import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import * as harness from '../packages/core/src/testing/harness/smokeWorkspace.ts';
const { createSmokeWorkspace, withSmokeWorkspace } = harness;

test('the legacy smoke allocation adapter marks only its exact parent and label', async () => {
  assert.equal(typeof harness.createSmokeTemporaryDirectory, 'function');
  const prefix = join(tmpdir(), `soulforge-legacy-${randomUUID()}-`);
  const root = await harness.createSmokeTemporaryDirectory(prefix);
  const { rm } = await import('node:fs/promises');
  try {
    const marker = JSON.parse(await readFile(join(dirname(root), '.soulforge-temporary-owner.json'), 'utf8'));
    assert.equal(marker.owner, `smoke-${prefix.split(/[\\/]/).at(-1)}`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('smoke fixture roots start empty so ownership metadata cannot alter scanned resources', async () => {
  await withSmokeWorkspace('empty-resource-root', async ({ root }) => {
    assert.deepEqual(await readdir(root), []);
  });
});

test('smoke workspace removes its outputs after both success and a rejected body', async () => {
  let successfulRoot, failedRoot;
  assert.equal(await withSmokeWorkspace('cleanup-success', async ({ root }) => {
    successfulRoot = root; await writeFile(join(root, 'sentinel'), 'owned'); return 42;
  }), 42);
  await assert.rejects(readFile(join(successfulRoot, 'sentinel')), { code: 'ENOENT' });
  const failure = new Error('original body failure');
  await assert.rejects(withSmokeWorkspace('cleanup-failure', async ({ root }) => {
    failedRoot = root; await writeFile(join(root, 'sentinel'), 'owned'); throw failure;
  }), error => error === failure);
  await assert.rejects(readFile(join(failedRoot, 'sentinel')), { code: 'ENOENT' });
});

test('a smoke restart reclaims the workspace of a killed smoke process', async () => {
  const label = `interrupted-${randomUUID()}`;
  const url = pathToFileURL(resolve('packages/core/src/testing/harness/smokeWorkspace.ts')).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createSmokeWorkspace } from ${JSON.stringify(url)};
    import { writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    const workspace = await createSmokeWorkspace(${JSON.stringify(label)});
    await writeFile(join(workspace.root, 'sentinel'), 'interrupted');
    process.send(workspace.root); setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  let predecessor;
  try {
    [predecessor] = await once(child, 'message');
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const successor = await createSmokeWorkspace(label);
    try { await assert.rejects(readFile(join(predecessor, 'sentinel')), { code: 'ENOENT' }); }
    finally { await successor.dispose(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    if (predecessor) {
      const { rm } = await import('node:fs/promises'); await rm(predecessor, { recursive: true, force: true });
    }
  }
});
