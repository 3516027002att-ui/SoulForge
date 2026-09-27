import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runnerPath = resolve(repoRoot, 'scripts/run-real-agent-four-tasks.mjs');

test('batch runner help exits before validating task selections or dispatching children', () => {
  const result = spawnSync(process.execPath, [
    runnerPath,
    '--only',
    '__invalid_task_for_help_test__',
    '--help'
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true
  });

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /用法/u);
  assert.doesNotMatch(result.stdout, /"reportPath"/u);
  assert.equal(result.stderr, '');
});
