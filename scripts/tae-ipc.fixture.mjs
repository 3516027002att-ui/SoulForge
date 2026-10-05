import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { registerHooks } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

test('production TAE IPC defaults to a bounded animation page while retaining the native total and explicit page controls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-tae-ipc-'));
  const output = join(root, 'action-ipc.mjs'); const moduleUrl = pathToFileURL(output).href;
  const calls = [];
  globalThis[Symbol.for('sf.tae.ipc.fixture')] = async input => {
    calls.push(input);
    return { parseStatus: 'partial', diagnostics: [], data: { format: 'TAE', authority: 'first-party', sourceHash: 'native', animationCount: 2219, animationsTruncated: true, animations: [], eventTypes: [] } };
  };
  await build({ entryPoints: [resolve('apps/desktop/src/main/ipc/action.ts')], outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external', external: ['@soulforge/core', '@soulforge/shared'] });
  const coreUrl = pathToFileURL(resolve('packages/core/dist/index.js')).href;
  const hooks = registerHooks({
    resolve(specifier, context, next) { if (specifier === '@soulforge/core' && context.parentURL === moduleUrl) return { url: 'sf:tae-ipc-core', shortCircuit: true };
      return next(specifier, context.parentURL === moduleUrl && !specifier.startsWith('.') && !specifier.includes(':') ? { ...context, parentURL: import.meta.url } : context); },
    load(url, context, next) { return url === 'sf:tae-ipc-core' ? { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(coreUrl)}; export async function runBridge(input) { return globalThis[Symbol.for('sf.tae.ipc.fixture')](input); }` } : next(url, context); }
  });
  try {
    const { registerActionIpcHandlers } = await import(moduleUrl);
    const handlers = new Map(); const sourceUri = 'file://chr/c0000.anibnd.dcx';
    registerActionIpcHandlers({ handle: (name, fn) => handlers.set(name, fn), indexedFiles: [{ sourceUri, absolutePath: join(root, 'c0000.anibnd.dcx'), relativePath: 'chr/c0000.anibnd.dcx' }], activeSession: null, activeIndex: null, verifiedReadRoots: async () => ({ allowedRoots: [root], diagnostics: [] }) });
    const handler = handlers.get('resource.readTaeDocument');
    const initial = await handler({}, sourceUri);
    assert.ok(calls[0], JSON.stringify(initial));
    assert.deepEqual(calls[0].commandOptions, { animationPage: 0, animationPageSize: 64 });
    assert.equal(initial.data.animationCount, 2219, 'bounded output retains the independent native total');
    await handler({}, sourceUri, { animationPage: 3, animationPageSize: 20 });
    assert.deepEqual(calls[1].commandOptions, { animationPage: 3, animationPageSize: 20 });
  } finally { hooks.deregister(); delete globalThis[Symbol.for('sf.tae.ipc.fixture')]; await rm(root, { recursive: true, force: true }); }
});

async function withMotionIpcFixture(response, run) {
  const root = await mkdtemp(join(tmpdir(), 'sf-tae-motion-ipc-'));
  const output = join(root, 'action-ipc.mjs'); const moduleUrl = pathToFileURL(output).href;
  const calls = [];
  globalThis[Symbol.for('sf.tae.motion.ipc.fixture')] = async input => {
    calls.push(input);
    return response(input);
  };
  await build({ entryPoints: [resolve('apps/desktop/src/main/ipc/action.ts')], outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external', external: ['@soulforge/core', '@soulforge/shared'] });
  const coreUrl = pathToFileURL(resolve('packages/core/dist/index.js')).href;
  const hooks = registerHooks({
    resolve(specifier, context, next) { if (specifier === '@soulforge/core' && context.parentURL === moduleUrl) return { url: 'sf:tae-motion-ipc-core', shortCircuit: true };
      return next(specifier, context.parentURL === moduleUrl && !specifier.startsWith('.') && !specifier.includes(':') ? { ...context, parentURL: import.meta.url } : context); },
    load(url, context, next) { return url === 'sf:tae-motion-ipc-core' ? { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(coreUrl)}; export async function runBridge(input) { return globalThis[Symbol.for('sf.tae.motion.ipc.fixture')](input); }` } : next(url, context); }
  });
  try {
    const { registerActionIpcHandlers } = await import(moduleUrl);
    const { openWorkspaceSession, WorkspaceIndex } = await import(coreUrl);
    await mkdir(join(root, 'chr'));
    const sourceUri = 'file://chr/c0000.anibnd.dcx'; const source = join(root, 'chr/c0000.anibnd.dcx');
    await writeFile(source, 'read-only transport fixture');
    const session = await openWorkspaceSession({ overlayRoot: root, game: 'sekiro' });
    const index = new WorkspaceIndex(session.meta.workspaceId);
    const handlers = new Map();
    registerActionIpcHandlers({ handle: (name, fn) => handlers.set(name, fn), indexedFiles: [{ sourceUri, absolutePath: source, relativePath: 'chr/c0000.anibnd.dcx', game: 'sekiro' }], activeSession: session, activeWorkspaceSessionId: 'bounded-motion-fixture', activeIndex: index, verifiedReadRoots: async () => ({ allowedRoots: [root], diagnostics: [] }) });
    const select = () => handlers.get('resource.readTaeAnimationClip')({}, sourceUri, 42, undefined, undefined, undefined, 9, 33, 'a00.tae', 'a00');
    await run({ select, index, calls, source, sourceUri });
  } finally { hooks.deregister(); delete globalThis[Symbol.for('sf.tae.motion.ipc.fixture')]; await rm(root, { recursive: true, force: true }); }
}

