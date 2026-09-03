import type { Diagnostic, ReferenceConfidence, ReferenceEdge, ResourceKind } from './types.js';

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
  sourceRevision?: number;
  sourceHash?: string;
  relativePath?: string;
  resourceKind?: ResourceKind;
  confidence?: ReferenceConfidence;
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
  /** A file-only/light-scan corpus is not a usable semantic RAG corpus. */
  availability: 'available' | 'unavailable';
  diagnostics: Diagnostic[];
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
  /** 向量是可选增益；没有向量时必须明确标记纯 lexical 路径。 */
  retrievalMode?: 'lexical' | 'hybrid';
  diagnostics?: Diagnostic[];
  stats: {
    scanned: number;
    matched: number;
    expanded: number;
    truncated: boolean;
  };
}

export interface RagRetrieveFailure {
  ok: false;
  code: 'insufficient_evidence' | 'RAG_UNAVAILABLE' | 'INVALID_INPUT' | 'WORKSPACE_REQUIRED';
  message: string;
}

export type RagRetrieveResult = RagRetrieveOk | RagRetrieveFailure;

export interface RagRetrieveOptions {
  limit?: number;
  excerptChars?: number;
  families?: readonly RagChunkFamily[];
  expandReferences?: boolean;
}
