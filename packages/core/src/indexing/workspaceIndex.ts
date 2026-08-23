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
  TaeEventSymbol,
  TaeExport,
  TextEntrySymbol
} from '@soulforge/shared';
import { buildReferenceGraph, type ReferenceBuildOptions, type ReferenceBuildResult } from '../references/referenceBuilder.js';
import { collectEventEvidence, renderEventEvidenceMarkdown, type EventEvidenceReport } from '../references/eventEvidence.js';
import { ALL_RESOURCE_KINDS } from '../workspace/resourceKinds.js';

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
  textEntriesByConfidence: {
    high: number;
    medium: number;
    low: number;
    unknown: number;
  };
  references: number;
}

export class WorkspaceIndex {
  readonly workspaceId: string;

  private filesByUri = new Map<string, IndexedFile>();
  private eventExports: EventExport[] = [];
  private mapExports: MapExport[] = [];
  private paramExports: ParamExport[] = [];
  private msgExports: MsgExport[] = [];
  private taeExports: TaeExport[] = [];
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

  /** Merge a partial live PARAM read without erasing rows indexed earlier. */
  mergeParamRows(value: ParamExport): void {
    const key = value.paramName.toLowerCase();
    const existing = this.paramExports.find((item) => item.paramName.toLowerCase() === key);
    const rows = new Map((existing?.rows ?? []).map((row) => [row.rowId, row]));
    for (const row of value.rows) rows.set(row.rowId, row);
    this.upsertParamExport({ paramName: value.paramName, rows: [...rows.values()] });
  }

  upsertMsgExport(value: MsgExport): void {
    const key = value.category ?? 'default';
    this.msgExports = replaceByKey(this.msgExports, key, (item) => item.category ?? 'default', value);
  }

  /** Merge a partial live FMG read without erasing entries indexed earlier. */
  mergeMsgEntries(value: MsgExport): void {
    const key = value.category ?? 'default';
    const existing = this.msgExports.find((item) => (item.category ?? 'default') === key);
    const entries = new Map((existing?.entries ?? []).map((entry) => [entry.textId, entry]));
    for (const entry of value.entries) entries.set(entry.textId, entry);
    this.upsertMsgExport({ ...(value.category ? { category: value.category } : {}), entries: [...entries.values()] });
  }

