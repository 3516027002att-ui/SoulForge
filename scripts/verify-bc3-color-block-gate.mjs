#!/usr/bin/env node
/**
 * BC3 (DXT5) 颜色块解码常驻门禁。
 *
 * 守的是 DdsCodec.cs 的 DecodeBc3ColorBlock：**BC2/BC3 的颜色块恒用 4 色不透明
 * 插值，没有 BC1 那套 punchthrough（3 色 + 透明黑）模式**，且颜色块一律不得改写
 * alpha 通道（BC3 的 alpha 唯一权威是前 8 字节的 alpha 块）。
 *
 * ── 为什么需要这条门禁（它守的是一个真实存在过的缺陷）──
 *
 * 修复前 DecodeBc3 复用的是一个叫 DecodeBc1ColorOnly 的函数，它带着 BC1 的
 * `if (c0 > c1) … else 3色+黑` 分支，并在 `c0 <= c1 && idx == 3` 时把 alpha
 * **强行覆写为 0**。后果是所有 c0 <= c1 的 BC3 块同时出现两种错误：
 *   ① 调色板槽 2/3 取值错误（应为 2:1 / 1:2 插值，实得 1:1 平均与纯黑）；
 *   ② alpha 块里已正确解出的值被无声丢弃、像素被错误透明化。
 * c0 == c1 也落进 `c0 <= c1`，而编码器对低色彩变化块产出 c0 == c1 非常常见，
 * 所以这不是边角形态。
 *
 * ── 判据为什么必须打在像素值上 ──
 *
 * 这个缺陷的失效形态是**静默的**：PNG 结构完好、宽高正确、导出成功、不抛异常。
 * 定在「导出成功」那一层，带 punchthrough 分支的实现会 100% 报绿。所以本门禁对
 * 每个块逐像素断言 RGBA 等于按规范推导的期望值，并且刻意让 fixture 的
 * **alpha 块给出非 0 alpha**——否则「alpha 被覆写为 0」与「alpha 本来就是 0」
 * 不可区分，②那半个缺陷会漏过。
 *
 * ── 期望值怎么来 ──
 *
 * harness 自己是编码器：先决定语义内容（c0/c1 的 565 值、4 个 2-bit 颜色索引、
 * alpha0/alpha1 与 16 个 3-bit alpha 索引），按 DXT5 块布局打包成 16 字节，再用
 * 规范公式从**同一份语义内容**算出期望像素。harness 从不解析自己写出的块，所以
 * 这不是「两个解码器互相印证」，而是「合法块 → 规范推导的期望值」。
 *
 * ── 规范依据（两个独立来源，2026-08-08 机读核验）──
 *
 * ① Khronos EXT_texture_compression_s3tc（规范正文，DXT3 与 DXT5 两节逐字相同）：
 *      "Each RGB image data block is encoded according to the
 *       COMPRESSED_RGB_S3TC_DXT1_EXT format, with the exception that the two code
 *       bits always use the non-transparent encodings. In other words, they are
 *       treated as though color0 > color1, regardless of the actual values of
 *       color0 and color1."
 *    同文档 Issue (6) 明确把 MSDN 的相反暗示判为**文档 bug**：
 *      "RESOLVED: Yes -- this appears to be a bug in the MSDN documentation.
 *       The specification for the DXT2-DXT5 formats require decoding using the
 *       opaque block encoding, regardless of the relative values of color0 and color1."
 * ② Microsoft Learn《Block Compression (Direct3D 10)》：punchthrough 分支
 *    （color_2 = 1/2*color_0 + 1/2*color_1; color_3 = 0）**只出现在 BC1 一节**。
 *    BC2/BC3 两节只说颜色「与 BC1 相同的位数和数据布局」，把差异全部限定在 alpha，
 *    未给 BC2/BC3 任何依 c0/c1 切换调色板的规则。
 * 两源结论一致；①还额外把②的措辞歧义标注为已知文档缺陷，故不存在「双源冲突」。
 *
 * ⚠️ 同一份 Khronos 文档的 NVIDIA Implementation Note 记载 NV4x/G7x 系 GPU 确实
 *    按 BC1 规则解 DXT3/DXT5，并称其 "at variance with the specification"。也就是说
 *    「有硬件这么干」是真的，但那是被规范点名的偏差，不是可选行为。本门禁按规范钉。
 *
 * ── 真实语料覆盖 ──
 *
 * 2026-08-08 实测四个 Sekiro texbnd（c4510/c5030/c6210/c8010，52 个纹理）的格式
 * 分布为 BC7_UNORM 13 / BC7_UNORM_SRGB 12 / BC1_UNORM_SRGB 24 / ATI1 3，**BC3 零
 * 命中**。所以这是「会产出错误像素但当前无样本触发」的缺陷。BC3 与 BC1 不同源自
 * 规范而非语料，且 dxgi 77 / "DXT5" 两条 dispatch 早已在 DecodeDds 里对外可达，
 * 故按规范修复并门禁化，而不是删掉分支。
 *
 * 与 BC7 门禁的分工：那条守 BC7 的 8 个 mode，完全不碰 BC1/BC3/BC4 路径；BC3 的
 * alpha 块与 BC4 共用 DecodeBc4Block，本门禁的 alpha 判据顺带覆盖到它（BC4 的
 * 两种 ramp 模式都造了 case），这是此前无门禁的一段。
 *
 * 归 synthetic：DXT5 块可自造、不需要真实游戏资产，但解码在 C# 侧需要真实 exe。
 * 与 test:bc7-decode / test:bridge-write-boundary 同一惯例。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const LABEL = 'bc3-color-block';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DDS_CODEC = resolve(root, 'bridge', 'SoulForge.Bridge', 'DdsCodec.cs');
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

// ---------------------------------------------------------------------------
// oracle 侧的规范实现副本。**刻意不从 DdsCodec.cs 读取**：harness 一旦从被测源码
// 取规则，改坏 C# 就会同步改坏期望值，两边一起走偏而门禁报绿。
// ---------------------------------------------------------------------------

/** 565 → RGB888 的位复制扩展（Khronos: 按 UNSIGNED_SHORT_5_6_5 解释）。 */
function expand565(c) {
  const r = (c >> 11) & 0x1f;
  const g = (c >> 5) & 0x3f;
  const b = c & 0x1f;
  return [
    ((r << 3) | (r >> 2)) & 0xff,
    ((g << 2) | (g >> 4)) & 0xff,
    ((b << 3) | (b >> 2)) & 0xff
  ];
}

