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
console.log('ragRefreshQueue: PASS');
