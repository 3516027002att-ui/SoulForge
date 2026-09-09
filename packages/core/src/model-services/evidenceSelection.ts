/**
 * Current-snapshot evidence selection and context-window budgeting.
 *
 * This module owns selection only. The raw tool message remains in the rollout;
 * the selected sections are a bounded, disposable dynamic snapshot.
 */

import { utf8CodepointPrefix } from '@soulforge/shared';
import {
  evidenceKey,
  evidenceResourceKey,
  evidenceVersionKey,
  evidenceVersionMatchesCurrent,
  normalizeEvidenceIdentity,
  normalizeEvidenceVersion,
  type EvidenceClaim,
  type EvidenceIdentity,
  type EvidenceIdentityInput,
  type EvidenceRevision,
  type EvidenceVersion
} from './evidenceIdentity.js';

export type { EvidenceClaim, EvidenceIdentity, EvidenceIdentityInput, EvidenceRevision, EvidenceVersion };
export { evidenceKey, evidenceResourceKey, evidenceVersionKey };

export const DEFAULT_ACTIVE_EVIDENCE_CAPACITY = 512;

export interface EvidenceConflict {
  key: string;
  resourceKey: string;
  version: EvidenceVersion;
  authority: number;
  handles: string[];
  message: string;
}

export interface EvidenceSelectionOptions {
  readonly maxBytes: number;
  readonly maxEntries: number;
  /** Preferred name; the map is host-owned and never inferred from text. */
  readonly currentVersionByResource?: ReadonlyMap<string, EvidenceVersion | EvidenceRevision>;
  /** Reference-compatible alias for simple revision maps. */
  readonly currentRevisionByResource?: ReadonlyMap<string, EvidenceVersion | EvidenceRevision>;
  readonly requiredClaimKeys?: ReadonlySet<string> | readonly string[];
  readonly activeGoalRefs?: readonly string[];
  readonly revokedReaderSchemas?: ReadonlySet<string>;
  readonly maxActiveClaims?: number;
}

export interface SelectedEvidenceSection {
  readonly handle: string;
  readonly key: string;
  readonly resourceKey: string;
  readonly identity: EvidenceIdentity;
  readonly revision: EvidenceRevision | null;
  readonly version: EvidenceVersion;
  readonly title?: string;
  readonly text: string;
  readonly required: boolean;
  readonly truncated: boolean;
  readonly missingFields?: readonly string[];
  readonly cursor?: string;
}

export interface EvidenceSelectionResult {
  readonly selected: SelectedEvidenceSection[];
  readonly serialized: string;
  readonly actualBytes: number;
  /** Alias that makes the wire-byte/token distinction explicit to callers. */
  readonly actualWireBytes: number;
  readonly estimatedTokens?: number;
  readonly omitted: number;
  readonly omittedKeys: string[];
  readonly missingRequired: string[];
  readonly conflicts: EvidenceConflict[];
  readonly activeClaims: number;
  readonly capacityOmitted: number;
}

export class EvidenceSelectionError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'EvidenceSelectionError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code: string, message: string, details?: Record<string, unknown>): never {
  throw new EvidenceSelectionError(code, message, details);
}

function integer(value: number, min: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < min) fail('INVALID_INPUT', `${field} 必须是 >= ${min} 的安全整数。`);
}

function authorityRank(candidate: EvidenceClaim): number {
  const declared = typeof candidate.authority === 'number' && Number.isFinite(candidate.authority)
    ? Math.max(0, Math.min(3, Math.trunc(candidate.authority)))
    : undefined;
  if (declared !== undefined) return declared;
  switch (candidate.authorityClass) {
    case 'native':
    case 'native-verified':
      return 3;
    case 'fixture-confirmed':
      return 2;
    case 'candidate':
    case 'discovery':
      return 1;
    default:
      return 0;
  }
}

function sequenceOf(candidate: EvidenceClaim): number {
  const value = candidate.observationSequence ?? candidate.sequence ?? 0;
  return Number.isSafeInteger(value) ? value : 0;
}

