/**
 * Hybrid evidence retrieval: lexical (retrieveEvidence) fused with vector
 * similarity via Reciprocal Rank Fusion (RRF).
 *
 * Vector source is injected by the caller (main process loads rag_embeddings
 * from workspace.db and embeds the query with the same model that produced the
 * corpus vectors). Absent vectors → pure lexical, unchanged behavior. Vectors
 * never cross into renderer payloads beyond the fused hit metadata.
 */

import type {
  RagChunkFamily,
  RagCorpus,
  RagHit,
  RagRetrieveOptions,
  RagRetrieveResult
} from '@soulforge/shared';
import { RAG_CHUNK_FAMILIES } from '@soulforge/shared';
import { cosineSimilarity } from '../model-services/embeddingClient.js';
import { retrieveEvidence } from './retrieve.js';

export interface HybridVectorSource {
  /** chunkId -> corpus embedding（必须与 queryVector 同一模型）。 */
  vectors: ReadonlyMap<string, Float32Array>;
  queryVector: Float32Array;
}

type HybridOptions = RagRetrieveOptions & { vectors?: HybridVectorSource };

interface PreparedHybrid {
  corpus: RagCorpus;
  lexical: RagRetrieveResult;
  lexicalHits: RagHit[];
  vectorSource: HybridVectorSource;
  vectorFamilies: Set<RagChunkFamily> | null;
  limit: number;
  chunkById: Map<string, RagCorpus['chunks'][number]>;
}

interface VectorScanResult {
  vectorTop: Array<{ chunkId: string; similarity: number }>;
  vectorScanned: number;
}

/** RRF 常量：经典 60，稳定且对排名靠后的条目不敏感。 */
const RRF_K = 60;
/** 向量侧候选上限：只保留这么多纯向量命中进入融合。 */
const VECTOR_CANDIDATE_MULTIPLIER = 2;

export function retrieveEvidenceHybrid(
  corpus: RagCorpus | null | undefined,
  query: string,
  options: HybridOptions
): RagRetrieveResult {
  const lexical = retrieveEvidence(corpus, query, options);
  if (!lexical.ok && lexical.code !== 'insufficient_evidence') return lexical;
  const prepared = prepareHybrid(corpus, options, lexical);
  if (!prepared) return lexical;
  return fuseHybrid(query, prepared, scanVectors(prepared));
}

/**
 * Production main-process entrypoint. Exact vector scan remains honest and
 * bounded to top-K candidate memory, but yields between chunks so a large
 * corpus does not monopolize Electron's event loop for the whole scan.
 */
export async function retrieveEvidenceHybridAsync(
  corpus: RagCorpus | null | undefined,
  query: string,
  options: HybridOptions
): Promise<RagRetrieveResult> {
  const lexical = retrieveEvidence(corpus, query, options);
  if (!lexical.ok && lexical.code !== 'insufficient_evidence') return lexical;
  const prepared = prepareHybrid(corpus, options, lexical);
  if (!prepared) return lexical;
  return fuseHybrid(query, prepared, await scanVectorsAsync(prepared));
}

function prepareHybrid(
  corpus: RagCorpus | null | undefined,
  options: HybridOptions,
  lexical: RagRetrieveResult
): PreparedHybrid | null {
  const vectorSource = options.vectors;
  if (!vectorSource
    || vectorSource.vectors.size === 0
    || vectorSource.queryVector.length === 0
    || !corpus || corpus.chunks.length === 0
    || !isFiniteVector(vectorSource.queryVector)) {
    return null;
  }
  return {
    corpus,
    lexical,
    lexicalHits: lexical.ok ? lexical.hits : [],
    vectorSource,
    vectorFamilies: normalizeFamilies(options.families),
    limit: clampLimit(options.limit),
    chunkById: new Map(corpus.chunks.map((chunk) => [chunk.chunkId, chunk]))
  };
}

function scanVectors(prepared: PreparedHybrid): VectorScanResult {
  const vectorScored: Array<{ chunkId: string; similarity: number }> = [];
  const vectorCandidateLimit = prepared.limit * VECTOR_CANDIDATE_MULTIPLIER;
  let vectorScanned = 0;
  for (const chunk of prepared.corpus.chunks) {
    if (prepared.vectorFamilies && !prepared.vectorFamilies.has(chunk.family)) continue;
    vectorScanned += 1;
    const candidate = scoreVector(prepared.vectorSource, chunk);
    if (candidate) insertVectorCandidate(vectorScored, candidate, vectorCandidateLimit);
  }
  return { vectorTop: vectorScored, vectorScanned };
}

async function scanVectorsAsync(prepared: PreparedHybrid): Promise<VectorScanResult> {
  const vectorScored: Array<{ chunkId: string; similarity: number }> = [];
  const vectorCandidateLimit = prepared.limit * VECTOR_CANDIDATE_MULTIPLIER;
  let vectorScanned = 0;
  for (const chunk of prepared.corpus.chunks) {
    if (prepared.vectorFamilies && !prepared.vectorFamilies.has(chunk.family)) continue;
    vectorScanned += 1;
    const candidate = scoreVector(prepared.vectorSource, chunk);
    if (candidate) insertVectorCandidate(vectorScored, candidate, vectorCandidateLimit);
    if (vectorScanned % VECTOR_YIELD_INTERVAL === 0) await yieldToEventLoop();
  }
  return { vectorTop: vectorScored, vectorScanned };
}