/**
 * BC2/BC3 颜色调色板：**恒 4 色，无 c0/c1 分支**。
 * 槽 2/3 为 (2*RGB0+RGB1)/3 与 (RGB0+2*RGB1)/3，逐分量整除
 * （与规范的 non-transparent encoding 一致；C# 侧亦为整数除法）。
 */
function bc3ColorPalette(c0, c1) {
  const a = expand565(c0);
  const b = expand565(c1);
  const p2 = [0, 1, 2].map((i) => Math.floor((2 * a[i] + b[i]) / 3));
  const p3 = [0, 1, 2].map((i) => Math.floor((a[i] + 2 * b[i]) / 3));
  return [a, b, p2, p3];
}

/**
 * BC1 的调色板——**只用于负例断言**，证明本门禁能区分两种规则。
 * 生产路径永远不该对 BC3 走这条。
 */
function bc1ColorPaletteForContrast(c0, c1) {
  const a = expand565(c0);
  const b = expand565(c1);
  if (c0 > c1) return bc3ColorPalette(c0, c1);
  const p2 = [0, 1, 2].map((i) => Math.floor((a[i] + b[i]) / 2));
  return [a, b, p2, [0, 0, 0]];
}

/**
 * BC3/BC4 的 alpha ramp（8 值）。Khronos DXT5 alpha 与 Microsoft BC3/BC4 一致：
 * alpha0 > alpha1 → 6 个插值；否则 4 个插值 + 0 + 255。
 * 分母与 C# 的整数除法一致（/7、/5）。
 */
function alphaRamp(a0, a1) {
  const ramp = new Array(8).fill(0);
  ramp[0] = a0;
  ramp[1] = a1;
  if (a0 > a1) {
    for (let i = 1; i < 7; i++) ramp[i + 1] = Math.floor(((7 - i) * a0 + i * a1) / 7);
  } else {
    for (let i = 1; i < 5; i++) ramp[i + 1] = Math.floor(((5 - i) * a0 + i * a1) / 5);
    ramp[6] = 0;
    ramp[7] = 255;
  }
  return ramp;
}

/**
 * 打包一个 DXT5 (BC3) 块：8 字节 alpha 块 + 8 字节颜色块。
 * alpha 索引 3 位 ×16 = 48 位存入 6 字节，LSB-first；颜色索引 2 位 ×16 存入 4 字节。
 * 布局取自 Khronos DXT5 节（alpha0, alpha1, bits_0..bits_5，随后 color0/color1/bits）。
 */
