import { createHash } from 'node:crypto';
import type { RagChunk, RagChunkFamily, RagCorpus } from '@soulforge/shared';
import { RAG_CHUNK_FAMILIES } from '@soulforge/shared';

export type RetrievalVersion = string | number;

/**
 * The host supplies the workspace identity and the outer authorization.  A
 * model may narrow these values, but it cannot use this object to widen them.
 * The loose string arrays are intentional: this is also the boundary for
 * untrusted tool input, and normalizeRetrievalScope validates them at runtime.
 */
export interface RetrievalScopeInput {
  workspaceId?: string;
  families?: readonly string[];
  resourceUris?: readonly string[];
  sourceUris?: readonly string[];
  resourceKinds?: readonly string[];
  resourceKind?: string;
  relativePaths?: readonly string[];
  sourceUriPrefixes?: readonly string[];
  resourceUriPrefixes?: readonly string[];
  game?: string;
  profile?: string;
  language?: string;
  revision?: RetrievalVersion;
  revisions?: readonly RetrievalVersion[];
  stalePolicy?: 'exclude' | 'allow' | string;
  allowStale?: boolean;
  readerSchema?: string;
  metadataSchema?: string;
  embeddingModel?: string;
  embeddingProfile?: string;
  corpusRevision?: string;
}

export interface RetrievalScopeAuthorization {
  workspaceId: string;
  families?: readonly RagChunkFamily[];
  resourceUris?: readonly string[];
  resourceKinds?: readonly string[];
  relativePaths?: readonly string[];
  sourceUriPrefixes?: readonly string[];
  game?: string;
  profile?: string;
  language?: string;
  revision?: RetrievalVersion;
  revisions?: readonly RetrievalVersion[];
}

export interface NormalizedRetrievalScope {
  readonly workspaceId: string;
  readonly families: ReadonlySet<RagChunkFamily>;
  readonly resourceUris?: ReadonlySet<string>;
  readonly resourceKinds?: ReadonlySet<string>;
  readonly relativePaths?: ReadonlySet<string>;
  readonly sourceUriPrefixes?: readonly string[];
  readonly game?: string;
  readonly profile?: string;
  readonly language?: string;
  readonly revision?: RetrievalVersion;
  readonly revisions?: ReadonlySet<RetrievalVersion>;
  /** Stale chunks are always rejected; this is deliberately not caller-overridable. */
  readonly stalePolicy: 'exclude';
  readonly readerSchema?: string;
  readonly metadataSchema?: string;
  readonly embeddingModel?: string;
  readonly embeddingProfile?: string;
  readonly corpusRevision?: string;
  readonly key: string;
}

export class RetrievalScopeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RetrievalScopeError';
    this.code = code;
  }
}

/**
 * Normalize the one scope used by lexical lookup, vector lookup, exact
 * matching, and reference expansion.  The array overload mirrors the small
 * reference algorithm and is useful for direct algorithm tests.
 */
