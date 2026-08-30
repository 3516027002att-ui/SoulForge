/**
 * Platform-independent Binder membership resolution.
 *
 * This module deliberately knows nothing about BND4/DCX parsing or the
 * filesystem.  Callers provide already-read entry identities together with
 * their source provenance, and this module only performs the identity match.
 * Therefore a UNIQUE result is a deterministic projection, not native
 * verification of the container or its semantics.
 */

export type BinderSourceRevision = string | number | null;

export interface BinderSourceIdentity {
  /** Stable source identity supplied by the caller; never reconstructed here. */
  sourceUri: string;
  /** Optional physical/source path retained for later diagnostics and IPC. */
  sourcePath?: string;
  /** Optional content identity retained without interpretation. */
  sourceHash?: string;
  /** Caller-owned revision token; may be a scan revision or a content revision. */
  sourceRevision?: BinderSourceRevision;
  /** Optional layer metadata, for example an overlay/base source. */
  sourceLayer?: 'overlay' | 'base';
}

export interface BinderEntryIdentity {
  /** Exact native Binder entry id. It is never matched by name or array order. */
  entryId: number;
  /** Optional native entry index, retained as metadata only. */
  entryIndex?: number;
  /** Optional entry name, retained as metadata only. */
  entryName?: string;
}

export interface BinderMembershipCandidate {
  /** Canonical character-family key supplied by the caller. Comparison is exact. */
  characterFamily: string;
  source: BinderSourceIdentity;
  entries: readonly BinderEntryIdentity[];
}

export interface BinderMembershipQuery {
  /** Canonical character-family key; candidates from other families are ignored. */
  characterFamily: string;
  /** Exact Binder entry id to resolve. */
  binderEntryId: number;
}

export interface BinderMembershipMatch extends BinderSourceIdentity {
  characterFamily: string;
  binderEntryId: number;
  entryIndex?: number;
  entryName?: string;
}

export interface BinderMembershipSource {
  characterFamily: string;
  source: BinderSourceIdentity;
}

export interface BinderMembershipDiagnostic {
  code: 'BINDER_QUERY_INVALID' | 'BINDER_CANDIDATE_INVALID' | 'BINDER_ENTRY_INVALID';
  message: string;
  sourceUri?: string;
}

interface BinderMembershipResultBase {
  query: BinderMembershipQuery;
  /** Only same-family candidates are reported; cross-family sources do not leak. */
  consideredSources: readonly BinderMembershipSource[];
  diagnostics: readonly BinderMembershipDiagnostic[];
}

export type BinderMembershipResult =
  | (BinderMembershipResultBase & {
    status: 'UNIQUE';
    match: BinderMembershipMatch;
  })
  | (BinderMembershipResultBase & {
    status: 'NOT_FOUND';
    match: undefined;
  })
  | (BinderMembershipResultBase & {
    status: 'AMBIGUOUS';
    match: undefined;
    matches: readonly BinderMembershipMatch[];
  });

/**
 * Resolve one exact Binder entry id within one character family.
 *
 * A result is UNIQUE only when exactly one valid entry match exists across all
 * same-family candidates. Zero matches is NOT_FOUND. Every other cardinality
 * is AMBIGUOUS. Input order is never used to choose a winner.
 */
