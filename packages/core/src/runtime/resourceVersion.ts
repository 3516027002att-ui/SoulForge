/**
 * Canonical resource version identity for host caches, proofs and CAS.
 *
 * Outer file hash, child/payload hash and row data hash are separate fields.
 * mtime/size are cheap filters only and never prove content freshness.
 */
import { createHash } from 'node:crypto';

export interface ResourceVersion {
  /** Full hash of the outer physical file (BND/DCX/parambnd/...). */
  outerFileHash: string;
  /** Hash of the actually-read child/payload (param child, emevd body, script bytes). */
  childHash?: string;
  /** Physical row hash when the version refers to a PARAM row. */
  dataHash?: string;
  sourceRevision?: number | string;
  readerSchema?: string;
  metadataSchema?: string;
  /** Host-monotonic observation generation; not file mtime. */
  generation: number;
  /** Cheap filter fields; never authoritative alone. */
  mtimeMs?: number;
  size?: number;
}

export type ResourceVersionCompare =
  | { kind: 'equal' }
  | { kind: 'different'; reason: string }
  | { kind: 'unknown'; reason: string };

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isFullSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

export function createResourceVersion(input: {
  outerFileHash: string;
  childHash?: string;
  dataHash?: string;
  sourceRevision?: number | string;
  readerSchema?: string;
  metadataSchema?: string;
  generation: number;
  mtimeMs?: number;
  size?: number;
}): ResourceVersion {
  if (!isFullSha256(input.outerFileHash)) {
    throw new Error('RESOURCE_VERSION_HASH_INVALID: outerFileHash must be a full sha256 hex digest');
  }
  if (input.childHash !== undefined && !isFullSha256(input.childHash)) {
    throw new Error('RESOURCE_VERSION_HASH_INVALID: childHash must be a full sha256 hex digest');
  }
  if (input.dataHash !== undefined && !isFullSha256(input.dataHash)) {
    throw new Error('RESOURCE_VERSION_HASH_INVALID: dataHash must be a full sha256 hex digest');
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
    throw new Error('RESOURCE_VERSION_GENERATION_INVALID');
  }
  return {
    outerFileHash: input.outerFileHash.toLowerCase(),
    ...(input.childHash ? { childHash: input.childHash.toLowerCase() } : {}),
    ...(input.dataHash ? { dataHash: input.dataHash.toLowerCase() } : {}),
    ...(input.sourceRevision !== undefined ? { sourceRevision: input.sourceRevision } : {}),
    ...(input.readerSchema ? { readerSchema: input.readerSchema } : {}),
    ...(input.metadataSchema ? { metadataSchema: input.metadataSchema } : {}),
    generation: input.generation,
    ...(input.mtimeMs !== undefined ? { mtimeMs: input.mtimeMs } : {}),
    ...(input.size !== undefined ? { size: input.size } : {})
  };
}

/**
 * Compare versions by field semantics.
 * Missing authoritative hashes return unknown — never equal.
 */
export function compareResourceVersion(a: ResourceVersion | undefined, b: ResourceVersion | undefined): ResourceVersionCompare {
  if (!a || !b) return { kind: 'unknown', reason: 'version_missing' };
  if (!isFullSha256(a.outerFileHash) || !isFullSha256(b.outerFileHash)) {
    return { kind: 'unknown', reason: 'outer_hash_missing_or_invalid' };
  }
  if (a.outerFileHash.toLowerCase() !== b.outerFileHash.toLowerCase()) {
    return { kind: 'different', reason: 'outer_file_hash' };
  }

  const aChild = a.childHash;
  const bChild = b.childHash;
  if (aChild !== undefined && bChild !== undefined) {
    if (!isFullSha256(aChild) || !isFullSha256(bChild)) {
      return { kind: 'unknown', reason: 'child_hash_invalid' };
    }
    if (aChild.toLowerCase() !== bChild.toLowerCase()) {
      return { kind: 'different', reason: 'child_hash' };
    }
  } else if ((aChild === undefined) !== (bChild === undefined)) {
    // One side never observed a child hash — cannot claim equality of child payload.
    return { kind: 'unknown', reason: 'child_hash_incomplete' };
  }

  if (a.dataHash !== undefined && b.dataHash !== undefined) {
    if (a.dataHash.toLowerCase() !== b.dataHash.toLowerCase()) {
      return { kind: 'different', reason: 'data_hash' };
    }
  }

  if (a.readerSchema !== b.readerSchema) {
    return { kind: 'different', reason: 'reader_schema' };
  }
  if (a.metadataSchema !== b.metadataSchema) {
    return { kind: 'different', reason: 'metadata_schema' };
  }
  if (a.generation !== b.generation) {
    return { kind: 'different', reason: 'generation' };
  }

  // mtime/size alone never upgrade unknown to equal; if hashes matched they are informational.
  return { kind: 'equal' };
}

export function versionsLookCurrent(a: ResourceVersion, b: ResourceVersion): boolean {
  return compareResourceVersion(a, b).kind === 'equal';
}

export interface ResourceVersionSourceKeyInput {
  workspaceId: string;
  sourceUri: string;
  childChain?: string[];
  namespace?: string;
  objectKey?: string;
}

/**
 * Stable source key for cache/proof invalidation.
 * Display labels and query strings are never part of this key.
 */
export function resourceSourceKey(input: ResourceVersionSourceKeyInput): string {
  return JSON.stringify([
    input.workspaceId,
    input.sourceUri,
    input.childChain ?? [],
    input.namespace ?? '',
    input.objectKey ?? ''
  ]);
}

export interface DependencyDigestEntry {
  sourceKey: string;
  version: ResourceVersion;
}

/** Sorted dependency digest used for page sessions and snapshot identity. */
export function buildResourceDependencyDigest(entries: DependencyDigestEntry[]): string {
  const normalized = entries
    .map((entry) => ({
      sourceKey: entry.sourceKey,
      outerFileHash: entry.version.outerFileHash,
      childHash: entry.version.childHash ?? '',
      dataHash: entry.version.dataHash ?? '',
      sourceRevision: entry.version.sourceRevision === undefined ? '' : String(entry.version.sourceRevision),
      readerSchema: entry.version.readerSchema ?? '',
      metadataSchema: entry.version.metadataSchema ?? '',
      generation: entry.version.generation
    }))
    .sort((a, b) => (a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0));
  return JSON.stringify(normalized);
}

export class ResourceVersionClock {
  private generation = 0;

  current(): number {
    return this.generation;
  }

  /** Host observation bump after source invalidation or successful commit. */
  bump(): number {
    this.generation += 1;
    return this.generation;
  }

  stamp(version: Omit<ResourceVersion, 'generation'>): ResourceVersion {
    return { ...version, generation: this.generation };
  }
}
