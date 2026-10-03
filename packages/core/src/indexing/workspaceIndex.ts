import { createHash } from 'node:crypto';
import { createOpaqueCursor, parseOpaqueCursor, formatActionAddress } from '@soulforge/shared';
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
  ParamFieldSymbol,
  ParamRowSymbol,
  RagChunk,
  ReferenceEdge,
  ResourceKind,
  ScriptExport,
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
import {
  CoverageStateStore,
  deriveCoverageState,
  type CoverageSourceVersion,
  type CoverageState
} from './coverageState.js';
import { cloneParamExports } from './cloneParamExport.js';
import { isActiveSemanticSource } from '../workspace/resourceKinds.js';

export const MSB_READER_SCHEMA_REVISION = 2;
export const MSB_READER_SCHEMA_HASH = 'msb-schema-rev-2-entityid-verified';
export const METADATA_SCHEMA_HASH = 'meta-schema-rev-1-sekiro';

export function computeMapDerivedKey(input: {
  outerHash: string;
  readerSchemaHash?: string;
  metadataSchemaHash?: string;
}): string {
  const reader = input.readerSchemaHash ?? MSB_READER_SCHEMA_HASH;
  const meta = input.metadataSchemaHash ?? METADATA_SCHEMA_HASH;
  return `map-derived:${input.outerHash}:${reader}:${meta}`;
}

export interface SearchResourcesOptions {
  query?: string;
  kinds?: readonly ResourceKind[];
  limit?: number;
  /** Continuation token returned by searchResourcesPage. */
  cursor?: string;
  /** Recovery artifacts stay out of the normal resource search by default. */
  sourceFilter?: ResourceSearchSourceFilter;
}

export type ResourceSearchSourceFilter = 'active' | 'all' | 'artifacts';

export interface SearchResourcesPage {
  items: Array<SearchResult<IndexedFile>>;
  /** Agent-facing alias retained alongside the WorkspaceIndex item name. */
  matches: Array<SearchResult<IndexedFile>>;
  total: number;
  totalCount: number;
  offset: number;
  limit: number;
  returned: number;
  returnedCount: number;
  hasMore: boolean;
  truncated: boolean;
  nextCursor?: string;
  nextActions: Array<{ tool: 'search_resources'; args: { query: string; cursor: string }; reason: string }>;
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

export interface TaeAnimationIdentitySelector {
  taeEntryIndex?: number;
  taeEntryId?: number;
  taeEntryName?: string;
  taeGroup?: string;
}

export type ParamSemanticState = 'uninitialized' | 'scanning' | 'warming_up' | 'ready' | 'empty' | 'failed';

export interface NativeProjectionAcceptance {
  accepted: boolean;
  sourceUri: string;
  code?: 'NATIVE_PROJECTION_STALE' | 'NATIVE_PROJECTION_VERSION_CONFLICT';
  reason?: string;
}

export class WorkspaceIndex {
  readonly workspaceId: string;

  private filesByUri = new Map<string, IndexedFile>();
  private eventExports: EventExport[] = [];
  private mapExports: MapExport[] = [];
  private paramExports: ParamExport[] = [];
  private msgExports: MsgExport[] = [];
  private taeExports: TaeExport[] = [];
  /** On-demand/native LUABND projections used by script reference edges. */
  private scriptExports: ScriptExport[] = [];
  private references: ReferenceEdge[] = [];
  private referencesDirty = true;
  private lastReferenceBuildResult: ReferenceBuildResult | null = null;
  private actionBinderMembershipCandidates: BinderMembershipCandidate[] = [];
  private actionBinderMembershipReady = false;
  /** Families whose foreground membership projection is complete. */
  private actionBinderMembershipReadyFamilies = new Set<string>();
  private paramSemanticState: ParamSemanticState = 'uninitialized';
  private readonly coverageStore = new CoverageStateStore();
  /** Changed sources remain stale until a current-version projection is published. */
  private readonly staleSources = new Set<string>();
  /** Sources with useful decoded leaves but incomplete native coverage. */
  private readonly partialSources = new Set<string>();
  /** Highest accepted semantic version per physical source/child identity. */
  private readonly latestProjectionVersions = new Map<string, CoverageSourceVersion>();
  /** Monotonic identity epoch used by host-side RAG freshness masks. */
  private nativeVersionEpoch = 0;
  /** Cached source URI projections; semantic arrays replace on mutation. */
  private readonly semanticSourceUriCache = new Map<ResourceKind, readonly string[]>();

  constructor(workspaceId: string) {
    this.workspaceId = workspaceId;
    this.recomputeCoverageStates();
  }

  /**
   * Clone the complete semantic snapshot for an isolated refresh candidate.
   *
   * Native post-commit refreshes may spend minutes outside the event loop
   * while reading Bridge data and persisting RAG deltas.  A candidate must not
   * share the live index's mutable arrays or scoped ACTION membership: a late
   * or failed refresh must leave the live snapshot at its already-invalidated
   * state.  Keep this copy operation here, where all private projection state
   * is available, instead of reconstructing a partial bundle at each caller.
   */
  cloneForRefresh(): WorkspaceIndex {
    const clone = new WorkspaceIndex(this.workspaceId);
    clone.filesByUri.clear();
    for (const [sourceUri, file] of this.filesByUri) {
      clone.filesByUri.set(sourceUri, structuredClone(file));
    }
    clone.eventExports = structuredClone(this.eventExports);
    clone.mapExports = structuredClone(this.mapExports);
    clone.paramExports = cloneParamExports(this.paramExports);
    clone.msgExports = structuredClone(this.msgExports);
    clone.taeExports = structuredClone(this.taeExports);
    clone.scriptExports = structuredClone(this.scriptExports);
    // The constructor has already populated URI caches for the empty clone.
    // Projection arrays are assigned directly below it, so those entries must
    // be discarded before the first coverage recomputation on the clone.
    clone.invalidateSemanticSourceUriCache();
    clone.references = structuredClone(this.references);
    clone.referencesDirty = this.referencesDirty;
    clone.lastReferenceBuildResult = this.lastReferenceBuildResult
      ? { ...this.lastReferenceBuildResult, edges: clone.references }
      : null;
    clone.actionBinderMembershipCandidates = structuredClone(this.actionBinderMembershipCandidates);
    clone.actionBinderMembershipReady = this.actionBinderMembershipReady;
    clone.actionBinderMembershipReadyFamilies = new Set(this.actionBinderMembershipReadyFamilies);
    clone.paramSemanticState = this.paramSemanticState;
    clone.staleSources.clear();
    for (const sourceUri of this.staleSources) clone.staleSources.add(sourceUri);
    clone.partialSources.clear();
    for (const sourceUri of this.partialSources) clone.partialSources.add(sourceUri);
    clone.latestProjectionVersions.clear();
    for (const [sourceUri, version] of this.latestProjectionVersions) {
      clone.latestProjectionVersions.set(sourceUri, structuredClone(version));
    }
    clone.nativeVersionEpoch = this.nativeVersionEpoch;
    clone.coverageStore.clear();
    for (const state of this.coverageStore.list()) clone.coverageStore.set(state);
    return clone;
  }

  /**
   * Fork the mutable containers for a source refresh while structurally
   * sharing unchanged native projection trees. WorkspaceIndex updates use
   * copy-on-write top-level exports; callers must not mutate nested objects
   * returned by `toSymbolBundle()` directly.
   *
   * The regular `cloneForRefresh()` remains deeply isolated for native readers
   * that may mutate imported input. This variant is for a validated refresh
   * candidate whose unchanged projections have already passed provenance
   * checks and are immutable for the lifetime of the fork.
   */
  cloneForRefreshShared(): WorkspaceIndex {
    const clone = new WorkspaceIndex(this.workspaceId);
    clone.filesByUri = new Map(this.filesByUri);
    clone.eventExports = [...this.eventExports];
    clone.mapExports = [...this.mapExports];
    clone.paramExports = [...this.paramExports];
    clone.msgExports = [...this.msgExports];
    clone.taeExports = [...this.taeExports];
    clone.scriptExports = [...this.scriptExports];
    // The constructor warmed every source-URI cache while the projection
    // arrays were empty. Discard those entries before a later source-family
    // upsert recomputes coverage against the shared snapshot.
    clone.invalidateSemanticSourceUriCache();
    clone.references = [...this.references];
    clone.referencesDirty = this.referencesDirty;
    clone.lastReferenceBuildResult = this.lastReferenceBuildResult
      ? { ...this.lastReferenceBuildResult, edges: clone.references }
      : null;
    clone.actionBinderMembershipCandidates = structuredClone(this.actionBinderMembershipCandidates);
    clone.actionBinderMembershipReady = this.actionBinderMembershipReady;
    clone.actionBinderMembershipReadyFamilies = new Set(this.actionBinderMembershipReadyFamilies);
    clone.paramSemanticState = this.paramSemanticState;
    clone.staleSources.clear();
    for (const sourceUri of this.staleSources) clone.staleSources.add(sourceUri);
    clone.partialSources.clear();
    for (const sourceUri of this.partialSources) clone.partialSources.add(sourceUri);
    clone.latestProjectionVersions.clear();
    for (const [sourceUri, version] of this.latestProjectionVersions) {
      clone.latestProjectionVersions.set(sourceUri, structuredClone(version));
    }
    clone.nativeVersionEpoch = this.nativeVersionEpoch;
    clone.coverageStore.clear();
    for (const state of this.coverageStore.list()) clone.coverageStore.set(structuredClone(state));
    return clone;
  }

