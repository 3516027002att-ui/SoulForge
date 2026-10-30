import {
  importLegacyOperationLog,
  importLegacySemanticSnapshot,
  DurableWorkspaceRepository,
  WorkspaceDataRepository,
  isRagChunkDeltaStats,
  KnowledgeStore,
  openAppDatabase,
  openSqliteOperationLogStore,
  openWorkspaceDatabase,
  SqliteKnowledgeStorePersistence,
  SqliteOperationLogStore,
  type SqliteDatabase
} from '@soulforge/core';
import {
  OPERATION_LOG_UTILITY_PROTOCOL,
  isReadOnlyUtilityMethod,
  type OpenWorkspaceDatabasePayload,
  type OperationLogRequestJournalEntry,
  type OperationLogUtilityRequest,
  type OperationLogUtilityResponse,
  type ProviderUsageAggregate,
  type ProviderUsageEventPayload,
  type ProviderUsageSummary
} from './operationLogUtilityProtocol.js';
import { performance } from 'node:perf_hooks';
import { dirname, join } from 'node:path';
import { createQueueObservationWriter } from './databaseUtilityTelemetry.js';
import { migrateWorkspaceDatabaseSnapshot } from './workspaceDatabaseMigration.js';

let store: SqliteOperationLogStore | null = null;
let appDatabase: SqliteDatabase | null = null;
let appDatabasePath: string | null = null;
let workspaceId: string | null = null;
let durableRepository: DurableWorkspaceRepository | null = null;
let workspaceDataRepository: WorkspaceDataRepository | null = null;
let queue: Promise<void> = Promise.resolve();
let queueDepth = 0;
let workspaceRootPath: string | null = null;
let workspaceGame: string | null = null;

/**
 * 读侧独立连接（#42）。
 *
 * 读写共用一条 promise 链时，一次长写（提交事务、批量替换 RAG 块）会把后面所有读
 * 一起堵住，而读是 UI 与 Agent 的常规操作。这里多开一条 **只读** 连接：SQLite 的
 * WAL 允许一写多读，读看到的是已提交快照，不会被写事务的锁阻塞。
 *
 * 读连接不跑迁移、不建表，所以它永远只能看到已经由写侧建好的库；打不开时读方法
 * 明确报 DATABASE_UTILITY_NOT_INITIALIZED，而不是偷偷退回写队列（退回就等于把
 * "读不被长写阻塞"这条保证悄悄取消）。
 */
let readDatabase: SqliteDatabase | null = null;
let readStore: SqliteOperationLogStore | null = null;
let readDurableRepository: DurableWorkspaceRepository | null = null;
let readWorkspaceDataRepository: WorkspaceDataRepository | null = null;
let readQueue: Promise<void> = Promise.resolve();

/**
 * 请求台账（#42）。
 *
 * 调用方超时只是"没收到回执"，不代表 worker 里没执行。台账记录每个 requestId 的
 * 真实结局，超时后可以按操作 ID 查：done + ok 表示确实提交了，不要把重试当成
 * 第一次执行。只保留最近 512 条——被挤掉的查询返回 `state: 'unknown'`，那同样
 * 不足以断定"没执行"。
 */
const REQUEST_JOURNAL_LIMIT = 512;
const requestJournal = new Map<string, {
  requestId: string;
  method: string;
  state: 'queued' | 'running' | 'done';
  outcome: 'ok' | 'request-failed' | 'workerfail' | null;
  errorCode?: string;
  enqueuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}>();

function journalUpdate(
  requestId: string,
  method: string,
  patch: Partial<{
    state: 'queued' | 'running' | 'done';
    outcome: 'ok' | 'request-failed' | 'workerfail';
    errorCode: string;
    startedAt: number;
    finishedAt: number;
  }>
): void {
  const previous = requestJournal.get(requestId);
  const entry = previous ?? {
    requestId,
    method,
    state: 'queued' as const,
    outcome: null,
    enqueuedAt: performance.now(),
    startedAt: null,
    finishedAt: null
  };
  const next = { ...entry, ...patch };
  requestJournal.delete(requestId);
  requestJournal.set(requestId, next);
  while (requestJournal.size > REQUEST_JOURNAL_LIMIT) {
    const oldest = requestJournal.keys().next().value;
    if (oldest === undefined) break;
    requestJournal.delete(oldest);
  }
}

