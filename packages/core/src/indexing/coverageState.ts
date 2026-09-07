import type { IndexedFile, ParseStatus, ResourceKind } from '@soulforge/shared';

/**
 * Coverage is deliberately more precise than a boolean.  A search result is
 * only useful for a negative conclusion when both the source set and the
 * predicate are exhaustive.
 */
export const COVERAGE_STATUSES = [
  'complete',
  'partial',
  'not_indexed',
  'parse_failed',
  'stale',
  'source_unavailable'
] as const;

export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

/** A human-readable scope, kept open so a future resource family need not edit this union. */
export type CoverageScope = string;

export type PredicateKind =
  | 'exact_handle'
  | 'exact_id'
  | 'exact_field'
  | 'complete_range'
  | 'fuzzy_name'
  | 'semantic'
  | 'relationship'
  | 'unknown';

export type PredicateCompletenessStatus = 'complete' | 'partial' | 'not_applicable' | 'unknown';

export interface PredicateCompleteness {
  kind: PredicateKind;
  status: PredicateCompletenessStatus;
  /** True only when this predicate can enumerate the entire scoped set. */
  exhaustive: boolean;
  predicate: string;
  reason: string;
  missingFields?: string[];
}

export interface CoverageSourceVersion {
  sourceUri: string;
  sourceHash?: string;
  sourceRevision?: number | string;
  readerSchemaVersion?: number | string;
  metadataSchemaVersion?: string;
}

export interface CoverageState {
  status: CoverageStatus;
  scope: CoverageScope;
  domain?: string;
  coveredResources: number;
  expectedResources: number | null;
  /** Stable source IDs make a bounded result auditable without exposing bytes. */
  coveredResourceIds: string[];
  expectedResourceIds: string[] | null;
  sourceVersions: CoverageSourceVersion[];
  predicateCompleteness: PredicateCompleteness;
  staleSources: string[];
  diagnostics: string[];
}

/** Compatibility alias used by callers that call a coverage row a record. */
export type CoverageRecord = CoverageState;

export interface CoverageStateInput {
  status?: CoverageStatus;
  scope: CoverageScope;
  domain?: string;
  coveredResources?: number;
  expectedResources?: number | null;
  coveredResourceIds?: readonly string[];
  expectedResourceIds?: readonly string[] | null;
  sourceVersions?: readonly CoverageSourceVersion[];
  predicateCompleteness?: Partial<PredicateCompleteness> & Pick<PredicateCompleteness, 'kind' | 'predicate'>;
  staleSources?: readonly string[];
  diagnostics?: readonly string[];
}

export interface CoverageDerivationInput {
  scope: CoverageScope;
  domain?: string;
  files: readonly Pick<IndexedFile, 'sourceUri' | 'parseStatus' | 'sha256' | 'mtimeMs'>[];
  /** Source URIs for which the requested semantic projection was actually produced. */
  coveredResourceIds?: readonly string[];
  /** Omit when the host cannot know the size of the source set. */
  expectedResourceIds?: readonly string[] | null;
  sourceVersions?: readonly CoverageSourceVersion[];
  staleSources?: readonly string[];
  sourceUnavailable?: boolean;
  predicate?: Partial<PredicateCompleteness> & Pick<PredicateCompleteness, 'kind' | 'predicate'>;
  diagnostics?: readonly string[];
}

export const EXHAUSTIVE_PREDICATE_KINDS: readonly PredicateKind[] = [
  'exact_handle',
  'exact_id',
  'exact_field',
  'complete_range'
] as const;

export function createCoverageState(input: CoverageStateInput): CoverageState {
  const coveredResourceIds = uniqueStrings(input.coveredResourceIds ?? []);
  const expectedResourceIds = input.expectedResourceIds === undefined
    ? null
    : input.expectedResourceIds === null
      ? null
      : uniqueStrings(input.expectedResourceIds);
  const expectedResources = input.expectedResources === undefined
    ? expectedResourceIds?.length ?? null
    : input.expectedResources;
  const predicate = normalizePredicate(input.predicateCompleteness, input.status ?? 'not_indexed');
  return {
    status: input.status ?? 'not_indexed',
    scope: input.scope,
    ...(input.domain ? { domain: input.domain } : {}),
    coveredResources: input.coveredResources ?? coveredResourceIds.length,
    expectedResources,
    coveredResourceIds,
    expectedResourceIds,
    sourceVersions: normalizeSourceVersions(input.sourceVersions ?? []),
    predicateCompleteness: predicate,
    staleSources: uniqueStrings(input.staleSources ?? []),
    diagnostics: uniqueStrings(input.diagnostics ?? [])
  };
}

