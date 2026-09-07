import type {
  Diagnostic,
  RagChunk,
  RagCorpus,
  RagHit,
  RagRetrieveFailure,
  RagRetrieveOptions,
  RagRetrieveResult,
  ReferenceEdge
} from '@soulforge/shared';
import { parseRagQuery, type ParsedRagQuery } from './queryParse.js';
import {
  collectIndexedCandidates,
  ensureLookupIndex,
  type RagLookupIndex
} from './lookupIndex.js';
import {
  corpusRevision,
  getRetrievalCache,
  isChunkEligible,
  normalizeRetrievalScope,
  retrievalCacheKey,
  retrievalCandidateLimit,
  setRetrievalCache,
  RetrievalScopeError,
  type NormalizedRetrievalScope,
  type RetrievalScopeInput
} from './retrievalScope.js';
import { compareCodePointText, topK } from './topK.js';

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 32;
const DEFAULT_EXCERPT = 420;

export interface Sf18RetrieveOptions extends RagRetrieveOptions {
  /** Scope is supplied by the host and may only be narrowed by the caller. */
  scope?: RetrievalScopeInput | NormalizedRetrievalScope;
  workspaceId?: string;
  resourceUris?: readonly string[];
  sourceUris?: readonly string[];
  resourceKinds?: readonly string[];
  relativePaths?: readonly string[];
  revision?: string | number;
  revisions?: readonly (string | number)[];
  game?: string;
  profile?: string;
  language?: string;
  readerSchema?: string;
  metadataSchema?: string;
  embeddingModel?: string;
  embeddingProfile?: string;
  corpusRevision?: string;
  /** Internal continuation and candidate controls; finalLimit remains strict. */
  cursor?: string;
  candidateLimit?: number;
}

export interface LexicalCandidateSet {
  readonly query: string;
  readonly parsed: ParsedRagQuery;
  readonly corpus: RagCorpus;
  readonly lookup: RagLookupIndex;
  readonly scope: NormalizedRetrievalScope;
  readonly finalLimit: number;
  readonly candidateLimit: number;
  readonly excerptChars: number;
  readonly scopedCandidates: readonly RagChunk[];
  readonly lexicalHits: readonly RagHit[];
  readonly exactHits: readonly RagHit[];
  readonly matched: number;
  readonly diagnostics: readonly Diagnostic[];
}

export type RetrievalPreparation =
  | { ok: true; value: LexicalCandidateSet }
  | { ok: false; result: RagRetrieveResult };

/**
 * The lexical phase is public so the hybrid path can take candidateLimit
 * lexical ranks instead of accidentally fusing a list already truncated to
 * finalLimit.
 */
