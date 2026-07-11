import type {
  OperationLogRecord,
  OperationStatus,
  PatchHistoryEntry,
  IndexedFile
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
  OperationLogStore
} from '@soulforge/core';

export const OPERATION_LOG_UTILITY_PROTOCOL = '1.1.0' as const;

export interface OpenWorkspaceDatabasePayload {
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
  openWorkspace: OpenWorkspaceDatabasePayload;
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
  replaceDiagnostics: { diagnostics: Array<Omit<PersistedDiagnostic, 'workspaceId'>> };
  listDiagnostics: Record<string, never>;
  upsertJob: { job: Omit<BackgroundJobRecord, 'workspaceId'> };
  listJobs: Record<string, never>;
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
  openWorkspace: {
    workspaceId: string;
    legacyImport: {
      status: 'imported' | 'already_imported' | 'source_missing';
      recordCount: number;
      backupPath?: string;
    };
    semanticImport: {
      status: 'imported' | 'already_imported' | 'source_missing';
      nodeCount: number;
      edgeCount: number;
      backupPath?: string;
    };
  };
  record: null;
  get: OperationLogRecord | undefined;
  list: OperationLogRecord[];
  updateStatus: OperationLogRecord | undefined;
  history: PatchHistoryEntry[];
  createTransaction: null;
  transitionTransaction: TransactionJournalRecord;
  listIncompleteTransactions: TransactionJournalRecord[];
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
  replaceDiagnostics: null;
  listDiagnostics: PersistedDiagnostic[];
  upsertJob: null;
  listJobs: BackgroundJobRecord[];
  health: { ready: boolean; appReady: boolean; workspaceId?: string };
  close: null;
}

export type OperationLogUtilityMethod = keyof OperationLogUtilityResultMap;

type request<Method extends string, Payload> = {
  protocolVersion: typeof OPERATION_LOG_UTILITY_PROTOCOL;
  requestId: string;
  method: Method;
  payload: Payload;
};

export function isOperationLogUtilityResponse(value: unknown): value is OperationLogUtilityResponse {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<OperationLogUtilityResponse>;
  return candidate.protocolVersion === OPERATION_LOG_UTILITY_PROTOCOL
    && typeof candidate.requestId === 'string'
    && typeof candidate.ok === 'boolean';
}