/**
 * Derive a source-level coverage certificate from the file catalog and the
 * semantic projection that was actually published.
 */
export function deriveCoverageState(input: CoverageDerivationInput): CoverageState {
  const files = [...input.files];
  const expectedIds = input.expectedResourceIds === undefined
    ? uniqueStrings(files.map((file) => file.sourceUri))
    : input.expectedResourceIds === null
      ? null
      : uniqueStrings(input.expectedResourceIds);
  const coveredIds = uniqueStrings(input.coveredResourceIds ?? []);
  const staleSources = uniqueStrings(input.staleSources ?? []);
  const expected = expectedIds?.length ?? null;
  const covered = coveredIds.length;
  const parseStatuses = files.map((file) => file.parseStatus);
  const status = deriveStatus({
    files,
    expected,
    covered,
    staleSources,
    sourceUnavailable: input.sourceUnavailable === true
  });
  const predicate = normalizePredicate(input.predicate, status);
  const sourceVersions = input.sourceVersions && input.sourceVersions.length > 0
    ? normalizeSourceVersions(input.sourceVersions)
    : files.map((file) => ({
        sourceUri: file.sourceUri,
        ...(file.sha256 ? { sourceHash: file.sha256 } : {}),
        sourceRevision: file.mtimeMs
      }));
  const diagnostics = [
    ...(input.diagnostics ?? []),
    ...(parseStatuses.includes('failed' as ParseStatus) ? ['one or more sources failed to parse'] : []),
    ...(staleSources.length > 0 ? [`stale sources: ${staleSources.join(', ')}`] : [])
  ];
  return createCoverageState({
    status,
    scope: input.scope,
    ...(input.domain ? { domain: input.domain } : {}),
    coveredResources: covered,
    expectedResources: expected,
    coveredResourceIds: coveredIds,
    expectedResourceIds: expectedIds,
    sourceVersions,
    predicateCompleteness: predicate,
    staleSources,
    diagnostics
  });
}

export class CoverageStateStore {
  private readonly states = new Map<string, CoverageState>();

  set(state: CoverageState): void {
    this.states.set(coverageKey(state.scope, state.domain), cloneCoverageState(state));
  }

  get(scope = 'workspace', domain?: string): CoverageState | undefined {
    const value = this.states.get(coverageKey(scope, domain));
    return value ? cloneCoverageState(value) : undefined;
  }

  list(): CoverageState[] {
    return [...this.states.values()].map(cloneCoverageState);
  }

  clear(): void {
    this.states.clear();
  }

  /** Mark every state that includes a changed source as stale. */
  markStale(sourceUris: readonly string[], reason = 'source revision changed'): CoverageState[] {
    const changed = new Set(uniqueStrings(sourceUris));
    const changedStates: CoverageState[] = [];
    for (const [key, state] of this.states) {
      const matched = state.sourceVersions.some((version) => changed.has(version.sourceUri))
        || state.coveredResourceIds.some((sourceUri) => changed.has(sourceUri));
      if (!matched) continue;
      const next = createCoverageState({
        ...state,
        status: 'stale',
        predicateCompleteness: {
          ...state.predicateCompleteness,
          status: 'partial',
          exhaustive: false,
          reason: `${state.predicateCompleteness.reason}; ${reason}`
        },
        staleSources: [...state.staleSources, ...sourceUris],
        diagnostics: [...state.diagnostics, reason]
      });
      this.states.set(key, next);
      changedStates.push(cloneCoverageState(next));
    }
    return changedStates;
  }
}

export function coverageKey(scope: CoverageScope, domain?: string): string {
  return `${scope}\u0000${domain ?? '*'}`;
}

export function isCompleteCoverage(state: CoverageState | undefined): boolean {
  return state?.status === 'complete';
}

/**
 * This is the only gate that may produce NOT_FOUND_WITH_COMPLETE_COVERAGE.
 * Fuzzy/semantic retrieval is never exhaustive, even over a complete corpus.
 */
export function canConcludeNotFound(
  state: CoverageState | undefined,
  predicate: PredicateCompleteness | undefined = state?.predicateCompleteness
): boolean {
  return state?.status === 'complete'
    && predicate?.status === 'complete'
    && predicate.exhaustive
    && EXHAUSTIVE_PREDICATE_KINDS.includes(predicate.kind);
}

