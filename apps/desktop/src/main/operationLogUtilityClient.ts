import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { utilityProcess, type UtilityProcess } from 'electron';
import type {
  OperationLogRecord,
  OperationStatus,
  PatchHistoryEntry,
  IndexedFile,
  RagChunk,
  ReferenceEdge,
  ResourceKind,
  SymbolBundle
} from '@soulforge/shared';
import type { OperationLogStore } from '@soulforge/core';
import type {
  AuditEventRecord,
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
  type OperationLogUtilityResultMap,
  type ProviderUsageEventPayload,
  type ProviderUsageSummary
} from './operationLogUtilityProtocol.js';

interface PendingRequest {
  requestId: string;
  method: OperationLogUtilityMethod;
  enqueuedAt: number;
  dispatchedAt: number;
  depth: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface LateRequest {
  requestId: string;
  method: OperationLogUtilityMethod;
  enqueuedAt: number;
  dispatchedAt: number;
  depth: number;
  expiresAt: number;
}

type UtilityTraceEvent = 'enqueue' | 'dispatch' | 'finish' | 'timeout' | 'late-completion' | 'workerfail' | 'close';

interface UtilityTrace {
  side: 'client';
  event: UtilityTraceEvent;
  requestId: string;
  method: string;
  enqueue: number;
  start: number | null;
  finish: number | null;
  depth: number;
  queueWaitMs: number | null;
  dbDurationMs: number | null;
  timeout: boolean;
  timeoutMs?: number;
  outcome?: 'ok' | 'timeout' | 'request-failed' | 'workerfail' | 'close' | 'post-error' | 'late-completion';
  errorCode?: string;
}

export class OperationLogUtilityClient implements OperationLogStore {
  private process: UtilityProcess | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly lateRequests = new Map<string, LateRequest>();
  private activeWorkspace: OpenWorkspaceDatabasePayload | null = null;
  private activeAppDatabasePath: string | null = null;
  private opening: Promise<void> | null = null;

  constructor(
    private readonly modulePath: string,
    private readonly requestTimeoutMs = 60_000,
    private readonly nativeBindingPath?: string
  ) {}

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

  async openAppDatabase(appDatabasePath: string): Promise<void> {
    if (this.opening) await this.opening;
    if (this.process && this.activeAppDatabasePath === appDatabasePath) return;
    this.opening = this.openAppDatabaseInternal(appDatabasePath);
    try {
      await this.opening;
    } finally {
      this.opening = null;
    }
  }

  recordProviderUsage(event: ProviderUsageEventPayload): Promise<void> {
    return this.request('recordProviderUsage', { event }).then(() => undefined);
  }

