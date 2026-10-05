import { createOpaqueCursor, parseOpaqueCursor } from '@soulforge/shared';
import { cursorIdentity } from '../workspace/cursorIdentity.js';

/** Exact, case-sensitive source search. Scans at most a page plus one lookahead; no full hit-list allocation. */
export function literalSourceSearchPage(input: {
  text: string; sourceKey: string; sourceHash: string; query: string; cursor?: string; limit?: number;
}) {
  const limit = input.limit ?? 4;
  const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };
  if (!input.query || input.query.length > 256) fail('INVALID_SOURCE_QUERY', 'query 必须为 1 到 256 个字符的精确源码片段。');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 6) fail('INVALID_SOURCE_WINDOW', 'limit 必须为 1 到 6 的整数。');
  const scope = JSON.stringify({ sourceKey: cursorIdentity(input.sourceKey), query: input.query });
  let start = 0;
  if (input.cursor) {
    const c = parseOpaqueCursor(input.cursor);
    const expectedScope = c.sessionId === 'literal-source-v1'
      ? JSON.stringify({ sourceKey: input.sourceKey, query: input.query }) : scope;
    if (!['literal-source-v1', 'literal-source-v2'].includes(c.sessionId) || c.domain !== 'script' || c.scope !== expectedScope) fail('SOURCE_CURSOR_SCOPE_MISMATCH', '源码搜索游标不匹配来源或查询。');
    if (c.sourceHash !== input.sourceHash) fail('STALE_READ_CURSOR', '源码已变化，请重新搜索。');
    start = c.offset;
  }
  if (!Number.isSafeInteger(start) || start < 0 || start > input.text.length) fail('INVALID_SOURCE_WINDOW', '源码搜索偏移无效。');
  const matches: Array<{ sourceOffset: number; matchOffset: number; line: number; snippet: string }> = [];
  const lineAt = (offset: number) => {
    let line = 1;
    for (let i = input.text.indexOf('\n'); i >= 0 && i < offset; i = input.text.indexOf('\n', i + 1)) line++;
    return line;
  };
  let position = input.text.indexOf(input.query, start);
  while (position >= 0 && matches.length < limit) {
    let sourceOffset = Math.max(input.text.lastIndexOf('\n', position) + 1, position - 80);
    if (sourceOffset > 0 && /[\uDC00-\uDFFF]/u.test(input.text[sourceOffset]!)) sourceOffset--;
    let end = Math.min(input.text.length, position + input.query.length + 80);
    if (end < input.text.length && /[\uDC00-\uDFFF]/u.test(input.text[end]!)) end++;
    matches.push({ sourceOffset, matchOffset: position, line: lineAt(position), snippet: input.text.slice(sourceOffset, end) });
    position = input.text.indexOf(input.query, position + input.query.length);
  }
  const hasMore = position >= 0;
  return {
    query: input.query, matches, returned: matches.length, returnedCount: matches.length, limit,
    hasMore, truncated: hasMore, searchComplete: !hasMore,
    scan: { offset: start, nextOffset: hasMore ? position : input.text.length, complete: !hasMore },
    ...(hasMore ? { nextCursor: createOpaqueCursor({ sessionId: 'literal-source-v2', domain: 'script', scope, sourceHash: input.sourceHash, offset: position }) } : {})
  };
}
