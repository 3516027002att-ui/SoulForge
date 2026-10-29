import { createOpaqueCursor, parseOpaqueCursor, sanitizeCursorScope } from '@soulforge/shared';

export interface ScopedEventSearchScope { workspaceId: string; file: string; query: string }
const SESSION = 'scoped-event-search-v1';
export function createScopedEventSearchCursor(scope: ScopedEventSearchScope, sourceHash: string, offset: number): string {
  // Cursor scopes are stripped of host paths on encode, and `file` is needed
  // again after decode to re-read the source. The workspace index owns
  // relative `file://...` URIs, so an absolute one means the caller broke that
  // invariant; silently paging a rewritten source is worse than failing closed.
  if (sanitizeCursorScope(scope.file) !== scope.file) {
    throw Object.assign(new Error('事件搜索游标只能绑定工作区相对的来源 URI，不能绑定主机绝对路径。'), {
      code: 'EVENT_SEARCH_CURSOR_HOST_PATH'
    });
  }
  return createOpaqueCursor({ sessionId: SESSION, domain: 'emevd', scope: JSON.stringify(scope), sourceHash, offset });
}
export function readScopedEventSearchCursor(cursor: string, workspaceId: string) {
  const payload = parseOpaqueCursor(cursor);
  if (payload.sessionId !== SESSION) return undefined;
  let scope: ScopedEventSearchScope;
  try { scope = JSON.parse(payload.scope) as ScopedEventSearchScope; }
  catch { throw Object.assign(new Error('事件搜索游标范围无效。'), { code: 'INVALID_READ_CURSOR' }); }
  // The cursor stores a redacted workspace binding; accept the raw identity too
  // so cursors minted before the redaction stay usable.
  const workspaceMatches = scope?.workspaceId === workspaceId
    || scope?.workspaceId === sanitizeCursorScope(workspaceId);
  if (payload.domain !== 'emevd' || !workspaceMatches || typeof scope.file !== 'string'
    || !scope.file || typeof scope.query !== 'string' || !scope.query
    || !Number.isSafeInteger(payload.offset) || payload.offset < 0) {
    throw Object.assign(new Error('事件搜索游标不属于当前工作区或来源。'), { code: 'EVENT_SEARCH_CURSOR_SCOPE_MISMATCH' });
  }
  return { scope, sourceHash: payload.sourceHash, offset: payload.offset };
}
