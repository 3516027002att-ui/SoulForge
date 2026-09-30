import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ToolRegistry, createAgentToolBridge, createAgentRunAssembly } from '../packages/core/dist/index.js';
const config={id:'comparison',displayName:'comparison',protocol:'openai-compatible',baseUrl:'https://fixture.invalid',model:'same-deterministic-provider',hasCredential:false,createdAt:'',updatedAt:''};

for(const scenario of [
 {name:'read-only',initial:80,expected:80,write:false},
 {name:'already-satisfied',initial:80,expected:80,write:false},
 {name:'needs-change',initial:81,expected:80,write:true},
 {name:'false-model-success',initial:81,expected:80,write:false}
])test(`controlled old/new kernels share the same independent oracle for ${scenario.name}`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-kernel-comparison-'));
 try{const results=[];
  for(const kernel of ['legacy','finite']){
   let value=scenario.initial,writes=0,turn=0;
   const registry=new ToolRegistry();
   registry.register({name:'inspect_fixture',description:'inspect controlled fixture',permission:'read',permissionLevel:'read',inputSchema:{},run:async()=>({ok:true,state:'completed',data:{value}})});
   registry.register({name:'set_fixture',description:'set controlled fixture',permission:'commit',permissionLevel:'commit',inputSchema:{value:'number'},run:async input=>{value=input.value;writes++;return {ok:true,state:'committed',data:{value}};}});
   const bridge=createAgentToolBridge({registry,context:{mode:'normal'}});
   const adapter={protocol:'openai-compatible',listModels:async()=>({ok:true,models:[]}),stream:async function*(){throw new Error('unused');},complete:async()=>{
    turn++;const tool=turn===1?{id:'read',name:'inspect_fixture',argumentsJson:'{}'}:turn===2&&scenario.write?{id:'set',name:'set_fixture',argumentsJson:'{"value":80}'}:null;
    return {message:{role:'assistant',content:tool?'':'The controlled fixture task is complete.',...(tool?{toolCalls:[tool]}:{})},finishReason:tool?'tool_use':'stop',usage:{inputTokens:20,outputTokens:20},diagnostics:[]};
   }};
   const memoryBefore=process.memoryUsage(),started=performance.now();
   const session=await createAgentRunAssembly(bridge).run({sessionsDir:root,adapter,config,apiKey:'',prompt:'Check or set the controlled fixture as requested',permissionMode:'normal',kernel,requestApproval:async()=>({decision:'once'}),maxSteps:10});
   // The oracle reads domain state after the run, never the model's wording.
   results.push({kernel,goalStatus:value===scenario.expected?'passed':'failed',value,writes,finishReason:session.run.finishReason,durationMs:performance.now()-started,heapDelta:process.memoryUsage().heapUsed-memoryBefore.heapUsed,rss:process.memoryUsage().rss});
  }
  assert.equal(results[0].goalStatus,results[1].goalStatus);assert.equal(results[0].writes,results[1].writes);assert.equal(results[0].value,results[1].value);
  assert.equal(results[1].goalStatus,scenario.name==='false-model-success'?'failed':'passed');assert.equal(results[1].writes,scenario.write?1:0);
 }finally{await rm(root,{recursive:true,force:true});}
});
