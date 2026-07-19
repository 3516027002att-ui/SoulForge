import { randomUUID } from 'node:crypto';
import { utilityProcess, type UtilityProcess } from 'electron';
import type {
  OperationLogRecord,
  OperationStatus,
  PatchHistoryEntry,
  IndexedFile
} from '@soulforge/shared';
import type { OperationLogStore } from '@soulforge/core';
import type {
  AuditEventRecord,
  AppModelServiceRecord,
  AppPermissionGrant,
  RecordAgentRunInput,
  RetentionCleanupResult,
  AiHistoryRetentionMode,
  StoredAgentRunDetail,
  StoredAgentRunSummary,
  StoredAgentPermissionMode,
  BackgroundJobRecord,
  PersistedDiagnostic,
  RecoveryPointRecord,
  RecoveryCleanupPlan,
  ResourceEntryChangeRecord,
  TransactionJournalPhase,
  TransactionJournalRecord
} from '@soulforge/core';
import {
  OPERATION_LOG_UTILITY_PROTOCOL,
  isOperationLogUtilityResponse,
  type OpenWorkspaceDatabasePayload,
  type OperationLogUtilityMethod,
  type OperationLogUtilityPayloadMap,
  type OperationLogUtilityRequest,
  type OperationLogUtilityResultMap
} from './operationLogUtilityProtocol.js';

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class OperationLogUtilityClient implements OperationLogStore {
  private process: UtilityProcess | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private activeWorkspace: OpenWorkspaceDatabasePayload | null = null;
  private activeAppDatabasePath: string | null = null;
  private opening: Promise<void> | null = null;

  constructor(
    private readonly modulePath: string,
    private readonly requestTimeoutMs = 15_000,
    private readonly nativeBindingPath?: string
  ) {}

  async openApp(appDatabasePath: string): Promise<void> {
    if (this.opening) await this.opening;
    if (this.process && this.activeAppDatabasePath === appDatabasePath) return;
    if (!this.process) this.spawn();
    await this.request('openApp', { appDatabasePath });
    this.activeAppDatabasePath = appDatabasePath;
  }

  async openWorkspace(payload: OpenWorkspaceDatabasePayload): Promise<void> {
    if (this.opening) await this.opening;
    if (this.process && sameWorkspace(this.activeWorkspace, payload)) return;
    this.opening = this.openWorkspaceInternal(payload);
    try {
      await this.opening;
    } finally {
      this.opening = null;
    }
  }

  async record(entry: OperationLogRecord): Promise<void> {
    await this.request('record', { entry });
  }

  get(opId: string): Promise<OperationLogRecord | undefined> {
    return this.request('get', { opId });
  }

  list(workspaceId?: string): Promise<OperationLogRecord[]> {
    return this.request('list', { ...(workspaceId ? { workspaceId } : {}) });
  }

  updateStatus(
    opId: string,
    status: OperationStatus,
    patch?: Partial<OperationLogRecord>
  ): Promise<OperationLogRecord | undefined> {
    return this.request('updateStatus', { opId, status, ...(patch ? { patch } : {}) });
  }

  history(workspaceId?: string): Promise<PatchHistoryEntry[]> {
    return this.request('history', { ...(workspaceId ? { workspaceId } : {}) });
  }

  createTransaction(record: Omit<TransactionJournalRecord, 'workspaceId'>): Promise<null> {
    return this.request('createTransaction', { record });
  }

  transitionTransaction(options: {
    transactionId: string;
    expectedPhase: TransactionJournalPhase | TransactionJournalPhase[];
    nextPhase: TransactionJournalPhase;
    state: unknown;
    updatedAt?: string;
  }): Promise<TransactionJournalRecord> {
    return this.request('transitionTransaction', options);
  }

  listIncompleteTransactions(): Promise<TransactionJournalRecord[]> {
    return this.request('listIncompleteTransactions', {});
  }

  recordRecoveryPoint(
    record: Omit<RecoveryPointRecord, 'workspaceId' | 'recoveryId'> & { recoveryId?: string }
  ): Promise<RecoveryPointRecord> {
    return this.request('recordRecoveryPoint', { record });
  }

  listRecoveryPoints(): Promise<RecoveryPointRecord[]> {
    return this.request('listRecoveryPoints', {});
  }

  planRecoveryCleanup(options: { now?: string; maxAgeDays?: number; maxBytes?: number } = {}): Promise<RecoveryCleanupPlan> {
    return this.request('planRecoveryCleanup', options);
  }

  markRecoveryPointExpired(recoveryId: string): Promise<void> {
    return this.request('markRecoveryPointExpired', { recoveryId }).then(() => undefined);
  }

  appendAuditEvent(
    event: Omit<AuditEventRecord, 'workspaceId' | 'eventId'> & { eventId?: string }
  ): Promise<AuditEventRecord> {
    return this.request('appendAuditEvent', { event });
  }

  listAuditEvents(): Promise<AuditEventRecord[]> {
    return this.request('listAuditEvents', {});
  }

  recordResourceEntryChange(record: Omit<ResourceEntryChangeRecord, 'workspaceId'>): Promise<null> {
    return this.request('recordResourceEntryChange', { record });
  }

  listResourceEntryChanges(opId: string): Promise<ResourceEntryChangeRecord[]> {
    return this.request('listResourceEntryChanges', { opId });
  }

  finalizeCommit(
    bundle: Parameters<NonNullable<OperationLogStore['finalizeCommit']>>[0]
  ): Promise<void> {
    return this.request('finalizeCommit', { bundle }).then(() => undefined);
  }

  replaceFiles(files: IndexedFile[]): Promise<void> {
    return this.request('replaceFiles', { files }).then(() => undefined);
  }

  searchFiles(query: string, limit?: number): Promise<IndexedFile[]> {
    return this.request('searchFiles', { query, ...(limit === undefined ? {} : { limit }) });
  }

  replaceDiagnostics(diagnostics: Array<Omit<PersistedDiagnostic, 'workspaceId'>>): Promise<void> {
    return this.request('replaceDiagnostics', { diagnostics }).then(() => undefined);
  }

  listDiagnostics(): Promise<PersistedDiagnostic[]> {
    return this.request('listDiagnostics', {});
  }

  upsertJob(job: Omit<BackgroundJobRecord, 'workspaceId'>): Promise<void> {
    return this.request('upsertJob', { job }).then(() => undefined);
  }

  listJobs(): Promise<BackgroundJobRecord[]> {
    return this.request('listJobs', {});
  }

  listModelServices(): Promise<AppModelServiceRecord[]> {
    return this.request('listModelServices', {});
  }

  getModelService(serviceId: string, includeDeleted = false): Promise<AppModelServiceRecord | undefined> {
    return this.request('getModelService', { serviceId, includeDeleted });
  }

  upsertModelService(record: AppModelServiceRecord): Promise<AppModelServiceRecord> {
    return this.request('upsertModelService', { record });
  }

  importModelServices(records: AppModelServiceRecord[]): Promise<{ imported: number }> {
    return this.request('importModelServices', { records });
  }

  softDeleteModelService(serviceId: string, deletedAt?: string): Promise<void> {
    return this.request('softDeleteModelService', {
      serviceId,
      ...(deletedAt ? { deletedAt } : {})
    }).then(() => undefined);
  }

  replacePermissionGrant(grant: AppPermissionGrant): Promise<AppPermissionGrant> {
    return this.request('replacePermissionGrant', { grant });
  }

  getActivePermissionGrant(
    serviceId: string,
    permissionMode: AppPermissionGrant['permissionMode'] | StoredAgentPermissionMode,
    policyVersion: string
  ): Promise<AppPermissionGrant | undefined> {
    return this.request('getActivePermissionGrant', { serviceId, permissionMode, policyVersion });
  }

  revokePermissionGrant(grantId: string, revokedAt?: string): Promise<void> {
    return this.request('revokePermissionGrant', {
      grantId,
      ...(revokedAt ? { revokedAt } : {})
    }).then(() => undefined);
  }

  recordAgentRun(input: RecordAgentRunInput): Promise<{ runId: string; conversationId: string }> {
    return this.request('recordAgentRun', { input });
  }

  getAgentRun(runId: string): Promise<StoredAgentRunDetail | null> {
    return this.request('getAgentRun', { runId });
  }

  listAgentRuns(options: {
    workspaceKey?: string;
    serviceId?: string;
    limit?: number;
  } = {}): Promise<StoredAgentRunSummary[]> {
    return this.request('listAgentRuns', options);
  }

  getAiHistoryRetentionMode(): Promise<{ mode: AiHistoryRetentionMode }> {
    return this.request('getAiHistoryRetentionMode', {});
  }

  setAiHistoryRetentionMode(mode: AiHistoryRetentionMode): Promise<{ mode: AiHistoryRetentionMode; updatedAt: string }> {
    return this.request('setAiHistoryRetentionMode', { mode });
  }

  cleanupExpiredAiHistory(now?: string): Promise<RetentionCleanupResult> {
    return this.request('cleanupExpiredAiHistory', { ...(now ? { now } : {}) });
  }

  async health(): Promise<{ ready: boolean; appReady: boolean; workspaceId?: string }> {
    return this.request('health', {});
  }

  /** Force a fresh utility process and reopen the same workspace; pending RPCs are never replayed. */
  async restart(): Promise<void> {
    const payload = this.activeWorkspace;
    const child = this.process;
    if (!payload || !child) throw new Error('数据库后台进程没有可恢复的活动工作区。');
    this.process = null;
    this.activeWorkspace = null;
    this.activeAppDatabasePath = null;
    this.rejectAll(new Error('数据库后台进程正在重启；未完成请求不会自动重放。'));
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill();
    await exited;
    await this.openWorkspace(payload);
  }

  async dispose(): Promise<void> {
    const child = this.process;
    this.activeWorkspace = null;
    this.activeAppDatabasePath = null;
    if (!child) return;
    try {
      await this.requestOn(child, 'close', {});
    } catch {
      // Process exit below remains the final cleanup path.
    }
    if (this.process === child) this.process = null;
    child.kill();
    this.rejectAll(new Error('数据库后台进程已关闭。'));
  }

  private async openWorkspaceInternal(payload: OpenWorkspaceDatabasePayload): Promise<void> {
    if (!this.process) this.spawn();
    try {
      await this.request('openWorkspace', payload);
      this.activeWorkspace = { ...payload };
      this.activeAppDatabasePath = payload.appDatabasePath;
    } catch (error) {
      this.process?.kill();
      this.process = null;
      this.activeWorkspace = null;
      throw error;
    }
  }

  private spawn(): void {
    const child = utilityProcess.fork(this.modulePath, [], {
      serviceName: 'SoulForge 工作区数据库',
      stdio: 'pipe',
      ...(this.nativeBindingPath
        ? {
            env: {
              ...process.env,
              SOULFORGE_SQLITE_NATIVE_BINDING: this.nativeBindingPath
            }
          }
        : {})
    });
    child.on('message', (message) => this.onMessage(message));
    child.on('exit', (code) => {
      if (this.process !== child) return;
      this.process = null;
      this.activeWorkspace = null;
      this.activeAppDatabasePath = null;
      this.rejectAll(new Error(`数据库后台进程意外退出（代码 ${code}）。`));
    });
    child.on('error', (_type, location) => {
      if (this.process !== child) return;
      this.rejectAll(new Error(`数据库后台进程发生致命错误：${location}`));
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      process.stderr.write(`[SoulForge database utility] ${String(chunk)}`);
    });
    this.process = child;
  }

  private request<Method extends OperationLogUtilityMethod>(
    method: Method,
    payload: OperationLogUtilityPayloadMap[Method]
  ): Promise<OperationLogUtilityResultMap[Method]> {
    const child = this.process;
    if (!child) return Promise.reject(new Error('数据库后台进程不可用。'));
    return this.requestOn(child, method, payload);
  }

  private requestOn<Method extends OperationLogUtilityMethod>(
    child: UtilityProcess,
    method: Method,
    payload: OperationLogUtilityPayloadMap[Method]
  ): Promise<OperationLogUtilityResultMap[Method]> {
    const requestId = randomUUID();
    const request = {
      protocolVersion: OPERATION_LOG_UTILITY_PROTOCOL,
      requestId,
      method,
      payload
    } as OperationLogUtilityRequest;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`数据库后台请求超时：${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer
      });
      try {
        child.postMessage(request);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private onMessage(message: unknown): void {
    if (!isOperationLogUtilityResponse(message)) return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    const error = Object.assign(
      new Error(message.error?.message ?? '数据库后台请求失败。'),
      { code: message.error?.code ?? 'DATABASE_UTILITY_FAILED' }
    );
    pending.reject(error);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function sameWorkspace(
  left: OpenWorkspaceDatabasePayload | null,
  right: OpenWorkspaceDatabasePayload
): boolean {
  return left?.databasePath === right.databasePath
    && left.appDatabasePath === right.appDatabasePath
    && left.workspaceId === right.workspaceId
    && left.rootPath === right.rootPath;
}
