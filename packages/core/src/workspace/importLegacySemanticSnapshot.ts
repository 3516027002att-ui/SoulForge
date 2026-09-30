import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { SqliteDatabase } from '../storage/sqliteDatabase.js';
import type { SemanticSnapshot } from './semanticWorkspaceIndex.js';

export interface LegacySemanticSnapshotImportOptions {
  sourcePath: string;
  backupDirectory: string;
  database: SqliteDatabase;
  workspaceId: string;
}

export interface LegacySemanticSnapshotImportResult {
  status: 'archived' | 'already_imported' | 'source_missing';
  nodeCount: number;
  edgeCount: number;
  contentHash?: string;
  backupPath?: string;
}

export class LegacySemanticSnapshotImportError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) { super(message); }
}

export async function importLegacySemanticSnapshot(
  options: LegacySemanticSnapshotImportOptions
): Promise<LegacySemanticSnapshotImportResult> {
  let bytes: Buffer;
  try { bytes = await readFile(options.sourcePath); }
  catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return { status: 'source_missing', nodeCount: 0, edgeCount: 0 };
    throw new LegacySemanticSnapshotImportError('LEGACY_SEMANTIC_SNAPSHOT_READ_FAILED', '无法读取旧语义快照。', error);
  }
  const contentHash = sha256(bytes);
  const sourcePathHash = sha256(Buffer.from(normalizePath(options.sourcePath)));
  const sourceKind = 'semantic_snapshot_json_v1';
  const imported = options.database.prepare<[string, string, string], { found: number }>(`
SELECT 1 AS found FROM legacy_imports
WHERE source_kind = ? AND source_path_hash = ? AND content_hash = ?
`).get(sourceKind, sourcePathHash, contentHash);
  if (imported?.found === 1) return { status: 'already_imported', nodeCount: 0, edgeCount: 0, contentHash };

  const snapshot = parseAndValidate(bytes, options.workspaceId);
  await mkdir(options.backupDirectory, { recursive: true });
  const backupPath = join(options.backupDirectory, `${basename(options.sourcePath)}.${contentHash.slice(0, 16)}.readonly.json`);
  await copyFile(options.sourcePath, backupPath);
  await chmod(backupPath, 0o444).catch(() => undefined);
  const importedAt = new Date().toISOString();
  options.database.transaction(() => {
    // These graph tables were write-only. Keep the validated source archive and
    // import receipt; live semantic/knowledge projections rebuild from resources.
    options.database.prepare(`
INSERT INTO legacy_imports (
 source_kind, source_path_hash, content_hash, imported_at, record_count, backup_path
) VALUES (?, ?, ?, ?, ?, ?)
`).run(sourceKind, sourcePathHash, contentHash, importedAt,
      snapshot.graph.nodes.length + snapshot.graph.edges.length, backupPath);
  }).immediate();
  return {
    status: 'archived', nodeCount: snapshot.graph.nodes.length,
    edgeCount: snapshot.graph.edges.length, contentHash, backupPath
  };
}

function parseAndValidate(bytes: Buffer, workspaceId: string): SemanticSnapshot {
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch (error) {
    throw new LegacySemanticSnapshotImportError('LEGACY_SEMANTIC_SNAPSHOT_CORRUPT', '旧语义快照不是有效 JSON；未导入且未修改源文件。', error);
  }
  if (!isRecord(value) || value.workspaceId !== workspaceId || typeof value.createdAt !== 'string'
    || typeof value.version !== 'string' || !isRecord(value.graph)
    || !Array.isArray(value.graph.nodes) || !Array.isArray(value.graph.edges)) {
    throw new LegacySemanticSnapshotImportError('LEGACY_SEMANTIC_SNAPSHOT_SCHEMA_INVALID', '旧语义快照结构或工作区标识无效。');
  }
  const nodes = value.graph.nodes as unknown[];
  const edges = value.graph.edges as unknown[];
  const nodeIds = new Set<string>();
  const uris = new Set<string>();
  for (const [index, node] of nodes.entries()) {
    if (!isRecord(node) || !requiredStrings(node, ['id', 'kind', 'uri', 'label', 'createdAt', 'updatedAt'])
      || !Array.isArray(node.properties)) schemaError(`nodes[${index}]`);
    if (nodeIds.has(node.id as string) || uris.has(node.uri as string)) schemaError(`nodes[${index}] duplicate id or uri`);
    nodeIds.add(node.id as string); uris.add(node.uri as string);
  }
  const edgeIds = new Set<string>();
  for (const [index, edge] of edges.entries()) {
    if (!isRecord(edge) || !requiredStrings(edge, ['id', 'kind', 'fromId', 'toId', 'createdAt', 'updatedAt'])
      || !Array.isArray(edge.properties)) schemaError(`edges[${index}]`);
    if (edgeIds.has(edge.id as string) || !nodeIds.has(edge.fromId as string) || !nodeIds.has(edge.toId as string)) {
      schemaError(`edges[${index}] duplicate id or missing endpoint`);
    }
    edgeIds.add(edge.id as string);
  }
  if (typeof value.nodeCount === 'number' && value.nodeCount !== nodes.length) schemaError('nodeCount mismatch');
  if (typeof value.edgeCount === 'number' && value.edgeCount !== edges.length) schemaError('edgeCount mismatch');
  return value as unknown as SemanticSnapshot;
}

function requiredStrings(value: Record<string, unknown>, fields: string[]): boolean {
  return fields.every((field) => typeof value[field] === 'string' && (value[field] as string).length > 0);
}
function schemaError(reason: string): never {
  throw new LegacySemanticSnapshotImportError('LEGACY_SEMANTIC_SNAPSHOT_SCHEMA_INVALID', `旧语义快照结构无效：${reason}。`);
}
function normalizePath(path: string): string { const v = resolve(path); return process.platform === 'win32' ? v.toLowerCase() : v; }
function sha256(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
