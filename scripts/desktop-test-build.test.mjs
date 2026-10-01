import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, rm, writeFile, mkdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, relative, isAbsolute } from 'node:path';
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
  assert.deepEqual(build.desktopSmokeArgs('D:\\owned\\main\\smoke.js', false, 'D:\\owned\\.runtime\\electron.log'), [
    'D:\\owned\\main\\smoke.js', '--enable-logging=file', '--log-file=D:\\owned\\.runtime\\electron.log'
  ]);
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
      for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR']) {
        const local = relative(allocation.outputRoot, allocation.env[name]);
        assert.ok(local && !local.startsWith('..') && !isAbsolute(local), `${name} must belong to this test output`);
        const metadata = await lstat(allocation.env[name]);
        assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink());
        if (process.platform !== 'win32') assert.equal(metadata.mode & 0o777, 0o700);
      }
    }, { repositoryRoot: root, build: false });
    assert.notEqual(roots[0], roots[1]);
    for (const path of roots) await assert.rejects(readFile(join(path, 'test-output')), { code: 'ENOENT' });
    assert.equal(await readFile(join(production, 'index.js'), 'utf8'), 'sentinel');
    await assert.rejects(build.withDesktopTestBuild('database', async () => { throw new Error('test-failure'); }, { repositoryRoot: root, build: false }), /test-failure/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('runtime diagnostics retain a bounded native log tail and distinguish a missing log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-smoke-log-'));
  try {
    const log = join(root, 'electron.log');
    await writeFile(log, `${'old-line\n'.repeat(10000)}native failure\n`);
    const result = await build.readDesktopSmokeLog(log, 128);
    assert.equal(result.available, true);
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.tail) <= 128);
    assert.ok(result.tail.endsWith('native failure\n'));
    assert.deepEqual(await build.readDesktopSmokeLog(join(root, 'absent.log')), { available: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('owned bootstrap loads an ESM entry by file URL and records its real import boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-smoke-esm-'));
  try {
    const entry = join(root, 'entry with space.mjs'), marker = join(root, 'marker.txt'), bootstrap = join(root, 'bootstrap.cjs');
    await writeFile(entry, `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(marker)}, 'esm-entry\\n');`);
    await writeFile(bootstrap, build.desktopSmokeBootstrap(entry, marker));
    const result = spawnSync(process.execPath, [bootstrap], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await readFile(marker, 'utf8')).trim().split('\n'), ['bootstrap-entry', 'esm-entry', 'module-loaded']);
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
