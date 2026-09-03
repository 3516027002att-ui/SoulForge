import {
  importLegacyOperationLog,
  importLegacySemanticSnapshot,
  DurableWorkspaceRepository,
  WorkspaceDataRepository,
  openAppDatabase,
  openSqliteOperationLogStore,
  type SqliteDatabase,
  type SqliteOperationLogStore
} from '@soulforge/core';
import {
  OPERATION_LOG_UTILITY_PROTOCOL,
  type OpenWorkspaceDatabasePayload,
  type OperationLogUtilityRequest,
  type OperationLogUtilityResponse,
  type ProviderUsageAggregate,
  type ProviderUsageEventPayload,
  type ProviderUsageSummary
} from './operationLogUtilityProtocol.js';

let store: SqliteOperationLogStore | null = null;
let appDatabase: SqliteDatabase | null = null;
let appDatabasePath: string | null = null;
let workspaceId: string | null = null;
let durableRepository: DurableWorkspaceRepository | null = null;
let workspaceDataRepository: WorkspaceDataRepository | null = null;
let queue: Promise<void> = Promise.resolve();

const utilityParentPort = process.parentPort;

utilityParentPort.on('message', (event) => {
  const request = event.data as unknown;
  queue = queue.then(() => handleRequest(request)).catch((error) => {
    process.stderr.write(`SoulForge database utility queue failure: ${formatError(error)}\n`);
  });
});

async function handleRequest(value: unknown): Promise<void> {
  if (!isRequest(value)) {
    post({
      protocolVersion: OPERATION_LOG_UTILITY_PROTOCOL,
      requestId: requestIdOrUnknown(value),
      ok: false,
      error: {
        code: 'DATABASE_UTILITY_REQUEST_INVALID',
        message: '数据库后台进程收到了无效请求。'
      }
    });
    return;
  }

  try {
    const result = await dispatch(value);
    post({
      protocolVersion: OPERATION_LOG_UTILITY_PROTOCOL,
      requestId: value.requestId,
      ok: true,
      result
    });
  } catch (error) {
    post({
      protocolVersion: OPERATION_LOG_UTILITY_PROTOCOL,
      requestId: value.requestId,
      ok: false,
      error: {
        code: errorCode(error),
        message: formatError(error)
      }
    });
  }
}

