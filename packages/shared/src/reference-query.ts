/**
 * Reference-query contracts shared by CLI and Agent tool entrypoints.
 *
 * These DTOs describe host-validated identity, relation pages, coverage and
 * pagination. Nested selectors are decoded by core (see decodeReferenceQueryInput);
 * ToolInputShape only ever describes top-level string/array/boolean fields.
 */

import type { NativeEditDomain, NativeReadCompleteness } from './native-evidence-contract.js';

export type ReferenceDirection = 'from' | 'to' | 'both';
export type ReferenceDetail = 'edges' | 'context';
export type ReferenceRelatedMode = 'none' | 'summary' | 'context';
export type ReferenceResolution =
  | 'resolved'
  | 'ambiguous'
  | 'insufficient_evidence'
  | 'not_found';

export type RelationCertainty = 'confirmed' | 'indirect' | 'hypothesis';

export type RelationStatementKind =
  | 'native-rendered'
  | 'source-text'
  | 'decompiled-view'
  | 'field-assignment';

export type ParamTargetStatus = 'present' | 'missing' | 'ambiguous' | 'unverified';

export type ReferenceDomain =
  | 'param'
  | 'emevd'
  | 'fmg'
  | 'script'
  | 'map'
  | 'tae'
  | 'resource'
  | 'other';

export type ReferenceErrorCode =
  | 'REFERENCE_TARGET_REQUIRED'
  | 'REFERENCE_TARGET_CONFLICT'
  | 'REFERENCE_TARGET_AMBIGUOUS'
  | 'REFERENCE_SOURCE_STALE'
  | 'REFERENCE_COVERAGE_INCOMPLETE'
  | 'REFERENCE_PAGE_ITEM_TOO_LARGE'
  | 'REFERENCE_CURSOR_SCOPE_MISMATCH'
  | 'REFERENCE_INPUT_INVALID'
  | 'REFERENCE_WORKSPACE_REQUIRED'
  | 'NATIVE_READ_REQUIRED'
  | 'NATIVE_READ_COVERAGE_INCOMPLETE'
  | 'NATIVE_READ_STALE';

/** Discriminated physical identity for a reference root target. */
export type ReferenceTargetSelector =
  | { objectHandle: string }
  | {
      domain: 'param';
      sourceUri: string;
      entryIndex: number;
      entryName?: string;
      rowId: number;
      rowIndex?: number;
    }
  | { domain: 'emevd'; sourceUri: string; eventId: number }
  | {
      domain: 'fmg';
      sourceUri: string;
      childChain: string[];
      category: string;
      language?: string;
      textId: number;
      entryIndex?: number;
    }
  | {
      domain: 'script';
      sourceUri: string;
      childChain: string[];
      scriptEntryIndex?: number;
    }
  | { domain: 'map'; sourceUri: string; nativeObjectKey: string }
  | {
      domain: 'tae';
      sourceUri: string;
      childChain: string[];
      taeEntryIndex: number;
      animId: number;
      eventIndex?: number;
    }
  | {
      domain: 'resource';
      sourceUri: string;
      childChain: string[];
      nativeObjectKey?: string;
    };

export interface ReferenceStatement {
  kind: RelationStatementKind;
  text: string;
  /** Optional language label for decompiled/source views. */
  language?: string;
  /** Byte or character range in the host-held canonical view when known. */
  range?: { start: number; end: number };
}

export interface ReferenceLocation {
  sourceUri: string;
  domain: ReferenceDomain;
  /** Stable host locator; not a display name. */
  locator: string;
  line?: number;
  column?: number;
  instructionIndex?: number;
  fieldId?: string;
  rowIndex?: number;
  entryIndex?: number;
  nativeOffset?: number;
}

export interface ReferenceIdentity {
  workspaceId: string;
  domain: ReferenceDomain;
  sourceUri: string;
  outerId: string;
  childChain: string[];
  namespace: string;
  objectKey: string;
  /** Display label only; never used as a primary key. */
  label?: string;
  rowId?: number;
  rowIndex?: number;
  entryIndex?: number;
  entryName?: string;
  fieldId?: string;
  eventId?: number;
  textId?: number;
  animId?: number;
  nativeObjectKey?: string;
  /** Host-minted handle for follow-up precise calls when available. */
  objectHandle?: string;
}

