/**
 * Unified reference-query contract (执行指令 §3/§4).
 *
 * Everything the Agent, CLI and desktop share for `find_references`:
 * request DTO with a strict decoder, discriminated target selectors, the
 * reference-page record shape, and the certainty/resolution enums.
 *
 * The decoder is the only gate that turns model-authored JSON into a
 * normalized query. It rejects non-safe integers, NaN/Infinity, empty
 * strings, unknown keys and mutually-exclusive target entries BEFORE any
 * reader sees the input. Nested objects are validated field by field —
 * `ToolInputShape` can only describe top-level types.
 */

export type ReferenceDirection = 'from' | 'to' | 'both';
export type ReferenceDetail = 'edges' | 'context';
/** Relation nature. Deliberately separate from the legacy high/medium/low confidence. */
export type ReferenceCertainty = 'confirmed' | 'indirect' | 'hypothesis';
export type ReferenceResolution = 'resolved' | 'ambiguous' | 'insufficient_evidence' | 'not_found';
/** How a statement was obtained; never claim `source-text` for rendered or decompiled views. */
export type ReferenceStatementKind = 'native-rendered' | 'source-text' | 'decompiled-view' | 'field-assignment';

export type ReferenceRelationKind =
  | 'calls_event'
  | 'reads_flag'
  | 'writes_flag'
  | 'references_map_entity'
  | 'references_region'
  | 'references_param_row'
  | 'references_text'
  | 'invokes_script'
  | 'contains'
  | 'member_of'
  | 'numeric_match'
  | 'unknown';

/** Discriminated selector; no catch-all object with arbitrary properties. */
export type ReferenceTargetSelector =
  | { objectHandle: string }
  | {
      domain: 'param'; sourceUri: string;
      entryIndex: number; entryName?: string;
      rowId: number; rowIndex?: number;
    }
  | { domain: 'emevd'; sourceUri: string; eventId: number }
  | {
      domain: 'fmg'; sourceUri: string;
      childChain: string[]; category: string; language?: string;
      textId: number; entryIndex?: number;
    }
  | {
      domain: 'script'; sourceUri: string;
      childChain: string[]; scriptEntryIndex?: number;
    }
  | {
      domain: 'map'; sourceUri: string;
      nativeObjectKey: string;
    }
  | {
      domain: 'tae'; sourceUri: string;
      childChain: string[]; taeEntryIndex: number;
      animId: number; eventIndex?: number;
    }
  | {
      domain: 'resource'; sourceUri: string;
      childChain: string[]; nativeObjectKey?: string;
    };

export interface ReferenceQueryInput {
  uri?: string;
  target?: ReferenceTargetSelector;
  query?: string;
  domain?: string;
  direction?: ReferenceDirection;
  detail?: ReferenceDetail;
  fieldIds?: string[];
  depth?: number;
  limit?: number;
  includeHypotheses?: boolean;
  cursor?: string;
}

export type ReferenceQueryErrorCode =
  | 'REFERENCE_TARGET_REQUIRED'
  | 'REFERENCE_TARGET_CONFLICT'
  | 'REFERENCE_CURSOR_SCOPE_MISMATCH'
  | 'REFERENCE_INVALID_INPUT';

export interface ReferenceQueryDecodeFailure {
  ok: false;
  code: ReferenceQueryErrorCode;
  message: string;
  field?: string;
}

export interface NormalizedReferenceQuery {
  uri?: string;
  target?: ReferenceTargetSelector;
  query?: string;
  domain?: string;
  direction: ReferenceDirection;
  detail: ReferenceDetail;
  fieldIds?: string[];
  depth: number;
  limit: number;
  includeHypotheses: boolean;
  cursor?: string;
  /** Cursor continuation requests must match the host-stored scope exactly. */
  cursorScopeCheckRequired: boolean;
}

export type ReferenceQueryDecodeResult =
  | { ok: true; input: NormalizedReferenceQuery }
  | ReferenceQueryDecodeFailure;

