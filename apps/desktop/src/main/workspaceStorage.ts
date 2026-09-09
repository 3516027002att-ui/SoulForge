import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';

export interface WorkspaceStoragePaths {
  root: string;
  backupBaseDir: string;
  recoveryDir: string;
  stagingRoot: string;
  isCompanion: boolean;
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

      // If companion workspace.db doesn't exist yet, migrate from fallback if present
      const companionDb = join(companionRoot, 'workspace.db');
      const fallback = fallbackWorkspaceStoragePaths(workspaceId);
      const fallbackDb = join(fallback.root, 'workspace.db');
      if (!existsSync(companionDb) && existsSync(fallbackDb)) {
        try {
          copyFileSync(fallbackDb, companionDb);
          if (existsSync(`${fallbackDb}-wal`)) copyFileSync(`${fallbackDb}-wal`, `${companionDb}-wal`);
          if (existsSync(`${fallbackDb}-shm`)) copyFileSync(`${fallbackDb}-shm`, `${companionDb}-shm`);
          const fallbackFp = join(fallback.root, 'fingerprint-store.json');
          const companionFp = join(companionRoot, 'fingerprint-store.json');
          if (!existsSync(companionFp) && existsSync(fallbackFp)) {
            copyFileSync(fallbackFp, companionFp);
          }
        } catch {
          // Migration copy non-fatal
        }
      }

      return {
        root: companionRoot,
        backupBaseDir: join(companionRoot, 'backups'),
        recoveryDir: join(companionRoot, 'recovery'),
        stagingRoot: join(companionRoot, 'staging'),
        isCompanion: true
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
