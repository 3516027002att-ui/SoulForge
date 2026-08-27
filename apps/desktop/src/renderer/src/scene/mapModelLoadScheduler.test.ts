import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FrameTaskQueue,
  MapModelLoadCache,
  normalizeMapModelKey
} from './mapModelLoadScheduler.js';

const mesh = {
  positionsBase64: 'AAAA',
  vertexCount: 1
};

test('MapModelLoadCache deduplicates concurrent aliases and caches the result', async () => {
  let calls = 0;
  const cache = new MapModelLoadCache(async () => {
    calls += 1;
    await Promise.resolve();
    return mesh;
  });
  const [first, second] = await Promise.all([
    cache.load('N:/map/M000010.FLVER'),
    cache.load('m000010.mapbnd.dcx')
  ]);
  assert.equal(first, mesh);
  assert.equal(second, mesh);
  assert.equal(await cache.load('m000010'), mesh);
  assert.equal(calls, 1);
  assert.equal(normalizeMapModelKey('M000010.objbnd.dcx'), 'm000010');
});

test('FrameTaskQueue keeps later uploads for a subsequent frame when budget is exhausted', async () => {
  const frames: FrameRequestCallback[] = [];
  let clock = 0;
  const queue = new FrameTaskQueue(
    (callback) => { frames.push(callback); return frames.length; },
    () => undefined,
    () => clock,
    5
  );
  const order: number[] = [];
  const first = queue.enqueue(() => { order.push(1); clock += 6; });
  const second = queue.enqueue(() => { order.push(2); });
  assert.equal(frames.length, 1);
  frames.shift()!(0);
  assert.deepEqual(order, [1]);
  assert.equal(frames.length, 1);
  frames.shift()!(16);
  assert.deepEqual(order, [1, 2]);
  assert.equal(await first, true);
  assert.equal(await second, true);
});
