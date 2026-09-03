import type {
  RagChunk,
  RagChunkFamily,
  RagCorpus,
  RagHit,
  RagRetrieveOptions,
  RagRetrieveResult,
  ReferenceEdge
} from '@soulforge/shared';
import { RAG_CHUNK_FAMILIES } from '@soulforge/shared';
import { parseRagQuery, type ParsedRagQuery } from './queryParse.js';
import { collectIndexedCandidates, ensureLookupIndex } from './lookupIndex.js';

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 32;
const DEFAULT_EXCERPT = 420;

export function retrieveEvidence(
  corpus: RagCorpus | null | undefined,
  query: string,
  options: RagRetrieveOptions = {}
): RagRetrieveResult {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: 'retrieve_evidence 需要非空 query。'
    };
  }
  if (!corpus) {
    return {
      ok: false,
      code: 'insufficient_evidence',
      message: '没有可检索的工作区证据。先打开 Mod 工作区并完成扫描或分析。'
    };
  }
  if (corpus.availability !== 'available') {
    const detail = corpus.diagnostics.find((diagnostic) => diagnostic.code === 'RAG_SEMANTIC_CORPUS_EMPTY')?.message
      ?? 'RAG 语义语料不可用。先完成工作区原生分析并确认语义索引非空。';
    return {
      ok: false,
      code: 'RAG_UNAVAILABLE',
      message: detail
    };
  }
  if (corpus.chunks.length === 0) {
    return {
      ok: false,
      code: 'insufficient_evidence',
      message: '没有可检索的工作区证据。先打开 Mod 工作区并完成扫描或分析。'
    };
  }

  const parsed = parseRagQuery(trimmed);
  const families = normalizeFamilies(options.families);
  const lookup = ensureLookupIndex(corpus);
  const indexed = collectIndexedCandidates(corpus.chunks, lookup, parsed, families);
  const hasKeys = parsed.numericIds.length + parsed.terms.length + parsed.phrases.length + parsed.uris.length > 0;
  const candidates = hasKeys ? indexed : (families
    ? corpus.chunks.filter((chunk) => families.has(chunk.family))
    : corpus.chunks);
  const excerptChars = clampInt(options.excerptChars, DEFAULT_EXCERPT, 120, 1_200);
  const limit = clampInt(options.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);

  const scored: RagHit[] = [];
  for (const chunk of candidates) {
    const hit = scoreChunk(chunk, parsed, excerptChars);
    if (hit) scored.push(hit);
  }
  scored.sort((a, b) => b.score - a.score);

  const primary = scored.slice(0, limit);
  const expand = options.expandReferences !== false;
  const expanded = expand
    ? expandHits(primary, lookup.bySymbolUri, corpus.references, excerptChars, limit)
    : primary;
  const truncated = scored.length > expanded.length;

  if (expanded.length === 0) {
    return {
      ok: false,
      code: 'insufficient_evidence',
      message: `查询「${trimmed}」没有命中已索引的事件、地图、参数、文本或文件。`
    };
  }

  return {
    ok: true,
    query: trimmed,
    hits: expanded,
    retrievalMode: 'lexical',
    stats: {
      scanned: candidates.length,
      matched: scored.length,
      expanded: Math.max(0, expanded.length - primary.length),
      truncated
    }
  };
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
      // 用户给的 ID 是库中 ID 的前缀（少写/记错尾数）：低分命中，至少不丢。
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
  // 多 term 查询允许半数命中（用户口语化查询常混入噪音词）；结构化命中豁免。
  if (query.terms.length > 1
    && termsMatched < Math.ceil(query.terms.length / 2)
    && !structured) {
    return null;
  }

  if (score <= 0) return null;
  return {
    chunk,
    score,
    reasons,
    excerpt: excerptAround(chunk.body, firstNeedle(query), excerptChars)
  };
}

/** 查询数字是库中数字的前缀、且长度差 ≤2 位（用户少写/记错尾数）。 */
function isIdPrefixMatch(queryId: number, candidate: number): boolean {
  if (queryId <= 0 || candidate <= 0) return false;
  const queryText = String(queryId);
  const candidateText = String(candidate);
  if (candidateText.length - queryText.length > 2 || candidateText.length <= queryText.length) return false;
  return candidateText.startsWith(queryText);
}

function expandHits(
  primary: readonly RagHit[],
  byUri: ReadonlyMap<string, RagChunk>,
  references: readonly ReferenceEdge[],
  excerptChars: number,
  limit: number
): RagHit[] {
  if (primary.length === 0 || references.length === 0) return [...primary];
  const seen = new Set(primary.map((hit) => hit.chunk.chunkId));
  const extra: RagHit[] = [];

  for (const hit of primary) {
    for (const edge of references) {
      const other = otherUri(edge, hit.chunk.symbolUri);
      if (!other) continue;
      const related = byUri.get(other);
      if (!related || seen.has(related.chunkId)) continue;
      seen.add(related.chunkId);
      extra.push({
        chunk: related,
        // 扩展命中按引用边置信度衰减：高置信边带得更近，低置信只作线索。
        score: Math.max(1, Math.round(hit.score * (EXPANSION_WEIGHTS[edge.confidence] ?? 0.35))),
        reasons: [`expanded:${edge.kind}:${edge.confidence}`],
        excerpt: excerptAround(related.body, '', excerptChars),
        expandedFrom: hit.chunk.symbolUri
      });
      if (primary.length + extra.length >= limit) {
        return [...primary, ...extra];
      }
    }
  }
  return [...primary, ...extra];
}

/** 一跳引用扩展的置信度衰减系数（high/medium/low）。 */
const EXPANSION_WEIGHTS: Record<ReferenceEdge['confidence'], number> = {
  high: 0.7,
  medium: 0.5,
  low: 0.35
};

function otherUri(edge: ReferenceEdge, uri: string): string | null {
  if (edge.fromUri === uri) return edge.toUri;
  if (edge.toUri === uri) return edge.fromUri;
  return null;
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

function normalizeFamilies(families: readonly RagChunkFamily[] | undefined): Set<RagChunkFamily> | null {
  if (!families || families.length === 0) return null;
  const allowed = new Set<RagChunkFamily>(RAG_CHUNK_FAMILIES);
  const selected = families.filter((family): family is RagChunkFamily => allowed.has(family));
  return selected.length > 0 ? new Set(selected) : null;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
