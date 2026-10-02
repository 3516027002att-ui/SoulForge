// Actual MAP transport/domain execution with native, filesystem and commit
// ports replaced. No Electron/Bridge process or game corpus is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adapterPath = path.join(root, 'apps/desktop/src/main/ipc/map.ts');
const servicePath = path.join(root, 'apps/desktop/src/main/services/mapService.ts');
const channels = ['resource.readMsbDocument', 'resource.readMapModelSource', 'resource.readMapPartMesh',
  'resource.readMapStaticGeometry', 'resource.cancelMapStaticGeometry', 'resource.applyMsbMutation', 'resource.executeMapTransaction'];
const hash = 'a'.repeat(64);
const session = { meta: { workspaceId: 'owned-workspace', game: 'sekiro' }, layers: { overlayRoot: '/owned/mod', baseRoot: null } };
const msb = { sourceUri: 'resource://owned/map', relativePath: 'map/MapStudio/m10_00_00_00.msb', absolutePath: '/owned/mod/map/MapStudio/m10_00_00_00.msb', game: 'sekiro', sha256: hash };
const model = { sourceUri: 'resource://owned/model', relativePath: 'map/m10_00_00_00/m10_00_00_00_000001.mapbnd.dcx', absolutePath: '/owned/mod/map/m10_00_00_00/m10_00_00_00_000001.mapbnd.dcx' };
const plain = value => JSON.parse(JSON.stringify(value));
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