export const REFERENCE_DEPTH_DEFAULT = 3;
export const REFERENCE_DEPTH_MIN = 1;
export const REFERENCE_DEPTH_MAX = 4;
export const REFERENCE_LIMIT_DEFAULT = 8;
export const REFERENCE_LIMIT_MIN = 1;
export const REFERENCE_LIMIT_MAX = 32;

const QUERY_TOP_LEVEL_KEYS = new Set([
  'uri', 'target', 'query', 'domain', 'direction', 'detail',
  'fieldIds', 'depth', 'limit', 'includeHypotheses', 'cursor'
]);

const SELECTOR_KEYS: Record<string, ReadonlySet<string>> = {
  objectHandle: new Set(['objectHandle']),
  param: new Set(['domain', 'sourceUri', 'entryIndex', 'entryName', 'rowId', 'rowIndex']),
  emevd: new Set(['domain', 'sourceUri', 'eventId']),
  fmg: new Set(['domain', 'sourceUri', 'childChain', 'category', 'language', 'textId', 'entryIndex']),
  script: new Set(['domain', 'sourceUri', 'childChain', 'scriptEntryIndex']),
  map: new Set(['domain', 'sourceUri', 'nativeObjectKey']),
  tae: new Set(['domain', 'sourceUri', 'childChain', 'taeEntryIndex', 'animId', 'eventIndex']),
  resource: new Set(['domain', 'sourceUri', 'childChain', 'nativeObjectKey'])
};

const REFERENCE_DOMAINS = new Set(['param', 'emevd', 'fmg', 'script', 'map', 'tae', 'resource']);

function failure(code: ReferenceQueryErrorCode, message: string, field?: string): ReferenceQueryDecodeFailure {
  return { ok: false, code, message, ...(field ? { field } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Finite safe integer within [min,max]; rejects Number(''), NaN, Infinity, floats. */
function boundedSafeInteger(
  value: unknown, name: string, min: number, max: number, fallback: number
): { ok: true; value: number } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, value: fallback };
  if (typeof value === 'string') {
    // JSON numbers arrive as numbers; a string here is model-authored and must not be coerced.
    return { ok: false, message: `${name} must be a JSON number, not a string.` };
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return { ok: false, message: `${name} must be a safe integer.` };
  }
  if (value < min || value > max) {
    return { ok: false, message: `${name} must be between ${min} and ${max}.` };
  }
  return { ok: true, value };
}

function requiredSafeInteger(value: unknown, name: string): { ok: true; value: number } | { ok: false; message: string } {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return { ok: false, message: `${name} must be a safe integer.` };
  }
  return { ok: true, value };
}

function optionalNonNegativeInteger(value: unknown, name: string): { ok: true; value?: number } | { ok: false; message: string } {
  if (value === undefined) return { ok: true };
  const parsed = requiredSafeInteger(value, name);
  if (!parsed.ok) return parsed;
  if (parsed.value < 0) return { ok: false, message: `${name} must be non-negative.` };
  return { ok: true, value: parsed.value };
}

function decodeChildChain(value: unknown, name: string): { ok: true; value: string[] } | { ok: false; message: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, message: `${name} must be a non-empty array of non-empty strings.` };
  }
  for (const item of value) {
    if (!nonEmptyString(item)) return { ok: false, message: `${name} entries must be non-empty strings.` };
  }
  return { ok: true, value: [...(value as string[])] };
}

function failSelector(message: string): ReferenceQueryDecodeFailure {
  return failure('REFERENCE_INVALID_INPUT', message, 'target');
}

