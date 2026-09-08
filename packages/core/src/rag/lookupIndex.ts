/**
 * In-memory inverted index for workspace RAG.
 *
 * retrieveEvidence used to score every chunk. After analyze, a real Sekiro
 * workspace is tens of thousands of param/text/event rows — that linear scan
 * is the slow path. FTS tables exist in SQLite but the Agent tool never
 * called them. This index is built once with the corpus and used to gather
 * a candidate set before the existing scorer runs.
 */
import type { RagChunk, RagChunkFamily, RagCorpus, ReferenceEdge } from '@soulforge/shared';
import { extractAtomicAddressTokens } from '@soulforge/shared';
import { cjkBigrams, tokenize } from './queryParse.js';
import { compareCodePointText } from './topK.js';
import { isChunkEligible, type NormalizedRetrievalScope } from './retrievalScope.js';

export type RagAdjacentReference = ReferenceEdge & {
  /** URI at the other end of the undirected reference edge. */
  otherUri: string;
  /** Reference-algorithm compatible alias. */
  other: string;
};

export interface RagLookupIndex {
  byNumericId: Map<number, number[]>;
  byNumericPrefix: Map<string, number[]>;
  byToken: Map<string, number[]>;
  byUri: Map<string, number[]>;
  bySymbolUri: Map<string, RagChunk>;
  bySymbolUriAll: Map<string, RagChunk[]>;
  adjacency: Map<string, RagAdjacentReference[]>;
  adjacencyEdges?: ReferenceEdge[];
  referenceSignature: string;
  chunkSignature: string;
}

const lookupByCorpus = new WeakMap<RagCorpus, RagLookupIndex>();

export function attachLookupIndex(corpus: RagCorpus): RagLookupIndex {
  const index = buildLookupIndex(corpus.chunks, corpus.references);
  lookupByCorpus.set(corpus, index);
  return index;
}

export function getLookupIndex(corpus: RagCorpus): RagLookupIndex | undefined {
  return lookupByCorpus.get(corpus);
}

export function ensureLookupIndex(corpus: RagCorpus): RagLookupIndex {
  const existing = lookupByCorpus.get(corpus);
  if (!existing) return attachLookupIndex(corpus);
  if (existing.chunkSignature !== chunkSignature(corpus.chunks)) return attachLookupIndex(corpus);
  if (existing.referenceSignature !== referenceSignature(corpus.references)) {
    refreshReferenceAdjacency(existing, corpus.references);
  }
  return existing;
}

export function buildLookupIndex(chunks: readonly RagChunk[], references: readonly ReferenceEdge[] = []): RagLookupIndex {
  const byNumericId = new Map<number, number[]>();
  const byNumericPrefix = new Map<string, number[]>();
  const byToken = new Map<string, number[]>();
  const byUri = new Map<string, number[]>();
  const bySymbolUri = new Map<string, RagChunk>();
  const bySymbolUriAll = new Map<string, RagChunk[]>();

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]!;
    if (!bySymbolUri.has(chunk.symbolUri)) bySymbolUri.set(chunk.symbolUri, chunk);
    const symbols = bySymbolUriAll.get(chunk.symbolUri);
    if (symbols) symbols.push(chunk);
    else bySymbolUriAll.set(chunk.symbolUri, [chunk]);
    push(byUri, chunk.sourceUri.toLowerCase(), index);
    push(byUri, chunk.symbolUri.toLowerCase(), index);

    for (const id of chunk.numericIds) {
      indexNumeric(byNumericId, byNumericPrefix, id, index);
    }
    const text = `${chunk.title}\n${chunk.body}`;
    for (const match of text.matchAll(/\b\d{1,12}\b/g)) {
      indexNumeric(byNumericId, byNumericPrefix, Number(match[0]), index);
    }
    for (const token of tokenize(text)) {
      push(byToken, token, index);
    }
    // 问题 6：把原子地址（cXXXX / AXXXX / MXX / mAA_BB_CC_DD / 带 # 完整地址）
    // 额外推进 byToken —— tokenize 已含它们，这里独立再推一次，保证即使旧索引
    // 文本里地址没被抽成原子词，至少查询侧能对上新的正文。
    for (const atomic of extractAtomicAddressTokens(text)) {
      push(byToken, atomic, index);
    }
    for (const bigram of cjkBigrams(text)) {
      push(byToken, bigram, index);
    }
  }

  const index: RagLookupIndex = {
    byNumericId,
    byNumericPrefix,
    byToken,
    byUri,
    bySymbolUri,
    bySymbolUriAll,
    adjacency: new Map(),
    referenceSignature: '',
    chunkSignature: chunkSignature(chunks)
  };
  refreshReferenceAdjacency(index, references);
  return index;
}

export function collectIndexedCandidates(
  chunks: readonly RagChunk[],
  index: RagLookupIndex,
  query: {
    numericIds: readonly number[];
    terms: readonly string[];
    phrases: readonly string[];
    uris: readonly string[];
  },
  filter: ReadonlySet<RagChunkFamily> | NormalizedRetrievalScope | null
): RagChunk[] {
  const hits = new Set<number>();
  for (const id of query.numericIds) {
    addAll(hits, index.byNumericId.get(id));
    addAll(hits, index.byNumericPrefix.get(String(id)));
  }
  for (const term of query.terms) {
    addAll(hits, index.byToken.get(term));
  }
  for (const phrase of query.phrases) {
    addAll(hits, index.byToken.get(phrase.toLowerCase()));
    for (const bigram of cjkBigrams(phrase)) {
      addAll(hits, index.byToken.get(bigram));
    }
  }
  for (const uri of query.uris) {
    addAll(hits, index.byUri.get(uri.toLowerCase()));
  }

  const selected: RagChunk[] = [];
  for (const position of hits) {
    const chunk = chunks[position];
    if (!chunk) continue;
    if (!matchesFilter(chunk, filter)) continue;
    selected.push(chunk);
  }
  return selected;
}

