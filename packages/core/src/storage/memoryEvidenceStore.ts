import type {
  EventExport,
  IndexedFile,
  MapExport,
  MsgExport,
  ParamExport,
  ReferenceEdge,
  ResourceKind,
  SymbolBundle
} from '@soulforge/shared';
import type { SearchResult } from '../indexing/workspaceIndex.js';

export interface WorkspaceRecord {
  workspaceId: string;
  rootPath: string;
  game: string;
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceStoreSearchOptions {
  query: string;
  kinds?: readonly ResourceKind[];
  limit?: number;
}

export interface EvidenceStoreSymbols {
  events: EventExport[];
  maps: MapExport[];
  params: ParamExport[];
  msgs: MsgExport[];
}

export interface EvidenceStore {
  upsertWorkspace(workspace: WorkspaceRecord): void;
  getWorkspace(workspaceId: string): WorkspaceRecord | undefined;
  replaceFiles(workspaceId: string, files: readonly IndexedFile[]): void;
  getFiles(workspaceId: string): IndexedFile[];
  searchFiles(workspaceId: string, options: EvidenceStoreSearchOptions): Array<SearchResult<IndexedFile>>;
  replaceSymbols(workspaceId: string, symbols: SymbolBundle): void;
  getSymbols(workspaceId: string): EvidenceStoreSymbols;
  replaceReferences(workspaceId: string, references: readonly ReferenceEdge[]): void;
  findReferences(workspaceId: string, uri: string, direction?: 'from' | 'to' | 'both'): ReferenceEdge[];
}

export class MemoryEvidenceStore implements EvidenceStore {
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly filesByWorkspace = new Map<string, IndexedFile[]>();
  private readonly symbolsByWorkspace = new Map<string, EvidenceStoreSymbols>();
  private readonly referencesByWorkspace = new Map<string, ReferenceEdge[]>();

  upsertWorkspace(workspace: WorkspaceRecord): void {
    this.workspaces.set(workspace.workspaceId, workspace);
  }

  getWorkspace(workspaceId: string): WorkspaceRecord | undefined {
    return this.workspaces.get(workspaceId);
  }

  replaceFiles(workspaceId: string, files: readonly IndexedFile[]): void {
    this.filesByWorkspace.set(workspaceId, [...files]);
  }

  getFiles(workspaceId: string): IndexedFile[] {
    return [...(this.filesByWorkspace.get(workspaceId) ?? [])];
  }

  searchFiles(workspaceId: string, options: EvidenceStoreSearchOptions): Array<SearchResult<IndexedFile>> {
    const query = normalizeSearch(options.query);
    const limit = options.limit ?? 100;
    const kinds = options.kinds ? new Set<ResourceKind>(options.kinds) : null;
    const results: Array<SearchResult<IndexedFile>> = [];

    for (const file of this.filesByWorkspace.get(workspaceId) ?? []) {
      if (kinds && !kinds.has(file.resourceKind)) continue;
      const text = [file.relativePath, file.resourceKind, file.extension].join(' ');
      const score = scoreText(text, query);
      if (score > 0) results.push({ item: file, score, highlights: makeHighlights(text, query) });
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  replaceSymbols(workspaceId: string, symbols: SymbolBundle): void {
    this.symbolsByWorkspace.set(workspaceId, {
      events: [...(symbols.events ?? [])],
      maps: [...(symbols.maps ?? [])],
      params: [...(symbols.params ?? [])],
      msgs: [...(symbols.msgs ?? [])]
    });
  }

  getSymbols(workspaceId: string): EvidenceStoreSymbols {
    const symbols = this.symbolsByWorkspace.get(workspaceId);
    return {
      events: [...(symbols?.events ?? [])],
      maps: [...(symbols?.maps ?? [])],
      params: [...(symbols?.params ?? [])],
      msgs: [...(symbols?.msgs ?? [])]
    };
  }

  replaceReferences(workspaceId: string, references: readonly ReferenceEdge[]): void {
    this.referencesByWorkspace.set(workspaceId, [...references]);
  }

  findReferences(workspaceId: string, uri: string, direction: 'from' | 'to' | 'both' = 'both'): ReferenceEdge[] {
    return (this.referencesByWorkspace.get(workspaceId) ?? []).filter((edge) => {
      if (direction === 'from') return edge.fromUri === uri;
      if (direction === 'to') return edge.toUri === uri;
      return edge.fromUri === uri || edge.toUri === uri;
    });
  }
}

function normalizeSearch(value: string): string {
  return value
    .toLowerCase()
    .replaceAll('_', ' ')
    .replaceAll(':', ' ')
    .replaceAll('/', ' ')
    .replaceAll('\\', ' ')
    .replaceAll('.', ' ')
    .replaceAll('-', ' ')
    .split(' ')
    .filter(Boolean)
    .join(' ');
}

function scoreText(text: string, query: string): number {
  if (query.length === 0) return 1;
  const normalized = normalizeSearch(text);
  let score = 0;
  for (const term of query.split(' ').filter(Boolean)) {
    if (normalized === term) score += 100;
    else if (normalized.startsWith(term)) score += 40;
    else if (normalized.includes(term)) score += 12;
  }
  return score;
}

function makeHighlights(text: string, query: string): string[] {
  if (query.length === 0) return [];
  const normalized = normalizeSearch(text);
  return query.split(' ').filter((term) => term.length > 0 && normalized.includes(term));
}
