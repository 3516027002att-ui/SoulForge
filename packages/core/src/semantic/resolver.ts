import type {
  EventSymbol,
  MapEntitySymbol,
  MapRegionSymbol,
  ParamRowSymbol,
  TaeEventSymbol,
  TextEntrySymbol
} from '@soulforge/shared';
import type { SearchResult, WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { coverageForSearch, coverageForScope, revisionForFiles } from './coverage.js';
import { isExactTarget } from './taskModel.js';
import type {
  CanonicalEntity,
  CanonicalEntityEdge,
  CanonicalEntityGraph,
  CanonicalEntityKind,
  CoverageSnapshot,
  CoverageStatus,
  ResolverCandidate,
  ResolverResult,
  ResolvedFact,
  TaskModel,
  TaskTargetDescription
} from './types.js';

type SupportedSymbol = EventSymbol | MapEntitySymbol | MapRegionSymbol | ParamRowSymbol | TextEntrySymbol | TaeEventSymbol;

export class SemanticResolver {
  constructor(private readonly index: WorkspaceIndex | null) {}

  resolveTask(task: TaskModel): ResolverResult<CanonicalEntityGraph> {
    if (!this.index) {
      return {
        status: 'SOURCE_UNAVAILABLE',
        candidates: [],
        coverage: {
          status: 'SOURCE_UNAVAILABLE', scope: 'workspace', indexed: 0, expected: 0,
          successful: 0, failed: 0, completenessRatio: 0, resultCount: 0,
          diagnostics: ['工作区未打开。']
        },
        facts: [],
        diagnostics: ['无法在没有工作区的情况下解析 canonical entity。']
      };
    }

    const allCandidates: ResolverCandidate[] = [];
    const nodes: CanonicalEntity[] = [];
    const targetResults = task.targets.length > 0
      ? task.targets.map((target) => this.resolveTarget(target))
      : [this.searchAcrossDomains(task.originalGoal)];

    for (const result of targetResults) {
      allCandidates.push(...result.candidates);
      if (result.status === 'RESOLVED' && result.value) nodes.push(...result.value.nodes);
    }

    const uniqueNodes = uniqueBy(nodes, (node) => node.identity);
    const edges = this.buildEdges(uniqueNodes);
    const facts = factsForEntities(uniqueNodes);
    const revision = revisionForFiles(this.index.getFiles()) ?? 'workspace:unknown';
    const graph: CanonicalEntityGraph = { nodes: uniqueNodes, edges, facts, revision };
    const coverage = coverageForGraph(this.index, targetResults, uniqueNodes.length);
    const hasAmbiguous = targetResults.some((result) => result.status === 'AMBIGUOUS');
    const hasUnresolved = targetResults.some((result) => result.status !== 'RESOLVED');
    const status = !hasUnresolved && uniqueNodes.length > 0
      ? 'RESOLVED'
      : hasAmbiguous || uniqueNodes.length > 1
        ? 'AMBIGUOUS'
        : coverage.status === 'NOT_FOUND_WITH_COMPLETE_COVERAGE'
          ? 'NOT_FOUND_COMPLETE'
          : coverage.status === 'SOURCE_UNAVAILABLE'
            ? 'SOURCE_UNAVAILABLE'
            : coverage.status === 'PARSE_FAILED'
              ? 'PARSE_FAILED'
              : 'COVERAGE_INCOMPLETE';
    return {
      status,
      ...(uniqueNodes.length > 0 ? { value: graph } : {}),
      candidates: allCandidates,
      facts,
      coverage,
      diagnostics: coverage.diagnostics
    };
  }

  resolveTarget(target: TaskTargetDescription): ResolverResult<CanonicalEntityGraph> {
    if (!this.index) {
      return {
        status: 'SOURCE_UNAVAILABLE',
        candidates: [],
        facts: [],
        coverage: {
          status: 'SOURCE_UNAVAILABLE', scope: scopeForKind(target.kind), indexed: 0, expected: 0,
          successful: 0, failed: 0, completenessRatio: 0, resultCount: 0,
          diagnostics: ['工作区未打开。']
        },
        diagnostics: ['无法在没有工作区的情况下解析 canonical entity。']
      };
    }
    const scope = scopeForKind(target.kind);
    const results = this.search(target.text, target.kind);
    const indexedEntities = results.map((result) => toCanonicalEntity(result.item, target.kind, this.index!));
    const dirtyEntities = this.index.listEffectiveDirtyCanonicalEntities().filter((entity) => matchesTargetText(entity, target.text));
    const rawDirtyEntities = this.index.listRawDirtyCanonicalEntities().filter((entity) => matchesTargetText(entity, target.text));
    const issues = dirtyProjectionIssues(this.index, [...indexedEntities, ...rawDirtyEntities]);
    const blockedIdentities = new Set(issues.keys());
    const coverage = coverageForSearch(this.index, scope, results);
    const effectiveCoverage = coverageForDirtyIssues(coverage, issues);
    const entities = uniqueBy([
      ...indexedEntities.filter((entity) => !blockedIdentities.has(entity.identity)),
      ...dirtyEntities.filter((entity) => !blockedIdentities.has(entity.identity))
    ].map((entity) => this.index!.getEffectiveCanonicalEntity(entity.identity) ?? entity), (entity) => entity.identity);
    const indexedIdentitySet = new Set(indexedEntities.map((entity) => entity.identity));
    const indexedScores = new Map(indexedEntities.map((entity, index) => [entity.identity, results[index]?.score ?? 1]));
    const indexedHighlights = new Map(indexedEntities.map((entity, index) => [entity.identity, results[index]?.highlights ?? []]));
    const candidateEntities = uniqueBy([...entities, ...rawDirtyEntities.filter((entity) => blockedIdentities.has(entity.identity))], (entity) => entity.identity);
    const candidates = candidateEntities.map((entity) => ({
      value: entity,
      score: indexedScores.get(entity.identity) ?? 1,
      reasons: issues.get(entity.identity) === 'STALE'
        ? ['dirty canonical working copy stale against indexed source']
        : issues.get(entity.identity) === 'CONFLICT'
          ? ['dirty canonical working copies conflict']
          : issues.get(entity.identity) === 'SUPPRESSED'
            ? ['dirty canonical working copy explicitly removed this identity']
            : indexedIdentitySet.has(entity.identity)
        ? (indexedHighlights.get(entity.identity)?.length ? indexedHighlights.get(entity.identity)! : ['indexed canonical projection'])
        : ['dirty canonical working copy']
    }));
    const exactResults = isExactTarget(target)
      ? entities.filter((entity) => entity.address?.toLowerCase() === target.address?.toLowerCase()
        || entity.identity.toLowerCase() === target.address?.toLowerCase()
        || entity.sourceSymbolUri?.toLowerCase() === target.address?.toLowerCase())
      : entities;
    // Natural-language discovery is not an authorization to pick the first
    // ranked row.  Only an exact address may select one entity deterministically;
    // a non-exact query with multiple candidates remains ambiguous until the
    // caller supplies a canonical discriminator.
    const selected = isExactTarget(target)
      ? exactResults
      : exactResults.length === 1 ? exactResults : [];
    const issueStatuses = new Set(issues.values());
    const status = issueStatuses.has('STALE')
        ? 'STALE'
        : issueStatuses.has('CONFLICT')
          ? 'AMBIGUOUS'
          : issueStatuses.has('SUPPRESSED')
            ? 'COVERAGE_INCOMPLETE'
            : selected.length === 1
              ? 'RESOLVED'
              : exactResults.length > 1
                ? 'AMBIGUOUS'
                : effectiveCoverage.status === 'NOT_FOUND_WITH_COMPLETE_COVERAGE'
                  ? 'NOT_FOUND_COMPLETE'
                  : effectiveCoverage.status === 'PARSE_FAILED'
                    ? 'PARSE_FAILED'
                    : effectiveCoverage.status === 'SOURCE_UNAVAILABLE'
                      ? 'SOURCE_UNAVAILABLE'
                      : 'COVERAGE_INCOMPLETE';
    const facts = factsForEntities(selected);
    const graph: CanonicalEntityGraph = {
      nodes: selected,
      edges: this.buildEdges(selected),
      facts,
      revision: revisionForFiles(this.index!.getFiles()) ?? 'workspace:unknown'
    };
    return {
      status,
      ...(selected.length > 0 ? { value: graph } : {}),
      candidates,
      facts,
      coverage: effectiveCoverage,
      diagnostics: effectiveCoverage.diagnostics
    };
  }

  private searchAcrossDomains(query: string): ResolverResult<CanonicalEntityGraph> {
    const searches: Array<{ kind: CanonicalEntityKind; results: SearchResult<SupportedSymbol>[] }> = [
      { kind: 'text_entry', results: this.index!.searchTextEntries(query, 12) },
      { kind: 'param_row', results: this.index!.searchParamRows(query, 12) },
      { kind: 'map_entity', results: this.index!.searchMapEntities(query, 12) },
      { kind: 'event', results: this.index!.searchEvents(query, 12) },
      { kind: 'action', results: this.index!.searchTaeEvents(query, 12) }
    ];
    const indexedNodes = searches.flatMap(({ kind, results }) => results.map((result) => toCanonicalEntity(result.item, kind, this.index!)));
    const dirtyNodes = this.index!.listEffectiveDirtyCanonicalEntities().filter((entity) => matchesTargetText(entity, query));
    const rawDirtyNodes = this.index!.listRawDirtyCanonicalEntities().filter((entity) => matchesTargetText(entity, query));
    const issues = dirtyProjectionIssues(this.index!, [...indexedNodes, ...rawDirtyNodes]);
    const blockedIdentities = new Set(issues.keys());
    const nodes = uniqueBy([
      ...indexedNodes.filter((entity) => !blockedIdentities.has(entity.identity)),
      ...dirtyNodes.filter((entity) => !blockedIdentities.has(entity.identity))
    ].map((entity) => this.index!.getEffectiveCanonicalEntity(entity.identity) ?? entity), (entity) => entity.identity);
    const indexedIdentitySet = new Set(indexedNodes.map((entity) => entity.identity));
    const indexedScores = new Map(indexedNodes.map((entity) => [entity.identity, 1]));
    const candidateNodes = uniqueBy([...nodes, ...rawDirtyNodes.filter((entity) => blockedIdentities.has(entity.identity))], (entity) => entity.identity);
    const candidates = candidateNodes.map((entity) => ({
      value: entity,
      score: indexedScores.get(entity.identity) ?? 1,
      reasons: issues.get(entity.identity) === 'STALE'
        ? ['dirty canonical working copy stale against indexed source']
        : issues.get(entity.identity) === 'CONFLICT'
          ? ['dirty canonical working copies conflict']
          : issues.get(entity.identity) === 'SUPPRESSED'
            ? ['dirty canonical working copy explicitly removed this identity']
            : indexedIdentitySet.has(entity.identity)
        ? ['indexed canonical projection']
        : ['dirty canonical working copy']
    }));
    const coverage = coverageForDirtyIssues(
      coverageForScope(this.index, 'workspace', nodes.length, revisionForFiles(this.index!.getFiles())),
      issues
    );
    const facts = factsForEntities(nodes);
    const graph: CanonicalEntityGraph = {
      nodes,
      edges: this.buildEdges(nodes),
      facts,
      revision: revisionForFiles(this.index!.getFiles()) ?? 'workspace:unknown'
    };
    const issueStatuses = new Set(issues.values());
    const status = issueStatuses.has('STALE')
        ? 'STALE'
        : issueStatuses.has('CONFLICT')
          ? 'AMBIGUOUS'
          : issueStatuses.has('SUPPRESSED')
            ? 'COVERAGE_INCOMPLETE'
            : nodes.length === 1
              ? 'RESOLVED'
              : nodes.length > 1
                ? 'AMBIGUOUS'
                : coverage.status === 'NOT_FOUND_WITH_COMPLETE_COVERAGE'
                  ? 'NOT_FOUND_COMPLETE'
                  : coverage.status === 'SOURCE_UNAVAILABLE'
                    ? 'SOURCE_UNAVAILABLE'
                    : coverage.status === 'PARSE_FAILED'
                      ? 'PARSE_FAILED'
                      : 'COVERAGE_INCOMPLETE';
    return {
      status,
      ...(nodes.length > 0 ? { value: graph } : {}),
      candidates,
      facts,
      coverage,
      diagnostics: coverage.diagnostics
    };
  }

  private search(query: string, kind?: CanonicalEntityKind): Array<SearchResult<SupportedSymbol>> {
    switch (kind) {
      case 'event': return this.index!.searchEvents(query) as Array<SearchResult<SupportedSymbol>>;
      case 'map':
      case 'map_entity':
      case 'map_region': return this.index!.searchMapEntities(query) as Array<SearchResult<SupportedSymbol>>;
      case 'param':
      case 'param_row': return this.index!.searchParamRows(query) as Array<SearchResult<SupportedSymbol>>;
      case 'text_entry': return this.index!.searchTextEntries(query) as Array<SearchResult<SupportedSymbol>>;
      case 'action': return this.index!.searchTaeEvents(query) as Array<SearchResult<SupportedSymbol>>;
      default: return this.index!.searchTextEntries(query) as Array<SearchResult<SupportedSymbol>>;
    }
  }

  private buildEdges(nodes: readonly CanonicalEntity[]): CanonicalEntityEdge[] {
    const byUri = new Set(nodes.flatMap((node) => [node.identity, node.sourceUri, node.sourceSymbolUri ?? '']));
    const revision = revisionForFiles(this.index!.getFiles()) ?? 'workspace:unknown';
    return this.index!.listReferences()
      .filter((edge) => byUri.has(edge.fromUri) && byUri.has(edge.toUri))
      .map((edge) => ({
        from: edge.fromUri,
        to: edge.toUri,
        relation: edge.kind,
        provenance: edge.reason,
        confidence: edge.confidence,
        evidenceIds: edge.evidence.map((evidence) => evidence.sourceUri),
        revision,
        epistemic: edge.confidence === 'high' ? 'observed' : 'derived'
      }));
  }
}

type DirtyProjectionIssue = 'STALE' | 'CONFLICT' | 'SUPPRESSED';

function dirtyProjectionIssues(index: WorkspaceIndex, entities: readonly CanonicalEntity[]): Map<string, DirtyProjectionIssue> {
  const issues = new Map<string, DirtyProjectionIssue>();
  for (const entity of entities) {
    const selection = index.selectCanonicalProjection(entity.identity);
    if (selection.status === 'stale') issues.set(entity.identity, 'STALE');
    else if (selection.status === 'conflict') issues.set(entity.identity, 'CONFLICT');
    else if (selection.status === 'suppressed') issues.set(entity.identity, 'SUPPRESSED');
  }
  return issues;
}

function coverageForDirtyIssues(
  coverage: CoverageSnapshot,
  issues: ReadonlyMap<string, DirtyProjectionIssue>
): CoverageSnapshot {
  if (issues.size === 0) return coverage;
  const diagnostics = [
    ...coverage.diagnostics,
    ...[...issues.entries()].map(([identity, issue]) => `canonical projection ${identity} is ${issue.toLowerCase()}; indexed value is not effective evidence.`)
  ];
  return {
    ...coverage,
    status: [...issues.values()].includes('STALE') ? 'STALE' : coverage.status === 'FOUND' ? 'PARTIALLY_INDEXED' : coverage.status,
    diagnostics: [...new Set(diagnostics)]
  };
}

function toCanonicalEntity(symbol: SupportedSymbol, requestedKind: CanonicalEntityKind | undefined, index: WorkspaceIndex): CanonicalEntity {
  const sourceUri = 'sourceUri' in symbol && typeof symbol.sourceUri === 'string' ? symbol.sourceUri : symbol.uri;
  const revision = revisionForFiles(index.getFiles().filter((file) => file.sourceUri === sourceUri)) ?? `source:${sourceUri}`;
  if ('eventId' in symbol) return {
    identity: symbol.uri, sourceUri, revision, address: symbol.uri, kind: 'event', displayName: symbol.name ?? `event ${symbol.eventId}`,
    sourceSymbolUri: symbol.uri, epistemic: 'observed'
  };
  if ('textId' in symbol) return {
    identity: symbol.uri, sourceUri, revision, address: symbol.uri, kind: requestedKind === 'text_entry' ? 'text_entry' : 'text_entry', displayName: symbol.text,
    sourceSymbolUri: symbol.uri, epistemic: symbol.confidence === 'low' ? 'derived' : 'observed'
  };
  if ('rowId' in symbol) return {
    identity: symbol.uri, sourceUri, revision, address: symbol.uri, kind: 'param_row', displayName: symbol.rowName ?? `${symbol.paramName} ${symbol.rowId}`,
    sourceSymbolUri: symbol.uri, epistemic: 'observed'
  };
  if ('eventTypeId' in symbol) return {
    identity: symbol.uri, sourceUri, revision, address: symbol.uri, kind: 'action', displayName: symbol.typeName ?? `TAE ${symbol.eventTypeId}`,
    sourceSymbolUri: symbol.uri, epistemic: 'observed'
  };
  if ('mapId' in symbol && 'kind' in symbol) return {
    identity: symbol.uri, sourceUri, revision, address: symbol.uri, kind: 'map_entity', displayName: symbol.name,
    sourceSymbolUri: symbol.uri, epistemic: 'observed'
  };
  if ('mapId' in symbol) return {
    identity: symbol.uri, sourceUri, revision, address: symbol.uri, kind: 'map_region', displayName: symbol.name,
    sourceSymbolUri: symbol.uri, epistemic: 'observed'
  };
  const uri = (symbol as { uri: string }).uri;
  return { identity: uri, sourceUri, revision, kind: requestedKind ?? 'resource', displayName: uri, sourceSymbolUri: uri, epistemic: 'unverified' };
}

function scopeForKind(kind: CanonicalEntityKind | undefined): string {
  switch (kind) {
    case 'event': return 'event';
    case 'map':
    case 'map_entity':
    case 'map_region': return 'map';
    case 'param':
    case 'param_row': return 'param';
    case 'action': return 'action';
    case 'text_entry': return 'text';
    default: return 'workspace';
  }
}

function matchesTargetText(entity: CanonicalEntity, query: string): boolean {
  const haystack = [entity.identity, entity.displayName, entity.address, entity.sourceUri, entity.sourceSymbolUri]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
}

function coverageForGraph(index: WorkspaceIndex, results: readonly ResolverResult<CanonicalEntityGraph>[], resultCount: number): CoverageSnapshot {
  const statuses = results.map((result) => result.coverage.status);
  const sourceRevision = revisionForFiles(index.getFiles());
  const expected = index.getFiles().length;
  const failed = index.getFiles().filter((file) => file.parseStatus === 'failed' || file.parseStatus === 'unsupported').length;
  const partial = index.getFiles().filter((file) => file.parseStatus === 'partial').length;
  const pending = index.getFiles().filter((file) => file.parseStatus === 'unparsed').length;
  const successful = Math.max(0, expected - failed - partial - pending);
  const complete = expected > 0 && failed === 0 && partial === 0 && pending === 0;
  const status: CoverageStatus = resultCount > 0
    ? 'FOUND'
    : statuses.includes('PARSE_FAILED')
      ? 'PARSE_FAILED'
      : complete && statuses.length > 0 && statuses.every((item) => item === 'NOT_FOUND_WITH_COMPLETE_COVERAGE')
        ? 'NOT_FOUND_WITH_COMPLETE_COVERAGE'
      : statuses.some((item) => item === 'SOURCE_UNAVAILABLE')
        ? 'SOURCE_UNAVAILABLE'
        : expected === 0
          ? 'NOT_INDEXED'
          : 'PARTIALLY_INDEXED';
  return {
    status,
    scope: 'workspace',
    indexed: index.getStats().files,
    expected,
    successful,
    failed,
    ...(partial > 0 ? { partial } : {}),
    ...(sourceRevision ? { sourceRevision } : {}),
    completenessRatio: expected === 0 ? 0 : successful / expected,
    resultCount,
    diagnostics: [...new Set(results.flatMap((result) => result.coverage.diagnostics))]
  };
}

function factsForEntities(entities: readonly CanonicalEntity[]): ResolvedFact[] {
  return entities.map((entity) => ({
    key: `entity:${entity.identity}`,
    value: entity,
    subject: entity.identity,
    provenance: entity.sourceSymbolUri ?? entity.sourceUri,
    evidenceIds: [entity.sourceSymbolUri ?? entity.identity],
    revision: entity.revision,
    epistemic: entity.epistemic,
    confidence: entity.epistemic === 'observed'
      ? 'high'
      : entity.epistemic === 'derived'
        ? 'medium'
        : 'low'
  }));
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const item of items) {
    const value = key(item);
    if (seen.has(value)) continue;
    seen.add(value);
    output.push(item);
  }
  return output;
}
