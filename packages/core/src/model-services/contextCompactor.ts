/**
 * Context compaction: summarizes oversized history and atomically replaces it.
 * Design derived from openai/codex (Apache-2.0, Copyright 2025 OpenAI) —
 * core/compact.rs build_compacted_history + the pre-sampling/mid-turn trigger
 * points in session/turn.rs. See licenses/openai-codex.txt.
 *
 * Preserved Codex semantics:
 * - trigger on a token limit evaluated before each model call
 * - compaction runs one summarization request and takes the final assistant
 *   message as the summary
 * - replacement history = leading system context + recent user messages
 *   (reverse scan within a 20k-token budget) + one summary message carrying
 *   a fixed prefix
 * - when the summary request itself exceeds the window, the oldest
 *   non-system item is dropped and the request retried
 * Divergence: the original history stays with the caller/rollout — this
 * module is pure and never touches persistence itself.
 */

import type { ChatMessage, CompactionOptions, ModelServiceAdapter } from './types.js';

export const DEFAULT_USER_MESSAGE_BUDGET_TOKENS = 20_000;

/** 摘要请求输入里 tool 结果的最大字符数（OpenCode/Cline 同款 2000 字符限制）。 */
export const TOOL_RESULT_CHAR_LIMIT = 2_000;

/**
 * 摘要输出预算：压缩请求自身的 max_tokens。
 * 对齐 OpenCode V2 SUMMARY_OUTPUT_TOKENS=4096 与 Cline DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS=4096；
 * Anthropic 适配器无显式 max_tokens 时默认 1024，摘要会明显偏短。
 */
export const DEFAULT_SUMMARY_MAX_TOKENS = 4096;

/**
 * 压缩后历史至少保留的最近 user 消息条数（Hermes _MAX_TAIL_MESSAGE_FLOOR=8 的
 * 保守版）：预算极小（如触发阈值设得低）时也保底保留最近两条，避免丢失当前
 * 任务的直接上下文。
 */
export const MIN_KEPT_USER_MESSAGES = 2;

/**
 * 结构化摘要模板（OpenCode SUMMARY_TEMPLATE 风格）。要点：
 * - 明确目标 / 事实 / 工作状态 / 下一步 / 相关文件，让接手模型能直接续作；
 * - 强调保留函数名、ID、文件名、flag 等精确标识（Aider 同款约束）；
 * - 禁止提及压缩过程本身（OpenCode 模板同款要求）。
 */
export const DEFAULT_SUMMARIZATION_PROMPT = [
  '请将以上对话历史压缩为一份结构化摘要，供另一个语言模型直接续作本任务。',
  '按以下小节组织：',
  '## 目标：当前任务要达成的最终结果。',
  '## 重要事实与证据：已确认的事实、精确标识（函数名、文件路径、事件 ID、',
  'flag 编号、参数名与值、文本 ID 等，必须原样保留，不得泛化）。',
  '## 工作状态：已完成的操作及其结果；进行中的操作；被阻塞的事项及原因。',
  '## 下一步：继续任务所需的下一个动作，以及需要模型自行确认的未知点。',
  '## 相关文件：本任务涉及的文件/资源（相对路径或资源 URI）。',
  '省略寒暄与重复内容，不要提及压缩过程本身，直接输出摘要正文。'
].join('');

export const DEFAULT_SUMMARY_PREFIX = '【上下文摘要】以下为先前对话的压缩摘要，原始历史已归档：';

const MAX_SUMMARY_ATTEMPTS = 3;

/** Rough token estimate: ~4 characters per token plus per-message overhead. */
export function estimateMessageTokens(message: ChatMessage): number {
  let chars = message.content.length;
  for (const call of message.toolCalls ?? []) {
    chars += call.name.length + call.argumentsJson.length;
  }
  return Math.ceil(chars / 4) + 4;
}

/**
 * 摘要请求输入的预裁剪（OpenCode prune / Hermes 剪旧 tool 结果的轻量版）：
 * 大 tool 结果是上下文膨胀主因，也常是摘要请求自身超窗的原因——先把 tool
 * 结果截到 TOOL_RESULT_CHAR_LIMIT（2000 字符），比「删整条消息重试」更保守、
 * 保留更多信息。裁剪只作用于摘要请求的输入，不触碰原历史。
 */
