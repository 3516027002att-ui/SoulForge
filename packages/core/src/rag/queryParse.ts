import { extractAtomicAddressTokens } from '@soulforge/shared';

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
const CJK_RUN_PATTERN = /[\u3400-\u9fff]{2,}/g;

export function parseRagQuery(raw: string): ParsedRagQuery {
  const trimmed = raw.trim();
  const uris = unique(matchAll(trimmed, URI_PATTERN));
  const phraseValues = [
    [...trimmed.matchAll(QUOTED_PATTERN)]
      .map((match) => (match[1] ?? match[2] ?? '').trim())
      .filter((value) => value.length > 0)
  ].flat();

  let remainder = trimmed;
  // Keep a masked copy for numeric classification. It retains the Chinese
  // words around a number ("血条为2" / "持续5秒") while removing numbers
  // embedded in a URI or an explicitly quoted phrase.
  let numericSource = trimmed;
  for (const uri of uris) {
    const mask = ' '.repeat(uri.length);
    remainder = remainder.replaceAll(uri, mask);
    numericSource = numericSource.replaceAll(uri, mask);
  }
  remainder = remainder.replace(QUOTED_PATTERN, (match) => ' '.repeat(match.length));
  numericSource = numericSource.replace(QUOTED_PATTERN, (match) => ' '.repeat(match.length));

  // 中文请求通常把多个意图写在同一句里。如果把整段连续中文交给
  // tokenize，它会成为一个必须完整出现的超长 term，任何只包含对象名的
  // PARAM/地图条目都会被过滤掉。连续片段用 phrase + 二字短语检索，
  // phrase 命中不参加多 term 的半数门槛。
  const cjkRuns = matchAll(remainder, CJK_RUN_PATTERN);
  for (const run of cjkRuns) {
    phraseValues.push(run, ...cjkBigrams(run));
    // Keep offsets stable while removing the natural-language phrase.  The
    // numeric classifier below uses the surrounding words to distinguish an
    // object ID from a task value such as "血条为 2" or "持续 5 秒".
    remainder = remainder.replace(new RegExp(escapeRegExp(run), 'g'), ' '.repeat(run.length));
  }

  // 完整原子地址（带 `#` 或下划线四段块）进 phrases：m11_01_00_00 作为一个
  // 不可拆的短语，命中索引 / 正文里同一个原子词（问题 6）。
  for (const atomic of extractAtomicAddressTokens(remainder)) {
    if (atomic.includes('#') || atomic.includes('_')) phraseValues.push(atomic);
  }

  const numericIds = extractNumericIds(numericSource);
  const terms = tokenize(remainder).filter((term) => !/^\d+$/.test(term));

  if (terms.length === 0 && phraseValues.length === 0 && CJK_PATTERN.test(trimmed)) {
    phraseValues.push(trimmed);
    // 整串之外再产出 2 字 bigram：用户只记得部分词（「义手」）也能命中
    // 含完整短语（「狼的义手」）的 chunk —— 复用 phrase-body includes 匹配。
    phraseValues.push(...cjkBigrams(trimmed));
  }

  return { raw: trimmed, terms, phrases: unique(phraseValues), numericIds, uris };
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
  // 先抽原子地址（c1050 / A0200 / a000_020000 / M11 / m11_01_00_00 / 带 # 完整
  // 地址），这些 token 原样保留，不交给下面的 replaceAll 切词，避免 m11_01_00_00
  // 被拆成 m11 01 00 00、a000_020000 被拆成 a000 与 020000。原子 token 一律小写、
  // 保持下划线（问题 6 缺口 1）。
  const atomic = extractAtomicAddressTokens(value);
  let remainder = value;
  for (const token of atomic) {
    remainder = remainder.replace(new RegExp(escapeRegExp(token), 'gi'), ' ');
  }
  const sliced = unique(
    remainder
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
  return unique([...atomic, ...sliced]);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

/**
 * Only promote numbers that look like identifiers.  A natural-language task
 * commonly contains small configuration values (health-bar count, duration,
 * retry count, etc.). Treating every number as an ID made a query such as
 * "血条设置为2，落雷5秒" rank map entities whose native IDs happened to be 2
 * or 5 above the actual character evidence.
 *
 * Long numeric tokens remain searchable by default because Sekiro IDs are
 * often written without a label. Short tokens are retained only when the
 * query explicitly supplies an ID context or consists solely of that number.
 */
function extractNumericIds(value: string): number[] {
  const matches = [...value.matchAll(NUMERIC_PATTERN)];
  const kept: number[] = [];
  for (const match of matches) {
    const token = match[0];
    if (!token) continue;
    const start = match.index ?? 0;
    const before = value.slice(Math.max(0, start - 24), start);
    const after = value.slice(start + token.length, start + token.length + 24);
    const explicit = isExplicitNumericIdContext(before);
    if (!explicit && isMeasurementContext(before, after)) continue;
    if (explicit || token.length >= 3) {
      kept.push(Number(token));
    }
  }
  return uniqueNumbers(kept);
}

function isExplicitNumericIdContext(before: string): boolean {
  return /(?:id|rowid|eventid|textid|entityid|paramid|flag|编号|行号|事件号|文本号|实体号|参数号)\s*[:=#]?\s*$/iu.test(before);
}

function isMeasurementContext(before: string, after: string): boolean {
  const context = `${before}${after}`;
  return /(?:血条|生命|健康|health|hp|持续|duration|落雷|秒|毫秒|milliseconds?|seconds?|\bms\b|\bs\b|条|个|次|层|级|等级|分钟|小时|数量|随机|设置为)/iu.test(context);
}
