import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertTaeInternalProducer, compareTaeInternalResource, compareTaeInternalFields } from '../compare-tae-internal-fields.mjs';
import { oracleSourcePrerequisites, missingFile, verificationSkipReason } from '../verification-inputs.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
test('TAE reflection assembly must match the complete assembly uniquely embedded in the pinned published producer', () => {
  const assembly = Buffer.from('complete-current-native-assembly'), producer = Buffer.concat([Buffer.from('apphost'), assembly, Buffer.from('bundle-manifest')]);
  const pin = hash(producer), receipt = { executable: { sha256: pin } };
  const result = assertTaeInternalProducer(pin, receipt, producer, assembly);
  assert.equal(result.embeddedOffset, 7);
  assert.equal(result.assemblySha256, hash(assembly));
  assert.throws(() => assertTaeInternalProducer(undefined, receipt, producer, assembly), /EXPECTED_PRODUCER_SHA_REQUIRED/);
  assert.throws(() => assertTaeInternalProducer('0'.repeat(64), receipt, producer, assembly), /PRODUCER_PIN_MISMATCH/);
  assert.throws(() => assertTaeInternalProducer(pin, receipt, Buffer.from('other producer'), assembly), /PRODUCER_PIN_MISMATCH/);
  assert.throws(() => assertTaeInternalProducer(pin, receipt, producer, Buffer.from('stale assembly')), /ASSEMBLY_NOT_UNIQUELY_EMBEDDED/);
  const repeated = Buffer.concat([assembly, assembly]), repeatedPin = hash(repeated);
  assert.throws(() => assertTaeInternalProducer(repeatedPin, { executable: { sha256: repeatedPin } }, repeated, assembly), /ASSEMBLY_NOT_UNIQUELY_EMBEDDED/);
});

