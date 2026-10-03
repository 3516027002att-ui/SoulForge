import { createSmokeTemporaryDirectory } from './harness/smokeWorkspace.js';
// Native smoke: export real Sekiro FLVERs to GLB and verify container/JSON structure
// across the multi-sample matrix (all parseable chrbnd inner FLVERs).
import { readFileSync, rmSync, readdirSync, existsSync, accessSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { exportFlverToGlb } from '../export/flverToGlb.js';
import { classifyGlbDocument, classifyGlbMesh } from './staleValidationAssertions.js';
import { summarizeFlverValidation } from './flverValidationReport.js';

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
  meshesChecked: number;
  meshesOk: number;
  emptyMeshIndices: number[];
  decodeFailures: string[];
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

  // Preflight native topology before selecting an export sample. Zero meshes
  // and explicitly classified empty meshes are valid corpus entries, not GLB
  // exporter failures. Failed/unknown reads still fail closed.
  const document = await runBridge<Record<string, unknown>>({
    command: 'read-flver-document', filePath: out, allowedRoots: [tmp], timeoutMs: 180_000
  });
  const classification = classifyGlbDocument(document);
  const meshCount = document.data!.meshCount as number;
  const emptyMeshIndices: number[] = [];
  let drawableMeshes = 0;
  for (let meshIndex = 0; meshIndex < meshCount; meshIndex++) {
    const mesh = await runBridge<Record<string, unknown>>({
      command: 'read-flver-mesh', filePath: out, allowedRoots: [tmp],
      commandOptions: { meshIndex, maxVertices: 1_000_000, maxIndices: 3_000_000 }, timeoutMs: 180_000
    });
    if (classifyGlbMesh(mesh, meshIndex) === 'empty') emptyMeshIndices.push(meshIndex);
    else drawableMeshes++;
  }
  const coverage = { meshCount, meshesChecked: meshCount, meshesOk: drawableMeshes, emptyMeshIndices, decodeFailures: [] };
  if (classification === 'empty' || drawableMeshes === 0) {
    return { id, ...coverage, exportedMeshes: 0, glbBytes: 0, u32IndexMeshes: 0, accessorCount: 0, binBytes: 0 };
  }

  const glbPath = join(tmp, `${id}.glb`);
  const result = await exportFlverToGlb(out, glbPath, [tmp], [tmp], { timeoutMs: 180_000 });
  if (result.exportedMeshes !== drawableMeshes) {
    throw new Error(`GLB 导出遗漏可绘制网格：${id}; native drawable=${drawableMeshes}, exported=${result.exportedMeshes}`);
  }

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
    ...coverage,
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

  const tmp = await createSmokeTemporaryDirectory(join(tmpdir(), 'soulforge-native-flver-glb-'));
  const reports: ExportReport[] = [];
  try {
    for (const id of ids) {
      reports.push(await exportOne(root, tmp, id));
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    await disposeBridgeDaemonPool();
  }

  // Reuse the integrated structural classifier. Empty-only/all-absent sets
  // remain unverified and cannot claim a successful export matrix.
  const summary = summarizeFlverValidation(reports);
  console.log(JSON.stringify({
    ...summary,
    message: summary.ok ? `FLVER → GLB 导出结构矩阵验证通过（${summary.counts.passed} exported; ${summary.counts.empty} empty samples excluded）`
      : `FLVER → GLB 导出未验证（${summary.counts.empty} empty samples; no drawable export verified）`,
    authority: summary.ok ? 'native-verified' : 'unverified'
  }, null, 2));
  if (!summary.ok) process.exitCode = 1;
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ ok: false, message, authority: 'candidate' }, null, 2));
  await disposeBridgeDaemonPool();
  process.exitCode = 1;
});
