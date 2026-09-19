import type {
  EventSymbol,
  MapEntitySymbol,
  MapRegionSymbol,
  ParamRowSymbol,
  ReferenceEdge,
  TextEntrySymbol,
  IndexedFile
} from '@soulforge/shared';
import {
  canConcludeNotFound,
  createCoverageState,
  notFoundCode,
  type CoverageState,
  type PredicateCompleteness,
  type PredicateKind
} from '../indexing/coverageState.js';
import type { ChrLinkageResult } from '../references/chrLinkageResolver.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';

export type EntityResolutionDomain = 'event' | 'map' | 'param' | 'msg' | 'action' | 'resource' | 'chr' | string;

export interface NativeEntityHandle {
  namespace: string;
  objectKey: string;
  sourceUri?: string;
  sourceHash?: string;
  sourceRevision?: number | string;
  readerSchemaVersion?: number | string;
  metadataSchemaVersion?: string;
}

export type EntityRelationRequest = string | {
  relation: string;
  targetNamespace?: string;
  ruleId?: string;
};

export interface ResolutionEvidence {
  kind: 'index' | 'native-read' | 'memory' | 'reference-graph' | 'linkage';
  sourceUri?: string | undefined;
  sourceProperty?: string | undefined;
  value?: string | number | boolean | undefined;
  detail: string;
}

export interface EntitySourceSnapshot {
  sourceUri: string;
  sourceHash?: string;
  outerFileHash?: string;
  sourceRevision?: number | string;
  readerSchemaVersion?: number | string;
  metadataSchemaVersion?: string;
}

export interface EntityCandidate {
  candidateId: string;
  namespace: string;
  domain: EntityResolutionDomain;
  nativeHandle: string;
  sourceUri?: string | undefined;
  label?: string | undefined;
  score: number;
  route: 'exact_handle' | 'memory' | 'fmg' | 'param' | 'map' | 'event' | 'resource' | 'reference_graph' | 'native_read';
  status: 'candidate' | 'verified' | 'stale' | 'blocked' | 'excluded';
  nativeVerified: boolean;
  evidence: ResolutionEvidence[];
  sourceSnapshot?: EntitySourceSnapshot | undefined;
  rejectionReason?: string | undefined;
}

export interface IdentityChain {
  candidateId: string;
  nodes: string[];
  verified: boolean;
  links: Array<{
    ruleId: string;
    fromUri: string;
    toUri: string;
    verified: boolean;
  }>;
}

export interface VerifiedRelationEdge {
  ruleId: string;
  fromUri: string;
  toUri: string;
  sourceProperty: string;
  targetNamespace: string;
  sourceSnapshot: EntitySourceSnapshot;
  targetSnapshot?: EntitySourceSnapshot;
  targetConfirmed: boolean;
  confidence: 'high' | 'medium' | 'low';
  evidence: ResolutionEvidence[];
}

export interface PendingRelationEdge {
  fromUri: string;
  toUri: string;
  targetNamespace: string;
  reason: string;
  hypothesis: boolean;
  sourceProperty?: string;
  ruleId?: string;
  evidence: ResolutionEvidence[];
}

export interface ResolverReadPlanStep {
  stepId: string;
  route: 'read_memory' | 'search_fmg' | 'search_param' | 'read_native' | 'read_reference_metadata' | 'read_native_target';
  target: string;
  reason: string;
  priority: number;
  requiredForMutation: boolean;
}

export interface ResolverProgress {
  step: number;
  route: string;
  progressed: boolean;
  progressKind: 'candidate_excluded' | 'native_field_filled' | 'relation_verified' | 'coverage_improved' | 'postcondition' | 'none';
  detail: string;
}

export interface NativeReadRequest {
  handle: string;
  namespace: string;
  objectKey: string;
  domain: EntityResolutionDomain;
  sourceUri?: string;
  requiredFields: string[];
  route: 'exact_handle' | 'candidate' | 'target';
}

export interface NativeReadObservation {
  ok: boolean;
  verified?: boolean;
  candidate?: Partial<Pick<EntityCandidate, 'candidateId' | 'namespace' | 'domain' | 'nativeHandle' | 'sourceUri' | 'label'>>;
  sourceSnapshot?: EntitySourceSnapshot;
  evidence?: ResolutionEvidence[];
  reason?: string;
}

export interface EntityResolutionInput {
  index?: WorkspaceIndex;
  workspaceIndex?: WorkspaceIndex;
  query?: string;
  handle?: string | NativeEntityHandle;
  nativeHandle?: string | NativeEntityHandle;
  domain?: EntityResolutionDomain;
  requiredRelations?: readonly EntityRelationRequest[];
  memoryHints?: readonly string[];
  nativeRead?: (request: NativeReadRequest) => Promise<NativeReadObservation>;
  linkageResolver?: (rowId: number) => Promise<ChrLinkageResult | null>;
  maxDepth?: number;
  maxCandidates?: number;
  maxEdges?: number;
  maxSteps?: number;
  maxRouteChanges?: number;
}

export interface EntityResolutionResult {
  status: 'resolved' | 'ambiguous' | 'partial' | 'blocked' | 'not_found' | 'not_found_complete_coverage';
  query: string;
  domain: EntityResolutionDomain;
  candidates: EntityCandidate[];
  candidateSet: EntityCandidate[];
  identityChains: IdentityChain[];
  verifiedEdges: VerifiedRelationEdge[];
  pendingEdges: PendingRelationEdge[];
  /** Alias retained for callers that call the verified graph simply edges. */
  edges: VerifiedRelationEdge[];
  coverage: CoverageState;
  coverageByDomain: CoverageState[];
  blockedReasons: string[];
  nextReadPlan: ResolverReadPlanStep[];
  attemptedRoutes: string[];
  progress: ResolverProgress[];
  hypotheses: PendingRelationEdge[];
  /** Only current, native-verified candidates may enter this list. */
  mutationTargets: string[];
  diagnostics: string[];
}

