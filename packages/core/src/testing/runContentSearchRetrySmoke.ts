import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createOpaqueCursor, parseOpaqueCursor } from '@soulforge/shared';
import { contentSearchPage } from '../ai/contentSearchPage.js';
import { assertCursorPrivacy } from './harness/assertCursorPrivacy.js';

let rows = [0, 1, 2, 3, 4, 5, 6, 7];
const privateWorkspace = 'file:///C:/Users/Alice/private-mod-workspace';
const options = { tool: 'search_param_rows' as const, workspaceId: privateWorkspace,
  search: () => rows, fingerprint: (row: number) => row };
const first = contentSearchPage({ ...options, input: { query: 'needle', limit: 3 } });
assert.equal(assertCursorPrivacy(first, [privateWorkspace, '/Users/Alice', 'private-mod-workspace']), 2, 'nextCursor and nextActions[].args.cursor');
assert.equal(parseOpaqueCursor(first.nextCursor!).sessionId, 'content-search-v3');
const retry = contentSearchPage({ ...options, input: { cursor: first.nextCursor, limit: 1 } });
assert.equal(retry.offset, 3);
assert.deepEqual(retry.matches, [3]);
assert.equal(assertCursorPrivacy(retry, [privateWorkspace, 'private-mod-workspace']), 2);
const delivered = [...first.matches, ...retry.matches];
let page = retry;
while (page.nextCursor) {
  page = contentSearchPage({ ...options, input: { cursor: page.nextCursor } });
  delivered.push(...page.matches);
}
assert.deepEqual(delivered, rows);
assert.throws(() => contentSearchPage({ ...options, input: { cursor: first.nextCursor, query: 'other', limit: 1 } }), /条件/);
assert.throws(() => contentSearchPage({ ...options, input: { cursor: first.nextCursor, paramNames: ['other'], limit: 1 } }), /条件/);
assert.throws(() => contentSearchPage({ ...options, input: { cursor: first.nextCursor, limit: 4 } }), /扩大/);
assert.throws(() => contentSearchPage({ ...options, input: { cursor: first.nextCursor, offset: 0, limit: 1 } }), /offset/);
assert.throws(() => contentSearchPage({ ...options, workspaceId: 'other', input: { cursor: first.nextCursor, limit: 1 } }), /工作区/);

// Pre-hash cursors embedded the absolute workspace URL. They are rejected with
// the existing structured mismatch code, not migrated: v1 (window size in the
// snapshot hash) and v2 (the format HEAD emitted before this change).
const scope = { workspaceId: options.workspaceId, tool: options.tool, query: 'needle', paramNames: [], limit: 3 };
const hash = createHash('sha256').update(JSON.stringify(scope));
for (const row of rows) hash.update('\0').update(JSON.stringify(row));
const legacyV1 = createOpaqueCursor({ sessionId: 'content-search-v1', domain: 'param',
  scope: JSON.stringify(scope), sourceHash: hash.digest('hex'), offset: 3 });
const legacyV2 = createOpaqueCursor({ ...parseOpaqueCursor(first.nextCursor!), sessionId: 'content-search-v2', scope: JSON.stringify(scope) });
for (const legacy of [legacyV1, legacyV2]) {
  assert.throws(() => contentSearchPage({ ...options, input: { cursor: legacy, limit: 1 } }), (error: unknown) => {
    assert.ok(!String(error).includes('private-mod-workspace'), 'rejection must not echo the decodable path');
    return (error as { code?: string }).code === 'SEARCH_CURSOR_SCOPE_MISMATCH';
  });
}
// A v3 scope that smuggles the raw workspace id instead of its digest is rejected too.
const rawV3 = createOpaqueCursor({ ...parseOpaqueCursor(first.nextCursor!), scope: JSON.stringify(scope) });
assert.throws(() => contentSearchPage({ ...options, input: { cursor: rawV3, limit: 1 } }), { code: 'SEARCH_CURSOR_SCOPE_MISMATCH' });
rows = [...rows, 8];
assert.throws(() => contentSearchPage({ ...options, input: { cursor: first.nextCursor, limit: 1 } }), /变化/);
console.log('Content search current-page shrink and legacy cursor rejection smoke passed.');
