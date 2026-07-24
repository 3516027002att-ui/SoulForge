import { isAbsolute } from 'node:path';
import type { Diagnostic } from '@soulforge/shared';
import {
  type PersistedRuntimeLaunchState,
  type RuntimeLaunchRecord,
  type RuntimeLaunchSessionStore,
  type RuntimeVerificationKind
} from '../runtime/runtimeSessionStore.js';
import {
  assertRuntimeVerificationEvidence,
  type RuntimeVerificationEvidence,
  type RuntimeVerificationEvidenceKind,
  type RuntimeVerificationEvidenceStore,
  type RuntimeOperatorVerdict
} from '../runtime/runtimeVerification.js';
import type { SqliteDatabase } from './sqliteDatabase.js';

export interface RuntimeAdapterSetting {
  adapterId: string;
  executablePath: string;
  confirmedAt: string;
  updatedAt: string;
}

export class RuntimeAdapterSettingsRepository {
  constructor(private readonly database: SqliteDatabase) {}

  upsert(setting: RuntimeAdapterSetting): void {
    assertRuntimeAdapterSetting(setting);
    this.database.prepare(`
INSERT INTO runtime_adapter_settings (
  adapter_id, executable_path, confirmed_at, updated_at
) VALUES (?, ?, ?, ?)
ON CONFLICT(adapter_id) DO UPDATE SET
  executable_path=excluded.executable_path,
  confirmed_at=excluded.confirmed_at,
  updated_at=excluded.updated_at
`).run(setting.adapterId, setting.executablePath, setting.confirmedAt, setting.updatedAt);
  }

  get(adapterId: string): RuntimeAdapterSetting | undefined {
    const row = this.database.prepare<[string], Record<string, unknown>>(`
SELECT adapter_id AS adapterId, executable_path AS executablePath,
  confirmed_at AS confirmedAt, updated_at AS updatedAt
FROM runtime_adapter_settings
WHERE adapter_id = ?
`).get(adapterId);
    return row ? hydrateRuntimeAdapterSetting(row) : undefined;
  }

  list(): RuntimeAdapterSetting[] {
    const rows = this.database.prepare<[], Record<string, unknown>>(`
SELECT adapter_id AS adapterId, executable_path AS executablePath,
  confirmed_at AS confirmedAt, updated_at AS updatedAt
FROM runtime_adapter_settings
ORDER BY adapter_id
`).all();
    return rows.map(hydrateRuntimeAdapterSetting);
  }

  delete(adapterId: string): boolean {
    return this.database.prepare('DELETE FROM runtime_adapter_settings WHERE adapter_id = ?')
      .run(adapterId).changes > 0;
  }
}

export class RuntimeLaunchSessionRepository implements RuntimeLaunchSessionStore {
  constructor(private readonly database: SqliteDatabase, readonly workspaceId: string) {}

  upsertRuntimeSession(record: RuntimeLaunchRecord): void {
    this.assertWorkspace(record.workspaceId);
    assertRuntimeLaunchRecord(record);
    this.database.prepare(`
INSERT INTO runtime_launch_sessions (
  session_id, workspace_id, adapter_id, profile_id, profile_path,
  operation_id, related_operation_id, verification_kind, state, pid,
  started_at, exited_at, exit_code, exit_signal, stdout, stderr,
  output_truncated, diagnostics_json, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
  adapter_id=excluded.adapter_id,
  profile_id=excluded.profile_id,
  profile_path=excluded.profile_path,
  operation_id=excluded.operation_id,
  related_operation_id=excluded.related_operation_id,
  verification_kind=excluded.verification_kind,
  state=excluded.state,
  pid=excluded.pid,
  started_at=excluded.started_at,
  exited_at=excluded.exited_at,
  exit_code=excluded.exit_code,
  exit_signal=excluded.exit_signal,
  stdout=excluded.stdout,
  stderr=excluded.stderr,
  output_truncated=excluded.output_truncated,
  diagnostics_json=excluded.diagnostics_json,
  updated_at=excluded.updated_at
`).run(
      record.sessionId,
      this.workspaceId,
      record.adapterId,
      record.profileId,
      record.profilePath,
      record.operationId ?? null,
      record.relatedOperationId ?? null,
      record.verificationKind,
      record.state,
      record.pid ?? null,
      record.startedAt,
      record.exitedAt ?? null,
      record.exitCode ?? null,
      record.signal ?? null,
      record.stdout,
      record.stderr,
      record.outputTruncated ? 1 : 0,
      JSON.stringify(record.diagnostics),
      record.updatedAt
    );
  }