function packBc3Block(spec) {
  const block = Buffer.alloc(16);
  block[0] = spec.alpha0;
  block[1] = spec.alpha1;
  let abits = 0n;
  for (let p = 0; p < 16; p++) {
    abits |= BigInt(spec.alphaIndices[p] & 0x7) << BigInt(3 * p);
  }
  for (let i = 0; i < 6; i++) {
    block[2 + i] = Number((abits >> BigInt(8 * i)) & 0xffn);
  }
  block.writeUInt16LE(spec.c0, 8);
  block.writeUInt16LE(spec.c1, 10);
  let cbits = 0;
  for (let p = 0; p < 16; p++) {
    cbits |= (spec.colorIndices[p] & 0x3) << (2 * p);
  }
  block.writeUInt32LE(cbits >>> 0, 12);
  return block;
}

/**
 * 由**同一份语义内容**推导期望 RGBA。paletteFn 可换成 BC1 版本以驱动负例。
 * 关键：alpha 全部来自 alpha ramp，颜色索引绝不影响 alpha——那正是被测的不变式。
 */
function expectedPixels(spec, paletteFn = bc3ColorPalette) {
  const palette = paletteFn(spec.c0, spec.c1);
  const ramp = alphaRamp(spec.alpha0, spec.alpha1);
  const out = Buffer.alloc(64);
  for (let p = 0; p < 16; p++) {
    const rgb = palette[spec.colorIndices[p] & 0x3];
    out[p * 4 + 0] = rgb[0];
    out[p * 4 + 1] = rgb[1];
    out[p * 4 + 2] = rgb[2];
    out[p * 4 + 3] = ramp[spec.alphaIndices[p] & 0x7];
  }
  return out;
}

/**
 * 构造 DDS 容器。fourCC 模式（"DXT5"，数据从 128 开始）与 DX10 模式
 * （dxgiFormat=77，数据从 148 开始）都要造：这是 DecodeDds 的两条独立 dispatch。
 */
function buildBc3Dds(width, height, blocks, mode) {
  const blocksWide = Math.max(1, Math.ceil(width / 4));
  const blocksHigh = Math.max(1, Math.ceil(height / 4));
  if (blocks.length !== blocksWide * blocksHigh) {
    throw new Error(`DDS_BLOCK_COUNT: ${width}x${height} 需要 ${blocksWide * blocksHigh} 块，收到 ${blocks.length}。`);
  }
  const pixels = Buffer.concat(blocks);
  const dx10 = mode === 'dx10';
  const dataOffset = dx10 ? 148 : 128;
  const dds = Buffer.alloc(dataOffset + pixels.length);
  dds.write('DDS ', 0, 'ascii');
  dds.writeUInt32LE(124, 4);
  dds.writeUInt32LE(0x81007, 8);
  dds.writeUInt32LE(height, 12);
  dds.writeUInt32LE(width, 16);
  dds.writeUInt32LE(pixels.length, 20);
  dds.writeUInt32LE(0, 24);
  dds.writeUInt32LE(1, 28);           // 只有 mip 0
  dds.writeUInt32LE(32, 76);          // pfSize
  dds.writeUInt32LE(0x4, 80);         // DDPF_FOURCC
  dds.write(dx10 ? 'DX10' : 'DXT5', 84, 'ascii');
  dds.writeUInt32LE(0x1000, 108);     // DDSCAPS_TEXTURE
  if (dx10) {
    dds.writeUInt32LE(77, 128);       // DXGI_FORMAT_BC3_UNORM
    dds.writeUInt32LE(3, 132);        // TEXTURE2D
    dds.writeUInt32LE(0, 136);
    dds.writeUInt32LE(1, 140);
    dds.writeUInt32LE(0, 144);
  }
  pixels.copy(dds, dataOffset);
  return dds;
}

/** 最小 TPF（单纹理）。布局与 TpfNativeDocument.Read 实际读法一致（名字为 UTF-16LE）。 */
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
  tpf.writeUInt8(0, 0x0c);
  tpf.writeUInt8(0, 0x0d);
  tpf.writeUInt8(0, 0x0e);
  tpf.writeUInt8(0, 0x0f);
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