function decodeTargetSelector(raw: unknown): { ok: true; target: ReferenceTargetSelector } | ReferenceQueryDecodeFailure {
  if (!isRecord(raw)) return failSelector('target must be a structured selector object, not a scalar or array.');
  const keys = Object.keys(raw);
  if (keys.includes('objectHandle')) {
    if (keys.length !== 1) return failSelector('objectHandle selector must not carry additional properties.');
    if (!nonEmptyString(raw.objectHandle)) return failSelector('objectHandle must be a non-empty string.');
    return { ok: true, target: { objectHandle: raw.objectHandle } };
  }
  const domain = raw.domain;
  if (typeof domain !== 'string' || !REFERENCE_DOMAINS.has(domain)) {
    return failSelector(`target.domain must be one of ${[...REFERENCE_DOMAINS].join(', ')}.`);
  }
  const allowed = SELECTOR_KEYS[domain]!;
  for (const key of keys) {
    if (!allowed.has(key)) return failSelector(`target.${key} is not a known field for domain '${domain}'.`);
  }
  if (!nonEmptyString(raw.sourceUri)) return failSelector('target.sourceUri must be a non-empty string.');
  const sourceUri = raw.sourceUri;

  if (domain === 'param') {
    const entryIndex = optionalNonNegativeInteger(raw.entryIndex, 'entryIndex');
    // entryIndex is required for param: rowIndex-less addressing must still pin the physical entry.
    if (!entryIndex.ok || entryIndex.value === undefined) {
      return failSelector(entryIndex.ok ? 'target.entryIndex is required for param selectors.' : entryIndex.message);
    }
    const rowId = requiredSafeInteger(raw.rowId, 'rowId');
    if (!rowId.ok) return failSelector(rowId.message);
    const rowIndex = optionalNonNegativeInteger(raw.rowIndex, 'rowIndex');
    if (!rowIndex.ok) return failSelector(rowIndex.message);
    if (raw.entryName !== undefined && !nonEmptyString(raw.entryName)) return failSelector('entryName must be a non-empty string.');
    return {
      ok: true,
      target: {
        domain, sourceUri,
        entryIndex: entryIndex.value, rowId: rowId.value,
        ...(raw.entryName !== undefined ? { entryName: raw.entryName as string } : {}),
        ...(rowIndex.value !== undefined ? { rowIndex: rowIndex.value } : {})
      }
    };
  }

  if (domain === 'emevd') {
    const eventId = requiredSafeInteger(raw.eventId, 'eventId');
    if (!eventId.ok) return failSelector(eventId.message);
    return { ok: true, target: { domain, sourceUri, eventId: eventId.value } };
  }

  if (domain === 'fmg') {
    const chain = decodeChildChain(raw.childChain, 'childChain');
    if (!chain.ok) return failSelector(chain.message);
    if (!nonEmptyString(raw.category)) return failSelector('category must be a non-empty string.');
    const textId = requiredSafeInteger(raw.textId, 'textId');
    if (!textId.ok) return failSelector(textId.message);
    const entryIndex = optionalNonNegativeInteger(raw.entryIndex, 'entryIndex');
    if (!entryIndex.ok) return failSelector(entryIndex.message);
    if (raw.language !== undefined && !nonEmptyString(raw.language)) return failSelector('language must be a non-empty string.');
    return {
      ok: true,
      target: {
        domain, sourceUri, childChain: chain.value,
        category: raw.category, textId: textId.value,
        ...(raw.language !== undefined ? { language: raw.language as string } : {}),
        ...(entryIndex.value !== undefined ? { entryIndex: entryIndex.value } : {})
      }
    };
  }

  if (domain === 'script') {
    const chain = decodeChildChain(raw.childChain, 'childChain');
    if (!chain.ok) return failSelector(chain.message);
    const scriptEntryIndex = optionalNonNegativeInteger(raw.scriptEntryIndex, 'scriptEntryIndex');
    if (!scriptEntryIndex.ok) return failSelector(scriptEntryIndex.message);
    return {
      ok: true,
      target: {
        domain, sourceUri, childChain: chain.value,
        ...(scriptEntryIndex.value !== undefined ? { scriptEntryIndex: scriptEntryIndex.value } : {})
      }
    };
  }

  if (domain === 'map') {
    if (!nonEmptyString(raw.nativeObjectKey)) return failSelector('nativeObjectKey must be a non-empty string.');
    return { ok: true, target: { domain, sourceUri, nativeObjectKey: raw.nativeObjectKey } };
  }

  if (domain === 'tae') {
    const chain = decodeChildChain(raw.childChain, 'childChain');
    if (!chain.ok) return failSelector(chain.message);
    const taeEntryIndex = optionalNonNegativeInteger(raw.taeEntryIndex, 'taeEntryIndex');
    if (!taeEntryIndex.ok || taeEntryIndex.value === undefined) {
      return failSelector(taeEntryIndex.ok ? 'taeEntryIndex is required for tae selectors.' : taeEntryIndex.message);
    }
    const animId = requiredSafeInteger(raw.animId, 'animId');
    if (!animId.ok) return failSelector(animId.message);
    const eventIndex = optionalNonNegativeInteger(raw.eventIndex, 'eventIndex');
    if (!eventIndex.ok) return failSelector(eventIndex.message);
    return {
      ok: true,
      target: {
        domain, sourceUri, childChain: chain.value,
        taeEntryIndex: taeEntryIndex.value, animId: animId.value,
        ...(eventIndex.value !== undefined ? { eventIndex: eventIndex.value } : {})
      }
    };
  }

  // resource
  const chain = decodeChildChain(raw.childChain, 'childChain');
  if (!chain.ok) return failSelector(chain.message);
  if (raw.nativeObjectKey !== undefined && !nonEmptyString(raw.nativeObjectKey)) {
    return failSelector('nativeObjectKey must be a non-empty string.');
  }
  return {
    ok: true,
    target: {
      domain: 'resource' as const, sourceUri, childChain: chain.value,
      ...(raw.nativeObjectKey !== undefined ? { nativeObjectKey: raw.nativeObjectKey as string } : {})
    }
  };
}