test('clip identity fallback queries only the exact native animation and child before reading clip dependencies', async () => {
  await withMotionIpcFixture(() => ({ parseStatus: 'failed', diagnostics: [{ severity: 'error', code: 'FIXTURE_IDENTITY_STOP', message: 'Stop after observing the identity request.' }] }), async ({ select, calls, source, sourceUri }) => {
    const result = await select();
    assert.equal(result.ok, false, 'the fixture stops after the real IPC identity boundary');
    assert.equal(calls.length, 1, JSON.stringify(result));
    assert.equal(calls[0].command, 'read-tae-motion-identity', 'selection must not materialize the full TAE event envelope');
    assert.deepEqual(calls[0].commandOptions, { animId: 42, taeEntryIndex: 9, taeEntryId: 33, taeEntryName: 'a00.tae', taeGroup: 'a00' });
    assert.equal(calls[0].filePath, source);
    assert.equal(calls[0].resourceUri, sourceUri);
    assert.equal(calls[0].workspaceSessionId, 'bounded-motion-fixture');
  });
});

const scalarIdentity = { format: 'TAE_MOTION_IDENTITY', identityProjectionVersion: 2, sourceHash: 'native-snapshot', animId: 42, motionAnimId: 77, taeEntryIndex: 9, taeEntryId: 33, taeEntryName: 'a00.tae', taeGroup: 'a00' };

test('successful scalar identity preserves existing event projections and is cached only for the current source revision', async () => {
  await withMotionIpcFixture(() => ({ parseStatus: 'partial', diagnostics: [], data: scalarIdentity }), async ({ select, index, calls, source, sourceUri }) => {
    index.upsertTaeExport({ chrId: 'c0000', sourceUri, readerSchemaRevision: 2, animations: [{ animId: 42, code: 'A0042', events: [{ index: 0, eventTypeId: 16, startTime: 0, endTime: 1, startFrame: 0, endFrame: 30 }] }] });
    index.setActionBinderMembership([], ['c0000']);
    const before = structuredClone(index.toSymbolBundle().tae);
    const result = await select();
    assert.equal(result.ok, false); assert.equal(result.diagnostics[0].code, 'ACTION_BINDER_MEMBERSHIP_NOT_FOUND');
    assert.equal(result.diagnostics[0].details.motionAnimId, 77, 'membership uses native motion identity rather than the selected action ID 42');
    assert.deepEqual(index.toSymbolBundle().tae, before, 'scalar identity cannot replace event-index contents');
    await select(); assert.equal(calls.length, 1, 'same revision and selector reuse the identity cache');
    await writeFile(source, 'replacement with a different physical size and revision');
    await select(); assert.equal(calls.length, 2, 'source replacement requires a new native identity query');
    assert.deepEqual(index.toSymbolBundle().tae, before);
  });
});

