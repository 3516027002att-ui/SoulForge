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

export const DEFAULT_SUMMARIZATION_PROMPT = [
  '请将以上对话历史压缩为一份简明摘要：保留任务目标、已确认的事实与证据、',
  '已完成的操作及其结果、未决问题与下一步计划。省略寒暄与重复内容，',
  '直接输出摘要正文。'
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

export interface CompactionRequest {
  messages: ChatMessage[];
  signal?: AbortSignal;
  timeoutMs?: number;
  options?: CompactionOptions;
}

/**
 * Build the replacement history from the original one plus a summary.
 * Leading system messages are kept as initial context; recent user messages
 * are kept verbatim within the token budget (most recent first); the summary
 * lands as the final user message.
 */
export function buildCompactedHistory(
  originalMessages: ChatMessage[],
  summary: string,
  options?: Pick<CompactionOptions, 'userMessageBudgetTokens' | 'summaryPrefix'>
): ChatMessage[] {
  const prefix = options?.summaryPrefix ?? DEFAULT_SUMMARY_PREFIX;
  const budget = options?.userMessageBudgetTokens ?? DEFAULT_USER_MESSAGE_BUDGET_TOKENS;
  const systemMessages = originalMessages.filter((message) => message.role === 'system');
  const userMessages = originalMessages.filter((message) => message.role === 'user');
  const kept: ChatMessage[] = [];
  let tokens = 0;
  for (let index = userMessages.length - 1; index >= 0; index -= 1) {
    const message = userMessages[index]!;
    const cost = estimateMessageTokens(message);
    if (tokens + cost > budget && kept.length > 0) break;
    kept.unshift(message);
    tokens += cost;
  }
  return [...systemMessages, ...kept, { role: 'user', content: `${prefix}\n${summary}` }];
}

export async function runCompaction(
  adapter: ModelServiceAdapter,
  request: CompactionRequest
): Promise<CompactionResult> {
  const prompt = request.options?.summarizationPrompt ?? DEFAULT_SUMMARIZATION_PROMPT;
  let working = [...request.messages];
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
      ...(request.timeoutMs != null ? { timeoutMs: request.timeoutMs } : {})
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
