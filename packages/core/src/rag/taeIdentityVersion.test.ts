import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RagChunk } from '@soulforge/shared';
import { createRagCorpus } from './chunkBuilder.js';

test('persisted TAE chunks with old parser identity cannot survive an unchanged source hash', () => {
  const base = { workspaceId: 'test', sourceUri: 'file://chr/c0000.anibnd.dcx', symbolUri: 'action://c0000/A0010/e0', title: 'old animation', body: 'old', numericIds: [10], contentHash: 'body-hash', sourceHash: 'same', outerFileHash: 'same', sourceRevision: 1 };
  const legacy: RagChunk = { ...base, family: 'tae_event', chunkId: 'rag:tae_event:old' };
  const current: RagChunk = { ...base, family: 'tae_event', chunkId: 'rag:tae_event:v2:current' };
  const unrelated: RagChunk = { ...base, family: 'event', chunkId: 'rag:event:unrelated' };
  const corpus = createRagCorpus({ workspaceId: 'test', builtAt: 'test', chunks: [legacy, current, unrelated] });
  assert.deepEqual(corpus.chunks.map((chunk) => chunk.chunkId), [current.chunkId, unrelated.chunkId]);
  assert.equal(corpus.stats.total, 2);
});

test('desktop hydrated persistence baseline retains only legacy TAE IDs for deletion', async () => {
  const { diffRagCorpusBySource } = await import('./persist.js');
  const base = { workspaceId: 'test', sourceUri: 'file://chr/c0000.anibnd.dcx', symbolUri: 'action://c0000/A0010/e0', title: 'old', body: 'old', numericIds: [10], contentHash: 'old' };
  const legacy: RagChunk = { ...base, family: 'tae_event', chunkId: 'rag:tae_event:legacy' };
  const unrelated: RagChunk = { ...base, family: 'event', sourceUri: 'file://event/test.emevd', chunkId: 'rag:event:keep' };
  const previous = createRagCorpus({ workspaceId: 'test', builtAt: 'before', chunks: [legacy, unrelated] });
  const next = createRagCorpus({ workspaceId: 'test', builtAt: 'after', chunks: [unrelated] });
  assert.equal(previous.chunks.length, 1, 'stale actions remain hidden from retrieval');
  assert.deepEqual(diffRagCorpusBySource(previous, next).map((delta) => ({ sourceUri: delta.sourceUri, deleted: delta.deletedChunkIds })),
    [{ sourceUri: legacy.sourceUri, deleted: [legacy.chunkId] }]);
});

test('unstamped TAE exports are never promoted to the current identity by RAG generation', async () => {
  const { WorkspaceIndex } = await import('../indexing/workspaceIndex.js');
  const { buildRagCorpus } = await import('./chunkBuilder.js');
  const index = new WorkspaceIndex('identity-producer');
  const source = { chrId: 'c0000', sourceUri: 'file://chr/c0000.tae', animations: [{ animId: 10, code: 'A0010', events: [{ uri: 'action://c0000/A0010/e0', index: 0, eventTypeId: 100, startTime: 0, endTime: 1, startFrame: 0, endFrame: 30 }] }] };
  index.upsertTaeExport(source);
  assert.equal(buildRagCorpus(index).stats.byFamily.tae_event, 0);
  index.upsertTaeExport({ ...source, readerSchemaRevision: 2 });
  assert.equal(buildRagCorpus(index).stats.byFamily.tae_event, 1);
});

test('RAG action fallback preserves native partial totals instead of laundering cached seven events into a complete action', async () => {
  const { WorkspaceIndex } = await import('../indexing/workspaceIndex.js');
  const { buildRagCorpus } = await import('./chunkBuilder.js');
  const { createDefaultToolRegistry } = await import('../ai/toolRegistry.js');
  const producer = new WorkspaceIndex('partial-tae');
  producer.upsertTaeExport({ chrId: 'c0000', sourceUri: 'file://chr/c0000.tae', readerSchemaRevision: 2,
    animations: [{ animId: 400000, code: 'A400000', eventCount: 240, eventsComplete: false,
      events: Array.from({ length: 7 }, (_, index) => ({ uri: `action://c0000/A400000/e${index}`, index, eventTypeId: 9999, typeName: 'Needle', startTime: index, endTime: index + 1, startFrame: index * 30, endFrame: (index + 1) * 30 })) }] });
  const corpus = buildRagCorpus(producer);
  assert.equal(corpus.chunks[0]?.taeActionEventCount, 240);
  assert.equal(corpus.chunks[0]?.taeActionEventsComplete, false);
  const consumer = new WorkspaceIndex('partial-tae');
  const result = await createDefaultToolRegistry().run('search_tae_events', { query: 'Needle' }, {
    workspaceIndex: consumer, mode: 'plan', rag: corpus, ragScope: 'full', ragEpoch: 0,
    workspaceSessionId: 's', ragSessionId: 's', workspaceSessionGeneration: 1, ragGeneration: 1, indexedFilesRevision: 1, ragIndexedFilesRevision: 1 });
  assert.equal(result.ok, true, JSON.stringify(result));
  const data = result.data as any;
  assert.equal(data.source, 'rag-fallback');
  assert.equal(data.hits[0].pagination.totalCount, 240);
  assert.equal(data.hits[0].pagination.hasMore, true);
  assert.equal(data.hits[0].eventsComplete, false);
});
