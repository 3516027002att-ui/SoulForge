import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { classifyDcxRead, classifyNativeRead, collectNativeReads, summarizeNativeReads, verifyFileCoverage } from './native-read-acceptance.mjs';

const file = resolve('owned-fixture/source.ffxbnd.dcx'), sourceUri = pathToFileURL(file).href;
const sourceHash = 'a'.repeat(64), contentHash = 'b'.repeat(64);
const variants = new Set(['DFLT_fixture', 'KRAK_fixture']);
const context = { file, sourceHash, sourceSize: 64 * 1024 * 1024 + 1, sourceUnchanged: true, variants };
function cacheReceipt() {
  const entry = { index: 0, id: 7, name: 'effects\\example.fxr', entryIndex: 0, entryId: 7, entryName: 'effects\\example.fxr',
    duplicateOrdinal: 0, contentHash, contentSize: 3, size: 3, uncompressedSize: 3,
    sourcePath: file, sourceUri: `${sourceUri}#bnd/entry/0/child/effects%5Cexample.fxr`, sourceContainerHash: sourceHash };
  return { sourceUri, sourcePath: file, parseStatus: 'partial', diagnostics: [{ code: 'LARGE_RESOURCE_READ_ONLY_CACHE', severity: 'info' }],
    data: { format: 'DCX', sourceHash, sourceSize: 64 * 1024 * 1024 + 1, entryCount: 1, entries: [entry], readOnly: true,
      nested: { format: 'BND4', entryCount: 1, entries: [structuredClone(entry)] },
      provenance: { sourceContainerHash: sourceHash, unpackerIdentity: 'c'.repeat(64), unpacker: 'user-imported-standalone-WitchyBND', readOnly: true, containerWriteSupported: false },
      roundTrip: { byteIdentical: false, payloadIdentical: false } } };
}
function dfltReceipt() { return { parseStatus: 'partial', diagnostics: [], data: { compressionFormat: 'DFLT', variant: 'DFLT_fixture',
  roundTrip: { payloadIdentical: true, variantIdentical: true }, nested: { format: 'BND4', roundTrip: { entriesIdentical: true }, crud: { allPassed: true } }, nestedDcxRebuildVerified: true } }; }
function krakReceipt() { return { parseStatus: 'partial', diagnostics: [], data: { compressionFormat: 'KRAK', variant: 'KRAK_fixture', payloadHash: contentHash,
  nested: { format: 'BND4', crud: { allPassed: true }, fieldPreservation: { headerUnknownBytesPreserved: true, entryHeaderFieldsPreserved: true, storedBytesPreserved: true } } } }; }

