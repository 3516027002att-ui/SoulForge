import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const assertions = await import('../packages/core/src/testing/staleValidationAssertions.ts').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const evidence = await import('../apps/desktop/src/main/me3SekiroSessionEvidence.ts').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

// Fixed, reviewed inputs; these expectations do not come from parser output.
test('enabled Sekiro bytecode snapshot keeps the exact profile and denies disabled/wrong profiles', () => {
  assert.equal(typeof assertions.assertSekiroBytecodeSnapshot, 'function');
  const valid = { representation: 'bytecode', loaderProfileId: 'sekiro-ai-luabnd', canWriteBack: true };
  assertions.assertSekiroBytecodeSnapshot(valid);
  assert.throws(() => assertions.assertSekiroBytecodeSnapshot({ ...valid, canWriteBack: false }));
  assert.throws(() => assertions.assertSekiroBytecodeSnapshot({ ...valid, loaderProfileId: 'unknown' }));
});

test('indexed URI search uses record.matches and rejects missing/wrong/duplicate identities', () => {
  assert.equal(typeof assertions.requireIndexedSearchResult, 'function');
  const uri = 'file://chr/c7100.anibnd.dcx';
  const result = { ok: true, data: { items: [], record: { matches: [{ item: { sourceUri: uri, resourceKind: 'chr' } }] } } };
  assert.equal(assertions.requireIndexedSearchResult(result, uri).sourceUri, uri);
  assert.throws(() => assertions.requireIndexedSearchResult({ ok: true, data: { items: result.data.record.matches } }, uri));
  assert.throws(() => assertions.requireIndexedSearchResult(result, 'file://chr/wrong.anibnd.dcx'));
  assert.throws(() => assertions.requireIndexedSearchResult({ ...result, data: { record: { matches: [...result.data.record.matches, ...result.data.record.matches] } } }, uri));
});

test('rollback requires a committed operation id before any invocation', () => {
  assert.equal(typeof assertions.requireRollbackOpId, 'function');
  assert.equal(assertions.requireRollbackOpId({ data: { record: { opId: 'fixture-commit-42' } } }), 'fixture-commit-42');
  for (const bad of [{}, { data: { record: {} } }, { data: { record: { opId: ' ' } } }, { data: { record: { opId: 42 } } }]) {
    assert.throws(() => assertions.requireRollbackOpId(bad));
  }
});

test('GLB sample selection reports empty documents but rejects failed or malformed native reads', () => {
  assert.equal(typeof assertions.classifyGlbDocument, 'function');
  assert.equal(assertions.classifyGlbDocument({ parseStatus: 'parsed', data: { meshCount: 0 } }), 'empty');
  assert.equal(assertions.classifyGlbDocument({ parseStatus: 'partial', data: { meshCount: 2 } }), 'candidate');
  for (const bad of [{ parseStatus: 'unparsed', data: { meshCount: 0 } }, { parseStatus: 'unsupported', data: { meshCount: 0 } }, { parseStatus: 'failed', data: { meshCount: 0 } }, { data: {} }, { data: { meshCount: -1 } }, { data: { meshCount: 0.5 } }]) {
    assert.throws(() => assertions.classifyGlbDocument(bad));
  }
});

test('GLB mesh selection only excludes explicitly classified empty topology', () => {
  assert.equal(typeof assertions.classifyGlbMesh, 'function');
  const empty = { parseStatus: 'partial', diagnostics: [{ code: 'FLVER_MESH_EMPTY_TOPOLOGY' }], data: { meshIndex: 0, vertexCount: 3, indexCount: 3, geometryEmpty: true } };
  assert.equal(assertions.classifyGlbMesh(empty, 0), 'empty');
  assert.equal(assertions.classifyGlbMesh({ parseStatus: 'partial', data: { meshIndex: 0, vertexCount: 3, indexCount: 3, positionsBase64: 'fixture' } }, 0), 'drawable');
  assert.throws(() => assertions.classifyGlbMesh({ ...empty, diagnostics: [] }, 0));
  assert.throws(() => assertions.classifyGlbMesh({ ...empty, parseStatus: 'failed' }, 0));
  assert.throws(() => assertions.classifyGlbMesh(empty, 1));
  assert.throws(() => assertions.classifyGlbMesh({ ...empty, parseStatus: 'unsupported' }, 0));
});