function scoreVector(
  vectorSource: HybridVectorSource,
  chunk: RagCorpus['chunks'][number]
): { chunkId: string; similarity: number } | null {
  const vector = vectorSource.vectors.get(chunk.chunkId);
  if (!vector || vector.length !== vectorSource.queryVector.length || !isFiniteVector(vector)) return null;
  const similarity = cosineSimilarity(vectorSource.queryVector, vector);
  return similarity > 0 ? { chunkId: chunk.chunkId, similarity } : null;
}

function fuseHybrid(query: string, prepared: PreparedHybrid, scan: VectorScanResult): RagRetrieveResult {
  // RRF：两个排名列表按 1/(K+rank) 融合。
  const fused = new Map<string, {
    chunkId: string;
    rrf: number;
    similarity: number | undefined;
    lexicalHit: RagHit | undefined;
  }>();
  prepared.lexicalHits.forEach((hit, rank) => {
    fused.set(hit.chunk.chunkId, {
      chunkId: hit.chunk.chunkId,
      rrf: 1 / (RRF_K + rank + 1),
      similarity: undefined,
      lexicalHit: hit
    });
  });
  for (const [rank, entry] of scan.vectorTop.entries()) {
    const existing = fused.get(entry.chunkId);
    const contribution = 1 / (RRF_K + rank + 1);
    if (existing) {
      existing.rrf += contribution;
      existing.similarity = entry.similarity;
    } else {
      fused.set(entry.chunkId, {
        chunkId: entry.chunkId,
        rrf: contribution,
        similarity: entry.similarity,
        lexicalHit: undefined
      });
    }
  }

  const ordered = [...fused.values()].sort((a, b) => b.rrf - a.rrf).slice(0, prepared.limit);
  const hits: RagHit[] = [];
  for (const entry of ordered) {
    const chunk = entry.lexicalHit?.chunk ?? prepared.chunkById.get(entry.chunkId);
    if (!chunk) continue;
    hits.push({
      chunk,
      score: Math.max(1, Math.round(entry.rrf * 1000)),
      reasons: [
        ...(entry.lexicalHit?.reasons ?? []),
        ...(entry.similarity !== undefined
          ? [`vector:${entry.similarity.toFixed(3)}`]
          : [])
      ],
      excerpt: entry.lexicalHit?.excerpt ?? excerptOf(chunk),
      ...(entry.lexicalHit?.expandedFrom ? { expandedFrom: entry.lexicalHit.expandedFrom } : {}),
      ...(entry.similarity !== undefined ? { vectorScore: entry.similarity } : {})
    });
  }

  if (hits.length === 0) return prepared.lexical;
  const coverage = prepared.lexical.ok
    ? prepared.lexical.stats.coverage
    : prepared.lexical.coverage ?? {
      status: 'FOUND' as const,
      scope: 'rag',
      indexed: prepared.corpus.chunks.length,
      expected: prepared.corpus.chunks.length,
      successful: prepared.corpus.chunks.length,
      failed: 0,
      completenessRatio: 1,
      resultCount: hits.length
    };
  return {
    ok: true,
    query,
    hits,
    stats: {
      // `scanned` includes both the lexical candidate pass and the exact
      // vector pass.  This makes the O(corpusChunks * embeddingDimension)
      // cost visible instead of hiding it behind `hybrid_rrf`.
      scanned: scan.vectorScanned + (prepared.lexical.ok ? prepared.lexical.stats.scanned : 0),
      matched: fused.size,
      expanded: prepared.lexical.ok ? prepared.lexical.stats.expanded : 0,
      truncated: fused.size > hits.length,
      coverage,
      retrievalMode: 'hybrid_rrf'
    }
  };
}

const VECTOR_YIELD_INTERVAL = 256;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function insertVectorCandidate(
  candidates: Array<{ chunkId: string; similarity: number }>,
  candidate: { chunkId: string; similarity: number },
  maxCandidates: number
): void {
  const insertionIndex = candidates.findIndex((existing) => compareVectorCandidates(candidate, existing) < 0);
  if (insertionIndex < 0) {
    if (candidates.length < maxCandidates) candidates.push(candidate);
    return;
  }
  candidates.splice(insertionIndex, 0, candidate);
  if (candidates.length > maxCandidates) candidates.pop();
}

function compareVectorCandidates(
  left: { chunkId: string; similarity: number },
  right: { chunkId: string; similarity: number }
): number {
  const similarityOrder = right.similarity - left.similarity;
  return similarityOrder !== 0 ? similarityOrder : left.chunkId.localeCompare(right.chunkId);
}

function isFiniteVector(vector: Float32Array): boolean {
  for (const value of vector) {
    if (!Number.isFinite(value)) return false;
  }
  return vector.length > 0;
}

function normalizeFamilies(families: readonly RagChunkFamily[] | undefined): Set<RagChunkFamily> | null {
  if (!families || families.length === 0) return null;
  const allowed = new Set<RagChunkFamily>(RAG_CHUNK_FAMILIES);
  const selected = families.filter((family): family is RagChunkFamily => allowed.has(family));
  return selected.length > 0 ? new Set(selected) : null;
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return 8;
  return Math.max(1, Math.min(32, Math.trunc(limit)));
}

function excerptOf(chunk: { body: string }): string {
  return chunk.body.length <= 420 ? chunk.body : `${chunk.body.slice(0, 420)}…`;
}
