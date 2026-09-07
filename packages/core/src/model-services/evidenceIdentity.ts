/**
 * Structured identity and version primitives for agent evidence.
 *
 * Evidence identity is deliberately narrower than "all IDs mentioned in a
 * result".  Native/source adapters create these records after they have
 * validated the resource scope; search tickets, scores, offsets and timestamps
 * are never promoted to object identity here.
 */

import { stableJson } from '@soulforge/shared';

export type EvidenceRevision = number | string;

export interface EvidenceIdentity {
  readonly workspaceId: string;
  readonly canonicalOuterId: string;
  readonly childChain: readonly string[];
  readonly domain: string;
  readonly namespace: string;
  readonly objectHandle: string;
  /** Use one of claimKind/propertyKey/claimKey for the final claim component. */
  readonly claimKind?: string;
  readonly propertyKey?: string;
  readonly claimKey?: string;
  /** Optional source dimensions are folded into namespace without changing the key shape. */
  readonly language?: string;
  readonly formatProfileId?: string;
}

export interface EvidenceVersion {
  readonly revision?: EvidenceRevision;
  readonly sourceHash?: string;
  readonly outerHash?: string;
  readonly payloadHash?: string | null;
  readonly readerSchemaHash?: string;
  readonly metadataSchemaHash?: string;
  readonly workspaceEpoch?: number;
}

export interface EvidenceIdentityInput {
  readonly workspaceId: string;
  readonly canonicalOuterId?: string;
  readonly outerId?: string;
  readonly childChain: readonly string[];
  readonly domain: string;
  readonly namespace: string;
  readonly objectHandle?: string;
  readonly objectKey?: string;
  readonly snapshotObjectHandle?: string;
  readonly claimKind?: string;
  readonly propertyKey?: string;
  readonly claimKey?: string;
  readonly language?: string;
  readonly formatProfileId?: string;
}

export interface EvidenceClaim {
  readonly identity: EvidenceIdentity;
  readonly key: string;
  readonly resourceKey: string;
  readonly handle: string;
  readonly text: string;
  readonly version: EvidenceVersion;
  readonly versionState?: 'current' | 'candidate' | 'stale' | 'revoked' | 'out-of-scope';
  readonly authorityClass?: 'native' | 'fixture-confirmed' | 'candidate' | 'external' | string;
  readonly authority?: number;
  readonly required?: boolean;
  readonly goalRefs?: readonly string[];
  readonly dependencyRole?: 'direct' | 'same-goal' | 'background' | string;
  readonly observationSequence?: number;
  readonly sequence?: number;
  readonly relevance?: number;
  readonly title?: string;
  readonly missingFields?: readonly string[];
  readonly cursor?: string;
}

export interface EvidenceProjectionOptions {
  readonly workspaceId?: string;
  readonly canonicalOuterId?: string;
  readonly childChain?: readonly string[];
  readonly domain?: string;
  readonly namespace?: string;
  readonly language?: string;
  readonly formatProfileId?: string;
  readonly authorityClass?: EvidenceClaim['authorityClass'];
  readonly authority?: number;
  readonly versionState?: EvidenceClaim['versionState'];
  readonly observationSequence?: number;
}

export function assertEvidenceText(value: unknown, field = 'EVIDENCE_TEXT'): string {
  if (typeof value !== 'string') throw new Error(`INVALID_${field}`);
  return value;
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`EMPTY_${field}`);
  }
  return value;
}

function resolvedOuterId(input: EvidenceIdentityInput): string {
  return nonEmpty(input.canonicalOuterId ?? input.outerId, 'OUTER_ID');
}

function resolvedObjectHandle(input: EvidenceIdentityInput): string {
  return nonEmpty(
    input.objectHandle ?? input.objectKey ?? input.snapshotObjectHandle,
    'OBJECT_HANDLE'
  );
}

function resolvedClaimPart(input: EvidenceIdentityInput): string {
  const claim = input.propertyKey ?? input.claimKind ?? input.claimKey;
  if (input.claimKind && input.propertyKey && input.claimKind !== input.propertyKey) {
    return `${input.claimKind}\u0000${input.propertyKey}`;
  }
  return nonEmpty(claim, 'CLAIM_KEY');
}

function scopedNamespace(input: EvidenceIdentityInput): string {
  let namespace = nonEmpty(input.namespace, 'NAMESPACE');
  if (input.language !== undefined) namespace += `\u0000language=${nonEmpty(input.language, 'LANGUAGE')}`;
  if (input.formatProfileId !== undefined) {
    namespace += `\u0000format=${nonEmpty(input.formatProfileId, 'FORMAT_PROFILE')}`;
  }
  return namespace;
}

export function normalizeEvidenceIdentity(input: EvidenceIdentityInput): EvidenceIdentity {
  const childChain = Array.isArray(input.childChain)
    ? [...input.childChain]
    : [];
  nonEmpty(input.workspaceId, 'WORKSPACE_ID');
  const outerId = resolvedOuterId(input);
  if (childChain.length === 0 || childChain.some((part) => typeof part !== 'string' || part.length === 0)) {
    throw new Error('INVALID_CHILD_CHAIN');
  }
  const objectHandle = resolvedObjectHandle(input);
  const claimPart = resolvedClaimPart(input);
  return {
    workspaceId: input.workspaceId,
    canonicalOuterId: outerId,
    childChain,
    domain: nonEmpty(input.domain, 'DOMAIN'),
    namespace: scopedNamespace(input),
    objectHandle,
    claimKind: claimPart
  };
}

