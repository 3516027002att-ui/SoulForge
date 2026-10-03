// Execute the actual PARAM adapter/service with only native and desktop ports
// replaced. No Electron or Bridge process starts, and no game data is read.
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
const adapterPath = path.join(root, 'apps/desktop/src/main/ipc/param.ts');
const servicePath = path.join(root, 'apps/desktop/src/main/services/paramService.ts');
const channels = ['resource.openParamSession', 'resource.readParamIndexPage', 'resource.readParamRows',
  'param.metadata.trustState', 'param.metadata.setTrust', 'resource.readParamDocument', 'resource.readParamPage',
  'resource.applyParamMutation', 'resource.applyParamFieldMutation', 'resource.applyContainerParamFieldMutation',
  'resource.applyContainerParamRowNameMutation', 'resource.applyContainerParamRowMutations', 'param.exportRowsCsv',
  'param.exportNamesCsv', 'param.importNamesCsv', 'param.importRowsCsv', 'resource.listContainerParams',
  'resource.readContainerParamPage', 'resource.readContainerParamRowIndex'];
const hash = 'a'.repeat(64);
const session = { meta: { workspaceId: 'owned-session', game: 'sekiro' }, layers: { overlayRoot: '/owned/mod', baseRoot: '/owned/base' } };
const file = { sourceUri: 'sf://owned/param', relativePath: 'fixture.param', absolutePath: '/owned/mod/fixture.param', sha256: hash };
const plain = value => JSON.parse(JSON.stringify(value));

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

