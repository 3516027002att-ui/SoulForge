import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from './sqliteDatabase.js';
import type { PatchIrOperation } from '@soulforge/shared';

export type TransactionJournalPhase =
  | 'pending'
  | 'staging'
  | 'validating'
  | 'backing_up'
  | 'replacing'
  | 'after_commit_validation'
  | 'marking_committed'
  | 'committed'
  | 'rolling_back'
  | 'rolled_back'
  | 'recovery_required'
  | 'failed';

export interface TransactionJournalRecord<TState = unknown> {
  transactionId: string;
  workspaceId: string;
  opId: string;
  phase: TransactionJournalPhase;
  state: TState;
  createdAt: string;
  updatedAt: string;
}

export interface RecoveryPointRecord<TMetadata = unknown> {
  recoveryId: string;
  workspaceId: string;
  opId?: string;
  rootPath: string;
  sizeBytes: number;
  state: 'active' | 'restored' | 'expired' | 'failed';
  createdAt: string;
  expiresAt?: string;
  metadata: TMetadata;
}

export interface AuditEventRecord<TPayload = unknown> {
  eventId: string;
  workspaceId: string;
  eventKind: string;
  opId?: string;
  transactionId?: string;
  payload: TPayload;
  createdAt: string;
}

export interface ResourceEntryChangeRecord {
  id: string;
  workspaceId: string;
  opId: string;
  resourceUri: string;
  entryUri: string;
  changeKind: string;
  beforeHash?: string;
  afterHash?: string;
  inverse: PatchIrOperation;
}

export interface RecoveryCleanupPlan {
  candidates: Array<RecoveryPointRecord & { reason: 'expired' | 'age' | 'quota' }>;
  protectedRecoveryIds: string[];
  activeBytesBefore: number;
  projectedBytesAfter: number;
  quotaSatisfied: boolean;
}

interface JournalRow {
  transactionId: string;
  workspaceId: string;
  opId: string;
  phase: string;
  stateJson: string;
  createdAt: string;
  updatedAt: string;
}

interface RecoveryRow {
  recoveryId: string;
  workspaceId: string;
  opId: string | null;
  rootPath: string;
  sizeBytes: number;
  state: string;
  createdAt: string;
  expiresAt: string | null;
  metadataJson: string;
}

interface AuditRow {
  eventId: string;
  workspaceId: string;
  eventKind: string;
  opId: string | null;
  transactionId: string | null;
  payloadJson: string;
  createdAt: string;
}

interface ResourceEntryChangeRow {
  id: string;
  workspaceId: string;
  opId: string;
  resourceUri: string;
  entryUri: string;
  changeKind: string;
  beforeHash: string | null;
  afterHash: string | null;
  inverseJson: string;
}

const TERMINAL_PHASES: readonly TransactionJournalPhase[] = ['committed', 'rolled_back', 'failed'];
const PHASES: readonly TransactionJournalPhase[] = [
  'pending', 'staging', 'validating', 'backing_up', 'replacing',
  'after_commit_validation', 'marking_committed', 'committed', 'rolling_back',
  'rolled_back', 'recovery_required', 'failed'
];

/** Durable transaction, recovery, and audit access over one workspace.db connection. */
export class DurableWorkspaceRepository {
  constructor(
    private readonly database: SqliteDatabase,
    readonly workspaceId: string
  ) {}