/**
 * Strict decode of a model-authored `find_references` argument object.
 *
 * First requests must carry exactly one of uri / target / query.
 * Cursor continuations must not re-declare a target entry (host compares the
 * remaining scope against the stored query and rejects mismatches).
 */
export function decodeReferenceQueryInput(raw: unknown): ReferenceQueryDecodeResult {
  if (!isRecord(raw)) {
    return failure('REFERENCE_INVALID_INPUT', 'find_references arguments must be a JSON object.');
  }
  for (const key of Object.keys(raw)) {
    if (!QUERY_TOP_LEVEL_KEYS.has(key)) {
      return failure('REFERENCE_INVALID_INPUT', `Unknown find_references argument '${key}'.`, key);
    }
  }

  const hasUri = raw.uri !== undefined;
  const hasTarget = raw.target !== undefined;
  const hasQuery = raw.query !== undefined;
  const hasCursor = nonEmptyString(raw.cursor);

  if (hasCursor) {
    if (hasUri || hasTarget || hasQuery) {
      return failure('REFERENCE_CURSOR_SCOPE_MISMATCH',
        'A cursor continuation must not re-declare uri/target/query; omit them or start a fresh query.');
    }
  } else {
    const entries = [hasUri, hasTarget, hasQuery].filter(Boolean).length;
    if (entries === 0) {
      return failure('REFERENCE_TARGET_REQUIRED',
        'find_references requires exactly one of uri, target or query.');
    }
    if (entries > 1) {
      return failure('REFERENCE_TARGET_CONFLICT',
        'uri, target and query are mutually exclusive; provide exactly one.');
    }
  }

  const normalized: NormalizedReferenceQuery = {
    direction: 'both',
    detail: 'context',
    depth: REFERENCE_DEPTH_DEFAULT,
    limit: REFERENCE_LIMIT_DEFAULT,
    includeHypotheses: false,
    cursorScopeCheckRequired: hasCursor
  };

  if (hasUri) {
    if (!nonEmptyString(raw.uri)) return failure('REFERENCE_INVALID_INPUT', 'uri must be a non-empty string.', 'uri');
    normalized.uri = raw.uri.trim();
  }
  if (hasQuery) {
    if (!nonEmptyString(raw.query)) return failure('REFERENCE_INVALID_INPUT', 'query must be a non-empty string.', 'query');
    normalized.query = raw.query.trim();
  }
  if (hasTarget) {
    const decoded = decodeTargetSelector(raw.target);
    if (!decoded.ok) return decoded;
    normalized.target = decoded.target;
  }
  if (raw.domain !== undefined) {
    if (!nonEmptyString(raw.domain)) return failure('REFERENCE_INVALID_INPUT', 'domain must be a non-empty string.', 'domain');
    if (!normalized.query) {
      return failure('REFERENCE_INVALID_INPUT', 'domain only qualifies a query; it cannot narrow uri or target.', 'domain');
    }
    normalized.domain = raw.domain.trim();
  }
  if (raw.direction !== undefined) {
    if (raw.direction !== 'from' && raw.direction !== 'to' && raw.direction !== 'both') {
      return failure('REFERENCE_INVALID_INPUT', 'direction must be from, to or both.', 'direction');
    }
    normalized.direction = raw.direction;
  }
  if (raw.detail !== undefined) {
    if (raw.detail !== 'edges' && raw.detail !== 'context') {
      return failure('REFERENCE_INVALID_INPUT', 'detail must be edges or context.', 'detail');
    }
    normalized.detail = raw.detail;
  }
  if (raw.fieldIds !== undefined) {
    if (!Array.isArray(raw.fieldIds) || raw.fieldIds.length === 0) {
      return failure('REFERENCE_INVALID_INPUT', 'fieldIds must be a non-empty array when provided; an empty array is not a whole-table read.', 'fieldIds');
    }
    if (!normalized.target || !('domain' in normalized.target) || normalized.target.domain !== 'param') {
      return failure('REFERENCE_INVALID_INPUT', 'fieldIds is only valid on a param root target.', 'fieldIds');
    }
    for (const item of raw.fieldIds) {
      if (!nonEmptyString(item)) return failure('REFERENCE_INVALID_INPUT', 'fieldIds entries must be non-empty strings.', 'fieldIds');
    }
    normalized.fieldIds = [...(raw.fieldIds as string[])];
  }
  const depth = boundedSafeInteger(raw.depth, 'depth', REFERENCE_DEPTH_MIN, REFERENCE_DEPTH_MAX, REFERENCE_DEPTH_DEFAULT);
  if (!depth.ok) return failure('REFERENCE_INVALID_INPUT', depth.message, 'depth');
  normalized.depth = depth.value;
  const limit = boundedSafeInteger(raw.limit, 'limit', REFERENCE_LIMIT_MIN, REFERENCE_LIMIT_MAX, REFERENCE_LIMIT_DEFAULT);
  if (!limit.ok) return failure('REFERENCE_INVALID_INPUT', limit.message, 'limit');
  normalized.limit = limit.value;
  if (raw.includeHypotheses !== undefined) {
    if (typeof raw.includeHypotheses !== 'boolean') {
      return failure('REFERENCE_INVALID_INPUT', 'includeHypotheses must be a boolean.', 'includeHypotheses');
    }
    normalized.includeHypotheses = raw.includeHypotheses;
  }
  if (hasCursor) normalized.cursor = (raw.cursor as string).trim();

  return { ok: true, input: normalized };
}

