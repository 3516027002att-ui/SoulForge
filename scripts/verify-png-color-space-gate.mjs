#!/usr/bin/env node
/**
 * PNG 色彩空间声明门禁。
 *
 * 守的是 export-tpf-texture(format=png) 是否**如实**把 DDS 声明的色彩空间带到 PNG。
 *
 * ── 为什么这条缺失是真缺陷，而不是「锦上添花」──
 * DXGI 把同一种块压缩分成 UNORM 与 UNORM_SRGB 两个格式号（BC7 是 98/99，
 * BC1 是 71/72）。两者**块字节完全相同、解码出的 RGBA 数值也完全相同**，唯一差别
 * 是这些数值该被解释为线性光还是 sRGB 编码值。此前实现把 98/99 合并成同一条路径
 * （DdsCodec.cs 的 dxgi switch），EncodePng 只写 IHDR/IDAT/IEND，于是这个区分在
 * 导出产物里**彻底消失**。
 *
 * 实测真实语料（4 个 Sekiro texbnd / 52 纹理）里受影响的是多数：
 * BC7_UNORM_SRGB 12 + BC1_UNORM_SRGB 24 = 36/52 张纹理的 sRGB 声明被丢弃。
 *
 * 这类缺陷不会让任何既有断言变红，这正是它需要专门门禁的原因：
 *   · 不做色彩管理的查看器（多数图片浏览器）显示正常；
 *   · 做色彩管理的查看器（浏览器、Photoshop）按自身默认假设解释，亮度偏移；
 *   · 逐像素判据全部通过——因为像素值本来就没变，丢的是**元数据**。
 * 与「ddsValid 名不符实」「ESD 声明量算了却不比较」同一形态：数据在手，不表达
 * 出来就等于失真（硬约束 7）。
 *
 * ── 判据打在哪 ──
 * 全部经**生产命令** export-tpf-texture(format=png) 产出真实 PNG 字节，再由本
 * harness 独立解析 chunk 序列。不读 C# 源码字面量：改名、改常量都不该让判据失效，
 * 只有产物真的对才算对。
 *
 * 四个维度：
 *   ① dxgi 99（BC7_UNORM_SRGB）与 72（BC1_UNORM_SRGB）→ 必须有 sRGB chunk，
 *      且 gAMA/cHRM 逐字节等于规范推荐值。
 *   ② dxgi 98（BC7_UNORM）与 71（BC1_UNORM）→ 必须**没有** sRGB chunk。
 *      「多写」和「少写」都是谎报，所以正反两侧都要钉住。
 *   ③ 非 DX10 fourCC（ATI1）→ 没有 sRGB chunk，且必须报
 *      TPF_TEXTURE_COLOR_SPACE_UNDECLARED 诊断。「未声明」与「已确认线性」在产物上
 *      完全一样（都没有 chunk），只有诊断能区分它们。
 *   ④ chunk 顺序与像素不受影响：sRGB/gAMA/cHRM 必须在 IHDR 之后 IDAT 之前
 *      （PNG 规范要求），且加了 chunk 之后 RGBA 像素与不加时逐字节一致——
 *      否则「补元数据」就悄悄改了图像内容。
 *
 * gAMA/cHRM 的期望值是**双源核对**过的（2026-08-08）：W3C REC-PNG-20031110 与
 * libpng PNG-Chunks 1.2 两处逐值一致——gAMA=45455、白点 (31270,32900)、
 * 红 (64000,33000)、绿 (30000,60000)、蓝 (15000,6000)。本仓库有过「规格表看着有
 * 规律、实测推导失败 50/64」的教训，故这些值只从规格抄、不推导，且在本文件与
 * C# 各存一份——若 harness 改为从 C# 读取，改坏 C# 会同时改坏期望值，两边同步
 * 走偏而门禁报绿。
 *
 * 归 synthetic 层：DDS/TPF 可自造，不需要真实游戏资产；但解码在 C# 侧，需要真实
 * Bridge exe。与 test:bc7-decode / test:bc3-color-block 同一惯例。
 *
 * ── 负向证明（2026-08-08 实测八条，每条都退化 C# 生产代码后强制重建再跑）──
 * 本门禁首跑即 35 条全绿，而「首跑全绿」恰恰是假门禁最常见的表现，所以逐条证明：
 *   D1 sRGB 分支整体关掉（即修复前的行为）        → 8 条红，含「必须写 sRGB chunk」
 *   D2 gAMA 45455 → 45454（差 1）                → 2 条红，点名 gAMA 期望值
 *   D3 cHRM 蓝 y 6000 → 6001（八值里改一个）      → 2 条红，点名 cHRM 逐值比对
 *   D4 把 dxgi 98 也判成 Srgb（谎报线性为 sRGB）   → 2 条红，点名「不得写任何色彩空间 chunk」
 *   D5 只认 BC7 的 99、漏掉 BC1 的 72             → 5 条红，点名 dxgi 72 那组
 *   D6 去掉 UNDECLARED 诊断                       → 1 条红，点名该诊断码
 *   D7 生产路径退回不带色彩空间的 EncodePng 重载    → 8 条红（接线断开等于全丢）
 *   D8 在 sRGB 分支偷偷做数值缩放                  → 2 条红，点名「RGBA 逐字节一致」
 * 八条全部红在**目标断言**上，不是红在「一切都坏了」——退化只破坏被测的那一件事。
 * 还原后强制重建复跑回 35/35 绿。
 *
 * ⚠️ 复现时必须 `--no-incremental`：实测还原源码后增量构建不重编，D8 的像素扰动
 *    留在二进制里，导致复跑报 2 条假红，看起来像判据自己有 bug。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const LABEL = 'png-color-space';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXE_CANDIDATES = [
  join(root, 'bridge', 'SoulForge.Bridge', 'bin', 'Release', 'net10.0', 'win-x64', 'publish', 'SoulForge.Bridge.exe'),
  join(root, 'bridge', 'SoulForge.Bridge', 'bin', 'Debug', 'net10.0', 'win-x64', 'SoulForge.Bridge.exe')
];

/**
 * PNG 规范推荐的 sRGB 伴随值（实际值 ×100000）。
 * 双源核对：W3C REC-PNG-20031110 与 libpng PNG-Chunks 1.2 完全一致。
 * 刻意硬编码而不从 C# 读——见文件头注释里「副本即 oracle」的理由。
 */
