#!/usr/bin/env node
/**
 * DDS 截断失败关闭门禁。
 *
 * 守的是 DdsCodec.DecodeDds 的**块数据长度前置校验**。
 *
 * ── 缺陷形态（2026-08-08 实测，不是推断）──
 * 五条解码路径（BC1/BC3/BC4/BC5/BC7）的块循环里各有一句
 * `if (block + N > src.Length) return;`——越界就**提前 return**。而 rgba 缓冲是
 * `new byte[]` 全零起始，于是缺失的块原地留成全零，也就是**黑色**。
 *
 * 用生产命令 export-tpf-texture(format=png) 对 8x8 纹理逐档截断实测：
 *   BC1 给全 4 块  → 全零像素   0/64
 *   BC1 只给 2 块  → 全零像素  32/64（50%）
 *   BC1 只给 1 块  → 全零像素  48/64（75%）
 *   BC1 零像素数据 → 全零像素  64/64（**100% 纯黑**）
 *   BC7 只给 2 块  → 全零像素  32/64（50%）
 * 而这五种情形**一律**报 `info: TPF_TEXTURE_EXPORTED` 成功，无任何警告或降级。
 * 即「导出成功」与「导出了一张黑图」在输出上完全不可区分——违反硬约束 8
 * （unsupported / failed / partial 必须返回结构化诊断，不能吞）。
 *
 * ── 为什么必须失败关闭而不是补个 warn ──
 * 需要多少字节是**可算的**（blocksWide × blocksHigh × 块字节），所以这不属于
 * 「信息不足只能尽力而为」，而是判据本来就该存在。截断的 DDS 是坏数据，不是
 * 「部分支持的格式」；产出一张半黑图并声称成功，比直接拒绝更有害——用户会把
 * 黑色当成纹理的真实内容，而 mod 里一张错误纹理不会有任何别的信号提醒他。
 *
 * ── 判据打在哪 ──
 * 全部经生产命令 export-tpf-texture 走真实 Bridge，断言两件事：
 *   ① 截断输入必须 **failed** 且诊断码为 TPF_TEXTURE_EXPORT_FAILED，且**不得**
 *      产出 PNG 文件（半成品文件本身就是误导）。
 *   ② 完整输入必须照常成功——这条是防「一刀切拒绝」的对照组。只测 ①，判据退化成
 *      「一律拒绝」仍会全绿，而那会删掉一整项已交付能力（本仓库有「误拒比漏拒更糟」
 *      的实测教训：给 FLVER 加 version 白名单时抽样定闭集，误拒了 3/11 真实样本）。
 * 逐格式各测一遍：块字节 BC1/BC4 是 8、BC3/BC5/BC7 是 16，写成一个三元表达式时
 * 很容易把某一族算错，而算错的方向恰好是**误拒真实纹理**。
 *
 * 归 synthetic 层：DDS/TPF 可自造，不需要真实游戏资产；解码在 C# 侧需要真实 exe。
 * 与 test:bc7-decode / test:bc3-color-block / test:png-color-space 同一惯例。
 *
 * ── 负向证明（2026-08-08 实测七条，逐条退化 C# 后强制重建再跑）──
 *   T1 截断校验整条去掉（即修复前行为）→ 112 条红，含「必须 failed 而不是导出半黑图」
 *   T2 块字节表写成一律 16（BC1/BC4 算错）→ 8 条红，点名**完整数据被误拒**
 *   T3 判据写成「必须恰好相等」→ 7 条红，点名 mip 链形态被误拒
 *   T4 off-by-one（requiredBytes - 1）→ 28 条红，点名「差 1 字节」那档
 *   T5 可用字节按 148 硬算（忽略 fourCC 形态的 128）→ 4 条红，点名 fourCC 两族
 *   T6 宽高校验去掉 → 2 条红，点名宽高非法
 *   T7 诊断消息不给字节数 → 28 条红，点名「消息必须给出所需与实际字节数」
 * 七条全部红在**目标断言**上；还原后强制重建复跑回 129/129 绿。
 * T2/T3/T5 是**误拒方向**的证明，专门守「一刀切拒绝」这种假修复——本仓库有实测
 * 教训：给 FLVER 加 version 白名单时抽样定闭集，误拒了 3/11 已交付的真实样本。
 *
 * ⚠️ 复现必须 `--no-incremental`：还原源码后增量构建不重编，扰动留在二进制里会
 *    让复跑报假红，看起来像判据自己有 bug。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'dds-truncation';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXE_CANDIDATES = [
  join(root, 'bridge', 'SoulForge.Bridge', 'bin', 'Release', 'net10.0', 'win-x64', 'publish', 'SoulForge.Bridge.exe'),
  join(root, 'bridge', 'SoulForge.Bridge', 'bin', 'Debug', 'net10.0', 'win-x64', 'SoulForge.Bridge.exe')
];

function report(payload, exitCode) {
  (exitCode === 0 ? console.log : console.error)(JSON.stringify(payload, null, 2));
  process.exit(exitCode);
}

const exe = EXE_CANDIDATES.find(existsSync);
if (!exe) {
  report({
    ok: null,
    gate: LABEL,
    status: 'skipped',
    reason: 'Bridge 可执行文件缺失，无法做运行期解码验证。',
    remedy: 'npm run bridge:build',
    skipSemantics: '结构跳过：未声称通过，也不计为失败。'
  }, 0);
}

const checks = [];
const findings = [];
function check(label, ok, detail) {
  checks.push({ label, ok });
  if (!ok) findings.push({ label, detail });
}

const scratch = mkdtempSync(join(tmpdir(), 'sf-ddstrunc-'));
const sourceRoot = join(scratch, 'source');
const exportRoot = join(scratch, 'export');
mkdirSync(sourceRoot, { recursive: true });
mkdirSync(exportRoot, { recursive: true });
const SESSION = 'dds-truncation-gate';

/** 构造 DX10 头 DDS；pixels 可以刻意短于块数所需，用来造截断。 */
function buildDx10Dds(width, height, pixels, dxgiFormat) {
  const dds = Buffer.alloc(148 + pixels.length);
  dds.write('DDS ', 0, 'ascii');
  dds.writeUInt32LE(124, 4);
  dds.writeUInt32LE(0x81007, 8);
  // 用 Int32LE 而非 UInt32LE：负宽高是本门禁刻意要造的形态之一
  // （C# 侧用 BitConverter.ToInt32 读，负值必须被前置拒绝），
  // 而 writeUInt32LE 对 -4 直接抛 ERR_OUT_OF_RANGE，那是 harness 自己崩掉。
  dds.writeInt32LE(height, 12);
  dds.writeInt32LE(width, 16);
  dds.writeUInt32LE(pixels.length, 20);
  dds.writeUInt32LE(0, 24);
  dds.writeUInt32LE(1, 28);
  dds.writeUInt32LE(32, 76);
  dds.writeUInt32LE(0x4, 80);
  dds.write('DX10', 84, 'ascii');
  dds.writeUInt32LE(0x1000, 108);
  dds.writeUInt32LE(dxgiFormat, 128);
  dds.writeUInt32LE(3, 132);
  dds.writeUInt32LE(0, 136);
  dds.writeUInt32LE(1, 140);
  dds.writeUInt32LE(0, 144);
  pixels.copy(dds, 148);
  return dds;
}