  getRuntimeSession(sessionId: string): RuntimeLaunchRecord | undefined {
    const row = this.database.prepare<[string, string], Record<string, unknown>>(`
${runtimeSessionSelect()}
WHERE session_id = ? AND workspace_id = ?
`).get(sessionId, this.workspaceId);
    return row ? hydrateRuntimeLaunchRecord(row) : undefined;
  }

  listRuntimeSessions(workspaceId: string): RuntimeLaunchRecord[] {
    this.assertWorkspace(workspaceId);
    const rows = this.database.prepare<[string], Record<string, unknown>>(`
${runtimeSessionSelect()}
WHERE workspace_id = ?
ORDER BY started_at DESC, session_id DESC
`).all(this.workspaceId);
    return rows.map(hydrateRuntimeLaunchRecord);
  }

  private assertWorkspace(workspaceId: string): void {
    if (workspaceId !== this.workspaceId) {
      throw new Error(`Runtime session workspace mismatch: ${workspaceId}.`);
    }
  }
}

export class RuntimeVerificationEvidenceRepository
implements RuntimeVerificationEvidenceStore {
  constructor(private readonly database: SqliteDatabase, readonly workspaceId: string) {}

  appendRuntimeVerificationEvidence(evidence: RuntimeVerificationEvidence): void {
    this.assertWorkspace(evidence.workspaceId);
    assertRuntimeVerificationEvidence(evidence);
    const session = this.database.prepare<[string, string], { found: number }>(`
SELECT 1 AS found
FROM runtime_launch_sessions
WHERE session_id = ? AND workspace_id = ?
`).get(evidence.sessionId, this.workspaceId);
    if (!session) {
      throw new Error(`Runtime session not found for verification evidence: ${evidence.sessionId}.`);
    }
    const duplicate = this.database.prepare<[string], { found: number }>(`
SELECT 1 AS found
FROM runtime_verification_evidence
WHERE evidence_id = ?
`).get(evidence.evidenceId);
    if (duplicate) {
      throw new Error(`Runtime verification evidence already exists: ${evidence.evidenceId}.`);
    }
    this.database.prepare(`
INSERT INTO runtime_verification_evidence (
  evidence_id, workspace_id, session_id, evidence_kind, verdict, note, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(
      evidence.evidenceId,
      this.workspaceId,
      evidence.sessionId,
      evidence.evidenceKind,
      evidence.verdict,
      evidence.note ?? null,
      evidence.createdAt
    );
  }

  listRuntimeVerificationEvidence(sessionId: string): RuntimeVerificationEvidence[] {
    const rows = this.database.prepare<[string, string], Record<string, unknown>>(`
SELECT evidence_id AS evidenceId, workspace_id AS workspaceId,
  session_id AS sessionId, evidence_kind AS evidenceKind, verdict,
  note, created_at AS createdAt
FROM runtime_verification_evidence
WHERE session_id = ? AND workspace_id = ?
ORDER BY created_at, evidence_id
`).all(sessionId, this.workspaceId);
    return rows.map(hydrateRuntimeVerificationEvidence);
  }

  private assertWorkspace(workspaceId: string): void {
    if (workspaceId !== this.workspaceId) {
      throw new Error(`Runtime verification evidence workspace mismatch: ${workspaceId}.`);
    }
  }
}

function runtimeSessionSelect(): string {
  return `SELECT session_id AS sessionId, workspace_id AS workspaceId,
  adapter_id AS adapterId, profile_id AS profileId, profile_path AS profilePath,
  operation_id AS operationId, related_operation_id AS relatedOperationId,
  verification_kind AS verificationKind, state, pid, started_at AS startedAt,
  exited_at AS exitedAt, exit_code AS exitCode, exit_signal AS signal,
  stdout, stderr, output_truncated AS outputTruncated,
  diagnostics_json AS diagnosticsJson, updated_at AS updatedAt
FROM runtime_launch_sessions`;
}

function hydrateRuntimeAdapterSetting(row: Record<string, unknown>): RuntimeAdapterSetting {
  const setting = {
    adapterId: String(row.adapterId),
    executablePath: String(row.executablePath),
    confirmedAt: String(row.confirmedAt),
    updatedAt: String(row.updatedAt)
  };
  assertRuntimeAdapterSetting(setting);
  return setting;
}

function hydrateRuntimeLaunchRecord(row: Record<string, unknown>): RuntimeLaunchRecord {
  const state = String(row.state) as PersistedRuntimeLaunchState;
  const verificationKind = String(row.verificationKind) as RuntimeVerificationKind;
  const diagnostics = parseDiagnostics(String(row.diagnosticsJson));
  const record: RuntimeLaunchRecord = {
    sessionId: String(row.sessionId),
    workspaceId: String(row.workspaceId),
    adapterId: String(row.adapterId),
    profileId: String(row.profileId),
    profilePath: String(row.profilePath),
    ...(row.operationId === null ? {} : { operationId: String(row.operationId) }),
    ...(row.relatedOperationId === null ? {} : { relatedOperationId: String(row.relatedOperationId) }),
    verificationKind,
    state,
    ...(row.pid === null ? {} : { pid: Number(row.pid) }),
    startedAt: String(row.startedAt),
    ...(row.exitedAt === null ? {} : { exitedAt: String(row.exitedAt) }),
    ...(row.exitCode === null ? {} : { exitCode: Number(row.exitCode) }),
    ...(row.signal === null ? {} : { signal: String(row.signal) as NodeJS.Signals }),
    stdout: String(row.stdout),
    stderr: String(row.stderr),
    outputTruncated: row.outputTruncated === 1,
    diagnostics,
    updatedAt: String(row.updatedAt)
  };
  assertRuntimeLaunchRecord(record);
  return record;
}

function hydrateRuntimeVerificationEvidence(
  row: Record<string, unknown>
): RuntimeVerificationEvidence {
  const evidence: RuntimeVerificationEvidence = {
    evidenceId: String(row.evidenceId),
    workspaceId: String(row.workspaceId),
    sessionId: String(row.sessionId),
    evidenceKind: String(row.evidenceKind) as RuntimeVerificationEvidenceKind,
    verdict: String(row.verdict) as RuntimeOperatorVerdict,
    ...(row.note === null ? {} : { note: String(row.note) }),
    createdAt: String(row.createdAt)
  };
  assertRuntimeVerificationEvidence(evidence);
  return evidence;
}

function assertRuntimeAdapterSetting(setting: RuntimeAdapterSetting): void {
  if (!setting.adapterId.trim()) throw new Error('Runtime adapter id must not be empty.');
  if (!isAbsolute(setting.executablePath)) {
    throw new Error('Runtime executable path must be absolute.');
  }
  assertIsoDate(setting.confirmedAt, 'confirmedAt');
  assertIsoDate(setting.updatedAt, 'updatedAt');
}

function assertRuntimeLaunchRecord(record: RuntimeLaunchRecord): void {
  if (!record.sessionId || !record.workspaceId || !record.adapterId || !record.profileId) {
    throw new Error('Runtime launch record identity fields must not be empty.');
  }
  if (!isAbsolute(record.profilePath)) throw new Error('Runtime profile path must be absolute.');
  if (!['manual', 'post_commit', 'post_rollback'].includes(record.verificationKind)) {
    throw new Error(`Invalid runtime verification kind: ${record.verificationKind}.`);
  }
  if (!['starting', 'running', 'exited', 'failed', 'terminated', 'orphaned'].includes(record.state)) {
    throw new Error(`Invalid runtime launch state: ${record.state}.`);
  }
  assertIsoDate(record.startedAt, 'startedAt');
  assertIsoDate(record.updatedAt, 'updatedAt');
  if (record.exitedAt) assertIsoDate(record.exitedAt, 'exitedAt');
  if (record.verificationKind === 'post_commit' && !record.operationId) {
    throw new Error('post_commit runtime record requires operationId.');
  }
  if (record.verificationKind === 'post_rollback'
    && (!record.operationId || !record.relatedOperationId)) {
    throw new Error('post_rollback runtime record requires operationId and relatedOperationId.');
  }
}

function parseDiagnostics(value: string): Diagnostic[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Corrupt runtime diagnostics JSON: ${String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error('Corrupt runtime diagnostics JSON: expected array.');
  return parsed as Diagnostic[];
}

function assertIsoDate(value: string, field: string): void {
  if (!value || Number.isNaN(Date.parse(value))) throw new Error(`Invalid ${field}: ${value}.`);
}
