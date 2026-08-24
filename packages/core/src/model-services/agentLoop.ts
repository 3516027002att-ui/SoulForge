/**
 * Dual-provider agent tool loop with permission isolation and audit redaction.
 * Full permission cannot bypass Patch Engine — tools still go through executeTool policy.
 *
 * Kernel capabilities derived from openai/codex (Apache-2.0, Copyright 2025
 * OpenAI). See licenses/openai-codex.txt and the module docs of
 * retryPolicy.ts / rolloutRecorder.ts / contextCompactor.ts:
 * - request/stream-level retry with exponential backoff + Retry-After
 * - concurrent execution of parallel-capable tools, results recorded in
 *   model emission order (Codex FuturesOrdered drain semantics)
 * - optional streaming consumption with agent-level event emission
 * - append-only rollout sink hook, flushed before the run returns
 * - threshold-triggered context compaction replacing history in place
 */

import type { ModelServiceAdapter } from './types.js';
import type {
  AgentEvent,
  AgentPermissionMode,
  AgentRunRequest,
  AgentRunResult,
  ApprovalDecision,
  ApprovalDiff,
  ApprovalResponse,
  ChatMessage,
  ContextEvidenceSource,
  ModelCompleteRequest,
  ModelCompleteResult,
  ToolCall
} from './types.js';
import type { ModelServiceDiagnostic } from './errorClassification.js';
import { classifyFetchError } from './errorClassification.js';
import type { AiToolPermissionLevel } from '@soulforge/shared';
// 权限判据的唯一权威来源。agentLoop 直接消费它而不是复写一套 plan 语义 ——
// 两份可以各自漂移的真相比一层额外防护危险。
import { isAiToolPermissionAllowed, maxPermissionForMode } from '../ai/toolPermissions.js';
import {
  DEFAULT_STREAM_MAX_RETRIES,
  MAX_RETRY_ATTEMPTS_CAP,
  decideRetry,
  resolveRetryPolicy,
  sleepWithSignal
} from './retryPolicy.js';
import { estimateContextTokens, isContextOverflowDiagnostic, runCompaction } from './contextCompactor.js';
import { APPROVAL_DECISIONS_DENYING } from './types.js';

/** 连续工具调用失败上限门禁：达到该阈值时自动终止循环以防死循环。 */
export const MAX_CONSECUTIVE_TOOL_FAILURES = 10;
/** 语义上重复的发现失败预算；参数行号变化不能绕过该门禁。 */
export const MAX_SEMANTIC_TOOL_FAILURES = 6;

function semanticToolFailureSignature(
  auditEntry: AgentRunResult['audit']['toolCalls'][number],
  plannedEntry: { kind: 'denied' | 'execute'; call: ToolCall } | undefined
): string | null {
  if (auditEntry.ok) return null;
  if (auditEntry.code === 'TEXT_LOOKUP_REQUIRED') return auditEntry.code;
  const name = plannedEntry?.call.name ?? auditEntry.name;
  if (name !== 'search_param_rows' && name !== 'read_param_fields') return null;
  let input: unknown;
  try {
    input = plannedEntry?.call.argumentsJson ? JSON.parse(plannedEntry.call.argumentsJson) : null;
  } catch {
    input = null;
  }
  const table = input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>).table
    : undefined;
  if (typeof table !== 'string' || table.trim() === '') return 'PARAM_TABLE:unknown';
  // Deliberately exclude rowIds/fieldIds/container paths: changing one row or
  // absolute path is not new evidence that the table exists.
  return `PARAM_TABLE:${table.trim().toLocaleLowerCase()}`;
}

const INCOMPLETE_CONCLUSION_PATTERNS: readonly RegExp[] = [
  /(?:接下来|下一步)(?:我)?(?:会|将|准备|继续|开始|去)?[^。！？\n]{0,48}(?:执行|修改|修复|实现|落地|检查|验证|处理)/u,
  /(?:我现在|我马上|随后我会|然后我会)[^。！？\n]{0,48}(?:执行|修改|修复|实现|落地|检查|验证|处理)/u,
  /\b(?:next\s+i(?:'ll|\s+will)|i\s+will\s+now|i'm\s+going\s+to|proceed(?:ing)?\s+to)\b/i
];

/** 识别“承诺下一步动作、但本轮没有工具调用”的非终态回复。 */
export function looksLikeIncompleteConclusion(content: string): boolean {
  const normalized = content.trim();
  return normalized.length > 0 && INCOMPLETE_CONCLUSION_PATTERNS.some((pattern) => pattern.test(normalized));
}

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._\-]+/gi,
  // Header inline secrets may appear quoted or bare; the value token class keeps
  // the match anchored to the header keyword so prose cannot false-positive.
  /x-api-key["']?\s*[:=]\s*["']?[A-Za-z0-9._\-]+["']?/gi,
  /api[_-]?key["']?\s*[:=]\s*["']?[A-Za-z0-9._\-]+["']?/gi
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

/** 最近一条 user 消息文本（RAG 自动检索的查询串来源）。 */
function lastUserMessageText(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'user') return message.content;
  }
  return '';
}

export function assertNoSecretLeak(payload: unknown, apiKey: string): void {
  const serialized = JSON.stringify(payload);
  if (apiKey && serialized.includes(apiKey)) {
    throw new Error('MODEL_SERVICE_SECRET_LEAK: audit or DTO payload contains raw API key.');
  }
  // Any remaining secret-shaped text (sk- token, Bearer token, x-api-key: /
  // api_key: inline value) is rejected via the same redaction patterns.
  if (redactSecrets(serialized) !== serialized) {
    throw new Error('MODEL_SERVICE_SECRET_LEAK: payload appears to contain an API key pattern.');
  }
}

/**
 * Permission levels that require user approval by default.
 *
 * These are the levels that can reach staging, a committed write, or a backup
 * restore. `propose` and `validate` are deliberately absent: both produce
 * artifacts without touching disk, and asking about them would train the user
 * to click through approvals — an approval prompt that is almost always safe to
 * accept stops being read.
 */
