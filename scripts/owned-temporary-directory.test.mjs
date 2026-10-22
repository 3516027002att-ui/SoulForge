import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
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

// Windows job proofs. owned-windows-job.ps1 publishes 'finished' only after
// TerminateJobObject and ActiveProcesses == 0, so the job's driver is already
// gone; only the guardian (outside its own job) still has to be seen stopped.
// 'assigned' means the guardian ended without that accounting: both PIDs matter.
const windowsOnly = { skip: process.platform !== 'win32' && 'Windows job proof only' };
const markerName = '.soulforge-temporary-owner.json';
const lingering = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
async function exitedPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'exit');
  return child.pid;
}
async function writeJobProof(root, { supervisor, id, guardianPid, driverPid, state }) {
  const marker = JSON.parse(await readFile(join(root, markerName), 'utf8'));
  await writeFile(join(root, `.soulforge-windows-job.${id}.json`), JSON.stringify({ schema: 'soulforge.windows-job.v1', id,
    token: marker.token, observer: marker.observer, supervisorPid: supervisor, guardianPid, driverPid, state, killOnClose: true }));
}
async function ownerWithJobProof(parent, proof) {
  const owner = await helper.createOwnedTemporaryDirectory('windows-job-proof', { parent });
  const supervisor = await exitedPid(), id = randomUUID();
  const ticket = await owner.trackProcess(supervisor, { uncertainTree: true });
  helper.prepareOwnedWindowsJob(ticket, supervisor, id);
  await writeJobProof(owner.root, { supervisor, id, ...proof });
  return { owner, supervisor, id };
}

test('Windows dispose waits for a guardian that exits after publishing its finished proof', windowsOnly, async () => {
  await inParent(async parent => {
    const guardian = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 700)'], { stdio: 'ignore' });
    try {
      const { owner } = await ownerWithJobProof(parent, { state: 'finished', guardianPid: guardian.pid, driverPid: await exitedPid() });
      await owner.dispose({ stopProofWaitMs: 10_000 });
      // This process still holds the guardian's handle, so its PID cannot be reused yet.
      assert.throws(() => process.kill(guardian.pid, 0), { code: 'ESRCH' }, 'dispose returned only after the guardian exited');
      assert.deepEqual(await readdir(parent), []);
    } finally { await stop(guardian); }
  });
});

test('Windows dispose stays uncertain with the failed sub-check when the guardian never exits', windowsOnly, async () => {
  await inParent(async parent => {
    const guardian = lingering();
    try {
      const { owner, supervisor } = await ownerWithJobProof(parent, { state: 'finished', guardianPid: guardian.pid, driverPid: await exitedPid() });
      const started = Date.now();
      await assert.rejects(owner.dispose({ stopProofWaitMs: 300 }),
        new RegExp(`^Error: OWNED_TEMP_PROCESS_UNCERTAIN: .+: supervisor ${supervisor}: guardian-live\\(${guardian.pid},finished\\)$`));
      assert.ok(Date.now() - started >= 300, 'the bounded wait ran to its deadline');
      assert.ok((await readdir(parent)).includes(basename(owner.root)), 'an unproven tree keeps its root');
      await stop(guardian);
      await owner.dispose();
      assert.deepEqual(await readdir(parent), []);
    } finally { await stop(guardian); }
  });
});

test('Windows finished proof ignores a reused driver PID while assigned proof still requires the driver to stop', windowsOnly, async () => {
  await inParent(async parent => {
    const reused = lingering();
    try {
      const assigned = await ownerWithJobProof(parent, { state: 'assigned', guardianPid: await exitedPid(), driverPid: reused.pid });
      await assert.rejects(assigned.owner.dispose({ stopProofWaitMs: 200 }),
        new RegExp(`OWNED_TEMP_PROCESS_UNCERTAIN: .+: supervisor ${assigned.supervisor}: driver-live\\(${reused.pid},assigned\\)$`));
      assert.ok((await readdir(parent)).includes(basename(assigned.owner.root)));
      const finished = await ownerWithJobProof(parent, { state: 'finished', guardianPid: await exitedPid(), driverPid: reused.pid });
      await finished.owner.dispose({ stopProofWaitMs: 0 });
      assert.deepEqual(await readdir(parent), [basename(assigned.owner.root)]);
      await stop(reused);
      await assigned.owner.dispose();
      assert.deepEqual(await readdir(parent), []);
    } finally { await stop(reused); }
  });
});

test('Windows dispose names a missing job record and an unreadable proof without waiting', windowsOnly, async () => {
  await inParent(async parent => {
    const owner = await helper.createOwnedTemporaryDirectory('windows-job-proof', { parent });
    const supervisor = await exitedPid();
    await owner.trackProcess(supervisor, { uncertainTree: true });
    const started = Date.now();
    await assert.rejects(owner.dispose({ stopProofWaitMs: 5_000 }), new RegExp(`supervisor ${supervisor}: job-record-missing$`));
    assert.ok(Date.now() - started < 2_000, 'a reason no wait can change fails at once');
    const proof = await ownerWithJobProof(parent, { state: 'finished', guardianPid: await exitedPid(), driverPid: await exitedPid() });
    await writeFile(join(proof.owner.root, `.soulforge-windows-job.${proof.id}.json`), '{"schema":');
    await assert.rejects(proof.owner.dispose({ stopProofWaitMs: 100 }), new RegExp(`supervisor ${proof.supervisor}: job-proof-unreadable\\(SyntaxError\\)$`));
    await rm(join(proof.owner.root, `.soulforge-windows-job.${proof.id}.json`));
    await assert.rejects(proof.owner.dispose({ stopProofWaitMs: 100 }), new RegExp(`supervisor ${proof.supervisor}: job-proof-missing$`));
    assert.equal((await readdir(parent)).length, 2, 'both unproven roots are kept');
  });
});

test('Windows predecessor reclaim follows the finished-proof guardian, not a reused driver PID', windowsOnly, async () => {
  await inParent(async parent => {
    const predecessor = await childWorkspace(parent, 'windows-reclaim');
    const guardian = lingering(), reused = lingering();
    try {
      await stop(predecessor.child);
      const path = join(predecessor.root, markerName), marker = JSON.parse(await readFile(path, 'utf8'));
      const supervisor = await exitedPid(), id = randomUUID();
      await writeFile(path, JSON.stringify({ ...marker, childPids: [supervisor], uncertainTrees: [supervisor], windowsJobs: [{ pid: supervisor, id }] }));
      const proof = state => writeJobProof(predecessor.root, { supervisor, id, guardianPid: guardian.pid, driverPid: reused.pid, state });
      const allocate = async () => { const next = await helper.createOwnedTemporaryDirectory('windows-reclaim', { parent }); await next.dispose(); };
      const retained = async () => (await readdir(parent)).includes(basename(predecessor.root));
      await proof('finished'); await allocate();
      assert.ok(await retained(), 'a live finished-proof guardian keeps the predecessor');
      await stop(guardian);
      await proof('assigned'); await allocate();
      assert.ok(await retained(), 'an assigned proof with a live driver PID keeps the predecessor');
      await proof('finished'); await allocate();
      assert.equal(await retained(), false, 'after its guardian exits, a finished job is reclaimed even if its driver PID was reused');
    } finally { await stop(predecessor.child); await stop(guardian); await stop(reused); }
  });
});
