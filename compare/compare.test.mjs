// Tests for the comparison oracle itself. Synthetic inputs only; the real comparison is compare/run.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, compareOrdered, failedComparison, fmgEntriesFromBridge, fmgEntriesFromReferenceGraph,
  groupStatus, staleKnownDiffs, taeAnimationsFromBridge, taeAnimationsFromReferenceGraph } from './lib.mjs';

const graph = entries => ({ $type: 'SoulsFormats.FMG', $members: [{ name: 'Entries', value: { $items: entries.map(([id, text]) => ({
  $type: 'SoulsFormats.FMG+Entry', $members: [{ name: 'ID', value: id }, { name: 'Text', value: text }] })) } }] });

test('reference FMG graph and Bridge entries normalise to the same shape', () => {
  assert.deepEqual(fmgEntriesFromReferenceGraph(graph([[60, null], [61, '刀']])), [{ id: 60, text: null }, { id: 61, text: '刀' }]);
  assert.deepEqual(fmgEntriesFromBridge([{ id: 60 }, { id: 61, text: '刀' }]), [{ id: 60, text: null }, { id: 61, text: '刀' }]);
  assert.throws(() => fmgEntriesFromReferenceGraph({ $type: 'SoulsFormats.MSBS' }), /expected SoulsFormats\.FMG/u);
});

const taeGraph = animations => ({ $type: 'SoulsFormats.TAE', $members: [{ name: 'Animations', value: { $items: animations.map(([id, file, events]) => ({
  $type: 'SoulsFormats.TAE+Animation', $members: [{ name: 'ID', value: { $type: 'System.Int64', value: String(id) } },
    { name: 'AnimFileName', value: file }, { name: 'Events', value: { $items: Array.from({ length: events }, () => ({})) } }] })) } }] });

test('TAE animations normalise to (id, file, events) and a one-slot ID shift is a difference', () => {
  const reference = taeAnimationsFromReferenceGraph(taeGraph([[0, 'a000_000000.hkt', 4], [10, 'a000_000010.hkt', 24], [11, 'a000_000011.hkt', 24]]));
  assert.deepEqual(reference[0], { id: '0', file: 'a000_000000.hkt', events: 4 });
  const bridge = [
    { taeEntryIndex: 1, animId: 0, hkxName: 'a000_000000.hkt', eventCount: 4 },
    { taeEntryIndex: 1, animId: 10, hkxName: 'a000_000010.hkt', eventCount: 24 },
    { taeEntryIndex: 1, animId: 11, hkxName: 'a000_000011.hkt', eventCount: 24 },
    { taeEntryIndex: 2, animId: 0, hkxName: 'a010_000000.hkt', eventCount: 1 }
  ];
  const keyOf = animation => `${animation.id} ${animation.file} ${animation.events}`;
  assert.equal(compareOrdered(reference, taeAnimationsFromBridge(bridge, 1), keyOf).equal, true);
  // Issue #51 shape: every animation carries the next animation's ID.
  const shifted = bridge.slice(0, 3).map((animation, index, all) => ({ ...animation, animId: all[index + 1]?.animId ?? 22 }));
  assert.equal(compareOrdered(reference, taeAnimationsFromBridge(shifted, 1), keyOf).differenceCount, 3);
  assert.throws(() => taeAnimationsFromReferenceGraph({ $type: 'SoulsFormats.FMG' }), /expected SoulsFormats\.TAE/u);
  // No hkx: "" on the reference side and null in the Bridge are the same; a different name is not.
  const noFile = taeAnimationsFromReferenceGraph(taeGraph([[1150, '', 0]]));
  assert.equal(compareOrdered(noFile, taeAnimationsFromBridge([{ taeEntryIndex: 1, animId: 1150, eventCount: 0 }], 1), keyOf).equal, true);
  assert.equal(compareOrdered(noFile, taeAnimationsFromBridge([{ taeEntryIndex: 1, animId: 1150, hkxName: 'a000_001150.hkt', eventCount: 0 }], 1), keyOf).equal, false);
});

test('one changed text, a missing entry or a reordering is a difference', () => {
  const reference = [{ id: 1, text: 'a' }, { id: 2, text: 'b' }, { id: 3, text: 'c' }];
  assert.equal(compareOrdered(reference, structuredClone(reference)).equal, true);
  const changed = compareOrdered(reference, [{ id: 1, text: 'a' }, { id: 2, text: 'B' }, { id: 3, text: 'c' }]);
  assert.equal(changed.equal, false);
  assert.equal(changed.differenceCount, 1);
  assert.equal(changed.differences[0].index, 1);
  assert.equal(compareOrdered(reference, reference.slice(0, 2)).differenceCount, 1);
  assert.equal(compareOrdered(reference, [reference[1], reference[0], reference[2]]).differenceCount, 2);
});

test('the fingerprint changes when any difference changes, including ones past the reported sample', () => {
  const reference = Array.from({ length: 20 }, (_, id) => ({ id, text: 'x' }));
  const firstSoulForge = reference.map(entry => ({ ...entry, text: 'y' }));
  const secondSoulForge = firstSoulForge.map((entry, index) => index === 19 ? { ...entry, text: 'z' } : entry);
  const first = compareOrdered(reference, firstSoulForge);
  const second = compareOrdered(reference, secondSoulForge);
  assert.deepEqual(first.differences, second.differences, 'the reported sample is identical');
  assert.notEqual(first.fingerprint, second.fingerprint);
});

test('a difference is known only while its exact fingerprint has a reason and an issue', () => {
  const comparison = compareOrdered([{ id: 1, text: 'a' }], [{ id: 1, text: 'b' }]);
  const item = { key: 'k', reference: 'ok', comparison };
  const recorded = { key: 'k', fingerprint: comparison.fingerprint, reason: 'r', issue: '#1' };
  assert.equal(classify(item, []), 'diff');
  assert.equal(classify(item, [recorded]), 'known-diff');
  assert.equal(classify(item, [{ ...recorded, fingerprint: '0000000000000000' }]), 'diff');
  assert.equal(classify(item, [{ ...recorded, issue: '' }]), 'diff');
  assert.equal(classify(item, [{ ...recorded, reason: undefined }]), 'diff');
  assert.equal(classify({ key: 'k', reference: 'ok', comparison: failedComparison('READ_FAILED') }, []), 'diff');
  assert.equal(classify({ key: 'k', reference: 'ok', comparison: compareOrdered([1], [1]) }, [recorded]), 'match');
});

test('reference failures are never reported as a match', () => {
  assert.equal(classify({ key: 'k', reference: 'unsupported' }, []), 'reference-unsupported');
  assert.equal(classify({ key: 'k', reference: 'unavailable' }, []), 'reference-unavailable');
  assert.equal(groupStatus(['match', 'reference-unavailable']), 'reference-unavailable');
  assert.equal(groupStatus(['match', 'known-diff', 'diff']), 'diff');
  assert.equal(groupStatus(['match', 'known-diff']), 'known-diff');
  assert.equal(groupStatus(['match', 'match']), 'match');
  assert.equal(groupStatus([]), 'reference-unavailable', 'nothing compared is not a match');
});

test('recorded differences that no longer occur are reported as stale, unrun ones are not', () => {
  const known = [{ key: 'fixed' }, { key: 'still' }, { key: 'not-run' }];
  const items = [{ key: 'fixed', status: 'match' }, { key: 'still', status: 'known-diff' }];
  assert.deepEqual(staleKnownDiffs(items, known), ['fixed']);
});
