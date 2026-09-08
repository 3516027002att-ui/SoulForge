/**
 * Hybrid evidence retrieval. Lexical and vector candidates are both ranked
 * to candidateLimit, filtered by one normalized scope, then fused with RRF.
 */
import type { Diagnostic, RagChunk, RagCorpus, RagHit, RagRetrieveResult } from '@soulforge/shared';
import { isChunkEligible, RetrievalScopeError, type NormalizedRetrievalScope } from './retrievalScope.js';
import {
  expandScopedHits,
  finalizeLexicalCandidates,
  isRagSourceExcluded,
  prepareLexicalCandidates,
  type LexicalCandidateSet,
  type Sf18RetrieveOptions
} from './retrieve.js';
import { compareCodePointText, cosine, topK } from './topK.js';

export interface HybridVectorSource {
  /** chunkId -> corpus embedding（必须与 queryVector 同一模型）。 */
  vectors: ReadonlyMap<string, ArrayLike<number>>;
  queryVector: ArrayLike<number>;
  /** Optional provenance supplied by the embedding store. */
  model?: string;
  embeddingModel?: string;
  corpusRevision?: string;
  embeddingProfile?: string;
  normalizationProfile?: string;
  dim?: number;
  dimension?: number;
}

export type HybridRetrieveOptions = Sf18RetrieveOptions & { vectors?: HybridVectorSource };

/** RRF 常量：经典 60。 */
export const RRF_K = 60;

interface VectorRank {
  readonly chunkId: string;
  readonly similarity: number;
}

interface FusedRank {
  readonly chunkId: string;
  readonly rrf: number;
  readonly similarity?: number;
  readonly lexicalHit?: RagHit;
}

export function retrieveEvidenceHybrid(
  corpus: RagCorpus | null | undefined,
  query: string,
  options: HybridRetrieveOptions = {}
): RagRetrieveResult {
  const prepared = prepareLexicalCandidates(corpus, query, options);
  if (!prepared.ok) return prepared.result;
  const value = prepared.value;
  const vectorSource = options.vectors;
  if (!vectorSource || vectorSource.vectors.size === 0 || !corpus || corpus.chunks.length === 0) {
    return finalizeLexicalCandidates(value, options.expandReferences !== false);
  }

  const diagnostics: Diagnostic[] = [...value.diagnostics];
  const sourceValidation = validateVectorSource(vectorSource, value, options);
  diagnostics.push(...sourceValidation.diagnostics);
  if (!sourceValidation.ok) {
    return attachDiagnostics(finalizeLexicalCandidates(value, options.expandReferences !== false), diagnostics);
  }

  const chunksById = new Map<string, RagChunk>();
  // Vector-only queries have no lexical index candidates. Build the vector
  // lookup from the whole corpus, then apply the same hard scope predicate
  // immediately before scoring.
  for (const chunk of value.corpus.chunks) {
    if (isChunkEligible(chunk, value.scope)
      && !isRagSourceExcluded(chunk.sourceUri, value.excludedSourceUris)
      && !value.excludedChunkIds.has(chunk.chunkId)
      && !chunksById.has(chunk.chunkId)) chunksById.set(chunk.chunkId, chunk);
  }
  const vectorRanks: VectorRank[] = [];
  let invalidVectorCount = 0;
  for (const [chunkId, vector] of vectorSource.vectors) {
    const chunk = chunksById.get(chunkId);
    if (!chunk || !isChunkEligible(chunk, value.scope)) continue;
    try {
      const similarity = cosine(vectorSource.queryVector, vector);
      if (similarity > 0) vectorRanks.push({ chunkId, similarity });
    } catch (error) {
      invalidVectorCount += 1;
      diagnostics.push(vectorDiagnostic(error, chunkId));
    }
  }
  if (invalidVectorCount > 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'RAG_VECTOR_CANDIDATES_SKIPPED',
      message: `有 ${invalidVectorCount} 个向量因维度、有限性或范数校验失败而未参与融合。`,
      details: { invalidVectorCount }
    });
  }

  const vectorTop = topK(
    dedupeVectorRanks(vectorRanks).map((entry) => ({ id: entry.chunkId, score: entry.similarity, entry })),
    value.candidateLimit
  ).map((item) => item.entry);
  const lexicalRanks = dedupeHits(value.lexicalHits);
  const fused = fuseRankedEntries(lexicalRanks, vectorTop, chunksById, value.scope);
  if (fused.length === 0) {
    return attachDiagnostics(finalizeLexicalCandidates(value, options.expandReferences !== false), diagnostics);
  }

  const exactIds = new Set(value.exactHits.map((hit) => hit.chunk.chunkId));
  const exactFused = value.exactHits
    .map((hit) => fused.find((entry) => entry.chunkId === hit.chunk.chunkId))
    .filter((entry): entry is FusedRank => entry !== undefined);
  const rest = topK(
    fused
      .filter((entry) => !exactIds.has(entry.chunkId))
      .map((entry) => ({ id: entry.chunkId, score: entry.rrf, entry })),
    Math.max(0, value.candidateLimit - exactFused.length)
  ).map((item) => item.entry);
  const ordered = [...exactFused, ...rest];
  const primary = ordered.slice(0, value.finalLimit).map((entry) => toHit(entry, chunksById));
  const candidateHits = ordered.map((entry) => toHit(entry, chunksById));
  const expansion = expandScopedHits(
    primary,
    candidateHits,
    value.lookup,
    value.scope,
    value.finalLimit,
    options.expandReferences !== false,
    value.exactHits,
    value.excludedSourceUris,
    value.excludedChunkIds
  );
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
    retrievalMode: 'hybrid',
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    stats: {
      scanned: value.scopedCandidates.length,
      matched: fused.length,
      expanded: expansion.expanded,
      truncated: fused.length > expansion.hits.length || vectorRanks.length > vectorTop.length
    }
  };
}

