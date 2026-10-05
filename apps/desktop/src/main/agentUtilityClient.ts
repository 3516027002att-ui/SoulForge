/** Trusted utilityProcess host. Domain calls stay in main; the provider loop has its own heap. */
import { utilityProcess } from 'electron';
import { fileURLToPath } from 'node:url';
import { runAgentHostTransport } from '../../../../packages/agent/src/hostTransport.mjs';
import type { AgentSessionRunParams, AgentSessionRunResult } from '@soulforge/core';

export function runAgentUtilitySession(params: AgentSessionRunParams): Promise<AgentSessionRunResult> {
  const { adapter: _adapter, executeTool, requestApproval, resolveApprovalDiff,
    recordProviderUsage, onEvent, onProtocolEvent, signal, contextBroker, ragSearch,
    ...serializable } = params;
  const callbacks: Record<string, (...args: any[]) => Promise<unknown>> = {
    executeTool: (call, override = {}) => {
      const signals = [override.signal,signal].filter((value): value is AbortSignal => value instanceof AbortSignal);
      return executeTool(call, { ...override, ...(signals.length ? {signal:AbortSignal.any(signals)}:{}) });
    }
  };
  if (requestApproval) callbacks.requestApproval = requestApproval;
  if (resolveApprovalDiff) callbacks.resolveApprovalDiff = resolveApprovalDiff;
  if (recordProviderUsage) callbacks.recordProviderUsage = recordProviderUsage;
  if (contextBroker) callbacks.assembleContext = (sources, options = {}) => {
    const signals = [options.signal,signal].filter((value): value is AbortSignal => value instanceof AbortSignal);
    return contextBroker.assemble(sources,{...options,...(signals.length?{signal:AbortSignal.any(signals)}:{})});
  };
  if (ragSearch) callbacks.retrieveRag = ragSearch.retrieve;
  const child = utilityProcess.fork(fileURLToPath(new URL('./agentUtility.js', import.meta.url)), [], {
    serviceName: 'SoulForge Agent', stdio: 'pipe'
  });
  // Credentials never enter stderr forwarding, UI events or host RPC results.
  return runAgentHostTransport<AgentSessionRunResult>(child, {
    ...serializable, ...(ragSearch?.maxHits ? { ragSearchMaxHits: ragSearch.maxHits } : {})
  }, callbacks, {
    ...(signal ? { signal } : {}), ...(onEvent ? { onEvent } : {}),
    ...(onProtocolEvent ? { onProtocolEvent } : {}),
    timeoutMs: params.kernelLimits?.timeoutMs ?? 1_800_000
  });
}
