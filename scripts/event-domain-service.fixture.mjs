// Actual EVENT adapter and application methods; only native/worker/commit ports
// are replaced. No Electron process, Bridge process, provider or game data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adapterPath = path.join(root, 'apps/desktop/src/main/ipc/event.ts');
const servicePath = path.join(root, 'apps/desktop/src/main/services/eventService.ts');
const channels = ['resource.readEmevdDocument', 'resource.applyEmevdMutation', 'resource.cancelEmevdFullDocument',
  'resource.readEmevdSourceSlice', 'resource.readEmevdFullDocument', 'resource.readEmedfCompletionCatalog', 'resource.submitEmevdDslPlan'];
const uri = 'resource://owned/event';
const hash = 'a'.repeat(64), outerHash = 'b'.repeat(64);
const session = { meta: { workspaceId: 'owned', game: 'sekiro' }, layers: { overlayRoot: '/owned/mod', baseRoot: '/owned/base' } };
const file = { sourceUri: uri, absolutePath: '/owned/mod/common.emevd.dcx', relativePath: 'event/common.emevd.dcx', game: 'sekiro', sha256: outerHash };
const plain = value => JSON.parse(JSON.stringify(value));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

function harness(options = {}) {
  const calls = [], modules = new Map(), handlers = new Map();
  let activeSession = options.session === undefined ? session : options.session;
  let files = options.files ?? [file];
  const fullResult = input => ({ ok: true, diagnostics: [], sourceHash: hash, outerFileHash: outerHash,
    instructionTotal: 1, outline: [{ id: 1 }], authority: 'native', sourceFormat: 'DCX',
    document: { revision: 1, documentInstanceId: input.documentInstanceId ?? input.filePath,
      events: [{ instructions: [{}] }], marker: input.filePath } });
  const core = {
    resolveEmevdRegistry: () => ({ origin: options.origin ?? 'first-party', registry: {}, diagnostics: [], packageId: 'owned-schema' }),
    fingerprintEmedfRegistry: () => 'owned-schema-hash',
    listEmedfCompletionItems: () => [{ name: 'OwnedInstruction', bank: 1, id: 2, args: [] }],
    runBridge: async input => { calls.push(['envelope', plain(input)]); return options.envelope?.(input) ?? {
      parseStatus: 'confirmed', diagnostics: [], data: { sourceHash: hash, eventCount: 1, instructionCount: 1,
        events: [], instructionsSample: [], authority: 'native', supportsEventGc: true, absolutePath: 'PRIVATE' } }; },
    readFullEmevdDocumentViaBridge: async input => { calls.push(['full', plain({ ...input, signal: undefined })]);
      return options.full ? options.full(input, fullResult(input)) : fullResult(input); },
    commitEmevdMutationViaBridge: async input => { calls.push(['stageWrite', plain(input)]); return { ok: true }; },
    applyNativeMutation: async (input, ports) => {
      calls.push(['mutation', input, ports]);
      if (options.mutation) return options.mutation(input, ports);
      await input.stageWrite({ outputPath: '/owned/stage/output.emevd', allowedRoots: ['/owned/mod', '/owned/stage'], writableRoots: ['/owned/stage'] });
      return { status: 'committed', result: { ok: true, committed: true, opId: 'owned-operation', changedFiles: [uri], diagnostics: [] } };
    },
    submitEmevdDslPlanViaFourView: async input => { calls.push(['dslCommit', plain(input)]); return options.dsl?.(input) ?? { ok: true, diagnostics: [] }; },
    openResourcePreview: async input => { calls.push(['preview', plain(input)]); if (options.previewError) throw options.previewError;
      return { file: { ...input.file, sha256: hash, marker: input.file.absolutePath } }; }
  };
  const shared = {};
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename);
    const source = fs.readFileSync(filename, 'utf8');
    const built = ts.transpileModule(source, { fileName: filename, reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
    assert.deepEqual((built.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error), []);
    const exports = {}; modules.set(filename, exports);
    vm.runInNewContext(built.outputText, { exports, module: { exports }, process, Buffer, console, AbortController,
      setTimeout, clearTimeout, require(name) {
        if (name.startsWith('node:')) return require(name);
        if (name === '@soulforge/core') return core;
        if (name === '@soulforge/shared') return shared;
        if (name === 'electron') throw new Error('EVENT service/adapter must not import Electron runtime');
        if (name.endsWith('/bridgeRoots.js')) return { prepareBridgeRoots: async (...args) => {
          calls.push(['roots', ...args]); return options.roots?.(...args) ?? { ok: true, allowedRoots: ['/owned/mod', '/owned/stage'], writableRoots: ['/owned/stage'] }; } };
        if (name.endsWith('/emevdDarkScriptWorkerHost.js')) return { renderEmevdDarkScriptAsync: async (...args) => {
          calls.push(['worker', ...args]); return options.worker?.(...args) ?? { text: Array.from({ length: 405 }, (_, i) => `line ${i}`).join('\n'), totalLines: 405, truncated: false }; } };
        if (name.startsWith('.')) return load(path.resolve(path.dirname(filename), name.replace(/\.js$/u, '.ts')));
        throw new Error(`Unexpected EVENT import ${name}`);
      }
    }, { filename });
    return exports;
  }
  Object.assign(shared, load(path.join(root, 'packages/shared/src/path-sanitizer.ts')));
  const adapter = load(adapterPath);
  const deps = {
    handle: (channel, listener) => handlers.set(channel, (...args) => { if (options.deny) throw new Error('IPC_UNTRUSTED_SENDER'); return listener(...args); }),
    get indexedFiles() { return files; }, get activeSession() { return activeSession; },
    replaceIndexedFile: (...args) => { calls.push(['replace', ...args]); return true; },
    durableStoragePaths: () => ({ root: '/owned/storage', stagingRoot: '/owned/stage', backupBaseDir: '/owned/backups', recoveryDir: '/owned/recovery' }),
    bridgeRootSession: owner => ({ owner }), bridgeRootsDiagnostic: (code, result) => ({ severity: 'error', code, message: result.message ?? 'owned root refusal' }),
    rejectNonSekiroNativeWrite: () => options.gameFailure ?? null,
    ensureActiveOperationLog: async owner => { calls.push(['operationLog', owner]); return { marker: 'owned-journal' }; },
    sessionCommitPort: (...args) => { calls.push(['commitPort', ...args]); return { commit: async () => ({ ok: true }) }; },
    electronConfirmationPort: event => { calls.push(['confirmation', event.sender.id]); return { marker: event.sender.id }; },
    toSaveResultFromOutcome: outcome => outcome.result ?? { ok: false, changedFiles: [], diagnostics: [] },
    refreshActiveIndexAfterNativeWrite: async (...args) => { calls.push(['refresh', ...args]); if (options.refreshError) throw options.refreshError; }
  };
  adapter.registerEventIpcHandlers(deps);
  return { calls, deps, load, adapter, handlers,
    invoke: (channel, ...args) => handlers.get(channel)({ sender: { id: 1 } }, ...args),
    invokeAs: (id, channel, ...args) => handlers.get(channel)({ sender: { id } }, ...args),
    switchWorkspace(value, replacementFiles = [{ ...file, absolutePath: '/owned/new/common.emevd.dcx' }]) {
      activeSession = value; files = replacementFiles; adapter.clearEmevdIpcCaches();
    },
    fullResult,
    service() { const { handle: _handle, electronConfirmationPort: _confirmation, ...ports } = deps;
      return load(servicePath).createEventService({ ...ports, get indexedFiles() { return files; }, get activeSession() { return activeSession; } }); }
  };
}