/* ------------------------------------------------------------------ */
/* Reference page output DTOs (§3.2)                                   */
/* ------------------------------------------------------------------ */

export interface ReferenceSourceVersionDto {
  sourceUri: string;
  outerFileHash?: string;
  payloadHash?: string;
  sourceRevision?: number;
  readerSchemaVersion?: string | number;
  metadataSchemaVersion?: string | number;
  generation?: number;
}

/** Full stable identity of one object; never derived from display names alone. */
export interface ReferenceObjectIdentity {
  workspaceId: string;
  domain: string;
  sourceUri: string;
  childChain?: string[];
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
  /** Host-issued lookup key only; not a proof of anything. */
  objectHandle?: string;
  label?: string;
}

export interface ReferenceStatementLocation {
  instructionIndex?: number;
  instructionBank?: number;
  instructionId?: number;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  byteRange?: [number, number];
  fieldId?: string;
}

export interface ReferenceStatementDto {
  kind: ReferenceStatementKind;
  text: string;
  truncated?: boolean;
  location?: ReferenceStatementLocation;
}

export interface ReferenceFieldFactDto {
  fieldId: string;
  value: string | number | boolean | null;
  rowId?: number;
  rowIndex?: number;
  dataHash?: string;
  /** Metadata rule that made this field a reference (e.g. parsed Refs fragment). */
  metadataRule?: string;
  conditionField?: string;
  conditionValue?: number;
}

