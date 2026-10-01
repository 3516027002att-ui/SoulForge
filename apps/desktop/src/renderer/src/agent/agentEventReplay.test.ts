import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { orderUnseenAgentEvents, type AgentEventEnvelopeLike } from './agentEventReplay.js';
import * as replayModule from './agentEventReplay.js';

type Envelope = AgentEventEnvelopeLike & { label: string };

describe('Agent 事件回放合并', () => {
  it('不会因实时事件先到而丢掉更早的回放事件，并且重复事件只折叠一次', () => {
    const live: Envelope = { sessionId: 's1', seq: 5, label: 'fifth' };
    const replay: Envelope[] = [
      { sessionId: 's1', seq: 1, label: 'first' },
      { sessionId: 's1', seq: 2, label: 'second' },
      { sessionId: 's1', seq: 3, label: 'third' },
      { sessionId: 's1', seq: 4, label: 'fourth' },
      { sessionId: 's1', seq: 5, label: 'duplicate-fifth' },
      { sessionId: 'old', seq: 99, label: 'wrong-session' }
    ];

    const afterLive = orderUnseenAgentEvents([live], 's1');
    assert.deepEqual(afterLive.events.map((event) => event.seq), [5]);
    const afterReplay = orderUnseenAgentEvents(replay, 's1', afterLive.seen);
    assert.deepEqual(afterReplay.events.map((event) => event.seq), [1, 2, 3, 4]);
    assert.deepEqual([...afterReplay.seen].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  });

  it('限制已应用序号集合，仍保留最新事件', () => {
    const result = orderUnseenAgentEvents(
      [1, 2, 3, 4].map((seq) => ({ sessionId: 's1', seq, label: String(seq) })),
      's1',
      new Set<number>(),
      2
    );
    assert.deepEqual(result.events.map((event) => event.seq), [1, 2, 3, 4]);
    assert.deepEqual([...result.seen].sort((a, b) => a - b), [3, 4]);
  });

  it('已淘汰的旧序号不会在迟到回放中再次应用', () => {
    const first=orderUnseenAgentEvents([1,2,3].map(seq=>({sessionId:'s1',seq,label:String(seq)})),'s1',new Set(),2);
    const delayed=orderUnseenAgentEvents([{sessionId:'s1',seq:1,label:'duplicate'}],'s1',first.seen,2,first.droppedThrough);
    assert.deepEqual(delayed.events,[]);
  });

  it('接收队列按总字节和会话数保留有限窗口，超限明确报告缺口', () => {
    assert.equal(typeof replayModule.BoundedAgentEventQueue,'function');
    const queue=new replayModule.BoundedAgentEventQueue<Envelope>({maxBytes:500,maxEntries:4,maxSessions:2});
    for(let index=0;index<100;index++)queue.append({sessionId:`s-${index}`,seq:1,label:'x'.repeat(100)});
    assert.ok(queue.stats().sessions<=2);assert.ok(queue.stats().bytes<=500);assert.ok(queue.stats().entries<=4);
    for(let seq=2;seq<10;seq++)queue.append({sessionId:'s-99',seq,label:'x'.repeat(100)});
    const result=queue.take('s-99');assert.equal(result.truncated,true);assert.ok(result.events.length<=4);
    assert.equal(queue.take('s-99').events.length,0);queue.clear();assert.deepEqual(queue.stats(),{sessions:0,bytes:0,entries:0});
  });
  it('失败或拒绝的回放仍保留接收队列已淘汰内容的提示',()=>{
    assert.equal(typeof replayModule.combineAgentReplayWindow,'function');
    const queue=new replayModule.BoundedAgentEventQueue<Envelope>({maxEntries:1});
    queue.append({sessionId:'s1',seq:1,label:'old'});queue.append({sessionId:'s1',seq:2,label:'latest'});
    const queued=queue.take('s1');
    for(const result of [{ok:false},undefined]){
      const window=replayModule.combineAgentReplayWindow(result,queued);
      assert.equal(window.truncated,true);assert.deepEqual(window.events.map(event=>event.seq),[2]);
    }
  });
});