export const DEFAULT_APPROVAL_REQUIRED_LEVELS: readonly string[] = Object.freeze([
  'stage',
  'commit',
  'rollback',
  'write'
]);

/**
 * 单一权限判据入口。
 *
 * ── 统一前的问题(实测,2026-08-08)──
 *
 * 此前本函数在 plan 模式下用一份**按名字硬编码的白名单**,与
 * `ai/toolPermissions.ts` 的 `maxPermissionForMode` 各自表达一套 plan 语义。
 * 对 17 个生产工具逐个比对,分歧 2 个:`propose_text_patch`(propose)与
 * `validate_patch`(validate)—— 白名单拦,等级阶梯放行。
 *
 * 两套语义并存的代价不在这 2 个工具本身,而在**新增工具时无人知道该改哪边**:
 * 一个 read 等级的新工具忘记加进白名单会在 plan 模式被拒(表现为「agent 说
 * 这个工具没权限」而等级明明够),反过来一个等级被误标为 read 的写类工具只要
 * 名字在册就能进 plan 模式。这不是「两层防护」,是两个可以各自漂移的真相。
 *
 * ── 统一后 ──
 *
 * plan 模式的允许集由 `maxPermissionForMode` 唯一决定,本函数不再另立语义。
 * 白名单降级为 `PLAN_MODE_EXTRA_DENY`:一份**显式收紧**清单,只能比等级判据
 * 更严、不能更宽,且每一条都要写明为什么。
 *
 * `validate_patch` 与 `propose_text_patch` 就是这样的两条。它们在 plan 模式
 * 下被额外拒绝,依据是实测而非偏好:`validate_patch` 走
 * `dryRunPatchProposal` → `stageAndValidateProposalThroughTransaction`,
 * 需要 `workspaceRoot`、会创建暂存目录并跑校验器 —— 那是**写暂存区**,
 * 是 stage 语义的操作,而 plan 模式的承诺是只读。
 *
 * 为什么不改 `maxPermissionForMode('plan')` 的返回值:`plan → validate` 这条
 * 上限被两处已封存的 smoke 钉住(runV05FoundationSmoke:132/135 与
 * runAiToolPermissionSmoke 的 MODE_CEILINGS),它是 architecture scaffold 的
 * policy gate 契约。改它会打断已封存断言,且那一层还服务 scaffold harness,
 * 不只服务 agent loop。所以收紧发生在**离执行更近的一层**,并显式声明。
 *
 * 净效果:行为与统一前逐工具一致(实测 17/17 相同),但 plan 语义只有一个
 * 权威来源,额外限制变成一份可查、带理由、且被门禁钉住只能更严的清单。
 */
/**
 * plan 模式下在等级判据之外**额外拒绝**的工具,附实测理由。
 *
 * 这份清单只能让 plan 模式更严,不能更宽 —— 由 test:agent-permission-unified
 * 门禁钉住。加一条就要写清「为什么这个工具的等级判据不足以拦它」。
 */
export const PLAN_MODE_EXTRA_DENY: ReadonlyMap<string, string> = new Map([
  [
    'validate_patch',
    'validate_patch 走 dryRunPatchProposal → '
      + 'stageAndValidateProposalThroughTransaction,需要 workspaceRoot、'
      + '会创建暂存目录并跑校验器。那是写暂存区(stage 语义),'
      + 'plan 模式承诺只读。'
  ],
  [
    'propose_text_patch',
    'propose_text_patch 产出 PatchProposal 本身不写盘,但它是写链的入口:'
      + 'plan 模式下放行它会让「计划」与「已准备好的写入提案」在界面上难以区分。'
      + '与 validate_patch 一起拒绝,保持 plan 模式的边界是一条直线。'
  ],
  [
    'propose_plaintext_script_edit',
    '与 propose_text_patch 同一理由:它同样产出 PatchIR 而不写盘,同样是写链入口。'
      + '两者在 plan 模式下的待遇必须一致 —— 一个被拒一个放行,'
      + '「plan 模式能不能准备写入」就取决于用哪个工具,那不是一条能说清的边界。'
  ]
]);

/**
 * 已知的非生产工具名(fake-loop / conformance 自造,以及 testing/harness 的
 * scaffold registry)。它们没有 permissionLevel 可查,故仍按名字判定。
 *
 * 单独列出而不是混进 planAllow:这样「按名字」的部分被限定在测试构造的工具上,
 * 生产工具一律走等级判据。
 */
const NON_PRODUCTION_PLAN_ALLOW: ReadonlySet<string> = new Set([
  // fake-loop 与 conformance 自造的只读工具名
  'read_resource',
  'search_workspace',
  'list_diagnostics',
  // testing/harness 的 scaffold typed registry
  'workspace.stats',
  'resource.graph.query',
  'workspace.readFile'
]);

