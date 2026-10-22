/** Source-only preparation tests. No vendor/native/game binary or provider is invoked. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,posix,win32} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createExperimentModelWire,createExperimentRetrieval,createOwnedNativeComparisonRuntime,experimentNativeReadObserved,inspectOwnedNativeInputs} from './testing/owned-native-agent-comparison.mjs';
import {materializeLegacyAgentBaseline} from './testing/legacy-agent-baseline.mjs';
import {AGENT_EXPERIMENTS,BASELINE_LOOP_SHA256,experimentSourceTransform,experimentActivation} from './testing/agent-experiment-treatments.mjs';
import {previewAgentExperiment,executeAgentExperiment,validateExperimentInputs,evaluateExperimentLeg} from './testing/agent-provider-experiment.mjs';
import {parseProviderExperimentArguments,runProviderExperimentCommand} from './run-agent-provider-experiment.mjs';
const exec=promisify(execFile),repoRoot=process.cwd();
const publicControl='public-main-c4',publicRevision='c4a8b158f935c35624f132850b068a8e02921f68',publicLoopSha='1475f0faeefc6eb8b67972691e3182fb7f0eed954dd7965c868688ed8f9fc4a4';
const provider={protocol:'openai-compatible',baseUrl:'https://fixture.invalid',model:'owner-selected-model-fixture',pricing:{inputPerMillion:1,outputPerMillion:1},currency:'USD'};
const budget={maxCost:1,maxLegCost:0.125,maxOutputTokens:65536,maxLegOutputTokens:8192,timeoutMs:1500000,maxLegTimeoutMs:180000,maxSteps:8};
const base=()=>({repoRoot,experiment:'description-dedup',provider:structuredClone(provider),budget:{...budget},sampling:{temperature:0,topP:1,maxTokens:512}});

test('provider, currency/pricing and every explicit experiment/per-leg budget are required before execution',()=>{
 for(const field of ['provider','budget']){const input=base();delete input[field];assert.throws(()=>validateExperimentInputs(input),error=>error.code?.startsWith('AGENT_EXPERIMENT_'));}
 for(const key of Object.keys(budget)){const input=base();delete input.budget[key];assert.throws(()=>validateExperimentInputs(input),{code:'AGENT_EXPERIMENT_BUDGET_REQUIRED'});}
 for(const value of [0,-1,NaN,Infinity]){const input=base();input.budget.maxCost=value;assert.throws(()=>validateExperimentInputs(input));}
 for(const mutated of [{...provider,pricing:undefined},{...provider,currency:undefined},{...provider,apiKey:'must-not-appear'},{...provider,pricing:{...provider.pricing,apiKey:'must-not-appear'}},{...provider,baseUrl:'https://fixture.invalid?key=must-not-appear'}]){
  assert.throws(()=>validateExperimentInputs({...base(),provider:mutated}),error=>error.code?.startsWith('AGENT_EXPERIMENT_')&&!error.message.includes('must-not-appear'));
 }
 assert.throws(()=>validateExperimentInputs({...base(),experiment:'full-kernel-cutover'}),{code:'AGENT_EXPERIMENT_UNAVAILABLE'});
 assert.throws(()=>parseProviderExperimentArguments(['--execute','--dry-run','--provider-config','fixture.json']),{code:'AGENT_EXPERIMENT_MODE_CONFLICT'});
});

test('all nine public-control conditions are uniquely source-bound, change only their exact condition and remain valid TypeScript',async()=>{
 const {stdout:source}=await exec('git',['show',publicRevision+':packages/core/src/model-services/agentLoop.ts'],{cwd:repoRoot,maxBuffer:8388608});
 const ts=createRequire(import.meta.url)('typescript');let treatments=0;
 for(const [id,spec] of Object.entries(AGENT_EXPERIMENTS).filter(([,spec])=>spec.kind==='heuristic')){
  assert.equal(source.split(spec.needle).length,2);assert.throws(()=>experimentSourceTransform(id,'on')('packages/core/src/model-services/agentLoop.ts',source),{code:'AGENT_EXPERIMENT_BASELINE_DRIFT'});
  const on=experimentSourceTransform(id,'on',publicControl)('packages/core/src/model-services/agentLoop.ts',source),off=experimentSourceTransform(id,'off',publicControl)('packages/core/src/model-services/agentLoop.ts',source);
  assert.equal(on.source,source);assert.equal(on.treatment.originalSha256,publicLoopSha);assert.equal(on.treatment.controlId,publicControl);assert.equal(on.treatment.revision,publicRevision);assert.equal(off.treatment.changedConditions,1);
  const [before,after]=source.split(spec.needle);assert.equal(off.source.slice(0,before.length),before);assert.equal(off.source.slice(-after.length),after);
  assert.equal(ts.createSourceFile(`${id}.ts`,off.source,ts.ScriptTarget.Latest,true).parseDiagnostics.length,0);
  assert.throws(()=>experimentSourceTransform(id,'off',publicControl)('packages/core/src/model-services/agentLoop.ts',source+'\n'),{code:'AGENT_EXPERIMENT_BASELINE_DRIFT'});
  assert.equal(experimentSourceTransform(id,'off',publicControl)('other.ts',source),undefined);treatments++;
 }
 assert.equal(treatments,9);
});

test('dry-run binds source/build/tasks and reports missing/mismatched native inputs without network or credential access',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-provider-preview-'));const originalFetch=globalThis.fetch;let fetches=0;
 globalThis.fetch=()=>{fetches++;throw new Error('Network must not open during preparation.');};
 try{
  const badCorpus=join(root,'corpus');await mkdir(join(badCorpus,'mods/event'),{recursive:true});await writeFile(join(badCorpus,'mods/event/common.emevd.dcx'),'hash drift fixture');
  const plan=await previewAgentExperiment({...base(),corpusRoot:badCorpus,dotnet:'',oracleAssembly:''});
  assert.equal(plan.execution,'not_run');assert.equal(plan.networkCalls,0);assert.equal(plan.credentialAccess,false);assert.equal(fetches,0);
  assert.equal(plan.status,'unavailable');assert.ok(plan.unavailable.some(item=>item.reason==='pinned-input-mismatch'));assert.equal(plan.bindings.tasks.length,4);assert.equal(plan.experiment.variants.length,2);
  assert.match(plan.bindings.source.commit,/^[a-f0-9]{40}$/);assert.match(plan.bindings.implementationSha256,/^[a-f0-9]{64}$/);
  let credentials=0;assert.deepEqual(await executeAgentExperiment({...base(),execute:true},plan,{credential:()=>{credentials++;throw new Error('No credential access');}}),plan);assert.equal(credentials,0);
  const ready={...plan,status:'ready'};const drifted=await executeAgentExperiment({...base(),execute:true},ready,{credential:()=>{credentials++;throw new Error('No credential access');},preview:async()=>({...ready,bindings:{...ready.bindings,sampling:{temperature:1}}})});assert.equal(drifted.status,'unavailable');assert.equal(drifted.unavailable[0].reason,'pre-execution-binding-drift');assert.equal(credentials,0);
  assert.throws(()=>parseProviderExperimentArguments(['--dry-run']),{code:'AGENT_EXPERIMENT_PROVIDER_REQUIRED'});
  const config=join(root,'provider.json');await writeFile(config,JSON.stringify(provider));
  await assert.rejects(()=>runProviderExperimentCommand(['--dry-run','--provider-config',config]),{code:'AGENT_EXPERIMENT_BUDGET_REQUIRED'});
 }finally{globalThis.fetch=originalFetch;await rm(root,{recursive:true,force:true});}
});

test('missing selected Git control returns explicit unavailable and retains current source identity for numeric exit codes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-provider-missing-control-'));const originalFetch=globalThis.fetch;
 globalThis.fetch=()=>{throw new Error('Network must not open during preparation.');};
 try{
  await mkdir(join(root,'testdata/corpus'),{recursive:true});
  await writeFile(join(root,'testdata/corpus/sekiro-1.6.corpus-manifest.json'),await readFile(join(repoRoot,'testdata/corpus/sekiro-1.6.corpus-manifest.json')));
  for(const path of ['scripts/run-agent-provider-experiment.mjs','scripts/testing/agent-provider-experiment.mjs','scripts/testing/agent-experiment-treatments.mjs','scripts/testing/owned-native-agent-comparison.mjs','scripts/testing/legacy-agent-baseline.mjs']){
   await mkdir(join(root,...path.split('/').slice(0,-1)),{recursive:true});await writeFile(join(root,path),await readFile(join(repoRoot,path)));
  }
  await exec('git',['init','--quiet'],{cwd:root});await exec('git',['add','.'],{cwd:root});
  await exec('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','Owned missing-control fixture'],{cwd:root});
  const {stdout:head}=await exec('git',['rev-parse','HEAD'],{cwd:root});
  const plan=await previewAgentExperiment({...base(),repoRoot:root,corpusRoot:'',dotnet:'',oracleAssembly:''});
  assert.equal(plan.status,'unavailable');assert.equal(plan.execution,'not_run');assert.equal(plan.networkCalls,0);assert.equal(plan.credentialAccess,false);
  assert.equal(plan.bindings.source.commit,head.trim());assert.equal(plan.bindings.baseline,undefined);
  const missing=plan.unavailable.find(item=>item.input==='legacy-baseline');
  assert.equal(missing.reason,'exact-revision-unavailable');assert.equal(missing.exitCode,128);
  assert.equal(missing.revision,'217234bb97ee20e3a83048042c4a1e67e9a16d33');
 }finally{globalThis.fetch=originalFetch;await rm(root,{recursive:true,force:true});}
});



test('public pre-refactor control is explicit and never substitutes for the unavailable historical control',async()=>{
 const originalFetch=globalThis.fetch;globalThis.fetch=()=>{throw new Error('No network in control selection.');};
 try{
  const selected=await previewAgentExperiment({...base(),control:publicControl,corpusRoot:'',dotnet:'',oracleAssembly:''});
  assert.equal(selected.bindings.baseline.id,publicControl);assert.equal(selected.bindings.baseline.revision,publicRevision);assert.equal(selected.bindings.baseline.controlSourceSha256,publicLoopSha);assert.match(selected.bindings.baseline.modelServicesTree,/^[a-f0-9]{40}$/);
  assert.equal(selected.bindings.controlHistory[0].id,'historical-217');assert.equal(selected.bindings.controlHistory[0].status,'unavailable');assert.equal(selected.bindings.controlHistory[0].revision,'217234bb97ee20e3a83048042c4a1e67e9a16d33');assert.equal(selected.bindings.controlHistory[0].loopSha256,BASELINE_LOOP_SHA256);
  assert.equal(selected.unavailable.some(item=>item.input==='legacy-baseline'),false);assert.equal(selected.execution,'not_run');assert.equal(selected.networkCalls,0);assert.equal(selected.credentialAccess,false);
  const defaults=await previewAgentExperiment({...base(),corpusRoot:'',dotnet:'',oracleAssembly:''});assert.equal(defaults.bindings.baseline,undefined);assert.equal(defaults.unavailable.find(item=>item.input==='legacy-baseline').revision,'217234bb97ee20e3a83048042c4a1e67e9a16d33');
  assert.equal(parseProviderExperimentArguments(['--provider-config','fixture.json','--control',publicControl]).control,publicControl);
  for(const control of ['HEAD','constructor','__proto__'])assert.throws(()=>validateExperimentInputs({...base(),control}),{code:'AGENT_EXPERIMENT_CONTROL_INVALID'});
 }finally{globalThis.fetch=originalFetch;}
});

test('entire public session snapshot is pinned, loadable and cannot be relabeled as the historical control',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-public-control-snapshot-'));
 try{
  const loaded=await materializeLegacyAgentBaseline(repoRoot,join(root,'public'),publicRevision,{control:publicControl});
  assert.equal(typeof loaded.runAgentSession,'function');assert.equal(loaded.manifest.control.id,publicControl);assert.equal(loaded.manifest.control.revision,publicRevision);assert.match(loaded.manifest.control.modelServicesTree,/^[a-f0-9]{40}$/);assert.equal(loaded.manifest.files.length,12);
  for(const file of loaded.manifest.files){assert.match(file.sha256,/^[a-f0-9]{64}$/);assert.equal(file.materializedSha256,file.sha256);}
  assert.equal(loaded.manifest.files.find(file=>file.path.endsWith('/agentLoop.ts')).sha256,publicLoopSha);
  await assert.rejects(()=>materializeLegacyAgentBaseline(repoRoot,join(root,'wrong'),publicRevision,{control:'historical-217'}),{code:'AGENT_EXPERIMENT_CONTROL_REVISION_MISMATCH'});
 }finally{await rm(root,{recursive:true,force:true});}
});

test('failed unmet goals are distinct from wrong writes and prose claims remain unverified',()=>{
 const report={scenario:'native-rest-mutation',goal:{status:'failed'},byteHashes:{before:'same',after:'same'},allowedResourceDelta:true,preservation:{siblingBytes:true,originalBytes:true},operations:[],transactionJournal:[],modelFinalText:'The task is complete.',protocolTermination:{finishReason:'stop'},durationMs:1};
 const judged=evaluateExperimentLeg(AGENT_EXPERIMENTS['description-dedup'],report,[]);assert.equal(judged.taskVerdict,'failed');assert.equal(judged.wrongWrites,false);assert.equal(judged.falseSuccess,'unverified');assert.equal(judged.actualCost.status,'unverified');
 assert.equal(evaluateExperimentLeg(AGENT_EXPERIMENTS['description-dedup'],{...report,modelFinalText:'{"claimedStatus":"completed"}'},[]).falseSuccess,true);
 assert.equal(evaluateExperimentLeg(AGENT_EXPERIMENTS['description-dedup'],{...report,byteHashes:{before:'old',after:'wrong'},allowedResourceDelta:false},[]).wrongWrites,true);
 const unavailable=evaluateExperimentLeg(AGENT_EXPERIMENTS['description-dedup'],{...report,goal:{status:'unverified'},byteHashes:{before:'old',after:'unknown'},allowedResourceDelta:'unverified'},[]);assert.equal(unavailable.wrongWrites,'unverified');assert.equal(unavailable.taskVerdict,'unverified');assert.equal(evaluateExperimentLeg(AGENT_EXPERIMENTS['description-dedup'],{...report,goal:{status:'unverified'},modelFinalText:'{"claimedStatus":"completed"}'},[]).falseSuccess,'unverified');
 const unread=evaluateExperimentLeg(AGENT_EXPERIMENTS['description-dedup'],{...report,scenario:'read-only',goal:{status:'passed'},taskEvidence:{nativeReadObserved:false},modelFinalText:'{"claimedStatus":"completed"}'},[]);assert.equal(unread.taskVerdict,'failed');assert.equal(unread.falseSuccess,true);assert.equal(unread.wrongWrites,false);
 const activation=experimentActivation(AGENT_EXPERIMENTS['empty-conclusion'],{modelRequests:[{messages:[{role:'system',content:'请根据上述已执行的工具'}]},{messages:[{role:'system',content:'请根据上述已执行的工具'}]}]});assert.equal(activation.controlMessageCount,1);assert.equal(activation.controlWireOccurrences,2);
});

test('no-write task policy uses committed operation/journal file facts even after a restore or committed no-op',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-readonly-op-facts-'));const file=join(root,'common.emevd.dcx'),{createHash}=await import('node:crypto'),hash=value=>createHash('sha256').update(value).digest('hex');
 const original=Buffer.from('preserved fixture bytes'),modified=Buffer.from('changed target bytes');
 try{
  await writeFile(file,original);const before=hash(await readFile(file));await writeFile(file,modified);const intermediate=hash(await readFile(file));await writeFile(file,original);const after=hash(await readFile(file));assert.equal(before,after);assert.notEqual(before,intermediate);
  const operation=(opId,beforeHash,afterHash)=>({opId,status:'committed',files:[{targetPath:file,beforeHash,afterHash}]});
  const base={goal:{status:'passed'},taskEvidence:{nativeReadObserved:true},byteHashes:{before,after},allowedResourceDelta:true,preservation:{siblingBytes:true,originalBytes:true},modelFinalText:'{"claimedStatus":"completed"}',transactionJournal:[],operations:[]};
  for(const scenario of ['read-only','already-satisfied','false-model-success'])for(const operations of [[operation('write',before,intermediate),operation('restore',intermediate,after)],[operation('noop',before,after)]]){
   const judged=evaluateExperimentLeg(AGENT_EXPERIMENTS['description-dedup'],{...base,scenario,operations,transactionJournal:operations.map(op=>({op_id:op.opId,phase:'committed',state_json:'{"changedFileCount":1}'}))},[]);
   assert.equal(judged.wrongWrites,true);assert.equal(judged.writePolicy.status,'violated');assert.equal(judged.taskVerdict,'failed');assert.equal(judged.falseSuccess,true);
  }
  const journalOnly=evaluateExperimentLeg(AGENT_EXPERIMENTS['description-dedup'],{...base,scenario:'read-only',transactionJournal:[{op_id:'missing-log-record',phase:'committed',state_json:'{"changedFileCount":0}'}]},[]);assert.equal(journalOnly.wrongWrites,true);
  const unresolved=evaluateExperimentLeg(AGENT_EXPERIMENTS['description-dedup'],{...base,scenario:'read-only',transactionJournal:[{op_id:'unknown-outcome',phase:'recovery_required'}]},[]);assert.equal(unresolved.wrongWrites,'unverified');assert.equal(unresolved.taskVerdict,'unverified');
  const allowed=evaluateExperimentLeg(AGENT_EXPERIMENTS['description-dedup'],{...base,scenario:'native-rest-mutation',operations:[operation('authorized',before,intermediate)],byteHashes:{before,after:intermediate},transactionJournal:[{op_id:'authorized',phase:'committed'}]},[]);assert.equal(allowed.wrongWrites,false);assert.equal(allowed.taskVerdict,'verified');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('fresh experiment preflight requires only documented native inputs and preserves the separate fixture loader contract',async()=>{
 const input={source:'/fresh/owned-source',dotnet:'/fresh/dotnet',oracleAssembly:'/fresh/oracle',bridge:'/fresh/bridge',loader:'/stale/ad-hoc-loader',fixture:{byteLength:20,sha256:'pinned-source'},oracleSha:'pinned-oracle'};
 const paths=[];const ports={exists:path=>{paths.push(path);return path!==input.loader;},stat:async()=>({size:20}),fileHash:async path=>path===input.source?'pinned-source':'pinned-oracle'};
 const prepared=await inspectOwnedNativeInputs(input,ports);assert.equal(prepared.status,'ready');assert.equal(paths.includes(input.loader),false);
 const historical=await inspectOwnedNativeInputs({...input,requireExternalLoader:true},ports);assert.equal(historical.status,'unavailable');assert.deepEqual(historical.missing,[input.loader]);
});

test('target native evidence is required; candidate/RAG, wrong target and failed reads do not prove the read task',()=>{
 const envelope={data:{record:{eventId:952787}},evidence:{status:'native-verified',sourceUris:['file://event/common.emevd.dcx']}};
 const result=value=>[{result:{ok:true,content:JSON.stringify(value)}}];const target={file:'event/common.emevd.dcx',eventId:952787};
 assert.equal(experimentNativeReadObserved(result(envelope),target),true);assert.equal(experimentNativeReadObserved([],target),false);
 assert.equal(experimentNativeReadObserved(result({...envelope,evidence:{...envelope.evidence,status:'candidate'}}),target),false);
 assert.equal(experimentNativeReadObserved(result({...envelope,data:{record:{eventId:42}}}),target),false);
 assert.equal(experimentNativeReadObserved(result({...envelope,evidence:{...envelope.evidence,sourceUris:['file://event/other.emevd.dcx']}}),target),false);
 assert.equal(experimentNativeReadObserved([{result:{ok:false,content:JSON.stringify(envelope)}}],target),false);
});

test('reported usage survives a configured output-budget rejection before the session usage callback',{timeout:10000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-provider-overrun-'));const input={...base(),execute:true,outputRoot:join(root,'fresh'),budget:{...budget,timeoutMs:20000,maxLegTimeoutMs:1000}};
 const plan={status:'ready',experiment:{id:'description-dedup',kind:'description',variants:['repeated']},bindings:{tasks:[{id:'read-only',permissionMode:'normal'}],identities:{bridge:{path:'unused'}}}};
 const core={createConfiguredModelServiceAdapter:()=>({ok:true,adapter:{protocol:'openai-compatible',complete:async()=>({usage:{inputTokens:4,outputTokens:11}})}}),redactSecrets:text=>text};
 try{
  const result=await executeAgentExperiment(input,plan,{credential:()=> 'fixture-only',core,installBridge:()=>{},preview:async()=>plan,runtimeFactory:()=>({LIMITS:{},prepare:async()=>({status:'ready'}),worker:async(_kernel,_scenario,leg)=>leg.adapter.complete({messages:[],maxTokens:10})})});
  assert.equal(result.results[0].status,'failed');assert.equal(result.results[0].error.code,'AGENT_PROVIDER_OUTPUT_BUDGET_EXCEEDED');assert.deepEqual(result.results[0].reportedUsageSamples,[{providerReported:true,inputTokens:4,outputTokens:11}]);assert.equal(result.providerRequestAttempts,1);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('explicit future execution orchestration uses only supplied fake ports, binds one treatment and keeps billing unverified',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-provider-fake-ports-'));const input={...base(),control:publicControl,execute:true,outputRoot:join(root,'fresh'),budget:{...budget,timeoutMs:20000,maxLegTimeoutMs:1000}};let credentials=0,providers=0,native=0;
 const plan={status:'ready',experiment:{id:'description-dedup',kind:'description',variants:['repeated','deduplicated']},bindings:{baseline:{id:publicControl,revision:publicRevision,controlSourceSha256:publicLoopSha},tasks:[{id:'read-only',permissionMode:'normal'}],identities:{bridge:{path:'fake-not-executed'}}}};
 const core={createConfiguredModelServiceAdapter:()=>({ok:true,adapter:{protocol:'openai-compatible',complete:async()=>{providers++;return {message:{role:'assistant',content:'{"claimedStatus":"completed"}'},finishReason:'stop',diagnostics:[],usage:{inputTokens:1,outputTokens:1}};}}}),redactSecrets:text=>text};
 try{
  await assert.rejects(()=>executeAgentExperiment({...input,execute:false},plan,{credential:()=>{credentials++;}}),{code:'AGENT_EXPERIMENT_EXECUTION_NOT_AUTHORIZED'});assert.equal(credentials,0);
   const output=await executeAgentExperiment(input,plan,{credential:()=>{credentials++;return 'fixture-only-not-a-real-credential';},core,installBridge:()=>{},preview:async()=>plan,runtimeFactory:options=>{assert.equal(options.control,publicControl);return {LIMITS:{},prepare:async()=>({status:'ready'}),worker:async(kernel,scenario,leg)=>{native++;assert.equal(kernel,'legacy');assert.equal(leg.repeatedDescriptions,leg.label.endsWith('repeated'));assert.equal(leg.limits.timeoutMs,1000);await leg.adapter.complete({messages:[{role:'user',content:'fixture'}],maxTokens:10});return {scenario,goal:{status:'passed'},modelFinalText:'{"claimedStatus":"completed"}',byteHashes:{before:'same',after:'same'},allowedResourceDelta:true,preservation:{siblingBytes:true,originalBytes:true},operations:[],protocolTermination:{finishReason:'stop'},durationMs:1};}};}});
  assert.equal(output.status,'completed');assert.equal(credentials,1);assert.equal(providers,2);assert.equal(native,2);assert.equal(output.results.length,2);assert.ok(output.results.every(result=>result.actualCost.status==='unverified'));
  assert.ok(!JSON.stringify(output).includes('fixture-only-not-a-real-credential'));assert.equal(output.budget.requests,2);assert.equal(output.providerRequestAttempts,2);assert.equal(output.networkCalls.status,'unverified');assert.ok(output.results.every(result=>result.usage.inputTokens===1));
 }finally{await rm(root,{recursive:true,force:true});}
});

test('owned treatment paths have identical model-visible identities and reverse only into each owned leg',()=>{
 const one=createExperimentModelWire({directory:'/tmp/first-treatment',workspaceId:'workspace-first'}),two=createExperimentModelWire({directory:'/tmp/second-treatment',workspaceId:'workspace-second'});
 const request=(directory,workspaceId)=>({messages:[{role:'tool',content:JSON.stringify({sourceUri:pathToFileURL(directory+'/overlay/event/common.emevd.dcx').href,workspaceId})}],tools:[]});
 assert.deepEqual(one.request(request('/tmp/first-treatment','workspace-first')),two.request(request('/tmp/second-treatment','workspace-second')));
 const proposed={message:{role:'assistant',content:'',toolCalls:[{id:'owned',name:'read_fixture',argumentsJson:JSON.stringify({sourceUri:'file:///owned-agent-experiment/overlay/event/common.emevd.dcx',workspaceId:'owned-agent-experiment-workspace'})}]}};
 assert.deepEqual(one.request(one.response(proposed)),proposed);assert.ok(two.response(proposed).message.toolCalls[0].argumentsJson.includes('/tmp/second-treatment'));assert.ok(!two.response(proposed).message.toolCalls[0].argumentsJson.includes('/tmp/first-treatment'));
 assert.match(createOwnedNativeComparisonRuntime({repoRoot}).ORACLE_SOURCE,/using SoulsFormats/);
});

test('automatic and requested RAG use the same production lexical source without embedding/provider/native calls',async()=>{
 const {createRagCorpus}=await import('../packages/core/dist/rag/chunkBuilder.js');const {retrieveEvidence}=await import('../packages/core/dist/rag/retrieve.js');
 const calls=[],before={source:{sha256:'pinned-source'},events:[{id:952787,restBehavior:1,instructionCount:3,parameterCount:0,bodySha256:'pinned-body'}]};
 const retrieval=createExperimentRetrieval({createRagCorpus,retrieveEvidence},{before,target:'/tmp/owned/event/common.emevd.dcx',workspaceId:'owned-test',onRetrieve:call=>calls.push(call)});
 const automatic=await retrieval.retrieve('event 952787','automatic'),requested=await retrieval.retrieve('event 952787','tool');
 assert.equal(automatic.ok,true);assert.equal(automatic.hits.length,1);assert.deepEqual(automatic,requested);assert.deepEqual(calls.map(call=>call.channel),['automatic','tool']);assert.equal(retrieval.corpus.chunks[0].body.includes('Native reads remain authoritative'),true);
 const {createRetrieveEvidenceTool}=await import('../packages/core/dist/ai/tools/retrieve_evidence.js');
 const tool=await createRetrieveEvidenceTool().run({query:'event 952787',limit:4},{workspaceIndex:null,rag:retrieval.corpus,mode:'normal'});
 assert.equal(tool.ok,true);assert.deepEqual(tool.data,automatic);
});

test('each old heuristic treatment actually activates on and remains absent off under bounded fake transport/tool inputs',{timeout:60000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-heuristic-activation-'));
 const done={message:{role:'assistant',content:'The result is reported.'},finishReason:'stop',diagnostics:[],usage:{inputTokens:1,outputTokens:1}};
 const read=(name='inspect_fixture',args={})=>({message:{role:'assistant',content:'',toolCalls:[{id:'read',name,argumentsJson:JSON.stringify(args)}]},finishReason:'tool_use',diagnostics:[],usage:{inputTokens:1,outputTokens:1}});
 const cases={
  'empty-conclusion':{outputs:[read(),{...done,message:{role:'assistant',content:''}},done]},
  'future-action-conclusion':{outputs:[{...done,message:{role:'assistant',content:'接下来我会继续读取参数并进行修改。'}},done]},
  'provider-length-conclusion':{outputs:[read(),{...done,finishReason:'length'},done]},
  'output-reserve-conclusion':{outputs:[{...read(),usage:{inputTokens:1,outputTokens:3072}},done],maxTotalOutputTokens:4096},
  'identical-tool-failure':{repeat:read(),toolFailure:true,maxSteps:12},
  'semantic-param-failure':{repeat:turn=>read('read_param_fields',{table:'FixtureParam',rowIds:[turn]}),toolFailure:true,maxSteps:8},
  'research-stall-conclusion':{repeat:read('read_emevd_event'),maxSteps:8},
  'candidate-native-nudge':{outputs:[read('search_events'),done],toolContent:'{"ok":true,"evidence":{"status":"candidate"},"data":{"eventId":952787}}'},
  'model-wording-partial':{outputs:[{...done,message:{role:'assistant',content:'本次任务未完成，证据不足。'}}]}
 };
 try{
  for(const [id,fixture] of Object.entries(cases))for(const variant of ['on','off']){
   const baseline=await materializeLegacyAgentBaseline(repoRoot,join(root,id,variant),publicRevision,{control:publicControl,sourceTransform:experimentSourceTransform(id,variant,publicControl)});let turn=0;const modelRequests=[];
   const adapter={protocol:'openai-compatible',complete:async request=>{modelRequests.push({messages:structuredClone(request.messages)});const response=fixture.outputs?.[turn]??(request.tools.length===0?done:typeof fixture.repeat==='function'?fixture.repeat(turn):fixture.repeat)??done;turn++;return response;}};
   const tools=['inspect_fixture','read_param_fields','read_emevd_event','search_events'].map(name=>({name,description:'Fake read-only experiment port',permissionLevel:'read',parametersJsonSchema:{}}));
   const result=await baseline.runAgentSession({sessionsDir:join(root,id,variant,'sessions'),adapter,config:{...provider,id:'fixture',displayName:'fixture',hasCredential:false,createdAt:'',updatedAt:''},apiKey:'',kernel:'legacy',prompt:'检查资源并报告',permissionMode:'plan',maxSteps:fixture.maxSteps??8,tools,executeTool:async()=>fixture.toolFailure?{ok:false,code:'FIXTURE_FAILURE',content:'{"ok":false,"code":"FIXTURE_FAILURE"}'}:{ok:true,content:fixture.toolContent??'{"ok":true,"data":{"eventId":952787}}'},...(fixture.maxTotalOutputTokens?{maxTotalOutputTokens:fixture.maxTotalOutputTokens}:{})});
   const activation=experimentActivation(AGENT_EXPERIMENTS[id],{runDiagnostics:result.run.diagnostics,modelRequests});
   const count=activation.diagnosticCount+activation.controlMessageCount;
   assert.equal(count>0,variant==='on',`${id}/${variant}: ${JSON.stringify(result.run.diagnostics)}`);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});

test('RAG treatment preserves once-per-run automatic retrieval and exposes the same on-demand tool source',{timeout:10000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-rag-treatment-'));
 const {createRagCorpus}=await import('../packages/core/dist/rag/chunkBuilder.js'),{retrieveEvidence}=await import('../packages/core/dist/rag/retrieve.js');
 const before={source:{sha256:'pinned-source'},events:[{id:952787,restBehavior:1,instructionCount:3,parameterCount:0,bodySha256:'pinned-body'}]};
 try{
  const baseline=await materializeLegacyAgentBaseline(repoRoot,join(root,'baseline'),publicRevision,{control:publicControl});const runs=[];
  for(const mode of ['automatic','on-demand']){
   const calls=[],requests=[];let turn=0;
   const retrieval=createExperimentRetrieval({createRagCorpus,retrieveEvidence},{before,target:'/tmp/owned/event/common.emevd.dcx',workspaceId:'owned-test',onRetrieve:call=>calls.push(call)});
   const tools=[{name:'retrieve_evidence',description:'Retrieve the same pinned evidence.',permissionLevel:'read',parametersJsonSchema:{}}];
   const adapter={protocol:'openai-compatible',complete:async request=>{requests.push(structuredClone(request));return turn++===0?{message:{role:'assistant',content:'',toolCalls:[{id:'retrieve',name:'retrieve_evidence',argumentsJson:'{"query":"event 952787"}'}]},finishReason:'tool_use',diagnostics:[]}:{message:{role:'assistant',content:'The result is reported.'},finishReason:'stop',diagnostics:[]};}};
   await baseline.runAgentSession({sessionsDir:join(root,mode),adapter,config:{...provider,id:'fixture',displayName:'fixture',hasCredential:false,createdAt:'',updatedAt:''},apiKey:'',kernel:'legacy',prompt:'Read event 952787',permissionMode:'plan',maxSteps:3,tools,executeTool:async()=>({ok:true,content:JSON.stringify(await retrieval.retrieve('event 952787','tool'))}),...(mode==='automatic'?{ragSearch:{retrieve:retrieval.retrieve,maxHits:4}}:{})});
   assert.equal(calls.filter(call=>call.channel==='automatic').length,mode==='automatic'?1:0);assert.equal(calls.filter(call=>call.channel==='tool').length,1);assert.equal(requests.length,2);runs.push({requests,calls});
  }
  assert.deepEqual(runs[0].requests[0].tools,runs[1].requests[0].tools);assert.deepEqual(runs[0].calls.find(call=>call.channel==='tool').result,runs[1].calls.find(call=>call.channel==='tool').result);
 }finally{await rm(root,{recursive:true,force:true});}
});


test('description variants change only per-tool repetition through the public control with the shared policy fixed',{timeout:10000},async()=>{
 const {createExperimentToolDescriptions}=await import('./testing/owned-native-agent-comparison.mjs');assert.equal(typeof createExperimentToolDescriptions,'function');
 const root=await mkdtemp(join(tmpdir(),'sf-public-description-treatment-'));const originalFetch=globalThis.fetch;let networkCalls=0;
 globalThis.fetch=()=>{networkCalls++;throw new Error('No provider network calls.');};
 try{
  const {AGENT_TOOL_RESULT_INSTRUCTIONS}=await import('../packages/core/dist/ai/agentToolBridge.js');
  const baseline=await materializeLegacyAgentBaseline(repoRoot,join(root,'baseline'),publicRevision,{control:publicControl});
  const tools=[{name:'inspect_fixture',description:'Read owned fixture metadata.',permissionLevel:'read',parametersJsonSchema:{type:'object'}}],runs=[];
  for(const variant of ['repeated','deduplicated']){
   const requests=[];let calls=0;
   const adapter={protocol:'openai-compatible',complete:async request=>{requests.push(structuredClone(request));return calls++===0?{message:{role:'assistant',content:'',toolCalls:[{id:'read',name:'inspect_fixture',argumentsJson:'{}'}]},finishReason:'tool_use',diagnostics:[],usage:{inputTokens:1,outputTokens:1}}:{message:{role:'assistant',content:'The result is reported.'},finishReason:'stop',diagnostics:[],usage:{inputTokens:1,outputTokens:1}};}};
   const result=await baseline.runAgentSession({sessionsDir:join(root,variant),adapter,config:{...provider,id:'fixture',displayName:'fixture',hasCredential:false,createdAt:'',updatedAt:''},apiKey:'',prompt:'Read the owned fixture.',systemPrompt:AGENT_TOOL_RESULT_INSTRUCTIONS,permissionMode:'plan',maxSteps:3,tools:createExperimentToolDescriptions(tools,AGENT_TOOL_RESULT_INSTRUCTIONS,variant==='repeated'),executeTool:async()=>({ok:true,content:'{"ok":true,"data":{"value":1}}'})});
   assert.equal(result.run.finishReason,'stop');assert.equal(requests.length,2);runs.push(requests);
  }
  for(let turn=0;turn<2;turn++){
   assert.deepEqual(runs[0][turn].messages,runs[1][turn].messages);
   const repeated=runs[0][turn].tools[0],deduplicated=runs[1][turn].tools[0];assert.deepEqual({...repeated,description:deduplicated.description},deduplicated);assert.equal(repeated.description,`${deduplicated.description} ${AGENT_TOOL_RESULT_INSTRUCTIONS}`);
  }
  assert.equal(networkCalls,0);assert.equal(tools[0].description,'Read owned fixture metadata.');
 }finally{globalThis.fetch=originalFetch;await rm(root,{recursive:true,force:true});}
});


test('legacy snapshot classifies Windows and POSIX model-service imports with canonical Git paths',async()=>{
 const {resolveLegacySnapshotImport}=await import('./testing/legacy-agent-baseline.mjs');assert.equal(typeof resolveLegacySnapshotImport,'function');
 for(const [paths,repo] of [[win32,'C:\\ci folder\\SoulForge'],[win32,'\\\\server\\share\\SoulForge'],[posix,'/ci folder/SoulForge']]){
  for(const source of ['packages/core/src/model-services/agentSessionHost.ts',paths.join('packages','core','src','model-services','agentSessionHost.ts')]){
   const target=resolveLegacySnapshotImport(repo,source,'./agentLoop.js',paths);assert.equal(target.snapshotPath,'packages/core/src/model-services/agentLoop.ts');assert.equal(target.runtimePath,undefined);
  }
 }
});

test('legacy snapshot remaps only core source imports into platform-native build paths',async()=>{
 const {resolveLegacySnapshotImport}=await import('./testing/legacy-agent-baseline.mjs');assert.equal(typeof resolveLegacySnapshotImport,'function');
 for(const [paths,repo] of [[win32,'C:\\ci\\packages\\core\\src\\SoulForge'],[posix,'/ci/packages/core/src/SoulForge']]){
  const source='packages/core/src/model-services/agentLoop.ts';
  const domain=resolveLegacySnapshotImport(repo,source,'../rag/chunkBuilder.js',paths);assert.equal(domain.snapshotPath,undefined);assert.equal(domain.runtimePath,paths.join(repo,'packages','core','dist','rag','chunkBuilder.js'));
  const shared=resolveLegacySnapshotImport(repo,source,'../../../shared/src/index.js',paths);assert.equal(shared.runtimePath,paths.join(repo,'packages','shared','src','index.js'));
  const sibling=resolveLegacySnapshotImport(repo,source,'../../src-extra/fixture.js',paths);assert.equal(sibling.runtimePath,paths.join(repo,'packages','core','src-extra','fixture.js'));
 }
});
