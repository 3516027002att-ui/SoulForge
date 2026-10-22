import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { expectedFlverMetadata, compareFlverMetadata, metadataNegativeControls } from './compare-flver-metadata-fields.mjs';

const payloadHash = createHash('sha256').update(Buffer.from([1, 2, 3, 4])).digest('hex');
function fixture() {
  const bytes = Buffer.alloc(272);
  bytes.write('FLVER\0L\0', 0, 'ascii'); bytes[0x49] = 1;
  bytes.writeInt32LE(2, 0x18); bytes.writeInt32LE(2, 0x58);
  for (const [index, firstTexture, nativeIndex, storedBytes] of [[0, 1, 19, 42], [1, 0, 4, 64]]) {
    const at = 128 + index * 32;
    bytes.writeInt32LE(1, at + 8); bytes.writeInt32LE(firstTexture, at + 12);
    bytes.writeInt32LE(storedBytes, at + 16); bytes.writeInt32LE(224, at + 20); bytes.writeInt32LE(nativeIndex, at + 24);
  }
  bytes.write('GX00', 224, 'ascii'); bytes.writeInt32LE(100, 228); bytes.writeInt32LE(16, 232);
  Buffer.from([1, 2, 3, 4]).copy(bytes, 236);
  bytes.writeInt32LE(2147483647, 240); bytes.writeInt32LE(100, 244); bytes.writeInt32LE(16, 248);
  const fields = {
    Materials: [
      { Name: 'a', MTD: 'a.mtd', Index: 19, GXIndex: 0, Textures: [{ ParamName: 'mapA', Path: 'a.tif', TilingScale: [1, 2], TilingTypeU: 'Repeat', TilingTypeV: 'Clamp', Unk14: 0.5, Unk18: 0.25, Unk1C: 0.125 }] },
      { Name: 'b', MTD: 'b.mtd', Index: 4, GXIndex: 0, Textures: [{ ParamName: 'mapB', Path: 'b.tif', TilingScale: [3, 4], TilingTypeU: 'MirrorRepeat', TilingTypeV: 'Border', Unk14: 2, Unk18: 3, Unk1C: 4 }] }
    ],
    GXLists: [[{ ID: 'GX00', Unk04: 100, Data: { byteLength: 4, sha256: payloadHash } }]]
  };
  const gx = { itemCount: 1, byteLength: 32, terminatorId: 2147483647, terminatorLength: 4, terminatorPaddingAllZero: true, items: [{ id: 'GX00', unk04: 100, itemLength: 16, dataLength: 4, dataSha256: payloadHash }] };
  // Literal Bridge wire fixture: native material identities differ from ordinals,
  // both materials share one GXIndex, and texture ranges are out of material order.
  const actual = {
    materialCount: 2,
    materials: [
      { index: 0, name: 'a', mtdPath: 'a.mtd', textureCount: 1, firstTextureIndex: 1, stringByteCount: 42, nativeIndex: 19, flags: 42, unk18: 19, gxOffset: 224, gxIndex: 0, gxList: structuredClone(gx) },
      { index: 1, name: 'b', mtdPath: 'b.mtd', textureCount: 1, firstTextureIndex: 0, stringByteCount: 64, nativeIndex: 4, flags: 64, unk18: 4, gxOffset: 224, gxIndex: 0, gxList: structuredClone(gx) }
    ],
    textureCount: 2,
    textures: [
      { index: 0, materialIndex: 1, type: 'mapB', path: 'b.tif', tilingScale: [3, 4], tilingTypeU: 2, tilingTypeV: 4, unk14: 2, unk18: 3, unk1C: 4 },
      { index: 1, materialIndex: 0, type: 'mapA', path: 'a.tif', tilingScale: [1, 2], tilingTypeU: 1, tilingTypeV: 3, unk14: 0.5, unk18: 0.25, unk1C: 0.125 }
    ]
  };
  const document = { materialCount: 2, materials: structuredClone(actual.materials), materialsTruncated: false, textureCount: 2, textureSlots: structuredClone(actual.textures), texturesTruncated: false };
  return { bytes, fields, expected: expectedFlverMetadata(fields, bytes), actual, document };
}

test('compares full material/texture fields with shared GXIndex and native texture ranges', () => {
  const { expected, actual, document } = fixture();
  const result = compareFlverMetadata(expected, actual, document);
  assert.equal(result.status, 'passed');
  assert.equal(result.firstDivergentLayer, null);
  assert.equal(result.layers.core.status, 'unverified');
  assert.equal(result.layers.renderer.status, 'unverified');
  assert.equal(expected.materials[1].gxIndex, 0);
  assert.equal(expected.materials[0].nativeIndex, 19);
  assert.equal(expected.materials[0].stringByteCount, 42);
  assert.equal(expected.textures[0].materialIndex, 1);
});

test('missing full material metadata fails at Bridge while complete texture references pass', () => {
  const { expected, actual, document } = fixture();
  delete actual.materials;
  const result = compareFlverMetadata(expected, actual, document);
  assert.equal(result.status, 'failed');
  assert.equal(result.firstDivergentLayer, 'bridge');
  assert.equal(result.layers.bridge.coverage.checks.textureArrayLength.status, 'passed');
  assert.equal(result.layers.bridge.coverage.checks.materialArrayLength.status, 'failed');
});

