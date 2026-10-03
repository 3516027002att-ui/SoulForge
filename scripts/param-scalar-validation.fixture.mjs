// Actual Core scalar codec with owned row bytes; no native or resource writes.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const load = require('./typescript-test-loader.cjs')();
const { applyParamFieldMutation } = load(fileURLToPath(new URL('../packages/core/src/param/paramFieldMutation.ts', import.meta.url)));
const { FIRST_PARTY_PARAM_METADATA_PACKAGE } = load(fileURLToPath(new URL('../packages/core/src/schema/sekiro/firstPartySchemaData.ts', import.meta.url)));
const actionGuide = FIRST_PARTY_PARAM_METADATA_PACKAGE.definitions.find(item => item.key.typeName === 'ACTION_GUIDE_PARAM_ST').document;
const field = actionGuide.fields.find(item => item.id === 'priority');
assert.equal(field.type, 's8');
assert.equal(field.offset, 4);

function mutate(definition, fieldId, value) {
  const bytes = Buffer.alloc(definition.rowDataSize, 0x5a);
  const before = Buffer.from(bytes);
  const result = applyParamFieldMutation({ definition, fieldId, value, rowDataBase64: bytes.toString('base64') });
  assert.deepEqual(bytes, before, 'The source row must remain unchanged');
  return { before, result, next: result.ok ? Buffer.from(result.nextDataBase64, 'base64') : null };
}
function rejects(definition, fieldId, value) {
  const { result } = mutate(definition, fieldId, value);
  assert.equal(result.ok, false, `Invalid scalar ${String(value)} must not become a valid byte value`);
  assert.equal(result.code, 'PARAMDEF_ENCODE_FAILED');
  assert.equal(typeof result.message, 'string');
  assert.ok(result.message.length > 0);
  assert.equal(Object.hasOwn(result, 'nextDataBase64'), false);
}

test('first-party Priority rejects invalid and blank text instead of writing zero', () => {
  for (const value of ['not-a-number', '', ' \t\n', 'false']) rejects(actionGuide, 'priority', value);
});

const integerTypes = [
  ['u8', 1, 0, 255, 'readUInt8'], ['s8', 1, -128, 127, 'readInt8'],
  ['u16', 2, 0, 65535, 'readUInt16LE'], ['s16', 2, -32768, 32767, 'readInt16LE'],
  ['u32', 4, 0, 4294967295, 'readUInt32LE'], ['s32', 4, -2147483648, 2147483647, 'readInt32LE']
];
function definition(type, size, bitfield) {
  return { schemaVersion: 1, typeName: 'OWNED_SCALAR', version: 1, rowDataSize: size + 4, origin: 'fixture',
    fields: [{ id: 'value', name: 'Value', type, offset: 2, size, ...(bitfield ? { bitfield } : {}) }] };
}
for (const [type, size, min, max, read] of integerTypes) {
  test(`${type} keeps valid numeric strings, boundaries and untouched sibling bytes`, () => {
    const def = definition(type, size);
    for (const value of [min, max, String(min), String(max), ' 7 ', '7.0', '0x7', '7e0', false]) {
      const { before, result, next } = mutate(def, 'value', value);
      assert.equal(result.ok, true);
      assert.equal(next[read](2), Number(value));
      assert.deepEqual(next.subarray(0, 2), before.subarray(0, 2));
      assert.deepEqual(next.subarray(2 + size), before.subarray(2 + size));
    }
  });
  test(`${type} rejects fractions, unsafe integers, nonfinite values and physical overflow`, () => {
    const def = definition(type, size);
    for (const value of [1.5, '1.5', Number.MAX_SAFE_INTEGER + 1, '9007199254740993', NaN, Infinity, -Infinity, 'NaN', 'Infinity', min - 1, max + 1]) {
      rejects(def, 'value', value);
    }
  });
}
for (const [type, size, read] of [['f32', 4, 'readFloatLE'], ['f64', 8, 'readDoubleLE']]) {
  test(`${type} rejects unrelated invalid or blank text while preserving IEEE number values`, () => {
    const def = definition(type, size);
    for (const value of ['not-a-number', '', ' \t', 'false']) rejects(def, 'value', value);
    for (const value of [1.25, ' 1.25 ', -0, '-0', NaN, 'NaN', Infinity, 'Infinity', -Infinity, '-Infinity']) {
      const { before, result, next } = mutate(def, 'value', value);
      assert.equal(result.ok, true);
      assert.ok(Object.is(next[read](2), Number(value)));
      assert.deepEqual(next.subarray(0, 2), before.subarray(0, 2));
      assert.deepEqual(next.subarray(2 + size), before.subarray(2 + size));
    }
  });
}

test('bool, fixed text, bytes and bitfields retain their separate established semantics', () => {
  const boolean = mutate(definition('bool', 1), 'value', false);
  assert.equal(boolean.result.ok, true); assert.equal(boolean.next.readUInt8(2), 0);
  const text = mutate(definition('fix', 4), 'value', 'a');
  assert.equal(text.result.ok, true); assert.equal(text.next.subarray(2, 6).toString('hex'), '61000000');
  const bytes = mutate(definition('bytes', 2), 'value', 'cafe');
  assert.equal(bytes.result.ok, true); assert.equal(bytes.next.subarray(2, 4).toString('hex'), 'cafe');
  const bit = mutate(definition('u8', 1, { bitOffset: 1, bitWidth: 2 }), 'value', '3');
  assert.equal(bit.result.ok, true); assert.equal(bit.next.readUInt8(2), 0x5e);
  for (const value of [1.5, 'not-a-number', 4]) rejects(definition('u8', 1, { bitOffset: 1, bitWidth: 2 }), 'value', value);
});
