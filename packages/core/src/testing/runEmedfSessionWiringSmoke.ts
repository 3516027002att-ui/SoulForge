import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import {
  openWorkspaceSession,
  type EmedfLocator
} from '../workspace/workspaceSession.js';
import {
  nativeEditSessionFromContext,
  openNativeEditSession
} from '../editing/nativeEditSession.js';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';

async function run(): Promise<void> {
  const previousEmedfPath = process.env.SOULFORGE_EMEDF_PATH;
  const previousGameRoot = process.env.SOULFORGE_SEKIRO_GAME_ROOT;
  const previousLocalAppData = process.env.LOCALAPPDATA;

  try {
    await withSmokeWorkspace('emedf-session-wiring', async (workspace) => {
      const overlayRoot = join(workspace.root, 'overlay');
      const gameRoot = join(workspace.root, 'Sekiro');
      const defaultPath = join(
        workspace.root,
        'tools',
        'DarkScript3',
        'Resources',
        'sekiro-common.emedf.json'
      );
      await mkdir(overlayRoot, { recursive: true });
      await mkdir(gameRoot, { recursive: true });
      await mkdir(dirname(defaultPath), { recursive: true });
      await writeFile(defaultPath, '{}', 'utf8');

      delete process.env.SOULFORGE_EMEDF_PATH;
      delete process.env.SOULFORGE_SEKIRO_GAME_ROOT;
      const defaultSession = await openWorkspaceSession({
        overlayRoot,
        baseRoot: gameRoot,
        game: 'sekiro'
      });
      assert.equal(defaultSession.emedfPath, resolve(defaultPath));

      const injectedPath = join(workspace.root, 'injected.emedf.json');
      await writeFile(injectedPath, '{}', 'utf8');
      const contexts: Array<{ overlayRoot: string; baseRoot?: string; game: string }> = [];
      const locator: EmedfLocator = (context) => {
        contexts.push({ ...context });
        return injectedPath;
      };

      const injectedSession = await openWorkspaceSession({
        overlayRoot,
        baseRoot: gameRoot,
        game: 'sekiro',
        emedfLocator: locator
      });
      assert.equal(injectedSession.emedfPath, resolve(injectedPath));
      assert.deepEqual(contexts[0], {
        overlayRoot: resolve(overlayRoot),
        baseRoot: resolve(gameRoot),
        game: 'sekiro'
      });

      const fromContext = nativeEditSessionFromContext({
        session: injectedSession,
        operationLog: new MemoryOperationLogStore(),
        backupBaseDir: join(workspace.root, 'storage', 'backups'),
        recoveryDir: join(workspace.root, 'storage', 'recovery')
      });
      assert.equal(fromContext.emedfPath, resolve(injectedPath));

      process.env.LOCALAPPDATA = join(workspace.root, 'local-app-data');
      const nativeSession = await openNativeEditSession({
        overlayRoot,
        baseRoot: gameRoot,
        game: 'sekiro',
        emedfLocator: locator
      });
      assert.equal(nativeSession.emedfPath, resolve(injectedPath));
      assert.equal(nativeSession.session.emedfPath, resolve(injectedPath));
      assert.equal(contexts.length, 2);

      const explicitPath = join(workspace.root, 'explicit.emedf.json');
      const beforeExplicit = contexts.length;
      const explicitSession = await openWorkspaceSession({
        overlayRoot,
        baseRoot: gameRoot,
        game: 'sekiro',
        emedfPath: explicitPath,
        emedfLocator: () => {
          throw new Error('explicit emedfPath must bypass the locator');
        }
      });
      assert.equal(explicitSession.emedfPath, resolve(explicitPath));
      assert.equal(contexts.length, beforeExplicit);
    });
  } finally {
    if (previousEmedfPath === undefined) delete process.env.SOULFORGE_EMEDF_PATH;
    else process.env.SOULFORGE_EMEDF_PATH = previousEmedfPath;
    if (previousGameRoot === undefined) delete process.env.SOULFORGE_SEKIRO_GAME_ROOT;
    else process.env.SOULFORGE_SEKIRO_GAME_ROOT = previousGameRoot;
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
  }
}

run().then(
  () => console.log('runEmedfSessionWiringSmoke: PASS'),
  (error) => {
    console.error(`runEmedfSessionWiringSmoke: FAIL\n${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  }
);
