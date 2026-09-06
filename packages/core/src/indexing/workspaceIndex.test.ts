import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WorkspaceIndex } from './workspaceIndex.js';
import type { TaeExport } from '@soulforge/shared';

function makeTaeExport(): TaeExport {
  const entry = (entryIndex: number, entryId: number, entryName: string, taeGroup: string) => ({
    entryIndex,
    entryId,
    entryName,
    taeGroup,
    animationCount: 1,
    sourceSize: 128,
    sourceHash: `hash-${taeGroup}`
  });
  const animation = (taeEntryIndex: number, taeEntryId: number, taeEntryName: string, taeGroup: string) => ({
    animId: 10,
    taeEntryIndex,
    taeEntryId,
    taeEntryName,
    taeGroup,
    code: 'A0010',
    events: []
  });
  return {
    chrId: 'c0000',
    sourceUri: 'file:///chr/c0000.anibnd.dcx',
    sourceHash: 'aggregate-hash',
    taeEntryCount: 2,
    taeEntries: [
      entry(1, 5000000, 'a00.tae', 'a00'),
      entry(3, 5000050, 'a50.tae', 'a50')
    ],
    animations: [
      animation(1, 5000000, 'a00.tae', 'a00'),
      animation(3, 5000050, 'a50.tae', 'a50')
    ]
  };
}

describe('WorkspaceIndex TAE section identity', () => {
  it('裸 animId 在跨 section 时返回 AMBIGUOUS', () => {
    const index = new WorkspaceIndex('fixture');
    index.upsertTaeExport(makeTaeExport());
    assert.deepEqual(index.lookupTaeAnimation('file:///chr/c0000.anibnd.dcx', 10), {
      status: 'AMBIGUOUS',
      sourceUri: 'file:///chr/c0000.anibnd.dcx',
      animId: 10,
      matchCount: 2
    });
  });

  it('entry selector 精确命中单个 section，并拒绝不存在的 section', () => {
    const index = new WorkspaceIndex('fixture');
    index.upsertTaeExport(makeTaeExport());
    const selected = index.lookupTaeAnimation('file:///chr/c0000.anibnd.dcx', 10, {
      taeEntryIndex: 3,
      taeEntryId: 5000050,
      taeEntryName: 'a50.tae',
      taeGroup: 'a50'
    });
    assert.equal(selected.status, 'UNIQUE');
    if (selected.status === 'UNIQUE') assert.equal(selected.animation.taeGroup, 'a50');
    assert.equal(
      index.lookupTaeAnimation('file:///chr/c0000.anibnd.dcx', 10, { taeEntryIndex: 25 }).status,
      'NOT_FOUND'
    );
  });
});
