/**
 * Open-format conversion smoke:
 * - real PNG/TGA decode → uncompressed DDS intermediate
 * - glTF/GLB structure-only candidate path (no FLVER claim)
 * - texture conversion writeback through PatchIR into isolated temp overlay
 * - mesh structure writeback must stay blocked
 */
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertOpenFormatAsset } from '../assets/openFormatConvert.js';
import { convertOpenFormatAndWriteback } from '../assets/openFormatConvertWriteback.js';
import { createSekiroOpenFormatAdapterPack } from '../assets/openFormatAdapterRules.js';
import { isDdsBuffer } from '../assets/pngToDds.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { createConfirmationReceipt } from '../patch/writerContract.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';

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

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function solidPng(r: number, g: number, b: number, a = 255): Buffer {
  const width = 2;
  const height = 2;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = 1 + width * 4;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const o = row + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function solidTgaBgra(): Buffer {
  const header = Buffer.alloc(18, 0);
  header[2] = 2;
  header.writeUInt16LE(2, 12);
  header.writeUInt16LE(2, 14);
  header[16] = 32;
  header[17] = 0x28;
  const px = Buffer.alloc(2 * 2 * 4);
  for (let i = 0; i < 4; i++) {
    px[i * 4 + 0] = 0x10;
    px[i * 4 + 1] = 0x20;
    px[i * 4 + 2] = 0x30;
    px[i * 4 + 3] = 0xff;
  }
  return Buffer.concat([header, px]);
}

function minimalGlb(options?: {
  materialName?: string;
  nodeName?: string;
  includeCollisionNode?: boolean;
}): Buffer {
  const materialName = options?.materialName ?? 'c_body';
  const nodeName = options?.nodeName ?? 'root';
  const nodes: Array<Record<string, unknown>> = [{ name: nodeName, mesh: 0 }];
  if (options?.includeCollisionNode) {
    nodes.push({ name: 'hkt_body', mesh: 0 });
  }
  const json = Buffer.from(
    JSON.stringify({
      asset: { version: '2.0', generator: 'soulforge-open-format-smoke' },
      scenes: [{ nodes: nodes.map((_, i) => i) }],
      nodes,
      materials: [{ name: materialName }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
      buffers: [{ byteLength: 36 }]
    }),
    'utf8'
  );
  const pad = (4 - (json.length % 4)) % 4;
  const jsonChunk = Buffer.concat([json, Buffer.alloc(pad, 0x20)]);
  const bin = Buffer.alloc(36, 0);
  const totalLength = 12 + 8 + jsonChunk.length + 8 + bin.length;
  const out = Buffer.alloc(totalLength);
  out.write('glTF', 0, 'ascii');
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(totalLength, 8);
  let o = 12;
  out.writeUInt32LE(jsonChunk.length, o);
  out.write('JSON', o + 4, 'ascii');
  jsonChunk.copy(out, o + 8);
  o += 8 + jsonChunk.length;
  out.writeUInt32LE(bin.length, o);
  out.write('BIN\0', o + 4, 'ascii');
  bin.copy(out, o + 8);
  return out;
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-open-format-convert-'));
  const staging = join(root, 'staging');
  const overlay = join(root, 'mod');
  await mkdir(join(overlay, 'parts', 'tex'), { recursive: true });
  await mkdir(staging, { recursive: true });

  const png = solidPng(0x30, 0x20, 0x10);
  const sekiroPack = createSekiroOpenFormatAdapterPack();
  const pngConv = await convertOpenFormatAsset({
    sourcePath: join(root, 'a.png'),
    sourceBytes: png,
    targetAssetUri: 'soulforge://parts/tex/a.dds',
    conversionRuleId: 'open-format.png.to-dds',
    stagingRoot: staging,
    adapterPack: sekiroPack
  });
  if (!pngConv.ok || pngConv.plan.authority !== 'candidate' || pngConv.plan.conversionKind !== 'texture-rgba-to-dds') {
    throw new Error(`PNG convert failed: ${JSON.stringify(pngConv.diagnostics)}`);
  }
  if (!pngConv.stagingPath || !isDdsBuffer(await readFile(pngConv.stagingPath))) {
    throw new Error('PNG convert did not emit DDS');
  }
  if (!pngConv.dds || pngConv.dds.width !== 2 || pngConv.dds.height !== 2) {
    throw new Error(`PNG convert dimensions wrong: ${JSON.stringify(pngConv.dds)}`);
  }
  if (!pngConv.plan.notes.some((n) => n.includes('adapterTextureRule=sekiro.tex.png-tga.albedo'))) {
    throw new Error(`PNG convert missing adapter rule note: ${JSON.stringify(pngConv.plan.notes)}`);
  }
  assertRegisteredValidators(pngConv.plan.requiredValidators, 'pngConv');

  // Oversized path must fail-closed when adapter pack is provided.
  // solidPng is 2x2; synthesize a rule-bound failure via a pack with tiny max dims.
  const tinyPack = {
    ...sekiroPack,
    packId: 'sekiro.open-format.tiny-test',
    textureRules: sekiroPack.textureRules.map((r) =>
      r.sourceKinds.includes('png') ? { ...r, maxWidth: 1, maxHeight: 1 } : r
    )
  };
  const pngOversized = await convertOpenFormatAsset({
    sourcePath: join(root, 'oversized.png'),
    sourceBytes: png,
    targetAssetUri: 'soulforge://parts/tex/oversized.dds',
    conversionRuleId: 'open-format.png.to-dds',
    stagingRoot: staging,
    adapterPack: tinyPack
  });
  if (pngOversized.ok) {
    throw new Error('oversized PNG with tiny adapter pack must fail-closed');
  }
  if (!pngOversized.diagnostics.some((d) => d.code === 'OPEN_FORMAT_ADAPTER_TEXTURE_SIZE')) {
    throw new Error(`expected OPEN_FORMAT_ADAPTER_TEXTURE_SIZE: ${JSON.stringify(pngOversized.diagnostics)}`);
  }

  const tga = solidTgaBgra();
  const tgaConv = await convertOpenFormatAsset({
    sourcePath: join(root, 'b.tga'),
    sourceBytes: tga,
    targetAssetUri: 'soulforge://parts/tex/b.dds',
    conversionRuleId: 'open-format.tga.to-dds',
    stagingRoot: staging
  });
  if (!tgaConv.ok || tgaConv.plan.conversionKind !== 'texture-rgba-to-dds') {
    throw new Error(`TGA convert failed: ${JSON.stringify(tgaConv.diagnostics)}`);
  }
  if (!tgaConv.stagingPath || !isDdsBuffer(await readFile(tgaConv.stagingPath))) {
    throw new Error('TGA convert did not emit DDS');
  }
  assertRegisteredValidators(tgaConv.plan.requiredValidators, 'tgaConv');

  const glb = minimalGlb({ materialName: 'c_body', includeCollisionNode: true });
  const glbConv = await convertOpenFormatAsset({
    sourcePath: join(root, 'c.glb'),
    sourceBytes: glb,
    targetAssetUri: 'soulforge://chr/c0000.flver',
    conversionRuleId: 'open-format.glb.structure',
    stagingRoot: staging,
    adapterPack: sekiroPack
  });
  if (!glbConv.ok || glbConv.plan.conversionKind !== 'mesh-structure-probe-only') {
    throw new Error(`GLB convert failed: ${JSON.stringify(glbConv.diagnostics)}`);
  }
  if (glbConv.plan.authority !== 'candidate' || !glbConv.gltf || glbConv.gltf.meshCount < 1) {
    throw new Error(`GLB structure authority/mesh unexpected: ${JSON.stringify(glbConv.gltf)}`);
  }
  if (glbConv.dds) {
    throw new Error('GLB structure path must not claim DDS texture conversion');
  }
  if (glbConv.plan.requiredValidators.length !== 0) {
    throw new Error(
      `mesh structure-only plan must not claim write validators: ${JSON.stringify(glbConv.plan.requiredValidators)}`
    );
  }
  if (!glbConv.diagnostics.some((d) => d.code === 'OPEN_FORMAT_ADAPTER_MATERIAL_MAPPED')) {
    throw new Error(`expected material mapped diagnostic: ${JSON.stringify(glbConv.diagnostics)}`);
  }
  if (!glbConv.diagnostics.some((d) => d.code === 'OPEN_FORMAT_ADAPTER_COLLISION_MAPPED')) {
    throw new Error(`expected collision mapped diagnostic: ${JSON.stringify(glbConv.diagnostics)}`);
  }

  const glbUnmapped = await convertOpenFormatAsset({
    sourcePath: join(root, 'c-unmapped.glb'),
    sourceBytes: minimalGlb({ materialName: 'totally_unknown_mat' }),
    targetAssetUri: 'soulforge://chr/c0000.flver',
    conversionRuleId: 'open-format.glb.structure',
    stagingRoot: staging,
    adapterPack: sekiroPack
  });
  if (glbUnmapped.ok) {
    throw new Error('unmapped GLB material must fail-closed when adapter pack provided');
  }
  if (!glbUnmapped.diagnostics.some((d) => d.code === 'OPEN_FORMAT_ADAPTER_MATERIAL_UNMAPPED')) {
    throw new Error(
      `expected OPEN_FORMAT_ADAPTER_MATERIAL_UNMAPPED: ${JSON.stringify(glbUnmapped.diagnostics)}`
    );
  }

  // Collision node present but unmapped must fail-closed (no auto-guess).
  const glbColUnmapped = await convertOpenFormatAsset({
    sourcePath: join(root, 'col-unmapped.glb'),
    sourceBytes: minimalGlb({
      materialName: 'c_body',
      nodeName: 'collider_unmapped_01',
      includeCollisionNode: false
    }),
    // Force a collision-like node name that does not match pack rules:
    // rebuild with an explicit unmapped collision-ish name.
    targetAssetUri: 'soulforge://chr/c0000.flver',
    conversionRuleId: 'open-format.glb.structure',
    stagingRoot: staging,
    adapterPack: sekiroPack
  });
  // root node "weird_col_node" is not a collision prefix — mapping is only
  // required for names that look like collision OR when pack is applied to all
  // node names. Current gate checks every node name fail-closed; unmapped node
  // names therefore fail. Assert that behavior.
  if (glbColUnmapped.ok) {
    throw new Error('unmapped glTF node name must fail-closed under adapter pack');
  }
  if (!glbColUnmapped.diagnostics.some((d) => d.code === 'OPEN_FORMAT_ADAPTER_COLLISION_UNMAPPED')) {
    throw new Error(
      `expected OPEN_FORMAT_ADAPTER_COLLISION_UNMAPPED: ${JSON.stringify(glbColUnmapped.diagnostics)}`
    );
  }

  // New hitbox-style unmapped collision name must also fail-closed under convert.
  const glbHitboxUnmapped = await convertOpenFormatAsset({
    sourcePath: join(root, 'hitbox-unmapped.glb'),
    sourceBytes: minimalGlb({
      materialName: 'c_body',
      nodeName: 'enemy_hitbox_unmapped',
      includeCollisionNode: false
    }),
    targetAssetUri: 'soulforge://chr/c0000.flver',
    conversionRuleId: 'open-format.glb.structure',
    stagingRoot: staging,
    adapterPack: {
      ...sekiroPack,
      // Drop hitbox rule so convert path proves fail-closed for looksCollision names.
      collisionNodeRules: sekiroPack.collisionNodeRules.filter(
        (rule) => rule.ruleId !== 'sekiro.col.includes_hitbox'
      )
    }
  });
  if (glbHitboxUnmapped.ok) {
    throw new Error('unmapped hitbox-like collision node must fail-closed under adapter pack');
  }
  if (!glbHitboxUnmapped.diagnostics.some((d) => d.code === 'OPEN_FORMAT_ADAPTER_COLLISION_UNMAPPED')) {
    throw new Error(
      `expected OPEN_FORMAT_ADAPTER_COLLISION_UNMAPPED for hitbox: ${JSON.stringify(glbHitboxUnmapped.diagnostics)}`
    );
  }

  // Mapped n_col_ / endsWith _col collision nodes succeed with candidate pack.
  const glbColMapped = await convertOpenFormatAsset({
    sourcePath: join(root, 'col-mapped.glb'),
    sourceBytes: minimalGlb({
      materialName: 'c_cloak',
      nodeName: 'n_col_torso',
      includeCollisionNode: false
    }),
    targetAssetUri: 'soulforge://chr/c0000.flver',
    conversionRuleId: 'open-format.glb.structure',
    stagingRoot: staging,
    adapterPack: sekiroPack
  });
  if (!glbColMapped.ok || glbColMapped.plan.authority !== 'candidate') {
    throw new Error(`mapped n_col_ GLB convert failed: ${JSON.stringify(glbColMapped.diagnostics)}`);
  }
  if (!glbColMapped.plan.notes.some((n) => n.includes('sekiro.col.n_col_'))) {
    throw new Error(`expected n_col_ rule note: ${JSON.stringify(glbColMapped.plan.notes)}`);
  }

  // structure.ok gate: missing asset.version must fail convert (not stage-only soft pass)
  const badGltfConv = await convertOpenFormatAsset({
    sourcePath: join(root, 'bad.gltf'),
    sourceBytes: Buffer.from(JSON.stringify({ meshes: [{ primitives: [{}] }] }), 'utf8'),
    targetAssetUri: 'soulforge://chr/bad.flver',
    conversionRuleId: 'open-format.gltf.structure',
    stagingRoot: staging
  });
  if (badGltfConv.ok) {
    throw new Error('glTF without asset.version must fail via structure.ok gate');
  }
  if (!badGltfConv.diagnostics.some((d) => String(d.code) === 'GLTF_ASSET_VERSION_MISSING'
    || String(d.code) === 'OPEN_FORMAT_GLTF_STRUCTURE_REJECTED')) {
    throw new Error(`expected structure reject diagnostics, got ${JSON.stringify(badGltfConv.diagnostics)}`);
  }

  const targetPath = join(overlay, 'parts', 'tex', 'from-png.dds');
  await writeFile(targetPath, Buffer.from('OLD_DDS_PLACEHOLDER'));
  const session = await openWorkspaceSession({ overlayRoot: overlay, stagingRoot: staging });
  const receipt = createConfirmationReceipt({
    subjects: ['asset-import-writeback', targetPath],
    riskLevel: 'high',
    note: 'open-format convert writeback smoke'
  });
  const opLog = new MemoryOperationLogStore();

  const wb = await convertOpenFormatAndWriteback(
    {
      sourcePath: join(root, 'wb.png'),
      sourceBytes: png,
      targetAssetUri: 'file://parts/tex/from-png.dds',
      conversionRuleId: 'open-format.png.to-dds',
      stagingRoot: staging,
      workspaceId: session.meta.workspaceId,
      targetAbsolutePath: targetPath,
      expectedTargetHash: sha(Buffer.from('OLD_DDS_PLACEHOLDER')),
      confirmationReceiptId: receipt.id,
      title: 'open-format PNG→DDS writeback smoke'
    },
    {
      session,
      workspaceRoot: overlay,
      operationLog: opLog,
      actorId: 'open-format-convert-smoke'
    }
  );
  if (!wb.ok || !wb.opId || !wb.contentHash) {
    throw new Error(`writeback failed: ${JSON.stringify(wb.diagnostics)}`);
  }
  const after = await readFile(targetPath);
  if (!isDdsBuffer(after) || sha(after) !== wb.contentHash) {
    throw new Error('writeback reread hash/magic mismatch');
  }

  const blocked = await convertOpenFormatAndWriteback(
    {
      sourcePath: join(root, 'mesh.glb'),
      sourceBytes: glb,
      targetAssetUri: 'soulforge://chr/c0000.flver',
      conversionRuleId: 'open-format.glb.structure',
      stagingRoot: staging,
      workspaceId: session.meta.workspaceId,
      targetAbsolutePath: join(overlay, 'parts', 'tex', 'nope.dds'),
      expectedTargetHash: sha(Buffer.from('x')),
      confirmationReceiptId: receipt.id
    },
    {
      session,
      workspaceRoot: overlay,
      operationLog: opLog,
      actorId: 'open-format-convert-smoke'
    }
  );
  if (blocked.ok) {
    throw new Error('mesh structure path must not writeback as native asset');
  }
  if (!blocked.diagnostics.some((d) => d.code === 'OPEN_FORMAT_WRITEBACK_STRUCTURE_ONLY')) {
    throw new Error(`expected structure-only block: ${JSON.stringify(blocked.diagnostics)}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        message: 'open-format conversion + PatchIR writeback smoke passed',
        pngAuthority: pngConv.plan.authority,
        pngConversionKind: pngConv.plan.conversionKind,
        pngAdapterRuleGated: true,
        pngOversizedFailClosed: true,
        tgaAuthority: tgaConv.plan.authority,
        glbAuthority: glbConv.plan.authority,
        glbMeshCount: glbConv.gltf?.meshCount ?? 0,
        glbAdapterMaterialCollisionGated: true,
        glbUnmappedMaterialFailClosed: true,
        glbUnmappedCollisionFailClosed: true,
        glbHitboxUnmappedFailClosed: true,
        glbMappedNColOk: true,
        writebackOpId: wb.opId,
        writebackHash: wb.contentHash,
        structureWritebackBlocked: true,
        noGameRootWrite: true
      },
      null,
      2
    )
  );
}

/** Plan-level requiredValidators must only name registered ValidatorContract ids. */
function assertRegisteredValidators(ids: readonly string[], label: string): void {
  const allowed = new Set(['whole_file_replace', 'file_risk', 'workspace_boundary', 'raw_file', 'text_file']);
  for (const id of ids) {
    if (!allowed.has(id)) {
      throw new Error(`${label}: unregistered requiredValidator id "${id}"`);
    }
  }
  if (!ids.includes('whole_file_replace') || !ids.includes('file_risk')) {
    throw new Error(`${label}: texture writeback plan must require whole_file_replace + file_risk`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
