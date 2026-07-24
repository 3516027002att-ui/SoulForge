import {
  importLegacyOperationLog,
  importLegacySemanticSnapshot,
  DurableWorkspaceRepository,
  RuntimeAdapterSettingsRepository,
  RuntimeLaunchSessionRepository,
  RuntimeVerificationEvidenceRepository,
  WorkspaceDataRepository,
  openAppDatabase,
  openSqliteOperationLogStore,
  type SqliteDatabase,
  type SqliteOperationLogStore
} from '@soulforge/core';
import {
  OPERATION_LOG_UTILITY_PROTOCOL,
  type OpenAppDatabasePayload,
  type OpenWorkspaceDatabasePayload,
  type OperationLogUtilityRequest,
  type OperationLogUtilityResponse
} from './operationLogUtilityProtocol.js';

let store: SqliteOperationLogStore | null = null;
let appDatabase: SqliteDatabase | null = null;
let appDatabasePath: string | null = null;
let workspaceId: string | null = null;
let durableRepository: DurableWorkspaceRepository | null = null;
let workspaceDataRepository: WorkspaceDataRepository | null = null;
let runtimeSettingsRepository: RuntimeAdapterSettingsRepository | null = null;
let runtimeSessionRepository: RuntimeLaunchSessionRepository | null = null;
let runtimeVerificationRepository: RuntimeVerificationEvidenceRepository | null = null;
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
    case 'openApp':
      return openApp(request.payload);
    case 'openWorkspace':
      return openWorkspace(request.payload);
    case 'health':
      return {
        ready: store !== null,
        appReady: appDatabase !== null,
        ...(workspaceId ? { workspaceId } : {})
      };
    case 'close':
      closeAll();
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
    case 'getRuntimeAdapterSetting':
      return requireRuntimeSettingsRepository().get(request.payload.adapterId);
    case 'upsertRuntimeAdapterSetting':
      requireRuntimeSettingsRepository().upsert(request.payload.setting);
      return null;
    case 'deleteRuntimeAdapterSetting':
      return requireRuntimeSettingsRepository().delete(request.payload.adapterId);
    case 'upsertRuntimeSession':
      requireRuntimeSessionRepository().upsertRuntimeSession(request.payload.record);
      return null;
    case 'getRuntimeSession':
      return requireRuntimeSessionRepository().getRuntimeSession(request.payload.sessionId);
    case 'listRuntimeSessions':
      return requireRuntimeSessionRepository().listRuntimeSessions(request.payload.workspaceId);
    case 'appendRuntimeVerificationEvidence':
      requireRuntimeVerificationRepository().appendRuntimeVerificationEvidence(
        request.payload.evidence
      );
      return null;
    case 'listRuntimeVerificationEvidence':
      return requireRuntimeVerificationRepository().listRuntimeVerificationEvidence(
        request.payload.sessionId
      );
  }
}

function openApp(payload: OpenAppDatabasePayload): { appReady: true } {
  ensureAppDatabase(payload.appDatabasePath);
  return { appReady: true };
}

async function openWorkspace(payload: OpenWorkspaceDatabasePayload) {
  closeWorkspaceStore();
  ensureAppDatabase(payload.appDatabasePath);
  let next: SqliteOperationLogStore | null = null;
  try {
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
    runtimeSessionRepository = new RuntimeLaunchSessionRepository(next.database, payload.workspaceId);
    runtimeVerificationRepository = new RuntimeVerificationEvidenceRepository(
      next.database,
      payload.workspaceId
    );
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
    closeWorkspaceStore();
    throw error;
  }
}

function ensureAppDatabase(path: string): void {
  if (appDatabase && appDatabasePath === path) return;
  if (store) {
    throw codedError(
      'APP_DATABASE_SWITCH_WITH_OPEN_WORKSPACE',
      '活动工作区存在时拒绝切换 app.db authority。'
    );
  }
  appDatabase?.close();
  appDatabase = openAppDatabase(path, {
    ...(process.env.SOULFORGE_SQLITE_NATIVE_BINDING
      ? { nativeBinding: process.env.SOULFORGE_SQLITE_NATIVE_BINDING }
      : {})
  });
  appDatabasePath = path;
  runtimeSettingsRepository = new RuntimeAdapterSettingsRepository(appDatabase);
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

function requireRuntimeSettingsRepository(): RuntimeAdapterSettingsRepository {
  if (!runtimeSettingsRepository) {
    throw codedError('APP_DATABASE_NOT_INITIALIZED', 'app.db runtime settings authority 尚未初始化。');
  }
  return runtimeSettingsRepository;
}

function requireRuntimeSessionRepository(): RuntimeLaunchSessionRepository {
  if (!runtimeSessionRepository) {
    throw codedError('DATABASE_UTILITY_NOT_INITIALIZED', 'workspace runtime session authority 尚未初始化。');
  }
  return runtimeSessionRepository;
}

function requireRuntimeVerificationRepository(): RuntimeVerificationEvidenceRepository {
  if (!runtimeVerificationRepository) {
    throw codedError(
      'DATABASE_UTILITY_NOT_INITIALIZED',
      'workspace runtime verification evidence authority 尚未初始化。'
    );
  }
  return runtimeVerificationRepository;
}

function closeWorkspaceStore(): void {
  store?.close();
  store = null;
  durableRepository = null;
  workspaceDataRepository = null;
  runtimeSessionRepository = null;
  runtimeVerificationRepository = null;
  workspaceId = null;
}

function closeAll(): void {
  closeWorkspaceStore();
  appDatabase?.close();
  appDatabase = null;
  appDatabasePath = null;
  runtimeSettingsRepository = null;
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

process.once('exit', closeAll);