const EXPECTED_GAMA = 45455;
const EXPECTED_CHRM = Object.freeze([31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000]);
/** sRGB chunk 的 rendering intent：0 = Perceptual。 */
const EXPECTED_SRGB_INTENT = 0;

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
    reason: 'Bridge 可执行文件缺失，无法做运行期导出验证。',
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

const scratch = mkdtempSync(join(tmpdir(), 'sf-pngcs-'));
const sourceRoot = join(scratch, 'source');
const exportRoot = join(scratch, 'export');
mkdirSync(sourceRoot, { recursive: true });
mkdirSync(exportRoot, { recursive: true });
const SESSION = 'png-color-space-gate';

// ---------------------------------------------------------------------------
// fixture 构造
// ---------------------------------------------------------------------------

/**
 * 构造 DX10 头的块压缩 DDS。blockBytes 是每块字节数（BC1/BC4 为 8，BC7 为 16）。
 * 字段偏移与 DdsCodec.DecodeDds 实际读取处对齐。
 */
function buildDx10Dds(width, height, blocks, dxgiFormat, blockBytes) {
  const blocksWide = Math.max(1, Math.ceil(width / 4));
  const blocksHigh = Math.max(1, Math.ceil(height / 4));
  if (blocks.length !== blocksWide * blocksHigh) {
    throw new Error(`DDS_BLOCK_COUNT: ${width}x${height} 需要 ${blocksWide * blocksHigh} 块，收到 ${blocks.length}。`);
  }
  for (const block of blocks) {
    if (block.length !== blockBytes) {
      throw new Error(`DDS_BLOCK_SIZE: 期望每块 ${blockBytes} 字节，收到 ${block.length}。`);
    }
  }
  const pixels = Buffer.concat(blocks);
  const dds = Buffer.alloc(148 + pixels.length);
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

/**
 * 构造非 DX10（fourCC）形态的 DDS。用于 ③：这类头不携带色彩空间信息。
 * 用 ATI1（BC4）而非 DXT1——真实语料里 ATI1 有 3 个命中，DXT1/DXT5 零命中，
 * 拿真实存在的形态做靶标，判据才对着真问题。
 */
function buildFourCcDds(width, height, blocks, fourCc) {
  const pixels = Buffer.concat(blocks);
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

/**
 * 构造最小 TPF（单纹理）。布局按 TpfNativeDocument.Read 实际读法：
 * 16 字节头 + 20 字节条目 + UTF-16LE 名字（双字节 NUL）+ DDS blob。
 */
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
  tpf.writeUInt8(0, 0x0C);
  tpf.writeUInt8(0, 0x0D);
  tpf.writeUInt8(0, 0x0E);
  tpf.writeUInt8(0, 0x0F);

  const e = headerSize;
  tpf.writeUInt32LE(dataOffset, e);
  tpf.writeUInt32LE(ddsBytes.length, e + 4);
  tpf.writeUInt8(0, e + 8);
  tpf.writeUInt8(0, e + 9);
  tpf.writeUInt16LE(1, e + 10);
  tpf.writeUInt32LE(nameOffset, e + 12);
  tpf.writeUInt32LE(0, e + 16);

  nameBytes.copy(tpf, nameOffset);
  ddsBytes.copy(tpf, dataOffset);
  return tpf;
}

/**
 * BC1 块（8 字节）：c0 > c1 走 4 色不透明模式，产出非退化颜色。
 * 这里不需要精确期望像素——本门禁判的是元数据，像素只需「两次导出一致」。
 */
function makeBc1Block() {
  const block = Buffer.alloc(8);
  block.writeUInt16LE(0xf800, 0); // c0：纯红（565）
  block.writeUInt16LE(0x001f, 2); // c1：纯蓝，c0 > c1
  block.writeUInt32LE(0x1b1b1b1b, 4); // 索引混用四个调色板项
  return block;
}

/** BC4 块（8 字节）：两个 alpha 端点 + 16 个 3 位索引。 */
function makeBc4Block() {
  const block = Buffer.alloc(8);
  block[0] = 0xf0;
  block[1] = 0x10;
  for (let i = 2; i < 8; i++) block[i] = 0x6d;
  return block;
}

/**
 * BC7 mode 6 块（16 字节）：mode 位是最低位的 1（0b1000000 → 第 6 位）。
 * mode 6 无 partition、无 rotation，端点 7 位 + P-bit，索引 4 位。
 * 只要是**合法 mode 6 块**即可——本门禁不判像素值（那是 test:bc7-decode 的职责）。
 */
function makeBc7Mode6Block() {
  const block = Buffer.alloc(16);
  // mode 6 = 低 7 位为 1000000b：bit0..bit5 = 0，bit6 = 1。
  block[0] = 0x40;
  // 端点与索引位随便给一组非零值，保证解码结果非全零。
  block[1] = 0x7f;
  block[2] = 0x3a;
  block[3] = 0x55;
  block[8] = 0xaa;
  block[9] = 0x55;
  block[12] = 0x3c;
  block[15] = 0x81;
  return block;
}

// ---------------------------------------------------------------------------
// PNG 解析（独立实现，只为观测 chunk 序列与像素）
// ---------------------------------------------------------------------------

/**
 * 解析 PNG，返回 chunk 序列（按出现顺序）与 RGBA 像素。
 * chunk 数据一并返回，供逐字节比对 gAMA/cHRM。
 */
function decodePng(bytes) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!bytes.subarray(0, 8).equals(signature)) throw new Error('PNG_SIGNATURE_INVALID');
  let at = 8;
  let ihdr = null;
  const idat = [];
  const chunks = [];
  while (at + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.subarray(at + 4, at + 8).toString('ascii');
    const data = Buffer.from(bytes.subarray(at + 8, at + 8 + length));
    // CRC 必须校验：写 chunk 时算错 CRC 会让产物在严格解码器里直接非法，
    // 而只看「chunk 在不在」的判据对此完全失明。
    const declaredCrc = bytes.readUInt32BE(at + 8 + length);
    const actualCrc = crc32(bytes.subarray(at + 4, at + 8 + length));
    chunks.push({ type, data, crcValid: declaredCrc === actualCrc });
    if (type === 'IHDR') ihdr = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') { at += 12 + length; break; }
    at += 12 + length;
  }
  if (ihdr === null) throw new Error('PNG_IHDR_MISSING');
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(`PNG_UNEXPECTED_FORMAT: bitDepth=${bitDepth} colorType=${colorType}，期望 8/6 (RGBA8)。`);
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rgba = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter !== 0) throw new Error(`PNG_FILTER_UNSUPPORTED: 第 ${y} 行 filter=${filter}，harness 只支持 0。`);
    raw.copy(rgba, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  }
  return { width, height, rgba, chunks, chunkTypes: chunks.map((c) => c.type) };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// daemon 客户端
