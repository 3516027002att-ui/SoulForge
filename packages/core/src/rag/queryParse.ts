export interface ParsedRagQuery {
  raw: string;
  terms: string[];
  phrases: string[];
  numericIds: number[];
  uris: string[];
}

const URI_PATTERN = /\b(?:file|event|map|param|text|soulforge):\/\/[^\s"'<>]+/gi;
const QUOTED_PATTERN = /"([^"]{1,200})"|“([^”]{1,200})”/g;
const NUMERIC_PATTERN = /\b\d{1,12}\b/g;
const CJK_PATTERN = /[\u3400-\u9fff]/;

export function parseRagQuery(raw: string): ParsedRagQuery {
  const trimmed = raw.trim();
  const uris = unique(matchAll(trimmed, URI_PATTERN));
  const phrases = unique(
    [...trimmed.matchAll(QUOTED_PATTERN)]
      .map((match) => (match[1] ?? match[2] ?? '').trim())
      .filter((value) => value.length > 0)
  );

  let remainder = trimmed;
  for (const uri of uris) remainder = remainder.replaceAll(uri, ' ');
  remainder = remainder.replace(QUOTED_PATTERN, ' ');

  const numericIds = uniqueNumbers(matchAll(remainder, NUMERIC_PATTERN).map((value) => Number(value)));
  const terms = tokenize(remainder).filter((term) => !/^\d+$/.test(term));

  if (terms.length === 0 && phrases.length === 0 && CJK_PATTERN.test(trimmed)) {
    phrases.push(trimmed);
    // 整串之外再产出 2 字 bigram：用户只记得部分词（「义手」）也能命中
    // 含完整短语（「狼的义手」）的 chunk —— 复用 phrase-body includes 匹配。
    for (const bigram of cjkBigrams(trimmed)) phrases.push(bigram);
  }

  return { raw: trimmed, terms, phrases, numericIds, uris };
}

/** 连续 CJK 片段切 2 字 bigram；非 CJK 字符打断片段。 */
export function cjkBigrams(value: string): string[] {
  const bigrams: string[] = [];
  let run = '';
  for (const char of value) {
    if (CJK_PATTERN.test(char)) {
      run += char;
    } else {
      pushBigrams(run, bigrams);
      run = '';
    }
  }
  pushBigrams(run, bigrams);
  return bigrams;
}

function pushBigrams(run: string, out: string[]): void {
  if (run.length < 2) return;
  for (let i = 0; i <= run.length - 2; i += 1) {
    out.push(run.slice(i, i + 2));
  }
}

export function tokenize(value: string): string[] {
  return unique(
    value
      .toLowerCase()
      .replaceAll('_', ' ')
      .replaceAll(':', ' ')
      .replaceAll('/', ' ')
      .replaceAll('\\', ' ')
      .replaceAll('.', ' ')
      .replaceAll('-', ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 2 || /^\d+$/.test(token))
  );
}

function matchAll(value: string, pattern: RegExp): string[] {
  return [...value.matchAll(pattern)].map((match) => match[0]).filter((item) => item.length > 0);
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function uniqueNumbers(values: readonly number[]): number[] {
  const seen = new Set<number>();
  const result: number[] = [];
  for (const value of values) {
    if (!Number.isFinite(value) || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}