export function trimToolResultsForSummary(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== 'tool' || message.content.length <= TOOL_RESULT_CHAR_LIMIT) return message;
    return {
      ...message,
      content: `${message.content.slice(0, TOOL_RESULT_CHAR_LIMIT)}\n… [tool result truncated for summary]`
    };
  });
}

/**
 * 历史轮次工具结果渐进修剪（Codex & OpenCode context management 机制）：
 * 在多轮会话持续推进时，保留最近 keepLastTurns 轮的完整 tool 输出；
 * 对于更早轮次（历史轮次）中超长（> maxCharsPerTool）的 tool 结果进行修剪，
 * 将其缩减为带概要的片段，防止历史 tool 输出无谓消耗宝贵的上下文窗口。
 */
export function pruneHistoricalToolOutputs(
  messages: readonly ChatMessage[],
  keepLastTurns = 2,
  maxCharsPerTool = 1500
): ChatMessage[] {
  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === 'user') userIndices.push(i);
  }
  const cutoffIndex = userIndices.length > keepLastTurns
    ? userIndices[userIndices.length - keepLastTurns] ?? 0
    : 0;

  return messages.map((message, idx) => {
    if (idx >= cutoffIndex || message.role !== 'tool' || message.content.length <= maxCharsPerTool) {
      return message;
    }
    const truncated = message.content.slice(0, maxCharsPerTool);
    return {
      ...message,
      content: `${truncated}\n… [历史工具输出已截断（原文共 ${message.content.length} 字符），保留核心摘要供上下文参考]`
    };
  });
}

export function estimateContextTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateMessageTokens(message);
  }
  return total;
}

export type CompactionResult =
  | { ok: true; replacementMessages: ChatMessage[]; summary: string; diagnostics: [] }
  | {
      ok: false;
      code: 'COMPACTION_SUMMARY_FAILED' | 'COMPACTION_CANCELLED' | 'insufficient_evidence';
      message: string;
      diagnostics: Array<{ severity: 'error'; code: string; message: string }>;
    };

/**
 * 判定一次模型调用失败是否为「上下文超窗」错误（OpenCode provider-error.ts 的
 * context-overflow 分类，约 28 条正则的轻量版）。超窗错误不走退避重试，而是
 * 触发压缩恢复（OpenCode：context overflow 不参与 retry，直接走 compaction）。
 */
const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /context\s*(length|limit|window|size|is\s+too\s+(long|large)|exceeded|overflow)/i,
  /maximum\s+context/i,
  /prompt\s+is\s+too\s+long/i,
  /token\s*(limit|length|budget|exceeded|too\s+(long|large))/i,
  /reduce\s+the\s+(length|size)\s+of\s+(the\s+)?(messages|prompt|input)/i
];

export function isContextOverflowDiagnostic(
  diagnostics: ReadonlyArray<{ severity: string; code: string; message: string }>
): boolean {
  return diagnostics.some((entry) => {
    if (entry.code !== 'MODEL_SERVICE_HTTP_ERROR' && entry.code !== 'MODEL_SERVICE_RESPONSE_PARSE_FAILED') {
      return false;
    }
    return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(entry.message));
  });
}

export interface CompactionRequest {
  messages: ChatMessage[];
  signal?: AbortSignal;
  timeoutMs?: number;
  options?: CompactionOptions;
}

/**
 * 判断一条消息是否为本机制生成的旧摘要（以 summaryPrefix 开头）。
 * 压缩保留预算里必须剔除旧摘要：否则第二次压缩会把旧摘要当作普通 user
 * 消息保留进 20k 预算，既浪费预算又让接手模型读到过期摘要（Codex 的
 * is_summary_message 同款过滤，compact.rs:567）。
 */
export function isSummaryMessage(message: ChatMessage, summaryPrefix = DEFAULT_SUMMARY_PREFIX): boolean {
  return message.role === 'user' && message.content.startsWith(summaryPrefix);
}

/**
 * Build the replacement history from the original one plus a summary.
 * Leading system messages are kept as initial context; recent user messages
 * are kept verbatim within the token budget (most recent first), excluding
 * previous summary messages; the new summary lands as the final user message.
 */
