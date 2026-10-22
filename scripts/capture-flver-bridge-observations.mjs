import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const [oracleDirectory, observationsDirectory, bridgeDll] = process.argv.slice(2);
if (!bridgeDll) throw new Error('Usage: node scripts/capture-flver-bridge-observations.mjs <oracle-results> <observations> <bridge.dll-or-executable>');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const captureScriptSha256 = hash(await readFile(new URL(import.meta.url)));
const dll = resolve(bridgeDll);
const producerSha256 = hash(await readFile(dll));
const inventory = JSON.parse(await readFile(resolve(oracleDirectory, 'flver-per-mesh-inventory.json'), 'utf8'));
const directory = resolve(observationsDirectory);
await mkdir(directory, { recursive: true });
const options = { maxVertices: 1_000_000, maxIndices: 3_000_000 };
const observations = [];
const producerKind = dll.toLowerCase().endsWith('.dll') ? 'framework-dependent-dll' : 'native-executable';
const capture = async (command, name, commandOptions, sourcePath, sourceSha256, decodedSourceSha256) => {
  if (hash(await readFile(sourcePath)) !== sourceSha256) throw new Error('CAPTURE_SOURCE_IDENTITY_MISMATCH');
  const args = [command, sourcePath, '--options', JSON.stringify(commandOptions)];
  const result = spawnSync(producerKind === 'framework-dependent-dll' ? process.env.SOULFORGE_DOTNET ?? 'dotnet' : dll, producerKind === 'framework-dependent-dll' ? [dll, ...args] : args, { encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });
  if (result.error || !result.stdout) throw result.error ?? new Error(result.stderr || 'BRIDGE_OBSERVATION_EMPTY');
  if (result.status !== 0 || result.signal) throw new Error(`BRIDGE_OBSERVATION_PROCESS_FAILED:${name}:${result.status ?? result.signal}`);
  const parsed = JSON.parse(result.stdout);
  if (!['partial', 'parsed'].includes(parsed.parseStatus) || !parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data) || !Array.isArray(parsed.diagnostics) || typeof parsed.sourcePath !== 'string' || resolve(parsed.sourcePath) !== resolve(sourcePath) || typeof parsed.sourceUri !== 'string') throw new Error(`BRIDGE_OBSERVATION_ENVELOPE_INVALID:${name}`);
  if (decodedSourceSha256 && parsed.data?.sourceHash !== decodedSourceSha256) throw new Error('CAPTURE_DECODED_SOURCE_IDENTITY_MISMATCH');
  if (hash(await readFile(sourcePath)) !== sourceSha256) throw new Error('CAPTURE_SOURCE_CHANGED');
  await writeFile(resolve(directory, name), result.stdout);
  observations.push({ name, sha256: hash(Buffer.from(result.stdout)), command, commandOptions, sourcePath, sourceSha256, ...(decodedSourceSha256 ? { decodedSourceSha256 } : {}) });
};
for (const resource of inventory.resources) {
  if (hash(await readFile(resource.rawLeafPath)) !== resource.flverSha256) throw new Error('ORACLE_LEAF_IDENTITY_MISMATCH');
  const captureLeaf = (command, name, commandOptions) => capture(command, name, commandOptions, resource.rawLeafPath, resource.flverSha256);
  for (const mesh of resource.meshes) await captureLeaf('read-flver-mesh', `${resource.id}-mesh${mesh.ordinal}.json`, { ...options, meshIndex: mesh.ordinal });
  await captureLeaf('read-flver-skeleton', `${resource.id}-skeleton.json`, {});
  await captureLeaf('read-flver-document', `${resource.id}-document.json`, {});
  await captureLeaf('read-flver-texture-slots', `${resource.id}-texture-slots.json`, {});
}
const msb = JSON.parse(await readFile(resolve(oracleDirectory, 'm13_00_00_00.msbs.fields.json'), 'utf8'));
await capture('read-msb-document', 'msb.json', {}, msb.source.path, msb.source.sha256, msb.decoded.sha256);
if (hash(await readFile(dll)) !== producerSha256) throw new Error('BRIDGE_PRODUCER_CHANGED_DURING_CAPTURE');
if (hash(await readFile(new URL(import.meta.url))) !== captureScriptSha256) throw new Error('CAPTURE_TOOL_CHANGED');
await writeFile(resolve(directory, 'observation-manifest.json'), JSON.stringify({ schemaVersion: 1, capturedAt: new Date().toISOString(), bridgeDllSha256: producerSha256, producerKind, captureScriptSha256, observations }, null, 2) + '\n');
console.log(JSON.stringify({ status: 'captured', bridgeDllSha256: producerSha256, observationCount: observations.length }));