/** 解析 PNG。宽高取自 IHDR（复用输入会让「IHDR == DDS 头」变成恒真）。 */
function decodePng(bytes) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!bytes.subarray(0, 8).equals(signature)) throw new Error('PNG_SIGNATURE_INVALID');
  let at = 8;
  let ihdr = null;
  const idat = [];
  while (at + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.subarray(at + 4, at + 8).toString('ascii');
    const data = bytes.subarray(at + 8, at + 8 + length);
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
    // EncodePng 固定写 filter 0；出现别的 filter 说明编码器变了，本 harness 未实现
    // 反滤波，必须失败关闭而不是产出错误像素。
    if (filter !== 0) throw new Error(`PNG_UNSUPPORTED_FILTER: 行 ${y} filter=${filter}`);
    raw.copy(rgba, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  }
  return { width, height, rgba };
}
/**
 * 每个 case 的 alpha 索引**刻意避开会产出 0 的槽位**，让 alpha 全程非 0。
 * 这是「颜色块不得覆写 alpha」判据能成立的前提：若期望 alpha 本来就是 0，
 * 「被错误覆写为 0」与「本来就是 0」不可区分，缺陷的②那半会静默漏过。
 */
function allIndices(v) { return new Array(16).fill(v); }

function buildCases() {
  const cases = [];

  // 覆盖全部 4 个颜色索引的行优先图样，用于让槽 2/3 真正参与。
  const rampIndices = [
    0, 1, 2, 3,
    3, 2, 1, 0,
    2, 3, 0, 1,
    1, 0, 3, 2
  ];

  // alpha0 > alpha1：6 插值模式；索引取 0..5，全部非 0。
  const alpha6 = [
    1, 2, 3, 4,
    5, 0, 1, 2,
    3, 4, 5, 0,
    1, 2, 3, 4
  ];

  // ---- 核心组：c0 <= c1，这是修复前会走 punchthrough 的全部形态 ----
  //
  // 三个子形态都必须造，因为它们在旧实现下的错误表现不同：
  //   c0 < c1  → 槽2 变 1:1 平均、槽3 变纯黑、且 idx==3 的 alpha 被清零
  //   c0 == c1 → 同上（== 也落进 <=），但更常见（低色彩变化块）
  //   c0 > c1  → 旧实现恰好正确，作为「修复没把对的改坏」的对照
  cases.push({
    label: 'c0-lt-c1-punchthrough-shape',
    note: 'c0 < c1：旧实现在此走 3 色+黑并清零 alpha。规范要求恒 4 色且不碰 alpha。',
    spec: {
      c0: 0x0000,          // 纯黑
      c1: 0xffff,          // 纯白 → c0 < c1
      colorIndices: rampIndices,
      alpha0: 0xf0,
      alpha1: 0x10,        // a0 > a1 → 6 插值
      alphaIndices: alpha6
    }
  });

  cases.push({
    label: 'c0-eq-c1-punchthrough-shape',
    note: 'c0 == c1：同样落进旧实现的 <= 分支；编码器对低色彩变化块常产出此形态。',
    spec: {
      c0: 0x4208,
      c1: 0x4208,
      colorIndices: rampIndices,
      alpha0: 0xc0,
      alpha1: 0x20,
      alphaIndices: alpha6
    }
  });

  cases.push({
    label: 'c0-gt-c1-opaque-shape',
    note: 'c0 > c1：旧实现在此本就正确，用于确认修复没把原本正确的路径改坏。',
    spec: {
      c0: 0xf800,          // 纯红
      c1: 0x001f,          // 纯蓝 → c0 > c1
      colorIndices: rampIndices,
      alpha0: 0xff,
      alpha1: 0x01,
      alphaIndices: alpha6
    }
  });

  // ---- alpha 块的两种 ramp 模式（BC3 与 BC4 共用 DecodeBc4Block，此前无门禁）----
  cases.push({
    label: 'alpha-ramp-4interp-mode',
    note: 'alpha0 <= alpha1 → 4 插值 + 槽6=0 + 槽7=255。索引覆盖 0..7 含两个特殊槽。',
    spec: {
      c0: 0x07e0,
      c1: 0xf81f,          // c0 < c1，同时压 punchthrough
      colorIndices: rampIndices,
      alpha0: 0x20,
      alpha1: 0xe0,        // a0 < a1 → 4 插值模式
      alphaIndices: [
        0, 1, 2, 3,
        4, 5, 6, 7,
        7, 6, 5, 4,
        3, 2, 1, 0
      ]
    }
  });

  // ---- 恒定索引：把「调色板某一槽」单独隔离出来逐槽验证 ----
  for (const slot of [0, 1, 2, 3]) {
    cases.push({
      label: `slot-${slot}-isolated-c0-le-c1`,
      note: `全 16 像素取调色板槽 ${slot}，c0 < c1。槽 2/3 是 punchthrough 与规范的分歧点。`,
      spec: {
        c0: 0x1082,
        c1: 0xe71c,        // c0 < c1
        colorIndices: allIndices(slot),
        alpha0: 0xb0,
        alpha1: 0x30,
        alphaIndices: allIndices(2)
      }
    });
  }

  return cases;
}

