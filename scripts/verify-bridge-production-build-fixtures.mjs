import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  BRIDGE_PRODUCTION_BUILD_RECEIPT,
  assertBridgeProductionBuildFresh,
  writeBridgeProductionBuildReceipt
} from './bridge-production-build.mjs';

const root = await mkdtemp(join(tmpdir(), 'soulforge-bridge-production-build-'));

async function seed(path, content) {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

async function updatePackage(mutator) {
  const packagePath = join(root, 'package.json');
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  const next = mutator(packageJson) ?? packageJson;
  await writeFile(packagePath, `${JSON.stringify(next, null, 2)}\n`);
}

async function expectStale(label, mutate) {
  await mutate();
  await assert.rejects(
    () => assertBridgeProductionBuildFresh(root),
    (error) => error?.code === 'BRIDGE_PRODUCTION_BUILD_STALE',
    label
  );
}

try {
  await seed('global.json', '{"sdk":{"version":"6.0.100","rollForward":"latestMajor"}}\n');
  await seed('package.json', `${JSON.stringify({
    scripts: {
      'bridge:publish': 'node scripts/run-dotnet.mjs publish bridge/SoulForge.Bridge/SoulForge.Bridge.csproj -c Release',
      test: 'echo fixture baseline'
    }
  }, null, 2)}\n`);
  await seed('scripts/run-dotnet.mjs', 'spawn dotnet with controlled arguments\n');
  await seed('bridge/SoulForge.Bridge/Program.cs', 'class Program { }\n');
  await seed('bridge/SoulForge.Bridge/FormatRules/rules.json', '{"version":1}\n');
  await seed(
    'bridge/SoulForge.Bridge/bin/Release/net10.0/win-x64/publish/SoulForge.Bridge.exe',
    'bridge executable v1\n'
  );
  // Generated/VCS directories are deliberately outside the source fingerprint.
  await seed('bridge/SoulForge.Bridge/bin/ignored-source.cs', 'ignored\n');
  await seed('bridge/SoulForge.Bridge/obj/ignored-source.cs', 'ignored\n');
  await seed('bridge/SoulForge.Bridge/.git/ignored-source', 'ignored\n');

  await assert.rejects(
    () => assertBridgeProductionBuildFresh(root),
    (error) => error?.code === 'BRIDGE_PRODUCTION_BUILD_STALE',
    '缺少 receipt 必须失败'
  );

  const written = await writeBridgeProductionBuildReceipt(root);
  assert.equal(written.manifestPath, join(root, BRIDGE_PRODUCTION_BUILD_RECEIPT));
  const fresh = await assertBridgeProductionBuildFresh(root);
  assert.equal(fresh.current.source.fileCount, 5);
  assert.equal(fresh.current.executable.sha256, written.receipt.executable.sha256);

  await seed('bridge/SoulForge.Bridge/bin/ignored-source.cs', 'ignored changed\n');
  await seed('bridge/SoulForge.Bridge/obj/ignored-source.cs', 'ignored changed\n');
  await seed('bridge/SoulForge.Bridge/.git/ignored-source', 'ignored changed\n');
  await assertBridgeProductionBuildFresh(root);

  await expectStale('源码变更必须拒绝旧 receipt', async () => {
    await seed('bridge/SoulForge.Bridge/Program.cs', 'class Program { static int Version => 2; }\n');
  });

  await writeBridgeProductionBuildReceipt(root);
  await expectStale('run-dotnet helper 变更必须拒绝旧 receipt', async () => {
    await seed('scripts/run-dotnet.mjs', 'spawn dotnet with changed arguments\n');
  });

  await writeBridgeProductionBuildReceipt(root);
  await expectStale('global.json 变更必须拒绝旧 receipt', async () => {
    await seed('global.json', '{"sdk":{"version":"6.0.200","rollForward":"latestMajor"}}\n');
  });

  await writeBridgeProductionBuildReceipt(root);
  await expectStale('EXE 变更必须拒绝旧 receipt', async () => {
    await seed(
      'bridge/SoulForge.Bridge/bin/Release/net10.0/win-x64/publish/SoulForge.Bridge.exe',
      'bridge executable v2\n'
    );
  });

  await writeBridgeProductionBuildReceipt(root);
  await expectStale('bridge:publish 参数变更必须拒绝旧 receipt', async () => {
    await updatePackage((packageJson) => {
      packageJson.scripts['bridge:publish'] += ' --no-restore';
      return packageJson;
    });
  });

  await writeBridgeProductionBuildReceipt(root);
  await updatePackage((packageJson) => {
    packageJson.scripts.test = 'echo unrelated fixture change';
    return packageJson;
  });
  await assertBridgeProductionBuildFresh(root);

  const receiptPath = join(root, BRIDGE_PRODUCTION_BUILD_RECEIPT);
  await writeBridgeProductionBuildReceipt(root);
  const tampered = JSON.parse(await readFile(receiptPath, 'utf8'));
  tampered.helper.sha256 = '0'.repeat(64);
  await writeFile(receiptPath, `${JSON.stringify(tampered, null, 2)}\n`);
  await assert.rejects(
    () => assertBridgeProductionBuildFresh(root),
    (error) => error?.code === 'BRIDGE_PRODUCTION_BUILD_STALE',
    'helper 规则指纹变化必须拒绝旧 receipt'
  );

  console.log(JSON.stringify({
    ok: true,
    checks: 11,
    message: 'Bridge production receipt fixtures passed'
  }));
} finally {
  await unlink(join(root, BRIDGE_PRODUCTION_BUILD_RECEIPT)).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
