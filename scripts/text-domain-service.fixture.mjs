// Actual TEXT/FMG callbacks with owned synthetic native/commit ports.
// No native process, Electron runtime, game bytes or remote service is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(import.meta.url);
const adapterPath = path.join(root, 'apps/desktop/src/main/ipc/text.ts'), servicePath = path.join(root, 'apps/desktop/src/main/services/textService.ts');
const channels = ['resource.readFmgDocument', 'resource.readFmgPage', 'resource.readTextCatalog', 'resource.readFmgTablePage', 'resource.applyFmgMutation'];
const hash = 'a'.repeat(64), childHash = 'b'.repeat(64), uri = 'resource://owned/text';
const session = { meta: { workspaceId: 'owned', game: 'sekiro' }, layers: { overlayRoot: '/owned/mod', baseRoot: null } };
const file = { sourceUri: uri, relativePath: 'msg/enus/common.msgbnd.dcx', absolutePath: '/owned/mod/msg/enus/common.msgbnd.dcx', compoundExtension: '.msgbnd.dcx', sha256: hash };
const entries = Array.from({ length: 501 }, (_, id) => ({ id, text: `owned entry ${id}` }));
const catalog = { languageId: 'enus', containerKind: 'common', containerId: 'text:enus:common', outerHash: hash, tableSourceHash: childHash, authority: 'Bridge', tables: [{ stableId: 'table:common', entryIndex: 3, entryName: 'N:\\PRIVATE\\Title_Items.fmg', entryCount: 501, filledCount: 501 }], entries };
const plain = value => JSON.parse(JSON.stringify(value));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function harness(options = {}) {
    const calls = [], handlers = new Map(), modules = new Map();
    let files = options.files ?? [file], activeSession = options.session === undefined ? session : options.session;
    const result = options.result ?? { ok: true, opId: 'owned-operation', changedFiles: [file.absolutePath], diagnostics: [] };
    const core = {
        runBridge: async (input) => { calls.push(['bridge', plain(input)]); return options.bridge ? options.bridge(input) : { parseStatus: 'confirmed', diagnostics: [], data: catalog }; },
        readFmgDocumentViaBridge: async (input) => { calls.push(['fmg', plain(input)]); return options.fmg ? options.fmg(input) : { ok: true, diagnostics: [], data: { sourceHash: hash, entryCount: 501, entries, authority: 'Bridge', absolutePath: 'PRIVATE' } }; },
        applyNativeMutation: async (input, ports) => { calls.push(['mutation', input, ports]); const staged = await input.stageWrite({ outputPath: '/owned/stage/out.fmg', allowedRoots: ['/owned/mod'], writableRoots: ['/owned/stage'] }); if (!staged.ok)
            return { status: 'failed', diagnostics: staged.diagnostics }; return { status: 'committed', result }; },
        commitFmgMutationViaBridge: async (input) => { calls.push(['stageWrite', plain(input)]); return { ok: true, diagnostics: [] }; }
    };
    const shared = {};
    const roots = { prepareBridgeRoots: async () => { calls.push(['prepareRoots']); return options.prepareRoots ?? { ok: true, allowedRoots: ['/owned/mod'], writableRoots: [] }; } };
    function load(filename) { if (modules.has(filename))
        return modules.get(filename); const built = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename, reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }); assert.deepEqual((built.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error), []); const exports = {}; modules.set(filename, exports); vm.runInNewContext(built.outputText, { exports, module: { exports }, Error, Buffer, console, require(name) { if (name.startsWith('node:'))
            return require(name); if (name === 'electron')
            throw new Error('Text service has no Electron runtime'); if (name === '@soulforge/core')
            return core; if (name === '@soulforge/shared')
            return shared; if (name.endsWith('/bridgeRoots.js'))
            return roots; if (name.startsWith('.'))
            return load(path.resolve(path.dirname(filename), name.replace(/\.js$/, '.ts'))); throw new Error(`Unexpected import ${name}`); } }, { filename }); return exports; }
    Object.assign(shared, load(path.join(root, 'packages/shared/src/path-sanitizer.ts')), load(path.join(root, 'packages/shared/src/fmg-names.ts')), load(path.join(root, 'packages/shared/src/editor-pagination.ts')));
    Object.assign(core, { normalizePageWindow: load(path.join(root, 'packages/core/src/editing/editorCapabilityContract.ts')).normalizePageWindow });
    const deps = {
        handle: (channel, listener) => handlers.set(channel, (...args) => { if (options.deny)
            throw new Error('IPC_UNTRUSTED_SENDER'); return listener(...args); }),
        get indexedFiles() { return files; }, get activeSession() { return activeSession; },
        durableStoragePaths: () => ({ root: '/owned/storage', backupBaseDir: '/owned/backup', recoveryDir: '/owned/recovery', stagingRoot: '/owned/stage' }),
        bridgeRootSession: () => ({}), bridgeRootsDiagnostic: (code, value) => ({ severity: 'error', code, message: value.code ?? 'owned roots' }),
        verifiedReadRoots: async (readSession, fallback) => { calls.push(['roots', readSession, fallback]); return options.roots ? options.roots() : { allowedRoots: ['/owned/mod'], diagnostics: options.rootDiagnostics ?? [] }; },
        verifiedStageRoots: async () => { calls.push(['stageRoots']); return { allowedRoots: ['/owned/mod'], writableRoots: ['/owned/stage'], diagnostics: options.stageDiagnostics ?? [] }; },
        rejectNonSekiroNativeWrite: () => options.gameFailure ?? null, sha256FileNow: async () => { calls.push(['hash']); return hash; },
        ensureActiveOperationLog: async (readSession) => { calls.push(['operationLog', readSession]); return {}; },
        sessionCommitPort: (readSession, log, storage, ownership) => { calls.push(['commitPort', readSession, ownership]); return { commit: () => result }; },
        toSaveResultFromOutcome: outcome => ({ ok: outcome.result?.ok ?? false, opId: outcome.result?.opId, changedFiles: [uri], diagnostics: outcome.result?.diagnostics ?? outcome.diagnostics }),
        refreshActiveIndexAfterNativeWrite: async (sources, carrier) => { calls.push(['refresh', sources, carrier]); if (options.refreshError)
            throw options.refreshError; }
    };
    const adapter = load(adapterPath);
    adapter.registerTextIpcHandlers(deps);
    return { calls, handlers, load, deps, adapter, result, invoke: (channel, ...args) => handlers.get(channel)({}, ...args), switchSession(value) { activeSession = value; }, switchFiles(value) { files = value; }, clear() { adapter.clearTextIpcCaches(); } };
}
test('TEXT business and lifetime live in callable services below trusted registration', () => {
    assert.equal(fs.existsSync(servicePath), true, 'TEXT application service must exist');
    const adapter = fs.readFileSync(adapterPath, 'utf8');
    assert.doesNotMatch(adapter, /runBridge\(|readFmgDocumentViaBridge\(|fmgPageCache|textTableRefs|applyNativeMutation\(/);
    assert.doesNotMatch(fs.readFileSync(servicePath, 'utf8'), /TrustedIpcHandle|IpcMainInvokeEvent|deps\.handle|readLifetime\.register/);
});
test('current five TEXT channels retain original registration order', () => assert.deepEqual([...harness().handlers.keys()], channels));
test('independently callable TEXT service enters the same captured read lifetime without a registrar', async () => {
    const start = deferred(), wait = deferred();
    let delay = true;
    const h = harness({ fmg: async () => { if (delay) {
            start.resolve();
            await wait.promise;
        } return { ok: true, diagnostics: [], data: { sourceHash: hash, entries: [{ id: 1, text: 'owned' }] } }; } });
    const { handle: _handle, ...ports } = h.deps;
    const service = h.load(servicePath).createTextService({ ...ports, get indexedFiles() { return h.deps.indexedFiles; }, get activeSession() { return h.deps.activeSession; } });
    assert.equal(Object.isFrozen(service), true);
    assert.equal('handle' in service, false);
    const pending = service.readFmgPage(uri, 0, 100);
    await start.promise;
    h.switchSession({ ...session });
    service.clearCaches();
    delay = false;
    assert.equal((await service.readFmgPage(uri, 0, 100)).ok, true);
    wait.resolve();
    const stale = await pending;
    assert.equal(stale.ok, false);
    assert.equal(stale.diagnostics[0].code, 'WORKSPACE_READ_SUPERSEDED');
});
test('trusted refusal stops all native/commit work', async () => { const h = harness({ deny: true }); await assert.rejects(async () => h.invoke(channels[0], uri), /IPC_UNTRUSTED_SENDER/); assert.deepEqual(h.calls, []); });
test('missing FMG and missing workspace return structured errors', async () => { const h = harness({ files: [], session: null }); assert.equal((await h.invoke(channels[0], uri)).diagnostics[0].code, 'RESOURCE_NOT_INDEXED'); assert.equal((await h.invoke(channels[2])).diagnostics[0].code, 'WORKSPACE_SESSION_REQUIRED'); assert.equal((await h.invoke(channels[4], uri, hash, { kind: 'delete', id: 2 })).diagnostics[0].code, 'FMG_WRITE_NO_SESSION'); assert.deepEqual(h.calls, []); });
test('container FMG document keeps outer hash and 500-row renderer projection', async () => { const h = harness(), out = await h.invoke(channels[0], uri); assert.equal(out.ok, true); assert.equal(out.data.sourceHash, hash); assert.equal(out.data.entries.length, 500); assert.equal(out.data.entriesTruncated, true); const input = h.calls.find(([n]) => n === 'bridge')[1]; assert.equal(input.command, 'read-text-catalog'); assert.equal(input.timeoutMs, 60000); assert.deepEqual(input.commandOptions, { tableEntryIndex: 0 }); });
test('loose FMG document retains native hash and hides physical fields', async () => { const h = harness({ files: [{ ...file, compoundExtension: '.fmg' }] }), out = await h.invoke(channels[0], uri); assert.equal(out.data.sourceHash, hash); assert.equal(out.data.entries.length, 500); assert.equal('absolutePath' in out.data, false); assert.equal(h.calls.filter(([n]) => n === 'bridge').length, 0); });
test('verified-root failure prevents native FMG page read', async () => { const h = harness({ rootDiagnostics: [{ severity: 'error', code: 'OWNED_ROOT_REFUSED', message: 'owned' }] }); assert.equal((await h.invoke(channels[1], uri, 0, 100)).ok, false); assert.equal(h.calls.filter(([n]) => n === 'fmg').length, 0); });
test('page cache reads once and query covers the full native document', async () => { const h = harness(), first = await h.invoke(channels[1], uri, 0, 100); assert.equal(first.entries.length, 100); assert.equal(first.maxId, 500); const match = await h.invoke(channels[1], uri, 0, 100, 'entry 500'); assert.equal(match.entries[0].id, 500); assert.equal(h.calls.filter(([n]) => n === 'fmg').length, 1); });
test('catalog keeps typed table identity and logical names from native metadata', async () => { const h = harness(), out = await h.invoke(channels[2]); assert.equal(out.ok, true); const table = out.languages[0].containers[0].tables[0]; assert.equal(table.tableId, 'table:common'); assert.equal(table.entryIndex, 3); assert.equal(table.entryName, 'Title_Items'); assert.equal(JSON.stringify(out).includes('PRIVATE'), false); });
test('native catalog failure retains a typed failed node instead of an empty successful table', async () => { const h = harness({ bridge: () => ({ parseStatus: 'failed', diagnostics: [{ severity: 'error', code: 'OWNED_NATIVE_REFUSED', message: 'owned' }] }) }), out = await h.invoke(channels[2]); assert.equal(out.languages[0].languageId, 'enus'); assert.equal(out.languages[0].containers[0].parseStatus, 'failed'); assert.equal(out.languages[0].containers[0].diagnostics[0].code, 'OWNED_NATIVE_REFUSED'); });
test('typed table page binds native entry index and child source hash', async () => { const h = harness(); await h.invoke(channels[2]); const out = await h.invoke(channels[3], 'table:common', 0, 100, 'entry 500'); assert.equal(out.sourceHash, childHash); assert.equal(out.entries[0].id, 500); const reads = h.calls.filter(([n]) => n === 'bridge'); assert.deepEqual(reads.at(-1)[1].commandOptions, { tableEntryIndex: 3 }); });
test('unknown table IDs refuse both paging and mutation', async () => { const h = harness(); assert.equal((await h.invoke(channels[3], 'table:unknown', 0, 100)).diagnostics[0].code, 'TEXT_TABLE_NOT_RESOLVED'); assert.equal((await h.invoke(channels[4], uri, hash, { kind: 'delete', id: 2 }, 'table:unknown')).diagnostics[0].code, 'FMG_WRITE_PROFILE_UNSUPPORTED'); assert.deepEqual(h.calls, []); });
for (const kind of ['delete', 'add', 'upsert'])
    test(`FMG ${kind} retains verified staging, entry identity and caller-owned commit`, async () => { const h = harness(); await h.invoke(channels[2]); const out = await h.invoke(channels[4], uri, hash, { kind, id: 2, text: 'changed' }, 'table:common'); assert.equal(out.ok, true); assert.equal(out.opId, 'owned-operation'); const staged = h.calls.find(([n]) => n === 'stageWrite')[1]; assert.equal(staged.expectedDocumentHash, hash); assert.equal(staged.entryIndex, 3); assert.deepEqual(staged.allowedRoots, ['/owned/mod']); assert.deepEqual(staged.writableRoots, ['/owned/stage']); assert.deepEqual(staged.mutation, kind === 'delete' ? { kind, id: 2 } : { kind, id: 2, text: 'changed' }); assert.deepEqual(plain(h.calls.find(([n]) => n === 'commitPort')[2]), { knowledgeRefreshOwner: 'caller' }); assert.equal(h.calls.filter(([n]) => n === 'refresh').length, 1); });
test('native game and staging refusals prevent FMG mutation', async () => { for (const options of [{ gameFailure: { ok: false, changedFiles: [], diagnostics: [{ code: 'OWNED_GAME_REFUSED' }] } }, { stageDiagnostics: [{ severity: 'error', code: 'OWNED_STAGE_REFUSED', message: 'owned' }] }]) {
    const h = harness(options);
    assert.equal((await h.invoke(channels[4], uri, hash, { kind: 'delete', id: 2 })).ok, false);
    assert.equal(h.calls.filter(([n]) => n === 'mutation').length, 0);
} });
test('failed native commit performs no refresh', async () => { const h = harness({ result: { ok: false, diagnostics: [], changedFiles: [] } }); assert.equal((await h.invoke(channels[4], uri, hash, { kind: 'delete', id: 2 })).ok, false); assert.equal(h.calls.filter(([n]) => n === 'refresh').length, 0); });
test('committed FMG refresh rejection retains receipt and does not replay', async () => { const h = harness({ refreshError: new Error('owned refresh failed') }); const out = await h.invoke(channels[4], uri, hash, { kind: 'delete', id: 2 }); assert.equal(out.ok, true); assert.equal(out.opId, 'owned-operation'); assert.equal(out.diagnostics[0].code, 'POSTCOMMIT_REFRESH_FAILED'); assert.equal(h.calls.filter(([n]) => n === 'mutation').length, 1); assert.equal(h.calls.filter(([n]) => n === 'refresh').length, 1); });
for (const phase of ['roots', 'native'])
    for (const aba of [false, true])
        test(`TEXT delayed ${phase} read cannot overwrite ${aba ? 'same-object ABA' : 'replacement'} cache`, async () => { const start = deferred(), wait = deferred(); let old = true; const delayed = async () => { if (old) {
            start.resolve();
            await wait.promise;
        } return old ? 'OLD' : 'NEW'; }; const h = harness({ roots: phase === 'roots' ? async () => { await delayed(); return { allowedRoots: ['/owned/mod'], diagnostics: [] }; } : undefined, fmg: async () => { const value = phase === 'native' ? await delayed() : 'NEW'; return { ok: true, diagnostics: [], data: { sourceHash: value, entries: [{ id: 1, text: value }] } }; } }); const pending = h.invoke(channels[1], uri, 0, 100); await start.promise; h.switchSession(aba ? session : { ...session }); h.clear(); old = false; const current = await h.invoke(channels[1], uri, 0, 100); assert.equal(current.entries[0].text, 'NEW'); wait.resolve(); const stale = await pending; assert.equal(stale.ok, false); assert.equal(stale.diagnostics[0].code, 'WORKSPACE_READ_SUPERSEDED'); assert.equal((await h.invoke(channels[1], uri, 0, 100)).entries[0].text, 'NEW'); });