export function prepareLexicalCandidates(
  corpus: RagCorpus | null | undefined,
  query: string,
  options: Sf18RetrieveOptions = {}
): RetrievalPreparation {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return { ok: false, result: invalidInput('retrieve_evidence 需要非空 query。') };
  }
  if (!corpus) {
    return { ok: false, result: { ok: false, code: 'insufficient_evidence', message: '没有可检索的工作区证据。先打开 Mod 工作区并完成扫描或分析。' } };
  }

  let scope: NormalizedRetrievalScope;
  let finalLimit: number;
  try {
    scope = normalizeScopeForCorpus(corpus, options);
    finalLimit = strictLimit(options.limit);
  } catch (error) {
    return { ok: false, result: invalidInput(scopeErrorMessage(error)) };
  }
  const candidateLimit = retrievalCandidateLimit(finalLimit);
  const excerptChars = clampInt(options.excerptChars, DEFAULT_EXCERPT, 120, 1_200);

  if (corpus.availability !== 'available') {
    const detail = corpus.diagnostics.find((diagnostic) => diagnostic.code === 'RAG_SEMANTIC_CORPUS_EMPTY')?.message
      ?? 'RAG 语义语料不可用。先完成工作区原生分析并确认语义索引非空。';
    return { ok: false, result: { ok: false, code: 'RAG_UNAVAILABLE', message: detail } };
  }
  if (corpus.chunks.length === 0) {
    return { ok: false, result: { ok: false, code: 'insufficient_evidence', message: '没有可检索的工作区证据。先打开 Mod 工作区并完成扫描或分析。' } };
  }

  const parsed = parseRagQuery(trimmed);
  const lookup = ensureLookupIndex(corpus);
  const hasKeys = parsed.numericIds.length + parsed.terms.length + parsed.phrases.length + parsed.uris.length > 0;
  const scopedCandidates = hasKeys
    ? collectIndexedCandidates(corpus.chunks, lookup, parsed, scope)
    : corpus.chunks.filter((chunk) => isChunkEligible(chunk, scope));
  const scored: RagHit[] = [];
  const seenChunkIds = new Set<string>();
  for (const chunk of scopedCandidates) {
    if (seenChunkIds.has(chunk.chunkId)) continue;
    seenChunkIds.add(chunk.chunkId);
    const hit = scoreChunk(chunk, parsed, excerptChars);
    if (hit) scored.push(hit);
  }

  const exactHits = scored
    .filter((hit) => isExactChunkMatch(hit.chunk, parsed))
    .sort((left, right) => compareCodePointText(left.chunk.chunkId, right.chunk.chunkId));
  if (exactHits.length > finalLimit) {
    return {
      ok: false,
      result: exactAmbiguityFailure(trimmed, exactHits, finalLimit)
    };
  }

  const exactIds = new Set(exactHits.map((hit) => hit.chunk.chunkId));
  const rest = topK(
    scored
      .filter((hit) => !exactIds.has(hit.chunk.chunkId))
      .map((hit) => ({ id: hit.chunk.chunkId, score: hit.score, hit })),
    Math.max(0, candidateLimit - exactHits.length)
  ).map((item) => item.hit);
  const lexicalHits = [...exactHits, ...rest];
  const diagnostics: Diagnostic[] = [];
  if (exactHits.length > 1) {
    diagnostics.push({
      severity: 'warning',
      code: 'EXACT_MATCH_AMBIGUOUS',
      message: '多个授权资源满足同一精确身份；已保留全部精确候选，不按相似度替用户选择。',
      details: { candidateIds: exactHits.map((hit) => hit.chunk.chunkId) }
    });
  }

  return {
    ok: true,
    value: {
      query: trimmed,
      parsed,
      corpus,
      lookup,
      scope,
      finalLimit,
      candidateLimit,
      excerptChars,
      scopedCandidates,
      lexicalHits,
      exactHits,
      matched: scored.length,
      diagnostics
    }
  };
}

export function retrieveEvidence(
  corpus: RagCorpus | null | undefined,
  query: string,
  options: Sf18RetrieveOptions = {}
): RagRetrieveResult {
  const prepared = prepareLexicalCandidates(corpus, query, options);
  if (!prepared.ok) return prepared.result;
  const value = prepared.value;
  const cacheKey = retrievalCacheKey({
    query: value.query,
    scope: value.scope,
    corpusRevision: corpusRevision(value.corpus),
    ...(options.readerSchema !== undefined ? { readerSchema: options.readerSchema } : {}),
    ...(options.metadataSchema !== undefined ? { metadataSchema: options.metadataSchema } : {}),
    ...(options.embeddingModel !== undefined ? { embeddingModel: options.embeddingModel } : {}),
    ...(options.embeddingProfile !== undefined ? { embeddingProfile: options.embeddingProfile } : {}),
    limit: value.finalLimit,
    candidateLimit: value.candidateLimit,
    excerptChars: value.excerptChars,
    expandReferences: options.expandReferences !== false,
    mode: 'lexical'
  });
  const cached = getRetrievalCache<RagRetrieveResult>(cacheKey);
  if (cached) return cloneResult(cached);

  const result = finalizeLexicalCandidates(value, options.expandReferences !== false);
  if (result.ok) setRetrievalCache(cacheKey, value.scope.workspaceId, result);
  return result;
}