export function normalizeRetrievalScope(
  input: RetrievalScopeInput | undefined,
  authorization?: RetrievalScopeAuthorization | readonly RagChunkFamily[],
  expectedWorkspaceId?: string
): NormalizedRetrievalScope {
  const value = input ?? {};
  const outer: RetrievalScopeAuthorization | undefined = Array.isArray(authorization)
    ? ({ workspaceId: expectedWorkspaceId ?? value.workspaceId ?? '', families: authorization } as RetrievalScopeAuthorization)
    : authorization as RetrievalScopeAuthorization | undefined;
  const hostWorkspaceId = expectedWorkspaceId ?? outer?.workspaceId ?? value.workspaceId;
  const workspaceId = nonEmptyString(hostWorkspaceId, 'INVALID_SCOPE_WORKSPACE');
  if (value.workspaceId !== undefined && value.workspaceId !== workspaceId) {
    throw new RetrievalScopeError(
      'INVALID_SCOPE_WORKSPACE',
      '检索 scope 的 workspaceId 不能扩大或改写宿主注入的工作区身份。'
    );
  }

  const allFamilies = [...(outer?.families ?? RAG_CHUNK_FAMILIES)];
  const allowedFamilies = new Set<RagChunkFamily>();
  for (const family of allFamilies) {
    if (!RAG_CHUNK_FAMILIES.includes(family)) {
      throw new RetrievalScopeError('INVALID_FAMILY_FILTER', `授权 family 不受支持：${String(family)}`);
    }
    allowedFamilies.add(family);
  }
  const families = normalizeFamilies(value.families, allowedFamilies);

  const resourceUris = normalizeOptionalSet(
    mergeAliases(value.resourceUris, value.sourceUris),
    outer?.resourceUris,
    'INVALID_RESOURCE_FILTER'
  );
  const resourceKinds = normalizeOptionalSet(value.resourceKinds ?? (value.resourceKind ? [value.resourceKind] : undefined), outer?.resourceKinds, 'INVALID_RESOURCE_FILTER');
  const relativePaths = normalizeOptionalSet(value.relativePaths, outer?.relativePaths, 'INVALID_RESOURCE_FILTER');
  const sourceUriPrefixes = normalizeOptionalStrings(
    mergeAliases(value.sourceUriPrefixes, value.resourceUriPrefixes),
    outer?.sourceUriPrefixes,
    'INVALID_RESOURCE_FILTER'
  );

  const game = normalizeScopedString(value.game, outer?.game, 'INVALID_SCOPE_GAME');
  const profile = normalizeScopedString(value.profile, outer?.profile, 'INVALID_SCOPE_PROFILE');
  const language = normalizeScopedString(value.language, outer?.language, 'INVALID_SCOPE_LANGUAGE');
  const revisions = normalizeRevisions(value, outer);

  if (value.allowStale === true || (value.stalePolicy !== undefined && value.stalePolicy !== 'exclude')) {
    throw new RetrievalScopeError('INVALID_STALE_POLICY', 'RAG 检索 scope 不允许放行 stale 证据。');
  }

  const normalized: Omit<NormalizedRetrievalScope, 'key'> = {
    workspaceId,
    families,
    ...(resourceUris ? { resourceUris } : {}),
    ...(resourceKinds ? { resourceKinds } : {}),
    ...(relativePaths ? { relativePaths } : {}),
    ...(sourceUriPrefixes ? { sourceUriPrefixes } : {}),
    ...(game ? { game } : {}),
    ...(profile ? { profile } : {}),
    ...(language ? { language } : {}),
    ...(revisions.revision !== undefined ? { revision: revisions.revision } : {}),
    ...(revisions.revisions ? { revisions: revisions.revisions } : {}),
    stalePolicy: 'exclude',
    ...(value.readerSchema !== undefined ? { readerSchema: nonEmptyString(value.readerSchema, 'INVALID_SCHEMA') } : {}),
    ...(value.metadataSchema !== undefined ? { metadataSchema: nonEmptyString(value.metadataSchema, 'INVALID_SCHEMA') } : {}),
    ...(value.embeddingModel !== undefined ? { embeddingModel: nonEmptyString(value.embeddingModel, 'INVALID_EMBEDDING_MODEL') } : {}),
    ...(value.embeddingProfile !== undefined ? { embeddingProfile: nonEmptyString(value.embeddingProfile, 'INVALID_EMBEDDING_PROFILE') } : {}),
    ...(value.corpusRevision !== undefined ? { corpusRevision: nonEmptyString(value.corpusRevision, 'INVALID_CORPUS_REVISION') } : {})
  };
  return { ...normalized, key: scopeKey(normalized) };
}

/** Short alias retained for callers that mirror the reference algorithm. */
export const normalizeScope = normalizeRetrievalScope;

