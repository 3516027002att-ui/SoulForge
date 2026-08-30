import assert from 'node:assert/strict';
import type { BridgeResult } from '@soulforge/shared';
import { ingestBridgeResult, resolveBinderMembership, WorkspaceIndex } from '../index.js';

const SOURCE_URI = 'file:///overlay/chr/c0000_a00.tae';
const SOURCE_PATH = 'chr/c0000.tae';
const BINDER_ENTRY_ID_BASE = 1_000_000_000;

function main(): void {
  const index = new WorkspaceIndex('action-motion-identity-smoke');

  ingest(index, {
    sourceUri: SOURCE_URI,
    sourcePath: SOURCE_PATH,
    animations: [{ animId: 10, motionAnimId: 42, events: [] }]
  });
  const unique = index.lookupTaeAnimation(SOURCE_URI, 10);
  assert.equal(unique.status, 'UNIQUE');
  if (unique.status !== 'UNIQUE') throw new Error('unique TAE lookup narrowed unexpectedly');
  assert.equal(unique.animation.motionAnimId, 42);

  ingest(index, {
    sourceUri: SOURCE_URI,
    sourcePath: SOURCE_PATH,
    animations: [
      { animId: 10, motionAnimId: 42, events: [] },
      { animId: 10, motionAnimId: 43, events: [] }
    ]
  });
  const ambiguous = index.lookupTaeAnimation(SOURCE_URI, 10);
  assert.equal(ambiguous.status, 'AMBIGUOUS');
  if (ambiguous.status !== 'AMBIGUOUS') throw new Error('duplicate TAE lookup did not fail closed');
  assert.equal(ambiguous.matchCount, 2);

  ingest(index, {
    sourceUri: SOURCE_URI,
    sourcePath: SOURCE_PATH,
    animations: [{ animId: 10, motionAnimId: -1, events: [] }]
  });
  const invalidMotion = index.lookupTaeAnimation(SOURCE_URI, 10);
  assert.equal(invalidMotion.status, 'UNIQUE');
  if (invalidMotion.status !== 'UNIQUE') throw new Error('invalid motion fixture narrowed unexpectedly');
  assert.equal(invalidMotion.animation.motionAnimId, undefined);
  assert.equal(index.lookupTaeAnimation(SOURCE_URI, 999).status, 'NOT_FOUND');

  const binderId = BINDER_ENTRY_ID_BASE + 42;
  const binderUnique = resolveBinderMembership({
    query: { characterFamily: 'c0000', binderEntryId: binderId },
    candidates: [
      {
        characterFamily: 'c0000',
        source: { sourceUri: 'file:///overlay/chr/c0000_a00.anibnd.dcx', sourceLayer: 'overlay' },
        entries: [{ entryId: binderId, entryIndex: 3, entryName: 'a0000_004200.hkx' }]
      },
      {
        characterFamily: 'c0001',
        source: { sourceUri: 'file:///overlay/chr/c0001.anibnd.dcx', sourceLayer: 'overlay' },
        entries: [{ entryId: binderId, entryIndex: 3, entryName: 'wrong-family.hkx' }]
      }
    ]
  });
  assert.equal(binderUnique.status, 'UNIQUE');
  if (binderUnique.status !== 'UNIQUE') throw new Error('unique Binder fixture narrowed unexpectedly');
  assert.equal(binderUnique.match.sourceLayer, 'overlay');

  const binderMissing = resolveBinderMembership({
    query: { characterFamily: 'c0000', binderEntryId: binderId + 1 },
    candidates: binderUnique.consideredSources.map((item) => ({
      characterFamily: item.characterFamily,
      source: item.source,
      entries: [{ entryId: binderId }]
    }))
  });
  assert.equal(binderMissing.status, 'NOT_FOUND');

  const binderAmbiguous = resolveBinderMembership({
    query: { characterFamily: 'c0000', binderEntryId: binderId },
    candidates: [
      {
        characterFamily: 'c0000',
        source: { sourceUri: 'file:///overlay/chr/c0000_a00.anibnd.dcx', sourceLayer: 'overlay' },
        entries: [{ entryId: binderId, entryIndex: 3 }]
      },
      {
        characterFamily: 'c0000',
        source: { sourceUri: 'file:///base/chr/c0000_a07x.anibnd.dcx', sourceLayer: 'base' },
        entries: [{ entryId: binderId, entryIndex: 8 }]
      }
    ]
  });
  assert.equal(binderAmbiguous.status, 'AMBIGUOUS');
  if (binderAmbiguous.status !== 'AMBIGUOUS') throw new Error('duplicate Binder fixture narrowed unexpectedly');
  assert.equal(binderAmbiguous.matches.length, 2);

  console.log(JSON.stringify({
    ok: true,
    status: 'fixture-confirmed',
    message: 'ACTION motion identity 与 Binder membership synthetic 回归通过。',
    cases: [
      'TAE motionAnimId projection',
      'TAE duplicate animId fail-closed',
      'invalid motionAnimId does not fall back to animId',
      'Binder UNIQUE',
      'Binder NOT_FOUND',
      'Binder AMBIGUOUS',
      'character-family isolation'
    ],
    nonClaims: [
      '不证明真实 Sekiro TAE/BND4/DCX native 读取。',
      '不证明 overlay/base 目录枚举或 Desktop IPC/Electron 功能。',
      '不提升 ACTION 为 native-verified 或 release 完成。'
    ]
  }, null, 2));
}

function ingest(
  index: WorkspaceIndex,
  input: {
    sourceUri: string;
    sourcePath: string;
    animations: Array<Record<string, unknown>>;
  }
): void {
  const result: BridgeResult<unknown> = {
    sourceUri: input.sourceUri,
    sourcePath: input.sourcePath,
    game: 'Sekiro',
    resourceKind: 'action',
    parseStatus: 'partial',
    diagnostics: [],
    data: { animations: input.animations }
  };
  const accepted = ingestBridgeResult(index, result);
  assert.equal(accepted.accepted, true);
}

main();
