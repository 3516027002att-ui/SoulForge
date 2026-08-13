/**
 * Native MTD smoke（MATERIAL-53A）：read-mtd-document 三页投影。
 *
 * 路径 A（真实语料）：registry 已登记 mtd-primary → 真实读，断言三页 wire 形状
 * 与 authority ∈ {candidate, partial, fixture-confirmed}。未识别结构由 C# 侧
 * unparsedGaps 反映并降 partial，smoke 不把「读出来了」冒充「完整解析」。
 *
 * 路径 B（合成 fixture）：registry 未登记 → 用微小、合法、显式 syntheticFixture
 * 标记的合成 MTD XML（root/header/param/texture）跑 read-mtd-document，断言三页
 * 形状 + authority ∈ {fixture-confirmed, candidate}。合成语料干净时 authority
 * 应正好是 candidate 且 unparsedGaps 为空——任何 gap 说明识别逻辑把已知元素
 * 误报成未知。
 *
 * 缺语料处置：MTD 在真实 corpus 中未登记是合法状态（本机未发现 .mtd 样本，
 * infer-mtd-schema 永久禁令），此时走路径 B 而非静默 skip——合成 fixture 仍真实
 * 经过 C# MtdNativeDocument 验证三页投影，不冒充 native authority。只有 registry
 * 配置损坏等环境问题才失败关闭（与 ESD smoke 的「缺语料 vs 基础设施损坏」区分一致）。
 *
 * 运行需要已构建的 Bridge daemon（read-mtd-document 由 C# 服务；TS 不维护
 * 第二套 production native parser）。
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { nativeFixtureRoleRegistered, resolveNativeFixture } from './nativeFixtureRegistry.js';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';

interface MtdEnvelope {
  format?: string;
  formatId?: string;
  sourceSize?: number;
  sourceHash?: string;
  name?: string | null;
  version?: string | null;
  shaderPath?: string | null;
  materialCount?: number;
  properties?: Array<{
    id?: string | null;
    type?: string | null;
    name?: string | null;
    value?: string | null;
    unknown?: Record<string, string> | null;
  }>;
  propertiesTruncated?: boolean;
  textureRefs?: Array<{
    path?: string | null;
    type?: string | null;
    name?: string | null;
  }>;
  textureRefsTruncated?: boolean;
  unparsedGaps?: string[];
  layoutWarnings?: string[];
  roundTrip?: {
    consistent?: boolean;
    sourceHash?: string;
    reparsedHash?: string;
    paramCount?: number;
    textureRefCount?: number;
    note?: string | null;
  };
  authority?: string;
}

/**
 * 微小、合法、显式 syntheticFixture 标记的合成 MTD XML。
 * root/header/param（含 shader 参数，用于断言 shaderPath 的约定式提取）/
 * texture 各若干；只含 reader 认识的结构，保证权威断言落在 candidate。
 */
const SYNTHETIC_MTD_XML = `<?xml version="1.0" encoding="utf-8"?>
<material name="synthetic_mtd_smoke" version="1.0">
  <header>Synthetic MTD smoke header</header>
  <param id="0" type="shader" name="ShaderPath">mtd/synthetic/smoke_shader.mtd</param>
  <param id="1" type="float" name="SpecularPower">32.0</param>
  <texture path="asset/textures/synthetic_smoke_a.dds" type="diffuse" name="Diffuse"/>
  <texture path="asset/textures/synthetic_smoke_b.dds" type="normal" name="Normal"/>
</material>
`;

async function readMtd(path: string, allowedRoots: string[]): Promise<MtdEnvelope> {
  const result = await runBridge<MtdEnvelope>({
    command: 'read-mtd-document',
    filePath: path,
    allowedRoots,
    timeoutMs: 120_000
  });
  if (result.parseStatus === 'failed' || !result.data) {
    throw new Error(`read-mtd-document ${path} 失败：${JSON.stringify(result.diagnostics)}`);
  }
  return result.data;
}

