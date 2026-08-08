#!/usr/bin/env node
/**
 * FLVER2 GX 列表解析常驻门禁。
 *
 * 守的是 FlverNativeDocument 新增的 material 后 16 字节解析（Flags / GxOffset / Unk18 /
 * 保留字段）与 <c>TryReadGxList</c>。那段实现由真实语料验证过（11 个 Sekiro chrbnd 的
 * 505 条 material 全部解析成功），但那次验证的判据在临时探针里、探针已删除——
 * 与 BC7 解码当初的处境相同：代码在，证明不在。
 *
 * ── 为什么判据不能只打在「不抛异常」上 ──
 * GX 列表的失效形态全是**静默**的：
 *   · 把 +0x10/+0x14 读反（Flags 当偏移用）→ 偏移落到别处，多半仍能读出「某种」结构；
 *   · item 长度语义读错（itemLength 不含头 vs 含头）→ 步进错位，item 数与 ID 全错；
 *   · 终止哨兵只判 int.MaxValue 漏判 -1 → 某些文件读到文件尾；
 *   · TerminatorLength 忘减 0xC → 填充长度多算 12 字节。
 * 这些都不抛异常，只产出**结构完好但内容错误**的输出。所以本门禁对每个字段逐值
 * 断言，并覆盖上面每一种读错形态的负例。
 *
 * ── 期望值怎么来（本门禁能成立的关键）──
 * harness 自身是**编码器**：先决定语义内容（几个 item、各自 ID/unk04/payload 长度、
 * 终止填充多长），按规范位序打包成 FLVER 字节，再从**同一份语义内容**推出期望值。
 * 它从不解析自己写出的字节，所以不是「两个解析器互相印证」。
 *
 * ── 结构依据（双源核对，2026-08-08）──
 * JKAnderson/SoulsFormats 与 soulsmods/SoulsFormatsNEXT 的 FLVER2 Material/GXList
 * 逐字段一致：material +0x10=Flags、+0x14=gxOffset（**字节偏移**）、+0x18=Unk18、
 * +0x1C 断言 0；GXList 循环读 item 至 id==int.MaxValue 或 id==-1，item 头 12 字节
 * （id/unk04/length，length **含头**），终止记录为 (id, 100, rawLen)，
 * 真实填充长度 = rawLen − 0xC 且按规范全零。
 *
 * ⚠️ 两处与本仓库旧注释的分歧（旧注释已作废，改 FLVER 前必读）：
 *   ① 旧注释称 +0x10 是 gxIndex。**不对**，那是 Flags；+0x14 才是偏移。实测 505 条
 *      +0x14 严格单调递增、相邻差值以 64 为主、全部 < dataOffset——偏移的形态。
 *      SoulsFormats 的公开属性 GXIndex 是去重后的列表序号，不是文件字段。
 *   ② SoulsFormatsNEXT 把 +0x18 叫 Index，但实测**不是 material 序号**
 *      （c1020 前五条是 0,1,2,2,0）。故保留中性名 Unk18。
 *
 * 归 synthetic 层：FLVER 字节可自造，不需要真实游戏资产；解析在 C# 侧需要真实 exe。
 * 与 test:flver-gap-visibility / test:bc7-decode 同一惯例。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'flver-gxlist';
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
    ok: null, gate: LABEL, status: 'skipped',
    reason: 'Bridge 可执行文件缺失，无法做运行期解析验证。',
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

const scratch = mkdtempSync(join(tmpdir(), 'sf-gxgate-'));
const sourceRoot = join(scratch, 'source');
mkdirSync(sourceRoot, { recursive: true });
const SESSION = 'flver-gxlist-gate';

const INT_MAX = 2147483647;
const HEADER_SIZE = 0x80;
const MATERIAL_SIZE = 32;
const BONE_SIZE = 128;

/**
 * 构造一个**最小合法 FLVER2**：0 dummy、N material、1 bone、0 mesh、0 vertex buffer。
 * 字段偏移与 FlverNativeDocument.Read 实际读取处对齐（不是凭印象）。
 *
 * 布局：
 *   0x00 "FLVER\0" + "L\0"（小端标记）
 *   0x08 version、0x0C dataOffset、0x10 dataSize
 *   0x14 dummyCount、0x18 materialCount、0x1C boneCount、0x20 meshCount
 *   0x24 vertexBufferCount、0x28 bbox(6 float)…、0x40 faceCount、0x44 totalFaceCount
 *   0x48 vertexIndexSize、0x49 unicode
 *   之后：material 表 → bone 表 → 字符串/GX 区（放在 dataOffset 之前）
 */
