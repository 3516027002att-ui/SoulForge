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
  AgentRunRequest,
  AgentRunResult,
  ApprovalDecision,
  ApprovalResponse,
  ChatMessage,
  ContextEvidenceSource,
  ModelCompleteRequest,
  ModelCompleteResult,
  ToolCall
} from './types.js';
import type { ModelServiceDiagnostic } from './errorClassification.js';
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
import { estimateContextTokens, runCompaction } from './contextCompactor.js';

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
  onTextDelta: (text: string) => void
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
      diagnostics.push({
        severity: 'error',
        code: 'MODEL_SERVICE_REQUEST_FAILED',
        message: `流式响应消费失败：${error instanceof Error ? error.message : String(error)}`
      });
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
  const maxSteps = request.maxSteps ?? 8;
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
  let steps = 0;
  let finishReason = 'stop';
  let totalOutputTokens = 0;
  let lastInputTokens: number | undefined;
  let compactionWindows = 0;

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

  const recordMessage = (step: number, message: ChatMessage): void => {
    request.rollout?.enqueue({ type: 'message', step, message });
  };
  const recordInterrupted = (): void => {
    request.rollout?.enqueue({ type: 'interrupted', at: new Date().toISOString() });
  };

  while (steps < maxSteps) {
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
        const compacted = await runCompaction(adapter, {
          messages,
          ...(request.signal ? { signal: request.signal } : {}),
          ...(request.timeoutMs != null ? { timeoutMs: request.timeoutMs } : {}),
          ...(request.compaction ? { options: request.compaction } : {})
        });
        if (compacted.ok) {
          messages.length = 0;
          messages.push(...compacted.replacementMessages);
          lastInputTokens = undefined;
          compactionWindows += 1;
          compactionsAudit.push({
            step: steps,
            reason: 'auto',
            tokenLimit: autoCompactLimit,
            summaryBytes: compacted.summary.length
          });
          diagnostics.push({
            severity: 'info',
            code: 'CONTEXT_COMPACTION_APPLIED',
            message: `上下文已压缩为 ${compacted.replacementMessages.length} 条消息（摘要 ${compacted.summary.length} 字符）。`
          });
          emit({ type: 'context-compacted', step: steps, reason: 'auto', tokenLimit: autoCompactLimit });
          request.rollout?.enqueue({
            type: 'compacted',
            at: new Date().toISOString(),
            windowId: `window-${compactionWindows}`
          });
        } else {
          diagnostics.push(...compacted.diagnostics);
        }
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

    // Context Broker: assemble accumulated workspace evidence into a bounded,
    // redacted fragment injected before the model call. No evidence is
    // surfaced structurally as insufficient_evidence instead of failing silently.
    if (broker) {
      const assembled = await broker.assemble(evidenceQueue, brokerOptions);
      if (assembled.ok) {
        messages.push({ role: 'system', content: assembled.context });
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
          messages.push({
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

    // Model call with retry/backoff. Both transport paths (complete/stream)
    // normalize into ModelCompleteResult, so one retry loop covers them.
    let completion: ModelCompleteResult = {
      message: { role: 'assistant', content: '' },
      finishReason: 'error',
      diagnostics: []
    };
    let cancelledDuringRetry = false;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      completion = request.streaming
        ? await collectStreamCompletion(
            adapter,
            {
              messages,
              tools: request.tools,
              ...(request.signal ? { signal: request.signal } : {}),
              ...(request.timeoutMs != null ? { timeoutMs: request.timeoutMs } : {})
            },
            (text) => emit({ type: 'agent-message-delta', step: steps, text })
          )
        : await adapter.complete({
            messages,
            tools: request.tools,
            ...(request.signal ? { signal: request.signal } : {}),
            ...(request.timeoutMs != null ? { timeoutMs: request.timeoutMs } : {})
          });
      if (completion.finishReason !== 'error' || request.signal?.aborted) break;
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
    const toolCalls = safeMessage.toolCalls ?? [];
    emit({ type: 'step-complete', step: steps, finishReason: completion.finishReason });
    if (toolCalls.length === 0 || completion.finishReason === 'stop') {
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
        request.permissionMode,
        registered,
        toolLevelsByName
      );
      if (!allowed.ok) {
        planned.push({ kind: 'denied', call, code: allowed.code, message: allowed.message });
        continue;
      }
      // Evidence gate: empty arguments with no prior context → insufficient_evidence.
      if (!call.argumentsJson || call.argumentsJson.trim() === '' || call.argumentsJson === '{}') {
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
          emit({
            type: 'approval-requested',
            step: steps,
            callId: call.id,
            toolName: call.name,
            permissionLevel: level,
            argumentsJson: call.argumentsJson
          });
          let response: ApprovalResponse;
          try {
            response = await request.requestApproval({
              step: steps,
              callId: call.id,
              toolName: call.name,
              permissionLevel: level,
              argumentsJson: call.argumentsJson
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
        if (decision === 'reject' || decision === 'never') {
          planned.push({
            kind: 'denied',
            call,
            code: 'APPROVAL_DENIED',
            message: decision === 'never'
              ? `用户拒绝并已在本会话内永久拒绝工具 ${call.name}。`
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
          return request.executeTool(batchEntry.call);
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
    }
    if (broker && evidenceAdditions.length) {
      evidenceQueue.push(...evidenceAdditions);
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
