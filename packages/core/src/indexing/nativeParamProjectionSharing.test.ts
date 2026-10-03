import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ParamDefDocument } from '@soulforge/shared';
import { decodeRowFields } from '../param/paramdefLayout.js';
import { decodeNativeParamRows, type NativeParamFieldProjectionCache } from './nativeSemanticRefresh.js';

const definition: ParamDefDocument = {
  schemaVersion: 1, typeName: 'SHARED_FIELD_FIXTURE', version: 1, rowDataSize: 8, origin: 'fixture',
  fields: [{ id: 'flag', name: 'Flag', type: 'u8', offset: 0, size: 1, description: 'All metadata stays visible' },
    { id: 'rate', name: 'Rate', type: 'f32', offset: 4, size: 4 }]
};
const file = { sourceUri: 'file://param/shared.param', mtimeMs: 12 };
const makeRows = (rates: number[]) => rates.map((rate, rowIndex) => {
  const bytes = Buffer.alloc(8); bytes.writeFloatLE(rate, 4);
  return { id: 100 + rowIndex, rowIndex, dataHash: `bytes-${rowIndex}`, dataBase64: bytes.toString('base64') };
});
const decode = (rows: ReturnType<typeof makeRows>, document = definition,
  options: { fieldProjectionCache?: NativeParamFieldProjectionCache; referenceFieldsOnly?: boolean } = {}) => decodeNativeParamRows({
  file, sourceHash: 'native-child', outerFileHash: 'packed-source', tableName: 'Shared',
  entryName: 'Shared.param', entryIndex: 3, typeName: document.typeName, definition: document, rows, ...options
});

test('repeated native field cells share immutable storage with exact visible and serialized values', async () => {
  const native = makeRows(Array(130).fill(0));
  const actual = await decode(native);
  for (const [index, row] of actual.entries()) {
    const expected = decodeRowFields(Buffer.from(native[index]!.dataBase64, 'base64'), definition).map((field) => ({
      fieldId: field.fieldId, name: field.name, type: field.type,
      ...(definition.fields.find((candidate) => candidate.id === field.fieldId)?.description
        ? { description: definition.fields.find((candidate) => candidate.id === field.fieldId)!.description } : {}),
      value: field.value
    }));
    assert.deepEqual(row.fields, expected);
    assert.equal(JSON.stringify(row.fields), JSON.stringify(expected));
    assert.equal(row.rowId, 100 + index);
    assert.deepEqual(row.raw, { typeName: definition.typeName, dataHash: `bytes-${index}`, rowIndex: index });
    assert.equal(row.sourceHash, 'native-child'); assert.equal(row.outerFileHash, 'packed-source');
  }
  assert.equal(new Set(actual.flatMap((row) => row.fields!)).size, 2,
    '130 identical two-cell rows must retain two cells, rather than260 full metadata/value objects');
  assert.notEqual(actual[0]!.fields, actual[1]!.fields, 'each physical row keeps its own field vector');
  assert.throws(() => { actual[0]!.fields![0]!.value = 99; }, TypeError);
  assert.throws(() => { actual[0]!.fields![0]!.description = 'changed'; }, TypeError);
  actual[0]!.fields![0] = { ...actual[0]!.fields![0]!, value: 99 };
  assert.equal(actual[1]!.fields![0]!.value, 0, 'replacing one row cell must not affect another row');
});

test('projection sharing preserves negative zero, NaN and ordinary float distinctions', async () => {
  const actual = await decode(makeRows([0, -0, NaN, NaN, 1, Infinity, -Infinity]));
  const values = actual.map((row) => row.fields![1]!.value);
  assert.equal(Object.is(values[0], 0), true); assert.equal(Object.is(values[1], -0), true);
  assert.equal(Number.isNaN(values[2]), true); assert.equal(Number.isNaN(values[3]), true);
  assert.deepEqual(values.slice(4), [1, Infinity, -Infinity]);
  assert.notEqual(actual[0]!.fields![1], actual[1]!.fields![1]);
  assert.equal(actual[2]!.fields![1], actual[3]!.fields![1]);
});

