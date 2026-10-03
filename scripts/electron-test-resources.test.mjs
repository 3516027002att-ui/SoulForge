import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const resources = await import('./electron-test-resources.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

test('Electron test teardown closes a real registered child before removing its owned profile', async () => {
  assert.equal(typeof resources.createElectronTestResources, 'function');
  const parent = await mkdtemp(join(tmpdir(), 'sf-electron-owner-test-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const owner = await resources.createElectronTestResources('profile', { parent });
    await owner.registerApp({ process: () => child, close: async () => {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    } });
    assert.ok((await readdir(parent)).length > 0);
    await owner.dispose();
    assert.ok(child.signalCode);
    assert.deepEqual(await readdir(parent), []);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    await rm(parent, { recursive: true, force: true });
  }
});

test('Electron profile teardown reports a close failure while the actual child stays live', async () => {
  assert.equal(typeof resources.createElectronTestResources, 'function');
  const parent = await mkdtemp(join(tmpdir(), 'sf-electron-close-test-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const owner = await resources.createElectronTestResources('profile', { parent });
    await owner.registerApp({ process: () => child, close: async () => { throw new Error('close failed'); } });
    await assert.rejects(owner.dispose(), /close failed|OWNED_TEMP_PROCESS_LIVE/);
    assert.equal((await readdir(parent)).length, 1, 'live child profile is preserved');
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    await owner.dispose();
    assert.deepEqual(await readdir(parent), []);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    await rm(parent, { recursive: true, force: true });
  }
});
