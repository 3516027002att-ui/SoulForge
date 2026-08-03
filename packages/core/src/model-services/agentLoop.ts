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
  ChatMessage,
  ContextEvidenceSource,
  ModelCompleteRequest,
  ModelCompleteResult,
  ToolCall
} from './types.js';
import type { ModelServiceDiagnostic } from './errorClassification.js';
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
 * Plan mode: only allow tools that are explicitly read/analysis.
 * Full mode still cannot invent elevated tools outside the registry passed in.
 */
export function isToolAllowedInMode(
  toolName: string,
  mode: AgentRunRequest['permissionMode'],
  registeredTools: Set<string>
): { ok: true } | { ok: false; code: string; message: string } {
  if (!registeredTools.has(toolName)) {
    return {
      ok: false,
      code: 'AGENT_TOOL_NOT_REGISTERED',
      message: `工具 ${toolName} 未在注册表中。`
    };
  }
  if (mode === 'plan') {
    const planAllow = new Set([
      'read_resource',
      'search_workspace',
      'build_patch_graph',
      'assess_edit_risk',
      'list_diagnostics',
      // Scaffold typed registry read tools — plan mode stays strictly read-only.
      'workspace.stats',
      'resource.graph.query',
      'workspace.readFile'
    ]);
    if (!planAllow.has(toolName)) {
      return {
        ok: false,
        code: 'AGENT_TOOL_DENIED_PLAN_MODE',
        message: `计划模式不允许执行工具 ${toolName}。`
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
      const allowed = isToolAllowedInMode(call.name, request.permissionMode, registered);
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
          emit({ type: 'tool-call-begin', step: steps, callId: batchEntry.call.id, name: batchEntry.call.name });
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
