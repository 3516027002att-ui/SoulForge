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
  TaeAnimSymbol,
  TaeEventSymbol,
  TaeExport,
  TextEntrySymbol
} from '@soulforge/shared';
import { buildReferenceGraph, type ReferenceBuildOptions, type ReferenceBuildResult } from '../references/referenceBuilder.js';
import { collectEventEvidence, renderEventEvidenceMarkdown, type EventEvidenceReport } from '../references/eventEvidence.js';
import { ALL_RESOURCE_KINDS } from '../workspace/resourceKinds.js';
import {
  resolveBinderMembership,
  type BinderMembershipCandidate,
  type BinderMembershipQuery,
  type BinderMembershipResult
} from '../action/binderMembership.js';

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

export interface SourceInvalidationResult {
  sourceUris: string[];
  removed: {
    events: number;
    mapEntities: number;
    mapRegions: number;
    paramRows: number;
    textEntries: number;
    taeExports: number;
  };
  referencesRebuilt: number;
}

/** sourceUri + animId 的严格读取结果；重复 identity 必须显式失败关闭。 */
export type TaeAnimationLookup =
  | {
      status: 'UNIQUE';
      sourceUri: string;
      animId: number;
      animation: TaeAnimSymbol;
      sourceHash?: string;
      sourceRevision?: number;
    }
  | {
      status: 'NOT_FOUND';
      sourceUri: string;
      animId: number;
    }
  | {
      status: 'AMBIGUOUS';
      sourceUri: string;
      animId: number;
      matchCount: number;
    };

export class WorkspaceIndex {
  readonly workspaceId: string;

  private filesByUri = new Map<string, IndexedFile>();
  private eventExports: EventExport[] = [];
  private mapExports: MapExport[] = [];
  private paramExports: ParamExport[] = [];
  private msgExports: MsgExport[] = [];
  private taeExports: TaeExport[] = [];
  private references: ReferenceEdge[] = [];
  private actionBinderMembershipCandidates: BinderMembershipCandidate[] = [];
  private actionBinderMembershipReady = false;

  constructor(workspaceId: string) {
    this.workspaceId = workspaceId;
  }

  setFiles(files: readonly IndexedFile[]): void {
    this.filesByUri.clear();
    for (const file of files) this.filesByUri.set(file.sourceUri, file);
    // Binder membership carries source revisions from the file catalog. Any
    // catalog replacement invalidates that projection until the indexer has
    // rebuilt it for the same workspace session.
    this.clearActionBinderMembership();
  }

  /**
   * Install the complete ACTION binder membership projection produced by the
   * workspace indexer. Playback may query this projection, but must not scan
   * sibling ANIBND files or parse containers on demand.
   */
  setActionBinderMembership(candidates: readonly BinderMembershipCandidate[]): void {
    this.actionBinderMembershipCandidates = candidates.map((candidate) => ({
      characterFamily: candidate.characterFamily,
      source: { ...candidate.source },
      entries: candidate.entries.map((entry) => ({ ...entry }))
    }));
    this.actionBinderMembershipReady = true;
  }

  /** Drop the projection when its source catalog/session is no longer valid. */
  clearActionBinderMembership(): void {
    this.actionBinderMembershipCandidates = [];
    this.actionBinderMembershipReady = false;
  }

  isActionBinderMembershipReady(): boolean {
    return this.actionBinderMembershipReady;
  }

  lookupActionBinderMembership(query: BinderMembershipQuery): BinderMembershipResult {
    return resolveBinderMembership({
      query,
      candidates: this.actionBinderMembershipCandidates
    });
  }

  /**
   * Remove semantic projections whose provenance points at changed sources.
   * Replacing the file catalog alone proves only that bytes changed; it does
   * not prove that old decoded symbols still describe the new bytes.
   */
  invalidateChangedSources(sourceUris: readonly string[]): SourceInvalidationResult {
    const uniqueSources = [...new Set(sourceUris.filter((sourceUri) => sourceUri.trim().length > 0))];
    const changedFiles = uniqueSources
      .map((sourceUri) => findUniqueSourceFile(this.filesByUri, sourceUri))
      .filter((file): file is IndexedFile => file !== undefined);
    const isChangedSource = (sourceUri: string): boolean =>
      uniqueSources.includes(sourceUri)
      || changedFiles.some((file) => sourceUriMatchesFile(sourceUri, file));
    const removed = {
      events: 0,
      mapEntities: 0,
      mapRegions: 0,
      paramRows: 0,
      textEntries: 0,
      taeExports: 0
    };

    this.eventExports = this.eventExports.flatMap((item) => {
      const events = item.events.filter((event) => {
        const keep = !isChangedSource(event.sourceUri);
        if (!keep) removed.events += 1;
        return keep;
      });
      return events.length > 0 ? [{ ...item, events }] : [];
    });
    this.mapExports = this.mapExports.flatMap((item) => {
      const entities = item.entities.filter((entity) => {
        const keep = !isChangedSource(entity.sourceUri);
        if (!keep) removed.mapEntities += 1;
        return keep;
      });
      const regions = item.regions.filter((region) => {
        const keep = !isChangedSource(region.sourceUri);
        if (!keep) removed.mapRegions += 1;
        return keep;
      });
      return entities.length > 0 || regions.length > 0 ? [{ ...item, entities, regions }] : [];
    });
    this.paramExports = this.paramExports.flatMap((item) => {
      const rows = item.rows.filter((row) => {
        const keep = !isChangedSource(row.sourceUri);
        if (!keep) removed.paramRows += 1;
        return keep;
      });
      return rows.length > 0 ? [{ ...item, rows }] : [];
    });
    this.msgExports = this.msgExports.flatMap((item) => {
      const entries = item.entries.filter((entry) => {
        const keep = !isChangedSource(entry.sourceUri);
        if (!keep) removed.textEntries += 1;
        return keep;
      });
      return entries.length > 0 ? [{ ...item, entries }] : [];
    });
    this.taeExports = this.taeExports.filter((item) => {
      const keep = !isChangedSource(item.sourceUri);
      if (!keep) removed.taeExports += 1;
      return keep;
    });

    const referencesRebuilt = uniqueSources.length > 0 ? this.rebuildReferences().edges.length : this.references.length;
    return { sourceUris: uniqueSources, removed, referencesRebuilt };
  }