// ---------------------------------------------------------------------------

/** NDJSON daemon 客户端：只解析终态帧（accepted/progress 是中间态）。 */
function openDaemon() {
  const child = spawn(exe, ['daemon'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let buffer = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) {
        let frame;
        try { frame = JSON.parse(line); } catch { frame = null; }
        if (frame !== null) {
          const requestId = frame.requestId ?? null;
          const isTerminal = frame.kind === 'result' || frame.kind === 'error' || frame.kind === 'handshake';
          if (isTerminal && requestId !== null && pending.has(requestId)) {
            pending.get(requestId)(frame);
            pending.delete(requestId);
          }
        }
      }
      index = buffer.indexOf('\n');
    }
  });
  return {
    child,
    send(frame) {
      return new Promise((resolveFrame, rejectFrame) => {
        const timer = setTimeout(() => {
          pending.delete(frame.requestId);
          rejectFrame(new Error(`BRIDGE_TIMEOUT: ${frame.requestId}；stderr=${stderr.slice(0, 400)}`));
        }, 60_000);
        pending.set(frame.requestId, (response) => { clearTimeout(timer); resolveFrame(response); });
        child.stdin.write(`${JSON.stringify(frame)}\n`);
      });
    }
  };
}

let daemon;
let requestSeq = 0;

