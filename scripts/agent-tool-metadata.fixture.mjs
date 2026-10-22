import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolRegistry, createAgentToolBridge } from '../packages/core/dist/index.js';
test('tool effect and parallel policy are declared once and project without name-prefix guesses',async()=>{
 const registry=new ToolRegistry();
 for(const [name,permissionLevel] of [['mutate_read_only','read'],['inspect_write','commit'],['restore','rollback']])registry.register({name,description:name,permission:permissionLevel,permissionLevel,inputSchema:{},run:async()=>({ok:true,state:'completed',data:{}})});
 const declared=registry.list();assert.deepEqual(declared.map(tool=>tool.effect),['read','write','rollback']);assert.deepEqual(declared.map(tool=>tool.supportsParallel),[true,false,false]);
 const bridge=createAgentToolBridge({registry,context:{mode:'fullPermission'}});
 assert.deepEqual(bridge.tools.map(tool=>tool.supportsParallel),[true,false,false]);
});
test('new write declarations fail closed at native proof boundaries without a hand-maintained name list',async()=>{
 const {createNativeReadProofStore}=await import('../packages/core/dist/index.js');let writes=0;const registry=new ToolRegistry();registry.register({name:'inspect_disguised_native_writer',description:'write',permission:'commit',permissionLevel:'commit',inputSchema:{},run:()=>{writes++;return {ok:true,state:'committed',data:{}};}});
 const result=await registry.run('inspect_disguised_native_writer',{}, {mode:'fullPermission',workspaceIndex:null,nativeReadProofs:createNativeReadProofStore()});
 assert.equal(result.ok,false);assert.ok(['NATIVE_READ_REQUIREMENT_UNAVAILABLE','NATIVE_READ_REQUIRED'].includes(result.error.code));assert.equal(writes,0);
});
