import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createOpaqueCursor } from '@soulforge/shared';
import { contentSearchPage } from '../ai/contentSearchPage.js';

let rows = [0, 1, 2, 3, 4, 5, 6, 7];
const options = { tool: 'search_param_rows' as const, workspaceId: 'test-workspace',
  search: () => rows, fingerprint: (row: number) => row };
const first = contentSearchPage({ ...options, input: { query: 'needle', limit: 3 } });
const retry = contentSearchPage({ ...options, input: { cursor: first.nextCursor, limit: 1 } });
assert.equal(retry.offset, 3);
assert.deepEqual(retry.matches, [3]);
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

// Legacy v1 tokens used the window size in the snapshot hash. Verify that exact
// old snapshot before migrating to a smaller v2 window at the SAME offset.
const scope = { workspaceId: options.workspaceId, tool: options.tool, query: 'needle', paramNames: [], limit: 3 };
const hash = createHash('sha256').update(JSON.stringify(scope));
for (const row of rows) hash.update('\0').update(JSON.stringify(row));
const legacy = createOpaqueCursor({ sessionId: 'content-search-v1', domain: 'param',
  scope: JSON.stringify(scope), sourceHash: hash.digest('hex'), offset: 3 });
assert.deepEqual(contentSearchPage({ ...options, input: { cursor: legacy, limit: 1 } }).matches, [3]);
rows = [...rows, 8];
for (const cursor of [first.nextCursor, legacy]) {
  assert.throws(() => contentSearchPage({ ...options, input: { cursor, limit: 1 } }), /变化/);
}
console.log('Content search current-page shrink and legacy cursor smoke passed.');