/** Expand one hop through the cached symbolUri adjacency under the same scope. */
export function expandScopedHits(
  primaryCandidates: readonly RagHit[],
  lexicalCandidates: readonly RagHit[],
  lookup: RagLookupIndex,
  scope: NormalizedRetrievalScope,
  finalLimit: number,
  expandReferences: boolean,
  exactCandidates: readonly RagHit[] = []
): { hits: RagHit[]; expanded: number; outOfScopeEdges: number } {
  if (primaryCandidates.length > finalLimit) {
    throw new RetrievalScopeError('PRIMARY_OVER_LIMIT', 'primary 结果不能超过 finalLimit。');
  }
  if (!primaryCandidates.every((hit) => isChunkEligible(hit.chunk, scope))) {
    throw new RetrievalScopeError('PRIMARY_SCOPE_VIOLATION', 'primary 结果包含 scope 外 chunk。');
  }

  const expansionBudget = expandReferences && finalLimit > 3
    ? Math.min(2, Math.floor(finalLimit / 4))
    : 0;
  const exactCount = countExactPrimary(primaryCandidates, exactCandidates);
  const primaryTarget = Math.min(finalLimit, Math.max(exactCount, finalLimit - expansionBudget));
  const result = [...primaryCandidates.slice(0, primaryTarget)];
  const seen = new Set(result.map((hit) => hit.chunk.chunkId));
  let expanded = 0;
  let outOfScopeEdges = 0;

  if (expansionBudget > 0) {
    for (const hit of result.slice()) {
      const edges = lookup.adjacency.get(hit.chunk.symbolUri) ?? [];
      for (const edge of edges) {
        if (expanded >= expansionBudget || result.length >= finalLimit) break;
        const relatedChunks = lookup.bySymbolUriAll.get(edge.otherUri) ?? [];
        if (relatedChunks.length === 0) continue;
        for (const related of [...relatedChunks].sort((left, right) => compareCodePointText(left.chunkId, right.chunkId))) {
          if (seen.has(related.chunkId)) continue;
          if (!isChunkEligible(related, scope)) {
            outOfScopeEdges += 1;
            continue;
          }
          seen.add(related.chunkId);
          result.push({
            chunk: related,
            score: Math.max(1, Math.round(hit.score * expansionWeight(edge.confidence))),
            reasons: [`expanded:${edge.kind}:${edge.confidence}`],
            excerpt: excerptOf(related.body, 420),
            expandedFrom: hit.chunk.symbolUri
          });
          expanded += 1;
          break;
        }
      }
      if (expanded >= expansionBudget || result.length >= finalLimit) break;
    }
  }

  // If the reserved expansion slots could not be filled, use the next primary
  // candidates.  This keeps expansion from reducing recall while preserving
  // all exact candidates already pinned at the front.
  for (const candidate of lexicalCandidates) {
    if (result.length >= finalLimit) break;
    if (seen.has(candidate.chunk.chunkId)) continue;
    if (!isChunkEligible(candidate.chunk, scope)) continue;
    seen.add(candidate.chunk.chunkId);
    result.push(candidate);
  }
  if (result.length > finalLimit) throw new RetrievalScopeError('RESULT_OVER_LIMIT', '引用扩展结果超过 finalLimit。');
  return { hits: result, expanded, outOfScopeEdges };
}

export function finalizeLexicalCandidates(value: LexicalCandidateSet, expandReferences: boolean): RagRetrieveResult {
  try {
    const primary = value.lexicalHits.slice(0, value.finalLimit);
    const expansion = expandScopedHits(
      primary,
      value.lexicalHits,
      value.lookup,
      value.scope,
      value.finalLimit,
      expandReferences,
      value.exactHits
    );
    if (expansion.hits.length === 0) {
      return { ok: false, code: 'insufficient_evidence', message: `查询「${value.query}」没有命中已索引的事件、地图、参数、文本或文件。` };
    }
    const diagnostics = [...value.diagnostics];
    if (expansion.outOfScopeEdges > 0) {
      diagnostics.push({
        severity: 'info',
        code: 'RAG_REFERENCE_OUT_OF_SCOPE',
        message: '存在引用邻接，但越出当前授权 scope 的内容未进入结果。',
        details: { count: expansion.outOfScopeEdges }
      });
    }
    return {
      ok: true,
      query: value.query,
      hits: expansion.hits,
      retrievalMode: 'lexical',
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
      stats: {
        scanned: value.scopedCandidates.length,
        matched: value.matched,
        expanded: expansion.expanded,
        truncated: value.matched > value.lexicalHits.length || value.lexicalHits.length > expansion.hits.length
      }
    };
  } catch (error) {
    return invalidInput(scopeErrorMessage(error));
  }
}

function normalizeScopeForCorpus(corpus: RagCorpus, options: Sf18RetrieveOptions): NormalizedRetrievalScope {
  const nested = options.scope;
  const input: RetrievalScopeInput = isNormalizedScope(nested)
    ? normalizedScopeToInput(nested)
    : { ...(nested ?? {}) };
  if (options.workspaceId !== undefined) input.workspaceId = options.workspaceId;
  if (options.families !== undefined) input.families = options.families;
  if (options.resourceUris !== undefined) input.resourceUris = options.resourceUris;
  if (options.sourceUris !== undefined) input.sourceUris = options.sourceUris;
  if (options.resourceKinds !== undefined) input.resourceKinds = options.resourceKinds;
  if (options.relativePaths !== undefined) input.relativePaths = options.relativePaths;
  if (options.revision !== undefined) input.revision = options.revision;
  if (options.revisions !== undefined) input.revisions = options.revisions;
  if (options.game !== undefined) input.game = options.game;
  if (options.profile !== undefined) input.profile = options.profile;
  if (options.language !== undefined) input.language = options.language;
  if (options.readerSchema !== undefined) input.readerSchema = options.readerSchema;
  if (options.metadataSchema !== undefined) input.metadataSchema = options.metadataSchema;
  if (options.embeddingModel !== undefined) input.embeddingModel = options.embeddingModel;
  if (options.embeddingProfile !== undefined) input.embeddingProfile = options.embeddingProfile;
  if (options.corpusRevision !== undefined) input.corpusRevision = options.corpusRevision;
  return normalizeRetrievalScope(input, { workspaceId: corpus.workspaceId });
}