  setFiles(files: readonly IndexedFile[]): void {
    // A foreground ACTION family may already have been indexed while the
    // background scanner is replacing the light catalog with hashed files.
    // Keep that read-only projection alive, but refresh the catalog half of
    // each source revision so later source validation remains exact.
    const previousFiles = [...this.filesByUri.values()];
    const previousMembership = this.actionBinderMembershipCandidates;
    const nextFiles = [...files];
    // Resolve removed sources against one alias index.  Calling
    // sourceUriMatchesFile for every previous/next pair turns a large scan
    // replacement into O(fileCount^2) work.
    const nextSourceKeyCounts = new Map<string, number>();
    for (const next of nextFiles) {
      for (const key of [next.sourceUri, next.sourcePath, next.relativePath, next.absolutePath]
        .flatMap((value) => sourceReferenceKeys(value))) {
        nextSourceKeyCounts.set(key, (nextSourceKeyCounts.get(key) ?? 0) + 1);
      }
    }
    const removedSourceUris = previousFiles
      .filter((previous) => ![previous.sourceUri, previous.sourcePath, previous.relativePath, previous.absolutePath]
        .flatMap((value) => sourceReferenceKeys(value))
        .some((key) => nextSourceKeyCounts.get(key) === 1))
      .flatMap((file) => [file.sourceUri, file.sourcePath, file.relativePath, file.absolutePath]);
    this.filesByUri.clear();
    for (const file of nextFiles) this.filesByUri.set(file.sourceUri, file);
    this.invalidateSemanticSourceUriCache();
    this.actionBinderMembershipCandidates = previousMembership.map((candidate) => ({
      characterFamily: candidate.characterFamily,
      source: this.refreshActionBinderSourceRevision(candidate.source, nextFiles),
      entries: candidate.entries.map((entry) => ({ ...entry }))
    }));
    // The full projection is no longer authoritative after a catalog
    // replacement. Scoped foreground projections remain usable and are still
    // checked against the live file revision by the ACTION IPC layer.
    this.actionBinderMembershipReady = false;
    for (const sourceUri of removedSourceUris) {
      this.staleSources.add(sourceUri);
      this.partialSources.delete(this.canonicalSourceUri(sourceUri));
      this.deleteProjectionVersionsForSource(sourceUri);
    }
    if (removedSourceUris.length > 0) {
      this.coverageStore.markStale(removedSourceUris, 'source removed from indexed catalog');
    }
    this.nativeVersionEpoch += 1;
    this.recomputeCoverageStates();
  }

  /**
   * Version of the native source identity snapshot used by host-side RAG
   * freshness masks.  It changes when the file catalog, invalidation state, or
   * an accepted native projection changes; callers can therefore cache a mask
   * per (WorkspaceIndex, RagCorpus, epoch) instead of rescanning all chunks on
   * every query.
   */
  getNativeVersionEpoch(): number {
    return this.nativeVersionEpoch;
  }

  /**
   * Return semantic/file chunks that cannot be proven to describe the current
   * native source identity.  This is deliberately chunk-level: a partial read
   * may publish a fresh row while durable storage still contains old rows from
   * the same source.  Fresh rows survive; only the old/missing-provenance rows
   * are excluded.
   */
  getRagStaleChunkIds(chunks: readonly RagChunk[]): string[] {
    const staleSources = new Set(
      this.getStaleSourceUris().flatMap((sourceUri) => sourceReferenceKeys(sourceUri))
    );
    const sourceState = new Map<string, { file?: IndexedFile; stale: boolean }>();
    const staleIds = new Set<string>();
    for (const chunk of chunks) {
      let state = sourceState.get(chunk.sourceUri);
      if (!state) {
        const file = findUniqueSourceFile(this.filesByUri, chunk.sourceUri);
        state = {
          ...(file ? { file } : {}),
          stale: sourceReferenceKeys(chunk.sourceUri).some((key) => staleSources.has(key))
        };
        sourceState.set(chunk.sourceUri, state);
      }
      const file = state.file;
      if (state.stale) {
        staleIds.add(chunk.chunkId);
        continue;
      }
      if (!file) continue;
      const chunkOuterHash = chunk.outerFileHash ?? chunk.sourceHash;
      if (file.sha256 !== undefined && chunkOuterHash !== file.sha256) {
        staleIds.add(chunk.chunkId);
        continue;
      }
      if (chunk.sourceRevision !== file.mtimeMs) staleIds.add(chunk.chunkId);
    }
    return [...staleIds];
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

  getParamSemanticState(): ParamSemanticState {
    if (this.paramExports.length > 0) return 'ready';
    return this.paramSemanticState;
  }

  setParamSemanticState(state: ParamSemanticState): void {
    this.paramSemanticState = state;
  }

  /** Return the workspace-wide coverage certificate. */
  getCoverageState(scope = 'workspace', domain?: string): CoverageState {
    const existing = this.coverageStore.get(scope, domain)
      ?? (domain === undefined && scope !== 'workspace' ? this.coverageStore.get('workspace', scope) : undefined);
    if (existing) return existing;
    this.recomputeCoverageStates();
    return this.coverageStore.get(scope, domain)
      ?? (domain === undefined && scope !== 'workspace' ? this.coverageStore.get('workspace', scope) : undefined)
      ?? deriveCoverageState({
      scope,
      ...(domain ? { domain } : {}),
      files: [],
      expectedResourceIds: []
    });
  }

  /** Alias used by discovery consumers that name a certificate a coverage record. */
  getCoverage(domain = 'workspace', scope = 'workspace'): CoverageState {
    return this.getCoverageState(scope, domain === 'workspace' ? undefined : domain);
  }

  getCoverageSnapshot(): CoverageState[] {
    return this.coverageStore.list();
  }

  setCoverageState(state: CoverageState): void {
    this.coverageStore.set(state);
  }

  markCoverageStale(sourceUris: readonly string[], reason = 'source revision changed'): CoverageState[] {
    const normalized = sourceUris.filter((sourceUri) => sourceUri.trim().length > 0);
    for (const sourceUri of normalized) this.staleSources.add(sourceUri);
    if (normalized.length > 0) this.nativeVersionEpoch += 1;
    const marked = this.coverageStore.markStale(normalized, reason);
    this.recomputeCoverageStates();
    return marked;
  }

  markCoveragePartial(sourceUris: readonly string[]): CoverageState[] {
    const normalized = uniqueStrings(sourceUris.map((sourceUri) => this.canonicalSourceUri(sourceUri)));
    for (const sourceUri of normalized) this.partialSources.add(sourceUri);
    if (normalized.length > 0) this.nativeVersionEpoch += 1;
    this.recomputeCoverageStates();
    return this.coverageStore.list();
  }

  /**
   * Gate semantic projection publication.  An async native read may finish
   * after a newer read or a commit; an older projection must never replace the
   * newer one.  Missing provenance remains usable for synthetic/catalog-only
   * callers, but concrete conflicting versions fail closed.
   */
  acceptNativeProjection(
    sourceUri: string,
    version: Omit<CoverageSourceVersion, 'sourceUri'> = {},
    projectionKey = sourceUri
  ): NativeProjectionAcceptance {
    const canonicalSourceUri = this.canonicalSourceUri(sourceUri);
    const incoming: CoverageSourceVersion = {
      sourceUri: canonicalSourceUri,
      ...(version.outerFileHash ? { outerFileHash: version.outerFileHash } : {}),
      ...(version.sourceHash ? { sourceHash: version.sourceHash } : {}),
      ...(version.sourceRevision !== undefined ? { sourceRevision: version.sourceRevision } : {}),
      ...(version.readerSchemaVersion !== undefined ? { readerSchemaVersion: version.readerSchemaVersion } : {}),
      ...(version.metadataSchemaVersion ? { metadataSchemaVersion: version.metadataSchemaVersion } : {})
    };
    const currentFile = findUniqueSourceFile(this.filesByUri, sourceUri);
    const fileConflict = currentFile ? compareToIndexedFile(incoming, currentFile) : undefined;
    if (fileConflict) {
      return {
        accepted: false,
        sourceUri: canonicalSourceUri,
        ...(fileConflict.code ? { code: fileConflict.code } : {}),
        reason: fileConflict.reason
      };
    }

    const previous = this.latestProjectionVersions.get(projectionKey);
    const previousConflict = previous ? compareProjectionVersions(previous, incoming) : undefined;
    if (previousConflict) {
      return {
        accepted: false,
        sourceUri: canonicalSourceUri,
        ...(previousConflict.code ? { code: previousConflict.code } : {}),
        reason: previousConflict.reason
      };
    }

    if (hasConcreteVersion(incoming)) this.latestProjectionVersions.set(projectionKey, incoming);
    this.staleSources.delete(canonicalSourceUri);
    if (canonicalSourceUri !== sourceUri) this.staleSources.delete(sourceUri);
    if (currentFile) {
      for (const alias of [currentFile.sourceUri, currentFile.sourcePath, currentFile.relativePath, currentFile.absolutePath]) {
        this.staleSources.delete(alias);
      }
    }
    this.nativeVersionEpoch += 1;
    this.recomputeCoverageStates();
    return { accepted: true, sourceUri: canonicalSourceUri };
  }

  isNativeProjectionCurrent(sourceUri: string, version: Omit<CoverageSourceVersion, 'sourceUri'> = {}): boolean {
    const canonicalSourceUri = this.canonicalSourceUri(sourceUri);
    const incoming: CoverageSourceVersion = {
      sourceUri: canonicalSourceUri,
      ...(version.outerFileHash ? { outerFileHash: version.outerFileHash } : {}),
      ...(version.sourceHash ? { sourceHash: version.sourceHash } : {}),
      ...(version.sourceRevision !== undefined ? { sourceRevision: version.sourceRevision } : {}),
      ...(version.readerSchemaVersion !== undefined ? { readerSchemaVersion: version.readerSchemaVersion } : {}),
      ...(version.metadataSchemaVersion ? { metadataSchemaVersion: version.metadataSchemaVersion } : {})
    };
    const currentFile = findUniqueSourceFile(this.filesByUri, sourceUri);
    return !currentFile || (!compareToIndexedFile(incoming, currentFile)
      && !(this.latestProjectionVersions.get(canonicalSourceUri)
        && compareProjectionVersions(this.latestProjectionVersions.get(canonicalSourceUri)!, incoming)));
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
    this.invalidateSemanticSourceUriCache();
    if (uniqueSources.length > 0) this.markReferencesDirty();
    for (const sourceUri of uniqueSources) {
      this.staleSources.add(sourceUri);
      this.partialSources.delete(this.canonicalSourceUri(sourceUri));
      this.deleteProjectionVersionsForSource(sourceUri);
    }
    if (uniqueSources.length > 0) this.nativeVersionEpoch += 1;
    this.coverageStore.markStale(uniqueSources, 'source invalidated before semantic refresh');
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
    this.scriptExports = this.scriptExports.filter((item) => !isChangedSource(item.sourceUri));

    const referencesRebuilt = uniqueSources.length > 0 ? this.rebuildReferences().edges.length : this.references.length;
    this.recomputeCoverageStates();
    return { sourceUris: uniqueSources, removed, referencesRebuilt };
  }

  private deleteProjectionVersionsForSource(sourceUri: string): void {
    const candidates = new Set([sourceUri, this.canonicalSourceUri(sourceUri)]);
    for (const key of this.latestProjectionVersions.keys()) {
      const separator = key.indexOf('\u0000');
      const keySource = separator < 0 ? key : key.slice(0, separator);
      if (candidates.has(keySource)) this.latestProjectionVersions.delete(key);
    }
  }

  invalidateSource(sourceUri: string): SourceInvalidationResult {
    return this.invalidateChangedSources([sourceUri]);
  }

  upsertEventExport(value: EventExport): boolean {
    // An empty outline has no source URI in EventExport and therefore cannot
    // identify a replacement. Treat it as an incomplete observation so it
    // cannot erase an already indexed rich event body.
    if (value.events.length === 0) return false;
    const sourceUri = value.events[0]?.sourceUri;
    const projectionKey = eventExportKey(value);
    if (sourceUri && !this.acceptNativeProjection(sourceUri, projectionVersion(value), projectionKey ?? sourceUri).accepted) return false;
    this.invalidateSemanticSourceUriCache('event');
    const key = projectionKey;
    // An export without one unambiguous source identity cannot safely replace
    // another export. Keep it as a separate candidate instead of collapsing it
    // under a shared "unknown" key.
    if (!key || !hasUniqueEventIds(value.events)) {
      this.eventExports = [...this.eventExports, value];
      this.recomputeCoverageStates();
      return true;
    }
    const matches = this.eventExports
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => eventExportKey(item) === key);
    // Multiple exports with the same physical identity are ambiguous. Do not
    // pick the first one and do not erase either body; a caller can invalidate
    // the source and ingest a fresh export to resolve the ambiguity.
    if (matches.length > 1) {
      this.eventExports = [...this.eventExports, value];
      this.recomputeCoverageStates();
      return true;
    }
    if (matches.length === 0) {
      this.eventExports = [...this.eventExports, value];
      this.recomputeCoverageStates();
      return true;
    }
    const match = matches[0]!;
    const copy = [...this.eventExports];
    copy[match.index] = mergeEventExport(match.item, value);
    this.eventExports = copy;
    this.recomputeCoverageStates();
    return true;
  }