export function buildReferenceAdjacency(edges: readonly ReferenceEdge[]): Map<string, RagAdjacentReference[]> {
  const adjacency = new Map<string, RagAdjacentReference[]>();
  const add = (uri: string, otherUri: string, edge: ReferenceEdge): void => {
    const list = adjacency.get(uri);
    const adjacent = { ...edge, otherUri, other: otherUri };
    if (list) list.push(adjacent);
    else adjacency.set(uri, [adjacent]);
  };
  for (const edge of edges) {
    add(edge.fromUri, edge.toUri, edge);
    add(edge.toUri, edge.fromUri, edge);
  }
  for (const list of adjacency.values()) {
    list.sort((left, right) => compareCodePointText(left.otherUri, right.otherUri)
      || confidenceRank(left.confidence) - confidenceRank(right.confidence)
      || compareCodePointText(left.kind, right.kind));
  }
  return adjacency;
}

/**
 * Refresh only adjacency buckets touched by changed edges.  The inverted
 * token/numeric maps remain valid during an incremental reference refresh.
 */
export function refreshReferenceAdjacency(index: RagLookupIndex, edges: readonly ReferenceEdge[]): void {
  const oldEdges = index.adjacencyEdges ?? [];
  const oldByKey = new Map(oldEdges.map((edge) => [referenceEdgeKey(edge), edge] as const));
  const nextByKey = new Map(edges.map((edge) => [referenceEdgeKey(edge), edge] as const));
  const affected = new Set<string>();
  for (const [key, edge] of oldByKey) {
    if (!nextByKey.has(key)) {
      affected.add(edge.fromUri);
      affected.add(edge.toUri);
    }
  }
  for (const [key, edge] of nextByKey) {
    if (!oldByKey.has(key)) {
      affected.add(edge.fromUri);
      affected.add(edge.toUri);
    }
  }
  if (index.referenceSignature === '') {
    index.adjacency = buildReferenceAdjacency(edges);
  } else {
    for (const uri of affected) {
      const next = edges.filter((edge) => edge.fromUri === uri || edge.toUri === uri);
      const rebuilt = buildReferenceAdjacency(next).get(uri);
      if (rebuilt && rebuilt.length > 0) index.adjacency.set(uri, rebuilt);
      else index.adjacency.delete(uri);
    }
  }
  index.adjacencyEdges = [...edges];
  index.referenceSignature = referenceSignature(edges);
}

function indexNumeric(
  byNumericId: Map<number, number[]>,
  byNumericPrefix: Map<string, number[]>,
  id: number,
  chunkIndex: number
): void {
  if (!Number.isFinite(id) || !Number.isInteger(id)) return;
  push(byNumericId, id, chunkIndex);
  const text = String(id);
  if (text.length < 3) return;
  push(byNumericPrefix, text.slice(0, -1), chunkIndex);
  if (text.length >= 4) push(byNumericPrefix, text.slice(0, -2), chunkIndex);
}

function push<K>(map: Map<K, number[]>, key: K, value: number): void {
  const list = map.get(key);
  if (list) {
    if (list[list.length - 1] !== value) list.push(value);
    return;
  }
  map.set(key, [value]);
}

function addAll(target: Set<number>, source: readonly number[] | undefined): void {
  if (!source) return;
  for (const value of source) target.add(value);
}

function matchesFilter(
  chunk: RagChunk,
  filter: ReadonlySet<RagChunkFamily> | NormalizedRetrievalScope | null
): boolean {
  if (!filter) return true;
  if (filter instanceof Set) return filter.has(chunk.family);
  return isChunkEligible(chunk, filter as NormalizedRetrievalScope);
}

function confidenceRank(confidence: ReferenceEdge['confidence']): number {
  return confidence === 'high' ? 0 : confidence === 'medium' ? 1 : 2;
}

function referenceEdgeKey(edge: ReferenceEdge): string {
  return JSON.stringify([
    edge.fromUri,
    edge.toUri,
    edge.kind,
    edge.confidence,
    edge.reason,
    edge.evidence
  ]);
}

function referenceSignature(edges: readonly ReferenceEdge[]): string {
  return edges.map(referenceEdgeKey).sort(compareCodePointText).join('\u0000');
}

function chunkSignature(chunks: readonly RagChunk[]): string {
  // The inverted maps store positions into `chunks`, so a reorder is a real
  // index change even when the same chunk identities/content are present.  An
  // ordered signature also avoids sorting every chunk signature with the
  // code-point comparator on every ensureLookupIndex call.  Keep the source
  // and content identity fields here; provenance changes must still rebuild
  // the index.
  return chunks.map((chunk) => JSON.stringify([
    chunk.chunkId,
    chunk.workspaceId,
    chunk.sourceUri,
    chunk.symbolUri,
    chunk.family,
    chunk.contentHash,
    chunk.outerFileHash,
    chunk.sourceRevision,
    chunk.sourceHash
  ])).join('\u0000');
}