/** 构造 fourCC 形态 DDS（非 DX10），数据区从 128 起。 */
function buildFourCcDds(width, height, pixels, fourCc) {
  const dds = Buffer.alloc(128 + pixels.length);
  dds.write('DDS ', 0, 'ascii');
  dds.writeUInt32LE(124, 4);
  dds.writeUInt32LE(0x81007, 8);
  dds.writeUInt32LE(height, 12);
  dds.writeUInt32LE(width, 16);
  dds.writeUInt32LE(pixels.length, 20);
  dds.writeUInt32LE(0, 24);
  dds.writeUInt32LE(1, 28);
  dds.writeUInt32LE(32, 76);
  dds.writeUInt32LE(0x4, 80);
  dds.write(fourCc, 84, 'ascii');
  dds.writeUInt32LE(0x1000, 108);
  pixels.copy(dds, 128);
  return dds;
}

function buildSyntheticTpf(name, ddsBytes) {
  const nameBytes = Buffer.from(`${name}\0`, 'utf16le');
  const headerSize = 0x10;
  const entrySize = 20;
  const nameOffset = headerSize + entrySize;
  const dataOffset = nameOffset + nameBytes.length;
  const tpf = Buffer.alloc(dataOffset + ddsBytes.length);
  tpf.write('TPF\0', 0, 'ascii');
  tpf.writeUInt32LE(ddsBytes.length, 4);
  tpf.writeUInt32LE(1, 8);
  const e = headerSize;
  tpf.writeUInt32LE(dataOffset, e);
  tpf.writeUInt32LE(ddsBytes.length, e + 4);
  tpf.writeUInt16LE(1, e + 10);
  tpf.writeUInt32LE(nameOffset, e + 12);
  nameBytes.copy(tpf, nameOffset);
  ddsBytes.copy(tpf, dataOffset);
  return tpf;
}

