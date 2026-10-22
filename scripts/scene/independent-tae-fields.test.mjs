import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { assertTaeCaptureProducer } from '../capture-tae-bridge-observations.mjs';
import { compareTaeLayers, taeObservationProducerPin } from '../compare-tae-projection-fields.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
test('TAE producer pin accepts a receipt-bound current hash and rejects a wrong explicit expected hash', () => {
  const currentBytes = Buffer.from('freshly built TAE native producer');
  const currentHash = sha(currentBytes);
  const receipt = { executable: { sha256: currentHash } };
  assert.doesNotThrow(() => assertTaeCaptureProducer(currentHash, receipt, currentBytes));
  assert.throws(() => assertTaeCaptureProducer('0'.repeat(64), receipt, currentBytes), /TAE_CAPTURE_EXPECTED_PRODUCER_MISMATCH/);
  assert.throws(() => assertTaeCaptureProducer(currentHash, receipt, Buffer.from('changed producer')), /TAE_CAPTURE_PRODUCER_RECEIPT_MISMATCH/);
  assert.throws(() => assertTaeCaptureProducer(undefined, receipt, currentBytes), /TAE_CAPTURE_EXPECTED_PRODUCER_SHA_REQUIRED/);
});
test('TAE producer pin accepts the current receipt-verified published producer without executing it', { skip: !process.env.SOULFORGE_TAE_PIN_CONTROL_PRODUCT }, async () => {
  const path = process.env.SOULFORGE_TAE_PIN_CONTROL_PRODUCT;
  const root = `${path}/bridge/SoulForge.Bridge/bin/Release/net10.0/linux-x64/publish`;
  const receipt = JSON.parse(await readFile(`${root}/bridge-production-build.json`, 'utf8'));
  const bytes = await readFile(`${root}/SoulForge.Bridge`);
  assertTaeCaptureProducer(receipt.executable.sha256, receipt, bytes);
  assert.throws(() => assertTaeCaptureProducer('0'.repeat(64), receipt, bytes), /TAE_CAPTURE_EXPECTED_PRODUCER_MISMATCH/);
});
test('TAE comparison enforces explicit producer pins for new manifests while identifying historical receipts', () => {
  const producerSha256 = sha(Buffer.from('current producer'));
  const current = { schemaVersion: 2, producerSha256, expectedProducerSha256: producerSha256 };
  assert.deepEqual(taeObservationProducerPin(current), { mode: 'explicit-sha', expectedProducerSha256: producerSha256 });
  assert.throws(() => taeObservationProducerPin({ ...current, expectedProducerSha256: '0'.repeat(64) }), /TAE_MANIFEST_PRODUCER_PIN_MISMATCH/);
  assert.throws(() => taeObservationProducerPin({ schemaVersion: 2, producerSha256 }), /TAE_MANIFEST_PRODUCER_PIN_MISMATCH/);
  assert.deepEqual(taeObservationProducerPin({ schemaVersion: 1, producerSha256 }), { mode: 'historical-build-receipt-only', expectedProducerSha256: null });
  assert.throws(() => taeObservationProducerPin({ ...current, schemaVersion: 1, expectedProducerSha256: '0'.repeat(64) }), /TAE_MANIFEST_PRODUCER_PIN_MISMATCH/);
});
function fixture() {
  const raw = Buffer.from([1, 2, 3, 4]);
  const expected = { id: 'fixture', leafSha256: 'a'.repeat(64), eventBank: 14, animations: [{ animId: 100, animFileName: 'a000_000100.hkt', miniHeader: { type: 'Standard' }, groups: [{ groupType: 7, eventIndices: [0] }], events: [{ ordinal: 0, eventTypeId: 5, startTime: 0.1, endTime: 0.2, parameterLength: 4, parameterSha256: sha(raw) }] }] };
  const bridge = { sourceHash: expected.leafSha256, eventBank: 14, animationCount: 1, totalEventCount: 1, totalGroupCount: 1, eventTypes: [5, 7], animationsTruncated: false, animations: [{ animId: 100, hkxName: 'a000_000100.hkt', motionAnimId: 100, eventCount: 1, groupCount: 1, eventsTruncated: false, events: [{ eventTypeId: 5, startTime: 0.1, endTime: 0.2, parameterLength: 4, parameterBytesHex: raw.toString('hex'), templateFields: [{ name: 'id', value: 1 }] }] }] };
  const core = { animations: [{ animId: 100, hkxName: 'a000_000100.hkt', motionAnimId: 100, eventCount: 1, eventsComplete: true, events: [{ index: 0, eventTypeId: 5, startTime: 0.1, endTime: 0.2, parameterBytesHex: raw.toString('hex'), fields: [{ name: 'id', value: 1 }] }] }] };
  return { expected, bridge, core };
}
test('TAE comparator preserves order and localizes wrong event, time and parameter at Bridge', () => {
  let f = fixture();
  assert.equal(compareTaeLayers(f.expected, f.bridge, f.core).status, 'passed');
  for (const [field, value] of [['eventTypeId', 6], ['startTime', 0.3], ['parameterBytesHex', '01020305']]) {
    f = fixture(); f.bridge.animations[0].events[0][field] = value;
    const report = compareTaeLayers(f.expected, f.bridge, f.core);
    assert.equal(report.status, 'failed'); assert.equal(report.firstDivergentLayer, 'bridge');
    assert.match(report.firstMismatch.path, /animations\[0\]\.events\[0\]/);
  }
  f = fixture(); f.core.animations[0].events[0].eventTypeId = 6;
  assert.equal(compareTaeLayers(f.expected, f.bridge, f.core).firstDivergentLayer, 'core');
  f = fixture(); f.bridge.animations[0].eventsTruncated = true;
  assert.equal(compareTaeLayers(f.expected, f.bridge, f.core).firstDivergentLayer, 'bridge');
  f = fixture(); f.bridge.animations[0].animId = 101;
  assert.equal(compareTaeLayers(f.expected, f.bridge, f.core).firstDivergentLayer, 'bridge');
});