test('me3 expected loader log is disclosed while asset changes/removal still fail', () => {
  assert.equal(typeof evidence.classifyGameDirectoryChanges, 'function');
  const asset = { name: 'sekiro.exe', size: 10, mtimeMs: 1 };
  const log = { name: 'mod_loader_log.txt', size: 20, mtimeMs: 2 };
  assert.deepEqual(evidence.classifyGameDirectoryChanges([asset], [asset, log]), { runtimeArtifactChanges: ['added:mod_loader_log.txt'], unexpectedChanges: [] });
  assert.deepEqual(evidence.classifyGameDirectoryChanges([asset], [{ ...asset, size: 11 }, log]).unexpectedChanges, ['changed:sekiro.exe']);
  assert.deepEqual(evidence.classifyGameDirectoryChanges([asset, log], [asset]).unexpectedChanges, ['removed:mod_loader_log.txt']);
  assert.deepEqual(evidence.classifyGameDirectoryChanges([asset], [asset, { ...log, name: 'other.log' }]).unexpectedChanges, ['added:other.log']);
});

test('early cleanup never fabricates a watchdog timeout or successful termination', () => {
  assert.equal(typeof evidence.cleanupDiagnostic, 'function');
  const attempts = [{ image: 'sekiro.exe', pid: 21, exitCode: 0, remainingPids: [] }, { image: 'me3.exe', pid: 22, exitCode: 1, remainingPids: [22] }];
  const failure = evidence.cleanupDiagnostic('failure', attempts, 8600, 180000);
  assert.equal(failure.code, 'ME3_SESSION_FAILURE_CLEANUP');
  assert.equal(failure.details.timedOut, false);
  assert.deepEqual(failure.details.terminatedPids, [21]);
  assert.deepEqual(failure.details.residualPids, [22]);
  assert.equal(evidence.cleanupDiagnostic('watchdog', [], 180001, 180000).code, 'ME3_SESSION_WATCHDOG_TIMEOUT');
  const successive = [{ image: 'sekiro.exe', pid: 21, exitCode: 0, remainingPids: [22] }, { image: 'sekiro.exe', pid: 22, exitCode: 0, remainingPids: [] }];
  assert.deepEqual(evidence.cleanupDiagnostic('failure', successive, 8600, 180000).details.residualPids, []);
  const unknown = evidence.cleanupDiagnostic('failure', [{ image: 'sekiro.exe', pid: 21, exitCode: 0, remainingPids: null }], 8600, 180000, ['tasklist failed']);
  assert.equal(unknown.details.residualObservationComplete, false);
  assert.deepEqual(unknown.details.terminatedPids, []);
});

test('renderer tests retain fixed localized assertions and per-test profile cleanup', async () => {
  const source = await readFile(new URL('../apps/desktop/e2e/playwright/tests/renderer.spec.mjs', import.meta.url), 'utf8');
  const verify = text => {
    assert.doesNotMatch(text, /mode:\s*'serial'/);
    assert.match(text, /test\.afterEach/);
    assert.match(text, /userDataDirs\.get\(test\.info\(\)\.testId\)/);
    for (const label of ['参数文件', '行', '字段', '动画', '文本分类', '文本条目', '文件 / 状态机 / 状态', '条件与命令']) {
      assert.ok(text.includes(`name: '${label}'`), `missing fixed localized region ${label}`);
    }
    assert.match(text, /getByLabel\('行为工作台'\)/);
  };
  verify(source);
  for (const label of ['参数文件', '行', '字段', '动画', '文本分类', '文本条目', '文件 / 状态机 / 状态', '条件与命令']) {
    assert.throws(() => verify(source.replaceAll(`name: '${label}'`, "name: 'incorrect-label'")), `negative label ${label}`);
  }
  assert.throws(() => verify(source + "\ntest.describe.configure({ mode: 'serial' });"));
});