/** 走真实生产命令导出 PNG，返回解析后的 PNG 与结果信封。 */
async function exportPng(name, ddsBytes) {
  const tpfPath = join(sourceRoot, `${name}.tpf`);
  writeFileSync(tpfPath, buildSyntheticTpf(name, ddsBytes));
  const outputPath = join(exportRoot, `${name}.png`);
  requestSeq += 1;
  const response = await daemon.send({
    kind: 'request',
    protocolVersion: '1.0.0',
    requestId: `pngcs-${requestSeq}`,
    workspaceSessionId: SESSION,
    payload: {
      command: 'export-tpf-texture',
      filePath: tpfPath,
      options: { textureIndex: 0, format: 'png', outputPath }
    }
  });
  if (response.kind !== 'result' || response.payload?.result?.parseStatus === 'failed') {
    return {
      failed: true,
      kind: response.kind,
      code: response.payload?.code ?? response.payload?.result?.diagnostics?.[0]?.code ?? null,
      message: response.payload?.message ?? response.payload?.result?.diagnostics?.[0]?.message ?? null
    };
  }
  if (!existsSync(outputPath)) return { failed: true, code: 'PNG_NOT_WRITTEN' };
  return {
    failed: false,
    png: decodePng(readFileSync(outputPath)),
    result: response.payload.result,
    diagnostics: response.payload.result?.diagnostics ?? []
  };
}

