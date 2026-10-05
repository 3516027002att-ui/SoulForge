import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createOpaqueCursor } from '@soulforge/shared';
import { contentSearchPage } from '../ai/contentSearchPage.js';
import { assertCursorPrivacy } from './harness/assertCursorPrivacy.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { createDefaultToolRegistry } from '../ai/toolRegistry.js';
import { createAgentToolBridge } from '../ai/agentToolBridge.js';

let rows = [0, 1, 2, 3, 4, 5, 6, 7];
const privateWorkspace = 'file:///home/alice/private-mod-workspace';
const options = { tool: 'search_param_rows' as const, workspaceId: privateWorkspace,
  search: () => rows, fingerprint: (row: number) => row };
const first = contentSearchPage({ ...options, input: { query: 'needle', limit: 3 } });
assert.ok(assertCursorPrivacy(first, [privateWorkspace, '/home/alice', 'private-mod-workspace']) >= 2);
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
const migrated = contentSearchPage({ ...options, input: { cursor: legacy, limit: 1 } });
assert.deepEqual(migrated.matches, [3]);
assert.ok(assertCursorPrivacy(migrated, [privateWorkspace, 'private-mod-workspace']) >= 2);
const { limit: _legacyLimit, ...v2Scope } = scope;
const v2Hash = createHash('sha256').update(JSON.stringify(v2Scope));
for (const row of rows) v2Hash.update('\0').update(JSON.stringify(row));
const legacyV2 = createOpaqueCursor({ sessionId: 'content-search-v2', domain: 'param',
  scope: JSON.stringify(scope), sourceHash: v2Hash.digest('hex'), offset: 3 });
const migratedV2 = contentSearchPage({ ...options, input: { cursor: legacyV2, limit: 1 } });
assert.deepEqual(migratedV2.matches, [3]);
assert.ok(assertCursorPrivacy(migratedV2, [privateWorkspace, 'private-mod-workspace']) >= 2);
assert.throws(() => contentSearchPage({ ...options, workspaceId: 'other', input: { cursor: legacyV2 } }), { code: 'SEARCH_CURSOR_SCOPE_MISMATCH' });
for (const tool of ['search_param_rows', 'search_text_entries', 'search_tae_events'] as const) {
  for (const workspaceId of [privateWorkspace, 'file:///C:/Users/Alice/private-mod-workspace']) {
    const start = contentSearchPage({ ...options, tool, workspaceId, input: { query: 'needle', limit: 1 } });
    assert.ok(assertCursorPrivacy(start, [workspaceId, 'private-mod-workspace']) >= 2);
    const next = contentSearchPage({ ...options, tool, workspaceId, input: { cursor: start.nextCursor } });
    assert.deepEqual(next.matches, [1]);
    assert.ok(assertCursorPrivacy(next, [workspaceId, 'private-mod-workspace']) >= 2);
    assert.throws(() => contentSearchPage({ ...options, tool, workspaceId: workspaceId + '-other', input: { cursor: start.nextCursor } }), { code: 'SEARCH_CURSOR_SCOPE_MISMATCH' });
  }
}
rows = [...rows, 8];
for (const cursor of [first.nextCursor, legacy, legacyV2]) {
  assert.throws(() => contentSearchPage({ ...options, input: { cursor, limit: 1 } }), /变化/);
}
// Exercise the actual domain handlers and the model transport, including
// continuation cursors nested inside suggested actions and identifiers.
const index = new WorkspaceIndex(privateWorkspace);
index.upsertParamExport({ paramName: 'FixtureParam', rows: Array.from({ length: 8 }, (_, rowId) => ({
  uri: `param://FixtureParam/${rowId}`, sourceUri: 'file://param/fixture.param', paramName: 'FixtureParam',
  rowId, rowName: `needle ${rowId}`, fields: []
})) });
index.upsertMsgExport({ category: 'Title', entries: Array.from({ length: 8 }, (_, textId) => ({
  uri: `msg://Title/${textId}`, sourceUri: 'file://msg/fixture.msgbnd.dcx', textId, text: `needle ${textId}`
})) });
const registry = createDefaultToolRegistry();
const context = { workspaceIndex: index, mode: 'plan' as const };
const bridge = createAgentToolBridge({ registry, context });
for (const tool of ['search_param_rows', 'search_text_entries'] as const) {
  const native = await registry.run(tool, { query: 'needle', limit: 1 }, context);
  assert.equal(native.ok, true);
  assert.ok(assertCursorPrivacy(native.data, [privateWorkspace, '/home/alice', 'private-mod-workspace']) >= 2);
  const model = await bridge.executeTool({ id: tool, name: tool, argumentsJson: JSON.stringify({ query: 'needle', limit: 1 }) });
  assert.equal(model.ok, true, model.content);
  const output = JSON.parse(model.content);
  assert.ok(assertCursorPrivacy(output, [privateWorkspace, '/home/alice', 'private-mod-workspace']) >= 2);
  const next = await bridge.executeTool({ id: `${tool}-next`, name: tool, argumentsJson: JSON.stringify({ cursor: output.data.record.nextCursor }) });
  assert.equal(next.ok, true, next.content);
  const nextOutput = JSON.parse(next.content);
  assert.equal(nextOutput.data.record.offset, 1);
  assert.notEqual(nextOutput.data.record.matches[0].item.uri, output.data.record.matches[0].item.uri);
  assert.ok(assertCursorPrivacy(nextOutput, [privateWorkspace, 'private-mod-workspace']) >= 2);
}
console.log('Content search current-page shrink and legacy cursor smoke passed.');