  upsertMapExport(value: MapExport): boolean {
    const sourceUri = mapExportSourceUri(value);
    if (sourceUri && !this.acceptNativeProjection(sourceUri, {
      ...(value.outerFileHash ? { outerFileHash: value.outerFileHash } : {}),
      ...(value.sourceHash ? { sourceHash: value.sourceHash } : {}),
      ...(value.sourceRevision !== undefined ? { sourceRevision: value.sourceRevision } : {}),
      readerSchemaVersion: value.readerSchemaRevision ?? MSB_READER_SCHEMA_REVISION,
      metadataSchemaVersion: METADATA_SCHEMA_HASH
    }).accepted) return false;
    this.invalidateSemanticSourceUriCache('map');
    const derivedKey = value.derivedKey
      ?? ((value.outerFileHash ?? value.sourceHash)
        ? computeMapDerivedKey({ outerHash: value.outerFileHash ?? value.sourceHash! })
        : undefined);
    const enriched: MapExport = {
      ...value,
      readerSchemaRevision: value.readerSchemaRevision ?? MSB_READER_SCHEMA_REVISION,
      ...(derivedKey ? { derivedKey } : {})
    };
    // A map block name is not a physical identity: base/overlay (or two MSB
    // containers with the same mapId) may legitimately expose the same block.
    // Keep one projection per source+mapId so an incoming source cannot erase
    // the other source before RAG chunk identity/persistence sees it.
    this.mapExports = replaceByKey(this.mapExports, mapExportKey(enriched), mapExportKey, enriched);
    this.recomputeCoverageStates();
    return true;
  }

  /**
   * Idempotent migration of MSB reader schema (SF-02: revision 1 -> revision 2).
   * Stale map EntityID projections from schema revision < 2 are evicted/invalidated,
   * and dependent references are rebuilt. Returns the number of invalidated map sources.
   */
  migrateMsbReaderSchema(targetRevision: number = MSB_READER_SCHEMA_REVISION): {
    migratedSources: string[];
    staleMapExportsRemoved: number;
    referencesRebuilt: number;
  } {
    this.invalidateSemanticSourceUriCache('map');
    const staleMapSources: string[] = [];
    this.mapExports = this.mapExports.filter((mapExport) => {
      const rev = mapExport.readerSchemaRevision ?? 1;
      if (rev < targetRevision) {
        const sourceUri = mapExport.entities[0]?.sourceUri ?? mapExport.regions[0]?.sourceUri;
        if (sourceUri) staleMapSources.push(sourceUri);
        return false;
      }
      return true;
    });
    const referencesRebuilt = staleMapSources.length > 0 ? this.rebuildReferences().edges.length : this.references.length;
    for (const sourceUri of staleMapSources) this.staleSources.add(sourceUri);
    this.recomputeCoverageStates();
    return {
      migratedSources: staleMapSources,
      staleMapExportsRemoved: staleMapSources.length,
      referencesRebuilt
    };
  }

  upsertParamExport(value: ParamExport): boolean {
    const sourceUri = paramExportSourceUri(value);
    if (sourceUri && !this.acceptNativeProjection(sourceUri, projectionVersion(value), paramExportKey(value)).accepted) return false;
    this.invalidateSemanticSourceUriCache('param');
    this.paramExports = replaceByKey(this.paramExports, paramExportKey(value), paramExportKey, value);
    if (this.paramExports.length > 0) {
      this.paramSemanticState = 'ready';
    }
    this.recomputeCoverageStates();
    return true;
  }

  /** Merge a partial live PARAM read without erasing rows indexed earlier. Returns false for a no-op or rejected stale projection. */
  mergeParamRows(value: ParamExport): boolean {
    const key = paramExportKey(value);
    const existing = this.paramExports.find((item) => paramExportKey(item) === key);
    if (existing && sameProvidedParamExportMetadata(existing, value)
      && value.rows.every((incoming) => {
        const previous = existing.rows.find((row) => paramRowKey(row) === paramRowKey(incoming));
        return previous !== undefined && sameParamRowAfterMerge(previous, incoming);
      })) {
      return false;
    }
    // Row IDs are only unique inside one native source.  Keying by rowId alone
    // used to let a live read from source B overwrite source A, and could then
    // carry source A's old semantic body under source B's hash.
    // Row IDs are scoped by the physical PARAM child, not merely by the
    // packed source URI.  Two BND4 tables commonly contain the same numeric
    // row ID; keep their identities separate while merging a slim live read.
    const rows = new Map((existing?.rows ?? []).map((row) => [paramRowKey(row), row]));
    for (const row of value.rows) {
      const key = paramRowKey(row);
      const previous = rows.get(key);
      if (!previous) {
        rows.set(key, row);
        continue;
      }
      // read_param_fields pages field cells.  Merge field projections by
      // physical identity instead of replacing page 1 with page 2; otherwise
      // a second cursor call would silently erase the first page from the
      // shared semantic index.
      const fields = new Map((previous.fields ?? []).map((field) => [field.fieldId ?? field.name, field]));
      for (const field of row.fields ?? []) fields.set(field.fieldId ?? field.name, field);
      const { fields: _incomingFields, ...rowWithoutFields } = row;
      const mergedRow: ParamRowSymbol = { ...previous, ...rowWithoutFields };
      if (fields.size > 0) mergedRow.fields = [...fields.values()];
      rows.set(key, mergedRow);
    }
    const mergedRows = [...rows.values()];
    const sourceHashes = new Set(mergedRows.map((row) => row.sourceHash).filter((item): item is string => Boolean(item)));
    const outerFileHashes = new Set(mergedRows.map((row) => row.outerFileHash).filter((item): item is string => Boolean(item)));
    const sourceRevisions = new Set(mergedRows.map((row) => row.sourceRevision).filter((item): item is number => item !== undefined));
    return this.upsertParamExport({
      ...(value.sourceUri !== undefined ? { sourceUri: value.sourceUri } : existing?.sourceUri !== undefined ? { sourceUri: existing.sourceUri } : {}),
      ...(value.entryIndex !== undefined ? { entryIndex: value.entryIndex } : existing?.entryIndex !== undefined ? { entryIndex: existing.entryIndex } : {}),
      ...(value.entryName !== undefined ? { entryName: value.entryName } : existing?.entryName !== undefined ? { entryName: existing.entryName } : {}),
      paramName: value.paramName,
      ...(outerFileHashes.size === 1 ? { outerFileHash: [...outerFileHashes][0] } : {}),
      ...(sourceHashes.size === 1 ? { sourceHash: [...sourceHashes][0] } : {}),
      ...(sourceRevisions.size === 1 ? { sourceRevision: [...sourceRevisions][0] } : {}),
      rows: mergedRows
    });
  }

  upsertMsgExport(value: MsgExport): boolean {
    const sourceUri = msgExportSourceUri(value);
    if (sourceUri && !this.acceptNativeProjection(sourceUri, projectionVersion(value), msgProjectionKey(value)).accepted) return false;
    this.invalidateSemanticSourceUriCache('msg');
    const key = value.category ?? 'default';
    this.msgExports = replaceByKey(this.msgExports, key, (item) => item.category ?? 'default', value);
    this.recomputeCoverageStates();
    return true;
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
    const outerFileHashes = new Set(mergedEntries.map((entry) => entry.outerFileHash).filter((item): item is string => Boolean(item)));
    const sourceRevisions = new Set(mergedEntries.map((entry) => entry.sourceRevision).filter((item): item is number => item !== undefined));
    this.upsertMsgExport({
      ...(value.category ? { category: value.category } : {}),
      ...(outerFileHashes.size === 1 ? { outerFileHash: [...outerFileHashes][0] } : {}),
      ...(sourceHashes.size === 1 ? { sourceHash: [...sourceHashes][0] } : {}),
      ...(sourceRevisions.size === 1 ? { sourceRevision: [...sourceRevisions][0] } : {}),
      entries: mergedEntries
    });
  }

  /** 照 upsertMapExport 抄：TAE 一份 anibnd 一个 TaeExport，按 sourceUri 替换。 */
  upsertTaeExport(value: TaeExport): boolean {
    if (!this.acceptNativeProjection(value.sourceUri, projectionVersion(value)).accepted) return false;
    this.invalidateSemanticSourceUriCache('action');
    this.taeExports = replaceByKey(this.taeExports, value.sourceUri, (item) => item.sourceUri, value);
    this.recomputeCoverageStates();
    return true;
  }

