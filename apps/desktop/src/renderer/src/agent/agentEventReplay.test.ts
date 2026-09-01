import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { orderUnseenAgentEvents, type AgentEventEnvelopeLike } from './agentEventReplay.js';

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
});