test('missing imported tool is unavailable, not a successful read', () => {
  const receipt = { parseStatus: 'unsupported', diagnostics: [{ severity: 'warning', code: 'LARGE_RESOURCE_UNPACKER_MISSING' }] };
  assert.equal(classifyNativeRead(receipt).status, 'unavailable');
  assert.equal(classifyDcxRead(receipt, context).status, 'unavailable');
});
test('read receipt needs executed parsing and real data', () => {
  assert.equal(classifyNativeRead({ parseStatus: 'partial', diagnostics: [] }).status, 'failed');
  assert.equal(classifyNativeRead({ parseStatus: 'unparsed', data: {} }).status, 'unavailable');
  assert.equal(classifyNativeRead({ parseStatus: 'ok', data: {} }).status, 'passed');
  assert.equal(classifyNativeRead({ parseStatus: 'failed', data: {} }).status, 'failed');
});
test('empty/no-sample and mixed unavailable summaries cannot become passes', () => {
  for (const rows of [[], [{ status: 'not_run' }]]) {
    const result = summarizeNativeReads(rows); assert.equal(result.status, 'not_run'); assert.equal(result.ok, null); assert.equal(result.skipped, true);
  }
  const mixed = summarizeNativeReads([{ status: 'passed' }, { status: 'unavailable' }]);
  assert.equal(mixed.status, 'unavailable'); assert.equal(mixed.ok, null); assert.ok(mixed.skippedLegs.length);
  assert.equal(mixed.counts.passed, 1); assert.equal(mixed.counts.unavailable, 1);
  assert.equal(summarizeNativeReads([{ status: 'passed' }, { status: 'not_run' }]).status, 'not_run');
  const unavailable = summarizeNativeReads([{ status: 'unavailable' }]);
  assert.equal(unavailable.status, 'unavailable'); assert.equal(unavailable.skipped, true);
  assert.equal(summarizeNativeReads([{ status: 'failed' }, { status: 'not_run' }]).status, 'failed');
});
test('only the source-bound complete native cache table gets read-only acceptance', () => {
  const result = classifyDcxRead(cacheReceipt(), context);
  assert.equal(result.status, 'passed'); assert.equal(result.kind, 'read-only-cache');
  assert.equal(result.containerWriteSupported, false); assert.equal(result.outerRoundTripVerified, false);
});
for (const [name, mutate] of [
  ['no cache diagnostic', r => { r.diagnostics = []; }],
  ['wrong source version', r => { r.data.sourceHash = 'd'.repeat(64); }],
  ['wrong source size', r => { r.data.sourceSize += 1; }],
  ['foreign source path', r => { r.data.entries[0].sourcePath = resolve('unrelated.dcx'); }],
  ['cache filesystem URI', r => { r.data.entries[0].sourceUri = 'file:///cache/leaf.fxr'; }],
  ['wrong child URI name', r => { r.data.entries[0].sourceUri = `${sourceUri}#bnd/entry/0/child/other.fxr`; }],
  ['wrong native identity alias', r => { r.data.entries[0].entryId = 8; }],
  ['missing content hash', r => { delete r.data.entries[0].contentHash; }],
  ['missing native table sibling', r => { r.data.nested.entries = []; }],
  ['duplicate native table entry', r => { r.data.entries.push(structuredClone(r.data.entries[0])); r.data.entryCount = 2; }],
  ['writer capability claim', r => { r.data.provenance.containerWriteSupported = true; }],
  ['undeclared unpacker provenance', r => { delete r.data.provenance.unpacker; }],
  ['outer byte roundtrip claim', r => { r.data.roundTrip.byteIdentical = true; }],
  ['outer payload roundtrip claim', r => { r.data.roundTrip.payloadIdentical = true; }],
  ['failed receipt with valid-looking data', r => { r.parseStatus = 'failed'; }]
]) test(`cache acceptance rejects ${name}`, () => {
  const result = cacheReceipt(); mutate(result); assert.equal(classifyDcxRead(result, context).status, 'failed');
});
test('cache source hash must be independently observed and unchanged', () => {
  assert.equal(classifyDcxRead(cacheReceipt(), { ...context, sourceHash: undefined }).status, 'failed');
  assert.equal(classifyDcxRead(cacheReceipt(), { ...context, sourceUnchanged: false }).status, 'failed');
});
test('ordinary DFLT and KRAK assertions remain strict and independently exercised', () => {
  assert.equal(classifyDcxRead(dfltReceipt(), context).kind, 'dflt-roundtrip');
  assert.equal(classifyDcxRead(krakReceipt(), context).kind, 'krak-native-read');
  for (const corrupt of [r => { r.data.roundTrip.payloadIdentical = false; }, r => { r.data.nested.crud.allPassed = false; },
    r => { r.data.nestedDcxRebuildVerified = false; }, r => { r.data.variant = 'UNRECOGNIZED'; }]) {
    const receipt = dfltReceipt(); corrupt(receipt); assert.equal(classifyDcxRead(receipt, context).status, 'failed');
  }
  const krak = krakReceipt(); krak.data.nested.fieldPreservation.storedBytesPreserved = false;
  assert.equal(classifyDcxRead(krak, context).status, 'failed');
  const failure = dfltReceipt(); failure.parseStatus = 'failed'; assert.equal(classifyDcxRead(failure, context).status, 'failed');
});
for (const value of [false, undefined]) test(`DFLT nested BND4 requires entriesIdentical, got ${value}`, () => {
  const receipt = dfltReceipt(); receipt.data.nested.roundTrip.entriesIdentical = value;
  const result = classifyDcxRead(receipt, context);
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'BND4_CRUD_ROUNDTRIP_FAILED');
});

