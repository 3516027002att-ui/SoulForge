import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
declare const __SOULFORGE_REPO_ROOT__: string;

const workspaceServiceSource = readFileSync(
  typeof __SOULFORGE_REPO_ROOT__ !== 'undefined'
    ? join(__SOULFORGE_REPO_ROOT__,'apps/desktop/src/main/services/workspaceService.ts')
    : join(dirname(fileURLToPath(import.meta.url)), 'services', 'workspaceService.ts'),
  'utf8'
);
const scanStart = workspaceServiceSource.indexOf('const scan = async');
const scanEnd = workspaceServiceSource.indexOf('const remountBase = async', scanStart);
assert.ok(scanStart >= 0, 'workspace.scan application operation must exist');
assert.ok(scanEnd > scanStart, 'workspace.scan application boundary must exist');
const scanHandler = workspaceServiceSource.slice(scanStart, scanEnd);
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
