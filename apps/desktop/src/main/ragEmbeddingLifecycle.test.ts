import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import type { RagCorpus } from '@soulforge/shared';
import { InternalRagEmbeddingService, INTERNAL_RAG_EMBEDDING, type RagEmbeddingRecord } from './ragEmbedding.js';
import type { RagLocalModelResolution } from './ragLocalModel.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(done => setImmediate(done));
function corpus(key = 'cached'): RagCorpus {
  return { workspaceId: 'owned', builtAt: 'owned', availability: 'available', references: [], diagnostics: [],
    stats: { total: 1, byFamily: { file: 0, event: 0, map_entity: 0, map_region: 0, param_row: 1, text_entry: 0, tae_event: 0 } },
    chunks: [{ chunkId: key, workspaceId: 'owned', sourceUri: 'fixture://owned', symbolUri: 'fixture://owned/row',
      family: 'param_row', title: 'owned', body: 'owned', numericIds: [], contentHash: key }] };
}
function records(key = 'cached'): RagEmbeddingRecord[] {
  return [{ chunkId: key, model: INTERNAL_RAG_EMBEDDING.id, contentHash: key, vector: new Float32Array(512) },
    { chunkId: 'stale', model: 'old', contentHash: 'old', vector: new Float32Array() }];
}
async function fixture(run: (service: InternalRagEmbeddingService) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'sf-embedding-lifecycle-'));
  const service = new InternalRagEmbeddingService(root, (): RagLocalModelResolution => ({ state: 'local-ready',
    modelId: INTERNAL_RAG_EMBEDDING.id, revision: INTERNAL_RAG_EMBEDDING.revision, dimension: INTERNAL_RAG_EMBEDDING.dim }));
  // Every vector is supplied by the owned in-memory store. A model/worker is
  // forbidden even if a future implementation accidentally misses that reuse.
  Reflect.set(service, 'ensureWorker', () => { assert.fail('worker/model creation is forbidden'); });
  try { await run(service); }
  finally {
    await service.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
}

test('embedding close drains a pending load and cannot delete stale rows or republish after cancellation', async () => {
  await fixture(async service => {
    const start = deferred(), wait = deferred(), writes: unknown[] = [];
    const value = corpus();
    const job = service.ensure(value, { loadRagEmbeddingRecords: async () => { start.resolve(); await wait.promise; return records(); },
      mergeRagEmbeddings: async input => { writes.push(input); } });
    await start.promise; let closed = false;
    const closing = service.close().then(() => { closed = true; });
    try { await tick(); assert.equal(closed, false, 'close must wait for real work, not erase its handle'); }
    finally { wait.resolve(); await job; await closing; }
    assert.deepEqual(writes, []);
    assert.equal((await job).ok, false);
    assert.equal(service.getCachedVectors(value), null);
  });
});

test('embedding close retains all superseded jobs until their real tails settle', async () => {
  await fixture(async service => {
    const starts = [deferred(), deferred()], waits = [deferred(), deferred()], writes: unknown[] = [];
    const jobs: ReturnType<typeof service.ensure>[] = [];
    for (let i = 0; i < starts.length; i++) {
      jobs.push(service.ensure(corpus(String(i)), {
        loadRagEmbeddingRecords: async () => { starts[i]!.resolve(); await waits[i]!.promise; return records(String(i)); },
        mergeRagEmbeddings: async input => { writes.push(input); }
      }));
      await starts[i]!.promise;
    }
    let closed = false; const closing = service.close().then(() => { closed = true; });
    try {
      waits[1]!.resolve(); await jobs[1]; await tick();
      assert.equal(closed, false, 'the older, superseded store request still owns work');
    } finally { for (const wait of waits) wait.resolve(); await Promise.all(jobs); await closing; }
    assert.deepEqual(writes, []);
  });
});

test('embedding close drains an already admitted write without publishing it as a completed corpus', async () => {
  await fixture(async service => {
    const start = deferred(), wait = deferred(); let writes = 0;
    const value = corpus();
    const job = service.ensure(value, { loadRagEmbeddingRecords: async () => records(),
      mergeRagEmbeddings: async () => { writes++; start.resolve(); await wait.promise; } });
    await start.promise; let closed = false;
    const closing = service.close().then(() => { closed = true; });
    try { await tick(); assert.equal(closed, false); }
    finally { wait.resolve(); await job; await closing; }
    assert.equal(writes, 1, 'an admitted write is not replayed or falsely rolled back');
    assert.equal((await job).ok, false); assert.equal(service.getCachedVectors(value), null);
  });
});

test('embedding reset is reusable but final dispose rejects all later producers', async () => {
  await fixture(async service => {
    const value = corpus(); let loads = 0;
    const store = { loadRagEmbeddingRecords: async () => { loads++; return records(); }, mergeRagEmbeddings: async () => {} };
    assert.equal((await service.ensure(value, store)).ok, true);
    await service.close(); assert.equal(service.getCachedVectors(value), null);
    assert.equal((await service.ensure(value, store)).ok, true);
    const disposal = service.dispose(); assert.equal(service.dispose(), disposal);
    await disposal;
    const previous = loads;
    assert.equal((await service.ensure(value, store)).ok, false);
    service.schedule(value, store);
    assert.equal(await service.embedQuery('owned'), null);
    await tick(); assert.equal(loads, previous);
  });
});

test('pre-cancelled embedding admission does not probe a model or touch the database', async () => {
  await fixture(async service => {
    Reflect.set(service, 'getLocalModelStatus', () => assert.fail('cancelled admission must not probe the model'));
    const controller = new AbortController(); controller.abort();
    const result = await service.ensure(corpus(), {
      loadRagEmbeddingRecords: async () => assert.fail('cancelled admission must not load records'),
      mergeRagEmbeddings: async () => assert.fail('cancelled admission must not persist')
    }, controller.signal);
    assert.equal(result.ok, false);
  });
});

test('closing rejects ensure and scheduled admission until all old real work has drained', async () => {
  await fixture(async service => {
    const start = deferred(), wait = deferred();
    const job = service.ensure(corpus('old'), { loadRagEmbeddingRecords: async () => {
      start.resolve(); await wait.promise; return records('old');
    }, mergeRagEmbeddings: async () => assert.fail('cancelled old job must not persist') });
    await start.promise; const closing = service.close(); assert.equal(service.close(), closing);
    const rejectedStore = { loadRagEmbeddingRecords: async () => assert.fail('no load while closing'),
      mergeRagEmbeddings: async () => assert.fail('no write while closing') };
    try {
      assert.equal((await service.ensure(corpus('late'), rejectedStore)).ok, false);
      service.schedule(corpus('late'), rejectedStore);
      assert.equal(await service.embedQuery('late'), null);
      assert.equal(Reflect.get(service, 'scheduleTimer'), null);
    } finally { wait.resolve(); await job; await closing; }
    const value = corpus('new');
    assert.equal((await service.ensure(value, { loadRagEmbeddingRecords: async () => records('new'), mergeRagEmbeddings: async () => {} })).ok, true);
    await tick(); assert.notEqual(service.getCachedVectors(value), null, 'old finally cannot clear a new generation');
  });
});