export function buildCompactedHistory(
  originalMessages: ChatMessage[],
  summary: string,
  options?: Pick<CompactionOptions, 'userMessageBudgetTokens' | 'summaryPrefix'>
): ChatMessage[] {
  const prefix = options?.summaryPrefix ?? DEFAULT_SUMMARY_PREFIX;
  const budget = options?.userMessageBudgetTokens ?? DEFAULT_USER_MESSAGE_BUDGET_TOKENS;
  const systemMessages = originalMessages.filter((message) => message.role === 'system');
  const userMessages = originalMessages.filter(
    (message) => message.role === 'user' && !isSummaryMessage(message, prefix)
  );
  const kept: ChatMessage[] = [];
  let tokens = 0;
  for (let index = userMessages.length - 1; index >= 0; index -= 1) {
    const message = userMessages[index]!;
    const cost = estimateMessageTokens(message);
    if (tokens + cost > budget && kept.length >= MIN_KEPT_USER_MESSAGES) break;
    kept.unshift(message);
    tokens += cost;
  }
  return [
    ...systemMessages,
    ...kept,
    {
      role: 'user',
      content: `${prefix}\n${summary}\n\n【说明】请基于上述已知事实与上下文摘要，继续推进并执行用户的原始任务；若已排查完毕或准备结束，请向用户清晰输出最终分析结论。`
    }
  ];
}

export async function runCompaction(
  adapter: ModelServiceAdapter,
  request: CompactionRequest
): Promise<CompactionResult> {
  const prompt = request.options?.summarizationPrompt ?? DEFAULT_SUMMARIZATION_PROMPT;
  let working = trimToolResultsForSummary(request.messages);
  for (let attempt = 1; attempt <= MAX_SUMMARY_ATTEMPTS; attempt += 1) {
    if (request.signal?.aborted) {
      return {
        ok: false,
        code: 'COMPACTION_CANCELLED',
        message: '上下文压缩已取消。',
        diagnostics: [{ severity: 'error', code: 'COMPACTION_CANCELLED', message: '上下文压缩已取消。' }]
      };
    }
    const completion = await adapter.complete({
      messages: [...working, { role: 'user', content: prompt }],
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.timeoutMs != null ? { timeoutMs: request.timeoutMs } : {}),
      maxTokens: request.options?.summaryMaxTokens != null && request.options.summaryMaxTokens > 0
        ? Math.trunc(request.options.summaryMaxTokens)
        : DEFAULT_SUMMARY_MAX_TOKENS
    });
    if (request.signal?.aborted || completion.finishReason === 'cancelled') {
      return {
        ok: false,
        code: 'COMPACTION_CANCELLED',
        message: '上下文压缩在模型调用期间取消。',
        diagnostics: [{ severity: 'error', code: 'COMPACTION_CANCELLED', message: '上下文压缩在模型调用期间取消。' }]
      };
    }
    if (completion.finishReason === 'error') {
      // Window overflow path: drop the oldest non-system item and retry.
      const dropIndex = working.findIndex((message) => message.role !== 'system');
      if (dropIndex === -1 || attempt === MAX_SUMMARY_ATTEMPTS) {
        return {
          ok: false,
          code: 'COMPACTION_SUMMARY_FAILED',
          message: '摘要请求失败，保留原历史。',
          diagnostics: [
            ...completion.diagnostics.filter(
              (entry): entry is { severity: 'error'; code: string; message: string } =>
                entry.severity === 'error'
            ),
            { severity: 'error', code: 'COMPACTION_SUMMARY_FAILED', message: '摘要请求失败，保留原历史。' }
          ]
        };
      }
      working = working.filter((_message, index) => index !== dropIndex);
      continue;
    }
    const summary = completion.message.content.trim();
    if (!summary) {
      return {
        ok: false,
        code: 'insufficient_evidence',
        message: '摘要为空，拒绝替换历史。',
        diagnostics: [
          { severity: 'error', code: 'insufficient_evidence', message: '摘要请求返回空内容。' }
        ]
      };
    }
    return {
      ok: true,
      replacementMessages: buildCompactedHistory(request.messages, summary, request.options),
      summary,
      diagnostics: []
    };
  }
  return {
    ok: false,
    code: 'COMPACTION_SUMMARY_FAILED',
    message: '摘要请求在重试预算内未成功，保留原历史。',
    diagnostics: [
      { severity: 'error', code: 'COMPACTION_SUMMARY_FAILED', message: '摘要重试预算耗尽。' }
    ]
  };
}
