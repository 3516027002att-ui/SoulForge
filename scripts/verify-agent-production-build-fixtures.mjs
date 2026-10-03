import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  AGENT_PRODUCTION_BUILD_MANIFEST,
  assertAgentProductionBuildFresh,
  createAgentProductionArtifactSnapshot,
  agentArtifactBridgeTarget,
  writeAgentProductionBuildManifest
} from './agent-production-build-lib.mjs';

const root = await mkdtemp(join(tmpdir(), 'soulforge-agent-build-fixture-'));

async function seed(path, content = path) {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, 'utf8');
}

async function expectStale(label, mutate) {
  await writeAgentProductionBuildManifest(root);
  await mutate();
  await assert.rejects(
    () => assertAgentProductionBuildFresh(root),
    (error) => error?.code === 'AGENT_PRODUCTION_BUILD_STALE',
    label
  );
}

try {
  for (const path of [
    'tsconfig.base.json',
    'scripts/prepare-electron-sqlite-binding.mjs',
    'prompt/system.md',
    'package.json',
    'package-lock.json',
    'packages/shared/package.json',
    'packages/shared/tsconfig.json',
    'packages/shared/src/index.ts',
    'packages/core/package.json',
    'packages/core/tsconfig.json',
    'packages/core/src/index.ts',
    'packages/agent/package.json',
    'packages/agent/src/index.mjs',
    'packages/agent/src/index.d.mts',
    'apps/desktop/package.json',
    'apps/desktop/tsconfig.json',
    'apps/desktop/electron.vite.config.ts',
    'apps/desktop/src/main/index.ts',
    'apps/desktop/.native/better_sqlite3.node',
    'apps/desktop/.native/better_sqlite3.json',
    'apps/desktop/out/main/index.js',
    'apps/desktop/out/preload/index.cjs',
    'apps/desktop/out/renderer/index.html'
  ]) await seed(path);

  const written = await writeAgentProductionBuildManifest(root);
  assert.equal(written.manifestPath, join(root, AGENT_PRODUCTION_BUILD_MANIFEST));
  const fresh = await assertAgentProductionBuildFresh(root);
  assert.equal(fresh.current.source.sha256, fresh.manifest.source.sha256);
  assert.equal(fresh.current.output.sha256, fresh.manifest.output.sha256);

  await expectStale('源码变化必须拒绝旧产物', () => seed('packages/core/src/index.ts', 'changed source'));
  await expectStale('Agent kernel-only change must invalidate the bundled artifact', () => seed('packages/agent/src/index.mjs', 'changed kernel'));
  await expectStale('Agent protocol declarations must remain source-bound', () => seed('packages/agent/src/index.d.mts', 'changed protocol'));
  await expectStale('Agent package metadata changes must invalidate the artifact', () => seed('packages/agent/package.json', 'changed metadata'));
  await expectStale('Electron 产物变化必须拒绝旧清单', () => seed('apps/desktop/out/main/index.js', 'changed output'));
  await expectStale('根 TypeScript 配置变化必须拒绝旧产物', () => seed('tsconfig.base.json', 'changed config'));
  await expectStale('原生绑定构建输入变化必须拒绝旧产物', () => seed('scripts/prepare-electron-sqlite-binding.mjs', 'changed preparation'));

  // Compiler caches and Windows profile junctions are not runtime inputs.
  const publish = agentArtifactBridgeTarget().publish;
  for (const file of ['apps/desktop/out/release-compliance.json',
    'apps/desktop/e2e/playwright/production-main.mjs', 'scripts/map-native-timing-aggregate.mjs',
    'scripts/character-native-timing-aggregate.mjs', 'scripts/character-main-timing-aggregate.mjs',
    'scripts/bridge-transport-timing-aggregate.mjs', 'bridge/SoulForge.Bridge/SoulForge.Bridge.csproj',
    publish + '/' + (process.platform === 'linux' ? 'SoulForge.Bridge' : 'SoulForge.Bridge.exe')]) await seed(file);
  await seed('apps/desktop/.native/electron-rebuild/cache/compiler-input');
  const cache = join(root, 'apps/desktop/.native/electron-rebuild/cache');
  await symlink(cache, join(root, 'apps/desktop/.native/electron-rebuild/profile-junction'),
    process.platform === 'win32' ? 'junction' : 'dir');
  await writeAgentProductionBuildManifest(root);
  await seed('apps/desktop/.native/electron-rebuild/cache/compiler-input', 'changed compiler cache');
  await assertAgentProductionBuildFresh(root);
  const snapshot = await createAgentProductionArtifactSnapshot(root, { label: 'runtime-only' });
  const runtimeBinding = join(snapshot.snapshotRoot, 'apps/desktop/.native/better_sqlite3.node');
  assert.equal(await readFile(runtimeBinding, 'utf8'), await readFile(join(root, 'apps/desktop/.native/better_sqlite3.node'), 'utf8'));
  await assert.rejects(readFile(join(snapshot.snapshotRoot, 'apps/desktop/.native/electron-rebuild/cache/compiler-input')), { code: 'ENOENT' });
  // A link at the runtime root can redirect ordinary leaf files to another checkout.
  const nativeRoot = join(root, 'apps/desktop/.native');
  const foreignNativeRoot = join(root, 'foreign-native');
  await rename(nativeRoot, foreignNativeRoot);
  await symlink(foreignNativeRoot, nativeRoot, process.platform === 'win32' ? 'junction' : 'dir');
  await writeAgentProductionBuildManifest(root);
  await assertAgentProductionBuildFresh(root);
  await assert.rejects(() => createAgentProductionArtifactSnapshot(root, { label: 'foreign-native' }),
    /source .*符号链接: apps\/desktop\/.native|source .*符号链接：apps\/desktop\/.native/,
    '拒绝 .native 根 junction，即使两个 runtime 叶文件和合法构建指纹均可读取');
  console.log('agent production build manifest fixtures passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
