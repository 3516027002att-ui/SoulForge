import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { parseAgentExecArguments, runHeadlessAgentCommand } from '../tools/soulforge-cli/headless-agent.mjs';
import { encryptTestConfig, decryptTestPayload } from './testing/test-agent-provider.mjs';

test('original encrypted test input requires a positive cost ceiling and explicit prices before loading or opening', async () => {
 const common=['exec','--prompt','read fixture','--provider','test','--test-config','/missing/private/test'];
 let opened=0,created=0;
 const core={openLocalCliSession:async()=>{opened++;},createConfiguredModelServiceAdapter:()=>{created++;}};
 await assert.rejects(()=>runHeadlessAgentCommand({workspace:'.',agentArgs:common},core,process.cwd(),{emit:()=>{}}),{code:'AGENT_PROVIDER_BUDGET_REQUIRED'});
 assert.throws(()=>parseAgentExecArguments([...common,'--max-cost','1']),{code:'AGENT_PROVIDER_PRICING_REQUIRED'});
 assert.throws(()=>parseAgentExecArguments([...common,'--max-cost','0','--input-price-per-million','1','--output-price-per-million','1']),{code:'AGENT_PROVIDER_BUDGET_REQUIRED'});
 assert.throws(()=>parseAgentExecArguments(['exec','--prompt','x','--responses-file','responses.json','--provider','test']),{code:'AGENT_PROVIDER_REQUIRED'});
 assert.throws(()=>parseAgentExecArguments(['exec','--prompt','x','--responses-file','responses.json','--test-config','test']),{code:'AGENT_ARGUMENT_INVALID'});
 assert.equal(opened,0);assert.equal(created,0);
});