/** The one hard predicate shared by every retrieval branch. */
export function isChunkEligible(chunk: RagChunk, scope: NormalizedRetrievalScope): boolean {
  if (chunk.workspaceId !== scope.workspaceId) return false;
  if (!scope.families.has(chunk.family)) return false;

  const record = chunk as RagChunk & Record<string, unknown>;
  if (record.stale === true || record.isStale === true || record.staleState === 'stale') return false;

  const chunkRevision = chunkRevisionOf(chunk);
  if (scope.revision !== undefined && chunkRevision !== scope.revision) return false;
  if (scope.revisions && (chunkRevision === undefined || !scope.revisions.has(chunkRevision))) return false;

  if (scope.resourceUris
    && !scope.resourceUris.has(chunk.sourceUri)
    && !scope.resourceUris.has(chunk.symbolUri)) return false;
  if (scope.resourceKinds && (!chunk.resourceKind || !scope.resourceKinds.has(chunk.resourceKind))) return false;
  if (scope.relativePaths && (!chunk.relativePath || !scope.relativePaths.has(chunk.relativePath))) return false;
  if (scope.sourceUriPrefixes && !scope.sourceUriPrefixes.some((prefix) => chunk.sourceUri.startsWith(prefix))) return false;

  if (scope.game !== undefined && readString(record, ['game', 'gameId']) !== scope.game) return false;
  if (scope.profile !== undefined
    && readString(record, ['profile', 'formatProfile', 'metadataProfile', 'embeddingProfile']) !== scope.profile) return false;
  if (scope.language !== undefined && readString(record, ['language', 'locale']) !== scope.language) return false;
  return true;
}

/** Short alias retained for direct algorithm tests. */
export const eligible = isChunkEligible;

export function chunkRevisionOf(chunk: RagChunk): RetrievalVersion | undefined {
  if (chunk.sourceRevision !== undefined) return chunk.sourceRevision;
  const record = chunk as RagChunk & Record<string, unknown>;
  const revision = record.revision;
  return typeof revision === 'string' || (typeof revision === 'number' && Number.isFinite(revision))
    ? revision
    : undefined;
}

export function retrievalCandidateLimit(finalLimit: number): number {
  if (!Number.isSafeInteger(finalLimit) || finalLimit < 1 || finalLimit > 32) {
    throw new RetrievalScopeError('INVALID_LIMIT', 'finalLimit 必须是 1..32 的安全整数。');
  }
  return Math.min(256, Math.max(64, 4 * finalLimit));
}

export function corpusRevision(corpus: RagCorpus): string {
  const hash = createHash('sha256');
  hash.update(corpus.workspaceId);
  hash.update('\u0000');
  hash.update(corpus.builtAt);
  for (const chunk of [...corpus.chunks].sort((left, right) => compareText(left.chunkId, right.chunkId))) {
    hash.update(JSON.stringify([
      chunk.chunkId,
      chunk.workspaceId,
      chunk.sourceUri,
      chunk.symbolUri,
      chunk.family,
      chunk.contentHash,
      chunk.sourceHash ?? null,
      chunk.sourceRevision ?? null
    ]));
    hash.update('\n');
  }
  for (const edge of [...corpus.references].sort((left, right) => compareText(edgeKey(left), edgeKey(right)))) {
    hash.update(edgeKey(edge));
    hash.update('\n');
  }
  return hash.digest('hex');
}

export interface RetrievalCacheKeyInput {
  query: string;
  scope: NormalizedRetrievalScope;
  corpusRevision: string;
  readerSchema?: string;
  metadataSchema?: string;
  embeddingModel?: string;
  embeddingProfile?: string;
  limit: number;
  candidateLimit: number;
  excerptChars: number;
  expandReferences: boolean;
  mode?: 'lexical' | 'hybrid';
}

export function retrievalCacheKey(input: RetrievalCacheKeyInput): string {
  return JSON.stringify({
    query: input.query.trim().normalize('NFC').toLowerCase(),
    scope: input.scope.key,
    corpusRevision: input.corpusRevision,
    readerSchema: input.readerSchema ?? input.scope.readerSchema ?? null,
    metadataSchema: input.metadataSchema ?? input.scope.metadataSchema ?? null,
    embeddingModel: input.embeddingModel ?? input.scope.embeddingModel ?? null,
    embeddingProfile: input.embeddingProfile ?? input.scope.embeddingProfile ?? null,
    limit: input.limit,
    candidateLimit: input.candidateLimit,
    excerptChars: input.excerptChars,
    expandReferences: input.expandReferences,
    mode: input.mode ?? 'lexical'
  });
}