  /** Merge bounded reads from the same snapshot without dropping unread siblings. */
  mergeTaeEvents(value: TaeExport): boolean {
    const previous = this.taeExports.find((item) => item.sourceUri === value.sourceUri);
    // A physical snapshot can be ingested without a catalog mtime and later
    // read through the public tool with one. Matching captured bytes, native
    // logical identity and reader revision retain unread sibling projections.
    const sameSnapshot = previous && previous.sourceHash === value.sourceHash
      && previous.readerSchemaRevision === value.readerSchemaRevision
      && (previous.outerFileHash && value.outerFileHash
        ? previous.outerFileHash === value.outerFileHash
        : previous.sourceRevision === value.sourceRevision);
    if (!sameSnapshot)
      return this.upsertTaeExport(value);
    const key = (animation: TaeAnimSymbol) => JSON.stringify([animation.taeEntryIndex, animation.taeEntryId, animation.taeEntryName, animation.taeGroup, animation.animId]);
    const animations = new Map(previous.animations.map((animation) => [key(animation), animation]));
    for (const animation of value.animations) {
      const old = animations.get(key(animation));
      const events = new Map((old?.events ?? []).map((event) => [event.index, event]));
      for (const event of animation.events) events.set(event.index, event);
      const ordered = [...events.values()].sort((a, b) => a.index - b.index);
      const eventCount = animation.eventCount ?? old?.eventCount;
      const eventsComplete = eventCount !== undefined && ordered.length === eventCount
        && ordered.every((event, index) => event.index === index);
      animations.set(key(animation), { ...old, ...animation, ...(eventCount === undefined ? {} : { eventCount }), eventsComplete, events: ordered });
    }
    return this.upsertTaeExport({ ...previous, ...value, animations: [...animations.values()] });
  }

  /**
   * Publish a bounded LUABND catalog or a native child read into the shared
   * semantic snapshot. A list operation may only provide catalog-only or
   * bytecode children; those remain visible for containment, while the source
   * is marked partial until decodable source/IR coverage is available.
   */
  upsertScriptExport(value: ScriptExport): boolean {
    if (!this.acceptNativeProjection(value.sourceUri, projectionVersion(value), `script:${value.sourceUri}`).accepted) {
      return false;
    }
    this.invalidateSemanticSourceUriCache('script');
    this.scriptExports = replaceByKey(this.scriptExports, value.sourceUri, (item) => item.sourceUri, value);
    const incomplete = value.catalogComplete !== true
      || value.scripts.some((script) => (
        script.contentKind === 'catalog-only'
        || (script.contentKind === 'bytecode' && !script.sourceText)
      ));
    if (incomplete) this.partialSources.add(value.sourceUri);
    else this.partialSources.delete(value.sourceUri);
    this.recomputeCoverageStates();
    return true;
  }