interface InternalCandidateInput {
  candidateId: string;
  namespace: string;
  domain: EntityResolutionDomain;
  nativeHandle: string;
  sourceUri?: string;
  label?: string;
  score: number;
  route: EntityCandidate['route'];
  evidence: ResolutionEvidence[];
  sourceSnapshot?: EntitySourceSnapshot;
}

interface RelationRule {
  ruleId: string;
  targetNamespace: string;
  sourceProperty: string;
  kind: ReferenceEdge['kind'];
}

const MAX_RESOLVER_STEPS = 200;
const MAX_CANDIDATES = 64;
const MAX_EDGES = 128;
const MAX_DEPTH = 4;
const MAX_ROUTE_CHANGES = 2;

/**
 * Resolve a user name or native handle using only indexed/native evidence.
 * This module never owns a game-specific ID dictionary and never emits a
 * mutation target from a fuzzy or stale observation.
 */
export async function resolveEntity(input: EntityResolutionInput): Promise<EntityResolutionResult> {
  const index = input.index ?? input.workspaceIndex;
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  const rawHandle = input.nativeHandle ?? input.handle;
  const handleText = typeof rawHandle === 'string'
    ? rawHandle.trim()
    : rawHandle
      ? formatNativeHandle(rawHandle)
      : '';
  const domain = input.domain ?? inferDomainFromHandle(handleText) ?? 'unknown';
  const requestedRelations = normalizeRelations(input.requiredRelations ?? []);
  const maxCandidates = boundedInteger(input.maxCandidates, MAX_CANDIDATES, 1, MAX_CANDIDATES);
  const maxEdges = boundedInteger(input.maxEdges, MAX_EDGES, 1, MAX_EDGES);
  const maxDepth = boundedInteger(input.maxDepth, MAX_DEPTH, 0, MAX_DEPTH);
  const maxSteps = boundedInteger(input.maxSteps, MAX_RESOLVER_STEPS, 1, MAX_RESOLVER_STEPS);
  const maxRouteChanges = boundedInteger(input.maxRouteChanges, MAX_ROUTE_CHANGES, 0, MAX_ROUTE_CHANGES);
  const exact = handleText.length > 0;
  const attemptedRoutes: string[] = [];
  const progress: ResolverProgress[] = [];
  const nextReadPlan: ResolverReadPlanStep[] = [];
  const blockedReasons: string[] = [];
  const diagnostics: string[] = [];

  if (!index) {
    const coverage = createCoverageState({
      scope: 'workspace',
      domain,
      status: 'not_indexed',
      predicateCompleteness: {
        kind: exact ? 'exact_handle' : 'fuzzy_name',
        predicate: exact ? 'exact native handle' : 'fuzzy name',
        exhaustive: exact,
        status: 'partial',
        reason: 'workspace index is unavailable'
      }
    });
    return makeResult({
      status: 'blocked',
      query: query || handleText,
      domain,
      candidates: [],
      identityChains: [],
      verifiedEdges: [],
      pendingEdges: [],
      coverage,
      coverageByDomain: [coverage],
      blockedReasons: ['WORKSPACE_INDEX_UNAVAILABLE'],
      nextReadPlan: [],
      attemptedRoutes: [],
      progress: [],
      hypotheses: [],
      mutationTargets: [],
      diagnostics: ['resolver requires a current workspace index']
    });
  }

  const rawCoverage = coverageForDomain(index, domain);
  const predicateKind: PredicateKind = exact ? 'exact_handle' : 'fuzzy_name';
  const coverage = withPredicate(rawCoverage, {
    kind: predicateKind,
    predicate: exact ? `exact handle ${handleText}` : `fuzzy query ${query}`,
    exhaustive: exact,
    status: rawCoverage.status === 'complete' && exact ? 'complete' : exact ? 'partial' : 'not_applicable',
    reason: exact
      ? rawCoverage.status === 'complete' ? 'exact handle is deterministic over the current scope' : 'exact handle is deterministic but source coverage is incomplete'
      : 'fuzzy lexical/semantic retrieval is not an exhaustive predicate'
  });

  let candidates: EntityCandidate[] = [];
  if (exact) {
    attemptedRoutes.push('exact_handle');
    candidates = exactCandidates(index, handleText, domain, maxCandidates);
    if (candidates.length === 0 && input.nativeRead) {
      nextReadPlan.push({
        stepId: 'native-exact-handle',
        route: 'read_native',
        target: handleText,
        reason: 'exact handle is not present in the semantic projection; a native read is required before creating an identity',
        priority: 100,
        requiredForMutation: true
      });
      candidates = await runNativeReadForExact(input.nativeRead, handleText, domain, maxSteps, maxRouteChanges, progress, attemptedRoutes, blockedReasons);
    } else if (candidates.length === 0) {
      nextReadPlan.push({
        stepId: 'native-exact-handle',
        route: 'read_native',
        target: handleText,
        reason: 'exact handle is not indexed; do not invent an ID from a fuzzy result',
        priority: 100,
        requiredForMutation: true
      });
    }
  } else {
    if (!query) {
      blockedReasons.push('QUERY_OR_NATIVE_HANDLE_REQUIRED');
    } else {
      // The two high-value name routes intentionally run together.  Neither
      // route is allowed to claim absence on its own.
      attemptedRoutes.push('memory', 'fmg', 'param');
      const [memoryCandidates, fmgCandidates, paramCandidates, domainCandidates] = await Promise.all([
        Promise.resolve(memoryHintCandidates(index, input.memoryHints ?? [], query, domain)),
        Promise.resolve(domain === 'param' || domain === 'unknown' || domain === 'msg'
          ? index.searchTextEntries(query, maxCandidates)
          : []),
        Promise.resolve(domain === 'msg' ? [] : index.searchParamRows(query, maxCandidates)),
        Promise.resolve(searchDomain(index, query, domain, maxCandidates))
      ]);
      candidates = mergeCandidates([
        ...memoryCandidates,
        ...fmgCandidates.map((result) => candidateFromText(result.item, result.score, 'fmg', result.highlights)),
        ...paramCandidates.map((result) => candidateFromParam(result.item, result.score, 'param', result.highlights)),
        ...domainCandidates
      ], maxCandidates);
      nextReadPlan.push({
        stepId: 'native-fuzzy-candidates',
        route: 'read_native',
        target: query,
        reason: 'candidate retrieval is not identity confirmation; read the selected native source before mutation',
        priority: 80,
        requiredForMutation: true
      });
    }
  }

  candidates = candidates.map((candidate) => verifyIndexedCandidate(index, candidate));
  const verifiedEdges: VerifiedRelationEdge[] = [];
  const pendingEdges: PendingRelationEdge[] = [];
  const hypotheses: PendingRelationEdge[] = [];
  const identityChains: IdentityChain[] = [];

  for (const candidate of candidates.slice(0, maxCandidates)) {
    const chain: IdentityChain = {
      candidateId: candidate.candidateId,
      nodes: [candidate.candidateId],
      verified: candidate.nativeVerified,
      links: []
    };
    const sourceEdges = index.findReferences(candidate.candidateId, 'both');
    for (const edge of sourceEdges) {
      if (verifiedEdges.length + pendingEdges.length >= maxEdges) {
        blockedReasons.push('EDGE_BUDGET_EXHAUSTED');
        break;
      }
      const rule = declaredRuleForEdge(edge);
      const targetSymbol = findSymbol(index, edge.toUri);
      const targetSnapshot = targetSymbol ? snapshotForSymbol(targetSymbol, index) : undefined;
      const targetConfirmed = targetSymbol
        ? isSnapshotCurrent(targetSnapshot, index)
        : edge.kind === 'reads_flag' || edge.kind === 'writes_flag';
      const evidence = edge.evidence.map((item) => ({
        kind: 'reference-graph' as const,
        sourceUri: item.sourceUri,
        ...(item.fieldName ? { sourceProperty: item.fieldName } : {}),
        ...(item.value !== undefined ? { value: item.value } : {}),
        detail: item.excerpt ?? edge.reason
      }));
      if (!rule) {
        const pending: PendingRelationEdge = {
          fromUri: edge.fromUri,
          toUri: edge.toUri,
          targetNamespace: namespaceFromUri(edge.toUri),
          reason: 'RELATION_RULE_UNDECLARED: numeric/reference graph observation has no registered join rule',
          hypothesis: true,
          evidence
        };
        pendingEdges.push(pending);
        hypotheses.push(pending);
        continue;
      }
      const sourceSnapshot = candidate.sourceSnapshot ?? snapshotForSymbol(findSymbol(index, edge.fromUri), index);
      if (!sourceSnapshot || !targetConfirmed) {
        pendingEdges.push({
          fromUri: edge.fromUri,
          toUri: edge.toUri,
          targetNamespace: rule.targetNamespace,
          reason: 'NATIVE_TARGET_CONFIRMATION_REQUIRED',
          hypothesis: false,
          sourceProperty: rule.sourceProperty,
          ruleId: rule.ruleId,
          evidence
        });
        continue;
      }
      const verified: VerifiedRelationEdge = {
        ruleId: rule.ruleId,
        fromUri: edge.fromUri,
        toUri: edge.toUri,
        sourceProperty: rule.sourceProperty,
        targetNamespace: rule.targetNamespace,
        sourceSnapshot,
        ...(targetSnapshot ? { targetSnapshot } : {}),
        targetConfirmed: true,
        confidence: edge.confidence,
        evidence
      };
      verifiedEdges.push(verified);
      chain.nodes.push(edge.toUri);
      chain.links.push({ ruleId: rule.ruleId, fromUri: edge.fromUri, toUri: edge.toUri, verified: true });
      progress.push({
        step: progress.length + 1,
        route: 'reference_graph',
        progressed: true,
        progressKind: 'relation_verified',
        detail: `${rule.ruleId} verified ${edge.fromUri} -> ${edge.toUri}`
      });
    }
    identityChains.push(chain);
  }

  if (input.linkageResolver) {
    await addChrLinkageEdges({
      input,
      index,
      candidates,
      verifiedEdges,
      pendingEdges,
      identityChains,
      maxEdges,
      blockedReasons,
      progress
    });
  }

  for (const requested of requestedRelations) {
    const rule = relationRuleForRequest(requested);
    if (!rule) {
      blockedReasons.push(`RELATION_UNVERIFIED:${requested.relation}`);
      nextReadPlan.push({
        stepId: `relation-${requested.relation}`,
        route: 'read_reference_metadata',
        target: requested.relation,
        reason: 'no declared relation rule; keep this relationship as a hypothesis and do not mutate through it',
        priority: 90,
        requiredForMutation: true
      });
      continue;
    }
    const hasEdge = verifiedEdges.some((edge) => (
      edge.ruleId === rule.ruleId
        && (!requested.targetNamespace || edge.targetNamespace === requested.targetNamespace)
    ));
    if (!hasEdge) {
      blockedReasons.push(`RELATION_NOT_VERIFIED:${rule.ruleId}`);
      pendingEdges.push({
        fromUri: candidates[0]?.candidateId ?? 'unresolved://target',
        toUri: 'unresolved://target',
        targetNamespace: requested.targetNamespace ?? rule.targetNamespace,
        reason: 'required relationship has no verified edge in the current snapshot',
        hypothesis: false,
        ruleId: rule.ruleId,
        sourceProperty: rule.sourceProperty,
        evidence: []
      });
      nextReadPlan.push({
        stepId: `read-relation-${rule.ruleId}`,
        route: 'read_native_target',
        target: requested.targetNamespace ?? rule.targetNamespace,
        reason: 'read the target with the declared relation rule and current source version',
        priority: 70,
        requiredForMutation: true
      });
    }
  }

  const hasVerifiedCandidate = candidates.some((candidate) => candidate.status === 'verified' && candidate.nativeVerified);
  const mutationTargets = candidates
    .filter((candidate) => candidate.status === 'verified' && candidate.nativeVerified)
    .filter((candidate) => !requestedRelations.some((relation) => (
      !relationRuleForRequest(relation)
        || !verifiedEdges.some((edge) => edge.ruleId === relationRuleForRequest(relation)?.ruleId)
    )))
    .map((candidate) => candidate.candidateId);

  if (candidates.length === 0) {
    const code = notFoundCode(coverage, coverage.predicateCompleteness);
    blockedReasons.push(code);
  }
  if (candidates.some((candidate) => candidate.status === 'stale')) blockedReasons.push('STALE_NATIVE_EVIDENCE');
  if (candidates.some((candidate) => candidate.status === 'candidate')) blockedReasons.push('NATIVE_READ_REQUIRED_BEFORE_MUTATION');
  if (blockedReasons.length > 0 && !hasVerifiedCandidate) {
    diagnostics.push(...blockedReasons.filter((reason) => reason.startsWith('NOT_FOUND')));
  }

  const status = candidates.length === 0
    ? canConcludeNotFound(coverage, coverage.predicateCompleteness) ? 'not_found_complete_coverage' : query ? 'not_found' : 'blocked'
    : mutationTargets.length > 0 && blockedReasons.every((reason) => !reason.startsWith('RELATION_'))
      ? candidates.filter((candidate) => candidate.nativeVerified).length > 1 ? 'ambiguous' : 'resolved'
      : hasVerifiedCandidate ? 'partial' : 'blocked';

  return makeResult({
    status,
    query: query || handleText,
    domain,
    candidates,
    identityChains,
    verifiedEdges: verifiedEdges.slice(0, maxEdges),
    pendingEdges: pendingEdges.slice(0, maxEdges),
    coverage,
    coverageByDomain: index.getCoverageSnapshot(),
    blockedReasons: uniqueStrings(blockedReasons),
    nextReadPlan: dedupePlan(nextReadPlan),
    attemptedRoutes: uniqueStrings(attemptedRoutes),
    progress,
    hypotheses: hypotheses.slice(0, maxEdges),
    mutationTargets,
    diagnostics
  });
}

