import type {
  Diagnostic,
  FileOperationRecord,
  OperationLogRecord,
  OperationStatus,
  PatchHistoryEntry,
  PatchMode,
  PatchProposal
} from '@soulforge/shared';
import type {
  AuditEventRecord,
  RecoveryPointRecord,
  ResourceEntryChangeRecord,
  TransactionJournalPhase,
  TransactionJournalRecord
} from '../storage/durableWorkspaceRepository.js';
import type { GraphPatch } from '@soulforge/shared';

export interface RecordCommittedOperationInput {
  proposal: PatchProposal;
  backupRoot: string;
  files: FileOperationRecord[];
  diagnostics: Diagnostic[];
  graph?: GraphPatch;
}

export interface OperationLogStore {
  record(entry: OperationLogRecord): Promise<void>;
  get(opId: string): Promise<OperationLogRecord | undefined>;
  list(workspaceId?: string): Promise<OperationLogRecord[]>;
  updateStatus(
    opId: string,
    status: OperationStatus,
    patch?: Partial<OperationLogRecord>
  ): Promise<OperationLogRecord | undefined>;
  history(workspaceId?: string): Promise<PatchHistoryEntry[]>;
  /** Optional durable journal capabilities supplied by the desktop database utility. */
  createTransaction?(record: Omit<TransactionJournalRecord, 'workspaceId'>): Promise<unknown>;
  transitionTransaction?(options: {
    transactionId: string;
    expectedPhase: TransactionJournalPhase | TransactionJournalPhase[];
    nextPhase: TransactionJournalPhase;
    state: unknown;
    updatedAt?: string;
  }): Promise<TransactionJournalRecord>;
  recordRecoveryPoint?(
    record: Omit<RecoveryPointRecord, 'workspaceId' | 'recoveryId'> & { recoveryId?: string }
  ): Promise<RecoveryPointRecord>;
  appendAuditEvent?(
    event: Omit<AuditEventRecord, 'workspaceId' | 'eventId'> & { eventId?: string }
  ): Promise<AuditEventRecord>;
  recordResourceEntryChange?(record: Omit<ResourceEntryChangeRecord, 'workspaceId'>): Promise<unknown>;
  listResourceEntryChanges?(opId: string): Promise<ResourceEntryChangeRecord[]>;
  finalizeCommit?(bundle: {
    operation: OperationLogRecord;
    resourceEntryChanges: Array<Omit<ResourceEntryChangeRecord, 'workspaceId'>>;
    recoveryPoint: Omit<RecoveryPointRecord, 'workspaceId'>;
    auditEvent: Omit<AuditEventRecord, 'workspaceId'>;
    transactionId: string;
    expectedPhase: TransactionJournalPhase;
    finalState: unknown;
  }): Promise<void>;
}

/**
 * In-memory operation log used until the desktop main process wires SQLite.
 * Semantics match the v0.5 operation / file rollback model.
 */
export class MemoryOperationLogStore implements OperationLogStore {
  private readonly byId = new Map<string, OperationLogRecord>();
  private readonly resourceEntryChanges = new Map<string, ResourceEntryChangeRecord[]>();

  async record(entry: OperationLogRecord): Promise<void> {
    this.byId.set(entry.opId, cloneRecord(entry));
  }

  async get(opId: string): Promise<OperationLogRecord | undefined> {
    const entry = this.byId.get(opId);
    return entry ? cloneRecord(entry) : undefined;
  }