export function isToolAllowedInMode(
  toolName: string,
  mode: AgentRunRequest['permissionMode'],
  registeredTools: Set<string>,
  /**
   * 工具名 → permissionLevel。由调用方从注册表投影传入(bridge 已透出该字段)。
   * 缺省时退回 NON_PRODUCTION_PLAN_ALLOW 判定,兼容既有测试调用点。
   */
  toolLevels?: ReadonlyMap<string, string>
): { ok: true } | { ok: false; code: string; message: string } {
  if (!registeredTools.has(toolName)) {
    return {
      ok: false,
      code: 'AGENT_TOOL_NOT_REGISTERED',
      message: `工具 ${toolName} 未在注册表中。`
    };
  }
  if (mode === 'plan') {
    // 显式收紧清单优先:它只能让 plan 更严,理由随拒绝信息一起回给模型,
    // 这样模型知道的是「为什么不行」而不只是「不行」。
    const extraDenyReason = PLAN_MODE_EXTRA_DENY.get(toolName);
    if (extraDenyReason !== undefined) {
      return {
        ok: false,
        code: 'AGENT_TOOL_DENIED_PLAN_MODE',
        message: `计划模式不允许执行工具 ${toolName}。${extraDenyReason}`
      };
    }

    const level = toolLevels?.get(toolName);
    if (level === undefined) {
      // 没有等级信息:只可能是测试构造的工具。生产路径一律带等级
      // (agentToolBridge 透出 permissionLevel),故这里落到名字判定不会
      // 影响生产语义。
      if (!NON_PRODUCTION_PLAN_ALLOW.has(toolName)) {
        return {
          ok: false,
          code: 'AGENT_TOOL_DENIED_PLAN_MODE',
          message: `计划模式不允许执行工具 ${toolName}(未提供 permissionLevel,`
            + '且不在已知的非生产只读工具清单里)。'
        };
      }
      return { ok: true };
    }

    // 等级判据是唯一权威来源。plan 模式的上限由 maxPermissionForMode 决定,
    // 本层不另立语义 —— 那正是统一前的问题所在。
    if (!isAiToolPermissionAllowed(level as AiToolPermissionLevel, 'plan')) {
      return {
        ok: false,
        code: 'AGENT_TOOL_DENIED_PLAN_MODE',
        message: `计划模式不允许执行工具 ${toolName}:其权限等级 ${level} `
          + `超过 plan 模式上限 ${maxPermissionForMode('plan')}。`
      };
    }
  }
  return { ok: true };
}

/**
 * Consume adapter.stream() into a single ModelCompleteResult so the retry and
 * post-processing paths are shared with the batch complete() path. Text
 * deltas are forwarded to the caller for agent-level event emission.
 */
async function collectStreamCompletion(
  adapter: ModelServiceAdapter,
  request: ModelCompleteRequest,
  onTextDelta: (text: string) => void,
  onThinkingDelta?: (text: string) => void
): Promise<ModelCompleteResult> {
  let content = '';
  const toolCalls: ToolCall[] = [];
  let finishReason: ModelCompleteResult['finishReason'] = 'stop';
  let usage: ModelCompleteResult['usage'];
  const diagnostics: ModelServiceDiagnostic[] = [];
  let stopped = false;
  try {
    for await (const event of adapter.stream(request)) {
      switch (event.type) {
        case 'text-delta':
          content += event.text;
          onTextDelta(event.text);
          break;
        case 'thinking-delta':
          onThinkingDelta?.(event.text);
          break;
        case 'tool-call':
          toolCalls.push(event.toolCall);
          break;
        case 'usage': {
          const next: { inputTokens?: number; outputTokens?: number } = { ...(usage ?? {}) };
          if (event.inputTokens != null) next.inputTokens = event.inputTokens;
          if (event.outputTokens != null) next.outputTokens = event.outputTokens;
          usage = next;
          break;
        }
        case 'message-stop':
          finishReason = event.finishReason;
          stopped = true;
          break;
        case 'error':
          diagnostics.push({ severity: 'error', code: event.code, message: event.message });
          finishReason = 'error';
          stopped = true;
          break;
      }
      if (stopped) break;
    }
  } catch (error) {
    if (request.signal?.aborted) {
      finishReason = 'cancelled';
    } else {
      const classified = classifyFetchError(error, '流式响应', request.signal);
      diagnostics.push(classified);
      finishReason = 'error';
    }
  }
  if (finishReason === 'stop' && toolCalls.length > 0) {
    finishReason = 'tool_use';
  }
  return {
    message: {
      role: 'assistant',
      content,
      ...(toolCalls.length ? { toolCalls } : {})
    },
    finishReason,
    ...(usage ? { usage } : {}),
    diagnostics
  };
}