function readJournalEntry(requestId: string): OperationLogRequestJournalEntry {
  const entry = requestJournal.get(requestId);
  if (!entry) {
    return {
      requestId,
      method: 'unknown',
      state: 'unknown',
      outcome: null,
      queueWaitMs: null,
      runMs: null
    };
  }
  return {
    requestId,
    method: entry.method,
    state: entry.state,
    outcome: entry.outcome,
    ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
    queueWaitMs: entry.startedAt === null ? null : boundedDuration(entry.startedAt - entry.enqueuedAt),
    runMs: entry.startedAt === null || entry.finishedAt === null
      ? null
      : boundedDuration(entry.finishedAt - entry.startedAt)
  };
}

/**
 * 走读队列的方法。判据是"只读"而非"快"：这里每一条都只查库、不写库，因此可以
 * 在只读连接上跑。新增方法必须复查这一点——写方法混进来会在只读连接上抛
 * SQLITE_READONLY，而不是静默写坏数据。
 */
const READ_ONLY_METHODS: ReadonlySet<string> = new Set<OperationLogUtilityRequest['method']>([
  'health',
  'providerUsageSummary',
  'queryRequest',
  'get',
  'list',
  'history',
  'listIncompleteTransactions',
  'listRecoveryPoints',
  'planRecoveryCleanup',
  'listAuditEvents',
  'listResourceEntryChanges',
  'searchFiles',
  'loadRagChunks',
  'searchRagChunks',
  'loadRagEmbeddings',
  'loadRagEmbeddingRecords',
  'ragEmbeddingModel'
]);

const writeUtilityTrace = createQueueObservationWriter({ side: 'worker' });

const utilityParentPort = process.parentPort;

utilityParentPort.on('message', (event) => {
  const request = event.data as unknown;
  const enqueuedAt = performance.now();
  const depth = ++queueDepth;
  const requestId = requestIdOrUnknown(request);
  const method = methodOrUnknown(request);
  journalUpdate(requestId, method, { state: 'queued' });
  writeUtilityTrace({
    event: 'enqueue',
    requestId,
    method,
    enqueue: enqueuedAt,
    start: null,
    finish: null,
    depth,
    queueWaitMs: null,
    dbDurationMs: null,
    timeout: false
  });
  const run = async (): Promise<void> => {
    const startedAt = performance.now();
    journalUpdate(requestId, method, { state: 'running', startedAt });
    writeUtilityTrace({
      event: 'start',
      requestId,
      method,
      enqueue: enqueuedAt,
      start: startedAt,
      finish: null,
      depth,
      queueWaitMs: boundedDuration(startedAt - enqueuedAt),
      dbDurationMs: null,
      timeout: false
    });
    let outcome: 'ok' | 'request-failed' | 'workerfail' = 'ok';
    let failureCode: string | undefined;
    try {
      outcome = isReadOnlyUtilityMethod(method)
        ? await handleRequest(request, dispatchRead)
        : await handleRequest(request, dispatch);
    } catch (error) {
      outcome = 'workerfail';
      failureCode = errorCode(error);
      throw error;
    } finally {
      const finishedAt = performance.now();
      journalUpdate(requestId, method, {
        state: 'done',
        outcome,
        finishedAt,
        ...(failureCode ? { errorCode: failureCode } : {})
      });
      writeUtilityTrace({
        event: 'finish',
        requestId,
        method,
        enqueue: enqueuedAt,
        start: startedAt,
        finish: finishedAt,
        depth,
        queueWaitMs: boundedDuration(startedAt - enqueuedAt),
        dbDurationMs: boundedDuration(finishedAt - startedAt),
        timeout: false,
        outcome,
        ...(failureCode ? { errorCode: failureCode } : {})
      });
      queueDepth -= 1;
    }
  };
  // 读走独立队列：它只与其它读互斥，不排在长写后面。
  const target = isReadOnlyUtilityMethod(method)
    ? (readQueue = readQueue.then(run))
    : (queue = queue.then(run));
  target.catch((error) => {
    process.stderr.write(`SoulForge database utility queue failure: ${errorCode(error)}\n`);
  });
});