async function dispatch(request: OperationLogUtilityRequest): Promise<unknown> {
  switch (request.method) {
    case 'openAppDatabase':
      return openAppDatabaseOnly(request.payload.appDatabasePath);
    case 'openWorkspace':
      return openWorkspace(request.payload);
    case 'recordProviderUsage':
      recordProviderUsage(request.payload.event);
      return null;
    case 'providerUsageSummary':
      return providerUsageSummary();
    case 'health':
      return {
        ready: store !== null,
        appReady: appDatabase !== null,
        ...(workspaceId ? { workspaceId } : {})
      };
    case 'close':
      closeStore();
      return null;
    case 'record':
      await requireStore().record(request.payload.entry);
      return null;
    case 'get':
      return requireStore().get(request.payload.opId);
    case 'list':
      return requireStore().list(request.payload.workspaceId);
    case 'updateStatus':
      return requireStore().updateStatus(
        request.payload.opId,
        request.payload.status,
        request.payload.patch
      );
    case 'history':
      return requireStore().history(request.payload.workspaceId);
    case 'createTransaction':
      requireDurableRepository().createTransaction(request.payload.record);
      return null;
    case 'transitionTransaction':
      return requireDurableRepository().transitionTransaction(request.payload);
    case 'listIncompleteTransactions':
      return requireDurableRepository().listIncompleteTransactions();
    case 'recordRecoveryPoint':
      return requireDurableRepository().recordRecoveryPoint(request.payload.record);
    case 'listRecoveryPoints':
      return requireDurableRepository().listRecoveryPoints();
    case 'planRecoveryCleanup':
      return requireDurableRepository().planRecoveryCleanup({
        ...(request.payload.now ? { now: new Date(request.payload.now) } : {}),
        ...(request.payload.maxAgeDays === undefined ? {} : { maxAgeDays: request.payload.maxAgeDays }),
        ...(request.payload.maxBytes === undefined ? {} : { maxBytes: request.payload.maxBytes })
      });
    case 'markRecoveryPointExpired':
      requireDurableRepository().markRecoveryPointExpired(request.payload.recoveryId);
      return null;
    case 'appendAuditEvent':
      return requireDurableRepository().appendAuditEvent(request.payload.event);
    case 'listAuditEvents':
      return requireDurableRepository().listAuditEvents();
    case 'recordResourceEntryChange':
      requireDurableRepository().recordResourceEntryChange(request.payload.record);
      return null;
    case 'listResourceEntryChanges':
      return requireDurableRepository().listResourceEntryChanges(request.payload.opId);
    case 'finalizeCommit':
      await requireStore().finalizeCommit(request.payload.bundle);
      return null;
    case 'replaceFiles':
      requireWorkspaceDataRepository().replaceFiles(request.payload.files);
      return null;
    case 'searchFiles':
      return requireWorkspaceDataRepository().searchFiles(request.payload.query, request.payload.limit);
    case 'replaceRagChunks':
      requireWorkspaceDataRepository().replaceRagChunks(request.payload.chunks);
      return null;
    case 'mergeRagChunks':
      requireWorkspaceDataRepository().mergeRagChunks(request.payload.chunks);
      return null;
    case 'mergeRagChunkDelta':
      requireWorkspaceDataRepository().mergeRagChunkDelta(request.payload);
      return null;
    case 'loadRagChunks':
      return requireWorkspaceDataRepository().loadRagChunks();
    case 'searchRagChunks':
      return requireWorkspaceDataRepository().searchRagChunks(request.payload.query, request.payload.limit);
    case 'replaceRagEmbeddings':
      requireWorkspaceDataRepository().replaceRagEmbeddings(request.payload.entries);
      return null;
    case 'mergeRagEmbeddings':
      requireWorkspaceDataRepository().mergeRagEmbeddings(request.payload);
      return null;
    case 'loadRagEmbeddings': {
      const vectors = requireWorkspaceDataRepository().loadRagEmbeddings();
      const plain: Record<string, number[]> = {};
      for (const [chunkId, vector] of vectors) plain[chunkId] = Array.from(vector);
      return plain;
    }
    case 'loadRagEmbeddingRecords':
      return requireWorkspaceDataRepository().loadRagEmbeddingRecords().map((record) => ({
        chunkId: record.chunkId,
        model: record.model,
        contentHash: record.contentHash,
        vector: Array.from(record.vector)
      }));
    case 'ragEmbeddingModel':
      return requireWorkspaceDataRepository().ragEmbeddingModel();
    case 'replaceReferences':
      requireWorkspaceDataRepository().replaceReferences(request.payload.references);
      return null;
    case 'loadReferences':
      return requireWorkspaceDataRepository().loadReferences();
    case 'replaceDiagnostics':
      requireWorkspaceDataRepository().replaceDiagnostics(request.payload.diagnostics);
      return null;
    case 'listDiagnostics':
      return requireWorkspaceDataRepository().listDiagnostics();
    case 'upsertJob':
      requireWorkspaceDataRepository().upsertJob(request.payload.job);
      return null;
    case 'listJobs':
      return requireWorkspaceDataRepository().listJobs();
  }
}

