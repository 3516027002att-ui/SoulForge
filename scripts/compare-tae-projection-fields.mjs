import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const f32 = value => { if (!Number.isFinite(value)) return null; const bytes = Buffer.alloc(4); bytes.writeFloatLE(value); return bytes.toString('hex'); };
const rawHex = value => typeof value === 'string' && /^(?:[a-f0-9]{2})*$/i.test(value) ? Buffer.from(value, 'hex') : null;
const valueEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function taeObservationProducerPin(manifest) {
  if (![1, 2].includes(manifest.schemaVersion)) throw new Error('TAE_CAPTURE_MANIFEST_INVALID');
  if (manifest.schemaVersion === 1 && manifest.expectedProducerSha256 === undefined) return { mode: 'historical-build-receipt-only', expectedProducerSha256: null };
  if (typeof manifest.expectedProducerSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.expectedProducerSha256) || manifest.expectedProducerSha256 !== manifest.producerSha256) throw new Error('TAE_MANIFEST_PRODUCER_PIN_MISMATCH');
  return { mode: 'explicit-sha', expectedProducerSha256: manifest.expectedProducerSha256 };
}
const expectedMotionId = animation => {
  const name = animation.animFileName?.replaceAll('\\', '/').split('/').at(-1);
  const match = /^a(\d{3})_(\d+)\.(?:hkt|hkx)$/i.exec(name ?? '');
  if (animation.miniHeader.type !== 'Standard') return null;
  if (match) return Number(match[1] + match[2]);
  return animation.miniHeader.ImportsHKX ? animation.miniHeader.ImportHKXSourceAnimID : animation.animId;
};

/** Ordered field checks only. Expectations come from the external native reader. */
export function compareTaeLayers(expected, bridge, core) {
  const mismatches = [], counts = { bridge: 0, core: 0 };
  const check = (layer, path, want, actual, equal = valueEqual) => {
    counts[layer]++;
    if (!equal(want, actual)) mismatches.push({ layer, path, expected: want ?? null, actual: actual ?? null });
  };
  const animations = expected.animations;
  check('bridge', 'sourceHash', expected.leafSha256, bridge.sourceHash);
  check('bridge', 'eventBank', expected.eventBank, bridge.eventBank);
  check('bridge', 'animationCount', animations.length, bridge.animationCount);
  check('bridge', 'totalEventCount', animations.reduce((sum, a) => sum + a.events.length, 0), bridge.totalEventCount);
  check('bridge', 'totalGroupCount', animations.reduce((sum, a) => sum + a.groups.length, 0), bridge.totalGroupCount);
  const types = [...new Set(animations.flatMap(a => [...a.events.map(e => e.eventTypeId), ...a.groups.map(g => g.groupType)]))].sort((a, b) => a - b);
  check('bridge', 'eventTypes', types, bridge.eventTypes);
  check('bridge', 'animationsTruncated', false, bridge.animationsTruncated);
  check('bridge', 'animations.length', animations.length, bridge.animations?.length);
  if (core) check('core', 'animations.length', animations.length, core.animations?.length);
  for (let ai = 0; ai < animations.length; ai++) {
    const a = animations[ai], b = bridge.animations?.[ai] ?? {}, c = core?.animations?.[ai] ?? {};
    const base = `animations[${ai}]`;
    for (const [field, want] of [['animId', a.animId], ['eventCount', a.events.length], ['groupCount', a.groups.length], ['hkxName', a.animFileName || null], ['motionAnimId', expectedMotionId(a)], ['eventsTruncated', false], ['events.length', a.events.length]]) {
      check('bridge', `${base}.${field}`, want, field === 'events.length' ? b.events?.length : b[field] ?? null);
    }
    if (core) {
      for (const [field, want] of [['animId', a.animId], ['eventCount', a.events.length], ['hkxName', a.animFileName || null], ['motionAnimId', expectedMotionId(a)], ['eventsComplete', true], ['events.length', a.events.length]]) {
        check('core', `${base}.${field}`, want, field === 'events.length' ? c.events?.length : c[field] ?? null);
      }
    }
    for (let ei = 0; ei < a.events.length; ei++) {
      const event = a.events[ei], be = b.events?.[ei] ?? {}, ce = c.events?.[ei] ?? {};
      const path = `${base}.events[${ei}]`;
      check('bridge', `${path}.eventTypeId`, event.eventTypeId, be.eventTypeId);
      check('bridge', `${path}.startTime`, event.startTime, be.startTime, (x, y) => f32(x) !== null && f32(x) === f32(y));
      check('bridge', `${path}.endTime`, event.endTime, be.endTime, (x, y) => f32(x) !== null && f32(x) === f32(y));
      check('bridge', `${path}.parameterLength`, event.parameterLength, be.parameterLength);
      const bytes = rawHex(be.parameterBytesHex);
      check('bridge', `${path}.parameterBytesHex.length`, event.parameterLength, bytes?.length);
      check('bridge', `${path}.parameterSha256`, event.parameterSha256, bytes ? hash(bytes) : null);
      if (core) {
        check('core', `${path}.index`, event.ordinal, ce.index);
        check('core', `${path}.eventTypeId`, event.eventTypeId, ce.eventTypeId);
        check('core', `${path}.startTime`, event.startTime, ce.startTime, (x, y) => f32(x) !== null && f32(x) === f32(y));
        check('core', `${path}.endTime`, event.endTime, ce.endTime, (x, y) => f32(x) !== null && f32(x) === f32(y));
        const coreBytes = rawHex(ce.parameterBytesHex ?? '');
        check('core', `${path}.parameterBytesHex.length`, event.parameterLength, coreBytes?.length);
        check('core', `${path}.parameterSha256`, event.parameterSha256, coreBytes ? hash(coreBytes) : null);
        const fields = be.templateFields?.map(field => ({ name: field.name, value: field.value })) ?? [];
        check('core', `${path}.fields`, fields, ce.fields ?? []);
      }
    }
  }
  const firstMismatch = mismatches.find(item => item.layer === 'bridge') ?? mismatches[0] ?? null;
  return { id: expected.id, status: mismatches.length ? 'failed' : 'passed', firstDivergentLayer: firstMismatch?.layer ?? null, firstMismatch, mismatchCount: mismatches.length, mismatches: mismatches.slice(0, 20), checks: counts, animations: animations.length, events: animations.reduce((sum, a) => sum + a.events.length, 0), groups: animations.reduce((sum, a) => sum + a.groups.length, 0) };
}