/** Class form for hosts that prefer an explicit resolver object. */
export class EntityResolver {
  async resolve(input: EntityResolutionInput): Promise<EntityResolutionResult> {
    return resolveEntity(input);
  }
}

export const resolveEntityResolution = resolveEntity;

function makeResult(input: Omit<EntityResolutionResult, 'candidateSet' | 'edges'>): EntityResolutionResult {
  return {
    ...input,
    candidateSet: input.candidates,
    edges: input.verifiedEdges
  };
}

function coverageForDomain(index: WorkspaceIndex, domain: EntityResolutionDomain): CoverageState {
  const normalized = domain === 'chr' ? 'map' : domain;
  return index.getCoverage(normalized);
}

function withPredicate(state: CoverageState, predicate: PredicateCompleteness): CoverageState {
  return createCoverageState({
    ...state,
    predicateCompleteness: predicate
  });
}

function exactCandidates(
  index: WorkspaceIndex,
  handle: string,
  domain: EntityResolutionDomain,
  limit: number
): EntityCandidate[] {
  const normalized = normalizeHandle(handle);
  const bundle = index.toSymbolBundle();
  const found: EntityCandidate[] = [];
  for (const item of bundle.params ?? []) {
    for (const row of item.rows) {
      if (domain !== 'unknown' && domain !== 'param') continue;
      if (!matchesExactHandle(normalized, row, item.paramName)) continue;
      found.push(candidateFromParam(row, 100, 'exact_handle', ['exact native handle']));
    }
  }
  for (const item of bundle.msgs ?? []) {
    for (const entry of item.entries) {
      if (domain !== 'unknown' && domain !== 'msg') continue;
      if (!matchesExactHandle(normalized, entry, entry.category ?? 'text')) continue;
      found.push(candidateFromText(entry, 100, 'exact_handle', ['exact native handle']));
    }
  }
  for (const item of bundle.maps ?? []) {
    for (const symbol of [...item.entities, ...item.regions]) {
      if (domain !== 'unknown' && domain !== 'map' && domain !== 'chr') continue;
      if (!matchesExactHandle(normalized, symbol, item.mapId)) continue;
      found.push(candidateFromMap(symbol, 100, 'exact_handle', ['exact native handle']));
    }
  }
  for (const item of bundle.events ?? []) {
    for (const event of item.events) {
      if (domain !== 'unknown' && domain !== 'event') continue;
      if (!matchesExactHandle(normalized, event, item.mapId ?? event.mapId ?? 'event')) continue;
      found.push(candidateFromEvent(event, 100, 'exact_handle', ['exact native handle']));
    }
  }
  for (const file of index.getFiles()) {
    if (domain !== 'unknown' && domain !== 'resource') continue;
    const handles = [file.sourceUri, file.sourcePath, file.relativePath, file.absolutePath].map(normalizeHandle);
    if (handles.includes(normalized)) {
      found.push({
        candidateId: file.sourceUri,
        namespace: `resource:${file.resourceKind}`,
        domain: 'resource',
        nativeHandle: file.sourceUri,
        sourceUri: file.sourceUri,
        label: file.relativePath,
        score: 100,
        route: 'exact_handle',
        status: 'candidate',
        nativeVerified: false,
        evidence: [{ kind: 'index', sourceUri: file.sourceUri, detail: 'exact file handle' }]
      });
    }
  }
  return mergeCandidates(found, limit);
}