function normalizedScopeToInput(scope: NormalizedRetrievalScope): RetrievalScopeInput {
  return {
    workspaceId: scope.workspaceId,
    families: [...scope.families],
    ...(scope.resourceUris ? { resourceUris: [...scope.resourceUris] } : {}),
    ...(scope.resourceKinds ? { resourceKinds: [...scope.resourceKinds] } : {}),
    ...(scope.relativePaths ? { relativePaths: [...scope.relativePaths] } : {}),
    ...(scope.sourceUriPrefixes ? { sourceUriPrefixes: [...scope.sourceUriPrefixes] } : {}),
    ...(scope.game !== undefined ? { game: scope.game } : {}),
    ...(scope.profile !== undefined ? { profile: scope.profile } : {}),
    ...(scope.language !== undefined ? { language: scope.language } : {}),
    ...(scope.revision !== undefined ? { revision: scope.revision } : {}),
    ...(scope.revisions ? { revisions: [...scope.revisions] } : {}),
    stalePolicy: scope.stalePolicy,
    ...(scope.readerSchema !== undefined ? { readerSchema: scope.readerSchema } : {}),
    ...(scope.metadataSchema !== undefined ? { metadataSchema: scope.metadataSchema } : {}),
    ...(scope.embeddingModel !== undefined ? { embeddingModel: scope.embeddingModel } : {}),
    ...(scope.embeddingProfile !== undefined ? { embeddingProfile: scope.embeddingProfile } : {}),
    ...(scope.corpusRevision !== undefined ? { corpusRevision: scope.corpusRevision } : {})
  };
}

function isNormalizedScope(value: RetrievalScopeInput | NormalizedRetrievalScope | undefined): value is NormalizedRetrievalScope {
  return !!value && value.families instanceof Set && typeof (value as NormalizedRetrievalScope).key === 'string';
}

function isExactChunkMatch(chunk: RagChunk, query: ParsedRagQuery): boolean {
  const lowerSource = chunk.sourceUri.toLowerCase();
  const lowerSymbol = chunk.symbolUri.toLowerCase();
  if (query.uris.some((uri) => uri.toLowerCase() === lowerSource || uri.toLowerCase() === lowerSymbol)) return true;
  return query.numericIds.some((id) => chunk.numericIds.includes(id));
}

function scoreChunk(chunk: RagChunk, query: ParsedRagQuery, excerptChars: number): RagHit | null {
  let score = 0;
  const reasons: string[] = [];
  const hayTitle = chunk.title.toLowerCase();
  const hayBody = chunk.body.toLowerCase();
  const hayUri = `${chunk.sourceUri} ${chunk.symbolUri}`.toLowerCase();

  for (const id of query.numericIds) {
    if (chunk.numericIds.includes(id)) {
      score += 200;
      reasons.push(`id:${id}`);
    } else if (hayTitle.includes(String(id)) || hayBody.includes(String(id))) {
      score += 40;
      reasons.push(`id-text:${id}`);
    } else if (chunk.numericIds.some((candidate) => isIdPrefixMatch(id, candidate))) {
      score += 25;
      reasons.push(`id-prefix:${id}`);
    }
  }

  for (const uri of query.uris) {
    const needle = uri.toLowerCase();
    if (chunk.sourceUri.toLowerCase() === needle || chunk.symbolUri.toLowerCase() === needle) {
      score += 180;
      reasons.push('uri-exact');
    } else if (hayUri.includes(needle)) {
      score += 60;
      reasons.push('uri-partial');
    }
  }

  for (const phrase of query.phrases) {
    const needle = phrase.toLowerCase();
    if (hayTitle.includes(needle)) {
      score += 50;
      reasons.push('phrase-title');
    } else if (hayBody.includes(needle)) {
      score += 25;
      reasons.push('phrase-body');
    }
  }

  let termsMatched = 0;
  for (const term of query.terms) {
    if (hayTitle === term) {
      score += 100;
      termsMatched += 1;
      reasons.push(`term-exact:${term}`);
    } else if (hayTitle.startsWith(term)) {
      score += 40;
      termsMatched += 1;
      reasons.push(`term-prefix:${term}`);
    } else if (hayTitle.includes(term)) {
      score += 20;
      termsMatched += 1;
      reasons.push(`term-title:${term}`);
    } else if (hayBody.includes(term)) {
      score += 12;
      termsMatched += 1;
      reasons.push(`term-body:${term}`);
    }
  }

  const structured = reasons.some((reason) =>
    reason.startsWith('id:') || reason.startsWith('uri-') || reason.startsWith('phrase-')
  );
  if (query.terms.length > 1 && termsMatched < Math.ceil(query.terms.length / 2) && !structured) return null;
  if (score <= 0) return null;
  return {
    chunk,
    score,
    reasons,
    excerpt: excerptAround(chunk.body, firstNeedle(query), excerptChars)
  };
}

