import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { classifyChange, inTrustZone, runTrustZoneCheck } from './trust-zone-check.mjs';

test('a change mixing trust-zone and other paths is rejected', () => {
  const result = classifyChange(['.github/workflows/windows-ci.yml', 'packages/core/src/index.ts']);
  assert.equal(result.ok, false);
  assert.deepEqual(result.zone, ['.github/workflows/windows-ci.yml']);
  assert.deepEqual(result.other, ['packages/core/src/index.ts']);
});

test('zone-only, other-only and empty changes pass', () => {
  assert.equal(classifyChange(['AGENTS.md', 'scripts/verify/runner.mjs']).ok, true);
  assert.equal(classifyChange(['packages/core/src/index.ts', 'README.md']).ok, true);
  assert.equal(classifyChange([]).ok, true);
});

test('zone matching is exact for files and prefix-only for directories', () => {
  assert.equal(inTrustZone('packages/core/src/patch/patchEngine.ts'), true);
  assert.equal(inTrustZone('packages\\core\\src\\patch\\rollback.ts'), true);
  assert.equal(inTrustZone('packages/core/src/patch-engine/patchIr.ts'), false);
  assert.equal(inTrustZone('AGENTS.md.bak'), false);
  assert.equal(inTrustZone('docs/AGENTS.md'), false);
  assert.equal(inTrustZone('scripts/check.mjs'), true);
  assert.equal(inTrustZone('scripts/check-something-else.mjs'), false);
});

async function addChecker(root, git) {
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'scripts', 'trust-zone-check.mjs'), '// checker\n');
  git('add', 'scripts/trust-zone-check.mjs');
  git('commit', '-q', '-m', 'checker');
}

// zone: whether the base commit already carries the trust-zone checker.
async function repo({ zone = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sf-trust-zone-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  await writeFile(join(root, 'README.md'), 'base\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'base');
  if (zone) await addChecker(root, git);
  return { root, git, base: git('rev-parse', 'HEAD').trim() };
}

async function commitMixedChange(root, git) {
  await mkdir(join(root, '.github'), { recursive: true });
  await writeFile(join(root, '.github', 'CODEOWNERS'), '* @owner\n');
  await writeFile(join(root, 'README.md'), 'changed\n');
  git('add', '.github/CODEOWNERS', 'README.md');
  git('commit', '-q', '-m', 'mixed');
}

test('the change that introduces the trust zone is not judged by a zone the target does not have', async () => {
  const { root, git, base } = await repo({ zone: false });
  try {
    await commitMixedChange(root, git);
    const result = runTrustZoneCheck({ cwd: root, base });
    assert.equal(result.bootstrap, true);
    assert.equal(result.ok, true);
    assert.deepEqual(result.zone, ['.github/CODEOWNERS']);
    assert.deepEqual(result.other, ['README.md']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('once the target has the checker, a branch forked before it is still judged', async () => {
  const { root, git, base } = await repo({ zone: false });
  try {
    git('checkout', '-q', '-b', 'feature', base);
    await commitMixedChange(root, git);
    git('checkout', '-q', 'main');
    await addChecker(root, git);
    const target = git('rev-parse', 'HEAD').trim();
    git('checkout', '-q', 'feature');
    // The merge-base is the fork point, which predates the checker; the target is asked instead.
    const result = runTrustZoneCheck({ cwd: root, base: target });
    assert.equal(result.base, base);
    assert.equal(result.bootstrap, false);
    assert.equal(result.ok, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a target that has the checker rejects a mixed change', async () => {
  const { root, git, base } = await repo();
  try {
    await commitMixedChange(root, git);
    const result = runTrustZoneCheck({ cwd: root, base });
    assert.equal(result.bootstrap, false);
    assert.equal(result.ok, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the check sees committed, uncommitted and untracked changes against the base', async () => {
  const { root, git, base } = await repo();
  try {
    await mkdir(join(root, '.github'));
    await writeFile(join(root, '.github', 'CODEOWNERS'), '* @owner\n');
    git('add', '.github/CODEOWNERS');
    git('commit', '-q', '-m', 'zone');
    assert.equal(runTrustZoneCheck({ cwd: root, base }).ok, true);
    await writeFile(join(root, 'README.md'), 'changed\n');
    const tracked = runTrustZoneCheck({ cwd: root, base });
    assert.equal(tracked.ok, false);
    assert.deepEqual(tracked.other, ['README.md']);
    git('checkout', '-q', '--', 'README.md');
    await writeFile(join(root, 'new.txt'), 'untracked\n');
    assert.deepEqual(runTrustZoneCheck({ cwd: root, base }).other, ['new.txt']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an explicit base that cannot be resolved fails closed', async () => {
  const { root } = await repo();
  try {
    assert.throws(() => runTrustZoneCheck({ cwd: root, base: 'f'.repeat(40) }), /TRUST_ZONE_BASE_UNRESOLVED/);
    // No origin/main in the fixture, so the missing-base fallback also fails closed.
    assert.throws(() => runTrustZoneCheck({ cwd: root, base: '0'.repeat(40) }), /TRUST_ZONE_BASE_UNRESOLVED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
