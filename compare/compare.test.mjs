// Tests for the comparison oracle itself. Synthetic inputs only; the real comparison is compare/run.mjs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { classify, compareOrdered, emevdFromBridgePages, emevdFromReferenceGraph, emevdKeys, failedComparison, fmgEntriesFromBridge,
  fmgEntriesFromReferenceGraph, graphRefResolver, groupStatus, resolveReferenceResponse, staleKnownDiffs,
  taeAnimationsFromBridge, taeAnimationsFromReferenceGraph } from './lib.mjs';

test('a large reference result takes its identity only from the matching result manifest', () => {
  const full = { requestId: 'r1', status: 'ok', source: { commit: 'c' }, artifacts: [] };
  const bytes = Buffer.from(JSON.stringify(full));
  const summary = sha => ({ requestId: 'r1', status: 'ok', fullResultInManifest: true, resultManifest: { path: 'm', sha256: sha } });
  const good = createHash('sha256').update(bytes).digest('hex');
  const small = { requestId: 'r1', status: 'ok', source: { commit: 'c' } };
  assert.equal(resolveReferenceResponse(small, () => { throw new Error('must not read'); }), small);
  assert.deepEqual(resolveReferenceResponse(summary(good), () => bytes), full);
  assert.throws(() => resolveReferenceResponse(summary('0'.repeat(64)), () => bytes), /hash mismatch/u);
  const other = Buffer.from(JSON.stringify({ ...full, requestId: 'r2' }));
  assert.throws(() => resolveReferenceResponse(summary(createHash('sha256').update(other).digest('hex')), () => other), /another request/u);
  assert.throws(() => resolveReferenceResponse({ ...summary(good), resultManifest: undefined }, () => bytes), /no result manifest/u);
});

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

// Two events in SoulsFormats.EMEVD graph shape: Int64 IDs, an enum RestBehavior with a text value, ArgData blobs, and the
// second empty ArgData written as { $ref } to the first one, as GraphWriter does for an object it has already written.
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const sha256 = bytes => createHash('sha256').update(Buffer.from(bytes)).digest('hex');
const emevdEvents = () => [
  { id: '0', rest: ['Default', '0'], instructions: [[2000, 6, [1, 0, 0, 0], null], [1000, 3, [], null]], parameters: [] },
  { id: '11305300', rest: ['Restart', '1'], instructions: [[2000, 0, [], 5], [1000, 1, [2, 0, 0, 0], null]], parameters: [[1, 0, 0, 4, 1]] }
];

function emevdGraph({ danglingRef = false } = {}) {
  let nextId = 1;
  let emptyArgsId = null;
  const node = (type, members) => ({ $id: nextId++, $type: type, $members: Object.entries(members).map(([name, value]) => ({ name, value })) });
  const list = items => ({ $id: nextId++, $type: 'System.Collections.Generic.List`1', $items: items, $members: [{ name: 'Count', value: items.length }] });
  const int64 = value => ({ $type: 'System.Int64', value: String(value) });
  const blob = bytes => {
    if (bytes.length === 0 && emptyArgsId !== null) return { $ref: danglingRef ? 9999 : emptyArgsId };
    const value = { $id: nextId++, $type: 'System.Byte[]', $blob: 'structure.blobs/000001.bin', length: bytes.length, sha256: sha256(bytes) };
    if (bytes.length === 0) emptyArgsId = value.$id;
    return value;
  };
  const events = emevdEvents().map(event => node('SoulsFormats.EMEVD+Event', {
    ID: int64(event.id),
    Instructions: list(event.instructions.map(([bank, id, args, layer]) => node('SoulsFormats.EMEVD+Instruction', { Bank: bank, ID: id, ArgData: blob(args), Layer: layer }))),
    Parameters: list(event.parameters.map(([instruction, target, source, bytes, unk]) => node('SoulsFormats.EMEVD+Parameter', {
      InstructionIndex: int64(instruction), TargetStartByte: int64(target), SourceStartByte: int64(source), ByteCount: bytes, UnkID: unk }))),
    RestBehavior: { $type: 'SoulsFormats.EMEVD+Event+RestBehaviorType', name: event.rest[0], value: event.rest[1] },
    Name: null
  }));
  return node('SoulsFormats.EMEVD', { Events: list(events) });
}

// The same document as Bridge read-emevd-document pages: plain numbers, base64 args, layerOffset -1 = no layer.
function emevdBridgePages(pageSize = 3, mutate = instructions => instructions) {
  const flat = mutate(emevdEvents().flatMap(event => event.instructions).map(([bank, id, args, layer], index) => ({
    index, bank, id, argsLength: args.length, argsBase64: Buffer.from(args).toString('base64'), layerOffset: layer === null ? -1 : 0 })));
  let start = 0;
  const events = emevdEvents().map(event => {
    const projected = { id: Number(event.id), instructionCount: event.instructions.length,
      instructionStartIndex: event.instructions.length ? start : -1, parameterCount: event.parameters.length, restBehavior: Number(event.rest[1]),
      parameters: event.parameters.map(([instructionIndex, targetStartByte, sourceStartByte, byteCount, unkId]) =>
        ({ instructionIndex, targetStartByte, sourceStartByte, byteCount, unkId })) };
    start += event.instructions.length;
    return projected;
  });
  const pageCount = Math.ceil(flat.length / pageSize);
  return Array.from({ length: pageCount }, (_, page) => ({ sourceHash: 'h', events, instructionTotal: flat.length, instructionPage: page,
    instructionPageCount: pageCount, instructionsSample: flat.slice(page * pageSize, (page + 1) * pageSize) }));
}