function requiredKeys(options: EvidenceSelectionOptions, candidates: readonly EvidenceClaim[]): Set<string> {
  const keys = new Set<string>();
  if (options.requiredClaimKeys) {
    for (const key of options.requiredClaimKeys) keys.add(key);
  }
  for (const candidate of candidates) {
    if (candidate.required === true) keys.add(evidenceKey(candidate.identity));
  }
  return keys;
}

function currentVersionMap(options: EvidenceSelectionOptions): ReadonlyMap<string, EvidenceVersion | EvidenceRevision> | undefined {
  return options.currentVersionByResource ?? options.currentRevisionByResource;
}

function candidateVersion(candidate: EvidenceClaim): EvidenceVersion {
  return normalizeEvidenceVersion(candidate.version);
}

function isCurrentCandidate(
  candidate: EvidenceClaim,
  options: EvidenceSelectionOptions,
  current: ReadonlyMap<string, EvidenceVersion | EvidenceRevision> | undefined
): boolean {
  if (candidate.versionState === 'stale'
    || candidate.versionState === 'revoked'
    || candidate.versionState === 'out-of-scope'
    || (candidate as { revoked?: boolean }).revoked === true) return false;
  const version = candidateVersion(candidate);
  const schema = version.readerSchemaHash;
  if (schema && options.revokedReaderSchemas?.has(schema)) return false;
  if (current) {
    const expected = current.get(evidenceResourceKey(candidate.identity));
    return evidenceVersionMatchesCurrent(version, expected);
  }
  // A host CurrentVersionMap is required for a structured snapshot. An
  // adapter's "current at read time" label is not a substitute: it cannot
  // invalidate an older native claim after a later resource refresh.
  return false;
}

function goalRank(candidate: EvidenceClaim, activeGoals: ReadonlySet<string>): number {
  if (candidate.dependencyRole === 'direct' || candidate.dependencyRole === 'subgoal') return 3;
  if (candidate.dependencyRole === 'same-goal') return 2;
  if (candidate.goalRefs?.some((goal) => activeGoals.has(goal))) return 2;
  if (candidate.dependencyRole === 'background') return 1;
  return 0;
}

function compareCandidates(
  left: EvidenceClaim & { requiredResolved: boolean },
  right: EvidenceClaim & { requiredResolved: boolean },
  activeGoals: ReadonlySet<string>
): number {
  if (left.requiredResolved !== right.requiredResolved) return left.requiredResolved ? -1 : 1;
  const leftGoal = goalRank(left, activeGoals);
  const rightGoal = goalRank(right, activeGoals);
  if (leftGoal !== rightGoal) return rightGoal - leftGoal;
  const leftRelevance = Number.isFinite(left.relevance ?? 0) ? left.relevance ?? 0 : 0;
  const rightRelevance = Number.isFinite(right.relevance ?? 0) ? right.relevance ?? 0 : 0;
  if (leftRelevance !== rightRelevance) return rightRelevance - leftRelevance;
  const leftAuthority = authorityRank(left);
  const rightAuthority = authorityRank(right);
  if (leftAuthority !== rightAuthority) return rightAuthority - leftAuthority;
  const leftSequence = sequenceOf(left);
  const rightSequence = sequenceOf(right);
  if (leftSequence !== rightSequence) return rightSequence - leftSequence;
  return evidenceKey(left.identity) < evidenceKey(right.identity)
    ? -1
    : evidenceKey(left.identity) > evidenceKey(right.identity) ? 1 : 0;
}

function contentFingerprint(candidate: EvidenceClaim): string {
  return JSON.stringify({
    text: candidate.text,
    title: candidate.title ?? null,
    missingFields: candidate.missingFields ?? null,
    cursor: candidate.cursor ?? null
  });
}

