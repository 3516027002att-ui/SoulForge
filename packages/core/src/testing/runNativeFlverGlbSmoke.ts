// Native smoke: export real Sekiro FLVERs to GLB and verify container/JSON structure
// across the multi-sample matrix (all parseable chrbnd inner FLVERs).
import { mkdtempSync, readFileSync, rmSync, readdirSync, existsSync, accessSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { exportFlverToGlb } from '../export/flverToGlb.js';

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

function fixtureRoot(): string {
  return process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim()
    ?? process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim()
    ?? '';
}

interface ExportReport {
  id: string;
  meshCount: number;
  exportedMeshes: number;
  glbBytes: number;
  u32IndexMeshes: number;
  accessorCount: number;
  binBytes: number;
}

async function exportOne(root: string, tmp: string, id: string): Promise<ExportReport> {
  const chrDir = join(root, 'mods', 'chr');
  const container = join(chrDir, `${id}.chrbnd.dcx`);
  if (!existsSync(container)) throw new Error(`chrbnd container missing: ${container}`);
  const out = join(tmp, `${id}.flver`);
  const extract = await runBridge<Record<string, unknown>>({
    command: 'extract-bnd4-child',
    filePath: container,
    allowedRoots: [chrDir],
    writableRoots: [tmp],
    oodleRuntimeRoot: root,
    commandOptions: { childPath: `${id}.flver`, outputPath: out },
    timeoutMs: 180_000
  });
  if (extract.parseStatus === 'failed' || !extract.data) {
    throw new Error(`FLVER 提取失败 ${id}: ${JSON.stringify(extract.diagnostics)}`);
  }

  const glbPath = join(tmp, `${id}.glb`);
  const result = await exportFlverToGlb(out, glbPath, [tmp], [tmp], { timeoutMs: 180_000 });
  if (result.exportedMeshes <= 0) throw new Error(`GLB 导出未包含任何网格：${id}`);

  const glb = readFileSync(glbPath);
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('GLB magic 无效。');
  if (view.getUint32(4, true) !== 2) throw new Error('GLB 版本非 2。');
  if (view.getUint32(8, true) !== glb.byteLength) throw new Error('GLB 总长度字段不匹配。');

  const jsonLen = view.getUint32(12, true);
  if (view.getUint32(16, true) !== CHUNK_JSON) throw new Error('JSON chunk 类型无效。');
  const jsonText = new TextDecoder().decode(glb.subarray(20, 20 + jsonLen));
  const json = JSON.parse(jsonText) as {
    asset: { version: string };
    meshes: unknown[];
    accessors: Array<{ componentType?: number }>;
    buffers: Array<{ byteLength: number }>;
  };
  if (json.asset.version !== '2.0') throw new Error('glTF asset 版本非 2.0。');
  if (json.meshes.length !== result.exportedMeshes) {
    throw new Error(`GLB 网格数 ${json.meshes.length} 与导出数 ${result.exportedMeshes} 不一致。`);
  }

  const binHeaderOffset = 20 + jsonLen;
  const binLen = view.getUint32(binHeaderOffset, true);
  if (view.getUint32(binHeaderOffset + 4, true) !== CHUNK_BIN) throw new Error('BIN chunk 类型无效。');
  if ((json.buffers[0]?.byteLength ?? -1) !== binLen) throw new Error('BIN 长度与 buffer 声明不一致。');

  const u32IndexMeshes = json.accessors.filter((a) => a.componentType === 5125).length;
  return {
    id,
    meshCount: result.meshCount,
    exportedMeshes: result.exportedMeshes,
    glbBytes: result.byteLength,
    u32IndexMeshes,
    accessorCount: json.accessors.length,
    binBytes: binLen
  };
}

async function main(): Promise<void> {
  const root = fixtureRoot();
  const chrDir = join(root, 'mods', 'chr');
  if (!root || !existsSync(chrDir)) {
    console.log(JSON.stringify({
      ok: true,
      status: 'skipped',
      message: '未配置本机 Sekiro 根（SOULFORGE_NATIVE_FIXTURE_ROOT / SOULFORGE_SEKIRO_GAME_ROOT）。'
    }));
    return;
  }
  accessSync(chrDir, constants.R_OK);

  const requested = (process.argv[2] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const ids = requested.length
    ? requested
    : readdirSync(chrDir)
      .filter((f) => f.endsWith('.chrbnd.dcx'))
      .map((f) => basename(f, '.chrbnd.dcx'))
      .sort();

  const tmp = mkdtempSync(join(tmpdir(), 'soulforge-native-flver-glb-'));
  const reports: ExportReport[] = [];
  try {
    for (const id of ids) {
      reports.push(await exportOne(root, tmp, id));
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    await disposeBridgeDaemonPool();
  }

  console.log(JSON.stringify({
    ok: true,
    status: 'verified',
    message: `FLVER → GLB 导出矩阵验证通过（${reports.length} samples）`,
    samples: reports,
    authority: 'native-verified'
  }, null, 2));
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (/(chrbnd container missing|未配置本机 Sekiro 根)/.test(message)) {
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
