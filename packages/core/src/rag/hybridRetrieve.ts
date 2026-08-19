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
  RagCorpus,
  RagHit,
  RagRetrieveOptions,
  RagRetrieveResult
} from '@soulforge/shared';
import { cosineSimilarity } from '../model-services/embeddingClient.js';
import { retrieveEvidence } from './retrieve.js';

export interface HybridVectorSource {
  /** chunkId -> corpus embedding（必须与 queryVector 同一模型）。 */
  vectors: ReadonlyMap<string, Float32Array>;
  queryVector: Float32Array;
}

/** RRF 常量：经典 60，稳定且对排名靠后的条目不敏感。 */
const RRF_K = 60;
/** 向量侧候选上限：lexical 之外只允许这么多纯向量命中进入融合。 */
const VECTOR_CANDIDATE_MULTIPLIER = 2;
/**
 * 全库余弦只在小语料上跑。真实工作区上万块时，Agent 默认路径是词法倒排；
 * 大库的纯向量命中改为只给词法候选打分，避免每次查询扫完所有 embedding。
 */
const VECTOR_FULL_SCAN_LIMIT = 2048;

export function retrieveEvidenceHybrid(
  corpus: RagCorpus | null | undefined,
  query: string,
  options: RagRetrieveOptions & { vectors?: HybridVectorSource }
): RagRetrieveResult {
  const lexical = retrieveEvidence(corpus, query, options);
  if (!lexical.ok) return lexical;
  const vectorSource = options.vectors;
  if (!vectorSource
    || vectorSource.vectors.size === 0
    || vectorSource.queryVector.length === 0
    || !corpus || corpus.chunks.length === 0) {
    return lexical;
  }

  const limit = clampLimit(options.limit);
  const chunkById = new Map(corpus.chunks.map((chunk) => [chunk.chunkId, chunk]));

  const vectorScored: Array<{ chunkId: string; similarity: number }> = [];
  const scanAll = vectorSource.vectors.size <= VECTOR_FULL_SCAN_LIMIT;
  const vectorTargets = scanAll ? corpus.chunks : lexical.hits.map((hit) => hit.chunk);
  for (const chunk of vectorTargets) {
    const vector = vectorSource.vectors.get(chunk.chunkId);
    if (!vector) continue;
    const similarity = cosineSimilarity(vectorSource.queryVector, vector);
    if (similarity <= 0) continue;
    vectorScored.push({ chunkId: chunk.chunkId, similarity });
  }
  vectorScored.sort((a, b) => b.similarity - a.similarity);
  const vectorTop = vectorScored.slice(0, limit * VECTOR_CANDIDATE_MULTIPLIER);

  // RRF：两个排名列表按 1/(K+rank) 融合。
  const fused = new Map<string, {
    chunkId: string;
    rrf: number;
    similarity: number | undefined;
    lexicalHit: RagHit | undefined;
  }>();
  lexical.hits.forEach((hit, rank) => {
    fused.set(hit.chunk.chunkId, {
      chunkId: hit.chunk.chunkId,
      rrf: 1 / (RRF_K + rank + 1),
      similarity: undefined,
      lexicalHit: hit
    });
  });
  for (const [rank, entry] of vectorTop.entries()) {
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

  const ordered = [...fused.values()].sort((a, b) => b.rrf - a.rrf).slice(0, limit);
  const hits: RagHit[] = [];
  for (const entry of ordered) {
    const chunk = entry.lexicalHit?.chunk ?? chunkById.get(entry.chunkId);
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

  if (hits.length === 0) return lexical;
  return {
    ok: true,
    query: lexical.query,
    hits,
    stats: {
      scanned: lexical.stats.scanned,
      matched: fused.size,
      expanded: lexical.stats.expanded,
      truncated: fused.size > hits.length
    }
  };
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return 8;
  return Math.max(1, Math.min(32, Math.trunc(limit)));
}

function excerptOf(chunk: { body: string }): string {
  return chunk.body.length <= 420 ? chunk.body : `${chunk.body.slice(0, 420)}…`;
}
