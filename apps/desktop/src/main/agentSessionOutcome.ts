import type { AgentSessionRunResult } from '@soulforge/core';

export type AgentSessionOutcomeEvent =
  | {type:'session-error';code:string;message:string}
  | {type:'session-done';finishReason:string;steps:number;rolloutFileName:string};

/** Project actual terminal diagnostics without inventing assistant output. */
export function agentSessionOutcomeEvents(result:AgentSessionRunResult,rolloutFileName:string):AgentSessionOutcomeEvent[]{
  const events:AgentSessionOutcomeEvent[]=[];
  events.push({type:'session-done',finishReason:result.run.finishReason,steps:result.run.steps,rolloutFileName});
  if(result.run.finishReason==='error'){
    const errors=result.run.diagnostics.filter(diagnostic=>diagnostic.severity==='error');
    const diagnostic=result.kernel.reason==='provider_error'
      ? [...errors].reverse().find(entry=>entry.code.startsWith('MODEL_SERVICE_')||entry.code.startsWith('AGENT_PROVIDER_')) ?? errors.at(-1)
      : errors.at(-1);
    events.push({type:'session-error',code:diagnostic?.code ?? 'AGENT_RUN_FAILED',message:diagnostic?.message ?? 'Agent control ended with an error; inspect the session rollout.'});
  }
  return events;
}