function searchDomain(
  index: WorkspaceIndex,
  query: string,
  domain: EntityResolutionDomain,
  limit: number
): EntityCandidate[] {
  if (domain === 'param') return index.searchParamRows(query, limit).map((result) => candidateFromParam(result.item, result.score, 'param', result.highlights));
  if (domain === 'msg') return index.searchTextEntries(query, limit).map((result) => candidateFromText(result.item, result.score, 'fmg', result.highlights));
  if (domain === 'map' || domain === 'chr') return index.searchMapEntities(query, limit).map((result) => candidateFromMap(result.item, result.score, 'map', result.highlights));
  if (domain === 'event') return index.searchEvents(query, limit).map((result) => candidateFromEvent(result.item, result.score, 'event', result.highlights));
  if (domain === 'resource') return index.searchResources({ query, limit }).map((result) => ({
    candidateId: result.item.sourceUri,
    namespace: `resource:${result.item.resourceKind}`,
    domain: 'resource',
    nativeHandle: result.item.sourceUri,
    sourceUri: result.item.sourceUri,
    label: result.item.relativePath,
    score: result.score,
    route: 'resource' as const,
    status: 'candidate' as const,
    nativeVerified: false,
    evidence: [{ kind: 'index' as const, sourceUri: result.item.sourceUri, detail: `resource search: ${result.highlights.join(', ')}` }]
  }));
  return [
    ...index.searchParamRows(query, Math.ceil(limit / 2)).map((result) => candidateFromParam(result.item, result.score, 'param', result.highlights)),
    ...index.searchMapEntities(query, Math.ceil(limit / 2)).map((result) => candidateFromMap(result.item, result.score, 'map', result.highlights)),
    ...index.searchEvents(query, Math.ceil(limit / 2)).map((result) => candidateFromEvent(result.item, result.score, 'event', result.highlights))
  ];
}

