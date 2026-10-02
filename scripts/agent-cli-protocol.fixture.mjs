import assert from 'node:assert/strict';
import test from 'node:test';
import {PassThrough} from 'node:stream';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,writeFile,readFile,rm,mkdir,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as core from '../packages/core/dist/index.js';
import {noteOperationStarted,journalStateWithRequest} from '../packages/core/dist/runtime/operationOutcome.js';
import {runHeadlessAgentCommand,parseAgentExecArguments} from '../tools/soulforge-cli/headless-agent.mjs';
import {createAgentStdioControl} from '../tools/soulforge-cli/agent-control.mjs';

async function fixture({respond,timeoutMs=1000,lateCommit=false,disconnectOnTool=false,resumeSession,outputFailure=false}={},check){
 const root=await mkdtemp(join(tmpdir(),'sf-cli-control-')),input=new PassThrough(),frames=[];
 const operationLog=core.openSqliteOperationLogStore({databasePath:join(root,'audit.db'),workspaceId:'owned',rootPath:root,game:'sekiro'}),coreSession=new core.CoreToolSession({principal:'agent:owned',workspaceId:'owned',operationLog,modeCeiling:'normal'});
 const target=join(root,'owned-effect.txt');let executions=0,disposed=false;
 try{
  await writeFile(target,'original');
  const registry=new core.ToolRegistry();registry.register({name:'commit_owned',description:'Commit only the owned fixture effect',effect:'write',proofPolicy:'none',permission:'write',permissionLevel:'commit',inputSchema:{},run:async()=>{
   executions++;noteOperationStarted('owned-op',operationLog);
   if(lateCommit)await new Promise(resolve=>setTimeout(resolve,30));
   await writeFile(target,'approved');await operationLog.record({opId:'owned-op',workspaceId:'owned',title:'owned fixture',author:'ai',mode:'normal',status:'committed',createdAt:new Date().toISOString(),committedAt:new Date().toISOString(),backupRoot:join(root,'backup'),files:[],diagnostics:[]});
   await operationLog.createTransaction({transactionId:'owned-txn',opId:'owned-op',phase:'committed',state:journalStateWithRequest({ownedFixture:true}),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
   return {ok:true,data:{opId:'owned-op',committed:true}};
  }});
  const bridge=core.createAgentToolBridge({registry,context:{workspaceIndex:coreSession.workspaceIndex,mode:'normal',coreSession}});
  const responses=join(root,'responses.json');await writeFile(responses,JSON.stringify([{message:{role:'assistant',content:'',toolCalls:[{id:'write-one',name:'commit_owned',argumentsJson:'{}'}]},finishReason:'tool_use',diagnostics:[]},{message:{role:'assistant',content:'Task stopped.'},finishReason:'stop',diagnostics:[]}]));
  const host={...core,openLocalCliSession:async()=>({bridge,coreSession,dispose:async()=>{disposed=true;coreSession.close();}})};
  const report=await runHeadlessAgentCommand({workspace:root,mode:'normal',noAnalyze:true,agentArgs:['exec','--prompt','Owned task','--responses-file',responses,'--sessions-dir',join(root,'sessions'),...(outputFailure?['--timeout-ms','100']:[]),...(timeoutMs!==1000?['--approval-timeout-ms',String(timeoutMs)]:[]),...(resumeSession?['--resume-session',resumeSession]:[])]},host,process.cwd(),{input,emit:frame=>{
   frames.push(frame);
   if(outputFailure&&frame.type==='agent-event'&&frame.event.type==='turn-started')return Promise.reject(Object.assign(new Error('Owned output consumer disconnected'),{code:'OWNED_OUTPUT_CLOSED'}));
   if(frame.type==='agent-approval-request')respond?.(frame,input,frames);
   if(disconnectOnTool&&frame.type==='agent-event'&&frame.event.type==='tool-call-begin')input.end();
  }}).catch(error=>{if(!outputFailure)throw error;return {fixtureError:error};});
  await check({report,error:report.fixtureError,frames,executions,disposed,operationLog,target,root});
 }finally{input.destroy();coreSession.close();operationLog.close();await rm(root,{recursive:true,force:true});}
}
const reply=(request,input,decision,patch={})=>input.write(JSON.stringify({type:'agent-approval-response',protocolVersion:1,sessionId:request.sessionId,runId:request.runId,requestId:request.requestId,callId:request.callId,proposalHash:request.proposalHash,decision,...patch})+'\n');

test('normal CLI approves only the current exact request and executes once through shared assembly',async()=>{
 await fixture({respond:(request,input)=>reply(request,input,'approve')},async({report,executions,target})=>{assert.equal(report.state,'completed');assert.equal(executions,1);assert.equal(await readFile(target,'utf8'),'approved');assert.ok(report.transactions.some(transaction=>transaction.state==='committed'));assert.equal(report.evaluation,'unverified');});
});
test('wrong request, session, call and proposal replies cannot authorize a write',async()=>{
 await fixture({respond:(request,input)=>{
  for(const patch of [{requestId:'other'},{sessionId:'other'},{runId:'other'},{callId:'other'},{proposalHash:'other'}])reply(request,input,'approve',patch);
  reply(request,input,'deny');
 }},async({report,frames,executions,target})=>{assert.equal(executions,0);assert.equal(await readFile(target,'utf8'),'original');assert.equal(frames.filter(frame=>frame.type==='agent-control-result'&&frame.matched===false).length,5);assert.equal(report.evaluation,'unverified');});
});
test('invalid decisions, including object prototype names, remain pending until exact approval',async()=>{
 await fixture({respond:(request,input)=>{for(const decision of ['timed_out','always','__proto__','constructor'])reply(request,input,decision);reply(request,input,'approve');}},async({report,executions})=>{assert.equal(report.state,'completed');assert.equal(executions,1);});
});
test('approval timeout is a host fact and does not dispatch the proposed call',async()=>{
 await fixture({timeoutMs:20},async({frames,executions,target})=>{assert.equal(executions,0);assert.equal(await readFile(target,'utf8'),'original');assert.ok(frames.some(frame=>frame.type==='agent-event'&&frame.event.type==='approval-resolved'&&frame.event.decision==='timed_out'));});
});
test('approval cancellation and input disconnect stop without granting or replaying writes',async()=>{
 for(const disconnect of [false,true])await fixture({respond:(request,input)=>disconnect?input.end():reply(request,input,'cancel')},async({report,executions,target})=>{assert.equal(report.state,'cancelled');assert.equal(executions,0);assert.equal(await readFile(target,'utf8'),'original');});
});
test('disconnect during a write keeps the late committed journal fact without rerunning the tool',async()=>{
 await fixture({lateCommit:true,disconnectOnTool:true,respond:(request,input)=>reply(request,input,'approve')},async({report,executions,operationLog,target,disposed})=>{assert.equal(report.state,'cancelled');assert.equal(executions,1);assert.equal(disposed,true);assert.equal(await readFile(target,'utf8'),'approved');assert.equal((await operationLog.get('owned-op')).status,'committed');assert.ok(report.hostRequests.some(status=>status.transaction?.state==='committed'));assert.equal(report.evaluation,'unverified');});
});
test('rollout continuation reopens the authoritative journal, closes pending history and never replays the old write',async()=>{
 await fixture({lateCommit:true,disconnectOnTool:true,respond:(request,input)=>reply(request,input,'approve')},async({report,operationLog,target,root})=>{
  operationLog.close();const reopened=core.openSqliteOperationLogStore({databasePath:join(root,'audit.db'),workspaceId:'owned',rootPath:root,game:'sekiro'}),session=new core.CoreToolSession({principal:'agent:resumed',workspaceId:'owned',operationLog:reopened,modeCeiling:'plan'});
  const responses=join(root,'resume-responses.json');await writeFile(responses,JSON.stringify([{message:{role:'assistant',content:'Journal fact read; no replay.'},finishReason:'stop',diagnostics:[]}]));let dispatches=0;
  const bridge={tools:[],executeTool:async()=>{dispatches++;throw new Error('Historical calls must not dispatch');}},frames=[];
  try{
   const resumed=await runHeadlessAgentCommand({workspace:root,mode:'plan',agentArgs:['exec','--prompt','Inspect the prior outcome','--responses-file',responses,'--resume-session',report.rolloutPath,'--sessions-dir',join(root,'resumed')]},{...core,openLocalCliSession:async()=>({bridge,coreSession:session,dispose:async()=>session.close()})},process.cwd(),{emit:frame=>frames.push(frame)});
   assert.equal(resumed.state,'completed');assert.notEqual(resumed.sessionId,report.sessionId);assert.equal(dispatches,0);assert.equal(await readFile(target,'utf8'),'approved');
   const lines=(await readFile(resumed.rolloutPath,'utf8')).trim().split('\n').map(JSON.parse),prior=lines.find(line=>line.type==='message'&&line.message.role==='tool'&&line.message.toolCallId==='write-one');
   assert.ok(prior);const facts=JSON.parse(prior.message.content);assert.equal(facts.retryable,false);assert.equal(facts.state,'committed');assert.equal(facts.journal.transaction.opId,'owned-op');assert.equal(resumed.evaluation,'unverified');
  }finally{session.close();reopened.close();}
 });
});
test('interactive transport and rollout continuation are explicit callable CLI options',()=>{
 const args=parseAgentExecArguments(['exec','--prompt','x','--responses-file','fixture.json','--protocol-stdin','--resume-session','prior.jsonl']);assert.equal(args.protocolStdin,true);assert.equal(args.resumeSession,'prior.jsonl');
 assert.throws(()=>parseAgentExecArguments(['exec','--prompt','x','--responses-file','fixture.json','--approval-timeout-ms','0']),{code:'AGENT_ARGUMENT_INVALID'});
});
test('async output disconnect cancels safely and always disposes the owned session',async()=>{
 await fixture({outputFailure:true},async({error,executions,disposed,target})=>{assert.equal(error?.code,'OWNED_OUTPUT_CLOSED');assert.equal(disposed,true);assert.equal(executions,0);assert.equal(await readFile(target,'utf8'),'original');});
});
test('unavailable prior journal lookup stays unknown without a replay or global resume exception',async()=>{
 const store=new core.MemoryOperationLogStore();store.findTransactionsForRequest=async()=>{throw new Error('OWNED_JOURNAL_UNAVAILABLE');};const session=new core.CoreToolSession({principal:'agent:owned',workspaceId:'owned',operationLog:store});let calls=0;
 try{const assembly=core.createAgentRunAssembly({tools:[],executeTool:async()=>{calls++;return {ok:true,content:'{}'};}},{coreSession:session});const status=await assembly.resolvePriorCallOutcome('prior-session','old-call');assert.equal(status.transaction.state,'unknown');assert.equal(status.id,'prior-session:old-call');assert.equal(calls,0);}finally{session.close();}
});
test('fragmented input stays bounded and a closed approval host cannot revive a request',async()=>{
 const input=new PassThrough(),controller=new AbortController(),frames=[];
 const control=createAgentStdioControl({input,emit:frame=>frames.push(frame),sessionId:'owned',runId:'owned-run',requestId:'owned-task',controller,maxFrameBytes:32});
 input.write('x'.repeat(20));input.write('x'.repeat(20));assert.equal(controller.signal.aborted,true);assert.equal(control.disconnectReason,'AGENT_CONTROL_FRAME_TOO_LARGE');await control.close();
 const decision=await control.requestApproval({callId:'old',toolName:'owned',permissionLevel:'commit',step:1,argumentsJson:'{}'});assert.equal(decision.decision,'abort');assert.equal(frames.filter(frame=>frame.type==='agent-approval-request').length,0);input.destroy();
});

test('actual sfcli process accepts an exact stdin approval while native proof still blocks the unsafe write',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sfcli-duplex-process-')),overlay=join(root,'overlay'),responses=join(root,'responses.json'),frames=[];await mkdir(overlay);await writeFile(join(overlay,'owned.txt'),'unchanged');
 await writeFile(responses,JSON.stringify([{message:{role:'assistant',content:'',toolCalls:[{id:'unproved-write',name:'mutate_param_fields',argumentsJson:JSON.stringify({edits:[{table:'FixtureParam',rowId:1,fieldId:'fixtureField',value:2}]})}]},finishReason:'tool_use',diagnostics:[]},{message:{role:'assistant',content:'Stopped after the guarded result.'},finishReason:'stop',diagnostics:[]}]));
 const env={...process.env,XDG_DATA_HOME:join(root,'profile'),LOCALAPPDATA:join(root,'profile')};delete env.SF_E2E_WORKSPACE_STORAGE_ROOT;
 const args=['tools/soulforge-cli/sfcli.mjs','--workspace',overlay,'--mode','normal','--no-cache','--no-analyze','--quiet','--json','agent','exec','--prompt','Inspect only the owned fixture','--responses-file',responses,'--sessions-dir',join(root,'sessions'),'--protocol-stdin'];
 const child=spawn(process.execPath,args,{cwd:process.cwd(),env,stdio:['pipe','pipe','pipe']});let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
 const lines=createInterface({input:child.stdout});lines.on('line',line=>{const frame=JSON.parse(line);frames.push(frame);if(frame.type==='agent-approval-request')reply(frame,child.stdin,'approve');});
 const exit=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));const timer=setTimeout(()=>child.kill(),5000);
 try{
  const status=await exit;assert.equal(status.signal,null,JSON.stringify({stderr,frames:frames.map(frame=>({type:frame.type,state:frame.state,event:frame.event?.type,matched:frame.matched,code:frame.event?.code??frame.code}))}));assert.equal(status.code,0,stderr);
  const report=frames.find(frame=>frame.type==='agent-report');assert.ok(report);assert.equal(report.evaluation,'unverified');assert.ok(frames.some(frame=>frame.type==='agent-control-result'&&frame.matched===true));
  assert.ok(frames.some(frame=>frame.type==='agent-event'&&frame.event.type==='tool-call-end'&&frame.event.ok===false&&/NATIVE_READ/.test(frame.event.code)));assert.equal(await readFile(join(overlay,'owned.txt'),'utf8'),'unchanged');assert.equal(report.transactions.some(transaction=>transaction.state==='committed'),false);
  const profileFiles=await readdir(join(root,'profile'),{recursive:true});assert.ok(profileFiles.some(file=>/workspace\.db$/.test(file)), 'actual CLI database must be inside the owned profile');
 }finally{clearTimeout(timer);lines.close();child.stdin.destroy();child.kill();await rm(root,{recursive:true,force:true});await assert.rejects(()=>readdir(join(root,'profile')),{code:'ENOENT'});}
});
