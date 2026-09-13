import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  AGENT_PRODUCTION_BUILD_MANIFEST,
  assertAgentProductionBuildFresh,
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
    'apps/desktop/package.json',
    'apps/desktop/tsconfig.json',
    'apps/desktop/electron.vite.config.ts',
    'apps/desktop/src/main/index.ts',
    'apps/desktop/.native/better_sqlite3.node',
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
  await expectStale('Electron 产物变化必须拒绝旧清单', () => seed('apps/desktop/out/main/index.js', 'changed output'));
  await expectStale('根 TypeScript 配置变化必须拒绝旧产物', () => seed('tsconfig.base.json', 'changed config'));
  await expectStale('原生绑定构建输入变化必须拒绝旧产物', () => seed('scripts/prepare-electron-sqlite-binding.mjs', 'changed preparation'));

  console.log('agent production build manifest fixtures passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