function isIdPrefixMatch(queryId: number, candidate: number): boolean {
  if (queryId <= 0 || candidate <= 0) return false;
  const queryText = String(queryId);
  const candidateText = String(candidate);
  if (candidateText.length - queryText.length > 2 || candidateText.length <= queryText.length) return false;
  return candidateText.startsWith(queryText);
}

function countExactPrimary(primary: readonly RagHit[], exact: readonly RagHit[]): number {
  const primaryIds = new Set(primary.map((hit) => hit.chunk.chunkId));
  return exact.reduce((count, hit) => count + (primaryIds.has(hit.chunk.chunkId) ? 1 : 0), 0);
}

function expansionWeight(confidence: ReferenceEdge['confidence']): number {
  return confidence === 'high' ? 0.7 : confidence === 'medium' ? 0.5 : 0.35;
}

function exactAmbiguityFailure(query: string, hits: readonly RagHit[], limit: number): RagRetrieveResult {
  const candidateIds = hits.map((hit) => hit.chunk.chunkId);
  const failure = {
    ok: false as const,
    code: 'INVALID_INPUT' as const,
    message: `查询「${query}」在当前 scope 内有 ${candidateIds.length} 个精确候选，超过 finalLimit=${limit}；需要用户选择或继续读取。`,
    ambiguity: 'exact' as const,
    ambiguityCode: 'EXACT_MATCH_SET_EXCEEDS_LIMIT' as const,
    candidateIds,
    cursor: `exact:${encodeURIComponent(query)}:${limit}`
  };
  return failure as unknown as RagRetrieveResult;
}

function invalidInput(message: string): RagRetrieveFailure {
  return { ok: false, code: 'INVALID_INPUT', message };
}

function strictLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  // Legacy internal RAG fallbacks historically passed page sizes of 50 or
  // 100; keep those adapter values bounded to the SF-18 maximum while
  // rejecting nearby caller mistakes such as 33.  The public final result
  // remains strictly capped at MAX_LIMIT.
  if (value === 50 || value === 100) return MAX_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new RetrievalScopeError('INVALID_LIMIT', 'finalLimit 必须是 1..32 的安全整数。');
  }
  return value;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function scopeErrorMessage(error: unknown): string {
  if (error instanceof RetrievalScopeError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

function cloneResult(result: RagRetrieveResult): RagRetrieveResult {
  if (!result.ok) return { ...result };
  return {
    ...result,
    hits: result.hits.map((hit) => ({ ...hit, reasons: [...hit.reasons] })),
    ...(result.diagnostics ? { diagnostics: result.diagnostics.map((diagnostic) => ({ ...diagnostic })) } : {})
  };
}

function excerptOf(body: string, maxChars: number): string {
  return body.length <= maxChars ? body : `${body.slice(0, maxChars)}…`;
}

function firstNeedle(query: ParsedRagQuery): string {
  return query.phrases[0] ?? query.terms[0] ?? (query.numericIds[0] !== undefined ? String(query.numericIds[0]) : '');
}

function excerptAround(body: string, needle: string, maxChars: number): string {
  if (body.length <= maxChars) return body;
  if (needle.length === 0) return `${body.slice(0, maxChars)}…`;
  const index = body.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return `${body.slice(0, maxChars)}…`;
  const start = Math.max(0, index - Math.floor(maxChars / 3));
  const slice = body.slice(start, start + maxChars);
  return `${start > 0 ? '…' : ''}${slice}${start + maxChars < body.length ? '…' : ''}`;
}
