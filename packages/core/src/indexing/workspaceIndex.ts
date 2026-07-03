import type {
  EventExport,
  EventSymbol,
  IndexedFile,
  MapEntitySymbol,
  MapExport,
  MapRegionSymbol,
  MsgExport,
  ParamExport,
  ParamRowSymbol,
  ReferenceEdge,
  ResourceKind,
  SymbolBundle,
  TextEntrySymbol
} from '@soulforge/shared';
import { buildReferenceGraph, type ReferenceBuildOptions, type ReferenceBuildResult } from '../references/referenceBuilder.js';
import { collectEventEvidence, renderEventEvidenceMarkdown, type EventEvidenceReport } from '../references/eventEvidence.js';

export interface SearchResourcesOptions {
  query: string;
  kinds?: readonly ResourceKind[];
  limit?: number;
}

export interface SearchResult<T> {
  item: T;
  score: number;
  highlights: string[];
}

export interface EventExplanationInput {
  event: EventSymbol;
  report: EventEvidenceReport;
  markdown: string;
  references: ReferenceEdge[];
}

export interface WorkspaceIndexStats {
  files: number;
  filesByKind: Record<ResourceKind, number>;
  events: number;
  mapEntities: number;
  mapRegions: number;
  paramRows: number;
  textEntries: number;
  references: number;
}

export class WorkspaceIndex {
  readonly workspaceId: string;

  private filesByUri = new Map<string, IndexedFile>();
  private eventExports: EventExport[] = [];
  private mapExports: MapExport[] = [];
  private paramExports: ParamExport[] = [];
  private msgExports: MsgExport[] = [];
  private references: ReferenceEdge[] = [];

  constructor(workspaceId: string) {
    this.workspaceId = workspaceId;
  }

  setFiles(files: readonly IndexedFile[]): void {
    this.filesByUri.clear();
    for (const file of files) this.filesByUri.set(file.sourceUri, file);
  }

  upsertEventExport(value: EventExport): void {
    const key = value.mapId ?? value.events[0]?.sourceUri ?? value.events[0]?.uri ?? 'unknown';
    this.eventExports = replaceByKey(this.eventExports, key, (item) => item.mapId ?? item.events[0]?.sourceUri ?? item.events[0]?.uri ?? 'unknown', value);
  }

  upsertMapExport(value: MapExport): void {
    this.mapExports = replaceByKey(this.mapExports, value.mapId, (item) => item.mapId, value);
  }

  upsertParamExport(value: ParamExport): void {
    this.paramExports = replaceByKey(this.paramExports, value.paramName.toLowerCase(), (item) => item.paramName.toLowerCase(), value);
  }

  upsertMsgExport(value: MsgExport): void {
    const key = value.category ?? 'default';
    this.msgExports = replaceByKey(this.msgExports, key, (item) => item.category ?? 'default', value);
  }

  rebuildReferences(options: ReferenceBuildOptions = {}): ReferenceBuildResult {
    const result = buildReferenceGraph(this.toSymbolBundle(), options);
    this.references = result.edges;
    return result;
  }

  toSymbolBundle(): SymbolBundle {
    return {
      ...(this.eventExports.length > 0 ? { events: this.eventExports } : {}),
      ...(this.mapExports.length > 0 ? { maps: this.mapExports } : {}),
      ...(this.paramExports.length > 0 ? { params: this.paramExports } : {}),
      ...(this.msgExports.length > 0 ? { msgs: this.msgExports } : {})
    };
  }

  getStats(): WorkspaceIndexStats {
    const filesByKind = emptyKindCounts();
    for (const file of this.filesByUri.values()) filesByKind[file.resourceKind] += 1;

    return {
      files: this.filesByUri.size,
      filesByKind,
      events: this.eventExports.reduce((sum, item) => sum + item.events.length, 0),
      mapEntities: this.mapExports.reduce((sum, item) => sum + item.entities.length, 0),
      mapRegions: this.mapExports.reduce((sum, item) => sum + item.regions.length, 0),
      paramRows: this.paramExports.reduce((sum, item) => sum + item.rows.length, 0),
      textEntries: this.msgExports.reduce((sum, item) => sum + item.entries.length, 0),
      references: this.references.length
    };
  }

  searchResources(options: SearchResourcesOptions): Array<SearchResult<IndexedFile>> {
    const query = normalizeSearch(options.query);
    const limit = options.limit ?? 100;
    const kinds = options.kinds ? new Set<ResourceKind>(options.kinds) : null;
    const results: Array<SearchResult<IndexedFile>> = [];

    for (const file of this.filesByUri.values()) {
      if (kinds && !kinds.has(file.resourceKind)) continue;
      const text = [file.relativePath, file.resourceKind, file.extension].join(' ');
      const score = scoreText(text, query);
      if (score > 0) results.push({ item: file, score, highlights: makeHighlights(text, query) });
    }

    return sortAndLimit(results, limit);
  }

  searchEvents(query: string, limit = 100): Array<SearchResult<EventSymbol>> {
    return searchSymbols(this.eventExports.flatMap((item) => item.events), query, limit, eventSearchText);
  }