export interface ReferenceEvidenceDto {
  sourceUri: string;
  sourceVersion?: ReferenceSourceVersionDto;
  statement?: ReferenceStatementDto;
  fieldFact?: ReferenceFieldFactDto;
  /** Native addressing kept for host-side proof; path-sanitized for display. */
  nativeLocation?: Record<string, unknown>;
}

export interface ReferencePathHop {
  from: ReferenceObjectIdentity;
  relationKind: ReferenceRelationKind;
  certainty: ReferenceCertainty;
}

export interface ReferenceRelationItem {
  relationId: string;
  from: ReferenceObjectIdentity;
  to: ReferenceObjectIdentity;
  relationKind: ReferenceRelationKind;
  certainty: ReferenceCertainty;
  evidence: ReferenceEvidenceDto[];
  path: ReferencePathHop[];
  /** Explicit heuristic rule name; required when certainty is hypothesis. */
  ruleName?: string;
  /** Whether the referenced native target currently exists. */
  targetStatus?: 'present' | 'missing' | 'ambiguous' | 'unverified';
}

export interface ReferenceCandidateDto {
  identity: ReferenceObjectIdentity;
  discriminators: Record<string, unknown>;
}

export interface ReferenceTargetReadFieldDto {
  fieldId: string;
  value: string | number | boolean | null;
  rowId?: number;
  rowIndex?: number;
  dataHash?: string;
}

export interface ReferenceTargetReadDto {
  fields: ReferenceTargetReadFieldDto[];
  completeness: 'complete' | 'windowed' | 'summary_only' | 'partial';
  /** Requested field ids that were not present in the indexed projection. */
  missingFieldIds?: string[];
}

export interface ReferenceContextDto {
  target?: ReferenceObjectIdentity;
  statements: ReferenceStatementDto[];
  evidence: ReferenceEvidenceDto[];
}

export interface ReferenceDomainCoverageDto {
  domain: string;
  status: 'complete' | 'partial' | 'unscanned' | 'not_indexed' | 'unknown';
  discoveredSources: number;
  readSuccessSources: number;
  parsedSuccessSources: number;
  unscannedSources: string[];
  failedSources: string[];
}

export interface ReferenceCoverageDto {
  scope: string;
  status: 'complete' | 'partial' | 'unscanned' | 'not_indexed' | 'unknown';
  domains: ReferenceDomainCoverageDto[];
  predicateComplete: boolean;
  /** Only true when a complete-scope exhaustive predicate allows a negative conclusion. */
  negativeConclusionAllowed: boolean;
}

export interface DependencySummaryEntry {
  sourceKey: string;
  outerFileHash?: string;
  payloadHash?: string;
  sourceRevision?: number;
  generation?: number;
}

export interface DependencySummaryDto {
  catalogGeneration: number;
  readerSchemaVersion?: string | number;
  metadataSchemaVersion?: string | number;
  entries: DependencySummaryEntry[];
}

export interface ReferencePageDto {
  returnedCount: number;
  hasMore: boolean;
  nextCursor?: string;
  truncationReason?: string;
  dependencySummary?: DependencySummaryDto;
}

export interface ReferenceDiagnosticDto {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  sourceUri?: string;
}

export interface ReferenceNextActionDto {
  tool: string;
  args: Record<string, unknown>;
  reason: string;
}

/** The `data.record` payload of a find_references envelope. */
export interface ReferencePageRecord {
  resolution: ReferenceResolution;
  detail?: ReferenceDetail;
  target?: ReferenceObjectIdentity;
  candidates?: ReferenceCandidateDto[];
  targetRead?: ReferenceTargetReadDto;
  context?: ReferenceContextDto;
  relations: ReferenceRelationItem[];
  coverage: ReferenceCoverageDto;
  page: ReferencePageDto;
  diagnostics: ReferenceDiagnosticDto[];
  nextActions: ReferenceNextActionDto[];
}