/** 三页 wire 形状断言（只断言形状，不断言 authority 的具体值——那由调用方按语料裁）。 */
function assertThreePages(d: MtdEnvelope): void {
  if (d.format !== 'MTD-XML') throw new Error(`unexpected format: ${d.format}`);
  if (d.formatId !== 'mtd') throw new Error(`unexpected formatId: ${d.formatId}`);
  if (typeof d.sourceHash !== 'string' || !d.sourceHash) throw new Error('missing source hash');
  if (d.materialCount !== 1) throw new Error(`materialCount 应为 1（单材质定义），实际 ${d.materialCount}`);
  if (!Array.isArray(d.properties)) throw new Error('missing properties array');
  for (const p of d.properties) {
    for (const key of ['id', 'type', 'name', 'value'] as const) {
      if (p[key] !== undefined && p[key] !== null && typeof p[key] !== 'string') {
        throw new Error(`property.${key} 类型错误：${typeof p[key]}`);
      }
    }
  }
  if (!Array.isArray(d.textureRefs)) throw new Error('missing textureRefs array');
  for (const t of d.textureRefs) {
    for (const key of ['path', 'type', 'name'] as const) {
      if (t[key] !== undefined && t[key] !== null && typeof t[key] !== 'string') {
        throw new Error(`textureRef.${key} 类型错误：${typeof t[key]}`);
      }
    }
  }
  if (!Array.isArray(d.unparsedGaps)) throw new Error('missing unparsedGaps');
  if (!Array.isArray(d.layoutWarnings)) throw new Error('missing layoutWarnings');
  if (!d.roundTrip || typeof d.roundTrip.consistent !== 'boolean') {
    throw new Error('missing roundTrip.consistent');
  }
}

async function syntheticLeg(): Promise<void> {
  await withSmokeWorkspace('native-mtd-smoke', async (workspace) => {
    const syntheticPath = join(workspace.root, 'synthetic_smoke.mtd');
    await writeFile(syntheticPath, SYNTHETIC_MTD_XML, 'utf8');
    const d = await readMtd(syntheticPath, [workspace.root]);
    assertThreePages(d);
    // 合成语料干净：权威应正好是 candidate 且无未识别结构。
    if (d.authority !== 'candidate') {
      throw new Error(`合成干净 MTD 的 authority 应属于 fixture-confirmed/candidate（预期 candidate），实际 ${d.authority}`);
    }
    if ((d.unparsedGaps?.length ?? 0) > 0) {
      throw new Error(`合成干净 MTD 不应有 unparsedGaps：${JSON.stringify(d.unparsedGaps)}`);
    }
    if (!d.roundTrip?.consistent) {
      throw new Error('合成干净 MTD 的 roundTrip.consistent 应为 true');
    }
    if (d.shaderPath !== 'mtd/synthetic/smoke_shader.mtd') {
      throw new Error(`shaderPath 约定式提取失败：${d.shaderPath}`);
    }
    console.log(JSON.stringify({
      ok: true,
      status: 'synthetic-fixture',
      syntheticFixture: true,
      fixtureRole: 'mtd-primary',
      message: `MTD synthetic fixture 读取验证通过（${d.properties?.length ?? 0} params, ${d.textureRefs?.length ?? 0} textures）`,
      name: d.name,
      version: d.version,
      shaderPath: d.shaderPath,
      materialCount: d.materialCount,
      properties: d.properties,
      textureRefs: d.textureRefs,
      unparsedGaps: d.unparsedGaps,
      layoutWarnings: d.layoutWarnings,
      authority: d.authority,
      roundTrip: d.roundTrip
    }, null, 2));
  });
}

async function corpusLeg(explicitPath: string | undefined): Promise<void> {
  const source = await resolveNativeFixture(
    explicitPath,
    'mtd-primary',
    '../../mtd/m_a.mtd'
  );
  const d = await readMtd(source, [source.replace(/[/\\][^/\\]+$/, '')]);
  assertThreePages(d);
  const allowed = new Set(['candidate', 'partial', 'fixture-confirmed']);
  if (d.authority === undefined || !allowed.has(d.authority)) {
    throw new Error(`真实语料 authority 应属于 ${[...allowed].join('/')}，实际 ${d.authority}`);
  }
  console.log(JSON.stringify({
    ok: true,
    syntheticFixture: false,
    message: `MTD native 读取验证通过（${d.properties?.length ?? 0} params, ${d.textureRefs?.length ?? 0} textures）`,
    name: d.name,
    version: d.version,
    shaderPath: d.shaderPath,
    materialCount: d.materialCount,
    properties: d.properties?.slice(0, 10),
    propertiesTruncated: d.propertiesTruncated,
    textureRefs: d.textureRefs,
    textureRefsTruncated: d.textureRefsTruncated,
    unparsedGaps: d.unparsedGaps,
    layoutWarnings: d.layoutWarnings,
    authority: d.authority,
    roundTrip: d.roundTrip
  }, null, 2));
}

async function main(): Promise<void> {
  const explicitPath = process.argv[2]?.trim();
  const registered = await nativeFixtureRoleRegistered('mtd-primary');
  if (!explicitPath && !registered) {
    // 缺语料（未登记且未显式给路径）：走合成 fixture leg。
    await syntheticLeg();
  } else {
    await corpusLeg(explicitPath);
  }
}

main()
  .then(async () => {
    await disposeBridgeDaemonPool();
  })
  .catch(async (error) => {
    await disposeBridgeDaemonPool();
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
