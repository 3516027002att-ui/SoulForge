// Execute the current ACTION callbacks/services with only native and filesystem
// boundaries replaced. Uses the actual identity cache, preview guard and remapper.
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
const adapterPath = path.join(root, 'apps/desktop/src/main/ipc/action.ts');
const servicePath = path.join(root, 'apps/desktop/src/main/services/actionService.ts');
const characterPath = path.join(root, 'apps/desktop/src/main/services/characterPreviewService.ts');
const channels = ['resource.readTaeDocument', 'resource.readTaeTemplateCatalog', 'resource.readTaeEventParams',
  'resource.readTaeChrbndPreview', 'resource.readTaeAnimationClip', 'resource.sampleTaeAnimationPose', 'resource.resolveChrbndPreview'];
const hash = 'a'.repeat(64);
const ownedPath = relative => path.resolve(path.sep, 'owned', relative);
const inside = (rootPath, candidate) => candidate.startsWith(`${rootPath}${path.sep}`);
const file = { sourceUri: 'resource://owned/action', absolutePath: ownedPath('mod/chr/c1020.anibnd.dcx'), relativePath: 'chr/c1020.anibnd.dcx', game: 'sekiro', sha256: hash, mtimeMs: 1 };
const selector = [9, 33, 'a00.tae', 'a00'];
const plain = value => JSON.parse(JSON.stringify(value));
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function model(id = 'leader') { return { modelId: id, entry: { index: 3, id: 99, name: `${id}.flver`, duplicateOrdinal: 1, contentHash: hash },
  meshCount: 0, boneCount: 1, meshes: [], bones: [{ index: 0, name: 'Root', parentIndex: -1, childIndex: -1, nextSiblingIndex: -1,
    hierarchyId: 'Root#0', translation: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], rotationOrder: 'XZY' }] }; }
function bundle(models = [model()]) { return { meshCount: 0, vertexCount: 0, boneCount: 1, leaderModelId: 'leader', models }; }