/** 断言一份 PNG 带有完整且数值正确的 sRGB 三件套。 */
function assertSrgbChunks(label, png) {
  const srgb = png.chunks.find((c) => c.type === 'sRGB') ?? null;
  check(`${label}: 必须写 sRGB chunk`, srgb !== null, { chunkTypes: png.chunkTypes });
  if (srgb !== null) {
    check(
      `${label}: sRGB chunk 为 1 字节且 rendering intent = ${EXPECTED_SRGB_INTENT}（Perceptual）`,
      srgb.data.length === 1 && srgb.data[0] === EXPECTED_SRGB_INTENT,
      { length: srgb.data.length, intent: srgb.data[0] ?? null }
    );
    check(`${label}: sRGB chunk CRC 合法`, srgb.crcValid, { crcValid: srgb.crcValid });
  }

  const gama = png.chunks.find((c) => c.type === 'gAMA') ?? null;
  check(`${label}: 必须写规范推荐的 gAMA 伴随值`, gama !== null, { chunkTypes: png.chunkTypes });
  if (gama !== null) {
    const value = gama.data.length === 4 ? gama.data.readUInt32BE(0) : null;
    check(
      `${label}: gAMA = ${EXPECTED_GAMA}（双源核对值）`,
      value === EXPECTED_GAMA,
      { expected: EXPECTED_GAMA, actual: value }
    );
    check(`${label}: gAMA chunk CRC 合法`, gama.crcValid, { crcValid: gama.crcValid });
  }

  const chrm = png.chunks.find((c) => c.type === 'cHRM') ?? null;
  check(`${label}: 必须写规范推荐的 cHRM 伴随值`, chrm !== null, { chunkTypes: png.chunkTypes });
  if (chrm !== null) {
    const actual = chrm.data.length === 32
      ? Array.from({ length: 8 }, (_, i) => chrm.data.readUInt32BE(i * 4))
      : null;
    check(
      `${label}: cHRM 八个值逐个等于规范推荐值`,
      actual !== null && EXPECTED_CHRM.every((v, i) => actual[i] === v),
      { expected: [...EXPECTED_CHRM], actual }
    );
    check(`${label}: cHRM chunk CRC 合法`, chrm.crcValid, { crcValid: chrm.crcValid });
  }

  // 顺序：色彩空间 chunk 必须在 IHDR 之后、第一个 IDAT 之前（PNG 规范硬要求）。
  const ihdrAt = png.chunkTypes.indexOf('IHDR');
  const firstIdatAt = png.chunkTypes.indexOf('IDAT');
  const ordered = ['sRGB', 'gAMA', 'cHRM'].every((type) => {
    const at = png.chunkTypes.indexOf(type);
    return at > ihdrAt && at < firstIdatAt;
  });
  check(
    `${label}: sRGB/gAMA/cHRM 均位于 IHDR 之后、IDAT 之前（规范要求的顺序）`,
    ordered,
    { chunkTypes: png.chunkTypes, ihdrAt, firstIdatAt }
  );
}

