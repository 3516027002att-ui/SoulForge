import assert from 'node:assert/strict';
import test from 'node:test';
import { RolloutRecorder } from '../packages/core/dist/index.js';
test('stalled rollout storage applies backpressure before retaining unbounded session messages',async()=>{
 let release,calls=0;const storage={appendLines:()=>++calls===1?new Promise(resolve=>{release=resolve;}):Promise.resolve(),flush:async()=>{},close:async()=>{},readLines:async()=>[]};
 const recorder=new RolloutRecorder(storage,{sessionId:'fixture',startedAt:'',configId:'fixture',protocol:'openai-compatible',permissionMode:'plan'},{maxQueuedBytes:512,maxQueuedItems:3});
 const item={type:'message',step:1,message:{role:'assistant',content:'x'.repeat(200)}};
 recorder.enqueue(item);await new Promise(resolve=>setImmediate(resolve));
 assert.throws(()=>{recorder.enqueue(item);recorder.enqueue(item);},error=>error.code==='ROLLOUT_QUEUE_BUDGET_EXCEEDED');
 release();await recorder.close();
});