  providerUsageSummary(): Promise<ProviderUsageSummary> {
    return this.request('providerUsageSummary', {});
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

  replaceRagChunks(chunks: RagChunk[]): Promise<void> {
    return this.request('replaceRagChunks', { chunks }).then(() => undefined);
  }

  mergeRagChunks(chunks: RagChunk[]): Promise<void> {
    return this.request('mergeRagChunks', { chunks }).then(() => undefined);
  }

  mergeRagChunkDelta(input: {
    sourceUri: string;
    upserts: RagChunk[];
    deletedChunkIds: string[];
  }): Promise<OperationLogUtilityResultMap['mergeRagChunkDelta']> {
    return this.request('mergeRagChunkDelta', input);
  }

  loadRagChunks(): Promise<RagChunk[]> {
    return this.request('loadRagChunks', {});
  }

  async replaceRagEmbeddings(entries: Array<{ chunkId: string; model: string; vector: Float32Array }>): Promise<void> {
    await this.request('replaceRagEmbeddings', { entries }).then(() => undefined);
  }

  async mergeRagEmbeddings(input: {
    model: string;
    entries: Array<{ chunkId: string; contentHash: string; vector: Float32Array }>;
    deletedChunkIds: string[];
  }): Promise<void> {
    await this.request('mergeRagEmbeddings', input).then(() => undefined);
  }

  async loadRagEmbeddings(): Promise<Map<string, Float32Array>> {
    const plain = await this.request('loadRagEmbeddings', {});
    const map = new Map<string, Float32Array>();
    for (const [chunkId, values] of Object.entries(plain)) {
      map.set(chunkId, Float32Array.from(values));
    }
    return map;
  }

  async loadRagEmbeddingRecords(): Promise<Array<{ chunkId: string; model: string; contentHash: string | null; vector: Float32Array }>> {
    const records = await this.request('loadRagEmbeddingRecords', {});
    return records.map((record) => ({
      chunkId: record.chunkId,
      model: record.model,
      contentHash: record.contentHash,
      vector: Float32Array.from(record.vector)
    }));
  }

  ragEmbeddingModel(): Promise<string | null> {
    return this.request('ragEmbeddingModel', {});
  }

  searchRagChunks(query: string, limit?: number): Promise<RagChunk[]> {
    return this.request('searchRagChunks', { query, ...(limit === undefined ? {} : { limit }) });
  }

  replaceReferences(references: ReferenceEdge[]): Promise<void> {
    return this.request('replaceReferences', { references }).then(() => undefined);
  }

  loadReferences(): Promise<ReferenceEdge[]> {
    return this.request('loadReferences', {});
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

  async getSemanticFileCache(relativePath: string): Promise<{ fileSha256: string; payload: SymbolBundle } | null> {
    const result = await this.request('getSemanticFileCache', { relativePath });
    if (!result) return null;
    try {
      return {
        fileSha256: result.fileSha256,
        payload: JSON.parse(result.payloadJson) as SymbolBundle
      };
    } catch {
      return null;
    }
  }

  async getAllSemanticFileCache(): Promise<Map<string, { fileSha256: string; payload: SymbolBundle }>> {
    const result = await this.request('getAllSemanticFileCache', {});
    const map = new Map<string, { fileSha256: string; payload: SymbolBundle }>();
    for (const item of result.entries) {
      try {
        map.set(item.relativePath, {
          fileSha256: item.fileSha256,
          payload: JSON.parse(item.payloadJson) as SymbolBundle
        });
      } catch {}
    }
    return map;
  }

  async upsertSemanticFileCache(entry: {
    relativePath: string;
    fileSha256: string;
    resourceKind: ResourceKind;
    payload: SymbolBundle;
    mtimeMs: number;
  }): Promise<void> {
    await this.request('upsertSemanticFileCache', {
      entry: {
        relativePath: entry.relativePath,
        fileSha256: entry.fileSha256,
        resourceKind: entry.resourceKind,
        payloadJson: JSON.stringify(entry.payload),
        mtimeMs: entry.mtimeMs
      }
    });
  }

  async health(): Promise<{ ready: boolean; appReady: boolean; workspaceId?: string }> {
    return this.request('health', {});
  }

  /** Force a fresh utility process and reopen the same workspace; pending RPCs are never replayed. */
  async restart(): Promise<void> {
    const payload = this.activeWorkspace;
    const appDatabasePath = this.activeAppDatabasePath;
    const child = this.process;
    if ((!payload && !appDatabasePath) || !child) throw new Error('数据库后台进程没有可恢复的活动数据库。');
    this.process = null;
    this.activeWorkspace = null;
    this.activeAppDatabasePath = null;
    this.rejectAll(new Error('数据库后台进程正在重启；未完成请求不会自动重放。'));
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill();
    await exited;
    if (payload) await this.openWorkspace(payload);
    else if (appDatabasePath) await this.openAppDatabase(appDatabasePath);
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
      this.activeAppDatabasePath = null;
      throw error;
    }
  }

  private async openAppDatabaseInternal(appDatabasePath: string): Promise<void> {
    if (!this.process) this.spawn();
    try {
      await this.request('openAppDatabase', { appDatabasePath });
      this.activeAppDatabasePath = appDatabasePath;
    } catch (error) {
      this.process?.kill();
      this.process = null;
      this.activeWorkspace = null;
      this.activeAppDatabasePath = null;
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
      this.rejectAll(
        new Error(`数据库后台进程意外退出（代码 ${code}）。`),
        code === 0 ? 'close' : 'workerfail'
      );
    });
    child.on('error', (_type, location) => {
      if (this.process !== child) return;
      this.rejectAll(new Error(`数据库后台进程发生致命错误：${location}`), 'workerfail');
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      try {
        process.stderr.write(`[SoulForge database utility] ${String(chunk)}`);
      } catch {
        // 忽略管道断开
      }
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
    const enqueuedAt = performance.now();
    const request = {
      protocolVersion: OPERATION_LOG_UTILITY_PROTOCOL,
      requestId,
      method,
      payload
    } as OperationLogUtilityRequest;
    return new Promise((resolve, reject) => {
      const timeout = this.timeoutForMethod(method);
      const depth = this.pending.size + 1;
      const dispatchedAt = performance.now();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.rememberLateRequest({
          requestId,
          method,
          enqueuedAt,
          dispatchedAt,
          depth
        });
        writeUtilityTrace({
          side: 'client',
          event: 'timeout',
          requestId,
          method,
          enqueue: enqueuedAt,
          start: null,
          finish: null,
          depth,
          queueWaitMs: null,
          dbDurationMs: null,
          timeout: true,
          timeoutMs: timeout,
          outcome: 'timeout'
        });
        reject(new Error(`数据库后台请求超时：${method}`));
      }, timeout);
      this.pending.set(requestId, {
        requestId,
        method,
        enqueuedAt,
        dispatchedAt,
        depth,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer
      });
      writeUtilityTrace({
        side: 'client',
        event: 'enqueue',
        requestId,
        method,
        enqueue: enqueuedAt,
        start: null,
        finish: null,
        depth,
        queueWaitMs: null,
        dbDurationMs: null,
        timeout: false,
        timeoutMs: timeout
      });
      try {
        child.postMessage(request);
        writeUtilityTrace({
          side: 'client',
          event: 'dispatch',
          requestId,
          method,
          enqueue: enqueuedAt,
          start: null,
          finish: null,
          depth,
          queueWaitMs: null,
          dbDurationMs: null,
          timeout: false,
          timeoutMs: timeout
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        writeUtilityTrace({
          side: 'client',
          event: 'finish',
          requestId,
          method,
          enqueue: enqueuedAt,
          start: null,
          finish: performance.now(),
          depth: this.pending.size,
          queueWaitMs: null,
          dbDurationMs: null,
          timeout: false,
          timeoutMs: timeout,
          outcome: 'post-error',
          errorCode: 'UTILITY_POST_MESSAGE_FAILED'
        });
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private timeoutForMethod(method: OperationLogUtilityMethod): number {
    switch (method) {
      case 'openWorkspace':
      case 'replaceFiles':
      case 'loadRagChunks':
      case 'replaceRagChunks':
      case 'mergeRagChunkDelta':
      case 'replaceReferences':
      case 'replaceDiagnostics':
      case 'planRecoveryCleanup':
      case 'getSemanticFileCache':
      case 'getAllSemanticFileCache':
      case 'record':
      case 'createTransaction':
      case 'transitionTransaction':
      case 'finalizeCommit':
        return Math.max(this.requestTimeoutMs, 120_000);
      default:
        return this.requestTimeoutMs;
    }
  }

  private onMessage(message: unknown): void {
    if (!isOperationLogUtilityResponse(message)) return;
    this.pruneLateRequests();
    const pending = this.pending.get(message.requestId);
    if (!pending) {
      const late = this.lateRequests.get(message.requestId);
      if (!late) return;
      this.lateRequests.delete(message.requestId);
      writeUtilityTrace({
        side: 'client',
        event: 'late-completion',
        requestId: late.requestId,
        method: late.method,
        enqueue: late.enqueuedAt,
        start: null,
        finish: performance.now(),
        depth: late.depth,
        queueWaitMs: null,
        dbDurationMs: null,
        timeout: true,
        outcome: 'late-completion',
        ...(message.ok ? {} : { errorCode: message.error?.code ?? 'DATABASE_UTILITY_FAILED' })
      });
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);
    writeUtilityTrace({
      side: 'client',
      event: 'finish',
      requestId: pending.requestId,
      method: pending.method,
      enqueue: pending.enqueuedAt,
      start: null,
      finish: performance.now(),
      depth: this.pending.size,
      queueWaitMs: null,
      dbDurationMs: null,
      timeout: false,
      outcome: message.ok ? (pending.method === 'close' ? 'close' : 'ok') : 'request-failed',
      ...(message.ok ? {} : { errorCode: message.error?.code ?? 'DATABASE_UTILITY_FAILED' })
    });
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

  private rejectAll(error: Error, outcome: 'workerfail' | 'close' = 'workerfail'): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      writeUtilityTrace({
        side: 'client',
        event: outcome,
        requestId: pending.requestId,
        method: pending.method,
        enqueue: pending.enqueuedAt,
        start: null,
        finish: performance.now(),
        depth: this.pending.size,
        queueWaitMs: null,
        dbDurationMs: null,
        timeout: false,
        outcome,
        errorCode: outcome === 'close' ? 'UTILITY_PROCESS_CLOSED' : 'UTILITY_PROCESS_FAILED'
      });
      pending.reject(error);
    }
    this.pending.clear();
  }

  private rememberLateRequest(request: Omit<LateRequest, 'expiresAt'>): void {
    this.pruneLateRequests();
    this.lateRequests.set(request.requestId, {
      ...request,
      expiresAt: performance.now() + 60_000
    });
    while (this.lateRequests.size > 128) {
      const oldest = this.lateRequests.keys().next().value;
      if (!oldest) break;
      this.lateRequests.delete(oldest);
    }
  }

  private pruneLateRequests(): void {
    const now = performance.now();
    for (const [requestId, request] of this.lateRequests) {
      if (request.expiresAt <= now) this.lateRequests.delete(requestId);
    }
  }
}

function writeUtilityTrace(trace: UtilityTrace): void {
  try {
    process.stderr.write(`[SoulForge database utility trace] ${JSON.stringify({
      ...trace,
      requestId: boundedTraceString(trace.requestId, 128),
      method: boundedTraceString(trace.method, 64),
      ...(trace.errorCode ? { errorCode: boundedTraceString(trace.errorCode, 96) } : {}),
      enqueue: boundedTraceNumber(trace.enqueue),
      start: trace.start === null ? null : boundedTraceNumber(trace.start),
      finish: trace.finish === null ? null : boundedTraceNumber(trace.finish),
      queueWaitMs: trace.queueWaitMs === null ? null : boundedTraceNumber(trace.queueWaitMs),
      dbDurationMs: trace.dbDurationMs === null ? null : boundedTraceNumber(trace.dbDurationMs)
    })}\n`);
  } catch {
    // 诊断输出不能影响数据库 RPC。
  }
}

function boundedTraceNumber(value: number): number {
  return Math.min(Math.max(Math.round(value * 100) / 100, 0), 86_400_000);
}

function boundedTraceString(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
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
