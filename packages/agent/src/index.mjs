/** Finite control kernel. Domain authority, provider transports and resource data stay in host ports. */
import { createHash } from 'node:crypto';
export const AGENT_PROTOCOL_VERSION = 1;
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
const positive = (value, fallback) => Number.isSafeInteger(value) && value > 0 ? value : fallback;
const budgetDefaults = Object.freeze({ maxSteps: 200, timeoutMs: 1800000, maxOutputTokens: 100000, maxContextBytes: 2097152, maxResultBytes: 65536, maxResponseBytes: 131072, maxToolCallsPerTurn: 32 });
const deniedDecisions = new Set(['reject', 'never', 'timed_out', 'abort']);
const approvalLevels = new Set(['stage', 'commit', 'rollback']);
function hashProposal(call) { return createHash('sha256').update(JSON.stringify([call.name, call.argumentsJson])).digest('hex'); }
function boundedAwait(promise, signal) {
    if (!signal)
        return promise;
    let handler;
    const cancelled = new Promise((_, reject) => { handler = () => reject(Object.assign(new Error('Run cancelled'), { code: 'AGENT_CANCELLED' })); if (signal.aborted)
        handler();
    else
        signal.addEventListener('abort', handler, { once: true }); });
    return Promise.race([promise, cancelled]).finally(() => signal.removeEventListener('abort', handler));
}
export async function runFiniteAgent(options) {
    const limits = Object.fromEntries(Object.entries(budgetDefaults).map(([key, value]) => [key, positive(options.limits?.[key], value)]));
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted)
        controller.abort();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, limits.timeoutMs);
    const redact = options.redact ?? (text => text);
    const messages = options.messages.map(message => ({ ...message }));
    const tools = new Map(options.tools.map(tool => [tool.name, tool]));
    const seenCallIds = new Set();
    const toolCalls = [], transactions = [], diagnostics = [], unresolvedCalls = [];
    let eventSeq = 0, steps = 0, outputTokens = 0, cost = 0, state = 'running', reason = '';
    let pendingApproval;
    let modelAttempt = 0;
    const emit = event => options.onEvent?.({ protocolVersion: AGENT_PROTOCOL_VERSION, sessionId: options.sessionId, runId: options.runId, requestId: options.requestId, eventSeq: ++eventSeq, event: JSON.parse(JSON.stringify(event, (_key, value) => typeof value === 'string' ? redact(value) : value)) });
    const append = (message) => { messages.push(message); options.recordMessage?.(message, steps); };
    const finish = (next, why) => { state = next; reason = why; };
    const toolResult = (call, result) => {
        if (result.transaction) {
            transactions.push(result.transaction);
            emit({ type: 'transaction-observed', callId: call.id, transaction: result.transaction });
        }
        let content = redact(result.content ?? '{}');
        if (bytes(content) > limits.maxResultBytes) {
            result = { ...result, ok: false, code: 'AGENT_RESULT_BUDGET_EXCEEDED' };
            content = JSON.stringify({ ok: false, code: result.code, message: 'Result exceeded the bounded page budget; use a narrower read or continuation.', ...(result.transaction ? { transaction: result.transaction } : {}) });
        }
        append({ role: 'tool', name: call.name, toolCallId: call.id, content });
        toolCalls.push({ name: call.name, ok: result.ok, ...(result.code ? { code: result.code } : {}) });
        emit({ type: 'tool-call-end', step: steps, callId: call.id, name: call.name, ok: result.ok, ...(result.code ? { code: result.code } : {}) });
    };
    try {
        emit({ type: 'run-started', kernel: 'finite', evaluation: 'unverified', strategy: options.strategy ?? 'on-demand' });
        if (options.limits?.maxCost !== undefined && (!(options.limits.maxCost >= 0) || !Number.isFinite(options.limits.maxCost) || !options.pricing || !Number.isFinite(options.pricing.inputPerMillion) || !Number.isFinite(options.pricing.outputPerMillion) || options.pricing.inputPerMillion < 0 || options.pricing.outputPerMillion < 0))
            finish('partial', 'cost_configuration_required');
        while (state === 'running' && steps < limits.maxSteps) {
            if (controller.signal.aborted) {
                finish('cancelled', timedOut ? 'time_budget' : 'cancelled');
                break;
            }
            if (outputTokens >= limits.maxOutputTokens) {
                finish('partial', 'output_budget');
                break;
            }
            if (options.prepareContext) {
                await boundedAwait(options.prepareContext(messages, controller.signal, emit), controller.signal);
            }
            if (bytes(messages) > limits.maxContextBytes) {
                finish('partial', 'context_budget');
                break;
            }
            const remaining = limits.maxOutputTokens - outputTokens;
            const maxTokens = Math.min(remaining, positive(options.maxTokens, remaining));
            if (options.limits?.maxCost !== undefined) {
                const reserve = (bytes([messages, options.tools]) * options.pricing.inputPerMillion + maxTokens * options.pricing.outputPerMillion) / 1e6;
                if (cost + reserve > options.limits.maxCost) {
                    finish('partial', 'cost_budget');
                    break;
                }
            }
            ++steps;
            emit({ type: 'turn-started', step: steps });
            const completion = await boundedAwait(options.model({ messages, tools: options.tools, maxTokens, signal: controller.signal, step: steps, emitEvent: emit }), controller.signal);
            if (bytes(completion) > limits.maxResponseBytes) {
                finish('partial', 'response_budget');
                break;
            }
            diagnostics.push(...(completion.diagnostics ?? []).map(d => ({ ...d, message: redact(d.message) })));
            const used = Number.isFinite(completion.usage?.outputTokens) && completion.usage.outputTokens >= 0 ? completion.usage.outputTokens : Math.ceil(bytes(completion.message) / 4);
            outputTokens += used;
            if (options.pricing) {
                cost += ((completion.usage?.inputTokens ?? Math.ceil(bytes(messages) / 4)) * options.pricing.inputPerMillion + used * options.pricing.outputPerMillion) / 1e6;
            }
            ++modelAttempt;
            if (completion.finishReason === 'error' && options.retryDecision) {
                const retry = options.retryDecision(completion.diagnostics ?? [], modelAttempt);
                if (retry.retry) {
                    emit({ type: 'retry-scheduled', step: steps, attempt: modelAttempt, maxAttempts: retry.maxAttempts, delayMs: retry.delayMs, code: retry.code ?? 'MODEL_SERVICE_ERROR' });
                    await boundedAwait(new Promise(resolve => setTimeout(resolve, retry.delayMs)), controller.signal);
                    continue;
                }
            }
            modelAttempt = 0;
            const message = { ...completion.message, content: redact(completion.message.content), ...(completion.message.toolCalls ? { toolCalls: completion.message.toolCalls.map(call => ({ ...call, argumentsJson: redact(call.argumentsJson) })) } : {}) };
            const calls = message.toolCalls ?? [];
            if (calls.length > limits.maxToolCallsPerTurn) {
                finish('partial', 'tool_call_budget');
                break;
            }
            const turnCallIds = new Set();
            const invalidCall = calls.some(call => {
                if (!call || typeof call.id !== 'string' || !call.id.trim()
                    || typeof call.name !== 'string' || typeof call.argumentsJson !== 'string'
                    || seenCallIds.has(call.id) || turnCallIds.has(call.id)) return true;
                turnCallIds.add(call.id);
                return false;
            });
            if (invalidCall) {
                diagnostics.push({severity:'error',code:'AGENT_TOOL_CALL_IDENTITY_INVALID',message:'Provider tool call identities must be valid and unique for the run; no calls from this response were executed.'});
                finish('error', 'tool_call_identity_invalid');
                break;
            }
            for (const id of turnCallIds) seenCallIds.add(id);
            append(message);
            if (completion.finishReason === 'cancelled') {
                finish('cancelled', 'provider_cancelled');
                break;
            }
            if (completion.finishReason === 'error') {
                finish('error', 'provider_error');
                break;
            }
            if (calls.length === 0) {
                finish(completion.finishReason === 'length' ? 'partial' : 'completed', completion.finishReason === 'length' ? 'provider_length' : 'model_stopped');
                break;
            }
            for (const call of calls) {
                if (controller.signal.aborted) {
                    finish('cancelled', timedOut ? 'time_budget' : 'cancelled');
                    break;
                }
                emit({ type: 'tool-call-begin', step: steps, callId: call.id, name: call.name, argumentsJson: redact(call.argumentsJson) });
                const tool = tools.get(call.name);
                const allowed = tool ? options.allowTool(call, tool) : { ok: false, code: 'AGENT_TOOL_NOT_REGISTERED', message: 'Tool is not registered.' };
                if (!allowed.ok) {
                    toolResult(call, { ok: false, code: allowed.code, content: JSON.stringify({ ok: false, code: allowed.code, message: allowed.message }) });
                    continue;
                }
                if (options.permissionMode !== 'full' && approvalLevels.has(tool.permissionLevel)) {
                    const request = { step: steps, callId: call.id, toolName: call.name, permissionLevel: tool.permissionLevel, argumentsJson: redact(call.argumentsJson), proposalHash: hashProposal(call) };
                    if (options.resolveApprovalDiff) {
                        const diff = await boundedAwait(options.resolveApprovalDiff({ toolName: call.name, argumentsJson: call.argumentsJson }), controller.signal);
                        if (diff)
                            request.diff = diff;
                    }
                    emit({ type: 'approval-requested', ...request });
                    if (!options.requestApproval) {
                        pendingApproval = { call: { ...call }, proposalHash: request.proposalHash, step: steps };
                        finish('waiting', 'approval_required');
                        break;
                    }
                    const decision = await boundedAwait(options.requestApproval(request), controller.signal);
                    emit({ type: 'approval-resolved', step: steps, callId: call.id, toolName: call.name, decision: decision.decision, fromMemory: false });
                    if (deniedDecisions.has(decision.decision)) {
                        toolResult(call, { ok: false, code: 'AGENT_APPROVAL_DENIED', content: JSON.stringify({ ok: false, decision: decision.decision }) });
                        if (decision.decision === 'abort')
                            finish('cancelled', 'approval_aborted');
                        continue;
                    }
                    if (decision.decision !== 'once' && decision.decision !== 'always') {
                        finish('error', 'approval_response_invalid');
                        break;
                    }
                }
                try {
                    const result = await boundedAwait(options.executeTool(call, { signal: controller.signal }), controller.signal);
                    toolResult(call, result);
                }
                catch (error) {
                    unresolvedCalls.push({ callId: call.id, toolName: call.name, state: 'unknown', retryable: false });
                    emit({ type: 'operation-unresolved', callId: call.id, toolName: call.name, state: 'unknown', retryable: false });
                    diagnostics.push({ severity: 'error', code: 'AGENT_TOOL_OUTCOME_UNKNOWN', message: redact(error.message ?? String(error)) });
                    finish(controller.signal.aborted ? 'cancelled' : 'error', 'tool_outcome_unknown');
                    break;
                }
                if (controller.signal.aborted) {
                    finish('cancelled', timedOut ? 'time_budget' : 'cancelled');
                    break;
                }
            }
            emit({ type: 'step-complete', step: steps, finishReason: completion.finishReason });
        }
        if (state === 'running')
            finish('partial', 'step_budget');
    }
    catch (error) {
        finish(controller.signal.aborted ? 'cancelled' : 'error', controller.signal.aborted ? (timedOut ? 'time_budget' : 'cancelled') : 'provider_error');
        diagnostics.push({ severity: 'error', code: error.code ?? 'AGENT_RUN_FAILED', message: redact(error.message ?? String(error)) });
    }
    finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
    }
    const finishReason = state === 'completed' ? 'stop' : state === 'waiting' ? 'waiting' : state;
    emit({ type: 'turn-complete', finishReason, steps });
    return { state, reason, finishReason, steps, messages, diagnostics, toolCalls, transactions, unresolvedCalls, outputTokens, cost, evaluation: 'unverified', ...(pendingApproval ? { pendingApproval } : {}) };
}