test('failed DFLT preserves native sub-check facts without turning unsupported CRUD into success', () => {
  const receipt = dfltReceipt(); receipt.data.nested.crud = { allPassed: false,
    note: 'BND4_HASH_INDEX_STRUCTURAL_REPACK_UNSUPPORTED: controlled fixture' };
  receipt.data.nestedDcxRebuildVerified = null;
  const result = classifyDcxRead(receipt, context);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.nativeChecks, {
    parseStatus: 'partial', entriesIdentical: true, crudAllPassed: false,
    crudNote: receipt.data.nested.crud.note, crudNoteTruncated: false, nestedDcxRebuildVerified: null,
    headerUnknownBytesPreserved: null, entryHeaderFieldsPreserved: null, storedBytesPreserved: null
  });
});

test('failed KRAK facts remain tri-state and bounded, without copying nested payloads', () => {
  const receipt = krakReceipt(); receipt.data.nested.crud.note = 'x'.repeat(800);
  receipt.data.nested.fieldPreservation.storedBytesPreserved = false;
  receipt.data.nested.fieldPreservation.entryHeaderFieldsPreserved = 'true';
  receipt.data.nested.entries = [{ content: 'not-an-acceptance-fact' }];
  const result = classifyDcxRead(receipt, context);
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'KRAK_BND4_PRESERVATION_OR_CRUD_FAILED');
  assert.equal(result.nativeChecks.crudNote.length, 512); assert.equal(result.nativeChecks.crudNoteTruncated, true);
  assert.equal(result.nativeChecks.storedBytesPreserved, false);
  assert.equal(result.nativeChecks.headerUnknownBytesPreserved, true);
  assert.equal(result.nativeChecks.entryHeaderFieldsPreserved, null);
  assert.equal(result.nativeChecks.entriesIdentical, null);
  assert.equal(Object.hasOwn(result.nativeChecks, 'entries'), false);
});
for (const concurrency of [1, 3]) test(`collector does not lose already settled receipts at concurrency ${concurrency}`, async () => {
  const input = ['a', 'b', 'c'], output = [];
  for await (const result of collectNativeReads(input, concurrency, async file => ({ file, result: {} }))) output.push(result.file);
  assert.deepEqual([...output].sort(), input); assert.equal(verifyFileCoverage(input, output).ok, true);
});
test('collector preserves rejected and misbound file outcomes as explicit failures', async () => {
  const output = [];
  for await (const result of collectNativeReads(['bad', 'other'], 2, async file => {
    if (file === 'bad') throw new Error('CONTROLLED_READ_FAILURE'); return { file: 'wrong' };
  })) output.push(result);
  assert.equal(verifyFileCoverage(['bad', 'other'], output.map(item => item.file)).ok, true);
  assert.ok(output.every(item => item.error));
});
test('coverage rejects omissions, duplicate receipts, duplicate inputs and unexpected files', () => {
  for (const [input, output] of [[['a', 'b'], ['a']], [['a', 'b'], ['a', 'a', 'b']], [['a'], ['a', 'x']], [['a', 'a'], ['a', 'a']]]) {
    assert.equal(verifyFileCoverage(input, output).ok, false);
  }
  const good = verifyFileCoverage(['a', 'b'], ['b', 'a']);
  assert.equal(good.ok, true); assert.equal(good.inputSetSha256, good.processedSetSha256);
});