function harness(options = {}) {
  const calls = [], handlers = new Map(), cache = new Map(), owners = new Map();
  let files = options.files ?? [msb, model], activeSession = options.session === undefined ? session : options.session;
  let revision = 1, generation = 1;
  const core = {
    BRIDGE_TRANSPORT_TIMING_CODE: 'BRIDGE_TRANSPORT_TIMINGS',
    runBridge: async input => {
      calls.push(['bridge', input]);
      if (options.bridge) return options.bridge(input);
      return { parseStatus: options.parseStatus ?? 'partial', sourceUri: msb.sourceUri,
        diagnostics: options.diagnostics ?? [], data: options.data === undefined
          ? { sessionToken: 'native-owned-token', nextCursor: null, complete: true, chunks: [], sourceHash: hash } : options.data };
    },
    readMsbDocumentViaBridge: async input => { calls.push(['msbRead', plain(input)]); return {
      ok: true, diagnostics: [], data: { sourceHash: hash, modelCount: 1, partCount: 1, regionCount: 0, eventCount: 0,
        routeCount: 0, models: [], parts: [], regions: [], events: [], routes: [], absolutePath: 'PRIVATE' }
    }; },
    mapExportFromMsbDocument: input => { calls.push(['mapExport', plain(input)]); return input; },
    ingestBridgeResult: (_index, input) => calls.push(['ingest', plain(input)]),
    nativeEditSessionFromContext: input => { calls.push(['nativeEdit', input]); return {
      indexFile: async () => { calls.push(['indexFile']); return { ...msb, sha256: 'b'.repeat(64), mtimeMs: 2 }; }
    }; },
    loadMapDocument: async () => { calls.push(['loadMap']); return { ok: true, doc: { mapId: 'm10_00_00_00', revision: hash } }; },
    executeMapTransaction: async (_edit, _file, transaction) => { calls.push(['transaction', plain(transaction)]); return options.transactionResult ?? { ok: true, committed: true }; }
  };
  const shared = {
    maskPathFragments: value => value,
    isCharacterPreviewBundle: value => load(path.join(root, 'packages/shared/src/flver-preview.ts')).isCharacterPreviewBundle(value)
  };
  const action = {
    characterTexturePackagePaths: () => [],
    assembleC0000CompatibilityPreview: async () => { throw new Error('unexpected character compatibility'); }
  };
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename);
    const source = fs.readFileSync(filename, 'utf8');
    const built = ts.transpileModule(source, { fileName: filename, reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
    assert.deepEqual((built.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error), []);
    const exports = {}; cache.set(filename, exports);
    vm.runInNewContext(built.outputText, { exports, module: { exports }, process, Buffer, console, performance,
      AbortController, setTimeout, clearTimeout, require(name) {
        if (name === 'node:fs') return { existsSync: () => false, statSync: () => ({ mtimeMs: 1 }),
          readdirSync: () => { if (options.directoryError) throw Object.assign(new Error('owned directory error'), { code: 'EACCES' }); return [path.basename(model.absolutePath)]; } };
        if (name.startsWith('node:')) return require(name);
        if (name === '@soulforge/core') return core;
        if (name === '@soulforge/shared') return shared;
        if (name.endsWith('/action.js') || name === './action.js') {
          assert.ok(!filename.includes(`${path.sep}services${path.sep}`), 'MAP services receive character helper ports, not IPC registrars');
          return action;
        }
        if (name === 'electron') throw new Error('MAP domain/adapter must have no Electron runtime import');
        if (name.startsWith('.')) return load(path.resolve(path.dirname(filename), name.replace(/\.js$/, '.ts')));
        throw new Error(`Unexpected MAP import ${name}`);
      }
    }, { filename });
    return exports;
  }
  Object.assign(shared, load(path.join(root, 'packages/shared/src/path-sanitizer.ts')));
  const adapter = load(adapterPath);
  const deps = {
    handle: (name, listener) => handlers.set(name, (...args) => {
      if (options.deny) throw new Error('IPC_UNTRUSTED_SENDER'); return listener(...args);
    }),
    get indexedFiles() { return files; }, get indexedFilesRevision() { return revision; },
    get indexedFilesIdentityDigest() { return `owned-${revision}`; }, get activeSession() { return activeSession; },
    activeIndex: {}, activeWorkspaceSessionId: 'owned-session', get activeWorkspaceSessionGeneration() { return generation; },
    safeExists: value => value.startsWith('/owned/mod/map/') || files.some(file => file.absolutePath === value),
    asBasicDiagnostics: value => value,
    verifiedReadRoots: async () => { calls.push(['roots']); return { allowedRoots: ['/owned/mod'], diagnostics: options.rootDiagnostics ?? [] }; },
    rejectNonSekiroNativeWrite: () => options.gameFailure ?? null,
    durableStoragePaths: () => ({ root: '/owned/storage', backupBaseDir: '/owned/backups', recoveryDir: '/owned/recovery', stagingRoot: '/owned/staging' }),
    ensureActiveOperationLog: async () => { calls.push(['operationLog']); return {}; },
    electronConfirmationPort: event => { calls.push(['confirmation', event.sender.id]); return { owned: true }; },
    refreshActiveIndexAfterNativeWrite: async (...args) => {
      calls.push(['refresh', ...args]);
      if (options.refreshError) throw options.refreshError;
    },
    replaceIndexedFile: (uri, file) => { calls.push(['replace', uri, file]); return true; }
  };
  adapter.registerMapIpcHandlers(deps);
  const event = id => {
    if (!owners.has(id)) {
      const listeners = new Map();
      const sender = { id, once(name, listener) { listeners.set(name, listener); }, removeListener(name) { listeners.delete(name); } };
      owners.set(id, { sender, listeners });
    }
    return { sender: owners.get(id).sender };
  };
  return { calls, handlers, owners, load, deps, action, adapter,
    invoke: (channel, ...args) => handlers.get(channel)(event(1), ...args),
    invokeAs: (id, channel, ...args) => handlers.get(channel)(event(id), ...args),
    switchFiles(value) { files = value; revision++; }, switchSession(value) { activeSession = value; generation++; }
  };
}

