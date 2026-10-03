import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const shaPattern = /^[a-f0-9]{64}$/;

/** The reflection DLL must be exactly the complete assembly embedded in the frozen producer. */
export function assertTaeInternalProducer(expectedSha256, receipt, producerBytes, assemblyBytes) {
  if (typeof expectedSha256 !== 'string' || !shaPattern.test(expectedSha256)) throw new Error('TAE_INTERNAL_EXPECTED_PRODUCER_SHA_REQUIRED');
  if (receipt.executable?.sha256 !== expectedSha256 || hash(producerBytes) !== expectedSha256) throw new Error('TAE_INTERNAL_PRODUCER_PIN_MISMATCH');
  if (!assemblyBytes.length) throw new Error('TAE_INTERNAL_ASSEMBLY_EMPTY');
  const embeddedOffset = producerBytes.indexOf(assemblyBytes);
  if (embeddedOffset < 0 || producerBytes.indexOf(assemblyBytes, embeddedOffset + 1) !== -1) throw new Error('TAE_INTERNAL_ASSEMBLY_NOT_UNIQUELY_EMBEDDED');
  return { assemblySha256: hash(assemblyBytes), assemblyByteLength: assemblyBytes.length, embeddedOffset, embeddedByteIdentity: true };
}

function expectedReference(animation) {
  if (animation.miniHeader.type === 'ImportOtherAnim') return { animationId: animation.animId, kind: 'ImportOtherAnimation', sourceAnimationId: animation.miniHeader.ImportFromAnimID, hkxAnimationId: null };
  const name = animation.animFileName?.replaceAll('\\', '/').split('/').at(-1);
  const match = /^a(\d{3})_(\d+)\.(?:hkt|hkx)$/i.exec(name ?? '');
  if (match) return { animationId: animation.animId, kind: 'OwnHkx', sourceAnimationId: null, hkxAnimationId: Number(match[1] + match[2]) };
  return { animationId: animation.animId, kind: animation.miniHeader.ImportsHKX ? 'ImportHkx' : 'OwnHkx', sourceAnimationId: animation.miniHeader.ImportsHKX ? animation.miniHeader.ImportHKXSourceAnimID : null, hkxAnimationId: null };
}

/** The raw supplement is counted independently from retained native parser properties. */
export function compareTaeInternalResource(expected, observed) {
  const mismatches = [], counts = { 'decoded-native': 0, 'supplemental-raw-layout': 0 };
  const check = (layer, path, wanted, actual) => {
    counts[layer]++;
    if (!same(wanted, actual)) mismatches.push({ layer, path, expected: wanted ?? null, actual: actual ?? null });
  };
  for (const [field, wanted] of [['id', expected.id], ['sourceHash', expected.leafSha256], ['sourceByteLength', expected.leafByteLength], ['eventBank', expected.eventBank], ['animationCount', expected.animations.length], ['totalEventCount', expected.animations.reduce((n, a) => n + a.events.length, 0)], ['totalGroupCount', expected.animations.reduce((n, a) => n + a.groups.length, 0)]])
    check('decoded-native', field, wanted, observed[field]);
  check('decoded-native', 'animations.length', expected.animations.length, observed.animations?.length);
  for (let ai = 0; ai < expected.animations.length; ai++) {
    const a = expected.animations[ai], actual = observed.animations?.[ai] ?? {}, base = `animations[${ai}]`;
    for (const [field, wanted] of [['ordinal', ai], ['animId', a.animId], ['hkxName', a.animFileName || null], ['eventCount', a.events.length], ['groupCount', a.groups.length], ['motionReference', expectedReference(a)]])
      check('decoded-native', `${base}.${field}`, wanted, actual[field]);
    check('decoded-native', `${base}.groups.length`, a.groups.length, actual.groups?.length);
    const eventGroupOrdinals = a.events.map(event => event.groupOrdinal ?? null);
    check('decoded-native', `${base}.eventGroupOrdinals`, eventGroupOrdinals, actual.eventGroupOrdinals);
    for (let gi = 0; gi < a.groups.length; gi++) {
      const group = a.groups[gi], observedGroup = actual.groups?.[gi] ?? {};
      for (const [field, wanted] of [['ordinal', gi], ['groupType', group.groupType], ['groupEventCount', group.eventIndices.length]])
        check('decoded-native', `${base}.groups[${gi}].${field}`, wanted, observedGroup[field]);
      // NEXT's public Event.Group exporter produces indices in event order. Compare
      // memberships in that order while the capture retains actual native offset order.
      check('decoded-native', `${base}.groups[${gi}].eventIndices`, group.eventIndices, Array.isArray(observedGroup.eventIndices) ? [...observedGroup.eventIndices].sort((x, y) => x - y) : undefined);
    }
    const rawHeader = actual.supplementalNativeLayout?.miniHeader;
    check('supplemental-raw-layout', `${base}.miniHeader`, a.miniHeader, rawHeader);
  }
  return { id: expected.id, status: mismatches.length ? 'failed' : 'passed', animations: expected.animations.length, events: expected.animations.reduce((n, a) => n + a.events.length, 0), groups: expected.animations.reduce((n, a) => n + a.groups.length, 0), comparedFields: counts, mismatchCount: mismatches.length, firstMismatch: mismatches[0] ?? null, mismatches };
}

