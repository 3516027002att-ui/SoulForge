import assert from 'node:assert/strict';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import type { RagChunk, ReferenceEdge } from '@soulforge/shared';
import { buildRagCorpus, createRagCorpus } from '../rag/chunkBuilder.js';
import { attachLookupIndexAsync, buildLookupIndex, DEFAULT_RAG_LOOKUP_BUILD_TIMEOUT_MS, ensureLookupIndex, getLookupIndex } from '../rag/lookupIndex.js';
import { retrieveEvidence } from '../rag/retrieve.js';
import { compareCodePointText } from '../rag/topK.js';
import { createDefaultToolRegistry } from '../ai/toolRegistry.js';

const chunks: RagChunk[] = Array.from({ length: 2048 }, (_, i) => ({
  chunkId: `chunk-${i}`, workspaceId: 'async-lookup', sourceUri: 'file://map/example.msb',
  symbolUri: `map://example#${i}`, family: 'map_entity', title: `c1050 m11_01_00_00#${i}`,
  body: `苇名城 武士 ${i} target`, numericIds: [i], contentHash: `hash-${i}`,
  outerFileHash: 'outer', sourceHash: 'leaf', sourceRevision: 1
}));
const references: ReferenceEdge[] = chunks.slice(1).map((chunk) => ({
  fromUri: chunks[0]!.symbolUri, toUri: chunk.symbolUri, kind: 'references_text', confidence: 'high',
  reason: 'synthetic relation', evidence: []
}));
const referencesOnlyIndex = {
  workspaceId: 'reference-omission',
  getFiles: () => [],
  toSymbolBundle: () => ({}),
  listReferences: () => [references[0]!]
} as unknown as Parameters<typeof buildRagCorpus>[0];
const deferredWithoutReferences = buildRagCorpus(
  referencesOnlyIndex,
  'reference-omission',
  undefined,
  [references[0]!.fromUri],
  undefined,
  { lookupIndex: 'deferred', includeReferences: false }
);
assert.equal(deferredWithoutReferences.references.length, 0, 'source-scoped RAG candidates can omit the full reference graph when the caller supplies final references separately');
const defaultReferences = buildRagCorpus(
  referencesOnlyIndex,
  'reference-omission',
  undefined,
  [references[0]!.fromUri],
  undefined,
  { lookupIndex: 'deferred' }
);
assert.equal(defaultReferences.references.length, 1, 'reference omission remains opt-in');
const make = () => createRagCorpus({ workspaceId: 'async-lookup', builtAt: 'test', chunks, references, lookupIndex: 'deferred' });
const corpus = make();
assert.equal(DEFAULT_RAG_LOOKUP_BUILD_TIMEOUT_MS, 600_000, 'large workspace lookup indexing must allow ten minutes before timing out');
let yields = 0;
const progress: number[] = [];
const indexed = await attachLookupIndexAsync(corpus, {
  batchSize: 32,
  yieldControl: async () => { yields++; assert.equal(getLookupIndex(corpus), undefined); await yieldTurn(); },
  onProgress: (value) => progress.push(value.completed)
});
assert.ok(yields > 1, 'construction must yield before completing, not defer the work to retrieval');
assert.deepEqual(indexed, buildLookupIndex(chunks, references));
assert.equal(ensureLookupIndex(corpus), indexed, 'first retrieval reuses the prepared index');
assert.equal(getLookupIndex(corpus), indexed);
const yieldsAfterInitialBuild = yields;
const repeated = await attachLookupIndexAsync(corpus, {
  batchSize: 32,
  yieldControl: async () => { yields++; await yieldTurn(); }
});
assert.ok(repeated === indexed, 'repeated async preparation reuses an unchanged corpus index');
assert.equal(yields, yieldsAfterInitialBuild, 'reusing a prepared lookup must not rebuild its full maps');
assert.ok(progress.length > 1 && progress.every((n, i) => i === 0 || n >= progress[i - 1]!));
assert.deepEqual(retrieveEvidence(corpus, '苇名城 c1050'), retrieveEvidence(createRagCorpus({
  workspaceId: 'async-lookup', builtAt: 'test', chunks, references
}), '苇名城 c1050'));
corpus.references.reverse();
const adjacencySnapshot = indexed.adjacencyEdges;
const referenceSignatureBeforeReorder = indexed.referenceSignature;
assert.equal(ensureLookupIndex(corpus), indexed, 'reference ordering is not a semantic change');
assert.equal(indexed.referenceSignature, referenceSignatureBeforeReorder);
assert.equal(indexed.adjacencyEdges, adjacencySnapshot, 'pure reference reorder must not rebuild adjacency');
corpus.chunks.reverse();
assert.notEqual(ensureLookupIndex(corpus), indexed, 'chunk reordering must invalidate positional maps');

