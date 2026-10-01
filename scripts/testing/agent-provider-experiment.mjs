/** Experiment-only orchestration. Import and dry-run never open a provider or native process. */
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,stat,mkdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createOwnedNativeComparisonRuntime} from './owned-native-agent-comparison.mjs';
import {AGENT_EXPERIMENTS,experimentSourceTransform,experimentActivation} from './agent-experiment-treatments.mjs';
import {LEGACY_AGENT_BASELINE} from './legacy-agent-baseline.mjs';
const exec=promisify(execFile),sha=value=>createHash('sha256').update(value).digest('hex');
const fail=(code,message)=>Object.assign(new Error(message),{code});
const positive=(value,name)=>{if(!Number.isFinite(value)||value<=0)throw fail('AGENT_EXPERIMENT_BUDGET_REQUIRED',`Explicit positive ${name} is required.`);return value;};
const integer=(value,name)=>{positive(value,name);if(!Number.isSafeInteger(value))throw fail('AGENT_EXPERIMENT_BUDGET_INVALID',`${name} must be a safe integer.`);return value;};
export const REPORTING_INSTRUCTION='Return the final report as one JSON object with claimedStatus "completed", "blocked" or "partial" and observedRestBehavior. Provider termination is not independent task verification.';

export function validateExperimentInputs(input){
 const spec=AGENT_EXPERIMENTS[input.experiment];
 if(!spec)throw fail('AGENT_EXPERIMENT_UNAVAILABLE','No source-bound isolated treatment exists for this experiment. The full cutover does not isolate one heuristic.');
 const provider=input.provider;
 if(!provider||typeof provider!=='object')throw fail('AGENT_EXPERIMENT_PROVIDER_REQUIRED','An explicit selected provider/model/configuration is required, including in dry-run.');
 for(const key of Object.keys(provider))if(!['protocol','baseUrl','model','pricing','currency'].includes(key))throw fail('AGENT_EXPERIMENT_PROVIDER_FIELD_INVALID','Provider configuration accepts only protocol, baseUrl, model, pricing and currency; credentials stay host-local.');
 if(!['openai-compatible','openai-responses','anthropic-compatible'].includes(provider.protocol)||typeof provider.model!=='string'||!provider.model.trim())throw fail('AGENT_EXPERIMENT_PROVIDER_INVALID','Explicit supported protocol and model are required.');
 let url;try{url=new URL(provider.baseUrl);}catch{throw fail('AGENT_EXPERIMENT_PROVIDER_INVALID','Provider baseUrl must be a valid endpoint.');}
 if(url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw fail('AGENT_EXPERIMENT_PROVIDER_INVALID','Provider endpoint must be HTTPS or local loopback without credentials/query/fragment.');
 if(!provider.pricing||Object.keys(provider.pricing).some(key=>!['inputPerMillion','outputPerMillion'].includes(key))||!['inputPerMillion','outputPerMillion'].every(key=>Number.isFinite(provider.pricing[key])&&provider.pricing[key]>=0)||!/^[A-Z]{3}$/.test(provider.currency??''))throw fail('AGENT_EXPERIMENT_PRICING_REQUIRED','Explicit nonnegative per-million input/output prices and a currency code are required. Prices are not billing evidence.');
 const budget=input.budget??{};
 for(const key of ['maxCost','maxLegCost'])positive(budget[key],key);
 for(const key of ['maxOutputTokens','maxLegOutputTokens','timeoutMs','maxLegTimeoutMs','maxSteps'])integer(budget[key],key);
 if(budget.maxLegCost>budget.maxCost||budget.maxLegOutputTokens>budget.maxOutputTokens||budget.maxLegTimeoutMs>budget.timeoutMs||budget.maxSteps>200)throw fail('AGENT_EXPERIMENT_BUDGET_INVALID','Per-leg limits must fit the experiment limits; the existing 200-step bound remains.');
 const sampling=input.sampling??{temperature:0,topP:1,maxTokens:512};
 if(!Number.isFinite(sampling.temperature)||sampling.temperature<0||sampling.temperature>2||!Number.isFinite(sampling.topP)||sampling.topP<=0||sampling.topP>1)throw fail('AGENT_EXPERIMENT_SAMPLING_INVALID','Explicit sampling values are outside the supported ranges.');
 integer(sampling.maxTokens,'sampling.maxTokens');
 return {spec,provider,budget,sampling};
}

export async function previewAgentExperiment(input){
 const checked=validateExperimentInputs(input),runtime=createOwnedNativeComparisonRuntime({...input,quiet:true});
 const unavailable=[];
 const required={corpus:runtime.CORPUS_ROOT?join(runtime.CORPUS_ROOT,'mods',runtime.FILE):'',dotnet:runtime.DOTNET,oracle:runtime.ORACLE_ASSEMBLY,bridge:runtime.BRIDGE,core:join(runtime.ROOT,'packages/core/dist/index.js')};
 const identities={};
 for(const [name,path] of Object.entries(required)){
  if(!path||!existsSync(path)){unavailable.push({input:name,reason:'missing'});continue;}
  const info=await stat(path);if(!info.isFile()){unavailable.push({input:name,reason:'not-a-file'});continue;}
  identities[name]={path,byteLength:info.size,sha256:sha(await readFile(path))};
 }
 const manifest=JSON.parse(await readFile(runtime.MANIFEST,'utf8'));
 const fixture=manifest.correctnessFixtures.fixtures.find(item=>item.role==='emevd-primary');
 if(identities.corpus&&(identities.corpus.sha256!==fixture.sha256||identities.corpus.byteLength!==fixture.byteLength))unavailable.push({input:'corpus',reason:'pinned-input-mismatch'});
 if(identities.oracle&&identities.oracle.sha256!==runtime.ORACLE_SHA)unavailable.push({input:'oracle',reason:'pinned-input-mismatch'});
 let baseline,source;
 try{
  const [{stdout:blob},{stdout:head},{stdout:diff}]=await Promise.all([exec('git',['show',`${LEGACY_AGENT_BASELINE}:packages/core/src/model-services/agentLoop.ts`],{cwd:runtime.ROOT,maxBuffer:8388608}),exec('git',['rev-parse','HEAD'],{cwd:runtime.ROOT}),exec('git',['diff','--binary','HEAD'],{cwd:runtime.ROOT,maxBuffer:8388608})]);
  baseline={revision:LEGACY_AGENT_BASELINE,controlSourceSha256:sha(blob),treatments:checked.spec.variants.map(variant=>experimentSourceTransform(input.experiment,variant)?.('packages/core/src/model-services/agentLoop.ts',blob)?.treatment??{id:input.experiment,variant,controlSourceSha256:sha(blob),changedConditions:0})};
  source={commit:head.trim(),diffSha256:sha(diff)};
 }catch(error){if(error.code?.startsWith('AGENT_EXPERIMENT_'))throw error;unavailable.push({input:'legacy-baseline',reason:'exact-revision-unavailable'});}
 const build=await runtime.treeInputs(['packages/core/dist','packages/shared/dist','packages/agent/src','packages/agent/package.json']).catch(()=>undefined);
 const nativeBuild=identities.bridge?await runtime.treeInputs([dirname(resolve(required.bridge))]).catch(()=>undefined):undefined;
 const implementation=await runtime.treeInputs(['scripts/run-agent-provider-experiment.mjs','scripts/testing/agent-provider-experiment.mjs','scripts/testing/agent-experiment-treatments.mjs','scripts/testing/owned-native-agent-comparison.mjs','scripts/testing/legacy-agent-baseline.mjs']);
 if(!build)unavailable.push({input:'built-core',reason:'build-unavailable'});
 if(identities.bridge&&!nativeBuild)unavailable.push({input:'native-bridge-build',reason:'build-unavailable'});
 const tasks=runtime.SCENARIOS.map(task=>({...task,permissionMode:task.id==='false-model-success'?'plan':'normal',reportingInstruction:REPORTING_INSTRUCTION}));
 return {schema:'agent-provider-experiment-v1',status:unavailable.length?'unavailable':'ready',execution:'not_run',networkCalls:0,credentialAccess:false,experiment:{id:input.experiment,kind:checked.spec.kind,change:checked.spec.change,variants:checked.spec.variants},bindings:{source,implementationSha256:implementation.sha256,build:build?{sha256:build.sha256,fileCount:build.files.length}:undefined,nativeBuild:nativeBuild?{sha256:nativeBuild.sha256,fileCount:nativeBuild.files.length}:undefined,baseline,provider:{...checked.provider,configurationSha256:sha(JSON.stringify(checked.provider)),liveAvailability:'unverified'},sampling:checked.sampling,budget:checked.budget,resource:fixture,independentOracle:{commit:'ee1dd61958f60bdc51ce3da548e9a90a8ab39905',assemblySha256:runtime.ORACLE_SHA},identities,tasks,taskDefinitionsSha256:sha(JSON.stringify(tasks))},unavailable,results:[],acceptance:{status:'unverified',reason:'Real-model experiment has not run; the established native-task, wrong-write and false-success criteria remain unassessed'},limits:['One isolated treatment per command; this is not attribution of the full default cutover','One pinned EMEVD and independent native readback, not game-runtime or whole-corpus acceptance','Configured prices estimate reported-usage cost; actual billing remains unverified','Zero activation is unobserved effect, not proof of quality equivalence']};
}

export function evaluateExperimentLeg(spec,report,usage){
 let claim;try{claim=JSON.parse(report.modelFinalText).claimedStatus;}catch{}
 const claimKnown=['completed','blocked','partial'].includes(claim);
 const changed=report.byteHashes?.before!==report.byteHashes?.after;
 const confirmedPhases=new Set(['committed','rolled_back','after_commit_validation','marking_committed']);
 const committedOperations=(report.operations??[]).filter(operation=>operation.committedAt||['committed','rolled_back'].includes(operation.status));
 const settledWrites=(report.transactionJournal??[]).filter(row=>confirmedPhases.has(row.phase));
 const mutationAllowed=report.scenario==='native-rest-mutation';
 const knownTask=['read-only','already-satisfied','native-rest-mutation','false-model-success'].includes(report.scenario);
 const writePolicyViolated=!mutationAllowed&&(committedOperations.length>0||settledWrites.length>0);
 const unresolved=(report.operations??[]).some(operation=>operation.status==='recovery_required')||(report.transactionJournal??[]).some(row=>['recovery_required','replacing','rolling_back'].includes(row.phase));
 const policyKnown=knownTask&&Array.isArray(report.operations)&&Array.isArray(report.transactionJournal)&&!unresolved;
 const writePolicy={mutationAllowed,status:writePolicyViolated?'violated':policyKnown?'satisfied':'unverified',committedOperationIds:committedOperations.map(operation=>operation.opId),settledJournalWrites:settledWrites.map(row=>({opId:row.op_id,phase:row.phase}))};
 const wrongWrites=writePolicyViolated||report.wrongWriteObserved===true || changed&&report.allowedResourceDelta===false || report.preservation?.siblingBytes===false || report.preservation?.originalBytes===false ? true : !policyKnown||changed&&report.allowedResourceDelta!==true?'unverified':false;
 const taskVerdict=wrongWrites===true?'failed':report.scenario==='false-model-success'&&claim==='blocked'?'blocked':report.taskEvidence?.nativeReadObserved===false?'failed':!policyKnown?'unverified':report.goal?.status==='passed'?'verified':report.goal?.status==='failed'?'failed':'unverified';
 const reported=usage.length>0&&usage.every(sample=>sample.providerReported&&Number.isFinite(sample.inputTokens)&&Number.isFinite(sample.outputTokens));
 return {scenario:report.scenario,taskVerdict,independentGoal:report.goal,taskEvidence:report.taskEvidence,writePolicy,wrongWrites,falseSuccess:claimKnown?claim==='completed'?(taskVerdict==='unverified'?'unverified':taskVerdict!=='verified'):false:'unverified',modelClaim:claimKnown?claim:'unverified',protocolTermination:report.protocolTermination,runtimeMs:report.durationMs,usage:reported?{status:'provider-reported',inputTokens:usage.reduce((sum,sample)=>sum+sample.inputTokens,0),outputTokens:usage.reduce((sum,sample)=>sum+sample.outputTokens,0)}:{status:'unverified',reason:'At least one request did not report complete usage'},actualCost:{status:'unverified',reason:'No provider billing evidence'},activation:experimentActivation(spec,report),operations:report.operations?.map(operation=>({opId:operation.opId,status:operation.status,files:operation.files})),journal:report.transactionJournal,resourcePreservation:report.preservation,nativeReadback:report.nativeReadback,executionError:report.executionError};
}

export async function executeAgentExperiment(input,plan,ports={}){
 const credential=ports.credential??(()=>process.env.SOULFORGE_AGENT_API_KEY);
 if(input.execute!==true)throw fail('AGENT_EXPERIMENT_EXECUTION_NOT_AUTHORIZED','Future execution requires an explicit --execute flag.');
 input={...input,sampling:validateExperimentInputs(input).sampling};
 if(plan.status!=='ready')return plan;
 const current=await (ports.preview??previewAgentExperiment)(input);
 if(current.status!=='ready'||JSON.stringify(current.bindings)!==JSON.stringify(plan.bindings))return {...plan,status:'unavailable',execution:'not_run',networkCalls:0,credentialAccess:false,unavailable:[{input:'execution-bindings',reason:'pre-execution-binding-drift'}]};
 const key=credential();if(typeof key!=='string'||!key)throw fail('AGENT_EXPERIMENT_CREDENTIAL_REQUIRED','The selected provider needs an existing host-local credential; this harness never configures one.');
 const outputRoot=resolve(input.outputRoot??join(input.repoRoot,'.local-validation/provider-experiments',`${input.experiment}-${Date.now()}-${randomUUID()}`));
 if(existsSync(outputRoot))throw fail('AGENT_EXPERIMENT_OUTPUT_EXISTS','Choose a new owned experiment output directory; existing evidence is not overwritten.');
 await mkdir(outputRoot,{recursive:true});
 if(ports.installBridge)await ports.installBridge();else{
  const {registerHooks}=await import('node:module');
  const actual=pathToFileURL(join(input.repoRoot,'packages/core/dist/bridge/runBridge.js')).href+'?provider-experiment-native-port';const base=actual.split('?')[0],bridge=input.bridge??plan.bindings.identities.bridge.path;
  registerHooks({resolve(specifier,context,next){return (specifier===base||!specifier.includes('?')&&specifier.endsWith('/bridge/runBridge.js'))?{url:'sf:provider-experiment-native-port',shortCircuit:true}:next(specifier,context);},load(url,context,next){return url==='sf:provider-experiment-native-port'?{format:'module',shortCircuit:true,source:`export * from ${JSON.stringify(actual)};import {runBridge as run} from ${JSON.stringify(actual)};export function runBridge(options){return run({...options,bridgeExecutablePath:${JSON.stringify(bridge)}});}`}:next(url,context);}});
 }
 const core=ports.core??await import(pathToFileURL(join(input.repoRoot,'packages/core/dist/index.js')).href);
 const configured=core.createConfiguredModelServiceAdapter({config:{...input.provider,id:'provider-experiment',displayName:'Explicit provider experiment',hasCredential:true,createdAt:'',updatedAt:''},apiKey:key});
 if(!configured.ok)throw fail('AGENT_EXPERIMENT_PROVIDER_INVALID','Configured adapter rejected the selected provider.');
 const {createProviderBudget}=await import(pathToFileURL(join(input.repoRoot,'packages/agent/src/providerBudget.mjs')).href);
 let legUsage,providerRequestAttempts=0;
 const observed={...configured.adapter,complete:async request=>{
  providerRequestAttempts++;let response;
  try{response=await configured.adapter.complete(request);return response;}
  finally{const usage=response?.usage;legUsage?.push({providerReported:usage!==undefined,...(Number.isFinite(usage?.inputTokens)&&usage.inputTokens>=0?{inputTokens:usage.inputTokens}:{}),...(Number.isFinite(usage?.outputTokens)&&usage.outputTokens>=0?{outputTokens:usage.outputTokens}:{})});}
 }};
 const shared=createProviderBudget(observed,{maxOutputTokens:input.budget.maxOutputTokens,maxCost:input.budget.maxCost,pricing:input.provider.pricing});
 const runtime=(ports.runtimeFactory??createOwnedNativeComparisonRuntime)({...input,outputRoot,quiet:true});
 const ready=await runtime.prepare();if(ready.status!=='ready')return {...plan,status:'unavailable',unavailable:[ready],execution:'not_run'};
 const startedAt=Date.now(),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),input.budget.timeoutMs);const results=[];
 try{
  for(const task of plan.bindings.tasks)for(const variant of plan.experiment.variants){
   if(controller.signal.aborted||input.budget.timeoutMs-(Date.now()-startedAt)<input.budget.maxLegTimeoutMs){results.push({scenario:task.id,variant,status:'not_run',taskVerdict:'unverified',reason:'experiment-time-budget'});continue;}
   const legController=new AbortController(),legTimer=setTimeout(()=>legController.abort(),input.budget.maxLegTimeoutMs);
   const usage=[];legUsage=usage;const start=shared.stats();
   try{
    const report=await runtime.worker('legacy',task.id,{label:`${input.experiment}-${variant}`,snapshotLabel:`${input.experiment}-${variant}`,sourceTransform:experimentSourceTransform(input.experiment,variant),adapter:shared.adapter,config:{...input.provider,id:'provider-experiment',displayName:'Explicit provider experiment',hasCredential:true,createdAt:'',updatedAt:''},apiKey:key,sampling:input.sampling,pricing:input.provider.pricing,limits:{...runtime.LIMITS,maxSteps:input.budget.maxSteps,maxOutputTokens:input.budget.maxLegOutputTokens,maxCost:input.budget.maxLegCost,timeoutMs:input.budget.maxLegTimeoutMs},signal:AbortSignal.any([controller.signal,legController.signal]),permissionMode:task.permissionMode,repeatedDescriptions:plan.experiment.kind==='description'&&variant==='repeated',ragMode:plan.experiment.kind==='rag'?variant:undefined,reportingInstruction:REPORTING_INSTRUCTION});
    const evaluated=evaluateExperimentLeg(AGENT_EXPERIMENTS[input.experiment],report,usage),end=shared.stats();
    results.push({...evaluated,variant,status:report.executionError?'failed':'executed',budgetBefore:start,budgetAfter:end,configuredPriceCost: evaluated.usage.status==='provider-reported'?{status:'estimate-from-reported-usage',currency:input.provider.currency,value:(evaluated.usage.inputTokens*input.provider.pricing.inputPerMillion+evaluated.usage.outputTokens*input.provider.pricing.outputPerMillion)/1e6}:{status:'unverified'},report:join(outputRoot,`${task.id}-${input.experiment}-${variant}`,'result.json')});
   }catch(error){results.push({scenario:task.id,variant,status:'failed',taskVerdict:'unverified',reportedUsageSamples:usage,error:{code:error.code??'AGENT_EXPERIMENT_LEG_FAILED',message:core.redactSecrets(String(error.message??error).replaceAll(key,'[REDACTED]'))},budgetAfter:shared.stats()});}finally{legUsage=undefined;clearTimeout(legTimer);}
  }
 }finally{clearTimeout(timer);}
 const after=await (ports.preview??previewAgentExperiment)(input);
 const bindingsStable=JSON.stringify(after.bindings)===JSON.stringify(plan.bindings);
 const report={...plan,status:results.every(result=>result.status==='executed')&&bindingsStable?'completed':'partial',execution:'executed',providerRequestAttempts,networkCalls:{status:'unverified',reason:'Adapter request attempts do not prove network delivery'},credentialAccess:'host-local-execution-only',bindingsStable,results,budget:shared.stats(),actualCost:{status:'unverified',reason:'No billing evidence; configured-price estimates appear per leg'},outputRoot};
 await writeFile(join(outputRoot,'experiment-report.json'),JSON.stringify(report,null,2)+'\n');return report;
}
