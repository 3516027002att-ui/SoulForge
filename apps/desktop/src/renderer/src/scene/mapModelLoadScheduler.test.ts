import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalResourceCacheKeySha256,
  FrameTaskQueue,
  MapModelLoadCache,
  normalizeMapModelKey,
  sha256Utf8Hex,
  type ResourceCacheKeyV1
} from './mapModelLoadScheduler.js';

const mesh = {
  positionsBase64: 'AAAA',
  vertexCount: 1
};

function resourceKey(overrides: Partial<ResourceCacheKeyV1> = {}): ResourceCacheKeyV1 {
  return {
    schema: 'map-resource-cache-key-v1',
    workspacePersistentIdentityHash: 'workspace',
    overlayResolutionGeneration: 1,
    resourceEdgeId: 'edge',
    resolvedLogicalUri: 'uri',
    sourceIdentityHash: 'source',
    pathSourceGeneration: 1,
    containerEntryIdentitySha256: 'entry',
    modelLocalTransformSha256: 'transform',
    faceSetRuleRegistrySha256: 'faceset',
    mapCoordinateContractPayloadSha256: 'coordinate',
    ...overrides
  };
}

test('sha256Utf8Hex uses standard SHA-256 for UTF-8 and boundary inputs', async () => {
  assert.equal(
    await sha256Utf8Hex(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  );
  assert.equal(
    await sha256Utf8Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
  assert.equal(
    await sha256Utf8Hex('雪鸮🦉'),
    '7d59f9b987573d634654142d00cfa513b247f72b176bb6b11e47d07ba14e61b6'
  );
  assert.equal(
    await sha256Utf8Hex('a'.repeat(1024)),
    '2edc986847e209b4016e141a6dc8716d3207350f416969382d431539bf292e4a'
  );
});

test('canonicalResourceCacheKeySha256 is stable across property insertion order', async () => {
  const keyA: ResourceCacheKeyV1 = {
    schema: 'map-resource-cache-key-v1',
    workspacePersistentIdentityHash: 'workspace',
    overlayResolutionGeneration: 2,
    resourceEdgeId: 'edge',
    resolvedLogicalUri: 'uri',
    sourceIdentityHash: 'source',
    pathSourceGeneration: 3,
    containerEntryIdentitySha256: 'entry',
    modelLocalTransformSha256: 'transform',
    faceSetRuleRegistrySha256: 'faceset',
    mapCoordinateContractPayloadSha256: 'coordinate'
  };
  const keyB = {
    mapCoordinateContractPayloadSha256: 'coordinate',
    faceSetRuleRegistrySha256: 'faceset',
    modelLocalTransformSha256: 'transform',
    containerEntryIdentitySha256: 'entry',
    pathSourceGeneration: 3,
    sourceIdentityHash: 'source',
    resolvedLogicalUri: 'uri',
    resourceEdgeId: 'edge',
    overlayResolutionGeneration: 2,
    workspacePersistentIdentityHash: 'workspace',
    schema: 'map-resource-cache-key-v1'
  } satisfies ResourceCacheKeyV1;
  assert.equal(
    await canonicalResourceCacheKeySha256(keyA),
    await canonicalResourceCacheKeySha256(keyB)
  );
});

test('sha256Utf8Hex fails clearly when WebCrypto is unavailable', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: undefined,
      writable: true
    });
    await assert.rejects(sha256Utf8Hex('abc'), /MAP_CACHE_SHA256_UNAVAILABLE/);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else Reflect.deleteProperty(globalThis, 'crypto');
  }
});

test('MapModelLoadCache keeps distinct normalized legacy names on distinct geometries', async () => {
  const calls: string[] = [];
  const cache = new MapModelLoadCache(async (modelName) => {
    calls.push(modelName);
    return { positionsBase64: `wire:${modelName}`, vertexCount: 1, marker: modelName };
  });
  const [first, second] = await Promise.all([
    cache.load('m10_00_00_00_042260'),
    cache.load('m10_00_00_00_098775')
  ]);
  assert.equal(calls.length, 2);
  assert.notEqual(first, second);
  assert.equal(first?.positionsBase64, 'wire:m10_00_00_00_042260');
  assert.equal(second?.positionsBase64, 'wire:m10_00_00_00_098775');
});

