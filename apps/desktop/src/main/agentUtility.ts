/** Utility process entry: no workspace, index, native document or renderer access. */
import { BoundedEventSender } from '../../../../packages/agent/src/eventSender.mjs';
import { createConfiguredModelServiceAdapter, createAgentRunAssembly, toAgentSessionTerminalResult,
  type AgentSessionRunParams } from '@soulforge/core';
const parent = process.parentPort;
let started = false, nextId = 0, nextEventId = 0;
const pendingEvents = new Map<number, {resolve():void;reject(error:Error):void;timer:NodeJS.Timeout}>();
const eventSender = new BoundedEventSender<{type:string;event:unknown}>(frame => new Promise((resolve,reject) => {
  const id=++nextEventId;
  const timer=setTimeout(()=>{pendingEvents.delete(id);reject(Object.assign(new Error('Agent event consumer did not acknowledge its bounded page.'),{code:'AGENT_EVENT_ACK_TIMEOUT'}));},10000);
  pendingEvents.set(id,{resolve,reject,timer});parent.postMessage({...frame,id});
}));
const controller = new AbortController();
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
const cleanContext = (value: Record<string, unknown> | undefined) => {
  const { signal: _signal, ...rest } = value ?? {};
  return rest;
};
function rpc(method: string, args: unknown[], signal?: AbortSignal): Promise<any> {
  if (pending.size >= 16) return Promise.reject(Object.assign(new Error('Agent host queue is full.'), { code: 'AGENT_HOST_QUEUE_LIMIT' }));
  const id = ++nextId;
  const onAbort = () => parent.postMessage({type:'rpc-cancel',id});
  const result = new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); parent.postMessage({ type: 'rpc', id, method, args }); });
  signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();
  return result.finally(()=>signal?.removeEventListener('abort',onAbort));
}
parent.on('message', async event => {
  const message = event.data;
  if (message?.type === 'event-ack') {
    const event=pendingEvents.get(message.id);if(!event)return;clearTimeout(event.timer);pendingEvents.delete(message.id);
    if(message.ok)event.resolve();else event.reject(Object.assign(new Error('Agent event delivery failed.'),{code:'AGENT_EVENT_DELIVERY_FAILED'}));return;
  }
  if (message?.type === 'cancel') { controller.abort(); return; }
  if (message?.type === 'rpc-result') {
    const request = pending.get(message.id); if (!request) return;
    pending.delete(message.id);
    if (message.ok) request.resolve(message.result);
    else request.reject(Object.assign(new Error(message.error?.message ?? 'Host call failed.'), { code: message.error?.code }));
    return;
  }
  if (message?.type !== 'start' || started) return;
  started = true;
  const params = message.params as Omit<AgentSessionRunParams, 'adapter' | 'executeTool'> & {ragSearchMaxHits?:number};
  const capabilities = new Set<string>(message.capabilities);
  try {
    const adapterResult = createConfiguredModelServiceAdapter({ config: params.config, apiKey: params.apiKey, ...(params.sessionId ? { sessionId: params.sessionId } : {}) });
    if (!adapterResult.ok) throw Object.assign(new Error('Invalid provider configuration.'), { code: 'AGENT_PROVIDER_INVALID' });
    const assembly = createAgentRunAssembly({ tools: params.tools, executeTool: (call, override) => rpc('executeTool', [call, cleanContext(override)], override?.signal) });
    const result = await assembly.run({
      ...params, adapter: adapterResult.adapter, signal: controller.signal,
      ...(capabilities.has('requestApproval') ? { requestApproval: request => rpc('requestApproval', [request]) } : {}),
      ...(capabilities.has('resolveApprovalDiff') ? { resolveApprovalDiff: request => rpc('resolveApprovalDiff', [request]) } : {}),
      ...(capabilities.has('recordProviderUsage') ? { recordProviderUsage: sample => rpc('recordProviderUsage', [sample]) } : {}),
      ...(capabilities.has('assembleContext') ? { contextBroker: { assemble: (sources, options) => rpc('assembleContext', [sources, cleanContext(options as Record<string, unknown> | undefined)], options?.signal) } } : {}),
      ...(capabilities.has('retrieveRag') ? { ragSearch: { retrieve: query => rpc('retrieveRag', [query]), ...(params.ragSearchMaxHits ? { maxHits: params.ragSearchMaxHits } : {}) } } : {}),
      onEvent: event => eventSender.enqueue({ type: 'event', event }),
      onProtocolEvent: event => eventSender.enqueue({ type: 'protocol-event', event })
    });
    await eventSender.flush();
    parent.postMessage({ type: 'result', result:toAgentSessionTerminalResult(result) });
  } catch (error) {
    const value = error as Error & {code?:string};
    const text = params.apiKey ? value.message.replaceAll(params.apiKey, '[REDACTED]') : value.message;
    parent.postMessage({ type: 'error', error: { code: value.code ?? 'AGENT_PROCESS_FAILED', message: text } });
  }
});
