import assert from 'node:assert/strict';
import test from 'node:test';
import type {WorkspaceSession} from '@soulforge/core';
import {WorkspaceReadLifetime} from './workspaceReadLifetime.js';

test('late committed writes retain operation facts while old cache and refresh projections stay isolated',async()=>{
  const lifetime=new WorkspaceReadLifetime();const cache=lifetime.createCache<string,string>();
  let session={meta:{workspaceId:'old'}} as WorkspaceSession;const handlers=new Map<string,Function>();
  let entered!:()=>void;let settle!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});const wait=new Promise<void>(resolve=>{settle=resolve;});
  let refreshed=0;const refresh=lifetime.guardProjection(()=>{refreshed++;});
  const register=lifetime.register((name,handler)=>handlers.set(name,handler),()=>session);
  register('resource.applyFmgMutation',async()=>{
    entered();await wait;cache.delete('same-resource');cache.clear();cache.set('same-resource','old');refresh();
    return {ok:true,operationId:'committed-old-op',committed:true,retryable:false};
  });
  const pending=handlers.get('resource.applyFmgMutation')!({});await started;
  lifetime.invalidate();session={meta:{workspaceId:'new'}} as WorkspaceSession;cache.set('same-resource','new');
  settle();assert.deepEqual(await pending,{ok:true,operationId:'committed-old-op',committed:true,retryable:false});
  assert.equal(cache.get('same-resource'),'new');assert.equal(refreshed,0);
});
