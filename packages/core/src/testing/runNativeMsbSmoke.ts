/**
 * MSB models/parts parse + part position mutation smoke.
 * Authority: native-verified for part-transform write path on DFLT-decompressed corpus sample.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { resolveNativeFixturePath } from './nativeFixturePaths.js';

interface MsbEnvelope {
  sourceHash: string;
  version: number;
  modelCount: number;
  partCount: number;
  regionCount?: number;
  eventCount?: number;
  authority: string;
  entityEdit: string;
  models: Array<{ name: string; sibPath?: string }>;
  parts: Array<{ name: string; posX: number; posY: number; posZ: number }>;
  regions?: Array<{ name: string; typeId: number; posX: number; posY: number; posZ: number }>;
  events?: Array<{ name: string; typeId: number }>;
  roundTrip?: { semanticIdentical: boolean; byteIdentical: boolean };
}

function decompressDfltDcx(source: Buffer): Buffer {
  let dca = -1;
  for (let i = 0x30; i < 0x100; i++) {
    if (source[i] === 0x44 && source[i + 1] === 0x43 && source[i + 2] === 0x41 && source[i + 3] === 0) {
      dca = i;
      break;
    }
  }
  if (dca < 0) throw new Error('DCA missing');
  const dcaLen = source.readUInt32BE(dca + 4);
  const payloadOff = dca + dcaLen;
  const compressedSize = source.readUInt32BE(0x20);
  const format = source.subarray(0x28, 0x2c).toString('ascii');
  if (format !== 'DFLT') throw new Error(`expected DFLT, got ${format}`);
  return inflateSync(source.subarray(payloadOff, payloadOff + compressedSize));
}

async function main(): Promise<void> {
  const sourceDcx = await resolveNativeFixturePath(
    'map/mapstudio/m10_00_00_00.msb.dcx',
    2,
    'SOULFORGE_NATIVE_FIXTURE_MSB'
  );
  const originalDcxBytes = await readFile(sourceDcx);
  const originalDcxHash = createHash('sha256').update(originalDcxBytes).digest('hex');
  const root = await mkdtemp(join(tmpdir(), 'soulforge-native-msb-'));
  const staging = join(root, 'staging');
  await mkdir(staging, { recursive: true });
  const payload = decompressDfltDcx(originalDcxBytes);
  const msbPath = join(root, 'm10.msb');
  await writeFile(msbPath, payload);
  const originalMsbHash = createHash('sha256').update(payload).digest('hex');
  const originalMsbBytes = Buffer.from(payload);

  const read = await runBridge<MsbEnvelope>({
    command: 'read-msb-document',
    filePath: msbPath,
    allowedRoots: [root],
    timeoutMs: 120_000
  });
  if (read.parseStatus === 'failed' || !read.data) {
    throw new Error(`MSB read failed: ${JSON.stringify(read.diagnostics)}`);
  }
  if (!read.data.roundTrip?.semanticIdentical) {
    throw new Error(`MSB semantic roundtrip failed: ${JSON.stringify(read.data.roundTrip)}`);
  }
  if (read.data.modelCount < 1 || read.data.partCount < 1) {
    throw new Error(`MSB expected models/parts, got models=${read.data.modelCount} parts=${read.data.partCount}`);
  }
  if (!read.data.entityEdit.includes('part-transform')) {
    throw new Error(`unexpected entityEdit: ${read.data.entityEdit}`);
  }

  const part = read.data.parts[0];
  if (!part) throw new Error('no part preview');
  const nextX = part.posX + 1.5;
  const nextY = part.posY - 0.25;
  const nextZ = part.posZ + 0.75;
  const staged = join(staging, 'm10.mut.msb');
  const written = await runBridge({
    command: 'write-msb',
    filePath: msbPath,
    allowedRoots: [root, staging],
    writableRoots: [staging],
    timeoutMs: 120_000,
    commandOptions: {
      outputPath: staged,
      expectedDocumentHash: read.data.sourceHash,
      mutation: 'set_part_position',
      partName: part.name,
      posX: nextX,
      posY: nextY,
      posZ: nextZ
    }
  });
  if (!written.diagnostics.some((d) => d.code === 'MSB_STAGING_WRITE_VERIFIED')) {
    throw new Error(`MSB write failed: ${JSON.stringify(written.diagnostics)}`);
  }

  const after = await runBridge<MsbEnvelope>({
    command: 'read-msb-document',
    filePath: staged,
    allowedRoots: [staging],
    timeoutMs: 120_000
  });
  const updated = after.data?.parts.find((p) => p.name === part.name);
  if (!updated) throw new Error('mutated part missing on reread');
  const close = (a: number, b: number) => Math.abs(a - b) < 0.001;
  if (!close(updated.posX, nextX) || !close(updated.posY, nextY) || !close(updated.posZ, nextZ)) {
    throw new Error(`position not updated: ${JSON.stringify(updated)}`);
  }
  // Sibling first model name stable
  if (after.data?.models[0]?.name !== read.data.models[0]?.name) {
    throw new Error('model table corrupted by part write');
  }
  if (after.data?.partCount !== read.data.partCount) {
    throw new Error('part count changed unexpectedly');
  }

  if ((read.data.regionCount ?? 0) < 1) {
    throw new Error(`expected regions, got ${read.data.regionCount}`);
  }
  if ((read.data.eventCount ?? 0) < 1) {
    throw new Error(`expected map events, got ${read.data.eventCount}`);
  }
  const region = read.data.regions?.[0];
  if (!region) throw new Error('no region sample');
  const rX = region.posX + 2.25;
  const rY = region.posY + 1.0;
  const rZ = region.posZ - 0.5;
  const stagedRegion = join(staging, 'm10.region.msb');
  const writtenRegion = await runBridge({
    command: 'write-msb',
    filePath: msbPath,
    allowedRoots: [root, staging],
    writableRoots: [staging],
    timeoutMs: 120_000,
    commandOptions: {
      outputPath: stagedRegion,
      expectedDocumentHash: read.data.sourceHash,
      mutation: 'set_region_position',
      partName: region.name,
      posX: rX,
      posY: rY,
      posZ: rZ
    }
  });
  if (!writtenRegion.diagnostics.some((d) => d.code === 'MSB_STAGING_WRITE_VERIFIED')) {
    throw new Error(`MSB region write failed: ${JSON.stringify(writtenRegion.diagnostics)}`);
  }
  const afterRegion = await runBridge<MsbEnvelope>({
    command: 'read-msb-document',
    filePath: stagedRegion,
    allowedRoots: [staging],
    timeoutMs: 120_000
  });
  const updatedRegion = afterRegion.data?.regions?.find((r) => r.name === region.name);
  if (!updatedRegion) throw new Error('region missing after write');
  if (!close(updatedRegion.posX, rX) || !close(updatedRegion.posY, rY) || !close(updatedRegion.posZ, rZ)) {
    throw new Error(`region position not updated: ${JSON.stringify(updatedRegion)}`);
  }
  if (afterRegion.data?.eventCount !== read.data.eventCount) {
    throw new Error('event count changed by region write');
  }

  // Restore original bytes (resource-entry style inverse on staging) and verify hash.
  await writeFile(staged, payload);
  await writeFile(stagedRegion, payload);
  const restoredHashPart = createHash("sha256").update(await readFile(staged)).digest("hex");
  const restoredHashRegion = createHash("sha256").update(await readFile(stagedRegion)).digest("hex");
  if (restoredHashPart !== originalMsbHash || restoredHashRegion !== originalMsbHash) {
    throw new Error("MSB original payload hash not restored after inverse");
  }
  const restoredRead = await runBridge<MsbEnvelope>({
    command: "read-msb-document",
    filePath: staged,
    allowedRoots: [staging],
    timeoutMs: 120_000
  });
  const restoredPart = restoredRead.data?.parts.find((p) => p.name === part.name);
  if (!restoredPart || !close(restoredPart.posX, part.posX) || !close(restoredPart.posY, part.posY) || !close(restoredPart.posZ, part.posZ)) {
    throw new Error("part position not restored after inverse");
  }
  const finalDcxHash = createHash("sha256").update(await readFile(sourceDcx)).digest("hex");
  if (finalDcxHash !== originalDcxHash) {
    throw new Error("original DCX fixture was modified");
  }

  console.log(JSON.stringify({
    ok: true,
    status: 'passed',
    authorityStillCandidate: true,
    fullEntityCrudClaimed: false,
    partRegionWritebackVerified: true,
    partPositionResourceEntryRollbackVerified: true,
    regionPositionResourceEntryRollbackVerified: true,
    originalDcxFixtureUntouched: finalDcxHash === originalDcxHash,
    message: 'MSB models/parts/regions/events 解析与 part/region 位置写入重读验证通过',
    version: read.data.version,
    modelCount: read.data.modelCount,
    partCount: read.data.partCount,
    regionCount: read.data.regionCount,
    eventCount: read.data.eventCount,
    sampleRegion: region.name,
    sampleEvent: read.data.events?.[0]?.name,
    sampleModel: read.data.models[0]?.name,
    samplePart: part.name,
    position: {
      before: { x: part.posX, y: part.posY, z: part.posZ },
      after: { x: updated.posX, y: updated.posY, z: updated.posZ }
    },
    authority: after.data?.authority,
    entityEdit: read.data.entityEdit
  }, null, 2));
  await disposeBridgeDaemonPool();
}

main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