  async list(workspaceId?: string): Promise<OperationLogRecord[]> {
    const rows = [...this.byId.values()]
      .filter((entry) => !workspaceId || entry.workspaceId === workspaceId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return rows.map(cloneRecord);
  }

  async updateStatus(
    opId: string,
    status: OperationStatus,
    patch: Partial<OperationLogRecord> = {}
  ): Promise<OperationLogRecord | undefined> {
    const existing = this.byId.get(opId);
    if (!existing) return undefined;
    const next: OperationLogRecord = {
      ...existing,
      ...patch,
      status,
      diagnostics: patch.diagnostics ?? existing.diagnostics,
      files: patch.files ?? existing.files
    };
    this.byId.set(opId, next);
    return cloneRecord(next);
  }

  async recordResourceEntryChange(record: Omit<ResourceEntryChangeRecord, 'workspaceId'>): Promise<void> {
    const operation = this.byId.get(record.opId);
    if (!operation) throw new Error(`Operation not found for resource entry change: ${record.opId}.`);
    const existing = this.resourceEntryChanges.get(record.opId) ?? [];
    if (existing.some((item) => item.id === record.id)) throw new Error(`Duplicate resource entry change: ${record.id}.`);
    existing.push(structuredClone({ ...record, workspaceId: operation.workspaceId }));
    this.resourceEntryChanges.set(record.opId, existing);
  }

  async listResourceEntryChanges(opId: string): Promise<ResourceEntryChangeRecord[]> {
    return structuredClone(this.resourceEntryChanges.get(opId) ?? []);
  }

  async history(workspaceId?: string): Promise<PatchHistoryEntry[]> {
    return (await this.list(workspaceId)).map(toHistoryEntry);
  }
}

const defaultStore = new MemoryOperationLogStore();

export function getDefaultOperationLogStore(): MemoryOperationLogStore {
  return defaultStore;
}

export function toHistoryEntry(entry: OperationLogRecord): PatchHistoryEntry {
  return {
    opId: entry.opId,
    workspaceId: entry.workspaceId,
    title: entry.title,
    author: entry.author,
    mode: entry.mode,
    status: entry.status,
    createdAt: entry.createdAt,
    ...(entry.committedAt ? { committedAt: entry.committedAt } : {}),
    ...(entry.rolledBackAt ? { rolledBackAt: entry.rolledBackAt } : {}),
    fileCount: entry.files.length,
    changedPaths: entry.files.map((file) => file.targetPath),
    ...(entry.inverseOfOpId ? { inverseOfOpId: entry.inverseOfOpId } : {}),
    ...(entry.rollbackScope ? { rollbackScope: entry.rollbackScope } : {}),
    ...(entry.rollbackTargetUri ? { rollbackTargetUri: entry.rollbackTargetUri } : {}),
    ...(entry.graph
      ? {
          graphSummary: {
            title: entry.graph.title,
            fileCount: entry.graph.summary.fileCount,
            resourceCount: entry.graph.summary.resourceCount,
            edgeCount: entry.graph.summary.edgeCount
          }
        }
      : {})
  };
}

export function createCommittedOperationRecord(input: RecordCommittedOperationInput): OperationLogRecord {
  const now = new Date().toISOString();
  return {
    opId: input.proposal.opId,
    workspaceId: input.proposal.workspaceId,
    title: input.proposal.title,
    author: input.proposal.author,
    mode: input.proposal.mode,
    status: 'committed',
    createdAt: input.proposal.createdAt,
    committedAt: now,
    backupRoot: input.backupRoot,
    files: input.files,
    diagnostics: input.diagnostics,
    ...(input.graph ? { graph: input.graph } : input.proposal.graph ? { graph: input.proposal.graph } : {})
  };
}

export function createPlannedOperationRecord(
  proposal: PatchProposal,
  status: OperationStatus = 'planned',
  diagnostics: Diagnostic[] = []
): OperationLogRecord {
  return {
    opId: proposal.opId,
    workspaceId: proposal.workspaceId,
    title: proposal.title,
    author: proposal.author,
    mode: proposal.mode as PatchMode,
    status,
    createdAt: proposal.createdAt,
    files: [],
    diagnostics,
    ...(proposal.graph ? { graph: proposal.graph } : {})
  };
}

function cloneRecord(entry: OperationLogRecord): OperationLogRecord {
  return {
    ...entry,
    files: entry.files.map((file) => ({ ...file })),
    diagnostics: entry.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    ...(entry.graph
      ? {
          graph: {
            ...entry.graph,
            nodes: entry.graph.nodes.map((node) => ({ ...node })),
            edges: entry.graph.edges.map((edge) => ({ ...edge })),
            summary: { ...entry.graph.summary }
          }
        }
      : {})
  };
}
