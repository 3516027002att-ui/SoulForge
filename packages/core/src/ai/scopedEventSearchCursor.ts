import { createOpaqueCursor, parseOpaqueCursor } from '@soulforge/shared';
import { cursorIdentity } from '../workspace/cursorIdentity.js';

export interface ScopedEventSearchScope { workspaceId: string; file: string; query: string }
// v2: the wire scope carries cursorIdentity(workspaceId), never the workspace URL.
const SESSION = 'scoped-event-search-v2';
const LEGACY_SESSION = 'scoped-event-search-v1';
export function createScopedEventSearchCursor(scope: ScopedEventSearchScope, sourceHash: string, offset: number): string {
  return createOpaqueCursor({ sessionId: SESSION, domain: 'emevd',
    scope: JSON.stringify({ ...scope, workspaceId: cursorIdentity(scope.workspaceId) }), sourceHash, offset });
}
export function readScopedEventSearchCursor(cursor: string, workspaceId: string) {
  const payload = parseOpaqueCursor(cursor);
  // Unhashed v1 cursors are rejected (not migrated); the agent re-queries.
  if (payload.sessionId === LEGACY_SESSION) {
    throw Object.assign(new Error('事件搜索游标已失效，请重新执行 search_events。'), { code: 'EVENT_SEARCH_CURSOR_SCOPE_MISMATCH' });
  }
  if (payload.sessionId !== SESSION) return undefined;
  let scope: ScopedEventSearchScope;
  try { scope = JSON.parse(payload.scope) as ScopedEventSearchScope; }
  catch { throw Object.assign(new Error('事件搜索游标范围无效。'), { code: 'INVALID_READ_CURSOR' }); }
  if (payload.domain !== 'emevd' || scope?.workspaceId !== cursorIdentity(workspaceId) || typeof scope.file !== 'string'
    || !scope.file || typeof scope.query !== 'string' || !scope.query
    || !Number.isSafeInteger(payload.offset) || payload.offset < 0) {
    throw Object.assign(new Error('事件搜索游标不属于当前工作区或来源。'), { code: 'EVENT_SEARCH_CURSOR_SCOPE_MISMATCH' });
  }
  // Restore the real workspace id in memory only.
  return { scope: { ...scope, workspaceId }, sourceHash: payload.sourceHash, offset: payload.offset };
}
