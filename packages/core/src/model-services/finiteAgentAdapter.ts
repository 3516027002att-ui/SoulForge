/** Domain-neutral adapter from existing transports/rollouts to the independent finite control package. */
import { runFiniteAgent, type FiniteAgentResult, type KernelTransaction } from '../../../agent/src/index.mjs';
import { decideRetry, resolveRetryPolicy } from './retryPolicy.js';
import { estimateContextTokens, runCompaction } from './contextCompactor.js';
import { DYNAMIC_EVIDENCE_SYSTEM_PREFIX } from './contextBroker.js';
import { isToolAllowedInMode, redactSecrets } from './agentLoop.js';
import type { AgentRunRequest, AgentRunResult, AgentEvent, ModelCompleteResult } from './types.js';

function transactionFromContent(content: string): KernelTransaction | undefined {
  try {
    const root = JSON.parse(content) as Record<string, unknown>;
    const data = root.data as Record<string, unknown> | undefined;
    const record = data?.record as Record<string, unknown> | undefined;
    for (const candidate of [root.transaction, data?.transaction, record?.transaction]) {
      if (!candidate || typeof candidate !== 'object') continue;
      const value = candidate as Record<string, unknown>;
      if (['not_committed','committed','unknown','recovery_required','rolled_back'].includes(String(value.state))) {
        return { ...value, ...(typeof value.opId === 'string' ? {opId:value.opId}:{}), state: value.state as KernelTransaction['state'] };
      }
    }
  } catch { /* Results are not required to be JSON. */ }
  return undefined;
}

