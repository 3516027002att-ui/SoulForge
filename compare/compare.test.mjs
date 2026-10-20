// Tests for the comparison oracle itself. Synthetic inputs only; the real comparison is compare/run.mjs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { classify, compareOrdered, emevdFromBridgePages, emevdFromReferenceGraph, emevdKeys, failedComparison, float32Bits, fmgEntriesFromBridge,
  fmgEntriesFromReferenceGraph, graphRefResolver, groupStatus, int64Text, memberItems, msbDisambiguateNames, msbFromBridge, msbFromReferenceGraph, msbKeys,
  referenceFloatBits, resolveReferenceResponse, staleKnownDiffs, taeAnimationsFromBridge, taeAnimationsFromReferenceGraph } from './lib.mjs';

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

// IEEE-754 single bits written out by hand, not computed with the code under test.
const BITS = { '1': '3F800000', '-303': 'C3978000', '0.5': '3F000000', '2': '40000000', '0': '00000000', '90': '42B40000' };

test('float32 bits are exact: -0 differs from +0, one ulp differs, non-floats and malformed reference nodes fail', () => {
  for (const [text, bits] of Object.entries(BITS)) assert.equal(float32Bits(Number(text)), bits);
  assert.equal(float32Bits(-0), '80000000');
  assert.equal(float32Bits(1 + 2 ** -23), '3F800001');
  for (const bad of [NaN, Infinity, '1', null, undefined]) assert.throws(() => float32Bits(bad), /not a finite float/u);
  assert.equal(referenceFloatBits({ $type: 'System.Single', value: '-303', bits: 'c3978000' }), 'C3978000');
  for (const bad of [{ $type: 'System.Double', value: '1', bits: '3F800000' }, { $type: 'System.Single', value: '1' },
    { $type: 'System.Single', bits: '3F80000' }, { $type: 'System.Single', bits: '3F80000G' }, 1, null]) {
    assert.throws(() => referenceFloatBits(bad), /expected a System\.Single with bits/u);
  }
});

test('Int64 text accepts canonical in-range decimals only', () => {
  assert.equal(int64Text({ $type: 'System.Int64', value: '-9223372036854775808' }), '-9223372036854775808');
  assert.equal(int64Text({ $type: 'System.Int64', value: '9223372036854775807' }), '9223372036854775807');
  assert.equal(int64Text({ $type: 'System.Int64', value: '0' }), '0');
  assert.throws(() => int64Text({ $type: 'System.Int64', value: '9223372036854775808' }), /out of range/u);
  assert.throws(() => int64Text({ $type: 'System.Int64', value: '-9223372036854775809' }), /out of range/u);
  for (const value of ['-0', '01', '1.0', '', ' 1', 1]) assert.throws(() => int64Text({ $type: 'System.Int64', value }), /not an Int64 decimal/u);
  for (const bad of [{ $type: 'System.Int32', value: '1' }, '1', 1, null]) assert.throws(() => int64Text(bad), /expected System\.Int64/u);
});

test('member items resolve the list and each item through $ref; a non-list or a missing member fails', () => {
  const shared = { $id: 2, $type: 'T', $members: [] };
  const graph = { $id: 1, $type: 'Root', $members: [{ name: 'A', value: { $id: 3, $items: [shared, { $ref: 2 }] } },
    { name: 'B', value: { $ref: 3 } }, { name: 'C', value: { $id: 4, $type: 'NotAList' } }, { name: 'D', value: null }] };
  const deref = graphRefResolver(graph);
  assert.deepEqual(memberItems(graph, 'A', deref), [shared, shared]);
  assert.deepEqual(memberItems(graph, 'B', deref), [shared, shared]);
  assert.throws(() => memberItems(graph, 'C', deref), /Root C has no items/u);
  assert.throws(() => memberItems(graph, 'D', deref), /Root D has no items/u);
  assert.throws(() => memberItems(graph, 'E', deref), /member E missing on Root/u);
  assert.throws(() => memberItems(graph, 'A'), /needs a graphRefResolver/u);
});

// One map in both shapes, written by hand. File order interleaves types; both sides must come out in MSBS type order.
// Class names per type id are written out here, not taken from lib.mjs MSBS_TYPES.
const CLASS = { model: { 0: 'MapPiece', 2: 'Enemy' }, part: { 0: 'MapPiece', 2: 'Enemy' }, region: { 5: 'SFX', '-1': 'Other' },
  event: { 23: 'Talk', 4: 'Treasure' }, shape: { 0: 'Point', 5: 'Box' } };