async function handleRequest(
  value: unknown,
  dispatchFn: (request: OperationLogUtilityRequest) => Promise<unknown> | unknown = dispatch
): Promise<'ok' | 'request-failed'> {
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
    return 'request-failed';
  }

  try {
    const result = await dispatchFn(value);
    post({
      protocolVersion: OPERATION_LOG_UTILITY_PROTOCOL,
      requestId: value.requestId,
      ok: true,
      result
    });
    return 'ok';
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
    return 'request-failed';
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
      assertWorkspaceRequest(request.payload.workspaceId);
      requireWorkspaceDataRepository().replaceRagChunks(request.payload.chunks);
      return null;
    case 'mergeRagChunks':
      assertWorkspaceRequest(request.payload.workspaceId);
      requireWorkspaceDataRepository().mergeRagChunks(request.payload.chunks);
      return null;
    case 'mergeRagChunkDelta': {
      assertWorkspaceRequest(request.payload.workspaceId);
      const stats = requireWorkspaceDataRepository().mergeRagChunkDelta(request.payload);
      // The transaction has already committed when this result is produced.
      // An invalid diagnostic must therefore become explicit unavailable
      // rather than a fabricated zero-filled receipt.
      return isRagChunkDeltaStats(stats) ? stats : null;
    }
    case 'loadRagChunks':
      assertWorkspaceRequest(request.payload.workspaceId);
      return requireWorkspaceDataRepository().loadRagChunks();
    case 'searchRagChunks':
      assertWorkspaceRequest(request.payload.workspaceId);
      return requireWorkspaceDataRepository().searchRagChunks(request.payload.query, request.payload.limit);
    case 'replaceRagEmbeddings':
      assertWorkspaceRequest(request.payload.workspaceId);
      requireWorkspaceDataRepository().replaceRagEmbeddings(request.payload.entries);
      return null;
    case 'mergeRagEmbeddings':
      assertWorkspaceRequest(request.payload.workspaceId);
      requireWorkspaceDataRepository().mergeRagEmbeddings(request.payload);
      return null;
    case 'loadRagEmbeddings': {
      assertWorkspaceRequest(request.payload.workspaceId);
      const vectors = requireWorkspaceDataRepository().loadRagEmbeddings();
      const plain: Record<string, number[]> = {};
      for (const [chunkId, vector] of vectors) plain[chunkId] = Array.from(vector);
      return plain;
    }
    case 'loadRagEmbeddingRecords':
      assertWorkspaceRequest(request.payload.workspaceId);
      return requireWorkspaceDataRepository().loadRagEmbeddingRecords().map((record) => ({
        chunkId: record.chunkId,
        model: record.model,
        contentHash: record.contentHash,
        vector: Array.from(record.vector)
      }));
    case 'ragEmbeddingModel':
      assertWorkspaceRequest(request.payload.workspaceId);
      return requireWorkspaceDataRepository().ragEmbeddingModel();
    case 'replaceReferences':
      assertWorkspaceRequest(request.payload.workspaceId);
      requireWorkspaceDataRepository().replaceReferences(request.payload.references);
      return null;
    case 'loadReferences':
      assertWorkspaceRequest(request.payload.workspaceId);
      return requireWorkspaceDataRepository().loadReferences();
    case 'replaceDiagnostics':
      requireWorkspaceDataRepository().replaceDiagnostics(request.payload.diagnostics);
      return null;
    case 'listDiagnostics':
      return requireWorkspaceDataRepository().listDiagnostics();
    case 'upsertJob':
      assertWorkspaceRequest(request.payload.workspaceId);
      requireWorkspaceDataRepository().upsertJob(request.payload.job);
      return null;
    case 'listJobs':
      return requireWorkspaceDataRepository().listJobs();
    case 'getSemanticFileCache':
      return requireWorkspaceDataRepository().getSemanticFileCacheRow(request.payload.relativePath);
    case 'getAllSemanticFileCache':
      return {
        entries: requireWorkspaceDataRepository().getAllSemanticFileCacheRows()
      };
    case 'upsertSemanticFileCache':
      requireWorkspaceDataRepository().upsertSemanticFileCacheRow(request.payload.entry);
      return null;
    case 'loadKnowledgeSnapshot': {
      assertWorkspaceRequest(request.payload.workspaceId);
      if (request.payload.rootPath !== workspaceRootPath || request.payload.game !== workspaceGame) {
        throw codedError('DATABASE_UTILITY_WORKSPACE_METADATA_MISMATCH', 'Knowledge snapshot 请求的 rootPath/game 与活动工作区不匹配。');
      }
      const activeStore = requireStore();
      const persistence = new SqliteKnowledgeStorePersistence(activeStore.database, {
        workspaceId: activeStore.workspaceId,
        rootPath: workspaceRootPath ?? undefined,
        game: workspaceGame ?? undefined,
        ensureWorkspaceRow: false
      });
      let snapshot = persistence.load();
      if (!snapshot) {
        // Preserve the old first-open behavior: gen-0 is durably initialized
        // on the utility connection, never through a main-process handle.
        new KnowledgeStore({ persistence, schemaVersion: 'knowledge-v1' });
        snapshot = persistence.load();
      }
      return snapshot;
    }
  }
}

