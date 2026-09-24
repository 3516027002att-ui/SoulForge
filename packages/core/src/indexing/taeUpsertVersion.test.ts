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
