// Actual asset IPC/application operations and the real core mutation commit /
// confirmation flow; only native staging, filesystem and commit ports replaced.
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
const sourcePath = name => path.join(root, 'apps/desktop/src/main', name);
const ownedPath = relative => path.resolve(path.sep, 'owned-assets', relative);
const hash = 'a'.repeat(64), outerHash = 'b'.repeat(64);
const file = { sourceUri: 'resource://owned/assets', absolutePath: ownedPath('mod/asset.flver'), relativePath: 'asset.flver', game: 'sekiro', sha256: hash };
const reads = ['readFlverDocument', 'readTpfDocument', 'readTpfTexturePreview', 'readFlverMesh', 'readFlverSkeleton', 'readFlverDummies',
  'readFlverTextureSlots', 'readEsdDocument', 'readMtdDocument', 'readFxrDocument', 'listFxrEntries', 'readGparamDocument'];
const writes = [
  ['applyFlverMutation', { kind: 'material-slot-set', meshStableId: 'native-mesh-17', slotIndex: 2, materialStableId: 'native-material-33' }, 'commitFlverMutationViaBridge'],
  ['saveTpfTextureReplace', [4, Buffer.from('owned texture').toString('base64')], 'commitTpfTextureReplaceViaBridge'],
  ['commitGparamMutations', [{ groupIndex: 3, fieldIndex: 7, valueIndex: 11, value: 42 }], 'commitGparamMutationsViaBridge'],
  ['commitMtdPropertySet', { paramId: 'native-param-2', newValue: '42' }, 'commitMtdPropertySetViaBridge'],
  ['commitEsdTransition', [{ mutation: 'behavior-transition-upsert', stateGroupId: 2, stateId: 3, transitionIndex: 4 }], 'commitEsdTransitionViaBridge'],
  ['commitTaeEvent', [{ mutation: 'update-event-times', animId: 42, eventIndex: 7, startTime: 1, endTime: 2 }], 'commitTaeEventViaBridge'],
  ['commitFxrFieldSet', [{ mutation: 'vfx-field-set', nodeIndex: 17, fieldIndex: 33, value: 42 }], 'commitVfxFieldSetViaBridge']
];
const plain = value => JSON.parse(JSON.stringify(value));