function memoryHintCandidates(
  index: WorkspaceIndex,
  hints: readonly string[],
  query: string,
  domain: EntityResolutionDomain
): EntityCandidate[] {
  const candidates: EntityCandidate[] = [];
  for (const hint of hints) {
    const exact = exactCandidates(index, hint, domain, 4);
    for (const candidate of exact) {
      candidates.push({
        ...candidate,
        route: 'memory',
        score: candidate.score + 2,
        evidence: [...candidate.evidence, { kind: 'memory', detail: `host memory supplied handle for ${query}` }]
      });
    }
  }
  return candidates;
}

function candidateFromParam(row: ParamRowSymbol, score: number, route: EntityCandidate['route'], highlights: readonly string[]): EntityCandidate {
  return {
    candidateId: row.uri,
    namespace: `param:${row.paramName}`,
    domain: 'param',
    nativeHandle: `${row.paramName}#${row.rowId}`,
    sourceUri: row.sourceUri,
    ...(row.rowName ? { label: row.rowName } : {}),
    score,
    route,
    status: 'candidate',
    nativeVerified: false,
    evidence: [{ kind: route === 'param' ? 'index' : route === 'memory' ? 'memory' : 'index', sourceUri: row.sourceUri, detail: highlights.join(', ') || 'parameter row candidate' }],
    ...(snapshotFromFields(row.sourceUri, row.sourceHash, row.sourceRevision, row.outerFileHash) ? { sourceSnapshot: snapshotFromFields(row.sourceUri, row.sourceHash, row.sourceRevision, row.outerFileHash) } : {})
  };
}

function candidateFromText(entry: TextEntrySymbol, score: number, route: EntityCandidate['route'], highlights: readonly string[]): EntityCandidate {
  return {
    candidateId: entry.uri,
    namespace: `msg:${entry.category ?? 'default'}`,
    domain: 'msg',
    nativeHandle: `${entry.category ?? 'default'}#${entry.textId}`,
    sourceUri: entry.sourceUri,
    label: entry.text,
    score,
    route,
    status: 'candidate',
    nativeVerified: false,
    evidence: [{ kind: route === 'fmg' ? 'index' : 'index', sourceUri: entry.sourceUri, detail: highlights.join(', ') || entry.text.slice(0, 120) }],
    ...(snapshotFromFields(entry.sourceUri, entry.sourceHash, entry.sourceRevision, entry.outerFileHash) ? { sourceSnapshot: snapshotFromFields(entry.sourceUri, entry.sourceHash, entry.sourceRevision, entry.outerFileHash) } : {})
  };
}

function candidateFromMap(symbol: MapEntitySymbol | MapRegionSymbol, score: number, route: EntityCandidate['route'], highlights: readonly string[]): EntityCandidate {
  return {
    candidateId: symbol.uri,
    namespace: 'map-entity',
    domain: 'map',
    nativeHandle: `${symbol.mapId}#${symbol.name}`,
    sourceUri: symbol.sourceUri,
    label: symbol.name,
    score,
    route,
    status: 'candidate',
    nativeVerified: false,
    evidence: [{ kind: 'index', sourceUri: symbol.sourceUri, detail: highlights.join(', ') || 'map entity candidate' }],
    ...(snapshotFromFields(symbol.sourceUri, symbol.sourceHash, symbol.sourceRevision, symbol.outerFileHash) ? { sourceSnapshot: snapshotFromFields(symbol.sourceUri, symbol.sourceHash, symbol.sourceRevision, symbol.outerFileHash) } : {})
  };
}

function candidateFromEvent(event: EventSymbol, score: number, route: EntityCandidate['route'], highlights: readonly string[]): EntityCandidate {
  return {
    candidateId: event.uri,
    namespace: 'event',
    domain: 'event',
    nativeHandle: `${event.sourceUri}#${event.eventId}`,
    sourceUri: event.sourceUri,
    label: event.name ?? String(event.eventId),
    score,
    route,
    status: 'candidate',
    nativeVerified: false,
    evidence: [{ kind: 'index', sourceUri: event.sourceUri, detail: highlights.join(', ') || 'event candidate' }],
    ...(snapshotFromFields(event.sourceUri, event.sourceHash, event.sourceRevision, event.outerFileHash) ? { sourceSnapshot: snapshotFromFields(event.sourceUri, event.sourceHash, event.sourceRevision, event.outerFileHash) } : {})
  };
}

function verifyIndexedCandidate(index: WorkspaceIndex, candidate: EntityCandidate): EntityCandidate {
  if (!candidate.sourceUri || !candidate.sourceSnapshot) {
    return { ...candidate, status: 'candidate', nativeVerified: false };
  }
  const file = index.getFile(candidate.sourceUri);
  if (!file) return { ...candidate, status: 'candidate', nativeVerified: false };
  if (!isSnapshotCurrent(candidate.sourceSnapshot, index)) {
    return {
      ...candidate,
      status: 'stale',
      nativeVerified: false,
      rejectionReason: 'source hash/revision is not current'
    };
  }
  return {
    ...candidate,
    status: 'verified',
    nativeVerified: true,
    evidence: [...candidate.evidence, { kind: 'native-read', sourceUri: file.sourceUri, detail: 'indexed native projection matches current source version' }]
  };
}