function checkConflicts(
  candidates: readonly EvidenceClaim[],
  required: ReadonlySet<string>
): { winners: EvidenceClaim[]; conflicts: EvidenceConflict[]; missingRequired: string[] } {
  const groups = new Map<string, EvidenceClaim[]>();
  for (const candidate of candidates) {
    const key = evidenceKey(candidate.identity);
    const list = groups.get(key) ?? [];
    list.push(candidate);
    groups.set(key, list);
  }
  const winners: EvidenceClaim[] = [];
  const conflicts: EvidenceConflict[] = [];
  for (const [key, group] of groups) {
    const byVersion = new Map<string, EvidenceClaim[]>();
    for (const candidate of group) {
      const versionKey = evidenceVersionKey(candidate.version);
      const list = byVersion.get(versionKey) ?? [];
      list.push(candidate);
      byVersion.set(versionKey, list);
    }
    for (const [versionKey, versionGroup] of byVersion) {
      const bestAuthority = Math.max(...versionGroup.map(authorityRank));
      const best = versionGroup.filter((candidate) => authorityRank(candidate) === bestAuthority);
      const contents = new Map<string, EvidenceClaim[]>();
      for (const candidate of best) {
        const content = contentFingerprint(candidate);
        const list = contents.get(content) ?? [];
        list.push(candidate);
        contents.set(content, list);
      }
      if (contents.size > 1) {
        const identity = best[0]!.identity;
        const conflict: EvidenceConflict = {
          key,
          resourceKey: evidenceResourceKey(identity),
          version: normalizeEvidenceVersion(versionGroup[0]!.version),
          authority: bestAuthority,
          handles: best.map((candidate) => candidate.handle),
          message: '同一 claim、同一当前版本、同一 authority 的内容发生冲突；必须重新读取。'
        };
        conflicts.push(conflict);
        continue;
      }
      const sameContent = best[0]!;
      // Required is resolved at the key level, not copied from the winning
      // record. The later selection stage carries it forward.
      winners.push(sameContent);
      void versionKey;
    }
  }
  const winnerKeys = new Set(winners.map((candidate) => evidenceKey(candidate.identity)));
  const missingRequired = [...required].filter((key) => !winnerKeys.has(key));
  return { winners, conflicts, missingRequired };
}

function sectionFor(
  candidate: EvidenceClaim,
  text: string,
  truncated: boolean,
  required: boolean
): SelectedEvidenceSection {
  const identity = normalizeEvidenceIdentity(candidate.identity);
  const version = normalizeEvidenceVersion(candidate.version);
  const section: SelectedEvidenceSection = {
    handle: candidate.handle,
    key: evidenceKey(identity),
    resourceKey: evidenceResourceKey(identity),
    identity,
    revision: version.revision ?? null,
    version,
    text,
    required,
    truncated,
    ...(candidate.title !== undefined ? { title: candidate.title } : {}),
    ...(candidate.missingFields ? { missingFields: candidate.missingFields } : {}),
    ...(candidate.cursor ? { cursor: candidate.cursor } : {})
  };
  return section;
}

function fits(
  selected: readonly SelectedEvidenceSection[],
  section: SelectedEvidenceSection,
  maxBytes: number
): boolean {
  return Buffer.byteLength(JSON.stringify([...selected, section]), 'utf8') <= maxBytes;
}

