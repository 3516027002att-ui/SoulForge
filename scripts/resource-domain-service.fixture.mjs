// Execute actual resource transport/services with filesystem, native preview,
// transaction and dialog boundaries replaced. No native/Electron process starts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainPath = name => path.join(root, 'apps/desktop/src/main', name);
const ownedPath = relative => path.resolve(path.sep, 'owned-resource', relative);
const hash = 'a'.repeat(64), childHash = 'b'.repeat(64);
const file = { sourceUri: 'resource://owned/script', absolutePath: ownedPath('mod/script.lua'), relativePath: 'script.lua', game: 'sekiro',
  resourceKind: 'script', extension: '.lua', compoundExtension: '.lua', formatKind: 'text', formatLabel: 'Lua', parseStatus: 'parsed', diagnostics: [], size: 8, mtimeMs: 1, sha256: hash };
const channels = ['resource.replaceContainerChild', 'resource.saveScriptSource', 'resource.preview', 'resource.saveText', 'resource.search'];
const plain = value => JSON.parse(JSON.stringify(value));
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

function harness(options = {}) {
  const calls = [], handlers = new Map(), cache = new Map();
  let files = options.files ?? [file], session = options.session === null ? null : { meta: { workspaceId: 'owned' }, layers: { overlayRoot: ownedPath('mod'), baseRoot: null } };
  let activeIndex = options.index ?? null;
  let generation = 1;
  const storage = { root: ownedPath('storage'), backupBaseDir: ownedPath('backup'), recoveryDir: ownedPath('recovery'), stagingRoot: ownedPath('stage') };
  const result = { ok: options.commitOk !== false, opId: 'owned-op', changedFiles: options.commitOk === false ? [] : [file.absolutePath], diagnostics: [] };
  const core = {
    runBridge: async input => { calls.push(['bridge', input]); return { parseStatus: 'partial', diagnostics: [], data: {
      containerHash: hash, contentHash: childHash, contentBase64: Buffer.from('return 1').toString('base64'), sanitizedName: 'owned.lua'
    } }; },
    openResourcePreview: async input => { calls.push(['preview', input]); await options.previewGate?.promise; if (options.previewError) throw options.previewError; return { file: input.file, previewKind: 'text', text: 'owned preview', truncated: false, bytesRead: 8, diagnostics: [] }; },
    replaceContainerChild: async input => { calls.push(['replaceChild', input]); await options.commitGate?.promise; return result; },
    saveRawReplace: async input => { calls.push(['rawReplace', input]); await options.commitGate?.promise; return result; },
    saveTextResource: async input => { calls.push(['textSave', input]); if (options.confirmationRequired && !input.confirmation)
      return { ok: false, requiresConfirmation: true, changedFiles: [], diagnostics: [] }; await options.commitGate?.promise; return result; },
    encodeScriptSourceForWriteback: (_original, text) => ({ ok: true, bytes: Buffer.from(text), diagnostics: [] }),
    readContainerChild: async () => ({ ok: true, bytes: Buffer.from(options.childBytecode ? [0x1b,0x4c,0x75,0x61,0x51] : 'return 1') }),
    inspectContainerTree: async () => ({ ok: true, tree: { rootHash: hash } }),
    applyNativeMutation: async request => { calls.push(['nativeMutation', request]); return options.nativeOutcome ?? { status: 'failed', diagnostics: [{ code: 'OWNED_NATIVE_STOP' }] }; }
  };
  const shared = {};
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename);
    const built = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename, reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
    assert.deepEqual((built.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error), []);
    const exports = {}; cache.set(filename, exports);
    vm.runInNewContext(built.outputText, { exports, module: { exports }, process, Buffer, Error, Uint8Array, ArrayBuffer, console,
      require(name) {
        if (name === 'node:fs/promises') return { readFile: async input => { calls.push(['fileRead', input]); return Buffer.from('return 1'); } };
        if (name.startsWith('node:')) return require(name);
        if (name === '@soulforge/core') return core;
        if (name === '@soulforge/shared') return shared;
        if (name === 'electron') throw new Error('Resource application services cannot import Electron at runtime');
        if (name.startsWith('.')) return load(path.resolve(path.dirname(filename), name.replace(/\.js$/, '.ts')));
        throw new Error(`Unexpected resource import ${name}`);
      }
    }, { filename });
    return exports;
  }
  Object.assign(shared, load(path.join(root, 'packages/shared/src/path-sanitizer.ts')));
  const adapter = load(mainPath('ipc/resource.ts'));
  const deps = {
    handle: (name, callback) => handlers.set(name, (...args) => { if (options.deny) throw new Error('IPC_UNTRUSTED_SENDER'); return callback(...args); }),
    getIndexedFiles: () => files, getActiveSession: () => session, getActiveIndex: () => activeIndex, getActiveWorkspaceSessionId: () => 'owned-session',
    getActiveWorkspaceSessionGeneration: () => generation,
    durableStoragePaths: () => storage, ensureActiveOperationLog: async () => { calls.push(['operationLog']); return {}; },
    rejectNonSekiroNativeWrite: () => options.gameFailure ?? null,
    requestWriteConfirmation: async input => { calls.push(['confirm', input]); return options.cancel ? null : { token: 'owned-confirmation' }; },
    verifiedReadRoots: async () => ({ allowedRoots: [ownedPath('mod')], diagnostics: options.rootDiagnostics ?? [] }),
    verifiedStageRoots: async () => ({ allowedRoots: [ownedPath('mod')], writableRoots: [storage.stagingRoot], diagnostics: [] }),
    sessionCommitPort: () => ({ commit: async () => result }), toSaveResultFromOutcome: outcome => ({ ok: outcome.status === 'committed', changedFiles: [], diagnostics: outcome.diagnostics ?? [] }),
    clearResourceRelatedCaches: () => { calls.push(['cacheClear']); if (options.cacheError) throw options.cacheError; },
    refreshActiveIndexAfterNativeWrite: async (sources, carrier) => { calls.push(['refresh', sources, carrier]); if (options.refreshError) throw options.refreshError; },
    withForegroundPriority: async fn => { calls.push(['foreground']); return fn(); },
    bumpPathSourceGenerationForUris: uris => { calls.push(['generation', uris]); if (options.generationError) throw options.generationError; },
    replaceIndexedFile: (uri, next) => { calls.push(['replaceIndex', uri, next]); if (options.indexError) throw options.indexError; return true; }
  };
  adapter.registerResourceIpcHandlers(deps);
  return { calls, handlers, adapter, deps, load, storage, result,
    invoke: (channel, ...args) => handlers.get(channel)({ sender: { id: 17 } }, ...args),
    switchFiles(next) { files = next; }, switchSession(next) { session = next; generation++; }, switchIndex(next) { activeIndex = next; }
  };
}

