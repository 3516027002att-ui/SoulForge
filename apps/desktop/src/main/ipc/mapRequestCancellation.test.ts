import assert from 'node:assert/strict';
import { test } from 'node:test';

// @ts-ignore Focused runner executes this source with Node TypeScript stripping.
import { executeMapRequest, MapRequestCancellationRegistry, normalizeMapRequestId, type MapRequestOwnerLifecycle } from './mapRequestCancellation.ts';

class FakeOwner implements MapRequestOwnerLifecycle {
  private readonly listeners = new Map<'destroyed' | 'render-process-gone', () => void>();

  public once(event: 'destroyed' | 'render-process-gone', listener: () => void): void {
    assert.equal(this.listeners.has(event), false, `owner ${event} listener must be installed once`);
    this.listeners.set(event, listener);
  }

  public removeListener(event: 'destroyed' | 'render-process-gone', listener: () => void): void {
    if (this.listeners.get(event) === listener) this.listeners.delete(event);
  }

  public destroy(): void {
    const listener = this.listeners.get('destroyed');
    this.listeners.clear();
    listener?.();
  }

  public crash(): void {
    const listener = this.listeners.get('render-process-gone');
    this.listeners.clear();
    listener?.();
  }

  public get hasListener(): boolean {
    return this.listeners.size > 0;
  }
}

test('requestId bounded normalization keeps the IPC handle opaque', () => {
  assert.equal(normalizeMapRequestId(' map-request-1 '), 'map-request-1');
  assert.equal(normalizeMapRequestId(''), null);
  assert.equal(normalizeMapRequestId('x'.repeat(161)), null);
  assert.equal(normalizeMapRequestId({}), null);
});

test('same owner duplicate live requestId is rejected while a different owner is isolated', () => {
  const registry = new MapRequestCancellationRegistry();
  const first = registry.begin(1, 'same-id');
  assert.equal(first.status, 'started');
  assert.equal(registry.begin(1, 'same-id').status, 'duplicate');
  const other = registry.begin(2, 'same-id');
  assert.equal(other.status, 'started');
  assert.equal(registry.cancel(2, 'same-id').status, 'cancelled');
  assert.equal((first as { lease: { controller: AbortController } }).lease.controller.signal.aborted, false);
});

test('cancel before await and in-flight cancel both abort only the owned controller', () => {
  const registry = new MapRequestCancellationRegistry();
  const beforeAwait = registry.begin(10, 'before-await');
  const inFlight = registry.begin(10, 'in-flight');
  assert.equal(beforeAwait.status, 'started');
  assert.equal(inFlight.status, 'started');
  assert.equal(registry.cancel(10, 'before-await').status, 'cancelled');
  assert.equal(registry.cancel(10, 'in-flight').status, 'cancelled');
  assert.equal((beforeAwait as { lease: { controller: AbortController } }).lease.controller.signal.aborted, true);
  assert.equal((inFlight as { lease: { controller: AbortController } }).lease.controller.signal.aborted, true);
  assert.equal(registry.cancel(10, 'in-flight').status, 'already-cancelled');
});

test('pre-aborted execution does not start Bridge work', async () => {
  const controller = new AbortController();
  controller.abort('cancel-before-execute');
  let calls = 0;
  const settled = await executeMapRequest(controller, async () => {
    calls += 1;
    return 'must-not-run';
  });
  assert.deepEqual(settled, { outcome: 'cancelled' });
  assert.equal(calls, 0);
});

test('a pending read resolves late after cancel but cannot publish its result', async () => {
  const registry = new MapRequestCancellationRegistry();
  const begun = registry.begin(11, 'pending');
  assert.equal(begun.status, 'started');
  const lease = (begun as { lease: { controller: AbortController; requestId: string } }).lease;
  let resolveRead!: (value: string) => void;
  const pendingRead = new Promise<string>((resolve) => { resolveRead = resolve; });
  const read = executeMapRequest(lease.controller, async () => {
    return pendingRead;
  }).finally(() => {
    registry.finish(11, lease.requestId, lease.controller);
  });

  assert.equal(registry.cancel(11, 'pending').status, 'cancelled');
  resolveRead('late geometry');
  const settled = await read;
  assert.deepEqual(settled, { outcome: 'cancelled' }, 'late result must not publish after request cancellation');
  assert.equal(registry.size, 0);
});