function harness(options = {}) {
  const calls = [], handlers = new Map(), cache = new Map();
  let activeSession = options.session === undefined ? session : options.session;
  const files = options.files ?? [file];
  const core = {
    isParamBackupPath: value => value.includes('backup'),
    normalizePageWindow: (page, pageSize) => ({ page: Math.max(0, page), pageSize: Math.min(256, Math.max(1, pageSize)) }),
    loadFirstPartyParamMetadata: () => options.definition
      ? { ok: true, package: { definitions: [{ key: {}, document: options.definition }] } }
      : { ok: false, diagnostics: [{ code: 'OWNED_METADATA_UNAVAILABLE', message: 'owned' }] },
    matchParamMetadataPackage: () => ({ ok: true, definition: { document: options.definition } }),
    applyParamFieldMutation: input => load(path.join(root, 'packages/core/src/param/paramFieldMutation.ts')).applyParamFieldMutation(input),
    runBridge: async input => {
      calls.push(['bridge', plain(input)]);
      if (options.bridge) return options.bridge(input);
      return { parseStatus: 'success', diagnostics: [], data: { sessionToken: 'owned-token', sourceHash: hash,
        typeName: 'OwnedParam', rowCount: 1, rowDataSize: 4, pathSourceGeneration: 2,
        rows: [{ rowIndex: 0, id: 7, name: 'owned', dataHash: hash, dataBase64: 'AQAAAA==' }] } };
    },
    applyNativeMutation: async (input, ports) => {
      calls.push(['mutation', { sourceUri: input.sourceUri, expectedHash: input.expectedHash, allowedRoots: input.allowedRoots() }]);
      const staged = await input.stageWrite({ outputPath: '/owned/stage/result.param', allowedRoots: ['/owned/mod', '/owned/stage'], writableRoots: ['/owned/stage'] });
      calls.push(['staged', staged]);
      assert.equal(ports.confirm, options.confirmPort ?? 'owned-confirm');
      return options.outcome ?? { status: 'committed', result: { ok: true, diagnostics: [] } };
    },
    commitParamMutationViaBridge: async input => { calls.push(['nativeWrite', plain(input)]); return { ok: true }; }
  };
  const shared = {
    PARAM_PAGE_SIZE: 50, PARAM_ROW_PAYLOAD_BATCH_MAX: 256,
    PARAM_SESSION_IPC_CHANNELS: { open: channels[0], readIndexPage: channels[1], readRows: channels[2] },
    maskPathFragments: value => value
  };
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename);
    const source = fs.readFileSync(filename, 'utf8').replaceAll('import.meta.url', JSON.stringify(new URL(`file://${filename}`).href));
    const compiled = ts.transpileModule(source, { fileName: filename, reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
    assert.deepEqual((compiled.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error), []);
    const exports = {}; cache.set(filename, exports);
    vm.runInNewContext(compiled.outputText, { exports, module: { exports }, process, Buffer, console, setTimeout, clearTimeout,
      require(name) {
        if (name.startsWith('node:')) return require(name);
        if (name === '@soulforge/core') return core;
        if (name === '@soulforge/shared') return shared;
        if (name === 'electron') {
          assert.ok(!filename.includes(`${path.sep}services${path.sep}`), 'domain services cannot hold Electron runtime authority');
          return { dialog: {
          showSaveDialog: async () => { calls.push(['saveDialog']); return { canceled: true }; },
          showOpenDialog: async () => { calls.push(['openDialog']); return { canceled: true, filePaths: [] }; }
          } };
        }
        if (name.endsWith('/bridgeRoots.js')) return { prepareBridgeRoots: async () => { throw new Error('unexpected stage preparation'); } };
        if (name.startsWith('.')) return load(path.resolve(path.dirname(filename), name.replace(/\.js$/, '.ts')));
        throw new Error(`Unexpected PARAM runtime import: ${name}`);
      }
    }, { filename });
    return exports;
  }
  const adapter = load(adapterPath);
  const deps = {
    handle(channel, listener) { handlers.set(channel, (...args) => {
      if (options.deny) throw new Error('IPC_UNTRUSTED_SENDER');
      return listener(...args);
    }); }, indexedFiles: files, get activeSession() { return activeSession; },
    getIndexedFiles: () => files, getActiveSession: () => activeSession,
    activeWorkspaceSessionId: 'owned-workspace', getActiveWorkspaceSessionId: () => 'owned-workspace',
    verifiedReadRoots: async () => ({ allowedRoots: ['/owned/mod', '/owned/base'], diagnostics: options.rootDiagnostics ?? [] }),
    durableStoragePaths: () => ({ root: '/owned/storage', stagingRoot: '/owned/stage', backupBaseDir: '/owned/backups', recoveryDir: '/owned/recovery' }),
    verifiedStageRoots: async () => { calls.push(['stageRoots']); return { allowedRoots: ['/owned/mod', '/owned/stage'], writableRoots: ['/owned/stage'], diagnostics: options.stageDiagnostics ?? [] }; },
    rejectNonSekiroNativeWrite: () => options.gameFailure ?? null,
    ensureActiveOperationLog: async () => { calls.push(['operationLog']); return 'owned-log'; },
    sha256FileNow: async () => { calls.push(['hash']); return hash; },
    electronConfirmationPort: event => { calls.push(['confirmation', event]); return options.confirmPort ?? 'owned-confirm'; },
    sessionCommitPort: (_session, _log, _storage, ownership) => { calls.push(['commitPort', ownership]); return 'owned-commit'; },
    refreshActiveIndexAfterNativeWrite: async sources => { calls.push(['refresh', plain(sources)]); if (options.refreshError) throw options.refreshError; },
    toSaveResultFromOutcome: outcome => outcome.result,
    bridgeRootSession: () => { throw new Error('unexpected root session'); },
    bridgeRootsDiagnostic: () => { throw new Error('unexpected root diagnostic'); }
  };
  if (options.legacyGetters) {
    delete deps.getIndexedFiles; delete deps.getActiveSession; delete deps.getActiveWorkspaceSessionId;
  }
  adapter.registerParamIpcHandlers(deps);
  return { adapter, calls, handlers, load, deps,
    invoke: (channel, ...args) => handlers.get(channel)({ sender: 'owned' }, ...args), switchSession(value) { activeSession = value; } };
}

test('PARAM registration is a transport adapter with a separately callable domain service', () => {
  const source = fs.readFileSync(adapterPath, 'utf8');
  assert.equal(fs.existsSync(servicePath), true, 'PARAM business service must exist below IPC');
  assert.doesNotMatch(source, /runBridge|applyNativeMutation|stageBridgeOutput|readFile|writeFile/);
  assert.match(source, /createParamService/);
});

test('all nineteen existing PARAM channels register once in their original order', () => {
  const h = harness(); assert.deepEqual([...h.handlers.keys()], channels);
});

test('trusted registrar rejection settles before native work or confirmation', async () => {
  const h = harness({ deny: true }); await assert.rejects(async () => h.invoke(channels[7], file.sourceUri, hash, { kind: 'delete', id: 7 }), /IPC_UNTRUSTED_SENDER/);
  assert.deepEqual(h.calls, []);
});