function findSymbol(index: WorkspaceIndex, uri: string): EventSymbol | MapEntitySymbol | MapRegionSymbol | ParamRowSymbol | TextEntrySymbol | undefined {
  const bundle = index.toSymbolBundle();
  for (const item of bundle.events ?? []) {
    const found = item.events.find((event) => event.uri === uri);
    if (found) return found;
  }
  for (const item of bundle.maps ?? []) {
    const found = [...item.entities, ...item.regions].find((symbol) => symbol.uri === uri);
    if (found) return found;
  }
  for (const item of bundle.params ?? []) {
    const found = item.rows.find((row) => row.uri === uri);
    if (found) return found;
  }
  for (const item of bundle.msgs ?? []) {
    const found = item.entries.find((entry) => entry.uri === uri);
    if (found) return found;
  }
  return undefined;
}

function snapshotForSymbol(
  symbol: ReturnType<typeof findSymbol>,
  index: WorkspaceIndex
): EntitySourceSnapshot | undefined {
  if (!symbol) return undefined;
  const sourceUri = symbol.sourceUri;
  const source = snapshotFromFields(sourceUri, symbol.sourceHash, symbol.sourceRevision, symbol.outerFileHash);
  if (source) return source;
  const file = index.getFile(sourceUri);
  return file ? snapshotFromFile(file) : undefined;
}

function snapshotFromFields(sourceUri: string, sourceHash?: string, sourceRevision?: number, outerFileHash?: string): EntitySourceSnapshot | undefined {
  if (!sourceHash && !outerFileHash && sourceRevision === undefined) return undefined;
  return {
    sourceUri,
    ...(sourceHash ? { sourceHash } : {}),
    ...(outerFileHash ? { outerFileHash } : {}),
    ...(sourceRevision !== undefined ? { sourceRevision } : {})
  };
}

function snapshotFromFile(file: Pick<IndexedFile, 'sourceUri' | 'sha256' | 'mtimeMs'>): EntitySourceSnapshot {
  return {
    sourceUri: file.sourceUri,
    ...(file.sha256 ? { sourceHash: file.sha256 } : {}),
    sourceRevision: file.mtimeMs
  };
}

function isSnapshotCurrent(snapshot: EntitySourceSnapshot | undefined, index: WorkspaceIndex): boolean {
  if (!snapshot) return false;
  const file = index.getFile(snapshot.sourceUri);
  if (!file) return false;
  const outerHash = snapshot.outerFileHash ?? snapshot.sourceHash;
  if (outerHash && file.sha256 && outerHash !== file.sha256) return false;
  if (snapshot.sourceRevision !== undefined && typeof snapshot.sourceRevision === 'number' && snapshot.sourceRevision !== file.mtimeMs) return false;
  return true;
}

function declaredRuleForEdge(edge: ReferenceEdge): RelationRule | undefined {
  if (edge.kind === 'numeric_match' || edge.kind === 'unknown') return undefined;
  if (edge.kind === 'calls_event') return { ruleId: 'emevd.event-id', targetNamespace: 'event', sourceProperty: 'eventId', kind: edge.kind };
  if (edge.kind === 'references_map_entity') return { ruleId: 'emevd.entity-id', targetNamespace: 'map-entity', sourceProperty: 'entityId', kind: edge.kind };
  if (edge.kind === 'references_region') return { ruleId: 'emevd.region-id', targetNamespace: 'map-region', sourceProperty: 'regionId', kind: edge.kind };
  if (edge.kind === 'references_param_row') return { ruleId: 'emevd.param-id', targetNamespace: 'param-row', sourceProperty: 'paramId', kind: edge.kind };
  if (edge.kind === 'references_text') {
    if (!edge.reason.includes('source-backed') && !edge.reason.includes('PARAM')) return undefined;
    return { ruleId: 'param.text-reference.declared', targetNamespace: 'text-entry', sourceProperty: edge.evidence[0]?.fieldName ?? 'textId', kind: edge.kind };
  }
  if (edge.kind === 'reads_flag' || edge.kind === 'writes_flag') return { ruleId: 'emevd.flag-reference', targetNamespace: 'flag', sourceProperty: 'flagId', kind: edge.kind };
  return undefined;
}

function relationRuleForRequest(request: { relation: string; targetNamespace?: string; ruleId?: string }): RelationRule | undefined {
  if (request.ruleId) {
    const known = relationRules().find((rule) => rule.ruleId === request.ruleId);
    return known;
  }
  const relation = request.relation.toLowerCase();
  return relationRules().find((rule) => rule.ruleId === relation || rule.targetNamespace === relation || rule.targetNamespace === request.targetNamespace);
}

function relationRules(): RelationRule[] {
  return [
    { ruleId: 'emevd.event-id', targetNamespace: 'event', sourceProperty: 'eventId', kind: 'calls_event' },
    { ruleId: 'emevd.entity-id', targetNamespace: 'map-entity', sourceProperty: 'entityId', kind: 'references_map_entity' },
    { ruleId: 'emevd.region-id', targetNamespace: 'map-region', sourceProperty: 'regionId', kind: 'references_region' },
    { ruleId: 'emevd.param-id', targetNamespace: 'param-row', sourceProperty: 'paramId', kind: 'references_param_row' },
    { ruleId: 'param.text-reference.declared', targetNamespace: 'text-entry', sourceProperty: 'textId', kind: 'references_text' },
    { ruleId: 'emevd.flag-reference', targetNamespace: 'flag', sourceProperty: 'flagId', kind: 'reads_flag' }
  ];
}