test('MapModelLoadCache loadByKey coalesces after hashing and does not cache a missing result', async () => {
  let calls = 0;
  const cache = new MapModelLoadCache(async () => {
    calls += 1;
    return calls === 1 ? null : mesh;
  });
  const key = resourceKey();
  const [first, second] = await Promise.all([
    cache.loadByKey(key, 'm000010'),
    cache.loadByKey({ ...key }, 'm000010')
  ]);
  assert.equal(first, null);
  assert.equal(second, null);
  assert.equal(calls, 1);
  assert.equal(await cache.loadByKey(key, 'm000010'), null);
  assert.equal(calls, 2);
  assert.equal(await cache.loadByKey(key, 'm000010'), null);
  assert.equal(calls, 2);
});

test('MapModelLoadCache loadByKey snapshots the typed key before async hashing', async () => {
  const key = resourceKey();
  const expectedSha = await canonicalResourceCacheKeySha256(key);
  const cache = new MapModelLoadCache(async () => mesh);
  const pending = cache.loadByKey(key, 'm000010');
  key.modelLocalTransformSha256 = 'mutated-after-call';
  await pending;
  const manifests = (cache as unknown as {
    resolvedManifests: Map<string, { cacheKey: ResourceCacheKeyV1; resourceCacheKeySha256: string }>;
  }).resolvedManifests;
  const manifest = [...manifests.values()][0];
  assert.ok(manifest);
  assert.equal(manifest.cacheKey.modelLocalTransformSha256, 'transform');
  assert.equal(manifest.resourceCacheKeySha256, expectedSha);
});

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

test('MapModelLoadCache markUploaded keeps another model identity independent', async () => {
  const geometries = new Map<string, typeof mesh>();
  const cache = new MapModelLoadCache(async (modelName) => {
    const geometry = { positionsBase64: `wire:${modelName}`, vertexCount: 1 };
    geometries.set(modelName, geometry);
    return geometry;
  });
  const [first, second] = await Promise.all([
    cache.load('m10_00_00_00_042260'),
    cache.load('m10_00_00_00_098775')
  ]);
  assert.equal(cache.markUploaded('m10_00_00_00_042260', first!), true);
  assert.equal(cache.isUploaded('m10_00_00_00_042260'), true);
  assert.equal(cache.isUploaded('m10_00_00_00_098775'), false);
  assert.equal(cache.markUploaded('m10_00_00_00_098775', second!), true);
  assert.equal(geometries.size, 2);
});

test('MapModelLoadCache releases a committed envelope and keeps selected loads visible-only', async () => {
  let calls = 0;
  const first = { positionsBase64: 'AAAA', vertexCount: 1 };
  const cache = new MapModelLoadCache(async () => {
    calls += 1;
    return first;
  });
  const loaded = await cache.load('m000010');
  assert.equal(loaded, first);
  assert.deepEqual(cache.getRetentionStats(), {
    preparedEnvelopeCount: 1,
    inFlightCount: 0,
    legacyInFlightCount: 0,
    uploadedCount: 0
  });
  assert.equal(cache.markUploaded('m000010', loaded!), true);
  assert.equal(cache.isUploaded('m000010'), true);
  assert.deepEqual(cache.getRetentionStats(), {
    preparedEnvelopeCount: 0,
    inFlightCount: 0,
    legacyInFlightCount: 0,
    uploadedCount: 1
  });
  assert.equal(await cache.load('m000010'), null);
  assert.equal(calls, 1);
});