/** 造一个内容非零的块，便于「完整输入」对照组产出非全黑图。 */
function makeBlock(bytes) {
  const block = Buffer.alloc(bytes);
  if (bytes === 8) {
    block.writeUInt16LE(0xf800, 0);
    block.writeUInt16LE(0x001f, 2);
    block.writeUInt32LE(0x1b1b1b1b, 4);
  } else {
    block[0] = 0x40;   // BC7 mode 6
    block[1] = 0x7f;
    block[8] = 0xaa;
  }
  return block;
}

function openDaemon() {
  const child = spawn(exe, ['daemon'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let buffer = '';
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let i = buffer.indexOf('\n');
    while (i >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line.length > 0) {
        let frame = null;
        try { frame = JSON.parse(line); } catch { /* 中间态 */ }
        if (frame !== null) {
          const id = frame.requestId ?? null;
          const terminal = frame.kind === 'result' || frame.kind === 'error' || frame.kind === 'handshake';
          if (terminal && id !== null && pending.has(id)) { pending.get(id)(frame); pending.delete(id); }
        }
      }
      i = buffer.indexOf('\n');
    }
  });
  return {
    child,
    send(frame) {
      return new Promise((res, rej) => {
        const timer = setTimeout(() => {
          pending.delete(frame.requestId);
          rej(new Error(`BRIDGE_TIMEOUT: ${frame.requestId}；stderr=${stderr.slice(0, 400)}`));
        }, 60_000);
        pending.set(frame.requestId, (r) => { clearTimeout(timer); res(r); });
        child.stdin.write(`${JSON.stringify(frame)}\n`);
      });
    }
  };
}

let daemon;
let seq = 0;

async function exportPng(name, ddsBytes) {
  const tpfPath = join(sourceRoot, `${name}.tpf`);
  writeFileSync(tpfPath, buildSyntheticTpf(name, ddsBytes));
  const outputPath = join(exportRoot, `${name}.png`);
  seq += 1;
  const response = await daemon.send({
    kind: 'request',
    protocolVersion: '1.0.0',
    requestId: `trunc-${seq}`,
    workspaceSessionId: SESSION,
    payload: {
      command: 'export-tpf-texture',
      filePath: tpfPath,
      options: { textureIndex: 0, format: 'png', outputPath }
    }
  });
  const diagnostics = response.payload?.result?.diagnostics ?? [];
  return {
    parseStatus: response.payload?.result?.parseStatus ?? response.kind,
    codes: diagnostics.map((d) => d.code),
    messages: diagnostics.map((d) => d.message),
    pngWritten: existsSync(outputPath),
    outputPath
  };
}