  invalidateSource(sourceUri: string): SourceInvalidationResult {
    return this.invalidateChangedSources([sourceUri]);
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
    // Row IDs are only unique inside one native source.  Keying by rowId alone
    // used to let a live read from source B overwrite source A, and could then
    // carry source A's old semantic body under source B's hash.
    const rows = new Map((existing?.rows ?? []).map((row) => [`${row.sourceUri}#${row.rowId}`, row]));
    for (const row of value.rows) rows.set(`${row.sourceUri}#${row.rowId}`, row);
    const mergedRows = [...rows.values()];
    const sourceHashes = new Set(mergedRows.map((row) => row.sourceHash).filter((item): item is string => Boolean(item)));
    const sourceRevisions = new Set(mergedRows.map((row) => row.sourceRevision).filter((item): item is number => item !== undefined));
    this.upsertParamExport({
      paramName: value.paramName,
      ...(sourceHashes.size === 1 ? { sourceHash: [...sourceHashes][0] } : {}),
      ...(sourceRevisions.size === 1 ? { sourceRevision: [...sourceRevisions][0] } : {}),
      rows: mergedRows
    });
  }

  upsertMsgExport(value: MsgExport): void {
    const key = value.category ?? 'default';
    this.msgExports = replaceByKey(this.msgExports, key, (item) => item.category ?? 'default', value);
  }

  /** Merge a partial live FMG read without erasing entries indexed earlier. */
  mergeMsgEntries(value: MsgExport): void {
    const key = value.category ?? 'default';
    const existing = this.msgExports.find((item) => (item.category ?? 'default') === key);
    // FMG IDs are also scoped by their source container/category; never merge
    // equal numeric IDs across source URIs under one stale export hash.
    const entries = new Map((existing?.entries ?? []).map((entry) => [`${entry.sourceUri}#${entry.textId}`, entry]));
    for (const entry of value.entries) entries.set(`${entry.sourceUri}#${entry.textId}`, entry);
    const mergedEntries = [...entries.values()];
    const sourceHashes = new Set(mergedEntries.map((entry) => entry.sourceHash).filter((item): item is string => Boolean(item)));
    const sourceRevisions = new Set(mergedEntries.map((entry) => entry.sourceRevision).filter((item): item is number => item !== undefined));
    this.upsertMsgExport({
      ...(value.category ? { category: value.category } : {}),
      ...(sourceHashes.size === 1 ? { sourceHash: [...sourceHashes][0] } : {}),
      ...(sourceRevisions.size === 1 ? { sourceRevision: [...sourceRevisions][0] } : {}),
      entries: mergedEntries
    });
  }

  /** 照 upsertMapExport 抄：TAE 一份 anibnd 一个 TaeExport，按 sourceUri 替换。 */
  upsertTaeExport(value: TaeExport): void {
    this.taeExports = replaceByKey(this.taeExports, value.sourceUri, (item) => item.sourceUri, value);
  }

