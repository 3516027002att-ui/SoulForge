import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildPublicCiReport, PUBLIC_CI_CHECKS } from './ci-public-report.mjs';

const success = () => Object.fromEntries(PUBLIC_CI_CHECKS.map(({ id }) => [id, { outcome: 'success' }]));

test('a successful public matrix leg preserves unavailable private acceptance checks', () => {
  const report = buildPublicCiReport({ steps: success(), runtime: 'linux-x64', commit: 'a'.repeat(40) });
  assert.equal(report.publicStatus, 'passed');
  assert.equal(report.acceptanceComplete, false);
  assert.ok(report.unavailableChecks.length >= 3);
  assert.ok(report.unavailableChecks.every(check => check.status === 'unavailable'));
  assert.ok(report.publicChecks.every(check => check.status === 'passed'));
});

test('failed, skipped, cancelled and absent steps cannot become passed checks', () => {
  for (const outcome of ['failure', 'skipped', 'cancelled', undefined]) {
    const steps = success();
    steps.database = outcome === undefined ? {} : { outcome };
    const report = buildPublicCiReport({ steps, runtime: 'win-x64' });
    assert.notEqual(report.publicStatus, 'passed');
    assert.notEqual(report.publicChecks.find(check => check.id === 'database').status, 'passed');
  }
});

test('unknown outcomes and unsupported runtimes fail closed', () => {
  assert.throws(() => buildPublicCiReport({ steps: { install: { outcome: 'maybe' } }, runtime: 'linux-x64' }), /outcome/);
  assert.throws(() => buildPublicCiReport({ steps: success(), runtime: 'macos-arm64' }), /runtime/);
});

test('theme runtime failures and missing runs remain visible independently of a successful database smoke', () => {
  for (const outcome of ['failure', 'skipped', undefined]) {
    const steps = success();
    steps.theme = outcome === undefined ? {} : { outcome };
    const report = buildPublicCiReport({ steps, runtime: 'win-x64' });
    const theme = report.publicChecks.find(check => check.id === 'theme');
    assert.ok(theme, 'the real theme/frame runtime must have its own public outcome');
    assert.equal(theme.status, outcome === 'failure' ? 'failed' : 'not_run');
    assert.equal(report.publicChecks.find(check => check.id === 'database').status, 'passed');
    assert.notEqual(report.publicStatus, 'passed');
    assert.equal(report.acceptanceComplete, false);
  }
});

test('the actual report entry writes archive evidence and the GitHub summary without claiming private acceptance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-ci-report-'));
  try {
    const bytes = Buffer.from('synthetic CI archive');
    const archive = join(root, 'package.tar.gz');
    const summary = join(root, 'summary.md');
    await writeFile(archive, bytes);
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('./ci-public-report.mjs', import.meta.url))], {
      cwd: root, encoding: 'utf8', env: { ...process.env, CI_RUNTIME: 'linux-x64',
        CI_STEP_OUTCOMES: JSON.stringify(success()), CI_PACKAGE_ARCHIVE: archive, GITHUB_STEP_SUMMARY: summary }
    });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(await readFile(join(root, 'output/ci-public-linux-x64.json'), 'utf8'));
    assert.equal(report.packageArchive.bytes, bytes.length);
    assert.equal(report.packageArchive.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(report.acceptanceComplete, false);
    assert.match(await readFile(summary, 'utf8'), /unavailable: Real-provider Agent tasks/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the public Windows/Linux matrix runs for main pushes and main pull requests', async () => {
  const workflow = await readFile(new URL('../.github/workflows/desktop-platform-ci.yml', import.meta.url), 'utf8');
  const lines = workflow.split(/\r?\n/);
  for (const event of ['push', 'pull_request']) {
    const index = lines.indexOf('  ' + event + ':');
    assert.ok(index >= 0, event + ' must declare its target branches');
    const match = lines[index + 1].trim().match(/^branches: \[([^\]]+)\]$/);
    assert.ok(match, event + ' must declare its target branches');
    const branches = match[1].split(',').map(branch => branch.trim());
    assert.ok(branches.includes('main'), event + ' must verify the final main integration');
    assert.ok(branches.includes('linux'), event + ' must retain Linux branch coverage');
  }
});