interface RetrievalCacheEntry {
  workspaceId: string;
  result: unknown;
}

const retrievalCache = new Map<string, RetrievalCacheEntry>();

export function getRetrievalCache<T>(key: string): T | undefined {
  return retrievalCache.get(key)?.result as T | undefined;
}

export function setRetrievalCache(key: string, workspaceId: string, result: unknown): void {
  retrievalCache.set(key, { workspaceId, result });
}

/** Source or schema refreshes invalidate the whole workspace query cache. */
export function invalidateRetrievalCache(workspaceId: string): void {
  for (const [key, entry] of retrievalCache) {
    if (entry.workspaceId === workspaceId) retrievalCache.delete(key);
  }
}

export function clearRetrievalCache(): void {
  retrievalCache.clear();
}

function normalizeFamilies(
  requested: readonly string[] | undefined,
  allowed: ReadonlySet<RagChunkFamily>
): ReadonlySet<RagChunkFamily> {
  if (requested === undefined) return new Set(allowed);
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new RetrievalScopeError('INVALID_FAMILY_FILTER', 'families 显式为空时拒绝放大为全量 family。');
  }
  const selected = new Set<RagChunkFamily>();
  for (const family of requested) {
    if (typeof family !== 'string' || !RAG_CHUNK_FAMILIES.includes(family as RagChunkFamily) || !allowed.has(family as RagChunkFamily)) {
      throw new RetrievalScopeError('INVALID_FAMILY_FILTER', `检索 scope 包含未授权或未知 family：${String(family)}`);
    }
    selected.add(family as RagChunkFamily);
  }
  return selected;
}

function normalizeOptionalSet(
  requested: readonly string[] | undefined,
  authorized: readonly string[] | undefined,
  code: string
): ReadonlySet<string> | undefined {
  if (requested !== undefined && (!Array.isArray(requested) || requested.length === 0)) {
    throw new RetrievalScopeError(code, '资源范围显式为空时拒绝扩大检索范围。');
  }
  const requestedSet = requested === undefined ? undefined : new Set(requested.map((value) => nonEmptyString(value, code)));
  const authorizedSet = authorized === undefined ? undefined : new Set(authorized.map((value) => nonEmptyString(value, code)));
  if (requestedSet && authorizedSet) {
    for (const value of requestedSet) {
      if (!authorizedSet.has(value)) throw new RetrievalScopeError(code, `资源不在宿主授权范围内：${value}`);
    }
  }
  return requestedSet ?? authorizedSet;
}

function normalizeOptionalStrings(
  requested: readonly string[] | undefined,
  authorized: readonly string[] | undefined,
  code: string
): readonly string[] | undefined {
  if (requested !== undefined && (!Array.isArray(requested) || requested.length === 0)) {
    throw new RetrievalScopeError(code, '资源前缀范围显式为空。');
  }
  const values = requested ?? authorized;
  if (values === undefined) return undefined;
  const normalized = [...new Set(values.map((value) => nonEmptyString(value, code)))];
  if (requested && authorized) {
    for (const prefix of normalized) {
      if (!authorized.some((allowed) => prefix.startsWith(allowed))) {
        throw new RetrievalScopeError(code, `资源前缀不在宿主授权范围内：${prefix}`);
      }
    }
  }
  return normalized.sort(compareText);
}

function normalizeScopedString(
  requested: string | undefined,
  authorized: string | undefined,
  code: string
): string | undefined {
  if (requested !== undefined) {
    const value = nonEmptyString(requested, code);
    if (authorized !== undefined && value !== authorized) {
      throw new RetrievalScopeError(code, `scope 值超出宿主授权范围：${value}`);
    }
    return value;
  }
  return authorized === undefined ? undefined : nonEmptyString(authorized, code);
}