async function openWorkspace(payload: OpenWorkspaceDatabasePayload) {
  closeStore();
  let nextAppDatabase: SqliteDatabase | null = null;
  let next: SqliteOperationLogStore | null = null;
  try {
    nextAppDatabase = openAppDatabase(payload.appDatabasePath, {
      ...(process.env.SOULFORGE_SQLITE_NATIVE_BINDING
        ? { nativeBinding: process.env.SOULFORGE_SQLITE_NATIVE_BINDING }
        : {})
    });
    next = openSqliteOperationLogStore({
      databasePath: payload.databasePath,
      workspaceId: payload.workspaceId,
      rootPath: payload.rootPath,
      game: payload.game,
      ...(process.env.SOULFORGE_SQLITE_NATIVE_BINDING
        ? { nativeBinding: process.env.SOULFORGE_SQLITE_NATIVE_BINDING }
        : {})
    });
    const legacyImport = await importLegacyOperationLog({
      sourcePath: payload.legacyOperationLogPath,
      backupDirectory: payload.legacyBackupDirectory,
      store: next
    });
    const semanticImport = await importLegacySemanticSnapshot({
      sourcePath: payload.legacySemanticSnapshotPath,
      backupDirectory: payload.legacySemanticBackupDirectory,
      database: next.database,
      workspaceId: payload.workspaceId
    });
    store = next;
    durableRepository = new DurableWorkspaceRepository(next.database, payload.workspaceId);
    workspaceDataRepository = new WorkspaceDataRepository(next.database, payload.workspaceId);
    appDatabase = nextAppDatabase;
    appDatabasePath = payload.appDatabasePath;
    workspaceId = payload.workspaceId;
    return {
      workspaceId,
      legacyImport: {
        status: legacyImport.status,
        recordCount: legacyImport.recordCount,
        ...(legacyImport.backupPath ? { backupPath: legacyImport.backupPath } : {})
      },
      semanticImport: {
        status: semanticImport.status,
        nodeCount: semanticImport.nodeCount,
        edgeCount: semanticImport.edgeCount,
        ...(semanticImport.backupPath ? { backupPath: semanticImport.backupPath } : {})
      }
    };
  } catch (error) {
    next?.close();
    nextAppDatabase?.close();
    throw error;
  }
}

function openAppDatabaseOnly(databasePath: string): { appReady: true } {
  if (appDatabase && appDatabasePath === databasePath) return { appReady: true };
  const next = openAppDatabase(databasePath, {
    ...(process.env.SOULFORGE_SQLITE_NATIVE_BINDING
      ? { nativeBinding: process.env.SOULFORGE_SQLITE_NATIVE_BINDING }
      : {})
  });
  appDatabase?.close();
  appDatabase = next;
  appDatabasePath = databasePath;
  return { appReady: true };
}

function recordProviderUsage(event: ProviderUsageEventPayload): void {
  for (const [field, value] of [
    ['callIndex', event.callIndex],
    ['currentContextTokens', event.currentContextTokens],
    ...(event.inputTokens === undefined ? [] : [['inputTokens', event.inputTokens] as const]),
    ...(event.outputTokens === undefined ? [] : [['outputTokens', event.outputTokens] as const])
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw codedError('PROVIDER_USAGE_INVALID', `${field} 必须是非负安全整数。`);
    }
  }
  requireAppDatabase().prepare(`
    INSERT INTO provider_usage_events (
      event_id, session_id, service_id, protocol, model, call_index,
      input_tokens, output_tokens, context_tokens, context_source,
      provider_reported, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO NOTHING
  `).run(
    event.eventId,
    event.sessionId,
    event.serviceId,
    event.protocol,
    event.model,
    event.callIndex,
    event.inputTokens ?? null,
    event.outputTokens ?? null,
    event.currentContextTokens,
    event.contextSource,
    event.providerReported ? 1 : 0,
    event.recordedAt
  );
}

interface UsageAggregateRow {
  service_id?: string;
  protocol?: string;
  model?: string;
  calls: number;
  reported_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  first_used_at: string | null;
  last_used_at: string | null;
}

