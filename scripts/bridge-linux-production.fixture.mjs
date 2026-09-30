import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { assertBridgeProductionBuildFresh, writeBridgeProductionBuildReceipt } from './bridge-production-build.mjs';
import * as artifacts from './agent-production-build-lib.mjs';
import { validatePortableBuilderResourceSources } from './portable-packaging-config.mjs';

test('an empty Linux publish directory cannot pass apphost source preflight', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-empty-publish-'));
  try {
    const config = JSON.parse(await readFile(new URL('../apps/desktop/electron-builder.json', import.meta.url), 'utf8'));
    const resource = config.linux.extraResources[0];
    const configDir = join(root, 'apps/desktop'); await mkdir(configDir, { recursive: true });
    await mkdir(join(root, 'bridge/SoulForge.Bridge/bin/Release/net10.0/linux-x64/publish'), { recursive: true });
    const checks = validatePortableBuilderResourceSources({ extraResources: [], linux: { extraResources: [resource] } }, configDir, { platform: 'linux' });
    assert.equal(checks.length, 1); assert.equal(checks[0].ok, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('production artifact target identifies native Linux and explicit Windows snapshots', () => {
  assert.equal(artifacts.agentArtifactBridgeTarget({ runtimeIdentifier: 'linux-x64' }).executable,
    'bridge/SoulForge.Bridge/bin/Release/net10.0/linux-x64/publish/SoulForge.Bridge');
  assert.equal(artifacts.agentArtifactBridgeTarget({ runtimeIdentifier: 'win-x64' }).executable,
    'bridge/SoulForge.Bridge/bin/Release/net10.0/win-x64/publish/SoulForge.Bridge.exe');
});

test('production harness accepts a Linux snapshot and rejects an outside executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-linux-snapshot-harness-'));
  const linuxExe = 'bridge/SoulForge.Bridge/bin/Release/net10.0/linux-x64/publish/SoulForge.Bridge';
  const outRoot = join(root, 'apps/desktop/out');
  const manifestPath = join(root, 'agent-production-snapshot.json');
  try {
    for (const path of ['apps/desktop/.native/better_sqlite3.node', 'apps/desktop/out/main/index.js',
      'apps/desktop/out/preload/index.cjs', 'apps/desktop/out/renderer/index.html',
      'bridge/SoulForge.Bridge/SoulForge.Bridge.csproj', linuxExe, 'prompt/system.md']) {
      await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), 'fixture');
    }
    const manifest = { artifactId: 'a'.repeat(64), runtime: { bridgeExecutable: linuxExe, bridgeRuntimeIdentifier: 'linux-x64' } };
    await writeFile(manifestPath, JSON.stringify(manifest));
    const source = await readFile(new URL('../apps/desktop/e2e/playwright/production-main.mjs', import.meta.url), 'utf8');
    const guard = source.slice(source.indexOf('if (snapshotRoot) {'), source.indexOf('/**\n * 生产 main 关闭链路'));
    const context = { snapshotRoot: root, outRoot, existsSync, join, resolve: (await import('node:path')).resolve,
      readFileSync: (await import('node:fs')).readFileSync, process: { env: {}, chdir() {} } };
    assert.doesNotThrow(() => vm.runInNewContext(guard, context));
    manifest.runtime.bridgeExecutable = '../outside'; await writeFile(manifestPath, JSON.stringify(manifest));
    assert.throws(() => vm.runInNewContext(guard, context), /SNAPSHOT.*INVALID/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Linux publish receipts bind native apphost and selected publish inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-linux-receipt-'));
  const seed = async (path, data) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), data);
  };
  const linux = { runtimeIdentifier: 'linux-x64' };
  const winExe = 'bridge/SoulForge.Bridge/bin/Release/net10.0/win-x64/publish/SoulForge.Bridge.exe';
  const linuxExe = 'bridge/SoulForge.Bridge/bin/Release/net10.0/linux-x64/publish/SoulForge.Bridge';
  try {
    await seed('global.json', '{}');
    await seed('scripts/run-dotnet.mjs', '// fixture');
    await seed('bridge/SoulForge.Bridge/Program.cs', '// source');
    await seed('package.json', JSON.stringify({ scripts: { 'bridge:publish': 'publish win-x64', 'bridge:publish:linux': 'publish linux-x64' } }));
    await seed(winExe, 'neighbor Windows executable');
    await seed(linuxExe, 'native Linux executable');
    const written = await writeBridgeProductionBuildReceipt(root, linux);
    assert.equal(written.receipt.executable.path, linuxExe);
    assert.equal(written.receipt.source.publishScriptInput, 'package.json#scripts.bridge:publish:linux');
    await assertBridgeProductionBuildFresh(root, linux);
    await seed(winExe, 'unrelated Windows rebuild');
    await assertBridgeProductionBuildFresh(root, linux);
    await seed(linuxExe, 'changed Linux executable');
    await assert.rejects(assertBridgeProductionBuildFresh(root, linux), { code: 'BRIDGE_PRODUCTION_BUILD_STALE' });
    await writeBridgeProductionBuildReceipt(root, linux);
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    pkg.scripts['bridge:publish:linux'] += ' changed';
    await seed('package.json', JSON.stringify(pkg));
    await assert.rejects(assertBridgeProductionBuildFresh(root, linux), { code: 'BRIDGE_PRODUCTION_BUILD_STALE' });
    await assert.rejects(writeBridgeProductionBuildReceipt(root, { runtimeIdentifier: 'untrusted/../target' }), /Unsupported Bridge runtime/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
