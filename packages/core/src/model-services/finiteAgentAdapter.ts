/** Domain-neutral adapter from existing transports/rollouts to the independent finite control package. */
import { runFiniteAgent, type FiniteAgentResult, type KernelTransaction } from '../../../agent/src/index.mjs';
import { decideRetry, resolveRetryPolicy, DEFAULT_STREAM_MAX_RETRIES } from './retryPolicy.js';
import { estimateContextTokens, isContextOverflowDiagnostic, runCompaction } from './contextCompactor.js';
import { DYNAMIC_EVIDENCE_SYSTEM_PREFIX, upsertContextEvidenceSources } from './contextBroker.js';
import { isToolAllowedInMode, redactSecrets, assertNoSecretLeak, extractSwitchedAgentPermissionMode } from './agentPolicy.js';
import { makeToolEvidenceSource, envelopeKnowledgeRefreshStatus, isHealthyKnowledgeRefreshStatus } from './agentEvidenceProjection.js';
import {canonicalizeToolFailureContent,failureCodeFromContent} from './agentResultPolicy.js';
import { classifyFetchError } from './errorClassification.js';
import type { RagRetrieveResult } from '@soulforge/shared';
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
  const levels = new Map(request.tools.filter(tool=>tool.permissionLevel!==undefined).map(tool => [tool.name, tool.permissionLevel!]));
  let contextMessages: import('./types.js').ChatMessage[] = [];
  let step = 0;
  let compactionWindows = 0;
  let ragSearchWindow = -1;
  let cachedRagResult: RagRetrieveResult | undefined;
  let currentMode = request.permissionMode;
  let degradedRefresh: string | undefined;
  let pendingOverflowCompaction = false;
  let overflowRecoveryUsed = false;
  let evidenceVersion = 0;
  let assembledEvidenceVersion = -1;
  let assembledEvidenceWindow = -1;
  const evidenceQueue: import('./types.js').ContextEvidenceSource[] = [];
  const retries: NonNullable<AgentRunResult['audit']['retries']> = [];
  const compactions: NonNullable<AgentRunResult['audit']['compactions']> = [];
  const contextAssemblies: NonNullable<AgentRunResult['audit']['contextAssemblies']> = [];
  const retryPolicy = resolveRetryPolicy({...request.retryPolicy,...(request.streaming ? {maxAttempts:request.streamMaxRetries != null ? request.streamMaxRetries+1 : request.retryPolicy?.maxAttempts ?? DEFAULT_STREAM_MAX_RETRIES+1}: {})});
  const initialUserQuery = request.taskQuery?.trim() ?? '';
  const contextDiagnostics: ModelCompleteResult['diagnostics'] = [];
  if(request.ragSearch && !initialUserQuery)contextDiagnostics.push({severity:'warning',code:'AGENT_TASK_QUERY_MISSING',message:'缺少固定 external taskQuery，已跳过自动 RAG 检索；不会从 role=user 历史猜测任务。'});
  const kernel = await runFiniteAgent({
    sessionId: request.sessionId ?? options.runId, runId: options.runId, requestId: options.requestId,
    permissionMode: request.permissionMode, messages: request.messages, tools: request.tools,
    ...(request.signal ? { signal: request.signal } : {}),
    limits: { ...options.limits, ...(request.maxSteps != null ? { maxSteps: request.maxSteps } : {}),
      ...(request.timeoutMs != null ? { timeoutMs: request.timeoutMs } : {}),
      ...(request.maxTotalOutputTokens != null ? { maxOutputTokens: request.maxTotalOutputTokens } : {}) },
    ...(options.pricing ? { pricing: options.pricing } : {}),
    // Preserve the Anthropic transport default and the existing shared budget
    // reservation default instead of sending the whole run ceiling per call.
    maxTokens: request.sampling?.maxTokens ?? (adapter.protocol === 'anthropic-compatible' ? 1024 : 4096),
    redact: text => redactSecrets(request.apiKey ? text.replaceAll(request.apiKey, '[REDACTED]') : text),
    allowTool: call => isToolAllowedInMode(call.name, currentMode, names, levels),
    executeTool: async (call, context) => {
      const allowed = isToolAllowedInMode(call.name, currentMode, names, levels);
      if (!allowed.ok) return {ok:false,code:allowed.code,content:JSON.stringify({ok:false,error:allowed})};
      const result = await request.executeTool(call, {...context,mode:currentMode==='full'?'fullPermission':currentMode});
      if (result.ok && call.name === 'switch_mode') currentMode = extractSwitchedAgentPermissionMode(result.content) ?? currentMode;
      const refresh = result.ok ? envelopeKnowledgeRefreshStatus(result.content) : undefined;
      if (refresh !== undefined && !isHealthyKnowledgeRefreshStatus(refresh)) degradedRefresh ??= refresh;
      const transaction = transactionFromContent(result.content);
      const normalized=canonicalizeToolFailureContent(result);
      const content=!result.ok && transaction ? JSON.stringify({...JSON.parse(normalized),transaction}) : normalized;
      return { ...result,content,...(!result.ok?{code:failureCodeFromContent(content) ?? result.code ?? 'TOOL_EXECUTION_FAILED'}:{}), ...(transaction ? { transaction } : {}) };
    },
    ...(request.approvalRequiredLevels ? {approvalRequiredLevels:request.approvalRequiredLevels}:{}),
    ...(request.requestApproval ? { requestApproval: request.requestApproval } : {}),
    ...(request.resolveApprovalDiff ? { resolveApprovalDiff: request.resolveApprovalDiff } : {}),
    prepareContext: async (messages, signal, emitEvent) => {
      contextMessages = [];
      if (pendingOverflowCompaction || (request.compaction?.autoCompactTokenLimit && estimateContextTokens(messages) >= request.compaction.autoCompactTokenLimit)) {
        const reason = pendingOverflowCompaction ? 'overflow' : 'auto';
        pendingOverflowCompaction = false;
        const compacted = await runCompaction(adapter, {messages,signal,...(request.timeoutMs ? {timeoutMs:request.timeoutMs}:{}),...(request.compaction?{options:request.compaction}:{})});
        if (!compacted.ok) {
          contextDiagnostics.push(...compacted.diagnostics);
          if (reason === 'overflow' || signal.aborted) throw Object.assign(new Error(compacted.message), {code:compacted.code});
        } else {
          messages.splice(0,messages.length,...compacted.replacementMessages);
          compactionWindows += 1;
          const tokenLimit=request.compaction?.autoCompactTokenLimit ?? 0;
          compactions.push({step,reason,tokenLimit,summaryBytes:Buffer.byteLength(compacted.summary,'utf8')});
          contextDiagnostics.push({severity:'info',code:'CONTEXT_COMPACTION_APPLIED',message:`Context compacted to ${messages.length} messages.`});
          request.rollout?.enqueue({type:'compacted',at:new Date().toISOString(),windowId:`finite-${compactionWindows}`,replacementHistory:messages});
          emitEvent({type:'context-compacted',step,reason,tokenLimit});
        }
      }
      if (request.contextBroker && (assembledEvidenceVersion !== evidenceVersion || assembledEvidenceWindow !== compactionWindows)) {
        const assembled = await request.contextBroker.assemble(evidenceQueue, {...request.contextBrokerOptions,signal});
        assembledEvidenceVersion=evidenceVersion;assembledEvidenceWindow=compactionWindows;
        if (assembled.ok) {
          if(assembled.systemPrefix)contextMessages.push({role:'system',content:assembled.systemPrefix});
          contextMessages.push({role:assembled.dynamic?'user':'system',content:assembled.context});
          contextAssemblies.push({ok:true,sections:assembled.sections.length,totalBytes:assembled.totalBytes,...(assembled.dynamic!==undefined?{dynamic:assembled.dynamic}:{}),...(assembled.actualWireBytes!==undefined?{actualWireBytes:assembled.actualWireBytes}:{}),...(assembled.omitted!==undefined?{omitted:assembled.omitted}:{})});
          contextDiagnostics.push({severity:'info',code:'CONTEXT_BROKER_ASSEMBLED',message:`Assembled ${assembled.sections.length} bounded evidence sections.`});
          emitEvent({type:'context-assembled',step,sections:assembled.sections.length,totalBytes:assembled.totalBytes});
        } else {
          contextAssemblies.push({ok:false,sections:0,totalBytes:0,code:assembled.code});
          contextDiagnostics.push(...assembled.diagnostics);
          contextMessages.push({role:'system',content:JSON.stringify({ok:false,state:'failed',error:{code:assembled.code,message:assembled.message}})});
          if(signal.aborted)throw signal.reason ?? new Error('Agent context cancelled.');
        }
      }
      // Preserve the configured automatic policy: retrieve the fixed external
      // query once per run and inject the same evidence once per context window.
      if (request.ragSearch && initialUserQuery && ragSearchWindow !== compactionWindows) {
        ragSearchWindow = compactionWindows;
        cachedRagResult ??= await request.ragSearch.retrieve(initialUserQuery);
        if(signal.aborted)throw signal.reason ?? new Error('Agent context cancelled.');
        const result = cachedRagResult;
        if (result.ok && result.hits.length) {
          const hits=result.hits.slice(0,Math.max(1,Math.min(8,Math.trunc(request.ragSearch.maxHits??4))));
          const lines=hits.map((hit,index)=>[`-- hit ${index+1} (score=${hit.score}, family=${hit.chunk.family}, uri=${hit.chunk.symbolUri}) --`,hit.excerpt].join('\n'));
          if(!contextMessages.some(message=>message.role==='system'&&message.content===DYNAMIC_EVIDENCE_SYSTEM_PREFIX))contextMessages.push({role:'system',content:DYNAMIC_EVIDENCE_SYSTEM_PREFIX});
          contextMessages.push({role:'user',content:`[UNTRUSTED_RAG_EVIDENCE_BEGIN]\n[rag-evidence query="${initialUserQuery.replaceAll('"','\\"')}" hits=${hits.length}]\n${lines.join('\n')}\n[UNTRUSTED_RAG_EVIDENCE_END]`});
          const diagnostic={severity:'info' as const,code:'RAG_EVIDENCE_INJECTED',message:`已注入 ${hits.length} 条工作区检索证据（查询「${initialUserQuery.slice(0,80)}」）。`};
          contextDiagnostics.push(diagnostic);emitEvent({type:'context-diagnostic',step,diagnostic});
        } else if(!result.ok){
          const diagnostic={severity:'warning' as const,code:result.code,message:`RAG 未注入证据：${result.message}`};
          contextDiagnostics.push(diagnostic);emitEvent({type:'context-diagnostic',step,diagnostic});
        }
      }
      if (Buffer.byteLength(JSON.stringify([...messages,...contextMessages]),'utf8') > (options.limits?.maxContextBytes ?? 2_097_152)) throw Object.assign(new Error('Bounded provider context exceeded its byte budget.'),{code:'AGENT_CONTEXT_BUDGET_EXCEEDED'});
    },
    retryDecision: (diagnostics,attempt) => {
      if(!overflowRecoveryUsed && isContextOverflowDiagnostic(diagnostics)){
        overflowRecoveryUsed=true;pendingOverflowCompaction=true;
        contextDiagnostics.push({severity:'info',code:'CONTEXT_OVERFLOW_RECOVERY',message:'Provider context overflow triggered bounded compaction recovery.'});
        return {retry:true,delayMs:0,code:'CONTEXT_OVERFLOW_RECOVERY',maxAttempts:1};
      }
      return {...decideRetry(diagnostics,attempt,retryPolicy),maxAttempts:retryPolicy.maxAttempts};
    },
    strategy: request.ragSearch ? 'automatic' : 'on-demand',
    emitCompletedMessage: request.streaming!==true,
    recordMessage: (message, step) => {
      request.rollout?.enqueue({ type: 'message', step, message });
      if(request.contextBroker && message.role==='tool' && upsertContextEvidenceSources(evidenceQueue,[makeToolEvidenceSource(message.name ?? 'tool',message.content,undefined,Boolean(request.contextBrokerOptions?.currentVersionByResource ?? request.contextBrokerOptions?.currentRevisionByResource))],request.contextBrokerOptions))evidenceVersion+=1;
    },
    onEvent: envelope => {
      options.onProtocolEvent?.(degradedRefresh!==undefined && envelope.event.type==='turn-complete'
        ? {...envelope,event:{...envelope.event,resourceOutcome:{status:'degraded',knowledgeRefresh:degradedRefresh}}} : envelope);
      if(envelope.event.type==='retry-scheduled'){
        const event=envelope.event as unknown as {step:number;attempt:number;code:string;delayMs:number};
        retries.push({step:event.step,attempt:event.attempt,code:event.code,delayMs:event.delayMs});
      }
      // Protocol-only state and transaction events never pretend to be legacy UI events.
      if (['turn-started','tool-call-begin','tool-call-end','approval-requested','approval-resolved','step-complete','turn-complete','agent-message-delta','agent-thinking-delta','context-compacted','context-assembled','retry-scheduled'].includes(envelope.event.type)) {
        request.onEvent?.(degradedRefresh!==undefined && envelope.event.type==='turn-complete' && envelope.event.finishReason==='stop'
          ? {...envelope.event,finishReason:'partial'} as AgentEvent : envelope.event as AgentEvent);
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
      try { for await (const event of adapter.stream(modelRequest)) {
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
      } } catch(error) {
        const diagnostic=classifyFetchError(error,adapter.protocol,input.signal,{callerSignal:input.signal});
        diagnostics.push(diagnostic);finishReason=input.signal.aborted?'cancelled':'error';
      }
      return { message: { role: 'assistant', content, ...(calls.length ? { toolCalls: calls } : {}) },
        finishReason: calls.length && finishReason === 'stop' ? 'tool_use' : finishReason,
        diagnostics, ...(usage ? { usage } : {}) };
    }
  });
  kernel.diagnostics.push(...contextDiagnostics);
  if(degradedRefresh!==undefined)kernel.diagnostics.push({severity:'warning',code:'AGENT_KNOWLEDGE_REFRESH_DEGRADED',message:`Committed resource outcome is retained; knowledge refresh remains ${degradedRefresh}.`});
  const run: AgentRunResult = {
    messages: kernel.messages, steps: kernel.steps, finishReason: degradedRefresh!==undefined&&kernel.finishReason==='stop'?'partial':kernel.finishReason, diagnostics: kernel.diagnostics,
    audit: { configId: request.config.id, protocol: request.config.protocol,
      permissionMode: request.permissionMode, toolCalls: kernel.toolCalls, redacted: true,
      ...(kernel.approvals.length ? {approvals:kernel.approvals}:{}),
      ...(retries.length ? {retries}:{}),...(compactions.length ? {compactions}:{}),...(contextAssemblies.length ? {contextAssemblies}:{}),
      ...(request.streaming ? { streaming: true } : {}) }
  };
  assertNoSecretLeak({messages:run.messages,audit:run.audit,diagnostics:run.diagnostics},request.apiKey);
  if(kernel.state==='cancelled')request.rollout?.enqueue({type:'interrupted',at:new Date().toISOString()});
  request.rollout?.enqueue({ type: 'turn-complete', at: new Date().toISOString(), finishReason: run.finishReason,
    taskStatus: run.finishReason === 'stop' ? 'completed' : run.finishReason === 'cancelled' ? 'cancelled' : run.finishReason === 'error' ? 'error' : 'partial',
    steps: run.steps, diagnostics: run.diagnostics });
  await request.rollout?.flush();
  return { run, kernel };
}
