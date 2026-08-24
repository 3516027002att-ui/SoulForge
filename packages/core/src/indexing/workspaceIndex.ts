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
import type { CanonicalEntity } from '../semantic/types.js';
import {
  type CanonicalProjectionEntry,
  type CanonicalProjectionResolution,
  type CanonicalProjectionStale,
  type CanonicalProjectionSuppressed,
  type CanonicalSuppressionProjection,
  type DirtyCanonicalDocument,
  type DirtyCanonicalDocumentErrorCode,
  type DirtyCanonicalDocumentInput,
  type DirtyCanonicalDocumentMutationResult,
  selectEffectiveCanonicalProjection,
  type CanonicalProjection
} from '../semantic/canonicalPrecedence.js';

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
  private readonly canonicalProjections = new Map<string, CanonicalProjection<CanonicalEntity>[]>();
  private readonly dirtyCanonicalDocuments = new Map<string, DirtyCanonicalDocument<CanonicalEntity>>();
  private readonly dirtyCanonicalTombstones = new Map<string, CanonicalSuppressionProjection[]>();

  constructor(workspaceId: string) {
    this.workspaceId = workspaceId;
  }

  /**
   * Register an observed dirty canonical document.
   *
   * The caller must have completed a canonical read.  A plan, PatchIR or
   * model proposal has no accepted shape here and therefore cannot become an
   * observed index fact.  The current indexed file revision is checked before
   * the snapshot is installed.
   */
  registerDirtyCanonicalDocument(
    input: DirtyCanonicalDocumentInput<CanonicalEntity>
  ): DirtyCanonicalDocumentMutationResult<CanonicalEntity> {
    const validation = validateDirtyCanonicalDocumentInput(input);
    if (validation.length > 0) return dirtyFailure('DIRTY_CANONICAL_INVALID_INPUT', validation);
    if (this.dirtyCanonicalDocuments.has(input.documentId)) {
      return dirtyFailure('DIRTY_CANONICAL_DUPLICATE', [`dirty canonical document 已注册：${input.documentId}`]);
    }
    const currentRevision = this.getAuthoritativeSourceRevision(input.sourceUri);
    if (!currentRevision) {
      return dirtyFailure('DIRTY_CANONICAL_SOURCE_NOT_INDEXED', [`source 没有可校验的 indexed sha256：${input.sourceUri}`]);
    }
    if (currentRevision !== input.baseRevision) {
      return dirtyFailure(
        'DIRTY_CANONICAL_BASE_REVISION_CONFLICT',
        [`dirty canonical 注册拒绝：base revision ${input.baseRevision} != 当前 indexed revision ${currentRevision}`],
        input.baseRevision,
        currentRevision
      );
    }
    const document = normalizeDirtyCanonicalDocument(input);
    this.dirtyCanonicalDocuments.set(document.documentId, document);
    this.installDirtyCanonicalDocument(document);
    return { ok: true, document: cloneDirtyCanonicalDocument(document) };
  }

  /**
   * Compare-and-swap update for one editor working copy.  The document id and
   * base source revision are immutable for the lifetime of the dirty record.
   */
  updateDirtyCanonicalDocument(
    documentId: string,
    expectedRevision: string,
    input: Omit<DirtyCanonicalDocumentInput<CanonicalEntity>, 'documentId'>
  ): DirtyCanonicalDocumentMutationResult<CanonicalEntity> {
    const current = this.dirtyCanonicalDocuments.get(documentId);
    if (!current) return dirtyFailure('DIRTY_CANONICAL_NOT_FOUND', [`找不到 dirty canonical document：${documentId}`]);
    if (current.revision !== expectedRevision) {
      return dirtyFailure(
        'DIRTY_CANONICAL_REVISION_CONFLICT',
        [`dirty canonical 更新拒绝：expected ${expectedRevision} != 当前 working revision ${current.revision}`],
        expectedRevision,
        current.revision
      );
    }
    if (input.sourceUri !== current.sourceUri || input.baseRevision !== current.baseRevision) {
      return dirtyFailure(
        'DIRTY_CANONICAL_BASE_REVISION_CONFLICT',
        ['dirty canonical document 不允许在 update 时改绑 source 或 base revision。'],
        current.baseRevision,
        input.baseRevision
      );
    }
    const validation = validateDirtyCanonicalDocumentInput({ ...input, documentId });
    if (validation.length > 0) return dirtyFailure('DIRTY_CANONICAL_INVALID_INPUT', validation);
    const sourceRevision = this.getAuthoritativeSourceRevision(current.sourceUri);
    if (!sourceRevision) {
      return dirtyFailure('DIRTY_CANONICAL_SOURCE_NOT_INDEXED', [`source 没有可校验的 indexed sha256：${current.sourceUri}`]);
    }
    if (sourceRevision !== current.baseRevision) {
      return dirtyFailure(
        'DIRTY_CANONICAL_BASE_REVISION_CONFLICT',
        [`dirty canonical 更新拒绝：base revision ${current.baseRevision} 已被推进到 ${sourceRevision}`],
        current.baseRevision,
        sourceRevision
      );
    }
    const document = normalizeDirtyCanonicalDocument({ ...input, documentId });
    this.removeDirtyCanonicalDocumentProjection(current);
    this.dirtyCanonicalDocuments.set(document.documentId, document);
    this.installDirtyCanonicalDocument(document);
    return { ok: true, document: cloneDirtyCanonicalDocument(document) };
  }

  /**
   * Clear a dirty document only with a revision CAS.  `discarded` requires the
   * original base revision to remain current.  `committed` is only accepted
   * after the caller has indexed the authoritative post-commit reread and
   * supplies that exact revision.
   */
  clearDirtyCanonicalDocument(input: {
    documentId: string;
    expectedRevision: string;
    mode: 'discarded' | 'committed';
    authoritativeRevision?: string;
  }): DirtyCanonicalDocumentMutationResult<CanonicalEntity> {
    const current = this.dirtyCanonicalDocuments.get(input.documentId);
    if (!current) return dirtyFailure('DIRTY_CANONICAL_NOT_FOUND', [`找不到 dirty canonical document：${input.documentId}`]);
    if (current.revision !== input.expectedRevision) {
      return dirtyFailure(
        'DIRTY_CANONICAL_REVISION_CONFLICT',
        [`dirty canonical 清理拒绝：expected ${input.expectedRevision} != 当前 working revision ${current.revision}`],
        input.expectedRevision,
        current.revision
      );
    }
    const sourceRevision = this.getAuthoritativeSourceRevision(current.sourceUri);
    if (!sourceRevision) {
      return dirtyFailure('DIRTY_CANONICAL_SOURCE_NOT_INDEXED', [`source 没有可校验的 indexed sha256：${current.sourceUri}`]);
    }
    if (input.mode === 'discarded') {
      if (sourceRevision !== current.baseRevision) {
        return dirtyFailure(
          'DIRTY_CANONICAL_BASE_REVISION_CONFLICT',
          [`dirty canonical 丢弃拒绝：base revision ${current.baseRevision} 已被推进到 ${sourceRevision}`],
          current.baseRevision,
          sourceRevision
        );
      }
    } else {
      if (!input.authoritativeRevision || sourceRevision !== input.authoritativeRevision) {
        return dirtyFailure(
          'DIRTY_CANONICAL_AUTHORITATIVE_REVISION_CONFLICT',
          [`提交后的 authoritative reread revision 与当前 index 不一致：${input.authoritativeRevision ?? '<missing>'} != ${sourceRevision}`],
          input.authoritativeRevision,
          sourceRevision
        );
      }
    }
    this.removeDirtyCanonicalDocumentProjection(current);
    this.dirtyCanonicalDocuments.delete(current.documentId);
    return { ok: true, document: cloneDirtyCanonicalDocument(current) };
  }

  getDirtyCanonicalDocument(documentId: string): DirtyCanonicalDocument<CanonicalEntity> | undefined {
    const document = this.dirtyCanonicalDocuments.get(documentId);
    return document ? cloneDirtyCanonicalDocument(document) : undefined;
  }

  listDirtyCanonicalDocuments(): DirtyCanonicalDocument<CanonicalEntity>[] {
    return [...this.dirtyCanonicalDocuments.values()].map(cloneDirtyCanonicalDocument);
  }

  /**
   * Safe default for semantic callers: only observed, effective dirty values.
   * Stale, suppressed and conflicting snapshots are deliberately excluded.
   */
  listDirtyCanonicalEntities(): CanonicalEntity[] {
    return this.listEffectiveDirtyCanonicalEntities();
  }

  /**
   * Diagnostic-only view used to explain a conflict.  It is not an observed
   * fact source and must never be used to satisfy a resolver or completion
   * predicate without selectCanonicalProjection.
   */
  listRawDirtyCanonicalEntities(): CanonicalEntity[] {
    return [...this.dirtyCanonicalDocuments.values()].flatMap((document) => document.entities.map(cloneCanonicalEntity));
  }

  /** Only non-conflicting, non-stale dirty values may enter semantic resolution. */
  listEffectiveDirtyCanonicalEntities(): CanonicalEntity[] {
    const entities: CanonicalEntity[] = [];
    for (const document of this.dirtyCanonicalDocuments.values()) {
      for (const entity of document.entities) {
        const selection = this.selectCanonicalProjection(entity.identity);
        if (selection.status === 'resolved' && selection.projection.documentId === document.documentId) {
          entities.push(cloneCanonicalEntity(selection.projection.value));
        }
      }
    }
    return uniqueCanonicalEntities(entities);
  }

  selectCanonicalProjection(identity: string): CanonicalProjectionResolution<CanonicalEntity> {
    const projections = this.canonicalProjections.get(identity) ?? [];
    const tombstones = this.dirtyCanonicalTombstones.get(identity) ?? [];
    const entries: CanonicalProjectionEntry<CanonicalEntity>[] = [...projections, ...tombstones];
    const stale = this.staleDirtyProjection(entries);
    if (stale) return cloneCanonicalProjectionResolution(stale);

    // A dirty value and a dirty tombstone for one identity come from
    // different working documents (the input validator rejects both in one
    // document).  Neither may silently win over the other.
    if (tombstones.length > 0 && projections.some((projection) => projection.layer === 'dirty')) {
      return cloneCanonicalProjectionResolution({ status: 'conflict', projections: entries });
    }
    const selection = selectEffectiveCanonicalProjection(projections);
    if (selection.status !== 'empty') return cloneCanonicalProjectionResolution(selection);
    if (tombstones.length === 0) return selection;

    const revisions = new Set(tombstones.map((projection) => projection.revision));
    const documentIds = new Set(tombstones.map((projection) => projection.documentId));
    if (revisions.size > 1 || documentIds.size > 1) {
      return cloneCanonicalProjectionResolution({ status: 'conflict', projections: tombstones });
    }
    const selected = [...tombstones].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]!;
    const suppressed: CanonicalProjectionSuppressed = {
      status: 'suppressed',
      identity,
      documentIds: [selected.documentId],
      revision: selected.revision,
      updatedAt: selected.updatedAt
    };
    return cloneCanonicalProjectionResolution(suppressed);
  }

  /** Returns a dirty projection only when it is observed and conflict-free. */
  getEffectiveCanonicalEntity(identity: string): CanonicalEntity | undefined {
    const selection = this.selectCanonicalProjection(identity);
    return selection.status === 'resolved' ? cloneCanonicalEntity(selection.projection.value) : undefined;
  }

  private getAuthoritativeSourceRevision(sourceUri: string): string | undefined {
    const revision = this.filesByUri.get(sourceUri)?.sha256;
    return typeof revision === 'string' && revision.length > 0 ? revision : undefined;
  }

  private installDirtyCanonicalDocument(document: DirtyCanonicalDocument<CanonicalEntity>): void {
    for (const entity of document.entities) {
      const projections = this.canonicalProjections.get(entity.identity) ?? [];
      projections.push({
        identity: entity.identity,
        revision: document.revision,
        layer: 'dirty',
        value: cloneCanonicalEntity(entity),
        updatedAt: document.updatedAt,
        documentId: document.documentId,
        sourceUri: document.sourceUri,
        baseRevision: document.baseRevision,
        observation: 'canonical-read'
      });
      this.canonicalProjections.set(entity.identity, projections);
    }
    for (const identity of document.removedIdentities) {
      const tombstones = this.dirtyCanonicalTombstones.get(identity) ?? [];
      tombstones.push({
        identity,
        revision: document.revision,
        layer: 'dirty',
        documentId: document.documentId,
        sourceUri: document.sourceUri,
        baseRevision: document.baseRevision,
        updatedAt: document.updatedAt,
        observation: 'canonical-read'
      });
      this.dirtyCanonicalTombstones.set(identity, tombstones);
    }
  }

  private removeDirtyCanonicalDocumentProjection(document: DirtyCanonicalDocument<CanonicalEntity>): void {
    for (const entity of document.entities) {
      const projections = (this.canonicalProjections.get(entity.identity) ?? [])
        .filter((projection) => projection.documentId !== document.documentId);
      if (projections.length === 0) this.canonicalProjections.delete(entity.identity);
      else this.canonicalProjections.set(entity.identity, projections);
    }
    for (const identity of document.removedIdentities) {
      const tombstones = (this.dirtyCanonicalTombstones.get(identity) ?? [])
        .filter((projection) => projection.documentId !== document.documentId);
      if (tombstones.length === 0) this.dirtyCanonicalTombstones.delete(identity);
      else this.dirtyCanonicalTombstones.set(identity, tombstones);
    }
  }

  private staleDirtyProjection(
    entries: readonly CanonicalProjectionEntry<CanonicalEntity>[]
  ): CanonicalProjectionStale<CanonicalEntity> | undefined {
    const dirtyEntries = entries.filter((entry): entry is CanonicalProjectionEntry<CanonicalEntity> & {
      baseRevision: string;
      sourceUri: string;
    } => entry.layer === 'dirty' && typeof entry.baseRevision === 'string' && typeof entry.sourceUri === 'string');
    if (dirtyEntries.length === 0) return undefined;
    const expectedBaseRevisions = [...new Set(dirtyEntries.map((entry) => entry.baseRevision))];
    const actualRevisions = [...new Set(dirtyEntries.map((entry) => this.getAuthoritativeSourceRevision(entry.sourceUri)))];
    const stale = dirtyEntries.some((entry) => this.getAuthoritativeSourceRevision(entry.sourceUri) !== entry.baseRevision);
    if (!stale) return undefined;
    return {
      status: 'stale',
      projections: [...entries],
      ...(actualRevisions.length === 1 && actualRevisions[0] ? { actualRevision: actualRevisions[0] } : {}),
      expectedBaseRevisions
    };
  }

  setFiles(files: readonly IndexedFile[]): void {
    this.filesByUri.clear();
    for (const file of files) this.filesByUri.set(file.sourceUri, file);
  }

  /** Update one live file revision without discarding the rest of the workspace index. */
  upsertFile(file: IndexedFile): void {
    this.filesByUri.set(file.sourceUri, file);
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

function validateDirtyCanonicalDocumentInput(input: DirtyCanonicalDocumentInput<CanonicalEntity>): string[] {
  const diagnostics: string[] = [];
  if (!input || typeof input !== 'object') return ['dirty canonical input 必须是对象。'];
  if (typeof input.documentId !== 'string' || !input.documentId.trim()) diagnostics.push('documentId 不能为空。');
  if (typeof input.sourceUri !== 'string' || !input.sourceUri.trim()) diagnostics.push('sourceUri 不能为空。');
  if (typeof input.baseRevision !== 'string' || !input.baseRevision.trim()) diagnostics.push('baseRevision 不能为空。');
  if (typeof input.revision !== 'string' || !input.revision.trim()) diagnostics.push('revision 不能为空。');
  if (!input.observation || typeof input.observation !== 'object' || input.observation.kind !== 'canonical-read') {
    diagnostics.push('dirty canonical 只能由 canonical-read observation 注册；pending plan 不具备 observed authority。');
  } else {
    if (input.observation.sourceUri !== input.sourceUri) diagnostics.push('observation.sourceUri 必须与 document.sourceUri 相同。');
    if (input.observation.revision !== input.revision) diagnostics.push('observation.revision 必须与 working revision 相同。');
  }
  const identities = new Set<string>();
  if (!Array.isArray(input.entities)) {
    diagnostics.push('entities 必须是数组。');
  } else for (const entity of input.entities) {
    if (!entity || typeof entity !== 'object') {
      diagnostics.push('entities 只能包含 canonical entity 对象。');
      continue;
    }
    if (typeof entity.identity !== 'string' || !entity.identity.trim()) diagnostics.push('canonical entity identity 不能为空。');
    if (entity.sourceUri !== input.sourceUri) diagnostics.push(`entity ${entity.identity} 的 sourceUri 与 document 不一致。`);
    if (entity.revision !== input.revision) diagnostics.push(`entity ${entity.identity} 的 revision 必须与 working revision 相同。`);
    if (entity.epistemic === 'hypothesized' || entity.epistemic === 'unverified') {
      diagnostics.push(`entity ${entity.identity} 不是 canonical read 可观察事实：${entity.epistemic}。`);
    }
    if (identities.has(entity.identity)) diagnostics.push(`同一 dirty document 重复声明 identity：${entity.identity}。`);
    identities.add(entity.identity);
  }
  const removed = new Set(input.removedIdentities ?? []);
  if (!Array.isArray(input.removedIdentities ?? [])) diagnostics.push('removedIdentities 必须是数组。');
  if ([...removed].some((identity) => typeof identity !== 'string' || !identity.trim())) diagnostics.push('removedIdentities 不能包含空 identity。');
  for (const identity of removed) {
    if (identities.has(identity)) diagnostics.push(`identity 同时出现在 entities 与 removedIdentities：${identity}。`);
  }
  if (input.observedAt !== undefined && !input.observedAt.trim()) diagnostics.push('observedAt 不能是空字符串。');
  if (input.updatedAt !== undefined && !input.updatedAt.trim()) diagnostics.push('updatedAt 不能是空字符串。');
  return diagnostics;
}

function normalizeDirtyCanonicalDocument(
  input: DirtyCanonicalDocumentInput<CanonicalEntity>
): DirtyCanonicalDocument<CanonicalEntity> {
  const observedAt = input.observedAt ?? new Date().toISOString();
  return {
    documentId: input.documentId,
    sourceUri: input.sourceUri,
    baseRevision: input.baseRevision,
    revision: input.revision,
    observation: {
      kind: 'canonical-read',
      sourceUri: input.observation.sourceUri,
      revision: input.observation.revision
    },
    entities: input.entities.map(cloneCanonicalEntity),
    removedIdentities: [...new Set(input.removedIdentities ?? [])],
    observedAt,
    updatedAt: input.updatedAt ?? observedAt
  };
}

function cloneDirtyCanonicalDocument(
  document: DirtyCanonicalDocument<CanonicalEntity>
): DirtyCanonicalDocument<CanonicalEntity> {
  return {
    documentId: document.documentId,
    sourceUri: document.sourceUri,
    baseRevision: document.baseRevision,
    revision: document.revision,
    observation: { ...document.observation },
    entities: document.entities.map(cloneCanonicalEntity),
    removedIdentities: [...document.removedIdentities],
    observedAt: document.observedAt,
    updatedAt: document.updatedAt
  };
}

function cloneCanonicalEntity(entity: CanonicalEntity): CanonicalEntity {
  return { ...entity };
}

function cloneCanonicalProjectionResolution(
  resolution: CanonicalProjectionResolution<CanonicalEntity>
): CanonicalProjectionResolution<CanonicalEntity> {
  switch (resolution.status) {
    case 'resolved':
      return { status: 'resolved', projection: cloneCanonicalProjection(resolution.projection) };
    case 'conflict':
      return { status: 'conflict', projections: resolution.projections.map(cloneCanonicalProjectionEntry) };
    case 'intent':
      return { status: 'intent', projections: resolution.projections.map(cloneCanonicalProjection) };
    case 'stale':
      return {
        status: 'stale',
        projections: resolution.projections.map(cloneCanonicalProjectionEntry),
        ...(resolution.actualRevision ? { actualRevision: resolution.actualRevision } : {}),
        expectedBaseRevisions: [...resolution.expectedBaseRevisions]
      };
    case 'suppressed':
      return {
        status: 'suppressed',
        identity: resolution.identity,
        documentIds: [...resolution.documentIds],
        revision: resolution.revision,
        updatedAt: resolution.updatedAt
      };
    case 'empty':
      return { status: 'empty' };
  }
}

function cloneCanonicalProjection(
  projection: CanonicalProjection<CanonicalEntity>
): CanonicalProjection<CanonicalEntity> {
  return { ...projection, value: cloneCanonicalEntity(projection.value) };
}

function cloneCanonicalProjectionEntry(
  entry: CanonicalProjectionEntry<CanonicalEntity>
): CanonicalProjectionEntry<CanonicalEntity> {
  return 'value' in entry ? cloneCanonicalProjection(entry) : { ...entry };
}

function uniqueCanonicalEntities(entities: readonly CanonicalEntity[]): CanonicalEntity[] {
  const seen = new Set<string>();
  return entities.filter((entity) => {
    if (seen.has(entity.identity)) return false;
    seen.add(entity.identity);
    return true;
  });
}

function dirtyFailure(
  code: DirtyCanonicalDocumentErrorCode,
  diagnostics: string[],
  expectedRevision?: string,
  actualRevision?: string
): DirtyCanonicalDocumentMutationResult<CanonicalEntity> {
  return {
    ok: false,
    code,
    diagnostics,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    ...(actualRevision === undefined ? {} : { actualRevision })
  };
}