/**
 * 读侧分发（#42）。这里每个分支都只查库，跑在只读连接上，因此不会被长写挡住。
 *
 * 与 `dispatch` 里的同名分支刻意并存而不是抽公共函数：写侧分支用的全局实例是
 * 读写连接上的仓储，读侧用只读连接上的仓储。合并成一个函数就需要在运行时切换
 * 全局，而 dispatch 是 async，切换会在 await 处泄漏到别的请求上。
 */
function dispatchRead(request: OperationLogUtilityRequest): unknown {
  switch (request.method) {
    case 'health':
      return {
        ready: readStore !== null,
        appReady: appDatabase !== null,
        ...(workspaceId ? { workspaceId } : {})
      };
    case 'providerUsageSummary':
      // 应用库（app.db）只有写侧会打开，读侧复用同一实例：它不参与工作区长写，
      // 不会成为阻塞源。
      return providerUsageSummary();
    case 'queryRequest':
      return readJournalEntry(request.payload.requestId);
    case 'get':
      return requireReadStore().get(request.payload.opId);
    case 'list':
      return requireReadStore().list(request.payload.workspaceId);
    case 'history':
      return requireReadStore().history(request.payload.workspaceId);
    case 'listIncompleteTransactions':
      return requireReadDurableRepository().listIncompleteTransactions();
    case 'listRecoveryPoints':
      return requireReadDurableRepository().listRecoveryPoints();
    case 'planRecoveryCleanup':
      return requireReadDurableRepository().planRecoveryCleanup({
        ...(request.payload.now ? { now: new Date(request.payload.now) } : {}),
        ...(request.payload.maxAgeDays === undefined ? {} : { maxAgeDays: request.payload.maxAgeDays }),
        ...(request.payload.maxBytes === undefined ? {} : { maxBytes: request.payload.maxBytes })
      });
    case 'listAuditEvents':
      return requireReadDurableRepository().listAuditEvents();
    case 'listResourceEntryChanges':
      return requireReadDurableRepository().listResourceEntryChanges(request.payload.opId);
    case 'searchFiles':
      return requireReadWorkspaceDataRepository().searchFiles(
        request.payload.query,
        request.payload.limit
      );
    case 'loadRagChunks':
      assertWorkspaceRequest(request.payload.workspaceId);
      return requireReadWorkspaceDataRepository().loadRagChunks();
    case 'searchRagChunks':
      assertWorkspaceRequest(request.payload.workspaceId);
      return requireReadWorkspaceDataRepository().searchRagChunks(
        request.payload.query,
        request.payload.limit
      );
    case 'loadRagEmbeddings': {
      assertWorkspaceRequest(request.payload.workspaceId);
      const vectors = requireReadWorkspaceDataRepository().loadRagEmbeddings();
      const plain: Record<string, number[]> = {};
      for (const [chunkId, vector] of vectors) plain[chunkId] = Array.from(vector);
      return plain;
    }
    case 'loadRagEmbeddingRecords':
      assertWorkspaceRequest(request.payload.workspaceId);
      return requireReadWorkspaceDataRepository().loadRagEmbeddingRecords().map((record) => ({
        chunkId: record.chunkId,
        model: record.model,
        contentHash: record.contentHash,
        vector: Array.from(record.vector)
      }));
    case 'ragEmbeddingModel':
      assertWorkspaceRequest(request.payload.workspaceId);
      return requireReadWorkspaceDataRepository().ragEmbeddingModel();
    default:
      // READ_ONLY_METHODS 与上面的分支必须一一对应；漏一个就在这里炸，而不是
      // 悄悄退回写队列。
      throw codedError(
        'DATABASE_UTILITY_READ_ROUTE_MISSING',
        `读队列方法 ${String(request.method)} 没有读侧实现。`
      );
  }
}

