import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';
import {
  planWorkspaceDatabaseMigration,
  type WorkspaceDatabaseMigrationPlan
} from './workspaceDatabaseMigration.js';

export interface WorkspaceStoragePaths {
  root: string;
  backupBaseDir: string;
  recoveryDir: string;
  stagingRoot: string;
  isCompanion: boolean;
  /**
   * 伴随库缺失、但 LocalAppData 下的 fallback 库可迁移时给出迁移来源。
   *
   * 迁移本身不在主进程做：主进程不得同步打开 SQLite（会阻塞 UI，且 native
   * binding 只保证在 Electron 侧可用）。这里只做存在性判断，真正的一致性快照
   * 由数据库 utility 进程完成（`workspaceDatabaseMigration.ts`，见 #40）。
   */
  migration?: WorkspaceDatabaseMigrationPlan;
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
    } catch {
      // Fall through to the normal companion/fallback policy if the explicit
      // test root cannot be created.
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

      // 伴随库还没有、但 fallback 库存在：声明迁移来源，由数据库 utility 进程
      // 用一致性快照完成。分文件 copyFileSync 在 WAL 库上会撕开事务（#40），
      // 且中途失败会留下会被当成"迁移完成"的半成品。
      const fallback = fallbackWorkspaceStoragePaths(workspaceId);
      const migration = planWorkspaceDatabaseMigration({
        fallbackRoot: fallback.root,
        companionDatabaseExists: existsSync(join(companionRoot, 'workspace.db')),
        fallbackDatabaseExists: existsSync(join(fallback.root, 'workspace.db'))
      });

      return {
        root: companionRoot,
        backupBaseDir: join(companionRoot, 'backups'),
        recoveryDir: join(companionRoot, 'recovery'),
        stagingRoot: join(companionRoot, 'staging'),
        isCompanion: true,
        ...(migration ? { migration } : {})
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
