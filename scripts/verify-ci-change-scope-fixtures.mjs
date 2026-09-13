import assert from 'node:assert/strict';
import { classifyCiChanges } from './ci-change-scope.mjs';
assert.deepEqual(classifyCiChanges(['docs/guide.md']), { build: false, installer: false, tiers: 'governance' });
assert.equal(classifyCiChanges(['docs/governance/slices.json']).build, false);
assert.equal(classifyCiChanges(['apps/desktop/src/main/index.ts']).build, true);
assert.equal(classifyCiChanges(['apps/desktop/src/main/index.ts']).installer, false);
for (const path of ['package-lock.json', 'apps/desktop/package.json', 'apps/desktop/electron.vite.config.ts',
  'bridge/SoulForge.Bridge/A.cs', 'scripts/verify-installer-lifecycle.mjs', '.github/workflows/windows-ci.yml',
  'apps/desktop/electron-builder.json', 'apps/desktop/build/icon.ico', 'prompt/rag-embedding.md', 'licenses/library.txt', 'NOTICE',
  'scripts/prepare-electron-sqlite-binding.mjs', 'global.json', 'scripts/run-dotnet.mjs']) {
  assert.equal(classifyCiChanges([path]).installer, true, path);
}
assert.equal(classifyCiChanges(['prompt/system.md']).build, true);
assert.equal(classifyCiChanges(['new-tool/config.json']).build, true);
assert.equal(classifyCiChanges(['docs/new-script.mjs']).build, true);
assert.equal(classifyCiChanges(['docs/guide.md'], { forceInstaller: true }).installer, true);
assert.equal(classifyCiChanges([]).installer, true);
console.log(JSON.stringify({ ok: true, checks: 23, message: 'CI 路径分层与未知变更保守回退通过' }));