/** Reference-compatible RRF helper with pre-rank filtering and deduplication. */
export function fuseRrf(
  chunks: readonly RagChunk[],
  lexicalIds: readonly string[],
  vectorIds: readonly string[],
  scope: NormalizedRetrievalScope,
  limit: number,
  exactIds: readonly string[] = [],
  excludedChunkIds: ReadonlySet<string> = new Set()
): RagChunk[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) {
    throw new RetrievalScopeError('INVALID_LIMIT', 'finalLimit 必须是 1..32 的安全整数。');
  }
  const byId = new Map<string, RagChunk>();
  for (const chunk of chunks) {
    if (byId.has(chunk.chunkId)) throw new RetrievalScopeError('DUPLICATE_CHUNK_ID', `重复 chunkId：${chunk.chunkId}`);
    byId.set(chunk.chunkId, chunk);
  }
  const fused = new Map<string, number>();
  addRrfRanks(fused, uniqueIds(lexicalIds), byId, scope, excludedChunkIds);
  addRrfRanks(fused, uniqueIds(vectorIds), byId, scope, excludedChunkIds);
  const exact = uniqueIds(exactIds).filter((id) => {
    const chunk = byId.get(id);
    return !!chunk && isChunkEligible(chunk, scope) && !excludedChunkIds.has(id);
  });
  if (exact.length > limit) throw new RetrievalScopeError('EXACT_MATCH_SET_EXCEEDS_LIMIT', '精确候选超过 finalLimit。');
  const rest = topK(
    [...fused.entries()]
      .filter(([id]) => !exact.includes(id))
      .map(([id, score]) => ({ id, score })),
    limit - exact.length
  );
  return [
    ...exact.map((id) => byId.get(id)).filter((chunk): chunk is RagChunk => chunk !== undefined),
    ...rest.map((entry) => byId.get(entry.id)).filter((chunk): chunk is RagChunk => chunk !== undefined)
  ];
}

function validateVectorSource(
  source: HybridVectorSource,
  value: LexicalCandidateSet,
  options: HybridRetrieveOptions
): { ok: boolean; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const expectedModel = options.embeddingModel ?? value.scope.embeddingModel;
  const actualModel = source.model ?? source.embeddingModel;
  if (expectedModel !== undefined && actualModel !== undefined && expectedModel !== actualModel) {
    diagnostics.push({ severity: 'warning', code: 'RAG_VECTOR_MODEL_MISMATCH', message: 'embedding 模型版本不匹配，已禁用向量源。', details: { expectedModel, actualModel } });
  }
  const expectedProfile = options.embeddingProfile ?? value.scope.embeddingProfile;
  const actualProfile = source.embeddingProfile ?? source.normalizationProfile;
  if (expectedProfile !== undefined && actualProfile !== undefined && expectedProfile !== actualProfile) {
    diagnostics.push({ severity: 'warning', code: 'RAG_VECTOR_PROFILE_MISMATCH', message: 'embedding normalization/profile 不匹配，已禁用向量源。', details: { expectedProfile, actualProfile } });
  }
  const expectedRevision = options.corpusRevision ?? value.scope.corpusRevision;
  if (expectedRevision !== undefined && source.corpusRevision !== undefined && expectedRevision !== source.corpusRevision) {
    diagnostics.push({ severity: 'warning', code: 'RAG_VECTOR_CORPUS_REVISION_MISMATCH', message: '向量语料 revision 已过期，已禁用向量源。', details: { expectedRevision, actualRevision: source.corpusRevision } });
  }
  const expectedDimension = source.dimension ?? source.dim;
  if (expectedDimension !== undefined && (!Number.isSafeInteger(expectedDimension) || expectedDimension <= 0 || source.queryVector.length !== expectedDimension)) {
    diagnostics.push({ severity: 'warning', code: 'RAG_VECTOR_DIMENSION_MISMATCH', message: 'query embedding 维度与向量源声明不匹配，已禁用向量源。', details: { expectedDimension, actualDimension: source.queryVector.length } });
  }
  if (source.queryVector.length === 0) diagnostics.push({ severity: 'warning', code: 'RAG_VECTOR_DIMENSION', message: 'query embedding 维度为空，已禁用向量源。' });
  const invalid = diagnostics.some((diagnostic) => diagnostic.code.includes('MISMATCH') || diagnostic.code === 'RAG_VECTOR_DIMENSION');
  return { ok: !invalid, diagnostics };
}

