import assert from 'node:assert/strict';
import type { BridgeResult, IndexedFile, ResourceKind } from '@soulforge/shared';
import { ingestBridgeResult } from '../indexing/ingestBridgeResult.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';

/**
 * Native semantic projection gate fixture.
 *
 * Each supported semantic family receives a current projection and then a
 * late projection carrying the previous hash/revision.  The late read must be
 * rejected and the current semantic body must remain intact.
 */
const SOURCE_HASH = 'native-current-hash';
const SOURCE_REVISION = 2;

function main(): void {
  const cases: Array<{ kind: ResourceKind; sourceUri: string; sourcePath: string; current: unknown; stale: unknown; body: (index: WorkspaceIndex) => string }> = [
    {
      kind: 'event',
      sourceUri: 'file://synthetic/native/event/common.emevd.dcx',
      sourcePath: 'event/common.emevd.dcx',
      current: { mapId: 'm10_00_00_00', sourceHash: SOURCE_HASH, sourceRevision: SOURCE_REVISION, events: [{ eventId: 1000, name: 'current-event', instructions: [] }] },
      stale: { mapId: 'm10_00_00_00', sourceHash: 'native-old-hash', sourceRevision: 1, events: [{ eventId: 1000, name: 'stale-event', instructions: [] }] },
      body: (index) => index.toSymbolBundle().events?.[0]?.events[0]?.name ?? ''
    },
    {
      kind: 'map',
      sourceUri: 'file://synthetic/native/map/m10_00_00_00.msb',
      sourcePath: 'map/m10_00_00_00.msb',
      current: { mapId: 'm10_00_00_00', sourceHash: SOURCE_HASH, sourceRevision: SOURCE_REVISION, entities: [{ entityId: 1100800, name: 'current-map-entity', kind: 'character' }], regions: [] },
      stale: { mapId: 'm10_00_00_00', sourceHash: 'native-old-hash', sourceRevision: 1, entities: [{ entityId: 1100800, name: 'stale-map-entity', kind: 'character' }], regions: [] },
      body: (index) => index.toSymbolBundle().maps?.[0]?.entities[0]?.name ?? ''
    },
    {
      kind: 'param',
      sourceUri: 'file://synthetic/native/param/NpcParam.param',
      sourcePath: 'param/NpcParam.param',
      current: { paramName: 'NpcParam', sourceHash: SOURCE_HASH, sourceRevision: SOURCE_REVISION, rows: [{ rowId: 50800000, rowName: 'current-param-row', fields: [{ name: 'hp', value: 100 }] }] },
      stale: { paramName: 'NpcParam', sourceHash: 'native-old-hash', sourceRevision: 1, rows: [{ rowId: 50800000, rowName: 'stale-param-row', fields: [{ name: 'hp', value: 1 }] }] },
      body: (index) => index.toSymbolBundle().params?.[0]?.rows[0]?.rowName ?? ''
    },
    {
      kind: 'msg',
      sourceUri: 'file://synthetic/native/msg/menu.fmg',
      sourcePath: 'msg/menu.fmg',
      current: { category: 'menu', sourceHash: SOURCE_HASH, sourceRevision: SOURCE_REVISION, entries: [{ textId: 1, text: 'current-msg' }] },
      stale: { category: 'menu', sourceHash: 'native-old-hash', sourceRevision: 1, entries: [{ textId: 1, text: 'stale-msg' }] },
      body: (index) => index.toSymbolBundle().msgs?.[0]?.entries[0]?.text ?? ''
    },
    {
      kind: 'action',
      sourceUri: 'file://synthetic/native/action/c1050.anibnd.dcx',
      sourcePath: 'chr/c1050.anibnd.dcx',
      current: { sourceHash: SOURCE_HASH, sourceRevision: SOURCE_REVISION, animations: [{ animId: 0x200, events: [{ eventTypeId: 1, startTime: 0, endTime: 1 }] }] },
      stale: { sourceHash: 'native-old-hash', sourceRevision: 1, animations: [{ animId: 0x200, events: [{ eventTypeId: 2, startTime: 0, endTime: 1 }] }] },
      body: (index) => String(index.toSymbolBundle().tae?.[0]?.animations[0]?.events[0]?.eventTypeId ?? '')
    }
  ];

  for (const fixture of cases) {
    const index = new WorkspaceIndex(`native-projection-${fixture.kind}`);
    index.setFiles([makeFile(fixture.sourceUri, fixture.kind, fixture.sourcePath)]);
    const current = ingest(index, fixture, fixture.current);
    assert.equal(current.accepted, true, `${fixture.kind}: current projection must be accepted`);
    assert.equal(current.parseStatus, 'parsed', `${fixture.kind}: current parse status`);
    const currentBody = fixture.body(index);
    assert.notEqual(currentBody, '', `${fixture.kind}: current projection body missing`);

    const stale = ingest(index, fixture, fixture.stale);
    assert.equal(stale.accepted, false, `${fixture.kind}: stale projection must be rejected`);
    assert.equal(stale.parseStatus, 'partial', `${fixture.kind}: rejected projection must be partial`);
    assert.ok(stale.diagnostics.some((diagnostic) => diagnostic.code === 'NATIVE_PROJECTION_REJECTED'), `${fixture.kind}: rejection diagnostic missing`);
    assert.equal(fixture.body(index), currentBody, `${fixture.kind}: stale projection overwrote current body`);
  }

  // A batched PARAM read can contain one current and one stale export.  The
  // current value remains usable, but the envelope must stay partial rather
  // than claiming the whole batch was parsed/accepted.
  const partialIndex = new WorkspaceIndex('native-projection-partial-batch');
  const partialSourceUri = 'file://synthetic/native/param/partial.param';
  partialIndex.setFiles([makeFile(partialSourceUri, 'param', 'param/partial.param')]);
  const partial = ingestBridgeResult(partialIndex, {
    sourceUri: partialSourceUri,
    sourcePath: 'param/partial.param',
    game: 'sekiro',
    resourceKind: 'param',
    parseStatus: 'parsed',
    diagnostics: [],
    data: {
      params: [
        { paramName: 'NpcParam', entryName: 'Current.param', sourceHash: SOURCE_HASH, sourceRevision: SOURCE_REVISION, rows: [{ rowId: 1, rowName: 'current-batch-row' }] },
        { paramName: 'NpcParam', entryName: 'Stale.param', sourceHash: 'native-old-hash', sourceRevision: 1, rows: [{ rowId: 2, rowName: 'stale-batch-row' }] }
      ]
    }
  });
  assert.equal(partial.accepted, true, 'partially accepted PARAM batch must remain usable');
  assert.equal(partial.parseStatus, 'partial', 'partially accepted PARAM batch must not claim parsed');
  assert.equal(partialIndex.toSymbolBundle().params?.[0]?.rows[0]?.rowName, 'current-batch-row');

  // Packed PARAM/MSG sources have two identities: the catalog hash belongs to
  // the outer DCX/BND4 file, while each decoded child has its own leaf hash.
  // Two children may also contain the same numeric row ID.  The projection
  // gate must compare the outer hash to the catalog and retain both child
  // tables instead of collapsing one row into the other.
  const packedIndex = new WorkspaceIndex('native-projection-packed');
  const packedSourceUri = 'file://synthetic/native/param/gameparam.parambnd.dcx';
  const packedOuterHash = 'packed-outer-hash';
  packedIndex.setFiles([makeFile(packedSourceUri, 'param', 'param/gameparam.parambnd.dcx', packedOuterHash)]);
  const packed = ingestBridgeResult(packedIndex, {
    sourceUri: packedSourceUri,
    sourcePath: 'param/gameparam.parambnd.dcx',
    game: 'sekiro',
    resourceKind: 'param',
    parseStatus: 'parsed',
    diagnostics: [],
    data: {
      outerFileHash: packedOuterHash,
      params: [
        { paramName: 'NpcParam', entryName: 'NpcParam.param', entryIndex: 1, sourceHash: 'leaf-a', sourceRevision: SOURCE_REVISION, rows: [{ rowId: 7, rowName: 'child-a' }] },
        { paramName: 'NpcParam', entryName: 'EquipParam.param', entryIndex: 2, sourceHash: 'leaf-b', sourceRevision: SOURCE_REVISION, rows: [{ rowId: 7, rowName: 'child-b' }] }
      ]
    }
  });
  assert.equal(packed.accepted, true, 'packed PARAM children with leaf hashes must be accepted');
  const packedParams = packedIndex.toSymbolBundle().params ?? [];
  assert.equal(packedParams.length, 2, 'packed PARAM children must remain separate projections');
  assert.deepEqual(
    packedParams.map((item) => item.rows[0]?.rowName).sort(),
    ['child-a', 'child-b'],
    'same row IDs in different PARAM children must not collide'
  );
  assert.ok(packedParams.every((item) => item.outerFileHash === packedOuterHash), 'outer hash must propagate to every PARAM child');
  assert.deepEqual(
    packedParams.map((item) => item.sourceHash).sort(),
    ['leaf-a', 'leaf-b'],
    'leaf hashes must remain distinct from the outer catalog hash'
  );

  // A native BND4 name may carry a full physical path.  Two children can have
  // the same basename while remaining distinct table identities; collapsing
  // to basename would make one same-row-id child replace the other.
  const sameBasenameIndex = new WorkspaceIndex('native-projection-same-basename');
  const sameBasenameSourceUri = 'file://synthetic/native/param/same-basename.parambnd.dcx';
  sameBasenameIndex.setFiles([makeFile(
    sameBasenameSourceUri,
    'param',
    'param/same-basename.parambnd.dcx',
    packedOuterHash
  )]);
  const sameBasenameA = 'N:\\NTC\\data\\Target\\INTERROOT_win64\\param\\GameParam\\NpcParam.param';
  const sameBasenameB = 'N:\\NTC\\data\\Target\\INTERROOT_win64\\param\\Overlay\\NpcParam.param';
  const sameBasename = ingestBridgeResult(sameBasenameIndex, {
    sourceUri: sameBasenameSourceUri,
    sourcePath: 'param/same-basename.parambnd.dcx',
    game: 'sekiro',
    resourceKind: 'param',
    parseStatus: 'parsed',
    diagnostics: [],
    data: {
      outerFileHash: packedOuterHash,
      params: [
        { paramName: 'NPC_PARAM_ST', entryName: sameBasenameA, entryIndex: 10, sourceHash: 'leaf-path-a', sourceRevision: SOURCE_REVISION, rows: [{ rowId: 50800000, rowName: 'path-a' }] },
        { paramName: 'NPC_PARAM_ST', entryName: sameBasenameB, entryIndex: 11, sourceHash: 'leaf-path-b', sourceRevision: SOURCE_REVISION, rows: [{ rowId: 50800000, rowName: 'path-b' }] }
      ]
    }
  });
  assert.equal(sameBasename.accepted, true, 'same-basename PARAM children must be accepted');
  const sameBasenameParams = sameBasenameIndex.toSymbolBundle().params ?? [];
  assert.equal(sameBasenameParams.length, 2, 'same-basename PARAM children must remain separate projections');
  assert.deepEqual(
    sameBasenameParams.map((item) => item.entryName).sort(),
    [sameBasenameA, sameBasenameB].sort(),
    'full physical child names must remain exact projection identities'
  );
  assert.deepEqual(
    sameBasenameParams.map((item) => item.rows[0]?.rowName).sort(),
    ['path-a', 'path-b'],
    'same basename and row ID must not collapse either child'
  );

  console.log(JSON.stringify({ ok: true, checks: cases.length + 3, message: 'native projection acceptance smoke passed' }, null, 2));
}

function ingest(
  index: WorkspaceIndex,
  fixture: { kind: ResourceKind; sourceUri: string; sourcePath: string },
  data: unknown
) {
  const result: BridgeResult<unknown> = {
    sourceUri: fixture.sourceUri,
    sourcePath: fixture.sourcePath,
    game: 'sekiro',
    resourceKind: fixture.kind,
    parseStatus: 'parsed',
    diagnostics: [],
    data
  };
  return ingestBridgeResult(index, result);
}

function makeFile(sourceUri: string, resourceKind: ResourceKind, sourcePath: string, sha256 = SOURCE_HASH): IndexedFile {
  return {
    id: sourceUri,
    workspaceId: 'native-projection-smoke',
    sourceUri,
    sourcePath,
    absolutePath: sourcePath,
    relativePath: sourcePath,
    extension: sourcePath.slice(sourcePath.lastIndexOf('.')),
    compoundExtension: sourcePath.slice(sourcePath.lastIndexOf('.')),
    game: 'sekiro',
    resourceKind,
    parseStatus: 'parsed',
    diagnostics: [],
    formatKind: 'unknown',
    formatLabel: resourceKind,
    size: 1,
    mtimeMs: SOURCE_REVISION,
    sha256
  };
}

main();
