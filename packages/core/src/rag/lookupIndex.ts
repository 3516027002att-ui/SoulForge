/**
 * In-memory inverted index for workspace RAG.
 *
 * retrieveEvidence used to score every chunk. After analyze, a real Sekiro
 * workspace is tens of thousands of param/text/event rows — that linear scan
 * is the slow path. FTS tables exist in SQLite but the Agent tool never
 * called them. This index is built once with the corpus and used to gather
 * a candidate set before the existing scorer runs.
 */
import type { RagChunk, RagChunkFamily, RagCorpus } from '@soulforge/shared';
import { extractAtomicAddressTokens } from '@soulforge/shared';
import { cjkBigrams, tokenize } from './queryParse.js';

export interface RagLookupIndex {
  byNumericId: Map<number, number[]>;
  byNumericPrefix: Map<string, number[]>;
  byToken: Map<string, number[]>;
  byUri: Map<string, number[]>;
  bySymbolUri: Map<string, RagChunk>;
}

const lookupByCorpus = new WeakMap<RagCorpus, RagLookupIndex>();

export function attachLookupIndex(corpus: RagCorpus): RagLookupIndex {
  const index = buildLookupIndex(corpus.chunks);
  lookupByCorpus.set(corpus, index);
  return index;
}

export function getLookupIndex(corpus: RagCorpus): RagLookupIndex | undefined {
  return lookupByCorpus.get(corpus);
}

export function ensureLookupIndex(corpus: RagCorpus): RagLookupIndex {
  return lookupByCorpus.get(corpus) ?? attachLookupIndex(corpus);
}

export function buildLookupIndex(chunks: readonly RagChunk[]): RagLookupIndex {
  const byNumericId = new Map<number, number[]>();
  const byNumericPrefix = new Map<string, number[]>();
  const byToken = new Map<string, number[]>();
  const byUri = new Map<string, number[]>();
  const bySymbolUri = new Map<string, RagChunk>();

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]!;
    bySymbolUri.set(chunk.symbolUri, chunk);
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

  return { byNumericId, byNumericPrefix, byToken, byUri, bySymbolUri };
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
  families: ReadonlySet<RagChunkFamily> | null
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
    if (families && !families.has(chunk.family)) continue;
    selected.push(chunk);
  }
  return selected;
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
