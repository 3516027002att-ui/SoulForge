/** Experiment-only treatments; no production settings or alternate production kernel. */
import {createHash} from 'node:crypto';
import {LEGACY_AGENT_CONTROLS,selectLegacyAgentControl} from './legacy-agent-baseline.mjs';
export const BASELINE_LOOP_SHA256=LEGACY_AGENT_CONTROLS['historical-217'].loopSha256;
const path='packages/core/src/model-services/agentLoop.ts';
const rules={
 'empty-conclusion':{needle:"if (safeMessage.content.trim() === '' && steps > 1\n        && emptyConclusionRetries < MAX_EMPTY_CONCLUSION_RETRIES)",activationText:'请根据上述已执行的工具'},
 'future-action-conclusion':{needle:'if (looksLikeIncompleteConclusion(safeMessage.content))',activationText:'你刚才只描述了将要执行的动作'},
 'provider-length-conclusion':{needle:'if (!forcedConclusion && toolAudit.length > 0 && !lengthConclusionAttempted)',activationCode:'MODEL_SERVICE_LENGTH_FORCED_CONCLUSION'},
 'output-reserve-conclusion':{needle:'if (!forcedConclusion\n      && conclusionReserveTokens > 0\n      && toolAudit.length > 0\n      && maxTotalOutputTokens !== undefined\n      && maxTotalOutputTokens - totalOutputTokens <= conclusionReserveTokens)',activationCode:'AGENT_OUTPUT_BUDGET_CONCLUSION_RESERVED'},
 'identical-tool-failure':{needle:'if (consecutiveIdenticalToolFailures >= MAX_CONSECUTIVE_TOOL_FAILURES)',activationCode:'AGENT_CONSECUTIVE_TOOL_FAILURES_EXCEEDED'},
 'semantic-param-failure':{needle:'if (consecutiveSemanticToolFailures >= MAX_SEMANTIC_TOOL_FAILURES)',activationCode:'AGENT_SEMANTIC_TOOL_FAILURES_EXCEEDED'},
 'research-stall-conclusion':{needle:'if (consecutiveDiscoveryOnlyTurns >= MAX_RESEARCH_ONLY_TURNS && !shouldNudgeNativeFollowup)',activationCode:'AGENT_RESEARCH_BUDGET_EXHAUSTED'},
 'candidate-native-nudge':{needle:'if (shouldNudgeNativeFollowup)',activationText:'探索提示：本轮已定位到相关候选。'},
 'model-wording-partial':{needle:"const modelReportedPartial = completion.finishReason === 'stop'",activationCode:'AGENT_REPORTED_TASK_PARTIAL'}
};
export const AGENT_EXPERIMENTS=Object.freeze({
 'description-dedup':{kind:'description',variants:['repeated','deduplicated'],change:'Per-tool common-instruction repetition; shared system instruction and control kernel are fixed.'},
 'automatic-vs-on-demand-rag':{kind:'rag',variants:['automatic','on-demand'],change:'Retrieval/injection cadence over the same pinned independent metadata corpus, production retriever and tool definitions.'},
 ...Object.fromEntries(Object.entries(rules).map(([id,rule])=>[id,{kind:'heuristic',variants:['on','off'],change:'One source-hash-bound condition in the exact legacy control snapshot.',...rule}]))
});
const sha=value=>createHash('sha256').update(value).digest('hex');
export function experimentSourceTransform(id,variant,controlId){
 const control=selectLegacyAgentControl(controlId);
 const spec=AGENT_EXPERIMENTS[id];
 if(!spec)throw Object.assign(new Error('Experiment is unavailable: no defined isolated treatment.'),{code:'AGENT_EXPERIMENT_UNAVAILABLE'});
 if(!spec.variants.includes(variant))throw Object.assign(new Error('Unknown experiment variant.'),{code:'AGENT_EXPERIMENT_VARIANT_INVALID'});
 if(spec.kind!=='heuristic')return undefined;
 return (sourcePath,source)=>{
  if(sourcePath!==path)return undefined;
  if(sha(source)!==control.loopSha256)throw Object.assign(new Error('Pinned legacy control source does not match the treatment contract.'),{code:'AGENT_EXPERIMENT_BASELINE_DRIFT'});
  if(source.split(spec.needle).length!==2)throw Object.assign(new Error('Treatment condition must occur exactly once.'),{code:'AGENT_EXPERIMENT_CONDITION_DRIFT'});
  const replacement=id==='model-wording-partial'?spec.needle.replace('= completion','= false && completion'):spec.needle.replace('if (','if (false && (')+')';
  const materialized=variant==='off'?source.replace(spec.needle,replacement):source;
  return {source:materialized,treatment:{id,variant,controlId:control.id,revision:control.revision,sourcePath,originalSha256:sha(source),materializedSha256:sha(materialized),conditionSha256:sha(spec.needle),changed:variant==='off',changedConditions:variant==='off'?1:0}};
 };
}
export function experimentActivation(spec,report){
 const diagnostics=report.protocolEvents?.flatMap(envelope=>envelope.event?.diagnostic?[envelope.event.diagnostic]:[]) ?? [];
 const modelRequests=report.modelRequests ?? [];
 const messages=modelRequests.flatMap(request=>request.messages??[]);
 const matching=spec.activationText?messages.filter(message=>message.content?.includes(spec.activationText)):[];
 return {diagnosticCount:spec.activationCode?(report.runDiagnostics??diagnostics).filter(diagnostic=>diagnostic.code===spec.activationCode).length:0,controlMessageCount:new Set(matching.map(message=>`${message.role}:${message.content}`)).size,controlWireOccurrences:matching.length,interpretation:'Zero activation does not establish that the heuristic has no quality effect.'};
}