for (const [name, options, code] of [
  ['unindexed resource', { files: [] }, 'RESOURCE_NOT_INDEXED'],
  ['backup resource', { files: [{ ...file, relativePath: 'backup/fixture.param' }] }, 'BACKUP_READ_FORBIDDEN'],
  ['missing session', { session: null }, 'PARAM_OPEN_NO_SESSION'],
  ['read roots rejected', { rootDiagnostics: [{ severity: 'error', code: 'OWNED_ROOT_REJECTED', message: 'owned' }] }, 'OWNED_ROOT_REJECTED']
]) test(`PARAM session refuses ${name} before native parsing`, async () => {
  const h = harness(options); const result = await h.invoke(channels[0], { sourceUri: file.sourceUri });
  assert.equal(result.ok, false); assert.equal(result.diagnostics[0].code, code); assert.deepEqual(h.calls, []);
});

test('slim session preserves native identity, indexed rows, root scope and read budgets', async () => {
  const h = harness(); const opened = await h.invoke(channels[0], { sourceUri: file.sourceUri });
  assert.equal(opened.sourceHash, hash); assert.equal(opened.workspaceSessionId, 'owned-workspace'); assert.equal(opened.pathSourceGeneration, 2);
  assert.equal(opened.firstPage.rows[0].dataBase64, undefined);
  const rows = [{ rowIndex: 0, id: 7, dataHash: hash }];
  await h.invoke(channels[1], { sourceUri: file.sourceUri, sessionToken: 'owned-token', page: 2, pageSize: 5 });
  await h.invoke(channels[2], { sourceUri: file.sourceUri, sessionToken: 'owned-token', rows });
  const reads = h.calls.filter(([name]) => name === 'bridge').map(([, input]) => input);
  assert.deepEqual(reads.map(input => input.timeoutMs), [120000, 60000, 60000]);
  assert.deepEqual(reads.map(input => input.allowedRoots), [['/owned/mod', '/owned/base'], ['/owned/mod', '/owned/base'], ['/owned/mod', '/owned/base']]);
  assert.deepEqual(reads[2].commandOptions, { documentSession: 'owned-token', includeRowPayloads: true, rowSelections: [{ rowIndex: 0, expectedId: 7, expectedDataHash: hash }] });
});

test('session binding and selected-row limits refuse wrong source or oversized batch', async () => {
  const h = harness(); await h.invoke(channels[0], { sourceUri: file.sourceUri });
  assert.equal((await h.invoke(channels[1], { sourceUri: 'sf://foreign', sessionToken: 'owned-token' })).diagnostics[0].code, 'PARAM_SESSION_BINDING_MISMATCH');
  assert.equal((await h.invoke(channels[2], { sourceUri: file.sourceUri, sessionToken: 'owned-token', rows: Array(257).fill({}) })).diagnostics[0].code, 'PARAM_ROW_SELECTION_TOO_LARGE');
  assert.equal(h.calls.length, 1);
});

test('workspace replacement discards an in-flight native projection', async () => {
  const gate = deferred(); const h = harness({ bridge: () => gate.promise });
  const pending = h.invoke(channels[0], { sourceUri: file.sourceUri }); await new Promise(resolve => setImmediate(resolve));
  h.switchSession({ ...session }); gate.resolve({ parseStatus: 'success', diagnostics: [], data: { sessionToken: 'stale' } });
  const result = await pending; assert.equal(result.cancelled, true); assert.equal(result.diagnostics[0].code, 'WORKSPACE_READ_SUPERSEDED');
});

test('cache invalidation prevents old PARAM session token reuse', async () => {
  const h = harness(); await h.invoke(channels[0], { sourceUri: file.sourceUri }); h.adapter.clearParamIpcCaches();
  assert.equal((await h.invoke(channels[1], { sourceUri: file.sourceUri, sessionToken: 'owned-token' })).diagnostics[0].code, 'PARAM_SESSION_BINDING_MISMATCH');
});

test('host fallback getters remain live through service port projection', async () => {
  const h = harness({ legacyGetters: true }); h.switchSession(null);
  const result = await h.invoke(channels[0], { sourceUri: file.sourceUri });
  assert.equal(result.diagnostics[0].code, 'PARAM_OPEN_NO_SESSION'); assert.deepEqual(h.calls, []);
});

