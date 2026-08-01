/**
 * Journal-wired operation-log store for recovery smokes.
 *
 * The plain SQLite operation-log store delegates the optional durable journal
 * methods (`createTransaction` / `transitionTransaction` /
 * `recordRecoveryPoint` / `appendAuditEvent`) to `DurableWorkspaceRepository`
 * and lets `finalizeCommit` run the atomic bundle. This mirrors what the
 * desktop main process wires through `operationLogUtilityClient`, so
 * `executePatchIrThroughTransaction` can drive the full
 * pending -> staging -> validating -> backing_up -> replacing ->
 * marking_committed -> committed phase machine over a real workspace.db.
 */

import type {
  OperationLogRecord,
  OperationStatus,
  PatchHistoryEntry
} from '@soulforge/shared';
import type { OperationLogStore } from '../patch/operationLog.js';
import { SqliteOperationLogStore } from '../patch/sqliteOperationLogStore.js';
import {
  DurableWorkspaceRepository,
  type AuditEventRecord,
  type RecoveryPointRecord,
  type ResourceEntryChangeRecord,
  type TransactionJournalPhase,
  type TransactionJournalRecord
} from '../storage/durableWorkspaceRepository.js';
import { openWorkspaceDatabase } from '../storage/sqliteDatabase.js';

export class JournalWiringStore implements OperationLogStore {
  constructor(
    private readonly delegate: SqliteOperationLogStore,
    readonly repository: DurableWorkspaceRepository
  ) {}

  record(entry: OperationLogRecord): Promise<void> {
    return this.delegate.record(entry);
  }
  get(opId: string): Promise<OperationLogRecord | undefined> {
    return this.delegate.get(opId);
  }
  list(workspaceId?: string): Promise<OperationLogRecord[]> {
    return this.delegate.list(workspaceId);
  }
  updateStatus(
    opId: string,
    status: OperationStatus,
    patch?: Partial<OperationLogRecord>
  ): Promise<OperationLogRecord | undefined> {
    return this.delegate.updateStatus(opId, status, patch);
  }
  history(workspaceId?: string): Promise<PatchHistoryEntry[]> {
    return this.delegate.history(workspaceId);
  }
  recordResourceEntryChange(record: Omit<ResourceEntryChangeRecord, 'workspaceId'>): Promise<unknown> {
    return this.delegate.recordResourceEntryChange(record);
  }
  listResourceEntryChanges(opId: string): Promise<ResourceEntryChangeRecord[]> {
    return this.delegate.listResourceEntryChanges(opId);
  }
  createTransaction(record: Omit<TransactionJournalRecord, 'workspaceId'>): Promise<unknown> {
    this.repository.createTransaction(record);
    return Promise.resolve(null);
  }
  transitionTransaction(options: {
    transactionId: string;
    expectedPhase: TransactionJournalPhase | TransactionJournalPhase[];
    nextPhase: TransactionJournalPhase;
    state: unknown;
    updatedAt?: string;
  }): Promise<TransactionJournalRecord> {
    return Promise.resolve(this.repository.transitionTransaction(options));
  }
  recordRecoveryPoint(
    record: Omit<RecoveryPointRecord, 'workspaceId' | 'recoveryId'> & { recoveryId?: string }
  ): Promise<RecoveryPointRecord> {
    return Promise.resolve(this.repository.recordRecoveryPoint(record));
  }
  appendAuditEvent(
    event: Omit<AuditEventRecord, 'workspaceId' | 'eventId'> & { eventId?: string }
  ): Promise<AuditEventRecord> {
    return Promise.resolve(this.repository.appendAuditEvent(event));
  }
  finalizeCommit(bundle: {
    operation: OperationLogRecord;
    resourceEntryChanges: Array<Omit<ResourceEntryChangeRecord, 'workspaceId'>>;
    recoveryPoint: Omit<RecoveryPointRecord, 'workspaceId'>;
    auditEvent: Omit<AuditEventRecord, 'workspaceId'>;
    transactionId: string;
    expectedPhase: TransactionJournalPhase;
    finalState: unknown;
  }): Promise<void> {
    return this.delegate.finalizeCommit(bundle);
  }

  /** Close the underlying database (session boundary). */
  close(): void {
    this.delegate.close();
  }
}

/** Open a workspace database and ensure the workspace row exists. */
export function openSessionStore(
  databasePath: string,
  workspaceId: string,
  overlayRoot: string
): {
  database: ReturnType<typeof openWorkspaceDatabase>;
  store: JournalWiringStore;
  repository: DurableWorkspaceRepository;
} {
  const database = openWorkspaceDatabase(databasePath);
  const now = new Date().toISOString();
  database.prepare(`
INSERT INTO workspaces (workspace_id, root_path, game, created_at, updated_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(workspace_id) DO UPDATE SET
  root_path = excluded.root_path,
  game = excluded.game,
  updated_at = excluded.updated_at
`).run(workspaceId, overlayRoot, 'sekiro', now, now);
  const delegate = new SqliteOperationLogStore(database, workspaceId, true);
  const repository = new DurableWorkspaceRepository(database, workspaceId);
  return { database, store: new JournalWiringStore(delegate, repository), repository };
}
