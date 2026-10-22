import assert from 'node:assert/strict';
// @ts-ignore Focused runner uses Node TypeScript stripping.
import { RagRefreshQueue } from './ragRefreshQueue.ts';

const queue = new RagRefreshQueue();
const owner = 'workspace-a:session-a:1';
let release!: () => void;
let durable = 0;
const first = queue.run(owner, async () => {
  await new Promise<void>(resolve => { release = resolve; });
  durable = 1;
});
await Promise.resolve();
const second = queue.run(owner, async () => {
  assert.equal(durable, 1, 'load baseline must happen after the previous writer completes');
  durable = 2;
});
const controller = new AbortController();
let cancelledRan = false;
const cancelled = queue.run(owner, async () => { cancelledRan = true; }, controller.signal);
controller.abort();
await assert.rejects(cancelled, { name: 'AbortError' });
release();
await Promise.all([first, second]);
await queue.run(owner, async () => { assert.equal(cancelledRan, false); });
await assert.rejects(queue.run(owner, async () => { throw Error('expected failure'); }), /expected failure/);
await queue.run(owner, async () => { durable = 3; });
assert.equal(durable, 3, 'a failed refresh must not poison later refreshes');

// A new workspace generation must not wait behind an old workspace's
// cancelled/slow tail.  The queue key is a logical workspace generation, not
// the singleton OperationLogUtilityClient object.
let ownerARunning = false;
let ownerBStarted = false;
let releaseOwnerA!: () => void;
const ownerA = queue.run('workspace-a:session-a:2', async () => {
  ownerARunning = true;
  await new Promise<void>(resolve => { releaseOwnerA = resolve; });
  ownerARunning = false;
});
await Promise.resolve();
const ownerB = queue.run('workspace-b:session-b:1', async () => {
  ownerBStarted = true;
  assert.equal(ownerARunning, true, 'independent workspace generations may overlap');
});
await ownerB;
assert.equal(ownerBStarted, true);
releaseOwnerA();
await ownerA;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

// Cancellation releases the caller immediately, not the actual operation. A
// shutdown owner must still wait for that operation before closing its database.
{
  const pending = new RagRefreshQueue();
  const started = deferred(), finish = deferred();
  const cancellation = new AbortController();
  let operationFinished = false, drained = false;
  const caller = pending.run('cancelled-active-owner', async () => {
    started.resolve(); await finish.promise; operationFinished = true;
  }, cancellation.signal);
  await started.promise;
  const cancelledCaller = assert.rejects(caller, { name: 'AbortError' });
  cancellation.abort();
  await cancelledCaller;
  assert.equal(operationFinished, false, 'the existing immediate cancellation contract must remain unchanged');
  let draining: Promise<void> | undefined;
  try {
    draining = pending.drain().then(() => { drained = true; });
    await turn();
    assert.equal(drained, false, 'cancelled wrapper settlement is not a completed real tail');
    finish.resolve();
    await draining;
    assert.equal(operationFinished, true, 'drain must wait for the real cancelled operation');
  } finally { finish.resolve(); await draining; }
}

// Drain all logical owners, including a replacement tail/new owner admitted
// while a previous snapshot is waiting. A failed operation must not poison it.
{
  const pending = new RagRefreshQueue();
  const a = deferred(), b = deferred(), c = deferred();
  const completed: string[] = [];
  let drained = false;
  const tasks: Promise<unknown>[] = [
    pending.run('a', async () => { await a.promise; completed.push('a'); }),
    pending.run('b', async () => { await b.promise; completed.push('b'); })
  ];
  let draining: Promise<void> | undefined;
  try {
    draining = pending.drain().then(() => { drained = true; });
    const failure = pending.run('a', async () => { throw new Error('owned drain failure'); });
    tasks.push(assert.rejects(failure, /owned drain failure/));
    tasks.push(pending.run('c', async () => { await c.promise; completed.push('c'); }));
    a.resolve(); b.resolve();
    await turn();
    assert.equal(drained, false, 'a drain snapshot must not omit later real tails');
    assert.deepEqual(completed, ['a', 'b']);
    c.resolve();
    await Promise.all(tasks); await draining;
    assert.deepEqual(completed, ['a', 'b', 'c']);
    await pending.drain(); // Empty/repeated drains complete without changing admission.
    await pending.run('after-drain', async () => { completed.push('after-drain'); });
    assert.equal(completed.at(-1), 'after-drain', 'permanent producer shutdown belongs to the workspace owner');
  } finally { a.resolve(); b.resolve(); c.resolve(); await Promise.allSettled(tasks); await draining; }
}
console.log('ragRefreshQueue: PASS');