async function addChrLinkageEdges(input: {
  input: EntityResolutionInput;
  index: WorkspaceIndex;
  candidates: readonly EntityCandidate[];
  verifiedEdges: VerifiedRelationEdge[];
  pendingEdges: PendingRelationEdge[];
  identityChains: IdentityChain[];
  maxEdges: number;
  blockedReasons: string[];
  progress: ResolverProgress[];
}): Promise<void> {
  for (const candidate of input.candidates) {
    if (input.verifiedEdges.length >= input.maxEdges) {
      input.blockedReasons.push('EDGE_BUDGET_EXHAUSTED');
      return;
    }
    if (!candidate.namespace.toLowerCase().startsWith('param:npcparam')) continue;
    const rowId = parseNativeRowId(candidate.nativeHandle);
    if (rowId === undefined) continue;
    const linkage = await input.input.linkageResolver!(rowId);
    if (!linkage) continue;
    const sourceSnapshot = candidate.sourceSnapshot;
    if (!sourceSnapshot) {
      input.blockedReasons.push('NATIVE_TARGET_CONFIRMATION_REQUIRED:NpcParam');
      continue;
    }
    const chain = input.identityChains.find((value) => value.candidateId === candidate.candidateId);
    const chrUri = `chr://${linkage.characterId}`;
    input.verifiedEdges.push({
      ruleId: 'npc-param.character-model',
      fromUri: candidate.candidateId,
      toUri: chrUri,
      sourceProperty: 'rowId',
      targetNamespace: 'character-model',
      sourceSnapshot,
      targetConfirmed: true,
      confidence: 'high',
      evidence: [{ kind: 'linkage', sourceUri: candidate.sourceUri, sourceProperty: 'rowId', value: rowId, detail: 'declared NpcParam rowId -> character model rule' }]
    });
    chain?.nodes.push(chrUri);
    if (chain) chain.links.push({ ruleId: 'npc-param.character-model', fromUri: candidate.candidateId, toUri: chrUri, verified: true });
    for (const map of linkage.maps) {
      if (input.verifiedEdges.length >= input.maxEdges) break;
      const mapUri = `map://${map.mapId}/part/${map.partName}`;
      input.verifiedEdges.push({
        ruleId: 'character-model.map-part-name',
        fromUri: chrUri,
        toUri: mapUri,
        sourceProperty: 'part.name',
        targetNamespace: 'map-entity',
        sourceSnapshot,
        targetConfirmed: true,
        confidence: 'high',
        evidence: [{ kind: 'linkage', sourceUri: map.mapFile, sourceProperty: 'part.name', detail: 'native MSB character part matched character model' }]
      });
      chain?.nodes.push(mapUri);
    }
    for (const event of linkage.associatedBossEvents) {
      if (input.verifiedEdges.length >= input.maxEdges) break;
      const eventUri = `event://${event.eventFile}#${event.eventId}`;
      input.verifiedEdges.push({
        ruleId: 'map-part.event-scope',
        fromUri: chrUri,
        toUri: eventUri,
        sourceProperty: 'eventId',
        targetNamespace: 'event',
        sourceSnapshot,
        targetConfirmed: true,
        confidence: 'medium',
        evidence: [{ kind: 'linkage', sourceUri: event.eventFile, sourceProperty: 'eventId', value: event.eventId, detail: event.description }]
      });
      chain?.nodes.push(eventUri);
    }
    for (const script of linkage.scripts) {
      if (input.verifiedEdges.length >= input.maxEdges) break;
      const scriptUri = `script://${script}`;
      input.verifiedEdges.push({
        ruleId: 'character-model.ai-script',
        fromUri: chrUri,
        toUri: scriptUri,
        sourceProperty: 'characterId',
        targetNamespace: 'ai-script',
        sourceSnapshot,
        targetConfirmed: true,
        confidence: 'medium',
        evidence: [{ kind: 'linkage', detail: `AI script candidate ${script}` }]
      });
      chain?.nodes.push(scriptUri);
    }
    input.progress.push({
      step: input.progress.length + 1,
      route: 'chr_linkage',
      progressed: input.verifiedEdges.length > 0,
      progressKind: input.verifiedEdges.length > 0 ? 'relation_verified' : 'none',
      detail: `NpcParam ${rowId} linkage completed`
    });
  }
}

async function runNativeReadForExact(
  reader: NonNullable<EntityResolutionInput['nativeRead']>,
  handle: string,
  domain: EntityResolutionDomain,
  maxSteps: number,
  maxRouteChanges: number,
  progress: ResolverProgress[],
  attemptedRoutes: string[],
  blockedReasons: string[]
): Promise<EntityCandidate[]> {
  const parsed = parseNativeHandle(handle, domain);
  if (!parsed) {
    blockedReasons.push('EXACT_HANDLE_UNPARSEABLE');
    return [];
  }
  let noProgress = 0;
  let routeChanges = 0;
  const candidates: EntityCandidate[] = [];
  for (let step = 0; step < maxSteps; step += 1) {
    attemptedRoutes.push(routeNameForStep(routeChanges));
    let observation: NativeReadObservation;
    try {
      observation = await reader({
        handle,
        namespace: parsed.namespace,
        objectKey: parsed.objectKey,
        domain,
        ...(parsed.sourceUri ? { sourceUri: parsed.sourceUri } : {}),
        requiredFields: ['identity', 'sourceHash', 'sourceRevision'],
        route: 'exact_handle'
      });
    } catch (error) {
      blockedReasons.push(`NATIVE_READ_FAILED:${error instanceof Error ? error.message : String(error)}`);
      break;
    }
    const progressed = observation.ok === true && observation.verified === true && Boolean(observation.candidate?.candidateId || observation.candidate?.nativeHandle);
    progress.push({
      step: progress.length + 1,
      route: 'read_native',
      progressed,
      progressKind: progressed ? 'native_field_filled' : 'none',
      detail: observation.reason ?? (progressed ? 'native identity verified' : 'native read did not add a verified identity')
    });
    if (progressed) {
      const partial = observation.candidate!;
      const candidate: EntityCandidate = {
        candidateId: partial.candidateId ?? partial.nativeHandle ?? handle,
        namespace: partial.namespace ?? parsed.namespace,
        domain: partial.domain ?? domain,
        nativeHandle: partial.nativeHandle ?? handle,
        ...(partial.sourceUri ? { sourceUri: partial.sourceUri } : parsed.sourceUri ? { sourceUri: parsed.sourceUri } : {}),
        ...(partial.label ? { label: partial.label } : {}),
        score: 100,
        route: 'native_read',
        status: 'verified',
        nativeVerified: true,
        evidence: observation.evidence ?? [{ kind: 'native-read', sourceUri: partial.sourceUri, detail: 'native exact handle read verified identity' }],
        ...(observation.sourceSnapshot ? { sourceSnapshot: observation.sourceSnapshot } : {})
      };
      candidates.push(candidate);
      break;
    }
    noProgress += 1;
    if (noProgress < 2) continue;
    if (routeChanges < maxRouteChanges) {
      routeChanges += 1;
      noProgress = 0;
      continue;
    }
    blockedReasons.push('RESOLVER_NO_PROGRESS');
    break;
  }
  if (maxSteps === 0) blockedReasons.push('RESOLVER_BUDGET_EXHAUSTED');
  else if (progress.length >= maxSteps && candidates.length === 0) blockedReasons.push('RESOLVER_BUDGET_EXHAUSTED');
  return candidates;
}

