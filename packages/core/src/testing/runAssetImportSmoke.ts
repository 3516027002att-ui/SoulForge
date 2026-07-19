/**
 * Asset import staging smoke.
 * Covers PNG/TGA/GLB/DDS staging, glTF structure reject paths, and magic gates.
 * No overlay write.
 */
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planAssetImport, stageAssetImport } from '../assets/assetImport.js';
import { encodeRawRgba8ToDds } from '../assets/pngToDds.js';

function sha(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function minimalPng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.from([0x00, 0xff, 0x00, 0x00]);
  const idat = deflateSync(raw);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function minimalGlb(jsonObj: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(jsonObj), 'utf8');
  const pad = (4 - (json.length % 4)) % 4;
  const jsonChunk = Buffer.concat([json, Buffer.alloc(pad, 0x20)]);
  const total = 12 + 8 + jsonChunk.length;
  const out = Buffer.alloc(total);
  out.write('glTF', 0, 'ascii');
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonChunk.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jsonChunk.copy(out, 20);
  return out;
}

function uncompressedTga(
  width: number,
  height: number,
  bpp: 24 | 32,
  pixelBytes: Buffer
): Buffer {
  const header = Buffer.alloc(18, 0);
  header[2] = 2;
  header.writeUInt16LE(width, 12);
  header.writeUInt16LE(height, 14);
  header[16] = bpp;
  header[17] = bpp === 32 ? 0x08 : 0x00;
  return Buffer.concat([header, pixelBytes]);
}