test('field storage is local to one read and cannot carry another definition metadata', async () => {
  const old = await decode(makeRows([0, 0]));
  const changed = await decode(makeRows([0, 0]), { ...definition,
    fields: [{ ...definition.fields[0]!, name: 'New label', description: 'New metadata' }, definition.fields[1]!] });
  assert.notEqual(old[0]!.fields![0], changed[0]!.fields![0]);
  assert.equal(old[0]!.fields![0]!.name, 'Flag');
  assert.equal(changed[0]!.fields![0]!.name, 'New label');
  assert.equal(changed[0]!.fields![0]!.description, 'New metadata');
});

test('a table cache preserves exact per-page metadata and reference context without sharing mutable children', async () => {
  const cache: NativeParamFieldProjectionCache = new Map();
  const sourceDefinition = { ...definition, fields: [{ ...definition.fields[0]!, refs: 'TargetParam(flag=1)' }, definition.fields[1]!] };
  const first = await decode(makeRows([0]), sourceDefinition, { fieldProjectionCache: cache, referenceFieldsOnly: true });
  const second = await decode(makeRows([0]), sourceDefinition, { fieldProjectionCache: cache, referenceFieldsOnly: true });
  assert.equal(first[0]!.fields![0], second[0]!.fields![0], 'page transitions share only an equal cell');
  const shared = first[0]!.fields![0]!;
  assert.equal(shared.refsProvenance, 'trusted-metadata');
  assert.throws(() => { shared.refs!.push({ paramName: 'WrongTarget' } as never); }, TypeError);
  assert.throws(() => { shared.refs![0]!.condition!.value = 99; }, TypeError);
  const changedDefinition = { ...definition, fields: [{ ...sourceDefinition.fields[0]!,
    name: 'New label', description: 'Different description', refs: 'OtherParam(flag=2)' }, definition.fields[1]!] };
  const changed = await decode(makeRows([0]), changedDefinition, { fieldProjectionCache: cache, referenceFieldsOnly: true });
  assert.notEqual(shared, changed[0]!.fields![0]);
  assert.equal(changed[0]!.fields![0]!.name, 'New label');
  assert.equal(changed[0]!.fields![0]!.description, 'Different description');
  assert.notEqual(JSON.stringify(shared.refs), JSON.stringify(changed[0]!.fields![0]!.refs));
  const full = await decode(makeRows([0]), sourceDefinition, { fieldProjectionCache: cache });
  assert.equal(full[0]!.fields![0]!.refs, undefined, 'full-field mode keeps its existing reference metadata shape');
  assert.notEqual(shared, full[0]!.fields![0]);
});

test('high-cardinality fields and long native strings cannot grow the projection cache without bound', async () => {
  const cache: NativeParamFieldProjectionCache = new Map();
  const actual = await decode(makeRows(Array.from({ length: 160 }, (_, index) => index)), definition, { fieldProjectionCache: cache });
  assert.equal(cache.get('rate')!.values.size, 64);
  assert.deepEqual(actual.map((row) => row.fields![1]!.value), Array.from({ length: 160 }, (_, index) => index));
  const bytesDefinition: ParamDefDocument = { ...definition, rowDataSize: 512,
    fields: [{ id: 'text', name: 'Complete text', type: 'fix', offset: 0, size: 512 }] };
  const bytesRows = [0, 1].map((rowIndex) => ({ id: rowIndex, rowIndex, dataHash: `bytes-${rowIndex}`, dataBase64: Buffer.alloc(512, 0x78).toString('base64') }));
  const strings = await decode(bytesRows, bytesDefinition, { fieldProjectionCache: cache });
  assert.equal(cache.get('text')!.values.size, 0);
  assert.equal(strings[0]!.fields![0]!.value, 'x'.repeat(512));
  assert.notEqual(strings[0]!.fields![0], strings[1]!.fields![0]);
});
