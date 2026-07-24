import type { Diagnostic } from '@soulforge/shared';
import type {
  GameRuntimeAdapter,
  LaunchSession,
  RuntimeCapability,
  RuntimeDiagnostics
} from './gameRuntimeAdapter.js';
import {
  isTerminalRuntimeState,
  runtimeRecordFromSnapshot,
  type RuntimeLaunchRecord,
  type RuntimeLaunchSessionStore,
  type RuntimeVerificationKind
} from './runtimeSessionStore.js';
import type { WorkspaceSession } from '../workspace/workspaceSession.js';

export interface RuntimeSessionManagerOptions {
  adapter: GameRuntimeAdapter;
  workspace: WorkspaceSession;
  store: RuntimeLaunchSessionStore;
  now?: () => Date;
  onBackgroundError?: (error: Error) => void;
}

export interface RuntimeLaunchRequest {
  operationId?: string;
  relatedOperationId?: string;
  verificationKind?: RuntimeVerificationKind;
  profileName?: string;
  signal?: AbortSignal;
}

export interface RuntimeLaunchResult {
  capability: RuntimeCapability;
  record: RuntimeLaunchRecord;
}

interface ActiveRuntimeSession {
  session: LaunchSession;
  verificationKind: RuntimeVerificationKind;
  relatedOperationId?: string;
}

export class RuntimeSessionManagerError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

export class RuntimeSessionManager {
  private readonly adapter: GameRuntimeAdapter;
  private readonly workspace: WorkspaceSession;
  private readonly store: RuntimeLaunchSessionStore;
  private readonly now: () => Date;
  private readonly onBackgroundError: (error: Error) => void;
  private readonly active = new Map<string, ActiveRuntimeSession>();
  private recovered = false;
  private disposed = false;

  constructor(options: RuntimeSessionManagerOptions) {
    this.adapter = options.adapter;
    this.workspace = options.workspace;
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.onBackgroundError = options.onBackgroundError ?? (() => undefined);
  }

  get workspaceId(): string {
    return this.workspace.meta.workspaceId;
  }

  detect(): Promise<RuntimeCapability> {
    this.assertUsable();
    return this.adapter.detect();
  }

  hasActiveSessions(): boolean {
    return this.active.size > 0;
  }

  activeSessionIds(): string[] {
    return [...this.active.keys()];
  }

  async recoverInterruptedSessions(): Promise<number> {
    this.assertUsable();
    if (this.recovered) return 0;
    this.recovered = true;
    const records = await this.store.listRuntimeSessions(this.workspaceId);
    let recovered = 0;
    for (const record of records) {
      if (isTerminalRuntimeState(record.state)) continue;
      const updatedAt = this.now().toISOString();
      await this.store.upsertRuntimeSession({
        ...record,
        state: 'orphaned',
        exitedAt: record.exitedAt ?? updatedAt,
        diagnostics: [
          ...record.diagnostics,
          {
            severity: 'warning',
            code: 'RUNTIME_SESSION_ORPHANED_AFTER_RESTART',
            message: '上次运行会话未记录终态；当前进程无法重新取得其控制权，已标记为 orphaned。'
          }
        ],
        updatedAt
      });
      recovered += 1;
    }
    return recovered;
  }

  async launch(request: RuntimeLaunchRequest = {}): Promise<RuntimeLaunchResult> {
    this.assertUsable();
    await this.recoverInterruptedSessions();
    const capability = await this.adapter.detect();
    if (capability.status !== 'available') {
      throw new RuntimeSessionManagerError(
        'RUNTIME_CAPABILITY_UNAVAILABLE',
        capability.diagnostics.map((item) => item.message).join('; ') || 'Runtime adapter is unavailable.',
        capability.diagnostics
      );
    }

    const verificationKind = request.verificationKind ?? 'manual';
    assertVerificationRequest(verificationKind, request.operationId, request.relatedOperationId);
    const profile = await this.adapter.prepareProfile(this.workspace, {
      ...(request.operationId === undefined ? {} : { operationId: request.operationId }),
      ...(request.profileName === undefined ? {} : { profileName: request.profileName })
    });
    const session = await this.adapter.launch(profile, {
      ...(request.signal === undefined ? {} : { signal: request.signal })
    });
    const active: ActiveRuntimeSession = {
      session,
      verificationKind,
      ...(request.relatedOperationId === undefined
        ? {}
        : { relatedOperationId: request.relatedOperationId })
    };
    this.active.set(session.sessionId, active);
    const record = await this.persistSession(active);
    void this.observe(active).catch((error) => this.onBackgroundError(asError(error)));
    return { capability, record };
  }

