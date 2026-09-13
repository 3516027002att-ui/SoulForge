/** Executes exact production functions with controlled async storage/state.
 * This bounded race test is not an Electron/native readiness acceptance test.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { diffRagCorpusBySource, sameRagReferences } from '../packages/core/dist/rag/persist.js';
import { createRagCorpus, mergeCatalogAndPersisted } from '../packages/core/dist/rag/chunkBuilder.js';
import { openWorkspaceDatabase } from '../packages/core/dist/storage/sqliteDatabase.js';
import { WorkspaceDataRepository } from '../packages/core/dist/storage/workspaceDataRepository.js';

function productionFunctions(path, names) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const selected = file.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  assert.equal(selected.length, names.length, 'every tested production function must exist');
  return ts.transpileModule(selected.map(node => node.getText(file).replace(/^export\s+/, '')).join('\n'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
}
const source = productionFunctions('../apps/desktop/src/main/ipc/workspace.ts',
  ['awaitWorkspaceReadiness', 'waitForWorkspaceIndexing', 'persistActiveRag', 'clearWorkspaceIpcCaches']);
const ragPersistenceSource = `const RAG_PERSIST_BATCH_SIZE = 512;\n${productionFunctions('../apps/desktop/src/main/ragPersistence.ts', [
  'persistRagCorpusBySourceDelta',
  'throwIfAborted'
])}`;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const state = {
  activeSession: {}, activeWorkspaceSessionId: 'session-a', activeWorkspaceSessionGeneration: 1,
  activeIndex: { workspaceId: 'workspace-a' }, activeRag: null,
  workspaceAnalysisRequestedGeneration: -1, workspaceSemanticIndexingTask: null,
  workspaceIndexingTask: null, workspaceAnalyzeAbort: null,
  directorySelections: new Map(), actionMembershipForegroundTasks: new Map(),
  scheduleRagEmbedding: null,
  throwIfRagRefreshAborted(signal) { if (signal?.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); },
  resolveWorkspaceSemanticIndexingTask() { state.workspaceSemanticIndexingTask?.resolve(); state.workspaceSemanticIndexingTask = null; },
  async persistRagCorpusBySourceDelta() {},
  diffRagCorpusBySource,
  sameRagReferences
};
let starts = 0;
state.workspaceAnalysisStarter = async () => {
  starts++;
  state.workspaceAnalysisRequestedGeneration = state.activeWorkspaceSessionGeneration;
};
vm.createContext(state);
vm.runInContext(source, state);
vm.runInContext(ragPersistenceSource, state);
const productionPersistRagCorpusBySourceDelta = vm.runInContext('persistRagCorpusBySourceDelta', state);
await state.waitForWorkspaceIndexing();
await state.waitForWorkspaceIndexing();
assert.equal(starts, 1, 'readiness must not relaunch an already attempted generation');
state.activeWorkspaceSessionGeneration = 2;
await state.waitForWorkspaceIndexing();
assert.equal(starts, 2, 'new generation must still auto-start');
const waiting = deferred();
state.workspaceSemanticIndexingTask = waiting;
let settled = false;
const waiter = state.waitForWorkspaceIndexing().then(() => { settled = true; });
await Promise.resolve();
assert.equal(settled, false, 'readiness must wait for durable semantic stage');
waiting.resolve();
await waiter;
state.workspaceSemanticIndexingTask = null;
const cancelledWait = deferred();
state.workspaceSemanticIndexingTask = cancelledWait;
const waiterAbort = new AbortController();
const stopped = state.waitForWorkspaceIndexing(waiterAbort.signal);
waiterAbort.abort();
await assert.rejects(stopped, error => error.name === 'AbortError');
state.workspaceSemanticIndexingTask = null;
cancelledWait.resolve();

const corpus = { workspaceId: 'workspace-a' };
const durable = deferred();
state.persistRagCorpusBySourceDelta = async () => durable.promise;
const publishing = state.persistActiveRag({}, corpus, null);
assert.equal(state.activeRag, null, 'speculative corpus must not publish');
durable.resolve();
await publishing;
assert.equal(state.activeRag, corpus, 'durable corpus publishes');

// The production RAG writer sends one source in bounded 512-row calls.  A
// rejection after batch 1 is a partial durable write, not a publication: the
// active corpus must remain the previous snapshot so the retry still diffs
// and resends batch 1 instead of treating it as already committed.
const makeRagChunk = index => ({
  chunkId: `rag:boundary:${index}`,
  workspaceId: 'workspace-a',
  sourceUri: 'file://synthetic/param/boundary.param',
  symbolUri: `param://Boundary/${index}`,
  family: 'param_row',
  title: `Boundary ${index}`,
  body: `row ${index}`,
  numericIds: [index],
  contentHash: `hash-${index}`,
  sourceHash: 'source-v2',
  sourceRevision: 2
});
const previousBoundary = createRagCorpus({
  workspaceId: 'workspace-a',
  builtAt: 'before',
  chunks: [],
  references: []
});
const nextBoundary = createRagCorpus({
  workspaceId: 'workspace-a',
  builtAt: 'after',
  chunks: Array.from({ length: 513 }, (_, index) => makeRagChunk(index)),
  references: []
});
const flakyBatches = [];
const flakyStore = {
  mergeRagChunkDelta(delta) {
    flakyBatches.push(delta);
    if (flakyBatches.length === 2) throw new Error('synthetic batch 2 rejection');
    return Promise.resolve();
  },
  replaceReferences() { return Promise.resolve(); }
};
state.activeRag = previousBoundary;
state.persistRagCorpusBySourceDelta = (_database, next, previous) => {
  assert.equal(previous, previousBoundary, 'failed refresh must retain the old previous corpus');
  return productionPersistRagCorpusBySourceDelta(flakyStore, next, previous);
};
await assert.rejects(
  state.persistActiveRag({}, nextBoundary, previousBoundary),
  /synthetic batch 2 rejection/
);
assert.equal(state.activeRag, previousBoundary, 'partial batch failure must not publish activeRag');
assert.deepEqual(flakyBatches.map(batch => batch.upserts.length), [512, 1]);

// Abort is observed at the boundary before batch 2.  This does not claim to
// cancel a SQLite call that is already queued; it only proves no later batch
// is submitted and no speculative corpus is published.
const abortBatches = [];
const abortController = new AbortController();
const abortStore = {
  mergeRagChunkDelta(delta) {
    abortBatches.push(delta);
    if (abortBatches.length === 1) abortController.abort();
    return Promise.resolve();
  },
  replaceReferences() { return Promise.resolve(); }
};
state.activeRag = previousBoundary;
state.persistRagCorpusBySourceDelta = (_database, next, previous, signal) => {
  assert.equal(previous, previousBoundary, 'aborted refresh must retain the old previous corpus');
  return productionPersistRagCorpusBySourceDelta(abortStore, next, previous, signal);
};
await assert.rejects(
  state.persistActiveRag({}, nextBoundary, previousBoundary, abortController.signal),
  error => error?.name === 'AbortError'
);
assert.equal(state.activeRag, previousBoundary, 'abort between batches must not publish activeRag');
assert.deepEqual(abortBatches.map(batch => batch.upserts.length), [512]);

// Retry with the same old previous snapshot.  Both batches must be sent
// again; a speculative in-memory publication would incorrectly make this a
// no-op and leave batch 2 missing from SQLite.
const retryBatches = [];
const retryStore = {
  mergeRagChunkDelta(delta) {
    retryBatches.push(delta);
    return Promise.resolve();
  },
  replaceReferences() { return Promise.resolve(); }
};
state.persistRagCorpusBySourceDelta = (_database, next, previous) => {
  assert.equal(previous, previousBoundary, 'retry must still diff against the old snapshot');
  return productionPersistRagCorpusBySourceDelta(retryStore, next, previous);
};
await state.persistActiveRag({}, nextBoundary, previousBoundary);
assert.equal(state.activeRag, nextBoundary, 'only the fully durable retry may publish activeRag');
assert.deepEqual(retryBatches.map(batch => batch.upserts.length), [512, 1]);

// Simulate restart loading a durable old projection beside a current scan:
// mergeCatalogAndPersisted must not reintroduce the old source hash.
const restartSource = 'file://synthetic/event/restart.emevd.dcx';
const currentChunk = {
  ...makeRagChunk(900),
  chunkId: 'rag:event:restart',
  sourceUri: restartSource,
  symbolUri: 'event://restart/1000',
  family: 'event',
  body: 'fresh semantic body',
  sourceHash: 'source-current',
  sourceRevision: 2
};
const staleChunk = { ...currentChunk, body: 'stale persisted body', sourceHash: 'source-old' };
const restarted = mergeCatalogAndPersisted(
  createRagCorpus({ workspaceId: 'workspace-a', builtAt: 'restart', chunks: [currentChunk], references: [] }),
  createRagCorpus({ workspaceId: 'workspace-a', builtAt: 'restart', chunks: [staleChunk], references: [] })
);
assert.equal(restarted.chunks.some(chunk => chunk.body === 'stale persisted body'), false);
assert.equal(restarted.chunks.find(chunk => chunk.chunkId === currentChunk.chunkId)?.body, 'fresh semantic body');

// Exercise the same durable delta shape used by refreshRagAfterAnalyze:
// filter the merge view, but diff against the unfiltered SQLite snapshot so a
// failed PARAM leaf is deleted from both rag_chunks and FTS.  A stage->final
// reuse with identical canonical bodies must then submit no FTS/upsert work.
const deltaRoot = await mkdtemp(join(tmpdir(), 'soulforge-workspace-analysis-delta-'));
const deltaDatabase = openWorkspaceDatabase(join(deltaRoot, 'workspace.db'));
const deltaWorkspaceId = 'workspace-analysis-delta';
const deltaSourceUri = 'file://synthetic/param/gameparam.parambnd.dcx';
const deltaNow = new Date().toISOString();
deltaDatabase.prepare(`
  INSERT INTO workspaces (workspace_id, root_path, game, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?)
`).run(deltaWorkspaceId, deltaRoot, 'sekiro', deltaNow, deltaNow);
const deltaRepository = new WorkspaceDataRepository(deltaDatabase, deltaWorkspaceId);
const durableFailed = { ...makeRagChunk(2001), workspaceId: deltaWorkspaceId, sourceUri: deltaSourceUri, symbolUri: 'param://FailedLeaf/1', body: 'generic failed leaf', contentHash: 'generic-failed' };
const durableGood = { ...makeRagChunk(2002), workspaceId: deltaWorkspaceId, sourceUri: deltaSourceUri, symbolUri: 'param://GoodLeaf/1', body: 'generic good leaf', contentHash: 'generic-good' };
const canonicalGood = { ...durableGood, body: 'native canonical good leaf', contentHash: 'native-good' };
const durableCorpus = createRagCorpus({ workspaceId: deltaWorkspaceId, builtAt: deltaNow, chunks: [durableFailed, durableGood], references: [] });
const stageCorpus = createRagCorpus({ workspaceId: deltaWorkspaceId, builtAt: deltaNow, chunks: [canonicalGood], references: [] });
const mergeView = createRagCorpus({ workspaceId: deltaWorkspaceId, builtAt: deltaNow, chunks: [], references: [] });
const desiredCorpus = mergeCatalogAndPersisted(stageCorpus, mergeView);
deltaRepository.mergeRagChunkDelta({ sourceUri: deltaSourceUri, upserts: [durableFailed, durableGood], deletedChunkIds: [] });
for (const delta of diffRagCorpusBySource(durableCorpus, desiredCorpus)) {
  deltaRepository.mergeRagChunkDelta(delta);
}
assert.equal(deltaRepository.loadRagChunks().some(chunk => chunk.chunkId === durableFailed.chunkId), false, 'failed PARAM leaf must be removed from durable rows');
assert.equal(deltaDatabase.prepare('SELECT 1 AS present FROM rag_chunks_fts WHERE chunk_id = ?').get(durableFailed.chunkId), undefined, 'failed PARAM leaf must be removed from FTS');
assert.equal(deltaRepository.loadRagChunks().find(chunk => chunk.chunkId === canonicalGood.chunkId)?.body, canonicalGood.body);
const stageFinalDeltas = diffRagCorpusBySource(stageCorpus, createRagCorpus({ workspaceId: deltaWorkspaceId, builtAt: new Date().toISOString(), chunks: [canonicalGood], references: [] }));
assert.equal(stageFinalDeltas.reduce((sum, delta) => sum + delta.upserts.length, 0), 0, 'stage->final canonical reuse must not upsert');
assert.equal(stageFinalDeltas.reduce((sum, delta) => sum + delta.deletedChunkIds.length, 0), 0, 'stage->final canonical reuse must not rebuild FTS');
deltaDatabase.close();
await rm(deltaRoot, { recursive: true, force: true });

for (const change of ['session', 'generation', 'workspace', 'cancel']) {
  state.activeWorkspaceSessionId = 'session-a';
  state.activeWorkspaceSessionGeneration = 2;
  state.activeIndex = { workspaceId: 'workspace-a' };
  state.activeRag = null;
  const pending = deferred();
  const controller = new AbortController();
  state.persistRagCorpusBySourceDelta = async () => pending.promise;
  const result = state.persistActiveRag({}, corpus, null, controller.signal);
  if (change === 'session') state.activeWorkspaceSessionId = 'session-b';
  if (change === 'generation') state.activeWorkspaceSessionGeneration++;
  if (change === 'workspace') state.activeIndex = { workspaceId: 'workspace-b' };
  if (change === 'cancel') controller.abort();
  const rejection = assert.rejects(result);
  pending.resolve();
  await rejection;
  assert.equal(state.activeRag, null, `${change} during persistence must reject stale publication`);
}
const controller = new AbortController();
state.workspaceAnalyzeAbort = controller;
state.clearWorkspaceIpcCaches();
assert.equal(controller.signal.aborted, true, 'cache teardown cancels native analysis');
assert.equal(state.workspaceAnalysisRequestedGeneration, -1);
assert.equal(state.workspaceAnalysisStarter, null);
console.log('[workspace-analysis-lifecycle] PASS: generation, readiness, durable publication, switch and abort races');
