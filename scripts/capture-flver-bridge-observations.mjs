import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const [oracleDirectory, observationsDirectory, bridgeDll] = process.argv.slice(2);
if (!bridgeDll) throw new Error('Usage: node scripts/capture-flver-bridge-observations.mjs <oracle-results> <observations> <bridge.dll>');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const dll = resolve(bridgeDll);
const producerSha256 = hash(await readFile(dll));
const inventory = JSON.parse(await readFile(resolve(oracleDirectory, 'flver-per-mesh-inventory.json'), 'utf8'));
const directory = resolve(observationsDirectory);
await mkdir(directory, { recursive: true });
const options = { maxVertices: 1_000_000, maxIndices: 3_000_000 };
const observations = [];
for (const resource of inventory.resources) {
  if (hash(await readFile(resource.rawLeafPath)) !== resource.flverSha256) throw new Error('ORACLE_LEAF_IDENTITY_MISMATCH');
  const capture = async (command, name, commandOptions) => {
    const result = spawnSync(process.env.SOULFORGE_DOTNET ?? 'dotnet', [dll, command, resource.rawLeafPath, '--options', JSON.stringify(commandOptions)], { encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });
    if (result.error || !result.stdout) throw result.error ?? new Error(result.stderr || 'BRIDGE_OBSERVATION_EMPTY');
    JSON.parse(result.stdout);
    await writeFile(resolve(directory, name), result.stdout);
    observations.push({ name, sha256: hash(Buffer.from(result.stdout)), command, commandOptions, sourcePath: resource.rawLeafPath, sourceSha256: resource.flverSha256 });
  };
  for (const mesh of resource.meshes) await capture('read-flver-mesh', `${resource.id}-mesh${mesh.ordinal}.json`, { ...options, meshIndex: mesh.ordinal });
  await capture('read-flver-skeleton', `${resource.id}-skeleton.json`, {});
  await capture('read-flver-document', `${resource.id}-document.json`, {});
}
if (hash(await readFile(dll)) !== producerSha256) throw new Error('BRIDGE_PRODUCER_CHANGED_DURING_CAPTURE');
await writeFile(resolve(directory, 'observation-manifest.json'), JSON.stringify({ schemaVersion: 1, capturedAt: new Date().toISOString(), bridgeDllSha256: producerSha256, observations }, null, 2) + '\n');
console.log(JSON.stringify({ status: 'captured', bridgeDllSha256: producerSha256, observationCount: observations.length }));