/**
 * 只读进程打开工作区（#42）。
 *
 * better-sqlite3 是同步 API：长写会在 worker 里同步跑事务，整个 JS 线程被占住，
 * parentPort 上的读消息连接收都做不到。所以"同进程内分队列 + 只读连接"结构上
 * 不可能让读绕过长写——必须让读跑在**另一个进程**里。这个进程只打开只读连接，
 * 不跑迁移、不做 legacy 导入，也拒绝任何写方法（写会撞 SQLITE_READONLY）。
 */
function openReadOnlyWorkspace(payload: OpenWorkspaceDatabasePayload) {
  closeStore();
  openReadView(payload.databasePath, payload.workspaceId);
  if (!readStore || !readDurableRepository || !readWorkspaceDataRepository) {
    throw codedError(
      'DATABASE_UTILITY_READ_VIEW_UNAVAILABLE',
      '只读视图无法打开工作区数据库。'
    );
  }
  store = readStore;
  durableRepository = readDurableRepository;
  workspaceDataRepository = readWorkspaceDataRepository;
  workspaceId = payload.workspaceId;
  workspaceRootPath = payload.rootPath;
  workspaceGame = payload.game;
  return {
    workspaceId,
    readOnly: true as const,
    legacyImport: { status: 'source_missing' as const, recordCount: 0 },
    semanticImport: { status: 'source_missing' as const, nodeCount: 0, edgeCount: 0 }
  };
}

