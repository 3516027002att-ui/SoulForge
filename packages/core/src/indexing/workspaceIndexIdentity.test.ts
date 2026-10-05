import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EventExport, IndexedFile } from '@soulforge/shared';
import { WorkspaceIndex } from './workspaceIndex.js';
import { assertCursorPrivacy } from '../testing/harness/assertCursorPrivacy.js';
import { createOpaqueCursor, parseOpaqueCursor } from '@soulforge/shared';

function file(
  sourceUri: string,
  relativePath: string,
  resourceKind: IndexedFile['resourceKind'],
  artifactMarkers?: IndexedFile['artifactMarkers']
): IndexedFile {
  return {
    id: sourceUri,
    workspaceId: 'fixture',
    sourceUri,
    sourcePath: relativePath,
    absolutePath: `C:/fixture/${relativePath}`,
    relativePath,
    game: 'sekiro',
    resourceKind,
    parseStatus: 'parsed',
    diagnostics: [],
    extension: '.dcx',
    compoundExtension: '.emevd.dcx',
    formatKind: 'emevd',
    formatLabel: 'EMEVD',
    size: 1,
    mtimeMs: 1,
    ...(artifactMarkers ? { artifactMarkers } : {})
  };
}

function eventExport(
  sourceHash: string | undefined,
  mapId: string,
  uri: string,
  sourceUri = 'file:///event/common.emevd.dcx'
): EventExport {
  return {
    mapId,
    ...(sourceHash ? { sourceHash } : {}),
    events: [{
      uri,
      sourceUri,
      mapId,
      eventId: 100,
      instructions: []
    }]
  };
}

