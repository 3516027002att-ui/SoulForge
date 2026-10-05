import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(resolve('scripts/owned-temporary-directory.mjs')).href;
const helper = await import(moduleUrl).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

async function inParent(body) {
  const parent = await mkdtemp(join(tmpdir(), 'sf-owned-cleanup-test-'));
  try { await body(parent); } finally { await rm(parent, { recursive: true, force: true }); }
}

async function childWorkspace(parent, owner = 'interruption') {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createOwnedTemporaryDirectory } from ${JSON.stringify(moduleUrl)};
    const directory = await createOwnedTemporaryDirectory(${JSON.stringify(owner)}, { parent: ${JSON.stringify(parent)} });
    process.send(directory.root);
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const root = await Promise.race([
    once(child, 'message').then(([value]) => value),
    once(child, 'exit').then(([code]) => { throw new Error(`child exited ${code}: ${stderr}`); })
  ]);
  return { child, root };
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
}

test('owned roots are distinct and dispose on successful and failed work', async () => {
  assert.equal(typeof helper.createOwnedTemporaryDirectory, 'function');
  await inParent(async parent => {
    const first = await helper.createOwnedTemporaryDirectory('unit', { parent });
    const second = await helper.createOwnedTemporaryDirectory('unit', { parent });
    assert.notEqual(first.root, second.root);
    await writeFile(join(first.root, 'output'), 'owned');
    await first.dispose(); await first.dispose();
    await assert.rejects(readFile(join(first.root, 'output')), { code: 'ENOENT' });
    try { throw new Error('body failed'); } catch (error) {
      await second.dispose(); assert.equal(error.message, 'body failed');
    }
    assert.deepEqual(await readdir(parent), []);
  });
});

test('exact directory initialization rejects a linked ancestor even when the selected leaf is a real empty directory', async () => {
  await inParent(async parent => {
    const target = join(parent, 'target');
    const alias = join(parent, 'alias');
    await mkdir(target);
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const leaf = join(alias, 'fresh');
    await mkdir(leaf);
    await assert.rejects(helper.initializeOwnedTemporaryDirectory('linked-parent', leaf), /OWNED_TEMP_PARENT_INVALID/);
    assert.deepEqual(await readdir(join(target, 'fresh')), []);
  });
});

