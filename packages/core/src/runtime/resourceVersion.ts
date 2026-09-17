/**
 * Canonical resource identity, version comparison and dependency summaries
 * (执行指令 §4.1/§4.2, T02).
 *
 * This module never parses game binaries. It stores what a reader observed:
 * outer container hash, child payload hash, reader/metadata schema versions
 * and a host-maintained generation. mtime/size are cheap pre-filters only and
 * never prove content immutability.
 */

export interface ResourceVersion {
  /** SHA-256 of the outer container file on disk (CAS + shared-container invalidation). */
  outerFileHash: string;
  /** SHA-256 of the unpacked child payload / inner document (per-document write precondition). */
  payloadHash?: string;
  /** SHA-256 of one physical row's bytes (physical row precondition; never replaces outer version). */
  rowHash?: string;
  /** Monotonic revision supplied by the repository/workspace index. */
  sourceRevision?: number;
  /** Schema version of the parser/reader (EMEDF fingerprint, paramdef version, …). */
  readerSchemaVersion?: string | number;
  /** Schema / fingerprint of the external metadata package. */
  metadataSchemaVersion?: string | number;
  /** Host-maintained counter identifying this session's observation of the source. */
  generation: number;
  /** Stat mtime in milliseconds (cheap pre-filter only). */
  mtimeMs?: number;
  /** Stat size in bytes (cheap pre-filter only). */
  sizeBytes?: number;
}

/**
 * Physical identity that never loses child addressing. Display labels, query
 * terms and filename tails must never enter these keys.
 */
export interface ResourceIdentity {
  workspaceId: string;
  sourceUri: string;
  domain: string;
  childChain?: readonly string[];
  entryIndex?: number;
  entryName?: string;
  rowId?: number;
  rowIndex?: number;
  eventId?: number;
  textId?: number;
  animId?: number;
  eventIndex?: number;
  taeEntryIndex?: number;
  nativeObjectKey?: string;
}

export type VersionComparisonResult = 'equal' | 'stale' | 'newer' | 'unknown';

const IDENTITY_FIELD_ORDER = [
  'workspaceId', 'domain', 'sourceUri', 'childChain', 'entryIndex', 'entryName',
  'rowId', 'rowIndex', 'eventId', 'textId', 'animId', 'eventIndex', 'taeEntryIndex', 'nativeObjectKey'
] as const satisfies readonly (keyof ResourceIdentity)[];

/**
 * Stable key for one object that preserves child identity.
 * Two rows with the same logical rowId but different physical rowIndex, two
 * entries with the same name but different entryIndex, the same eventId in
 * different files, and the same relative path in different workspaces all get
 * different keys.
 */
export function computeResourceKey(identity: ResourceIdentity): string {
  const parts: string[] = [];
  for (const field of IDENTITY_FIELD_ORDER) {
    const value = identity[field];
    if (value === undefined) continue;
    if (field === 'childChain') {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
        throw new Error('INVALID_IDENTITY_FIELD: childChain must be an array of non-empty strings');
      }
      parts.push(`${field}=${JSON.stringify(value)}`);
      continue;
    }
    if (typeof value === 'number' && !Number.isSafeInteger(value)) {
      throw new Error(`INVALID_IDENTITY_FIELD: ${field} must be a safe integer`);
    }
    if (typeof value === 'string' && value.trim().length === 0) {
      throw new Error(`INVALID_IDENTITY_FIELD: ${field} must be a non-empty string`);
    }
    parts.push(`${field}=${String(value)}`);
  }
  return parts.join('|');
}

/**
 * Compare a reference version against the current observed version.
 *
 * - Missing either side, or a missing outerFileHash on either side, returns
 *   `unknown` — absent information never means `equal`.
 * - Different outer hash, payload hash, row hash, reader schema or metadata
 *   schema means the reference no longer describes what is live: `stale`.
 * - Same bytes but a host generation change (H0→H1→H0) is still `stale`:
 *   accidental byte equality must not resurrect old proofs.
 * - A reference observed with a strictly higher generation than the current
 *   record returns `newer` (a late async result must not overwrite the live
 *   projection).
 */
