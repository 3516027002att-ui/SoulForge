import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { clearWorkspaceServiceCaches, createWorkspaceService, disposeWorkspaceService, getWorkspaceActiveIndex,
  getWorkspaceIndexedFiles, getWorkspaceRuntimeIdentityState, type AdmittedWorkspaceDirectory } from './workspaceService.js';

test('base remount rebuilds the current overlay catalog instead of publishing an empty index', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-workspace-remount-'));
  const overlay = join(root, 'mod'), base = join(root, 'game'), storage = join(root, 'storage');
  const admit = (absolutePath: string, kind: 'overlay' | 'base'): AdmittedWorkspaceDirectory => ({ absolutePath, kind, label: kind });
  let databaseAttempts = 0;
  const service = createWorkspaceService({
    // Deliberately unavailable persistence does not erase the light catalog.
    // No Electron, Bridge, native parsing or user's database is required.
    ensureActiveOperationLog: async () => { databaseAttempts++; throw new Error('owned persistence unavailable'); },
    clearActiveOperationLog: async () => {}, releaseEditorCaches: () => {}, clearRememberedBase: () => {},
    verifiedReadRoots: async () => ({ allowedRoots: [], diagnostics: [] }),
    resolveWorkspaceStoragePaths: () => ({ root: storage, backupBaseDir: join(storage, 'backups'),
      recoveryDir: join(storage, 'recovery'), stagingRoot: join(storage, 'staging'), isCompanion: false })
  });
  try {
    await Promise.all([overlay, base, storage].map(path => mkdir(path)));
    await writeFile(join(overlay, 'first.txt'), 'owned first');
    const opened = await service.scan({ overlaySelectionId: 'owned', clearBase: true },
      () => admit(overlay, 'overlay'), () => undefined, () => { throw new Error('no auto base'); });
    assert.deepEqual(opened.files.map(file => file.relativePath), ['first.txt']);
    await writeFile(join(overlay, 'second.txt'), 'owned second');
    const remounted = await service.remountBase(() => admit(base, 'base'));
    assert.notEqual(remounted.workspaceSessionId, opened.workspaceSessionId);
    assert.equal(remounted.session.baseMounted, true);
    assert.deepEqual(getWorkspaceIndexedFiles().map(file => file.relativePath).sort(), ['first.txt', 'second.txt']);
    assert.deepEqual(getWorkspaceActiveIndex()?.getFiles().map(file => file.relativePath).sort(), ['first.txt', 'second.txt']);
    const cleared = await service.remountBase(() => undefined);
    assert.equal(cleared.session.baseMounted, false);
    assert.equal(getWorkspaceRuntimeIdentityState().baseRoot, null);
    assert.deepEqual(getWorkspaceIndexedFiles().map(file => file.relativePath).sort(), ['first.txt', 'second.txt']);
    assert.equal(databaseAttempts, 3, 'Every new session starts its own catalog persistence work');
  } finally {
    clearWorkspaceServiceCaches();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('overlapping mounts are serialized and an old remount cannot retake a replacement workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-workspace-remount-'));
  const a = join(root, 'a'), b = join(root, 'b'), c = join(root, 'c'), base = join(root, 'base'), storage = join(root, 'storage');
  const entered = deferred(), release = deferred();
  let clears = 0;
  const service = createWorkspaceService({
    ensureActiveOperationLog: async () => { throw new Error('owned persistence unavailable'); },
    clearActiveOperationLog: async () => { if (++clears === 2) { entered.resolve(); await release.promise; } },
    releaseEditorCaches: () => {}, clearRememberedBase: () => {},
    verifiedReadRoots: async () => ({ allowedRoots: [], diagnostics: [] }),
    resolveWorkspaceStoragePaths: () => ({ root: storage, backupBaseDir: join(storage, 'backups'),
      recoveryDir: join(storage, 'recovery'), stagingRoot: join(storage, 'staging'), isCompanion: false })
  });
  const scan = (directory: string) => service.scan({ overlaySelectionId: 'owned', clearBase: true },
    () => ({ absolutePath: directory, kind: 'overlay', label: directory.slice(-1) }), () => undefined,
    () => { throw new Error('no auto base'); });
  let pending: Promise<unknown>[] = [];
  try {
    await Promise.all([a, b, c, base, storage].map(path => mkdir(path)));
    for (const directory of [a, b, c]) await writeFile(join(directory, `${directory.slice(-1)}.txt`), 'owned');
    await scan(a);
    const openingB = scan(b); pending.push(openingB);
    await entered.promise;
    const openingC = scan(c); pending.push(openingC);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(clears, 2, 'the second mount must not enter lifecycle cleanup while the first owns it');
    release.resolve();
    await Promise.all(pending); pending = [];
    assert.deepEqual(getWorkspaceIndexedFiles().map(file => file.relativePath), ['c.txt']);

    // Capture a remount of C before the already queued switch to A starts.
    // It must not silently turn the main session back into C after A publishes.
    const returningA = scan(a);
    const staleRemount = service.remountBase(() => ({ absolutePath: base, kind: 'base', label: 'owned base' }));
    const settled = await Promise.allSettled([returningA, staleRemount]);
    assert.equal(settled[0]!.status, 'fulfilled');
    const remount = settled[1]!;
    assert.equal(remount.status, 'rejected');
    if (remount.status === 'rejected') assert.equal((remount.reason as { code: string }).code, 'WORKSPACE_REMOUNT_SUPERSEDED');
    assert.deepEqual(getWorkspaceIndexedFiles().map(file => file.relativePath), ['a.txt']);
    assert.equal(getWorkspaceRuntimeIdentityState().baseRoot, null);
    await scan(c);
    assert.deepEqual(getWorkspaceIndexedFiles().map(file => file.relativePath), ['c.txt'], 'a rejected remount must release the mount queue');
  } finally {
    release.resolve(); await Promise.allSettled(pending);
    clearWorkspaceServiceCaches(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
});

async function withMountFixture(
  run: (fixture: {
    scan: (key: 'a' | 'b', facade?: number) => Promise<unknown>;
    remount: (key: 'base1' | 'base2', facade?: number) => Promise<unknown>;
    analyze: (facade?: number) => Promise<unknown>;
  }) => Promise<void>,
  clear: () => Promise<void> = async () => {},
  ensure: () => Promise<never> = async () => { throw new Error('owned persistence unavailable'); }
) {
  const root = await mkdtemp(join(tmpdir(), 'sf-workspace-remount-'));
  const paths = Object.fromEntries(['a', 'b', 'base1', 'base2', 'storage'].map(key => [key, join(root, key)]));
  const pending: Promise<unknown>[] = [];
  const track = <T>(task: Promise<T>): Promise<T> => { pending.push(task); return task; };
  const deps = {
    ensureActiveOperationLog: ensure,
    clearActiveOperationLog: clear, releaseEditorCaches: () => {}, clearRememberedBase: () => {},
    verifiedReadRoots: async () => ({ allowedRoots: [], diagnostics: [] }),
    resolveWorkspaceStoragePaths: () => ({ root: paths.storage!, backupBaseDir: join(paths.storage!, 'backups'),
      recoveryDir: join(paths.storage!, 'recovery'), stagingRoot: join(paths.storage!, 'staging'), isCompanion: false })
  };
  const facades = [createWorkspaceService(deps), createWorkspaceService(deps)];
  try {
    await Promise.all(Object.values(paths).map(path => mkdir(path)));
    for (const key of ['a', 'b']) await writeFile(join(paths[key]!, `${key}.txt`), 'owned');
    await run({
      scan: (key, facade = 0) => track(facades[facade]!.scan({ overlaySelectionId: 'owned', clearBase: true },
        () => ({ absolutePath: paths[key]!, kind: 'overlay', label: key }), () => undefined,
        () => { throw new Error('no auto base'); })),
      remount: (key, facade = 0) => track(facades[facade]!.remountBase(() => ({ absolutePath: paths[key]!, kind: 'base', label: key }))),
      analyze: (facade = 0) => track(facades[facade]!.analyze())
    });
  } finally {
    await Promise.allSettled(pending);
    clearWorkspaceServiceCaches(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
}

test('an A to B to A replacement rejects an old A remount but consecutive base changes remain ordered', async () => {
  await withMountFixture(async ({ scan, remount }) => {
    await scan('a');
    const settled = await Promise.allSettled([scan('b'), scan('a', 1), remount('base1')]);
    assert.equal(settled[0]!.status, 'fulfilled');
    assert.equal(settled[1]!.status, 'fulfilled');
    assert.equal(settled[2]!.status, 'rejected', 'the path returning to A must not revive an old A capability');
    if (settled[2]!.status === 'rejected') assert.equal(settled[2].reason.code, 'WORKSPACE_REMOUNT_SUPERSEDED');
    assert.equal(getWorkspaceRuntimeIdentityState().baseRoot, null);
    const results = await Promise.all([remount('base1'), remount('base2', 1)]);
    assert.equal(results.length, 2);
    assert.equal(getWorkspaceRuntimeIdentityState().baseRoot?.endsWith('base2'), true);
    assert.deepEqual(getWorkspaceIndexedFiles().map(file => file.relativePath), ['a.txt']);
  });
});

test('a failed mount releases the process-wide queue across facades', async () => {
  let clears = 0;
  await withMountFixture(async ({ scan }) => {
    const result = await Promise.allSettled([scan('a'), scan('b', 1)]);
    assert.equal(result[0]!.status, 'rejected');
    if (result[0]!.status === 'rejected') assert.equal(result[0].reason.message, 'owned cleanup failure');
    assert.equal(result[1]!.status, 'fulfilled');
    assert.deepEqual(getWorkspaceIndexedFiles().map(file => file.relativePath), ['b.txt']);
  }, async () => { if (++clears === 1) throw new Error('owned cleanup failure'); });
});

test('cache clearing revokes both an in-flight mount and an admitted queued mount', async () => {
  const entered = deferred(), release = deferred();
  let clears = 0;
  await withMountFixture(async ({ scan }) => {
    await scan('a');
    const opening = scan('b');
    await entered.promise;
    const queued = scan('a', 1);
    clearWorkspaceServiceCaches();
    release.resolve();
    const results = await Promise.allSettled([opening, queued]);
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') assert.equal(result.reason.code, 'WORKSPACE_MOUNT_CANCELLED');
    }
    assert.equal(clears, 2, 'the revoked queued mount must not enter cleanup');
    assert.equal(getWorkspaceRuntimeIdentityState().workspaceSessionId, null);
    assert.equal(getWorkspaceActiveIndex(), null);
    assert.deepEqual(getWorkspaceIndexedFiles(), []);
    await scan('b');
    assert.deepEqual(getWorkspaceIndexedFiles().map(file => file.relativePath), ['b.txt']);
  }, async () => { if (++clears === 2) { entered.resolve(); await release.promise; } });
});

test('a cancelled background failure releases readiness without reviving its old catalog', async () => {
  let reject!: (error: Error) => void;
  const database = new Promise<never>((_, fail) => { reject = fail; });
  await withMountFixture(async ({ scan }) => {
    await scan('a');
    assert.deepEqual(getWorkspaceIndexedFiles().map(file => file.relativePath), ['a.txt']);
    clearWorkspaceServiceCaches();
    reject(new Error('owned delayed database failure'));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(getWorkspaceRuntimeIdentityState().workspaceSessionId, null);
    assert.deepEqual(getWorkspaceIndexedFiles(), [], 'a cancelled background finalizer must not publish');
  }, async () => {}, () => database);
});

test('shutdown drains superseded analyses and current mounts before releasing dependencies', async () => {
  const entered = deferred(), release = deferred(), oldEntered = deferred(), newEntered = deferred();
  let failOld!: (error: Error) => void, failNew!: (error: Error) => void, clears = 0, opens = 0;
  const oldDatabase = new Promise<never>((_, reject) => { failOld = reject; });
  const newDatabase = new Promise<never>((_, reject) => { failNew = reject; });
  await withMountFixture(async ({ scan, analyze }) => {
    await scan('a');
    const oldAnalysis = Promise.allSettled([analyze()]);
    await oldEntered.promise;
    await scan('b');
    const newAnalysis = Promise.allSettled([analyze(1)]);
    await newEntered.promise;
    const opening = scan('a');
    await entered.promise;
    const queued = scan('b', 1);
    let stopped = false;
    const disposal = disposeWorkspaceService().then(() => { stopped = true; });
    const results = Promise.allSettled([opening, queued, scan('a')]);
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(stopped, false, 'cancelling admission must not release dependencies before its owner finishes');
      release.resolve(); failNew(new Error('owned new analysis failure'));
      await results; await newAnalysis;
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(stopped, false, 'the superseded analysis still owns its pending database request');
    } finally { release.resolve(); failOld(new Error('owned old analysis failure')); failNew(new Error('owned new analysis failure')); }
    for (const result of await results) {
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') assert.equal(result.reason.code, 'WORKSPACE_MOUNT_CANCELLED');
    }
    await oldAnalysis; await newAnalysis; await disposal;
    assert.equal(stopped, true); assert.deepEqual(getWorkspaceIndexedFiles(), []);
  }, async () => { if (++clears === 3) { entered.resolve(); await release.promise; } }, async () => {
    if (++opens === 2) { oldEntered.resolve(); return oldDatabase; }
    if (opens === 4) { newEntered.resolve(); return newDatabase; }
    throw new Error('owned scan persistence unavailable');
  });
});
