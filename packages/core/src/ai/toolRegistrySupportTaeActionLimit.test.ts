import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TAE_IDENTITY_PROJECTION_VERSION, type RagChunk } from '@soulforge/shared';
import { createRagCorpus } from '../rag/chunkBuilder.js';
import { ragSearchFallback } from './toolRegistrySupport.js';

const workspaceId = 'tae-rag-action-limit';
const sourceUri = 'file://chr/c0000.anibnd.dcx';

function event(action: string, index: number, text: string, count?: number): RagChunk {
  const symbolUri = `action://c0000/entry/2/${action}/e${index}`;
  return {
    chunkId: `rag:tae_event:v${TAE_IDENTITY_PROJECTION_VERSION}:${action}:${index}`,
    workspaceId, sourceUri, symbolUri, family: 'tae_event',
    title: text, body: text, numericIds: [], contentHash: `${action}:${index}:${text}`,
    ...(count === undefined ? {} : { taeActionEventCount: count, taeActionEventsComplete: true })
  };
}

async function search(chunks: RagChunk[], limit: number) {
  const rag = createRagCorpus({ workspaceId, builtAt: '2026-10-03T00:00:00Z', chunks });
  const result = await ragSearchFallback({ workspaceIndex: null, mode: 'plan', rag },
    'needle', ['tae_event'], limit, 'search_tae_events');
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data as {
    totalHits: number;
    hits: Array<{ address: string; sourceUri: string; events: RagChunk[]; eventsComplete: boolean;
      pagination: { totalCount: number | null; returnedCount: number; hasMore: boolean } }>;
  };
}

test('TAE RAG limit counts actions before repeated matching events consume the budget', async () => {
  const chunks = [event('A0010', 0, 'needle'), event('A0010', 1, 'needle'),
    event('A0020', 0, 'lower-ranked needle')];
  const result = await search(chunks, 2);
  assert.equal(result.totalHits, 2);
  assert.deepEqual(result.hits.map(hit => hit.address),
    ['action://c0000/entry/2/A0010', 'action://c0000/entry/2/A0020']);
});

test('TAE RAG duplicate events beyond the retrieval cap do not hide another action', async () => {
  const chunks = Array.from({ length: 40 }, (_, index) => event('A0010', index, 'needle', 40));
  chunks.push(event('A0020', 0, 'lower-ranked needle', 1));
  const result = await search(chunks, 2);
  assert.equal(result.totalHits, 2);
  assert.equal(result.hits[0]?.eventsComplete, true);
  assert.equal(result.hits[0]?.pagination.totalCount, 40);
  assert.equal(result.hits[0]?.pagination.returnedCount, 16);
  assert.equal(result.hits[0]?.pagination.hasMore, true);
  assert.deepEqual(result.hits[0]?.events.map(chunk => Number(/\/e(\d+)$/.exec(chunk.symbolUri)?.[1])),
    Array.from({ length: 16 }, (_, index) => index));
});

test('TAE RAG action grouping keeps source identity, siblings and unknown native counts', async () => {
  const otherSource = { ...event('A0010', 0, 'needle'), chunkId: `rag:tae_event:v${TAE_IDENTITY_PROJECTION_VERSION}:other-source`,
    sourceUri: 'file://chr/c0001.anibnd.dcx' };
  const result = await search([event('A0010', 2, 'needle'), event('A0010', 0, 'sibling'), otherSource], 2);
  assert.equal(result.totalHits, 2);
  assert.equal(new Set(result.hits.map(hit => hit.sourceUri)).size, 2);
  const action = result.hits.find(hit => hit.sourceUri === sourceUri)!;
  assert.deepEqual(action.events.map(chunk => chunk.symbolUri),
    ['action://c0000/entry/2/A0010/e0', 'action://c0000/entry/2/A0010/e2']);
  assert.equal(action.eventsComplete, false);
  assert.equal(action.pagination.totalCount, null);
  assert.equal(action.pagination.hasMore, true);
});

test('TAE RAG grouped search never admits stale or other-workspace event text', async () => {
  const stale = Object.assign(event('A0010', 1, 'needle'), { stale: true });
  const foreign = { ...event('A0030', 0, 'needle'), workspaceId: 'other-workspace' };
  const result = await search([event('A0010', 0, 'unmatched sibling'), stale, foreign,
    event('A0020', 0, 'needle')], 2);
  assert.equal(result.totalHits, 1);
  assert.equal(result.hits[0]?.address, 'action://c0000/entry/2/A0020');
});
