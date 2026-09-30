import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundedEventHistory } from './eventHistory.mjs';
test('slow UI replay retains a byte-bounded window and reports the evicted sequence gap',()=>{
 const history=new BoundedEventHistory({maxBytes:512,maxEntries:10});for(let seq=1;seq<=100;seq++)history.append({seq,event:{type:'delta',text:String(seq).repeat(80)}});
 const replay=history.replay(0);assert.ok(replay.totalBytes<=512);assert.ok(replay.events.length<10);assert.equal(replay.truncated,true);assert.equal(replay.events.at(-1).seq,100);
 history.clear();assert.equal(history.replay(0).totalBytes,0);
});
test('a single oversized event cannot replace the final bounded lifecycle event',()=>{
 const history=new BoundedEventHistory({maxBytes:128,maxEntries:10});history.append({seq:1,event:{text:'x'.repeat(1000)}});history.append({seq:2,event:{type:'done'}});
 assert.deepEqual(history.replay(0).events.map(e=>e.seq),[2]);assert.equal(history.replay(0).truncated,true);
});