test('MapModelLoadCache failed and released envelopes remain retryable', async () => {
  let calls = 0;
  const second = { positionsBase64: 'BBBB', vertexCount: 1 };
  const cache = new MapModelLoadCache(async () => {
    calls += 1;
    if (calls === 1) throw new Error('synthetic loader failure');
    return second;
  });
  await assert.rejects(cache.load('m000010'), /synthetic loader failure/);
  assert.deepEqual(cache.getRetentionStats(), {
    preparedEnvelopeCount: 0,
    inFlightCount: 0,
    legacyInFlightCount: 0,
    uploadedCount: 0
  });
  const loaded = await cache.load('m000010');
  assert.equal(loaded, second);
  assert.equal(cache.getRetentionStats().preparedEnvelopeCount, 1);
  cache.release('m000010', loaded!);
  assert.equal(cache.getRetentionStats().preparedEnvelopeCount, 0);
  assert.equal(await cache.load('m000010'), second);
  assert.equal(calls, 3);
});

test('MapModelLoadCache does not permanently cache an empty legacy result', async () => {
  let calls = 0;
  const second = { positionsBase64: 'BBBB', vertexCount: 1 };
  const cache = new MapModelLoadCache(async () => {
    calls += 1;
    return calls === 1 ? null : second;
  });
  assert.equal(await cache.load('m000010'), null);
  assert.equal(await cache.load('m000010'), second);
  assert.equal(calls, 2);
});

test('MapModelLoadCache dispose rejects a late old result without affecting a new cache', async () => {
  const oldGeometry = { positionsBase64: 'OLD', vertexCount: 1 };
  const newGeometry = { positionsBase64: 'NEW', vertexCount: 1 };
  let resolveOld!: (geometry: typeof oldGeometry) => void;
  const oldCache = new MapModelLoadCache(() => new Promise<typeof oldGeometry | null>((resolve) => {
    resolveOld = (geometry) => resolve(geometry);
  }));
  const oldPending = oldCache.load('m000010');
  oldCache.dispose();

  const newCache = new MapModelLoadCache(async () => newGeometry);
  assert.equal(await newCache.load('m000010'), newGeometry);
  resolveOld(oldGeometry);
  await assert.rejects(oldPending, /MAP_MESH_LOAD_CANCELLED/);
  assert.equal(await newCache.load('m000010'), newGeometry);
});

test('MapModelLoadCache identity guards prevent an old generation releasing a newer envelope', async () => {
  const oldGeometry = { positionsBase64: 'AAAA', vertexCount: 1 };
  const newGeometry = { positionsBase64: 'BBBB', vertexCount: 1 };
  let current = oldGeometry;
  const cache = new MapModelLoadCache(async () => current);
  const oldLoaded = await cache.load('m000010');
  cache.release('m000010', oldLoaded!);
  current = newGeometry;
  const freshLoaded = await cache.load('m000010');
  assert.equal(cache.markUploaded('m000010', oldLoaded!), false);
  assert.equal(cache.isUploaded('m000010'), false);
  assert.equal(cache.markUploaded('m000010', freshLoaded!), true);
  assert.equal(cache.isUploaded('m000010'), true);
  cache.dispose();
  assert.deepEqual(cache.getRetentionStats(), {
    preparedEnvelopeCount: 0,
    inFlightCount: 0,
    legacyInFlightCount: 0,
    uploadedCount: 0
  });
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

test('FrameTaskQueue propagates an explicit upload result instead of task execution', async () => {
  const frames: FrameRequestCallback[] = [];
  const queue = new FrameTaskQueue(
    (callback) => { frames.push(callback); return frames.length; },
    () => undefined,
    () => 0,
    5
  );
  const uploaded = queue.enqueue(() => false);
  frames.shift()!(0);
  assert.equal(await uploaded, false);
});

test('MapModelLoadCache exposes dispose instead of converting it to a missing mesh', async () => {
  const cache = new MapModelLoadCache(async () => mesh);
  cache.dispose();
  await assert.rejects(cache.load('m000010'), /MAP_MESH_LOAD_CACHE_DISPOSED/);
});
