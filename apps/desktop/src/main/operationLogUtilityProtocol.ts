import type {
  OperationLogRecord,
  OperationStatus,
  PatchHistoryEntry,
  IndexedFile,
  RagChunk,
  ReferenceEdge
} from '@soulforge/shared';
import type {
  AuditEventRecord,
  RecoveryPointRecord,
  RecoveryCleanupPlan,
  ResourceEntryChangeRecord,
  BackgroundJobRecord,
  PersistedDiagnostic,
  TransactionJournalPhase,
  TransactionJournalRecord,
  OperationLogStore,
  RagChunkDeltaStats,
  KnowledgeStoreSnapshot
} from '@soulforge/core';

export const OPERATION_LOG_UTILITY_PROTOCOL = '1.6.0' as const;

export interface ProviderUsageEventPayload {
  eventId: string;
  sessionId: string;
  serviceId: string;
  protocol: string;
  model: string;
  callIndex: number;
  inputTokens?: number;
  outputTokens?: number;
  currentContextTokens: number;
  contextSource: 'provider' | 'estimated';
  providerReported: boolean;
  recordedAt: string;
}

export interface ProviderUsageAggregate {
  serviceId: string;
  protocol: string;
  model: string;
  calls: number;
  reportedCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  firstUsedAt: string | null;
  lastUsedAt: string | null;
}

export interface ProviderUsageSessionSummary extends ProviderUsageAggregate {
  sessionId: string;
  lastCallIndex: number;
  currentContextTokens: number;
  contextSource: 'provider' | 'estimated';
}

export interface ProviderUsageSummary {
  calls: number;
  reportedCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  firstUsedAt: string | null;
  lastUsedAt: string | null;
  byService: ProviderUsageAggregate[];
  latestSession: ProviderUsageSessionSummary | null;
}

export interface OpenWorkspaceDatabasePayload {
  migrationSourceDatabasePath?: string;
  appDatabasePath: string;
  databasePath: string;
  workspaceId: string;
  rootPath: string;
  game: string;
  legacyOperationLogPath: string;
  legacyBackupDirectory: string;
  legacySemanticSnapshotPath: string;
  legacySemanticBackupDirectory: string;
}

export interface OperationLogUtilityPayloadMap {
  openAppDatabase: { appDatabasePath: string };
  openWorkspace: OpenWorkspaceDatabasePayload;
  recordProviderUsage: { event: ProviderUsageEventPayload };
  providerUsageSummary: Record<string, never>;
  record: { entry: OperationLogRecord };
  get: { opId: string };
  list: { workspaceId?: string };
  updateStatus: {
      opId: string;
      status: OperationStatus;
      patch?: Partial<OperationLogRecord>;
  };
  history: { workspaceId?: string };
  createTransaction: { record: Omit<TransactionJournalRecord, 'workspaceId'> };
  transitionTransaction: {
    transactionId: string;
    expectedPhase: TransactionJournalPhase | TransactionJournalPhase[];
    nextPhase: TransactionJournalPhase;
    state: unknown;
    updatedAt?: string;
  };
  listIncompleteTransactions: Record<string, never>;
  getTransactionForOperation: { opId: string };
  findTransactionsForRequest: { sessionName: string; requestId: string };
  recordRecoveryPoint: { record: Omit<RecoveryPointRecord, 'workspaceId' | 'recoveryId'> & { recoveryId?: string } };
  listRecoveryPoints: Record<string, never>;
  planRecoveryCleanup: { now?: string; maxAgeDays?: number; maxBytes?: number };
  markRecoveryPointExpired: { recoveryId: string };
  appendAuditEvent: { event: Omit<AuditEventRecord, 'workspaceId' | 'eventId'> & { eventId?: string } };
  listAuditEvents: Record<string, never>;
  recordResourceEntryChange: { record: Omit<ResourceEntryChangeRecord, 'workspaceId'> };
  listResourceEntryChanges: { opId: string };
  finalizeCommit: { bundle: Parameters<NonNullable<OperationLogStore['finalizeCommit']>>[0] };
  replaceFiles: { files: IndexedFile[] };
  searchFiles: { query: string; limit?: number };
  replaceRagChunks: { workspaceId: string; chunks: RagChunk[] };
  mergeRagChunks: { workspaceId: string; chunks: RagChunk[] };
  mergeRagChunkDelta: {
    workspaceId: string;
    sourceUri: string;
    upserts: RagChunk[];
    deletedChunkIds: string[];
  };
  loadRagChunks: { workspaceId: string };
  searchRagChunks: { workspaceId: string; query: string; limit?: number };
  replaceRagEmbeddings: { workspaceId: string; entries: Array<{ chunkId: string; model: string; vector: Float32Array }> };
  mergeRagEmbeddings: {
    workspaceId: string;
    model: string;
    entries: Array<{ chunkId: string; contentHash: string; vector: Float32Array }>;
    deletedChunkIds: string[];
  };
  loadRagEmbeddings: { workspaceId: string };
  loadRagEmbeddingRecords: { workspaceId: string };
  ragEmbeddingModel: { workspaceId: string };
  replaceReferences: { workspaceId: string; references: ReferenceEdge[] };
  loadReferences: { workspaceId: string };
  replaceDiagnostics: { diagnostics: Array<Omit<PersistedDiagnostic, 'workspaceId'>> };
  listDiagnostics: Record<string, never>;
  upsertJob: { workspaceId: string; job: Omit<BackgroundJobRecord, 'workspaceId'> };
  listJobs: Record<string, never>;
  getSemanticFileCache: { relativePath: string };
  getAllSemanticFileCache: Record<string, never>;
  upsertSemanticFileCache: {
    entry: {
      relativePath: string;
      fileSha256: string;
      resourceKind: string;
      payloadJson: string;
      mtimeMs: number;
    };
  };
  loadKnowledgeSnapshot: { workspaceId: string; rootPath: string; game: string };
  health: Record<string, never>;
  close: Record<string, never>;
}

