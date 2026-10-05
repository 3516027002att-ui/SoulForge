import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
const SHA256 = /^[a-f0-9]{64}$/;
const LAYERS = ['bridge', 'core', 'renderer'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const unverified = (reason) => ({ status: 'unverified', reason });

/** Compare decoded native channels before colorspace, filtering or rendering. */
export function compareIndependentRgba8(reference, actual, maxChannelDelta = 0) {
  if (!Number.isInteger(maxChannelDelta) || maxChannelDelta < 0 || maxChannelDelta > 1) return unverified('PIXEL_TOLERANCE_INVALID');
  if (!(reference instanceof Uint8Array) || !(actual instanceof Uint8Array) || reference.length === 0 || reference.length % 4 !== 0 || actual.length !== reference.length) return { status: 'failed', reason: 'RGBA8_BYTE_LENGTH_MISMATCH' };
  let maximumChannelDelta = 0;
  let differentChannels = 0;
  let channelsOverTolerance = 0;
  for (let index = 0; index < reference.length; index++) {
    const delta = Math.abs(reference[index] - actual[index]);
    maximumChannelDelta = Math.max(maximumChannelDelta, delta);
    if (delta) differentChannels++;
    if (delta > maxChannelDelta) channelsOverTolerance++;
  }
  return { status: channelsOverTolerance ? 'failed' : 'passed', pixelCount: reference.length / 4, maximumChannelDelta, differentChannels, channelsOverTolerance, allowedChannelDelta: maxChannelDelta };
}

/** Compare each normalized layer to an external expectation, never to another SoulForge layer. */
export function compareDecodedSceneLayers(oracle, actual) {
  if (oracle?.independentOfSoulForge !== true || !oracle.provider || !oracle.revision || !oracle.license) return unverified('INDEPENDENT_ORACLE_PROVENANCE_MISSING');
  if (!SHA256.test(oracle.sourceSha256 ?? '') || actual?.sourceSha256 !== oracle.sourceSha256) return { status: 'failed', reason: 'CORPUS_HASH_MISMATCH' };
  const layers = LAYERS.map((layer) => {
    const expected = oracle.expectedByLayer?.[layer];
    const received = actual.layers?.[layer];
    if (!expected || Object.keys(expected).length === 0 || !received) return { layer, ...unverified('LAYER_EXPECTATION_OR_OBSERVATION_MISSING') };
    const differences = [];
    let differenceCount = 0;
    const mismatch = (path, reason, expected, actual) => { differenceCount++; if (differences.length < 128) differences.push({ path, reason, expected, actual }); };
    const compare = (expected, actual, path) => {
      if (typeof expected === 'number') {
        const tolerance = oracle.absoluteTolerances?.[path] ?? (/indices|index|count|parent|pixels|width|height/i.test(path) ? 0 : 1e-6);
        if (!Number.isFinite(tolerance) || tolerance < 0) return mismatch(path, 'INVALID_TOLERANCE', tolerance, null);
        if (!Number.isFinite(expected) || !Number.isFinite(actual) || Math.abs(expected - actual) > tolerance) mismatch(path, 'NUMERIC_DIFFERENCE', expected, actual);
      } else if (Array.isArray(expected)) {
        if (!Array.isArray(actual)) return mismatch(path, 'ARRAY_MISSING', expected.length, null);
        if (actual.length !== expected.length) mismatch(path, 'ARRAY_LENGTH', expected.length, actual.length);
        expected.forEach((value, index) => compare(value, actual[index], `${path}[${index}]`));
      } else if (expected && typeof expected === 'object') {
        for (const [key, value] of Object.entries(expected)) compare(value, actual?.[key], path ? `${path}.${key}` : key);
      } else if (expected !== actual) mismatch(path, 'VALUE_DIFFERENCE', expected, actual);
    };
    compare(expected, received, '');
    return { layer, status: differenceCount ? 'failed' : 'passed', differenceCount, differences };
  });
  const firstDivergentLayer = layers.find((layer) => layer.status === 'failed')?.layer ?? null;
  return { schemaVersion: 1, sourceSha256: oracle.sourceSha256, oracle: { provider: oracle.provider, revision: oracle.revision, license: oracle.license }, status: firstDivergentLayer ? 'failed' : layers.some((layer) => layer.status === 'unverified') ? 'unverified' : 'passed', firstDivergentLayer, layers };
}

/** A captured SoulForge screenshot is not automatically a correctness baseline. */
export async function compareConfirmedSceneImage(record, referencePng, actualPng, actualIdentity) {
  const confirmation = record?.confirmation;
  if (confirmation?.status !== 'confirmed' || !confirmation.confirmedBy || !confirmation.referenceSource || !Number.isFinite(Date.parse(confirmation.confirmedAt))) return unverified('REFERENCE_IMAGE_NOT_CONFIRMED');
  for (const key of ['assetSha256', 'renderConfigSha256']) {
    if (!SHA256.test(record[key] ?? '') || record[key] !== actualIdentity?.[key]) return { status: 'failed', reason: `IMAGE_IDENTITY_MISMATCH:${key}` };
  }
  if (!['webgl2', 'webgpu'].includes(record.backend) || record.backend !== actualIdentity?.backend) return { status: 'failed', reason: 'IMAGE_BACKEND_MISMATCH' };
  if (!SHA256.test(record.referencePngSha256 ?? '') || hash(referencePng) !== record.referencePngSha256) return { status: 'failed', reason: 'REFERENCE_PNG_HASH_MISMATCH' };
  const channelLimit = record.tolerance?.maxChannelDelta;
  const fractionLimit = record.tolerance?.maxChangedPixelFraction;
  if (!Number.isFinite(channelLimit) || channelLimit < 0 || channelLimit > 32 || !Number.isFinite(fractionLimit) || fractionLimit < 0 || fractionLimit > 0.2) return unverified('IMAGE_TOLERANCE_INVALID');
  const decode = (png) => sharp(png, { limitInputPixels: 32_000_000 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let reference, actual;
  try { [reference, actual] = await Promise.all([decode(referencePng), decode(actualPng)]); }
  catch (error) { return { status: 'failed', reason: 'IMAGE_DECODE_FAILED', error: String(error?.message ?? error) }; }
  if (reference.info.width !== actual.info.width || reference.info.height !== actual.info.height) return { status: 'failed', reason: 'IMAGE_DIMENSIONS_MISMATCH' };
  let changedPixels = 0;
  let maximumChannelDelta = 0;
  for (let index = 0; index < reference.data.length; index += 4) {
    let changed = false;
    for (let channel = 0; channel < 4; channel++) {
      const delta = Math.abs(reference.data[index + channel] - actual.data[index + channel]);
      maximumChannelDelta = Math.max(maximumChannelDelta, delta);
      if (delta > channelLimit) changed = true;
    }
    if (changed) changedPixels++;
  }
  const changedPixelFraction = changedPixels / (reference.info.width * reference.info.height);
  return { schemaVersion: 1, status: changedPixelFraction <= fractionLimit ? 'passed' : 'failed', assetId: record.assetId, backend: record.backend, referencePngSha256: record.referencePngSha256, actualPngSha256: hash(actualPng), dimensions: [reference.info.width, reference.info.height], changedPixels, changedPixelFraction, maximumChannelDelta, tolerance: record.tolerance };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [oraclePath, actualPath, reportPath] = process.argv.slice(2);
  if (!oraclePath || !actualPath || !reportPath) throw new Error('Usage: node scripts/scene-independent-baselines.mjs <external-oracle.json> <normalized-layer-observations.json> <report.json>');
  const report = compareDecodedSceneLayers(JSON.parse(await readFile(oraclePath, 'utf8')), JSON.parse(await readFile(actualPath, 'utf8')));
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, firstDivergentLayer: report.firstDivergentLayer ?? null }));
  process.exitCode = report.status === 'passed' ? 0 : report.status === 'unverified' ? 2 : 1;
}
