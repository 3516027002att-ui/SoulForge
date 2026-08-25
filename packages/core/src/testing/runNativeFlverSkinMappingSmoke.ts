/**
 * Narrow native FLVER skin-mapping regression.
 *
 * It first proves a real skinned mesh keeps its legal mapping, then mutates
 * the mapping metadata into an out-of-range palette and requires the
 * production Bridge path to fail closed with a structured diagnostic.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';

interface MeshData {
  boneIndicesBase64?: string;
  vertexCount: number;
}

function readI32(bytes: Buffer, offset: number): number {
  return bytes.readInt32LE(offset);
}

function meshTableOffset(bytes: Buffer, meshIndex: number): number {
  const skeletonTransformCount = readI32(bytes, 0x14);
  const materialCount = readI32(bytes, 0x18);
  const boneCount = readI32(bytes, 0x1c);
  return 0x80
    + skeletonTransformCount * 64
    + materialCount * 32
    + boneCount * 128
    + meshIndex * 48;
}

function firstMeshPalette(bytes: Buffer, meshIndex: number): { offset: number; count: number } | null {
  const meshCount = readI32(bytes, 0x20);
  for (let index = 0; index < meshCount; index++) {
    const meshOffset = meshTableOffset(bytes, index);
    const count = readI32(bytes, meshOffset + 0x14);
    const offset = readI32(bytes, meshOffset + 0x1c);
    if (index === meshIndex && count > 0 && offset >= 0 && offset + count * 4 <= bytes.length) {
      return { offset, count };
    }
  }
  return null;
}

async function main(): Promise<void> {
  const fixtureRoot = process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim()
    ?? process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim()
    ?? '';
  const registryConfigured = Boolean(process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY?.trim());
  if (!process.argv[2] && !fixtureRoot && !registryConfigured) {
    console.log(JSON.stringify({ ok: true, status: 'skipped', message: '未配置本机 Sekiro 根。' }));
    return;
  }
  const source = await resolveNativeFixture(
    process.argv[2] ?? (!registryConfigured && fixtureRoot
      ? join(fixtureRoot, 'mods', 'chr', 'c1020.chrbnd.dcx')
      : undefined),
    'chrbnd-primary',
    '../../mods/chr/c1020.chrbnd.dcx'
  );
  const tmp = join(tmpdir(), 'soulforge-flver-skin-mapping-smoke');
  mkdirSync(tmp, { recursive: true });
  const extracted = join(tmp, 'c1020.flver');
  const malformed = join(tmp, 'c1020-invalid-skin-palette.flver');

  try {
    const extractedResult = await runBridge<{ contentSize?: number }>({
      command: 'extract-bnd4-child',
      filePath: source,
      allowedRoots: [source.replace(/[/\\][^/\\]+$/, '')],
      writableRoots: [tmp],
      ...(fixtureRoot ? { oodleRuntimeRoot: fixtureRoot } : {}),
      commandOptions: { childPath: 'c1020.flver', outputPath: extracted },
      timeoutMs: 120_000
    });
    if (!extractedResult.data?.contentSize) {
      console.log(JSON.stringify({ ok: true, status: 'skipped', message: 'FLVER fixture not available.' }));
      return;
    }

    const document = await runBridge<{ meshCount: number; boneCount: number }>({
      command: 'read-flver-document',
      filePath: extracted,
      allowedRoots: [tmp],
      timeoutMs: 120_000
    });
    if (document.parseStatus === 'failed' || !document.data) {
      throw new Error(`FLVER document read failed: ${JSON.stringify(document.diagnostics)}`);
    }

    const bytes = readFileSync(extracted);
    let selectedMesh = -1;
    let selectedPalette: { offset: number; count: number } | null = null;
    for (let meshIndex = 0; meshIndex < document.data.meshCount; meshIndex++) {
      const mesh = await runBridge<MeshData>({
        command: 'read-flver-mesh',
        filePath: extracted,
        allowedRoots: [tmp],
        commandOptions: { meshIndex },
        timeoutMs: 120_000
      });
      if (mesh.parseStatus !== 'failed' && mesh.data?.boneIndicesBase64 && mesh.data.vertexCount > 0
        && firstMeshPalette(bytes, meshIndex)) {
        selectedMesh = meshIndex;
        selectedPalette = firstMeshPalette(bytes, meshIndex);
        break;
      }
    }
    if (selectedMesh < 0) {
      // 真实 Sekiro character FLVER 常使用 global bone indices，合法文件
      // 的 boneCountInMesh=0，因此不能把“没有 local palette”误报成失败。
      for (let meshIndex = 0; meshIndex < document.data.meshCount; meshIndex++) {
        const mesh = await runBridge<MeshData>({
          command: 'read-flver-mesh',
          filePath: extracted,
          allowedRoots: [tmp],
          commandOptions: { meshIndex },
          timeoutMs: 120_000
        });
        if (mesh.parseStatus !== 'failed' && mesh.data?.boneIndicesBase64 && mesh.data.vertexCount > 0) {
          selectedMesh = meshIndex;
          break;
        }
      }
    }
    if (selectedMesh < 0) {
      throw new Error('真实 FLVER 语料没有可验证的 skin mapping mesh。');
    }

    // 合法样本必须先通过，防止回归测试只覆盖失败路径。
    const valid = await runBridge<MeshData>({
      command: 'read-flver-mesh',
      filePath: extracted,
      allowedRoots: [tmp],
      commandOptions: { meshIndex: selectedMesh },
      timeoutMs: 120_000
    });
    if (valid.parseStatus === 'failed' || !valid.data?.boneIndicesBase64) {
      throw new Error(`合法 skin palette 被错误拒绝：${JSON.stringify(valid.diagnostics)}`);
    }

    const invalid = Buffer.from(bytes);
    let mutation: string;
    if (selectedPalette) {
      // 将 palette 中的全局骨骼索引改成恰好越界的值。
      invalid.writeInt32LE(document.data.boneCount, selectedPalette.offset);
      mutation = 'local-palette-global-index';
    } else {
      // 当前真实 character corpus 的合法编码是 global index。把 mesh 头的
      // palette count 改成超出全局骨骼数量，验证 parser 的 fail-closed 边界。
      invalid.writeInt32LE(document.data.boneCount + 1, meshTableOffset(bytes, selectedMesh) + 0x14);
      mutation = 'global-index-palette-count';
    }
    writeFileSync(malformed, invalid);

    const rejected = selectedPalette
      ? await runBridge<MeshData>({
        command: 'read-flver-mesh',
        filePath: malformed,
        allowedRoots: [tmp],
        commandOptions: { meshIndex: selectedMesh },
        timeoutMs: 120_000
      })
      : await runBridge<{ meshCount: number; boneCount: number }>({
        command: 'read-flver-document',
        filePath: malformed,
        allowedRoots: [tmp],
        timeoutMs: 120_000
      });
    if (rejected.parseStatus !== 'failed') {
      throw new Error(`越界 palette 未 fail-closed：${JSON.stringify(rejected)}`);
    }
    const codes = (rejected.diagnostics ?? []).map((diagnostic) => diagnostic.code);
    if (!codes.includes('FLVER_SKIN_INDEX_PALETTE_OUT_OF_RANGE')) {
      throw new Error(`越界 palette 缺少结构化诊断：${JSON.stringify(rejected.diagnostics)}`);
    }

    console.log(JSON.stringify({
      ok: true,
      status: selectedPalette ? 'verified' : 'partial',
      meshIndex: selectedMesh,
      boneCount: document.data.boneCount,
      legalMapping: selectedPalette ? 'local-palette' : 'global-index',
      malformedMapping: 'rejected',
      mutation,
      nonClaims: selectedPalette ? [] : ['本机 character corpus 使用 global bone indices，未提供 local palette positive sample。'],
      diagnosticCode: 'FLVER_SKIN_INDEX_PALETTE_OUT_OF_RANGE'
    }, null, 2));
  } finally {
    await disposeBridgeDaemonPool();
  }
}

main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
