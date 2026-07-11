import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { OperationLogRecord } from '@soulforge/shared';
import type { SqliteOperationLogStore } from './sqliteOperationLogStore.js';

export interface ImportLegacyOperationLogOptions {
  sourcePath: string;
  backupDirectory: string;
  store: SqliteOperationLogStore;
}

export interface ImportLegacyOperationLogResult {
  status: 'imported' | 'already_imported' | 'source_missing';
  recordCount: number;
  contentHash?: string;
  backupPath?: string;
}

interface LegacyOperationLogDocument {
  version: 1;
  entries: unknown[];
}

export class LegacyOperationLogImportError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

/**
 * Strict, idempotent JSON → workspace.db importer.
 * Corrupt input is surfaced and left untouched; it is never converted to an
 * empty history. A validated read-only backup is created before the DB commit.
 */
export async function importLegacyOperationLog(
  options: ImportLegacyOperationLogOptions
): Promise<ImportLegacyOperationLogResult> {
  let bytes: Buffer;
  try {
    bytes = await readFile(options.sourcePath);
  } catch (error) {
    if (isMissing(error)) return { status: 'source_missing', recordCount: 0 };
    throw new LegacyOperationLogImportError(
      'LEGACY_OPERATION_LOG_READ_FAILED',
      '无法读取旧操作日志。',
      { cause: error instanceof Error ? error.message : String(error) }
    );
  }

  const contentHash = sha256(bytes);
  const sourcePathHash = sha256(Buffer.from(normalizePath(options.sourcePath), 'utf8'));
  if (options.store.hasLegacyImport('operation_log_json_v1', sourcePathHash, contentHash)) {
    return { status: 'already_imported', recordCount: 0, contentHash };
  }

  const records = parseAndValidate(bytes, options.store.workspaceId);
  await mkdir(options.backupDirectory, { recursive: true });
  const backupPath = join(
    options.backupDirectory,
    `${basename(options.sourcePath)}.${contentHash.slice(0, 16)}.readonly.json`
  );
  await copyFile(options.sourcePath, backupPath);
  await chmod(backupPath, 0o444).catch(() => undefined);

  options.store.importLegacyRecords(records, {
    sourceKind: 'operation_log_json_v1',
    sourcePathHash,
    contentHash,
    importedAt: new Date().toISOString(),
    recordCount: records.length,
    backupPath
  });

  return {
    status: 'imported',
    recordCount: records.length,
    contentHash,
    backupPath
  };
}

function parseAndValidate(bytes: Buffer, workspaceId: string): OperationLogRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new LegacyOperationLogImportError(
      'LEGACY_OPERATION_LOG_CORRUPT',
      '旧操作日志不是有效 JSON；未导入、未覆盖原文件。',
      { cause: error instanceof Error ? error.message : String(error) }
    );
  }

  const entries = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed)
      && parsed.version === 1
      && Array.isArray((parsed as unknown as LegacyOperationLogDocument).entries)
        ? (parsed as unknown as LegacyOperationLogDocument).entries
        : null;
  if (!entries) {
    throw new LegacyOperationLogImportError(
      'LEGACY_OPERATION_LOG_SCHEMA_INVALID',
      '旧操作日志结构无效；预期 version=1 的 entries 数组。'
    );
  }

  const seen = new Set<string>();
  return entries.map((entry, index) => {
    if (!isRecord(entry)) throw schemaError(index, 'entry must be an object');
    requireString(entry, 'opId', index);
    requireString(entry, 'workspaceId', index);
    requireString(entry, 'title', index);
    requireString(entry, 'createdAt', index);
    if (entry.workspaceId !== workspaceId) throw schemaError(index, 'workspaceId does not match the target database');
    if (seen.has(entry.opId as string)) throw schemaError(index, 'duplicate opId');
    seen.add(entry.opId as string);
    if (entry.author !== 'user' && entry.author !== 'ai') throw schemaError(index, 'invalid author');
    if (!['plan', 'normal', 'fullPermission'].includes(String(entry.mode))) throw schemaError(index, 'invalid mode');
    if (![
      'planned',
      'pending',
      'staged',
      'validated',
      'committed',
      'rolled_back',
      'failed',
      'recovery_required'
    ].includes(String(entry.status))) throw schemaError(index, 'invalid status');
    if (!Array.isArray(entry.files)) throw schemaError(index, 'files must be an array');
    if (!Array.isArray(entry.diagnostics)) throw schemaError(index, 'diagnostics must be an array');
    entry.files.forEach((file, fileIndex) => validateFileRecord(file, index, fileIndex));
    return entry as unknown as OperationLogRecord;
  });
}

function validateFileRecord(value: unknown, entryIndex: number, fileIndex: number): void {
  if (!isRecord(value)) throw schemaError(entryIndex, `files[${fileIndex}] must be an object`);
  for (const key of ['targetUri', 'targetPath', 'beforeHash', 'afterHash', 'backupPath', 'kind']) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      throw schemaError(entryIndex, `files[${fileIndex}].${key} must be a non-empty string`);
    }
  }
}

function requireString(value: Record<string, unknown>, key: string, index: number): void {
  if (typeof value[key] !== 'string' || value[key].length === 0) {
    throw schemaError(index, `${key} must be a non-empty string`);
  }
}

function schemaError(index: number, reason: string): LegacyOperationLogImportError {
  return new LegacyOperationLogImportError(
    'LEGACY_OPERATION_LOG_SCHEMA_INVALID',
    `旧操作日志第 ${index} 条记录无效：${reason}。`
  );
}

function normalizePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