export function coverageForPredicate(state: CoverageState | undefined, kindOrPredicate: PredicateKind | string): boolean {
  if (!state || state.status !== 'complete') return false;
  return (state.predicateCompleteness.kind === kindOrPredicate || state.predicateCompleteness.predicate === kindOrPredicate)
    && state.predicateCompleteness.status === 'complete';
}

export function notFoundCode(
  state: CoverageState | undefined,
  predicate: PredicateCompleteness | undefined = state?.predicateCompleteness
): 'NOT_FOUND_WITH_COMPLETE_COVERAGE' | 'NOT_FOUND_INCOMPLETE_COVERAGE' | 'FUZZY_QUERY_NO_MATCH' {
  if (canConcludeNotFound(state, predicate)) return 'NOT_FOUND_WITH_COMPLETE_COVERAGE';
  if (predicate?.kind === 'fuzzy_name' || predicate?.kind === 'semantic') return 'FUZZY_QUERY_NO_MATCH';
  return 'NOT_FOUND_INCOMPLETE_COVERAGE';
}

function deriveStatus(input: {
  files: readonly Pick<IndexedFile, 'parseStatus'>[];
  expected: number | null;
  covered: number;
  staleSources: readonly string[];
  sourceUnavailable: boolean;
}): CoverageStatus {
  if (input.sourceUnavailable) return 'source_unavailable';
  if (input.staleSources.length > 0) return 'stale';
  if (input.files.length === 0 && input.covered === 0) return 'not_indexed';
  if (input.files.some((file) => file.parseStatus === 'failed')) return 'parse_failed';
  if (input.files.some((file) => file.parseStatus === 'unsupported')) return 'parse_failed';
  if (input.files.some((file) => file.parseStatus === 'unparsed')) {
    return input.covered > 0 ? 'partial' : 'not_indexed';
  }
  if (input.files.some((file) => file.parseStatus === 'partial')) return 'partial';
  if (input.expected !== null && input.covered < input.expected) return 'partial';
  return 'complete';
}

function normalizePredicate(
  predicate: CoverageDerivationInput['predicate'] | CoverageStateInput['predicateCompleteness'],
  status: CoverageStatus
): PredicateCompleteness {
  const kind = predicate?.kind ?? 'unknown';
  const exhaustive = predicate?.exhaustive ?? EXHAUSTIVE_PREDICATE_KINDS.includes(kind);
  const predicateStatus = predicate?.status
    ?? (exhaustive && status === 'complete' ? 'complete' : status === 'complete' ? 'not_applicable' : 'partial');
  return {
    kind,
    status: predicateStatus,
    exhaustive,
    predicate: predicate?.predicate ?? 'unknown',
    reason: predicate?.reason
      ?? (exhaustive
        ? status === 'complete' ? 'deterministic predicate is complete' : 'source coverage is not complete'
        : 'retrieval predicate is not exhaustive'),
    ...(predicate?.missingFields && predicate.missingFields.length > 0
      ? { missingFields: uniqueStrings(predicate.missingFields) }
      : {})
  };
}

function normalizeSourceVersions(values: readonly CoverageSourceVersion[]): CoverageSourceVersion[] {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    if (!value.sourceUri || seen.has(value.sourceUri)) return [];
    seen.add(value.sourceUri);
    return [{
      sourceUri: value.sourceUri,
      ...(value.sourceHash ? { sourceHash: value.sourceHash } : {}),
      ...(value.sourceRevision !== undefined ? { sourceRevision: value.sourceRevision } : {}),
      ...(value.readerSchemaVersion !== undefined ? { readerSchemaVersion: value.readerSchemaVersion } : {}),
      ...(value.metadataSchemaVersion ? { metadataSchemaVersion: value.metadataSchemaVersion } : {})
    }];
  });
}

function cloneCoverageState(state: CoverageState): CoverageState {
  return {
    ...state,
    coveredResourceIds: [...state.coveredResourceIds],
    expectedResourceIds: state.expectedResourceIds ? [...state.expectedResourceIds] : null,
    sourceVersions: state.sourceVersions.map((version) => ({ ...version })),
    predicateCompleteness: {
      ...state.predicateCompleteness,
      ...(state.predicateCompleteness.missingFields
        ? { missingFields: [...state.predicateCompleteness.missingFields] }
        : {})
    },
    staleSources: [...state.staleSources],
    diagnostics: [...state.diagnostics]
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim().length > 0))];
}