/**
 * 走一次真实的 export-tpf-texture（format=png）。这是**生产可达路径**：
 * BridgeCommandService 在 format=png 时调用 DdsCodec.DecodeDds + EncodePng。
 * 不走内部测试后门。
 */
async function exportPng(name, width, height, blocks, mode) {
  const dds = buildBc3Dds(width, height, blocks, mode);
  const tpfPath = join(sourceRoot, `${name}.tpf`);
  writeFileSync(tpfPath, buildSyntheticTpf(name, dds));
  const outputPath = join(exportRoot, `${name}.png`);
  requestSeq += 1;
  const response = await daemon.send({
    kind: 'request',
    protocolVersion: '1.0.0',
    requestId: `bc3-${requestSeq}`,
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
  const png = decodePng(readFileSync(outputPath));
  exported.push(name);
  return { failed: false, png, ddsWidth: width, ddsHeight: height };
}

/** 逐像素比对一个 4x4 块，返回首个不匹配详情（全匹配返回 null）。 */
function firstPixelMismatch(actualRgba, pngWidth, blockX, blockY, expected) {
  for (let p = 0; p < 16; p++) {
    const px = blockX * 4 + (p % 4);
    const py = blockY * 4 + Math.floor(p / 4);
    const at = (py * pngWidth + px) * 4;
    for (let c = 0; c < 4; c++) {
      if (actualRgba[at + c] !== expected[p * 4 + c]) {
        return {
          pixel: p,
          xy: [px, py],
          channel: ['R', 'G', 'B', 'A'][c],
          expected: expected[p * 4 + c],
          actual: actualRgba[at + c],
          expectedRgba: [...expected.subarray(p * 4, p * 4 + 4)],
          actualRgba: [...actualRgba.subarray(at, at + 4)]
        };
      }
    }
  }
  return null;
}
// ---------------------------------------------------------------------------
// BC1 对照组。
//
// 为什么必须有：本门禁的核心命题是「BC3 无 punchthrough」，但单独钉这一半会让
// 「把 BC1 的 punchthrough 也一起删掉」报绿——那是对 BC1 的规范违背，而且是
// 「统一两处重复代码」时最自然的手滑方向。BC1 **必须保留** punchthrough。
// 两组合起来才把规则钉成「BC1 有、BC3 没有」这条差异本身。
//
// 这也是本门禁不设 grep must-not 判据的原因：must-not 文本判据改名即报绿，
// 而这里的运行期像素判据严格更强——它直接观测两条路径的实际调色板行为。
// ---------------------------------------------------------------------------

/** BC1 期望像素：punchthrough 生效（c0 <= c1 时槽3 = 透明黑）。 */
function expectedBc1Pixels(spec) {
  const a = expand565(spec.c0);
  const b = expand565(spec.c1);
  let palette;
  if (spec.c0 > spec.c1) {
    palette = [
      [...a, 255],
      [...b, 255],
      [...[0, 1, 2].map((i) => Math.floor((2 * a[i] + b[i]) / 3)), 255],
      [...[0, 1, 2].map((i) => Math.floor((a[i] + 2 * b[i]) / 3)), 255]
    ];
  } else {
    palette = [
      [...a, 255],
      [...b, 255],
      [...[0, 1, 2].map((i) => Math.floor((a[i] + b[i]) / 2)), 255],
      [0, 0, 0, 0]   // 透明黑：BC1 的 1-bit alpha
    ];
  }
  const out = Buffer.alloc(64);
  for (let p = 0; p < 16; p++) {
    const rgba = palette[spec.colorIndices[p] & 0x3];
    out[p * 4 + 0] = rgba[0];
    out[p * 4 + 1] = rgba[1];
    out[p * 4 + 2] = rgba[2];
    out[p * 4 + 3] = rgba[3];
  }
  return out;
}

/** 打包 BC1 块（8 字节：c0/c1 + 4 字节索引）。 */
function packBc1Block(spec) {
  const block = Buffer.alloc(8);
  block.writeUInt16LE(spec.c0, 0);
  block.writeUInt16LE(spec.c1, 2);
  let bits = 0;
  for (let p = 0; p < 16; p++) bits |= (spec.colorIndices[p] & 0x3) << (2 * p);
  block.writeUInt32LE(bits >>> 0, 4);
  return block;
}

/** BC1 的 DDS 容器（fourCC "DXT1"，8 字节/块，数据从 128 开始）。 */
function buildBc1Dds(width, height, blocks) {
  const pixels = Buffer.concat(blocks);
  const dds = Buffer.alloc(128 + pixels.length);
  dds.write('DDS ', 0, 'ascii');
  dds.writeUInt32LE(124, 4);
  dds.writeUInt32LE(0x81007, 8);
  dds.writeUInt32LE(height, 12);
  dds.writeUInt32LE(width, 16);
  dds.writeUInt32LE(pixels.length, 20);
  dds.writeUInt32LE(1, 28);
  dds.writeUInt32LE(32, 76);
  dds.writeUInt32LE(0x4, 80);
  dds.write('DXT1', 84, 'ascii');
  dds.writeUInt32LE(0x1000, 108);
  pixels.copy(dds, 128);
  return dds;
}

async function exportBc1Png(name, spec) {
  const dds = buildBc1Dds(4, 4, [packBc1Block(spec)]);
  const tpfPath = join(sourceRoot, `${name}.tpf`);
  writeFileSync(tpfPath, buildSyntheticTpf(name, dds));
  const outputPath = join(exportRoot, `${name}.png`);
  requestSeq += 1;
  const response = await daemon.send({
    kind: 'request',
    protocolVersion: '1.0.0',
    requestId: `bc1-${requestSeq}`,
    workspaceSessionId: SESSION,
    payload: {
      command: 'export-tpf-texture',
      filePath: tpfPath,
      options: { textureIndex: 0, format: 'png', outputPath }
    }
  });
  if (response.kind !== 'result' || response.payload?.result?.parseStatus === 'failed') {
    return { failed: true, code: response.payload?.code ?? null };
  }
  if (!existsSync(outputPath)) return { failed: true, code: 'PNG_NOT_WRITTEN' };
  exported.push(name);
  return { failed: false, png: decodePng(readFileSync(outputPath)) };
}
function openDaemon() {
  const child = spawn(exe, ['daemon'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let buffer = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) continue;
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      if (frame.kind === 'progress' || frame.kind === 'request/accepted') continue;
      const settle = pending.get(frame.requestId);
      if (settle) { pending.delete(frame.requestId); settle(frame); }
    }
  });
  const send = (frame) => new Promise((settle, reject) => {
    const timer = setTimeout(() => {
      pending.delete(frame.requestId);
      reject(new Error(`BRIDGE_FRAME_TIMEOUT: ${frame.requestId} 无终态响应；stderr=${stderr.slice(-400)}`));
    }, 60_000);
    pending.set(frame.requestId, (received) => { clearTimeout(timer); settle(received); });
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  });
  return { child, send, getStderr: () => stderr };
}