test('generic resource application services receive no registrar or Electron event authority', () => {
  for (const name of ['resourceReadService.ts', 'resourceMutationService.ts', 'scriptSourceService.ts']) {
    assert.equal(fs.existsSync(mainPath(`services/${name}`)), true, name);
    assert.doesNotMatch(fs.readFileSync(mainPath(`services/${name}`), 'utf8'), /TrustedIpcHandle|IpcMainInvokeEvent/);
  }
  assert.doesNotMatch(fs.readFileSync(mainPath('ipc/resource.ts'), 'utf8'), /runBridge\(|replaceContainerChild\(\{|saveRawReplace\(/);
});
test('all five resource channels retain literal order and trusted refusal', async () => {
  const h = harness({ deny: true }); assert.deepEqual([...h.handlers.keys()], channels);
  await assert.rejects(async () => h.invoke(channels[0], `${file.sourceUri}#entry`, hash, childHash, 'b3duZWQ='), /IPC_UNTRUSTED_SENDER/);
  assert.deepEqual(h.calls, []);
});
test('generic preview retains foreground priority and avoids a second native parse for domain-owned sources', async () => {
  for (const resourceKind of ['param', 'map', 'action']) {
    const h = harness({ files: [{ ...file, resourceKind }] }); const value = await h.invoke(channels[2], file.sourceUri);
    assert.equal(value.kind, resourceKind); assert.equal(value.structured, null); assert.deepEqual(h.calls.map(([kind]) => kind), ['foreground']);
  }
  const h = harness(); assert.equal((await h.invoke(channels[2], file.sourceUri)).text, 'owned preview');
  assert.deepEqual(h.calls.map(([kind]) => kind), ['foreground', 'preview']);
});
test('search uses the active resource index or the existing slash/dot/underscore tolerant fallback', async () => {
  const h = harness(); h.switchFiles([{ ...file, relativePath: 'action/script/chara_param.lua' }]);
  const value = await h.invoke(channels[4], 'action/script/chara_param.lua'); assert.equal(value.length, 1); assert.equal('absolutePath' in value[0], false);
  h.switchIndex({ searchResources: input => { h.calls.push(['indexSearch', input]); return [{ item: file }]; } });
  const indexed = await h.invoke(channels[4], 'owned'); assert.equal(indexed[0].sourceUri, file.sourceUri);
  assert.equal(h.calls[0][1].limit, 100);
});
test('unindexed resources and unavailable container sessions refuse replacement before confirmation', async () => {
  const absent = harness({ files: [] }); assert.equal((await absent.invoke(channels[0], `${file.sourceUri}#entry`, hash, childHash, '')).diagnostics[0].code, 'RESOURCE_NOT_INDEXED');
  assert.deepEqual(absent.calls, []);
  const noSession = harness({ session: null }); assert.equal((await noSession.invoke(channels[0], `${file.sourceUri}#entry`, hash, childHash, '')).diagnostics[0].code, 'CONTAINER_WRITE_NO_SESSION');
  assert.deepEqual(noSession.calls, []);
});
test('container replacement keeps both hashes, bound dialog event and exactly one cache/refresh sequence', async () => {
  const h = harness(); const childUri = `${file.sourceUri}#bnd/child/owned.lua`, bytes = Buffer.from('owned child').toString('base64');
  const value = await h.invoke(channels[0], childUri, hash, childHash, bytes); assert.equal(value.ok, true); assert.equal(value.opId, 'owned-op');
  const confirmation = h.calls.find(([kind]) => kind === 'confirm')[1]; assert.equal(confirmation.event.sender.id, 17); assert.equal(confirmation.sourceUri, file.sourceUri);
  assert.equal(confirmation.payloadHash, crypto.createHash('sha256').update(`${hash}\n${childHash}\n${bytes}`).digest('hex'));
  const request = h.calls.find(([kind]) => kind === 'replaceChild')[1]; assert.equal(request.expectedContainerHash, hash); assert.equal(request.expectedChildHash, childHash);
  assert.equal(request.newContentBase64, bytes); assert.equal(request.backupBaseDir, h.storage.backupBaseDir);
  assert.deepEqual(h.calls.filter(([kind]) => ['replaceChild', 'cacheClear', 'refresh'].includes(kind)).map(([kind]) => kind), ['replaceChild', 'cacheClear', 'refresh']);
  assert.deepEqual(plain(value.changedFiles), [file.sourceUri]);
});
test('cancelled container/text confirmation stops writes without replay or refresh', async () => {
  for (const channel of [channels[0], channels[3]]) {
    const h = harness({ cancel: true, confirmationRequired: true });
    const value = await h.invoke(channel, file.sourceUri, ...(channel === channels[0] ? [hash, childHash, ''] : ['owned text']));
    assert.equal(value.ok, false); assert.equal(value.diagnostics[0].code, 'WRITE_CONFIRMATION_CANCELLED');
    assert.equal(h.calls.some(([kind]) => kind === 'refresh' || kind === 'replaceChild'), false);
    assert.equal(h.calls.filter(([kind]) => kind === 'textSave').length, channel === channels[3] ? 1 : 0);
  }
});
test('generic text save keeps conditional confirmation, source generation and preview/index refresh order', async () => {
  const h = harness({ confirmationRequired: true }); const result = await h.invoke(channels[3], file.sourceUri, 'owned text');
  assert.equal(result.ok, true); assert.deepEqual(h.calls.map(([kind]) => kind), ['operationLog', 'textSave', 'confirm', 'textSave', 'generation', 'preview', 'replaceIndex', 'refresh']);
  assert.equal(h.calls.find(([kind]) => kind === 'confirm')[1].event.sender.id, 17);
  assert.equal(h.calls.filter(([kind]) => kind === 'textSave')[1][1].confirmation.token, 'owned-confirmation');
});
test('loose plaintext Script source keeps physical byte hash and skips native compilation', async () => {
  const h = harness(); const result = await h.invoke(channels[1], file.sourceUri, undefined, undefined, undefined, 'return 2');
  assert.equal(result.ok, true); const save = h.calls.find(([kind]) => kind === 'rawReplace')[1];
  assert.equal(save.expectedHash, crypto.createHash('sha256').update('return 1').digest('hex')); assert.equal(save.newContentBase64, Buffer.from('return 2').toString('base64'));
  assert.equal(h.calls.some(([kind]) => kind === 'bridge'), false); assert.equal(h.calls.find(([kind]) => kind === 'confirm')[1].event.sender.id, 17);
});
test('native Script plaintext child preserves supplied physical hashes and rejects unindexed HKS child writeback', async () => {
  const h = harness(); const value = await h.invoke(channels[1], file.sourceUri, 'owned.lua', childHash, hash, 'return 2', 'utf8', 0);
  assert.equal(value.ok, false); const read = h.calls.find(([kind]) => kind === 'bridge')[1];
  assert.equal(read.command, 'read-luabnd-script'); assert.equal(read.commandOptions.entryIndex, 0);
  assert.equal(read.commandOptions.expectedContainerHash, hash); assert.equal(read.commandOptions.expectedChildHash, childHash);
  assert.equal(h.calls.find(([kind]) => kind === 'nativeMutation')[1].expectedHash, hash);
  assert.equal(h.calls.some(([kind, input]) => kind === 'bridge' && input.command === 'compile-hks-source'), false);
  const legacy = harness({ childBytecode: true }); const rejected = await legacy.invoke(channels[1], file.sourceUri, 'owned.lua', childHash, hash, 'return 2');
  assert.equal(rejected.diagnostics[0].code, 'HKS_ENTRY_INDEX_REQUIRED'); assert.equal(legacy.calls.some(([kind]) => kind === 'confirm' || kind === 'replaceChild'), false);
});

test('resource read service is directly callable and observes current indexed files without transport capabilities', async () => {
  const h = harness(); const { createResourceReadService } = h.load(mainPath('services/resourceReadService.ts'));
  const ports = { getIndexedFiles: h.deps.getIndexedFiles, getActiveSession: h.deps.getActiveSession,
    getActiveIndex: h.deps.getActiveIndex, withForegroundPriority: h.deps.withForegroundPriority };
  const service = createResourceReadService(ports); assert.deepEqual(Object.keys(service), ['preview', 'search']);
  assert.equal(Object.isFrozen(service), true); assert.equal('handle' in ports, false);
  assert.equal((await service.preview(file.sourceUri)).text, 'owned preview');
  h.switchFiles([]); assert.equal(await service.preview(file.sourceUri), null);
  assert.deepEqual(plain(await service.search('owned')), []);
});

test('Script source service accepts a neutral deferred confirmation port and never receives a raw event', async () => {
  const h = harness(); const { createScriptSourceService } = h.load(mainPath('services/scriptSourceService.ts'));
  const ports = {};
  for (const name of ['getIndexedFiles', 'replaceIndexedFile', 'getActiveSession', 'durableStoragePaths', 'ensureActiveOperationLog',
    'getActiveWorkspaceSessionGeneration',
    'verifiedReadRoots', 'verifiedStageRoots', 'sessionCommitPort', 'toSaveResultFromOutcome', 'rejectNonSekiroNativeWrite',
    'refreshActiveIndexAfterNativeWrite', 'clearResourceRelatedCaches']) ports[name] = h.deps[name];
  const service = createScriptSourceService(ports); assert.deepEqual(Object.keys(service), ['saveScriptSource']);
  assert.equal(Object.isFrozen(service), true); assert.equal('handle' in ports, false); assert.equal('requestWriteConfirmation' in ports, false);
  let request;
  const result = await service.saveScriptSource(async input => { request = input; return { token: 'owned-neutral' }; },
    file.sourceUri, undefined, undefined, undefined, 'return 2');
  assert.equal(result.ok, true); assert.equal(request.sourceUri, file.sourceUri); assert.equal('event' in request, false);
  assert.equal(h.calls.some(([kind]) => kind === 'confirm'), false);
  h.switchFiles([]);
  assert.equal((await service.saveScriptSource(() => { throw new Error('must remain deferred'); }, file.sourceUri, undefined, undefined, undefined, 'return 2')).ok, false);
});

const committedPaths = [
  { name: 'container replacement', writer: 'replaceChild', invoke: h => h.invoke(channels[0], `${file.sourceUri}#bnd/child/owned.lua`, hash, childHash, 'b3duZWQ='), prepareFailures: ['cacheError'] },
  { name: 'generic text save', writer: 'textSave', invoke: h => h.invoke(channels[3], file.sourceUri, 'owned text'), prepareFailures: ['generationError', 'previewError', 'indexError'] },
  { name: 'legacy container Script save', writer: 'replaceChild', invoke: h => h.invoke(channels[1], file.sourceUri, 'owned.lua', childHash, hash, 'return 2'), prepareFailures: ['cacheError'] },
  { name: 'loose Script save', writer: 'rawReplace', invoke: h => h.invoke(channels[1], file.sourceUri, undefined, undefined, undefined, 'return 2'), prepareFailures: ['previewError', 'indexError'] }
];

for (const scenario of committedPaths) {
  test(`${scenario.name} keeps A's receipt labels when the original indexed object is mutated while the result is pending`, async () => {
    const gate = deferred(), mutable = { ...file };
    const h = harness({ files: [mutable], commitGate: gate }); const pending = scenario.invoke(h); await turn();
    assert.equal(h.calls.filter(([kind]) => kind === scenario.writer).length, 1);
    mutable.sourceUri = 'resource://reused-index/B'; mutable.relativePath = 'B-reused.lua';
    gate.resolve(); const result = await pending;
    assert.equal(result.ok, true); assert.equal(result.opId, 'owned-op');
    assert.deepEqual(plain(result.changedFiles), [file.sourceUri]);
    assert.equal(h.calls.filter(([kind]) => kind === scenario.writer).length, 1);
  });
  for (const returnToSameObject of [false, true]) {
    test(`${scenario.name} retains A's receipt without writing the ${returnToSameObject ? 'remounted A' : 'B'} global projection after owner replacement`, async () => {
      const gate = deferred(); const h = harness({ commitGate: gate }); const original = h.deps.getActiveSession();
      const pending = scenario.invoke(h); await turn(); assert.equal(h.calls.filter(([kind]) => kind === scenario.writer).length, 1);
      h.switchSession({ ...original }); h.switchFiles([{ ...file, sourceUri: 'resource://other/script', absolutePath: ownedPath('other/script.lua') }]);
      if (returnToSameObject) h.switchSession(original);
      gate.resolve(); const result = await pending;
      assert.equal(result.ok, true); assert.equal(result.opId, 'owned-op'); assert.deepEqual(plain(result.changedFiles), [file.sourceUri]);
      assert.equal(h.calls.some(([kind]) => ['cacheClear','generation','preview','replaceIndex','refresh'].includes(kind)), false);
      assert.equal(h.calls.filter(([kind]) => kind === scenario.writer).length, 1);
      assert.ok(result.diagnostics.some(d => d.code === 'POSTCOMMIT_WORKSPACE_SUPERSEDED'));
    });
  }
  for (const physicalPath of ['C:\\Users\\owned\\private\\script.lua', '/home/owned/private/script.lua']) {
    test(`${scenario.name} retains committed facts on ${physicalPath.startsWith('C:') ? 'Windows' : 'POSIX'} refresh rejection without replay`, async () => {
      const h = harness({ refreshError: new Error(`EACCES refresh denied '${physicalPath}'; reload needed`) });
      const result = await scenario.invoke(h);
      assert.equal(result.ok, true); assert.equal(result.opId, 'owned-op'); assert.deepEqual(plain(result.changedFiles), [file.sourceUri]);
      assert.equal(h.result.ok, true); assert.equal(h.calls.find(([kind]) => kind === 'refresh')[2], h.result);
      assert.equal(h.calls.filter(([kind]) => kind === scenario.writer).length, 1); assert.equal(h.calls.filter(([kind]) => kind === 'refresh').length, 1);
      const warning = result.diagnostics.find(d => d.code === 'POSTCOMMIT_REFRESH_FAILED'); assert.equal(warning.severity, 'warning');
      const text = JSON.stringify(warning); assert.equal(text.includes(physicalPath), false); assert.equal(text.includes(physicalPath.replaceAll('\\', '\\\\')), false);
      assert.ok(text.includes('[本机路径已隐藏]')); assert.ok(text.includes('EACCES refresh denied')); assert.ok(text.includes('reload needed'));
    });
  }
  test(`${scenario.name} preserves committed identity on each preparation failure and still refreshes exactly once`, async () => {
    for (const phase of scenario.prepareFailures) {
      const h = harness({ [phase]: new Error('owned projection failed') }); const result = await scenario.invoke(h);
      assert.equal(result.ok, true); assert.equal(result.opId, 'owned-op'); assert.deepEqual(plain(result.changedFiles), [file.sourceUri]);
      assert.equal(result.diagnostics[0].code, 'POSTCOMMIT_PREVIEW_FAILED'); assert.equal(result.diagnostics[0].severity, 'warning');
      assert.equal(h.calls.filter(([kind]) => kind === scenario.writer).length, 1); assert.equal(h.calls.filter(([kind]) => kind === 'refresh').length, 1);
    }
  });
  test(`${scenario.name} does not prepare or refresh a failed commit`, async () => {
    const h = harness({ commitOk: false, refreshError: new Error('must not run'), previewError: new Error('must not run'), cacheError: new Error('must not run') });
    const result = await scenario.invoke(h); assert.equal(result.ok, false); assert.deepEqual(plain(result.changedFiles), []);
    assert.equal(h.calls.some(([kind]) => ['cacheClear','generation','preview','replaceIndex','refresh'].includes(kind)), false);
    assert.equal(h.calls.filter(([kind]) => kind === scenario.writer).length, 1);
  });
}

for (const scenario of committedPaths.filter(s => s.prepareFailures.includes('previewError'))) {
  test(`${scenario.name} drops the old preview result if the owner changes during preview without hiding the committed receipt`, async () => {
    const gate = deferred(); const h = harness({ previewGate: gate }); const pending = scenario.invoke(h);
    await turn(); assert.equal(h.calls.filter(([kind]) => kind === 'preview').length, 1);
    h.switchSession({ ...h.deps.getActiveSession() }); gate.resolve(); const result = await pending;
    assert.equal(result.ok, true); assert.equal(result.opId, 'owned-op');
    assert.equal(h.calls.some(([kind]) => kind === 'replaceIndex' || kind === 'refresh'), false);
    assert.ok(result.diagnostics.some(d => d.code === 'POSTCOMMIT_WORKSPACE_SUPERSEDED'));
  });
}