const MSB_ROWS = {
  models: [[0, 'm0', 'sib/m0'], [2, 'e0', 'sib/e0'], [0, 'm1', null]],
  parts: [[2, 'p1', 1, ['2', '0', '0'], ['0', '0', '0'], ['1', '1', '2'], 7], [0, 'p0', 2, ['1', '-303', '0.5'], ['0', '90', '0'], ['1', '1', '1'], 0]],
  regions: [[-1, 'r1', 5, ['0', '0', '0'], ['0', '0', '0'], 9], [5, 'r0', 0, ['1', '2', '0.5'], ['0', '90', '0'], 0]],
  events: [[23, 'k0', 11], [4, 't0', 10]]
};
const single = text => ({ $type: 'System.Single', value: text, bits: BITS[text] });
const vector3 = (x, y, z) => ({ $type: 'System.Numerics.Vector3', $members: [['X', x], ['Y', y], ['Z', z]].map(([name, text]) => ({ name, value: single(text) })) });

function msbGraph(rows = MSB_ROWS) {
  let id = 1;
  const node = (type, members) => ({ $id: id++, $type: type, $members: Object.entries(members).map(([name, value]) => ({ name, value })) });
  const param = (family, familyClass, rows, build) => {
    const lists = {};
    for (const row of rows) (lists[CLASS[family][row[0]]] ??= []).push(node(`SoulsFormats.MSBS+${familyClass}+${CLASS[family][row[0]]}`, build(row)));
    return node(`SoulsFormats.MSBS+${familyClass}Param`, { Version: 1,
      ...Object.fromEntries(Object.entries(lists).map(([name, items]) => [`${name}s`, { $id: id++, $type: 'List', $items: items }])) });
  };
  const models = param('model', 'Model', rows.models, ([, name, sib]) => ({ Name: name, SibPath: sib }));
  const parts = param('part', 'Part', rows.parts, ([, name, index, p, r, s, entity]) => ({ Name: name,
    ModelName: rows.models[index][1], Position: vector3(...p), Rotation: vector3(...r), Scale: vector3(...s), EntityID: entity }));
  const regions = param('region', 'Region', rows.regions, ([, name, shape, p, r, entity]) => ({ Name: name,
    Shape: { $id: id++, $type: `SoulsFormats.MSB+Shape+${CLASS.shape[shape]}`, $members: [] }, Position: vector3(...p), Rotation: vector3(...r), EntityID: entity }));
  const events = param('event', 'Event', rows.events, ([, name, eventId]) => ({ Name: name, EventID: eventId }));
  return node('SoulsFormats.MSBS', { Models: models, Events: events, Regions: regions, Parts: parts });
}

function msbEnvelope(mutate = rows => rows, base = MSB_ROWS) {
  const rows = mutate(structuredClone(base));
  const xyz = (prefix, [x, y, z]) => ({ [`${prefix}X`]: Number(x), [`${prefix}Y`]: Number(y), [`${prefix}Z`]: Number(z) });
  const envelope = { format: 'MSB',
    models: rows.models.map(([typeId, name, sibPath]) => ({ name, sibPath, typeId })),
    parts: rows.parts.map(([typeId, name, modelIndex, p, r, s, entityId]) => ({ name, typeId, modelIndex, ...xyz('pos', p), ...xyz('rot', r), ...xyz('scale', s), entityId })),
    regions: rows.regions.map(([typeId, name, shapeType, p, r, entityId]) => ({ name, typeId, shapeType, ...xyz('pos', p), ...xyz('rot', r), entityId })),
    events: rows.events.map(([typeId, name, eventId]) => ({ name, typeId, eventId })) };
  for (const key of ['models', 'parts', 'regions', 'events']) { envelope[`${key.slice(0, -1)}Count`] = envelope[key].length; envelope[`${key}Truncated`] = false; }
  return envelope;
}

test('MSB reference graph and Bridge envelope normalise to the same rows, in type order then file order', () => {
  const reference = msbFromReferenceGraph(msbGraph());
  const bridge = msbFromBridge(msbEnvelope());
  for (const part of ['models', 'parts', 'regions', 'events']) assert.equal(compareOrdered(reference[part], bridge[part], msbKeys[part]).equal, true, part);
  assert.deepEqual(reference.models.map(m => [m.type, m.name, m.sibPath]), [['MapPiece', 'm0', 'sib/m0'], ['MapPiece', 'm1', null], ['Enemy', 'e0', 'sib/e0']]);
  assert.deepEqual(reference.parts[0], { type: 'MapPiece', name: 'p0', model: 'm1', position: '3F800000,C3978000,3F000000',
    rotation: '00000000,42B40000,00000000', scale: '3F800000,3F800000,3F800000', entityId: '0' });
  assert.deepEqual(reference.regions.map(r => [r.type, r.name, r.shape]), [['SFX', 'r0', 'Point'], ['Other', 'r1', 'Box']]);
  assert.deepEqual(reference.events.map(e => [e.type, e.name, e.eventId]), [['Treasure', 't0', '10'], ['Talk', 'k0', '11']]);
});