test('GraphWriter $ref nodes resolve to the object first written with that $id; duplicate or dangling ids fail', () => {
  const reference = emevdFromReferenceGraph(emevdGraph());
  assert.equal(reference.instructions[1].args, EMPTY_SHA256);
  assert.equal(reference.instructions[2].args, EMPTY_SHA256, 'the second empty ArgData is a $ref to the first');
  assert.equal(reference.instructions[2].argsLength, '0');
  assert.throws(() => emevdFromReferenceGraph(emevdGraph({ danglingRef: true })), /unresolved \$ref 9999/u);
  const deref = graphRefResolver({ $id: 1, $members: [{ name: 'A', value: { $id: 2, x: 1 } }] });
  assert.deepEqual(deref({ $ref: 2 }), { $id: 2, x: 1 });
  const plain = { x: 1 };
  assert.equal(deref(plain), plain);
  assert.throws(() => graphRefResolver({ $id: 1, a: { $id: 1 } }), /duplicate \$id 1/u);
  assert.throws(() => emevdFromReferenceGraph({ $type: 'SoulsFormats.TAE' }), /expected SoulsFormats\.EMEVD/u);
});

test('EMEVD reference graph and Bridge pages normalise to the same events, instructions and parameters for any page size', () => {
  const reference = emevdFromReferenceGraph(emevdGraph());
  assert.deepEqual(reference.events, [{ id: '0', restBehavior: '0', instructions: 2, parameters: 0 },
    { id: '11305300', restBehavior: '1', instructions: 2, parameters: 1 }]);
  assert.deepEqual(reference.parameters, [{ event: '11305300', index: 0, instruction: '1', target: '0', source: '0', bytes: '4', unk: '1' }]);
  for (const pageSize of [1, 2, 3, 4]) {
    const bridge = emevdFromBridgePages(emevdBridgePages(pageSize));
    for (const part of ['events', 'instructions', 'parameters']) {
      assert.equal(compareOrdered(reference[part], bridge[part], emevdKeys[part]).equal, true, `${part} with page size ${pageSize}`);
    }
  }
});

test('missing, reordered, mixed or short Bridge pages fail instead of comparing a subset', () => {
  const pages = emevdBridgePages(3);
  assert.equal(pages.length, 2);
  assert.throws(() => emevdFromBridgePages(pages.slice(0, 1)), /incomplete or come from different sources/u);
  assert.throws(() => emevdFromBridgePages([pages[1], pages[0]]), /incomplete or come from different sources/u);
  assert.throws(() => emevdFromBridgePages([pages[0], { ...pages[1], sourceHash: 'other' }]), /incomplete or come from different sources/u);
  assert.throws(() => emevdFromBridgePages([pages[0], { ...pages[1], instructionTotal: 5 }]), /incomplete or come from different sources/u);
  assert.throws(() => emevdFromBridgePages([pages[0], { ...pages[1], instructionsSample: [] }]), /returned 3 of 4 instructions/u);
  assert.throws(() => emevdFromBridgePages([]), /incomplete or come from different sources/u);
});

test('a changed args byte on a later page, a dropped layer, a shifted event range, a rest behavior or a parameter change is a diff', () => {
  const reference = emevdFromReferenceGraph(emevdGraph());
  const compare = (pages, part = 'instructions') => compareOrdered(reference[part], emevdFromBridgePages(pages)[part], emevdKeys[part]);
  // Instruction 3 is the only instruction on page 1 when the page size is 3.
  const args = compare(emevdBridgePages(3, all => all.map(i => i.index === 3 ? { ...i, argsBase64: Buffer.from([3, 0, 0, 0]).toString('base64') } : i)));
  assert.equal(args.differenceCount, 1);
  assert.equal(args.differences[0].index, 3);
  assert.equal(classify({ key: 'k', reference: 'ok', comparison: args }, []), 'diff');
  assert.equal(compare(emevdBridgePages(3, all => all.map(i => i.index === 2 ? { ...i, layerOffset: -1 } : i))).differenceCount, 1);
  const shifted = emevdBridgePages();
  shifted[0].events[1] = { ...shifted[0].events[1], instructionStartIndex: 1 };
  assert.equal(compare(shifted).differenceCount, 2, 'event 11305300 now reads instructions 1..2 instead of 2..3');
  const rest = emevdBridgePages();
  rest[0].events[0] = { ...rest[0].events[0], restBehavior: 1 };
  assert.equal(compare(rest, 'events').differenceCount, 1);
  const parameter = emevdBridgePages();
  parameter[0].events[1] = { ...parameter[0].events[1], parameters: [{ ...parameter[0].events[1].parameters[0], byteCount: 8 }] };
  assert.equal(compare(parameter, 'parameters').differenceCount, 1);
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