export interface ReferenceVersionSnapshot {
  outerFileHash?: string;
  childHash?: string;
  dataHash?: string;
  sourceRevision?: number | string;
  readerSchema?: string;
  metadataSchema?: string;
  generation?: number;
}

export interface ReferenceEvidence {
  version: ReferenceVersionSnapshot;
  location: ReferenceLocation;
  statement?: ReferenceStatement;
  /** Field-assignment facts for PARAM-style evidence. */
  fieldFacts?: {
    fieldId: string;
    value: unknown;
    conditionFieldId?: string;
    conditionValue?: unknown;
    metadataRule?: string;
    targetStatus?: ParamTargetStatus;
  };
  ruleName?: string;
  diagnostics?: string[];
}

export interface ReferenceRelationItem {
  relationId: string;
  from: ReferenceIdentity;
  to: ReferenceIdentity;
  relationKind: string;
  certainty: RelationCertainty;
  evidence: ReferenceEvidence;
  /** Ordered hop identities for indirect paths; empty or single-hop for direct. */
  path: ReferenceIdentity[];
  /** Why this is not confirmed, when certainty is not confirmed. */
  limitNote?: string;
}

export interface ReferenceCandidate {
  identity: ReferenceIdentity;
  version?: ReferenceVersionSnapshot;
  /** Fields that distinguish this candidate from siblings. */
  discriminators: Record<string, unknown>;
}

export interface ReferenceTargetRead {
  identity: ReferenceIdentity;
  version: ReferenceVersionSnapshot;
  fields: Array<{
    fieldId: string;
    value: unknown;
    displayName?: string;
  }>;
  completeness: NativeReadCompleteness;
}

export interface ReferenceDomainCoverage {
  domain: ReferenceDomain | 'workspace';
  status:
    | 'complete'
    | 'partial'
    | 'unscanned'
    | 'failed'
    | 'not_indexed'
    | 'unsupported'
    | 'skipped';
  discovered?: number;
  readOk?: number;
  parsedOk?: number;
  unscanned?: number;
  failed?: number;
  unsupported?: number;
  notes?: string[];
}

export interface ReferenceCoverage {
  scopeDescription: string;
  predicateComplete: boolean;
  domains: ReferenceDomainCoverage[];
  unresolvedSources: string[];
  failedSources: string[];
  unscannedSources: string[];
  /** True when a negative "no references" claim is allowed for this scope. */
  allowsNegativeClaim: boolean;
}

export interface ReferencePageInfo {
  returnedCount: number;
  hasMore: boolean;
  cursor?: string;
  truncationReason?: string;
  dependencyDigest: string;
  sortVersion: string;
}

export interface ReferenceNextAction {
  tool: string;
  args: Record<string, unknown>;
  reason?: string;
}

export interface ReferenceDiagnostic {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
  sourceUri?: string;
  domain?: ReferenceDomain;
}

export interface ReferencePageRecord {
  resolution: ReferenceResolution;
  target?: ReferenceIdentity;
  targetVersion?: ReferenceVersionSnapshot;
  candidates: ReferenceCandidate[];
  targetRead?: ReferenceTargetRead;
  relations: ReferenceRelationItem[];
  coverage: ReferenceCoverage;
  page: ReferencePageInfo;
  diagnostics: ReferenceDiagnostic[];
  nextActions: ReferenceNextAction[];
  /** Present when related=summary on param tools. */
  relatedSummary?: {
    relationCounts: Record<string, number>;
    coverage: ReferenceCoverage;
  };
}

export interface ReferenceQueryInput {
  uri?: string;
  target?: ReferenceTargetSelector;
  query?: string;
  domain?: ReferenceDomain;
  direction: ReferenceDirection;
  detail: ReferenceDetail;
  fieldIds?: string[];
  depth: number;
  limit: number;
  includeHypotheses: boolean;
  cursor?: string;
}

export interface ReferenceQueryDecodeOk {
  ok: true;
  value: ReferenceQueryInput;
}