  async terminate(sessionId: string): Promise<RuntimeLaunchRecord> {
    this.assertUsable();
    const active = this.active.get(sessionId);
    if (!active) {
      const record = await this.store.getRuntimeSession(sessionId);
      if (record && isTerminalRuntimeState(record.state)) return record;
      throw new RuntimeSessionManagerError(
        'RUNTIME_SESSION_NOT_ACTIVE',
        `Runtime session is not active: ${sessionId}.`
      );
    }
    await this.adapter.terminate(active.session);
    await active.session.waitForExit();
    const record = await this.persistSession(active);
    this.active.delete(sessionId);
    return record;
  }

  async waitForExit(sessionId: string): Promise<RuntimeLaunchRecord> {
    this.assertUsable();
    const active = this.active.get(sessionId);
    if (!active) {
      const record = await this.store.getRuntimeSession(sessionId);
      if (!record) {
        throw new RuntimeSessionManagerError('RUNTIME_SESSION_NOT_FOUND', `Runtime session not found: ${sessionId}.`);
      }
      return record;
    }
    await active.session.waitForExit();
    const record = await this.persistSession(active);
    this.active.delete(sessionId);
    return record;
  }

  async get(sessionId: string): Promise<RuntimeLaunchRecord | undefined> {
    const active = this.active.get(sessionId);
    if (active) return this.persistSession(active);
    return this.store.getRuntimeSession(sessionId);
  }

  list(): Promise<RuntimeLaunchRecord[]> {
    return Promise.resolve(this.store.listRuntimeSessions(this.workspaceId));
  }

  async dispose(options: { terminateActive?: boolean } = {}): Promise<void> {
    if (this.disposed) return;
    if (options.terminateActive) {
      const results = await Promise.allSettled(
        [...this.active.keys()].map((sessionId) => this.terminate(sessionId))
      );
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (rejected) throw asError(rejected.reason);
    } else {
      for (const active of this.active.values()) {
        const record = await this.persistSession(active);
        const updatedAt = this.now().toISOString();
        await this.store.upsertRuntimeSession({
          ...record,
          state: 'orphaned',
          exitedAt: record.exitedAt ?? updatedAt,
          diagnostics: [
            ...record.diagnostics,
            {
              severity: 'warning',
              code: 'RUNTIME_SESSION_DETACHED_ON_MANAGER_DISPOSE',
              message: '编辑器已释放运行会话控制权；没有据此推断游戏或 Mod 的最终状态。'
            }
          ],
          updatedAt
        });
      }
      this.active.clear();
    }
    this.disposed = true;
  }

  private async observe(active: ActiveRuntimeSession): Promise<void> {
    await active.session.waitForExit();
    if (this.disposed) return;
    await this.persistSession(active);
    this.active.delete(active.session.sessionId);
  }

  private async persistSession(active: ActiveRuntimeSession): Promise<RuntimeLaunchRecord> {
    const diagnostics = await collectDiagnosticsSafely(this.adapter, active.session);
    const record = {
      ...runtimeRecordFromSnapshot({
        workspaceId: this.workspaceId,
        adapterId: active.session.adapterId,
        profileId: active.session.profile.profileId,
        profilePath: active.session.profile.profilePath,
        ...(active.session.operationId === undefined
          ? {}
          : { operationId: active.session.operationId }),
        ...(active.relatedOperationId === undefined
          ? {}
          : { relatedOperationId: active.relatedOperationId }),
        verificationKind: active.verificationKind,
        snapshot: active.session.snapshot(),
        diagnostics,
        updatedAt: this.now().toISOString()
      }),
      sessionId: active.session.sessionId
    } satisfies RuntimeLaunchRecord;
    await this.store.upsertRuntimeSession(record);
    return record;
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new RuntimeSessionManagerError('RUNTIME_MANAGER_DISPOSED', 'Runtime session manager is disposed.');
    }
  }
}

async function collectDiagnosticsSafely(
  adapter: GameRuntimeAdapter,
  session: LaunchSession
): Promise<Diagnostic[]> {
  try {
    const result: RuntimeDiagnostics = await adapter.collectDiagnostics(session);
    return result.diagnostics;
  } catch (error) {
    return [{
      severity: 'error',
      code: 'RUNTIME_DIAGNOSTICS_COLLECTION_FAILED',
      message: asError(error).message
    }];
  }
}

function assertVerificationRequest(
  kind: RuntimeVerificationKind,
  operationId: string | undefined,
  relatedOperationId: string | undefined
): void {
  if (kind === 'post_commit' && !operationId) {
    throw new RuntimeSessionManagerError(
      'RUNTIME_POST_COMMIT_OPERATION_REQUIRED',
      'post_commit runtime verification requires operationId.'
    );
  }
  if (kind === 'post_rollback' && (!operationId || !relatedOperationId)) {
    throw new RuntimeSessionManagerError(
      'RUNTIME_POST_ROLLBACK_OPERATIONS_REQUIRED',
      'post_rollback runtime verification requires the inverse operationId and related original operationId.'
    );
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