const aborted = make();
const controller = new AbortController();
await assert.rejects(attachLookupIndexAsync(aborted, {
  signal: controller.signal, batchSize: 8,
  yieldControl: async () => { controller.abort(); }
}), { name: 'AbortError' });
assert.equal(getLookupIndex(aborted), undefined, 'cancelled partial maps must not be published');
await assert.rejects(attachLookupIndexAsync(make(), { timeoutMs: 0 }), { name: 'TimeoutError' });

const sharedCorpus = make();
const sharedOptions = { batchSize: 32, yieldControl: async () => { await yieldTurn(); } };
const concurrent = await Promise.all(Array.from({ length: 3 }, () => attachLookupIndexAsync(sharedCorpus, sharedOptions)));
assert.ok(concurrent.every(value => value === concurrent[0]), 'concurrent queries must share one built index');
const waitingCorpus = make(), ownerAbort = new AbortController(), waitingAbort = new AbortController();
const owner = attachLookupIndexAsync(waitingCorpus, { ...sharedOptions, signal: ownerAbort.signal });
const cancelledWaiter = attachLookupIndexAsync(waitingCorpus, { ...sharedOptions, signal: waitingAbort.signal });
waitingAbort.abort();
await assert.rejects(cancelledWaiter, { name: 'AbortError' });
assert.ok(await owner, 'a cancelled waiter must not cancel the active owner');
const retryCorpus = make(), firstAbort = new AbortController();
const first = attachLookupIndexAsync(retryCorpus, { ...sharedOptions, signal: firstAbort.signal });
const surviving = attachLookupIndexAsync(retryCorpus, sharedOptions);
firstAbort.abort();
await assert.rejects(first, { name: 'AbortError' });
assert.equal(await surviving, getLookupIndex(retryCorpus), 'survivor retries after owner cancellation');

// The source arrays are mutable in the workspace pipeline.  Mutating them
// while an async build yields must not publish positional maps for an older
// ordering, and the bounded retry must converge on the final corpus.
const mutationChunks: RagChunk[] = Array.from({ length: 64 }, (_, i) => ({
  ...chunks[i]!, chunkId: `mutation-${i}`, symbolUri: `map://mutation#${i}`,
  numericIds: [10_000 + i]
}));
const mutationCorpus = createRagCorpus({
  workspaceId: 'async-lookup', builtAt: 'mutation-source', chunks: mutationChunks,
  references: [], lookupIndex: 'deferred'
});
let mutationYielded = false;
const asyncMutationIndex = await attachLookupIndexAsync(mutationCorpus, {
  batchSize: 1,
  yieldControl: async () => {
    if (!mutationYielded) {
      mutationYielded = true;
      mutationCorpus.chunks.reverse();
    }
    await yieldTurn();
  }
});
assert.equal(asyncMutationIndex, getLookupIndex(mutationCorpus));
assert.deepEqual(
  collectCandidateIds(mutationCorpus, asyncMutationIndex, 10_000),
  [mutationCorpus.chunks.findIndex((chunk) => chunk.numericIds.includes(10_000))],
  'async index positions must match the final corpus ordering'
);

const mutableEdge = { ...references[0]! };
const mutableCorpus = createRagCorpus({ workspaceId: 'async-lookup', builtAt: 'mutation', chunks, references: [mutableEdge] });
const mutationIndex = ensureLookupIndex(mutableCorpus);
mutableCorpus.references.push(mutableEdge);
assert.equal(ensureLookupIndex(mutableCorpus).adjacency.get(mutableEdge.fromUri)?.length, 2);
const oldTarget = mutableEdge.toUri;
mutableEdge.toUri = chunks[4]!.symbolUri;
assert.equal(ensureLookupIndex(mutableCorpus), mutationIndex);
assert.equal(mutationIndex.adjacency.has(oldTarget), false);
assert.equal(mutationIndex.adjacency.get(mutableEdge.toUri)?.length, 2);

