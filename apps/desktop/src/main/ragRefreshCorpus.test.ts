import assert from 'node:assert/strict';
import { createRagCorpus, type RagChunk, type RagCorpus } from '@soulforge/core';
import type { ReferenceEdge } from '@soulforge/shared';
// @ts-ignore Focused runner reads the built core module directly.
import { getLookupIndex } from '@soulforge/core/dist/rag/lookupIndex.js';
// @ts-ignore The focused runner executes this source file with Node's experimental TypeScript stripping.
import { createInvalidatedRagCorpus, createPostCommitRagCorpus, prepareAgentRagSearchCorpus } from './ragRefreshCorpus.ts';

const workspaceId = 'rag-refresh-regression';
const changedSource = 'file://param/changed.parambnd.dcx#NpcParam';
const stableSource = 'file://param/stable.parambnd.dcx#NpcParam';

const fileChunk = (sourceUri: string, hash: string): RagChunk => ({
  chunkId: `file:${sourceUri}`, workspaceId, sourceUri, symbolUri: sourceUri,
  family: 'file', title: sourceUri, body: 'native file', numericIds: [],
  contentHash: hash, outerFileHash: hash, sourceRevision: 1
});
const paramChunk = (sourceUri: string, rowId: number, hash: string, body: string): RagChunk => ({
  chunkId: `${sourceUri}#${rowId}`, workspaceId, sourceUri,
  symbolUri: `${sourceUri}#${rowId}`, family: 'param_row', title: `NpcParam#${rowId}`,
  body, numericIds: [rowId], contentHash: `${hash}:${rowId}`,
  outerFileHash: hash, sourceRevision: 1
});
const edge = (fromUri: string, toUri: string): ReferenceEdge => ({
  fromUri, toUri, kind: 'references_text', confidence: 'high', reason: 'fixture', evidence: []
});

const oldSourceFile = fileChunk(changedSource, 'old-source-hash');
const newSourceFile = fileChunk(changedSource, 'new-source-hash');
const stableFile = fileChunk(stableSource, 'stable-source-hash');
const current: RagCorpus = createRagCorpus({
  workspaceId,
  builtAt: 'before',
  chunks: [oldSourceFile, stableFile, paramChunk(changedSource, 10, 'old-source-hash', 'old row'), paramChunk(changedSource, 11, 'old-source-hash', 'removed sibling row'), paramChunk(stableSource, 20, 'stable-source-hash', 'stable row')],
  references: [edge(`${stableSource}#20`, 'msg://keep'), edge(`${changedSource}#10`, 'msg://old')],
  lookupIndex: 'deferred'
});
const changedCatalog = createRagCorpus({
  workspaceId,
  builtAt: 'after',
  chunks: [newSourceFile, paramChunk(changedSource, 10, 'new-source-hash', 'fresh row')],
  references: [],
  lookupIndex: 'deferred'
});
const nextReferences = [edge(`${stableSource}#20`, 'msg://keep'), edge(`${changedSource}#10`, 'msg://new')];
const postCommit = createPostCommitRagCorpus({
  current,
  changedCatalog,
  changedSources: [changedSource],
  changedSymbols: [],
  references: nextReferences,
  builtAt: 'after'
});
assert.equal(getLookupIndex(postCommit), undefined, 'post-commit persistence must not eagerly duplicate the full active RAG lookup index');
assert.deepEqual(postCommit.chunks.map((chunk) => chunk.chunkId).sort(), [
  stableFile.chunkId,
  paramChunk(stableSource, 20, 'stable-source-hash', 'stable row').chunkId,
  newSourceFile.chunkId,
  paramChunk(changedSource, 10, 'new-source-hash', 'fresh row').chunkId
].sort(), 'changed-source merge must retain unaffected rows and replace only the changed source');
assert.deepEqual(postCommit.references, nextReferences, 'the new corpus must use the post-refresh reference snapshot');
const postCommitCombined = createPostCommitRagCorpus({
  current,
  changedCatalog,
  changedSources: [changedSource],
  changedSymbols: [`${changedSource}#10`],
  references: nextReferences,
  builtAt: 'after-combined'
});
assert.deepEqual(postCommitCombined.chunks.map((chunk) => chunk.chunkId).sort(), postCommit.chunks.map((chunk) => chunk.chunkId).sort(), 'source and symbol invalidations compose; an absent old sibling must not survive the source refresh');
const symbolDeleted = createPostCommitRagCorpus({
  current,
  changedCatalog: createRagCorpus({ workspaceId, builtAt: 'delete-symbol', chunks: [], lookupIndex: 'deferred' }),
  changedSources: [],
  changedSymbols: [`${changedSource}#10`],
  references: [edge(`${stableSource}#20`, 'msg://keep')],
  builtAt: 'delete-symbol'
});
assert.ok(!symbolDeleted.chunks.some((chunk) => chunk.symbolUri === `${changedSource}#10`), 'a removed symbol must not survive when the changed catalog omits it');
assert.ok(symbolDeleted.chunks.some((chunk) => chunk.symbolUri === `${changedSource}#11`), 'symbol-only refresh preserves unaffected sibling symbols');
const staleSafe = createInvalidatedRagCorpus({ current, invalidatedSources: [changedSource], builtAt: 'invalidated' });
assert.equal(getLookupIndex(staleSafe), undefined, 'source invalidation must release the old full lookup while refresh runs');
assert.deepEqual(staleSafe.chunks.map((chunk) => chunk.chunkId).sort(), [stableFile.chunkId, paramChunk(stableSource, 20, 'stable-source-hash', 'stable row').chunkId].sort());
assert.deepEqual(staleSafe.references, [edge(`${stableSource}#20`, 'msg://keep')], 'stale references from the invalidated source must not escape while refresh is pending');