export async function runFiniteAgentAdapter(
  adapter: import('./types.js').ModelServiceAdapter,
  request: AgentRunRequest,
  options: {
    runId: string; requestId: string;
    onProtocolEvent?: (event: import('../../../agent/src/index.mjs').AgentProtocolEvent) => void;
    limits?: import('../../../agent/src/index.mjs').KernelLimits;
    pricing?: { inputPerMillion: number; outputPerMillion: number };
  }
): Promise<{ run: AgentRunResult; kernel: FiniteAgentResult }> {
  const names = new Set(request.tools.map(tool => tool.name));
  const levels = new Map(request.tools.map(tool => [tool.name, tool.permissionLevel ?? 'read']));
  let contextMessages: import('./types.js').ChatMessage[] = [];
  let step = 0;
  const kernel = await runFiniteAgent({
    sessionId: request.sessionId ?? options.runId, runId: options.runId, requestId: options.requestId,
    permissionMode: request.permissionMode, messages: request.messages, tools: request.tools,
    ...(request.signal ? { signal: request.signal } : {}),
    limits: { ...options.limits, ...(request.maxSteps != null ? { maxSteps: request.maxSteps } : {}),
      ...(request.timeoutMs != null ? { timeoutMs: request.timeoutMs } : {}),
      ...(request.maxTotalOutputTokens != null ? { maxOutputTokens: request.maxTotalOutputTokens } : {}) },
    ...(options.pricing ? { pricing: options.pricing } : {}),
    ...(request.sampling?.maxTokens ? { maxTokens: request.sampling.maxTokens } : {}),
    redact: text => redactSecrets(request.apiKey ? text.replaceAll(request.apiKey, '[REDACTED]') : text),
    allowTool: call => isToolAllowedInMode(call.name, request.permissionMode, names, levels),
    executeTool: async (call, context) => {
      const result = await request.executeTool(call, context);
      const transaction = transactionFromContent(result.content);
      return { ...result, ...(transaction ? { transaction } : {}) };
    },
    ...(request.requestApproval ? { requestApproval: request.requestApproval } : {}),
    ...(request.resolveApprovalDiff ? { resolveApprovalDiff: request.resolveApprovalDiff } : {}),
    prepareContext: async (messages, signal, emitEvent) => {
      contextMessages = [];
      if (request.compaction?.autoCompactTokenLimit && estimateContextTokens(messages) >= request.compaction.autoCompactTokenLimit) {
        const compacted = await runCompaction(adapter, {messages,signal,...(request.timeoutMs ? {timeoutMs:request.timeoutMs}:{}),options:request.compaction});
        if (!compacted.ok) throw Object.assign(new Error(compacted.diagnostics[0]?.message ?? 'Context compaction failed.'), {code:'AGENT_COMPACTION_FAILED'});
        messages.splice(0,messages.length,...compacted.replacementMessages);
        request.rollout?.enqueue({type:'compacted',at:new Date().toISOString(),windowId:`finite-${step}`,replacementHistory:messages});
        emitEvent({type:'context-compacted',step,reason:'auto',tokenLimit:request.compaction.autoCompactTokenLimit});
      }
      if (request.contextBroker) {
        const assembled = await request.contextBroker.assemble(messages.filter(message=>message.role==='tool').slice(-16).map(message=>({kind:'toolResult' as const,text:message.content})), {...request.contextBrokerOptions,signal});
        if (assembled.ok) {
          contextMessages.push({role:'system',content:assembled.systemPrefix ?? DYNAMIC_EVIDENCE_SYSTEM_PREFIX}, {role:'user',content:assembled.context});
          emitEvent({type:'context-assembled',step,sections:assembled.sections.length,totalBytes:assembled.totalBytes});
        } else if (assembled.code !== 'insufficient_evidence') throw Object.assign(new Error(assembled.message), {code:assembled.code});
      }
      if (request.ragSearch && (request.taskQuery??'').trim()) {
        const result = await request.ragSearch.retrieve(request.taskQuery!);
        if (result.ok) {
          const hits=result.hits.slice(0,Math.max(1,Math.min(8,request.ragSearch.maxHits??4)));
          if (hits.length) contextMessages.push({role:'system',content:DYNAMIC_EVIDENCE_SYSTEM_PREFIX},{role:'user',content:`[UNTRUSTED_RAG_EVIDENCE_BEGIN]\n${hits.map(hit=>`${hit.chunk.symbolUri}: ${hit.excerpt}`).join('\n')}\n[UNTRUSTED_RAG_EVIDENCE_END]`});
        }
      }
      if (Buffer.byteLength(JSON.stringify([...messages,...contextMessages]),'utf8') > (options.limits?.maxContextBytes ?? 2_097_152)) throw Object.assign(new Error('Bounded provider context exceeded its byte budget.'),{code:'AGENT_CONTEXT_BUDGET_EXCEEDED'});
    },
    retryDecision: (diagnostics,attempt) => ({...decideRetry(diagnostics,attempt,resolveRetryPolicy(request.retryPolicy)),maxAttempts:resolveRetryPolicy(request.retryPolicy).maxAttempts}),
    strategy: request.ragSearch ? 'automatic' : 'on-demand',
    recordMessage: (message, step) => request.rollout?.enqueue({ type: 'message', step, message }),
    onEvent: envelope => {
      options.onProtocolEvent?.(envelope);
      // Protocol-only state and transaction events never pretend to be legacy UI events.
      if (['turn-started','tool-call-begin','tool-call-end','approval-requested','approval-resolved','step-complete','turn-complete','agent-message-delta','agent-thinking-delta','context-compacted','context-assembled','retry-scheduled'].includes(envelope.event.type)) {
        request.onEvent?.(envelope.event as AgentEvent);
      }
    },
    model: async (input) => {
      step = input.step;
      const modelRequest = { messages: [...input.messages,...contextMessages], tools: request.tools,
        ...(request.sampling ? request.sampling : {}), maxTokens: input.maxTokens, signal: input.signal,
        ...(request.timeoutMs != null ? { timeoutMs: request.timeoutMs } : {}),
        ...(request.sessionId ? { sessionId: request.sessionId } : {}) };
      if (!request.streaming) return adapter.complete(modelRequest);
      let content = '';
      const calls: import('./types.js').ToolCall[] = [];
      const diagnostics: ModelCompleteResult['diagnostics'] = [];
      let finishReason: ModelCompleteResult['finishReason'] = 'stop';
      let usage: ModelCompleteResult['usage'];
      for await (const event of adapter.stream(modelRequest)) {
        if (event.type === 'text-delta') {
          content += event.text;
          input.emitEvent({ type: 'agent-message-delta', step: input.step, text: event.text });
        } else if (event.type === 'thinking-delta') {
          input.emitEvent({ type: 'agent-thinking-delta', step: input.step, text: event.text });
        } else if (event.type === 'tool-call') calls.push(event.toolCall);
        else if (event.type === 'usage') usage = { ...usage, ...event };
        else if (event.type === 'error') { finishReason = 'error'; diagnostics.push({ severity: 'error', code: event.code, message: event.message }); break; }
        else if (event.type === 'message-stop') { finishReason = event.finishReason; break; }
        if (Buffer.byteLength(content, 'utf8') + Buffer.byteLength(JSON.stringify(calls), 'utf8') > (options.limits?.maxResponseBytes ?? 131_072)) {
          throw Object.assign(new Error('Stream exceeded the bounded response budget.'), { code: 'AGENT_RESPONSE_BUDGET_EXCEEDED' });
        }
      }
      return { message: { role: 'assistant', content, ...(calls.length ? { toolCalls: calls } : {}) },
        finishReason: calls.length && finishReason === 'stop' ? 'tool_use' : finishReason,
        diagnostics, ...(usage ? { usage } : {}) };
    }
  });
  const run: AgentRunResult = {
    messages: kernel.messages, steps: kernel.steps, finishReason: kernel.finishReason, diagnostics: kernel.diagnostics,
    audit: { configId: request.config.id, protocol: request.config.protocol,
      permissionMode: request.permissionMode, toolCalls: kernel.toolCalls, redacted: true,
      ...(request.streaming ? { streaming: true } : {}) }
  };
  request.rollout?.enqueue({ type: 'turn-complete', at: new Date().toISOString(), finishReason: run.finishReason,
    taskStatus: kernel.state === 'completed' ? 'completed' : kernel.state === 'cancelled' ? 'cancelled' : kernel.state === 'error' ? 'error' : 'partial',
    steps: run.steps, diagnostics: run.diagnostics });
  await request.rollout?.flush();
  return { run, kernel };
}