async function openWorkspace(payload: OpenWorkspaceDatabasePayload) {
  if (payload.readOnly === true) return openReadOnlyWorkspace(payload);
  closeStore();
  let nextAppDatabase: SqliteDatabase | null = null;
  let next: SqliteOperationLogStore | null = null;
  try {
    // fallback -> 伴随库的一次性迁移：在打开目标库之前用一致性快照完成。
    // 失败不阻塞打开（目标仍然缺失，下次启动会重试），但必须把结构化原因
    // 带回主进程，不能再像旧实现那样吞掉异常（#40）。
    const migration = payload.migrateFromDatabasePath
      ? migrateWorkspaceDatabaseSnapshot({
          sourceDatabasePath: payload.migrateFromDatabasePath,
          targetDatabasePath: payload.databasePath,
          ...(payload.migrateFingerprintFromPath
            ? {
                fingerprintSourcePath: payload.migrateFingerprintFromPath,
                fingerprintTargetPath: join(dirname(payload.databasePath), 'fingerprint-store.json')
              }
            : {}),
          ...(process.env.SOULFORGE_SQLITE_NATIVE_BINDING
            ? { nativeBinding: process.env.SOULFORGE_SQLITE_NATIVE_BINDING }
            : {})
        })
      : undefined;
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
    workspaceRootPath = payload.rootPath;
    workspaceGame = payload.game;
    openReadView(payload.databasePath, payload.workspaceId);
    return {
      workspaceId,
      ...(migration ? { migration } : {}),
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

/**
 * 打开只读视图（#42）。
 *
 * 只读连接不跑迁移（`readonly: true` 在 openMigratedDatabase 里就是"跳过迁移"），
 * 所以必须等写侧把库建好之后再开；fileMustExist 让"库还不存在"变成显式报错而不是
 * 在磁盘上凭空建一个空库。
 *
 * 打不开的后果是读方法返回 DATABASE_UTILITY_READ_VIEW_UNAVAILABLE，而不是退回写
 * 队列——退回会让"读不被长写阻塞"这条保证静默失效。
 */
function openReadView(databasePath: string, id: string): void {
  closeReadView();
  try {
    readDatabase = openWorkspaceDatabase(databasePath, {
      readonly: true,
      fileMustExist: true,
      ...(process.env.SOULFORGE_SQLITE_NATIVE_BINDING
        ? { nativeBinding: process.env.SOULFORGE_SQLITE_NATIVE_BINDING }
        : {})
    });
    readStore = new SqliteOperationLogStore(readDatabase, id, false);
    readDurableRepository = new DurableWorkspaceRepository(readDatabase, id);
    readWorkspaceDataRepository = new WorkspaceDataRepository(readDatabase, id);
  } catch {
    closeReadView();
  }
}

/**
 * 读连接开不起来时退一步：读队列仍独立于写队列，但复用写连接上的实例。
 *
 * 这一步只有"读不再排在写队列之后"的队列级保证，没有 WAL 快照隔离；比直接抛错
 * 好，因为只读连接打不开通常意味着权限问题，而读写连接此时是能用的。
 */
function requireReadStore(): SqliteOperationLogStore {
  return readStore ?? requireStore();
}

function requireReadDurableRepository(): DurableWorkspaceRepository {
  return readDurableRepository ?? requireDurableRepository();
}

function requireReadWorkspaceDataRepository(): WorkspaceDataRepository {
  return readWorkspaceDataRepository ?? requireWorkspaceDataRepository();
}

function closeReadView(): void {
  readDatabase?.close();
  readDatabase = null;
  readStore = null;
  readDurableRepository = null;
  readWorkspaceDataRepository = null;
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
  closeReadView();
  store?.close();
  appDatabase?.close();
  store = null;
  durableRepository = null;
  workspaceDataRepository = null;
  appDatabase = null;
  appDatabasePath = null;
  workspaceId = null;
  workspaceRootPath = null;
  workspaceGame = null;
}

function assertWorkspaceRequest(requestedWorkspaceId: string): void {
  if (!workspaceId || workspaceId !== requestedWorkspaceId) {
    throw codedError('DATABASE_UTILITY_WORKSPACE_MISMATCH', '数据库后台请求不属于当前工作区。');
  }
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

function methodOrUnknown(value: unknown): string {
  return value && typeof value === 'object' && typeof (value as { method?: unknown }).method === 'string'
    ? (value as { method: string }).method
    : 'unknown';
}

function boundedDuration(value: number): number {
  return boundedTraceNumber(value);
}

function boundedTraceNumber(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.round(value * 100) / 100, 0), 86_400_000);
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
