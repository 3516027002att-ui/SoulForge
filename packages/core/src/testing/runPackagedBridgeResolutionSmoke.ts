import assert from 'node:assert/strict';
import { access, copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { disposeBridgeDaemonPool, runBridge } from '../bridge/runBridge.js';

type ElectronProcessShape = NodeJS.Process & {
  defaultApp?: boolean;
  resourcesPath?: string;
};

const electronProcess = process as ElectronProcessShape;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const bridgeSource = resolve(
  repositoryRoot,
  'bridge/SoulForge.Bridge/bin/Release/net10.0/win-x64/publish/SoulForge.Bridge.exe'
);

if (!(await exists(bridgeSource))) {
  console.log(JSON.stringify({
    ok: null,
    status: 'skipped',
    reason: 'Bridge publish executable is unavailable; run npm run exe:build first.'
  }, null, 2));
  process.exit(0);
}

const scratch = await mkdtemp(join(tmpdir(), 'soulforge-packaged-bridge-'));
const resources = join(scratch, 'resources');
const packagedBridge = join(resources, 'bridge', 'SoulForge.Bridge.exe');
const source = join(scratch, 'probe.bin');
const outsideCwd = join(scratch, 'outside-cwd');
const originalCwd = process.cwd();
const originalResourcesPath = electronProcess.resourcesPath;
const originalDefaultApp = electronProcess.defaultApp;
const hadResourcesPath = Object.prototype.hasOwnProperty.call(process, 'resourcesPath');
const hadDefaultApp = Object.prototype.hasOwnProperty.call(process, 'defaultApp');

try {
  await mkdir(outsideCwd, { recursive: true });
  await writeFile(source, Buffer.from('not a native game resource\n', 'utf8'));
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: resources
  });
  Object.defineProperty(process, 'defaultApp', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: false
  });
  process.chdir(outsideCwd);

  const missing = await runBridge({
    command: 'inspect',
    filePath: source,
    allowedRoots: [scratch]
  });
  assert.equal(missing.parseStatus, 'failed');
  assert.ok(missing.diagnostics.some((item) => item.code === 'BRIDGE_PACKAGED_EXECUTABLE_MISSING'));

  await mkdir(dirname(packagedBridge), { recursive: true });
  await copyFile(bridgeSource, packagedBridge);
  const resolved = await runBridge({
    command: 'inspect',
    filePath: source,
    allowedRoots: [scratch],
    timeoutMs: 30_000
  });
  assert.equal(resolved.parseStatus, 'partial');
  assert.equal(resolved.sourcePath, source);
  assert.ok(resolved.sourceUri.startsWith('file:'));
  assert.ok(!resolved.diagnostics.some((item) => item.code === 'BRIDGE_PACKAGED_EXECUTABLE_MISSING'));

  console.log(JSON.stringify({
    ok: true,
    status: 'passed',
    missingBridge: 'structured-failure',
    nonRepositoryCwd: outsideCwd,
    resolvedParseStatus: resolved.parseStatus
  }, null, 2));
} finally {
  await disposeBridgeDaemonPool();
  process.chdir(originalCwd);
  restoreProcessProperty('resourcesPath', hadResourcesPath, originalResourcesPath);
  restoreProcessProperty('defaultApp', hadDefaultApp, originalDefaultApp);
  await rm(scratch, { recursive: true, force: true });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function restoreProcessProperty(
  key: 'resourcesPath' | 'defaultApp',
  existed: boolean,
  value: string | boolean | undefined
): void {
  if (existed) {
    Object.defineProperty(process, key, {
      configurable: true,
      enumerable: false,
      writable: true,
      value
    });
  } else {
    delete (process as unknown as Record<string, unknown>)[key];
  }
}