export async function compareTaeProjectionFields(oraclePath, observationsPath, productPath) {
  const productRoot = resolve(productPath), outputRoot = resolve(observationsPath);
  const bindings = new Map();
  const bind = async path => { path = resolve(path); const bytes = await readFile(path); bindings.set(path, { path, byteLength: bytes.length, sha256: hash(bytes) }); return bytes; };
  await bind(fileURLToPath(import.meta.url));
  const oracle = JSON.parse(await bind(oraclePath));
  if (oracle.schema !== 'soulforge.external-tae-fields.v1' || oracle.provider?.revision !== 'ee1dd61958f60bdc51ce3da548e9a90a8ab39905' || oracle.provider.independentOfSoulForge !== true) throw new Error('TAE_ORACLE_PROVENANCE_INVALID');
  const manifest = JSON.parse(await bind(join(outputRoot, 'observation-manifest.json')));
  const producerPin = taeObservationProducerPin(manifest);
  if (manifest.producerKind !== 'native-executable' || resolve(manifest.oraclePath) !== resolve(oraclePath)) throw new Error('TAE_CAPTURE_MANIFEST_INVALID');
  for (const record of [...oracle.bindings, ...manifest.bindings]) if (hash(await bind(record.path)) !== record.sha256) throw new Error(`TAE_BOUND_FILE_CHANGED:${record.path}`);
  if (hash(await bind(manifest.producerPath)) !== manifest.producerSha256) throw new Error('TAE_BRIDGE_PRODUCER_MISMATCH');
  const buildReceipt = JSON.parse(await bind(manifest.buildReceiptPath));
  if (buildReceipt.executable.sha256 !== manifest.producerSha256 || resolve(join(productRoot, buildReceipt.executable.path)) !== resolve(manifest.producerPath)) throw new Error('TAE_BUILD_PRODUCER_RECEIPT_MISMATCH');
  const captureScript = fileURLToPath(new URL('./capture-tae-bridge-observations.mjs', import.meta.url));
  if (resolve(manifest.captureScriptPath) !== resolve(captureScript) || manifest.bindings.find(item => resolve(item.path) === resolve(captureScript))?.sha256 !== hash(await bind(captureScript))) throw new Error('TAE_CAPTURE_SCRIPT_RECEIPT_MISMATCH');
  const corePath = join(productRoot, 'packages/core/dist/indexing/ingestBridgeResult.js');
  if (!manifest.bindings.some(item => resolve(item.path) === resolve(corePath))) throw new Error('TAE_CORE_MAPPER_NOT_BOUND');
  const { ingestBridgeResult } = await import(pathToFileURL(corePath).href);
  const resources = [], negatives = [];
  for (const expected of oracle.resources) {
    if (hash(await bind(expected.leafPath)) !== expected.leafSha256) throw new Error('TAE_NATIVE_LEAF_IDENTITY_MISMATCH');
    const name = `${expected.id}-document.json`, observation = manifest.observations.find(item => item.name === name);
    const bytes = await bind(join(outputRoot, name));
    if (!observation || observation.sha256 !== hash(bytes) || observation.command !== 'read-tae-document' || JSON.stringify(observation.commandOptions) !== '{}' || observation.processExitCode !== 0 || resolve(observation.sourcePath) !== resolve(expected.leafPath) || observation.sourceSha256 !== expected.leafSha256) throw new Error(`TAE_OBSERVATION_RECEIPT_MISMATCH:${name}`);
    const bridge = JSON.parse(bytes);
    if (!['parsed', 'partial'].includes(bridge.parseStatus) || bridge.resourceKind !== 'action' || !Array.isArray(bridge.diagnostics) || resolve(bridge.sourcePath) !== resolve(expected.leafPath) || bridge.data?.sourceHash !== expected.leafSha256) throw new Error('TAE_OBSERVATION_ENVELOPE_INVALID');
    let projection;
    const ingested = ingestBridgeResult({ upsertTaeExport(value) { projection = value; return true; } }, bridge);
    if (!ingested.accepted || !projection) throw new Error(`TAE_CORE_MAPPER_REJECTED:${JSON.stringify(ingested.diagnostics)}`);
    const report = compareTaeLayers(expected, bridge.data, projection);
    resources.push({ ...report, sourceSha256: expected.leafSha256, sourceByteLength: expected.leafByteLength, rawParameterBytes: expected.animations.reduce((sum, animation) => sum + animation.events.reduce((total, event) => total + event.parameterLength, 0), 0), coreAccepted: ingested.accepted, coreDiagnosticCodes: [...new Set(ingested.diagnostics.map(item => item.code))] });
    const index = expected.animations.findIndex(animation => animation.events.length > 0);
    for (const mutation of ['eventTypeId', 'startTime', 'parameterBytesHex']) {
      const wrong = structuredClone(bridge.data), event = wrong.animations[index].events[0];
      if (mutation === 'eventTypeId') event.eventTypeId += 1;
      if (mutation === 'startTime') event.startTime += 0.25;
      if (mutation === 'parameterBytesHex') { const raw = Buffer.from(event.parameterBytesHex, 'hex'); raw[0] ^= 1; event.parameterBytesHex = raw.toString('hex'); }
      const negative = compareTaeLayers(expected, wrong, projection);
      negatives.push({ id: `${expected.id}:${mutation}`, mutation, originalFilesUnchanged: true, status: negative.status, firstDivergentLayer: negative.firstDivergentLayer, firstMismatch: negative.firstMismatch, negativePassed: negative.status === 'failed' && negative.firstDivergentLayer === 'bridge' });
    }
  }
  for (const record of bindings.values()) if (hash(await readFile(record.path)) !== record.sha256) throw new Error(`TAE_BOUND_FILE_CHANGED_DURING_COMPARE:${record.path}`);
  return {
    schema: 'soulforge.independent-tae-fields.v1', status: resources.every(item => item.status === 'passed') && negatives.every(item => item.negativePassed) ? 'passed' : 'failed', generatedAt: new Date().toISOString(),
    comparisonLayers: ['bridge', 'compiled-core-mapper'], provider: oracle.provider, originalSource: oracle.originalSource, producer: { path: manifest.producerPath, sha256: manifest.producerSha256, buildReceiptPath: manifest.buildReceiptPath, producerPinMode: producerPin.mode, expectedProducerSha256: producerPin.expectedProducerSha256 },
    coreAttestation: manifest.coreAttestation, bindings: [...bindings.values()], resources, negatives,
    exposedCoverage: ['Ordered animation IDs and native names', 'Derived motion IDs for the available Standard/name/import cases', 'Event banks, counts, group counts and union event-type set', 'Ordered event types and exact float32 times', 'Complete native parameter spans, lengths and SHA-256', 'Compiled core event indexes/types/times/raw parameters and Bridge-to-core decoded field preservation'],
    unexposedOrUnverified: ['Bridge/core omit full miniheader flags and ImportOther target metadata', 'Bridge/core omit group types and event memberships; independent export preserves them, product comparison covers group counts only', 'Bridge/core omit native event Unk04', 'NEXT public object model omits native times-table counts', 'No independent typed parameter schema semantics; only byte identity plus Bridge-to-core field preservation', 'Cross-leaf ImportOther motion resolution is unverified by the two naked leaf reads', 'No HKX decode, pose evaluation, animation rendering, game execution, vendor DLL execution, complete corpus coverage or independent format discovery']
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [oraclePath, observationsPath, productPath, reportPath] = process.argv.slice(2);
  if (!reportPath) throw new Error('Usage: node scripts/compare-tae-projection-fields.mjs <external-tae-fields.json> <observations> <product-root> <report.json>');
  const report = await compareTaeProjectionFields(oraclePath, observationsPath, productPath);
  await writeFile(resolve(reportPath), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, resources: report.resources.map(({ id, animations, events, groups, mismatchCount }) => ({ id, animations, events, groups, mismatchCount })), negativeCount: report.negatives.length, reportPath: resolve(reportPath) }));
  if (report.status !== 'passed') process.exitCode = 1;
}