test('clip identity rejects mismatched native child provenance before reading membership or clip data', async () => {
  await withMotionIpcFixture(() => ({ parseStatus: 'partial', diagnostics: [], data: { ...scalarIdentity, taeEntryId: 34 } }), async ({ select, index, calls }) => {
    index.setActionBinderMembership([], ['c0000']);
    const result = await select();
    assert.equal(result.ok, false); assert.equal(result.diagnostics[0].code, 'TAE_MOTION_IDENTITY_UNRESOLVED');
    assert.equal(calls.length, 1); assert.equal(calls[0].command, 'read-tae-motion-identity');
    assert.equal((index.toSymbolBundle().tae ?? []).length, 0);
  });
});

test('ANIBND commit hash preflight requests a bounded native page before any writer is reached', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-tae-commit-hash-')); const output = join(root, 'assets-ipc.mjs'); const moduleUrl = pathToFileURL(output).href;
  const calls = []; const symbol = Symbol.for('sf.tae.commit.hash');
  globalThis[symbol] = async input => { calls.push(input); return { parseStatus: 'failed', diagnostics: [{ severity: 'error', code: 'FIXTURE_STOP', message: 'Stop after hash read; do not reach any writer.' }] }; };
  await build({ entryPoints: [resolve('apps/desktop/src/main/ipc/assets.ts')], outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external', external: ['@soulforge/core', '@soulforge/shared'] });
  const coreUrl = pathToFileURL(resolve('packages/core/dist/index.js')).href;
  const hooks = registerHooks({
    resolve(specifier, context, next) { if (specifier === '@soulforge/core' && context.parentURL === moduleUrl) return { url: 'sf:tae-commit-hash-core', shortCircuit: true }; return next(specifier, context.parentURL === moduleUrl && !specifier.startsWith('.') && !specifier.includes(':') ? { ...context, parentURL: import.meta.url } : context); },
    load(url, context, next) { return url === 'sf:tae-commit-hash-core' ? { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(coreUrl)}; export async function runBridge(input) { return globalThis[Symbol.for('sf.tae.commit.hash')](input); }` } : next(url, context); }
  });
  try {
    const { registerAssetIpcHandlers } = await import(moduleUrl); const { openWorkspaceSession } = await import(coreUrl);
    await mkdir(join(root, 'chr')); const source = join(root, 'chr/c0000.anibnd.dcx'); await writeFile(source, 'owned read-only fixture');
    const sourceUri = 'file://chr/c0000.anibnd.dcx'; const session = await openWorkspaceSession({ overlayRoot: root, game: 'sekiro' }); const handlers = new Map();
    registerAssetIpcHandlers({ handle: (name, fn) => handlers.set(name, fn), indexedFiles: [{ sourceUri, absolutePath: source, relativePath: 'chr/c0000.anibnd.dcx', game: 'sekiro' }], activeSession: session, rejectNonSekiroNativeWrite: () => null, durableStoragePaths: () => ({ root: join(root, 'storage') }) });
    const result = await handlers.get('resource.commitTaeEvent')({}, sourceUri, 'snapshot-hash', [{ mutation: 'update-event-times', animId: 0, eventIndex: 0, taeEntryIndex: 1, startTime: 1, endTime: 2 }]);
    assert.equal(result.ok, false); assert.equal(result.diagnostics[0].code, 'FIXTURE_STOP'); assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'read-tae-document'); assert.deepEqual(calls[0].commandOptions, { animationPage: 0, animationPageSize: 1 });
  } finally { hooks.deregister(); delete globalThis[symbol]; await rm(root, { recursive: true, force: true }); }
});
