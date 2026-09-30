import { randomUUID } from 'node:crypto';
import type { AgentToolBridge } from '../ai/agentToolBridge.js';
import { LocalSessionHost } from '../cli/localSessionHost.js';
import type { CoreToolSession } from '../runtime/coreToolSession.js';
import { runAgentSession, type AgentSessionRunParams } from './agentSessionHost.js';

/** Desktop, CLI and evaluators use one assembly surface over the same domain bridge. */
export function createAgentRunAssembly(bridge: AgentToolBridge, options: {
  sessionRunner?: typeof runAgentSession;
  coreSession?: CoreToolSession;
} = {}) {
  const pendingOperations = new Set<Promise<unknown>>();
  return {
    async waitForHostOperations() {
      while (pendingOperations.size) await Promise.allSettled([...pendingOperations]);
    },
    run(params: Omit<AgentSessionRunParams, 'tools' | 'executeTool'>) {
      const sessionId = params.sessionId ?? randomUUID();
      const host = options.coreSession ? new LocalSessionHost(`agent:${sessionId}`,
        options.coreSession.workspaceId, options.coreSession.principal, options.coreSession) : undefined;
      const dispatchTool: AgentToolBridge['executeTool'] = host ? async (call, override = {}) => {
        let args: Record<string, unknown>;
        try { args = JSON.parse(call.argumentsJson || '{}') as Record<string, unknown>; }
        catch { return bridge.executeTool(call, override); }
        const outcome = await host.dispatch({ id: `${sessionId}:${call.id}`, tool: call.name, args },
          (_tool, _args, signal) => bridge.executeTool(call, { ...override, ...(signal ? { signal } : {}) }),
          override.signal ?? params.signal);
        // Storage owns this contract. Older hosts expose only result; the
        // integrated host additionally preserves request/transaction truth.
        const hostOutcome = outcome as typeof outcome & { requestState?: string; transaction?: {
          state: string; opId?: string; operations: {opId:string;state:string}[];
        } };
        const result = hostOutcome.result as {ok:boolean;content:string;code?:string} | undefined;
        const transaction = hostOutcome.transaction ? {
          state: hostOutcome.transaction.state,
          ...(hostOutcome.transaction.opId ? { opId: hostOutcome.transaction.opId } : {}),
          operations: hostOutcome.transaction.operations.map(operation => ({opId:operation.opId,state:operation.state}))
        } : undefined;
        const requestState = hostOutcome.requestState;
        if (result && typeof result.content === 'string' && typeof result.ok === 'boolean') {
          let payload: Record<string, unknown>;
          try { payload = JSON.parse(result.content) as Record<string, unknown>; }
          catch { payload = { content: result.content }; }
          return {...result,content:JSON.stringify({...payload,...(requestState?{requestState}:{}),...(transaction?{transaction}:{})})};
        }
        return {ok:false,code:hostOutcome.error?.code ?? 'AGENT_HOST_RESULT_UNAVAILABLE',content:JSON.stringify({ok:false,error:hostOutcome.error,...(requestState?{requestState}:{}),...(transaction?{transaction}:{})})};
      } : bridge.executeTool;
      const executeTool: AgentToolBridge['executeTool'] = (call,override) => {
        const task = Promise.resolve().then(()=>dispatchTool(call,override));
        pendingOperations.add(task);
        void task.then(()=>pendingOperations.delete(task),()=>pendingOperations.delete(task));
        return task;
      };
      return (options.sessionRunner ?? runAgentSession)({ ...params, sessionId, tools: bridge.tools, executeTool });
    }
  };
}