function normalizeRevisions(
  input: RetrievalScopeInput,
  authorization: RetrievalScopeAuthorization | undefined
): { revision?: RetrievalVersion; revisions?: ReadonlySet<RetrievalVersion> } {
  if (input.revision !== undefined && input.revisions !== undefined) {
    throw new RetrievalScopeError('INVALID_REVISION_FILTER', 'revision 与 revisions 不能同时指定。');
  }
  const authorizedRevisions = authorization?.revisions;
  const requested = input.revisions ?? (input.revision !== undefined ? [input.revision] : undefined);
  if (requested !== undefined && (!Array.isArray(requested) || requested.length === 0)) {
    throw new RetrievalScopeError('INVALID_REVISION_FILTER', '版本范围不能为空。');
  }
  const values = requested?.map((value) => normalizeVersion(value))
    ?? authorizedRevisions?.map((value) => normalizeVersion(value));
  if (values) {
    const set = new Set(values);
    if (authorizedRevisions) {
      const allowed = new Set(authorizedRevisions.map((value) => normalizeVersion(value)));
      for (const value of set) {
        if (!allowed.has(value)) throw new RetrievalScopeError('INVALID_REVISION_FILTER', `版本不在宿主授权范围内：${String(value)}`);
      }
    }
    if (set.size === 1) {
      const revision = [...set][0];
      if (revision === undefined) throw new RetrievalScopeError('INVALID_REVISION_FILTER', '版本范围为空。');
      return { revision };
    }
    return { revisions: set };
  }
  if (authorization?.revision !== undefined) return { revision: normalizeVersion(authorization.revision) };
  return {};
}

function normalizeVersion(value: RetrievalVersion): RetrievalVersion {
  if (typeof value === 'string') return nonEmptyString(value, 'INVALID_REVISION_FILTER');
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new RetrievalScopeError('INVALID_REVISION_FILTER', '版本必须是非空字符串或有限数字。');
}

function mergeAliases(first: readonly string[] | undefined, second: readonly string[] | undefined): readonly string[] | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return [...first, ...second];
}

function scopeKey(scope: Omit<NormalizedRetrievalScope, 'key'>): string {
  return JSON.stringify({
    workspaceId: scope.workspaceId,
    families: [...scope.families].sort(compareText),
    resourceUris: scope.resourceUris ? [...scope.resourceUris].sort(compareText) : null,
    resourceKinds: scope.resourceKinds ? [...scope.resourceKinds].sort(compareText) : null,
    relativePaths: scope.relativePaths ? [...scope.relativePaths].sort(compareText) : null,
    sourceUriPrefixes: scope.sourceUriPrefixes ?? null,
    game: scope.game ?? null,
    profile: scope.profile ?? null,
    language: scope.language ?? null,
    revision: scope.revision ?? null,
    revisions: scope.revisions ? [...scope.revisions].sort(compareVersion) : null,
    stalePolicy: scope.stalePolicy,
    readerSchema: scope.readerSchema ?? null,
    metadataSchema: scope.metadataSchema ?? null,
    embeddingModel: scope.embeddingModel ?? null,
    embeddingProfile: scope.embeddingProfile ?? null,
    corpusRevision: scope.corpusRevision ?? null
  });
}

function readString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function edgeKey(edge: { fromUri: string; toUri: string; kind: string; confidence: string; reason?: string }): string {
  return JSON.stringify([edge.fromUri, edge.toUri, edge.kind, edge.confidence, edge.reason ?? '']);
}

function nonEmptyString(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RetrievalScopeError(code, 'scope 字段必须是非空字符串。');
  }
  return value.trim();
}

function compareText(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const leftCodePoint = a[index]!.codePointAt(0)!;
    const rightCodePoint = b[index]!.codePointAt(0)!;
    if (leftCodePoint !== rightCodePoint) return leftCodePoint < rightCodePoint ? -1 : 1;
  }
  return a.length - b.length;
}

function compareVersion(left: RetrievalVersion, right: RetrievalVersion): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return compareText(String(left), String(right));
}