describe('WorkspaceIndex identity and resource search boundaries', () => {
  it('event search collapses URI aliases but preserves conflicting source hashes', () => {
    const index = new WorkspaceIndex('fixture');
    index.setFiles([file('file:///event/common.emevd.dcx', 'event/common.emevd.dcx', 'event')]);

    // The first two rows describe one native snapshot through two URI forms.
    index.upsertEventExport(eventExport('hash-a', 'm10', 'event://m10/100'));
    index.upsertEventExport(eventExport('hash-a', 'm11', 'file:///event/common.emevd.dcx#event/100'));
    index.upsertEventExport(eventExport(undefined, 'm13', 'event://m13/100'));
    // A different source hash is a real version conflict and must remain visible.
    index.upsertEventExport(eventExport('hash-b', 'm12', 'event://m12/100'));

    const page = index.searchEventsPage('', 0, 20);
    assert.equal(page.total, 2);
    assert.deepEqual(page.items.map((item) => item.item.sourceHash).sort(), ['hash-a', 'hash-b']);
    assert.equal(page.items.filter((item) => item.item.sourceHash === 'hash-a').length, 1);
    assert.equal(
      page.items.find((item) => item.item.sourceHash === 'hash-a')?.item.uri,
      'file:///event/common.emevd.dcx#event/100'
    );
  });

  it('resource search excludes recovery files by default and exposes an opaque, query-bound page cursor', () => {
    const workspaceId = 'file:///home/alice/private-mod-workspace';
    const index = new WorkspaceIndex(workspaceId);
    index.setFiles([
      file('file:///event/a.emevd.dcx', 'event/a.emevd.dcx', 'event'),
      file('file:///event/b.emevd.dcx', 'event/b.emevd.dcx', 'event'),
      file('file:///event/c.emevd.dcx', 'event/c.emevd.dcx', 'event'),
      file('file:///event/a.emevd.dcx.bak', 'event/a.emevd.dcx.bak', 'event', { artifactRole: 'backup', sourceLayer: 'overlay' })
    ]);

    const first = index.searchResourcesPage({ query: '', limit: 2 });
    assert.equal(first.total, 3);
    assert.equal(first.items.length, 2);
    assert.equal(first.matches.length, 2);
    assert.equal(first.limit, 2);
    assert.equal(first.truncated, true);
    assert.ok(first.nextCursor);
    const firstCursor = first.nextCursor;
    assert.ok(assertCursorPrivacy(first, [workspaceId, '/home/alice', 'private-mod-workspace']) >= 2);
    const legacy = createOpaqueCursor({ ...parseOpaqueCursor(firstCursor), sessionId: 'workspace-resource-search-v1',
      scope: JSON.stringify({ workspaceId, query: '', kinds: [], limit: 2, sourceFilter: 'active' }) });
    assert.deepEqual(index.searchResourcesPage({ cursor: legacy }).items, index.searchResourcesPage({ cursor: firstCursor }).items);
    const migrated = index.searchResourcesPage({ cursor: createOpaqueCursor({ ...parseOpaqueCursor(legacy), offset: 0 }) });
    assert.deepEqual(migrated.items, first.items);
    assert.ok(assertCursorPrivacy(migrated, [workspaceId, 'private-mod-workspace']) >= 2);
    assert.equal(first.nextActions[0]?.args.cursor, firstCursor);
    assert.ok(first.items.every((item) => !item.item.relativePath.endsWith('.bak')));

    const second = index.searchResourcesPage({ query: '', limit: 2, cursor: firstCursor });
    assert.equal(second.total, 3);
    assert.equal(second.items.length, 1);
    assert.equal(second.hasMore, false);
    assert.deepEqual(second.nextActions, []);

    assert.throws(
      () => index.searchResourcesPage({ query: 'different', limit: 2, cursor: firstCursor }),
      (error: unknown) => (error as { code?: string }).code === 'RESOURCE_SEARCH_CURSOR_SCOPE_MISMATCH'
    );

    const otherWorkspace = new WorkspaceIndex('other-workspace');
    otherWorkspace.setFiles([
      file('file:///event/a.emevd.dcx', 'event/a.emevd.dcx', 'event'),
      file('file:///event/b.emevd.dcx', 'event/b.emevd.dcx', 'event'),
      file('file:///event/c.emevd.dcx', 'event/c.emevd.dcx', 'event')
    ]);
    assert.throws(
      () => otherWorkspace.searchResourcesPage({ cursor: firstCursor }),
      (error: unknown) => (error as { code?: string }).code === 'RESOURCE_SEARCH_CURSOR_SCOPE_MISMATCH'
    );
    assert.throws(() => otherWorkspace.searchResourcesPage({ cursor: legacy }), (error: unknown) => {
      assert.ok(!String(error).includes('private-mod-workspace'));
      return (error as { code?: string }).code === 'RESOURCE_SEARCH_CURSOR_SCOPE_MISMATCH';
    });

    const all = index.searchResourcesPage({ query: '', limit: 10, sourceFilter: 'all' });
    assert.equal(all.total, 4);
    const artifacts = index.searchResourcesPage({ query: '', limit: 10, sourceFilter: 'artifacts' });
    assert.equal(artifacts.total, 1);
    assert.equal(artifacts.items[0]?.item.relativePath, 'event/a.emevd.dcx.bak');
    index.setFiles([file('file:///event/a.emevd.dcx', 'event/a.emevd.dcx', 'event')]);
    for (const cursor of [firstCursor, legacy]) assert.throws(() => index.searchResourcesPage({ cursor }), { code: 'STALE_READ_CURSOR' });
  });

  it('semantic map search excludes backup projections while keeping them catalog-visible', () => {
    const index = new WorkspaceIndex('fixture-map-backup');
    index.setFiles([
      file('file:///map/m11.msb.dcx', 'map/m11.msb.dcx', 'map'),
      file('file:///map/m11.msb.dcx.bak', 'map/m11.msb.dcx.bak', 'map', { artifactRole: 'backup', sourceLayer: 'overlay' })
    ]);
    index.upsertMapExport({
      mapId: 'm11_00_00_00',
      entities: [{ uri: 'file:///map/m11.msb.dcx#entity/5080', sourceUri: 'file:///map/m11.msb.dcx', mapId: 'm11_00_00_00', entityId: 5080, name: '5080 active', kind: 'character' }],
      regions: []
    });
    index.upsertMapExport({
      mapId: 'm11_00_00_00',
      entities: [{ uri: 'file:///map/m11.msb.dcx.bak#entity/5080', sourceUri: 'file:///map/m11.msb.dcx.bak', mapId: 'm11_00_00_00', entityId: 5080, name: '5080 backup', kind: 'character' }],
      regions: []
    });

    const matches = index.searchMapEntities('5080', 10);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.item.sourceUri, 'file:///map/m11.msb.dcx');
  });
});