function providerUsageSummary(): ProviderUsageSummary {
  const database = requireAppDatabase();
  const totals = database.prepare(`
    SELECT COUNT(*) AS calls,
      COALESCE(SUM(provider_reported), 0) AS reported_calls,
      COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
      COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
      MIN(created_at) AS first_used_at,
      MAX(created_at) AS last_used_at
    FROM provider_usage_events
  `).get() as UsageAggregateRow;
  const byServiceRows = database.prepare(`
    SELECT service_id, protocol, model, COUNT(*) AS calls,
      COALESCE(SUM(provider_reported), 0) AS reported_calls,
      COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
      COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
      MIN(created_at) AS first_used_at,
      MAX(created_at) AS last_used_at
    FROM provider_usage_events
    GROUP BY service_id, protocol, model
    ORDER BY MAX(created_at) DESC
  `).all() as UsageAggregateRow[];
  const latest = database.prepare(`
    SELECT session_id, service_id, protocol, model, call_index, context_tokens,
      context_source
    FROM provider_usage_events
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `).get() as {
    session_id: string;
    service_id: string;
    protocol: string;
    model: string;
    call_index: number;
    context_tokens: number;
    context_source: 'provider' | 'estimated';
  } | undefined;

  let latestSession: ProviderUsageSummary['latestSession'] = null;
  if (latest) {
    const row = database.prepare(`
      SELECT COUNT(*) AS calls,
        COALESCE(SUM(provider_reported), 0) AS reported_calls,
        COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
        MIN(created_at) AS first_used_at,
        MAX(created_at) AS last_used_at
      FROM provider_usage_events
      WHERE session_id = ?
    `).get(latest.session_id) as UsageAggregateRow;
    latestSession = {
      sessionId: latest.session_id,
      serviceId: latest.service_id,
      protocol: latest.protocol,
      model: latest.model,
      ...usageNumbers(row),
      lastCallIndex: Number(latest.call_index),
      currentContextTokens: Number(latest.context_tokens),
      contextSource: latest.context_source
    };
  }

  return {
    ...usageNumbers(totals),
    byService: byServiceRows.map((row): ProviderUsageAggregate => ({
      serviceId: row.service_id ?? '',
      protocol: row.protocol ?? '',
      model: row.model ?? '',
      ...usageNumbers(row)
    })),
    latestSession
  };
}

function usageNumbers(row: UsageAggregateRow): Omit<ProviderUsageAggregate, 'serviceId' | 'protocol' | 'model'> {
  return {
    calls: Number(row.calls),
    reportedCalls: Number(row.reported_calls),
    totalInputTokens: Number(row.total_input_tokens),
    totalOutputTokens: Number(row.total_output_tokens),
    firstUsedAt: row.first_used_at,
    lastUsedAt: row.last_used_at
  };
}

function requireStore(): SqliteOperationLogStore {
  if (!store) throw codedError('DATABASE_UTILITY_NOT_INITIALIZED', '工作区数据库尚未初始化。');
  return store;
}

function requireDurableRepository(): DurableWorkspaceRepository {
  if (!durableRepository) throw codedError('DATABASE_UTILITY_NOT_INITIALIZED', '工作区数据库尚未初始化。');
  return durableRepository;
}

function requireWorkspaceDataRepository(): WorkspaceDataRepository {
  if (!workspaceDataRepository) throw codedError('DATABASE_UTILITY_NOT_INITIALIZED', '工作区数据库尚未初始化。');
  return workspaceDataRepository;
}

function requireAppDatabase(): SqliteDatabase {
  if (!appDatabase) throw codedError('DATABASE_UTILITY_NOT_INITIALIZED', '应用数据库尚未初始化。');
  return appDatabase;
}

function closeStore(): void {
  store?.close();
  appDatabase?.close();
  store = null;
  durableRepository = null;
  workspaceDataRepository = null;
  appDatabase = null;
  appDatabasePath = null;
  workspaceId = null;
}

function post(response: OperationLogUtilityResponse): void {
  utilityParentPort.postMessage(response);
}

function isRequest(value: unknown): value is OperationLogUtilityRequest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<OperationLogUtilityRequest>;
  return candidate.protocolVersion === OPERATION_LOG_UTILITY_PROTOCOL
    && typeof candidate.requestId === 'string'
    && typeof candidate.method === 'string'
    && candidate.payload !== null
    && typeof candidate.payload === 'object';
}

function requestIdOrUnknown(value: unknown): string {
  return value && typeof value === 'object' && typeof (value as { requestId?: unknown }).requestId === 'string'
    ? (value as { requestId: string }).requestId
    : 'unknown';
}

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'DATABASE_UTILITY_FAILED';
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

process.once('exit', closeStore);
