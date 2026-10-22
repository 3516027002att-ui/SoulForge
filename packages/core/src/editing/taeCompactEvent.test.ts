import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactTaeEvent } from './taeCompactEvent.js';

const timing = { eventTypeId: 1, typeName: 'InvokeAttackBehavior', startTime: 0.1, endTime: 0.4, startFrame: 3, endFrame: 12 };

test('a decoded read snapshot keeps identity, timing and values but not layout, quiet padding or raw bytes', () => {
  const compact = compactTaeEvent({
    ...timing, eventIndex: 4, address: 'action://c0000/tae/1/A0300/e4', decodeStatus: 'decoded', parameterBytesHex: '00'.repeat(16),
    fields: [
      { name: 'Behavior Judge ID', value: 150, index: 0, displayValue: '150' },
      { name: 'Source', value: 1, index: 1, displayValue: 'RightWeapon' },
      { name: 'Unk08', value: 0, index: 2, isPadding: true, assert: 0, assertValid: true },
      { name: 'Unk0C', value: 0, index: 3, isPadding: true }
    ]
  });
  assert.deepEqual(compact, {
    index: 4, address: 'action://c0000/tae/1/A0300/e4', ...timing,
    fields: [{ name: 'Behavior Judge ID', value: 150 }, { name: 'Source', value: 1, display: 'RightWeapon' }]
  });
});

test('padding that does not hold its asserted value stays visible and is marked unwritable', () => {
  const compact = compactTaeEvent({ ...timing, index: 0, decodeStatus: 'decoded', fields: [
    { name: 'Pad', value: 7, isPadding: true, assert: 0 },
    { name: 'Checked', value: 0, isPadding: true, assert: 0, assertValid: false }
  ] });
  assert.deepEqual(compact.fields, [{ name: 'Pad', value: 7, padding: true }, { name: 'Checked', value: 0, padding: true }]);
});

test('display is kept for enum labels, not for another spelling of the same value', () => {
  const compact = compactTaeEvent({ ...timing, index: 0, decodeStatus: 'decoded', fields: [
    { name: 'Flag', value: false, displayValue: 'False' },
    { name: 'Tiny', value: 2.8e-44, displayValue: '2.8E-44' },
    { name: 'Mode', value: 0, displayValue: 'Unconditional' },
    { name: 'Input', value: 87, displayValue: 'Common Key Input' },
    { name: 'Blank', value: 0, displayValue: ' ' }
  ] });
  assert.deepEqual(compact.fields, [{ name: 'Flag', value: false }, { name: 'Tiny', value: 2.8e-44 },
    { name: 'Mode', value: 0, display: 'Unconditional' }, { name: 'Input', value: 87, display: 'Common Key Input' },
    { name: 'Blank', value: 0, display: ' ' }]);
});

test('a repeated field name carries its schema index so a mutation can address it', () => {
  const compact = compactTaeEvent({ ...timing, index: 0, decodeStatus: 'decoded', fields: [
    { name: 'Value', value: 1, index: 0 }, { name: 'Value', value: 2, index: 1 }, { name: 'Other', value: 3, index: 2 }
  ] });
  assert.deepEqual(compact.fields, [{ name: 'Value', value: 1, index: 0 }, { name: 'Value', value: 2, index: 1 }, { name: 'Other', value: 3 }]);
});

test('an indexed symbol without decode status is judged by its fields; undecoded bodies keep bounded hex', () => {
  const uri = 'action://c0000/tae/1/A0300/e2';
  const decoded = compactTaeEvent({ ...timing, index: 2, uri, parameterBytesHex: 'ab'.repeat(8), fields: [{ name: 'A', value: 1 }] });
  assert.equal(decoded.address, uri);
  assert.equal(decoded.parameterBytesHex, undefined);
  const bare = compactTaeEvent({ ...timing, index: 2, uri, parameterBytesHex: 'ab'.repeat(8) });
  assert.equal(bare.parameterBytesHex, 'ab'.repeat(8));
  assert.equal(bare.parameterBytesHexTruncated, undefined);
  const long = compactTaeEvent({ ...timing, index: 2, uri, decodeStatus: 'unknown', parameterBytesHex: 'cd'.repeat(300) });
  assert.equal(long.decodeStatus, 'unknown');
  assert.equal(long.parameterBytesHex, 'cd'.repeat(128));
  assert.equal(long.parameterBytesHexTruncated, true);
  assert.equal(long.parameterByteLength, 300);
  const partial = compactTaeEvent({ ...timing, index: 2, decodeStatus: 'partial', parameterBytesHex: 'ef', fields: [{ name: 'A', value: 1 }] });
  assert.equal(partial.decodeStatus, 'partial');
  assert.equal(partial.parameterBytesHex, 'ef', 'partly decoded fields do not stand for the whole body');
});

test('an event without an index is rejected instead of being placed on a page', () => {
  assert.throws(() => compactTaeEvent({ ...timing }), (error: { code?: string }) => error.code === 'TAE_EVENT_INDEX_MISSING');
});
