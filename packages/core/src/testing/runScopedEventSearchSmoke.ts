import assert from 'node:assert/strict';
import { createDefaultToolRegistry, ToolRegistry, type ToolContext } from '../ai/toolRegistry.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { createScopedEventSearchCursor, readScopedEventSearchCursor } from '../ai/scopedEventSearchCursor.js';
import { assertCursorPrivacy } from './harness/assertCursorPrivacy.js';
import { createOpaqueCursor, defaultReadSessionManager, parseOpaqueCursor } from '@soulforge/shared';
import { createAgentToolBridge } from '../ai/agentToolBridge.js';
import { registerHooks } from 'node:module';

const scope = { workspaceId: 'file:///home/alice/private-mod-workspace', file: 'file://event/a.emevd', query: '1100800' };
const token = createScopedEventSearchCursor(scope, 'a'.repeat(64), 6);
assert.equal(assertCursorPrivacy(token, [scope.workspaceId, '/home/alice', 'private-mod-workspace']), 1);
assert.deepEqual(readScopedEventSearchCursor(token, scope.workspaceId), { scope, sourceHash: 'a'.repeat(64), offset: 6 });
const legacy = createOpaqueCursor({ sessionId: 'scoped-event-search-v1', domain: 'emevd', sourceHash: 'a'.repeat(64), offset: 6, scope: JSON.stringify(scope) });
assert.deepEqual(readScopedEventSearchCursor(legacy, scope.workspaceId), { scope, sourceHash: 'a'.repeat(64), offset: 6 });
assert.throws(() => readScopedEventSearchCursor(legacy, 'other-workspace'), { code: 'EVENT_SEARCH_CURSOR_SCOPE_MISMATCH' });
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
const globalEvents = { mapId: 'common', sourceHash: 'snapshot-a', events: Array.from({ length: 8 }, (_, eventId) => ({
  uri: `${sourceUri}#event/${eventId}`, sourceUri, mapId: 'common', eventId,
  instructions: [{ uri: `${sourceUri}#event/${eventId}/0`, index: 0, name: 'DisplayBossHealthBar', args: [] }]
})) };
const firstWorkspace = new WorkspaceIndex(scope.workspaceId); firstWorkspace.upsertEventExport(globalEvents);
const secondWorkspace = new WorkspaceIndex('other-workspace'); secondWorkspace.upsertEventExport(globalEvents);
const globalFirst = await registry.run('search_events', { query: 'DisplayBossHealthBar', limit: 1 }, { workspaceIndex: firstWorkspace, mode: 'plan' });
assert.equal(globalFirst.ok, true);
const globalCursor = (globalFirst.data as { nextCursor: string }).nextCursor;
assert.equal(assertCursorPrivacy(globalFirst, [scope.workspaceId, '/home/alice', 'private-mod-workspace']), 1);
const unboundGlobal = createOpaqueCursor({ ...parseOpaqueCursor(globalCursor), scope: `search-events:${JSON.stringify({ query: 'DisplayBossHealthBar' })}` });
const legacyGlobal = await registry.run('search_events', { cursor: unboundGlobal }, { workspaceIndex: firstWorkspace, mode: 'plan' });
assert.equal(legacyGlobal.ok, false); assert.equal(legacyGlobal.error?.code, 'EVENT_SEARCH_CURSOR_SCOPE_MISMATCH');
const crossed = await registry.run('search_events', { cursor: globalCursor, limit: 1 }, { workspaceIndex: secondWorkspace, mode: 'plan' });
assert.equal(crossed.ok, false, 'global event cursors must reject another workspace with an identical snapshot');
assert.equal(crossed.error?.code, 'EVENT_SEARCH_CURSOR_SCOPE_MISMATCH');
defaultReadSessionManager.invalidate(parseOpaqueCursor(globalCursor).sessionId);
const globalNext = await registry.run('search_events', { cursor: globalCursor, limit: 1 }, { workspaceIndex: firstWorkspace, mode: 'plan' });
assert.equal(globalNext.ok, true);
assert.equal((globalNext.data as { offset: number }).offset, 1, 'same-workspace continuation must survive a process restart');
const changedWorkspace = new WorkspaceIndex(scope.workspaceId);
changedWorkspace.upsertEventExport({ ...globalEvents, sourceHash: 'snapshot-b' });
const globalStale = await registry.run('search_events', { cursor: globalCursor, limit: 1 }, { workspaceIndex: changedWorkspace, mode: 'plan' });
assert.equal(globalStale.ok, false); assert.equal(globalStale.error?.code, 'STALE_READ_CURSOR');