function harness(options = {}) {
  const calls = [], handlers = new Map(), cache = new Map();
  let files = options.files ?? [file], sourceRevision = 1, binderRevision = 1, sessionId = 'owned-session';
  const session = { layers: { overlayRoot: ownedPath('mod'), baseRoot: options.baseRoot ?? null },
    isOverlayPath: value => inside(ownedPath('mod'), value), isBasePath: value => inside(ownedPath('base'), value) };
  let activeSession = options.session === null ? null : session;
  const match = { sourceUri: 'action-binder://overlay/chr/c1020_a01.anibnd.dcx', sourcePath: 'chr/c1020_a01.anibnd.dcx',
    sourceLayer: 'overlay', sourceRevision: '10:1:1:1:1|not-indexed', entryIndex: 4, binderEntryId: 1_000_000_077, entryName: 'a000000077.hkx' };
  const index = {
    lookupTaeAnimation: () => options.indexedMotion === undefined ? null : { status: 'UNIQUE', sourceRevision, animation: { motionAnimId: options.indexedMotion } },
    isActionBinderMembershipReadyFor: () => options.membershipReady !== false,
    lookupActionBinderMembership: input => { calls.push(['membership', input]); return options.membership ?? { status: 'UNIQUE', match: options.match ?? match, diagnostics: [] }; }
  };
  const identity = input => ({ format: 'TAE_MOTION_IDENTITY', identityProjectionVersion: 2, sourceHash: hash,
    animId: input.commandOptions.animId, motionAnimId: 77, ...input.commandOptions });
  const core = {
    ingestBridgeResult: (_index, input) => calls.push(['ingest', input]),
    runBridge: async input => {
      calls.push(['bridge', input]);
      if (options.bridge) return options.bridge(input, { identity, switchSession: () => { activeSession = { ...session }; }, changeSource: () => sourceRevision++ });
      const data = input.command === 'read-tae-motion-identity' ? identity(input)
        : input.command === 'read-chrbnd-flver-preview' ? options.preview ?? bundle()
        : input.command === 'read-tae-document' ? { sourceHash: hash, animationCount: 2219, animationsTruncated: true,
          entries: [{ index: 9, id: 33, name: 'a00.tae', duplicateOrdinal: 2, contentHash: hash }], animations: [], eventTypes: [16], absolutePath: 'PRIVATE' }
        : input.command === 'read-tae-event-params' ? { eventTypeId: 16, parameterLength: 16, parameterDecodedSize: 12,
          fields: [{ index: 7, name: 'owned', offset: 8, size: 4, value: 42, rawValue: 42, assertValid: true }], tailHex: '0102', undecodedHex: '03' }
        : { sourceHash: hash, pose: 'native' };
      return { parseStatus: 'partial', diagnostics: [], data };
    }
  };
  const shared = { TAE_IDENTITY_PROJECTION_VERSION: 2, maskPathFragments: value => value };
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename);
    const source = fs.readFileSync(filename, 'utf8');
    const built = ts.transpileModule(source, { fileName: filename, reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
    assert.deepEqual((built.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error), []);
    const exports = {}; cache.set(filename, exports);
    vm.runInNewContext(built.outputText, { exports, module: { exports }, process, Buffer, console, AbortController,
      require(name) {
        if (name === 'node:fs') return { existsSync: value => (options.existing ?? []).includes(path.resolve(value)) };
        if (name === 'node:fs/promises') return {
          lstat: async value => { calls.push(['stat', value]); if (options.statError) throw options.statError;
            const revision = value === file.absolutePath ? sourceRevision : binderRevision;
            return { isFile: () => options.regular !== false, isSymbolicLink: () => options.symlink === true,
              size: 10, mtimeMs: revision, ctimeMs: revision, dev: 1, ino: 1 }; },
          readdir: async value => { calls.push(['directory', value]); if (options.directoryError) throw options.directoryError;
            return (options.directories?.[value] ?? []).map(item => ({ name: typeof item === 'string' ? item : item.name,
              isFile: () => typeof item === 'string' || item.regular !== false, isSymbolicLink: () => item.symlink === true })); }
        };
        if (name.startsWith('node:')) return require(name);
        if (name === '@soulforge/core') return core;
        if (name === '@soulforge/shared') return shared;
        if (name.endsWith('/taeTemplateCatalog.js')) return { getTaeTemplateCatalog: () => ({ origin: 'first-party', package: 'owned', version: '1',
          contentDigest: hash, events: new Map([[16, { name: 'owned event' }]]), diagnostics: [] }) };
        if (name === 'electron') throw new Error('ACTION services and adapter must not import Electron at runtime');
        if (name.startsWith('.')) return load(path.resolve(path.dirname(filename), name.replace(/\.js$/, '.ts')));
        throw new Error(`Unexpected ACTION import ${name}`);
      }
    }, { filename });
    return exports;
  }
  Object.assign(core, load(path.join(root, 'packages/core/src/character/characterAssembly.ts')),
    load(path.join(root, 'packages/core/src/action/motionIdentityCache.ts')));
  Object.assign(shared, load(path.join(root, 'packages/shared/src/flver-preview.ts')));
  Object.assign(shared, load(path.join(root, 'packages/shared/src/animation-editor.ts')));
  const adapter = load(adapterPath);
  const deps = {
    handle: (name, callback) => handlers.set(name, (...args) => { if (options.deny) throw new Error('IPC_UNTRUSTED_SENDER'); return callback(...args); }),
    get indexedFiles() { return files; }, get activeSession() { return activeSession; }, activeIndex: index,
    get activeWorkspaceSessionId() { return sessionId; },
    safeExists: value => (options.existing ?? []).includes(path.resolve(value)), asBasicDiagnostics: value => value,
    verifiedReadRoots: async () => { calls.push(['roots']); if (options.roots) await options.roots(); return { allowedRoots: [ownedPath('mod')], diagnostics: options.rootDiagnostics ?? [] }; },
    ensureActionBinderMembershipForFamily: async family => { calls.push(['ensureMembership', family]); await options.ensureMembership?.(); },
    waitForWorkspaceIndexing: async () => { calls.push(['waitIndex']); }
  };
  adapter.registerActionIpcHandlers(deps);
  return { calls, handlers, adapter, deps, load, session, identity,
    invoke: (channel, ...args) => handlers.get(channel)({ sender: { id: 1 } }, ...args),
    clip: () => handlers.get(channels[4])({}, file.sourceUri, 42, ['Root'], [-1], [], ...selector),
    pose: () => handlers.get(channels[5])({}, file.sourceUri, 42, 1.25, ['Root'], false, [-1], [], ...selector),
    changeSource() { sourceRevision++; }, changeBinder() { binderRevision++; }, switchFiles(value) { files = value; },
    switchSession() { activeSession = { ...session }; sessionId = 'new-session'; }
  };
}