function fuseRankedEntries(
  lexical: readonly RagHit[],
  vector: readonly VectorRank[],
  byId: ReadonlyMap<string, RagChunk>,
  scope: NormalizedRetrievalScope
): FusedRank[] {
  const fused = new Map<string, FusedRank>();
  const lexicalIds = uniqueIds(lexical.map((hit) => hit.chunk.chunkId));
  lexicalIds.forEach((chunkId, rank) => {
    const chunk = byId.get(chunkId);
    if (!chunk || !isChunkEligible(chunk, scope)) return;
    const lexicalHit = lexical.find((hit) => hit.chunk.chunkId === chunkId);
    fused.set(chunkId, {
      chunkId,
      rrf: 1 / (RRF_K + rank + 1),
      ...(lexicalHit ? { lexicalHit } : {})
    });
  });
  const vectorIds = uniqueIds(vector.map((entry) => entry.chunkId));
  vectorIds.forEach((chunkId, rank) => {
    const chunk = byId.get(chunkId);
    if (!chunk || !isChunkEligible(chunk, scope)) return;
    const entry = vector.find((candidate) => candidate.chunkId === chunkId);
    if (!entry) return;
    const existing = fused.get(chunkId);
    const contribution = 1 / (RRF_K + rank + 1);
    if (existing) fused.set(chunkId, { ...existing, rrf: existing.rrf + contribution, similarity: entry.similarity });
    else fused.set(chunkId, { chunkId, rrf: contribution, similarity: entry.similarity });
  });
  return [...fused.values()].sort((left, right) => right.rrf - left.rrf || compareCodePointText(left.chunkId, right.chunkId));
}

function addRrfRanks(
  target: Map<string, number>,
  ids: readonly string[],
  byId: ReadonlyMap<string, RagChunk>,
  scope: NormalizedRetrievalScope,
  excludedChunkIds: ReadonlySet<string> = new Set()
): void {
  // Scope filtering is part of rank-list construction.  An out-of-scope id
  // must not consume a rank slot and thereby change an authorized candidate's
  // RRF score.
  const eligibleIds = ids.filter((id) => {
    const chunk = byId.get(id);
    return chunk !== undefined && isChunkEligible(chunk, scope) && !excludedChunkIds.has(id);
  });
  eligibleIds.forEach((id, rank) => {
    const chunk = byId.get(id);
    if (!chunk) return;
    target.set(id, (target.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
  });
}

function toHit(entry: FusedRank, byId: ReadonlyMap<string, RagChunk>): RagHit {
  const chunk = byId.get(entry.chunkId);
  if (!chunk) throw new RetrievalScopeError('MISSING_CHUNK', `RRF chunk 不存在：${entry.chunkId}`);
  return {
    chunk,
    score: Math.max(1, Math.round(entry.rrf * 1_000)),
    reasons: [...(entry.lexicalHit?.reasons ?? []), ...(entry.similarity !== undefined ? [`vector:${entry.similarity.toFixed(3)}`] : [])],
    excerpt: entry.lexicalHit?.excerpt ?? excerptOf(chunk.body),
    ...(entry.lexicalHit?.expandedFrom ? { expandedFrom: entry.lexicalHit.expandedFrom } : {}),
    ...(entry.similarity !== undefined ? { vectorScore: entry.similarity } : {})
  };
}

function dedupeHits(hits: readonly RagHit[]): RagHit[] {
  const seen = new Set<string>();
  const result: RagHit[] = [];
  for (const hit of hits) {
    if (seen.has(hit.chunk.chunkId)) continue;
    seen.add(hit.chunk.chunkId);
    result.push(hit);
  }
  return result;
}

function dedupeVectorRanks(ranks: readonly VectorRank[]): VectorRank[] {
  const byId = new Map<string, VectorRank>();
  for (const rank of ranks) {
    const previous = byId.get(rank.chunkId);
    if (!previous || rank.similarity > previous.similarity) byId.set(rank.chunkId, rank);
  }
  return [...byId.values()];
}

function uniqueIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function attachDiagnostics(result: RagRetrieveResult, diagnostics: readonly Diagnostic[]): RagRetrieveResult {
  if (diagnostics.length === 0) return result;
  if (!result.ok) return { ...result, diagnostics } as unknown as RagRetrieveResult;
  return { ...result, diagnostics: [...(result.diagnostics ?? []), ...diagnostics] };
}

function vectorDiagnostic(error: unknown, chunkId: string): Diagnostic {
  const code = error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'VECTOR_INVALID';
  return { severity: 'warning', code: `RAG_${code}`, message: `chunk ${chunkId} 的向量未通过严格校验。`, details: { chunkId } };
}

function excerptOf(body: string): string {
  return body.length <= 420 ? body : `${body.slice(0, 420)}…`;
}
