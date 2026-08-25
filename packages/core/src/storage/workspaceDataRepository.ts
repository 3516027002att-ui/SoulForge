import { randomUUID } from 'node:crypto';
import type {
  Diagnostic,
  IndexedFile,
  ParseStatus,
  RagChunk,
  RagChunkFamily,
  RagCorpusMetadata,
  RagCoverage,
  ReferenceConfidence,
  ReferenceEdge,
  ResourceFormatKind,
  ResourceKind
} from '@soulforge/shared';
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

interface ExistingRagEmbeddingRow {
  chunkId: string;
  model: string;
  dim: number;
  vector: Buffer;
  sourceRevision: string;
  contentHash: string;
}

export type RagCorpusMetadataInput = Pick<RagCorpusMetadata, 'builtAt' | 'coverage'>;

interface RagEmbeddingSummary {
  count: number;
  model: string | null;
  modelCount: number;
  sourceRevision: string | null;
  revisionCount: number;
  dim: number | null;
  dimCount: number;
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

  replaceRagChunks(chunks: readonly RagChunk[], preserveEmbeddingsForSourceRevision?: string): void {
    for (const chunk of chunks) this.assertWorkspace(chunk.workspaceId);
    const insert = this.database.prepare(`
INSERT INTO rag_chunks (
 chunk_id, workspace_id, source_uri, symbol_uri, family, title, body,
 numeric_ids_json, relative_path, resource_kind, confidence, content_hash, source_revision, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertFts = this.database.prepare(`
INSERT INTO rag_chunks_fts (chunk_id, title, body) VALUES (?, ?, ?)`);
    const insertTrigram = this.database.prepare(`
INSERT INTO rag_chunks_fts_trigram (chunk_id, title, body) VALUES (?, ?, ?)`);
    const createdAt = new Date().toISOString();
    this.database.transaction(() => {
      const existingEmbeddings = this.database.prepare<[string], ExistingRagEmbeddingRow>(`
SELECT e.chunk_id AS chunkId, e.model, e.dim, e.vector,
       e.source_revision AS sourceRevision, c.content_hash AS contentHash
FROM rag_embeddings e
JOIN rag_chunks c ON c.chunk_id = e.chunk_id AND c.workspace_id = e.workspace_id
WHERE e.workspace_id = ?`).all(this.workspaceId);
      const nextChunksById = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
      const embeddingModels = new Set(existingEmbeddings.map((entry) => entry.model));
      const preserveEmbeddings = typeof preserveEmbeddingsForSourceRevision === 'string'
        && preserveEmbeddingsForSourceRevision.trim() !== ''
        && existingEmbeddings.length === chunks.length
        && existingEmbeddings.length > 0
        && embeddingModels.size === 1
        && existingEmbeddings.every((entry) => {
          const next = nextChunksById.get(entry.chunkId);
          return entry.sourceRevision === preserveEmbeddingsForSourceRevision
            && next !== undefined
            && next.contentHash === entry.contentHash
            && Number.isInteger(entry.dim)
            && entry.dim > 0
            && Buffer.isBuffer(entry.vector)
            && entry.vector.byteLength === entry.dim * Float32Array.BYTES_PER_ELEMENT;
        });
      const deleteFts = this.database.prepare(
        'DELETE FROM rag_chunks_fts WHERE chunk_id IN (SELECT chunk_id FROM rag_chunks WHERE workspace_id = ?)');
      const deleteTrigram = this.database.prepare(
        'DELETE FROM rag_chunks_fts_trigram WHERE chunk_id IN (SELECT chunk_id FROM rag_chunks WHERE workspace_id = ?)');
      deleteFts.run(this.workspaceId);
      deleteTrigram.run(this.workspaceId);
      this.database.prepare('DELETE FROM rag_chunks WHERE workspace_id = ?').run(this.workspaceId);
      for (const chunk of chunks) {
        insert.run(
          chunk.chunkId, this.workspaceId, chunk.sourceUri, chunk.symbolUri, chunk.family,
          chunk.title, chunk.body, JSON.stringify(chunk.numericIds),
          chunk.relativePath ?? null, chunk.resourceKind ?? null, chunk.confidence ?? null,
          chunk.contentHash, chunk.sourceRevision ?? null, createdAt
        );
        insertFts.run(chunk.chunkId, chunk.title, chunk.body);
        insertTrigram.run(chunk.chunkId, chunk.title, chunk.body);
      }
      if (preserveEmbeddings) {
        const insertEmbedding = this.database.prepare(`
INSERT INTO rag_embeddings (chunk_id, workspace_id, model, dim, vector, source_revision, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?)`);
        for (const entry of existingEmbeddings) {
          insertEmbedding.run(
            entry.chunkId,
            this.workspaceId,
            entry.model,
            entry.dim,
            entry.vector,
            entry.sourceRevision,
            createdAt
          );
        }
      }
    }).immediate();
  }

  /** Persist corpus-wide coverage separately from per-chunk source revisions. */
  replaceRagCorpusMetadata(input: RagCorpusMetadataInput): void {
    const coverage = input.coverage;
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.writeRagCorpusMetadata(input.builtAt, coverage, now);
    }).immediate();
  }

  /**
   * Load durable coverage and derive the embedding summary from the actual
   * rows.  This is deliberately defensive: a crash between two projections
   * may leave metadata claiming fresh vectors while the FK cascade already
   * removed them, so the returned status is recomputed rather than trusted.
   */
  loadRagCorpusMetadata(): RagCorpusMetadata | null {
    const row = this.database.prepare<[string], {
      builtAt: string;
      coverageJson: string;
      updatedAt: string;
    }>(`
SELECT built_at AS builtAt, coverage_json AS coverageJson, updated_at AS updatedAt
FROM rag_corpus_metadata WHERE workspace_id = ?`).get(this.workspaceId);
    if (!row) return null;
    const coverage = parseJson(String(row.coverageJson), 'RAG coverage metadata') as RagCoverage;
    const summary = this.ragEmbeddingSummary();
    const chunkCount = this.ragChunkCount();
    const fresh = chunkCount > 0
      && summary.count === chunkCount
      && summary.modelCount === 1
      && summary.revisionCount === 1
      && summary.dimCount === 1
      && summary.dim !== null
      && summary.dim > 0
      && coverage.sourceRevision !== undefined
      && summary.sourceRevision === coverage.sourceRevision;
    return {
      workspaceId: this.workspaceId,
      builtAt: String(row.builtAt),
      coverage,
      embeddingStatus: fresh ? 'fresh' : 'invalidated',
      ...(summary.model ? { embeddingModel: summary.model } : {}),
      ...(summary.sourceRevision ? { embeddingSourceRevision: summary.sourceRevision } : {}),
      ...(summary.dim !== null && summary.dim > 0 ? { embeddingDim: summary.dim } : {}),
      embeddingCount: summary.count,
      updatedAt: String(row.updatedAt)
    };
  }

  loadRagChunks(): RagChunk[] {
    const rows = this.database.prepare<[string], RagChunkRow>(`
SELECT chunk_id AS chunkId, workspace_id AS workspaceId, source_uri AS sourceUri,
 symbol_uri AS symbolUri, family, title, body, numeric_ids_json AS numericIdsJson,
 relative_path AS relativePath, resource_kind AS resourceKind, confidence,
 content_hash AS contentHash, source_revision AS sourceRevision
FROM rag_chunks WHERE workspace_id = ? ORDER BY family, title, chunk_id`)
      .all(this.workspaceId);
    return rows.map(hydrateRagChunk);
  }

  searchRagChunks(query: string, limit = 32): RagChunk[] {
    const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const trimmed = query.trim();
    const tokens = trimmed.split(/\s+/).filter(Boolean).map((token) => `"${token.replaceAll('"', '""')}"`);
    if (tokens.length === 0) return this.loadRagChunks().slice(0, boundedLimit);

    const selectChunks = `
SELECT c.chunk_id AS chunkId, c.workspace_id AS workspaceId, c.source_uri AS sourceUri,
 c.symbol_uri AS symbolUri, c.family, c.title, c.body, c.numeric_ids_json AS numericIdsJson,
 c.relative_path AS relativePath, c.resource_kind AS resourceKind, c.confidence,
 c.content_hash AS contentHash, c.source_revision AS sourceRevision
FROM rag_chunks c
JOIN rag_chunks_fts x ON x.chunk_id = c.chunk_id
WHERE c.workspace_id = ? AND rag_chunks_fts MATCH ? ORDER BY rank LIMIT ?`;
    const rows = this.database.prepare<[string, string, number], RagChunkRow>(selectChunks)
      .all(this.workspaceId, tokens.join(' AND '), boundedLimit);
    if (rows.length > 0) return rows.map(hydrateRagChunk);

    // CJK 子串检索：unicode61 不切分中文，整串 LIKE 只能命中完整短语。
    // trigram tokenizer（migration 8）支持任意 ≥3 字符子串（含中文）；1-2 字
    // 短词 trigram 无 gram 可匹配，仍走有界 LIKE 子串扫描。
    const cjkChars = countCjkChars(trimmed);
    if (cjkChars >= 3) {
      const phrase = `"${trimmed.replaceAll('"', '""')}"`;
      const trigramRows = this.database.prepare<[string, string, number], RagChunkRow>(`
SELECT c.chunk_id AS chunkId, c.workspace_id AS workspaceId, c.source_uri AS sourceUri,
 c.symbol_uri AS symbolUri, c.family, c.title, c.body, c.numeric_ids_json AS numericIdsJson,
 c.relative_path AS relativePath, c.resource_kind AS resourceKind, c.confidence,
 c.content_hash AS contentHash, c.source_revision AS sourceRevision
FROM rag_chunks c
JOIN rag_chunks_fts_trigram x ON x.chunk_id = c.chunk_id
WHERE c.workspace_id = ? AND rag_chunks_fts_trigram MATCH ? ORDER BY rank LIMIT ?`)
        .all(this.workspaceId, phrase, boundedLimit);
      if (trigramRows.length > 0) return trigramRows.map(hydrateRagChunk);
    }

    const needle = `%${trimmed.replaceAll('%', '').replaceAll('_', '')}%`;
    const fallback = this.database.prepare<[string, string, string, number], RagChunkRow>(`
SELECT chunk_id AS chunkId, workspace_id AS workspaceId, source_uri AS sourceUri,
 symbol_uri AS symbolUri, family, title, body, numeric_ids_json AS numericIdsJson,
 relative_path AS relativePath, resource_kind AS resourceKind, confidence,
 content_hash AS contentHash, source_revision AS sourceRevision
FROM rag_chunks
WHERE workspace_id = ? AND (title LIKE ? OR body LIKE ?)
ORDER BY family, title LIMIT ?`).all(this.workspaceId, needle, needle, boundedLimit);
    return fallback.map(hydrateRagChunk);
  }

  /**
   * 整体替换该 workspace 的 chunk 向量（embed 时先删后插）。
   * 向量只按 chunkId 关联；语料 replaceRagChunks 后旧的向量行会被 FK 级联删除。
   */
  replaceRagEmbeddings(entries: Array<{ chunkId: string; model: string; vector: Float32Array; sourceRevision: string }>): void {
    const insert = this.database.prepare(`
INSERT OR REPLACE INTO rag_embeddings (chunk_id, workspace_id, model, dim, vector, source_revision, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const createdAt = new Date().toISOString();
    this.database.transaction(() => {
      this.database.prepare('DELETE FROM rag_embeddings WHERE workspace_id = ?').run(this.workspaceId);
      for (const entry of entries) {
        insert.run(
          entry.chunkId, this.workspaceId, entry.model, entry.vector.length,
          Buffer.from(entry.vector.buffer, entry.vector.byteOffset, entry.vector.byteLength),
          entry.sourceRevision,
          createdAt
        );
      }
      this.refreshRagCorpusEmbeddingMetadata(createdAt);
    }).immediate();
  }

  /**
   * 加载该 workspace 的 chunk 向量（chunkId → Float32Array）。model 是生成
   * 向量所用的 embedding 模型 —— 查询向量必须用同一模型，调用方自行比对。
   */
  loadRagEmbeddings(): Map<string, Float32Array> {
    const rows = this.database.prepare<[string], { chunkId: string; vector: Buffer }>(`
SELECT chunk_id AS chunkId, vector FROM rag_embeddings WHERE workspace_id = ?`)
      .all(this.workspaceId);
    const map = new Map<string, Float32Array>();
    for (const row of rows) {
      map.set(row.chunkId, new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4));
    }
    return map;
  }

  /** 该 workspace 是否已有向量索引，以及所用 embedding 模型名。 */
  ragEmbeddingModel(): string | null {
    const row = this.database.prepare<[string], { model: string | null }>(`
SELECT model FROM rag_embeddings WHERE workspace_id = ? LIMIT 1`)
      .get(this.workspaceId);
    return row?.model ?? null;
  }

  /** Source revision shared by every stored vector, or null when absent/mixed. */
  ragEmbeddingSourceRevision(): string | null {
    const row = this.database.prepare<[
      string
    ], { sourceRevision: string | null; vectorCount: number; revisionCount: number }>(`
SELECT MIN(source_revision) AS sourceRevision,
       COUNT(*) AS vectorCount,
       COUNT(DISTINCT source_revision) AS revisionCount
FROM rag_embeddings WHERE workspace_id = ?`).get(this.workspaceId);
    if (!row || row.vectorCount === 0 || row.revisionCount !== 1 || !row.sourceRevision) return null;
    return row.sourceRevision;
  }

  private writeRagCorpusMetadata(builtAt: string, coverage: RagCoverage, updatedAt: string): void {
    const summary = this.ragEmbeddingSummary();
    const chunkCount = this.ragChunkCount();
    const fresh = chunkCount > 0
      && summary.count === chunkCount
      && summary.modelCount === 1
      && summary.revisionCount === 1
      && summary.dimCount === 1
      && summary.dim !== null
      && summary.dim > 0
      && coverage.sourceRevision !== undefined
      && summary.sourceRevision === coverage.sourceRevision;
    this.database.prepare(`
INSERT INTO rag_corpus_metadata (
 workspace_id, built_at, coverage_json, embedding_status, embedding_model,
 embedding_source_revision, embedding_dim, embedding_count, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(workspace_id) DO UPDATE SET built_at=excluded.built_at,
 coverage_json=excluded.coverage_json, embedding_status=excluded.embedding_status,
 embedding_model=excluded.embedding_model, embedding_source_revision=excluded.embedding_source_revision,
 embedding_dim=excluded.embedding_dim, embedding_count=excluded.embedding_count,
 updated_at=excluded.updated_at
`).run(
      this.workspaceId,
      builtAt,
      JSON.stringify(coverage),
      fresh ? 'fresh' : 'invalidated',
      summary.model,
      summary.sourceRevision,
      summary.dim,
      summary.count,
      updatedAt
    );
  }

  private refreshRagCorpusEmbeddingMetadata(updatedAt: string): void {
    const row = this.database.prepare<[string], { builtAt: string; coverageJson: string }>(`
SELECT built_at AS builtAt, coverage_json AS coverageJson
FROM rag_corpus_metadata WHERE workspace_id = ?`).get(this.workspaceId);
    if (!row) return;
    const coverage = parseJson(String(row.coverageJson), 'RAG coverage metadata') as RagCoverage;
    this.writeRagCorpusMetadata(String(row.builtAt), coverage, updatedAt);
  }

  private ragChunkCount(): number {
    const row = this.database.prepare<[string], { count: number }>(`
SELECT COUNT(*) AS count FROM rag_chunks WHERE workspace_id = ?`).get(this.workspaceId);
    return Number(row?.count ?? 0);
  }

  private ragEmbeddingSummary(): RagEmbeddingSummary {
    const row = this.database.prepare<[string], {
      count: number;
      model: string | null;
      modelCount: number;
      sourceRevision: string | null;
      revisionCount: number;
      dim: number | null;
      dimCount: number;
    }>(`
SELECT COUNT(*) AS count,
       MIN(model) AS model,
       COUNT(DISTINCT model) AS modelCount,
       MIN(source_revision) AS sourceRevision,
       COUNT(DISTINCT source_revision) AS revisionCount,
       MIN(dim) AS dim,
       COUNT(DISTINCT dim) AS dimCount
FROM rag_embeddings WHERE workspace_id = ?`).get(this.workspaceId);
    return {
      count: Number(row?.count ?? 0),
      model: row?.model ?? null,
      modelCount: Number(row?.modelCount ?? 0),
      sourceRevision: row?.sourceRevision ?? null,
      revisionCount: Number(row?.revisionCount ?? 0),
      dim: row?.dim === null || row?.dim === undefined ? null : Number(row.dim),
      dimCount: Number(row?.dimCount ?? 0)
    };
  }

  replaceReferences(references: readonly ReferenceEdge[]): void {    const insert = this.database.prepare(`
INSERT INTO reference_edges (
 id, workspace_id, from_uri, to_uri, kind, confidence, reason, evidence_json, source_revision
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.database.transaction(() => {
      this.database.prepare('DELETE FROM reference_edges WHERE workspace_id = ?').run(this.workspaceId);
      for (const [index, edge] of references.entries()) {
        insert.run(
          `${this.workspaceId}:${index}:${edge.fromUri}->${edge.toUri}:${edge.kind}`,
          this.workspaceId,
          edge.fromUri,
          edge.toUri,
          edge.kind,
          edge.confidence,
          edge.reason,
          JSON.stringify(edge.evidence),
          edge.sourceRevision ?? null
        );
      }
    }).immediate();
  }

  loadReferences(): ReferenceEdge[] {
    const rows = this.database.prepare<[string], Record<string, unknown>>(`
SELECT from_uri AS fromUri, to_uri AS toUri, kind, confidence, reason, evidence_json AS evidenceJson,
 source_revision AS sourceRevision
FROM reference_edges WHERE workspace_id = ? ORDER BY from_uri, to_uri, kind`)
      .all(this.workspaceId);
    return rows.map((row) => ({
      fromUri: String(row.fromUri),
      toUri: String(row.toUri),
      kind: String(row.kind) as ReferenceEdge['kind'],
      confidence: String(row.confidence) as ReferenceConfidence,
      reason: String(row.reason),
      evidence: parseJson(String(row.evidenceJson), 'reference evidence'),
      ...(row.sourceRevision ? { sourceRevision: String(row.sourceRevision) } : {})
    }));
  }

  private assertWorkspace(workspaceId: string): void {
    if (workspaceId !== this.workspaceId) throw new Error(`Workspace mismatch: ${workspaceId}.`);
  }
}

interface RagChunkRow {
  chunkId: string;
  workspaceId: string;
  sourceUri: string;
  symbolUri: string;
  family: string;
  title: string;
  body: string;
  numericIdsJson: string;
  relativePath: string | null;
  resourceKind: string | null;
  confidence: string | null;
  contentHash: string;
  sourceRevision: string | null;
}

function hydrateRagChunk(row: RagChunkRow): RagChunk {
  return {
    chunkId: row.chunkId,
    workspaceId: row.workspaceId,
    sourceUri: row.sourceUri,
    symbolUri: row.symbolUri,
    family: row.family as RagChunkFamily,
    title: row.title,
    body: row.body,
    numericIds: parseJson(row.numericIdsJson, 'rag numeric ids'),
    contentHash: row.contentHash,
    ...(row.sourceRevision ? { sourceRevision: row.sourceRevision } : {}),
    ...(row.relativePath ? { relativePath: row.relativePath } : {}),
    ...(row.resourceKind ? { resourceKind: row.resourceKind as ResourceKind } : {}),
    ...(row.confidence ? { confidence: row.confidence as ReferenceConfidence } : {})
  };
}

/** CJK 统一表意文字区字符计数，用于决定 trigram 子串检索是否可用（≥3）。 */
function countCjkChars(value: string): number {
  let count = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x3400 && code <= 0x9fff) count += 1;
  }
  return count;
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
