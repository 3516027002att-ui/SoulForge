import type { ReferenceConfidence, ReferenceEdge, ResourceKind } from './types.js';

/**
 * Retrievable evidence unit for workspace RAG.
 *
 * Chunks are renderer-safe: relative path only, never an absolute filesystem
 * path. Persistence lives in the main-owned workspace.db, never in the Mod
 * overlay.
 */
export type RagChunkFamily =
  | 'file'
  | 'event'
  | 'map_entity'
  | 'map_region'
  | 'param_row'
  | 'text_entry'
  | 'tae_event';

export const RAG_CHUNK_FAMILIES: readonly RagChunkFamily[] = [
  'file',
  'event',
  'map_entity',
  'map_region',
  'param_row',
  'text_entry',
  'tae_event'
];

export interface RagChunk {
  chunkId: string;
  workspaceId: string;
  sourceUri: string;
  symbolUri: string;
  family: RagChunkFamily;
  title: string;
  body: string;
  numericIds: number[];
  contentHash: string;
  /** Stable source revision. Persisted symbol chunks may not outlive this value. */
  sourceRevision?: string;
  sourceHash?: string;
  relativePath?: string;
  resourceKind?: ResourceKind;
  confidence?: ReferenceConfidence;
}

export type RagCoverageStatus =
  | 'FOUND'
  | 'NOT_FOUND_WITH_COMPLETE_COVERAGE'
  | 'NOT_INDEXED'
  | 'PARTIALLY_INDEXED'
  | 'PARSE_FAILED'
  | 'STALE'
  | 'SOURCE_UNAVAILABLE';

export interface RagCoverage {
  status: RagCoverageStatus;
  scope: string;
  indexed: number;
  expected: number;
  successful: number;
  failed: number;
  /** Source was accepted only as a partial projection; it cannot prove absence. */
  partial?: number;
  sourceRevision?: string;
  completenessRatio: number;
  resultCount: number;
}

export interface RagCorpusStats {
  total: number;
  byFamily: Record<RagChunkFamily, number>;
}

export interface RagCorpus {
  workspaceId: string;
  builtAt: string;
  chunks: RagChunk[];
  references: ReferenceEdge[];
  stats: RagCorpusStats;
  coverage?: RagCoverage;
}

export interface RagHit {
  chunk: RagChunk;
  score: number;
  reasons: string[];
  excerpt: string;
  expandedFrom?: string;
  /** 向量检索的余弦相似度（RRF 融合路径才有；纯 lexical 缺失）。 */
  vectorScore?: number;
}

export interface RagRetrieveOk {
  ok: true;
  query: string;
  hits: RagHit[];
  stats: {
    scanned: number;
    matched: number;
    expanded: number;
    truncated: boolean;
    coverage: RagCoverage;
    retrievalMode: 'lexical' | 'lexical_rerank' | 'hybrid_rrf';
  };
}

export interface RagRetrieveFailure {
  ok: false;
  code: 'insufficient_evidence' | 'INVALID_INPUT' | 'WORKSPACE_REQUIRED';
  message: string;
  coverage?: RagCoverage;
}

export type RagRetrieveResult = RagRetrieveOk | RagRetrieveFailure;

export interface RagRetrieveOptions {
  limit?: number;
  excerptChars?: number;
  families?: readonly RagChunkFamily[];
  expandReferences?: boolean;
}