const activeFile = fileChunk(changedSource, 'new-source-hash');
const activeRag = createRagCorpus({
  workspaceId,
  builtAt: 'search',
  chunks: [activeFile, paramChunk(changedSource, 1, 'new-source-hash', 'current row')],
  references: [],
  lookupIndex: 'deferred'
});
const persistedChunks: RagChunk[] = [fileChunk(changedSource, 'new-source-hash')];
for (let i = 0; i < 4096; i += 1) {
  persistedChunks.push(paramChunk(changedSource, 1000 + i, 'new-source-hash', `苇名城 poison candidate ${i}`));
}
let timerFired = false;
const timer = setTimeout(() => { timerFired = true; }, 0);
const searchable = await prepareAgentRagSearchCorpus({
  workspaceId,
  builtAt: 'search',
  activeRag,
  persistedChunks,
  persistedReferences: [],
});
clearTimeout(timer);
assert.equal(timerFired, true, 'Agent RAG fallback must yield while preparing the lookup instead of synchronously building it on the main stack');
assert.ok(getLookupIndex(searchable), 'the async Agent fallback must attach one complete lookup before retrieving evidence');
assert.equal(searchable.chunks.length, persistedChunks.length + 1, 'current live symbols must remain searchable alongside durable gaps');

const completeActive = createRagCorpus({
  workspaceId,
  builtAt: 'complete',
  chunks: [activeFile, paramChunk(changedSource, 1, 'new-source-hash', 'current row')],
  references: [edge(`${changedSource}#1`, 'msg://complete')]
});
const completeIndex = getLookupIndex(completeActive);
const reused = await prepareAgentRagSearchCorpus({
  workspaceId,
  builtAt: 'complete',
  activeRag: completeActive,
  persistedChunks: completeActive.chunks.map((chunk) => ({ ...chunk })),
  persistedReferences: completeActive.references.map((reference) => ({ ...reference }))
});
assert.ok(reused === completeActive, 'an unchanged durable merge reuses the active full-workspace lookup rather than building a duplicate');
assert.ok(getLookupIndex(reused) === completeIndex, 'the reused corpus keeps the already validated lookup snapshot');

console.log('ragRefreshCorpus: PASS (deferred post-commit corpus, async Agent fallback)');
