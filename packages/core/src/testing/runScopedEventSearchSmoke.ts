import assert from 'node:assert/strict';
import { createDefaultToolRegistry } from '../ai/toolRegistry.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { createScopedEventSearchCursor, readScopedEventSearchCursor } from '../ai/scopedEventSearchCursor.js';
import { assertCursorPrivacy } from './harness/assertCursorPrivacy.js';
import { cursorIdentity } from '../workspace/cursorIdentity.js';
import { createOpaqueCursor, defaultReadSessionManager, parseOpaqueCursor } from '@soulforge/shared';

const privateWorkspace = 'file:///home/alice/private-mod-workspace';
const forbidden = [privateWorkspace, '/home/alice', 'private-mod-workspace'];
const scope = { workspaceId: privateWorkspace, file: 'file://event/a.emevd', query: '1100800' };
const token = createScopedEventSearchCursor(scope, 'a'.repeat(64), 6);
assert.equal(assertCursorPrivacy(token, forbidden), 1);
assert.deepEqual(readScopedEventSearchCursor(token, scope.workspaceId), { scope, sourceHash: 'a'.repeat(64), offset: 6 });
assert.throws(() => readScopedEventSearchCursor(token, 'workspace-b'), /工作区/);
// Pre-hash cursors are rejected with the existing structured mismatch code.
const legacyScoped = createOpaqueCursor({ sessionId: 'scoped-event-search-v1', domain: 'emevd', sourceHash: 'a'.repeat(64), offset: 6, scope: JSON.stringify(scope) });
assert.throws(() => readScopedEventSearchCursor(legacyScoped, scope.workspaceId), { code: 'EVENT_SEARCH_CURSOR_SCOPE_MISMATCH' });
const registry = createDefaultToolRegistry();
const result = await registry.run('search_events', { file: 'event/a.emevd', query: '1100800' }, { workspaceIndex: new WorkspaceIndex('fixture'), mode: 'plan' });
assert.notEqual(!result.ok && result.error?.code, 'INVALID_INPUT', 'file + query must be a supported scoped native query');
const partialIndex = new WorkspaceIndex('partial-event-fixture');
const sourceUri = 'file://event/common.emevd';
partialIndex.upsertEventExport({ mapId: 'common', events: [{
  uri: `${sourceUri}#event/10`, sourceUri, mapId: 'common', eventId: 10,
  instructions: [{ uri: `${sourceUri}#event/10/0`, index: 0, name: 'DisplayBossHealthBar', args: [] }]
}] });
const indexed = await registry.run('search_events', { query: 'DisplayBossHealthBar', limit: 20 }, { workspaceIndex: partialIndex, mode: 'plan' });
assert.equal(indexed.ok, true);
const data = indexed.data as { coverage: { status: string; negativeConclusionAllowed: boolean }; limit: number; nextActions: unknown[] };
assert.equal(data.coverage.status, 'partial');
assert.equal(data.coverage.negativeConclusionAllowed, false);
assert.ok(data.limit <= 6);
assert.ok(data.nextActions.length > 0);

// a': global indexed search cursors are bound to the workspace and to their
// own read session. Two workspaces with an identical event projection produce
// the same snapshot hash, so only the workspace binding can tell them apart.
const globalEvents = { mapId: 'common', events: Array.from({ length: 8 }, (_, eventId) => ({
  uri: `${sourceUri}#event/${eventId}`, sourceUri, mapId: 'common', eventId,
  instructions: [{ uri: `${sourceUri}#event/${eventId}/0`, index: 0, name: 'DisplayBossHealthBar', args: [] }]
})) };
const firstWorkspace = new WorkspaceIndex(privateWorkspace); firstWorkspace.upsertEventExport(globalEvents);
const secondWorkspace = new WorkspaceIndex('file:///home/bob/other-workspace'); secondWorkspace.upsertEventExport(globalEvents);
const globalFirst = await registry.run('search_events', { query: 'DisplayBossHealthBar', limit: 1 }, { workspaceIndex: firstWorkspace, mode: 'plan' });
assert.equal(globalFirst.ok, true);
const globalCursor = (globalFirst.data as { nextCursor: string }).nextCursor;
assert.equal(assertCursorPrivacy(globalFirst, forbidden), 1);
const globalPayload = parseOpaqueCursor(globalCursor);

// Replay into another workspace while the minting session is still live.
const crossed = await registry.run('search_events', { cursor: globalCursor, limit: 1 }, { workspaceIndex: secondWorkspace, mode: 'plan' });
assert.equal(crossed.ok, false, 'global event cursors must reject another workspace with an identical snapshot');
assert.equal(crossed.error?.code, 'EVENT_SEARCH_CURSOR_SCOPE_MISMATCH');

// Forged cursor: the other workspace's digest in the scope, but this live
// session's id. Only the existing-session check can reject it.
const forgedScope = `search-events:${JSON.stringify({ query: 'DisplayBossHealthBar', workspaceId: cursorIdentity(secondWorkspace.workspaceId) })}`;
const forged = await registry.run('search_events', { cursor: createOpaqueCursor({ ...globalPayload, scope: forgedScope }), limit: 1 }, { workspaceIndex: secondWorkspace, mode: 'plan' });
assert.equal(forged.ok, false, 'a sessionId from another workspace must not be readable through a forged scope');
assert.equal(forged.error?.code, 'EVENT_SEARCH_CURSOR_SCOPE_MISMATCH');

// Unbound (pre-hash) cursors are rejected, not migrated.
const unbound = createOpaqueCursor({ ...globalPayload, scope: `search-events:${JSON.stringify({ query: 'DisplayBossHealthBar' })}` });
const legacyGlobal = await registry.run('search_events', { cursor: unbound }, { workspaceIndex: firstWorkspace, mode: 'plan' });
assert.equal(legacyGlobal.ok, false); assert.equal(legacyGlobal.error?.code, 'EVENT_SEARCH_CURSOR_SCOPE_MISMATCH');

// Same-workspace continuation still works, live and after a session loss
// (stateless fallback), and the stateless path stays workspace-bound.
const globalNextLive = await registry.run('search_events', { cursor: globalCursor, limit: 1 }, { workspaceIndex: firstWorkspace, mode: 'plan' });
assert.equal(globalNextLive.ok, true, JSON.stringify(globalNextLive));
assert.equal((globalNextLive.data as { offset: number }).offset, 1);
defaultReadSessionManager.invalidate(globalPayload.sessionId);
const crossedStateless = await registry.run('search_events', { cursor: globalCursor, limit: 1 }, { workspaceIndex: secondWorkspace, mode: 'plan' });
assert.equal(crossedStateless.ok, false, 'stateless fallback must also reject another workspace');
assert.equal(crossedStateless.error?.code, 'EVENT_SEARCH_CURSOR_SCOPE_MISMATCH');
const globalNext = await registry.run('search_events', { cursor: globalCursor, limit: 1 }, { workspaceIndex: firstWorkspace, mode: 'plan' });
assert.equal(globalNext.ok, true, JSON.stringify(globalNext));
assert.equal((globalNext.data as { offset: number }).offset, 1, 'same-workspace continuation must survive a process restart');
assert.equal(assertCursorPrivacy(globalNext, forbidden), 1);
console.log('Scoped event search cursor and routing smoke passed.');
