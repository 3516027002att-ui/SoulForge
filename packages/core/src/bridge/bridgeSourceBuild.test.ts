import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { prepareBridgeSourceBuild } from './bridgeSourceBuild.js';

it('prepares one shared source build and keeps compiler output out of the daemon stream', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-source-build-'));
  try {
    const receipt = join(root, 'receipt');
    const compiler = join(root, 'compiler.cjs');
    await writeFile(compiler, `require('node:fs').appendFileSync(${JSON.stringify(receipt)}, 'build\\n'); console.log('not NDJSON'); setTimeout(() => process.exit(0), 100);`);
    const phases: unknown[] = [];
    const options = { executable: process.execPath, args: [compiler], cwd: root, timeoutMs: 2_000 };
    await Promise.all([
      prepareBridgeSourceBuild({ ...options, onProgress: value => phases.push(value) }),
      prepareBridgeSourceBuild(options)
    ]);
    assert.equal(await readFile(receipt, 'utf8'), 'build\n');
    assert.deepEqual(phases.map(value => (value as { status: string }).status), ['started', 'completed']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('reports a failed build before any daemon starts and permits a later retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-source-build-fail-'));
  try {
    const compiler = join(root, 'compiler.cjs');
    await writeFile(compiler, "console.error('compiler rejected source'); process.exit(7);");
    const options = { executable: process.execPath, args: [compiler], cwd: root, timeoutMs: 2_000 };
    await assert.rejects(prepareBridgeSourceBuild(options), error => (error as { code: string }).code === 'BRIDGE_SOURCE_BUILD_FAILED');
    await writeFile(compiler, 'process.exit(0);');
    await prepareBridgeSourceBuild(options);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('bounds a hung compiler and waits for termination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-source-build-timeout-'));
  try {
    const compiler = join(root, 'compiler.cjs');
    const receipt = join(root, 'pid');
    await writeFile(compiler, `require('node:fs').writeFileSync(${JSON.stringify(receipt)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 100);`);
    await assert.rejects(prepareBridgeSourceBuild({ executable: process.execPath, args: [compiler], cwd: root, timeoutMs: 500 }), error => (error as { code: string }).code === 'BRIDGE_SOURCE_BUILD_TIMEOUT');
    const pid = Number(await readFile(receipt, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('cancelling one waiter does not interrupt a source build still needed by another', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-source-build-waiter-'));
  try {
    const compiler = join(root, 'compiler.cjs');
    await writeFile(compiler, 'setTimeout(() => process.exit(0), 200);');
    const options = { executable: process.execPath, args: [compiler], cwd: root, timeoutMs: 2_000 };
    const controller = new AbortController();
    const cancelled = prepareBridgeSourceBuild({ ...options, signal: controller.signal });
    const sibling = prepareBridgeSourceBuild(options);
    const rejected = assert.rejects(cancelled, error => (error as { code: string }).code === 'BRIDGE_REQUEST_CANCELLED');
    controller.abort();
    await Promise.all([rejected, sibling]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('a fresh caller waits for a cancelled build to retire, then starts its own build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-source-build-retiring-'));
  try {
    const compiler = join(root, 'compiler.cjs');
    const receipt = join(root, 'receipt');
    await writeFile(compiler, `const fs = require('node:fs'); const first = !fs.existsSync(${JSON.stringify(receipt)}); fs.appendFileSync(${JSON.stringify(receipt)}, 'build\\n'); if (first) { process.on('SIGTERM', () => {}); setInterval(() => {}, 100); }`);
    const options = { executable: process.execPath, args: [compiler], cwd: root, timeoutMs: 5_000 };
    const controller = new AbortController();
    const cancelled = prepareBridgeSourceBuild({ ...options, signal: controller.signal });
    const rejected = assert.rejects(cancelled, error => (error as { code: string }).code === 'BRIDGE_REQUEST_CANCELLED');
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { await readFile(receipt); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
    }
    controller.abort();
    await new Promise(resolveTurn => setImmediate(resolveTurn));
    const fresh = prepareBridgeSourceBuild(options);
    await Promise.all([rejected, fresh]);
    assert.equal(await readFile(receipt, 'utf8'), 'build\nbuild\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});
