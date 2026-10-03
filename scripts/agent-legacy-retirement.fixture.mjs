import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runAgentSession} from '../packages/core/dist/index.js';

test('unused model-authored task ledger has no implementation or executable self-check', () => {
  assert.equal(existsSync('apps/desktop/src/main/agentTaskRecord.ts'), false);
  assert.equal(existsSync('scripts/verify-agent-task-record-gate.mjs'), false);
  for (const file of ['scripts/verify-agent-emevd-proof-gate.mjs','scripts/verify-agent-performance-fixes.mjs']) {
    assert.doesNotMatch(readFileSync(file,'utf8'), /createAgentTaskRecordGateway/);
  }
});

test('the default session uses finite and rejects the retired selector before provider or host work',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-agent-default-'));let requests=0;
 const config={id:'retired',displayName:'retired',protocol:'openai-compatible',baseUrl:'https://fixture.invalid',hasCredential:false,createdAt:'',updatedAt:''};
 const params={sessionsDir:root,config,apiKey:'',prompt:'Read and report',permissionMode:'plan',tools:[],executeTool:async()=>{throw new Error('Unexpected tool');},adapter:{protocol:'openai-compatible',listModels:async()=>({ok:true,models:[]}),stream:async function*(){throw new Error('unused');},complete:async()=>{requests++;return {message:{role:'assistant',content:'Read outcome'},finishReason:'stop',diagnostics:[],usage:{inputTokens:1,outputTokens:1}};}}};
 try{
  const result=await runAgentSession(params);assert.equal(result.kernel.state,'completed');assert.equal(result.kernel.evaluation,'unverified');
  await assert.rejects(()=>runAgentSession({...params,kernel:'legacy'}),{code:'AGENT_LEGACY_KERNEL_RETIRED'});assert.equal(requests,1);
  const source=readFileSync('packages/core/src/model-services/agentLoop.ts','utf8');
  assert.match(source,/runFiniteAgentAdapter/);assert.doesNotMatch(source,/while\s*\(|MAX_SEMANTIC_TOOL_FAILURES|looksLikeIncompleteConclusion/);
 }finally{await rm(root,{recursive:true,force:true});}
});

for(const content of ['', '接下来我会继续读取参数并进行修改。'])test(`finite model stop remains independent of conclusion wording: ${JSON.stringify(content)}`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-agent-stop-'));let requests=0;
 try{
  const result=await runAgentSession({sessionsDir:root,config:{id:'stop',displayName:'stop',protocol:'openai-compatible',baseUrl:'https://fixture.invalid',hasCredential:false,createdAt:'',updatedAt:''},apiKey:'',prompt:'Check the resource',permissionMode:'plan',tools:[],executeTool:async()=>{throw new Error('Unexpected tool');},adapter:{protocol:'openai-compatible',listModels:async()=>({ok:true,models:[]}),stream:async function*(){throw new Error('unused');},complete:async()=>{requests++;return {message:{role:'assistant',content},finishReason:'stop',diagnostics:[],usage:{inputTokens:1,outputTokens:1}};}}});
  assert.equal(requests,1);assert.equal(result.kernel.reason,'model_stopped');assert.equal(result.kernel.evaluation,'unverified');
 }finally{await rm(root,{recursive:true,force:true});}
});