  createTransaction<TState>(record: Omit<TransactionJournalRecord<TState>, 'workspaceId'>): void {
    this.database.prepare(`
INSERT INTO transaction_journal (
  transaction_id, workspace_id, op_id, phase, state_json, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(
      record.transactionId,
      this.workspaceId,
      record.opId,
      record.phase,
      stringifyJson(record.state, 'transaction state'),
      record.createdAt,
      record.updatedAt
    );
  }

  transitionTransaction<TState>(options: {
    transactionId: string;
    expectedPhase: TransactionJournalPhase | readonly TransactionJournalPhase[];
    nextPhase: TransactionJournalPhase;
    state: TState;
    updatedAt?: string;
  }): TransactionJournalRecord<TState> {
    const expected = Array.isArray(options.expectedPhase)
      ? options.expectedPhase
      : [options.expectedPhase];
    if (expected.length === 0) throw new Error('Expected transaction phase must not be empty.');
    const placeholders = expected.map(() => '?').join(', ');
    const updatedAt = options.updatedAt ?? new Date().toISOString();
    const result = this.database.prepare(`
UPDATE transaction_journal
SET phase = ?, state_json = ?, updated_at = ?
WHERE workspace_id = ? AND transaction_id = ? AND phase IN (${placeholders})
`).run(
      options.nextPhase,
      stringifyJson(options.state, 'transaction state'),
      updatedAt,
      this.workspaceId,
      options.transactionId,
      ...expected
    );
    if (result.changes !== 1) {
      const current = this.getTransaction(options.transactionId);
      throw new Error(
        `Transaction phase conflict for ${options.transactionId}: expected ${expected.join('|')}, actual ${current?.phase ?? 'missing'}.`
      );
    }
    return this.getTransaction<TState>(options.transactionId)!;
  }

  getTransaction<TState = unknown>(transactionId: string): TransactionJournalRecord<TState> | undefined {
    const row = this.database.prepare<[string, string], JournalRow>(`
SELECT transaction_id AS transactionId, workspace_id AS workspaceId, op_id AS opId,
       phase, state_json AS stateJson, created_at AS createdAt, updated_at AS updatedAt
FROM transaction_journal WHERE workspace_id = ? AND transaction_id = ?
`).get(this.workspaceId, transactionId);
    return row ? hydrateJournal<TState>(row) : undefined;
  }

  listIncompleteTransactions(): TransactionJournalRecord[] {
    const placeholders = TERMINAL_PHASES.map(() => '?').join(', ');
    return this.database.prepare<[string, ...TransactionJournalPhase[]], JournalRow>(`
SELECT transaction_id AS transactionId, workspace_id AS workspaceId, op_id AS opId,
       phase, state_json AS stateJson, created_at AS createdAt, updated_at AS updatedAt
FROM transaction_journal
WHERE workspace_id = ? AND phase NOT IN (${placeholders})
ORDER BY created_at, transaction_id
`).all(this.workspaceId, ...TERMINAL_PHASES).map((row) => hydrateJournal(row));
  }

  recordRecoveryPoint<TMetadata>(
    record: Omit<RecoveryPointRecord<TMetadata>, 'workspaceId' | 'recoveryId'> & { recoveryId?: string }
  ): RecoveryPointRecord<TMetadata> {
    const recoveryId = record.recoveryId ?? randomUUID();
    this.database.prepare(`
INSERT INTO recovery_points (
  recovery_id, workspace_id, op_id, root_path, size_bytes, state, created_at, expires_at, metadata_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
      recoveryId, this.workspaceId, record.opId ?? null, record.rootPath, record.sizeBytes,
      record.state, record.createdAt, record.expiresAt ?? null,
      stringifyJson(record.metadata, 'recovery metadata')
    );
    return { ...record, recoveryId, workspaceId: this.workspaceId };
  }

  listRecoveryPoints(): RecoveryPointRecord[] {
    return this.database.prepare<[string], RecoveryRow>(`
SELECT recovery_id AS recoveryId, workspace_id AS workspaceId, op_id AS opId,
       root_path AS rootPath, size_bytes AS sizeBytes, state, created_at AS createdAt,
       expires_at AS expiresAt, metadata_json AS metadataJson
FROM recovery_points WHERE workspace_id = ? ORDER BY created_at DESC, recovery_id
`).all(this.workspaceId).map(hydrateRecovery);
  }

  planRecoveryCleanup(options: {
    now?: Date;
    maxAgeDays?: number;
    maxBytes?: number;
  } = {}): RecoveryCleanupPlan {
    const now = options.now ?? new Date();
    const maxAgeDays = Math.max(0, options.maxAgeDays ?? 30);
    const maxBytes = Math.max(0, options.maxBytes ?? 10 * 1024 * 1024 * 1024);
    const active = this.listRecoveryPoints().filter((item) => item.state === 'active');
    const protectedRows = this.database.prepare<[string], { recoveryId: string }>(`
SELECT DISTINCT rp.recovery_id AS recoveryId
FROM recovery_points rp
LEFT JOIN patch_history ph ON ph.op_id = rp.op_id AND ph.workspace_id = rp.workspace_id
LEFT JOIN transaction_journal tj ON tj.op_id = rp.op_id AND tj.workspace_id = rp.workspace_id
WHERE rp.workspace_id = ? AND rp.state = 'active'
  AND (ph.status = 'recovery_required'
    OR tj.phase NOT IN ('committed', 'rolled_back', 'failed'))
`).all(this.workspaceId);
    const protectedIds = new Set(protectedRows.map((row) => row.recoveryId));
    const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
    const candidates = new Map<string, RecoveryPointRecord & { reason: 'expired' | 'age' | 'quota' }>();
    for (const point of active) {
      if (protectedIds.has(point.recoveryId)) continue;
      const explicitlyExpired = point.expiresAt !== undefined && Date.parse(point.expiresAt) <= now.getTime();
      if (explicitlyExpired || Date.parse(point.createdAt) <= cutoff) {
        candidates.set(point.recoveryId, { ...point, reason: explicitlyExpired ? 'expired' : 'age' });
      }
    }
    const activeBytesBefore = active.reduce((sum, item) => sum + item.sizeBytes, 0);
    let projectedBytesAfter = activeBytesBefore
      - [...candidates.values()].reduce((sum, item) => sum + item.sizeBytes, 0);
    if (projectedBytesAfter > maxBytes) {
      const quotaPool = active
        .filter((item) => !protectedIds.has(item.recoveryId) && !candidates.has(item.recoveryId))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      for (const point of quotaPool) {
        if (projectedBytesAfter <= maxBytes) break;
        candidates.set(point.recoveryId, { ...point, reason: 'quota' });
        projectedBytesAfter -= point.sizeBytes;
      }
    }
    return {
      candidates: [...candidates.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      protectedRecoveryIds: [...protectedIds].sort(),
      activeBytesBefore,
      projectedBytesAfter,
      quotaSatisfied: projectedBytesAfter <= maxBytes
    };
  }

  markRecoveryPointExpired(recoveryId: string): void {
    const result = this.database.prepare(`
UPDATE recovery_points SET state = 'expired'
WHERE workspace_id = ? AND recovery_id = ? AND state = 'active'
`).run(this.workspaceId, recoveryId);
    if (result.changes !== 1) throw new Error(`Active recovery point not found: ${recoveryId}.`);
  }

  appendAuditEvent<TPayload>(
    event: Omit<AuditEventRecord<TPayload>, 'workspaceId' | 'eventId'> & { eventId?: string }
  ): AuditEventRecord<TPayload> {
    const eventId = event.eventId ?? randomUUID();
    this.database.prepare(`
INSERT INTO audit_events (
  event_id, workspace_id, event_kind, op_id, transaction_id, payload_json, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(
      eventId, this.workspaceId, event.eventKind, event.opId ?? null,
      event.transactionId ?? null, stringifyJson(event.payload, 'audit payload'), event.createdAt
    );
    return { ...event, eventId, workspaceId: this.workspaceId };
  }

  listAuditEvents(): AuditEventRecord[] {
    return this.database.prepare<[string], AuditRow>(`
SELECT event_id AS eventId, workspace_id AS workspaceId, event_kind AS eventKind,
       op_id AS opId, transaction_id AS transactionId, payload_json AS payloadJson,
       created_at AS createdAt
FROM audit_events WHERE workspace_id = ? ORDER BY created_at, event_id
`).all(this.workspaceId).map(hydrateAudit);
  }


  recordResourceEntryChange(record: Omit<ResourceEntryChangeRecord, 'workspaceId'>): void {
    assertInverseOperation(record.inverse);
    this.database.prepare(`
INSERT INTO resource_entry_changes (
  id, op_id, workspace_id, resource_uri, entry_uri, change_kind,
  before_hash, after_hash, inverse_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
      record.id, record.opId, this.workspaceId, record.resourceUri, record.entryUri,
      record.changeKind, record.beforeHash ?? null, record.afterHash ?? null,
      stringifyJson(record.inverse, 'resource entry inverse operation')
    );
  }

  listResourceEntryChanges(opId: string): ResourceEntryChangeRecord[] {
    return this.database.prepare<[string, string], ResourceEntryChangeRow>(`
SELECT id, workspace_id AS workspaceId, op_id AS opId, resource_uri AS resourceUri,
       entry_uri AS entryUri, change_kind AS changeKind, before_hash AS beforeHash,
       after_hash AS afterHash, inverse_json AS inverseJson
FROM resource_entry_changes WHERE workspace_id = ? AND op_id = ? ORDER BY id
`).all(this.workspaceId, opId).map((row) => {
      const inverse = parseJson<PatchIrOperation>(row.inverseJson, 'resource entry inverse operation');
      assertInverseOperation(inverse);
      return {
        id: row.id, workspaceId: row.workspaceId, opId: row.opId,
        resourceUri: row.resourceUri, entryUri: row.entryUri, changeKind: row.changeKind,
        ...(row.beforeHash ? { beforeHash: row.beforeHash } : {}),
        ...(row.afterHash ? { afterHash: row.afterHash } : {}), inverse
      };
    });
  }
}

function hydrateJournal<TState>(row: JournalRow): TransactionJournalRecord<TState> {
  return {
    transactionId: row.transactionId,
    workspaceId: row.workspaceId,
    opId: row.opId,
    phase: assertValue(row.phase, PHASES, 'transaction phase'),
    state: parseJson<TState>(row.stateJson, 'transaction state'),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function hydrateRecovery(row: RecoveryRow): RecoveryPointRecord {
  return {
    recoveryId: row.recoveryId, workspaceId: row.workspaceId,
    ...(row.opId ? { opId: row.opId } : {}), rootPath: row.rootPath,
    sizeBytes: row.sizeBytes,
    state: assertValue(row.state, ['active', 'restored', 'expired', 'failed'] as const, 'recovery state'),
    createdAt: row.createdAt, ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
    metadata: parseJson(row.metadataJson, 'recovery metadata')
  };
}

function hydrateAudit(row: AuditRow): AuditEventRecord {
  return {
    eventId: row.eventId, workspaceId: row.workspaceId, eventKind: row.eventKind,
    ...(row.opId ? { opId: row.opId } : {}),
    ...(row.transactionId ? { transactionId: row.transactionId } : {}),
    payload: parseJson(row.payloadJson, 'audit payload'), createdAt: row.createdAt
  };
}

function stringifyJson(value: unknown, label: string): string {
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error(`${label} must be JSON serializable.`);
  return result;
}

function parseJson<T>(value: string, label: string): T {
  try { return JSON.parse(value) as T; }
  catch (error) { throw new Error(`Corrupt ${label}: ${error instanceof Error ? error.message : String(error)}`); }
}

function assertValue<const T extends readonly string[]>(value: string, allowed: T, label: string): T[number] {
  if ((allowed as readonly string[]).includes(value)) return value as T[number];
  throw new Error(`Invalid ${label}: ${value}.`);
}

function assertInverseOperation(value: unknown): asserts value is PatchIrOperation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Resource entry inverse operation must be an object.');
  }
  const operation = value as Record<string, unknown>;
  for (const field of ['id', 'kind', 'targetUri']) {
    if (typeof operation[field] !== 'string' || operation[field] === '') {
      throw new Error(`Resource entry inverse operation is missing ${field}.`);
    }
  }
  if (!Array.isArray(operation.preconditions) || !Array.isArray(operation.validatorRequirements)) {
    throw new Error('Resource entry inverse operation is missing validation metadata.');
  }
}