test('finish makes an already-settled request uncancellable and stale finish cannot erase a new generation', () => {
  const registry = new MapRequestCancellationRegistry();
  const old = registry.begin(3, 'old');
  assert.equal(old.status, 'started');
  const oldLease = (old as { lease: { controller: AbortController } }).lease;
  assert.equal(registry.finish(3, 'old', oldLease.controller), true);
  assert.equal(registry.cancel(3, 'old').status, 'not-found');

  const generationOne = registry.begin(3, 'generation-one');
  assert.equal(generationOne.status, 'started');
  const generationOneLease = (generationOne as { lease: { controller: AbortController } }).lease;
  assert.equal(registry.finish(3, 'generation-one', new AbortController()), false);
  const generationTwo = registry.begin(3, 'generation-two');
  assert.equal(generationTwo.status, 'started');
  assert.equal(registry.finish(3, 'generation-one', generationOneLease.controller), true);
  assert.equal((generationTwo as { lease: { controller: AbortController } }).lease.controller.signal.aborted, false);
});

test('late cancellation of an old generation cannot abort the new generation', () => {
  const registry = new MapRequestCancellationRegistry();
  const old = registry.begin(12, 'generation-old');
  assert.equal(old.status, 'started');
  const oldLease = (old as { lease: { controller: AbortController } }).lease;
  assert.equal(registry.finish(12, 'generation-old', oldLease.controller), true);
  const current = registry.begin(12, 'generation-new');
  assert.equal(current.status, 'started');
  assert.equal(registry.cancel(12, 'generation-old').status, 'not-found');
  assert.equal((current as { lease: { controller: AbortController } }).lease.controller.signal.aborted, false);
});

test('owner destroyed cancels all live requests, installs one listener, and cleans it when idle', () => {
  const registry = new MapRequestCancellationRegistry();
  const owner = new FakeOwner();
  const first = registry.begin(7, 'a');
  const second = registry.begin(7, 'b');
  const other = registry.begin(8, 'other');
  assert.equal(first.status, 'started');
  assert.equal(second.status, 'started');
  assert.equal(other.status, 'started');
  registry.bindOwner(7, owner);
  registry.bindOwner(7, owner);
  assert.equal(registry.ownerListenerCount, 1);
  assert.equal(owner.hasListener, true);
  const firstController = (first as { lease: { controller: AbortController } }).lease.controller;
  const secondController = (second as { lease: { controller: AbortController } }).lease.controller;
  owner.destroy();
  assert.equal(firstController.signal.aborted, true);
  assert.equal(secondController.signal.aborted, true);
  assert.equal(registry.size, 1, 'destroying one owner must not touch another owner');
  assert.equal(registry.ownerListenerCount, 0);

  const next = registry.begin(7, 'next');
  assert.equal(next.status, 'started');
  registry.bindOwner(7, owner);
  const nextController = (next as { lease: { controller: AbortController } }).lease.controller;
  assert.equal(registry.finish(7, 'next', nextController), true);
  assert.equal(registry.ownerListenerCount, 0);
  assert.equal(owner.hasListener, false);
});

test('renderer process gone cancels only that owner and detaches both lifecycle listeners', () => {
  const registry = new MapRequestCancellationRegistry();
  const crashedOwner = new FakeOwner();
  const survivingOwner = new FakeOwner();
  const crashed = registry.begin(21, 'crashed');
  const surviving = registry.begin(22, 'surviving');
  assert.equal(crashed.status, 'started');
  assert.equal(surviving.status, 'started');
  registry.bindOwner(21, crashedOwner);
  registry.bindOwner(22, survivingOwner);
  const crashedController = (crashed as { lease: { controller: AbortController } }).lease.controller;
  const survivingController = (surviving as { lease: { controller: AbortController } }).lease.controller;
  crashedOwner.crash();
  assert.equal(crashedController.signal.aborted, true);
  assert.equal(survivingController.signal.aborted, false);
  assert.equal(registry.size, 1);
  assert.equal(registry.ownerListenerCount, 1);
  assert.equal(crashedOwner.hasListener, false);
  assert.equal(registry.finish(22, 'surviving', survivingController), true);
  assert.equal(survivingOwner.hasListener, false);
});
