// Actual refresh application functions, canonical corpus/delta/refresh helpers
// and controlled async host ports. No provider, Electron, native or game input.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { WorkspaceIndex } from '../packages/core/dist/indexing/workspaceIndex.js';
import * as corpusHelpers from '../packages/core/dist/rag/chunkBuilder.js';
import * as deltaHelpers from '../packages/core/dist/rag/persist.js';
import * as refreshHelpers from '../packages/core/dist/indexing/knowledgeRefresh.js';
import { loadSymbolBundleIntoIndex } from '../packages/core/dist/workspace/semanticFileCache.js';
import { isRagChunkDeltaStats } from '../packages/core/dist/storage/workspaceDataRepository.js';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ipcPath = path.join(root, 'apps/desktop/src/main/ipc.ts');
const servicePath = path.join(root, 'apps/desktop/src/main/services/semanticRefreshService.ts');
const sessionA = { meta: { workspaceId: 'owned', game: 'sekiro' }, layers: { overlayRoot: '/owned/A', baseRoot: '/owned/base' } };
const uri = 'file:///owned/common.param';
function file(sourceUri = uri, hash = 'before') {
  return { id: sourceUri, workspaceId: 'owned', sourceUri, sourcePath: 'common.param', game: 'sekiro',
    resourceKind: 'param', parseStatus: 'parsed', diagnostics: [], absolutePath: '/owned/A/common.param',
    relativePath: 'common.param', extension: '.param', compoundExtension: '.param', formatKind: 'param',
    formatLabel: 'PARAM', size: 1, mtimeMs: hash === 'before' ? 1 : 2, sha256: hash };
}
function index(files = [file()]) { const out = new WorkspaceIndex('owned'); out.setFiles(files); return out; }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const plain = value => JSON.parse(JSON.stringify(value));

