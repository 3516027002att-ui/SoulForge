import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {runAgentSession} from '../packages/core/dist/index.js';
const config={id:'rag',displayName:'rag',protocol:'openai-compatible',baseUrl:'https://fixture.invalid',model:'same-deterministic-provider',hasCredential:false,createdAt:'',updatedAt:''};
for(const compact of [false,true])test(`automatic RAG retains the configured retrieval/injection cadence with compaction=${compact}`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-rag-cadence-'));
 try{
  const results=[];
  for(const kernel of [undefined,'finite']){
   let reads=0,turn=0;const modelMessages=[];
   const adapter={protocol:'openai-compatible',listModels:async()=>({ok:true,models:[]}),stream:async function*(){throw new Error('unused');},complete:async request=>{
    if(!Array.isArray(request.tools))return {message:{role:'assistant',content:'Bounded context summary.'},finishReason:'stop',diagnostics:[],usage:{inputTokens:5,outputTokens:5}};
    modelMessages.push(structuredClone(request.messages));turn++;
    return {message:{role:'assistant',content:turn===1?'':'Read result reported.',...(turn===1?{toolCalls:[{id:'read',name:'inspect_fixture',argumentsJson:'{}'}]}:{})},finishReason:turn===1?'tool_use':'stop',diagnostics:[],usage:{inputTokens:5,outputTokens:5}};
   }};
   const result=await runAgentSession({sessionsDir:root,adapter,config,apiKey:'',kernel,prompt:'固定检索问题',permissionMode:'plan',maxSteps:4,maxTotalOutputTokens:10000,sampling:{maxTokens:512},
    tools:[{name:'inspect_fixture',description:'fixture',permissionLevel:'read',parametersJsonSchema:{}}],executeTool:async()=>({ok:true,content:'{"value":1}'}),
    ...(compact?{compaction:{autoCompactTokenLimit:1}}:{}),ragSearch:{maxHits:1,retrieve:async query=>{assert.equal(query,'固定检索问题');reads++;return {ok:true,hits:[{score:1,chunk:{family:'PARAM',symbolUri:'fixture://param/one'},excerpt:'Untrusted fixture evidence.'}]};}}});
   assert.equal(result.run.finishReason,'stop',JSON.stringify(result.run.diagnostics));
   results.push({reads,ragMessages:modelMessages.map(messages=>messages.filter(message=>message.content.includes('UNTRUSTED_RAG_EVIDENCE_BEGIN')).map(message=>message.content))});
  }
  assert.equal(results[0].reads,1);assert.deepEqual(results[1],results[0]);
  assert.deepEqual(results[1].ragMessages.map(messages=>messages.length),compact?[1,1]:[1,0]);
 }finally{await rm(root,{recursive:true,force:true});}
});
