/** Compatibility API for existing callers; all execution uses the shared finite kernel.
 * The retired legacy baseline is Git 217234bb97ee20e3a83048042c4a1e67e9a16d33.
 * Explicit experiment fixtures materialize that revision outside production sources.
 * Related retry/rollout capabilities derive from OpenAI Codex (Apache-2.0);
 * see https://github.com/openai/codex, NOTICE and licenses/openai-codex.txt.
 */
import { randomUUID } from 'node:crypto';
import { createProviderBudget } from '../../../agent/src/providerBudget.mjs';
import { runFiniteAgentAdapter } from './finiteAgentAdapter.js';
import type { AgentRunRequest, AgentRunResult, ModelServiceAdapter } from './types.js';
export { redactSecrets, assertNoSecretLeak, isToolAllowedInMode,
  DEFAULT_APPROVAL_REQUIRED_LEVELS, extractSwitchedAgentPermissionMode } from './agentPolicy.js';

export async function runAgentToolLoop(adapter: ModelServiceAdapter, request: AgentRunRequest): Promise<AgentRunResult> {
  const runId = request.sessionId ?? randomUUID();
  const budget = createProviderBudget(adapter, { maxOutputTokens: request.maxTotalOutputTokens ?? 100_000 });
  return (await runFiniteAgentAdapter(budget.adapter, request, {runId, requestId:runId})).run;
}