/**
 * 逐格式的块字节数。判据刻意在 harness 里另写一份而不是从 C# 读——
 * 若从 C# 读，改坏 C# 的块字节表会同时改坏期望值，两边同步走偏而门禁报绿。
 * 数值依据是各 Decode* 的块步进（实测：BC1 :263 与 BC4 :304 是 *8，
 * BC3 :171、BC5 :317、BC7 :669 是 *16）。
 */
const FORMATS = Object.freeze([
  { label: 'BC1 (dxgi 71)', dxgi: 71, blockBytes: 8, fourCc: null },
  { label: 'BC3 (dxgi 77)', dxgi: 77, blockBytes: 16, fourCc: null },
  { label: 'BC4 (dxgi 80)', dxgi: 80, blockBytes: 8, fourCc: null },
  { label: 'BC5 (dxgi 83)', dxgi: 83, blockBytes: 16, fourCc: null },
  { label: 'BC7 (dxgi 98)', dxgi: 98, blockBytes: 16, fourCc: null },
  // fourCC 形态数据区起点不同（128 而非 148），必须单独覆盖：
  // 若可用字节按 148 算，fourCC 形态会被少算 20 字节而误拒真实纹理。
  { label: 'ATI1 (fourCC, BC4)', dxgi: null, blockBytes: 8, fourCc: 'ATI1' },
  { label: 'DXT1 (fourCC, BC1)', dxgi: null, blockBytes: 8, fourCc: 'DXT1' }
]);

try {
  daemon = openDaemon();
  const handshake = await daemon.send({
    kind: 'handshake',
    protocolVersion: '1.0.0',
    requestId: 'handshake-1',
    workspaceSessionId: SESSION,
    payload: { allowedRoots: [sourceRoot, exportRoot], writableRoots: [exportRoot] }
  });
  if (handshake.kind !== 'handshake') {
    throw new Error(`BRIDGE_HANDSHAKE_FAILED: ${JSON.stringify(handshake.payload).slice(0, 300)}`);
  }

  // 8x8 = 2×2 = 4 块
  const WIDTH = 8;
  const HEIGHT = 8;
  const BLOCK_COUNT = 4;

  for (const format of FORMATS) {
    const block = makeBlock(format.blockBytes);
    const full = Buffer.concat(Array.from({ length: BLOCK_COUNT }, () => block));
    const build = (pixels) => (format.fourCc === null
      ? buildDx10Dds(WIDTH, HEIGHT, pixels, format.dxgi)
      : buildFourCcDds(WIDTH, HEIGHT, pixels, format.fourCc));
    const slug = format.label.replace(/[^\w]/g, '-');

    // ---- ② 对照组：完整数据必须照常成功（防「一刀切拒绝」）----
    const okResult = await exportPng(`trunc-${slug}-full`, build(full));
    check(
      `${format.label}: 完整块数据必须照常导出成功（对照组，防判据退化成一律拒绝）`,
      okResult.parseStatus !== 'failed' && okResult.pngWritten,
      okResult
    );

    // ---- ② 补充：多余字节（mip 链）不得被误判为异常 ----
    // 真实纹理带 mip 链时数据区长于 mip 0 所需，若判据写成「必须恰好相等」会误拒。
    const withExtraMips = Buffer.concat([full, block, block]);
    const extraResult = await exportPng(`trunc-${slug}-extra`, build(withExtraMips));
    check(
      `${format.label}: 数据区长于 mip 0 所需（mip 链形态）不得被拒`,
      extraResult.parseStatus !== 'failed' && extraResult.pngWritten,
      extraResult
    );

    // ---- ① 截断必须失败关闭 ----
    const truncations = [
      { name: 'half', pixels: full.subarray(0, format.blockBytes * 2), note: '只给 2/4 块' },
      { name: 'quarter', pixels: full.subarray(0, format.blockBytes), note: '只给 1/4 块' },
      { name: 'empty', pixels: Buffer.alloc(0), note: '零像素数据（会产出 100% 纯黑图）' },
      // 差一个字节：最容易被 off-by-one 判据漏掉的形态。
      { name: 'minus1', pixels: full.subarray(0, format.blockBytes * BLOCK_COUNT - 1), note: '差 1 字节' }
    ];
    for (const truncation of truncations) {
      const result = await exportPng(`trunc-${slug}-${truncation.name}`, build(truncation.pixels));
      check(
        `${format.label} ${truncation.note}: 必须 failed 而不是导出半黑图`,
        result.parseStatus === 'failed',
        result
      );
      check(
        `${format.label} ${truncation.note}: 诊断码必须是 TPF_TEXTURE_EXPORT_FAILED`,
        result.codes.includes('TPF_TEXTURE_EXPORT_FAILED'),
        { codes: result.codes, messages: result.messages }
      );
      check(
        `${format.label} ${truncation.note}: 不得留下 PNG 文件（半成品本身就是误导）`,
        !result.pngWritten,
        result
      );
      // 诊断消息必须说清缺多少，而不是只说「失败了」——「读不出来」与
      // 「数据比声明的短 N 字节」指向完全不同的排查方向。
      check(
        `${format.label} ${truncation.note}: 诊断消息必须给出所需与实际字节数`,
        result.messages.some((m) => typeof m === 'string' && m.includes('截断') && /\d+\s*字节/.test(m)),
        { messages: result.messages }
      );
    }
  }

  // ---- 宽高非法必须失败关闭（否则 new byte[] 会抛与格式无关的异常）----
  for (const [w, h, note] of [[0, 8, '宽为 0'], [8, 0, '高为 0'], [-4, 8, '宽为负']]) {
    const dds = buildDx10Dds(w, h, Buffer.alloc(64), 98);
    const result = await exportPng(`trunc-dim-${w}x${h}`.replace('-', 'n'), dds);
    check(
      `宽高非法（${note}）: 必须 failed 且不留 PNG`,
      result.parseStatus === 'failed' && !result.pngWritten,
      result
    );
  }
} catch (error) {
  report({
    ok: false,
    gate: LABEL,
    status: 'failed',
    code: 'DDS_TRUNCATION_HARNESS_FAILED',
    message: error instanceof Error ? error.message : String(error),
    checks
  }, 1);
} finally {
  if (daemon) {
    daemon.child.stdin.end();
    try { daemon.child.kill(); } catch { /* 已退出 */ }
  }
  rmSync(scratch, { recursive: true, force: true });
}