function harness(options = {}) {
  const calls = [], modules = new Map(), timers = new Map();
  let session = sessionA, sessionId = 'owned-session', generation = 1, catalogRevision = 1, activeIndex = index(), rag = options.rag ?? null, agentActive = false;
  const store = {
    forWorkspace(id) { calls.push(['store', id]); return this; },
    async loadRagChunks() { calls.push(['loadChunks']); return options.loadChunks ? options.loadChunks() : []; },
    async loadReferences() { calls.push(['loadReferences']); return []; },
    async mergeRagChunkDelta(delta) { calls.push(['delta', plain(delta)]); if (options.persist) await options.persist(delta); return null; },
    async replaceReferences(edges) { calls.push(['references', plain(edges)]); }
  };
  const core = { WorkspaceIndex, ...corpusHelpers, ...deltaHelpers, ...refreshHelpers, loadSymbolBundleIntoIndex, isRagChunkDeltaStats,
    scanWorkspace: async input => { calls.push(['scan', input]); return options.scan ? options.scan(input) : { files: [file(uri, 'after')] }; },
    analyzeWorkspace: async input => { calls.push(['analyze', input]); return options.analyze ? options.analyze(input) : { index: index(input.files), parsedFiles: input.files.length, inspectedFiles: 0 }; },
    refreshNativeSemanticSources: async input => { calls.push(['native', input]); return options.native ? options.native(input) : { partialSources: [], failedSources: [], refreshedSources: [uri], diagnostics: [] }; },
    disposeIdleBridgeDaemonPool: async () => { calls.push(['disposeIdle']); return options.disposeIdle ? options.disposeIdle() : { disposedClientCount: 0, activeClientCount: 0 }; }
  };
  const deps = {
    getWorkspaceSession: () => session,
    getActiveWorkspaceSessionIdState: () => sessionId,
    getActiveWorkspaceSessionGenerationState: () => generation,
    getWorkspaceIndexedFilesRevisionState: () => catalogRevision,
    getWorkspaceActiveIndex: () => activeIndex,
    getWorkspaceRag: () => rag,
    applyWorkspaceIndexSnapshot(value) { calls.push(['publishIndex', value]); options.publishIndex?.(value); activeIndex = value; catalogRevision++; },
    applyWorkspaceRag(value) { calls.push(['publishRag', value]); rag = value; },
    getActiveOperationLog: () => options.open ? null : store,
    ensureActiveOperationLog: async captured => { calls.push(['open', captured]); return options.open ? options.open(captured, store) : store; },
    durableStoragePaths: () => ({ stagingRoot: '/owned/staging' }),
    hasActiveAgentRuns: () => agentActive,
    scheduleInternalRagEmbedding: (...args) => calls.push(['embedding', ...args])
  };
  const clock = {
    setTimeout(callback, delay) { const timer = { callback, delay, unref() {} }; timers.set(timer, timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); }
  };
  const silentConsole = { info: (...args) => calls.push(['info', ...args]), warn: (...args) => calls.push(['warn', ...args]), error: (...args) => calls.push(['error', ...args]) };
  function execute(source, filename, extras = {}) {
    const built = ts.transpileModule(source, { fileName: filename, reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
    assert.deepEqual((built.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error), []);
    const exports = {};
    vm.runInNewContext(built.outputText, { exports, module: { exports }, process, Buffer, console: silentConsole,
      AbortController, ...clock, ...extras, require(name) {
        if (name.startsWith('node:')) return require(name);
        if (name === '@soulforge/core') return core;
        if (name === 'electron') throw new Error('refresh application must not import Electron');
        if (name.startsWith('.')) return load(path.resolve(path.dirname(filename), name.replace(/\.js$/u, '.ts')));
        throw new Error(`Unexpected refresh import ${name}`);
      }
    }, { filename });
    return exports;
  }
  function load(filename) { if (modules.has(filename)) return modules.get(filename); const value = execute(fs.readFileSync(filename, 'utf8'), filename); modules.set(filename, value); return value; }
  let service;
  if (fs.existsSync(servicePath)) service = load(servicePath).createSemanticRefreshService(deps);
  else {
    const source = fs.readFileSync(ipcPath, 'utf8'), ast = ts.createSourceFile(ipcPath, source, ts.ScriptTarget.Latest, true);
    const names = ['persistActiveRag', 'throwIfRagRefreshAborted', 'invalidateActiveRagForPostCommit', 'refreshRagAfterScan',
      'refreshRagAfterAnalyze', 'buildRagCorpusForRefresh', 'performActiveIndexSemanticRefresh', 'reportDeferredSemanticRefreshFailure',
      'startSemanticRefresh', 'scheduleSemanticRefreshWhenIdle', 'refreshActiveIndexAfterSemanticEvidence',
      'refreshActiveIndexAfterNativeWrite', 'mergeKnowledgeInvalidations', 'resolveKnowledgeSourceUris'];
    const fields = ['semanticRefreshInFlight', 'semanticRefreshQueued', 'semanticRefreshSources', 'semanticRefreshSymbols', 'semanticRefreshTimer',
      'SEMANTIC_REFRESH_DEBOUNCE_MS', 'SEMANTIC_REFRESH_IDLE_POLL_MS', 'NATIVE_KNOWLEDGE_REFRESH_DEADLINE_MS'];
    const nodes = ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text)
      || ts.isVariableStatement(n) && n.declarationList.declarations.some(d => fields.includes(d.name.getText(ast))));
    assert.equal(nodes.length, names.length + fields.length, 'exact current root baseline functions/state');
    const ragHelpers = load(path.join(root, 'apps/desktop/src/main/ragRefreshCorpus.ts'));
    const telemetry = load(path.join(root, 'apps/desktop/src/main/semanticRefreshTelemetry.ts'));
    const body = nodes.map(n => n.getText(ast)).join('\n') + '\nexport function controls(){return {refreshActiveIndexAfterSemanticEvidence,refreshActiveIndexAfterNativeWrite};}';
    service = execute(body, ipcPath, { ...deps, ...core, ...ragHelpers, ...telemetry, resolve: path.resolve,
      pathToFileURL: require('node:url').pathToFileURL,
      createPostCommitSemanticAnalysisOptions: load(path.join(root, 'apps/desktop/src/main/postCommitSemanticAnalysis.ts')).createPostCommitSemanticAnalysisOptions,
      persistRagCorpusBySourceDelta: load(path.join(root, 'apps/desktop/src/main/ragPersistence.ts')).persistRagCorpusBySourceDelta,
      utilityLifecycle: { get activeOperationLog() { return deps.getActiveOperationLog(); } }
    }).controls();
  }
  return { service, calls, store, deps, timers,
    get rag() { return rag; }, get activeIndex() { return activeIndex; },
    setAgentActive(value) { agentActive = value; },
    switchOwner({ sameSession = false, sameId = true } = {}) { if (!sameSession) session = { ...sessionA, layers: { overlayRoot: '/owned/B' } }; if (!sameId) sessionId = 'new-session'; generation++; catalogRevision++; activeIndex = index([file(uri, 'new-owner')]); rag = null; },
    replaceCatalog() { activeIndex = index([file(uri, 'new-catalog')]); catalogRevision++; rag = null; },
    fire(delay) { for (const timer of [...timers.values()]) if (timer.delay === delay) { timers.delete(timer); timer.callback(); } }
  };
}

