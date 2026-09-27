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
import { createHash } from 'node:crypto';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import { cjkBigrams, tokenize } from './queryParse.js';
import { compareCodePointText } from './topK.js';
import { corpusRevisionForValidatedLookup, isChunkEligible, type NormalizedRetrievalScope } from './retrievalScope.js';

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
  referenceKeyCounts?: Map<string, { fromUri: string; toUri: string; count: number }>;
  referenceSignature: string;
  chunkSignature: string;
}

const lookupByCorpus = new WeakMap<RagCorpus, RagLookupIndex>();
const pendingLookupByCorpus = new WeakMap<RagCorpus, Promise<RagLookupIndex>>();

/** Large native workspace corpora can need several minutes for the yielded lookup projection. */
export const DEFAULT_RAG_LOOKUP_BUILD_TIMEOUT_MS = 600_000;

export function attachLookupIndex(corpus: RagCorpus): RagLookupIndex {
  const index = buildLookupIndex(corpus.chunks, corpus.references);
  lookupByCorpus.set(corpus, index);
  return index;
}

export interface RagLookupBuildOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  batchSize?: number;
  maxSliceMs?: number;
  onProgress?: (progress: { completed: number; total: number }) => void;
  /** Host/test scheduler; must yield an event-loop turn, not just a microtask. */
  yieldControl?: () => Promise<void>;
}

/** Prepare before publication: a cancelled or timed-out partial index is never attached. */
export async function attachLookupIndexAsync(corpus: RagCorpus, options: RagLookupBuildOptions = {}): Promise<RagLookupIndex> {
  const started = performance.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_RAG_LOOKUP_BUILD_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0
    || !Number.isSafeInteger(options.batchSize ?? 128) || (options.batchSize ?? 128) < 1
    || !Number.isFinite(options.maxSliceMs ?? 8) || (options.maxSliceMs ?? 8) <= 0) {
    throw new RangeError('Invalid RAG index build budget.');
  }
  if (options.signal?.aborted) throw Object.assign(new Error('RAG index build cancelled.'), { name: 'AbortError' });
  const existing = lookupByCorpus.get(corpus);
  if (existing
    && existing.chunkSignature === chunkSignature(corpus.chunks)
    && existing.referenceSignature === referenceSignature(corpus.references)) {
    const total = corpus.chunks.length + corpus.references.length;
    options.onProgress?.({ completed: total, total });
    if (options.signal?.aborted) throw Object.assign(new Error('RAG index build cancelled.'), { name: 'AbortError' });
    return existing;
  }
  const pending = pendingLookupByCorpus.get(corpus);
  if (pending) {
    // A joining query can cancel its own wait without cancelling the owner.
    // If the owner failed/cancelled, surviving callers retry serially rather
    // than allocating competing partial indexes for the same corpus.
    await waitForLookupBuild(pending, options.signal, timeoutMs);
    const existing = getLookupIndex(corpus);
    if (existing) {
      const total = corpus.chunks.length + corpus.references.length;
      options.onProgress?.({ completed: total, total });
      if (options.signal?.aborted) throw Object.assign(new Error('RAG index build cancelled.'), { name: 'AbortError' });
      return existing;
    }
    return attachLookupIndexAsync(corpus, { ...options, timeoutMs: Math.max(0, timeoutMs - (performance.now() - started)) });
  }
  const build = buildLookupIndexAsync(corpus, options);
  pendingLookupByCorpus.set(corpus, build);
  try { return await build; }
  finally { if (pendingLookupByCorpus.get(corpus) === build) pendingLookupByCorpus.delete(corpus); }
}

function waitForLookupBuild(build: Promise<RagLookupIndex>, signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error): void => {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    };
    const abort = (): void => finish(Object.assign(new Error('RAG index build cancelled.'), { name: 'AbortError' }));
    if (signal?.aborted) { abort(); return; }
    const expire = (): void => finish(Object.assign(new Error('RAG index build timed out.'), { name: 'TimeoutError', code: 'RAG_INDEX_TIMEOUT' }));
    if (timeoutMs === 0) { expire(); return; }
    timeout = setTimeout(expire, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    // An owner failure is not a failure of an independent waiting caller.
    build.then(() => finish(), () => finish());
  });
}