test('one ulp, -0, a shifted model index, a type, shape, entity or event id change is a diff; unknown ids stay visible', () => {
  const reference = msbFromReferenceGraph(msbGraph());
  const diff = (part, mutate) => compareOrdered(reference[part], msbFromBridge(msbEnvelope(mutate))[part], msbKeys[part]);
  assert.equal(diff('parts', rows => { rows.parts[1][3][0] = String(1 + 2 ** -23); return rows; }).differenceCount, 1);
  assert.equal(diff('parts', rows => { rows.parts[1][4][0] = '-0'; return rows; }).differenceCount, 1);
  assert.equal(diff('parts', rows => { rows.parts[1][2] = 0; return rows; }).differenceCount, 1);
  assert.equal(diff('parts', rows => { rows.parts[0][0] = 10; return rows; }).differenceCount, 1, 'Enemy read as DummyEnemy');
  assert.equal(diff('regions', rows => { rows.regions[1][2] = 2; return rows; }).differenceCount, 1);
  assert.equal(diff('regions', rows => { rows.regions[0][5] = 8; return rows; }).differenceCount, 1);
  assert.equal(diff('events', rows => { rows.events[1][2] = 11; return rows; }).differenceCount, 1);
  const unknown = msbFromBridge(msbEnvelope(rows => { rows.events[0][0] = 99; rows.regions[1][2] = 9; return rows; }));
  assert.equal(unknown.events.at(-1).type, '<unknown typeId 99>');
  assert.equal(unknown.regions[0].shape, '<unknown shapeType 9>');
  // SoulsFormats MSB.FindName: -1 or past the end is no model name; another negative index is not a name either.
  const indexes = msbFromBridge(msbEnvelope(rows => { rows.parts[0][2] = -1; rows.parts[1][2] = 3; return rows; }));
  assert.deepEqual(indexes.parts.map(p => p.model), [null, null]);
  assert.equal(msbFromBridge(msbEnvelope(rows => { rows.parts[1][2] = -2; return rows; })).parts[0].model, '<invalid modelIndex -2>');
});

test('a truncated or inconsistent Bridge envelope and an unknown or malformed reference graph fail instead of comparing', () => {
  assert.throws(() => msbFromBridge({ ...msbEnvelope(), format: 'TAE' }), /expected a Bridge MSB envelope/u);
  assert.throws(() => msbFromBridge({ ...msbEnvelope(), regionsTruncated: true }), /regions are truncated/u);
  assert.throws(() => msbFromBridge({ ...msbEnvelope(), eventCount: 3 }), /events length does not match its count/u);
  const typeText = msbEnvelope(); typeText.parts[0].typeId = '2';
  assert.throws(() => msbFromBridge(typeText), /part typeId is not an integer/u);
  const nonFinite = msbEnvelope(); nonFinite.parts[0].posX = null;
  assert.throws(() => msbFromBridge(nonFinite), /not a finite float/u);
  assert.throws(() => msbFromReferenceGraph({ $type: 'SoulsFormats.MSB3' }), /expected SoulsFormats\.MSBS/u);
  const section = (graph, param, list) => graph.$members.find(m => m.name === param).value.$members.find(m => m.name === list).value;
  const unknownClass = msbGraph(); section(unknownClass, 'Events', 'Talks').$items[0].$type = 'SoulsFormats.MSBS+Event+Navmesh';
  assert.throws(() => msbFromReferenceGraph(unknownClass), /unknown MSBS event class/u);
  const noBits = msbGraph(); delete section(noBits, 'Parts', 'MapPieces').$items[0].$members.find(m => m.name === 'Position').value.$members[0].value.bits;
  assert.throws(() => msbFromReferenceGraph(noBits), /expected a System\.Single with bits/u);
});

test('MSB name disambiguation follows SoulsFormats: duplicates get " {n}", blanks always do, and passes repeat until unique', () => {
  assert.deepEqual(msbDisambiguateNames(['名', '名', '名']), ['名', '名 {2}', '名 {3}']);
  assert.deepEqual(msbDisambiguateNames(['']), [' {1}']);
  assert.deepEqual(msbDisambiguateNames(['', 'a', '']), [' {1}', 'a', ' {2}']);
  // Pass 1 renames the second "A" to "A {2}", which collides with the third entry's own name; pass 2 renames that one.
  assert.deepEqual(msbDisambiguateNames(['A', 'A', 'A {2}']), ['A', 'A {2}', 'A {2} {2}']);
  assert.deepEqual(msbDisambiguateNames(['a', 'b']), ['a', 'b']);
  assert.deepEqual(msbDisambiguateNames(['a', 'a'], 'C'), ['a', 'Ca {2}']);
  const input = ['x', 'x'];
  msbDisambiguateNames(input);
  assert.deepEqual(input, ['x', 'x'], 'the input list is not modified');
  assert.throws(() => msbDisambiguateNames(['a', null]), /not a string/u);
});

