import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, rm, writeFile, mkdir, lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
const build = await import('./desktop-test-build.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

// Evaluate actual target/output selection without loading build plugins.
// The plugin constructors do not affect these branches; build/runtime checks
// separately execute the real plugins, bundles and Electron utility process.
async function desktopConfig(env) {
  const configUrl = pathToFileURL(resolve('apps/desktop/electron.vite.config.ts'));
  const source = (await readFile(configUrl, 'utf8'))
    .replace(/^import .+;\r?\n/gm, '')
    .replaceAll('import.meta.url', JSON.stringify(configUrl.href))
    .replace('export default ', 'globalThis.config = ');
  const path = await import('node:path');
  const url = await import('node:url');
  const context = { process: { env }, fileURLToPath: url.fileURLToPath,
    dirname: path.dirname, resolve: path.resolve, relative: path.relative,
    isAbsolute: path.isAbsolute, sep: path.sep,
    defineConfig: value => value, externalizeDepsPlugin: () => ({}), react: () => ({}) };
  runInNewContext(source, context, { timeout: 100 });
  return context.config;
}

test('isolated utility smoke builds are main-only while production retains all three targets', async () => {
  const production = await desktopConfig({});
  assert.ok(production.main && production.preload && production.renderer);
  const productionEntries = Object.keys(production.main.build.rollupOptions.input).sort();
  assert.deepEqual(productionEntries, ['agentUtility', 'databaseUtility', 'emevdDarkScriptWorker', 'index', 'ragEmbeddingWorker']);
  const root = resolve('output/config-fixture');
  for (const [flag, entry] of [
    ['SOULFORGE_BUILD_DATABASE_UTILITY_SMOKE', 'databaseUtilitySmoke'],
    ['SOULFORGE_BUILD_ME3_GATEWAY_SMOKE', 'me3RuntimeGatewaySmoke'],
    ['SOULFORGE_BUILD_ME3_SEKIRO_SESSION_SMOKE', 'me3SekiroSessionSmoke']
  ]) {
    const config = await desktopConfig({ [flag]: '1', SOULFORGE_TEST_BUILD_ROOT: root });
    assert.equal(Object.hasOwn(config, 'preload'), false, `${entry} must omit the preload target key`);
    assert.equal(Object.hasOwn(config, 'renderer'), false, `${entry} must omit the renderer target key`);
    assert.equal(config.preload, undefined, `${entry} must not rebuild an unused preload`);
    assert.equal(config.renderer, undefined, `${entry} must not rebuild an unused renderer`);
    assert.equal(config.main.build.outDir, join(root, 'main'));
    assert.deepEqual(Object.keys(config.main.build.rollupOptions.input).sort(), [...productionEntries, entry].sort());
    assert.equal(config.main.build.rollupOptions.input[entry], resolve(`apps/desktop/src/main/${entry}.ts`));
  }
});

test('headless Electron smoke selects a display backend without relaxing sandbox settings', () => {
  assert.equal(typeof build.desktopSmokeArgs, 'function');
  assert.deepEqual(build.desktopSmokeArgs('/isolated/main/smoke.js', false), ['/isolated/main/smoke.js']);
  assert.deepEqual(build.desktopSmokeArgs('/isolated/main/smoke.js', true), ['/isolated/main/smoke.js', '--ozone-platform=headless']);
  assert.deepEqual(build.desktopSmokeArgs('D:\\owned\\main\\smoke.js', false, 'D:\\owned\\.runtime\\electron.log'), [
    'D:\\owned\\main\\smoke.js', '--enable-logging=file', '--log-file=D:\\owned\\.runtime\\electron.log'
  ]);
  assert.deepEqual(build.desktopSmokeArgs('D:\\owned output\\main\\smoke.js', false, undefined, 'D:\\owned output\\.runtime\\profile'), [
    'D:\\owned output\\main\\smoke.js', '--user-data-dir=D:\\owned output\\.runtime\\profile'
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

test('desktop smoke restart reclaims a killed output owner while preserving an unmarked neighbor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-desktop-interruption-test-'));
  const moduleUrl = pathToFileURL(resolve('scripts/desktop-test-build.mjs')).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { withDesktopTestBuild } from ${JSON.stringify(moduleUrl)};
    await withDesktopTestBuild('database', async ({ outputRoot }) => {
      process.send(outputRoot); await new Promise(() => { setInterval(() => {}, 1000); });
    }, { repositoryRoot: ${JSON.stringify(root)}, build: false });
  `], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  try {
    const [predecessor] = await once(child, 'message');
    const parent = join(root, 'output/desktop-smoke-builds');
    const neighbor = join(parent, 'database-user-output'); await mkdir(neighbor); await writeFile(join(neighbor, 'sentinel'), 'preserved');
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    await build.withDesktopTestBuild('database', async () => {
      await assert.rejects(lstat(predecessor), { code: 'ENOENT' });
      assert.equal(await readFile(join(neighbor, 'sentinel'), 'utf8'), 'preserved');
    }, { repositoryRoot: root, build: false });
    assert.deepEqual(await readdir(parent), ['database-user-output']);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    await rm(root, { recursive: true, force: true });
  }
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

test('production binding snapshots stay immutable while each smoke owns its writable copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-smoke-native-snapshot-'));
  try {
    const native = join(root, 'apps/desktop/.native');
    await mkdir(native, { recursive: true });
    for (const [name, version] of [['electron', '43.0.0'], ['better-sqlite3', '12.11.1']]) {
      const dir = join(root, 'node_modules', name); await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'package.json'), JSON.stringify({ version }));
    }
    await writeFile(join(native, 'better_sqlite3.node'), 'immutable-native-input');
    await writeFile(join(native, 'better_sqlite3.json'), JSON.stringify({ electronVersion: '43.0.0', betterSqlite3Version: '12.11.1', platform: process.platform, arch: process.arch }));
    const copies = [];
    for (let i = 0; i < 2; i++) await build.withDesktopTestBuild('database', async ({ env }) => {
      copies.push(env.SOULFORGE_SQLITE_NATIVE_BINDING);
      assert.equal(await readFile(env.SOULFORGE_SQLITE_NATIVE_BINDING, 'utf8'), 'immutable-native-input');
      await writeFile(env.SOULFORGE_SQLITE_NATIVE_BINDING, 'owned-change');
      assert.equal(await readFile(join(native, 'better_sqlite3.node'), 'utf8'), 'immutable-native-input');
    }, { repositoryRoot: root, build: false, reuseProductionBinding: true });
    assert.notEqual(copies[0], copies[1]);
    for (const copy of copies) await assert.rejects(readFile(copy), { code: 'ENOENT' });
    await writeFile(join(native, 'better_sqlite3.json'), JSON.stringify({ electronVersion: '42.0.0', betterSqlite3Version: '12.11.1', platform: process.platform, arch: process.arch }));
    await assert.rejects(build.withDesktopTestBuild('database', async () => { throw new Error('must not execute'); },
      { repositoryRoot: root, build: false, reuseProductionBinding: true }), /PRODUCTION_NATIVE_BINDING_TARGET_MISMATCH/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a real build replacing copied native bytes or metadata cannot execute as the selected snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-smoke-native-build-'));
  try {
    const native = join(root, 'apps/desktop/.native'); await mkdir(native, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/desktop'] }));
    await writeFile(join(root, 'apps/desktop/package.json'), JSON.stringify({ name: '@soulforge/desktop', scripts: { build: 'node ../../replace-binding.cjs' } }));
    for (const [name, version] of [['electron', '43.0.0'], ['better-sqlite3', '12.11.1']]) {
      const dir = join(root, 'node_modules', name); await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'package.json'), JSON.stringify({ version }));
    }
    await writeFile(join(native, 'better_sqlite3.node'), 'immutable-native-input');
    await writeFile(join(native, 'better_sqlite3.json'), JSON.stringify({ electronVersion: '43.0.0', betterSqlite3Version: '12.11.1', platform: process.platform, arch: process.arch }));
    for (const target of ['node', 'json']) {
      await writeFile(join(root, 'replace-binding.cjs'), `const fs=require('node:fs');fs.writeFileSync(process.env.SOULFORGE_SQLITE_NATIVE_BINDING.replace(/\\.node$/,'.${target}'),'changed-by-build');`);
      let executed = false;
      await assert.rejects(build.withDesktopTestBuild('database', async () => { executed = true; },
        { repositoryRoot: root, reuseProductionBinding: true }), /PRODUCTION_NATIVE_SNAPSHOT_CHANGED/);
      assert.equal(executed, false);
      assert.equal(await readFile(join(native, 'better_sqlite3.node'), 'utf8'), 'immutable-native-input');
    }
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