test('MAP transport delegates business work to callable services and retains request ownership', () => {
  assert.equal(fs.existsSync(servicePath), true, 'MAP application service must exist below IPC');
  const source = fs.readFileSync(adapterPath, 'utf8');
  assert.doesNotMatch(source, /runBridge\(|readMsbDocumentViaBridge\(|executeMapTransaction\(nativeEdit|mapCharacterPageSessions/);
  assert.match(source, /MapRequestCancellationRegistry/); assert.match(source, /withMapRequestCancellation/);
});

test('all seven current MAP channels register in their original order', () => {
  assert.deepEqual([...harness().handlers.keys()], channels);
});

test('trusted registrar refusal prevents reads and write confirmation', async () => {
  const h = harness({ deny: true }); await assert.rejects(async () => h.invoke(channels[0], msb.sourceUri), /IPC_UNTRUSTED_SENDER/);
  assert.deepEqual(h.calls, []);
});

test('unindexed MSB and unavailable static-read session refuse native work', async () => {
  const h = harness({ files: [] }); assert.equal((await h.invoke(channels[0], msb.sourceUri)).diagnostics[0].code, 'RESOURCE_NOT_INDEXED');
  assert.equal((await h.invoke(channels[3], msb.sourceUri, 'm000001')).diagnostics[0].code, 'MAP_PART_MSB_NOT_INDEXED'); assert.deepEqual(h.calls, []);
});

test('native MSB read preserves hash/root options and logical renderer projection', async () => {
  const h = harness(); const result = await h.invoke(channels[0], msb.sourceUri);
  assert.equal(result.ok, true); assert.equal(result.data.sourceHash, hash); assert.equal('absolutePath' in result.data, false);
  assert.deepEqual(h.calls[1], ['msbRead', { sourcePath: msb.absolutePath, allowedRoots: ['/owned/mod'] }]);
  assert.equal(h.calls.find(([name]) => name === 'ingest')[1].sourcePath, msb.relativePath);
});

test('verified-root rejection prevents native static reads', async () => {
  const h = harness({ rootDiagnostics: [{ severity: 'error', code: 'OWNED_ROOT_REFUSED', message: 'owned' }] });
  assert.equal((await h.invoke(channels[3], msb.sourceUri, 'm000001')).diagnostics[0].code, 'OWNED_ROOT_REFUSED');
  assert.equal(h.calls.filter(([name]) => name === 'bridge').length, 0);
});

test('native static paging preserves cursor/session/workspace scope and existing budgets', async () => {
  const h = harness(); const result = await h.invoke(channels[3], msb.sourceUri, 'm000001', 'owned-cursor', 'owned-token', 'owned-request');
  assert.equal(result.ok, true); const input = h.calls.find(([name]) => name === 'bridge')[1];
  assert.equal(input.command, 'read-map-static-geometry'); assert.equal(input.filePath, model.absolutePath);
  assert.equal(input.timeoutMs, 120000); assert.equal(input.maxConcurrency, 8); assert.equal(input.maxFrameBytes, undefined);
  assert.equal(input.workspaceSessionId, 'owned-session'); assert.deepEqual(plain(input.allowedRoots), ['/owned/mod']);
  assert.equal(input.commandOptions.cursor, 'owned-cursor'); assert.equal(input.commandOptions.sessionToken, 'owned-token');
  assert.equal(input.commandOptions.ownerLeaseId, 'owned-session'); assert.equal(input.signal.aborted, false);
});

test('independently callable MAP services own their verified-root caches without transport capabilities', async () => {
  const h = harness(); const { createMapService } = h.load(servicePath);
  const { handle: _handle, electronConfirmationPort: _confirmation, ...domain } = h.deps;
  const first = createMapService({ ...domain, ...h.action }), second = createMapService({ ...domain, ...h.action });
  assert.equal(Object.isFrozen(first), true); assert.equal('handle' in first, false); assert.equal('cancelMapStaticGeometry' in first, false);
  await first.readMsbDocument(msb.sourceUri); await first.readMsbDocument(msb.sourceUri);
  assert.equal(h.calls.filter(([name]) => name === 'roots').length, 1);
  await second.readMsbDocument(msb.sourceUri);
  assert.equal(h.calls.filter(([name]) => name === 'roots').length, 2);
});

test('character geometry reuses its bounded derived page and rejects a foreign resource binding', async () => {
  const chr = { sourceUri: 'resource://owned/character', relativePath: 'chr/c1000.chrbnd.dcx', absolutePath: '/owned/mod/chr/c1000.chrbnd.dcx' };
  const bundle = { meshCount: 1, vertexCount: 3, boneCount: 0, leaderModelId: 'c1000', models: [{ modelId: 'c1000', meshCount: 1, boneCount: 0,
    entry: { index: 0, id: 1, duplicateOrdinal: 0, name: 'owned.flver', contentHash: hash }, bones: [], meshes: [{ meshIndex: 0,
      vertexCount: 3, indexSize: 16, positionsBase64: Buffer.alloc(36).toString('base64'), indicesBase64: 'AAABAAIA', skinningMode: 'static', boneIndexSpace: 'none' }] }] };
  const other = { ...msb, sourceUri: 'resource://owned/other-map' };
  const h = harness({ files: [msb, chr, other], data: bundle });
  const first = await h.invoke(channels[3], msb.sourceUri, 'c1000');
  assert.equal(first.ok, true); assert.equal(first.data.chunks.length, 1);
  const token = first.data.sessionToken;
  const again = await h.invoke(channels[3], msb.sourceUri, 'c1000', null, token);
  assert.equal(again.ok, true); assert.equal(again.data.chunks[0].positionsBase64, bundle.models[0].meshes[0].positionsBase64);
  const foreign = await h.invoke(channels[3], other.sourceUri, 'c1000', null, token);
  assert.equal(foreign.ok, false); assert.equal(foreign.diagnostics[0].code, 'MAP_CHARACTER_SESSION_EXPIRED');
  assert.equal(h.calls.filter(([name]) => name === 'bridge').length, 1);
});

test('character paging preserves chunk limits, invalid cursors, TTL and capacity boundaries', () => {
  const h = harness(); const { createMapCharacterPaging } = h.load(path.join(root, 'apps/desktop/src/main/services/mapCharacterPaging.ts'));
  const paging = createMapCharacterPaging();
  const chunks = paging.splitCharacterMapChunks([{ vertexCount: 24003, positionsBase64: Buffer.alloc(24003 * 12).toString('base64') }]);
  assert.equal(chunks.length, 2); assert.equal(chunks.every(chunk => chunk.vertexCount <= 24000), true);
  const now = Date.now();
  const makeSession = token => ({ token, sourceUri: msb.sourceUri, modelPath: 'owned', modelStem: 'owned', chunks: [], diagnostics: [], cursors: new Map(), lastAccessMs: now });
  const expired = { ...makeSession('expired'), lastAccessMs: now - 10 * 60000 - 1 };
  paging.mapCharacterPageSessions.set(expired.token, expired);
  for (let index = 0; index < 33; index++) paging.mapCharacterPageSessions.set(`owned-${index}`, makeSession(`owned-${index}`));
  paging.evictMapCharacterPageSessions(now);
  assert.equal(paging.mapCharacterPageSessions.has('expired'), false); assert.equal(paging.mapCharacterPageSessions.size, 32);
  assert.equal(paging.serveMapCharacterPage(makeSession('owned'), 'foreign-cursor').diagnostics[0].code, 'MAP_CHARACTER_CURSOR_INVALID');
});

test('native parse failures and malformed data cannot become successful or missing-model fallbacks', async () => {
  for (const options of [
    { parseStatus: 'failed', diagnostics: [{ severity: 'error', code: 'OWNED_NATIVE_PARSE_FAILED', message: 'owned' }] },
    { data: [] }
  ]) {
    const h = harness(options); const result = await h.invoke(channels[3], msb.sourceUri, 'm000001');
    assert.equal(result.ok, false); assert.notEqual(result.diagnostics[0].code, 'MAP_PART_MODEL_NOT_FOUND');
    assert.equal(h.calls.filter(([name]) => name === 'bridge').length, 1);
  }
});

test('static MAP projection fails closed at the unchanged eight-MiB wire budget', async () => {
  const h = harness({ data: { complete: true, chunks: [{ positionsBase64: 'A'.repeat(8 * 1024 * 1024) }] } });
  const result = await h.invoke(channels[3], msb.sourceUri, 'm000001');
  assert.equal(result.ok, false); assert.equal(result.diagnostics[0].code, 'MAP_STATIC_WIRE_BUDGET_EXCEEDED');
});

test('model/root cache identity changes with index replacement and workspace generation', async () => {
  const h = harness(); await h.invoke(channels[3], msb.sourceUri, 'm000001');
  h.switchFiles([msb, { ...model, absolutePath: '/owned/mod/replaced.mapbnd.dcx' }]);
  h.switchSession({ ...session }); await h.invoke(channels[3], msb.sourceUri, 'm000001');
  const reads = h.calls.filter(([name]) => name === 'bridge').map(([, input]) => input.filePath);
  assert.deepEqual(reads, [model.absolutePath, '/owned/mod/replaced.mapbnd.dcx']);
  assert.equal(h.calls.filter(([name]) => name === 'roots').length, 2);
});

test('request cancellation is owner-scoped and drops late native success', async () => {
  const gate = deferred(); const h = harness({ bridge: async input => {
    await gate.promise; return { parseStatus: 'partial', diagnostics: [], data: { chunks: [], complete: true } };
  } });
  const first = h.invokeAs(1, channels[3], msb.sourceUri, 'm000001', null, null, 'same-id');
  const second = h.invokeAs(2, channels[3], msb.sourceUri, 'm000001', null, null, 'same-id');
  await turn(); assert.equal((await h.invokeAs(1, channels[4], 'same-id')).status, 'cancelled');
  gate.resolve(); const [cancelled, complete] = await Promise.all([first, second]);
  assert.equal(cancelled.ok, false); assert.equal(cancelled.diagnostics[0].code, 'MAP_REQUEST_CANCELLED'); assert.equal(complete.ok, true);
  assert.equal(cancelled.diagnostics[0].details.cancellation.daemonTerminalObserved, false);
  assert.equal(cancelled.diagnostics[0].details.cancellation.nativeActiveWorkStopped, 'unverified');
  assert.equal(h.owners.get(1).listeners.size, 0); assert.equal(h.owners.get(2).listeners.size, 0);
});

test('transport correlates a native terminal receipt while keeping stopped-work claims unverified', async () => {
  const h = harness({ bridge: input => new Promise(resolve => input.signal.addEventListener('abort', () => {
    input.onCancellationTerminal({ requestId: 'owned-native-id', outcome: 'cancelled', requestPhase: 'command', cancelRequested: true, receivedAt: 'owned-time' });
    resolve({ parseStatus: 'failed', diagnostics: [], data: null });
  }, { once: true })) });
  const pending = h.invoke(channels[3], msb.sourceUri, 'm000001', null, null, 'owned-receipt'); await turn();
  await h.invoke(channels[4], 'owned-receipt'); const result = await pending;
  const evidence = result.diagnostics[0].details.cancellation;
  assert.equal(evidence.daemonTerminalObserved, true); assert.equal(evidence.nativeAbortObserved, true);
  assert.equal(evidence.nativeActiveWorkStopped, 'unverified'); assert.equal(evidence.daemonCancelRequested, 'unverified');
  assert.equal(evidence.terminalReceipts[0].ownerId, 1); assert.equal(evidence.terminalReceipts[0].requestId, 'owned-receipt');
  assert.equal(evidence.terminalReceipts[0].bridgeRequestId, 'owned-native-id');
});

test('duplicate/invalid request handles refuse work and preserve later independent requests', async () => {
  const gate = deferred(); const h = harness({ bridge: async () => { await gate.promise; return { parseStatus: 'partial', diagnostics: [], data: { complete: true, chunks: [] } }; } });
  const first = h.invoke(channels[3], msb.sourceUri, 'm000001', null, null, 'duplicate'); await turn();
  assert.equal((await h.invoke(channels[3], msb.sourceUri, 'm000001', null, null, 'duplicate')).diagnostics[0].code, 'MAP_REQUEST_DUPLICATE');
  assert.equal((await h.invoke(channels[3], msb.sourceUri, 'm000001', null, null, '')).diagnostics[0].code, 'MAP_REQUEST_ID_INVALID');
  gate.resolve(); await first;
  assert.equal((await h.invoke(channels[3], msb.sourceUri, 'm000001', null, null, 'duplicate')).ok, true);
});

test('legacy static calls stay signal-free and do not install request-owner listeners', async () => {
  const h = harness(); await h.invoke(channels[3], msb.sourceUri, 'm000001');
  assert.equal(h.calls.find(([name]) => name === 'bridge')[1].signal, undefined); assert.equal(h.owners.get(1).listeners.size, 0);
});

test('invalid native mutation identity is refused before confirmation or transaction', async () => {
  const h = harness(); const result = await h.invoke(channels[5], msb.sourceUri, hash, { kind: 'delete_part', family: 'part', nativeOffset: -1 });
  assert.equal(result.diagnostics[0].code, 'MSB_NATIVE_OFFSET_REQUIRED'); assert.deepEqual(h.calls, []);
});

test('MAP mutation keeps native offset/family, source revision and event-bound confirmation', async () => {
  const h = harness(); const result = await h.invoke(channels[5], msb.sourceUri, hash, { kind: 'delete_part', family: 'part', nativeOffset: 32 });
  assert.equal(result.ok, true);
  assert.deepEqual(h.calls.map(([name]) => name), ['operationLog', 'confirmation', 'nativeEdit', 'loadMap', 'transaction', 'refresh']);
  const transaction = h.calls.find(([name]) => name === 'transaction')[1];
  assert.equal(transaction.baseRevision, hash); assert.deepEqual(transaction.operations, [{ kind: 'delete', target: 'part:m10_00_00_00:offset-20' }]);
  assert.equal(h.calls.find(([name]) => name === 'confirmation')[1], 1);
});

test('explicit MAP transaction keeps its base revision and refreshes only a committed outcome', async () => {
  const h = harness({ transactionResult: { ok: true, committed: false } });
  const transaction = { id: 'owned', baseRevision: 'b'.repeat(64), operations: [], mapId: 'm10_00_00_00' };
  const result = await h.invoke(channels[6], msb.sourceUri, hash, transaction);
  assert.equal(result.ok, true); assert.deepEqual(plain(result.changedFiles), []); assert.equal(result.sourceHash, 'b'.repeat(64));
  assert.deepEqual(h.calls.find(([name]) => name === 'transaction')[1], transaction);
  assert.equal(h.calls.some(([name]) => name === 'refresh'), false);
});

for (const [channel, request] of [
  [channels[5], { kind: 'delete_part', family: 'part', nativeOffset: 32 }],
  [channels[6], { id: 'owned-receipt', baseRevision: hash, operations: [], mapId: 'm10_00_00_00' }]
]) {
  test(`${channel} retains the committed response when knowledge refresh rejects without replay`, async () => {
    const h = harness({ refreshError: new Error('owned refresh failure') });
    const result = await h.invoke(channel, msb.sourceUri, hash, request);
    assert.equal(result.ok, true);
    assert.deepEqual(plain(result.changedFiles), [msb.sourceUri]);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].severity, 'warning');
    assert.equal(result.diagnostics[0].code, 'POSTCOMMIT_REFRESH_FAILED');
    assert.equal(result.diagnostics[0].sourceUri, msb.sourceUri);
    assert.equal(h.calls.filter(([name]) => name === 'transaction').length, 1);
    assert.equal(h.calls.filter(([name]) => name === 'refresh').length, 1);
    if (channel === channels[6]) {
      assert.equal(result.sourceHash, 'b'.repeat(64));
      assert.equal(result.sourceRevision, 2);
    }
  });

  test(`${channel} does not run postcommit refresh for failed or uncommitted transactions`, async () => {
    for (const transactionResult of [
      { ok: false, committed: false, verification: 'failed', error: { code: 'OWNED_NATIVE_REFUSAL', message: 'owned' } },
      { ok: true, committed: false }
    ]) {
      const h = harness({ transactionResult, refreshError: new Error('must not run') });
      const result = await h.invoke(channel, msb.sourceUri, hash, request);
      assert.equal(result.ok, transactionResult.ok);
      assert.deepEqual(plain(result.changedFiles), []);
      assert.equal(h.calls.filter(([name]) => name === 'transaction').length, 1);
      assert.equal(h.calls.some(([name]) => name === 'refresh'), false);
    }
  });

  for (const physicalPath of ['C:\\Users\\owned\\private\\map.msb', '/home/owned/private/map.msb']) {
    test(`${channel} masks ${physicalPath.startsWith('C:') ? 'Windows' : 'POSIX'} refresh paths while preserving committed facts and error context`, async () => {
      const h = harness({ refreshError: new Error(`EACCES refresh reader denied '${physicalPath}'; retry needed`) });
      const result = await h.invoke(channel, msb.sourceUri, hash, request);
      assert.equal(result.ok, true); assert.deepEqual(plain(result.changedFiles), [msb.sourceUri]);
      assert.equal(result, h.calls.find(([name]) => name === 'refresh')[2], 'retain the original response object');
      const warning = JSON.stringify(result.diagnostics[0]);
      assert.equal(warning.includes(physicalPath), false); assert.equal(warning.includes(physicalPath.replaceAll('\\', '\\\\')), false);
      assert.ok(warning.includes('[本机路径已隐藏]')); assert.ok(warning.includes('EACCES refresh reader denied'));
      assert.ok(warning.includes('retry needed')); assert.equal(h.calls.filter(([name]) => name === 'transaction').length, 1);
      assert.equal(h.calls.filter(([name]) => name === 'refresh').length, 1);
    });
  }
}