/** Stable, case-preserving claim key. JSON structure avoids delimiter collisions. */
export function evidenceKey(input: EvidenceIdentityInput | EvidenceIdentity): string {
  const identity = normalizeEvidenceIdentity(input);
  return stableJson([
    identity.workspaceId,
    identity.canonicalOuterId,
    identity.childChain,
    identity.domain,
    identity.namespace,
    identity.objectHandle,
    identity.claimKind
  ]);
}

/** Compatibility name used by the SF-19 smoke/legacy adapter call sites. */
export const makeEvidenceIdentityKey = evidenceKey;

/** Alias used by callers that name the final key explicitly as a claim key. */
export const claimIdentityKey = evidenceKey;

export function evidenceResourceKey(input: EvidenceIdentityInput | EvidenceIdentity): string {
  const identity = normalizeEvidenceIdentity(input);
  return stableJson([
    identity.workspaceId,
    identity.canonicalOuterId,
    identity.childChain,
    identity.domain,
    identity.namespace
  ]);
}

export const resourceIdentityKey = evidenceResourceKey;

export function normalizeEvidenceVersion(
  version: EvidenceVersion | EvidenceRevision | undefined
): EvidenceVersion {
  if (typeof version === 'string' || typeof version === 'number') return { revision: version };
  if (version === undefined) return {};
  const normalized: EvidenceVersion = {
    ...(version.revision !== undefined ? { revision: version.revision } : {}),
    ...(version.outerHash !== undefined
      ? { outerHash: version.outerHash }
      : version.sourceHash !== undefined ? { outerHash: version.sourceHash } : {}),
    ...(version.payloadHash !== undefined ? { payloadHash: version.payloadHash } : {}),
    ...(version.readerSchemaHash !== undefined ? { readerSchemaHash: version.readerSchemaHash } : {}),
    ...(version.metadataSchemaHash !== undefined ? { metadataSchemaHash: version.metadataSchemaHash } : {}),
    ...(version.workspaceEpoch !== undefined ? { workspaceEpoch: version.workspaceEpoch } : {})
  };
  return normalized;
}

export function evidenceVersionKey(version: EvidenceVersion | EvidenceRevision | undefined): string {
  return stableJson(normalizeEvidenceVersion(version));
}

/**
 * Exact version matching. No dictionary ordering is used for revisions: a
 * revision is an opaque host token, and a reader/schema change invalidates the
 * old derived claim even when the bytes/hash are unchanged.
 */
export function evidenceVersionsEqual(
  left: EvidenceVersion | EvidenceRevision | undefined,
  right: EvidenceVersion | EvidenceRevision | undefined
): boolean {
  const a = normalizeEvidenceVersion(left);
  const b = normalizeEvidenceVersion(right);
  return evidenceVersionKey(a) === evidenceVersionKey(b);
}

export function evidenceVersionMatchesCurrent(
  candidate: EvidenceVersion | EvidenceRevision | undefined,
  current: EvidenceVersion | EvidenceRevision | undefined
): boolean {
  if (current === undefined) return false;
  const expected = normalizeEvidenceVersion(current);
  const actual = normalizeEvidenceVersion(candidate);
  // A structured current map is authoritative. Missing fields are not treated
  // as equal because that would let an old reader-schema claim through.
  return Object.keys(expected).every((key) => (
    Object.prototype.hasOwnProperty.call(actual, key)
    && (actual as Record<string, unknown>)[key] === (expected as Record<string, unknown>)[key]
  ));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function firstRecordValue(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) if (record[key] !== undefined) return record[key];
  return undefined;
}

function firstVersion(record: Record<string, unknown>, parent: EvidenceVersion | undefined): EvidenceVersion {
  const nested = asRecord(record.version);
  const sourceHash = firstString(record, ['sourceHash', 'outerHash']);
  const revision = firstRecordValue(record, ['sourceRevision', 'revision']);
  const readerSchemaHash = firstString(record, ['readerSchemaHash', 'readerSchema']);
  const metadataSchemaHash = firstString(record, ['metadataSchemaHash', 'metadataSchema']);
  const workspaceEpoch = typeof record.workspaceEpoch === 'number' && Number.isSafeInteger(record.workspaceEpoch)
    ? record.workspaceEpoch
    : undefined;
  return {
    ...(parent ?? {}),
    ...(nested ? normalizeEvidenceVersion(nested as EvidenceVersion) : {}),
    ...(sourceHash ? { outerHash: sourceHash } : {}),
    ...(revision !== undefined && (typeof revision === 'string' || typeof revision === 'number')
      ? { revision }
      : {}),
    ...(readerSchemaHash ? { readerSchemaHash } : {}),
    ...(metadataSchemaHash ? { metadataSchemaHash } : {}),
    ...(workspaceEpoch !== undefined ? { workspaceEpoch } : {})
  };
}