const scratch = mkdtempSync(join(tmpdir(), 'sf-bc3-color-'));
const sourceRoot = join(scratch, 'source');
const exportRoot = join(scratch, 'export');
mkdirSync(sourceRoot, { recursive: true });
mkdirSync(exportRoot, { recursive: true });

const SESSION = 'bc3-color-block-session';
const findings = [];
const checks = [];
const exported = [];
let requestSeq = 0;
let daemon = null;

function check(name, condition, observed) {
  checks.push({ name, ok: Boolean(condition), observed });
  if (!condition) findings.push({ name, observed });
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

  // ---- 主体：逐 case 的像素判据，两条 dispatch 各跑一遍 ----
  const cases = buildCases();
  for (const item of cases) {
    for (const mode of ['fourcc', 'dx10']) {
      const label = `${item.label}/${mode}`;
      const name = `bc3-${item.label.replace(/[^\w]/g, '-')}-${mode}`;
      const result = await exportPng(name, 4, 4, [packBc3Block(item.spec)], mode);
      if (result.failed) {
        check(`${label}: export-tpf-texture(format=png) 必须成功`, false, result);
        continue;
      }
      const expected = expectedPixels(item.spec);
      const mismatch = firstPixelMismatch(result.png.rgba, result.png.width, 0, 0, expected);
      check(
        `${label}: 16 像素 RGBA 逐值等于规范推导的期望值`,
        mismatch === null,
        mismatch === null
          ? { pixelsCompared: 16, note: item.note }
          : { mismatch, spec: { c0: item.spec.c0, c1: item.spec.c1, alpha0: item.spec.alpha0, alpha1: item.spec.alpha1 }, note: item.note }
      );

      // 独立的 alpha 判据：颜色块不得改写 alpha。
      // 单独列出来是因为「像素全等」一旦因颜色原因红了，会掩盖 alpha 这一半；
      // 而 alpha 被清零恰是旧实现最有害的行为（错误透明化）。
      const ramp = alphaRamp(item.spec.alpha0, item.spec.alpha1);
      const expectedAlpha = item.spec.alphaIndices.map((i) => ramp[i & 0x7]);
      const actualAlpha = [];
      for (let p = 0; p < 16; p++) {
        const px = p % 4;
        const py = Math.floor(p / 4);
        actualAlpha.push(result.png.rgba[(py * result.png.width + px) * 4 + 3]);
      }
      const alphaOk = expectedAlpha.every((v, i) => v === actualAlpha[i]);
      check(
        `${label}: alpha 通道完全来自 alpha 块，未被颜色块覆写`,
        alphaOk,
        { expectedAlpha, actualAlpha }
      );

      // 断言 fixture 自身有区分力：期望 alpha 必须存在非 0 值，否则
      // 「alpha 被清零」与「本来就是 0」不可区分，上一条判据会变成恒真。
      check(
        `${label}: fixture 自检——期望 alpha 含非 0 值（否则清零缺陷不可观测）`,
        expectedAlpha.some((v) => v !== 0),
        { expectedAlpha }
      );
    }
  }

  // ---- 差异判据：BC3 的期望像素必须与「按 BC1 规则解码」不同 ----
  //
  // 这条钉的是本门禁的**区分力**本身。若某个 case 的两种规则恰好产出相同像素，
  // 那个 case 对本命题零信息量。c0 <= c1 且用到槽 2 或槽 3 的 case 必须可区分。
  for (const item of cases) {
    const usesSlot23 = item.spec.colorIndices.some((i) => i === 2 || i === 3);
    if (item.spec.c0 > item.spec.c1 || !usesSlot23) continue;
    const bc3Expected = expectedPixels(item.spec);
    const bc1Expected = expectedPixels(item.spec, bc1ColorPaletteForContrast);
    check(
      `${item.label}: 规范期望值必须与「按 BC1 punchthrough 规则」不同（判据有区分力）`,
      !bc3Expected.equals(bc1Expected),
      { c0: item.spec.c0, c1: item.spec.c1, differs: !bc3Expected.equals(bc1Expected) }
    );
  }

  // ---- BC1 对照组：punchthrough 必须仍然生效 ----
  const bc1Cases = [
    {
      label: 'bc1-c0-le-c1-punchthrough-must-remain',
      spec: { c0: 0x0000, c1: 0xffff, colorIndices: [0, 1, 2, 3, 3, 2, 1, 0, 2, 3, 0, 1, 1, 0, 3, 2] }
    },
    {
      label: 'bc1-c0-gt-c1-opaque',
      spec: { c0: 0xf800, c1: 0x001f, colorIndices: [0, 1, 2, 3, 3, 2, 1, 0, 2, 3, 0, 1, 1, 0, 3, 2] }
    }
  ];
  for (const item of bc1Cases) {
    const result = await exportBc1Png(item.label, item.spec);
    if (result.failed) {
      check(`${item.label}: export-tpf-texture(format=png) 必须成功`, false, result);
      continue;
    }
    const expected = expectedBc1Pixels(item.spec);
    const mismatch = firstPixelMismatch(result.png.rgba, result.png.width, 0, 0, expected);
    check(
      `${item.label}: BC1 的 16 像素 RGBA 等于规范推导值（punchthrough 语义未被误删）`,
      mismatch === null,
      mismatch === null ? { pixelsCompared: 16 } : { mismatch }
    );
  }

  // BC1 与 BC3 在同一 (c0,c1,indices) 下必须给出不同颜色——这条把「两条路径
  // 确实是两套规则」直接钉在运行期观测上，而不依赖源码文本。
  {
    const shared = { c0: 0x0000, c1: 0xffff, colorIndices: allIndices(3) };
    const bc1 = await exportBc1Png('bc1-shared-slot3', shared);
    const bc3Spec = { ...shared, alpha0: 0xf0, alpha1: 0x10, alphaIndices: allIndices(1) };
    const bc3 = await exportPng('bc3-shared-slot3', 4, 4, [packBc3Block(bc3Spec)], 'fourcc');
    if (bc1.failed || bc3.failed) {
      check('BC1 与 BC3 同参数对照导出必须成功', false, { bc1, bc3 });
    } else {
      const bc1Px = [...bc1.png.rgba.subarray(0, 4)];
      const bc3Px = [...bc3.png.rgba.subarray(0, 4)];
      // BC1 槽3 在 c0<c1 时是透明黑 (0,0,0,0)；BC3 槽3 是 (RGB0+2*RGB1)/3 且 alpha 来自 ramp。
      check(
        '同一 (c0<c1, idx=3) 下 BC1 得透明黑而 BC3 得 4 色插值：两条路径规则不同',
        bc1Px[3] === 0 && bc3Px[3] !== 0 && bc3Px[0] !== 0,
        { bc1Pixel0: bc1Px, bc3Pixel0: bc3Px }
      );
    }
  }
} catch (error) {
  if (daemon) { try { daemon.child.kill(); } catch { /* ignore */ } }
  rmSync(scratch, { recursive: true, force: true });
  report({
    ok: false,
    gate: LABEL,
    status: 'failed',
    code: 'BC3_GATE_HARNESS_ERROR',
    message: String(error && error.message ? error.message : error)
  }, 1);
}