test('all ten wrong material, tiling, unknown, and opaque GX negatives fail at Bridge', () => {
  const { expected, actual, document } = fixture();
  const negatives = metadataNegativeControls(expected, actual, document);
  assert.equal(negatives.length, 10);
  for (const result of negatives) {
    assert.equal(result.detected, true, result.kind);
    assert.equal(result.firstDivergentLayer, 'bridge', result.kind);
    assert.ok(result.changedChecks.length || result.coverageStatus === 'failed', result.kind);
  }
  assert.ok(negatives.find((value) => value.kind === 'wrong-gx-payload').changedChecks.some((value) => value.check === 'gx.items[0].dataSha256'));
  assert.ok(negatives.find((value) => value.kind === 'wrong-tiling-scale').changedChecks.some((value) => value.check === 'tilingScale'));
});

test('wrong oracle GXIndex association is rejected instead of assumed equal to material ordinal', () => {
  const { fields, bytes } = fixture(); fields.Materials[1].GXIndex = 1;
  assert.throws(() => expectedFlverMetadata(fields, bytes), /ORACLE_GX_REFERENCE_DIVERGENCE/);
});

test('overlapping oracle texture ranges are rejected', () => {
  const { fields, bytes } = fixture(); bytes.writeInt32LE(1, 128 + 32 + 12);
  assert.throws(() => expectedFlverMetadata(fields, bytes), /ORACLE_TEXTURE_RANGE_INVALID/);
});

test('legacy flag/native-index aliases must retain exact raw values', () => {
  const { expected, actual, document } = fixture(); actual.materials[0].flags = 0;
  const result = compareFlverMetadata(expected, actual, document);
  assert.equal(result.layers.bridge.materials[0].checks.flags.status, 'failed');
  assert.equal(result.layers.bridge.materials[0].checks.stringByteCount.status, 'passed');
});

test('sample truncation is explicit and preserves the same metadata fields as full command', () => {
  const { expected, actual, document } = fixture(); document.materials.pop();
  const result = compareFlverMetadata(expected, actual, document);
  assert.equal(result.status, 'failed');
  assert.equal(result.layers.bridge.documentSamples.checks.materialSampleLength.status, 'failed');
  assert.equal(result.layers.bridge.coverage.status, 'passed');
});

test('object key order does not create a false metadata mismatch', () => {
  const { expected, actual, document } = fixture();
  actual.materials = actual.materials.map((value) => Object.fromEntries(Object.entries(value).reverse()));
  document.textureSlots = document.textureSlots.map((value) => Object.fromEntries(Object.entries(value).reverse()));
  assert.equal(compareFlverMetadata(expected, actual, document).status, 'passed');
});

test('source-bound comparison refuses a wrong producer or stale material parser before reading observations', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { compareFlverMetadataFields } = await import('./compare-flver-metadata-fields.mjs');
  const root = await mkdtemp(join(tmpdir(), 'soulforge-metadata-receipt-'));
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  try {
    await mkdir(join(root, 'bridge/SoulForge.Bridge'), { recursive: true });
    const producer = join(root, 'producer.dll'), receipt = join(root, 'receipt.json');
    await writeFile(producer, 'fixture producer');
    const sourceFiles = [];
    for (const name of ['FlverNativeDocument.cs', 'BridgeCommandService.cs', 'SoulForge.Bridge.csproj']) {
      const path = `bridge/SoulForge.Bridge/${name}`, bytes = `fixture ${name}`;
      await writeFile(join(root, path), bytes);
      sourceFiles.push({ path, sha256: digest(bytes) });
    }
    const evidence = { product: { path: 'producer.dll', sha256: digest('fixture producer') }, sourceFiles };
    const compare = () => compareFlverMetadataFields(root, join(root, 'oracle'), join(root, 'observations'), producer, join(root, 'output'), receipt);
    await writeFile(receipt, JSON.stringify({ ...evidence, product: { ...evidence.product, sha256: '0'.repeat(64) } }));
    await assert.rejects(compare, /BRIDGE_SOURCE_BUILD_PRODUCER_MISMATCH/);
    await writeFile(receipt, JSON.stringify(evidence));
    await writeFile(join(root, sourceFiles[0].path), 'changed parser');
    await assert.rejects(compare, /BRIDGE_SOURCE_RECEIPT_MISMATCH:bridge\/SoulForge.Bridge\/FlverNativeDocument.cs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a published producer cannot claim complete build scope with only a listed-file receipt', async () => {
  const { mkdtemp, mkdir, writeFile, rm, access } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { compareFlverMetadataFields } = await import('./compare-flver-metadata-fields.mjs');
  const root = await mkdtemp(join(tmpdir(), 'soulforge-metadata-scope-'));
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  try {
    await mkdir(join(root, 'bridge/SoulForge.Bridge'), { recursive: true });
    const producer = join(root, 'producer'), receipt = join(root, 'receipt.json');
    await writeFile(producer, 'fixture published producer');
    const sourceFiles = [];
    for (const name of ['FlverNativeDocument.cs', 'BridgeCommandService.cs', 'SoulForge.Bridge.csproj']) {
      const path = `bridge/SoulForge.Bridge/${name}`, bytes = `fixture ${name}`;
      await writeFile(join(root, path), bytes);
      sourceFiles.push({ path, sha256: digest(bytes) });
    }
    await writeFile(receipt, JSON.stringify({ product: { path: 'producer', sha256: digest('fixture published producer') }, sourceFiles }));
    await assert.rejects(() => compareFlverMetadataFields(root, join(root, 'oracle'), join(root, 'observations'), producer, join(root, 'output'), receipt), /BRIDGE_PUBLISHED_BUILD_RECEIPT_REQUIRED/);
    await assert.rejects(() => access(join(root, 'output')), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
