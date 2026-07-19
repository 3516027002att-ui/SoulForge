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
  OperationLogStore,
  AppModelServiceRecord,
  AppPermissionGrant,
  RecordAgentRunInput,
  RetentionCleanupResult,
  AiHistoryRetentionMode,
  StoredAgentPermissionMode,
  StoredAgentRunDetail,
  StoredAgentRunSummary
} from '@soulforge/core';

export const OPERATION_LOG_UTILITY_PROTOCOL = '1.3.0' as const;

export interface OpenAppDatabasePayload {
  appDatabasePath: string;
}

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
  openApp: OpenAppDatabasePayload;
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
  listModelServices: Record<string, never>;
  getModelService: { serviceId: string; includeDeleted?: boolean };
  upsertModelService: { record: AppModelServiceRecord };
  importModelServices: { records: AppModelServiceRecord[] };
  softDeleteModelService: { serviceId: string; deletedAt?: string };
  replacePermissionGrant: { grant: AppPermissionGrant };
  getActivePermissionGrant: {
    serviceId: string;
    permissionMode: AppPermissionGrant['permissionMode'] | StoredAgentPermissionMode;
    policyVersion: string;
  };
  revokePermissionGrant: { grantId: string; revokedAt?: string };
  recordAgentRun: { input: RecordAgentRunInput };
  getAgentRun: { runId: string };
  listAgentRuns: { workspaceKey?: string; serviceId?: string; limit?: number };
  cleanupExpiredAiHistory: { now?: string };
  getAiHistoryRetentionMode: Record<string, never>;
  setAiHistoryRetentionMode: { mode: AiHistoryRetentionMode };
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
  openApp: { appReady: true };
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
  listModelServices: AppModelServiceRecord[];
  getModelService: AppModelServiceRecord | undefined;
  upsertModelService: AppModelServiceRecord;
  importModelServices: { imported: number };
  softDeleteModelService: null;
  replacePermissionGrant: AppPermissionGrant;
  getActivePermissionGrant: AppPermissionGrant | undefined;
  revokePermissionGrant: null;
  recordAgentRun: { runId: string; conversationId: string };
  getAgentRun: StoredAgentRunDetail | null;
  listAgentRuns: StoredAgentRunSummary[];
  cleanupExpiredAiHistory: RetentionCleanupResult;
  getAiHistoryRetentionMode: { mode: AiHistoryRetentionMode };
  setAiHistoryRetentionMode: { mode: AiHistoryRetentionMode; updatedAt: string };
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