test('independently callable PARAM services own isolated caches and clear only their own bindings', async () => {
  const h = harness(); const { createParamService } = h.load(servicePath);
  const { WorkspaceReadLifetime } = h.load(path.join(root, 'apps/desktop/src/main/ipc/workspaceReadLifetime.ts'));
  const { handle: _handle, electronConfirmationPort: _confirmation, ...ports } = h.deps;
  const create = () => createParamService({ ...ports, readLifetime: new WorkspaceReadLifetime(), dialog: {
    showSaveDialog: () => { throw new Error('unexpected dialog'); }, showOpenDialog: () => { throw new Error('unexpected dialog'); }
  } });
  const first = create(), second = create();
  assert.equal(Object.isFrozen(first), true); assert.equal('handle' in first, false);
  await first.openParamSession({ sourceUri: file.sourceUri });
  assert.equal((await second.readParamIndexPage({ sourceUri: file.sourceUri, sessionToken: 'owned-token' })).diagnostics[0].code, 'PARAM_SESSION_BINDING_MISMATCH');
  await second.openParamSession({ sourceUri: file.sourceUri }); first.clearCaches();
  assert.equal((await second.readParamIndexPage({ sourceUri: file.sourceUri, sessionToken: 'owned-token' })).ok, true);
  assert.equal((await first.readParamIndexPage({ sourceUri: file.sourceUri, sessionToken: 'owned-token' })).diagnostics[0].code, 'PARAM_SESSION_BINDING_MISMATCH');
});

test('invalid write input refuses staging and never creates confirmation', async () => {
  const h = harness(); const result = await h.invoke(channels[7], file.sourceUri, hash, { kind: 'upsert', id: 7 });
  assert.equal(result.ok, false); assert.equal(result.diagnostics[0].code, 'PARAM_UPSERT_DATA_REQUIRED'); assert.deepEqual(h.calls, []);
});

test('native row write preserves hash, row identity, staged roots and lazy request confirmation', async () => {
  const h = harness(); const result = await h.invoke(channels[7], file.sourceUri, '', { kind: 'delete', id: 7, rowIndex: 3, expectedDataHash: hash });
  assert.equal(result.ok, true);
  assert.deepEqual(h.calls.map(([name]) => name), ['stageRoots', 'operationLog', 'confirmation', 'commitPort', 'mutation', 'nativeWrite', 'staged', 'refresh']);
  const native = h.calls.find(([name]) => name === 'nativeWrite')[1];
  assert.equal(native.expectedDocumentHash, hash); assert.deepEqual(native.mutation, { kind: 'delete', id: 7, rowIndex: 3, expectedDataHash: hash });
  assert.deepEqual(native.writableRoots, ['/owned/stage']);
  assert.equal(h.calls.find(([name]) => name === 'confirmation')[1].sender, 'owned');
  assert.deepEqual(plain(h.calls.find(([name]) => name === 'commitPort')[1]), { knowledgeRefreshOwner: 'caller' });
});

test('postcommit refresh failure preserves the committed write and does not replay native work', async () => {
  const h = harness({ refreshError: new Error('owned refresh failed') });
  const result = await h.invoke(channels[7], file.sourceUri, hash, { kind: 'delete', id: 7 });
  assert.equal(result.ok, true); assert.equal(result.diagnostics[0].code, 'POSTCOMMIT_REFRESH_FAILED');
  assert.equal(h.calls.filter(([name]) => name === 'nativeWrite').length, 1);
});

test('field operation invokes the real row-byte codec and rebinds a forged renderer layout', async () => {
  const definition = { schemaVersion: 1, typeName: 'OwnedParam', version: 1, rowDataSize: 4, origin: 'first-party',
    fields: [{ id: 'owned', name: 'Owned', type: 'u32', offset: 0, size: 4 }] };
  const h = harness({ definition });
  const result = await h.invoke(channels[8], file.sourceUri, hash, { rowId: 7, rowIndex: 2, expectedDataHash: hash,
    fieldId: 'owned', value: 7, rowDataBase64: 'AQAAAA==', definition: { ...definition, fields: [{ ...definition.fields[0], offset: 999 }] } });
  assert.equal(result.ok, true);
  const native = h.calls.find(([name]) => name === 'nativeWrite')[1];
  assert.deepEqual(native.mutation, { kind: 'upsert', id: 7, dataBase64: 'BwAAAA==', rowIndex: 2, expectedDataHash: hash });
  assert.equal(h.calls.filter(([name]) => name === 'nativeWrite').length, 1);
});

test('rejected stage scope preserves diagnostics and cannot create a write or confirmation', async () => {
  const h = harness({ stageDiagnostics: [{ severity: 'error', code: 'OWNED_STAGE_REJECTED', message: 'owned' }] });
  const result = await h.invoke(channels[7], file.sourceUri, hash, { kind: 'delete', id: 7 });
  assert.equal(result.diagnostics[0].code, 'OWNED_STAGE_REJECTED'); assert.deepEqual(h.calls, [['stageRoots']]);
});
