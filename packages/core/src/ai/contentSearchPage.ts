import { createHash } from 'node:crypto';
import { createOpaqueCursor, parseOpaqueCursor } from '@soulforge/shared';

type SearchTool = 'search_param_rows' | 'search_text_entries';
interface SearchScope {
  workspaceId: string;
  tool: SearchTool;
  query: string;
  paramNames: string[];
  limit: number;
}

function invalid(message: string, code = 'SEARCH_CURSOR_SCOPE_MISMATCH'): never {
  throw Object.assign(new Error(message), { code });
}

/** Keep the search window aligned with the Agent's six-item content envelope. */
export function contentSearchPage<T>(options: {
  tool: SearchTool;
  workspaceId: string;
  input: Record<string, unknown>;
  search: (query: string, paramNames: string[]) => T[];
  fingerprint: (match: T) => unknown;
}) {
  const input = options.input;
  const requestedLimit = input.limit ?? 6;
  if (typeof requestedLimit !== 'number' || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
    invalid('limit 必须是正整数。', 'INVALID_SEARCH_WINDOW');
  }
  const paramNames = Array.isArray(input.paramNames)
    ? input.paramNames.filter((value): value is string => typeof value === 'string').map((name) => name.trim()).filter(Boolean).sort()
    : [];
  let scope: SearchScope = {
    workspaceId: options.workspaceId, tool: options.tool,
    query: typeof input.query === 'string' ? input.query : '',
    paramNames, limit: Math.min(6, requestedLimit)
  };
  let offset = input.offset ?? 0;
  let expectedHash: string | undefined;
  const domain = options.tool === 'search_param_rows' ? 'param' : 'fmg';
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== 'string' || input.offset !== undefined) invalid('续页只传 cursor，不同时传 offset。');
    const payload = parseOpaqueCursor(input.cursor);
    if (payload.sessionId !== 'content-search-v1' || payload.domain !== domain) invalid('游标不属于当前内容搜索。');
    let parsed: SearchScope;
    try { parsed = JSON.parse(payload.scope) as SearchScope; }
    catch { invalid('搜索游标范围无效。'); }
    if (!parsed || parsed.workspaceId !== options.workspaceId || parsed.tool !== options.tool
      || typeof parsed.query !== 'string' || !Array.isArray(parsed.paramNames)
      || parsed.paramNames.some((name) => typeof name !== 'string')
      || !Number.isSafeInteger(parsed.limit) || parsed.limit < 1 || parsed.limit > 6) invalid('游标与当前工作区或搜索工具不匹配。');
    if ((input.query !== undefined && input.query !== parsed.query)
      || (input.paramNames !== undefined && JSON.stringify(paramNames) !== JSON.stringify(parsed.paramNames))
      || (input.limit !== undefined && scope.limit !== parsed.limit)) invalid('续页时不能改变搜索条件。');
    scope = parsed;
    offset = payload.offset;
    expectedHash = payload.sourceHash;
  }
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) invalid('offset 必须是非负整数。', 'INVALID_SEARCH_WINDOW');
  const all = options.search(scope.query, scope.paramNames);
  const hash = createHash('sha256').update(JSON.stringify(scope));
  for (const match of all) hash.update('\0').update(JSON.stringify(options.fingerprint(match)));
  const sourceHash = hash.digest('hex');
  if (expectedHash !== undefined && expectedHash !== sourceHash) invalid('搜索结果已变化，请重新搜索。', 'STALE_READ_CURSOR');
  const matches = all.slice(offset, offset + scope.limit);
  const end = offset + matches.length;
  const truncated = end < all.length;
  const nextCursor = truncated ? createOpaqueCursor({
    sessionId: 'content-search-v1', domain, scope: JSON.stringify(scope), sourceHash, offset: end
  }) : undefined;
  return {
    query: scope.query, matches, total: all.length, totalCount: all.length,
    offset, limit: scope.limit, returned: matches.length, returnedCount: matches.length,
    truncated, ...(nextCursor ? { nextCursor } : {}),
    nextActions: nextCursor ? [{ tool: options.tool, args: { cursor: nextCursor }, reason: '继续读取后续搜索结果' }] : []
  };
}
