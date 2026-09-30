import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
const module = await import('../scene-independent-baselines.mjs').catch(() => ({}));
const sha = 'a'.repeat(64);
const oracle = { provider: 'hand-derived-synthetic', revision: 'v1', license: 'CC0', independentOfSoulForge: true, sourceSha256: sha, expectedByLayer: { bridge: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], boneWeights: [1, 0, 0, 0], boneMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 3, 4, 1] }, core: { vertexCount: 3, bounds: { min: [0, 0, 0], max: [1, 1, 0] } }, renderer: { vertexCount: 3, bounds: { min: [0, 0, 0], max: [1, 1, 0] } } } };
test('field oracle identifies the first wrong layer without self-generated expected values', () => {
  assert.equal(typeof module.compareDecodedSceneLayers, 'function');
  const actual = { sourceSha256: sha, layers: structuredClone(oracle.expectedByLayer) };
  assert.equal(module.compareDecodedSceneLayers(oracle, actual).status, 'passed');
  actual.layers.bridge.boneWeights[0] = 0.5;
  const failed = module.compareDecodedSceneLayers(oracle, actual);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.firstDivergentLayer, 'bridge');
  assert.equal(failed.layers[0].differences[0].path, 'boneWeights[0]');
  assert.equal(failed.layers[1].status, 'passed');
});
test('missing oracle layers and mismatched corpus hashes never report success', () => {
  assert.equal(typeof module.compareDecodedSceneLayers, 'function');
  assert.equal(module.compareDecodedSceneLayers(oracle, { sourceSha256: sha, layers: { bridge: oracle.expectedByLayer.bridge } }).status, 'unverified');
  assert.equal(module.compareDecodedSceneLayers({ ...oracle, independentOfSoulForge: false }, { sourceSha256: sha, layers: oracle.expectedByLayer }).status, 'unverified');
  assert.equal(module.compareDecodedSceneLayers(oracle, { sourceSha256: 'b'.repeat(64), layers: oracle.expectedByLayer }).status, 'failed');
});
test('pixel baseline rejects a dropped texture layer and refuses unconfirmed private screenshots', async () => {
  assert.equal(typeof module.compareConfirmedSceneImage, 'function');
  const reference = await sharp(Buffer.from([80, 100, 120, 255, 90, 110, 130, 255]), { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
  const wrong = await sharp(Buffer.from([255, 255, 255, 255, 255, 255, 255, 255]), { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
  const record = { assetId: 'synthetic-two-layer', assetSha256: sha, backend: 'webgl2', renderConfigSha256: sha, referencePngSha256: createHash('sha256').update(reference).digest('hex'), confirmation: { status: 'confirmed', confirmedBy: 'synthetic-hand-derived', referenceSource: 'known-two-pixel-input', confirmedAt: '2026-09-30T00:00:00Z' }, tolerance: { maxChannelDelta: 2, maxChangedPixelFraction: 0 } };
  const actual = { assetSha256: sha, backend: 'webgl2', renderConfigSha256: sha };
  assert.equal((await module.compareConfirmedSceneImage(record, reference, reference, actual)).status, 'passed');
  assert.equal((await module.compareConfirmedSceneImage(record, reference, wrong, actual)).status, 'failed');
  assert.equal((await module.compareConfirmedSceneImage({ ...record, confirmation: { status: 'unconfirmed' } }, reference, reference, actual)).status, 'unverified');
  assert.equal((await module.compareConfirmedSceneImage(record, reference, reference, { ...actual, backend: 'webgpu' })).status, 'failed');
});