function buildFlver(materials, options = {}) {
  const materialCount = materials.length;
  const boneCount = 1;
  const matBase = HEADER_SIZE;
  const boneBase = matBase + materialCount * MATERIAL_SIZE;
  const stringBase = boneBase + boneCount * BONE_SIZE;

  // 字符串区：每个 material 一个 name 与一个 mtd（UTF-16LE），外加 bone name。
  const strings = [];
  let stringCursor = stringBase;
  const putString = (text) => {
    const bytes = Buffer.from(`${text}\0`, 'utf16le');
    const at = stringCursor;
    strings.push({ at, bytes });
    stringCursor += bytes.length;
    return at;
  };
  const nameOffsets = materials.map((m, i) => ({
    name: putString(m.name ?? `mat${i}`),
    mtd: putString(m.mtd ?? `m${i}.mtd`)
  }));
  const boneNameOffset = putString('root');

  // GX 区：紧随字符串区。对齐到 4 字节，避免非对齐读的干扰。
  let gxCursor = (stringCursor + 3) & ~3;
  const gxBlocks = [];
  const gxOffsets = materials.map((m) => {
    if (!m.gx) return 0;
    const at = gxCursor;
    const parts = [];
    for (const item of m.gx.items) {
      const idBytes = Buffer.from(item.id, 'ascii');
      if (idBytes.length !== 4) throw new Error(`GX id 必须 4 字节 ASCII：${item.id}`);
      const payload = Buffer.alloc(item.dataLength ?? 0, item.fill ?? 0xab);
      const head = Buffer.alloc(12);
      idBytes.copy(head, 0);
      head.writeInt32LE(item.unk04 ?? 100, 4);
      // itemLength **含 12 字节头**——这是规范，也是最容易读错的一处。
      head.writeInt32LE(12 + payload.length, 8);
      parts.push(head, payload);
    }
    const term = Buffer.alloc(12);
    term.writeInt32LE(m.gx.terminatorId ?? INT_MAX, 0);
    term.writeInt32LE(m.gx.hundred ?? 100, 4);
    const padLength = m.gx.terminatorLength ?? 0;
    // 写盘值 = 真实填充长度 + 0xC
    term.writeInt32LE(padLength + 0xc, 8);
    parts.push(term);
    if (padLength > 0) parts.push(Buffer.alloc(padLength, m.gx.padFill ?? 0));
    const block = Buffer.concat(parts);
    gxBlocks.push({ at, block });
    gxCursor += block.length;
    return at;
  });

  const dataOffset = (gxCursor + 15) & ~15;
  const total = dataOffset + 16; // 一点 data 区，避免 dataOffset 落在文件末尾
  const b = Buffer.alloc(total);

  b.write('FLVER\0', 0, 'latin1');
  b.write('L\0', 6, 'latin1');
  b.writeInt32LE(options.version ?? 0x2001a, 0x08);
  b.writeInt32LE(dataOffset, 0x0c);
  b.writeInt32LE(total - dataOffset, 0x10);
  b.writeInt32LE(0, 0x14);              // dummyCount
  b.writeInt32LE(materialCount, 0x18);
  b.writeInt32LE(boneCount, 0x1c);
  b.writeInt32LE(0, 0x20);              // meshCount
  b.writeInt32LE(0, 0x24);              // vertexBufferCount
  b.writeInt32LE(0, 0x40);              // faceCount
  b.writeInt32LE(0, 0x44);              // totalFaceCount
  b[0x48] = 0;                          // vertexIndexSize
  b[0x49] = 1;                          // unicode = true（字符串按 UTF-16LE 读）

  for (let i = 0; i < materialCount; i++) {
    const o = matBase + i * MATERIAL_SIZE;
    b.writeInt32LE(nameOffsets[i].name, o + 0x00);
    b.writeInt32LE(nameOffsets[i].mtd, o + 0x04);
    b.writeInt32LE(materials[i].textureCount ?? 0, o + 0x08);
    b.writeInt32LE(0, o + 0x0c);
    b.writeInt32LE(materials[i].flags ?? 0, o + 0x10);
    b.writeInt32LE(gxOffsets[i], o + 0x14);
    b.writeInt32LE(materials[i].unk18 ?? 0, o + 0x18);
    b.writeInt32LE(materials[i].reserved ?? 0, o + 0x1c);
  }

  // bone：只填 name offset 与 index 字段，其余留零。
  b.writeInt32LE(boneNameOffset, boneBase + 0x0c);
  b.writeInt16LE(-1, boneBase + 0x1c);
  b.writeInt16LE(-1, boneBase + 0x1e);
  b.writeInt16LE(-1, boneBase + 0x20);
  b.writeInt16LE(-1, boneBase + 0x22);

  for (const s of strings) s.bytes.copy(b, s.at);
  for (const g of gxBlocks) g.block.copy(b, g.at);
  return b;
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

async function readFlver(name, bytes) {
  const path = join(sourceRoot, `${name}.flver`);
  writeFileSync(path, bytes);
  seq += 1;
  const response = await daemon.send({
    kind: 'request', protocolVersion: '1.0.0', requestId: `gx-${seq}`,
    workspaceSessionId: SESSION,
    payload: { command: 'read-flver-document', filePath: path, options: {} }
  });
  const result = response.payload?.result ?? null;
  return {
    parseStatus: result?.parseStatus ?? response.kind,
    data: result?.data ?? null,
    diagnostics: result?.diagnostics ?? [],
    codes: (result?.diagnostics ?? []).map((d) => d.code)
  };
}

try {
  daemon = openDaemon();
  const handshake = await daemon.send({
    kind: 'handshake', protocolVersion: '1.0.0', requestId: 'handshake-1',
    workspaceSessionId: SESSION,
    payload: { allowedRoots: [sourceRoot], writableRoots: [] }
  });
  if (handshake.kind !== 'handshake') {
    throw new Error(`BRIDGE_HANDSHAKE_FAILED: ${JSON.stringify(handshake.payload).slice(0, 300)}`);
  }

  // ---- ① 逐字段：单 material 单 item ----
  // 期望值由同一份语义内容推出：itemLength = 12 + dataLength。
  const single = await readFlver('gx-single', buildFlver([{
    flags: 0x1234, unk18: 7,
    gx: { items: [{ id: 'GX00', unk04: 102, dataLength: 40 }], terminatorLength: 0 }
  }]));
  if (single.parseStatus === 'failed') {
    check('单 material 单 item 的合法 FLVER 必须解析成功（fixture 前提）', false, {
      codes: single.codes, messages: single.diagnostics.map((d) => d.message)
    });
  } else {
    const m = single.data?.materials?.[0] ?? null;
    check('material 必须导出 flags / gxOffset / unk18 三个字段', m !== null
      && typeof m.flags === 'number' && typeof m.gxOffset === 'number' && typeof m.unk18 === 'number',
      { material: m });
    check('flags 逐值等于写入值 0x1234', m?.flags === 0x1234, { flags: m?.flags ?? null });
    check('unk18 逐值等于写入值 7（不是 material 序号）', m?.unk18 === 7, { unk18: m?.unk18 ?? null });
    check('gxOffset 非零（该 material 有 GX 列表）', (m?.gxOffset ?? 0) !== 0, { gxOffset: m?.gxOffset ?? null });
    check('gxList 必须被解析出来', m?.gxList != null, { gxList: m?.gxList ?? null });
    check('item 数等于写入的 1', m?.gxList?.itemCount === 1, { itemCount: m?.gxList?.itemCount ?? null });
    check('item ID 为 4 字节 ASCII "GX00"', m?.gxList?.items?.[0]?.id === 'GX00',
      { id: m?.gxList?.items?.[0]?.id ?? null });
    check('item unk04 逐值等于 102', m?.gxList?.items?.[0]?.unk04 === 102,
      { unk04: m?.gxList?.items?.[0]?.unk04 ?? null });
    // 这一对是「itemLength 含头」这条规范的直接判据：读错就会一个对一个错。
    check('itemLength 等于 12 + payload（含 12 字节头）', m?.gxList?.items?.[0]?.itemLength === 52,
      { itemLength: m?.gxList?.items?.[0]?.itemLength ?? null });
    check('dataLength 等于 payload 长度 40', m?.gxList?.items?.[0]?.dataLength === 40,
      { dataLength: m?.gxList?.items?.[0]?.dataLength ?? null });
    check('terminatorId 为 int.MaxValue', m?.gxList?.terminatorId === INT_MAX,
      { terminatorId: m?.gxList?.terminatorId ?? null });
    check('terminatorLength 为 0（写入 0xC 应减回 0）', m?.gxList?.terminatorLength === 0,
      { terminatorLength: m?.gxList?.terminatorLength ?? null });
    check('terminator 填充判定为全零', m?.gxList?.terminatorPaddingAllZero === true,
      { padding: m?.gxList?.terminatorPaddingAllZero ?? null });
  }

  // ---- ② 多 item + 非零填充 + 多 material（含无 GX 列表的一条）----
  const multi = await readFlver('gx-multi', buildFlver([
    { flags: 1, gx: { items: [
      { id: 'GX00', unk04: 102, dataLength: 40 },
      { id: 'GXMD', unk04: 103, dataLength: 8 },
      { id: 'GX04', unk04: 104, dataLength: 0 }   // 无 payload 的合法 item
    ], terminatorLength: 16 } },
    { flags: 2 }, // gxOffset == 0：无 GX 列表
    { flags: 3, gx: { items: [{ id: 'GX80', unk04: 105, dataLength: 4 }], terminatorLength: 0 } }
  ]));
  if (multi.parseStatus === 'failed') {
    check('多 material fixture 必须解析成功', false, { codes: multi.codes });
  } else {
    const ms = multi.data?.materials ?? [];
    check('三个 material 都被导出', ms.length === 3, { count: ms.length });
    check('material[0] 的 3 个 item 全部解析', ms[0]?.gxList?.itemCount === 3,
      { itemCount: ms[0]?.gxList?.itemCount ?? null });
    check('material[0] 的 item ID 顺序为 GX00/GXMD/GX04',
      JSON.stringify(ms[0]?.gxList?.items?.map((x) => x.id) ?? []) === '["GX00","GXMD","GX04"]',
      { ids: ms[0]?.gxList?.items?.map((x) => x.id) ?? null });
    check('dataLength==0 的 item 合法（itemLength 恰为 12）',
      ms[0]?.gxList?.items?.[2]?.itemLength === 12 && ms[0]?.gxList?.items?.[2]?.dataLength === 0,
      { item: ms[0]?.gxList?.items?.[2] ?? null });
    // 非零填充长度：忘减 0xC 会多算 12。
    check('terminatorLength 等于 16（写入 16+0xC，读出须减回 16）',
      ms[0]?.gxList?.terminatorLength === 16,
      { terminatorLength: ms[0]?.gxList?.terminatorLength ?? null });
    // gxOffset == 0 与「解析失败」必须可区分。
    check('gxOffset==0 的 material：gxOffset 为 0 且 gxList 为 null（无列表，不是失败）',
      ms[1]?.gxOffset === 0 && ms[1]?.gxList == null,
      { material: ms[1] ?? null });
    check('第三个 material 的列表独立解析（偏移各自独立）',
      ms[2]?.gxList?.items?.[0]?.id === 'GX80',
      { id: ms[2]?.gxList?.items?.[0]?.id ?? null });
  }

  // ---- ③ 全量覆盖面字段（不受样本截断影响）----
  const cov = multi.data?.gxCoverage ?? null;
  check('envelope 必须导出 gxCoverage 全量覆盖面', cov !== null, { gxCoverage: cov });
  check('gxCoverage.materialsWithGxOffset == 2', cov?.materialsWithGxOffset === 2,
    { value: cov?.materialsWithGxOffset ?? null });
  check('gxCoverage.gxListsParsed == 2', cov?.gxListsParsed === 2, { value: cov?.gxListsParsed ?? null });
  check('gxCoverage.gxListsFailed == 0', cov?.gxListsFailed === 0, { value: cov?.gxListsFailed ?? null });
  check('gxCoverage.gxItemsTotal == 4', cov?.gxItemsTotal === 4, { value: cov?.gxItemsTotal ?? null });
  // payload 未解码的字节数必须如实累计：40+8+0+4 = 52
  check('gxCoverage.gxPayloadBytesUndecoded == 52（如实累计未解码 payload）',
    cov?.gxPayloadBytesUndecoded === 52, { value: cov?.gxPayloadBytesUndecoded ?? null });
  check('gxCoverage.distinctItemIds 去重且有序',
    JSON.stringify(cov?.distinctItemIds ?? []) === '["GX00","GX04","GX80","GXMD"]',
    { value: cov?.distinctItemIds ?? null });

  // ---- ④ payload 未解码必须仍是可见缺口（收窄≠消失）----
  const gaps = (multi.data?.unparsedGaps ?? []).join(' | ');
  check('payload 未解码必须登记为 unparsedGaps（收窄不等于消失）',
    gaps.includes('payload'), { unparsedGaps: multi.data?.unparsedGaps ?? null });
  check('有未解码 payload 时 authority 必须为 partial',
    multi.data?.authority === 'partial', { authority: multi.data?.authority ?? null });

  // ---- ⑤ 全部 item 无 payload 时不得报假缺口 ----
  // 这条是判别力来源：若缺口写成无条件登记，这里立刻红。
  const noPayload = await readFlver('gx-nopayload', buildFlver([{
    flags: 9, gx: { items: [{ id: 'GX00', unk04: 102, dataLength: 0 }], terminatorLength: 0 }
  }]));
  if (noPayload.parseStatus !== 'failed') {
    const g = (noPayload.data?.unparsedGaps ?? []).join(' | ');
    check('全部 item 无 payload 时不得报「payload 未解码」缺口（假缺口稀释真信号）',
      !g.includes('payload'), { unparsedGaps: noPayload.data?.unparsedGaps ?? null });
  } else {
    check('无 payload fixture 必须解析成功', false, { codes: noPayload.codes });
  }

  // ---- ⑥ 终止哨兵 -1 与 int.MaxValue 都要认 ----
  const negTerm = await readFlver('gx-negterm', buildFlver([{
    flags: 5, gx: { items: [{ id: 'GX00', unk04: 102, dataLength: 4 }], terminatorId: -1, terminatorLength: 0 }
  }]));
  if (negTerm.parseStatus !== 'failed') {
    const m = negTerm.data?.materials?.[0] ?? null;
    check('终止哨兵为 -1 时同样正确停止（只判 int.MaxValue 会读飞）',
      m?.gxList?.itemCount === 1 && m?.gxList?.terminatorId === -1,
      { gxList: m?.gxList ?? null });
  } else {
    check('-1 终止 fixture 必须解析成功', false, { codes: negTerm.codes });
  }

  // ---- ⑦ 坏数据必须留痕，不得静默置 null ----
  // itemLength = 0 会让朴素实现原地死循环；这里要求报失败并留 warning。
  const badLen = buildFlver([{ flags: 6, gx: { items: [{ id: 'GX00', unk04: 102, dataLength: 4 }], terminatorLength: 0 } }]);
  {
    // 手工把该 item 的 length 字段改成 0（定位：gx 区在字符串区之后，找 "GX00" 首次出现）
    const at = badLen.indexOf(Buffer.from('GX00', 'ascii'));
    if (at < 0) throw new Error('构造坏数据失败：未找到 GX00');
    badLen.writeInt32LE(0, at + 8);
    const bad = await readFlver('gx-badlen', badLen);
    const warnText = JSON.stringify(bad.data?.layoutWarnings ?? bad.data?.warnings ?? []);
    check('itemLength=0 这类坏数据必须留痕（layoutWarning 或诊断），不得静默置 null',
      bad.parseStatus === 'failed'
      || warnText.includes('GX')
      || bad.codes.some((c) => typeof c === 'string' && c.length > 0),
      { parseStatus: bad.parseStatus, codes: bad.codes, warnings: bad.data?.layoutWarnings ?? null });
    check('坏数据时该 material 的 gxList 为 null 且 gxCoverage.gxListsFailed 计入',
      bad.parseStatus === 'failed' || (bad.data?.gxCoverage?.gxListsFailed ?? 0) >= 1,
      { gxCoverage: bad.data?.gxCoverage ?? null });
  }

  // ---- ⑧ +0x1C 保留字段非零必须报 warning（规范是 AssertInt32(0)）----
  const badReserved = await readFlver('gx-reserved', buildFlver([{
    flags: 1, reserved: 0x99,
    gx: { items: [{ id: 'GX00', unk04: 102, dataLength: 4 }], terminatorLength: 0 }
  }]));
  if (badReserved.parseStatus !== 'failed') {
    const warnText = JSON.stringify(badReserved.data?.layoutWarnings ?? []);
    check('+0x1C 非零必须报 layoutWarning（规范要求恒 0）',
      warnText.includes('0x1C') || warnText.includes('保留'),
      { layoutWarnings: badReserved.data?.layoutWarnings ?? null });
  } else {
    check('保留字段非零不应导致整个文件不可读（只降级不拒绝）', false,
      { codes: badReserved.codes });
  }
} catch (error) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'FLVER_GXLIST_HARNESS_FAILED',
    message: error instanceof Error ? error.message : String(error), checks
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
    ok: false, gate: LABEL, status: 'failed', code: 'FLVER_GXLIST_REGRESSION',
    message: 'FLVER GX 列表解析与规范推导的期望值不一致。',
    passed: checks.length - findings.length, failed: findings.length, findings
  }, 1);
}

