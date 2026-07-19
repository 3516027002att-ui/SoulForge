/**
 * Has-game MSB scene asset inventory smoke.
 * Reads real MSB via bridge from registry fixture and builds candidate inventory.
 * No FLVER parse claim. Game root remains read-only.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { disposeBridgeDaemonPool, runBridge } from '../bridge/runBridge.js';
import { buildMsbSceneManifest } from '../scene/msbSceneManifest.js';
import { buildSceneAssetInventory, buildSceneAssetInventoryFromMsbDocument } from '../scene/sceneAssetInventory.js';
import { resolveNativeFixturePath } from './nativeFixturePaths.js';

interface MsbEnvelope {
  sourceHash: string;
  modelCount: number;
  partCount: number;
  authority: string;
  models: Array<{ name: string; sibPath?: string }>;
  parts: Array<{ name: string; posX: number; posY: number; posZ: number; modelName?: string }>;
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
  const rootEnv = process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim() || process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim() || '';
  const regEnv = process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY?.trim() || '';
  if (!rootEnv || !regEnv) {
    const allowSkip = process.argv.includes('--allow-skip') || process.env.SOULFORGE_ALLOW_SKIP === '1';
    console.log(JSON.stringify({
      ok: allowSkip,
      status: allowSkip ? 'skipped' : 'blocked',
      code: 'HAS_GAME_SCENE_INVENTORY_ENV_REQUIRED',
      message: '需要 SOULFORGE_NATIVE_FIXTURE_ROOT/SEKIRO_GAME_ROOT + SOULFORGE_NATIVE_FIXTURE_REGISTRY'
    }, null, 2));
    process.exitCode = allowSkip ? 0 : 2;
    return;
  }
  const sourceDcx = await resolveNativeFixturePath(
    'map/mapstudio/m11_00_00_00.msb.dcx',
    2,
    'SOULFORGE_NATIVE_FIXTURE_MSB'
  );
  const originalDcx = await readFile(sourceDcx);
  const root = await mkdtemp(join(tmpdir(), "soulforge-scene-inv-"));
  try {
    const msbPath = join(root, "map.msb");
    await writeFile(msbPath, decompressDfltDcx(originalDcx));
    const read = await runBridge<{
      models: Array<{ name: string; sibPath?: string }>;
      parts: Array<{ name: string; posX: number; posY: number; posZ: number }>;
      modelCount: number;
      partCount: number;
      authority: string;
    }>({
      command: 'read-msb-document',
      filePath: msbPath,
      allowedRoots: [root],
      timeoutMs: 120_000
    });
    if (read.parseStatus === "failed" || !read.data) throw new Error(JSON.stringify(read.diagnostics));
    const mapUri = "soulforge://sekiro/overlay/map/mapstudio/m11_00_00_00.msb";
    const inventory = buildSceneAssetInventoryFromMsbDocument({
      mapResourceUri: mapUri,
      models: read.data.models,
      parts: read.data.parts
    });
    if (inventory.partCount < 1) throw new Error("expected parts");
    if (inventory.modelCount < 1) throw new Error("expected models");
    if (inventory.assets.length < inventory.modelCount) throw new Error("assets undercounted");
    if (inventory.assets.some((a) => a.authority !== "candidate")) throw new Error("authority must stay candidate");
    if (inventory.assets.some((a) => /^[a-zA-Z]:/.test(a.resourceLabel) || a.resourceLabel.startsWith("Users/") || a.resourceLabel.includes("/Users/"))) {
      throw new Error("absolute path leaked into inventory labels");
    }
    const after = await readFile(sourceDcx);
    if (after.length !== originalDcx.length || !after.equals(originalDcx)) {
      throw new Error("game fixture mutated");
    }
    console.log(JSON.stringify({
      ok: true,
      status: "passed",
      message: "has-game MSB scene inventory candidate list verified",
      partCount: inventory.partCount,
      modelCount: inventory.modelCount,
      assetCount: inventory.assets.length,
      materialCandidates: inventory.assets.filter((a) => a.kind === "material").length,
      sample: inventory.assets.slice(0, 6).map((a) => ({ id: a.assetId, kind: a.kind, refs: a.referencedByPartCount })),
      bridgeModelCount: read.data.modelCount,
      bridgePartCount: read.data.partCount,
      originalFixtureUntouched: true
    }, null, 2));
  } finally {
    await disposeBridgeDaemonPool();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
