import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function assertTaeCaptureProducer(expectedProducerSha256, receipt, producerBytes) {
  if (typeof expectedProducerSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedProducerSha256)) throw new Error('TAE_CAPTURE_EXPECTED_PRODUCER_SHA_REQUIRED');
  if (receipt.executable?.sha256 !== expectedProducerSha256) throw new Error('TAE_CAPTURE_EXPECTED_PRODUCER_MISMATCH');
  if (hash(producerBytes) !== receipt.executable.sha256) throw new Error('TAE_CAPTURE_PRODUCER_RECEIPT_MISMATCH');
}

export async function captureTaeBridgeObservations(oraclePath, outputPath, productPath, expectedProducerSha256) {
  if (typeof expectedProducerSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedProducerSha256)) throw new Error('TAE_CAPTURE_EXPECTED_PRODUCER_SHA_REQUIRED');
  const productRoot = resolve(productPath), outputRoot = resolve(outputPath);
  const bindings = new Map();
  const bind = async path => { path = resolve(path); const bytes = await readFile(path); bindings.set(path, { path, byteLength: bytes.length, sha256: hash(bytes) }); return bytes; };
  const scriptPath = fileURLToPath(import.meta.url);
  await bind(scriptPath);
  const oracle = JSON.parse(await bind(oraclePath));
  if (oracle.schema !== 'soulforge.external-tae-fields.v1' || oracle.provider?.independentOfSoulForge !== true || oracle.resources?.length !== 2) throw new Error('TAE_ORACLE_PROVENANCE_INVALID');
  for (const record of oracle.bindings) if (hash(await bind(record.path)) !== record.sha256) throw new Error(`TAE_ORACLE_INPUT_CHANGED:${record.path}`);
  const bridgePath = join(productRoot, 'bridge/SoulForge.Bridge/bin/Release/net10.0/linux-x64/publish/SoulForge.Bridge');
  const receiptPath = join(dirname(bridgePath), 'bridge-production-build.json');
  const receipt = JSON.parse(await bind(receiptPath));
  assertTaeCaptureProducer(expectedProducerSha256, receipt, await bind(bridgePath));
  const sourcePaths = ['TaeNativeDocument.cs', 'TaeDocumentSet.cs', 'SekiroTaeMotionReferenceReader.cs', 'BridgeCommandService.cs', 'BridgeCommandDefinitions.generated.cs', 'FirstParty/TaeFirstPartySchema.cs', 'FormatRules/sekiro-tae-schema.v1.json.gz.base64', 'ActionAnimationSemantics.cs'];
  for (const name of sourcePaths) {
    const path = `bridge/SoulForge.Bridge/${name}`;
    const entry = receipt.source.entries.find(item => item.path === path);
    if (!entry || hash(await bind(join(productRoot, path))) !== entry.sha256) throw new Error(`TAE_CAPTURE_SOURCE_RECEIPT_MISMATCH:${path}`);
  }
  for (const path of ['packages/core/src/indexing/ingestBridgeResult.ts', 'packages/core/dist/indexing/ingestBridgeResult.js', 'packages/core/dist/workspace/resourceKinds.js', 'packages/shared/package.json', 'package-lock.json']) await bind(join(productRoot, path));
  const bindSharedJs = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await bindSharedJs(path);
      else if (entry.isFile() && entry.name.endsWith('.js')) await bind(path);
    }
  };
  await bindSharedJs(join(productRoot, 'packages/shared/dist'));
  await mkdir(outputRoot, { recursive: true });
  const observations = [];
  for (const resource of oracle.resources) {
    if (hash(await bind(resource.leafPath)) !== resource.leafSha256) throw new Error('TAE_CAPTURE_LEAF_IDENTITY_MISMATCH');
    const command = 'read-tae-document', commandOptions = {};
    const args = [command, resource.leafPath, '--options', JSON.stringify(commandOptions)];
    const run = spawnSync(bridgePath, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
    if (run.error || run.status !== 0 || run.signal || !run.stdout) throw run.error ?? new Error(`TAE_CAPTURE_PROCESS_FAILED:${resource.id}:${run.status}:${run.stderr}`);
    const result = JSON.parse(run.stdout);
    if (!['parsed', 'partial'].includes(result.parseStatus) || result.resourceKind !== 'action' || !result.data || !Array.isArray(result.diagnostics) || resolve(result.sourcePath) !== resolve(resource.leafPath) || result.data.sourceHash !== resource.leafSha256 || result.data.animationsTruncated === true || result.data.animations?.some(animation => animation.eventsTruncated)) throw new Error(`TAE_CAPTURE_ENVELOPE_INVALID:${resource.id}`);
    const name = `${resource.id}-document.json`;
    await writeFile(join(outputRoot, name), run.stdout);
    observations.push({ name, sha256: hash(Buffer.from(run.stdout)), byteLength: Buffer.byteLength(run.stdout), command, commandOptions, sourcePath: resource.leafPath, sourceSha256: resource.leafSha256, processExitCode: run.status, stderr: run.stderr });
  }
  for (const record of bindings.values()) if (hash(await readFile(record.path)) !== record.sha256) throw new Error(`TAE_CAPTURE_BOUND_INPUT_CHANGED:${record.path}`);
  const manifest = { schemaVersion: 2, capturedAt: new Date().toISOString(), producerKind: 'native-executable', producerPath: bridgePath, producerSha256: receipt.executable.sha256, expectedProducerSha256, buildReceiptPath: receiptPath, captureScriptPath: scriptPath, oraclePath: resolve(oraclePath), bindings: [...bindings.values()], observations, coreAttestation: 'Compiled mapper/shared outputs individually hash-bound and checked before/after; no independent core compilation receipt is claimed' };
  await writeFile(join(outputRoot, 'observation-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, observations: observations.length, bytes: observations.reduce((sum, item) => sum + item.byteLength, 0), producerSha256: receipt.executable.sha256 }));
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [oraclePath, outputPath, productPath, expectedProducerSha256] = process.argv.slice(2);
  if (!expectedProducerSha256) throw new Error('Usage: node scripts/capture-tae-bridge-observations.mjs <external-tae-fields.json> <observations> <product-root> <expected-producer-sha256>');
  await captureTaeBridgeObservations(oraclePath, outputPath, productPath, expectedProducerSha256);
}
