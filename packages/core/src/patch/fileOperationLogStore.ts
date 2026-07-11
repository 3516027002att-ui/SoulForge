import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  OperationLogRecord,
  OperationStatus,
  PatchHistoryEntry
} from '@soulforge/shared';
import { toHistoryEntry, type OperationLogStore } from './operationLog.js';

interface FileOperationLogDocument {
  version: 1;
  entries: OperationLogRecord[];
}

/**
 * On-disk operation log implementing the same contract as MemoryOperationLogStore.
 * Persists to a single JSON file so commit / history / rollback survive process reopen.
 * Legacy compatibility store only. Production desktop opens this data through
 * the strict JSON -> workspace.db importer and never writes it again.
 */
export class FileOperationLogStore implements OperationLogStore {
  private readonly byId = new Map<string, OperationLogRecord>();

  constructor(public readonly storePath: string) {
    this.reload();
  }

  /** Re-read the store file. Missing starts empty; corrupt input fails closed. */
  reload(): void {
    if (!existsSync(this.storePath)) {
      this.byId.clear();
      return;
    }

    try {
      const raw = readFileSync(this.storePath, 'utf8');
      const parsed = JSON.parse(raw) as FileOperationLogDocument | OperationLogRecord[];
      const entries = Array.isArray(parsed)
        ? parsed
        : parsed?.version === 1 && Array.isArray(parsed.entries)
          ? parsed.entries
          : null;
      if (!entries) throw new Error('Expected an array or a version=1 entries document.');
      const next = new Map<string, OperationLogRecord>();
      for (const entry of entries) {
        if (!entry || typeof entry.opId !== 'string' || !Array.isArray(entry.files)
          || !Array.isArray(entry.diagnostics)) {
          throw new Error('Operation log contains an invalid entry.');
        }
        next.set(entry.opId, cloneRecord(entry));
      }
      this.byId.clear();
      for (const [opId, entry] of next) this.byId.set(opId, entry);
    } catch (error) {
      this.byId.clear();
      throw new FileOperationLogCorruptError(
        this.storePath,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  async record(entry: OperationLogRecord): Promise<void> {
    this.byId.set(entry.opId, cloneRecord(entry));
    this.persist();
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
    this.persist();
    return cloneRecord(next);
  }

  async history(workspaceId?: string): Promise<PatchHistoryEntry[]> {
    return (await this.list(workspaceId)).map(toHistoryEntry);
  }

  private persist(): void {
    const dir = dirname(this.storePath);
    mkdirSync(dir, { recursive: true });

    const document: FileOperationLogDocument = {
      version: 1,
      entries: [...this.byId.values()].map(cloneRecord)
    };
    const payload = `${JSON.stringify(document, null, 2)}\n`;
    const tempPath = `${this.storePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, payload, 'utf8');
    renameSync(tempPath, this.storePath);
  }
}

export class FileOperationLogCorruptError extends Error {
  readonly code = 'LEGACY_OPERATION_LOG_CORRUPT';

  constructor(readonly storePath: string, reason: string) {
    super(`旧操作日志已损坏，拒绝将其当作空历史继续写入：${reason}`);
  }
}

/** Open (or create) a file-backed operation log at the given path. */
export function openFileOperationLogStore(storePath: string): FileOperationLogStore {
  return new FileOperationLogStore(storePath);
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
