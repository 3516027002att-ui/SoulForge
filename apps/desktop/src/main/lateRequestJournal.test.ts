import assert from 'node:assert/strict';
// @ts-ignore Focused runner uses Node TypeScript stripping.
import { LateRequestJournal } from './lateRequestJournal.ts';

// 未记录 → unknown（不能当作"没执行"）
{
  const journal = new LateRequestJournal();
  assert.deepEqual(journal.query('missing'), {
    requestId: 'missing',
    state: 'unknown',
    outcome: null,
    method: null
  });
}

// 超时未结算 → pending
{
  const journal = new LateRequestJournal();
  journal.record('r1', 'record');
  const state = journal.query('r1');
  assert.equal(state.state, 'pending');
  assert.equal(state.outcome, null);
  assert.equal(state.method, 'record');
}

// 迟到响应成功 → completed/ok
{
  const journal = new LateRequestJournal();
  journal.record('r1', 'record');
  assert.equal(journal.settle('r1', 'ok'), true);
  const state = journal.query('r1');
  assert.equal(state.state, 'completed');
  assert.equal(state.outcome, 'ok');
}

// 迟到响应失败 → completed/request-failed 且带 errorCode
{
  const journal = new LateRequestJournal();
  journal.record('r1', 'finalizeCommit');
  assert.equal(journal.settle('r1', 'request-failed', 'SQLITE_BUSY'), true);
  const state = journal.query('r1');
  assert.equal(state.outcome, 'request-failed');
  assert.equal(state.errorCode, 'SQLITE_BUSY');
}

// 结算后重复 record 不得把 completed 打回 pending
{
  const journal = new LateRequestJournal();
  journal.record('r1', 'record');
  journal.settle('r1', 'ok');
  journal.record('r1', 'record');
  assert.equal(journal.query('r1').state, 'completed');
  assert.equal(journal.query('r1').outcome, 'ok');
}

// 超过容量淘汰最旧
{
  const journal = new LateRequestJournal(2);
  journal.record('a', 'record');
  journal.record('b', 'record');
  journal.record('c', 'record');
  assert.equal(journal.size, 2);
  assert.equal(journal.query('a').state, 'unknown');
  assert.equal(journal.query('b').state, 'pending');
  assert.equal(journal.query('c').state, 'pending');
}

// 结算一个已被淘汰的请求：返回 false 且不复活
{
  const journal = new LateRequestJournal(1);
  journal.record('a', 'record');
  journal.record('b', 'record');
  assert.equal(journal.settle('a', 'ok'), false);
  assert.equal(journal.query('a').state, 'unknown');
}

console.log('lateRequestJournal: ok');