if (findings.length > 0) {
  report({
    ok: false,
    gate: LABEL,
    status: 'failed',
    code: 'DDS_TRUNCATION_REGRESSION',
    message: '截断的 DDS 未被失败关闭，或完整 DDS 被误拒。',
    passed: checks.length - findings.length,
    failed: findings.length,
    findings
  }, 1);
}

report({
  ok: true,
  gate: LABEL,
  status: 'passed',
  assertions: checks.length,
  formatsCovered: FORMATS.map((f) => f.label),
  evidence: 'runtime-observed：经生产命令 export-tpf-texture(format=png) 真实解码',
  fixture: 'synthetic 截断 DDS-in-TPF（微小、合法构造、明确标记，非 native authority）',
  message: '七种格式/头形态各测「完整」「带 mip 链多余字节」「截断一半」「截断 3/4」'
    + '「零数据」「差 1 字节」六档；截断一律 failed 且不留 PNG，完整与 mip 链形态照常成功。',
  nonClaims: [
    '不声称真实语料存在截断纹理：本门禁用构造样本，真实 Sekiro 语料实测 52/52 纹理'
      + '数据完整、未触发本判据。它守的是「若出现截断则必须报错」这条性质。',
    '不声称 mip 链已解析：DecodeDds 只解 mip 0，本门禁只断言多余的 mip 字节不导致误拒。',
    '不构成 DDS 头全字段校验：只校验宽高与块数据长度两项，其余字段（depth/arraySize/'
      + 'misc flags）未校验。',
    'BC2 / BC6H 未覆盖：DdsCodec 刻意未实现（真实语料零命中），补判据会造出零覆盖代码。'
  ]
}, 0);