function fixture(type = 'Standard') {
  const miniHeader = type === 'Standard'
    ? { type, isNullHeader: false, IsLoopByDefault: false, ImportsHKX: false, AllowDelayLoad: true, ImportHKXSourceAnimID: 0 }
    : { type, isNullHeader: false, ImportFromAnimID: 567, Unknown: 8 };
  const expected = { id: 'fixture', leafSha256: 'a'.repeat(64), leafByteLength: 96, eventBank: 14, animations: [{ animId: 123, animFileName: '', miniHeader, groups: [{ ordinal: 0, groupType: 67, eventIndices: [0, 1] }], events: [{ groupOrdinal: 0 }, { groupOrdinal: 0 }] }] };
  const observed = { id: 'fixture', sourceHash: expected.leafSha256, sourceByteLength: 96, eventBank: 14, animationCount: 1, totalEventCount: 2, totalGroupCount: 1, animations: [{ ordinal: 0, animId: 123, hkxName: null, eventCount: 2, groupCount: 1, motionReference: { animationId: 123, kind: type === 'Standard' ? 'OwnHkx' : 'ImportOtherAnimation', sourceAnimationId: type === 'Standard' ? null : 567, hkxAnimationId: null }, groups: [{ ordinal: 0, groupType: 67, groupEventCount: 2, eventOffsets: [100, 124], eventIndices: [1, 0], groupTypeUnknown: 0 }], eventGroupOrdinals: [0, 0], supplementalNativeLayout: { miniHeader: structuredClone(miniHeader) } }] };
  return { expected, observed };
}
test('TAE comparator compares decoded memberships in oracle event order without claiming discarded miniheaders as decoded', () => {
  for (const type of ['Standard', 'ImportOtherAnim']) {
    const { expected, observed } = fixture(type), result = compareTaeInternalResource(expected, observed);
    assert.equal(result.status, 'passed');
    assert.equal(result.comparedFields['supplemental-raw-layout'], 1);
    assert.equal(result.comparedFields['decoded-native'], 20);
  }
});
test('TAE comparator localizes type, membership, ordinal and motion changes at decoded-native', () => {
  for (const mutate of [a => a.groups[0].groupType++, a => a.groups[0].eventIndices = [0], a => a.eventGroupOrdinals[0] = null, a => a.motionReference.animationId++, a => a.animId++]) {
    const { expected, observed } = fixture(); mutate(observed.animations[0]);
    const result = compareTaeInternalResource(expected, observed);
    assert.equal(result.status, 'failed');
    assert.equal(result.firstMismatch.layer, 'decoded-native');
  }
});
test('TAE comparator localizes Standard flags and ImportOther unknown to supplemental raw coverage', () => {
  for (const [type, field, value] of [['Standard', 'AllowDelayLoad', false], ['Standard', 'ImportsHKX', true], ['Standard', 'IsLoopByDefault', true], ['ImportOtherAnim', 'Unknown', 9], ['ImportOtherAnim', 'ImportFromAnimID', 568]]) {
    const { expected, observed } = fixture(type); observed.animations[0].supplementalNativeLayout.miniHeader[field] = value;
    const result = compareTaeInternalResource(expected, observed);
    assert.equal(result.status, 'failed');
    assert.equal(result.firstMismatch.layer, 'supplemental-raw-layout');
  }
});
test('TAE comparator preserves a synthetic null membership without claiming it occurs in the independent sample', () => {
  const { expected, observed } = fixture();
  expected.animations[0].groups[0].eventIndices = [0];
  expected.animations[0].events[1].groupOrdinal = null;
  observed.animations[0].groups[0].groupEventCount = 1;
  observed.animations[0].groups[0].eventIndices = [0];
  observed.animations[0].groups[0].eventOffsets = [100];
  observed.animations[0].eventGroupOrdinals[1] = null;
  assert.equal(compareTaeInternalResource(expected, observed).status, 'passed');
  observed.animations[0].eventGroupOrdinals[1] = 0;
  assert.equal(compareTaeInternalResource(expected, observed).firstMismatch.layer, 'decoded-native');
});
const internalOracleReason = verificationSkipReason([
  ...oracleSourcePrerequisites(process.env.SOULFORGE_TAE_INTERNAL_ORACLE_PATH,'SOULFORGE_TAE_INTERNAL_ORACLE_PATH',
    oracle=>oracle.originalSource,oracle=>{
      assert.equal(oracle.schema,'soulforge.external-tae-fields.v1'); assert.equal(oracle.ok,true);
      assert.equal(oracle.provider?.independentOfSoulForge,true);
      assert.equal(oracle.provider?.revision,'ee1dd61958f60bdc51ce3da548e9a90a8ab39905');
      assert.deepEqual(oracle.resources?.map(resource=>resource.id),['a232','a250']);
    }),
  missingFile(process.env.SOULFORGE_TAE_PIN_CONTROL_PRODUCT ? join(process.env.SOULFORGE_TAE_PIN_CONTROL_PRODUCT,
    'bridge/SoulForge.Bridge/bin/Release/net10.0/linux-x64/publish/bridge-production-build.json') : undefined,
    {kind:'published-control',sourceEnv:'SOULFORGE_TAE_PIN_CONTROL_PRODUCT',logicalResource:'published Linux Bridge receipt'})
]);
test('TAE reflection refuses a receipt with omitted compile inputs before creating or building the probe', {
  skip: internalOracleReason ?? false
}, async () => {
  const productRoot = process.env.SOULFORGE_TAE_PIN_CONTROL_PRODUCT;
  const receipt = JSON.parse(await readFile(join(productRoot, 'bridge/SoulForge.Bridge/bin/Release/net10.0/linux-x64/publish/bridge-production-build.json'), 'utf8'));
  const entry = receipt.source.entries.find(item => item.path === 'global.json');
  const bytes = await readFile(join(productRoot, entry.path));
  const digest = createHash('sha256');
  digest.update(entry.path); digest.update('\0'); digest.update(String(bytes.length)); digest.update('\0'); digest.update(bytes); digest.update('\0');
  receipt.source.entries = [entry]; receipt.source.fileCount = 1; receipt.source.totalBytes = bytes.length; receipt.source.sha256 = digest.digest('hex');
  const scratch = await mkdtemp(join(tmpdir(), 'sf-tae-internal-omitted-receipt-'));
  try {
    const receiptPath = join(scratch, 'trimmed-receipt.json');
    await writeFile(receiptPath, JSON.stringify(receipt));
    await assert.rejects(compareTaeInternalFields({
      oraclePath: process.env.SOULFORGE_TAE_INTERNAL_ORACLE_PATH, productRoot,
      assemblyPath: join(productRoot, 'bridge/SoulForge.Bridge/bin/Release/net10.0/linux-x64/SoulForge.Bridge.dll'),
      receiptPath, expectedProducerSha256: receipt.executable.sha256,
      dotnetPath: join(scratch, 'must-not-execute'), outputRoot: join(scratch, 'must-not-create')
    }), /TAE_INTERNAL_RECEIPT_CHANGED/);
    await assert.rejects(readFile(join(scratch, 'must-not-create/probe-source/Program.cs')), { code: 'ENOENT' });
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
