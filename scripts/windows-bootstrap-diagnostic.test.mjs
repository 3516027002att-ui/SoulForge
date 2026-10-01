import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { evaluateBootstrapOutcome, buildBootstrapSource } from './windows-bootstrap-diagnostic.mjs';

test('native trap and missing readiness cannot be mistaken for successful bootstrap', () => {
  assert.equal(evaluateBootstrapOutcome({ status: 0 }, ['entry', 'ready'], false).status, 'passed');
  assert.equal(evaluateBootstrapOutcome({ status: 0 }, [], false).status, 'failed');
  assert.equal(evaluateBootstrapOutcome({ status: 2147483651 }, ['entry'], false).nativeExitHex, '0x80000003');
  assert.equal(evaluateBootstrapOutcome({ status: 0 }, ['entry', 'ready'], true).status, 'failed');
  assert.equal(evaluateBootstrapOutcome({ status: null, signal: 'SIGTERM' }, ['entry', 'ready'], false).status, 'failed');
});

test('owned Node control produces real entry/readiness markers without Electron or SQLite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-bootstrap-source-'));
  try {
    const marker = join(root, 'marker.txt'), entry = join(root, 'probe.cjs');
    await writeFile(entry, buildBootstrapSource('node-basic'));
    const result = spawnSync(process.execPath, [entry], { env: { ...process.env, SF_BOOTSTRAP_MARKER: marker }, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    const stages = (await readFile(marker, 'utf8')).trim().split('\n');
    assert.deepEqual(stages, ['entry', 'ready']);
    assert.equal(evaluateBootstrapOutcome(result, stages, false).status, 'passed');
  } finally { await rm(root, { recursive: true, force: true }); }
});