  /** 照 upsertMapExport 抄：TAE 一份 anibnd 一个 TaeExport，按 sourceUri 替换。 */
  upsertTaeExport(value: TaeExport): void {
    this.taeExports = replaceByKey(this.taeExports, value.sourceUri, (item) => item.sourceUri, value);
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
      ...(this.msgExports.length > 0 ? { msgs: this.msgExports } : {}),
      ...(this.taeExports.length > 0 ? { tae: this.taeExports } : {})
    };
  }

  getStats(): WorkspaceIndexStats {
    const filesByKind = emptyKindCounts();
    for (const file of this.filesByUri.values()) filesByKind[file.resourceKind] += 1;

    const textEntries = this.msgExports.flatMap((item) => item.entries);

    return {
      files: this.filesByUri.size,
      filesByKind,
      events: this.eventExports.reduce((sum, item) => sum + item.events.length, 0),
      mapEntities: this.mapExports.reduce((sum, item) => sum + item.entities.length, 0),
      mapRegions: this.mapExports.reduce((sum, item) => sum + item.regions.length, 0),
      paramRows: this.paramExports.reduce((sum, item) => sum + item.rows.length, 0),
      textEntries: textEntries.length,
      textEntriesByConfidence: {
        high: textEntries.filter((entry) => entry.confidence === 'high').length,
        medium: textEntries.filter((entry) => entry.confidence === 'medium').length,
        low: textEntries.filter((entry) => entry.confidence === 'low').length,
        unknown: textEntries.filter((entry) => !entry.confidence).length
      },
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
      const text = [
        file.relativePath,
        file.resourceKind,
        file.extension,
        file.compoundExtension,
        file.formatKind,
        file.formatLabel
      ].join(' ');
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

  /** 问题 6-C/D：按地址（action://c1050/A0200/e0 / c1050#A0200.e0）、类型名与字段值搜 TAE 词条。 */
  searchTaeEvents(query: string, limit = 100): Array<SearchResult<TaeEventSymbol>> {
    const events = this.taeExports.flatMap((item) => item.animations.flatMap((anim) => anim.events));
    return searchSymbols(events, query, limit, taeEventSearchText);
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

  getFiles(): IndexedFile[] {
    return [...this.filesByUri.values()];
  }

  getFile(uri: string): IndexedFile | undefined {
    return this.filesByUri.get(uri);
  }

  listReferences(): ReferenceEdge[] {
    return [...this.references];
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

const SEKIRO_SEARCH_SYNONYMS: ReadonlyArray<[RegExp, string]> = [
  [/鬼[刑型]部/g, '鬼形部 鬼庭形部雅孝 50800000 Gyoubu'],
  [/形部/g, '鬼形部 鬼庭形部雅孝 50800000 Gyoubu'],
  [/雅孝/g, '鬼庭形部雅孝 50800000'],
  [/蝴蝶夫人|阿蝶/g, '幻影之蝶 50900000 Butterfly'],
  [/弦一郎/g, '苇名弦一郎 51100000 11000000 Genichiro'],
  [/狮子猿/g, '狮子猿 51000000 51000100 Ape Guardian'],
  [/巨型忍者|义父|枭/g, '巨型忍者 枭 50600000 50601000 Father Owl'],
  [/一心|剑圣/g, '苇名一心 剑圣 54000000 54300000 Isshin'],
  [/破戒僧/g, '破戒僧 50000000 50100000 Monk'],
  [/赤鬼/g, '赤鬼 50210000 50210080 Ogre'],
  [/火牛|樱牛/g, '火牛 樱牛 50100000 50100100 Bull'],
  [/佐濑甚助|居合哥/g, '佐濑甚助 10100000 Jinsuke']
];

function expandSearchQuery(query: string): string {
  let expanded = query;
  for (const [pattern, replacement] of SEKIRO_SEARCH_SYNONYMS) {
    if (pattern.test(query)) {
      expanded += ` ${replacement}`;
    }
  }
  return expanded;
}

function searchSymbols<T>(items: T[], query: string, limit: number, toText: (item: T) => string): Array<SearchResult<T>> {
  const expandedQuery = expandSearchQuery(query);
  const normalized = normalizeSearch(expandedQuery);
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
    else if (term.length >= 2) {
      let cjkMatchCount = 0;
      for (const ch of term) {
        if (/[\u4e00-\u9fa5]/.test(ch) && normalized.includes(ch)) {
          cjkMatchCount++;
        }
      }
      if (cjkMatchCount >= 2) {
        score += cjkMatchCount * 3;
      }
    }
  }
  return score;
}

function makeHighlights(text: string, query: string): string[] {
  if (query.length === 0) return [];
  const normalized = normalizeSearch(text);
  const terms = query.split(' ').filter(Boolean);
  const highlights: string[] = [];
  for (const term of terms) {
    if (term.length > 0 && normalized.includes(term)) {
      highlights.push(term);
    } else {
      for (const ch of term) {
        if (/[\u4e00-\u9fa5]/.test(ch) && normalized.includes(ch)) {
          highlights.push(ch);
        }
      }
    }
  }
  return [...new Set(highlights)];
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
  return [entry.uri, entry.category, entry.textId, entry.confidence, entry.text].filter(Boolean).join(' ');
}

function taeEventSearchText(event: TaeEventSymbol): string {
  return [
    event.uri,
    event.index,
    event.eventTypeId,
    event.typeName,
    event.startFrame,
    event.endFrame,
    ...(event.fields ?? []).map((field) => `${field.name}:${String(field.value)}`)
  ].filter((value) => value !== undefined && value !== null && String(value).length > 0).join(' ');
}

function emptyKindCounts(): Record<ResourceKind, number> {
  return Object.fromEntries(ALL_RESOURCE_KINDS.map((kind) => [kind, 0])) as Record<ResourceKind, number>;
}

function replaceByKey<T>(items: T[], key: string, selectKey: (item: T) => string, value: T): T[] {
  const index = items.findIndex((item) => selectKey(item) === key);
  if (index === -1) return [...items, value];
  const copy = [...items];
  copy[index] = value;
  return copy;
}
