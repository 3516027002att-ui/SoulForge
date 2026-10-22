import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import * as core from '../packages/core/dist/index.js';

test('one shared result instruction reaches default and explicit finite sessions while every tool retains its domain schema and description',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-description-dedup-'));
 try{
  const instructions=core.AGENT_TOOL_RESULT_INSTRUCTIONS;assert.equal(typeof instructions,'string');
  const registry=core.createDefaultToolRegistry();const bridge=core.createAgentToolBridge({registry,context:{mode:'plan'}});
  const descriptors=registry.list();assert.equal(bridge.tools.length,descriptors.length);
  for(const tool of bridge.tools){assert.equal(tool.description,descriptors.find(item=>item.name===tool.name).description);assert.ok(!tool.description.includes(instructions));}
  for(const kernel of [undefined,'finite']){
   const requests=[];const adapter={protocol:'openai-compatible',listModels:async()=>({ok:true,models:[]}),stream:async function*(){throw new Error('unused');},complete:async request=>{requests.push(request);return {message:{role:'assistant',content:'Read-only outcome reported.'},finishReason:'stop',diagnostics:[]};}};
   const config={id:'dedup',displayName:'dedup',protocol:'openai-compatible',baseUrl:'https://fixture.invalid',model:'same-deterministic-provider',hasCredential:false,createdAt:'',updatedAt:''};
   const result=await core.createAgentRunAssembly(bridge).run({sessionsDir:root,adapter,config,apiKey:'',kernel,prompt:'Report the bounded read-only task',permissionMode:'plan'});
   assert.equal(requests.length,1);assert.equal(requests[0].messages.filter(message=>message.content===instructions).length,1);
   assert.ok(!requests[0].tools.some(tool=>tool.description.includes(instructions)));
   const records=(await readFile(result.rolloutPath,'utf8')).trim().split('\n').map(JSON.parse);
   assert.equal(records.filter(record=>record.type==='message'&&record.message.content===instructions).length,1);
   const before={...requests[0],messages:requests[0].messages.filter(message=>message.content!==instructions),tools:requests[0].tools.map(tool=>({...tool,description:`${tool.description} ${instructions}`}))};
   assert.ok(JSON.stringify(before).length>JSON.stringify(requests[0]).length,'description dedup must reduce serialized request characters independently of the kernel');
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