if (daemon) { try { daemon.child.kill(); } catch { /* ignore */ } }
rmSync(scratch, { recursive: true, force: true });

if (findings.length > 0) {
  report({
    ok: false,
    gate: LABEL,
    status: 'failed',
    code: 'BC3_COLOR_BLOCK_REGRESSION',
    message: 'BC3 颜色块解码结果与规范推导的期望值不一致。',
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
  exportedTextures: exported.length,
  evidence: 'runtime-observed：经生产命令 export-tpf-texture(format=png) 真实解码，逐像素比对',
  fixture: 'synthetic DXT5/DXT1-in-DDS-in-TPF（微小、合法构造、明确标记，非 native authority）',
  oracle: 'harness 自身是编码器：期望值由与块同一份语义内容按规范公式推导，不解析块本身',
  message: 'BC2/BC3 颜色块恒 4 色插值、颜色块不改写 alpha、BC1 punchthrough 仍生效；'
    + 'fourCC "DXT5" 与 DX10 dxgi 77 两条 dispatch 各自验证；BC3 alpha 块两种 ramp 模式覆盖。',
  specSources: [
    'Khronos EXT_texture_compression_s3tc：DXT3/DXT5 节「treated as though color0 > color1, '
      + 'regardless of the actual values」；Issue (6) 明确把 MSDN 的相反暗示判为文档 bug。',
    'Microsoft Learn《Block Compression (Direct3D 10)》：punchthrough 分支只出现在 BC1 一节，'
      + 'BC2/BC3 两节把与 BC1 的差异全部限定在 alpha。'
  ],
  nonClaims: [
    'BC3 在真实语料零命中：2026-08-08 实测四个 Sekiro texbnd 的 52 个纹理为 BC7 25 / '
      + 'BC1_UNORM_SRGB 24 / ATI1 3，无 BC3。本门禁全部判据跑在 synthetic 块上，'
      + '不构成任何真实 BC3 样本的 native authority 声明。',
    'BC2 未覆盖：DdsCodec 刻意未实现 BC2（真实语料零命中），本门禁也不为它造判据。'
      + 'BC2 的颜色块规则与 BC3 相同这一点已由上述两源确认，但未实现即未验证。',
    'sRGB 未验证：DecodeDds 无 sRGB↔linear 传递函数，EncodePng 不写 sRGB/gAMA chunk。',
    'mip 链未验证：DecodeDds 只解 mip 0，fixture 也只有 mip 0。',
    '不构成 BC3 编码（writer）能力声明：harness 的编码器只为造 fixture，不是生产路径。',
    '未与 DirectXTex / nvtt 等外部解码器做对照（硬约束 12）。判据是「合法块 → 规范推导的期望值」。',
    'BC4/BC5 只被顺带覆盖到 alpha ramp 的两种模式（经 BC3 的 alpha 块共用 DecodeBc4Block），'
      + '不构成 BC4/BC5 作为独立格式的完整门禁。'
  ]
}, 0);
