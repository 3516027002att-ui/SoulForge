import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundedEventSender } from './eventSender.mjs';
test('slow host acknowledgement bounds queued event bytes and keeps emitted order',async()=>{
 let release,calls=0;const emitted=[];const sender=new BoundedEventSender(async event=>{emitted.push(event.seq);if(++calls===1)await new Promise(resolve=>{release=resolve;});},{maxBytes:300,maxEntries:3});
 sender.enqueue({seq:1,text:'x'.repeat(120)});await new Promise(resolve=>setImmediate(resolve));sender.enqueue({seq:2,text:'x'.repeat(120)});
 assert.throws(()=>sender.enqueue({seq:3,text:'x'.repeat(120)}),error=>error.code==='AGENT_EVENT_QUEUE_BUDGET_EXCEEDED');release();await sender.flush();assert.deepEqual(emitted,[1,2]);
});
