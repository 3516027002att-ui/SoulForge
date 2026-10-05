import { createOpaqueCursor, parseOpaqueCursor } from '@soulforge/shared';
import { cursorIdentity } from '../workspace/cursorIdentity.js';

export interface ScopedEventSearchScope { workspaceId: string; file: string; query: string }
const SESSION = 'scoped-event-search-v2';
export function createScopedEventSearchCursor(scope: ScopedEventSearchScope, sourceHash: string, offset: number): string {
  return createOpaqueCursor({ sessionId: SESSION, domain: 'emevd',
    scope: JSON.stringify({ ...scope, workspaceId: cursorIdentity(scope.workspaceId) }), sourceHash, offset });
}
export function readScopedEventSearchCursor(cursor: string, workspaceId: string) {
  const payload = parseOpaqueCursor(cursor);
  if (payload.sessionId !== SESSION && payload.sessionId !== 'scoped-event-search-v1') return undefined;
  let scope: ScopedEventSearchScope;
  try { scope = JSON.parse(payload.scope) as ScopedEventSearchScope; }
  catch { throw Object.assign(new Error('事件搜索游标范围无效。'), { code: 'INVALID_READ_CURSOR' }); }
  const expectedWorkspaceId = payload.sessionId === SESSION ? cursorIdentity(workspaceId) : workspaceId;
  if (payload.domain !== 'emevd' || scope?.workspaceId !== expectedWorkspaceId || typeof scope.file !== 'string'
    || !scope.file || typeof scope.query !== 'string' || !scope.query
    || !Number.isSafeInteger(payload.offset) || payload.offset < 0) {
    throw Object.assign(new Error('事件搜索游标不属于当前工作区或来源。'), { code: 'EVENT_SEARCH_CURSOR_SCOPE_MISMATCH' });
  }
  return { scope: { ...scope, workspaceId }, sourceHash: payload.sourceHash, offset: payload.offset };
}