async function buildLookupIndexAsync(corpus: RagCorpus, options: RagLookupBuildOptions): Promise<RagLookupIndex> {
  const batchSize = options.batchSize ?? 128;
  const maxSliceMs = options.maxSliceMs ?? 8;
  const timeoutMs = options.timeoutMs ?? DEFAULT_RAG_LOOKUP_BUILD_TIMEOUT_MS;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || !Number.isFinite(maxSliceMs) || maxSliceMs <= 0
    || !Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError('Invalid RAG index build budget.');
  const started = performance.now();
  const check = (): void => {
    if (options.signal?.aborted) throw Object.assign(new Error('RAG index build cancelled.'), { name: 'AbortError' });
    if (performance.now() - started >= timeoutMs) throw Object.assign(new Error('RAG index build timed out.'), { name: 'TimeoutError', code: 'RAG_INDEX_TIMEOUT' });
  };
  // setImmediate yields to I/O without paying Windows' per-timer delay for
  // every 128 records. A microtask would not let IPC/timers run at all.
  const yieldControl = options.yieldControl ?? yieldEventLoop;
  const maxSourceChangeRetries = 2;
  for (let attempt = 0; attempt <= maxSourceChangeRetries; attempt += 1) {
    const chunkSnapshot = [...corpus.chunks];
    const referenceSnapshot = [...corpus.references];
    const total = chunkSnapshot.length + referenceSnapshot.length;
    const steps = buildLookupIndexSteps(chunkSnapshot, referenceSnapshot);
    let sliceStart = performance.now(), inSlice = 0;
    check();
    for (;;) {
      const step = steps.next();
      check();
      if (step.done) {
        if (step.value.chunkSignature !== chunkSignature(corpus.chunks)
          || step.value.referenceSignature !== referenceSignature(corpus.references)) {
          if (attempt === maxSourceChangeRetries) throw lookupSourceChangedError();
          break;
        }
        // Canonical cache revision sorting/hashing also belongs to preparation,
        // not the user's first search. Subsequent queries reuse it only after
        // ensureLookupIndex has checked the mutable signatures.
        corpusRevisionForValidatedLookup(corpus, step.value);
        options.onProgress?.({ completed: total, total });
        check();
        lookupByCorpus.set(corpus, step.value);
        return step.value;
      }
      if (++inSlice >= batchSize || performance.now() - sliceStart >= maxSliceMs) {
        options.onProgress?.({ completed: step.value, total });
        await yieldControl();
        check();
        inSlice = 0; sliceStart = performance.now();
      }
    }
  }
  throw lookupSourceChangedError();
}

export function getLookupIndex(corpus: RagCorpus): RagLookupIndex | undefined {
  return lookupByCorpus.get(corpus);
}

export function ensureLookupIndex(corpus: RagCorpus): RagLookupIndex {
  const existing = lookupByCorpus.get(corpus);
  if (!existing) return attachLookupIndex(corpus);
  if (existing.chunkSignature !== chunkSignature(corpus.chunks)) return attachLookupIndex(corpus);
  const currentReferenceCounts = referenceCounts(corpus.references);
  if (!sameReferenceCounts(existing.referenceKeyCounts, currentReferenceCounts)) {
    refreshReferenceAdjacency(existing, corpus.references);
  }
  return existing;
}

export function buildLookupIndex(chunks: readonly RagChunk[], references: readonly ReferenceEdge[] = []): RagLookupIndex {
  const steps = buildLookupIndexSteps(chunks, references);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

function* buildLookupIndexSteps(chunks: readonly RagChunk[], references: readonly ReferenceEdge[]): Generator<number, RagLookupIndex> {
  const byNumericId = new Map<number, number[]>();
  const byNumericPrefix = new Map<string, number[]>();
  const byToken = new Map<string, number[]>();
  const byUri = new Map<string, number[]>();
  const bySymbolUri = new Map<string, RagChunk>();
  const bySymbolUriAll = new Map<string, RagChunk[]>();
  const chunkHash = createHash('sha256');

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
    // tokenize already retains complete atomic addresses; repeating the same
    // extraction only scans/allocates the body a second time.
    for (const bigram of cjkBigrams(text)) {
      push(byToken, bigram, index);
    }
    chunkHash.update(chunkIdentity(chunk)).update('\u0000');
    yield index + 1;
  }
  const adjacency = new Map<string, RagAdjacentReference[]>();
  const referenceKeyCounts = new Map<string, { fromUri: string; toUri: string; count: number }>();
  for (let i = 0; i < references.length; i++) {
    const edge = references[i]!;
    addAdjacent(adjacency, edge.fromUri, edge.toUri, edge);
    addAdjacent(adjacency, edge.toUri, edge.fromUri, edge);
    const key = referenceEdgeKey(edge);
    const digest = createHash('sha256').update(key).digest('hex');
    recordReference(referenceKeyCounts, digest, edge);
    yield chunks.length + i + 1;
  }
  for (const list of adjacency.values()) {
    sortAdjacent(list);
  }
  const index: RagLookupIndex = {
    byNumericId,
    byNumericPrefix,
    byToken,
    byUri,
    bySymbolUri,
    bySymbolUriAll,
    adjacency,
    adjacencyEdges: [...references],
    referenceKeyCounts,
    referenceSignature: referenceSignature(references),
    chunkSignature: chunkHash.digest('hex')
  };
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
  for (const edge of edges) {
    addAdjacent(adjacency, edge.fromUri, edge.toUri, edge);
    addAdjacent(adjacency, edge.toUri, edge.fromUri, edge);
  }
  for (const list of adjacency.values()) sortAdjacent(list);
  return adjacency;
}

function addAdjacent(adjacency: Map<string, RagAdjacentReference[]>, uri: string, otherUri: string, edge: ReferenceEdge): void {
  const list = adjacency.get(uri);
  const adjacent = { ...edge, otherUri, other: otherUri };
  if (list) list.push(adjacent);
  else adjacency.set(uri, [adjacent]);
}