function harness(options = {}) {
  const calls = [], handlers = new Map(), cache = new Map();
  let files = options.files ?? [{ ...file, ...(options.file ?? {}) }];
  let session = options.session === null ? null : { meta: { workspaceId: 'owned' }, layers: { overlayRoot: ownedPath('mod'), baseRoot: ownedPath('base') } };
  const storage = { root: ownedPath('storage'), backupBaseDir: ownedPath('backup'), recoveryDir: ownedPath('recovery'), stagingRoot: ownedPath('stage') };
  const stage = { allowedRoots: [ownedPath('mod'), storage.stagingRoot], writableRoots: [storage.stagingRoot], diagnostics: options.stageDiagnostics ?? [] };
  const nativeResult = { ok: options.commitOk !== false, opId: 'owned-commit', changedFiles: [files[0]?.absolutePath], diagnostics: [] };
  const core = {
    runBridge: async input => { calls.push(['bridge', input]); return options.bridge ? options.bridge(input) : {
      parseStatus: 'partial', diagnostics: [], data: { format: 'OWNED_NATIVE', sourceHash: hash, outerFileHash: outerHash, groupCount: 2219,
        entryIndex: 17, entryId: 33, groups: [], absolutePath: 'PRIVATE' }
    }; }
  };
  for (const name of [...writes.map(([, , name]) => name), 'commitTaeEventContainerViaBridge']) {
    core[name] = async input => { calls.push([name, input]); return { ok: options.writerOk !== false, diagnostics: [] }; };
  }
  const shared = {};
  function execute(source, filename, scope = {}) {
    const built = ts.transpileModule(source, { fileName: filename, reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
    assert.deepEqual((built.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error), []);
    const exports = {};
    vm.runInNewContext(built.outputText, { exports, module: { exports }, process, Buffer, Error, console, ...scope,
      require(name) {
        if (name === 'node:fs') return { existsSync: value => (options.existing ?? []).includes(value) };
        if (name.startsWith('node:')) return require(name);
        if (name === '@soulforge/core') return core;
        if (name === '@soulforge/shared') return shared;
        if (name === 'electron') throw new Error('Asset services cannot import Electron at runtime');
        if (name.startsWith('.')) return load(path.resolve(path.dirname(filename), name.replace(/\.js$/, '.ts')));
        throw new Error(`Unexpected asset import ${name}`);
      }
    }, { filename });
    return exports;
  }
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename);
    const value = execute(fs.readFileSync(filename, 'utf8'), filename); cache.set(filename, value); return value;
  }
  Object.assign(shared, load(path.join(root, 'packages/shared/src/path-sanitizer.ts')));
  const backupPath = path.join(root, 'packages/core/src/editing/paramBridgeCommit.ts');
  const backupAst = ts.createSourceFile(backupPath, fs.readFileSync(backupPath, 'utf8'), ts.ScriptTarget.Latest, true);
  const backupGuard = backupAst.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'isParamBackupPath');
  core.isParamBackupPath = execute(backupGuard.getText(backupAst), backupPath).isParamBackupPath;
  const mutationPath = path.join(root, 'packages/core/src/editing/editorMutationService.ts');
  const text = fs.readFileSync(mutationPath, 'utf8'); const ast = ts.createSourceFile(mutationPath, text, ts.ScriptTarget.Latest, true);
  const apply = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'applyNativeMutation');
  core.applyNativeMutation = execute(apply.getText(ast), mutationPath, {
    buildNativeMutationCandidate: async request => {
      calls.push(['candidate', request]);
      const staged = await request.stageWrite({ outputPath: path.join(storage.stagingRoot, request.stagingFileName),
        allowedRoots: request.allowedRoots(storage.stagingRoot), writableRoots: stage.writableRoots });
      return { ok: staged.ok, diagnostics: [{ severity: 'error', code: 'OWNED_WRITER_REFUSED', message: 'owned' }],
        newContentBase64: Buffer.from('owned native output').toString('base64'), payloadHash: 'owned-payload-hash' };
    }
  }).applyNativeMutation;
  const adapter = load(sourcePath('ipc/assets.ts'));
  const deps = {
    handle: (name, callback) => handlers.set(name, (...args) => { if (options.deny) throw new Error('IPC_UNTRUSTED_SENDER'); return callback(...args); }),
    get indexedFiles() { return files; }, get activeSession() { return session; },
    verifiedReadRoots: async () => { calls.push(['readRoots']); return { allowedRoots: [ownedPath('mod')], diagnostics: options.rootDiagnostics ?? [] }; },
    verifiedStageRoots: async (_session, _storage, code) => { calls.push(['stageRoots', code]); return stage; },
    durableStoragePaths: () => storage,
    rejectNonSekiroNativeWrite: () => options.gameFailure ?? null,
    ensureActiveOperationLog: async () => { calls.push(['operationLog']); return {}; },
    electronConfirmationPort: event => { calls.push(['confirmationPort', event.sender.id]); return {
      requestConfirmation: async input => { calls.push(['confirm', input]); return options.cancel ? null : { token: 'owned-receipt' }; }
    }; },
    sessionCommitPort: () => ({ commit: async input => { calls.push(['commit', input]);
      if (!input.confirmation && options.requiresConfirmation) return { ok: false, requiresConfirmation: true, changedFiles: [], diagnostics: [] };
      return nativeResult;
    } }),
    toSaveResultFromOutcome: outcome => outcome.status === 'committed' ? { ...outcome.result, changedFiles: outcome.result.ok ? [file.sourceUri] : [] }
      : outcome.status === 'cancelled' ? { ok: false, cancelled: true, changedFiles: [], diagnostics: [] }
      : { ok: false, changedFiles: [], diagnostics: outcome.diagnostics },
    resolveFlverReadFile: () => files[0] ?? null
  };
  adapter.registerAssetIpcHandlers(deps);
  const invoke = (name, ...args) => handlers.get(`resource.${name}`)({ sender: { id: 7 } }, ...args);
  return { calls, handlers, deps, adapter, load, invoke, files, stage, storage,
    write: entry => invoke(entry[0], files[0]?.sourceUri ?? file.sourceUri, hash, ...(entry[0] === 'saveTpfTextureReplace' ? entry[1] : [entry[1]])),
    switchFiles(next) { files = next; }, switchSession(next) { session = next; }
  };
}

