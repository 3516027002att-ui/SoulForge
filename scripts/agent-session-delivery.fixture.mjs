import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
import {transform} from 'esbuild';
import * as core from '../packages/core/dist/index.js';
import {runAgentHostTransport} from '../packages/agent/src/hostTransport.mjs';
const config={id:'delivery',displayName:'delivery',protocol:'openai-compatible',baseUrl:'https://fixture.invalid',hasCredential:false,createdAt:'',updatedAt:''};
const adapter={protocol:'openai-compatible',listModels:async()=>({ok:true,models:[]}),stream:async function*(){throw new Error('unused');},complete:async()=>({message:{role:'assistant',content:'The native task result is ready.'},finishReason:'stop',diagnostics:[],usage:{inputTokens:1,outputTokens:1}})};
class Child extends EventEmitter{frames=[];postMessage(frame){this.frames.push(frame);}kill(){}}
test('an accepted large context delivers its terminal outcome without duplicate history and a later session can start',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-agent-terminal-budget-'));const uiEvents=[];
 try{
  const prompt='x'.repeat(1_100_000);
  const result=await core.runAgentSession({sessionsDir:root,adapter,config,apiKey:'',prompt,permissionMode:'plan',tools:[],executeTool:async()=>({ok:true,content:'{}'}),onEvent:event=>uiEvents.push(event)});
  assert.equal(result.kernel.state,'completed');assert.ok(Buffer.byteLength(JSON.stringify(result))>2_097_152);
  const oversizedChild=new Child(),oversized=runAgentHostTransport(oversizedChild,{prompt},{},{timeoutMs:2000});
  oversizedChild.emit('message',{type:'result',result});await assert.rejects(oversized,{code:'AGENT_PROTOCOL_BUDGET_EXCEEDED'});
  assert.equal(typeof core.toAgentSessionTerminalResult,'function');
  const terminal=core.toAgentSessionTerminalResult(result);
  assert.ok(Buffer.byteLength(JSON.stringify({type:'result',result:terminal}))<2_097_152);
  assert.equal(terminal.historyDelivery.source,'rollout');assert.equal(terminal.historyDelivery.messageCount,result.run.messages.length);
  assert.deepEqual(terminal.run.messages,[]);assert.deepEqual(terminal.kernel.messages,[]);
  assert.deepEqual(terminal.kernel.transactions,result.kernel.transactions);assert.deepEqual(terminal.providerBudget,result.providerBudget);
  const child=new Child(),delivered=runAgentHostTransport(child,{prompt},{},{timeoutMs:2000});child.emit('message',{type:'result',result:terminal});
  assert.equal((await delivered).run.finishReason,'stop');
  const rendererSource=await readFile('apps/desktop/src/renderer/src/agent/agentTaskState.ts','utf8');const rendererOutput=await transform(rendererSource,{loader:'ts',format:'esm',target:'es2022'});
  const rendererPath=join(root,'nonstream-reducer.mjs');await writeFile(rendererPath,rendererOutput.code);const reducer=await import(pathToFileURL(rendererPath).href);
  const visible=uiEvents.map(event=>({sessionId:result.sessionId,event})).reduce(reducer.reduceAgentTaskEvent,reducer.startAgentTask(result.sessionId,0,reducer.INITIAL_AGENT_TASK_STATE));
  assert.deepEqual(visible.narrations.map(item=>item.text),['The native task result is ready.']);
  const persisted=(await readFile(result.rolloutPath,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(persisted.find(record=>record.type==='message'&&record.message.role==='user').message.content,prompt);
  const next=await core.runAgentSession({sessionsDir:root,adapter,config,apiKey:'',prompt:'next task',permissionMode:'plan',tools:[],executeTool:async()=>({ok:true,content:'{}'})});
  const nextChild=new Child(),recovered=runAgentHostTransport(nextChild,{prompt:'next task'},{},{timeoutMs:2000});nextChild.emit('message',{type:'result',result:core.toAgentSessionTerminalResult(next)});
  assert.equal((await recovered).kernel.state,'completed');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('the desktop terminal event projection preserves actual streamed auth failure details',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-agent-terminal-failure-'));const events=[];
 try{
  const result=await core.runAgentSession({sessionsDir:root,adapter:{...adapter,stream:async function*(){yield {type:'error',code:'MODEL_SERVICE_AUTH_ERROR',message:'HTTP 401: configured credential was rejected'};}},config,apiKey:'',prompt:'read',permissionMode:'plan',tools:[],executeTool:async()=>({ok:true,content:'{}'}),streaming:true,onEvent:event=>events.push(event)});
  assert.equal(result.run.finishReason,'error');assert.equal(events.filter(event=>event.type==='agent-message-delta').length,0);
  const source=await readFile('apps/desktop/src/main/agentSessionOutcome.ts','utf8');
  const output=await transform(source,{loader:'ts',format:'esm',target:'es2022'});const modulePath=join(root,'outcome.mjs');await writeFile(modulePath,output.code);
  const {agentSessionOutcomeEvents}=await import(pathToFileURL(modulePath).href);
  const outcome=agentSessionOutcomeEvents(core.toAgentSessionTerminalResult(result),'fixture.jsonl');
  assert.deepEqual(outcome.find(event=>event.type==='session-error'),{type:'session-error',code:'MODEL_SERVICE_AUTH_ERROR',message:'HTTP 401: configured credential was rejected'});
  assert.deepEqual(outcome.find(event=>event.type==='session-done'),{type:'session-done',finishReason:'error',steps:result.run.steps,rolloutFileName:'fixture.jsonl'});
  const reducerSource=await readFile('apps/desktop/src/renderer/src/agent/agentTaskState.ts','utf8');
  const reducerOutput=await transform(reducerSource,{loader:'ts',format:'esm',target:'es2022'});const reducerPath=join(root,'reducer.mjs');await writeFile(reducerPath,reducerOutput.code);
  const reducer=await import(pathToFileURL(reducerPath).href);
  const started=reducer.startAgentTask(result.sessionId,0,reducer.INITIAL_AGENT_TASK_STATE);
  const state=[...events,...outcome].map(event=>({sessionId:result.sessionId,event})).reduce(reducer.reduceAgentTaskEvent,started);
  assert.equal(state.phase,'error');assert.equal(state.rolloutFileName,'fixture.jsonl');assert.equal(state.steps,result.run.steps);
  assert.equal(state.error.code,'MODEL_SERVICE_AUTH_ERROR');assert.match(reducer.describeAgentTaskStatus(state),/configured credential was rejected/);
  assert.ok(reducer.extractCompletedTurnItems(state,null).some(item=>item.kind==='notice'&&item.text.includes('MODEL_SERVICE_AUTH_ERROR')));
  const ipc=await readFile('apps/desktop/src/main/ipc/agent.ts','utf8');assert.match(ipc,/agentSessionOutcomeEvents\(result,\s*relativeRolloutPath\)/);
 }finally{await rm(root,{recursive:true,force:true});}
});
