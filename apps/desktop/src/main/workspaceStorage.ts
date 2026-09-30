import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';

export interface WorkspaceStoragePaths {
  root: string;
  backupBaseDir: string;
  recoveryDir: string;
  stagingRoot: string;
  isCompanion: boolean;
  /** Selected only; the database utility performs an asynchronous consistent backup. */
  migrationSourceDatabasePath?: string;
}

export function localApplicationDataRoot(): string {
  if (process.platform === 'win32') {
    return join(dirname(app.getPath('appData')), 'Local', 'SoulForge');
  }
  return join(app.getPath('userData'), 'local-data');
}

export function fallbackWorkspaceStoragePaths(workspaceId: string): WorkspaceStoragePaths {
  const safeWorkspaceKey = createHash('sha256').update(workspaceId).digest('hex').slice(0, 24);
  const root = join(localApplicationDataRoot(), 'workspaces', safeWorkspaceKey);
  return {
    root,
    backupBaseDir: join(root, 'backups'),
    recoveryDir: join(root, 'recovery'),
    stagingRoot: join(root, 'staging'),
    isCompanion: false
  };
}

export function resolveWorkspaceStoragePaths(
  workspaceId: string,
  workspaceRoot?: string
): WorkspaceStoragePaths {
  // Production E2E mounts the user's real game/mod tree read-only, but must
  // not reuse or lock the user's companion workspace.db. The harness sets
  // this explicit isolated root; normal desktop runs leave it unset and keep
  // the companion-storage policy below unchanged.
  const isolatedRoot = process.env.SF_E2E_WORKSPACE_STORAGE_ROOT?.trim();
  if (isolatedRoot) {
    const safeWorkspaceKey = createHash('sha256').update(workspaceId).digest('hex').slice(0, 24);
    const root = join(resolve(isolatedRoot), safeWorkspaceKey);
    try {
      mkdirSync(join(root, 'backups'), { recursive: true });
      mkdirSync(join(root, 'recovery'), { recursive: true });
      mkdirSync(join(root, 'staging'), { recursive: true });
      return {
        root,
        backupBaseDir: join(root, 'backups'),
        recoveryDir: join(root, 'recovery'),
        stagingRoot: join(root, 'staging'),
        isCompanion: false
      };
    } catch (cause) {
      throw Object.assign(new Error('显式工作区隔离目录无法创建，已拒绝打开常规用户数据库。', { cause }), {
        code: 'WORKSPACE_ISOLATION_UNAVAILABLE',
        details: { isolatedRoot: resolve(isolatedRoot), workspaceId }
      });
    }
  }

  let resolvedRoot: string | undefined = workspaceRoot;
  if (!resolvedRoot && workspaceId.startsWith('file://')) {
    try {
      resolvedRoot = fileURLToPath(workspaceId);
    } catch {
      resolvedRoot = undefined;
    }
  }

  if (resolvedRoot) {
    const companionRoot = join(resolvedRoot, '.soulforge');
    try {
      mkdirSync(companionRoot, { recursive: true });
      mkdirSync(join(companionRoot, 'backups'), { recursive: true });
      mkdirSync(join(companionRoot, 'recovery'), { recursive: true });
      mkdirSync(join(companionRoot, 'staging'), { recursive: true });

      const probeFile = join(companionRoot, `.probe_${process.pid}_${Date.now()}`);
      writeFileSync(probeFile, 'ok', 'utf8');
      unlinkSync(probeFile);

      const companionDb = join(companionRoot, 'workspace.db');
      const fallbackDb = join(fallbackWorkspaceStoragePaths(workspaceId).root, 'workspace.db');
      const migrationSourceDatabasePath = !existsSync(companionDb) && existsSync(fallbackDb)
        ? fallbackDb : undefined;

      return {
        root: companionRoot,
        backupBaseDir: join(companionRoot, 'backups'),
        recoveryDir: join(companionRoot, 'recovery'),
        stagingRoot: join(companionRoot, 'staging'),
        isCompanion: true,
        ...(migrationSourceDatabasePath ? { migrationSourceDatabasePath } : {})
      };
    } catch {
      // Permission denied or readonly -> fallback to LocalAppData
    }
  }

  return fallbackWorkspaceStoragePaths(workspaceId);
}

export function durableStoragePaths(
  workspaceId: string,
  workspaceRoot?: string
): WorkspaceStoragePaths {
  return resolveWorkspaceStoragePaths(workspaceId, workspaceRoot);
}