test('EVENT domain owns callable native/cache/lifetime operations below trusted registration', () => {
  assert.equal(fs.existsSync(servicePath), true, 'EVENT application service must exist');
  assert.doesNotMatch(fs.readFileSync(adapterPath, 'utf8'), /runBridge\(|applyNativeMutation\(|emevdFullDocuments|emevdDisassemblyCache|EmevdOpenSlots|EmevdSourceTokens/);
  assert.doesNotMatch(fs.readFileSync(servicePath, 'utf8'), /IpcMainInvokeEvent|TrustedIpcHandle|deps\.handle|readLifetime\.register/);
});
test('all seven EVENT trusted channels retain their original order', () => assert.deepEqual([...harness().handlers.keys()], channels));
test('trusted refusal prevents every native and confirmation port', async () => {
  const h = harness({ deny: true }); await assert.rejects(async () => h.invoke(channels[0], uri), /IPC_UNTRUSTED_SENDER/); assert.deepEqual(h.calls, []);
});
test('missing resources and sessions refuse native reads and writes', async () => {
  const h = harness({ files: [], session: null }); assert.equal((await h.invoke(channels[0], uri)).diagnostics[0].code, 'RESOURCE_NOT_INDEXED');
  assert.equal((await h.invoke(channels[1], uri, hash, {})).diagnostics[0].code, 'EMEVD_WRITE_NO_SESSION'); assert.deepEqual(h.calls, []);
});
test('legacy envelope retains native hash/GC authority and masks physical data', async () => {
  const h = harness(), result = await h.invoke(channels[0], uri); assert.equal(result.ok, true); assert.equal(result.data.sourceHash, hash);
  assert.equal(result.data.supportsEventGc, true); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(h.calls.find(([name]) => name === 'envelope')[1].oodleRuntimeRoot, session.layers.baseRoot);
});
test('full read keeps bounded source paging and window-owned token authority', async () => {
  const h = harness(), result = await h.invoke(channels[4], uri, 'owned-doc', true);
  assert.equal(result.ok, true); assert.equal(result.dslTemplate, null); assert.equal(result.sourcePrefix.split('\n').length, 400);
  assert.equal(result.sourceHash, hash); assert.equal(result.outerFileHash, outerHash); assert.equal(result.sourceStyle, 'dark-script');
  assert.equal((await h.invoke(channels[3], result.sourceToken, 400, 1200)).sliceText, 'line 400\nline 401\nline 402\nline 403\nline 404');
  assert.equal((await h.invokeAs(2, channels[3], result.sourceToken, 400, 1200)).code, 'EMEVD_SOURCE_TOKEN_EXPIRED');
  h.adapter.disposeEmevdWindow(1); assert.equal((await h.invoke(channels[3], result.sourceToken, 0, 1)).code, 'EMEVD_SOURCE_TOKEN_EXPIRED');
});
test('disassembly reuse is bound to native source and schema hashes', async () => {
  const h = harness(); await h.invoke(channels[4], uri, 'first'); await h.invoke(channels[4], uri, 'second');
  assert.equal(h.calls.filter(([name]) => name === 'worker').length, 1);
  assert.equal(h.calls.filter(([name]) => name === 'full').length, 2);
});
test('schema gap produces no synthetic source and retains completion catalogue provenance', async () => {
  const h = harness({ origin: 'fixture' }), result = await h.invoke(channels[4], uri, 'owned');
  assert.equal(result.sourcePrefix, null); assert.equal(result.sourceToken, null); assert.equal(result.diagnostics[0].code, 'EMEDF_FIRST_PARTY_SCHEMA_UNAVAILABLE');
  assert.equal((await h.invoke(channels[5])).ok, false); assert.equal(h.calls.filter(([name]) => name === 'worker').length, 0);
});
test('same-window newer opens cancel the old slot without cancelling another window', async () => {
  const start = deferred(), wait = deferred(); let first = true;
  const h = harness({ full: async (_input, result) => { if (first) { first = false; start.resolve(); await wait.promise; } return result; } });
  const old = h.invoke(channels[4], uri, 'old'); await start.promise;
  assert.equal((await h.invokeAs(2, channels[4], uri, 'other-window')).ok, true);
  assert.equal((await h.invoke(channels[4], uri, 'new')).ok, true); wait.resolve();
  assert.equal((await old).diagnostics[0].code, 'EMEVD_LOAD_CANCELLED');
});
test('explicit cancel expires the token and stops the current open', async () => {
  const start = deferred(), wait = deferred(); const h = harness({ full: async (_input, result) => { start.resolve(); await wait.promise; return result; } });
  const pending = h.invoke(channels[4], uri, 'owned'); await start.promise;
  assert.equal((await h.invoke(channels[2])).cancelled, true); wait.resolve(); assert.equal((await pending).cancelled, true);
});
test('native mutation retains hash/staging/confirmation and caller-owned journal commit', async () => {
  const h = harness(), result = await h.invokeAs(7, channels[1], uri, hash, { kind: 'set_instruction_args', instructionIndex: 3 });
  assert.equal(result.ok, true); assert.equal(result.committed, true); assert.equal(result.opId, 'owned-operation');
  const staged = h.calls.find(([name]) => name === 'stageWrite')[1]; assert.equal(staged.sourcePath, file.absolutePath);
  assert.equal(staged.expectedDocumentHash, hash); assert.equal(staged.instructionIndex, 3); assert.deepEqual(staged.writableRoots, ['/owned/stage']);
  assert.deepEqual(plain(h.calls.find(([name]) => name === 'commitPort')[4]), { knowledgeRefreshOwner: 'caller' });
  assert.deepEqual(h.calls.find(([name]) => name === 'confirmation'), ['confirmation', 7]); assert.equal(h.calls.filter(([name]) => name === 'refresh').length, 1);
});
test('native game and staging refusal occur before confirmation and mutation', async () => {
  for (const options of [{ gameFailure: { ok: false, diagnostics: [{ code: 'OWNED_GAME_REFUSAL' }] } }, { roots: () => ({ ok: false }) }]) {
    const h = harness(options); assert.equal((await h.invoke(channels[1], uri, hash, {})).ok, false);
    assert.equal(h.calls.filter(([name]) => name === 'mutation' || name === 'confirmation').length, 0);
  }
});
test('committed preview failure retains receipt and still runs the one knowledge refresh', async () => {
  const h = harness({ previewError: new Error('owned preview failed') }), result = await h.invoke(channels[1], uri, hash, {});
  assert.equal(result.ok, true); assert.equal(result.committed, true); assert.equal(result.diagnostics[0].code, 'POSTCOMMIT_PREVIEW_FAILED');
  assert.equal(h.calls.filter(([name]) => name === 'mutation').length, 1); assert.equal(h.calls.filter(([name]) => name === 'refresh').length, 1);
});
test('DSL needs a full authoritative document and commits against fresh native outer identity', async () => {
  const h = harness(); assert.equal((await h.invoke(channels[6], uri, 'text')).diagnostics[0].code, 'EMEVD_FULL_DOCUMENT_MISSING');
  await h.invoke(channels[4], uri, 'owned-doc'); assert.equal((await h.invoke(channels[6], uri, 'text', 'dark-script')).ok, true);
  const input = h.calls.find(([name]) => name === 'dslCommit')[1]; assert.equal(input.sourcePath, file.absolutePath);
  assert.equal(input.expectedDocumentHash, hash); assert.equal(input.expectedOuterFileHash, outerHash); assert.equal(input.compileRequest.mode, 'dark-script');
  assert.equal(h.calls.filter(([name]) => name === 'full').slice(1).every(([, value]) => value.cachePolicy === 'bypass'), true);
});

for (const phase of ['roots', 'native', 'worker']) for (const aba of [false, true]) {
  test(`full EVENT read discards delayed ${phase} after ${aba ? 'same-object reset' : 'workspace replacement'}`, async () => {
    const start = deferred(), wait = deferred(); let delayed = true;
    const pause = async result => { if (delayed) { start.resolve(); await wait.promise; } return result; };
    const h = harness({
      roots: phase === 'roots' ? () => pause({ ok: true, allowedRoots: ['/owned/mod'], writableRoots: [] }) : undefined,
      full: phase === 'native' ? (_input, result) => pause(result) : undefined,
      worker: phase === 'worker' ? () => pause({ text: 'owned source', totalLines: 1, truncated: false }) : undefined
    });
    const pending = h.invoke(channels[4], uri, 'old'); await start.promise;
    h.switchWorkspace(aba ? session : { ...session }); delayed = false;
    const current = await h.invoke(channels[4], uri, 'new'); assert.equal(current.ok, true);
    wait.resolve(); const old = await pending; assert.equal(old.ok, false); assert.equal(old.cancelled, true);
    assert.equal((await h.invoke(channels[3], current.sourceToken, 0, 1)).ok, true);
    if (phase === 'roots') assert.equal(h.calls.filter(([name]) => name === 'full').length, 1);
  });
}
test('direct EVENT service invocation owns lifetime without a registrar', async () => {
  const start = deferred(), wait = deferred(); let delayed = true;
  const h = harness({ full: async (_input, result) => { if (delayed) { start.resolve(); await wait.promise; } return result; } });
  const service = h.service(); assert.equal(Object.isFrozen(service), true); assert.equal('handle' in service, false);
  const old = service.readEmevdFullDocument(8, uri, 'old'); await start.promise;
  h.switchWorkspace({ ...session }); service.clearCaches(); delayed = false;
  assert.equal((await service.readEmevdFullDocument(8, uri, 'new')).ok, true); wait.resolve(); assert.equal((await old).cancelled, true);
});
test('independent EVENT services share no document authority or source token state', async () => {
  const h = harness(), first = h.service(), second = h.service();
  const opened = await first.readEmevdFullDocument(8, uri, 'first-instance');
  assert.equal(opened.ok, true);
  assert.equal((await second.readEmevdSourceSlice(8, opened.sourceToken, 0, 1)).code, 'EMEVD_SOURCE_TOKEN_EXPIRED');
  assert.equal((await second.submitEmevdDslPlan(uri, 'text')).diagnostics[0].code, 'EMEVD_FULL_DOCUMENT_MISSING');
  assert.equal((await first.readEmevdSourceSlice(8, opened.sourceToken, 0, 1)).ok, true);
});
test('a delayed mutation keeps its committed journal receipt without replacing the new workspace index', async () => {
  const start = deferred(), wait = deferred();
  const h = harness({ mutation: async () => { start.resolve(); await wait.promise; return {
    status: 'committed', result: { ok: true, committed: true, opId: 'owned-late-operation', changedFiles: [uri], diagnostics: [] }
  }; } });
  const pending = h.invoke(channels[1], uri, hash, {}); await start.promise;
  h.switchWorkspace({ ...session, meta: { ...session.meta, workspaceId: 'new-workspace' } });
  wait.resolve(); const result = await pending;
  assert.equal(result.ok, true); assert.equal(result.committed, true); assert.equal(result.opId, 'owned-late-operation');
  assert.equal(h.calls.filter(([name]) => name === 'replace').length, 0);
  assert.equal(h.calls.filter(([name]) => name === 'refresh').length, 0);
  assert.equal(h.calls.filter(([name]) => name === 'mutation').length, 1);
  assert.equal(h.calls.find(([name]) => name === 'commitPort')[1], session);
});
test('delayed DSL settlement leaves the new native document instance authoritative without replay', async () => {
  const start = deferred(), wait = deferred(); let first = true;
  const h = harness({ dsl: async () => { if (first) { first = false; start.resolve(); await wait.promise; } return { ok: true, diagnostics: [] }; } });
  await h.invoke(channels[4], uri, 'old-instance');
  const pending = h.invoke(channels[6], uri, 'text'); await start.promise;
  h.switchWorkspace({ ...session, meta: { ...session.meta, workspaceId: 'new-workspace' } });
  await h.invoke(channels[4], uri, 'new-instance');
  wait.resolve(); assert.equal((await pending).ok, true);
  assert.equal(h.calls.filter(([name]) => name === 'replace').length, 0);
  assert.equal(h.calls.filter(([name]) => name === 'refresh').length, 0);
  assert.equal((await h.invoke(channels[6], uri, 'new text')).ok, true);
  assert.equal(h.calls.filter(([name]) => name === 'dslCommit').at(-1)[1].compileRequest.documentInstanceId, 'new-instance');
});
