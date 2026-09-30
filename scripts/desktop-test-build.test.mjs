import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const build = await import('./desktop-test-build.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

test('headless Electron smoke selects a display backend without relaxing sandbox settings', () => {
  assert.equal(typeof build.desktopSmokeArgs, 'function');
  assert.deepEqual(build.desktopSmokeArgs('/isolated/main/smoke.js', false), ['/isolated/main/smoke.js']);
  assert.deepEqual(build.desktopSmokeArgs('/isolated/main/smoke.js', true), ['/isolated/main/smoke.js', '--ozone-platform=headless']);
});

test('smoke output allocation is distinct, bounded, and cleaned without touching production', async () => {
  assert.equal(typeof build.withDesktopTestBuild, 'function', 'smoke builds require an isolated output owner');
  const root = await mkdtemp(join(tmpdir(), 'sf-build-test-'));
  try {
    const production = join(root, 'apps/desktop/out/main'); await mkdir(production, { recursive: true });
    await writeFile(join(production, 'index.js'), 'sentinel');
    const roots = [];
    for (let i = 0; i < 2; i++) await build.withDesktopTestBuild('database', async allocation => {
      roots.push(allocation.outputRoot); await writeFile(join(allocation.outputRoot, 'test-output'), 'test');
      assert.equal(allocation.env.SOULFORGE_BUILD_DATABASE_UTILITY_SMOKE, '1');
      assert.equal(allocation.env.SOULFORGE_TEST_BUILD_ROOT, allocation.outputRoot);
    }, { repositoryRoot: root, build: false });
    assert.notEqual(roots[0], roots[1]);
    for (const path of roots) await assert.rejects(readFile(join(path, 'test-output')), { code: 'ENOENT' });
    assert.equal(await readFile(join(production, 'index.js'), 'utf8'), 'sentinel');
    await assert.rejects(build.withDesktopTestBuild('database', async () => { throw new Error('test-failure'); }, { repositoryRoot: root, build: false }), /test-failure/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('packaging disables repository native rebuild and smoke config refuses production output', async () => {
  const builder = JSON.parse(await readFile(resolve('apps/desktop/electron-builder.json'), 'utf8'));
  assert.equal(builder.npmRebuild, false);
  const config = await readFile(resolve('apps/desktop/electron.vite.config.ts'), 'utf8');
  assert.match(config, /SOULFORGE_TEST_BUILD_ROOT/);
  assert.match(config, /DESKTOP_TEST_BUILD_ROOT_REQUIRED/);
});

test('smoke config rejects every production descendant, including names starting with two dots', () => {
  const configUrl = pathToFileURL(resolve('apps/desktop/electron.vite.config.ts')).href;
  for (const output of ['apps/desktop/out', 'apps/desktop/out/smoke', 'apps/desktop/out/..smoke']) {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `await import(${JSON.stringify(configUrl)});`], {
      encoding: 'utf8', env: { ...process.env, SOULFORGE_BUILD_DATABASE_UTILITY_SMOKE: '1', SOULFORGE_TEST_BUILD_ROOT: resolve(output) }
    });
    assert.notEqual(result.status, 0, `production output accepted: ${output}`);
    assert.match(result.stderr, /DESKTOP_TEST_BUILD_ROOT_REQUIRED/);
  }
});
