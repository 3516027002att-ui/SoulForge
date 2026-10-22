import { join } from 'node:path';
import { resolveOperationLogStorePath, type KnowledgeStore, type WorkspaceSession } from '@soulforge/core';
import { createReadOnlyKnowledgeStore } from '../knowledgeStoreSnapshot.js';
import { executeRecoveryCleanup } from '../recoveryCleanup.js';
import { WorkspaceDatabaseOpenGate } from '../workspaceDatabaseOpenGate.js';
import type { OperationLogUtilityClient } from '../operationLogUtilityClient.js';
import type { WorkspaceStoragePaths } from '../workspaceStorage.js';

export interface WorkspaceUtilityLifecycleDeps {
  operationLogUtility: OperationLogUtilityClient;
  getActiveSession(): WorkspaceSession | null;
  workspaceStoragePaths(workspaceId: string, workspaceRoot?: string): WorkspaceStoragePaths;
  getUserDataPath(): string;
  reportRecoveryCleanupRejections(items: Awaited<ReturnType<typeof executeRecoveryCleanup>>['rejected']): void;
  reportKnowledgeSnapshotUnavailable(message: string): void;
}

/** Application-owned database/knowledge lifetime. Host construction and userData
 * selection remain explicit ports; utility/journal and cleanup authority retain
 * their established implementations and exact scopes. */