// Native-global scans use the same workspace binding while retaining the
// existing stateless scan window. Substitute only the native scan authority.
const nativeKey = Symbol.for('sf.event.cursor-workspace');
(globalThis as any)[nativeKey] = async (input: { query: string; offset?: number; limit: number }) => {
  const offset = input.offset ?? 0; const matches = globalEvents.events.slice(offset, offset + input.limit);
  return { ok: true, matches, offset, returned: matches.length, limit: input.limit,
    complete: offset + matches.length === globalEvents.events.length, truncated: offset + matches.length < globalEvents.events.length,
    scannedFiles: 1, scannedEvents: matches.length, diagnostics: [] };
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return specifier === '../../editing/emevdEdit.js' && context.parentURL?.includes('/ai/tools/search_events.js?privacy')
      ? { url: 'sf:event-cursor-workspace', shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return url === 'sf:event-cursor-workspace' ? { format: 'module', shortCircuit: true,
      source: `export { isPreciseEmevdInstructionQuery } from ${JSON.stringify(new URL('../editing/emevdEdit.js', import.meta.url).href)};
        export async function searchEmevdInstructionMatches(input) { return globalThis[Symbol.for('sf.event.cursor-workspace')](input); }` }
      : next(url, context);
  }
});
try {
  const { createSearchEventsTool } = await import(new URL('../ai/tools/search_events.js?privacy', import.meta.url).href) as typeof import('../ai/tools/search_events.js');
  const nativeRegistry = new ToolRegistry(); nativeRegistry.register(createSearchEventsTool());
  const makeContext = (workspaceId: string): ToolContext => {
    const session = { layers: { overlayRoot: '/fixture' }, meta: { workspaceId } } as ToolContext['session'];
    return { session, editSession: { session }, workspaceIndex: new WorkspaceIndex(workspaceId), mode: 'plan' } as ToolContext;
  };
  const context = makeContext(scope.workspaceId);
  const nativeFirst = await nativeRegistry.run('search_events', { query: 'DisplayBossHealthBar', limit: 1 }, context);
  assert.equal(nativeFirst.ok, true, JSON.stringify(nativeFirst));
  const cursor = (nativeFirst.data as { nextCursor: string }).nextCursor;
  assert.equal(assertCursorPrivacy(nativeFirst, [scope.workspaceId, 'private-mod-workspace']), 1);
  const nativeCrossed = await nativeRegistry.run('search_events', { cursor, limit: 1 }, makeContext('other-workspace'));
  assert.equal(nativeCrossed.ok, false, 'native global event cursors must reject an identical other workspace');
  assert.equal(nativeCrossed.error?.code, 'EVENT_SEARCH_CURSOR_SCOPE_MISMATCH');
  const next = await nativeRegistry.run('search_events', { cursor, limit: 1 }, context);
  assert.equal(next.ok, true); assert.equal((next.data as { offset: number }).offset, 1);
  const changedQuery = await nativeRegistry.run('search_events', { cursor, query: 'changed' }, context);
  assert.equal(changedQuery.ok, false); assert.equal(changedQuery.error?.code, 'EVENT_SEARCH_CURSOR_SCOPE_MISMATCH');
  const legacyCursor = createOpaqueCursor({ ...parseOpaqueCursor(cursor), scope: `native-events:${JSON.stringify({ query: 'DisplayBossHealthBar' })}` });
  const legacyNative = await nativeRegistry.run('search_events', { cursor: legacyCursor }, context);
  assert.equal(legacyNative.ok, false); assert.equal(legacyNative.error?.code, 'EVENT_SEARCH_CURSOR_SCOPE_MISMATCH');
  const model = await createAgentToolBridge({ registry: nativeRegistry, context }).executeTool({ id: 'event-cursor', name: 'search_events', argumentsJson: JSON.stringify({ query: 'DisplayBossHealthBar', limit: 1 }) });
  assert.equal(model.ok, true, model.content);
  assert.ok(assertCursorPrivacy(JSON.parse(model.content), [scope.workspaceId, 'private-mod-workspace']) >= 1);
  context.workspaceIndex!.setFiles([{
    id: 'event-fixture', workspaceId: scope.workspaceId, sourceUri, sourcePath: 'event/common.emevd',
    relativePath: 'event/common.emevd', absolutePath: '/fixture/event/common.emevd', resourceKind: 'event',
    game: 'sekiro', parseStatus: 'unparsed', diagnostics: [], extension: '.emevd', compoundExtension: '.emevd',
    formatKind: 'emevd', formatLabel: 'EMEVD', size: 1, mtimeMs: 2, sha256: 'changed'
  }]);
  const nativeStale = await nativeRegistry.run('search_events', { cursor, limit: 1 }, context);
  assert.equal(nativeStale.ok, false); assert.equal(nativeStale.error?.code, 'STALE_READ_CURSOR');
} finally { hooks.deregister(); delete (globalThis as any)[nativeKey]; }
console.log('Scoped event search cursor and routing smoke passed.');