function parseNativeHandle(handle: string, domain: EntityResolutionDomain): { namespace: string; objectKey: string; sourceUri?: string } | undefined {
  const trimmed = handle.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('file:') || trimmed.includes('/') || trimmed.includes('\\')) {
    const fragment = trimmed.indexOf('#');
    if (fragment > 0) {
      return { namespace: namespaceForDomain(domain), objectKey: trimmed.slice(fragment + 1), sourceUri: trimmed.slice(0, fragment) };
    }
  }
  const match = trimmed.match(/^([^#/:]+)[#/:](.+)$/u);
  if (match?.[1] && match[2]) return { namespace: match[1], objectKey: match[2] };
  if (/^(?:c\d+|m\d+_\d+_\d+_\d+)$/iu.test(trimmed)) {
    return { namespace: namespaceForDomain(domain), objectKey: trimmed };
  }
  return { namespace: namespaceForDomain(domain), objectKey: trimmed };
}

function matchesExactHandle(
  normalized: string,
  symbol: { uri: string; sourceUri: string; rowId?: number; textId?: number; eventId?: number; name?: string },
  namespace: string
): boolean {
  const values = [
    symbol.uri,
    `${namespace}#${String(symbol['rowId'] ?? symbol['textId'] ?? symbol['eventId'] ?? symbol['name'] ?? '')}`,
    `${namespace}/${String(symbol['rowId'] ?? symbol['textId'] ?? symbol['eventId'] ?? symbol['name'] ?? '')}`,
    symbol.sourceUri
  ].map(normalizeHandle);
  return values.includes(normalized);
}

function normalizeHandle(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/\/+$/u, '').toLocaleLowerCase();
}

function namespaceForDomain(domain: EntityResolutionDomain): string {
  if (domain === 'param') return 'param';
  if (domain === 'msg') return 'msg';
  if (domain === 'map' || domain === 'chr') return 'map';
  if (domain === 'event') return 'event';
  return domain || 'resource';
}

function inferDomainFromHandle(handle: string): EntityResolutionDomain | undefined {
  const lower = handle.toLowerCase();
  if (lower.includes('npcparam') || lower.startsWith('param:') || lower.startsWith('param#')) return 'param';
  if (lower.includes('.emevd') || lower.startsWith('event:') || lower.startsWith('event#')) return 'event';
  if (lower.includes('.msb') || lower.startsWith('map:') || lower.startsWith('map#') || /^m\d/iu.test(handle)) return 'map';
  if (lower.includes('.fmg') || lower.includes('msgbnd') || lower.startsWith('msg:') || lower.startsWith('msg#')) return 'msg';
  return undefined;
}

function formatNativeHandle(handle: NativeEntityHandle): string {
  return `${handle.namespace}#${handle.objectKey}`;
}

function namespaceFromUri(uri: string): string {
  const scheme = uri.match(/^([a-z0-9_-]+):\/\//iu)?.[1];
  if (scheme) return scheme;
  if (uri.startsWith('flag://')) return 'flag';
  return 'unknown';
}

function normalizeRelations(values: readonly EntityRelationRequest[]): Array<{ relation: string; targetNamespace?: string; ruleId?: string }> {
  return values.flatMap((value) => {
    if (typeof value === 'string' && value.trim()) return [{ relation: value.trim() }];
    if (value && typeof value === 'object' && value.relation && value.relation.trim()) return [{ relation: value.relation.trim(), ...(value.targetNamespace ? { targetNamespace: value.targetNamespace } : {}), ...(value.ruleId ? { ruleId: value.ruleId } : {}) }];
    return [];
  });
}

function parseNativeRowId(handle: string): number | undefined {
  const match = handle.match(/#(\d+)$/u);
  if (!match?.[1]) return undefined;
  const rowId = Number(match[1]);
  return Number.isSafeInteger(rowId) ? rowId : undefined;
}

function mergeCandidates(candidates: readonly EntityCandidate[], limit: number): EntityCandidate[] {
  const byId = new Map<string, EntityCandidate>();
  for (const candidate of candidates) {
    const existing = byId.get(candidate.candidateId);
    if (!existing || candidate.score > existing.score) {
      byId.set(candidate.candidateId, candidate);
    } else if (existing) {
      byId.set(candidate.candidateId, {
        ...existing,
        evidence: [...existing.evidence, ...candidate.evidence].slice(0, 8),
        score: Math.max(existing.score, candidate.score)
      });
    }
  }
  return [...byId.values()].sort((left, right) => right.score - left.score).slice(0, limit);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function dedupePlan(plan: readonly ResolverReadPlanStep[]): ResolverReadPlanStep[] {
  const seen = new Set<string>();
  return plan.filter((step) => {
    const key = `${step.route}|${step.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isSafeInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function routeNameForStep(routeChanges: number): string {
  return routeChanges === 0 ? 'read_native_exact' : routeChanges === 1 ? 'read_reference_metadata' : 'read_native_target';
}
