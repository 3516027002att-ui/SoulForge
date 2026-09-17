import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import {
  openWorkspaceSession,
  type OpenWorkspaceSessionOptions
} from '../workspace/workspaceSession.js';
import {
  nativeEditSessionFromContext,
  openNativeEditSession,
  type OpenNativeEditSessionOptions
} from '../editing/nativeEditSession.js';
import { resolveEmevdRegistry } from '../emevd/emedfRegistryResolver.js';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';

const ENVIRONMENT_KEYS = ['SOULFORGE_EMEDF_PATH', 'SOULFORGE_SEKIRO_GAME_ROOT', 'LOCALAPPDATA'] as const;

async function assertExternalSchemaRejected(run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    const candidate = error as { code?: string; diagnostics?: Array<{ code?: string }> };
    return candidate.code === 'EMEVD_EXTERNAL_SCHEMA_FORBIDDEN'
      && candidate.diagnostics?.some((item) => item.code === 'EMEVD_EXTERNAL_SCHEMA_FORBIDDEN') === true;
  });
}

async function run(): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const key of ENVIRONMENT_KEYS) {
    previous.set(key, process.env[key]);
    process.env[key] = 'C:\\does-not-exist\\external-schema';
  }

  try {
    await withSmokeWorkspace('emedf-session-wiring', async (workspace) => {
      const overlayRoot = join(workspace.root, 'overlay');
      const gameRoot = join(workspace.root, 'Sekiro');
      await mkdir(overlayRoot, { recursive: true });
      await mkdir(gameRoot, { recursive: true });

      const defaultSession = await openWorkspaceSession({
        overlayRoot,
        baseRoot: gameRoot,
        game: 'sekiro'
      });
      assert.equal(Object.prototype.hasOwnProperty.call(defaultSession, 'emedfPath'), false);
      assert.equal(resolveEmevdRegistry().origin, 'first-party');

      const fromContext = nativeEditSessionFromContext({
        session: defaultSession,
        operationLog: new MemoryOperationLogStore(),
        backupBaseDir: join(workspace.root, 'storage', 'backups'),
        recoveryDir: join(workspace.root, 'storage', 'recovery')
      });
      assert.equal(Object.prototype.hasOwnProperty.call(fromContext, 'emedfPath'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(fromContext.session, 'emedfPath'), false);

      const nativeSession = await openNativeEditSession({
        overlayRoot,
        baseRoot: gameRoot,
        game: 'sekiro'
      });
      assert.equal(Object.prototype.hasOwnProperty.call(nativeSession, 'emedfPath'), false);

      const legacyWorkspace = {
        overlayRoot,
        baseRoot: gameRoot,
        game: 'sekiro',
        emedfPath: join(workspace.root, 'external.emedf.json')
      } as unknown as OpenWorkspaceSessionOptions;
      await assertExternalSchemaRejected(() => openWorkspaceSession(legacyWorkspace));

      const legacyNative = {
        overlayRoot,
        baseRoot: gameRoot,
        game: 'sekiro',
        emedfLocator: () => join(workspace.root, 'external.emedf.json')
      } as unknown as OpenNativeEditSessionOptions;
      await assertExternalSchemaRejected(() => openNativeEditSession(legacyNative));
    });
  } finally {
    for (const key of ENVIRONMENT_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

run().then(
  () => console.log('runEmedfSessionWiringSmoke: PASS'),
  (error) => {
    console.error(`runEmedfSessionWiringSmoke: FAIL\n${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  }
);