  /**
   * 按精确 sourceUri + animId 读取一个 TAE animation identity。
   *
   * sourceUri 不做 alias/fuzzy 匹配，animId 也不跨来源合并；同一来源出现
   * 多个相同 animId 时返回 AMBIGUOUS，调用方不得取首项继续解析。
   */
  lookupTaeAnimation(sourceUri: string, animId: number): TaeAnimationLookup {
    const matches: Array<{ exportItem: TaeExport; animation: TaeAnimSymbol }> = [];
    for (const exportItem of this.taeExports) {
      if (exportItem.sourceUri !== sourceUri) continue;
      for (const animation of exportItem.animations) {
        if (animation.animId === animId) matches.push({ exportItem, animation });
      }
    }
    if (matches.length === 0) return { status: 'NOT_FOUND', sourceUri, animId };
    if (matches.length !== 1) return { status: 'AMBIGUOUS', sourceUri, animId, matchCount: matches.length };
    const match = matches[0]!;
    return {
      status: 'UNIQUE',
      sourceUri: match.exportItem.sourceUri,
      animId: match.animation.animId,
      animation: match.animation,
      ...(match.exportItem.sourceHash ? { sourceHash: match.exportItem.sourceHash } : {}),
      ...(match.exportItem.sourceRevision !== undefined ? { sourceRevision: match.exportItem.sourceRevision } : {})
    };
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

  /** Exact event lookup used after the caller has resolved a source file. */
  lookupEvents(eventId: number, sourceUri?: string): EventSymbol[] {
    return this.eventExports
      .flatMap((item) => item.events)
      .filter((event) => event.eventId === eventId
        && (sourceUri === undefined || event.sourceUri === sourceUri));
  }

  searchMapEntities(query: string, limit = 100): Array<SearchResult<MapEntitySymbol | MapRegionSymbol>> {
    return searchSymbols(this.mapExports.flatMap((item) => [...item.entities, ...item.regions]), query, limit, mapSymbolSearchText);
  }

  searchParamRows(query: string, limit = 100, paramNames?: readonly string[]): Array<SearchResult<ParamRowSymbol>> {
    const allowed = paramNames && paramNames.length > 0
      ? new Set(paramNames.map(normalizeParamName))
      : null;
    const rows = this.paramExports
      .filter((item) => allowed === null || allowed.has(normalizeParamName(item.paramName)))
      .flatMap((item) => item.rows);
    return searchSymbols(rows, query, limit, paramRowSearchText);
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
    return findUniqueSourceFile(this.filesByUri, uri);
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

/**
 * A scanned workspace owns relative `file://...` URIs, while a live Bridge
 * read can report an absolute `file:///C:/...` URI.  Treat both as the same
 * source only when the indexed file proves the correspondence; comparing URI
 * strings alone leaves stale symbols behind after a native commit.
 */
function sourceUriMatchesFile(sourceUri: string, file: IndexedFile): boolean {
  const sourceKeys = sourceReferenceKeys(sourceUri);
  const fileKeys = new Set([
    ...sourceReferenceKeys(file.sourceUri),
    ...sourceReferenceKeys(file.sourcePath),
    ...sourceReferenceKeys(file.relativePath),
    ...sourceReferenceKeys(file.absolutePath)
  ]);
  return [...sourceKeys].some((key) => fileKeys.has(key));
}

/**
 * Resolve a source alias only when it identifies one indexed file.  A
 * relative path is not enough to choose between two roots accidentally
 * merged into one index; returning undefined keeps reads and invalidation
 * fail-closed instead of silently selecting the first insertion.
 */
function findUniqueSourceFile(filesByUri: ReadonlyMap<string, IndexedFile>, sourceUri: string): IndexedFile | undefined {
  const direct = filesByUri.get(sourceUri);
  if (direct) return direct;
  const matches = [...filesByUri.values()].filter((file) => sourceUriMatchesFile(sourceUri, file));
  return matches.length === 1 ? matches[0] : undefined;
}

function sourceReferenceKeys(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) return [];
  const keys = new Set<string>();
  const add = (candidate: string): void => {
    const normalized = candidate
      .replaceAll('\\', '/')
      .replace(/^\/+([A-Za-z]:\/)/, '$1')
      .replace(/^\.\//, '')
      .replace(/\/+/g, '/')
      .replace(/\/$/, '')
      .toLowerCase();
    if (normalized.length > 0) keys.add(normalized);
  };

  add(trimmed);
  if (/^file:\/\//i.test(trimmed)) {
    let pathPart = trimmed.slice('file://'.length);
    if (/^localhost\//i.test(pathPart)) pathPart = pathPart.slice('localhost/'.length);
    try {
      pathPart = decodeURIComponent(pathPart);
    } catch {
      // Keep the encoded fallback. Diagnostics should not make invalidation fail.
    }
    add(pathPart);
  }
  return [...keys];
}

function eventSearchText(event: EventSymbol): string {
  return [event.uri, event.eventId, event.name, event.mapId, event.instructions.map((item) => item.name).join(' ')].filter(Boolean).join(' ');
}

function mapSymbolSearchText(symbol: MapEntitySymbol | MapRegionSymbol): string {
  return [symbol.uri, symbol.entityId, symbol.name, symbol.mapId, 'kind' in symbol ? symbol.kind : undefined, 'model' in symbol ? symbol.model : undefined].filter(Boolean).join(' ');
}

function paramRowSearchText(row: ParamRowSymbol): string {
  return [
    row.uri,
    row.paramName,
    row.rowId,
    row.rowName,
    row.fields?.map((field) => [
      field.fieldId,
      field.name,
      field.description,
      String(field.value)
    ].filter(Boolean).join(':')).join(' ')
  ].filter(Boolean).join(' ');
}

function normalizeParamName(value: string): string {
  return value
    .replace(/\\/g, '/')
    .split('/')
    .pop()!
    .replace(/\.param$/i, '')
    .toLocaleLowerCase();
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