export function compareResourceVersion(
  current?: ResourceVersion | null,
  reference?: ResourceVersion | null
): VersionComparisonResult {
  if (!current || !reference) return 'unknown';
  if (typeof current.outerFileHash !== 'string' || current.outerFileHash.length === 0) return 'unknown';
  if (typeof reference.outerFileHash !== 'string' || reference.outerFileHash.length === 0) return 'unknown';

  if (current.outerFileHash !== reference.outerFileHash) return 'stale';
  if (reference.payloadHash !== undefined && current.payloadHash !== undefined
    && current.payloadHash !== reference.payloadHash) return 'stale';
  if (reference.rowHash !== undefined && current.rowHash !== undefined
    && current.rowHash !== reference.rowHash) return 'stale';
  if (reference.readerSchemaVersion !== undefined && current.readerSchemaVersion !== undefined
    && current.readerSchemaVersion !== reference.readerSchemaVersion) return 'stale';
  if (reference.metadataSchemaVersion !== undefined && current.metadataSchemaVersion !== undefined
    && current.metadataSchemaVersion !== reference.metadataSchemaVersion) return 'stale';

  if (typeof current.generation !== 'number' || !Number.isFinite(current.generation)) return 'unknown';
  if (typeof reference.generation !== 'number' || !Number.isFinite(reference.generation)) return 'unknown';
  if (reference.generation > current.generation) return 'newer';
  if (reference.generation < current.generation) return 'stale';
  return 'equal';
}

export interface DependencySummaryEntry {
  /** computeResourceKey() of the depended-on object. */
  sourceKey: string;
  outerFileHash?: string;
  payloadHash?: string;
  sourceRevision?: number;
  readerSchemaVersion?: string | number;
  metadataSchemaVersion?: string | number;
  generation?: number;
}

export interface DependencySummary {
  catalogGeneration: number;
  readerSchemaVersion?: string | number;
  metadataSchemaVersion?: string | number;
  entries: DependencySummaryEntry[];
}

/**
 * Deterministic dependency summary for snapshot identity.
 * Entries are sorted by source key; the summary identifies a snapshot but
 * never replaces per-source evidence.
 */
export function computeDependencySummary(
  entries: readonly DependencySummaryEntry[],
  options: { catalogGeneration: number; readerSchemaVersion?: string | number; metadataSchemaVersion?: string | number }
): DependencySummary {
  const sorted = [...entries].sort((a, b) => (a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0));
  return {
    catalogGeneration: options.catalogGeneration,
    ...(options.readerSchemaVersion !== undefined ? { readerSchemaVersion: options.readerSchemaVersion } : {}),
    ...(options.metadataSchemaVersion !== undefined ? { metadataSchemaVersion: options.metadataSchemaVersion } : {}),
    entries: sorted
  };
}

/**
 * True when two summaries describe the same snapshot. Used to reject page
 * cursors whose underlying sources drifted.
 */
export function dependencySummariesMatch(a: DependencySummary | undefined, b: DependencySummary | undefined): boolean {
  if (!a || !b) return false;
  if (a.catalogGeneration !== b.catalogGeneration) return false;
  if (a.readerSchemaVersion !== b.readerSchemaVersion) return false;
  if (a.metadataSchemaVersion !== b.metadataSchemaVersion) return false;
  if (a.entries.length !== b.entries.length) return false;
  for (let i = 0; i < a.entries.length; i += 1) {
    const left = a.entries[i]!;
    const right = b.entries[i]!;
    if (left.sourceKey !== right.sourceKey) return false;
    if (left.outerFileHash !== right.outerFileHash) return false;
    if (left.payloadHash !== right.payloadHash) return false;
    if (left.sourceRevision !== right.sourceRevision) return false;
    if (left.generation !== right.generation) return false;
  }
  return true;
}

