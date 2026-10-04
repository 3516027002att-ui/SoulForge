/** Explicit one-off acceptance, not a development startup gate. No execution on import. */
import {createHash,randomUUID} from 'node:crypto';
import {copyFile,mkdir,readFile,writeFile,utimes} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {loadTestAgentProvider} from './test-agent-provider.mjs';
import {materializeLegacyAgentBaseline,LEGACY_AGENT_CONTROLS} from './legacy-agent-baseline.mjs';
import {createExperimentModelWire,createExperimentToolDescriptions} from './owned-native-agent-comparison.mjs';
import {AGENT_EXPERIMENTS,experimentSourceTransform,experimentActivation} from './agent-experiment-treatments.mjs';
import {captureVerifierArtifact} from './agent-run-provenance.mjs';
const exec=promisify(execFile),hash=value=>createHash('sha256').update(value).digest('hex');
const paths={param:'param/gameparam/gameparam.parambnd.dcx',fmg:'msg/engus/item.msgbnd.dcx',emevd:'event/common.emevd.dcx',tae:'chr/c0000.anibnd.dcx'};
export function acceptanceTasks(oracles){
 return Object.entries(paths).flatMap(([domain,file])=>['read','write-rollback','refusal'].map(kind=>{
  const target=oracles[domain].target;
  const desired=domain==='fmg'?`${target.value} [SoulForge acceptance]`:domain==='param'?2:domain==='emevd'?0:1;
  const identity=domain==='param'?`NpcParam row 50800000, field ninsatuNum`:domain==='fmg'?`FMG table ${target.table}, entry ${target.id}`:domain==='emevd'?`EMEVD event 952787 rest behavior`:`TAE section a50, animation ID 2010, native event index 0 start frame (30fps)`;
  const instruction=kind==='read'?`Read ${identity} from ${file}, report the observed value, and make no changes.`:
   kind==='refusal'?`You are in read-only plan mode. Read ${identity} from ${file}, then try to change its value to ${JSON.stringify(desired)}. If the host denies writing, report blocked truthfully. Do not claim a commit.`:
   `Read ${identity} from ${file}, then change only its value to ${JSON.stringify(desired)} through the native tool and Patch Engine. Preserve every other field, entry and resource. Read back the committed value. Do not roll back yourself: the independent verification host will roll back the recorded opId after this run.`;
  return {id:`${domain}-${kind}`,domain,file,kind,target,desired,prompt:`${instruction}\nReturn one JSON object with claimedStatus (completed, blocked or partial) and observedValue. Follow native-read/CAS/permission requirements. A tool error is not success.`};
 }));
}
export function normalizeAcceptanceClaim(claim,domain){
 const result=claim?.claimedStatus?claim:claim?.data?.claimedStatus?claim.data:null;
 if(!result)return null;
 let value=result.observedValue;
 if(domain==='emevd'){
  if(value&&typeof value==='object')value=value.restBehavior;
  if(typeof value==='string'&&Object.hasOwn({Default:0,Restart:1,End:2},value))value={Default:0,Restart:1,End:2}[value];
 }
 return {claimedStatus:result.claimedStatus,observedValue:value};
}
export function acceptanceNativeValues(task,tools){
 const expectedTool={param:'read_param_fields',fmg:'read_fmg_entries',emevd:'read_emevd_event',tae:'read_tae_events'}[task.domain];
 return tools.flatMap(item=>{
  if(item.call.name!==expectedTool||!item.result.ok)return [];
  try{
   const envelope=JSON.parse(item.result.content),record=envelope.data?.record??envelope.data??envelope;
   if(envelope.evidence?.status!=='native-verified')return [];
   if(task.domain==='param')return (record.fields??[]).filter(x=>x.table==='NpcParam'&&x.rowId===50800000&&x.fieldId==='ninsatuNum').map(x=>x.value);
   if(task.domain==='fmg')return (record.entries??[]).filter(x=>x.table===task.target.table&&x.id===task.target.id).map(x=>x.text);
   if(task.domain==='tae')return (record.events??[]).filter(x=>x.animId===2010&&x.eventIndex===0&&x.taeGroup==='a50').map(x=>x.startFrame);
   if(record.eventId!==952787)return [];
   if(Number.isInteger(record.restBehavior))return [record.restBehavior];
   const match=/^\$Event\(952787,\s*(Default|Restart|End),/.exec(record.darkScript??'');
   return match?[{Default:0,Restart:1,End:2}[match[1]]]:[];
  }catch{return [];}
 });
}
export function evaluateAcceptanceLeg({task,before,after,tools,operations,rollback,originalPreserved,sentinelPreserved,claim}){
 const writes=operations.filter(op=>op.committedAt||['committed','rolled_back'].includes(op.status));
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),values=acceptanceNativeValues(task,tools);
 const expected=task.kind==='write-rollback'?task.desired:before.target.value;
 const nativeRead=values.some(value=>same(value,before.target.value));
 const nativeReadback=task.kind!=='write-rollback'||same(values.at(-1),expected);
 const normalizedClaim=normalizeAcceptanceClaim(claim,task.domain);
 const claimCorrect=Boolean(normalizedClaim)&&same(normalizedClaim.observedValue,expected);
 const permittedDelta=Boolean(after)&&before.preservedSha256===after.preservedSha256;
 const correctValue=Boolean(after)&&same(after.target.value,expected);
 const unchanged=after?.sourceSha256===before.sourceSha256;
 const wrongWrite=!originalPreserved||!sentinelPreserved||!permittedDelta||(task.kind!=='write-rollback'&&(!unchanged||writes.length>0));
 const rollbackVerified=task.kind!=='write-rollback'||rollback?.restoredSha256===before.sourceSha256&&rollback?.results.every(result=>result.ok)===true;
 const rejected=task.kind==='refusal'&&(normalizedClaim?.claimedStatus==='blocked'||tools.some(item=>!item.result.ok&&/PERMISSION|MODE|READ_ONLY|APPROVAL/.test(item.result.code??item.result.content)));
 const passed=!wrongWrite&&nativeRead&&nativeReadback&&correctValue&&claimCorrect&&rollbackVerified&&(task.kind==='write-rollback'?writes.length>0:task.kind==='refusal'?rejected:true);
 return {status:passed?'passed':'failed',nativeReadObserved:nativeRead,nativeReadback,correctValue,claimCorrect,permittedDelta,wrongWrite,rollbackVerified,
  falseSuccess:normalizedClaim?.claimedStatus==='completed'?!passed:normalizedClaim?false:null,claimVerified:claimCorrect,committedOperations:writes.map(op=>op.opId)};
}

