import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseAgentExecArguments, runHeadlessAgentCommand } from '../tools/soulforge-cli/headless-agent.mjs';

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