function domainFromTool(toolName: string | undefined): string {
  if (!toolName) return 'evidence';
  if (/param/i.test(toolName)) return 'param';
  if (/fmg|text/i.test(toolName)) return 'fmg';
  if (/emevd|event/i.test(toolName)) return 'emevd';
  if (/tae|animation/i.test(toolName)) return 'tae';
  if (/map|msb/i.test(toolName)) return 'map';
  if (/lua|script/i.test(toolName)) return 'script';
  return 'evidence';
}

function collectionItems(record: Record<string, unknown>): unknown[] {
  for (const key of ['claims', 'fields', 'entries', 'rows', 'events', 'parts', 'entities', 'items', 'hits', 'matches']) {
    if (Array.isArray(record[key])) return record[key];
  }
  return [record];
}

function claimText(item: Record<string, unknown>, fallback: unknown): string {
  const value = firstRecordValue(item, ['text', 'value', 'body', 'excerpt', 'summary', 'description']);
  if (typeof value === 'string') return value;
  if (value !== undefined) return JSON.stringify(value) ?? String(value);
  return typeof fallback === 'string' ? fallback : JSON.stringify(item) ?? '';
}

/**
 * Project a checked native/tool payload into independent typed claims. This is
 * intentionally conservative: if the payload does not expose an explicit
 * workspace, outer resource and object handle, no claim is fabricated.
 */
export function projectEvidenceClaims(
  payload: unknown,
  options: EvidenceProjectionOptions = {}
): EvidenceClaim[] {
  const root = asRecord(payload);
  if (!root) return [];
  const rootIdentity = asRecord(root.identity);
  const rootVersionRecord = asRecord(root.version);
  const parentVersion = firstVersion(
    { ...root, ...(rootVersionRecord ? { version: rootVersionRecord } : {}) },
    undefined
  );
  const workspaceId = options.workspaceId
    ?? firstString(rootIdentity ?? root, ['workspaceId']);
  const canonicalOuterId = options.canonicalOuterId
    ?? firstString(rootIdentity ?? root, [
      'canonicalOuterId', 'outerId', 'sourceUri', 'sourcePath', 'filePath',
      'containerPath', 'file', 'uri'
    ]);
  const childValue = options.childChain
    ?? firstRecordValue(rootIdentity ?? root, ['childChain']);
  const childChain = Array.isArray(childValue)
    ? childValue.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : (() => {
        const child = firstString(rootIdentity ?? root, ['entryName', 'childId', 'containerEntry']);
        return child ? [child] : ['root'];
      })();
  const domain = options.domain
    ?? firstString(rootIdentity ?? root, ['domain'])
    ?? 'evidence';
  const namespace = options.namespace
    ?? firstString(rootIdentity ?? root, ['namespace', 'paramName', 'table', 'category', 'format', 'resourceKind'])
    ?? domain;
  if (!workspaceId || !canonicalOuterId || childChain.length === 0) return [];

  const items = collectionItems(root);
  const claims: EvidenceClaim[] = [];
  const rootHandle = firstString(rootIdentity ?? root, ['objectHandle', 'objectKey', 'snapshotObjectHandle']);
  for (let index = 0; index < items.length && index < 256; index += 1) {
    const item = asRecord(items[index]);
    if (!item) continue;
    const itemIdentity = asRecord(item.identity);
    const record = itemIdentity ? { ...item, ...itemIdentity } : item;
    const objectHandle = firstString(record, [
      'objectHandle', 'objectKey', 'snapshotObjectHandle', 'rowId', 'eventId',
      'textId', 'entityId', 'animId', 'id', 'uri', 'address'
    ]) ?? rootHandle;
    if (!objectHandle) continue;
    const field = firstString(record, ['propertyKey', 'claimKey', 'claimKind', 'fieldId', 'fieldName', 'name']);
    const claimKind = field ?? (items.length > 1 ? 'object' : 'value');
    const version = firstVersion(record, parentVersion);
    const identity = normalizeEvidenceIdentity({
      workspaceId,
      canonicalOuterId,
      childChain,
      domain,
      namespace,
      objectHandle,
      claimKind,
      ...(options.language ?? firstString(record, ['language', 'lang'])
        ? { language: options.language ?? firstString(record, ['language', 'lang'])! }
        : {}),
      ...(options.formatProfileId ? { formatProfileId: options.formatProfileId } : {})
    });
    const key = evidenceKey(identity);
    claims.push({
      identity,
      key,
      resourceKey: evidenceResourceKey(identity),
      handle: firstString(record, ['handle', 'objectHandle', 'uri']) ?? `${canonicalOuterId}#${objectHandle}`,
      text: claimText(record, root),
      version,
      ...(options.versionState ? { versionState: options.versionState } : {}),
      ...(options.authorityClass ? { authorityClass: options.authorityClass } : {}),
      ...(options.authority !== undefined ? { authority: options.authority } : {}),
      observationSequence: (options.observationSequence ?? 0) + index,
      sequence: (options.observationSequence ?? 0) + index,
      relevance: 0
    });
  }
  return claims;
}
