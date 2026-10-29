import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 本用例靠读同目录的生产源码断言结构。`scripts/run-renderer-unit-tests.mjs`
 * 用 esbuild 把测试打进 node_modules/.cache，`import.meta.url` 就指向缓存目录，
 * 直接 join 会 ENOENT（整条 test:renderer-unit 因此长期是红的）。先按模块位置
 * 找，找不到再按仓库根定位源码树。
 */
function mainSource(relative: string): string {
  const fromModule = join(dirname(fileURLToPath(import.meta.url)), relative);
  if (existsSync(fromModule)) return fromModule;
  return resolve(process.cwd(), 'apps', 'desktop', 'src', 'main', relative);
}

const workspaceIpcSource = readFileSync(mainSource(join('ipc', 'workspace.ts')), 'utf8');
const scanStart = workspaceIpcSource.indexOf("handle('workspace.scan'");
const scanEnd = workspaceIpcSource.indexOf("\n  handle('workspace.remountBase'", scanStart);
assert.ok(scanStart >= 0, 'workspace.scan handler must exist');
assert.ok(scanEnd > scanStart, 'workspace.scan handler boundary must exist');
const scanHandler = workspaceIpcSource.slice(scanStart, scanEnd);
const lightScanOffset = scanHandler.indexOf('const lightResult = await scanWorkspace');
const databaseOpenOffset = scanHandler.indexOf('await deps.ensureActiveOperationLog');
const backgroundOffset = scanHandler.indexOf('const backgroundTask = (async () => {');
const clearOperationLogOffset = scanHandler.indexOf('deps.clearActiveOperationLog()');

assert.ok(lightScanOffset >= 0, 'workspace.scan must perform the light catalog scan');
assert.ok(databaseOpenOffset >= 0, 'workspace.scan must retain the database setup');
assert.ok(backgroundOffset >= 0, 'workspace.scan must retain background indexing');
assert.ok(clearOperationLogOffset >= 0, 'workspace.scan must clear the previous operation-log binding');
assert.ok(
  clearOperationLogOffset < lightScanOffset,
  'the previous operation-log binding must be cleared before the new workspace is exposed'
);
assert.ok(
  databaseOpenOffset > lightScanOffset && databaseOpenOffset > backgroundOffset,
  'opening the workspace database must not block the light catalog response'
);
assert.equal(
  scanHandler.slice(0, backgroundOffset).includes('await database.'),
  false,
  'database writes must remain in the background scan task'
);

console.log('[workspace-scan-fast-path] PASS: light catalog is not gated by database open');