// Raw Bridge rows of one map with duplicate and blank names across types, and the names SoulsFormats shows after its
// post-read rename, written by hand: one counter per list in file order across types; events are not renamed.
const DUP_ROWS = {
  models: [[0, 'm', 'sib/a'], [2, 'm', 'sib/b'], [0, '', null]],
  parts: [[0, 'p', 1, ['1', '0', '0'], ['0', '0', '0'], ['1', '1', '1'], 0], [2, 'p', 2, ['2', '0', '0'], ['0', '0', '0'], ['1', '1', '1'], 0],
    [0, 'p', 0, ['0', '0', '0'], ['0', '0', '0'], ['1', '1', '1'], 0]],
  regions: [[-1, 'r', 0, ['0', '0', '0'], ['0', '0', '0'], 0], [5, 'r', 0, ['1', '0', '0'], ['0', '0', '0'], 0], [5, '', 0, ['2', '0', '0'], ['0', '0', '0'], 0]],
  events: [[23, 'k', 1], [23, 'k', 2]]
};
const DUP_REFERENCE = structuredClone(DUP_ROWS);
DUP_REFERENCE.models.forEach((row, i) => { row[1] = ['m', 'm {2}', ' {1}'][i]; });
DUP_REFERENCE.parts.forEach((row, i) => { row[1] = ['p', 'p {2}', 'p {3}'][i]; });
DUP_REFERENCE.regions.forEach((row, i) => { row[1] = ['r', 'r {2}', ' {1}'][i]; });

test('Bridge duplicate and blank names get the same rename as SoulsFormats, and parts resolve the renamed model names', () => {
  const reference = msbFromReferenceGraph(msbGraph(DUP_REFERENCE));
  const bridge = msbFromBridge(msbEnvelope(undefined, DUP_ROWS));
  for (const part of ['models', 'parts', 'regions', 'events']) assert.equal(compareOrdered(reference[part], bridge[part], msbKeys[part]).equal, true, part);
  assert.deepEqual(bridge.models.map(m => m.name), ['m', ' {1}', 'm {2}']);
  assert.deepEqual(bridge.parts.map(p => [p.name, p.model]), [['p', 'm {2}'], ['p {3}', 'm'], ['p {2}', ' {1}']]);
  // One counter across types in file order: per-type renaming would give the first SFX region "r", not "r {2}".
  assert.deepEqual(bridge.regions.map(r => r.name), ['r {2}', ' {1}', 'r']);
  assert.deepEqual(bridge.events.map(e => e.name), ['k', 'k']);
});

test('a Bridge name cut to a prefix of a unique reference name is still a diff, also when the cut-off part is " {2}"', () => {
  const suffixed = structuredClone(MSB_ROWS); suffixed.regions[1][1] = 'x {2}';
  const reference = msbFromReferenceGraph(msbGraph(suffixed));
  const cut = msbFromBridge(msbEnvelope(rows => { rows.regions[1][1] = 'x'; return rows; }, suffixed));
  assert.equal(compareOrdered(reference.regions, cut.regions, msbKeys.regions).differenceCount, 1);
  assert.equal(compareOrdered(reference.regions, msbFromBridge(msbEnvelope(undefined, suffixed)).regions, msbKeys.regions).equal, true);
  const model = structuredClone(MSB_ROWS); model.models[2][1] = 'm1 {2}';
  const modelReference = msbFromReferenceGraph(msbGraph(model));
  const modelCut = msbFromBridge(msbEnvelope(rows => { rows.models[2][1] = 'm1'; return rows; }, model));
  assert.equal(compareOrdered(modelReference.models, modelCut.models, msbKeys.models).differenceCount, 1);
  assert.equal(compareOrdered(modelReference.parts, modelCut.parts, msbKeys.parts).differenceCount, 1, 'the part that uses that model');
  const plain = structuredClone(MSB_ROWS); plain.regions[1][1] = 'route_long_name';
  const plainCut = msbFromBridge(msbEnvelope(rows => { rows.regions[1][1] = 'route_long'; return rows; }, plain));
  assert.equal(compareOrdered(msbFromReferenceGraph(msbGraph(plain)).regions, plainCut.regions, msbKeys.regions).differenceCount, 1);
});