test('actual Playwright runner executes the tail after a failure with an isolated clean profile', async t => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const cli = join(root, 'node_modules', 'playwright', 'cli.js');
  try { await access(cli); } catch { t.skip('owned Playwright dependency unavailable; control was not executed'); return; }
  const parent = join(root, 'output');
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(join(parent, 'issue24-playwright-'));
  const source = await readFile(new URL('../apps/desktop/e2e/playwright/tests/renderer.spec.mjs', import.meta.url), 'utf8');
  const hooks = source.slice(source.indexOf('const userDataDirs ='), source.indexOf('// Default Playwright mode'));
  const modes = [...source.matchAll(/test\.describe\.configure\([^;]+;/g)].map(match => match[0]).join('\n');
  const pathsFile = join(dir, 'profiles.json');
  const reportFile = join(dir, 'report.json');
  const spec = `import { test, expect } from '@playwright/test';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
${hooks}
${modes}
const recordProfile = dir => fs.appendFileSync(${JSON.stringify(pathsFile)}, JSON.stringify(dir) + '\\n');
test('deliberate first failure', () => {
  const dir = userDataDirs.get(test.info().testId); recordProfile(dir);
  fs.writeFileSync(path.join(dir, 'state-leak'), 'first-test');
  expect(false, 'deliberate independent-test failure').toBe(true);
});
test('tail still executes with clean profile', () => {
  const dir = userDataDirs.get(test.info().testId); recordProfile(dir);
  expect(fs.existsSync(path.join(dir, 'state-leak'))).toBe(false);
});
`;
  try {
    await writeFile(join(dir, 'control.spec.mjs'), spec);
    await writeFile(join(dir, 'playwright.config.mjs'), `import base from ${JSON.stringify(new URL('../apps/desktop/e2e/playwright/playwright.config.mjs', import.meta.url).href)};
export default { ...base, testDir: '.', reporter: [['json', { outputFile: ${JSON.stringify(reportFile)} }]], outputDir: ${JSON.stringify(join(dir, 'results'))} };`);
    const result = spawnSync(process.execPath, [cli, 'test', '-c', join(dir, 'playwright.config.mjs')], { cwd: root, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(await readFile(reportFile, 'utf8'));
    const specs = report.suites.flatMap(suite => suite.specs);
    assert.equal(specs.length, 2);
    assert.equal(specs[0].tests[0].results[0].status, 'failed');
    assert.equal(specs[1].tests[0].results[0].status, 'passed', 'tail must execute despite first assertion failure');
    const profiles = (await readFile(pathsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(profiles.length, 2);
    assert.notEqual(profiles[0], profiles[1]);
    for (const profile of profiles) await assert.rejects(access(profile), /ENOENT/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('me3 and section28 retain explicit skipped boundaries without launching or building on Linux', async t => {
  if (process.platform === 'win32') { t.skip('Linux platform boundary case'); return; }
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const runner = spawnSync(process.execPath, ['scripts/verify-me3-sekiro-session.mjs'], {
    cwd: root, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, SOULFORGE_SEKIRO_GAME_ROOT: '/fixture/no-game-execution', SOULFORGE_ME3_SEKIRO_SESSION_RUN: '1' }
  });
  assert.equal(runner.status, 0, runner.stderr);
  const skipped = JSON.parse(runner.stdout);
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.code, 'ME3_SEKIRO_PLATFORM_UNAVAILABLE');
  const { classifyOutcome } = await import('./verify/runner.mjs');
  assert.equal(classifyOutcome(runner.status, runner.stdout).outcome, 'skipped');
  const source = await readFile(new URL('./verify-section28-sekiro-gate.mjs', import.meta.url), 'utf8');
  const verify = text => {
    assert.match(text, /const outcome = classifyOutcome\(result\.code, result\.stdout, result\.stderr, entry\.name\)/);
    assert.match(text, /const ok = processOk && outcome\.outcome === OUTCOME\.PASSED/);
    assert.match(text, /status: outcome\.outcome/);
  };
  verify(source);
  assert.throws(() => verify(source.replace('const ok = processOk && outcome.outcome === OUTCOME.PASSED', 'const ok = processOk')));
});