function sortAdjacent(list: RagAdjacentReference[]): void {
  list.sort((left, right) => compareCodePointText(left.otherUri, right.otherUri)
    || confidenceRank(left.confidence) - confidenceRank(right.confidence)
    || compareCodePointText(left.kind, right.kind));
}

/**
 * Refresh only adjacency buckets touched by changed edges.  The inverted
 * token/numeric maps remain valid during an incremental reference refresh.
 */
export function refreshReferenceAdjacency(index: RagLookupIndex, edges: readonly ReferenceEdge[]): void {
  const snapshot = (values: readonly ReferenceEdge[]): { counts: NonNullable<RagLookupIndex['referenceKeyCounts']>; signature: string } => {
    const map = referenceCounts(values);
    return { counts: map, signature: referenceSignature(values) };
  };
  // Primitive endpoint/count snapshots detect duplicate-count changes and
  // in-place edits; a shallow array of caller-owned edges cannot do that.
  const oldByKey = index.referenceKeyCounts ?? snapshot(index.adjacencyEdges ?? []).counts;
  const next = snapshot(edges);
  const nextByKey = next.counts;
  const affected = new Set<string>();
  for (const [key, edge] of oldByKey) {
    if (nextByKey.get(key)?.count !== edge.count) {
      affected.add(edge.fromUri);
      affected.add(edge.toUri);
    }
  }
  for (const [key, edge] of nextByKey) {
    if (oldByKey.get(key)?.count !== edge.count) {
      affected.add(edge.fromUri);
      affected.add(edge.toUri);
    }
  }
  if (index.referenceSignature === '') {
    index.adjacency = buildReferenceAdjacency(edges);
  } else {
    // Walk edges once, not once per affected URI (quadratic for a map refresh).
    const rebuilt = new Map<string, RagAdjacentReference[]>();
    for (const edge of edges) {
      if (affected.has(edge.fromUri)) addAdjacent(rebuilt, edge.fromUri, edge.toUri, edge);
      if (affected.has(edge.toUri)) addAdjacent(rebuilt, edge.toUri, edge.fromUri, edge);
    }
    for (const uri of affected) {
      const list = rebuilt.get(uri);
      if (list && list.length > 0) { sortAdjacent(list); index.adjacency.set(uri, list); }
      else index.adjacency.delete(uri);
    }
  }
  index.adjacencyEdges = [...edges];
  index.referenceKeyCounts = nextByKey;
  index.referenceSignature = next.signature;
}

function recordReference(map: NonNullable<RagLookupIndex['referenceKeyCounts']>, key: string, edge: ReferenceEdge): void {
  const existing = map.get(key);
  if (existing) existing.count++;
  else map.set(key, { fromUri: edge.fromUri, toUri: edge.toUri, count: 1 });
}

function referenceCounts(edges: readonly ReferenceEdge[]): NonNullable<RagLookupIndex['referenceKeyCounts']> {
  const counts: NonNullable<RagLookupIndex['referenceKeyCounts']> = new Map();
  for (const edge of edges) {
    const key = createHash('sha256').update(referenceEdgeKey(edge)).digest('hex');
    recordReference(counts, key, edge);
  }
  return counts;
}

function sameReferenceCounts(
  left: NonNullable<RagLookupIndex['referenceKeyCounts']> | undefined,
  right: NonNullable<RagLookupIndex['referenceKeyCounts']>
): boolean {
  if (!left || left.size !== right.size) return false;
  for (const [key, value] of right) {
    const previous = left.get(key);
    if (!previous || previous.count !== value.count
      || previous.fromUri !== value.fromUri || previous.toUri !== value.toUri) return false;
  }
  return true;
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
  // Reference adjacency is sorted independently, so source ordering is not a
  // semantic change. Hash a deterministic multiset while referenceCounts()
  // lets ensureLookupIndex skip a rebuild for pure reordering.
  const hash = createHash('sha256');
  const keys = edges.map(referenceEdgeKey).sort(compareCodePointText);
  for (const key of keys) hash.update(key).update('\u0000');
  return hash.digest('hex');
}

function chunkSignature(chunks: readonly RagChunk[]): string {
  // The inverted maps store positions into `chunks`, so a reorder is a real
  // index change even when the same chunk identities/content are present.  An
  // ordered signature also avoids sorting every chunk signature with the
  // code-point comparator on every ensureLookupIndex call.  Keep the source
  // and content identity fields here; provenance changes must still rebuild
  // the index.
  const hash = createHash('sha256');
  for (const chunk of chunks) hash.update(chunkIdentity(chunk)).update('\u0000');
  return hash.digest('hex');
}

function chunkIdentity(chunk: RagChunk): string {
  return JSON.stringify([
    chunk.chunkId,
    chunk.workspaceId,
    chunk.sourceUri,
    chunk.symbolUri,
    chunk.family,
    chunk.contentHash,
    chunk.outerFileHash,
    chunk.sourceRevision,
    chunk.sourceHash
  ]);
}

function lookupSourceChangedError(): Error {
  return Object.assign(new Error('RAG corpus changed while its lookup index was being built.'), {
    code: 'RAG_LOOKUP_SOURCE_CHANGED'
  });
}
