import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  OperationLogRecord,
  OperationStatus,
  PatchHistoryEntry
} from '@soulforge/shared';
import type { OperationLogStore } from './operationLog.js';

interface FileOperationLogDocument {
  version: 1;
  entries: OperationLogRecord[];
}

/**
 * On-disk operation log implementing the same contract as MemoryOperationLogStore.
 * Persists to a single JSON file so commit / history / rollback survive process reopen.
 * Uses atomic temp+rename writes; no SQLite driver dependency (schema remains available for later).
 */
export class FileOperationLogStore implements OperationLogStore {
  private readonly byId = new Map<string, OperationLogRecord>();

  constructor(public readonly storePath: string) {
    this.reload();
  }

  /** Re-read the store file from disk (or start empty if missing/corrupt). */
  reload(): void {
    this.byId.clear();
    if (!existsSync(this.storePath)) return;

    try {
      const raw = readFileSync(this.storePath, 'utf8');
      const parsed = JSON.parse(raw) as FileOperationLogDocument | OperationLogRecord[];
      const entries = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.entries)
          ? parsed.entries
          : [];
      for (const entry of entries) {
        if (entry && typeof entry.opId === 'string') {
          this.byId.set(entry.opId, cloneRecord(entry));
        }
      }
    } catch {
      // Corrupt store: keep empty map so callers can re-record; do not throw on open.
      this.byId.clear();
    }
  }

  record(entry: OperationLogRecord): void {
    this.byId.set(entry.opId, cloneRecord(entry));
    this.persist();
  }

  get(opId: string): OperationLogRecord | undefined {
    const entry = this.byId.get(opId);
    return entry ? cloneRecord(entry) : undefined;
  }

  list(workspaceId?: string): OperationLogRecord[] {
    const rows = [...this.byId.values()]
      .filter((entry) => !workspaceId || entry.workspaceId === workspaceId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return rows.map(cloneRecord);
  }

  updateStatus(
    opId: string,
    status: OperationStatus,
    patch: Partial<OperationLogRecord> = {}
  ): OperationLogRecord | undefined {
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

  history(workspaceId?: string): PatchHistoryEntry[] {
    return this.list(workspaceId).map((entry) => ({
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
      changedPaths: entry.files.map((file) => file.targetPath)
    }));
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
