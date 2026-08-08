/**
 * Native TPF multi-sample smoke: enumerate every Sekiro texbnd container in the
 * registered corpus, extract the inner TPF, and verify DDS texture parse quality.
 *
 * Covers c4510/c5030/c6210/c8010 texbnd (each holds exactly one uncompressed .tpf).
 *
 * DDS 魔数由 Bridge 侧失败关闭地校验（TpfNativeDocument.cs:99-100 魔数不符直接抛），
 * 所以能拿到 envelope 就意味着每个 blob 的 "DDS " 魔数成立。本套件在此之上断言
 * **Bridge 报出的 ddsFourCC 与真实像素格式**——这两项此前拿到手却从不校验。
 *
 * ⚠️ 关于 texture.format：它是 TPF 条目表 formatByte 经 FormatName 查表得来
 * （TpfNativeDocument.cs:241-249），**与 DDS 里的真实格式无关**。2026-08-08 实测
 * 52 个真实纹理，两者系统性错配：BC5/DX10→BC7_UNORM ×13、BC1/DX10→BC7_UNORM_SRGB
 * ×10、BC4/DX10→BC7_UNORM_SRGB ×1。所以判据必须定在 ddsFourCC + DX10 头的 dxgi，
 * 不能定在 format 字段——把查表结果当真实格式上报，正是上一条证据把含 25 个 BC7
 * 的语料记成 formats=[BC1,BC4] 的原因。
 *
 * Env contract: SOULFORGE_NATIVE_FIXTURE_ROOT / SOULFORGE_SEKIRO_GAME_ROOT.
 * Fail-closed when root is readable; honest-skip when not.
 */
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { mkdirSync, readdirSync, existsSync, accessSync, constants, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';

interface TpfEnvelope {
  authority: string;
  textureCount: number;
  sourceSize: number;
  sourceHash: string;
  textures?: Array<{
    index: number;
    name: string;
    format: string;
    mipCount: number;
    width: number;
    height: number;
    dataSize: number;
    dataOffset: number;
    ddsFourCC: string;
  }>;
}

function fixtureRoot(): string {
  return process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim()
    ?? process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim()
    ?? '';
}

interface SampleReport {
  id: string;
  textureCount: number;
  authority: string;
  /** 尺寸非零的纹理数。此前叫 ddsValid，但它从不校验 DDS 有效性——只判
   *  width>0 && height>0，实测恒等于 textureCount，名字比内容大一号。 */
  dimensionsValid: number;
  /** ddsFourCC 合法（在已登记闭集内）的纹理数。 */
  fourCcValid: number;
  ddsFailures: string[];
  sourceSize: number;
  /** TPF 条目表 formatByte 查表结果。不是真实像素格式，见头注释。 */
  containerFormats: string[];
  /** Bridge 报的 ddsFourCC 分布。 */
  ddsFourCCs: string[];
  /** DDS 真实像素格式分布（DX10 取头里的 dxgiFormat，其余取 fourCC）。 */
  realFormats: string[];
  /** 真实格式与条目表查表结果不一致的纹理数。实测 24/52，是既有事实不是回归。 */
  formatByteMismatches: number;
}

/**
 * 已登记的 DDS fourCC 闭集。出现闭集外的值必须失败关闭——那意味着遇到了
 * 未建模的纹理封装形态，不能当已支持放过。
 */
const KNOWN_FOURCC = Object.freeze(['DX10', 'ATI1', 'ATI2', 'DXT1', 'DXT3', 'DXT5']);

/** DXGI_FORMAT 数值 → 名称。只登记本语料实测出现过的 + BC 家族全集。 */
const DXGI_NAME: Readonly<Record<number, string>> = Object.freeze({
  71: 'BC1_UNORM', 72: 'BC1_UNORM_SRGB',
  74: 'BC2_UNORM', 75: 'BC2_UNORM_SRGB',
  77: 'BC3_UNORM', 78: 'BC3_UNORM_SRGB',
  80: 'BC4_UNORM', 81: 'BC4_SNORM',
  83: 'BC5_UNORM', 84: 'BC5_SNORM',
  95: 'BC6H_UF16', 96: 'BC6H_SF16',
  98: 'BC7_UNORM', 99: 'BC7_UNORM_SRGB'
});

/**
 * 从 TPF 字节里读某个纹理的真实像素格式。
 * DX10 的 dxgiFormat 在 DDS 头之后的 DXT10 扩展头首字段（blob+0x80）。
 * **用 Bridge 上报的 dataOffset 定位，不自行解析条目表**——条目步长由 C# 的
 * EntrySize 决定，本轮实测过：自己按 0x10 猜会让每个 dataOffset 错位，
 * 读出一堆「魔数不合法」的假结论。
 */
function realPixelFormat(tpf: Buffer, dataOffset: number, fourCC: string): string {
  if (fourCC !== 'DX10') return fourCC.trim();
  const at = dataOffset + 0x80;
  if (!Number.isFinite(dataOffset) || at + 4 > tpf.length) return 'DX10-header-truncated';
  const dxgi = tpf.readInt32LE(at);
  return DXGI_NAME[dxgi] ?? `dxgi${dxgi}`;
}

async function verifySample(root: string, tmp: string, id: string): Promise<SampleReport> {
  const chrDir = join(root, 'mods', 'chr');
  const container = join(chrDir, `${id}.texbnd.dcx`);
  if (!existsSync(container)) throw new Error(`texbnd container missing: ${container}`);
  const tpfPath = join(tmp, `${id}.tpf`);

  const ex = await runBridge<{ contentSize?: number }>({
    command: 'extract-bnd4-child',
    filePath: container,
    allowedRoots: [chrDir],
    writableRoots: [tmp],
    oodleRuntimeRoot: root,
    commandOptions: { childPath: `${id}.tpf`, outputPath: tpfPath },
    timeoutMs: 180_000
  });
  if (ex.parseStatus === 'failed' || !ex.data?.contentSize) {
    throw new Error(`TPF extract failed for ${id}: ${JSON.stringify(ex.diagnostics)}`);
  }

  const r = await runBridge<TpfEnvelope>({
    command: 'read-tpf-document',
    filePath: tpfPath,
    allowedRoots: [dirname(tpfPath)],
    timeoutMs: 120_000
  });
  if (r.parseStatus === 'failed' || !r.data) {
    throw new Error(`TPF read failed for ${id}: ${JSON.stringify(r.diagnostics)}`);
  }
  const d = r.data;
  if (d.textureCount <= 0) throw new Error(`TPF ${id} has no textures`);
  if (d.authority !== 'native-verified') {
    throw new Error(`TPF ${id} authority=${d.authority} (expected native-verified)`);
  }

  const failures: string[] = [];
  let dimensionsValid = 0;
  let fourCcValid = 0;
  let formatByteMismatches = 0;
  const containerFormats = new Set<string>();
  const ddsFourCCs = new Set<string>();
  const realFormats = new Set<string>();
  const tpfBytes = readFileSync(tpfPath);
  for (const tex of d.textures ?? []) {
    containerFormats.add(tex.format);
    if (!tex.name) failures.push(`texture ${tex.index} missing name`);
    if (tex.width <= 0 || tex.height <= 0) {
      failures.push(`texture ${tex.index} invalid dimensions ${tex.width}x${tex.height}`);
    } else {
      dimensionsValid++;
    }
    if (tex.dataSize <= 0) failures.push(`texture ${tex.index} invalid dataSize`);
    if (tex.mipCount <= 0) failures.push(`texture ${tex.index} invalid mipCount`);

    // fourCC 此前拿到手却从不校验。闭集外的值必须失败关闭：那是未建模的
    // 封装形态，放过等于声称支持一种没验证过的格式。
    const cc = String(tex.ddsFourCC ?? "");
    ddsFourCCs.add(cc === "" ? "(empty)" : cc);
    if (!KNOWN_FOURCC.includes(cc)) {
      failures.push(`texture ${tex.index} unknown ddsFourCC ${JSON.stringify(cc)}`);
    } else {
      fourCcValid++;
    }

    // 真实像素格式 vs 条目表查表结果。不一致是既有事实（实测 24/52），
    // 故只计数上报、不失败关闭——把它变成红需要先裁定哪一侧才是权威，
    // 那是独立议题。但计数必须可见，否则「formats=[BC1,BC4]」这类失真
    // 会继续被当成事实封存。
    const real = realPixelFormat(tpfBytes, Number(tex.dataOffset), cc);
    realFormats.add(real);
    const containerFamily = tex.format.replace(/-alpha$/, "");
    if (real !== "" && !real.startsWith(containerFamily)) formatByteMismatches++;

    // DX10 扩展头必须真的读得到——读不到说明 dataOffset 或文件被截断，
    // 而那会让真实格式统计静默退化成一堆 truncated。
    if (real === "DX10-header-truncated") {
      failures.push(`texture ${tex.index} DX10 扩展头不可读（dataOffset=${tex.dataOffset}）`);
    }
  }

  return {
    id,
    textureCount: d.textureCount,
    authority: d.authority,
    dimensionsValid,
    fourCcValid,
    ddsFailures: failures,
    sourceSize: d.sourceSize,
    containerFormats: [...containerFormats],
    ddsFourCCs: [...ddsFourCCs],
    realFormats: [...realFormats],
    formatByteMismatches
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
      .filter((f) => f.endsWith('.texbnd.dcx'))
      .map((f) => basename(f, '.texbnd.dcx'))
      .sort();

  const tmp = join(tmpdir(), 'soulforge-tpf-multi-smoke');
  mkdirSync(tmp, { recursive: true });

  const reports: SampleReport[] = [];
  for (const id of ids) {
    reports.push(await verifySample(root, tmp, id));
  }

  const bad = reports.filter((r) => r.ddsFailures.length > 0);
  // 汇总真实像素格式与错配计数。这两项必须出现在顶层输出里：上一条证据
  // 把含 25 个 BC7 的语料记成 formats=[BC1,BC4]，就是因为可引用的只有
  // 条目表查表结果那一个字段。
  const allReal = [...new Set(reports.flatMap((r) => r.realFormats))].sort();
  const allContainer = [...new Set(reports.flatMap((r) => r.containerFormats))].sort();
  const allFourCC = [...new Set(reports.flatMap((r) => r.ddsFourCCs))].sort();
  const totalTextures = reports.reduce((s, r) => s + r.textureCount, 0);
  const totalMismatch = reports.reduce((s, r) => s + r.formatByteMismatches, 0);
  const totalFourCcValid = reports.reduce((s, r) => s + r.fourCcValid, 0);
  const totalDimensionsValid = reports.reduce((s, r) => s + r.dimensionsValid, 0);
  console.log(JSON.stringify({
    ok: bad.length === 0,
    status: 'verified',
    message: `TPF 多样本原生验证通过（${reports.length} texbnd, ${reports.reduce((s, r) => s + r.textureCount, 0)} textures）`,
    textureCount: totalTextures,
    dimensionsValid: totalDimensionsValid,
    fourCcValid: totalFourCcValid,
    containerFormats: allContainer,
    ddsFourCCs: allFourCC,
    realPixelFormats: allReal,
    formatByteMismatches: totalMismatch,
    samples: reports,
    failures: bad,
    nonClaims: [
      'containerFormats 是 TPF 条目表 formatByte 的查表结果，不是真实像素格式；引用格式覆盖面时必须用 realPixelFormats。',
      'formatByteMismatches 只计数上报、不失败关闭——条目表与 DDS 头哪一侧是权威尚未裁定，那是独立议题。',
      '本套件不声明这些纹理可被解码或导出：DdsCodec 无 BC7 实现，而实测 BC7 占多数。',
      'dimensionsValid 只表示 width/height 非零（此前叫 ddsValid，名字比内容大一号）；DDS 魔数由 Bridge 侧失败关闭校验，不由本套件声称。'
    ]
  }, null, 2));

  await disposeBridgeDaemonPool();
  if (bad.length > 0) process.exitCode = 1;
}

main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
