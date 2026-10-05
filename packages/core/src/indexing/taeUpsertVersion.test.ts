import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WorkspaceIndex } from './workspaceIndex.js';

function makeChrFile(extra: Record<string, unknown> = {}) {
  return {
    id: 'probe:chr/c0000.anibnd.dcx',
    workspaceId: 'probe',
    absolutePath: '/w/chr/c0000.anibnd.dcx',
    relativePath: 'chr/c0000.anibnd.dcx',
    sourceUri: 'file://chr/c0000.anibnd.dcx',
    sourcePath: '/w/chr/c0000.anibnd.dcx',
    game: 'sekiro',
    resourceKind: 'chr',
    parseStatus: 'ok',
    diagnostics: [],
    extension: '.dcx',
    compoundExtension: '.anibnd.dcx',
    formatKind: 'bnd',
    formatLabel: 'Animation BND DCX',
    size: 100,
    mtimeMs: 1000,
    ...extra
  } as never;
}

function makeExport(extra: Record<string, unknown> = {}) {
  return {
    chrId: 'c0000',
    sourceUri: 'file://chr/c0000.anibnd.dcx',
    ...extra,
    animations: [
      {
        animId: 10,
        code: 'A0010',
        events: [{ uri: 'action://c0000/tae/1/A0010/e0', index: 0, eventTypeId: 16, startTime: 0, endTime: 0.3, startFrame: 0, endFrame: 9 }]
      }
    ]
  };
}

describe('TAE export freshness gate', () => {
  it('rejects a read-content hash that mismatches the scanned file bytes', () => {
    const index = new WorkspaceIndex('probe');
    index.setFiles([makeChrFile({ sha256: 'scan-hash' })]);
    assert.equal(
      index.upsertTaeExport(makeExport({ sourceHash: 'read-hash', sourceRevision: 1000 })),
      false
    );
    assert.equal(index.searchTaeEvents('A0010', 10).length, 0);
  });

  it('accepts the scan-consistent file identity so read events stay searchable', () => {
    const index = new WorkspaceIndex('probe');
    index.setFiles([makeChrFile({ sha256: 'scan-hash' })]);
    assert.equal(
      index.upsertTaeExport(makeExport({ sourceHash: 'scan-hash', sourceRevision: 1000 })),
      true
    );
    assert.equal(index.searchTaeEvents('A0010', 10).length, 1);
  });

  it('accepts a revision-only version when the scan carries no content hash', () => {
    const index = new WorkspaceIndex('probe');
    index.setFiles([makeChrFile()]);
    assert.equal(index.upsertTaeExport(makeExport({ sourceRevision: 1000 })), true);
    assert.equal(index.searchTaeEvents('A0010', 10).length, 1);
  });
});

describe('bounded TAE read parser-version isolation', () => {
  for (const legacyVersion of [undefined, 0, 1]) {
    it(`does not promote unread legacy actions from reader version ${String(legacyVersion)}`, () => {
      const index = new WorkspaceIndex('probe');
      index.setFiles([makeChrFile({ sha256: 'same-native-bytes' })]);
      const legacy = makeExport({ sourceHash: 'same-native-bytes', sourceRevision: 1000,
        ...(legacyVersion === undefined ? {} : { readerSchemaRevision: legacyVersion }) });
      index.upsertTaeExport(legacy);
      const bounded = { ...makeExport({ sourceHash: 'same-native-bytes', sourceRevision: 1000, readerSchemaRevision: 2 }),
        animations: [{ animId: 20, code: 'A0020', events: [{ uri: 'action://c0000/tae/1/A0020/e0', index: 0, eventTypeId: 16, startTime: 0, endTime: 0.3, startFrame: 0, endFrame: 9 }] }] };
      assert.equal(index.mergeTaeEvents(bounded), true);
      const published = index.toSymbolBundle().tae?.[0];
      assert.equal(published?.readerSchemaRevision, 2);
      assert.deepEqual(published?.animations.map(a => a.animId), [20], 'unread version-incompatible action must be discarded');
    });
  }
  it('merges unread siblings and continuation events only for the same v2 reader', () => {
    const index = new WorkspaceIndex('probe');
    index.setFiles([makeChrFile({ sha256: 'same-native-bytes' })]);
    index.upsertTaeExport(makeExport({ sourceHash: 'same-native-bytes', sourceRevision: 1000, readerSchemaRevision: 2 }));
    const page = makeExport({ sourceHash: 'same-native-bytes', sourceRevision: 1000, readerSchemaRevision: 2 });
    page.animations[0]!.events[0]!.index = 1;
    index.mergeTaeEvents(page);
    assert.deepEqual(index.toSymbolBundle().tae?.[0]?.animations[0]?.events.map(e => e.index), [0, 1]);
  });
});