export interface ReferenceQueryDecodeFail {
  ok: false;
  code: ReferenceErrorCode | 'INVALID_INPUT';
  message: string;
  details?: unknown;
}

export type ReferenceQueryDecodeResult = ReferenceQueryDecodeOk | ReferenceQueryDecodeFail;

/** Selector-only decode result (not a full query input). */
export type ReferenceSelectorDecodeResult =
  | { ok: true; value: ReferenceTargetSelector }
  | ReferenceQueryDecodeFail;

export const REFERENCE_DEFAULT_DEPTH = 3;
export const REFERENCE_DEFAULT_LIMIT = 8;
export const REFERENCE_MIN_DEPTH = 1;
export const REFERENCE_MAX_DEPTH = 4;
export const REFERENCE_MIN_LIMIT = 1;
export const REFERENCE_MAX_LIMIT = 32;

const REFERENCE_DOMAINS = new Set<string>([
  'param',
  'emevd',
  'fmg',
  'script',
  'map',
  'tae',
  'resource',
  'other'
]);

function fail(
  code: ReferenceQueryDecodeFail['code'],
  message: string,
  details?: unknown
): ReferenceQueryDecodeFail {
  return details === undefined ? { ok: false, code, message } : { ok: false, code, message, details };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asOptionalNonEmptyString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asSafeInteger(value: unknown, field: string): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function asBooleanDefault(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  return fallback;
}

function decodeDirection(value: unknown): ReferenceDirection {
  if (value === undefined || value === null || value === '') return 'both';
  if (value === 'from' || value === 'to' || value === 'both') return value;
  return 'both';
}

function decodeDetail(value: unknown): ReferenceDetail {
  if (value === 'edges' || value === 'context') return value;
  return 'context';
}

function decodeSelector(raw: unknown): ReferenceSelectorDecodeResult {
  if (!isRecord(raw)) return fail('REFERENCE_INPUT_INVALID', 'target 必须是结构化选择器对象。');
  if (typeof raw.objectHandle === 'string' && raw.objectHandle.trim() !== '') {
    const keys = Object.keys(raw);
    if (keys.length === 1) return { ok: true, value: { objectHandle: raw.objectHandle.trim() } };
    return fail('REFERENCE_INPUT_INVALID', 'objectHandle 选择器不得携带其它物理字段。');
  }

  const domain = raw.domain;
  if (typeof domain !== 'string' || !REFERENCE_DOMAINS.has(domain)) {
    return fail('REFERENCE_INPUT_INVALID', 'target.domain 必须是受支持的关联领域。');
  }
  const sourceUri = asOptionalNonEmptyString(raw.sourceUri);
  if (!sourceUri) return fail('REFERENCE_INPUT_INVALID', 'target.sourceUri 必须是非空字符串。');

  if (domain === 'param') {
    const entryIndex = asSafeInteger(raw.entryIndex, 'entryIndex');
    const rowId = asSafeInteger(raw.rowId, 'rowId');
    if (entryIndex === null || entryIndex < 0) {
      return fail('REFERENCE_INPUT_INVALID', 'param 选择器 entryIndex 必须是非负安全整数。');
    }
    if (rowId === null) {
      return fail('REFERENCE_INPUT_INVALID', 'param 选择器 rowId 必须是安全整数。');
    }
    const rowIndexRaw = raw.rowIndex;
    let rowIndex: number | undefined;
    if (rowIndexRaw !== undefined && rowIndexRaw !== null) {
      const parsed = asSafeInteger(rowIndexRaw, 'rowIndex');
      if (parsed === null || parsed < 0) {
        return fail('REFERENCE_INPUT_INVALID', 'param 选择器 rowIndex 必须是非负安全整数。');
      }
      rowIndex = parsed;
    }
    const entryName = asOptionalNonEmptyString(raw.entryName);
    return {
      ok: true,
      value: {
        domain: 'param',
        sourceUri,
        entryIndex,
        ...(entryName ? { entryName } : {}),
        rowId,
        ...(rowIndex !== undefined ? { rowIndex } : {})
      }
    };
  }

  if (domain === 'emevd') {
    const eventId = asSafeInteger(raw.eventId, 'eventId');
    if (eventId === null) return fail('REFERENCE_INPUT_INVALID', 'emevd 选择器 eventId 必须是安全整数。');
    return { ok: true, value: { domain: 'emevd', sourceUri, eventId } };
  }

  if (domain === 'fmg') {
    const childChain = decodeChildChain(raw.childChain);
    if (!childChain.ok) return childChain;
    const category = asOptionalNonEmptyString(raw.category);
    if (!category) return fail('REFERENCE_INPUT_INVALID', 'fmg 选择器 category 必填。');
    const textId = asSafeInteger(raw.textId, 'textId');
    if (textId === null) return fail('REFERENCE_INPUT_INVALID', 'fmg 选择器 textId 必须是安全整数。');
    const language = asOptionalNonEmptyString(raw.language);
    const entryIndexRaw = raw.entryIndex;
    let entryIndex: number | undefined;
    if (entryIndexRaw !== undefined && entryIndexRaw !== null) {
      const parsed = asSafeInteger(entryIndexRaw, 'entryIndex');
      if (parsed === null || parsed < 0) {
        return fail('REFERENCE_INPUT_INVALID', 'fmg 选择器 entryIndex 必须是非负安全整数。');
      }
      entryIndex = parsed;
    }
    return {
      ok: true,
      value: {
        domain: 'fmg',
        sourceUri,
        childChain: childChain.value,
        category,
        ...(language ? { language } : {}),
        textId,
        ...(entryIndex !== undefined ? { entryIndex } : {})
      }
    };
  }

  if (domain === 'script') {
    const childChain = decodeChildChain(raw.childChain);
    if (!childChain.ok) return childChain;
    const scriptEntryIndexRaw = raw.scriptEntryIndex;
    let scriptEntryIndex: number | undefined;
    if (scriptEntryIndexRaw !== undefined && scriptEntryIndexRaw !== null) {
      const parsed = asSafeInteger(scriptEntryIndexRaw, 'scriptEntryIndex');
      if (parsed === null || parsed < 0) {
        return fail('REFERENCE_INPUT_INVALID', 'script 选择器 scriptEntryIndex 必须是非负安全整数。');
      }
      scriptEntryIndex = parsed;
    }
    return {
      ok: true,
      value: {
        domain: 'script',
        sourceUri,
        childChain: childChain.value,
        ...(scriptEntryIndex !== undefined ? { scriptEntryIndex } : {})
      }
    };
  }

  if (domain === 'map') {
    const nativeObjectKey = asOptionalNonEmptyString(raw.nativeObjectKey);
    if (!nativeObjectKey) return fail('REFERENCE_INPUT_INVALID', 'map 选择器 nativeObjectKey 必填。');
    return { ok: true, value: { domain: 'map', sourceUri, nativeObjectKey } };
  }

  if (domain === 'tae') {
    const childChain = decodeChildChain(raw.childChain);
    if (!childChain.ok) return childChain;
    const taeEntryIndex = asSafeInteger(raw.taeEntryIndex, 'taeEntryIndex');
    const animId = asSafeInteger(raw.animId, 'animId');
    if (taeEntryIndex === null || taeEntryIndex < 0) {
      return fail('REFERENCE_INPUT_INVALID', 'tae 选择器 taeEntryIndex 必须是非负安全整数。');
    }
    if (animId === null) return fail('REFERENCE_INPUT_INVALID', 'tae 选择器 animId 必须是安全整数。');
    const eventIndexRaw = raw.eventIndex;
    let eventIndex: number | undefined;
    if (eventIndexRaw !== undefined && eventIndexRaw !== null) {
      const parsed = asSafeInteger(eventIndexRaw, 'eventIndex');
      if (parsed === null || parsed < 0) {
        return fail('REFERENCE_INPUT_INVALID', 'tae 选择器 eventIndex 必须是非负安全整数。');
      }
      eventIndex = parsed;
    }
    return {
      ok: true,
      value: {
        domain: 'tae',
        sourceUri,
        childChain: childChain.value,
        taeEntryIndex,
        animId,
        ...(eventIndex !== undefined ? { eventIndex } : {})
      }
    };
  }

  // resource / other
  const childChain = decodeChildChain(raw.childChain);
  if (!childChain.ok) return childChain;
  const nativeObjectKey = asOptionalNonEmptyString(raw.nativeObjectKey);
  return {
    ok: true,
    value: {
      domain: domain as 'resource',
      sourceUri,
      childChain: childChain.value,
      ...(nativeObjectKey ? { nativeObjectKey } : {})
    }
  };
}

function decodeChildChain(raw: unknown): { ok: true; value: string[] } | ReferenceQueryDecodeFail {
  if (!Array.isArray(raw) || raw.length === 0) {
    return fail('REFERENCE_INPUT_INVALID', 'childChain 必须是非空字符串数组。');
  }
  const out: string[] = [];
  for (const piece of raw) {
    if (typeof piece !== 'string' || piece.trim() === '') {
      return fail('REFERENCE_INPUT_INVALID', 'childChain 每一项必须是非空字符串。');
    }
    out.push(piece);
  }
  return { ok: true, value: out };
}

function decodeFieldIds(raw: unknown): { ok: true; value?: string[] } | ReferenceQueryDecodeFail {
  if (raw === undefined || raw === null) return { ok: true };
  if (!Array.isArray(raw)) return fail('REFERENCE_INPUT_INVALID', 'fieldIds 必须是字符串数组。');
  if (raw.length === 0) {
    return fail('REFERENCE_INPUT_INVALID', 'fieldIds 不得为空数组；省略该参数表示不请求原生字段。');
  }
  const out: string[] = [];
  for (const piece of raw) {
    if (typeof piece !== 'string' || piece.trim() === '') {
      return fail('REFERENCE_INPUT_INVALID', 'fieldIds 每一项必须是非空字符串。');
    }
    out.push(piece.trim());
  }
  return { ok: true, value: out };
}

/**
 * Strict decoder for find_references nested input.
 * Rejects NaN/Infinity/unsafe integers, mutual-exclusive targets, and empty fieldIds.
 */
export function decodeReferenceQueryInput(raw: unknown): ReferenceQueryDecodeResult {
  if (!isRecord(raw)) return fail('REFERENCE_INPUT_INVALID', 'find_references 输入必须是对象。');

  const uri = asOptionalNonEmptyString(raw.uri);
  const query = asOptionalNonEmptyString(raw.query);
  const hasTargetField = raw.target !== undefined && raw.target !== null;
  const targetCount = (uri ? 1 : 0) + (hasTargetField ? 1 : 0) + (query ? 1 : 0);

  if (raw.cursor !== undefined && raw.cursor !== null) {
    const cursor = asOptionalNonEmptyString(raw.cursor);
    if (!cursor) return fail('REFERENCE_INPUT_INVALID', 'cursor 必须是非空宿主游标。');
    // Continuation: only cursor is authoritative; other scope params must be omitted or match later.
    return {
      ok: true,
      value: {
        direction: decodeDirection(raw.direction),
        detail: decodeDetail(raw.detail),
        depth: REFERENCE_DEFAULT_DEPTH,
        limit: REFERENCE_DEFAULT_LIMIT,
        includeHypotheses: asBooleanDefault(raw.includeHypotheses, false),
        cursor
      }
    };
  }

  if (targetCount === 0) {
    return fail('REFERENCE_TARGET_REQUIRED', '第一次请求必须提供 uri / target / query 中的一种。');
  }
  if (targetCount > 1) {
    return fail('REFERENCE_TARGET_CONFLICT', 'uri / target / query 互斥，只能提供一种目标入口。');
  }

  const value: ReferenceQueryInput = {
    direction: decodeDirection(raw.direction),
    detail: decodeDetail(raw.detail),
    depth: REFERENCE_DEFAULT_DEPTH,
    limit: REFERENCE_DEFAULT_LIMIT,
    includeHypotheses: asBooleanDefault(raw.includeHypotheses, false)
  };

  if (uri) value.uri = uri;
  if (query) value.query = query;

  const domain = asOptionalNonEmptyString(raw.domain);
  if (domain) {
    if (!REFERENCE_DOMAINS.has(domain)) {
      return fail('REFERENCE_INPUT_INVALID', `domain 不受支持：${domain}`);
    }
    if (!query && !hasTargetField) {
      return fail('REFERENCE_INPUT_INVALID', 'domain 仅用于限定 query，不得单独作为目标。');
    }
    value.domain = domain as ReferenceDomain;
  }

  if (hasTargetField) {
    const decoded = decodeSelector(raw.target);
    if (!decoded.ok) return decoded;
    value.target = decoded.value;
  }

  const fieldIds = decodeFieldIds(raw.fieldIds);
  if (!fieldIds.ok) return fieldIds;
  if (fieldIds.value) {
    const selector = value.target;
    const isParamSelector = Boolean(selector && 'domain' in selector && selector.domain === 'param');
    if (!isParamSelector) {
      if (uri || query) {
        // Allowed only when the resolved root is PARAM; service enforces after resolution.
        value.fieldIds = fieldIds.value;
      } else {
        return fail('REFERENCE_INPUT_INVALID', 'fieldIds 仅对 PARAM 根目标有效。');
      }
    } else {
      value.fieldIds = fieldIds.value;
    }
  }

  if (raw.depth !== undefined && raw.depth !== null) {
    const depth = asSafeInteger(raw.depth, 'depth');
    if (depth === null || depth < REFERENCE_MIN_DEPTH || depth > REFERENCE_MAX_DEPTH) {
      return fail('REFERENCE_INPUT_INVALID', `depth 必须是 ${REFERENCE_MIN_DEPTH}-${REFERENCE_MAX_DEPTH} 的安全整数。`);
    }
    value.depth = depth;
  }

  if (raw.limit !== undefined && raw.limit !== null) {
    const limit = asSafeInteger(raw.limit, 'limit');
    if (limit === null || limit < REFERENCE_MIN_LIMIT || limit > REFERENCE_MAX_LIMIT) {
      return fail('REFERENCE_INPUT_INVALID', `limit 必须是 ${REFERENCE_MIN_LIMIT}-${REFERENCE_MAX_LIMIT} 的安全整数。`);
    }
    value.limit = limit;
  }

  return { ok: true, value };
}

/** Build a stable identity key that preserves physical discriminators. */
export function referenceIdentityKey(identity: ReferenceIdentity): string {
  return JSON.stringify([
    identity.workspaceId,
    identity.domain,
    identity.sourceUri,
    identity.outerId,
    identity.childChain,
    identity.namespace,
    identity.objectKey,
    identity.rowId ?? null,
    identity.rowIndex ?? null,
    identity.entryIndex ?? null,
    identity.entryName ?? null,
    identity.fieldId ?? null,
    identity.eventId ?? null,
    identity.textId ?? null,
    identity.animId ?? null,
    identity.nativeObjectKey ?? null
  ]);
}

/** Dependency digest for page/cursor binding; sorted source keys + versions. */
export function buildReferenceDependencyDigest(
  entries: Array<{ sourceKey: string; version: ReferenceVersionSnapshot }>
): string {
  const normalized = entries
    .map((entry) => ({
      sourceKey: entry.sourceKey,
      outerFileHash: entry.version.outerFileHash ?? '',
      childHash: entry.version.childHash ?? '',
      dataHash: entry.version.dataHash ?? '',
      sourceRevision: entry.version.sourceRevision === undefined ? '' : String(entry.version.sourceRevision),
      readerSchema: entry.version.readerSchema ?? '',
      metadataSchema: entry.version.metadataSchema ?? '',
      generation: entry.version.generation === undefined ? '' : String(entry.version.generation)
    }))
    .sort((a, b) => (a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0));
  return JSON.stringify(normalized);
}

export function domainFromNativeEditDomain(domain: NativeEditDomain): ReferenceDomain {
  switch (domain) {
    case 'param':
    case 'fmg':
    case 'emevd':
    case 'script':
    case 'map':
    case 'tae':
      return domain;
    default:
      return 'other';
  }
}