export async function compareTaeInternalFields({ oraclePath, productRoot, assemblyPath, receiptPath, expectedProducerSha256, dotnetPath, outputRoot }) {
  productRoot = resolve(productRoot); outputRoot = resolve(outputRoot);
  const bindings = new Map();
  const bind = async path => { path = resolve(path); const bytes = await readFile(path); const record = { path, byteLength: bytes.length, sha256: hash(bytes) }; const old = bindings.get(path); if (old && old.sha256 !== record.sha256) throw new Error(`TAE_INTERNAL_INPUT_CHANGED:${path}`); bindings.set(path, record); return bytes; };
  const scriptPath = fileURLToPath(import.meta.url);
  await bind(scriptPath);
  const oracle = JSON.parse(await bind(oraclePath));
  if (oracle.schema !== 'soulforge.external-tae-fields.v1' || oracle.ok !== true || oracle.provider?.independentOfSoulForge !== true || oracle.provider?.revision !== 'ee1dd61958f60bdc51ce3da548e9a90a8ab39905' || oracle.resources?.length !== 2 || !same(oracle.resources.map(item => item.id), ['a232', 'a250'])) throw new Error('TAE_INTERNAL_ORACLE_INVALID');
  for (const item of oracle.bindings) if (hash(await bind(item.path)) !== item.sha256) throw new Error(`TAE_INTERNAL_ORACLE_BINDING_CHANGED:${item.path}`);
  if (hash(await bind(oracle.provider.assemblyPath)) !== oracle.provider.assemblySha256 || hash(await bind(oracle.originalSource.path)) !== oracle.originalSource.sha256) throw new Error('TAE_INTERNAL_ORACLE_IDENTITY_MISMATCH');
  const receipt = JSON.parse(await bind(receiptPath));
  if (receipt.schemaVersion !== 2 || !Array.isArray(receipt.source?.entries) || !receipt.source.entries.length || !shaPattern.test(receipt.source.sha256)) throw new Error('TAE_INTERNAL_SOURCE_RECEIPT_INVALID');
  if (receipt.helper?.path !== 'scripts/bridge-production-build.mjs') throw new Error('TAE_INTERNAL_RECEIPT_HELPER_INVALID');
  const helperPath = join(productRoot, receipt.helper.path);
  if (hash(await bind(helperPath)) !== receipt.helper.sha256) throw new Error('TAE_INTERNAL_RECEIPT_HELPER_CHANGED');
  const { assertBridgeProductionBuildFresh } = await import(pathToFileURL(helperPath).href);
  const assertSourceScopeFresh = async () => {
    const fresh = await assertBridgeProductionBuildFresh(productRoot, { runtimeIdentifier: 'linux-x64' });
    if (resolve(fresh.manifestPath) !== resolve(receiptPath) || !same(fresh.receipt, receipt)) throw new Error('TAE_INTERNAL_RECEIPT_CHANGED');
  };
  // The product helper inventories all compile inputs and validates the mandatory
  // scope, so receipt omissions and newly added files also fail closed.
  await assertSourceScopeFresh();
  const producerPath = resolve(productRoot, receipt.executable.path);
  const producerBytes = await bind(producerPath), assemblyBytes = await bind(assemblyPath);
  const assemblyIdentity = assertTaeInternalProducer(expectedProducerSha256, receipt, producerBytes, assemblyBytes);
  const sourceDigest = createHash('sha256');
  let totalSourceBytes = 0;
  for (const item of receipt.source.entries) {
    const virtualScript = item.path === 'package.json#scripts.bridge:publish:linux';
    const path = resolve(productRoot, virtualScript ? 'package.json' : item.path), rel = relative(productRoot, path);
    if (rel.startsWith(`..${sep}`) || rel === '..' || !rel) throw new Error('TAE_INTERNAL_SOURCE_PATH_OUTSIDE_PRODUCT');
    const fileBytes = await bind(path);
    const bytes = virtualScript ? Buffer.from(JSON.parse(fileBytes).scripts['bridge:publish:linux'], 'utf8') : fileBytes;
    if (hash(bytes) !== item.sha256 || bytes.length !== item.bytes) throw new Error(`TAE_INTERNAL_PRODUCT_SOURCE_CHANGED:${item.path}`);
    sourceDigest.update(item.path, 'utf8'); sourceDigest.update('\0'); sourceDigest.update(String(bytes.length), 'utf8'); sourceDigest.update('\0'); sourceDigest.update(bytes); sourceDigest.update('\0');
    totalSourceBytes += bytes.length;
  }
  if (sourceDigest.digest('hex') !== receipt.source.sha256 || receipt.source.fileCount !== receipt.source.entries.length || totalSourceBytes !== receipt.source.totalBytes) throw new Error('TAE_INTERNAL_SOURCE_RECEIPT_DIGEST_MISMATCH');
  for (const item of [receipt.helper, receipt.nativeLibrary]) {
    if (!item || hash(await bind(resolve(productRoot, item.path))) !== item.sha256) throw new Error('TAE_INTERNAL_BUILD_DEPENDENCY_MISMATCH');
  }
  const sources = ['Program.cs', 'TAEInternalFields.csproj', 'NuGet.Config'];
  const probeSources = [];
  for (const name of sources) probeSources.push([name, await bind(join(dirname(scriptPath), 'scene/tae-internal-field-probe', name))]);
  await bind(dotnetPath);
  for (const leaf of oracle.resources) { const bytes = await bind(leaf.leafPath); if (hash(bytes) !== leaf.leafSha256 || bytes.length !== leaf.leafByteLength || bytes.length > 32 * 1024) throw new Error('TAE_INTERNAL_LEAF_CHANGED'); }
  // A fresh owned directory prevents rebuilding over an earlier evidence producer.
  await mkdir(outputRoot, { recursive: false });
  const probeRoot = join(outputRoot, 'probe-source'), probeOutput = join(outputRoot, 'probe-bin');
  await mkdir(probeRoot);
  for (const [name, bytes] of probeSources) { const target = join(probeRoot, name); await writeFile(target, bytes); await bind(target); }
  const env = { ...process.env, DOTNET_CLI_HOME: join(outputRoot, 'dotnet-home'), NUGET_PACKAGES: join(outputRoot, 'nuget-packages'), DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' };
  const run = (args, maxBuffer = 2 * 1024 * 1024) => {
    const result = spawnSync(resolve(dotnetPath), args, { cwd: probeRoot, env, encoding: 'utf8', timeout: 60_000, maxBuffer });
    if (result.error || result.status !== 0 || result.signal) throw result.error ?? new Error(`TAE_INTERNAL_PROBE_FAILED:${result.status}:${result.stderr || result.stdout}`);
    return result;
  };
  const build = run(['build', join(probeRoot, 'TAEInternalFields.csproj'), '-c', 'Release', '-o', probeOutput, '--configfile', join(probeRoot, 'NuGet.Config'), '-p:NuGetAudit=false', '-p:UseSharedCompilation=false']);
  const buildLog = join(outputRoot, 'probe-build.log'); await writeFile(buildLog, build.stdout + build.stderr); await bind(buildLog);
  const probePath = join(probeOutput, 'TAEInternalFields.dll');
  for (const name of ['TAEInternalFields.dll', 'TAEInternalFields.deps.json', 'TAEInternalFields.runtimeconfig.json']) await bind(join(probeOutput, name));
  const capture = run([probePath, resolve(assemblyPath), ...oracle.resources.map(item => resolve(item.leafPath))]);
  const observations = JSON.parse(capture.stdout);
  if (observations.schema !== 'soulforge.tae-internal-observations.v1' || observations.producerSha256 !== assemblyIdentity.assemblySha256 || observations.resources?.length !== 2) throw new Error('TAE_INTERNAL_CAPTURE_INVALID');
  const observationPath = join(outputRoot, 'observations.json'); await writeFile(observationPath, capture.stdout); await bind(observationPath);
  const resources = [], negatives = [];
  for (let ri = 0; ri < oracle.resources.length; ri++) {
    const expected = oracle.resources[ri], observed = observations.resources[ri];
    resources.push(compareTaeInternalResource(expected, observed));
    const grouped = expected.animations.findIndex(a => a.groups.length);
    const standard = expected.animations.findIndex(a => a.miniHeader.type === 'Standard');
    const imported = expected.animations.findIndex(a => a.miniHeader.type === 'ImportOtherAnim');
    for (const mutation of ['groupType', 'groupMembership', 'groupOrdinal', 'motionReference', 'standardMiniHeader', ...(imported < 0 ? [] : ['importMiniHeader'])]) {
      const changed = structuredClone(observed);
      if (mutation === 'groupType') changed.animations[grouped].groups[0].groupType++;
      if (mutation === 'groupMembership') changed.animations[grouped].groups[0].eventIndices = [];
      if (mutation === 'groupOrdinal') changed.animations[grouped].eventGroupOrdinals[expected.animations[grouped].groups[0].eventIndices[0]] = null;
      if (mutation === 'motionReference') changed.animations[0].motionReference.animationId++;
      if (mutation === 'standardMiniHeader') changed.animations[standard].supplementalNativeLayout.miniHeader.AllowDelayLoad = !changed.animations[standard].supplementalNativeLayout.miniHeader.AllowDelayLoad;
      if (mutation === 'importMiniHeader') changed.animations[imported].supplementalNativeLayout.miniHeader.Unknown++;
      const result = compareTaeInternalResource(expected, changed);
      const wantedLayer = mutation.endsWith('MiniHeader') ? 'supplemental-raw-layout' : 'decoded-native';
      negatives.push({ id: `${expected.id}:${mutation}`, mutation, status: result.status, firstMismatch: result.firstMismatch, passed: result.status === 'failed' && result.firstMismatch?.layer === wantedLayer, nativeInputUnchanged: true });
    }
  }
  for (const item of bindings.values()) if (hash(await readFile(item.path)) !== item.sha256) throw new Error(`TAE_INTERNAL_BOUND_INPUT_CHANGED_AFTER_CAPTURE:${item.path}`);
  await assertSourceScopeFresh();
  const report = {
    schema: 'soulforge.independent-tae-internal-fields.v1', status: resources.every(r => r.status === 'passed') && negatives.every(n => n.passed) ? 'passed' : 'failed', generatedAt: new Date().toISOString(),
    provider: oracle.provider, originalSource: oracle.originalSource,
    producer: { path: producerPath, expectedSha256: expectedProducerSha256, sha256: hash(producerBytes), reflectionAssemblyPath: resolve(assemblyPath), ...assemblyIdentity, receiptPath: resolve(receiptPath), sourceInputHash: receipt.source.sha256, boundSourceFiles: receipt.source.entries.length, completeBuildScopeFreshBeforeAndAfter: true, scopeVerifier: helperPath },
    probe: { path: probePath, sha256: hash(await readFile(probePath)), dotnetPath: resolve(dotnetPath), externalDependencies: false, stderr: capture.stderr },
    bindings: [...bindings.values()], resources, negatives,
    decodedCoverage: ['Ordered native animation identities/names/counts', 'Retained product miniheader motion-reference kind/target/native HKX identity', 'Every decoded group type/count and event-offset membership, translated with supplemental event-header base', 'Every observed event membership ordinal; null membership is supported but absent from these two samples'],
    supplementalRawCoverage: ['Complete exported Standard/ImportOther miniheader values read only in the validation probe from hash-bound native bytes; these values are not retained product miniheader properties'],
    omittedOrUnverified: ['Standard loop/delay flags and ImportOther Unknown are consumed but discarded by the product motion reader; full miniheaders are independently compared only as supplemental raw bytes', 'GroupTypeUnknown is retained and captured but omitted by the oracle export, so no independent value comparison is claimed', 'TAE root ID, null-header motion behavior, native reserved padding, and other unretained roots are not independently compared', 'No Bridge/core/UI DTO additions, product parser edits, typed parameter semantic claim, HKX evaluation/rendering, game execution, vendor DLL, whole corpus coverage, or independent format discovery'],
    groupMembershipTranslation: observations.groupMembershipTranslation, supplementalLayoutBasis: observations.supplementalLayoutBasis, originalInputsUnchanged: true
  };
  const reportPath = join(outputRoot, 'comparison.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  return { reportPath, report };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [oraclePath, productRoot, assemblyPath, receiptPath, expectedProducerSha256, dotnetPath, outputRoot] = process.argv.slice(2);
  if (!outputRoot) throw new Error('Usage: node scripts/compare-tae-internal-fields.mjs <oracle-json> <product-root> <product-dll> <build-receipt> <expected-apphost-sha256> <dotnet> <fresh-owned-output>');
  const { reportPath, report } = await compareTaeInternalFields({ oraclePath, productRoot, assemblyPath, receiptPath, expectedProducerSha256, dotnetPath, outputRoot });
  console.log(JSON.stringify({ status: report.status, reportPath, producer: report.producer, resources: report.resources.map(({ id, animations, events, groups, comparedFields, mismatchCount, firstMismatch }) => ({ id, animations, events, groups, comparedFields, mismatchCount, firstMismatch })), negativeCount: report.negatives.length }));
  if (report.status !== 'passed') process.exitCode = 1;
}
