import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createContextBroker} from './contextBroker.js';
import {runAgentSession} from './agentSessionHost.js';
import type {ModelServiceAdapter} from './types.js';

test('absent initial evidence stays unavailable with a warning rather than a run error',async()=>{
 for(const sources of [[],[{kind:'readFile' as const,text:''}],[{kind:'readFile' as const,readText:async()=>''}]]){
  const result=await createContextBroker().assemble(sources);
  assert.equal(result.ok,false);
  if(result.ok)throw new Error('Missing evidence cannot become assembled context.');
  assert.equal(result.code,'insufficient_evidence');assert.equal(result.diagnostics[0]?.severity,'warning');
 }
});

test('context cancellation and budget refusal keep their structured error diagnostics',async()=>{
 const controller=new AbortController();controller.abort();
 const cancelled=await createContextBroker().assemble([],{signal:controller.signal});
 assert.equal(cancelled.ok,false);if(cancelled.ok)throw new Error('Cancelled context cannot pass.');
 assert.equal(cancelled.code,'CONTEXT_CANCELLED');assert.equal(cancelled.diagnostics[0]?.severity,'error');
 const limited=await createContextBroker().assemble([{kind:'readFile',text:'owned fixture evidence'}],{maxBytes:1});
 assert.equal(limited.ok,false);if(limited.ok)throw new Error('Over-budget context cannot pass.');
 assert.equal(limited.code,'CONTEXT_LIMIT_EXCEEDED');assert.equal(limited.diagnostics[0]?.severity,'error');
});

test('a normal first model request records empty evidence as unavailable and keeps task completion unverified',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-initial-evidence-'));let modelCalls=0;
 const adapter:ModelServiceAdapter={protocol:'openai-compatible',listModels:async()=>({ok:true,models:[]}),stream:async function*(){throw new Error('Unused stream port');},complete:async()=>{modelCalls++;return {message:{role:'assistant',content:'Discovery can begin.'},finishReason:'stop',diagnostics:[]};}};
 try{
  const result=await runAgentSession({sessionsDir:root,adapter,config:{id:'fixture',displayName:'fixture',protocol:'openai-compatible',baseUrl:'https://fixture.invalid',model:'local-fixture',hasCredential:false,createdAt:'',updatedAt:''},apiKey:'',prompt:'Inspect owned resources.',permissionMode:'plan',tools:[],executeTool:async()=>{throw new Error('No tool call was proposed');},contextBroker:createContextBroker(),streaming:false});
  assert.equal(modelCalls,1);assert.equal(result.run.finishReason,'stop');assert.equal(result.kernel?.evaluation,'unverified');
  assert.equal(result.run.diagnostics.find(item=>item.code==='insufficient_evidence')?.severity,'warning');
  assert.equal(result.run.audit.contextAssemblies?.[0]?.ok,false);
 }finally{await rm(root,{recursive:true,force:true});}
});