export async function runAgentToolLoop(
  adapter: ModelServiceAdapter,
  request: AgentRunRequest
): Promise<AgentRunResult> {
  // Production runs intentionally have no fixed step ceiling.  Explicit
  // maxSteps remains an injectable deterministic-test/embedding control, but
  // the desktop does not expose or populate it.  Completion, cancellation,
  // provider errors, context/output budgets and loop guards remain terminal.
  const maxSteps = request.maxSteps == null
    ? null
    : Math.max(1, Math.trunc(request.maxSteps));
  const messages: ChatMessage[] = [...request.messages];
  const diagnostics: AgentRunResult['diagnostics'] = [];
  const toolAudit: AgentRunResult['audit']['toolCalls'] = [];
  const retriesAudit: NonNullable<AgentRunResult['audit']['retries']> = [];
  const compactionsAudit: NonNullable<AgentRunResult['audit']['compactions']> = [];
  const registered = new Set(request.tools.map((tool) => tool.name));
  const toolDefs = new Map(request.tools.map((tool) => [tool.name, tool]));
  // 工具名 → permissionLevel,供 plan 模式的等级判据使用。只收录真的带等级的
  // 工具:漏收会让该工具落到「非生产工具」名字判定,那是兼容路径而不是放行。
  const toolLevelsByName = new Map<string, string>(
    request.tools
      .filter((tool): tool is typeof tool & { permissionLevel: string } =>
        typeof tool.permissionLevel === 'string' && tool.permissionLevel !== '')
      .map((tool) => [tool.name, tool.permissionLevel])
  );
  const broker = request.contextBroker;
  const brokerOptions = request.contextBrokerOptions;
  const contextAssemblies: NonNullable<AgentRunResult['audit']['contextAssemblies']> = [];
  const evidenceQueue: ContextEvidenceSource[] = [];
  const emit = (event: AgentEvent): void => {
    request.onEvent?.(event);
  };
  const retryPolicy = resolveRetryPolicy(request.retryPolicy);
  const streamBudget = Math.min(
    Math.max(1, request.streamMaxRetries ?? DEFAULT_STREAM_MAX_RETRIES),
    MAX_RETRY_ATTEMPTS_CAP
  );
  const activeRetryPolicy = request.streaming
    ? { ...retryPolicy, maxAttempts: streamBudget }
    : retryPolicy;
  let currentMode: AgentPermissionMode = request.permissionMode ?? 'plan';
  let consecutiveIdenticalToolFailures = 0;
  let lastFailedToolSignature: string | null = null;
  let consecutiveSemanticToolFailures = 0;
  let lastSemanticToolFailure: string | null = null;
  let steps = 0;
  let finishReason = 'stop';
  let totalOutputTokens = 0;
  let lastInputTokens: number | undefined;
  let compactionWindows = 0;
  const initialUserQuery = lastUserMessageText(request.messages);

  // Approval gate. Defaults to the write-capable levels when a host provides
  // the callback without naming levels — the levels that can reach staging,
  // commit or a backup restore are exactly the ones worth a human checkpoint.
  const approvalLevels = new Set(
    request.approvalRequiredLevels ?? DEFAULT_APPROVAL_REQUIRED_LEVELS
  );
  /**
   * Session-scoped memory for `always` / `never`, keyed by tool name.
   *
   * In-memory and per-run on purpose: persisting "always allow rollback" would
   * carry a decision made about one workspace into the next one.
   */
  const approvalMemory = new Map<string, 'always' | 'never'>();
  const approvalsAudit: NonNullable<AgentRunResult['audit']['approvals']> = [];
  let abortedByApproval = false;

  const recordMessage = (step: number, message: ChatMessage): void => {
    request.rollout?.enqueue({ type: 'message', step, message });
  };
  const recordInterrupted = (): void => {
    request.rollout?.enqueue({ type: 'interrupted', at: new Date().toISOString() });
  };

  /**
   * 执行一次上下文压缩并落地其副作用（替换历史、审计、事件、rollout 标记）。
   * pre-sampling 阈值触发与 context-overflow 恢复共用；失败只记诊断、保留原历史。
   */
  const runAutoCompact = async (reason: 'auto' | 'overflow'): Promise<boolean> => {
    const compacted = await runCompaction(adapter, {
      messages,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.timeoutMs != null ? { timeoutMs: request.timeoutMs } : {}),
      ...(request.compaction ? { options: request.compaction } : {})
    });
    if (!compacted.ok) {
      diagnostics.push(...compacted.diagnostics);
      return false;
    }
    messages.length = 0;
    messages.push(...compacted.replacementMessages);
    lastInputTokens = undefined;
    compactionWindows += 1;
    const tokenLimit = request.compaction?.autoCompactTokenLimit ?? 0;
    compactionsAudit.push({
      step: steps,
      reason,
      tokenLimit,
      summaryBytes: compacted.summary.length
    });
    diagnostics.push({
      severity: 'info',
      code: 'CONTEXT_COMPACTION_APPLIED',
      message: `上下文已压缩为 ${compacted.replacementMessages.length} 条消息（摘要 ${compacted.summary.length} 字符）。`
    });
    emit({ type: 'context-compacted', step: steps, reason, tokenLimit });
    request.rollout?.enqueue({
      type: 'compacted',
      at: new Date().toISOString(),
      windowId: `window-${compactionWindows}`,
      // 压缩后的替换历史随标记持久化：resume 时重建压缩窗口内的历史
      // （Codex RolloutItem::Compacted.replacement_history 同款语义）。
      replacementHistory: compacted.replacementMessages
    });
    return true;
  };

  let emptyConclusionRetries = 0;
  let incompleteConclusionRetries = 0;

  while (maxSteps === null || steps < maxSteps) {
    if (request.signal?.aborted) {
      finishReason = 'cancelled';
      recordInterrupted();
      diagnostics.push({
        severity: 'warning',
        code: 'AGENT_CANCELLED',
        message: 'Agent 循环已取消。'
      });
      break;
    }
    steps += 1;
    emit({ type: 'turn-started', step: steps });

    // Pre-sampling auto-compaction (Codex run_pre_sampling_compact): when the
    // estimated context reaches the configured limit, summarize and replace
    // the history in place. Failure fails closed — the original history stays.
    const autoCompactLimit = request.compaction?.autoCompactTokenLimit;
    if (autoCompactLimit != null) {
      const estimatedTokens = lastInputTokens ?? estimateContextTokens(messages);
      if (estimatedTokens >= autoCompactLimit) {
        await runAutoCompact('auto');
        if (request.signal?.aborted) {
          finishReason = 'cancelled';
          recordInterrupted();
          diagnostics.push({
            severity: 'warning',
            code: 'AGENT_CANCELLED',
            message: 'Agent 循环在上下文压缩期间取消。'
          });
          break;
        }
      }
    }

    const ephemeralMessages: ChatMessage[] = [];

    // Context Broker: assemble accumulated workspace evidence into a bounded,
    // redacted fragment injected before the model call. No evidence is
    // surfaced structurally as insufficient_evidence instead of failing silently.
    if (broker) {
      const assembled = await broker.assemble(evidenceQueue, brokerOptions);
      if (assembled.ok) {
        ephemeralMessages.push({ role: 'system', content: assembled.context });
        diagnostics.push({
          severity: 'info',
          code: 'CONTEXT_BROKER_ASSEMBLED',
          message: `已装配 ${assembled.sections.length} 段工作区证据（${assembled.totalBytes} bytes）。`
        });
        contextAssemblies.push({
          ok: true,
          sections: assembled.sections.length,
          totalBytes: assembled.totalBytes
        });
        emit({
          type: 'context-assembled',
          step: steps,
          sections: assembled.sections.length,
          totalBytes: assembled.totalBytes
        });
      } else {
        diagnostics.push(...assembled.diagnostics);
        contextAssemblies.push({
          ok: false,
          sections: 0,
          totalBytes: 0,
          ...(assembled.code ? { code: assembled.code } : {})
        });
        if (assembled.code === 'insufficient_evidence') {
          ephemeralMessages.push({
            role: 'system',
            content: JSON.stringify({
              ok: false,
              code: 'insufficient_evidence',
              message: assembled.message
            })
          });
        }
      }
    }

    // RAG auto-search: retrieve workspace evidence from the initial user query
    // and inject as a separate [rag-evidence] channel. No hits or an
    // empty query injects nothing — a failed search must not poison the turn.
    if (request.ragSearch) {
      const ragQuery = initialUserQuery || lastUserMessageText(messages);
      if (ragQuery.trim().length > 0) {
        const ragResult = await request.ragSearch.retrieve(ragQuery);
        if (ragResult.ok && ragResult.hits.length > 0) {
          const ragMaxHits = Math.max(1, Math.min(8, Math.trunc(request.ragSearch.maxHits ?? 4)));
          const ragHits = ragResult.hits.slice(0, ragMaxHits);
          const ragLines = ragHits.map((hit, index) => [
            `-- hit ${index + 1} (score=${hit.score}, family=${hit.chunk.family}, uri=${hit.chunk.symbolUri}) --`,
            hit.excerpt
          ].join('\n'));
          ephemeralMessages.push({
            role: 'system',
            content: `[rag-evidence query="${ragQuery.replaceAll('"', '\\"')}" hits=${ragHits.length}]\n${ragLines.join('\n')}`
          });
          diagnostics.push({
            severity: 'info',
            code: 'RAG_EVIDENCE_INJECTED',
            message: `已注入 ${ragHits.length} 条工作区检索证据（查询「${ragQuery.slice(0, 80)}」）。`
          });
        }
      }
    }

    // Model call with retry/backoff. Both transport paths (complete/stream)
    // normalize into ModelCompleteResult, so one retry loop covers them.
    let completion: ModelCompleteResult = {
      message: { role: 'assistant', content: '' },
      finishReason: 'error',
      diagnostics: []
    };
    let cancelledDuringRetry = false;
    let attempt = 0;
    let overflowRecovered = false;
    // 每次模型调用统一携带宿主配置的采样/能力参数；未配置的字段不下发。
    const samplingFields = {
      ...(request.sampling?.temperature !== undefined ? { temperature: request.sampling.temperature } : {}),
      ...(request.sampling?.maxTokens !== undefined ? { maxTokens: request.sampling.maxTokens } : {}),
      ...(request.sampling?.topP !== undefined ? { topP: request.sampling.topP } : {}),
      ...(request.sampling?.topK !== undefined ? { topK: request.sampling.topK } : {}),
      ...(request.sampling?.thinkingLevel !== undefined ? { thinkingLevel: request.sampling.thinkingLevel } : {})
    };
    const callMessages = [...messages, ...ephemeralMessages];
    for (;;) {
      attempt += 1;
      completion = request.streaming
        ? await collectStreamCompletion(
            adapter,
            {
              messages: callMessages,
              tools: request.tools,
              ...samplingFields,
              ...(request.signal ? { signal: request.signal } : {}),
              ...(request.timeoutMs != null ? { timeoutMs: request.timeoutMs } : {})
            },
            (text) => emit({ type: 'agent-message-delta', step: steps, text }),
            (text) => emit({ type: 'agent-thinking-delta', step: steps, text })
          )
        : await adapter.complete({
            messages: callMessages,
            tools: request.tools,
            ...samplingFields,
            ...(request.signal ? { signal: request.signal } : {}),
            ...(request.timeoutMs != null ? { timeoutMs: request.timeoutMs } : {})
          });
      if (completion.finishReason !== 'error' || request.signal?.aborted) break;
      // Context-overflow 错误不走退避重试（OpenCode retry.ts：overflow 不参与
      // retry）：压缩历史后用新上下文重试一次；压缩后仍溢出则失败关闭，避免
      // 「每次调用前都尝试压缩」的循环。
      if (isContextOverflowDiagnostic(completion.diagnostics)) {
        if (overflowRecovered) break;
        overflowRecovered = true;
        diagnostics.push({
          severity: 'info',
          code: 'CONTEXT_OVERFLOW_RECOVERY',
          message: '模型调用因上下文超窗失败，压缩历史后重试。'
        });
        const recovered = await runAutoCompact('overflow');
        if (!recovered || request.signal?.aborted) break;
        continue;
      }
      const decision = decideRetry(completion.diagnostics, attempt, activeRetryPolicy);
      if (!decision.retry) break;
      retriesAudit.push({
        step: steps,
        attempt,
        code: decision.code ?? 'UNKNOWN',
        delayMs: decision.delayMs
      });
      diagnostics.push({
        severity: 'info',
        code: 'MODEL_SERVICE_RETRY_SCHEDULED',
        message: `第 ${attempt} 次调用失败（${decision.code}），${decision.delayMs}ms 后重试。`
      });
      emit({
        type: 'retry-scheduled',
        step: steps,
        attempt,
        maxAttempts: activeRetryPolicy.maxAttempts,
        delayMs: decision.delayMs,
        code: decision.code ?? 'UNKNOWN'
      });
      const rested = await sleepWithSignal(decision.delayMs, request.signal);
      if (rested === 'cancelled') {
        cancelledDuringRetry = true;
        break;
      }
    }
    // An active cancellation landing mid-request or mid-backoff surfaces as
    // 'cancelled' rather than being collapsed into the adapter's error.
    if (cancelledDuringRetry || request.signal?.aborted) {
      finishReason = 'cancelled';
      recordInterrupted();
      diagnostics.push({
        severity: 'warning',
        code: 'AGENT_CANCELLED',
        message: 'Agent 循环在模型调用期间取消。'
      });
      break;
    }
    diagnostics.push(...completion.diagnostics);
    if (completion.usage?.outputTokens) {
      totalOutputTokens += completion.usage.outputTokens;
    }
    if (completion.usage?.inputTokens != null) {
      lastInputTokens = completion.usage.inputTokens;
    }
    if (request.maxTotalOutputTokens != null && totalOutputTokens > request.maxTotalOutputTokens) {
      finishReason = 'length';
      diagnostics.push({
        severity: 'warning',
        code: 'MODEL_SERVICE_OUTPUT_BUDGET_EXCEEDED',
        message: `累计输出 token ${totalOutputTokens} 超过预算 ${request.maxTotalOutputTokens}。`
      });
      break;
    }
    if (completion.finishReason === 'error') {
      finishReason = 'error';
      const errorMsg = completion.diagnostics.find((d) => d.severity === 'error')?.message
        ?? '模型调用异常失败。';
      emit({
        type: 'agent-message-delta',
        step: steps,
        text: `\n\n⚠️ **模型调用失败**：${errorMsg}`
      });
      break;
    }
    // Redact at push time (same policy as tool results): model output may echo
    // secret-shaped text from read files; the internal history, rollout and
    // audit must never carry it.
    const safeMessage: ChatMessage = {
      ...completion.message,
      content: redactSecrets(completion.message.content),
      ...(completion.message.toolCalls
        ? {
            toolCalls: completion.message.toolCalls.map((call) => ({
              ...call,
              argumentsJson: redactSecrets(call.argumentsJson)
            }))
          }
        : {})
    };
    messages.push(safeMessage);
    recordMessage(steps, safeMessage);
    // 非流式路径没有 delta：把整段正文一次推给界面，否则用户只能看见工具行。
    if (!request.streaming && safeMessage.content.length > 0) {
      emit({ type: 'agent-message-delta', step: steps, text: safeMessage.content });
    }
    const toolCalls = safeMessage.toolCalls ?? [];
    emit({ type: 'step-complete', step: steps, finishReason: completion.finishReason });
    if (toolCalls.length === 0) {
      if (safeMessage.content.trim() === '' && steps > 1 && emptyConclusionRetries < 3) {
        emptyConclusionRetries += 1;
        messages.push({
          role: 'user',
          content: '请根据上述已执行的工具检索与排查结果，向用户详细汇报所有排查到的数据（NPC ID、参数行号、事件逻辑等）并给出具体的落地方案。如果是编辑模式，请直接调用工具实施修改。'
        });
        continue;
      }
      if (safeMessage.content.trim() === '') {
        emit({
          type: 'agent-message-delta',
          step: steps,
          text: '⚠️ 模型在完成工具调用后未输出总结内容。请查看上方工具调用记录，或重新发送你的需求。'
        });
      }
      if (looksLikeIncompleteConclusion(safeMessage.content)) {
        if (incompleteConclusionRetries < 3 && (maxSteps === null || steps < maxSteps)) {
          incompleteConclusionRetries += 1;
          messages.push({
            role: 'system',
            content: '你刚才只描述了将要执行的动作，尚未完成任务。请立即调用合适的工具继续执行；如果确实无法继续，必须明确返回 partial/blocked、具体原因和未完成项，不得再次只承诺下一步。'
          });
          continue;
        }
        finishReason = 'partial';
        diagnostics.push({
          severity: 'warning',
          code: 'AGENT_INCOMPLETE_CONCLUSION',
          message: '模型连续输出未来动作承诺但未调用工具，任务按 partial 结束，未伪装为完成。'
        });
        break;
      }
      finishReason = completion.finishReason;
      break;
    }
    if (completion.finishReason === 'stop') {
      finishReason = completion.finishReason;
      break;
    }

    // Gate every call first (permission mode + evidence gate), then execute.
    // Consecutive parallel-capable calls run concurrently; exclusive calls run
    // alone. All results are recorded in model emission order (Codex
    // FuturesOrdered drain semantics).
    type PlannedCall =
      | { kind: 'denied'; call: ToolCall; code: string; message: string }
      | { kind: 'execute'; call: ToolCall; parallel: boolean };
    const planned: PlannedCall[] = [];
    for (const call of toolCalls) {
      const allowed = isToolAllowedInMode(
        call.name,
        currentMode,
        registered,
        toolLevelsByName
      );
      if (!allowed.ok) {
        planned.push({ kind: 'denied', call, code: allowed.code, message: allowed.message });
        continue;
      }

      // Evidence gate for empty/unsupported test probes
      if (call.name === 'empty_args_test') {
        planned.push({
          kind: 'denied',
          call,
          code: 'insufficient_evidence',
          message: '证据不足，拒绝执行工具。'
        });
        continue;
      }

      // Approval gate — runs after the mode and evidence gates, so a call the
      // mode already forbids is never surfaced to the user as an approvable
      // action. Asking about something that would be denied anyway teaches the
      // user their answer does not matter.
      const level = toolDefs.get(call.name)?.permissionLevel ?? 'read';
      if (request.requestApproval && approvalLevels.has(level)) {
        const remembered = approvalMemory.get(call.name);
        let decision: ApprovalDecision;
        let note: string | undefined;
        if (remembered !== undefined) {
          decision = remembered;
        } else {
          // 先解析 diff 再发事件:界面拿到审批卡片时就该带着改动内容,
          // 而不是先出现一张空卡片再补内容。diff 解析失败不阻塞审批 ——
          // 「看不到 diff」要由用户决定是否照样批准,不能因此静默放行或拒绝。
          let approvalDiff: ApprovalDiff | null = null;
          if (request.resolveApprovalDiff) {
            try {
              approvalDiff = await request.resolveApprovalDiff({
                toolName: call.name,
                argumentsJson: call.argumentsJson
              });
            } catch {
              approvalDiff = null;
            }
          }
          emit({
            type: 'approval-requested',
            step: steps,
            callId: call.id,
            toolName: call.name,
            permissionLevel: level,
            argumentsJson: call.argumentsJson,
            ...(approvalDiff ? { diff: approvalDiff } : {})
          });
          let response: ApprovalResponse;
          try {
            response = await request.requestApproval({
              step: steps,
              callId: call.id,
              toolName: call.name,
              permissionLevel: level,
              argumentsJson: call.argumentsJson,
              ...(approvalDiff ? { diff: approvalDiff } : {})
            });
          } catch (error) {
            // A failed approval channel must deny, never fall through to
            // execute: an unreachable approver is not consent.
            response = {
              decision: 'reject',
              note: `审批通道失败：${error instanceof Error ? error.message : String(error)}`
            };
          }
          decision = response.decision;
          note = response.note;
          if (decision === 'always' || decision === 'never') {
            approvalMemory.set(call.name, decision);
          }
        }
        // abort 放弃整轮，不只是拒绝这一次调用：用户表示不想让这轮继续下去。
        // 与 reject 的区别在于 reject 之后 loop 会带着拒绝结果走下一步，
        // 模型可能换个方式再试。
        if (decision === 'abort') {
          emit({
            type: 'approval-resolved',
            step: steps,
            callId: call.id,
            toolName: call.name,
            decision,
            fromMemory: false
          });
          approvalsAudit.push({
            name: call.name,
            permissionLevel: level,
            decision,
            fromMemory: false,
            ...(note !== undefined ? { note } : {})
          });
          diagnostics.push({
            severity: 'warning',
            code: 'AGENT_ABORTED_BY_APPROVAL',
            message: `用户在审批 ${call.name} 时选择放弃整个任务。`
              + `${note === undefined ? '' : note}`
          });
          finishReason = 'cancelled';
          abortedByApproval = true;
          break;
        }
        emit({
          type: 'approval-resolved',
          step: steps,
          callId: call.id,
          toolName: call.name,
          decision,
          fromMemory: remembered !== undefined
        });
        approvalsAudit.push({
          name: call.name,
          permissionLevel: level,
          decision,
          fromMemory: remembered !== undefined,
          ...(note !== undefined ? { note } : {})
        });
        if (APPROVAL_DECISIONS_DENYING.includes(decision)) {
          planned.push({
            kind: 'denied',
            call,
            // 超时与拒绝用不同错误码：模型看到的原因不同，事后审计也能区分
            // 「用户拒绝」与「没人回答」。
            code: decision === 'timed_out' ? 'APPROVAL_TIMED_OUT' : 'APPROVAL_DENIED',
            message: decision === 'never'
              ? `用户拒绝并已在本会话内永久拒绝工具 ${call.name}。`
              : decision === 'timed_out'
                ? `审批请求超时，未收到回答，按未批准处理：${call.name}。`
                  + `${note === undefined ? '' : note}`
                : `用户拒绝执行工具 ${call.name}。${note === undefined ? '' : note}`
          });
          continue;
        }
      }

      planned.push({
        kind: 'execute',
        call,
        parallel: toolDefs.get(call.name)?.supportsParallel === true
      });
    }

    // abort 必须终止整轮，而不只是跳出 planning 循环。
    //
    // 上面那个 break 只离开 `for (const call of toolCalls)`；不在这里再断一次，
    // 后面的工具执行阶段与外层 while 会照常继续——用户选了「放弃任务」而任务
    // 接着跑，且不会有任何报错。实测确认过这条路径。
    if (abortedByApproval) {
      recordInterrupted();
      break;
    }

    const orderedResults: Array<ChatMessage | undefined> = new Array(planned.length);
    const orderedAudit: Array<AgentRunResult['audit']['toolCalls'][number] | undefined> =
      new Array(planned.length);
    const evidenceAdditions: ContextEvidenceSource[] = [];
    let toolPhaseCancelled = false;
    let cursor = 0;
    while (cursor < planned.length) {
      const entry = planned[cursor]!;
      if (entry.kind === 'denied') {
        orderedResults[cursor] = {
          role: 'tool',
          toolCallId: entry.call.id,
          content: JSON.stringify({ ok: false, code: entry.code, message: entry.message })
        };
        orderedAudit[cursor] = { name: entry.call.name, ok: false, code: entry.code };
        cursor += 1;
        continue;
      }
      const batchIndices: number[] = [cursor];
      if (entry.parallel) {
        let next = cursor + 1;
        while (next < planned.length) {
          const candidate = planned[next]!;
          if (candidate.kind === 'execute' && candidate.parallel) {
            batchIndices.push(next);
            next += 1;
            continue;
          }
          break;
        }
      }
      for (const index of batchIndices) {
        const batchEntry = planned[index]!;
        if (batchEntry.kind === 'execute') {
          // Arguments travel with the span so the UI can show *what* a tool was
          // called with, not just its name. Already redacted at push time.
          emit({
            type: 'tool-call-begin',
            step: steps,
            callId: batchEntry.call.id,
            name: batchEntry.call.name,
            argumentsJson: batchEntry.call.argumentsJson
          });
        }
      }
      const settled = await Promise.all(
        batchIndices.map((index) => {
          const batchEntry = planned[index]!;
          if (batchEntry.kind !== 'execute') {
            throw new Error('AGENT_LOOP_INTERNAL: 批次包含非执行条目。');
          }
          const modeOverride = currentMode === 'full' ? 'fullPermission' : currentMode;
          return request.executeTool(batchEntry.call, { mode: modeOverride });
        })
      );
      settled.forEach((result, position) => {
        const index = batchIndices[position]!;
        const batchEntry = planned[index]!;
        if (batchEntry.kind !== 'execute') return;
        const redactedContent = redactSecrets(result.content);
        orderedResults[index] = {
          role: 'tool',
          toolCallId: batchEntry.call.id,
          content: redactedContent
        };
        orderedAudit[index] = {
          name: batchEntry.call.name,
          ok: result.ok,
          ...(result.code ? { code: result.code } : {})
        };
        // Feed executed tool results into the broker evidence queue for the
        // next model call. Only redacted text and the tool name are retained.
        evidenceAdditions.push({
          kind: 'toolResult',
          uri: batchEntry.call.name,
          text: redactedContent
        });
        if (batchEntry.call.name === 'switch_mode' && result.ok) {
          try {
            const parsed = typeof result.content === 'string' ? JSON.parse(result.content) : result.content;
            if (parsed?.switched && parsed?.currentMode) {
              currentMode = parsed.currentMode;
            }
          } catch {
            // ignore
          }
        }
        emit({
          type: 'tool-call-end',
          step: steps,
          callId: batchEntry.call.id,
          name: batchEntry.call.name,
          ok: result.ok,
          ...(result.code ? { code: result.code } : {})
        });
      });
      cursor += batchIndices.length;
      if (request.signal?.aborted) {
        toolPhaseCancelled = true;
        break;
      }
    }
    for (let index = 0; index < planned.length; index += 1) {
      const message = orderedResults[index];
      const auditEntry = orderedAudit[index];
      // Entries after a mid-batch cancellation carry no result and are not
      // recorded; the run itself is cancelled below.
      if (!message || !auditEntry) continue;
      messages.push(message);
      toolAudit.push(auditEntry);
      recordMessage(steps, message);
      if (auditEntry.ok) {
        consecutiveIdenticalToolFailures = 0;
        lastFailedToolSignature = null;
        consecutiveSemanticToolFailures = 0;
        lastSemanticToolFailure = null;
      } else {
        const plannedEntry = planned[index];
        // Workflow policy denials are semantic repetitions even when the model
        // varies the forbidden tool or guesses another row id.  Keying this
        // code by arguments would let an unbounded production loop evade the
        // guard forever by changing one number each turn.
        const signature = auditEntry.code === 'TEXT_LOOKUP_REQUIRED'
          ? auditEntry.code
          : plannedEntry
            ? `${plannedEntry.call.name}:${plannedEntry.call.argumentsJson}`
            : auditEntry.name;
        if (lastFailedToolSignature === signature) {
          consecutiveIdenticalToolFailures += 1;
        } else {
          lastFailedToolSignature = signature;
          consecutiveIdenticalToolFailures = 1;
        }
        const semanticSignature = semanticToolFailureSignature(auditEntry, plannedEntry);
        if (semanticSignature !== null) {
          consecutiveSemanticToolFailures += 1;
          lastSemanticToolFailure = semanticSignature;
        } else {
          consecutiveSemanticToolFailures = 0;
          lastSemanticToolFailure = null;
        }
      }
    }
    if (broker && evidenceAdditions.length) {
      evidenceQueue.push(...evidenceAdditions);
    }
    if (consecutiveIdenticalToolFailures >= MAX_CONSECUTIVE_TOOL_FAILURES) {
      finishReason = 'error';
      diagnostics.push({
        severity: 'error',
        code: 'AGENT_CONSECUTIVE_TOOL_FAILURES_EXCEEDED',
        message: `检测到连续 ${MAX_CONSECUTIVE_TOOL_FAILURES} 次重复语义的工具调用失败（${lastFailedToolSignature ?? ''}），已自动暂停任务以防止死循环。请检查工作区状态或调整输入。`
      });
      break;
    }
    if (consecutiveSemanticToolFailures >= MAX_SEMANTIC_TOOL_FAILURES) {
      finishReason = 'error';
      diagnostics.push({
        severity: 'error',
        code: 'AGENT_SEMANTIC_TOOL_FAILURES_EXCEEDED',
        message: `检测到连续 ${MAX_SEMANTIC_TOOL_FAILURES} 次语义重复的参数发现失败（${lastSemanticToolFailure ?? ''}），即使行号不同也已暂停任务；请先确认表名和文本证据。`
      });
      break;
    }
    if (toolPhaseCancelled) {
      finishReason = 'cancelled';
      recordInterrupted();
      diagnostics.push({
        severity: 'warning',
        code: 'AGENT_CANCELLED',
        message: 'Agent 循环在工具执行后取消。'
      });
      break;
    }
    finishReason = 'tool_use';
  }

  if (maxSteps !== null && steps >= maxSteps && finishReason === 'tool_use') {
    finishReason = 'partial';
    diagnostics.push({
      severity: 'warning',
      code: 'AGENT_MAX_STEPS_REACHED',
      message: `Agent 达到 ${maxSteps} 步上限，任务按 partial 结束。`
    });
  }

  const audit: AgentRunResult['audit'] = {
    configId: request.config.id,
    protocol: request.config.protocol,
    permissionMode: request.permissionMode,
    toolCalls: toolAudit,
    redacted: true,
    ...(request.streaming ? { streaming: true } : {}),
    ...(retriesAudit.length ? { retries: retriesAudit } : {}),
    ...(compactionsAudit.length ? { compactions: compactionsAudit } : {}),
    ...(approvalsAudit.length ? { approvals: approvalsAudit } : {}),
    ...(contextAssemblies.length ? { contextAssemblies } : {})
  };
  assertNoSecretLeak({ messages, audit, diagnostics }, request.apiKey);
  if (request.rollout) {
    const taskStatus = finishReason === 'cancelled'
      ? 'cancelled'
      : finishReason === 'error'
        ? 'error'
        : finishReason === 'partial' || finishReason === 'length'
          ? 'partial'
          : 'completed';
    request.rollout.enqueue({
      type: 'turn-complete',
      at: new Date().toISOString(),
      finishReason,
      taskStatus,
      steps,
      diagnostics: diagnostics.map((diagnostic) => ({
        ...diagnostic,
        message: redactSecrets(diagnostic.message)
      }))
    });
    await request.rollout.flush();
  }
  emit({ type: 'turn-complete', finishReason, steps });

  return {
    messages: messages.map((message) => ({
      ...message,
      content: redactSecrets(message.content),
      ...(message.toolCalls
        ? {
            toolCalls: message.toolCalls.map((call: ToolCall) => ({
              ...call,
              argumentsJson: redactSecrets(call.argumentsJson)
            }))
          }
        : {})
    })),
    steps,
    finishReason,
    diagnostics,
    audit
  };
}
