import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as core from '../packages/core/dist/index.js';
const config={id:'fixture',displayName:'fixture',protocol:'openai-compatible',baseUrl:'https://fixture.invalid',model:'deterministic',hasCredential:false,createdAt:'',updatedAt:''};
const makeAdapter=()=>({protocol:'openai-compatible',listModels:async()=>({ok:true,models:[]}),complete:async()=>({message:{role:'assistant',content:'verified read'},finishReason:'stop',diagnostics:[]}),stream:async function*(){throw new Error('unused');}});
test('desktop and CLI assembly share deterministic session events and provenance-compatible results',async()=>{
 assert.equal(typeof core.createAgentRunAssembly,'function');
 const root=await mkdtemp(join(tmpdir(),'sf-agent-shared-'));
 try {
  const bridge={tools:[],executeTool:async()=>({ok:true,content:'{}'})};
  const params={sessionsDir:root,sessionId:'fixture-session',adapter:makeAdapter(),config,apiKey:'',prompt:'读取中文任务',permissionMode:'plan'};
  const desktopEvents=[],cliEvents=[];
  const desktop=await core.createAgentRunAssembly(bridge).run({...params,onEvent:e=>desktopEvents.push(e)});
  const cli=await core.createAgentRunAssembly(bridge).run({...params,onEvent:e=>cliEvents.push(e)});
  assert.deepEqual(cliEvents,desktopEvents);assert.equal(cli.run.finishReason,desktop.run.finishReason);
  assert.equal(cli.run.messages.at(-1).content,'verified read');
  assert.match(await readFile(cli.rolloutPath,'utf8'),/读取中文任务/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('finite kernel is a distinct implementation under the shared session protocol',async()=>{
 assert.equal(typeof core.createAgentRunAssembly,'function');const root=await mkdtemp(join(tmpdir(),'sf-agent-finite-'));
 try{const result=await core.createAgentRunAssembly({tools:[],executeTool:async()=>({ok:true,content:'{}'})}).run({sessionsDir:root,adapter:makeAdapter(),config,apiKey:'',prompt:'read',permissionMode:'plan',kernel:'finite'});
 assert.equal(result.kernel.state,'completed');assert.equal(result.kernel.evaluation,'unverified');assert.equal(result.run.finishReason,'stop');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('finite adapter preserves configured bounded context hook instead of silently ignoring it',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-finite-context-'));let assemblies=0;
 try{const result=await core.createAgentRunAssembly({tools:[],executeTool:async()=>({ok:true,content:'{}'})}).run({sessionsDir:root,adapter:makeAdapter(),config,apiKey:'',prompt:'read',permissionMode:'plan',kernel:'finite',contextBroker:{assemble:async()=>{assemblies++;return {ok:true,context:'trusted bounded fixture data',sections:[],totalBytes:28,diagnostics:[]};}}});
 assert.equal(result.kernel.state,'completed');assert.equal(assemblies,1);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('legacy and finite sessions persist versioned protocol events without exposing actual credentials',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-agent-protocol-'));try{for(const kernel of ['legacy','finite']){
  const events=[];const adapter={...makeAdapter(),complete:async()=>({message:{role:'assistant',content:'plain-secret-credential-value'},finishReason:'stop',diagnostics:[]})};
  const result=await core.createAgentRunAssembly({tools:[],executeTool:async()=>({ok:true,content:'{}'})}).run({sessionsDir:root,adapter,config,apiKey:'plain-secret-credential-value',prompt:'read',permissionMode:'plan',kernel,onProtocolEvent:event=>events.push(event)});
  assert.ok(events.length>0);assert.deepEqual(events.map(e=>e.eventSeq),events.map((_,i)=>i+1));
  const text=await readFile(result.rolloutPath,'utf8');assert.match(text,/protocol-event/);assert.doesNotMatch(text,/plain-secret-credential-value/);
 }}finally{await rm(root,{recursive:true,force:true});}
});
test('session output budget covers compaction requests as well as ordinary provider turns',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-session-budget-'));const requested=[];
 try{const adapter={...makeAdapter(),complete:async request=>{requested.push(request.maxTokens);return {message:{role:'assistant',content:request.tools?'Final bounded answer':'Compacted bounded context'},finishReason:'stop',diagnostics:[],usage:{inputTokens:3,outputTokens:2}};}};
 const result=await core.createAgentRunAssembly({tools:[],executeTool:async()=>({ok:true,content:'{}'})}).run({sessionsDir:root,adapter,config,apiKey:'',prompt:'A long enough input to force the configured summary threshold',permissionMode:'plan',kernel:'finite',maxTotalOutputTokens:5,compaction:{autoCompactTokenLimit:1}});
 assert.deepEqual(requested,[5,3]);assert.equal(result.providerBudget.outputUsed,4);assert.equal(result.providerBudget.requests,2);assert.equal(result.kernel.state,'completed');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('assembly exposes host-operation settlement before a caller disposes native/session resources',async()=>{
 let release;const bridge={tools:[],executeTool:async()=>new Promise(resolve=>{release=()=>resolve({ok:true,content:'{}'});})};
 const assembly=core.createAgentRunAssembly(bridge,{sessionRunner:async params=>{void params.executeTool({id:'late',name:'fixture',argumentsJson:'{}'});return {sessionId:'fixture',rolloutPath:'fixture',run:{}};}});
 assert.equal(typeof assembly.waitForHostOperations,'function');await assembly.run({sessionsDir:'fixture',adapter:makeAdapter(),config,apiKey:'',prompt:'read',permissionMode:'plan'});
 let settled=false;const wait=assembly.waitForHostOperations().then(()=>{settled=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);release();await wait;assert.equal(settled,true);
});
test('shared finite entry applies the configured total timeout to an unresponsive provider',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-finite-total-timeout-'));
 try{const result=await core.createAgentRunAssembly({tools:[],executeTool:async()=>({ok:true,content:'{}'})}).run({sessionsDir:root,adapter:{...makeAdapter(),complete:()=>new Promise(resolve=>setTimeout(()=>resolve({message:{role:'assistant',content:'late'},finishReason:'stop',diagnostics:[]}),100))},config,apiKey:'',prompt:'read',permissionMode:'plan',kernel:'finite',timeoutMs:15});
 assert.equal(result.kernel.reason,'time_budget');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('streamed credentials are redacted across every split before UI and protocol persistence',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-stream-redaction-'));const secret='review-private-credential-value';
 try{for(const kernel of ['legacy','finite'])for(const type of ['text-delta','thinking-delta'])for(let split=1;split<secret.length;split++){
  const ui=[],protocol=[];
  const adapter={...makeAdapter(),stream:async function*(){yield {type,text:`before ${secret.slice(0,split)}`};yield {type:type==='text-delta'?'thinking-delta':'text-delta',text:'public reply'};yield {type,text:`${secret.slice(split)} after`};yield {type:'message-stop',finishReason:'stop'};}};
  const result=await core.createAgentRunAssembly({tools:[],executeTool:async()=>({ok:true,content:'{}'})}).run({sessionsDir:root,adapter,config,apiKey:secret,prompt:'read',permissionMode:'plan',kernel,streaming:true,onEvent:event=>ui.push(event),onProtocolEvent:event=>protocol.push(event)});
  const displayedType=type==='text-delta'?'agent-message-delta':'agent-thinking-delta';
  const uiText=ui.filter(event=>event.type===displayedType).map(event=>event.text).join('');
  const protocolText=protocol.filter(event=>event.event.type===displayedType).map(event=>event.event.text).join('');
  assert.doesNotMatch(uiText,new RegExp(secret),`${kernel}/${type}/${split}`);assert.doesNotMatch(protocolText,new RegExp(secret));
  const records=(await readFile(result.rolloutPath,'utf8')).trim().split('\n').map(JSON.parse);
  assert.doesNotMatch(records.filter(record=>record.type==='protocol-event'&&record.envelope.event.type===displayedType).map(record=>record.envelope.event.text??'').join(''),new RegExp(secret));
  assert.equal(core.parseRolloutLines(records.map(record=>JSON.stringify(record))).parseErrors,0);
 }}finally{await rm(root,{recursive:true,force:true});}
});