test('encrypted test provider uses original loader and keeps credential only in shared run parameters', async () => {
 const root=await mkdtemp(join(tmpdir(),'sf-original-provider-'));const frames=[];const diagnostics=[];
 const secret='synthetic-"private\\token';const baseUrl='https://synthetic-provider.invalid';const model='synthetic-private-model';let disposed=false;
 try {
  const payload=encryptTestConfig({url:baseUrl,api:secret,model});await writeFile(join(root,'test'),payload);
  const selectedConfigHash=createHash('sha256').update(JSON.stringify(decryptTestPayload(payload))).digest('hex');
  const fakeCore={createConfiguredModelServiceAdapter:({config,apiKey})=>{assert.equal(apiKey,secret);assert.equal(config.baseUrl,baseUrl);assert.equal(config.model,model);writeFileSync(join(root,'test'),encryptTestConfig({url:'https://replacement.fixture.invalid',api:'different-synthetic-key',model:'different-synthetic-model'}));return {ok:true,adapter:{}};},
   openLocalCliSession:async options=>{options.onDiagnostic?.({phase:'workspace.scan',status:'complete'});return {bridge:{tools:[],executeTool:async()=>({ok:true,content:'{}'})},dispose:async()=>{disposed=true;}};},
   createAgentRunAssembly:()=>({run:async params=>{assert.equal(params.apiKey,secret);assert.equal(params.permissionMode,'plan');assert.deepEqual(params.pricing,{inputPerMillion:1,outputPerMillion:2});return {rolloutPath:'fixture',run:{finishReason:'error',steps:1,diagnostics:[{severity:'error',code:'FIXTURE_FAILURE',message:secret},{severity:'error',code:'NESTED_FIXTURE_FAILURE',message:JSON.stringify({credential:secret})}]},kernel:{state:'error',transactions:[],unresolvedCalls:[]}};}})};
  const report=await runHeadlessAgentCommand({workspace:root,mode:'plan',agentArgs:['exec','--prompt','read fixture','--provider','test','--test-config',join(root,'test'),'--max-cost','1','--input-price-per-million','1','--output-price-per-million','2','--sessions-dir',root]},fakeCore,process.cwd(),{emit:frame=>frames.push(frame),emitDiagnostic:event=>diagnostics.push(event)});
  assert.equal(report.provider.kind,'encrypted-test');assert.match(report.provider.configSha256,/^[a-f0-9]{64}$/);
  assert.equal(report.evaluation,'unverified');assert.equal(disposed,true);assert.ok(diagnostics.some(d=>d.phase==='workspace.scan'));
  assert.equal(report.diagnostics[0].message,'[REDACTED]');
  assert.equal(JSON.parse(report.diagnostics[1].message).credential,'[REDACTED]');
  assert.equal(report.provider.configSha256,selectedConfigHash);
  assert.equal(report.provider.identityScope,'selected-original-test-configuration');
  for(const privateValue of [secret,baseUrl,model])assert.equal(JSON.stringify({report,frames}).includes(privateValue),false);
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('headless input is explicit UTF-8 and provider budgets are checked before any workspace or network is opened', async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-headless-budget-'));let opens=0;
 try{const task=join(root,'task.txt'),config=join(root,'config.json');await writeFile(task,'读取中文任务');await writeFile(config,JSON.stringify({protocol:'openai-compatible',model:'fixture',baseUrl:'https://fixture.invalid'}));
 await assert.rejects(()=>runHeadlessAgentCommand({workspace:root,agentArgs:['exec','--task-file',task,'--provider-config',config]}, {openLocalCliSession:async()=>{opens++;}},root,{emit:()=>{}}),{code:'AGENT_PROVIDER_BUDGET_REQUIRED'});
 assert.equal(opens,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('headless deterministic runner emits source-bound report and shared event sequence without external provider cost', async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-headless-fixture-'));const frames=[];let disposed=false;
 try{const task=join(root,'task.txt'),responses=join(root,'responses.json');await writeFile(task,'读取中文任务');await writeFile(responses,JSON.stringify([{message:{role:'assistant',content:'done'},finishReason:'stop',diagnostics:[]}]));
 const fakeCore={openLocalCliSession:async()=>({bridge:{tools:[],executeTool:async()=>({ok:true,content:'{}'})},dispose:async()=>{disposed=true;}}),createAgentRunAssembly:()=>({run:async params=>{assert.equal(params.prompt,'读取中文任务');params.onProtocolEvent({protocolVersion:1,eventSeq:1,event:{type:'turn-started',step:1}});params.onProtocolEvent({protocolVersion:1,eventSeq:2,event:{type:'turn-complete',steps:1,finishReason:'stop'}});return {sessionId:params.sessionId,rolloutPath:'fixture',run:{finishReason:'stop',steps:1,messages:[]}};}})};
 const report=await runHeadlessAgentCommand({workspace:root,mode:'plan',agentArgs:['exec','--kernel','finite','--task-file',task,'--responses-file',responses,'--sessions-dir',root]},fakeCore,process.cwd(),{emit:f=>frames.push(f)});
 assert.equal(report.evaluation,'unverified');assert.equal(report.provider.kind,'deterministic-fixture');assert.match(report.source.commit,/^[a-f0-9]{40}$/);assert.equal(disposed,true);
 assert.deepEqual(frames.filter(f=>f.type==='agent-event').map(f=>f.eventSeq),[1,2]);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('headless argument parser cannot default approve, accept unknown switches or lose task text',()=>{
 const args=parseAgentExecArguments(['exec','--prompt','中文 tasks','--kernel','finite','--max-steps','4','--responses-file','fixture.json']);
 assert.throws(()=>parseAgentExecArguments(['exec','--prompt','task','--kernel','legacy','--responses-file','fixture.json']),error=>error.code==='AGENT_LEGACY_KERNEL_RETIRED');
 assert.equal(args.prompt,'中文 tasks');assert.equal(args.kernel,'finite');assert.equal(args.maxSteps,4);
 assert.throws(()=>parseAgentExecArguments(['exec','--approve-all']),/Unknown/);
});