function largestOptionalSection(
  selected: readonly SelectedEvidenceSection[],
  candidate: EvidenceClaim,
  required: boolean,
  maxBytes: number
): SelectedEvidenceSection | undefined {
  const full = sectionFor(candidate, candidate.text, false, required);
  if (fits(selected, full, maxBytes)) return full;
  if (required) return undefined;
  const points = [...candidate.text];
  let low = 0;
  let high = points.length;
  let best: SelectedEvidenceSection | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const prefix = utf8CodepointPrefix(candidate.text, Buffer.byteLength(points.slice(0, middle).join(''), 'utf8'));
    const section = sectionFor(candidate, prefix, prefix.length < candidate.text.length, required);
    if (fits(selected, section, maxBytes)) {
      best = section;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function asRequiredSet(value: ReadonlySet<string> | readonly string[] | undefined): Set<string> {
  return value instanceof Set ? new Set(value) : new Set(value ?? []);
}

/**
 * Selects current claims and serializes the final sections under real UTF-8
 * byte and entry limits. `chooseEvidence` is a reference-compatible alias.
 */
export function selectEvidence(
  candidates: readonly EvidenceClaim[],
  options: EvidenceSelectionOptions
): EvidenceSelectionResult {
  integer(options.maxBytes, 2, 'maxBytes');
  integer(options.maxEntries, 1, 'maxEntries');
  const maxActiveClaims = options.maxActiveClaims ?? DEFAULT_ACTIVE_EVIDENCE_CAPACITY;
  integer(maxActiveClaims, 1, 'maxActiveClaims');
  const required = asRequiredSet(options.requiredClaimKeys);
  for (const candidate of candidates) {
    if (candidate.required === true) required.add(evidenceKey(candidate.identity));
  }
  const current = currentVersionMap(options);
  const currentCandidates = candidates.filter((candidate) => isCurrentCandidate(candidate, options, current));
  const deduped = checkConflicts(currentCandidates, required);
  if (deduped.conflicts.length > 0) {
    const first = deduped.conflicts[0]!;
    fail('CONFLICTING_CURRENT_EVIDENCE', first.message, { conflicts: deduped.conflicts });
  }

  const ranked = deduped.winners
    .map((candidate) => ({ ...candidate, requiredResolved: required.has(evidenceKey(candidate.identity)) }))
    .sort((left, right) => compareCandidates(left, right, new Set(options.activeGoalRefs ?? [])));
  const requiredRanked = ranked.filter((candidate) => candidate.requiredResolved);
  const optionalRanked = ranked.filter((candidate) => !candidate.requiredResolved);
  const active = [...requiredRanked, ...optionalRanked.slice(0, Math.max(0, maxActiveClaims - requiredRanked.length))];
  const capacityOmitted = Math.max(0, ranked.length - active.length);
  const selected: SelectedEvidenceSection[] = [];
  const omittedKeys: string[] = [];
  let omitted = capacityOmitted;

  for (const candidate of active) {
    const key = evidenceKey(candidate.identity);
    const requiredCandidate = required.has(key);
    if (selected.length >= options.maxEntries) {
      if (requiredCandidate) {
        fail('REQUIRED_EVIDENCE_EXCEEDS_BUDGET', 'required 证据数量超过 maxEntries，不能静默丢弃前置条件。', {
          key,
          maxEntries: options.maxEntries
        });
      }
      omitted += 1;
      omittedKeys.push(key);
      continue;
    }
    const section = largestOptionalSection(selected, candidate, requiredCandidate, options.maxBytes);
    if (!section) {
      if (requiredCandidate) {
        fail('REQUIRED_EVIDENCE_EXCEEDS_BUDGET', 'required 证据的完整身份、版本和正文超过 JSON UTF-8 字节预算。', {
          key,
          maxBytes: options.maxBytes
        });
      }
      omitted += 1;
      omittedKeys.push(key);
      continue;
    }
    selected.push(section);
  }

  const serialized = JSON.stringify(selected);
  const actualBytes = Buffer.byteLength(serialized, 'utf8');
  if (actualBytes > options.maxBytes) fail('BYTE_BUDGET_INTERNAL', 'Evidence selection exceeded its final UTF-8 budget.');
  const missingRequired = [...new Set(deduped.missingRequired)];
  return {
    selected,
    serialized,
    actualBytes,
    actualWireBytes: actualBytes,
    omitted,
    omittedKeys,
    missingRequired,
    conflicts: [],
    activeClaims: active.length,
    capacityOmitted
  };
}

export const chooseEvidence = selectEvidence;

/** Reference-compatible name for the code-point-safe UTF-8 prefix helper. */
export const utf8Prefix = utf8CodepointPrefix;

export interface LegacyEvidenceCandidate {
  readonly identity: EvidenceIdentityInput;
  readonly handle: string;
  readonly revision?: EvidenceRevision;
  readonly version?: EvidenceVersion;
  readonly text: string;
  readonly relevance?: number;
  readonly authority?: number;
  readonly sequence?: number;
  readonly required?: boolean;
  readonly title?: string;
}

export type LegacyEvidenceSelectionOptions = EvidenceSelectionOptions & {
  readonly candidates: readonly LegacyEvidenceCandidate[];
};

export type LegacyEvidenceSelectionResult =
  | ({ ok: true } & EvidenceSelectionResult)
  | { ok: false; code: string; message: string };

/** Adapter for the original object-shaped SF-19 reference harness. */
export function selectEvidenceCandidates(
  options: LegacyEvidenceSelectionOptions
): LegacyEvidenceSelectionResult {
  try {
    const candidates: EvidenceClaim[] = options.candidates.map((candidate) => {
      const identity = normalizeEvidenceIdentity(candidate.identity);
      const version = normalizeEvidenceVersion(candidate.version ?? candidate.revision);
      return {
        identity,
        key: evidenceKey(identity),
        resourceKey: evidenceResourceKey(identity),
        handle: candidate.handle,
        text: candidate.text,
        version,
        ...(candidate.revision !== undefined ? { sequence: candidate.sequence ?? 0 } : {}),
        ...(candidate.relevance !== undefined ? { relevance: candidate.relevance } : {}),
        ...(candidate.authority !== undefined ? { authority: candidate.authority } : {}),
        ...(candidate.sequence !== undefined ? { observationSequence: candidate.sequence } : {}),
        ...(candidate.required !== undefined ? { required: candidate.required } : {}),
        ...(candidate.title !== undefined ? { title: candidate.title } : {})
      };
    });
    const { candidates: _ignored, ...selectionOptions } = options;
    void _ignored;
    return { ok: true, ...selectEvidence(candidates, selectionOptions) };
  } catch (error) {
    if (error instanceof EvidenceSelectionError) {
      return { ok: false, code: error.code, message: error.message };
    }
    throw error;
  }
}

export interface EvidenceCandidateMergeResult {
  readonly candidates: EvidenceClaim[];
  readonly changed: boolean;
  readonly omitted: number;
}

/** Exact repeats do not grow the active queue; newer observations refresh sequence in place. */
export function mergeEvidenceCandidates(
  existing: readonly EvidenceClaim[],
  additions: readonly EvidenceClaim[],
  options: { maxActiveClaims?: number; requiredClaimKeys?: ReadonlySet<string> | readonly string[] } = {}
): EvidenceCandidateMergeResult {
  const byIdentity = new Map<string, EvidenceClaim>();
  let changed = false;
  const upsert = (candidate: EvidenceClaim): void => {
    const key = `${evidenceKey(candidate.identity)}\u0000${evidenceVersionKey(candidate.version)}\u0000${authorityRank(candidate)}\u0000${contentFingerprint(candidate)}`;
    const previous = byIdentity.get(key);
    if (!previous || sequenceOf(candidate) > sequenceOf(previous)) {
      byIdentity.set(key, candidate);
      if (!previous || sequenceOf(candidate) !== sequenceOf(previous)) changed = true;
    }
  };
  for (const candidate of existing) upsert(candidate);
  for (const candidate of additions) upsert(candidate);
  const required = asRequiredSet(options.requiredClaimKeys);
  for (const candidate of [...byIdentity.values()]) {
    if (candidate.required === true) required.add(evidenceKey(candidate.identity));
  }
  const all = [...byIdentity.values()].sort((left, right) => compareCandidates(
    { ...left, requiredResolved: required.has(evidenceKey(left.identity)) },
    { ...right, requiredResolved: required.has(evidenceKey(right.identity)) },
    new Set()
  ));
  const max = options.maxActiveClaims ?? DEFAULT_ACTIVE_EVIDENCE_CAPACITY;
  const requiredItems = all.filter((candidate) => required.has(evidenceKey(candidate.identity)));
  const optionalItems = all.filter((candidate) => !required.has(evidenceKey(candidate.identity)));
  const kept = [...requiredItems, ...optionalItems.slice(0, Math.max(0, max - requiredItems.length))];
  const omitted = Math.max(0, all.length - kept.length);
  if (omitted > 0 || kept.length !== existing.length) changed = true;
  return { candidates: kept, changed, omitted };
}