/** 断言一份 PNG **没有**任何色彩空间 chunk。多写和少写都是谎报。 */
function assertNoColorSpaceChunks(label, png) {
  const present = png.chunkTypes.filter((t) => t === 'sRGB' || t === 'gAMA' || t === 'cHRM');
  check(
    `${label}: 不得写任何色彩空间 chunk（写了就是把未声明/线性谎报成 sRGB）`,
    present.length === 0,
    { unexpectedChunks: present, chunkTypes: png.chunkTypes }
  );
}

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

  const bc7Block = makeBc7Mode6Block();
  const bc1Block = makeBc1Block();
  const bc4Block = makeBc4Block();

  // ---- ① sRGB 变体必须声明 ----
  // 两个格式族都测：只测 BC7 的话，「BC1 的 72 漏判」会静默通过——而真实语料里
  // BC1_UNORM_SRGB 有 24 个，比 BC7 的 SRGB 变体还多。
  const srgbCases = [
    { label: 'dxgi 99 (BC7_UNORM_SRGB)', dxgi: 99, block: bc7Block, blockBytes: 16 },
    { label: 'dxgi 72 (BC1_UNORM_SRGB)', dxgi: 72, block: bc1Block, blockBytes: 8 }
  ];
  const srgbPixels = new Map();
  for (const item of srgbCases) {
    const dds = buildDx10Dds(4, 4, [item.block], item.dxgi, item.blockBytes);
    const result = await exportPng(`pngcs-dxgi${item.dxgi}`, dds);
    if (result.failed) {
      check(`${item.label}: export-tpf-texture(format=png) 必须成功`, false, result);
      continue;
    }
    assertSrgbChunks(item.label, result.png);
    check(
      `${item.label}: 信封 colorSpace 字段必须报 srgb`,
      result.result?.data?.colorSpace === 'srgb',
      { colorSpace: result.result?.data?.colorSpace ?? null }
    );
    srgbPixels.set(item.dxgi, result.png.rgba);
  }

  // ---- ② 线性变体必须不声明 ----
  const linearCases = [
    { label: 'dxgi 98 (BC7_UNORM)', dxgi: 98, block: bc7Block, blockBytes: 16, pairWith: 99 },
    { label: 'dxgi 71 (BC1_UNORM)', dxgi: 71, block: bc1Block, blockBytes: 8, pairWith: 72 }
  ];
  for (const item of linearCases) {
    const dds = buildDx10Dds(4, 4, [item.block], item.dxgi, item.blockBytes);
    const result = await exportPng(`pngcs-dxgi${item.dxgi}`, dds);
    if (result.failed) {
      check(`${item.label}: export-tpf-texture(format=png) 必须成功`, false, result);
      continue;
    }
    assertNoColorSpaceChunks(item.label, result.png);
    check(
      `${item.label}: 信封 colorSpace 字段必须报 linear`,
      result.result?.data?.colorSpace === 'linear',
      { colorSpace: result.result?.data?.colorSpace ?? null }
    );
    // ---- ④ 补元数据不得改动像素 ----
    // 同一份块字节在 UNORM 与 UNORM_SRGB 下解码数值必须完全相同（规范如此：
    // 差别只在解释，不在数值）。若将来有人「顺手」加了 sRGB↔linear 转换，
    // 这条会立刻红——那种改动会静默改变全部导出图像的亮度。
    const srgbRgba = srgbPixels.get(item.pairWith);
    if (srgbRgba !== undefined) {
      check(
        `${item.label}: 与 dxgi ${item.pairWith} 的 RGBA 逐字节一致（色彩空间只标注、不转换数值）`,
        Buffer.compare(result.png.rgba, srgbRgba) === 0,
        {
          linearFirstPixel: [...result.png.rgba.subarray(0, 4)],
          srgbFirstPixel: [...srgbRgba.subarray(0, 4)]
        }
      );
    }
    // 非退化：全零像素会让上面那条逐字节比对变成「两个全零缓冲相等」，恒真。
    const nonZero = [...result.png.rgba].some((v) => v !== 0);
    check(
      `${item.label}: 解码结果非全零（否则像素一致性判据会恒真）`,
      nonZero,
      { allZero: !nonZero, firstPixel: [...result.png.rgba.subarray(0, 4)] }
    );
  }

  // ---- ③ 非 DX10 fourCC：未声明，且必须有诊断 ----
  const fourCcDds = buildFourCcDds(4, 4, [bc4Block], 'ATI1');
  const fourCcResult = await exportPng('pngcs-ati1', fourCcDds);
  if (fourCcResult.failed) {
    check('ATI1 (非 DX10 fourCC): export-tpf-texture(format=png) 必须成功', false, fourCcResult);
  } else {
    assertNoColorSpaceChunks('ATI1 (非 DX10 fourCC)', fourCcResult.png);
    check(
      'ATI1 (非 DX10 fourCC): 信封 colorSpace 字段必须报 unknown',
      fourCcResult.result?.data?.colorSpace === 'unknown',
      { colorSpace: fourCcResult.result?.data?.colorSpace ?? null }
    );
    // 这条是本门禁最容易被忽略的一条：「未声明」与「已确认线性」在 PNG 产物上
    // 完全一样（都没有 chunk）。没有诊断的话，用户拿到一张色彩空间不明的图而
    // 毫不知情，且下游无从区分这两种情形。
    const codes = fourCcResult.diagnostics.map((d) => d.code);
    check(
      'ATI1 (非 DX10 fourCC): 必须报 TPF_TEXTURE_COLOR_SPACE_UNDECLARED（未声明≠已确认线性）',
      codes.includes('TPF_TEXTURE_COLOR_SPACE_UNDECLARED'),
      { diagnosticCodes: codes }
    );
  }

  // ---- 诊断只在 unknown 出现：对 srgb/linear 报「未声明」是噪声，也会掩盖真问题 ----
  for (const dxgi of [99, 98]) {
    const blockBytes = 16;
    const dds = buildDx10Dds(4, 4, [bc7Block], dxgi, blockBytes);
    const result = await exportPng(`pngcs-nodiag-${dxgi}`, dds);
    if (result.failed) continue;
    const codes = result.diagnostics.map((d) => d.code);
    check(
      `dxgi ${dxgi}: 色彩空间已声明，不得报 TPF_TEXTURE_COLOR_SPACE_UNDECLARED`,
      !codes.includes('TPF_TEXTURE_COLOR_SPACE_UNDECLARED'),
      { diagnosticCodes: codes }
    );
  }
} catch (error) {
  report({
    ok: false,
    gate: LABEL,
    status: 'failed',
    code: 'PNG_COLOR_SPACE_HARNESS_FAILED',
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
    code: 'PNG_COLOR_SPACE_REGRESSION',
    message: '导出 PNG 的色彩空间声明与 DDS 头声明不一致。',
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
  evidence: 'runtime-observed：经生产命令 export-tpf-texture(format=png) 产出真实 PNG 字节，独立解析 chunk 序列',
  fixture: 'synthetic BC7/BC1/BC4-in-DDS-in-TPF（微小、合法构造、明确标记，非 native authority）',
  message: 'sRGB 变体（dxgi 99/72）写全 sRGB+gAMA+cHRM 且数值等于双源核对的规范推荐值；'
    + '线性变体（dxgi 98/71）不写任何色彩空间 chunk；非 DX10 fourCC 报未声明诊断；'
    + '色彩空间只标注不转换（UNORM 与 UNORM_SRGB 的 RGBA 逐字节一致）。',
  nonClaims: [
    '不声称色彩管理已完整：本门禁只证明「DDS 头声明的色彩空间被如实带到 PNG」，'
      + '不证明游戏内的实际显示与导出图一致——那需要与游戏渲染管线对照，属独立议题。',
    '不声称 sRGB 数值转换正确：实现刻意不做 sRGB↔linear 转换（PNG 的 sRGB chunk 表达的正是'
      + '「样本值已是 sRGB 编码值」），故不存在需要验证的转换公式。',
    '非 DX10 fourCC 的真实色彩空间未判定：DXT1/ATI1 这类 fourCC 早于 DXGI 的 SRGB 变体，'
      + '头里确实没有该信息。本门禁断言的是「如实报未声明」，不是「推断出了正确答案」。',
    'mip 链未覆盖：DecodeDds 只解 mip 0，fixture 也只有 mip 0。',
    '不构成 PNG writer 的完整规范一致性声明：只覆盖本实现实际写出的 chunk 集合'
      + '（IHDR/sRGB/gAMA/cHRM/IDAT/IEND），未做 PNG 规范全量一致性测试。'
  ]
}, 0);