test('asset transport delegates named reads and mutations below trusted sender/event ownership', () => {
  assert.equal(fs.existsSync(sourcePath('services/assetReadService.ts')), true);
  assert.equal(fs.existsSync(sourcePath('services/assetMutationService.ts')), true);
  const source = fs.readFileSync(sourcePath('ipc/assets.ts'), 'utf8');
  assert.doesNotMatch(source, /runBridge\(|applyNativeMutation\(|commitTaeEventViaBridge\(/);
  assert.match(source, /TrustedIpcHandle/); assert.match(source, /electronConfirmationPort/);
});
test('nineteen existing channels register in order and trusted refusal prevents native/confirmation work', async () => {
  const h = harness({ deny: true }); assert.deepEqual([...h.handlers.keys()], [...reads, ...writes.map(([name]) => name)].map(name => `resource.${name}`));
  await assert.rejects(async () => h.write(writes[0]), /IPC_UNTRUSTED_SENDER/); assert.deepEqual(h.calls, []);
});
test('all native asset reads keep root budgets, stable identities/hash and logical renderer projection', async () => {
  const h = harness();
  for (const name of reads) {
    const result = await h.invoke(name, file.sourceUri, name === 'readFxrDocument' ? ' selected.fxr ' : 4);
    assert.equal(result.ok, true, name); assert.equal(result.sourceUri, file.sourceUri); assert.equal('absolutePath' in result.data, false);
    const request = h.calls.filter(([kind]) => kind === 'bridge').at(-1)[1];
    assert.equal(request.timeoutMs, 120000); assert.deepEqual(plain(request.allowedRoots), [ownedPath('mod')]);
    if (name !== 'readGparamDocument') assert.equal(result.data.sourceHash, hash);
  }
  const fxr = h.calls.find(([kind, input]) => kind === 'bridge' && input.command === 'read-fxr-document')[1]; assert.deepEqual(plain(fxr.commandOptions), { entryName: 'selected.fxr' });
  const mesh = h.calls.find(([kind, input]) => kind === 'bridge' && input.command === 'read-flver-mesh')[1]; assert.equal(mesh.commandOptions.meshIndex, 4);
});
test('unindexed and denied-root reads stop before Bridge', async () => {
  for (const name of reads) {
    const h = harness({ files: [] }); assert.equal((await h.invoke(name, file.sourceUri)).diagnostics[0].code, 'RESOURCE_NOT_INDEXED'); assert.deepEqual(h.calls, []);
    const denied = harness({ rootDiagnostics: [{ severity: 'error', code: 'OWNED_ROOT_REFUSED', message: 'owned' }] });
    assert.equal((await denied.invoke(name, file.sourceUri)).ok, false); assert.equal(denied.calls.some(([kind]) => kind === 'bridge'), false);
  }
});

for (const entry of writes) {
  test(`${entry[0]} preserves native mutation identity, source hash, staging roots and event-bound confirmation`, async () => {
    const h = harness({ requiresConfirmation: true }); const result = await h.write(entry); assert.equal(result.ok, true);
    const native = h.calls.find(([kind]) => kind === entry[2])[1]; assert.equal(native.sourcePath, file.absolutePath);
    assert.equal(native.expectedDocumentHash, hash); assert.deepEqual(plain(native.writableRoots), [h.storage.stagingRoot]);
    assert.deepEqual(plain(native.allowedRoots), [ownedPath('mod'), h.storage.stagingRoot]); assert.ok(native.outputPath.startsWith(h.storage.stagingRoot + path.sep));
    const commits = h.calls.filter(([kind]) => kind === 'commit'); assert.equal(commits.length, 2);
    assert.equal(commits[1][1].expectedHash, hash); assert.deepEqual(plain(commits[1][1].confirmation), { token: 'owned-receipt' });
    const confirmation = h.calls.find(([kind]) => kind === 'confirm')[1]; assert.equal(confirmation.sourceUri, file.sourceUri); assert.equal(confirmation.payloadHash, 'owned-payload-hash');
    assert.equal(h.calls.find(([kind]) => kind === 'confirmationPort')[1], 7); assert.equal(h.calls.filter(([kind]) => kind === entry[2]).length, 1);
  });
  test(`${entry[0]} refuses game/staging boundaries without acquiring sender confirmation`, async () => {
    for (const options of [{ gameFailure: { ok: false, changedFiles: [], diagnostics: [{ code: 'OWNED_GAME_REFUSED' }] } },
      { stageDiagnostics: [{ severity: 'error', code: 'OWNED_STAGE_REFUSED', message: 'owned' }] }, { session: null }]) {
      const h = harness(options); const result = await h.write(entry); assert.equal(result.ok, false);
      assert.equal(h.calls.some(([kind]) => kind === 'confirmationPort' || kind === 'candidate' || kind === 'commit'), false);
    }
  });
}
test('writer failure, rejected confirmation and commit failure do not rerun native staging or replay writes', async () => {
  for (const options of [{ writerOk: false }, { requiresConfirmation: true, cancel: true }, { commitOk: false }]) {
    const h = harness(options); const result = await h.write(writes[0]); assert.equal(result.ok, false);
    assert.equal(h.calls.filter(([kind]) => kind === 'commitFlverMutationViaBridge').length, 1);
    assert.equal(h.calls.filter(([kind]) => kind === 'commit').length, options.writerOk === false ? 0 : 1);
  }
});
test('ANIBND TAE mutations bind exact child indexes and aggregate hash to the physical outer commit hash', async () => {
  const h = harness({ file: { absolutePath: ownedPath('mod/chr/c1020.anibnd.dcx'), relativePath: 'chr/c1020.anibnd.dcx' } });
  const mutations = [{ ...writes[5][1][0], taeEntryIndex: 9, taeEntryId: 33, taeEntryName: 'a00.tae', taeGroup: 'a00' }];
  const result = await h.invoke('commitTaeEvent', file.sourceUri, hash, mutations); assert.equal(result.ok, true);
  const read = h.calls.find(([kind]) => kind === 'bridge')[1]; assert.deepEqual(plain(read.commandOptions), { animationPage: 0, animationPageSize: 1 });
  const writer = h.calls.find(([kind]) => kind === 'commitTaeEventContainerViaBridge')[1];
  assert.equal(writer.expectedDocumentHash, outerHash); assert.equal(writer.taeEntryIndex, 9); assert.deepEqual(plain(writer.mutations), mutations);
  const commit = h.calls.find(([kind]) => kind === 'commit')[1]; assert.equal(commit.expectedHash, outerHash); assert.equal(commit.file.sha256, outerHash);
});
test('missing/stale aggregate identity and invalid child selectors cannot reach TAE staging or confirmation', async () => {
  const anibnd = { absolutePath: ownedPath('mod/chr/c1020.anibnd.dcx'), relativePath: 'chr/c1020.anibnd.dcx' };
  for (const [options, mutations, code] of [
    [{ file: anibnd }, writes[5][1], 'TAE_CONTAINER_ENTRY_REQUIRED'],
    [{ file: anibnd, bridge: async () => ({ parseStatus: 'partial', diagnostics: [], data: { sourceHash: hash } }) }, [{ ...writes[5][1][0], taeEntryIndex: 9 }], 'TAE_CONTAINER_HASH_UNAVAILABLE'],
    [{ file: anibnd, bridge: async () => ({ parseStatus: 'partial', diagnostics: [], data: { sourceHash: 'stale', outerFileHash: outerHash } }) }, [{ ...writes[5][1][0], taeEntryIndex: 9 }], 'TAE_SOURCE_VERSION_STALE'],
    [{}, [{ ...writes[5][1][0], taeEntryIndex: 9 }], 'TAE_LOOSE_ENTRY_SELECTOR_INVALID']
  ]) {
    const h = harness(options); assert.equal((await h.invoke('commitTaeEvent', file.sourceUri, hash, mutations)).diagnostics[0].code, code);
    assert.equal(h.calls.some(([kind]) => kind === 'stageRoots' || kind === 'confirmationPort' || kind === 'candidate'), false);
  }
});
test('GPARAM backup and unsupported KRAK/source-hash failures retain actionable bounded diagnostics', async () => {
  const backup = harness({ file: { relativePath: 'asset.gparam.BAK' } }); assert.equal((await backup.invoke('readGparamDocument', file.sourceUri)).diagnostics[0].code, 'BACKUP_READ_FORBIDDEN'); assert.deepEqual(backup.calls, []);
  const failed = harness({ bridge: async () => ({ parseStatus: 'failed', data: null, diagnostics: [{ severity: 'error', code: 'OODLE_RUNTIME_MISSING', message: 'C:\\private\\path KRAK' }] }) });
  const result = await failed.invoke('readGparamDocument', file.sourceUri); assert.equal(result.ok, false); assert.equal(result.diagnostics[0].code, 'GPARAM_KRAK_OODLE_REQUIRED');
  assert.ok(result.diagnostics[0].message.includes('只读原版')); assert.equal(JSON.stringify(result).includes('private'), false);
});

test('native mutation service is independently callable through explicit ports and receives no Electron event or registrar', async () => {
  const h = harness(); const { createAssetMutationService } = h.load(sourcePath('services/assetMutationService.ts'));
  const ports = {
    get indexedFiles() { return h.deps.indexedFiles; }, get activeSession() { return h.deps.activeSession; },
    verifiedStageRoots: h.deps.verifiedStageRoots, durableStoragePaths: h.deps.durableStoragePaths,
    rejectNonSekiroNativeWrite: h.deps.rejectNonSekiroNativeWrite, ensureActiveOperationLog: h.deps.ensureActiveOperationLog,
    sessionCommitPort: h.deps.sessionCommitPort, toSaveResultFromOutcome: h.deps.toSaveResultFromOutcome
  };
  const service = createAssetMutationService(ports);
  assert.deepEqual(Object.keys(service), writes.map(([name]) => name)); assert.equal(Object.isFrozen(service), true);
  assert.equal('handle' in ports, false); assert.equal('electronConfirmationPort' in ports, false);
  let confirmationCalls = 0;
  const result = await service.applyFlverMutation(() => { confirmationCalls++; return { requestConfirmation: async () => null }; }, file.sourceUri, hash, writes[0][1]);
  assert.equal(result.ok, true); assert.equal(confirmationCalls, 1); assert.equal(h.calls.some(([kind]) => kind === 'confirmationPort'), false);
  h.switchSession(null);
  assert.equal((await service.applyFlverMutation(() => { throw new Error('must remain lazy'); }, file.sourceUri, hash, writes[0][1])).ok, false);
});

test('existing backup and typed-mutation guards stay in the actual native mutation operations', async () => {
  for (const entry of writes.slice(2)) {
    const h = harness({ file: { relativePath: 'asset.native.prev' } }); assert.equal((await h.write(entry)).diagnostics[0].code, 'BACKUP_READ_FORBIDDEN');
    assert.equal(h.calls.some(([kind]) => kind === 'stageRoots' || kind === 'candidate' || kind === 'confirmationPort'), false);
  }
  for (const [name, invalid, code] of [
    ['commitGparamMutations', [], 'GPARAM_MUTATIONS_REQUIRED'], ['commitMtdPropertySet', { paramId: '' }, 'MTD_PROPERTY_SET_REQUIRED'],
    ['commitEsdTransition', [], 'ESD_TRANSITION_MUTATIONS_REQUIRED'], ['commitTaeEvent', [], 'TAE_EVENT_MUTATIONS_REQUIRED'],
    ['commitFxrFieldSet', [], 'FXR_FIELD_SET_MUTATIONS_REQUIRED']
  ]) {
    const h = harness(); assert.equal((await h.invoke(name, file.sourceUri, hash, invalid)).diagnostics[0].code, code);
    assert.equal(h.calls.some(([kind]) => kind === 'stageRoots' || kind === 'candidate' || kind === 'confirmationPort'), false);
  }
});