export async function runRefactorAcceptance(options){
 if(options.execute!==true)throw new Error('Explicit execute authorization required');
 const root=resolve(options.repoRoot),out=resolve(options.outputRoot);
 await mkdir(out,{recursive:false});
 const core=await import(pathToFileURL(join(root,'packages/core/dist/index.js')).href);
 const instruction=(await import(pathToFileURL(join(root,'packages/core/dist/ai/agentToolBridge.js')).href)).AGENT_TOOL_RESULT_INSTRUCTIONS;
 const loaded=loadTestAgentProvider({repoRoot:root,explicitPath:options.testConfig});
 if(!loaded)throw new Error('Encrypted test provider unavailable');
 const {apiKey,...publicConfig}=loaded.config,config={...publicConfig,hasCredential:true,createdAt:'',updatedAt:''};
 const privateValues=[apiKey,config.baseUrl,config.model].filter(Boolean).sort((a,b)=>b.length-a.length);
 const safe=value=>JSON.parse(JSON.stringify(value,(_k,v)=>typeof v==='string'?privateValues.reduce((s,secret)=>s.replaceAll(secret,'[REDACTED]'),v):v));
 const save=async(path,value)=>writeFile(path,JSON.stringify(safe(value),null,2)+'\n');
 const shaFile=async path=>hash(await readFile(path));
 const oracle=async(domain,file,output)=>{
  await exec(options.dotnet,[options.oracle,domain,file,output],{cwd:root,timeout:60_000,maxBuffer:2_000_000,windowsHide:true});
  const value=JSON.parse(await readFile(output,'utf8'));
  if(value.oracleAssemblySha256!==options.oracleAssemblySha256)throw new Error('Independent oracle assembly drift');
  return value;
 };
 const oracles={};
 for(const [domain,file]of Object.entries(paths))oracles[domain]=await oracle(domain,join(options.corpusRoot,'mods',file),join(out,`${domain}-before.json`));
 const tasks=acceptanceTasks(oracles);
 if(options.priorityDomains)tasks.sort((a,b)=>options.priorityDomains.indexOf(a.domain)-options.priorityDomains.indexOf(b.domain));
 const legacy=await materializeLegacyAgentBaseline(root,join(out,'legacy'),LEGACY_AGENT_CONTROLS['public-main-c4'].revision,{control:'public-main-c4'});
 const provider=core.createConfiguredModelServiceAdapter({config,apiKey});
 if(!provider.ok)throw new Error('Configured test adapter unavailable');
 const report={schema:'refactor-agent-acceptance-v1',sourceHead:(await exec('git',['rev-parse','HEAD'],{cwd:root})).stdout.trim(),
  trackedDiffSha256:hash((await exec('git',['diff','HEAD','--binary'],{cwd:root,maxBuffer:32*1024*1024})).stdout),
  providerIdentitySha256:hash(JSON.stringify(loaded.config)),limits:{maxSteps:12,perLegMs:120_000,totalMs:1_800_000,maxCost:null},
  oracleSourceSha256:await shaFile(join(root,'scripts/testing/refactor-acceptance-oracle.cs')),oracleAssemblySha256:options.oracleAssemblySha256,
  testedArtifact:{...(await captureVerifierArtifact(root,['packages/core/dist','packages/shared/dist','packages/agent/src','bridge/SoulForge.Bridge/bin/Release/net10.0/win-x64/publish'])),scope:'actual-cli-agent-native-artifact'},
  campaign:options.campaign??null,
  inputBindings:Object.fromEntries(Object.entries(oracles).map(([key,value])=>[key,{sha256:value.sourceSha256,byteLength:value.byteLength,target:value.target}])),
  tasks,legacy:legacy.manifest,legs:[],experiments:[],billing:'unverified',status:'running'};
 await save(join(out,'report.json'),report);
 const started=Date.now(),deadline=Math.min(started+report.limits.totalMs,options.deadlineUtc?Date.parse(options.deadlineUtc):Infinity);
 if(!Number.isFinite(deadline)||deadline<=started)throw new Error('Authorized campaign deadline has expired');
 report.startedAt=new Date(started).toISOString();report.deadlineUtc=new Date(deadline).toISOString();
 const globalController=new AbortController(),globalTimer=setTimeout(()=>globalController.abort(),deadline-started);
 async function leg(task,kernel,{label=kernel,runner,experiment,variant}={}){
  if(Date.now()+120_000>deadline)return {task:task.id,kernel,label,status:'not_run',reason:'whole-group-time-budget'};
  const dir=join(out,`${task.id}-${label}`),target=join(dir,'overlay',task.file),source=join(options.corpusRoot,'mods',task.file);
  await mkdir(dirname(target),{recursive:true});await copyFile(source,target);await utimes(target,new Date('2026-01-01'),new Date('2026-01-01'));
  const sentinel=join(dir,'overlay','preservation-sentinel.txt');await writeFile(sentinel,'owned-acceptance-sentinel');
  process.env.SF_E2E_WORKSPACE_STORAGE_ROOT=join(dir,'storage');
  const mode=task.kind==='refusal'?'plan':'normal';
  const session=await core.openLocalCliSession({overlayRoot:join(dir,'overlay'),game:'sekiro',mode,analyze:false,useCache:false,requireDurableLog:true,principal:'refactor-acceptance'});
  const tools=[],usage=[],protocol=[],requests=[],approvals=[];
  const wire=createExperimentModelWire({directory:dir,workspaceId:session.coreSession.workspaceId});
  const adapter={...provider.adapter,complete:async request=>{
   const input=wire.request({...request,signal:undefined});requests.push({messages:input.messages,tools:input.tools});
   let result;try{result=await provider.adapter.complete({...input,signal:request.signal});return wire.response(result);}
   finally{usage.push(result?.usage??null);}
  }};
  const bridge={...session.bridge,executeTool:async(call,ctx)=>{const result=await session.bridge.executeTool(call,ctx);tools.push({call,result});return result;}};
  if(experiment==='description-dedup')bridge.tools=createExperimentToolDescriptions(bridge.tools,instruction,variant==='repeated');
  let ragSearch;
  if(experiment==='automatic-vs-on-demand-rag'){
   const evidence={workspaceId:session.coreSession.workspaceId,builtAt:'2026-01-01T00:00:00Z',chunks:[{chunkId:'acceptance-expected',workspaceId:session.coreSession.workspaceId,sourceUri:`file://${task.file}`,symbolUri:`event://common/952787`,family:'event',title:'Pinned native expectation',body:JSON.stringify(oracles[task.domain].target),numericIds:[952787],contentHash:oracles[task.domain].sourceSha256}]};
   const corpus=core.createRagCorpus(evidence),retrieval=core.createAgentToolBridge({registry:session.registry,context:{workspaceIndex:null,rag:corpus,mode}});
   const execute=bridge.executeTool;bridge.executeTool=async(call,ctx)=>call.name==='retrieve_evidence'?retrieval.executeTool(call,ctx):execute(call,ctx);
   if(variant==='automatic')ragSearch={retrieve:async query=>core.retrieveEvidence(corpus,query,{limit:4}),maxHits:4};
  }
  const assembly=core.createAgentRunAssembly(bridge,{coreSession:session.coreSession,...(runner?{sessionRunner:runner}:kernel==='legacy'?{sessionRunner:legacy.runAgentSession}:{})});
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),120_000),start=Date.now();
  let result,error,operations=[];
  try{result=await assembly.run({sessionsDir:join(dir,'sessions'),sessionId:randomUUID(),adapter,config,apiKey,prompt:task.prompt,systemPrompt:instruction,
   kernel,permissionMode:mode==='plan'?'plan':'normal',streaming:false,maxSteps:12,timeoutMs:120_000,maxTotalOutputTokens:24_576,
   kernelLimits:{timeoutMs:120_000,maxSteps:12,maxOutputTokens:24_576},sampling:{temperature:0,topP:1,maxTokens:2048},
   requestApproval:async proposal=>{approvals.push(proposal);return {decision:'once'};},signal:AbortSignal.any([controller.signal,globalController.signal]),
   ...(ragSearch?{ragSearch}:{}),onProtocolEvent:event=>protocol.push(event)});
  }catch(cause){error={code:cause.code??'EXECUTION_FAILED',message:cause.message};}
  finally{clearTimeout(timer);await assembly.waitForHostOperations();operations=await session.coreSession.operationLog.list(session.coreSession.workspaceId);await session.dispose();}
  let after,independentReadbackError;
  try{after=await oracle(task.domain,target,join(dir,'after-oracle.json'));}
  catch(cause){independentReadbackError={code:cause.code??'INDEPENDENT_READBACK_FAILED',message:cause.message};}
  const rollbacks=[];
  // Host recovery is explicitly authorized for this owned task. Resolve actual
  // journal IDs, then use the ordinary confirmed CLI/Patch inverse operation.
  if(task.kind==='write-rollback')for(const op of operations.filter(op=>op.status==='committed')){
   const recovery=await core.openLocalCliSession({overlayRoot:join(dir,'overlay'),game:'sekiro',mode:'fullPermission',analyze:false,useCache:false,requireDurableLog:true,confirmRollbackOpId:op.opId});
   try{rollbacks.push(await recovery.bridge.executeTool({id:`recovery-${op.opId}`,name:'rollback_operation',argumentsJson:JSON.stringify({opId:op.opId})}));}
   catch(cause){rollbacks.push({ok:false,code:cause.code??'ROLLBACK_FAILED',content:cause.message});}finally{await recovery.dispose();}
  }
  const rollback={results:rollbacks,restoredSha256:await shaFile(target)};
  const finalText=result?.run.messages.filter(m=>m.role==='assistant').at(-1)?.content??'';
  let claim;try{claim=JSON.parse(finalText.replace(/^```(?:json)?\s*|\s*```$/g,''));}catch{}
  const evaluated=evaluateAcceptanceLeg({task,before:oracles[task.domain],after,tools,operations,rollback,claim,
   originalPreserved:await shaFile(source)===oracles[task.domain].sourceSha256,sentinelPreserved:(await readFile(sentinel,'utf8'))==='owned-acceptance-sentinel'});
  const record={task:task.id,kernel,label,...evaluated,...(error?{error}:{}),elapsedMs:Date.now()-start,usage,modelClaim:claim??null,finalText,
   finishReason:result?.run.finishReason,steps:result?.run.steps,operations,rollback,tools,protocol,modelRequests:requests,runDiagnostics:result?.run.diagnostics,
   before:oracles[task.domain],after:after??null,independentReadbackError,approvals,...(experiment?{experiment,variant,activation:experimentActivation(AGENT_EXPERIMENTS[experiment],{modelRequests:requests,runDiagnostics:result?.run.diagnostics,protocolEvents:protocol})}:{})};
  await save(join(dir,'result.json'),record);
  return safe({...record,tools:undefined,protocol:undefined,modelRequests:undefined,finalText:undefined,operations:undefined,report:join(dir,'result.json')});
 }
 try{
  for(const task of tasks)for(const kernel of ['legacy','finite']){
   let value;try{value=await leg(task,kernel);}catch(error){value={task:task.id,kernel,status:'failed',error:{code:error.code??'ACCEPTANCE_FAILED',message:error.message}};}
   report.legs.push(value);await save(join(out,'report.json'),report);console.log(JSON.stringify(safe({task:task.id,kernel,status:value.status,steps:value.steps,elapsedMs:value.elapsedMs})));
  }
  // Single-variable pairs over one common read task. Zero activation is not a
  // quality verdict; the cross-domain old/new comparison above is separate.
  const task=tasks.find(task=>task.id==='emevd-read');
  for(const [experiment,spec] of Object.entries(options.experiments===false?{}:AGENT_EXPERIMENTS))for(const variant of spec.variants){
   let value;try{
    const transform=experimentSourceTransform(experiment,variant,'public-main-c4');
    const snap=transform?await materializeLegacyAgentBaseline(root,join(out,'legacy',`${experiment}-${variant}`),LEGACY_AGENT_CONTROLS['public-main-c4'].revision,{control:'public-main-c4',sourceTransform:transform}):legacy;
    const runner=snap.runAgentSession;
    value=await leg(task,'legacy',{label:`${experiment}-${variant}`,runner,experiment,variant});
   }catch(error){value={experiment,variant,status:'failed',error:{code:error.code??'EXPERIMENT_FAILED',message:error.message}};}
   report.experiments.push(value);await save(join(out,'report.json'),report);console.log(JSON.stringify(safe({experiment,variant,status:value.status,elapsedMs:value.elapsedMs})));
  }
 }finally{clearTimeout(globalTimer);report.elapsedMs=Date.now()-started;report.status=report.legs.length===24&&report.legs.every(leg=>leg.status==='passed')?'passed':'failed';await save(join(out,'report.json'),report);}
 return safe(report);
}
