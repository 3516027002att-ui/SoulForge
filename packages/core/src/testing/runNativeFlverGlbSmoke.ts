// Native smoke: export a real Sekiro FLVER to GLB and verify the container/JSON structure.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { exportFlverToGlb } from '../export/flverToGlb.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

async function main(): Promise<void> {
  const source = await resolveNativeFixture(
    process.argv[2],
    'chrbnd-primary',
    '../../mods/chr/c1020.chrbnd.dcx'
  );

  const tmp = mkdtempSync(join(tmpdir(), 'soulforge-native-flver-glb-'));
  try {
    const out = join(tmp, 'c1020.flver');
    const extract = await runBridge<Record<string, unknown>>({
      command: 'extract-bnd4-child',
      filePath: source,
      allowedRoots: [resolve(source, '..')],
      writableRoots: [tmp],
      commandOptions: { childPath: 'c1020.flver', outputPath: out },
      timeoutMs: 120_000
    });
    if (extract.parseStatus === 'failed' || !extract.data) {
      throw new Error(`FLVER 提取失败：${JSON.stringify(extract.diagnostics)}`);
    }

    const glbPath = join(tmp, 'c1020.glb');
    const result = await exportFlverToGlb(out, glbPath, [tmp], [tmp], { timeoutMs: 120_000 });
    if (result.exportedMeshes <= 0) throw new Error('GLB 导出未包含任何网格。');

    // Verify the GLB container.
    const glb = readFileSync(glbPath);
    const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('GLB magic 无效。');
    if (view.getUint32(4, true) !== 2) throw new Error('GLB 版本非 2。');
    if (view.getUint32(8, true) !== glb.byteLength) throw new Error('GLB 总长度字段不匹配。');

    // Parse the JSON chunk.
    const jsonLen = view.getUint32(12, true);
    if (view.getUint32(16, true) !== CHUNK_JSON) throw new Error('JSON chunk 类型无效。');
    const jsonText = new TextDecoder().decode(glb.subarray(20, 20 + jsonLen));
    const json = JSON.parse(jsonText) as {
      asset: { version: string };
      meshes: unknown[];
      accessors: unknown[];
      buffers: Array<{ byteLength: number }>;
    };
    if (json.asset.version !== '2.0') throw new Error('glTF asset 版本非 2.0。');
    if (json.meshes.length !== result.exportedMeshes) {
      throw new Error(`GLB 网格数 ${json.meshes.length} 与导出数 ${result.exportedMeshes} 不一致。`);
    }

    // Verify the BIN chunk follows and matches the declared buffer length.
    const binHeaderOffset = 20 + jsonLen;
    const binLen = view.getUint32(binHeaderOffset, true);
    if (view.getUint32(binHeaderOffset + 4, true) !== CHUNK_BIN) throw new Error('BIN chunk 类型无效。');
    if ((json.buffers[0]?.byteLength ?? -1) !== binLen) throw new Error('BIN 长度与 buffer 声明不一致。');

    console.log(JSON.stringify({
      ok: true,
      message: `FLVER → GLB 导出验证通过（${result.exportedMeshes}/${result.meshCount} 网格，${result.byteLength} 字节）`,
      meshCount: result.meshCount,
      exportedMeshes: result.exportedMeshes,
      glbBytes: result.byteLength,
      accessorCount: json.accessors.length,
      binBytes: binLen,
      authority: 'candidate'
    }, null, 2));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    await disposeBridgeDaemonPool();
  }
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (/native fixture 不可用/.test(message)) {
    console.log(JSON.stringify({
      ok: true,
      skipped: true,
      message: 'FLVER GLB 导出 smoke 跳过（需要真实只狼 fixture）',
      authority: 'candidate'
    }, null, 2));
    await disposeBridgeDaemonPool();
    return;
  }
  console.log(JSON.stringify({ ok: false, message, authority: 'candidate' }, null, 2));
  await disposeBridgeDaemonPool();
  process.exitCode = 1;
});
