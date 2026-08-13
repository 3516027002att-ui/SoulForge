/**
 * Native FLVER multi-sample smoke: enumerate every Sekiro chrbnd container in the
 * registered corpus, extract the inner FLVER, and verify document + mesh decode
 * quality across all samples.
 *
 * Covers the layout diversity matrix found in the corpus:
 *   - version 0x2001A (character) with 40B stride (c1020/c1021/c1220/c1360/c1400/c1700/c7400)
 *   - version 0x20014 with 44B stride (c4510/c5030/c6210/c8010)
 *   - secondary vertex buffers with stride 20/24/28/48/56
 *
 * Env contract (mirrors the other native smokes):
 *   SOULFORGE_NATIVE_FIXTURE_ROOT / SOULFORGE_SEKIRO_GAME_ROOT  — Sekiro root
 *   Sample selection: argv[2] = comma-separated chr ids (default: all chrbnd dirs)
 *
 * Fail-closed: when the fixture root is readable, every enumerated container MUST
 * extract and decode; any violation throws. When no root is configured the smoke
 * reports status "skipped" with exit 0 (honest skip for CI without local game).
 */
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { mkdirSync, readdirSync, existsSync, accessSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';

interface FlverEnvelope {
  authority: string;
  version: string;
  internalVersion: string;
  meshCount: number;
  vertexBufferCount: number;
  materialCount: number;
  boneCount: number;
  textureCount: number;
  vertexStrides: number[];
  boundingBox: { min: number[]; max: number[] };
  layoutWarnings: string[];
  /** 已识别但未解析的结构缺口（能力边界，与 layoutWarnings 的「数据可疑」分开）。 */
  unparsedGaps?: string[];
  sourceSize: number;
}

interface MeshEnvelope {
  vertexCount: number;
  vertexStride: number;
  bufferLayoutIndex: number;
  indexFormat: number;
  positionsBase64?: string;
  indicesBase64?: string;
  uvsBase64?: string;
  normalsBase64?: string;
  boneWeightsBase64?: string;
  boneIndicesBase64?: string;
}

function fixtureRoot(): string {
  return process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim()
    ?? process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim()
    ?? '';
}

function toF32(b64: string): Float32Array {
  const b = Buffer.from(b64, 'base64');
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
}
function toU16(b64: string): Uint16Array {
  const b = Buffer.from(b64, 'base64');
  return new Uint16Array(b.buffer, b.byteOffset, b.length / 2);
}
function toU32(b64: string): Uint32Array {
  const b = Buffer.from(b64, 'base64');
  return new Uint32Array(b.buffer, b.byteOffset, b.length / 4);
}

interface SampleReport {
  id: string;
  version: string;
  meshCount: number;
  vertexStrides: number[];
  authority: string;
  meshesChecked: number;
  meshesOk: number;
  decodeFailures: string[];
  layoutWarnings: number;
  unparsedGaps: string[];
}

async function verifyMesh(
  out: string,
  meshIndex: number,
  bbox: { min: number[]; max: number[] }
): Promise<string[]> {
  const r = await runBridge<MeshEnvelope>({
    command: 'read-flver-mesh',
    filePath: out,
    allowedRoots: [dirname(out)],
    commandOptions: { meshIndex },
    timeoutMs: 120_000
  });
  if (r.parseStatus === 'failed' || !r.data) {
    return [`mesh[${meshIndex}] read failed: ${JSON.stringify(r.diagnostics)}`];
  }
  const d = r.data;
  const failures: string[] = [];
  if (!d.positionsBase64) return [`mesh[${meshIndex}] missing positions`];
  const pos = toF32(d.positionsBase64);
  const vertexCount = Math.min(d.vertexCount, 10_000);
  if (pos.length !== vertexCount * 3) {
    return [`mesh[${meshIndex}] position size mismatch: ${pos.length} floats vs ${vertexCount} vertices`];
  }

  let allFinite = true;
  for (let i = 0; i < pos.length; i++) {
    if (!Number.isFinite(pos[i])) { allFinite = false; break; }
  }
  if (!allFinite) failures.push(`mesh[${meshIndex}] non-finite positions`);

  // Bounding-box containment (skip when every position is origin — degenerate aux meshes exist).
  const [bx0 = 0, by0 = 0, bz0 = 0] = bbox.min;
  const [bx1 = 0, by1 = 0, bz1 = 0] = bbox.max;
  const pad = Math.max(Math.abs(bx1 - bx0), Math.abs(by1 - by0), Math.abs(bz1 - bz0), 1) * 0.1;
  let anyNonZero = false;
  let outOfBbox = false;
  for (let i = 0; i < vertexCount; i++) {
    const [x, y, z] = [pos[i * 3] ?? 0, pos[i * 3 + 1] ?? 0, pos[i * 3 + 2] ?? 0];
    if (x !== 0 || y !== 0 || z !== 0) anyNonZero = true;
    if (x < bx0 - pad || x > bx1 + pad || y < by0 - pad || y > by1 + pad || z < bz0 - pad || z > bz1 + pad) {
      outOfBbox = true;
      break;
    }
  }
  if (anyNonZero && outOfBbox) failures.push(`mesh[${meshIndex}] positions outside bounding box`);

  // Bone weights: every skinned vertex must sum to ~1 (quantized bytes → tolerance 0.02);
  // all-zero weights are valid for static/aux meshes.
  if (d.boneWeightsBase64) {
    const wt = toF32(d.boneWeightsBase64);
    for (let i = 0; i < Math.min(vertexCount, 400); i++) {
      const w0 = wt[i * 4] ?? 0, w1 = wt[i * 4 + 1] ?? 0, w2 = wt[i * 4 + 2] ?? 0, w3 = wt[i * 4 + 3] ?? 0;
      if (Math.max(w0, w1, w2, w3) > 0 && Math.abs(w0 + w1 + w2 + w3 - 1) > 0.02) {
        failures.push(`mesh[${meshIndex}] bone weights sum ${(w0 + w1 + w2 + w3).toFixed(3)} != 1 (quantized)`);
        break;
      }
    }
  }

  // Indices must be valid for the real vertex count; edge-compressed (8) sets are skipped honestly.
  if (d.indicesBase64 && (d.indexFormat === 16 || d.indexFormat === 32)) {
    const arr = d.indexFormat === 32 ? toU32(d.indicesBase64) : toU16(d.indicesBase64);
    for (const ix of arr) {
      if (ix >= d.vertexCount) {
        failures.push(`mesh[${meshIndex}] index ${ix} >= vertexCount ${d.vertexCount}`);
        break;
      }
    }
  }
  return failures;
}

async function verifySample(root: string, tmp: string, id: string): Promise<SampleReport> {
  const chrDir = join(root, 'mods', 'chr');
  const container = join(chrDir, `${id}.chrbnd.dcx`);
  if (!existsSync(container)) throw new Error(`chrbnd container missing: ${container}`);
  const out = join(tmp, `${id}.flver`);

  const ex = await runBridge<{ contentSize?: number }>({
    command: 'extract-bnd4-child',
    filePath: container,
    allowedRoots: [chrDir],
    writableRoots: [tmp],
    oodleRuntimeRoot: root,
    commandOptions: { childPath: `${id}.flver`, outputPath: out },
    timeoutMs: 180_000
  });
  if (ex.parseStatus === 'failed' || !ex.data?.contentSize) {
    throw new Error(`FLVER extract failed for ${id}: ${JSON.stringify(ex.diagnostics)}`);
  }

  const doc = await runBridge<FlverEnvelope>({
    command: 'read-flver-document',
    filePath: out,
    allowedRoots: [tmp],
    timeoutMs: 120_000
  });
  if (doc.parseStatus === 'failed' || !doc.data) {
    throw new Error(`FLVER read failed for ${id}: ${JSON.stringify(doc.diagnostics)}`);
  }
  const e = doc.data;
  // meshCount 为负是数据异常（结构表读坏），必须失败关闭；为 0 是**合法空模型**——
  // 头本身合法、无 material/mesh/vertex buffer（如仅含骨骼与 dummy 的占位/辅助模型，
  // 实测 c1001.flver：materialCount=0、meshCount=0、vertexBufferCount=0、dataLength=0）。
  // 「fail-closed」针对的是解析失败与数据可疑，不是「必须有 mesh」。
  if (e.meshCount < 0) throw new Error(`FLVER ${id} meshCount 为负：${e.meshCount}`);

  // layoutWarnings 必须为空：那一类是「读到的东西不对」（越界引用、未知 member 大小、
  // structOffset 越界），在已登记样本上出现任何一条都是真实回归，必须失败关闭。
  if ((e.layoutWarnings ?? []).length > 0) {
    throw new Error(`FLVER ${id} layoutWarnings 非空（数据可疑，不是能力边界）：${JSON.stringify(e.layoutWarnings)}`);
  }

  // authority 判据刻意**不**再要求 native-verified。
  //
  // FlverNativeDocument.Authority 现在对 unparsedGaps 敏感：已识别但未解析的结构
  // （tangent/bitangent/vertexColor 三个语义、重复语义的第 2+ 个 member、material 后
  // 16 字节含 gxIndex→GXList）会把 authority 降为 partial。这批缺口在**全部**已登记
  // 样本上都存在（2026-08-08 实测 11 个 chrbnd：194 个未解析 member、505 条 material
  // 后 16 字节全部非零），所以 partial 是当前实现的**正确**自述，不是回归。
  //
  // 此前这条断言要求 native-verified 并且能通过——那恰恰是因为 Authority 当时唯一的
  // 降级依据是 layoutWarnings，对上述缺口完全不敏感。把断言改回 native-verified 只能
  // 靠让 authority 重新对缺口失明来实现，那是放宽判据而不是修复。
  //
  // 仍然失败关闭的形态：authority 不在这个闭集里（例如变成 unsupported/blocked），
  // 说明解析真的退化了。
  if (e.authority !== 'partial' && e.authority !== 'native-verified') {
    throw new Error(`FLVER ${id} authority=${e.authority}（期望 partial 或 native-verified）；warnings=${JSON.stringify(e.layoutWarnings)}`);
  }

  // 缺口必须**可见**：authority 一旦是 partial，就必须给出结构化缺口清单。
  // 「降级了但不说为什么」是此前那批缺口不可见的同一个病，不能换个位置重演。
  //
  // ⚠️ 该判据只适用于**非空**模型：合法 0-mesh 空壳没有顶点数据可解码，也没有
  // material/语义可供登记缺口，authority=partial 是「无数据可验证」的正确自述，
  // 不是「降级了不说为什么」。空模型在这里早退，报告 meshesChecked=0。
  if (e.meshCount === 0) {
    return {
      id,
      version: `${e.version} (${e.internalVersion})`,
      meshCount: 0,
      vertexStrides: e.vertexStrides,
      authority: e.authority,
      meshesChecked: 0,
      meshesOk: 0,
      decodeFailures: [],
      layoutWarnings: (e.layoutWarnings ?? []).length,
      unparsedGaps: e.unparsedGaps ?? []
    };
  }

  if (e.authority === 'partial' && (e.unparsedGaps ?? []).length === 0 && (e.layoutWarnings ?? []).length === 0) {
    throw new Error(`FLVER ${id} authority=partial 但既无 unparsedGaps 也无 layoutWarnings：降级原因不可见。`);
  }

  const checkCount = Math.min(e.meshCount, 4);
  const decodeFailures: string[] = [];
  for (let m = 0; m < checkCount; m++) {
    const failures = await verifyMesh(out, m, e.boundingBox);
    decodeFailures.push(...failures);
  }

  return {
    id,
    version: `${e.version} (${e.internalVersion})`,
    meshCount: e.meshCount,
    vertexStrides: e.vertexStrides,
    authority: e.authority,
    meshesChecked: checkCount,
    meshesOk: checkCount - decodeFailures.length,
    decodeFailures,
    layoutWarnings: (e.layoutWarnings ?? []).length,
    unparsedGaps: e.unparsedGaps ?? []
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

  const tmp = join(tmpdir(), 'soulforge-flver-multi-smoke');
  mkdirSync(tmp, { recursive: true });

  const reports: SampleReport[] = [];
  for (const id of ids) {
    reports.push(await verifySample(root, tmp, id));
  }

  const bad = reports.filter((r) => r.decodeFailures.length > 0);
  console.log(JSON.stringify({
    ok: bad.length === 0,
    status: 'verified',
    message: `FLVER 多样本原生验证通过（${reports.length} samples, ${reports.reduce((s, r) => s + r.meshCount, 0)} meshes）`,
    samples: reports,
    failures: bad
  }, null, 2));

  await disposeBridgeDaemonPool();
  if (bad.length > 0) process.exitCode = 1;
}

main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
