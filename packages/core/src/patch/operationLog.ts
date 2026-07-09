import type {
  Diagnostic,
  FileOperationRecord,
  OperationLogRecord,
  OperationStatus,
  PatchHistoryEntry,
  PatchMode,
  PatchProposal
} from '@soulforge/shared';
import type { GraphPatch } from '@soulforge/shared';

export interface RecordCommittedOperationInput {
  proposal: PatchProposal;
  backupRoot: string;
  files: FileOperationRecord[];
  diagnostics: Diagnostic[];
  graph?: GraphPatch;
}

export interface OperationLogStore {
  record(entry: OperationLogRecord): void;
  get(opId: string): OperationLogRecord | undefined;
  list(workspaceId?: string): OperationLogRecord[];
  updateStatus(opId: string, status: OperationStatus, patch?: Partial<OperationLogRecord>): OperationLogRecord | undefined;
  history(workspaceId?: string): PatchHistoryEntry[];
}

/**
 * In-memory operation log used until the desktop main process wires SQLite.
 * Semantics match the v0.5 operation / file rollback model.
 */
export class MemoryOperationLogStore implements OperationLogStore {
  private readonly byId = new Map<string, OperationLogRecord>();

  record(entry: OperationLogRecord): void {
    this.byId.set(entry.opId, cloneRecord(entry));
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
}

const defaultStore = new MemoryOperationLogStore();

export function getDefaultOperationLogStore(): MemoryOperationLogStore {
  return defaultStore;
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