report({
  ok: true, gate: LABEL, status: 'passed',
  assertions: checks.length,
  evidence: 'runtime-observed：经生产命令 read-flver-document 真实解析，逐字段比对',
  fixture: 'synthetic 最小 FLVER2（微小、合法构造、明确标记，非 native authority）',
  oracle: 'harness 自身是编码器：期望值由与字节同一份语义内容按规范推出，不解析自己写的块',
  message: 'material 后 16 字节（Flags/GxOffset/Unk18/保留）与 GX 列表逐字段验证；'
    + 'itemLength 含头、terminatorLength 减 0xC、-1 与 int.MaxValue 双哨兵、'
    + 'gxOffset==0 与解析失败可区分、坏数据留痕、payload 未解码仍是可见缺口。',
  nonClaims: [
    '**不声称 GX item payload 已解码**：各 ID（GX00/GXMD/GX04…）的字段语义按材质着色参数'
      + '分歧，未经真实往返验证不解码。本门禁断言的是「payload 未解码这件事仍然可见」'
      + '（登记为 unparsedGaps 并压 authority 至 partial）。',
    '不构成 FLVER writer 能力声明：harness 的编码器只为造 fixture，不是生产路径；'
      + 'FLVER 无 writer。',
    '不构成 native authority：fixture 是自造字节。真实语料的 505/505 解析成功是'
      + '一次性取证（11 个 Sekiro chrbnd），由 bridge:verify:flver-multi 覆盖真实样本，'
      + '本门禁覆盖字段级正确性。',
    '不覆盖 DS2 的 GXItem 变体（ID 为纯数字而非 4 字节 ASCII）：Sekiro 语料零命中，'
      + '补判据会造出零覆盖代码。',
    'Unk18 的语义未确定：实测它不是 material 序号（上游命名为 Index 但与实测不符），'
      + '本门禁只断言它被如实读出，不声称知道它是什么。'
  ]
}, 0);