export type OperationLogUtilityRequest = {
  [Method in keyof OperationLogUtilityPayloadMap]: request<
    Method,
    OperationLogUtilityPayloadMap[Method]
  >
}[keyof OperationLogUtilityPayloadMap];

export interface OperationLogUtilityResponse {
  protocolVersion: typeof OPERATION_LOG_UTILITY_PROTOCOL;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface OperationLogUtilityResultMap {
  openAppDatabase: { appReady: true };
  openWorkspace: {
    workspaceId: string;
    legacyImport: {
      status: 'imported' | 'already_imported' | 'source_missing';
      recordCount: number;
      backupPath?: string;
    };
    semanticImport: {
      status: 'archived' | 'already_imported' | 'source_missing';
      nodeCount: number;
      edgeCount: number;
      backupPath?: string;
    };
  };
  recordProviderUsage: null;
  providerUsageSummary: ProviderUsageSummary;
  record: null;
  get: OperationLogRecord | undefined;
  list: OperationLogRecord[];
  updateStatus: OperationLogRecord | undefined;
  history: PatchHistoryEntry[];
  createTransaction: null;
  transitionTransaction: TransactionJournalRecord;
  listIncompleteTransactions: TransactionJournalRecord[];
  getTransactionForOperation: TransactionJournalRecord | undefined;
  findTransactionsForRequest: TransactionJournalRecord[];
  recordRecoveryPoint: RecoveryPointRecord;
  listRecoveryPoints: RecoveryPointRecord[];
  planRecoveryCleanup: RecoveryCleanupPlan;
  markRecoveryPointExpired: null;
  appendAuditEvent: AuditEventRecord;
  listAuditEvents: AuditEventRecord[];
  recordResourceEntryChange: null;
  listResourceEntryChanges: ResourceEntryChangeRecord[];
  finalizeCommit: null;
  replaceFiles: null;
  searchFiles: IndexedFile[];
  replaceRagChunks: null;
  mergeRagChunks: null;
  mergeRagChunkDelta: RagChunkDeltaStats | null;
  loadRagChunks: RagChunk[];
  searchRagChunks: RagChunk[];
  replaceRagEmbeddings: null;
  mergeRagEmbeddings: null;
  loadRagEmbeddings: Record<string, number[]>;
  loadRagEmbeddingRecords: Array<{ chunkId: string; model: string; contentHash: string | null; vector: number[] }>;
  ragEmbeddingModel: string | null;
  replaceReferences: null;
  loadReferences: ReferenceEdge[];
  replaceDiagnostics: null;
  listDiagnostics: PersistedDiagnostic[];
  upsertJob: null;
  listJobs: BackgroundJobRecord[];
  getSemanticFileCache: {
    relativePath: string;
    fileSha256: string;
    resourceKind: string;
    payloadJson: string;
    mtimeMs: number;
    updatedAt: string;
  } | null;
  getAllSemanticFileCache: {
    entries: Array<{
      relativePath: string;
      fileSha256: string;
      resourceKind: string;
      payloadJson: string;
      mtimeMs: number;
      updatedAt: string;
    }>;
  };
  upsertSemanticFileCache: null;
  loadKnowledgeSnapshot: KnowledgeStoreSnapshot | null;
  health: { ready: boolean; appReady: boolean; workspaceId?: string };
  close: null;
}

export type OperationLogUtilityMethod = keyof OperationLogUtilityResultMap;

type request<Method extends string, Payload> = {
  protocolVersion: typeof OPERATION_LOG_UTILITY_PROTOCOL;
  requestId: string;
  method: Method;
  payload: Payload;
  /** A queued request must not begin after its caller's deadline. */
  deadlineAt?: number;
};

/** Only these RPCs may execute on the independent, read-only connection. */
export function isDatabaseReadMethod(method: string): boolean {
  return [
    'get', 'list', 'history', 'getTransactionForOperation', 'findTransactionsForRequest', 'listIncompleteTransactions',
    'listRecoveryPoints', 'planRecoveryCleanup', 'listAuditEvents', 'listResourceEntryChanges',
    'searchFiles', 'loadRagChunks', 'searchRagChunks', 'loadRagEmbeddings',
    'loadRagEmbeddingRecords', 'ragEmbeddingModel', 'loadReferences', 'listDiagnostics',
    'listJobs', 'getSemanticFileCache', 'getAllSemanticFileCache', 'loadKnowledgeSnapshot',
    'providerUsageSummary', 'health'
  ].includes(method);
}

export function isOperationLogUtilityResponse(value: unknown): value is OperationLogUtilityResponse {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<OperationLogUtilityResponse>;
  return candidate.protocolVersion === OPERATION_LOG_UTILITY_PROTOCOL
    && typeof candidate.requestId === 'string'
    && typeof candidate.ok === 'boolean';
}