// A legacy/missing-family tool fallback must also yield instead of silently
// rebuilding a large deferred corpus on the first query's synchronous stack.
const fallback = make();
let timerFired = false;
const timer = setTimeout(() => { timerFired = true; }, 0);
const toolResult = await createDefaultToolRegistry().run('retrieve_evidence', { query: '苇名城 c1050' }, {
  workspaceIndex: null, mode: 'plan', rag: fallback
});
clearTimeout(timer);
assert.equal(toolResult.ok, true);
assert.equal(timerFired, true, 'tool fallback must yield before finishing first-query preparation');
assert.ok(getLookupIndex(fallback));

// An index attached before a mutable corpus changed is not a prepared lookup.
// The production tool boundary must detect the stale signature and rebuild it
// asynchronously instead of letting retrieveEvidence rebuild it synchronously.
const staleLookup = createRagCorpus({
  workspaceId: 'async-lookup-stale-index',
  builtAt: 'stale-index',
  chunks: chunks.slice(0, 256)
});
staleLookup.chunks.push({ ...chunks[256]!, chunkId: 'late-marker', symbolUri: 'map://late-marker', body: 'unique late marker' });
let staleLookupYielded = false;
const staleLookupTimer = setTimeout(() => { staleLookupYielded = true; }, 0);
const staleLookupResult = await createDefaultToolRegistry().run('retrieve_evidence', { query: 'late marker' }, {
  workspaceIndex: null,
  mode: 'plan',
  rag: staleLookup
});
clearTimeout(staleLookupTimer);
assert.equal(staleLookupResult.ok, true);
assert.equal(staleLookupYielded, true, 'a stale attached lookup must be rebuilt at the asynchronous preparation boundary');

// A desktop workspace can be remounted while that asynchronous preparation is
// yielding. The result must be discarded instead of escaping from the old RAG.
const switchingWorkspace = createRagCorpus({
  workspaceId: 'async-lookup-switching-workspace',
  builtAt: 'switching-workspace',
  chunks: Array.from({ length: 2048 }, (_, i) => ({
    ...chunks[i]!,
    workspaceId: 'async-lookup-switching-workspace',
    chunkId: `switching-${i}`,
    symbolUri: `map://switching#${i}`,
    body: `workspace candidate ${i}`
  })),
  lookupIndex: 'deferred'
});
let workspaceStillCurrent = true;
const switchTimer = setTimeout(() => { workspaceStillCurrent = false; }, 0);
const switchedResult = await createDefaultToolRegistry().run('retrieve_evidence', { query: 'workspace candidate' }, {
  workspaceIndex: null,
  mode: 'plan',
  rag: switchingWorkspace,
  isWorkspaceContextCurrent: () => workspaceStillCurrent
} as unknown as Parameters<ReturnType<typeof createDefaultToolRegistry>['run']>[2]);
clearTimeout(switchTimer);
assert.equal(switchedResult.ok, false, 'a RAG result from a workspace identity that changed during async preparation must be rejected');
if (!switchedResult.ok) assert.equal(switchedResult.error?.code, 'RAG_CONTEXT_STALE');

const words = ['', 'a', 'a😀', 'a\uE000', '𐀀', '\uFFFF', 'abc', 'ab', '苇名城', '苇名😀'];
const oracle = (a: string, b: string): number => {
  const left = [...a], right = [...b];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const l = left[i]!.codePointAt(0)!, r = right[i]!.codePointAt(0)!;
    if (l !== r) return l < r ? -1 : 1;
  }
  return left.length - right.length;
};
for (const a of words) for (const b of words) assert.equal(Math.sign(compareCodePointText(a, b)), Math.sign(oracle(a, b)));
console.log(JSON.stringify({ ok: true, chunks: chunks.length, references: references.length, yields, tests: ['index equivalence', 'first search prepared', 'stale lookup async rebuild', 'workspace identity after await', 'repeated preparation reuse', 'scoped reference omission', 'invalidation', 'abort', 'timeout', 'unicode order'] }));

function collectCandidateIds(target: ReturnType<typeof make>, lookup: ReturnType<typeof buildLookupIndex>, id: number): number[] {
  return lookup.byNumericId.get(id) ?? [];
}