export function resolveBinderMembership(input: {
  query: BinderMembershipQuery;
  candidates: readonly BinderMembershipCandidate[];
}): BinderMembershipResult {
  const diagnostics: BinderMembershipDiagnostic[] = [];
  const query = input.query;

  if (!isValidCharacterFamily(query.characterFamily) || !isSafeInteger(query.binderEntryId)) {
    diagnostics.push({
      code: 'BINDER_QUERY_INVALID',
      message: 'Binder membership query requires a non-empty character family and a safe integer entry id.'
    });
    return {
      status: 'NOT_FOUND',
      query,
      match: undefined,
      consideredSources: [],
      diagnostics
    };
  }

  const sameFamilyCandidates = input.candidates.filter((candidate) => {
    if (!isValidCandidate(candidate)) {
      diagnostics.push({
        code: 'BINDER_CANDIDATE_INVALID',
        message: 'Binder candidate has an empty character family or source URI and was ignored.',
        ...(typeof candidate?.source?.sourceUri === 'string' ? { sourceUri: candidate.source.sourceUri } : {})
      });
      return false;
    }
    return candidate.characterFamily === query.characterFamily;
  });

  const consideredSources = sortSources(sameFamilyCandidates.map(({ characterFamily, source }) => ({
    characterFamily,
    source: copySourceIdentity(source)
  })));

  const matches: BinderMembershipMatch[] = [];
  for (const candidate of sameFamilyCandidates) {
    for (const entry of candidate.entries) {
      if (!isValidEntry(entry)) {
        diagnostics.push({
          code: 'BINDER_ENTRY_INVALID',
          message: 'Binder entry id is not a safe integer and was ignored.',
          sourceUri: candidate.source.sourceUri
        });
        continue;
      }
      if (entry.entryId !== query.binderEntryId) continue;
      matches.push({
        ...copySourceIdentity(candidate.source),
        characterFamily: candidate.characterFamily,
        binderEntryId: entry.entryId,
        ...(entry.entryIndex !== undefined ? { entryIndex: entry.entryIndex } : {}),
        ...(entry.entryName !== undefined ? { entryName: entry.entryName } : {})
      });
    }
  }

  const sortedMatches = sortMatches(matches);
  if (sortedMatches.length === 1) {
    const match = sortedMatches[0];
    if (!match) {
      return {
        status: 'NOT_FOUND',
        query,
        match: undefined,
        consideredSources,
        diagnostics
      };
    }
    return {
      status: 'UNIQUE',
      query,
      match,
      consideredSources,
      diagnostics
    };
  }
  if (sortedMatches.length === 0) {
    return {
      status: 'NOT_FOUND',
      query,
      match: undefined,
      consideredSources,
      diagnostics
    };
  }
  return {
    status: 'AMBIGUOUS',
    query,
    match: undefined,
    matches: sortedMatches,
    consideredSources,
    diagnostics
  };
}

function isValidCharacterFamily(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidCandidate(value: BinderMembershipCandidate): boolean {
  return Boolean(value)
    && isValidCharacterFamily(value.characterFamily)
    && isValidSource(value.source)
    && Array.isArray(value.entries);
}

function isValidSource(value: BinderSourceIdentity | undefined): value is BinderSourceIdentity {
  if (!value) return false;
  return typeof value.sourceUri === 'string' && value.sourceUri.trim().length > 0;
}

function isValidEntry(value: BinderEntryIdentity): boolean {
  return Boolean(value) && isSafeInteger(value.entryId);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function copySourceIdentity(source: BinderSourceIdentity): BinderSourceIdentity {
  return {
    sourceUri: source.sourceUri,
    ...(source.sourcePath !== undefined ? { sourcePath: source.sourcePath } : {}),
    ...(source.sourceHash !== undefined ? { sourceHash: source.sourceHash } : {}),
    ...(source.sourceRevision !== undefined ? { sourceRevision: source.sourceRevision } : {}),
    ...(source.sourceLayer !== undefined ? { sourceLayer: source.sourceLayer } : {})
  };
}

function sortSources(sources: BinderMembershipSource[]): BinderMembershipSource[] {
  return sources.sort((left, right) => compareStrings(left.source.sourceUri, right.source.sourceUri)
    || compareStrings(left.source.sourcePath ?? '', right.source.sourcePath ?? '')
    || compareStrings(String(left.source.sourceRevision ?? ''), String(right.source.sourceRevision ?? ''))
    || compareStrings(left.characterFamily, right.characterFamily));
}

function sortMatches(matches: BinderMembershipMatch[]): BinderMembershipMatch[] {
  return matches.sort((left, right) => compareStrings(left.sourceUri, right.sourceUri)
    || compareStrings(left.sourcePath ?? '', right.sourcePath ?? '')
    || compareStrings(String(left.sourceRevision ?? ''), String(right.sourceRevision ?? ''))
    || (left.entryIndex ?? Number.MAX_SAFE_INTEGER) - (right.entryIndex ?? Number.MAX_SAFE_INTEGER)
    || (left.binderEntryId - right.binderEntryId));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