test('exact directory initialization rejects link traversal hidden by a dot-dot segment', async () => {
  await inParent(async parent => {
    const base = join(parent, 'base'), other = join(parent, 'other');
    await mkdir(base); await mkdir(other); await mkdir(join(other, 'child'));
    await mkdir(join(base, 'fresh')); await mkdir(join(other, 'fresh'));
    await symlink(join(other, 'child'), join(base, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    let admitted;
    try {
      await assert.rejects(async () => {
        admitted = await helper.initializeOwnedTemporaryDirectory('linked-dot-dot', `${base}/link/../fresh`);
      }, /OWNED_TEMP_PARENT_INVALID/);
    } finally { if (admitted) await admitted.dispose(); }
    assert.deepEqual(await readdir(join(base, 'fresh')), []);
    assert.deepEqual(await readdir(join(other, 'fresh')), []);
  });
});

test('ordinary process failure still cleans an allocation made before a test finally block', async () => {
  assert.equal(typeof helper.createOwnedTemporaryDirectory, 'function');
  await inParent(async parent => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { createOwnedTemporaryDirectory } from ${JSON.stringify(moduleUrl)};
      const directory = await createOwnedTemporaryDirectory('early-failure', { parent: ${JSON.stringify(parent)} });
      process.send(directory.root);
      process.exitCode = 1;
      process.disconnect();
    `], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = once(child, 'exit'); await once(child, 'message');
    assert.equal((await exited)[0], 1);
    assert.deepEqual(await readdir(parent), []);
  });
});

test('the next allocation reclaims an actually interrupted predecessor but preserves a live owner', async () => {
  assert.equal(typeof helper.createOwnedTemporaryDirectory, 'function');
  await inParent(async parent => {
    const predecessor = await childWorkspace(parent);
    try {
      const concurrent = await helper.createOwnedTemporaryDirectory('interruption', { parent });
      assert.ok((await readdir(parent)).includes(basename(predecessor.root)));
      await concurrent.dispose();
      await stop(predecessor.child);
      assert.ok((await readdir(parent)).includes(basename(predecessor.root)), 'SIGKILL leaves the owned root for restart');
      const successor = await helper.createOwnedTemporaryDirectory('interruption', { parent });
      assert.ok(!(await readdir(parent)).includes(basename(predecessor.root)));
      await successor.dispose();
      assert.deepEqual(await readdir(parent), []);
    } finally { await stop(predecessor.child); }
  });
});

test('reclamation requires exact ownership and a real path boundary', async () => {
  assert.equal(typeof helper.createOwnedTemporaryDirectory, 'function');
  await inParent(async parent => {
    const predecessor = await childWorkspace(parent, 'boundary');
    await stop(predecessor.child);
    const markerName = '.soulforge-temporary-owner.json';
    const marker = JSON.parse(await readFile(join(predecessor.root, markerName), 'utf8'));
    const foreign = join(parent, `${basename(predecessor.root)}-foreign`);
    await mkdir(foreign); await writeFile(join(foreign, 'sentinel'), 'foreign');
    await writeFile(join(foreign, markerName), JSON.stringify(marker));
    const unmarked = join(parent, `${basename(predecessor.root)}-unmarked`); await mkdir(unmarked);
    const outside = await mkdtemp(join(tmpdir(), 'sf-owned-cleanup-outside-'));
    try {
      await writeFile(join(outside, 'sentinel'), 'outside');
      const linked = join(parent, `${basename(predecessor.root)}-linked`);
      await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
      const successor = await helper.createOwnedTemporaryDirectory('boundary', { parent }); await successor.dispose();
      assert.equal(await readFile(join(foreign, 'sentinel'), 'utf8'), 'foreign');
      assert.ok((await readdir(parent)).includes(basename(unmarked)));
      assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'outside');
      await assert.rejects(helper.createOwnedTemporaryDirectory('boundary', { parent: linked }), /OWNED_TEMP_PARENT_INVALID/);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
});

test('a surviving registered child keeps an interrupted owner’s root alive', async () => {
  assert.equal(typeof helper.createOwnedTemporaryDirectory, 'function');
  await inParent(async parent => {
    const predecessor = await childWorkspace(parent, 'child-owner');
    const keeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      const markerPath = join(predecessor.root, '.soulforge-temporary-owner.json');
      const marker = JSON.parse(await readFile(markerPath, 'utf8'));
      await writeFile(markerPath, JSON.stringify({ ...marker, childPids: [keeper.pid] }));
      await stop(predecessor.child);
      const concurrent = await helper.createOwnedTemporaryDirectory('child-owner', { parent }); await concurrent.dispose();
      assert.ok((await readdir(parent)).includes(basename(predecessor.root)));
      await stop(keeper);
      const successor = await helper.createOwnedTemporaryDirectory('child-owner', { parent }); await successor.dispose();
      assert.deepEqual(await readdir(parent), []);
    } finally { await stop(predecessor.child); await stop(keeper); }
  });
});

test('a different or unknown PID observer preserves a dead-looking predecessor', async () => {
  await inParent(async parent => {
    const predecessor = await childWorkspace(parent, 'opaque-owner');
    try {
      const path = join(predecessor.root, '.soulforge-temporary-owner.json');
      const marker = JSON.parse(await readFile(path, 'utf8'));
      await stop(predecessor.child);
      for (const observer of [undefined, 'different-pid-namespace']) {
        await writeFile(path, JSON.stringify({ ...marker, observer }));
        const next = await helper.createOwnedTemporaryDirectory('opaque-owner', { parent }); await next.dispose();
        assert.ok((await readdir(parent)).includes(basename(predecessor.root)));
      }
    } finally { await stop(predecessor.child); }
  });
});

test('exact-root initialization refuses pre-existing unmarked artifacts and attached live owners', async () => {
  await inParent(async parent => {
    const userRoot = join(parent, 'user-output'); await mkdir(userRoot);
    await writeFile(join(userRoot, 'sentinel'), 'user bytes');
    await assert.rejects(helper.initializeOwnedTemporaryDirectory('build', userRoot), /OWNED_TEMP_ROOT_NOT_FRESH/);
    assert.equal(await readFile(join(userRoot, 'sentinel'), 'utf8'), 'user bytes');
    await assert.rejects(readFile(join(userRoot, '.soulforge-temporary-owner.json')), { code: 'ENOENT' });
    const live = await childWorkspace(parent, 'attached-owner');
    try {
      const attached = await helper.attachOwnedTemporaryDirectory(live.root);
      await assert.rejects(attached.dispose(), /OWNED_TEMP_PROCESS_LIVE/);
      assert.equal(await helper.ownedTemporaryDirectoryIsIdle(live.root, 'attached-owner'), false);
    } finally { await stop(live.child); }
  });
});

test('uncertain descendant evidence stays preserved even after its registered PID exits', async () => {
  await inParent(async parent => {
    const owner = await helper.createOwnedTemporaryDirectory('uncertain-tree', { parent });
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    try {
      const ticket = await owner.trackProcess(child.pid, { uncertainTree: true });
      await stop(child);
      await assert.rejects(owner.dispose(), /OWNED_TEMP_PROCESS_UNCERTAIN/);
      assert.equal(await helper.ownedTemporaryDirectoryIsIdle(owner.root, 'uncertain-tree'), false);
      helper.recordOwnedProcess(ticket, child.pid, { finished: true });
      await owner.dispose();
    } finally { await stop(child); }
  });
});