  searchMapEntities(query: string, limit = 100): Array<SearchResult<MapEntitySymbol | MapRegionSymbol>> {
    return searchSymbols(this.mapExports.flatMap((item) => [...item.entities, ...item.regions]), query, limit, mapSymbolSearchText);
  }

  searchParamRows(query: string, limit = 100): Array<SearchResult<ParamRowSymbol>> {
    return searchSymbols(this.paramExports.flatMap((item) => item.rows), query, limit, paramRowSearchText);
  }

  searchTextEntries(query: string, limit = 100): Array<SearchResult<TextEntrySymbol>> {
    return searchSymbols(this.msgExports.flatMap((item) => item.entries), query, limit, textEntrySearchText);
  }

  lookupTextEntries(textId: number, category?: string): TextEntrySymbol[] {
    const normalizedCategory = category?.toLowerCase();
    const matches: TextEntrySymbol[] = [];
    for (const exportItem of this.msgExports) {
      if (normalizedCategory && (exportItem.category ?? 'default').toLowerCase() !== normalizedCategory) continue;
      matches.push(...exportItem.entries.filter((entry) => entry.textId === textId));
    }
    return matches;
  }

  lookupTextEntry(textId: number, category?: string): TextEntrySymbol | undefined {
    return this.lookupTextEntries(textId, category)[0];
  }

  getFile(uri: string): IndexedFile | undefined {
    return this.filesByUri.get(uri);
  }

  getEvent(uri: string): EventSymbol | undefined {
    for (const eventExport of this.eventExports) {
      const found = eventExport.events.find((event) => event.uri === uri);
      if (found) return found;
    }
    return undefined;
  }

  findReferences(uri: string, direction: 'from' | 'to' | 'both' = 'both'): ReferenceEdge[] {
    return this.references.filter((edge) => {
      if (direction === 'from') return edge.fromUri === uri;
      if (direction === 'to') return edge.toUri === uri;
      return edge.fromUri === uri || edge.toUri === uri;
    });
  }

  buildEventExplanationInput(uri: string): EventExplanationInput | null {
    const event = this.getEvent(uri);
    if (!event) return null;
    const references = this.findReferences(event.uri, 'from');
    const report = collectEventEvidence(event, references);
    return { event, report, markdown: renderEventEvidenceMarkdown(report), references };
  }
}

function searchSymbols<T>(items: T[], query: string, limit: number, toText: (item: T) => string): Array<SearchResult<T>> {
  const normalized = normalizeSearch(query);
  const results: Array<SearchResult<T>> = [];
  for (const item of items) {
    const text = toText(item);
    const score = scoreText(text, normalized);
    if (score > 0) results.push({ item, score, highlights: makeHighlights(text, normalized) });
  }
  return sortAndLimit(results, limit);
}

function scoreText(text: string, query: string): number {
  if (query.length === 0) return 1;
  const normalized = normalizeSearch(text);
  const terms = query.split(' ').filter(Boolean);
  let score = 0;
  for (const term of terms) {
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

function sortAndLimit<T>(results: Array<SearchResult<T>>, limit: number): Array<SearchResult<T>> {
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

function normalizeSearch(value: string): string {
  return value.toLowerCase().replaceAll('_', ' ').replaceAll(':', ' ').replaceAll('/', ' ').replaceAll('\\', ' ').replaceAll('.', ' ').replaceAll('-', ' ').split(' ').filter(Boolean).join(' ');
}

function eventSearchText(event: EventSymbol): string {
  return [event.uri, event.eventId, event.name, event.mapId, event.instructions.map((item) => item.name).join(' ')].filter(Boolean).join(' ');
}

function mapSymbolSearchText(symbol: MapEntitySymbol | MapRegionSymbol): string {
  return [symbol.uri, symbol.entityId, symbol.name, symbol.mapId, 'kind' in symbol ? symbol.kind : undefined, 'model' in symbol ? symbol.model : undefined].filter(Boolean).join(' ');
}

function paramRowSearchText(row: ParamRowSymbol): string {
  return [row.uri, row.paramName, row.rowId, row.rowName, row.fields?.map((field) => `${field.name}:${String(field.value)}`).join(' ')].filter(Boolean).join(' ');
}

function textEntrySearchText(entry: TextEntrySymbol): string {
  return [entry.uri, entry.category, entry.textId, entry.text].filter(Boolean).join(' ');
}

function emptyKindCounts(): Record<ResourceKind, number> {
  return {
    event: 0,
    map: 0,
    param: 0,
    msg: 0,
    menu: 0,
    script: 0,
    action: 0,
    ai: 0,
    sfx: 0,
    unknown: 0
  };
}

function replaceByKey<T>(items: T[], key: string, selectKey: (item: T) => string, value: T): T[] {
  const index = items.findIndex((item) => selectKey(item) === key);
  if (index === -1) return [...items, value];
  const copy = [...items];
  copy[index] = value;
  return copy;
}
