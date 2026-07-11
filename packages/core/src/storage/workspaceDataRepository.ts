import { randomUUID } from 'node:crypto';
import type { Diagnostic, IndexedFile, ParseStatus, ResourceFormatKind, ResourceKind } from '@soulforge/shared';
import type { SqliteDatabase } from './sqliteDatabase.js';

export interface PersistedDiagnostic extends Diagnostic {
  id: string;
  workspaceId: string;
  createdAt: string;
  suppressed: boolean;
  resolvedByOpId?: string;
}

export type BackgroundJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface BackgroundJobRecord {
  jobId: string;
  workspaceId: string;
  title: string;
  jobKind: string;
  status: BackgroundJobStatus;
  progress: { current: number; total?: number; message?: string };
  payload: unknown;
  result?: unknown;
  error?: unknown;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

interface FileRow {
  sourceUri: string; workspaceId: string; absolutePath: string; relativePath: string;
  resourceKind: string; extension: string; compoundExtension: string; formatKind: string;
  formatLabel: string; size: number; mtimeMs: number; sha256: string | null;
  parseStatus: string; diagnosticsJson: string; game: string;
}

export class WorkspaceDataRepository {
  constructor(private readonly database: SqliteDatabase, readonly workspaceId: string) {}

  replaceFiles(files: readonly IndexedFile[]): void {
    for (const file of files) this.assertWorkspace(file.workspaceId);
    const insert = this.database.prepare(`
INSERT INTO files (
 source_uri, workspace_id, absolute_path, relative_path, resource_kind, extension,
 compound_extension, format_kind, format_label, size, mtime_ms, sha256, parse_status, diagnostics_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertFts = this.database.prepare(`
INSERT INTO files_fts (source_uri, relative_path, resource_kind, extension) VALUES (?, ?, ?, ?)`);
    this.database.transaction(() => {
      this.database.prepare('DELETE FROM files_fts WHERE source_uri IN (SELECT source_uri FROM files WHERE workspace_id = ?)')
        .run(this.workspaceId);
      this.database.prepare('DELETE FROM files WHERE workspace_id = ?').run(this.workspaceId);
      for (const file of files) {
        insert.run(file.sourceUri, this.workspaceId, file.absolutePath, file.relativePath,
          file.resourceKind, file.extension, file.compoundExtension, file.formatKind, file.formatLabel,
          file.size, file.mtimeMs, file.sha256 ?? null, file.parseStatus, JSON.stringify(file.diagnostics));
        insertFts.run(file.sourceUri, file.relativePath, file.resourceKind, file.extension);
      }
    }).immediate();
  }

  searchFiles(query: string, limit = 100): IndexedFile[] {
    const boundedLimit = Math.max(1, Math.min(1000, Math.trunc(limit)));
    const tokens = query.trim().split(/\s+/).filter(Boolean).map((token) => `"${token.replaceAll('"', '""')}"`);
    const rows = tokens.length === 0
      ? this.database.prepare<[string, number], FileRow>(fileSelect('WHERE f.workspace_id = ? ORDER BY f.relative_path LIMIT ?'))
          .all(this.workspaceId, boundedLimit)
      : this.database.prepare<[string, string, number], FileRow>(fileSelect(`
JOIN files_fts x ON x.source_uri = f.source_uri
WHERE f.workspace_id = ? AND files_fts MATCH ? ORDER BY rank LIMIT ?`))
          .all(this.workspaceId, tokens.join(' AND '), boundedLimit);
    return rows.map(hydrateFile);
  }

  replaceDiagnostics(diagnostics: readonly Omit<PersistedDiagnostic, 'workspaceId'>[]): void {
    const insert = this.database.prepare(`
INSERT INTO diagnostics (
 id, workspace_id, source_uri, severity, code, message, details_json, created_at, suppressed, resolved_by_op_id
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.database.transaction(() => {
      this.database.prepare('DELETE FROM diagnostics WHERE workspace_id = ?').run(this.workspaceId);
      for (const item of diagnostics) insert.run(
        item.id, this.workspaceId, item.sourceUri ?? null, item.severity, item.code, item.message,
        item.details === undefined ? null : JSON.stringify(item.details), item.createdAt,
        item.suppressed ? 1 : 0, item.resolvedByOpId ?? null
      );
    }).immediate();
  }

  listDiagnostics(): PersistedDiagnostic[] {
    const rows = this.database.prepare<[string], Record<string, unknown>>(`
SELECT id, workspace_id AS workspaceId, source_uri AS sourceUri, severity, code, message,
 details_json AS detailsJson, created_at AS createdAt, suppressed, resolved_by_op_id AS resolvedByOpId
FROM diagnostics WHERE workspace_id = ? ORDER BY created_at, id`).all(this.workspaceId);
    return rows.map((row) => ({
      id: String(row.id), workspaceId: String(row.workspaceId), severity: String(row.severity) as Diagnostic['severity'],
      code: String(row.code), message: String(row.message), createdAt: String(row.createdAt),
      suppressed: row.suppressed === 1,
      ...(row.sourceUri ? { sourceUri: String(row.sourceUri) } : {}),
      ...(row.detailsJson ? { details: parseJson(String(row.detailsJson), 'diagnostic details') } : {}),
      ...(row.resolvedByOpId ? { resolvedByOpId: String(row.resolvedByOpId) } : {})
    }));
  }

  upsertJob(job: Omit<BackgroundJobRecord, 'workspaceId'>): void {
    assertJobStatus(job.status);
    this.database.prepare(`
INSERT INTO background_jobs (
 job_id, workspace_id, title, job_kind, status, progress_current, progress_total,
 progress_message, payload_json, result_json, error_json, created_at, started_at, completed_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(job_id) DO UPDATE SET title=excluded.title, job_kind=excluded.job_kind,
 status=excluded.status, progress_current=excluded.progress_current,
 progress_total=excluded.progress_total, progress_message=excluded.progress_message,
 payload_json=excluded.payload_json, result_json=excluded.result_json, error_json=excluded.error_json,
 started_at=excluded.started_at, completed_at=excluded.completed_at, updated_at=excluded.updated_at
`).run(job.jobId, this.workspaceId, job.title, job.jobKind, job.status, job.progress.current,
      job.progress.total ?? null, job.progress.message ?? null, JSON.stringify(job.payload),
      job.result === undefined ? null : JSON.stringify(job.result),
      job.error === undefined ? null : JSON.stringify(job.error), job.createdAt,
      job.startedAt ?? null, job.completedAt ?? null, job.updatedAt);
  }

  listJobs(): BackgroundJobRecord[] {
    const rows = this.database.prepare<[string], Record<string, unknown>>(`
SELECT job_id AS jobId, workspace_id AS workspaceId, title, job_kind AS jobKind, status,
 progress_current AS progressCurrent, progress_total AS progressTotal,
 progress_message AS progressMessage, payload_json AS payloadJson, result_json AS resultJson,
 error_json AS errorJson, created_at AS createdAt, started_at AS startedAt,
 completed_at AS completedAt, updated_at AS updatedAt
FROM background_jobs WHERE workspace_id = ? ORDER BY created_at DESC, job_id`).all(this.workspaceId);
    return rows.map(hydrateJob);
  }

  createDiagnostic(input: Omit<PersistedDiagnostic, 'id' | 'workspaceId'>): PersistedDiagnostic {
    return { ...input, id: randomUUID(), workspaceId: this.workspaceId };
  }

  private assertWorkspace(workspaceId: string): void {
    if (workspaceId !== this.workspaceId) throw new Error(`Workspace mismatch: ${workspaceId}.`);
  }
}

function fileSelect(suffix: string): string {
  return `SELECT f.source_uri AS sourceUri, f.workspace_id AS workspaceId,
 f.absolute_path AS absolutePath, f.relative_path AS relativePath, f.resource_kind AS resourceKind,
 f.extension, f.compound_extension AS compoundExtension, f.format_kind AS formatKind,
 f.format_label AS formatLabel, f.size, f.mtime_ms AS mtimeMs, f.sha256,
 f.parse_status AS parseStatus, f.diagnostics_json AS diagnosticsJson, w.game
FROM files f JOIN workspaces w ON w.workspace_id = f.workspace_id ${suffix}`;
}
function hydrateFile(row: FileRow): IndexedFile {
  return {
    id: row.sourceUri, workspaceId: row.workspaceId, sourceUri: row.sourceUri,
    sourcePath: row.absolutePath, absolutePath: row.absolutePath, relativePath: row.relativePath,
    game: row.game, resourceKind: row.resourceKind as ResourceKind, extension: row.extension,
    compoundExtension: row.compoundExtension, formatKind: row.formatKind as ResourceFormatKind,
    formatLabel: row.formatLabel, size: row.size, mtimeMs: row.mtimeMs,
    ...(row.sha256 ? { sha256: row.sha256 } : {}), parseStatus: row.parseStatus as ParseStatus,
    diagnostics: parseJson(row.diagnosticsJson, 'file diagnostics')
  };
}
function hydrateJob(row: Record<string, unknown>): BackgroundJobRecord {
  const status = String(row.status); assertJobStatus(status);
  return {
    jobId: String(row.jobId), workspaceId: String(row.workspaceId), title: String(row.title),
    jobKind: String(row.jobKind), status,
    progress: { current: Number(row.progressCurrent),
      ...(row.progressTotal !== null ? { total: Number(row.progressTotal) } : {}),
      ...(row.progressMessage ? { message: String(row.progressMessage) } : {}) },
    payload: parseJson(String(row.payloadJson), 'job payload'),
    ...(row.resultJson ? { result: parseJson(String(row.resultJson), 'job result') } : {}),
    ...(row.errorJson ? { error: parseJson(String(row.errorJson), 'job error') } : {}),
    createdAt: String(row.createdAt), ...(row.startedAt ? { startedAt: String(row.startedAt) } : {}),
    ...(row.completedAt ? { completedAt: String(row.completedAt) } : {}), updatedAt: String(row.updatedAt)
  };
}
function assertJobStatus(value: string): asserts value is BackgroundJobStatus {
  if (!['queued', 'running', 'completed', 'failed', 'cancelled'].includes(value)) throw new Error(`Invalid job status: ${value}.`);
}
function parseJson<T>(value: string, label: string): T {
  try { return JSON.parse(value) as T; } catch (error) { throw new Error(`Corrupt ${label}: ${String(error)}`); }
}