test('ACTION transport delegates all current business callbacks to independent application services', () => {
  assert.equal(fs.existsSync(servicePath), true); assert.equal(fs.existsSync(characterPath), true);
  const source = fs.readFileSync(adapterPath, 'utf8');
  assert.doesNotMatch(source, /runBridge\(|new ActionMotionIdentityCache|readActionFileRevision\(|remapCharacterBundleToLeader\(/);
  assert.match(source, /TrustedIpcHandle/);
});
test('all seven ACTION read channels retain their original order and trusted refusal', async () => {
  const h = harness({ deny: true }); assert.deepEqual([...h.handlers.keys()], channels);
  await assert.rejects(async () => h.invoke(channels[0], file.sourceUri), /IPC_UNTRUSTED_SENDER/); assert.deepEqual(h.calls, []);
});
test('TAE document keeps bounded native count, physical entry identities, hash and renderer-safe projection', async () => {
  const h = harness(); const result = await h.invoke(channels[0], file.sourceUri);
  assert.equal(result.ok, true); assert.equal(result.data.animationCount, 2219); assert.equal(result.data.sourceHash, hash);
  assert.deepEqual(plain(result.data.entries), [{ index: 9, id: 33, name: 'a00.tae', duplicateOrdinal: 2, contentHash: hash }]);
  assert.equal('absolutePath' in result.data, false); assert.deepEqual(plain(h.calls.find(([name]) => name === 'bridge')[1].commandOptions), { animationPage: 0, animationPageSize: 64 });
  assert.equal(h.calls.filter(([name]) => name === 'ingest').length, 1);
  await h.invoke(channels[0], file.sourceUri, { animationPage: 3.7, animationPageSize: 20.2 });
  assert.deepEqual(plain(h.calls.filter(([name]) => name === 'bridge')[1][1].commandOptions), { animationPage: 3, animationPageSize: 20 });
});
test('TAE catalog and event parameters preserve current field offsets, lengths and child selector', async () => {
  const h = harness(); assert.equal((await h.invoke(channels[1])).origin, 'first-party');
  const result = await h.invoke(channels[2], file.sourceUri, 42, 7, ...selector);
  assert.equal(result.data.parameterLength, 16); assert.equal(result.data.parameterDecodedSize, 12); assert.equal(result.data.fields[0].index, 7);
  assert.equal(result.data.fields[0].offset, 8); assert.equal(result.data.tailHex, '0102');
  assert.deepEqual(plain(h.calls.find(([name]) => name === 'bridge')[1].commandOptions), { animId: 42, eventIndex: 7, taeEntryIndex: 9, taeEntryId: 33, taeEntryName: 'a00.tae', taeGroup: 'a00' });
});
test('unindexed sources and denied roots stop native reads', async () => {
  const absent = harness({ files: [] }); assert.equal((await absent.clip()).diagnostics[0].code, 'RESOURCE_NOT_INDEXED'); assert.deepEqual(absent.calls, []);
  const denied = harness({ rootDiagnostics: [{ severity: 'error', code: 'OWNED_ROOT_REFUSED', message: 'owned' }] });
  assert.equal((await denied.invoke(channels[0], file.sourceUri)).diagnostics[0].code, 'OWNED_ROOT_REFUSED'); assert.equal(denied.calls.some(([name]) => name === 'bridge'), false);
});
test('clip and pose use exact child motion membership and retain native budgets/session/skeleton arguments', async () => {
  const h = harness(); assert.equal((await h.clip()).ok, true); assert.equal((await h.pose()).ok, true);
  const reads = h.calls.filter(([name]) => name === 'bridge').map(([, input]) => input);
  assert.deepEqual(reads.map(input => input.command), ['read-tae-motion-identity', 'read-tae-animation-clip', 'sample-tae-animation-pose']);
  assert.equal(reads[1].workspaceSessionId, 'owned-session'); assert.equal(reads[1].timeoutMs, 120000);
  assert.equal(reads[1].commandOptions.animationContainerPath, ownedPath('mod/chr/c1020_a01.anibnd.dcx'));
  assert.equal(reads[1].commandOptions.skeletonContainerPath, file.absolutePath);
  assert.equal(reads[1].commandOptions.taeEntryIndex, 9); assert.equal(reads[1].commandOptions.taeEntryId, 33);
  assert.equal(reads[2].commandOptions.timeSeconds, 1.25); assert.equal(reads[2].commandOptions.loop, false);
  assert.equal(h.calls.find(([name]) => name === 'membership')[1].binderEntryId, 1_000_000_077);
  assert.equal(h.calls.some(([name]) => name === 'directory' || name === 'ingest'), false);
});
test('motion cache is scoped to native source revision, selector and workspace lifetime', async () => {
  const h = harness(); await h.clip(); await h.clip(); assert.equal(h.calls.filter(([, input]) => input?.command === 'read-tae-motion-identity').length, 1);
  h.changeSource(); await h.clip(); h.switchSession(); await h.clip();
  assert.equal(h.calls.filter(([, input]) => input?.command === 'read-tae-motion-identity').length, 3);
  await h.invoke(channels[4], file.sourceUri, 42, undefined, undefined, undefined, 10, 33, 'a00.tae', 'a00');
  assert.equal(h.calls.filter(([, input]) => input?.command === 'read-tae-motion-identity').length, 4);
});
test('missing hash, mismatched child and invalid native motion identity cannot fall back to selected animId', async () => {
  for (const patch of [{ sourceHash: '' }, { taeEntryId: 34 }, { motionAnimId: 1_000_000_000 }, { identityProjectionVersion: 1 }]) {
    const h = harness({ bridge: async (input, ctx) => ({ parseStatus: 'partial', diagnostics: [], data: { ...ctx.identity(input), ...patch } }) });
    assert.equal((await h.clip()).diagnostics[0].code, 'TAE_MOTION_IDENTITY_UNRESOLVED');
    assert.equal(h.calls.some(([name]) => name === 'membership' || name === 'ingest'), false);
  }
});
test('HKX unsupported diagnostics stay authoritative without clip replay', async () => {
  const h = harness({ bridge: async (input, ctx) => input.command === 'read-tae-motion-identity'
    ? { parseStatus: 'partial', diagnostics: [], data: ctx.identity(input) }
    : { parseStatus: 'failed', data: null, diagnostics: [{ severity: 'error', code: 'HKX_ANIMATION_TYPE_UNSUPPORTED', message: 'owned unsupported' }] } });
  const result = await h.clip(); assert.equal(result.ok, false); assert.ok(result.diagnostics.some(d => d.code === 'HKX_ANIMATION_TYPE_UNSUPPORTED'));
  assert.equal(h.calls.filter(([name]) => name === 'bridge').length, 2);
});
test('session changes during native motion and clip reads discard stale success', async () => {
  for (const stop of ['read-tae-motion-identity', 'read-tae-animation-clip']) {
    const h = harness({ bridge: async (input, ctx) => { if (input.command === stop) ctx.switchSession(); return { parseStatus: 'partial', diagnostics: [], data: input.command === 'read-tae-motion-identity' ? ctx.identity(input) : {} }; } });
    assert.equal((await h.clip()).diagnostics[0].code, 'ACTION_WORKSPACE_SESSION_CHANGED');
  }
});
test('changed physical TAE and binder revisions cannot reuse stale membership', async () => {
  const gate = deferred(); const h = harness({ bridge: async (input, ctx) => { if (input.command === 'read-tae-animation-clip') { await gate.promise; ctx.changeSource(); } return { parseStatus: 'partial', diagnostics: [], data: input.command === 'read-tae-motion-identity' ? ctx.identity(input) : {} }; } });
  const pending = h.clip(); await turn(); gate.resolve(); assert.equal((await pending).diagnostics[0].code, 'ACTION_SOURCE_REVISION_CHANGED');
  const stale = harness(); stale.changeBinder(); assert.equal((await stale.clip()).diagnostics[0].code, 'ACTION_BINDER_SOURCE_REVISION_CHANGED');
});
test('malformed binder URI/path identity and unready membership refuse clip reads', async () => {
  const malformed = harness({ match: { sourcePath: '../outside.anibnd.dcx', sourceLayer: 'overlay', sourceRevision: 'x|y', sourceUri: 'forged' } });
  assert.equal((await malformed.clip()).diagnostics[0].code, 'ACTION_BINDER_MEMBERSHIP_INDEX_INVALID');
  const unready = harness({ membershipReady: false }); assert.equal((await unready.clip()).diagnostics[0].code, 'ACTION_BINDER_MEMBERSHIP_INDEX_NOT_READY');
  assert.equal(unready.calls.filter(([name]) => name === 'ensureMembership').length, 1);
  assert.equal(unready.calls.some(([name, input]) => name === 'bridge' && input.command === 'read-dcx-document'), false);
});
test('character preview preserves native physical identities and returns the original bundle without copying', async () => {
  const preview = bundle(); const h = harness({ preview, existing: [ownedPath('mod/chr/c1020.chrbnd.dcx')] });
  const result = await h.invoke(channels[3], file.sourceUri); assert.equal(result.ok, true); assert.equal(result.data, preview);
  assert.equal(result.data.models[0].entry.index, 3); assert.equal(result.data.models[0].entry.contentHash, hash);
  const input = h.calls.find(([name]) => name === 'bridge')[1]; assert.equal(input.command, 'read-chrbnd-flver-preview');
  assert.equal(input.commandOptions.maxVertices, 1_000_000); assert.equal(input.commandOptions.maxIndices, 3_000_000);
  assert.equal('compatibilityProjectionTextureName' in input.commandOptions, false);
});
test('invalid preview bundles and unavailable companion models retain explicit refusal diagnostics', async () => {
  const invalid = harness({ preview: {}, existing: [ownedPath('mod/chr/c1020.chrbnd.dcx')] });
  assert.equal((await invalid.invoke(channels[3], file.sourceUri)).diagnostics[0].code, 'CHRBND_PREVIEW_SCHEMA_INVALID');
  const missing = harness(); assert.equal((await missing.invoke(channels[3], file.sourceUri)).diagnostics[0].code, 'CHRBND_NOT_FOUND');
  assert.equal(missing.calls.some(([name]) => name === 'bridge'), false);
});
test('companion resolver keeps mounted-root precedence and logical identities', async () => {
  const h = harness({ existing: [ownedPath('mod/chr/c1020.chrbnd'), ownedPath('base/chr/c1020.chrbnd.dcx')], baseRoot: ownedPath('base') });
  assert.deepEqual(plain(await h.invoke(channels[6], file.sourceUri)), { ok: true, origin: 'overlay', chrbndSourceUri: 'chrbnd:chr/c1020.chrbnd' });
  assert.equal(h.calls.some(([name]) => name === 'bridge'), false);
});
test('MAP character support retains caller cancellation and native terminal observer without a second implementation', async () => {
  const h = harness(); const controller = new AbortController(); controller.abort();
  await assert.rejects(() => h.adapter.assembleC0000CompatibilityPreview({ leaderBundle: bundle(), overlayPartsDirectory: ownedPath('mod/parts'),
    basePartsDirectory: null, allowedRoots: [ownedPath('mod')], oodleRuntimeRoot: null, signal: controller.signal }), /MAP_REQUEST_CANCELLED/);
  assert.deepEqual(h.calls, []);
});

test('independently callable ACTION services isolate motion caches and receive no registrar capability', async () => {
  const h = harness(); const { createActionService } = h.load(servicePath);
  const ports = {
    get indexedFiles() { return h.deps.indexedFiles; }, get activeSession() { return h.deps.activeSession; },
    get activeIndex() { return h.deps.activeIndex; }, get activeWorkspaceSessionId() { return h.deps.activeWorkspaceSessionId; },
    verifiedReadRoots: h.deps.verifiedReadRoots, asBasicDiagnostics: h.deps.asBasicDiagnostics
  };
  const a = createActionService(ports), b = createActionService(ports);
  assert.deepEqual(Object.keys(a), ['readTaeDocument', 'readTaeTemplateCatalog', 'readTaeEventParams', 'readTaeAnimationClip', 'sampleTaeAnimationPose']);
  assert.equal(Object.isFrozen(a), true); assert.equal('handle' in ports, false);
  const select = service => service.readTaeAnimationClip(file.sourceUri, 42, undefined, undefined, undefined, ...selector);
  await select(a); await select(a); await select(b);
  assert.equal(h.calls.filter(([, input]) => input?.command === 'read-tae-motion-identity').length, 2);
  const character = h.load(characterPath);
  assert.equal(h.adapter.assembleC0000CompatibilityPreview, character.assembleC0000CompatibilityPreview);
  assert.equal(h.adapter.characterTexturePackagePaths, character.characterTexturePackagePaths);
});

test('membership missing/ambiguous outcomes and non-regular TAE resources stop clip/pose work', async () => {
  for (const [membership, code] of [
    [{ status: 'NOT_FOUND', diagnostics: [], consideredSources: [] }, 'ACTION_BINDER_MEMBERSHIP_NOT_FOUND'],
    [{ status: 'AMBIGUOUS', diagnostics: [], matches: [] }, 'ACTION_BINDER_MEMBERSHIP_AMBIGUOUS']
  ]) {
    const h = harness({ membership }); assert.equal((await h.pose()).diagnostics[0].code, code);
    assert.equal(h.calls.filter(([name]) => name === 'bridge').length, 1);
  }
  for (const property of [{ regular: false }, { symlink: true }]) {
    const h = harness(property); assert.equal((await h.clip()).diagnostics[0].code, 'ACTION_SOURCE_REVISION_UNAVAILABLE');
    assert.equal(h.calls.some(([name]) => name === 'bridge'), false);
  }
});

test('membership indexing retains deterministic physical entries, roots/session and bounded native fan-out', async () => {
  const h = harness({ directories: { [ownedPath('mod/chr')]: ['c1020_z.anibnd.dcx', 'c1020_a.anibnd.dcx'] },
    bridge: async () => ({ parseStatus: 'partial', diagnostics: [], data: { nested: { format: 'BND4', entries: [
      { index: 17, id: 1_000_000_077, name: 'a000000077.hkx', contentHash: hash }
    ] } } }) });
  const result = await h.adapter.buildActionBinderMembershipIndex({ session: h.session, sessionId: 'owned-index', effectiveBase: null,
    indexedFiles: [], allowedRoots: [ownedPath('mod')], characterFamilies: ['c1020'], readConcurrency: 2 });
  assert.equal(result.ok, true); assert.deepEqual(plain(result.candidates.map(c => c.source.sourcePath)), ['chr/c1020_a.anibnd.dcx', 'chr/c1020_z.anibnd.dcx']);
  assert.deepEqual(plain(result.candidates[0].entries), [{ entryId: 1_000_000_077, entryIndex: 17, entryName: 'a000000077.hkx' }]);
  for (const [, input] of h.calls.filter(([name]) => name === 'bridge')) {
    assert.equal(input.command, 'read-dcx-document'); assert.equal(input.maxConcurrency, 2); assert.equal(input.timeoutMs, 120000);
    assert.equal(input.workspaceSessionId, 'owned-index'); assert.deepEqual(plain(input.allowedRoots), [ownedPath('mod')]);
  }
});

test('malformed overlay binders retain shadow precedence and invalid native membership cannot be guessed', async () => {
  const shadow = harness({ baseRoot: ownedPath('base'), directories: {
    [ownedPath('mod/chr')]: [{ name: 'c1020_a.anibnd.dcx', symlink: true }], [ownedPath('base/chr')]: ['c1020_a.anibnd.dcx']
  } });
  const refused = await shadow.adapter.buildActionBinderMembershipIndex({ session: shadow.session, sessionId: 'owned', effectiveBase: ownedPath('base'),
    indexedFiles: [], allowedRoots: [ownedPath('mod'), ownedPath('base')] });
  assert.equal(refused.ok, false); assert.equal(refused.candidates.length, 0);
  assert.equal(refused.diagnostics[0].details.reason, 'symbolic-link'); assert.equal(shadow.calls.some(([name]) => name === 'bridge'), false);
  for (const data of [{ nested: { format: 'BND4', entries: [{ index: -1, id: 1, name: 'bad.hkx' }] } }, { nested: { format: 'BND3', entries: [] } }]) {
    const h = harness({ directories: { [ownedPath('mod/chr')]: ['c1020_a.anibnd.dcx'] }, bridge: async () => ({ parseStatus: 'partial', diagnostics: [], data }) });
    const result = await h.adapter.buildActionBinderMembershipIndex({ session: h.session, sessionId: 'owned', effectiveBase: null, indexedFiles: [], allowedRoots: [ownedPath('mod')] });
    assert.equal(result.ok, false); assert.equal(result.candidates.length, 0); assert.equal(result.diagnostics[0].code, 'ACTION_BINDER_MEMBERSHIP_READ_FAILED');
  }
});

test('shared compatibility reads forward the exact MAP signal/terminal observer and discard late native success', async () => {
  const gate = deferred(), controller = new AbortController(); const terminal = () => undefined;
  const h = harness({ directories: { [ownedPath('mod/parts')]: ['bd_m_9000.partsbnd.dcx'] },
    bridge: async () => { await gate.promise; return { parseStatus: 'partial', diagnostics: [], data: bundle() }; } });
  const pending = h.adapter.assembleC0000CompatibilityPreview({ leaderBundle: bundle(), overlayPartsDirectory: ownedPath('mod/parts'),
    basePartsDirectory: null, allowedRoots: [ownedPath('mod')], oodleRuntimeRoot: null, signal: controller.signal, onCancellationTerminal: terminal });
  await turn(); const input = h.calls.find(([name]) => name === 'bridge')[1];
  assert.equal(input.signal, controller.signal); assert.equal(input.onCancellationTerminal, terminal);
  controller.abort(); gate.resolve(); await assert.rejects(() => pending, /MAP_REQUEST_CANCELLED/);
  assert.equal(h.calls.filter(([name]) => name === 'bridge').length, 1);
});