test('semantic refresh is callable below root authority with private per-instance scheduling', () => {
  assert.equal(fs.existsSync(servicePath), true, 'semantic refresh service must exist');
  assert.doesNotMatch(fs.readFileSync(servicePath, 'utf8'), /from ['"]electron|IpcMainInvokeEvent|TrustedIpcHandle|ipcMain/);
  assert.doesNotMatch(fs.readFileSync(ipcPath, 'utf8'), /let semanticRefreshInFlight|async function persistActiveRag|async function refreshActiveIndexAfterNativeWrite/);
});
test('native-read publication uses existing index without scanning or native decoding', async () => {
  const h = harness(); await h.service.refreshActiveIndexAfterSemanticEvidence([uri]);
  assert.equal(h.calls.filter(([name]) => ['scan', 'analyze', 'native'].includes(name)).length, 0);
  assert.equal(h.rag.workspaceId, 'owned'); assert.equal(h.rag.chunks.length, 1);
  assert.equal(h.calls.filter(([name]) => name === 'embedding').length, 1);
});
test('RAG publication and embedding wait for durable source delta', async () => {
  const start = deferred(), wait = deferred(), h = harness({ persist: async () => { start.resolve(); await wait.promise; } });
  const pending = h.service.refreshActiveIndexAfterSemanticEvidence([uri]); await start.promise;
  assert.equal(h.rag, null); assert.equal(h.calls.filter(([name]) => name === 'embedding').length, 0);
  wait.resolve(); await pending; assert.ok(h.rag);
});
test('callbacks during a durable write survive as a second serialized delta batch', async () => {
  const start = deferred(), wait = deferred(); let first = true;
  const h = harness({ persist: async () => { if (first) { first = false; start.resolve(); await wait.promise; } } });
  const pending = h.service.refreshActiveIndexAfterSemanticEvidence([uri]); await start.promise;
  const secondUri = 'file:///owned/second.param'; h.activeIndex.setFiles([file(), file(secondUri)]);
  const second = h.service.refreshActiveIndexAfterSemanticEvidence([secondUri]); wait.resolve(); await Promise.all([pending, second]);
  assert.deepEqual(h.calls.filter(([name]) => name === 'delta').map(([, delta]) => delta.sourceUri), [uri, secondUri]);
});
test('Agent reads coalesce without waiting and keep the existing idle/debounce delays', async () => {
  const h = harness(); h.setAgentActive(true);
  await h.service.refreshActiveIndexAfterSemanticEvidence([uri]); await h.service.refreshActiveIndexAfterSemanticEvidence([uri]);
  assert.deepEqual([...h.timers.values()].map(t => t.delay), [250]); assert.equal(h.calls.length, 0);
  h.fire(250); assert.deepEqual([...h.timers.values()].map(t => t.delay), [250]);
  h.setAgentActive(false); await h.service.refreshActiveIndexAfterSemanticEvidence([uri]);
  assert.equal(h.calls.filter(([name]) => name === 'delta').length, 1); assert.equal(h.timers.size, 0);
});
test('source-delta failure leaves the previous corpus and retry sends the missing rows', async () => {
  let fail = true; const h = harness({ persist: async () => { if (fail) throw new Error('owned delta failed'); } });
  await assert.rejects(h.service.refreshActiveIndexAfterSemanticEvidence([uri]), /owned delta failed/); assert.equal(h.rag, null);
  fail = false; await h.service.refreshActiveIndexAfterSemanticEvidence([uri]);
  assert.equal(h.calls.filter(([name]) => name === 'delta').length, 2); assert.ok(h.rag);
});
test('same-ID activation replacement during utility opening rejects the old deferred candidate', async () => {
  const start = deferred(), wait = deferred(), h = harness({ open: async (_session, store) => { start.resolve(); await wait.promise; return store; } });
  const pending = h.service.refreshActiveIndexAfterSemanticEvidence([uri]); await start.promise; h.switchOwner(); wait.resolve();
  await pending.catch(() => undefined);
  assert.equal(h.calls.filter(([name]) => name === 'delta' || name === 'embedding').length, 0);
  assert.equal(h.rag, null);
});
test('same-object ABA generation during durable loading cannot publish old corpus', async () => {
  const start = deferred(), wait = deferred(), h = harness({ loadChunks: async () => { start.resolve(); await wait.promise; return []; } });
  const pending = h.service.refreshActiveIndexAfterSemanticEvidence([uri]); await start.promise;
  h.switchOwner({ sameSession: true }); wait.resolve(); await pending.catch(() => undefined);
  assert.equal(h.calls.filter(([name]) => name === 'delta' || name === 'embedding').length, 0); assert.equal(h.rag, null);
});
test('replacement between durable batches stops further writes and old RAG publication', async () => {
  const start = deferred(), wait = deferred(), h = harness({ persist: async () => { start.resolve(); await wait.promise; } });
  const pending = h.service.refreshActiveIndexAfterSemanticEvidence([uri]); await start.promise; h.switchOwner(); wait.resolve();
  await assert.rejects(pending, /工作区/); assert.equal(h.rag, null); assert.equal(h.calls.filter(([name]) => name === 'embedding').length, 0);
});
test('postcommit scan/analysis/native read/persistence retain source and staging identities', async () => {
  const h = harness(), carrier = { ok: true, committed: true, opId: 'owned-commit' };
  const result = await h.service.refreshActiveIndexAfterNativeWrite(['/owned/A/common.param'], carrier);
  assert.equal(result.status, 'converged'); assert.equal(carrier.committed, true); assert.equal(carrier.opId, 'owned-commit');
  assert.equal(carrier.knowledgeRefresh.status, 'converged');
  const analysis = h.calls.find(([name]) => name === 'analyze')[1]; assert.equal(analysis.exportNativeCandidateResources, false);
  assert.equal(analysis.exportNativeMsgResources, false); assert.equal(analysis.inspectNativeResources, false);
  const native = h.calls.find(([name]) => name === 'native')[1]; assert.equal(native.workspaceSessionId, 'owned-session');
  assert.equal(native.indexOwnership, 'isolated-candidate'); assert.equal(native.stagingRoot, '/owned/staging');
  assert.deepEqual(plain(native.allowedRoots), ['/owned/A', '/owned/base']); assert.equal(h.timers.size, 0);
});
test('postcommit deadline keeps committed facts and prevents a late projection', async () => {
  const start = deferred(), wait = deferred(), h = harness({ scan: async () => { start.resolve(); await wait.promise; return { files: [file(uri, 'after')] }; } });
  const carrier = { ok: true, committed: true, opId: 'owned-commit' };
  const pending = h.service.refreshActiveIndexAfterNativeWrite([uri], carrier); await start.promise;
  assert.deepEqual([...h.timers.values()].map(t => t.delay), [180_000]); h.fire(180_000);
  const result = await pending; assert.equal(result.status, 'failed'); assert.equal(carrier.committed, true); assert.equal(carrier.knowledgeRefresh.status, 'failed');
  const publicationCount = h.calls.filter(([name]) => name === 'publishIndex' || name === 'publishRag').length;
  wait.resolve(); await new Promise(done => setImmediate(done));
  assert.equal(h.calls.filter(([name]) => name === 'analyze' || name === 'native').length, 0);
  assert.equal(h.calls.filter(([name]) => name === 'publishIndex' || name === 'publishRag').length, publicationCount);
});
test('late postcommit scan after ABA cannot alter the new index or committed receipt', async () => {
  const start = deferred(), wait = deferred(), h = harness({ scan: async () => { start.resolve(); await wait.promise; return { files: [file(uri, 'after')] }; } });
  const carrier = { ok: true, committed: true, opId: 'owned-commit' };
  const pending = h.service.refreshActiveIndexAfterNativeWrite([uri], carrier); await start.promise; h.switchOwner({ sameSession: true });
  const newIndex = h.activeIndex; wait.resolve(); const result = await pending;
  assert.equal(result.status, 'failed'); assert.equal(h.activeIndex, newIndex); assert.equal(carrier.committed, true); assert.equal(carrier.knowledgeRefresh, undefined);
  assert.equal(h.calls.filter(([name]) => name === 'analyze' || name === 'native').length, 0);
});
test('a queued Agent batch expires with its activation rather than adopting replacement index', async () => {
  const h = harness(); h.setAgentActive(true);
  await h.service.refreshActiveIndexAfterSemanticEvidence([uri]); h.switchOwner({ sameSession: true });
  h.setAgentActive(false); h.fire(250); await new Promise(done => setImmediate(done));
  assert.equal(h.calls.filter(([name]) => ['delta', 'embedding', 'publishIndex', 'publishRag'].includes(name)).length, 0);
  assert.equal(h.rag, null); assert.equal(h.timers.size, 0);
});
test('replacement during postcommit analysis stops native dispatch while preserving committed receipt', async () => {
  const start = deferred(), wait = deferred(), h = harness({ analyze: async input => {
    start.resolve(); await wait.promise; return { index: index(input.files), parsedFiles: 1, inspectedFiles: 0 };
  } });
  const carrier = { ok: true, committed: true, opId: 'owned-commit' };
  const pending = h.service.refreshActiveIndexAfterNativeWrite([uri], carrier); await start.promise; h.switchOwner(); wait.resolve();
  assert.equal((await pending).status, 'failed'); assert.equal(carrier.committed, true); assert.equal(carrier.opId, 'owned-commit');
  assert.equal(h.calls.filter(([name]) => name === 'native').length, 0); assert.equal(h.rag, null);
});
test('same-activation catalog replacement during utility opening cannot stamp an old index as current', async () => {
  const start = deferred(), wait = deferred(), h = harness({ open: async (_session, store) => { start.resolve(); await wait.promise; return store; } });
  const pending = h.service.refreshActiveIndexAfterSemanticEvidence([uri]); await start.promise; h.replaceCatalog(); wait.resolve();
  await pending.catch(() => undefined); assert.equal(h.calls.filter(([name]) => name === 'delta' || name === 'embedding').length, 0); assert.equal(h.rag, null);
});
test('same-activation catalog replacement during durable loading cannot publish the old source hash', async () => {
  const start = deferred(), wait = deferred(), h = harness({ loadChunks: async () => { start.resolve(); await wait.promise; return []; } });
  const pending = h.service.refreshActiveIndexAfterSemanticEvidence([uri]); await start.promise; h.replaceCatalog(); wait.resolve();
  await pending.catch(() => undefined); assert.equal(h.calls.filter(([name]) => name === 'delta' || name === 'embedding').length, 0); assert.equal(h.rag, null);
});
test('an expired queued batch does not leave the in-flight latch stuck for the new activation', async () => {
  const h = harness(); h.setAgentActive(true); await h.service.refreshActiveIndexAfterSemanticEvidence([uri]);
  h.switchOwner(); h.setAgentActive(false); h.fire(250); await new Promise(done => setImmediate(done));
  await h.service.refreshActiveIndexAfterSemanticEvidence([uri]);
  assert.equal(h.calls.filter(([name]) => name === 'delta').length, 1); assert.equal(h.rag.chunks[0].outerFileHash, 'new-owner');
});
test('independent refresh instances retain separate Agent queues and projection ports', async () => {
  const first = harness(), second = harness(); first.setAgentActive(true);
  await first.service.refreshActiveIndexAfterSemanticEvidence([uri]); await second.service.refreshActiveIndexAfterSemanticEvidence([uri]);
  assert.equal(first.calls.length, 0); assert.equal(first.rag, null); assert.equal(first.timers.size, 1); assert.ok(second.rag);
  first.setAgentActive(false); await first.service.refreshActiveIndexAfterSemanticEvidence([uri]); assert.ok(first.rag);
  assert.notEqual(first.rag, second.rag);
});
test('pending refresh captures the original host port functions without freezing live session state', async () => {
  const start = deferred(), wait = deferred(), h = harness({ persist: async () => { start.resolve(); await wait.promise; } });
  const pending = h.service.refreshActiveIndexAfterSemanticEvidence([uri]); await start.promise;
  h.deps.applyWorkspaceRag = () => { throw new Error('replacement host port used'); };
  h.deps.getWorkspaceSession = () => null; wait.resolve(); await pending; assert.ok(h.rag);
});
test('partial native coverage remains partial and failed native coverage never claims convergence', async () => {
  for (const failure of [false, true]) {
    const h = harness({ native: async () => ({ partialSources: failure ? [] : [uri], failedSources: failure ? [uri] : [],
      refreshedSources: [], diagnostics: [{ code: 'OWNED_NATIVE_GAP', message: 'owned native gap' }] }) });
    const carrier = { ok: true, committed: true, opId: 'owned-commit' };
    const result = await h.service.refreshActiveIndexAfterNativeWrite([uri], carrier);
    assert.equal(result.status, failure ? 'failed' : 'partial'); assert.equal(carrier.knowledgeRefresh.status, result.status);
    assert.equal(carrier.committed, true); assert.equal(carrier.opId, 'owned-commit');
    assert.equal(h.calls.filter(([name]) => name === 'native').length, 1);
  }
});
test('postcommit catalog replacement during analysis prevents native work and old index publication', async () => {
  const start = deferred(), wait = deferred(), h = harness({ analyze: async input => {
    start.resolve(); await wait.promise; return { index: index(input.files), parsedFiles: 1, inspectedFiles: 0 };
  } });
  const carrier = { ok: true, committed: true, opId: 'owned-commit' };
  const pending = h.service.refreshActiveIndexAfterNativeWrite([uri], carrier); await start.promise; h.replaceCatalog();
  const replacement = h.activeIndex; wait.resolve(); assert.equal((await pending).status, 'failed');
  assert.equal(h.calls.filter(([name]) => name === 'native').length, 0); assert.equal(h.activeIndex, replacement); assert.equal(carrier.committed, true);
});
test('the existing postcommit deadline covers pending idle Bridge cleanup and cancels its late continuation', async () => {
  const start = deferred(), wait = deferred(), h = harness({ disposeIdle: async () => {
    start.resolve(); await wait.promise; return { disposedClientCount: 1, activeClientCount: 0 };
  } });
  const carrier = { ok: true, committed: true, opId: 'owned-commit' };
  const pending = h.service.refreshActiveIndexAfterNativeWrite([uri], carrier);
  let settled = false; const observed = pending.then(value => { settled = true; return value; });
  await start.promise; assert.deepEqual([...h.timers.values()].map(t => t.delay), [180_000]);
  h.fire(180_000); await new Promise(done => setImmediate(done)); const deadlineSettled = settled;
  wait.resolve(); const result = await observed; await new Promise(done => setImmediate(done));
  assert.equal(deadlineSettled, true, 'pending cleanup must not postpone the original 180s terminal result');
  assert.equal(result.status, 'failed'); assert.equal(carrier.committed, true); assert.equal(carrier.opId, 'owned-commit');
  assert.equal(carrier.knowledgeRefresh.status, 'failed');
  assert.equal(h.calls.filter(([name]) => ['scan', 'analyze', 'native', 'delta', 'embedding'].includes(name)).length, 0);
});
test('ordinary idle cleanup rejection remains nonfatal to the one committed refresh', async () => {
  const h = harness({ disposeIdle: async () => { throw new Error('owned idle cleanup failure'); } });
  const carrier = { ok: true, committed: true, opId: 'owned-commit' };
  assert.equal((await h.service.refreshActiveIndexAfterNativeWrite([uri], carrier)).status, 'converged');
  assert.equal(h.calls.filter(([name]) => name === 'warn').length, 1);
  assert.equal(h.calls.filter(([name]) => name === 'disposeIdle' || name === 'scan' || name === 'native').length, 3);
  assert.equal(carrier.committed, true); assert.equal(carrier.opId, 'owned-commit'); assert.equal(h.timers.size, 0);
});
test('replacement while idle cleanup is pending cancels old projection without replaying committed work', async () => {
  const start = deferred(), wait = deferred(), h = harness({ disposeIdle: async () => {
    start.resolve(); await wait.promise; return { disposedClientCount: 0, activeClientCount: 0 };
  } });
  const carrier = { ok: true, committed: true, opId: 'owned-commit' };
  const pending = h.service.refreshActiveIndexAfterNativeWrite([uri], carrier); await start.promise; h.switchOwner({ sameSession: true });
  const replacement = h.activeIndex; wait.resolve(); assert.equal((await pending).status, 'failed');
  assert.equal(h.activeIndex, replacement); assert.equal(carrier.committed, true); assert.equal(carrier.opId, 'owned-commit');
  assert.equal(carrier.knowledgeRefresh, undefined); assert.equal(h.calls.filter(([name]) => name === 'disposeIdle').length, 1);
  assert.equal(h.calls.filter(([name]) => ['scan', 'analyze', 'native', 'delta', 'embedding'].includes(name)).length, 0);
});
test('synchronous postcommit publication failure preserves the error and receipt without leaking a deadline', async () => {
  const sentinel = new Error('owned synchronous index publication failed');
  const h = harness({ publishIndex: () => { throw sentinel; } }), carrier = { ok: true, committed: true, opId: 'owned-commit' };
  await assert.rejects(h.service.refreshActiveIndexAfterNativeWrite([uri], carrier), error => error === sentinel);
  assert.equal(carrier.committed, true); assert.equal(carrier.opId, 'owned-commit'); assert.equal(carrier.knowledgeRefresh, undefined);
  assert.equal(h.timers.size, 0, 'setup rejection must clear the original deadline timer');
  h.fire(180_000); await new Promise(done => setImmediate(done));
  assert.equal(h.calls.filter(([name]) => ['disposeIdle', 'scan', 'analyze', 'native', 'delta', 'embedding'].includes(name)).length, 0);
});