  /**
   * 按精确 sourceUri + TAE entry selector + animId 读取一个 TAE animation identity。
   *
   * sourceUri 不做 alias/fuzzy 匹配，animId 也不跨来源合并；同一来源出现
   * 多个相同 animId 时，未带 selector 返回 AMBIGUOUS，调用方不得取首项继续解析。
   */
  lookupTaeAnimation(
    sourceUri: string,
    animId: number,
    selector: TaeAnimationIdentitySelector = {}
  ): TaeAnimationLookup {
    const matches: Array<{ exportItem: TaeExport; animation: TaeAnimSymbol }> = [];
    for (const exportItem of this.taeExports) {
      if (exportItem.sourceUri !== sourceUri) continue;
      for (const animation of exportItem.animations) {
        if (animation.animId !== animId) continue;
        if (!matchesTaeEntryIdentity(animation, selector)) continue;
        matches.push({ exportItem, animation });
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
    const cacheableDefaultBuild = Object.keys(options).length === 0;
    if (cacheableDefaultBuild && !this.referencesDirty && this.lastReferenceBuildResult) {
      return this.lastReferenceBuildResult;
    }
    // Drop stale or differently configured edges before allocating the next
    // full graph. If the build throws, keeping the old graph would make stale
    // relations appear current and also doubles the peak edge memory.
    this.references = [];
    this.referencesDirty = true;
    this.lastReferenceBuildResult = null;
    const result = buildReferenceGraph(this.toSymbolBundle(), options);
    this.references = result.edges;
    if (cacheableDefaultBuild) {
      this.referencesDirty = false;
      this.lastReferenceBuildResult = result;
    } else {
      // Non-default options change the graph semantics; a later default call
      // must not reuse this result as the canonical production graph.
      this.referencesDirty = true;
      this.lastReferenceBuildResult = null;
    }
    return result;
  }

  toSymbolBundle(): SymbolBundle {
    return {
      ...(this.eventExports.length > 0 ? { events: this.eventExports } : {}),
      ...(this.mapExports.length > 0 ? { maps: this.mapExports } : {}),
      ...(this.paramExports.length > 0 ? { params: this.paramExports } : {}),
      ...(this.msgExports.length > 0 ? { msgs: this.msgExports } : {}),
      ...(this.taeExports.length > 0 ? { tae: this.taeExports } : {}),
      ...(this.scriptExports.length > 0 ? { scripts: this.scriptExports } : {})
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

  /**
   * Backwards-compatible bounded resource search.  Callers that need to
   * inspect every match must use searchResourcesPage and follow its opaque
   * cursor; this method deliberately retains the historical array shape.
   */
  searchResources(options: SearchResourcesOptions): Array<SearchResult<IndexedFile>> {
    if (options.cursor) return this.searchResourcesPage(options).items;
    const sourceFilter = options.sourceFilter ?? 'active';
    if (sourceFilter !== 'active' && sourceFilter !== 'all' && sourceFilter !== 'artifacts') {
      throw Object.assign(new Error('sourceFilter 必须是 active、all 或 artifacts。'), {
        code: 'INVALID_RESOURCE_SEARCH_FILTER'
      });
    }
    const scope: ResourceSearchCursorScope = {
      workspaceId: this.workspaceId,
      query: normalizeSearch(options.query ?? ''),
      kinds: normalizeResourceSearchKinds(options.kinds),
      // The legacy API was not page-envelope limited. Keep its requested
      // limit semantics while the new page API remains bounded for Agents.
      limit: normalizeResourceSearchLimit(options.limit, false),
      sourceFilter
    };
    return this.searchResourceResults(scope).slice(0, scope.limit);
  }

  /**
   * Search the catalog with a stable, query-bound continuation cursor.
   * Recovery artifacts remain in the catalog for restore/history consumers,
   * but are excluded from the default active source view.  `sourceFilter`
   * makes that boundary explicit without deleting or hiding the files from
   * the workspace index itself.
   */
  searchResourcesPage(options: SearchResourcesOptions): SearchResourcesPage {
    const sourceFilter = options.sourceFilter ?? 'active';
    if (sourceFilter !== 'active' && sourceFilter !== 'all' && sourceFilter !== 'artifacts') {
      throw Object.assign(new Error('sourceFilter 必须是 active、all 或 artifacts。'), {
        code: 'INVALID_RESOURCE_SEARCH_FILTER'
      });
    }
    const hasQuery = options.query !== undefined;
    const requestedQuery = normalizeSearch(options.query ?? '');
    const requestedKinds = normalizeResourceSearchKinds(options.kinds);
    const requestedLimit = normalizeResourceSearchLimit(options.limit, true);
    let scope: ResourceSearchCursorScope = {
      workspaceId: this.workspaceId,
      query: requestedQuery,
      kinds: requestedKinds,
      limit: requestedLimit,
      sourceFilter
    };
    let offset = 0;
    let expectedHash: string | undefined;
    const cursor = options.cursor?.trim();
    if (cursor) {
      let payload;
      try {
        payload = parseOpaqueCursor(cursor);
      } catch (error) {
        throw Object.assign(
          new Error(error instanceof Error ? error.message : '资源搜索 cursor 无效。'),
          { code: (error as { code?: string }).code ?? 'INVALID_READ_CURSOR' }
        );
      }
      if (payload.sessionId !== RESOURCE_SEARCH_CURSOR_SESSION
        || payload.domain !== RESOURCE_SEARCH_CURSOR_DOMAIN) {
        throw Object.assign(new Error('资源搜索 cursor 不属于当前搜索范围。'), {
          code: 'RESOURCE_SEARCH_CURSOR_SCOPE_MISMATCH'
        });
      }
      let parsed: ResourceSearchCursorScope;
      try {
        parsed = JSON.parse(payload.scope) as ResourceSearchCursorScope;
      } catch {
        throw Object.assign(new Error('资源搜索 cursor 范围无效。'), {
          code: 'RESOURCE_SEARCH_CURSOR_SCOPE_MISMATCH'
        });
      }
      if (!isResourceSearchCursorScope(parsed) || parsed.workspaceId !== this.workspaceId) {
        throw Object.assign(new Error('资源搜索 cursor 范围无效。'), {
          code: 'RESOURCE_SEARCH_CURSOR_SCOPE_MISMATCH'
        });
      }
      if ((hasQuery && requestedQuery !== parsed.query)
        || (options.limit !== undefined && requestedLimit !== parsed.limit)
        || (options.sourceFilter !== undefined && sourceFilter !== parsed.sourceFilter)
        || (options.kinds !== undefined && !sameStringArray(requestedKinds, parsed.kinds))) {
        throw Object.assign(new Error('续页时不能改变资源搜索条件。'), {
          code: 'RESOURCE_SEARCH_CURSOR_SCOPE_MISMATCH'
        });
      }
      scope = parsed;
      offset = payload.offset;
      expectedHash = payload.sourceHash;
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw Object.assign(new Error('资源搜索 cursor offset 无效。'), {
        code: 'INVALID_READ_CURSOR'
      });
    }

    const ranked = this.searchResourceResults(scope);
    const sourceHash = resourceSearchFingerprint(scope, ranked);
    if (expectedHash !== undefined && expectedHash !== sourceHash) {
      throw Object.assign(new Error('资源目录已变化，请从头搜索。'), {
        code: 'STALE_READ_CURSOR'
      });
    }
    const items = ranked.slice(offset, offset + scope.limit);
    const nextOffset = offset + items.length;
    const hasMore = nextOffset < ranked.length;
    const nextCursor = hasMore ? createOpaqueCursor({
      sessionId: RESOURCE_SEARCH_CURSOR_SESSION,
      // CursorPayload is shared with native edit sessions. The scope and
      // session id are the authority for this catalog-only cursor; `script`
      // is used as the existing opaque token domain without broadening the
      // native edit-domain contract.
      domain: RESOURCE_SEARCH_CURSOR_DOMAIN,
      scope: JSON.stringify(scope),
      sourceHash,
      offset: nextOffset
    }) : undefined;
    const nextActions = nextCursor ? [{
      tool: 'search_resources' as const,
      args: { query: scope.query, cursor: nextCursor },
      reason: '继续读取后续资源搜索结果'
    }] : [];
    return {
      items,
      matches: items,
      total: ranked.length,
      totalCount: ranked.length,
      offset,
      returned: items.length,
      returnedCount: items.length,
      limit: scope.limit,
      hasMore,
      truncated: hasMore,
      ...(nextCursor ? { nextCursor } : {}),
      nextActions
    };
  }

  private searchResourceResults(scope: ResourceSearchCursorScope): Array<SearchResult<IndexedFile>> {
    const kinds = scope.kinds.length > 0 ? new Set<ResourceKind>(scope.kinds) : null;
    const results: Array<SearchResult<IndexedFile>> = [];
    for (const file of this.filesByUri.values()) {
      const active = isActiveSemanticSource(file);
      if (scope.sourceFilter === 'active' && !active) continue;
      if (scope.sourceFilter === 'artifacts' && active) continue;
      if (kinds && !kinds.has(file.resourceKind)) continue;
      const text = [
        file.relativePath,
        file.resourceKind,
        file.extension,
        file.compoundExtension,
        file.formatKind,
        file.formatLabel
      ].join(' ');
      const score = scoreResource(file, text, scope.query);
      if (score > 0) results.push({ item: file, score, highlights: makeHighlights(text, buildSearchQueryProfile(scope.query)) });
    }
    return sortAndLimit(results, results.length);
  }

  searchEvents(query: string, limit = 100): Array<SearchResult<EventSymbol>> {
    return this.searchEventsPage(query, 0, limit).items;
  }

  /**
   * Return a deterministic event-search window over the complete indexed
   * candidate set. The old searchEvents method applied the limit before the
   * host could mint a continuation cursor, so a truncated Agent result had no
   * safe way to request the next candidates.
   */
  searchEventsPage(query: string, offset = 0, limit = 100): {
    items: Array<SearchResult<EventSymbol>>;
    total: number;
    offset: number;
    returned: number;
    hasMore: boolean;
  } {
    const events = dedupeEventSearchSymbols(this.activeEventExportsForSearch());
    const ranked = searchSymbols(events, query, events.length, eventSearchText);
    const safeOffset = Math.max(0, Math.trunc(offset));
    const safeLimit = Math.max(1, Math.trunc(limit));
    const items = ranked.slice(safeOffset, safeOffset + safeLimit);
    return {
      items,
      total: ranked.length,
      offset: safeOffset,
      returned: items.length,
      hasMore: safeOffset + items.length < ranked.length
    };
  }

  /** Exact event lookup used after the caller has resolved a source file. */
  lookupEvents(eventId: number, sourceUri?: string): EventSymbol[] {
    return dedupeEventSearchSymbols(this.activeEventExportsForSearch())
      .filter((event) => event.eventId === eventId
        && (sourceUri === undefined || event.sourceUri === sourceUri));
  }

  searchMapEntities(query: string, limit = 100): Array<SearchResult<MapEntitySymbol | MapRegionSymbol>> {
    return searchSymbols(this.mapExports.flatMap((item) => [...item.entities, ...item.regions])
      .filter((symbol) => this.isActiveSemanticSourceUri(symbol.sourceUri)), query, limit, mapSymbolSearchText,
      (symbol, _text, profile) => scoreMapSymbol(symbol, profile));
  }

  searchParamRows(query: string, limit = 100, paramNames?: readonly string[]): Array<SearchResult<ParamRowSymbol>> {
    const allowed = paramNames && paramNames.length > 0
      ? new Set(paramNames.flatMap(paramNameVariants))
      : null;
    // Native semantic rows often have no rowName. Resolve only the bounded,
    // source-backed PARAM↔FMG links once per query so an item-name search can
    // find the physical row without scanning/rebuilding RAG per tool call.
    const textEntryLookup = buildTextEntryLookup(this.activeMsgExportsForSearch());
    // Rank each physical table independently before interleaving. Ranking the
    // flattened 50k-row corpus first can exhaust the limit on one dense table
    // and hide the NpcParam/ItemLotParam representative entirely.
    const ranked = this.paramExports
      .filter((item) => allowed === null || paramExportMatches(item, allowed))
      .flatMap((item) => searchSymbols(
        item.rows.filter((row) => this.isActiveSemanticSourceUri(row.sourceUri)),
        query,
        limit,
        (row) => paramRowSearchText(row, textEntryLookup),
        (row, text, profile) => scoreParamRow(row, text, profile)
      ));
    return diversifyParamSearchResults(
      ranked,
      limit,
      query
    );
  }

  searchTextEntries(query: string, limit = 100): Array<SearchResult<TextEntrySymbol>> {
    return searchSymbols(this.msgExports.flatMap((item) => item.entries)
      .filter((entry) => this.isActiveSemanticSourceUri(entry.sourceUri)), query, limit, textEntrySearchText,
      (entry, text, profile) => scoreTextEntry(entry, text, profile));
  }

  /** 问题 6-C/D：按地址（action://c1050/A0200/e0 / c1050#A0200.e0）、类型名与字段值搜 TAE 词条。 */
  searchTaeEvents(query: string, limit = 100): Array<SearchResult<TaeEventSymbol>> {
    const events = this.taeExports
      .filter((item) => this.isActiveSemanticSourceUri(item.sourceUri))
      .flatMap((item) => item.animations.flatMap((anim) => anim.events));
    return searchSymbols(events, query, limit, taeEventSearchText);
  }

  /** A hit expands to its whole native action; limits count actions. */
  searchTaeActionGroups(query: string, limit = 100) {
    const hits = this.searchTaeEvents(query, Number.MAX_SAFE_INTEGER);
    const byUri = new Map(hits.map((hit) => [hit.item, hit]));
    const groups = this.taeExports.filter((item) => this.isActiveSemanticSourceUri(item.sourceUri))
      .flatMap((source) => source.animations.flatMap((animation) => {
        const matches = animation.events.flatMap((event) => byUri.has(event) ? [byUri.get(event)!] : []);
        if (matches.length === 0) return [];
        const selector = animation.taeEntryIndex !== undefined ? { taeEntryIndex: animation.taeEntryIndex }
          : animation.taeEntryId !== undefined ? { taeEntryId: animation.taeEntryId }
          : animation.taeEntryName !== undefined ? { taeEntryName: animation.taeEntryName }
          : animation.taeGroup !== undefined ? { taeGroup: animation.taeGroup } : {};
        return [{ item: { sourceUri: source.sourceUri, chrId: source.chrId,
          ...animation, eventsComplete: (animation.eventCount !== undefined
            && animation.events.length === animation.eventCount && [...animation.events].sort((a, b) => a.index - b.index).every((e, i) => e.index === i)),
          address: formatActionAddress({ chr: source.chrId, animId: animation.animId, ...selector }),
          sourceHash: source.outerFileHash ?? source.sourceHash, sourceRevision: source.sourceRevision, readerSchemaRevision: source.readerSchemaRevision,
          events: [...animation.events].sort((a, b) => a.index - b.index) },
          score: Math.max(...matches.map((hit) => hit.score)), matchedEventIndices: matches.map((hit) => hit.item.index) }];
      }));
    return groups.sort((a, b) => b.score - a.score).slice(0, limit);
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

  private isActiveSemanticSourceUri(sourceUri: string): boolean {
    const file = findUniqueSourceFile(this.filesByUri, sourceUri);
    // Synthetic semantic fixtures may not have a catalog row. In that case
    // there is no evidence that the source is a recovery artifact, so retain
    // it; a catalog row marked backup/previous is a hard exclusion.
    return !file || isActiveSemanticSource(file);
  }

  private activeEventExportsForSearch(): EventExport[] {
    return this.eventExports.flatMap((item) => {
      const events = item.events.filter((event) => this.isActiveSemanticSourceUri(event.sourceUri));
      return events.length > 0 ? [{ ...item, events }] : [];
    });
  }

  private activeMsgExportsForSearch(): MsgExport[] {
    return this.msgExports.flatMap((item) => {
      const entries = item.entries.filter((entry) => this.isActiveSemanticSourceUri(entry.sourceUri));
      return entries.length > 0 ? [{ ...item, entries }] : [];
    });
  }

  getFiles(): IndexedFile[] {
    return [...this.filesByUri.values()];
  }

  getFile(uri: string): IndexedFile | undefined {
    return findUniqueSourceFile(this.filesByUri, uri);
  }

  /**
   * Return stale source identities plus every indexed alias for the same
   * physical file.  RAG retrieval uses this small set to exclude the old
   * durable corpus while a post-commit semantic refresh is in flight; it does
   * not rebuild or clear the durable corpus.
   */
  getStaleSourceUris(): string[] {
    const stale = new Set(this.staleSources);
    for (const sourceUri of [...this.staleSources]) {
      const file = findUniqueSourceFile(this.filesByUri, sourceUri);
      if (!file) continue;
      for (const alias of [file.sourceUri, file.sourcePath, file.relativePath, file.absolutePath]) {
        if (alias.trim().length > 0) stale.add(alias);
      }
    }
    return [...stale];
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

  private canonicalSourceUri(sourceUri: string): string {
    return findUniqueSourceFile(this.filesByUri, sourceUri)?.sourceUri ?? sourceUri;
  }

  private recomputeCoverageStates(): void {
    this.coverageStore.clear();
    const domains: ResourceKind[] = ['event', 'map', 'param', 'msg', 'action', 'script'];
    for (const domain of domains) {
      const files = [...this.filesByUri.values()].filter((file) => file.resourceKind === domain);
      const coverageFiles = files.map((file) => this.partialSources.has(file.sourceUri)
        ? { ...file, parseStatus: 'partial' as const }
        : file);
      const projectedSourceUris = this.semanticSourceUris(domain);
      const expectedResourceIds = files.map((file) => file.sourceUri);
      const coveredResourceIds = projectedSourceUris.length > 0
        ? projectedSourceUris
        : files
          .filter((file) => file.parseStatus === 'parsed')
          .map((file) => file.sourceUri);
      const sourceVersions = files.map((file) => {
      const version: CoverageSourceVersion = {
          sourceUri: file.sourceUri,
          ...(file.sha256 ? { outerFileHash: file.sha256 } : {}),
          ...(file.sha256 ? { sourceHash: file.sha256 } : {}),
          sourceRevision: file.mtimeMs
        };
        if (domain === 'map') {
          const map = this.mapExports.find((item) => mapExportSourceUri(item) === file.sourceUri);
          return {
            ...version,
            readerSchemaVersion: map?.readerSchemaRevision ?? MSB_READER_SCHEMA_REVISION,
            metadataSchemaVersion: METADATA_SCHEMA_HASH
          };
        }
        return version;
      });
      const stale = [...this.staleSources].filter((sourceUri) => (
        files.some((file) => sourceUriMatchesFile(sourceUri, file))
          || projectedSourceUris.includes(sourceUri)
      ));
      this.coverageStore.set(deriveCoverageState({
        scope: 'workspace',
        domain,
        files: coverageFiles,
        coveredResourceIds,
        expectedResourceIds,
        sourceVersions,
        staleSources: stale,
        sourceUnavailable: files.length === 0 && projectedSourceUris.length > 0,
        diagnostics: files.length === 0 && projectedSourceUris.length > 0
          ? ['semantic projection exists without a current file catalog']
          : []
      }));
    }

    const files = [...this.filesByUri.values()];
    const coverageFiles = files.map((file) => this.partialSources.has(file.sourceUri)
      ? { ...file, parseStatus: 'partial' as const }
      : file);
    const allProjectedSourceUris = uniqueStrings([
      ...this.semanticSourceUris('event'),
      ...this.semanticSourceUris('map'),
      ...this.semanticSourceUris('param'),
      ...this.semanticSourceUris('msg'),
      ...this.semanticSourceUris('action'),
      ...this.semanticSourceUris('script')
    ]);
    const allExpected = files.map((file) => file.sourceUri);
    const allCovered = allProjectedSourceUris.length > 0
      ? allProjectedSourceUris
      : files.filter((file) => file.parseStatus === 'parsed').map((file) => file.sourceUri);
    this.coverageStore.set(deriveCoverageState({
      scope: 'workspace',
      files: coverageFiles,
      coveredResourceIds: allCovered,
      expectedResourceIds: allExpected,
      staleSources: [...this.staleSources],
      sourceVersions: files.map((file) => ({
        sourceUri: file.sourceUri,
        ...(file.sha256 ? { outerFileHash: file.sha256 } : {}),
        ...(file.sha256 ? { sourceHash: file.sha256 } : {}),
        sourceRevision: file.mtimeMs
      }))
    }));
  }

  private invalidateSemanticSourceUriCache(...domains: ResourceKind[]): void {
    if (domains.length === 0) {
      this.semanticSourceUriCache.clear();
      return;
    }
    if (domains.some((domain) => ['event', 'map', 'param', 'msg', 'action', 'script'].includes(domain))) {
      this.markReferencesDirty();
    }
    for (const domain of domains) this.semanticSourceUriCache.delete(domain);
  }

  private markReferencesDirty(): void {
    this.referencesDirty = true;
    this.references = [];
    this.lastReferenceBuildResult = null;
  }

  private semanticSourceUris(domain: ResourceKind): readonly string[] {
    const cached = this.semanticSourceUriCache.get(domain);
    if (cached !== undefined) return cached;

    let result: string[];
    if (domain === 'event') {
      result = uniqueStrings(this.eventExports.flatMap((item) => item.events.map((event) => event.sourceUri)));
    } else if (domain === 'map') {
      result = uniqueStrings(this.mapExports.flatMap((item) => [
        ...item.entities.map((entity) => entity.sourceUri),
        ...item.regions.map((region) => region.sourceUri)
      ]));
    } else if (domain === 'param') {
      const uris = new Set<string>();
      for (const item of this.paramExports) {
        if (item.sourceUri) uris.add(item.sourceUri);
        else if (item.rows[0]?.sourceUri) uris.add(item.rows[0].sourceUri);
      }
      result = [...uris];
    } else if (domain === 'msg') {
      const uris = new Set<string>();
      for (const item of this.msgExports) {
        for (const entry of item.entries) {
          if (entry.sourceUri) uris.add(entry.sourceUri);
        }
      }
      result = [...uris];
    } else if (domain === 'action') {
      result = uniqueStrings(this.taeExports.map((item) => item.sourceUri));
    } else if (domain === 'script') {
      result = uniqueStrings(this.scriptExports.map((item) => item.sourceUri));
    } else {
      result = [];
    }
    this.semanticSourceUriCache.set(domain, result);
    return result;
  }
}

const RESOURCE_SEARCH_CURSOR_SESSION = 'workspace-resource-search-v1';
// Native cursor payloads use the existing edit-domain union. The session id
// and scope below make this a separate catalog-only cursor contract.
const RESOURCE_SEARCH_CURSOR_DOMAIN = 'script' as const;
const RESOURCE_SEARCH_PAGE_LIMIT = 6;

interface ResourceSearchCursorScope {
  workspaceId: string;
  query: string;
  kinds: ResourceKind[];
  limit: number;
  sourceFilter: ResourceSearchSourceFilter;
}

function normalizeResourceSearchKinds(kinds: readonly ResourceKind[] | undefined): ResourceKind[] {
  if (!kinds || kinds.length === 0) return [];
  return [...new Set(kinds.filter((kind): kind is ResourceKind => (ALL_RESOURCE_KINDS as readonly string[]).includes(kind)))]
    .sort((left, right) => left.localeCompare(right));
}

function normalizeResourceSearchLimit(value: number | undefined, pageBounded: boolean): number {
  const limit = value ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw Object.assign(new Error('limit 必须是正整数。'), { code: 'INVALID_RESOURCE_SEARCH_WINDOW' });
  }
  return pageBounded ? Math.min(RESOURCE_SEARCH_PAGE_LIMIT, limit) : limit;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isResourceSearchCursorScope(value: unknown): value is ResourceSearchCursorScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<ResourceSearchCursorScope>;
  const limit = candidate.limit;
  return typeof candidate.workspaceId === 'string'
    && candidate.workspaceId.length > 0
    && typeof candidate.query === 'string'
    && Array.isArray(candidate.kinds)
    && candidate.kinds.every((kind) => typeof kind === 'string' && (ALL_RESOURCE_KINDS as readonly string[]).includes(kind))
    && typeof limit === 'number'
    && Number.isSafeInteger(limit)
    && limit >= 1
    && limit <= RESOURCE_SEARCH_PAGE_LIMIT
    && (candidate.sourceFilter === 'active' || candidate.sourceFilter === 'all' || candidate.sourceFilter === 'artifacts');
}

function resourceSearchFingerprint(
  scope: ResourceSearchCursorScope,
  results: readonly SearchResult<IndexedFile>[]
): string {
  const hash = createHash('sha256').update(JSON.stringify(scope));
  for (const result of results) {
    hash.update('\0').update(JSON.stringify({
      sourceUri: result.item.sourceUri,
      relativePath: result.item.relativePath,
      resourceKind: result.item.resourceKind,
      score: result.score,
      sha256: result.item.sha256,
      mtimeMs: result.item.mtimeMs,
      artifactRole: result.item.artifactMarkers?.artifactRole
    }));
  }
  return hash.digest('hex');
}

/**
 * Search receives projections from both the legacy parser (event://...) and
 * the native reader (sourceUri#event/...).  URI spelling is not a second
 * event identity: source URI + event id + source version is.  Keep distinct
 * source hashes as separate candidates so a stale/current conflict cannot be
 * silently collapsed.
 */
function dedupeEventSearchSymbols(exports: readonly EventExport[]): EventSymbol[] {
  const byBaseIdentity = new Map<string, { known: Map<string, EventSymbol>; unknown?: EventSymbol }>();
  for (const exportItem of exports) {
    for (const event of exportItem.events) {
      const projected = event.sourceHash === undefined && exportItem.sourceHash !== undefined
        || event.outerFileHash === undefined && exportItem.outerFileHash !== undefined
        || event.sourceRevision === undefined && exportItem.sourceRevision !== undefined
        ? {
            ...event,
            ...(event.sourceHash === undefined && exportItem.sourceHash !== undefined ? { sourceHash: exportItem.sourceHash } : {}),
            ...(event.outerFileHash === undefined && exportItem.outerFileHash !== undefined ? { outerFileHash: exportItem.outerFileHash } : {}),
            ...(event.sourceRevision === undefined && exportItem.sourceRevision !== undefined ? { sourceRevision: exportItem.sourceRevision } : {})
          }
        : event;
      const baseIdentity = JSON.stringify([projected.sourceUri, projected.eventId]);
      const group = byBaseIdentity.get(baseIdentity) ?? { known: new Map<string, EventSymbol>() };
      const version = eventSearchVersion(projected);
      if (version === undefined) {
        if (!group.unknown || preferEventSearchSymbol(projected, group.unknown)) group.unknown = projected;
      } else {
        const previous = group.known.get(version);
        if (!previous || preferEventSearchSymbol(projected, previous)) group.known.set(version, projected);
      }
      byBaseIdentity.set(baseIdentity, group);
    }
  }
  return [...byBaseIdentity.values()].flatMap((group) => group.known.size > 0
    ? [...group.known.values()]
    : group.unknown ? [group.unknown] : []);
}

function eventSearchVersion(event: Pick<EventSymbol, 'sourceHash' | 'outerFileHash' | 'sourceRevision'>): string | undefined {
  if (event.sourceHash !== undefined) return `source:${event.sourceHash}`;
  if (event.outerFileHash !== undefined) return `outer:${event.outerFileHash}`;
  if (event.sourceRevision !== undefined) return `revision:${String(event.sourceRevision)}`;
  return undefined;
}

function preferEventSearchSymbol(candidate: EventSymbol, previous: EventSymbol): boolean {
  const canonicalUri = `${candidate.sourceUri}#event/${candidate.eventId}`;
  const candidateCanonical = candidate.uri === canonicalUri;
  const previousCanonical = previous.uri === `${previous.sourceUri}#event/${previous.eventId}`;
  if (candidateCanonical !== previousCanonical) return candidateCanonical;
  if (candidate.instructions.length !== previous.instructions.length) {
    return candidate.instructions.length > previous.instructions.length;
  }
  return candidate.uri.localeCompare(previous.uri) < 0;
}

function eventExportSourceUri(value: EventExport): string | undefined {
  return value.events[0]?.sourceUri;
}

function mapExportSourceUri(value: MapExport): string | undefined {
  return value.entities[0]?.sourceUri ?? value.regions[0]?.sourceUri;
}

function mapExportKey(value: MapExport): string {
  return `${mapExportSourceUri(value) ?? ''}\u0000${value.mapId}`;
}

function paramExportSourceUri(value: ParamExport): string | undefined {
  return value.sourceUri ?? value.rows[0]?.sourceUri;
}

function msgExportSourceUri(value: MsgExport): string | undefined {
  return value.entries[0]?.sourceUri;
}

function projectionVersion(value: {
  sourceHash?: string;
  outerFileHash?: string;
  sourceRevision?: number;
  readerSchemaRevision?: number;
}): Omit<CoverageSourceVersion, 'sourceUri'> {
  return {
    ...(value.outerFileHash ? { outerFileHash: value.outerFileHash } : {}),
    ...(value.sourceHash ? { sourceHash: value.sourceHash } : {}),
    ...(value.sourceRevision !== undefined ? { sourceRevision: value.sourceRevision } : {}),
    ...(value.readerSchemaRevision !== undefined ? { readerSchemaVersion: value.readerSchemaRevision } : {})
  };
}

function compareToIndexedFile(
  incoming: CoverageSourceVersion,
  file: Pick<IndexedFile, 'sourceUri' | 'sha256' | 'mtimeMs'>
): { code: NativeProjectionAcceptance['code']; reason: string } | undefined {
  // Native `sourceHash` is the decoded leaf payload identity.  Packed files
  // (DCX/BND4) therefore cannot be compared to the catalog hash directly.
  // Bridge semantic exports must carry the independently computed outer file
  // hash; sourceHash remains available for leaf-level CAS/conflict checks.
  const comparableOuterHash = incoming.outerFileHash ?? incoming.sourceHash;
  if (comparableOuterHash && file.sha256 && comparableOuterHash !== file.sha256) {
    return {
      code: 'NATIVE_PROJECTION_STALE',
      reason: `native projection outer hash ${comparableOuterHash} does not match current file ${file.sha256}`
    };
  }
  if (incoming.sourceRevision !== undefined
    && typeof incoming.sourceRevision === 'number'
    && incoming.sourceRevision !== file.mtimeMs) {
    return {
      code: 'NATIVE_PROJECTION_STALE',
      reason: `native projection revision ${String(incoming.sourceRevision)} does not match current file ${String(file.mtimeMs)}`
    };
  }
  return undefined;
}

function compareProjectionVersions(
  previous: CoverageSourceVersion,
  incoming: CoverageSourceVersion
): { code: NativeProjectionAcceptance['code']; reason: string } | undefined {
  const previousRevision = comparableRevision(previous.sourceRevision);
  const incomingRevision = comparableRevision(incoming.sourceRevision);
  if (previousRevision !== undefined && incomingRevision !== undefined) {
    if (incomingRevision < previousRevision) {
      return {
        code: 'NATIVE_PROJECTION_STALE',
        reason: `late native projection revision ${String(incoming.sourceRevision)} < accepted ${String(previous.sourceRevision)}`
      };
    }
    if (incomingRevision === previousRevision
      && previous.sourceHash
      && incoming.sourceHash
      && previous.sourceHash !== incoming.sourceHash) {
      return {
        code: 'NATIVE_PROJECTION_VERSION_CONFLICT',
        reason: 'same source revision carries conflicting source hashes'
      };
    }
    if (incomingRevision === previousRevision
      && previous.outerFileHash
      && incoming.outerFileHash
      && previous.outerFileHash !== incoming.outerFileHash) {
      return {
        code: 'NATIVE_PROJECTION_VERSION_CONFLICT',
        reason: 'same source revision carries conflicting outer file hashes'
      };
    }
  } else if (previous.sourceHash && incoming.sourceHash && previous.sourceHash !== incoming.sourceHash) {
    return {
      code: 'NATIVE_PROJECTION_VERSION_CONFLICT',
      reason: 'native projection carries a conflicting source hash without comparable revisions'
    };
  } else if (previous.outerFileHash && incoming.outerFileHash && previous.outerFileHash !== incoming.outerFileHash) {
    return {
      code: 'NATIVE_PROJECTION_VERSION_CONFLICT',
      reason: 'native projection carries a conflicting outer file hash without comparable revisions'
    };
  }

  const previousSchema = comparableRevision(previous.readerSchemaVersion);
  const incomingSchema = comparableRevision(incoming.readerSchemaVersion);
  if (previousSchema !== undefined && incomingSchema !== undefined && incomingSchema < previousSchema) {
    return {
      code: 'NATIVE_PROJECTION_STALE',
      reason: `late reader schema ${String(incoming.readerSchemaVersion)} < accepted ${String(previous.readerSchemaVersion)}`
    };
  }
  return undefined;
}

function comparableRevision(value: number | string | undefined): number | string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length > 0) return value;
  return undefined;
}

function hasConcreteVersion(value: CoverageSourceVersion): boolean {
  return value.outerFileHash !== undefined
    || value.sourceHash !== undefined
    || value.sourceRevision !== undefined
    || value.readerSchemaVersion !== undefined
    || value.metadataSchemaVersion !== undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function matchesTaeEntryIdentity(
  animation: Pick<TaeAnimSymbol, 'taeEntryIndex' | 'taeEntryId' | 'taeEntryName' | 'taeGroup'>,
  selector: TaeAnimationIdentitySelector
): boolean {
  if (selector.taeEntryIndex !== undefined && animation.taeEntryIndex !== selector.taeEntryIndex) return false;
  if (selector.taeEntryId !== undefined && animation.taeEntryId !== selector.taeEntryId) return false;
  if (selector.taeEntryName !== undefined && animation.taeEntryName !== selector.taeEntryName) return false;
  if (selector.taeGroup !== undefined && animation.taeGroup !== selector.taeGroup) return false;
  return true;
}

function sameProvidedParamExportMetadata(existing: ParamExport, incoming: ParamExport): boolean {
  return existing.paramName === incoming.paramName
    && (incoming.sourceUri === undefined || existing.sourceUri === incoming.sourceUri)
    && (incoming.entryIndex === undefined || existing.entryIndex === incoming.entryIndex)
    && (incoming.entryName === undefined || existing.entryName === incoming.entryName)
    && (incoming.sourceHash === undefined || existing.sourceHash === incoming.sourceHash)
    && (incoming.outerFileHash === undefined || existing.outerFileHash === incoming.outerFileHash)
    && (incoming.sourceRevision === undefined || existing.sourceRevision === incoming.sourceRevision);
}

function sameParamRowAfterMerge(previous: ParamRowSymbol, incoming: ParamRowSymbol): boolean {
  const { fields: incomingFields, ...incomingMetadata } = incoming;
  for (const [key, value] of Object.entries(incomingMetadata)) {
    if (!Object.is(previous[key as keyof ParamRowSymbol], value)) return false;
  }
  for (const field of incomingFields ?? []) {
    const fieldKey = field.fieldId ?? field.name;
    const previousField = previous.fields?.find((candidate) => (candidate.fieldId ?? candidate.name) === fieldKey);
    if (!previousField || !sameParamField(previousField, field)) return false;
  }
  return true;
}

function sameParamField(left: ParamFieldSymbol, right: ParamFieldSymbol): boolean {
  return left.fieldId === right.fieldId
    && left.name === right.name
    && left.type === right.type
    && left.description === right.description
    && Object.is(left.value, right.value)
    && left.refsProvenance === right.refsProvenance
    && sameParamFieldRefs(left.refs, right.refs)
    && sameStringSequence(left.refsRejected, right.refsRejected);
}

function sameParamFieldRefs(
  left: ParamFieldSymbol['refs'],
  right: ParamFieldSymbol['refs']
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((target, index) => {
    const other = right[index];
    return other !== undefined
      && target.param === other.param
      && target.condition?.fieldId === other.condition?.fieldId
      && target.condition?.value === other.condition?.value;
  });
}

function sameStringSequence(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
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

function paramRowKey(value: Pick<ParamRowSymbol, 'sourceUri' | 'entryName' | 'entryIndex' | 'rowId'>): string {
  const entryIdentity = value.entryName
    ?? (value.entryIndex === undefined ? '' : `#${value.entryIndex}`);
  return `${value.sourceUri}\u0000${entryIdentity.toLowerCase()}\u0000${value.rowId}`;
}

function msgProjectionKey(value: MsgExport): string {
  const sourceUri = msgExportSourceUri(value) ?? '';
  const category = value.category ?? value.entries[0]?.category ?? 'default';
  return `${sourceUri}\u0000${category.toLowerCase()}`;
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
  [/巨型忍者|义父(?!的?(?:铃铛|守护铃))|崇枭|祟枭|枭/iu, '巨型忍者 枭 崇枭 祟枭 Father Owl'],
  // 当前 Sekiro 中文语料把用户说的“义父的铃铛”写成
  // EquipParamGoods 行名“义父的守护铃”；这是受限的词法别名，不是
  // 数字 ID 映射。它让精确 Goods 行先进入候选，后续仍必须原生读取。
  [/铃铛|守护铃|守り鈴/iu, '义父的守护铃 守护铃 铃铛 Bell'],
  [/一心|剑圣/, '苇名一心 剑圣 Isshin'],
  [/破戒僧/, '破戒僧 Monk'],
  [/赤鬼/, '赤鬼 Ogre'],
  [/火牛|樱牛/, '火牛 樱牛 Bull'],
  [/佐濑甚助|居合哥/, '佐濑甚助 Jinsuke']
];

interface SearchQueryProfile {
  original: string;
  aliases: string[];
  preferredAliases: string[];
  hasCjk: boolean;
}

const SEARCH_CHAR_FOLDS: Readonly<Record<string, string>> = {
  義: '义', 鈴: '铃', 鐺: '铛', 護: '护', 梟: '枭',
  戰: '战', 鬥: '斗', 記: '记', 憶: '忆', 強: '强', 敵: '敌',
  現: '现', 發: '发', 聲: '声', 會: '会', 話: '话', 說: '说',
  為: '为', 與: '与', 從: '从', 後: '后', 獲: '获', 得: '得',
  這: '这', 個: '个', 無: '无', 關: '关', 係: '系', 親: '亲',
  愛: '爱', 遠: '远', 對: '对', 應: '应', 選: '选', 擇: '择',
  聽: '听', 見: '见', 開: '开', 門: '门', 離: '离', 讓: '让',
  帶: '带', 來: '来', 兩: '两', 進: '进', 場: '场', 殺: '杀',
  擊: '击', 傷: '伤', 體: '体', 氣: '气', 運: '运', 動: '动',
  變: '变', 換: '换', 將: '将', 號: '号', 類: '类', 別: '别',
  點: '点', 時: '时', 間: '间', 長: '长', 實: '实', 驗: '验',
  頁: '页', 總: '总', 數: '数', 簡: '简', 繁: '繁'
};

function foldSearchCharacters(value: string): string {
  return [...value].map((character) => SEARCH_CHAR_FOLDS[character] ?? character).join('');
}

function buildSearchQueryProfile(query: string): SearchQueryProfile {
  const original = normalizeSearch(query);
  const foldedQuery = foldSearchCharacters(query);
  const aliases: string[] = [];
  const preferredAliases: string[] = [];
  for (const [pattern, replacement] of SEKIRO_SEARCH_SYNONYMS) {
    if (!pattern.test(query) && !pattern.test(foldedQuery)) continue;
    const normalizedReplacement = normalizeSearch(replacement);
    if (!normalizedReplacement) continue;
    const canonicalAlias = normalizedReplacement.split(' ')[0];
    if (canonicalAlias) preferredAliases.push(canonicalAlias);
    aliases.push(normalizedReplacement, ...normalizedReplacement.split(' '));
  }
  return {
    original,
    aliases: [...new Set(aliases.filter((alias) => alias !== original))],
    preferredAliases: [...new Set(preferredAliases.filter((alias) => alias !== original))],
    hasCjk: /[\u3400-\u9fff]/u.test(original)
  };
}

function expandSearchQuery(query: string): string {
  const profile = buildSearchQueryProfile(query);
  return [profile.original, ...profile.aliases].filter(Boolean).join(' ');
}

function searchSymbols<T>(
  items: T[],
  query: string,
  limit: number,
  toText: (item: T) => string,
  scoreItem?: (item: T, text: string, profile: SearchQueryProfile) => number
): Array<SearchResult<T>> {
  const profile = buildSearchQueryProfile(query);
  const results: Array<SearchResult<T>> = [];
  for (const item of items) {
    const text = toText(item);
    const score = scoreItem ? scoreItem(item, text, profile) : scoreSearchProfile(text, profile);
    if (score > 0) results.push({ item, score, highlights: makeHighlights(text, profile) });
  }
  return sortAndLimit(results, limit);
}

function scoreText(text: string, query: string): number {
  return scoreSearchProfile(text, buildSearchQueryProfile(query));
}

function scoreSearchProfile(text: string, profile: SearchQueryProfile): number {
  if (profile.original.length === 0 && profile.aliases.length === 0) return 1;
  const normalized = normalizeSearch(text);
  let score = scorePrimaryTerm(normalized, profile.original);
  for (const alias of profile.aliases) score += scoreAliasTerm(normalized, alias, profile);
  return score;
}

function scorePrimaryTerm(normalizedText: string, term: string): number {
  if (!term) return 0;
  if (normalizedText === term) return 220;
  if (normalizedText.startsWith(term)) return 190;
  if (normalizedText.includes(term)) return 170;
  if (term.length >= 2) {
    const cjkMatchCount = [...term].filter((character) => /[\u4e00-\u9fff]/u.test(character)
      && normalizedText.includes(character)).length;
    if (cjkMatchCount >= 2) {
      // Keep weak CJK partial matches discoverable for recall, but make them
      // materially weaker than an exact phrase or a declared alias.
      if (term.length <= 4) {
        const required = term.length >= 3 ? Math.ceil(term.length * 0.67) : term.length;
        if (cjkMatchCount >= required) return cjkMatchCount * 4;
      }
      return cjkMatchCount;
    }
  }
  return 0;
}

function scoreAliasTerm(normalizedText: string, term: string, profile: SearchQueryProfile): number {
  if (!term) return 0;
  // A Chinese query may have an English synonym, but an English-only label
  // should not outrank a same-script entity name merely because both contain
  // a generic translated word such as "Bell".
  const crossScriptWeight = profile.hasCjk && /^[a-z0-9 _-]+$/iu.test(term) ? 0.2 : 1;
  if (normalizedText === term) return Math.round(120 * crossScriptWeight);
  if (normalizedText.startsWith(term)) return Math.round(70 * crossScriptWeight);
  if (normalizedText.includes(term)) return Math.round(48 * crossScriptWeight);
  return 0;
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

function makeHighlights(text: string, profile: SearchQueryProfile): string[] {
  if (profile.original.length === 0 && profile.aliases.length === 0) return [];
  const normalized = normalizeSearch(text);
  const terms = [profile.original, ...profile.aliases].filter(Boolean);
  const highlights: string[] = [];
  for (const term of terms) {
    if (term.length > 0 && normalized.includes(term)) {
      highlights.push(term);
    } else {
      for (const ch of term) {
        if (/[\u4e00-\u9fff]/u.test(ch) && normalized.includes(ch)) {
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
function selectDiversifiedMatches(
  matches: Array<SearchResult<ParamRowSymbol>>,
  maxCount: number
): Array<SearchResult<ParamRowSymbol>> {
  if (matches.length <= maxCount) return matches;
  const groups = new Map<string, Array<SearchResult<ParamRowSymbol>>>();
  for (const match of matches) {
    const groupName = normalizeParamName(match.item.paramName || match.item.entryName || 'unknown');
    const group = groups.get(groupName) ?? [];
    group.push(match);
    groups.set(groupName, group);
  }
  if (groups.size <= 1) return matches.slice(0, maxCount);
  for (const group of groups.values()) group.sort((left, right) => right.score - left.score);
  const orderedGroups = [...groups.values()].sort((left, right) => {
    const scoreDelta = (right[0]?.score ?? 0) - (left[0]?.score ?? 0);
    if (scoreDelta !== 0) return scoreDelta;
    return normalizeParamName(left[0]?.item.paramName ?? '').localeCompare(
      normalizeParamName(right[0]?.item.paramName ?? '')
    );
  });
  const selected: Array<SearchResult<ParamRowSymbol>> = [];
  for (let offset = 0; selected.length < maxCount; offset += 1) {
    let added = false;
    for (const group of orderedGroups) {
      const result = group[offset];
      if (!result) continue;
      selected.push(result);
      added = true;
      if (selected.length >= maxCount) break;
    }
    if (!added) break;
  }
  return selected;
}

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
  const phrasePriority = selectDiversifiedMatches(rowNamePhraseMatches, Math.min(12, limit));
  if (phrasePriority.length > 0) {
    const selected = new Set(phrasePriority.map((result) => result.item.uri));
    const remainder = results.filter((result) => !selected.has(result.item.uri));
    const diversifiedRemainder = diversifyParamSearchResults(remainder, limit - phrasePriority.length, query);
    return [...phrasePriority, ...diversifiedRemainder].slice(0, limit);
  }
  const topScore = results.reduce((highest, result) => Math.max(highest, result.score), 0);
  const topScoreMatches = results
    .filter((result) => result.score === topScore)
    .sort((left, right) => right.score - left.score);
  const diversifiedTopScores = selectDiversifiedMatches(topScoreMatches, Math.min(12, limit));
  if (diversifiedTopScores.length > 1) {
    const selected = new Set(diversifiedTopScores.map((result) => result.item.uri));
    const remainder = results.filter((result) => !selected.has(result.item.uri));
    const diversifiedRemainder = diversifyParamSearchResults(remainder, limit - diversifiedTopScores.length, query);
    return [...diversifiedTopScores, ...diversifiedRemainder].slice(0, limit);
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
  return foldSearchCharacters(value.toLowerCase())
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

function scoreMapSymbol(symbol: MapEntitySymbol | MapRegionSymbol, profile: SearchQueryProfile): number {
  const text = mapSymbolSearchText(symbol);
  const base = scoreSearchProfile(text, profile);
  const nameScore = scoreSearchProfile(symbol.name, profile);
  return base + nameScore * 1.5;
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

function scoreParamRow(row: ParamRowSymbol, text: string, profile: SearchQueryProfile): number {
  const base = scoreSearchProfile(text, profile);
  const rowNameScore = scoreSearchProfile(row.rowName ?? '', profile);
  const paramNameScore = scoreSearchProfile(row.paramName, profile);
  // A declared game-name synonym is stronger evidence of the intended
  // identity than an unrelated row that merely contains the user's misspelling
  // (for example, `怨恨鬼刑部` must not outrank canonical `鬼形部` for query
  // `鬼刑部`). Keep the literal competitor in the result set, but rank the
  // explicit canonical alias first so the model can verify both candidates.
  const preferredAliasScore = Math.max(0, ...profile.preferredAliases.map((alias) => (
    scoreAliasTerm(normalizeSearch(row.rowName ?? ''), alias, profile)
  )));
  return base + rowNameScore * 1.75 + paramNameScore * 0.25 + preferredAliasScore * 8;
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

function scoreTextEntry(entry: TextEntrySymbol, text: string, profile: SearchQueryProfile): number {
  const base = scoreSearchProfile(text, profile);
  const textScore = scoreSearchProfile(entry.text, profile);
  const category = entry.category ?? '';
  const normalizedCategory = normalizeSearch(category);
  const isItemName = /(?:item\s*name|itemname|アイテム名|アイテム\s*名)/iu.test(normalizedCategory);
  const isConversation = /(?:conversation|talk|会話)/iu.test(normalizedCategory);
  const isDescription = /(?:description|説明)/iu.test(normalizedCategory);
  if (isItemName) return base + textScore * 1.5 + (textScore > 0 ? 40 : 0);
  if (isDescription) return base + textScore * 0.25;
  if (isConversation && textScore === 0) return Math.max(0, base - 8);
  return base + textScore * 0.5;
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