/** Plan-level requiredValidators must only name registered ValidatorContract ids. */
function assertRegisteredValidators(ids: readonly string[], label: string): void {
  const allowed = new Set([
    'whole_file_replace',
    'file_risk',
    'workspace_boundary',
    'raw_file',
    'text_file'
  ]);
  for (const id of ids) {
    if (!allowed.has(id)) {
      throw new Error(`${label}: unregistered requiredValidator id "${id}"`);
    }
  }
  if (!ids.includes('whole_file_replace') || !ids.includes('file_risk')) {
    throw new Error(
      `${label}: import plan must require whole_file_replace + file_risk (writeback authority)`
    );
  }
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-asset-import-'));
  const stagingRoot = join(root, 'staging');
  const sourceDir = join(root, 'source');
  await mkdir(sourceDir, { recursive: true });
  await mkdir(stagingRoot, { recursive: true });

  const badPlan = planAssetImport({
    sourcePath: join(sourceDir, 'mesh.fbx'),
    targetAssetUri: 'soulforge://import/mesh.fbx',
    conversionRuleId: 'open-format.fbx.stage',
    stagingRoot
  });
  if (badPlan.ok || !badPlan.diagnostics.some((d) => d.code === 'ASSET_IMPORT_FORMAT_UNSUPPORTED')) {
    throw new Error('FBX must be rejected');
  }

  const results: Array<Record<string, unknown>> = [];

  const png = minimalPng();
  const pngPath = join(sourceDir, 'pixel.png');
  await writeFile(pngPath, png);
  const pngStaged = await stageAssetImport({
    sourcePath: pngPath,
    targetAssetUri: 'soulforge://import/png/pixel.png',
    conversionRuleId: 'open-format.png.stage',
    stagingRoot
  });
  if (!pngStaged.ok) throw new Error(`PNG stage failed: ${JSON.stringify(pngStaged.diagnostics)}`);
  assertRegisteredValidators(pngStaged.plan.requiredValidators, 'png stage');
  const stagedPng = await readFile(pngStaged.stagingPath);
  if (!stagedPng.equals(png) || pngStaged.contentHash !== sha(png)) {
    throw new Error('staged PNG bytes/hash mismatch');
  }
  if (
    pngStaged.stagingManifest.textureMeta?.width !== 1 ||
    pngStaged.stagingManifest.textureMeta?.height !== 1
  ) {
    throw new Error(
      `png textureMeta missing: ${JSON.stringify(pngStaged.stagingManifest.textureMeta)}`
    );
  }
  results.push({
    format: 'png',
    ok: true,
    hash: pngStaged.contentHash,
    requiredValidators: pngStaged.plan.requiredValidators
  });

  const tgaPixelBytes = Buffer.from([0x00, 0x00, 0xff, 0xff]); // BGRA red
  const tga = uncompressedTga(1, 1, 32, tgaPixelBytes);
  const tgaPath = join(sourceDir, 'pixel.tga');
  await writeFile(tgaPath, tga);
  const tgaStaged = await stageAssetImport({
    sourcePath: tgaPath,
    targetAssetUri: 'soulforge://import/tga/pixel.tga',
    conversionRuleId: 'open-format.tga.stage',
    stagingRoot
  });
  if (!tgaStaged.ok) throw new Error(`TGA stage failed: ${JSON.stringify(tgaStaged.diagnostics)}`);
  assertRegisteredValidators(tgaStaged.plan.requiredValidators, 'tga stage');
  results.push({
    format: 'tga',
    ok: true,
    hash: tgaStaged.contentHash,
    bpp: tgaStaged.stagingManifest.textureMeta?.bpp
  });

  const glb = minimalGlb({
    asset: { version: '2.0', generator: 'soulforge-smoke' },
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ componentType: 5126, count: 3, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    buffers: [{ byteLength: 36 }]
  });
  const glbPath = join(sourceDir, 'mesh.glb');
  await writeFile(glbPath, glb);
  const glbStaged = await stageAssetImport({
    sourcePath: glbPath,
    targetAssetUri: 'soulforge://import/glb/mesh.glb',
    conversionRuleId: 'open-format.glb.stage',
    stagingRoot
  });
  if (!glbStaged.ok) throw new Error(`GLB stage failed: ${JSON.stringify(glbStaged.diagnostics)}`);
  assertRegisteredValidators(glbStaged.plan.requiredValidators, 'glb stage');
  const glbStructure = glbStaged.stagingManifest.structure;
  if (!glbStructure || !glbStructure.ok || glbStructure.meshCount < 1) {
    throw new Error(`GLB structure.ok expected true: ${JSON.stringify(glbStructure)}`);
  }
  results.push({
    format: 'glb',
    ok: true,
    meshCount: glbStructure.meshCount,
    structureOk: glbStructure.ok
  });

  const dds = encodeRawRgba8ToDds({
    width: 1,
    height: 1,
    rgba: Buffer.from([0xff, 0x00, 0x00, 0xff])
  }).dds;
  const ddsPath = join(sourceDir, 'pixel.dds');
  await writeFile(ddsPath, dds);
  const ddsStaged = await stageAssetImport({
    sourcePath: ddsPath,
    targetAssetUri: 'soulforge://import/dds/pixel.dds',
    conversionRuleId: 'open-format.dds.stage',
    stagingRoot
  });
  if (!ddsStaged.ok) throw new Error(`DDS stage failed: ${JSON.stringify(ddsStaged.diagnostics)}`);
  assertRegisteredValidators(ddsStaged.plan.requiredValidators, 'dds stage');
  results.push({ format: 'dds', ok: true, hash: ddsStaged.contentHash });

  // Reject: bad GLB length
  const badGlbBytes = Buffer.alloc(20, 0);
  badGlbBytes.write('glTF', 0, 'ascii');
  badGlbBytes.writeUInt32LE(2, 4);
  badGlbBytes.writeUInt32LE(999, 8);
  const badGlb = await stageAssetImport({
    sourcePath: join(sourceDir, 'bad.glb'),
    sourceBytes: badGlbBytes,
    targetAssetUri: 'soulforge://import/glb/bad.glb',
    conversionRuleId: 'open-format.glb.stage',
    stagingRoot
  });
  if (badGlb.ok) throw new Error('bad GLB length should be rejected');

  // Reject: glTF missing asset.version / asset object
  const badGltf = await stageAssetImport({
    sourcePath: join(sourceDir, 'bad.gltf'),
    sourceBytes: Buffer.from(JSON.stringify({ meshes: [] }), 'utf8'),
    targetAssetUri: 'soulforge://import/gltf/bad.gltf',
    conversionRuleId: 'open-format.gltf.stage',
    stagingRoot
  });
  const badGltfCodes = new Set(badGltf.diagnostics.map((d) => String(d.code)));
  const structureReject =
    badGltfCodes.has('GLTF_ASSET_MISSING') ||
    badGltfCodes.has('GLTF_ASSET_VERSION_MISSING') ||
    badGltfCodes.has('GLTF_VERSION_UNSUPPORTED');
  if (badGltf.ok || !structureReject) {
    throw new Error(
      `glTF without asset.version must fail structure probe: ${JSON.stringify(badGltf.diagnostics)}`
    );
  }

  // Reject: tiny TGA
  const tinyTga = await stageAssetImport({
    sourcePath: join(sourceDir, 'tiny.tga'),
    sourceBytes: Buffer.alloc(10, 0),
    targetAssetUri: 'soulforge://import/tga/tiny.tga',
    conversionRuleId: 'open-format.tga.stage',
    stagingRoot
  });
  if (tinyTga.ok) throw new Error('tiny TGA should be rejected');

  // Reject: magic mismatch
  const wrong = await stageAssetImport({
    sourcePath: join(sourceDir, 'fake.png'),
    sourceBytes: Buffer.from('not-a-png-file-content'),
    targetAssetUri: 'soulforge://import/png/fake.png',
    conversionRuleId: 'open-format.png.stage',
    stagingRoot
  });
  if (wrong.ok || !wrong.diagnostics.some((d) => d.code === 'ASSET_IMPORT_MAGIC_MISMATCH')) {
    throw new Error('PNG magic mismatch must fail');
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        message: 'open-format asset import staging smoke passed',
        staged: results,
        rejectedBadGlb: true,
        rejectedBadGltfStructure: true,
        rejectedTinyTga: true,
        rejectedBadMagic: true,
        noOverlayWrite: true
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
