import type {
  EventArg,
  EventExport,
  EventInstruction,
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
import {
  buildTextEntryLookup,
  collectParamTextLinks,
  paramTextLinkSearchText
} from '../references/paramTextReferences.js';

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
  /** Families whose foreground membership projection is complete. */
  private actionBinderMembershipReadyFamilies = new Set<string>();

  constructor(workspaceId: string) {
    this.workspaceId = workspaceId;
  }

  setFiles(files: readonly IndexedFile[]): void {
    // A foreground ACTION family may already have been indexed while the
    // background scanner is replacing the light catalog with hashed files.
    // Keep that read-only projection alive, but refresh the catalog half of
    // each source revision so later source validation remains exact.
    const previousMembership = this.actionBinderMembershipCandidates;
    this.filesByUri.clear();
    for (const file of files) this.filesByUri.set(file.sourceUri, file);
    this.actionBinderMembershipCandidates = previousMembership.map((candidate) => ({
      characterFamily: candidate.characterFamily,
      source: this.refreshActionBinderSourceRevision(candidate.source, files),
      entries: candidate.entries.map((entry) => ({ ...entry }))
    }));
    // The full projection is no longer authoritative after a catalog
    // replacement. Scoped foreground projections remain usable and are still
    // checked against the live file revision by the ACTION IPC layer.
    this.actionBinderMembershipReady = false;
  }

  /**
   * Install the complete ACTION binder membership projection produced by the
   * workspace indexer. Playback may query this projection, but must not scan
   * sibling ANIBND files or parse containers on demand.
   */
  setActionBinderMembership(
    candidates: readonly BinderMembershipCandidate[],
    characterFamilies?: readonly string[]
  ): void {
    this.actionBinderMembershipCandidates = candidates.map((candidate) => ({
      characterFamily: candidate.characterFamily,
      source: { ...candidate.source },
      entries: candidate.entries.map((entry) => ({ ...entry }))
    }));
    this.actionBinderMembershipReady = true;
    this.actionBinderMembershipReadyFamilies = new Set(
      (characterFamilies ?? candidates.map((candidate) => candidate.characterFamily))
        .map((family) => family.toLowerCase())
    );
  }

  /**
   * Install a complete projection for one or more character families without
   * discarding another family that is already available to the foreground.
   * The global-ready bit deliberately stays false until the full indexer
   * publishes every discovered family.
   */
  mergeActionBinderMembership(
    characterFamilies: readonly string[],
    candidates: readonly BinderMembershipCandidate[]
  ): void {
    const families = new Set(characterFamilies.map((family) => family.toLowerCase()));
    this.actionBinderMembershipCandidates = [
      ...this.actionBinderMembershipCandidates.filter(
        (candidate) => !families.has(candidate.characterFamily.toLowerCase())
      ),
      ...candidates.map((candidate) => ({
        characterFamily: candidate.characterFamily,
        source: { ...candidate.source },
        entries: candidate.entries.map((entry) => ({ ...entry }))
      }))
    ];
    for (const family of families) this.actionBinderMembershipReadyFamilies.add(family);
    this.actionBinderMembershipReady = false;
  }

  /** Mark the global projection stale without dropping valid scoped families. */
  markActionBinderMembershipGlobalNotReady(): void {
    this.actionBinderMembershipReady = false;
  }

  /** Drop only the requested scoped projection and fail closed for it. */
  clearActionBinderMembershipFamilies(characterFamilies: readonly string[]): void {
    const families = new Set(characterFamilies.map((family) => family.toLowerCase()));
    this.actionBinderMembershipCandidates = this.actionBinderMembershipCandidates.filter(
      (candidate) => !families.has(candidate.characterFamily.toLowerCase())
    );
    for (const family of families) this.actionBinderMembershipReadyFamilies.delete(family);
    this.actionBinderMembershipReady = false;
  }

  /** Drop the projection when its source catalog/session is no longer valid. */
  clearActionBinderMembership(): void {
    this.actionBinderMembershipCandidates = [];
    this.actionBinderMembershipReady = false;
    this.actionBinderMembershipReadyFamilies.clear();
  }

  isActionBinderMembershipReady(): boolean {
    return this.actionBinderMembershipReady;
  }

  isActionBinderMembershipReadyFor(characterFamily: string): boolean {
    return this.actionBinderMembershipReady
      || this.actionBinderMembershipReadyFamilies.has(characterFamily.toLowerCase());
  }

  lookupActionBinderMembership(query: BinderMembershipQuery): BinderMembershipResult {
    return resolveBinderMembership({
      query,
      candidates: this.actionBinderMembershipCandidates
    });
  }

  private refreshActionBinderSourceRevision(
    source: BinderMembershipCandidate['source'],
    files: readonly IndexedFile[]
  ): BinderMembershipCandidate['source'] {
    const revision = source.sourceRevision;
    if (typeof revision !== 'string') return { ...source };
    const separator = revision.indexOf('|');
    if (separator <= 0) return { ...source };
    const sourcePath = source.sourcePath?.replace(/\\/g, '/').toLowerCase();
    const matchingFile = sourcePath
      ? files.find((file) => file.relativePath.replace(/\\/g, '/').toLowerCase() === sourcePath)
      : undefined;
    if (!matchingFile) return { ...source };
    const physicalRevision = revision.slice(0, separator);
    const catalogRevision = `${matchingFile.sourceUri}:${matchingFile.mtimeMs}:${matchingFile.sha256 ?? ''}`;
    return { ...source, sourceRevision: `${physicalRevision}|${catalogRevision}` };
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
    // An empty outline has no source URI in EventExport and therefore cannot
    // identify a replacement. Treat it as an incomplete observation so it
    // cannot erase an already indexed rich event body.
    if (value.events.length === 0) return;
    const key = eventExportKey(value);
    // An export without one unambiguous source identity cannot safely replace
    // another export. Keep it as a separate candidate instead of collapsing it
    // under a shared "unknown" key.
    if (!key || !hasUniqueEventIds(value.events)) {
      this.eventExports = [...this.eventExports, value];
      return;
    }
    const matches = this.eventExports
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => eventExportKey(item) === key);
    // Multiple exports with the same physical identity are ambiguous. Do not
    // pick the first one and do not erase either body; a caller can invalidate
    // the source and ingest a fresh export to resolve the ambiguity.
    if (matches.length > 1) {
      this.eventExports = [...this.eventExports, value];
      return;
    }
    if (matches.length === 0) {
      this.eventExports = [...this.eventExports, value];
      return;
    }
    const match = matches[0]!;
    const copy = [...this.eventExports];
    copy[match.index] = mergeEventExport(match.item, value);
    this.eventExports = copy;
  }

  upsertMapExport(value: MapExport): void {
    this.mapExports = replaceByKey(this.mapExports, value.mapId, (item) => item.mapId, value);
  }

  upsertParamExport(value: ParamExport): void {
    this.paramExports = replaceByKey(this.paramExports, paramExportKey(value), paramExportKey, value);
  }

  /** Merge a partial live PARAM read without erasing rows indexed earlier. */
  mergeParamRows(value: ParamExport): void {
    const key = paramExportKey(value);
    const existing = this.paramExports.find((item) => paramExportKey(item) === key);
    // Row IDs are only unique inside one native source.  Keying by rowId alone
    // used to let a live read from source B overwrite source A, and could then
    // carry source A's old semantic body under source B's hash.
    const rows = new Map((existing?.rows ?? []).map((row) => [`${row.sourceUri}#${row.rowId}`, row]));
    for (const row of value.rows) rows.set(`${row.sourceUri}#${row.rowId}`, row);
    const mergedRows = [...rows.values()];
    const sourceHashes = new Set(mergedRows.map((row) => row.sourceHash).filter((item): item is string => Boolean(item)));
    const sourceRevisions = new Set(mergedRows.map((row) => row.sourceRevision).filter((item): item is number => item !== undefined));
    this.upsertParamExport({
      ...(value.sourceUri !== undefined ? { sourceUri: value.sourceUri } : existing?.sourceUri !== undefined ? { sourceUri: existing.sourceUri } : {}),
      ...(value.entryIndex !== undefined ? { entryIndex: value.entryIndex } : existing?.entryIndex !== undefined ? { entryIndex: existing.entryIndex } : {}),
      ...(value.entryName !== undefined ? { entryName: value.entryName } : existing?.entryName !== undefined ? { entryName: existing.entryName } : {}),
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
      const score = scoreResource(file, text, query);
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
      ? new Set(paramNames.flatMap(paramNameVariants))
      : null;
    // Native semantic rows often have no rowName. Resolve only the bounded,
    // source-backed PARAM↔FMG links once per query so an item-name search can
    // find the physical row without scanning/rebuilding RAG per tool call.
    const textEntryLookup = buildTextEntryLookup(this.msgExports);
    // Rank each physical table independently before interleaving. Ranking the
    // flattened 50k-row corpus first can exhaust the limit on one dense table
    // and hide the NpcParam/ItemLotParam representative entirely.
    const ranked = this.paramExports
      .filter((item) => allowed === null || paramExportMatches(item, allowed))
      .flatMap((item) => searchSymbols(
        item.rows,
        query,
        limit,
        (row) => paramRowSearchText(row, textEntryLookup)
      ));
    return diversifyParamSearchResults(
      ranked,
      limit,
      query
    );
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

function paramExportKey(value: ParamExport): string {
  const sourceUri = value.sourceUri ?? value.rows[0]?.sourceUri ?? '';
  const entryIdentity = value.entryName
    ?? (value.entryIndex === undefined ? value.paramName : `#${value.entryIndex}`);
  // A physical BND4 child is the authoritative table identity.  Its native
  // typeName can differ between export/read paths (NPC_PARAM_ST vs NpcParam),
  // so including both would duplicate the same live row after a native read.
  return `${sourceUri}\u0000${entryIdentity.toLowerCase()}`;
}

function eventExportKey(value: EventExport): string | undefined {
  const sourceUris = new Set(value.events.map((event) => event.sourceUri).filter(Boolean));
  if (sourceUris.size !== 1) return undefined;
  const identities = new Set(value.events.map((event) => `${event.mapId ?? value.mapId ?? ''}`));
  if (identities.size !== 1) return undefined;
  const sourceUri = [...sourceUris][0]!;
  const mapId = value.mapId ?? value.events[0]?.mapId ?? '';
  return `${sourceUri}\u0000${mapId}`;
}

function hasUniqueEventIds(events: readonly EventSymbol[]): boolean {
  const ids = new Set<number>();
  for (const event of events) {
    if (ids.has(event.eventId)) return false;
    ids.add(event.eventId);
  }
  return true;
}

function mergeEventExport(existing: EventExport, incoming: EventExport): EventExport {
  // Hash/revision are part of the semantic identity. A new native snapshot
  // may use the same source URI and event ID, but its old instructions must
  // never be carried into that new identity.
  if (!eventExportSourceIdentityMatches(existing, incoming)) return incoming;

  const existingById = new Map(existing.events.map((event) => [event.eventId, event]));
  const incomingIds = new Set(incoming.events.map((event) => event.eventId));
  const mergedIncomingEvents = incoming.events.map((event) =>
    mergeEventSymbol(existingById.get(event.eventId), event, existing, incoming)
  );
  const retainOmittedEvents = incoming.events.length < existing.events.length
    || incoming.events.every(isIncompleteEventOutline);
  return {
    ...existing,
    ...incoming,
    // An incomplete outline is not a complete event set. Keep omitted symbols
    // from the same source identity, then merge the observations it did have.
    // A complete/rich export remains authoritative for its event list.
    events: [
      ...(retainOmittedEvents ? existing.events.filter((event) => !incomingIds.has(event.eventId)) : []),
      ...mergedIncomingEvents
    ]
  };
}

function mergeEventSymbol(
  existing: EventSymbol | undefined,
  incoming: EventSymbol,
  existingExport: EventExport,
  incomingExport: EventExport
): EventSymbol {
  if (!existing
    || !eventSourceIdentityMatches(existing, incoming, existingExport, incomingExport)
    || !shouldPreserveInstructions(existing, incoming)) {
    return incoming;
  }
  return {
    ...existing,
    ...incoming,
    // Native outline reads intentionally have no instruction rows. They may
    // refresh sourceHash/sourceRevision and raw.instructionCount, but cannot
    // destroy an already ingested semantic instruction body.
    instructions: existing.instructions,
    raw: mergeEventRaw(existing.raw, incoming.raw)
  };
}

function shouldPreserveInstructions(
  existing: EventSymbol,
  incoming: EventSymbol
): boolean {
  if (existing.instructions.length === 0) return false;
  return incoming.instructions.length < existing.instructions.length
    || isIncompleteEventOutline(incoming);
}

function isIncompleteEventOutline(event: EventSymbol): boolean {
  if (event.instructions.length === 0) return true;

  const raw = isRecord(event.raw) ? event.raw : undefined;
  const declaredCount = raw?.instructionCount;
  if (typeof declaredCount === 'number'
    && Number.isSafeInteger(declaredCount)
    && declaredCount >= 0
    && event.instructions.length < declaredCount) {
    return true;
  }

  const authority = raw?.authority;
  return typeof authority === 'string' && authority.toLocaleLowerCase().includes('outline')
    || raw?.semanticArgsDecoded === false;
}

function eventExportSourceIdentityMatches(existing: EventExport, incoming: EventExport): boolean {
  return sourceIdentityCandidatesMatch(
    eventExportIdentityCandidates(existing, 'sourceHash'),
    eventExportIdentityCandidates(incoming, 'sourceHash')
  ) && sourceIdentityCandidatesMatch(
    eventExportIdentityCandidates(existing, 'sourceRevision'),
    eventExportIdentityCandidates(incoming, 'sourceRevision')
  );
}

function eventSourceIdentityMatches(
  existing: EventSymbol,
  incoming: EventSymbol,
  existingExport: EventExport,
  incomingExport: EventExport
): boolean {
  if (existing.sourceUri !== incoming.sourceUri) return false;
  return sourceIdentityCandidatesMatch(
    eventIdentityCandidates(existing, existingExport, 'sourceHash'),
    eventIdentityCandidates(incoming, incomingExport, 'sourceHash')
  ) && sourceIdentityCandidatesMatch(
    eventIdentityCandidates(existing, existingExport, 'sourceRevision'),
    eventIdentityCandidates(incoming, incomingExport, 'sourceRevision')
  );
}

type EventIdentityValue = string | number;

function eventExportIdentityCandidates(
  value: EventExport,
  field: 'sourceHash' | 'sourceRevision'
): EventIdentityValue[] {
  return uniqueIdentityValues([
    value[field],
    ...value.events.map((event) => event[field])
  ]);
}

function eventIdentityCandidates(
  event: EventSymbol,
  exportItem: EventExport,
  field: 'sourceHash' | 'sourceRevision'
): EventIdentityValue[] {
  return uniqueIdentityValues([event[field], exportItem[field]]);
}

function uniqueIdentityValues(values: readonly (EventIdentityValue | undefined)[]): EventIdentityValue[] {
  return [...new Set(values.filter((value): value is EventIdentityValue => value !== undefined))];
}

function sourceIdentityCandidatesMatch(left: readonly EventIdentityValue[], right: readonly EventIdentityValue[]): boolean {
  // A missing identity is unknown, not evidence of a conflict. This lets an
  // outline observation enrich an older body with a newly available hash,
  // while still dropping the body when two concrete hashes/revisions differ.
  if (left.length === 0 || right.length === 0) return true;
  if (left.length !== right.length) return false;
  return left.every((value) => right.includes(value));
}

function mergeEventRaw(existing: unknown, incoming: unknown): unknown {
  if (isRecord(existing) && isRecord(incoming)) return { ...existing, ...incoming };
  return incoming === undefined ? existing : incoming;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const SEKIRO_SEARCH_SYNONYMS: ReadonlyArray<[RegExp, string]> = [
  [/鬼[刑型]部/, '鬼形部 鬼庭形部雅孝 Gyoubu'],
  [/形部/, '鬼形部 鬼庭形部雅孝 Gyoubu'],
  [/雅孝/, '鬼庭形部雅孝'],
  [/蝴蝶夫人|阿蝶/, '幻影之蝶 Butterfly'],
  [/弦一郎|屑一郎/, '苇名弦一郎 Genichiro c5400 540000 540000_battle.lua'],
  [/狮子猿/, '狮子猿 Ape Guardian'],
  [/巨型忍者|义父|枭/, '巨型忍者 枭 Father Owl'],
  // 当前 Sekiro 中文语料把用户说的“义父的铃铛”写成
  // EquipParamGoods 行名“义父的守护铃”；这是受限的词法别名，不是
  // 数字 ID 映射。它让精确 Goods 行先进入候选，后续仍必须原生读取。
  [/义父(?:的(?:铃铛|守护铃))?|铃铛|守护铃|守り鈴/iu, '义父的守护铃 守护铃 铃铛 Bell'],
  [/一心|剑圣/, '苇名一心 剑圣 Isshin'],
  [/破戒僧/, '破戒僧 Monk'],
  [/赤鬼/, '赤鬼 Ogre'],
  [/火牛|樱牛/, '火牛 樱牛 Bull'],
  [/佐濑甚助|居合哥/, '佐濑甚助 Jinsuke']
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

function scoreResource(file: IndexedFile, text: string, query: string): number {
  const score = scoreText(text, query);
  if (score <= 0 || query.length === 0) return score;

  // Resource search is also the command palette's open-resource resolver. A
  // filename query must prefer the exact file over a similarly named sibling
  // (for example c0000.anibnd.dcx over c0000_a000_lo.anibnd.dcx), otherwise
  // pressing Enter can open a different document even when the visible query
  // looks unambiguous.
  const normalizedQuery = normalizeSearch(query);
  const normalizedRelativePath = normalizeSearch(file.relativePath);
  const relativeName = file.relativePath.split(/[\\/]/).pop() ?? file.relativePath;
  const normalizedName = normalizeSearch(relativeName);
  if (normalizedRelativePath === normalizedQuery) return score + 10_000;
  if (normalizedName === normalizedQuery) return score + 9_000;
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

/**
 * An unscoped PARAM query can match tens of thousands of rows.  Keeping only
 * the globally highest-scoring rows often hides NpcParam behind a dense
 * BehaviorParam/AtkParam cluster, so the Agent never sees the table it needs.
 * Preserve row-name phrase matches before interleaving table groups. This
 * keeps two equally strong physical rows (for example the two distinct bell
 * names) visible in the bounded model-facing page instead of hiding the
 * second row behind one representative from every unrelated table. Exact
 * top-score ties are also preserved for rows whose phrase is not available.
 * The remaining rows still interleave table groups so a dense
 * BehaviorParam/AtkParam cluster cannot hide NpcParam or ItemLotParam.
 * Explicit paramNames that resolve to one table are unchanged.
 */
function diversifyParamSearchResults(
  results: Array<SearchResult<ParamRowSymbol>>,
  limit: number,
  query = ''
): Array<SearchResult<ParamRowSymbol>> {
  if (limit <= 0 || results.length <= 1) return limit <= 0 ? [] : results.slice(0, limit);
  const phraseTerms = normalizeSearch(expandSearchQuery(query))
    .split(' ')
    .filter((term) => term.length >= 2);
  const rowNamePhraseMatches = results
    .filter((result) => {
      const rowName = normalizeSearch(result.item.rowName ?? '');
      return rowName.length > 0 && phraseTerms.some((term) => rowName.includes(term));
    })
    .sort((left, right) => right.score - left.score);
  const phrasePriority = rowNamePhraseMatches.slice(0, Math.min(12, limit));
  if (phrasePriority.length > 0) {
    const selected = new Set(phrasePriority.map((result) => result.item.uri));
    const remainder = results.filter((result) => !selected.has(result.item.uri));
    const diversifiedRemainder = diversifyParamSearchResults(remainder, limit - phrasePriority.length, query);
    return [...phrasePriority, ...diversifiedRemainder].slice(0, limit);
  }
  const topScore = results.reduce((highest, result) => Math.max(highest, result.score), 0);
  const topScoreMatches = results
    .filter((result) => result.score === topScore)
    .slice(0, Math.min(12, limit));
  if (topScoreMatches.length > 1) {
    const selected = new Set(topScoreMatches.map((result) => result.item.uri));
    const remainder = results.filter((result) => !selected.has(result.item.uri));
    const diversifiedRemainder = diversifyParamSearchResults(remainder, limit - topScoreMatches.length, query);
    return [...topScoreMatches, ...diversifiedRemainder].slice(0, limit);
  }
  const groups = new Map<string, Array<SearchResult<ParamRowSymbol>>>();
  for (const result of results) {
    const groupName = normalizeParamName(result.item.paramName || result.item.entryName || 'unknown');
    const group = groups.get(groupName) ?? [];
    group.push(result);
    groups.set(groupName, group);
  }
  if (groups.size <= 1) return results.slice(0, limit);

  for (const group of groups.values()) group.sort((left, right) => right.score - left.score);

  const orderedGroups = [...groups.values()].sort((left, right) => {
    const scoreDelta = (right[0]?.score ?? 0) - (left[0]?.score ?? 0);
    if (scoreDelta !== 0) return scoreDelta;
    return normalizeParamName(left[0]?.item.paramName ?? '').localeCompare(
      normalizeParamName(right[0]?.item.paramName ?? '')
    );
  });
  const diversified: Array<SearchResult<ParamRowSymbol>> = [];
  for (let offset = 0; diversified.length < limit; offset += 1) {
    let added = false;
    for (const group of orderedGroups) {
      const result = group[offset];
      if (!result) continue;
      diversified.push(result);
      added = true;
      if (diversified.length >= limit) break;
    }
    if (!added) break;
  }
  return diversified;
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
  return [
    event.eventId,
    boundedSearchString(event.name),
    boundedSearchString(event.mapId),
    ...event.instructions.flatMap(eventInstructionSearchTokens),
    ...safeRawNumericTokens(event.raw)
  ].filter((value) => value !== undefined && value !== null && String(value).length > 0).join(' ');
}

function eventInstructionSearchTokens(instruction: EventInstruction): string[] {
  return [
    boundedSearchString(instruction.name),
    boundedSearchString(instruction.category),
    ...instruction.args.flatMap(eventArgSearchTokens),
    ...safeRawNumericTokens(instruction.raw)
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function eventArgSearchTokens(arg: EventArg): string[] {
  const tokens: string[] = [];
  const name = boundedSearchString(arg.name);
  const role = boundedSearchString(arg.role);
  const paramName = boundedSearchString(arg.paramName);
  if (name) tokens.push(name);
  if (role) tokens.push(role);
  if (paramName) tokens.push(paramName);
  // A low-confidence numeric value is evidence for review, not a confirmed
  // searchable entity. Textual values remain useful labels, but are bounded
  // and path-like values are excluded from the index text.
  if (arg.confidence !== 'low') {
    if (typeof arg.value === 'number') {
      const numeric = safeNumericToken(arg.value);
      if (numeric !== undefined) tokens.push(numeric);
    } else if (typeof arg.value === 'string') {
      const value = boundedSearchString(arg.value);
      if (value && !looksLikePath(value)) tokens.push(value);
    } else if (typeof arg.value === 'boolean') {
      tokens.push(String(arg.value));
    }
  }
  return tokens;
}

function safeRawNumericTokens(raw: unknown): string[] {
  const tokens: string[] = [];
  collectSafeRawNumericTokens(raw, tokens, 0);
  return tokens;
}

function collectSafeRawNumericTokens(value: unknown, tokens: string[], depth: number): void {
  if (depth > 3 || tokens.length >= 24 || !isRecord(value)) return;
  if (value.confidence === 'low') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:bank|id|entity|entityId)$/i.test(key)) {
      const numeric = safeNumericToken(child);
      if (numeric !== undefined) tokens.push(`${key}:${numeric}`);
      continue;
    }
    if (isRecord(child)) collectSafeRawNumericTokens(child, tokens, depth + 1);
    else if (Array.isArray(child)) {
      for (const item of child.slice(0, 8)) collectSafeRawNumericTokens(item, tokens, depth + 1);
    }
  }
}

function safeNumericToken(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? String(value) : undefined;
  }
  if (typeof value !== 'string' || !/^-?\d+$/.test(value) || value.length > 16) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && String(parsed) === value ? value : undefined;
}

function boundedSearchString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return undefined;
  return value;
}

function looksLikePath(value: string): boolean {
  return value.includes('\\') || value.includes('/') || /^[A-Za-z]:/.test(value) || value.startsWith('file:');
}

function mapSymbolSearchText(symbol: MapEntitySymbol | MapRegionSymbol): string {
  return [symbol.uri, symbol.entityId, symbol.name, symbol.mapId, 'kind' in symbol ? symbol.kind : undefined, 'model' in symbol ? symbol.model : undefined].filter(Boolean).join(' ');
}

function paramRowSearchText(row: ParamRowSymbol, textEntryLookup?: ReturnType<typeof buildTextEntryLookup>): string {
  const linkedText = textEntryLookup
    ? paramTextLinkSearchText(collectParamTextLinks(row, textEntryLookup))
    : '';
  return [
    row.uri,
    row.paramName,
    row.entryName,
    row.entryIndex,
    row.rowId,
    row.rowName,
    row.fields?.map((field) => [
      field.fieldId,
      field.name,
      field.description,
      String(field.value)
    ].filter(Boolean).join(':')).join(' '),
    linkedText
  ].filter(Boolean).join(' ');
}

function normalizeParamName(value: string): string {
  return value
    .replace(/\\/g, '/')
    .split('/')
    .pop()!
    .replace(/\.param$/i, '')
    // Bridge exports may expose the native type (NPC_PARAM_ST) while the
    // physical BND4 child is NpcParam.param.  Compare a punctuation-free
    // token and its conventional _ST-less alias, but retain entryName as a
    // separate candidate so same-type tables (e.g. ATK_PARAM_ST) do not get
    // conflated with one another.
    .replace(/[^A-Za-z0-9]+/g, '')
    .toLocaleLowerCase();
}

function paramNameVariants(value: string): string[] {
  const normalized = normalizeParamName(value);
  if (normalized.length === 0) return [];
  const variants = new Set([normalized]);
  if (normalized.endsWith('st') && normalized.length > 2) {
    variants.add(normalized.slice(0, -2));
  }
  return [...variants];
}

function paramExportMatches(value: ParamExport, allowed: ReadonlySet<string>): boolean {
  const names = [
    value.paramName,
    value.entryName,
    value.rows[0]?.paramName,
    value.rows[0]?.entryName
  ].filter((name): name is string => typeof name === 'string' && name.length > 0);
  return names.some((name) => paramNameVariants(name).some((variant) => allowed.has(variant)));
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
