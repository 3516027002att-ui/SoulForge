import assert from 'node:assert/strict';
import { createDefaultToolRegistry } from '../ai/toolRegistry.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { createScopedEventSearchCursor, readScopedEventSearchCursor } from '../ai/scopedEventSearchCursor.js';

const scope = { workspaceId: 'workspace-a', file: 'file://event/a.emevd', query: '1100800' };
const token = createScopedEventSearchCursor(scope, 'a'.repeat(64), 6);
assert.deepEqual(readScopedEventSearchCursor(token, scope.workspaceId), { scope, sourceHash: 'a'.repeat(64), offset: 6 });
assert.throws(() => readScopedEventSearchCursor(token, 'workspace-b'), /工作区/);
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
console.log('Scoped event search cursor and routing smoke passed.');