export function createWorkspaceUtilityLifecycleService(input: WorkspaceUtilityLifecycleDeps) {
  const deps = Object.freeze({ ...input });
  let activeOperationLog: OperationLogUtilityClient | null = null;

  let activeOperationLogWorkspaceId: string | null = null;

  let activeKnowledgeStore: KnowledgeStore | null = null;

  let activeKnowledgeWorkspaceId: string | null = null;

  let activeKnowledgeStoreError: string | null = null;

  let activeKnowledgeLoad: Promise<void> | null = null;

  let activeKnowledgeLoadWorkspaceId: string | null = null;

  let activeKnowledgeLoadToken: symbol | null = null;

  let activeKnowledgeFailureWorkspaceId: string | null = null;

  let activeKnowledgeRetryAt = 0;

  const KNOWLEDGE_RETRY_COOLDOWN_MS = 1_000;

  const operationLogOpenGate = new WorkspaceDatabaseOpenGate();

  function legacyOperationLogPathForWorkspace(workspaceId: string): string {
    // workspaceId is a file:// URL from makeWorkspaceId; never join it raw into a Windows path.
    return resolveOperationLogStorePath(join(deps.getUserDataPath(), 'operation-logs'), workspaceId);
  }

  async function ensureActiveOperationLog(session: WorkspaceSession): Promise<OperationLogUtilityClient> {
    const workspaceId = session.meta.workspaceId;
    const assertCurrentSession = (): void => {
      if (deps.getActiveSession() !== session) {
        throw Object.assign(new Error('工作区会话已切换，拒绝重新打开旧数据库。'), {
          code: 'DATABASE_UTILITY_SESSION_STALE'
        });
      }
    };
    assertCurrentSession();
    if (activeOperationLog === deps.operationLogUtility && activeOperationLogWorkspaceId === workspaceId) {
      await ensureActiveKnowledgeStore(session);
      return deps.operationLogUtility;
    }

    return operationLogOpenGate.run(workspaceId, async () => {
      assertCurrentSession();
      // A concurrent caller may have completed the open while this request was
      // queued. Never reopen the process-global SQLite utility for the same key.
      if (activeOperationLog === deps.operationLogUtility && activeOperationLogWorkspaceId === workspaceId) {
        await ensureActiveKnowledgeStore(session);
        return deps.operationLogUtility;
      }

      const storage = deps.workspaceStoragePaths(workspaceId, session.layers.overlayRoot);
      await deps.operationLogUtility.openWorkspace({
        appDatabasePath: join(deps.getUserDataPath(), 'app.db'),
        databasePath: join(storage.root, 'workspace.db'),
        ...(storage.migrationSourceDatabasePath ? { migrationSourceDatabasePath: storage.migrationSourceDatabasePath } : {}),
        workspaceId,
        rootPath: session.layers.overlayRoot,
        game: session.meta.game,
        legacyOperationLogPath: legacyOperationLogPathForWorkspace(workspaceId),
        legacyBackupDirectory: join(storage.root, 'legacy-operation-logs'),
        legacySemanticSnapshotPath: join(session.layers.overlayRoot, 'semantic-snapshot.json'),
        legacySemanticBackupDirectory: join(storage.root, 'legacy-semantic-snapshots')
      });
      assertCurrentSession();

      const cleanupPlan = await deps.operationLogUtility.planRecoveryCleanup();
      const cleanup = await executeRecoveryCleanup({
        plan: cleanupPlan,
        allowedRoots: [storage.backupBaseDir, storage.recoveryDir],
        store: deps.operationLogUtility
      });
      if (cleanup.rejected.length > 0) {
        deps.reportRecoveryCleanupRejections(cleanup.rejected);
      }
      assertCurrentSession();
      activeOperationLog = deps.operationLogUtility;
      activeOperationLogWorkspaceId = workspaceId;
      await ensureActiveKnowledgeStore(session);
      return deps.operationLogUtility;
    }, session);
  }

  async function ensureActiveKnowledgeStore(session: WorkspaceSession): Promise<void> {
    const workspaceId = session.meta.workspaceId;
    if (activeKnowledgeWorkspaceId === workspaceId && activeKnowledgeStore !== null) return;
    if (activeKnowledgeLoad && activeKnowledgeLoadWorkspaceId === workspaceId) {
      await activeKnowledgeLoad;
      return;
    }
    if (activeKnowledgeFailureWorkspaceId === workspaceId && Date.now() < activeKnowledgeRetryAt) return;
    await disposeActiveKnowledgeStore();
    const token = Symbol('knowledge-load');
    activeKnowledgeLoadToken = token;
    activeKnowledgeLoadWorkspaceId = workspaceId;
    const load = (async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (activeKnowledgeLoadToken !== token) return;
        if (attempt > 0) await new Promise<void>((resolve) => setTimeout(resolve, 50));
        try {
          const snapshot = await deps.operationLogUtility.loadKnowledgeSnapshot({
            workspaceId,
            rootPath: session.layers.overlayRoot,
            game: session.meta.game
          });
          if (activeKnowledgeLoadToken !== token) return;
          activeKnowledgeStore = createReadOnlyKnowledgeStore(snapshot);
          activeKnowledgeWorkspaceId = workspaceId;
          activeKnowledgeStoreError = null;
          activeKnowledgeFailureWorkspaceId = null;
          activeKnowledgeRetryAt = 0;
          return;
        } catch (error) {
          lastError = error;
        }
      }
      try {
        if (activeKnowledgeLoadToken !== token) return;
        activeKnowledgeWorkspaceId = workspaceId;
        activeKnowledgeStore = null;
        activeKnowledgeStoreError = lastError instanceof Error ? lastError.message : String(lastError);
        activeKnowledgeFailureWorkspaceId = workspaceId;
        activeKnowledgeRetryAt = Date.now() + KNOWLEDGE_RETRY_COOLDOWN_MS;
        deps.reportKnowledgeSnapshotUnavailable(activeKnowledgeStoreError);
      } catch {
        // A stale load token must never turn cleanup into a new failure.
      }
    })();
    activeKnowledgeLoad = load;
    try {
      await load;
    } finally {
      if (activeKnowledgeLoadToken === token) {
        activeKnowledgeLoad = null;
        activeKnowledgeLoadWorkspaceId = null;
      }
    }
  }

  async function disposeActiveKnowledgeStore(): Promise<void> {
    const pending = activeKnowledgeLoad;
    activeKnowledgeLoadToken = null;
    activeKnowledgeLoad = null;
    activeKnowledgeLoadWorkspaceId = null;
    activeKnowledgeStore = null;
    activeKnowledgeWorkspaceId = null;
    activeKnowledgeStoreError = null;
    activeKnowledgeFailureWorkspaceId = null;
    activeKnowledgeRetryAt = 0;
    await pending?.catch(() => undefined);
  }

  return Object.freeze({
    ensureActiveOperationLog,
    disposeActiveKnowledgeStore,
    dispose: async (): Promise<void> => {
      activeOperationLog = null;
      activeOperationLogWorkspaceId = null;
      await disposeActiveKnowledgeStore();
      await deps.operationLogUtility.dispose();
    },
    get activeOperationLog() { return activeOperationLog; },
    get activeKnowledgeStore() { return activeKnowledgeStore; },
    get activeKnowledgeWorkspaceId() { return activeKnowledgeWorkspaceId; },
    get activeKnowledgeStoreError() { return activeKnowledgeStoreError; }
  });
}

export type WorkspaceUtilityLifecycleService = ReturnType<typeof createWorkspaceUtilityLifecycleService>;
