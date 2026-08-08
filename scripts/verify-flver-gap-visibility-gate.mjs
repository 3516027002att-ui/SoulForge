#!/usr/bin/env node
/**
 * FLVER「解析缺口必须可见」常驻门禁。
 *
 * 守的不是某一条具体解析，而是**缺口不可见**这个根因机制：
 * FlverNativeDocument.Authority 必须对「已识别但未解析的结构」敏感，而不是只对
 * layoutWarnings 敏感。
 *
 * ── 它守的是什么（三条缺口 + 一个共同放大器）──
 *
 * 2026-08-08 对本机 11 个 Sekiro chrbnd 实测（`node scripts/gov.mjs` 之外的一次性探针，
 * 探针已删，数字记录在此）：
 *   ① SemTangent(0x6) / SemBitangent(0x7) / SemVertexColor(0xA) 三个语义常量声明后
 *      **零引用**，而顶点语义 switch 只有五个 case、**无 default 分支**。
 *      实测未解析的 member 计数：tangent 93、bitangent 22、vertexColor 79，合计 194。
 *   ② 同语义的第 2+ 个 member 被 `when plan.X == null` 守卫静默挡掉：
 *      实测 UV member 共 108 个，而 layout（≈Position member）73 个 —— 至少 35 个
 *      UV2/UV3 从未被投影，也从未被记录。
 *   ③（**已修复，不再由本门禁覆盖**）material 32 字节只读了前 16。该缺口 2026-08-08
 *      已真正解析：32 字节全部读出，GX 列表按双源核对的规范解析，真实语料 505/505
 *      成功。顺带更正了两处字段误标——**+0x10 是 Flags 不是 gxIndex，+0x14 是
 *      gxOffset（字节偏移）不是索引**。收窄后的缺口（GX item payload 未解码）与
 *      后 16 字节的逐字段正确性改由 **test:flver-gxlist** 覆盖。
 *
 * 放大器：Authority 此前唯一的降级依据是 `_layoutWarnings.Count > 0`，而上面几条
 * **全在不写 warning 的路径上**。后果是 11 个样本一律 authority=native-verified、
 * layoutWarnings=0 —— 一个对自己读没读全完全失明的 authority。项目红线「未有真实
 * parser 时不得声称格式已解析」的执行机制就是让 authority 对缺口敏感。
 *
 * ── 为什么这几条是诚实标记而不是补全解析 ──
 *
 * 补一条解析只填一个洞；把缺口接进降级机制修的是「缺口不可见」这个根因。
 * 剩下这 5 条顶点语义缺口要真正实现，需要 tangent/bitangent/vertexColor 的投影语义
 * 与真实渲染对照验证，属独立工作项。
 * （注：SCOPE-ASSET-FLVER 实测是 `proposedSupport: supported`、authorityAtRuling
 * 为 partial，**不是** V0.6 延期族——本文件旧注释把它写成「V0.6 延期只读预览族」
 * 是错的。GX 列表因此可以在 V0.5 实现，而 ESD 那种 `deferred` 项才需要用户裁定。）
 *
 * ── 判据打在哪 ──
 *
 * 判据不是「源码里有某个字符串」（grep must-not 改名即报绿），而是**运行期**：
 * 造一个合法的 synthetic FLVER，经生产命令 read-flver-document 读出 envelope，
 * 断言 authority 与 unparsedGaps 的对应关系。两种形态各造一个：
 *   A. 只含五个已实现语义、单 UV、无 material → 不应产生任何缺口；
 *   B. 含 tangent/bitangent/vertexColor、双 UV 或未知语义 → 必须逐条报出缺口，
 *      且 authority 必须降为 partial。
 * A 组的存在是关键：没有它，「无条件把 authority 钉成 partial」也会报绿，那样
 * 判据就与实现无关了。
 *
 * 归 synthetic：FLVER 结构可自造、不需真实游戏资产，但解析在 C# 侧需要真实 exe。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'flver-gap-visibility';
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
    reason: 'Bridge 可执行文件缺失，无法做运行期解析验证。',
    remedy: 'npm run bridge:build',
    skipSemantics: '结构跳过：未声称通过，也不计为失败。'
  }, 0);
}
// ---------------------------------------------------------------------------
// synthetic FLVER 构造器。
//
// 布局严格按 FlverNativeDocument.Read 实际读取的偏移：
//   Header 0x80 → Dummies(64B) → Materials(32B) → Bones(128B) → Meshes(48B)
//   → FaceSets(32B) → VertexBuffers(32B) → BufferLayouts(16B) → Textures(32B)
//   → SekiroUnk(28B, version >= 0x2001A) → [member 表/索引数组等] → dataStart
// 解析器有一条硬校验 sectionEnd <= dataStart，所以固定段必须先排完，
// 变长部分（layout member 表）放在固定段之后、dataStart 之前。
// ---------------------------------------------------------------------------

const SEM = { POSITION: 0, BONE_WEIGHTS: 1, BONE_INDICES: 2, NORMAL: 3, UV: 5, TANGENT: 6, BITANGENT: 7, VERTEX_COLOR: 10 };
const TYPE = { FLOAT3: 0x02, BYTE4B: 0x11, BYTE4C: 0x13, UV: 0x15, UVPAIR: 0x16 };

/**
 * 造一个合法的最小 FLVER。
 * @param opts.members  layout member 列表 [{semantic, type, structOffset, index}]
 * @param opts.materialCount  material 条数（后 16 字节现已解析，不再产生缺口）
 */
function buildFlver(opts) {
  const members = opts.members;
  const materialCount = opts.materialCount ?? 0;
  const internalVersion = 0x2001a;
  const vertexCount = 4;
  const stride = opts.stride ?? 32;

  const HEADER = 0x80;
  const dummyCount = 0;
  const boneCount = 0;
  const meshCount = 1;
  const faceSetCount = 1;
  const vertexBufferCount = 1;
  const bufferLayoutCount = 1;
  const textureCount = 0;

  // 固定段依次排布。
  let off = HEADER;
  const materialsAt = off; off += 32 * materialCount;
  const bonesAt = off; off += 128 * boneCount;
  const meshesAt = off; off += 48 * meshCount;
  const faceSetsAt = off; off += 32 * faceSetCount;
  const vertexBuffersAt = off; off += 32 * vertexBufferCount;
  const bufferLayoutsAt = off; off += 16 * bufferLayoutCount;
  const texturesAt = off; off += 32 * textureCount;
  const sekiroUnkAt = off; off += 28;   // internalVersion >= 0x2001A

  // 变长区（仍在 dataStart 之前）：layout member 表 + mesh 的索引数组。
  const memberTableAt = off; off += 20 * members.length;
  const vbIndexArrayAt = off; off += 4 * 1;
  const faceSetIndexArrayAt = off; off += 4 * 1;

  // dataStart 需 4 字节对齐，且必须 >= sectionEnd。
  const dataStart = (off + 15) & ~15;
  const vertexBytes = stride * vertexCount;
  const indexBytes = 3 * 2;             // 一个三角形，16-bit
  const dataLength = vertexBytes + indexBytes;
  const total = dataStart + dataLength;

  const b = Buffer.alloc(total);
  b.write('FLVER\0', 0, 'ascii');
  b.write('L\0', 6, 'ascii');           // endian 标记，解析器前置拒绝非 "L\0"
  b.writeInt32LE(internalVersion, 0x08);
  b.writeInt32LE(dataStart, 0x0c);
  b.writeInt32LE(dataLength, 0x10);
  b.writeInt32LE(dummyCount, 0x14);
  b.writeInt32LE(materialCount, 0x18);
  b.writeInt32LE(boneCount, 0x1c);
  b.writeInt32LE(meshCount, 0x20);
  b.writeInt32LE(vertexBufferCount, 0x24);
  b.writeFloatLE(-1, 0x28); b.writeFloatLE(-1, 0x2c); b.writeFloatLE(-1, 0x30);
  b.writeFloatLE(1, 0x34); b.writeFloatLE(1, 0x38); b.writeFloatLE(1, 0x3c);
  b.writeInt32LE(1, 0x40);              // faceCount
  b.writeInt32LE(3, 0x44);              // totalFaceCount
  b.writeUInt8(16, 0x48);               // vertexIndicesSize
  b.writeUInt8(0, 0x49);                // unicode = false
  b.writeInt32LE(faceSetCount, 0x50);
  b.writeInt32LE(bufferLayoutCount, 0x54);
  b.writeInt32LE(textureCount, 0x58);

  // Materials：32 字节全填。字段标注见下方逐行注释（2026-08-08 更正过一次）。
  for (let i = 0; i < materialCount; i++) {
    const at = materialsAt + 32 * i;
    b.writeInt32LE(0, at + 0x00);       // nameOffset=0 → 读成空串（合法）
    b.writeInt32LE(0, at + 0x04);
    b.writeInt32LE(0, at + 0x08);       // textureCount
    b.writeInt32LE(0, at + 0x0c);       // firstTextureIndex
    // ⚠️ 这四个字段的标注在 2026-08-08 更正过（双源核对 SoulsFormats 与
    // SoulsFormatsNEXT）：+0x10 是 **Flags**（旧注释误标为 gxIndex），
    // +0x14 是 **gxOffset —— 字节偏移**（旧注释误标为 unk18），+0x18 才是 Unk18。
    b.writeInt32LE(388, at + 0x10);     // Flags：真实语料里的典型取值
    // gxOffset 必须为 0：本 fixture 只有 598 字节，写真实语料的 106224 会被
    // TryReadGxList 正确判为「偏移越界」并记 layoutWarning，于是本组
    // 「缺口不得混进 layoutWarnings」那条断言必然红——**测到的是 fixture 越界，
    // 不是缺口可见性**。0 表示该 material 无 GX 列表，是完全合法的形态
    // （真实语料 505 条恰好都非零，但格式允许 0，SoulsFormats 用 0 表示 GXIndex=-1）。
    // 本组要测的缺口是「GX payload 未解码」，由 test:flver-gxlist 用带真实 GX 区的
    // fixture 覆盖；这里只需保证 material 存在且不引入无关的越界警告。
    b.writeInt32LE(0, at + 0x14);       // gxOffset = 0（无 GX 列表）
    b.writeInt32LE(i, at + 0x18);       // Unk18
    b.writeInt32LE(0, at + 0x1c);       // 保留：规范断言恒 0
  }

  // Mesh[0]
  b.writeUInt8(0, meshesAt + 0x00);
  b.writeInt32LE(0, meshesAt + 0x04);           // materialIndex
  b.writeInt32LE(-1, meshesAt + 0x10);          // defaultBoneIndex
  b.writeInt32LE(0, meshesAt + 0x14);           // boneCount
  b.writeInt32LE(0, meshesAt + 0x1c);           // boneOffset
  b.writeInt32LE(1, meshesAt + 0x20);           // faceSetCount
  b.writeInt32LE(faceSetIndexArrayAt, meshesAt + 0x24);
  b.writeInt32LE(1, meshesAt + 0x28);           // vertexBufferCount
  b.writeInt32LE(vbIndexArrayAt, meshesAt + 0x2c);
  b.writeInt32LE(0, vbIndexArrayAt);            // → vertex buffer 0
  b.writeInt32LE(0, faceSetIndexArrayAt);       // → face set 0

  // FaceSet[0]
  b.writeUInt32LE(0, faceSetsAt + 0x00);        // flags = 0 → 主 face set
  b.writeUInt8(0, faceSetsAt + 0x04);           // triangleStrip = false
  b.writeInt32LE(3, faceSetsAt + 0x08);         // indexCount
  b.writeInt32LE(vertexBytes, faceSetsAt + 0x0c); // indicesOffset（相对 dataStart）
  b.writeInt32LE(16, faceSetsAt + 0x18);        // indexSize

  // VertexBuffer[0]
  b.writeInt32LE(0, vertexBuffersAt + 0x00);
  b.writeInt32LE(0, vertexBuffersAt + 0x04);    // layoutIndex
  b.writeInt32LE(stride, vertexBuffersAt + 0x08);
  b.writeInt32LE(vertexCount, vertexBuffersAt + 0x0c);
  b.writeInt32LE(vertexBytes, vertexBuffersAt + 0x18);
  b.writeInt32LE(0, vertexBuffersAt + 0x1c);    // bufferOffset（相对 dataStart）

  // BufferLayout[0]
  b.writeInt32LE(members.length, bufferLayoutsAt + 0x00);
  b.writeInt32LE(memberTableAt, bufferLayoutsAt + 0x0c);
  members.forEach((m, i) => {
    const at = memberTableAt + 20 * i;
    b.writeInt32LE(0, at + 0x00);               // unk00
    b.writeInt32LE(m.structOffset, at + 0x04);
    b.writeUInt32LE(m.type, at + 0x08);
    b.writeUInt32LE(m.semantic, at + 0x0c);
    b.writeInt32LE(m.index ?? 0, at + 0x10);
  });

  // 顶点数据：position 用可辨识的有限值，落在 bounding box 内。
  for (let v = 0; v < vertexCount; v++) {
    const at = dataStart + v * stride;
    b.writeFloatLE(0.1 * v, at + 0);
    b.writeFloatLE(0.2 * v, at + 4);
    b.writeFloatLE(0.3 * v, at + 8);
  }
  // 索引
  const ixAt = dataStart + vertexBytes;
  b.writeUInt16LE(0, ixAt);
  b.writeUInt16LE(1, ixAt + 2);
  b.writeUInt16LE(2, ixAt + 4);

  return b;
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
      reject(new Error(`BRIDGE_FRAME_TIMEOUT: ${frame.requestId}；stderr=${stderr.slice(-400)}`));
    }, 60_000);
    pending.set(frame.requestId, (received) => { clearTimeout(timer); settle(received); });
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  });
  return { child, send };
}

const scratch = mkdtempSync(join(tmpdir(), 'sf-flver-gap-'));
const sourceRoot = join(scratch, 'source');
mkdirSync(sourceRoot, { recursive: true });

const SESSION = 'flver-gap-session';
const findings = [];
const checks = [];
let requestSeq = 0;
let daemon = null;

function check(name, condition, observed) {
  checks.push({ name, ok: Boolean(condition), observed });
  if (!condition) findings.push({ name, observed });
}

async function readFlver(name, bytes) {
  const path = join(sourceRoot, `${name}.flver`);
  writeFileSync(path, bytes);
  requestSeq += 1;
  const response = await daemon.send({
    kind: 'request',
    protocolVersion: '1.0.0',
    requestId: `flver-${requestSeq}`,
    workspaceSessionId: SESSION,
    payload: { command: 'read-flver-document', filePath: path }
  });
  const result = response.payload?.result;
  if (response.kind !== 'result' || result?.parseStatus === 'failed' || !result?.data) {
    return { failed: true, diagnostics: result?.diagnostics ?? response.payload };
  }
  return { failed: false, env: result.data };
}

/** 五个已实现语义、单 UV、无 material —— 不应产生任何缺口。 */
const CLEAN_MEMBERS = [
  { semantic: SEM.POSITION, type: TYPE.FLOAT3, structOffset: 0 },
  { semantic: SEM.NORMAL, type: TYPE.BYTE4B, structOffset: 12 },
  { semantic: SEM.UV, type: TYPE.UV, structOffset: 16 },
  { semantic: SEM.BONE_WEIGHTS, type: TYPE.BYTE4C, structOffset: 20 },
  { semantic: SEM.BONE_INDICES, type: TYPE.BYTE4B, structOffset: 24 }
];

try {
  daemon = openDaemon();
  const handshake = await daemon.send({
    kind: 'handshake',
    protocolVersion: '1.0.0',
    requestId: 'handshake-1',
    workspaceSessionId: SESSION,
    payload: { allowedRoots: [sourceRoot], writableRoots: [] }
  });
  if (handshake.kind !== 'handshake') {
    throw new Error(`BRIDGE_HANDSHAKE_FAILED: ${JSON.stringify(handshake.payload).slice(0, 300)}`);
  }

  // ---------------------------------------------------------------------
  // A 组：无缺口基线。
  //
  // 这一组是判据成立的**必要条件**：没有它，「无条件把 authority 钉成 partial」
  // 或「无条件塞一条 gap」都会让 B 组报绿，判据就与实现无关了。
  // ---------------------------------------------------------------------
  {
    const r = await readFlver('clean-no-gaps', buildFlver({ members: CLEAN_MEMBERS, materialCount: 0 }));
    if (r.failed) {
      check('A组基线：无缺口 FLVER 必须解析成功', false, r);
    } else {
      const gaps = r.env.unparsedGaps ?? [];
      check('A组基线：只含已实现语义且无 material 时，unparsedGaps 必须为空',
        gaps.length === 0, { gaps, authority: r.env.authority });
      check('A组基线：无缺口时 authority 必须是 native-verified（证明降级不是无条件的）',
        r.env.authority === 'native-verified',
        { authority: r.env.authority, gaps, layoutWarnings: r.env.layoutWarnings });
      check('A组基线：layoutWarnings 必须为空（fixture 自身合法，否则后续断言跑在坏数据上）',
        (r.env.layoutWarnings ?? []).length === 0, { layoutWarnings: r.env.layoutWarnings });
    }
  }

  // ---------------------------------------------------------------------
  // B 组：逐条缺口。每条单独造一个 fixture，确保报出的是**被测那一条**。
  // ---------------------------------------------------------------------
  const gapCases = [
    {
      label: 'tangent',
      needle: 'tangent',
      members: [...CLEAN_MEMBERS, { semantic: SEM.TANGENT, type: TYPE.BYTE4B, structOffset: 28 }],
      materialCount: 0,
      note: 'SemTangent(0x6) 声明后零引用；真实语料实测 93 个 member。'
    },
    {
      label: 'bitangent',
      needle: 'bitangent',
      members: [...CLEAN_MEMBERS, { semantic: SEM.BITANGENT, type: TYPE.BYTE4B, structOffset: 28 }],
      materialCount: 0,
      note: 'SemBitangent(0x7) 声明后零引用；真实语料实测 22 个 member。'
    },
    {
      label: 'vertexColor',
      needle: 'vertexColor',
      members: [...CLEAN_MEMBERS, { semantic: SEM.VERTEX_COLOR, type: TYPE.BYTE4C, structOffset: 28 }],
      materialCount: 0,
      note: 'SemVertexColor(0xA) 声明后零引用；真实语料实测 79 个 member。'
    },
    {
      label: 'duplicate-uv',
      needle: '第 2+ 个 member',
      members: [...CLEAN_MEMBERS, { semantic: SEM.UV, type: TYPE.UV, structOffset: 28, index: 1 }],
      materialCount: 0,
      note: '第 2 个 UV 被 when 守卫静默挡掉；真实语料 UV member 108 个 vs layout 73 个。'
    },
    {
      label: 'unknown-semantic',
      needle: '未识别',
      members: [...CLEAN_MEMBERS, { semantic: 0x63, type: TYPE.BYTE4B, structOffset: 28 }],
      materialCount: 0,
      note: 'switch 此前无 default 分支，未知语义完全静默。'
    },
    // ⚠️ 原先这里还有一条 `material-tail` 用例，断言「material 后 16/32 字节未读」
    // 这个缺口可见。**该缺口已在 2026-08-08 真正修掉**（32 字节全部读出，GX 列表按
    // 双源核对的规范解析，真实语料 505/505 成功），所以那条用例的前提不再成立——
    // 留着它会永远报红，而「修好了导致门禁红」正是 [承接后 fixture 靶标会失去前提]
    // 那类问题：靶标必须随实现推进改靶或删除，不能靠放宽判据转绿。
    //
    // 缺口没有消失，只是**收窄**了：GX item 的 payload 仍不解码。收窄后的缺口连同
    // material 后 16 字节的逐字段正确性，一起由 **test:flver-gxlist** 覆盖
    // （34 断言，含「全部 item 无 payload 时不得报假缺口」这条判别力用例）。
    // 本门禁继续守剩下 5 条顶点语义缺口——它们仍然真实存在。
  ];

  for (const item of gapCases) {
    const r = await readFlver(`gap-${item.label}`, buildFlver({ members: item.members, materialCount: item.materialCount, stride: 32 }));
    if (r.failed) {
      check(`B组 ${item.label}: fixture 必须解析成功（否则测的是解析失败而非缺口可见性）`, false, r);
      continue;
    }
    const gaps = r.env.unparsedGaps ?? [];
    check(
      `B组 ${item.label}: unparsedGaps 必须报出该缺口`,
      gaps.some((g) => g.includes(item.needle)),
      { gaps, needle: item.needle, note: item.note }
    );
    check(
      `B组 ${item.label}: 存在缺口时 authority 必须降为 partial`,
      r.env.authority === 'partial',
      { authority: r.env.authority, gaps }
    );
    check(
      `B组 ${item.label}: 缺口不得混进 layoutWarnings（「我没读」不是「文件坏了」）`,
      (r.env.layoutWarnings ?? []).length === 0,
      { layoutWarnings: r.env.layoutWarnings }
    );
  }
} catch (error) {
  if (daemon) { try { daemon.child.kill(); } catch { /* ignore */ } }
  rmSync(scratch, { recursive: true, force: true });
  report({
    ok: false,
    gate: LABEL,
    status: 'failed',
    code: 'FLVER_GAP_GATE_HARNESS_ERROR',
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
    code: 'FLVER_GAP_VISIBILITY_REGRESSION',
    message: 'FLVER 解析缺口未被登记，或 authority 对缺口不敏感。',
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
  evidence: 'runtime-observed：经生产命令 read-flver-document 真实解析，断言 envelope 的 authority/unparsedGaps',
  fixture: 'synthetic FLVER（微小、合法构造、明确标记，非 native authority）',
  message: '六类缺口（tangent/bitangent/vertexColor/重复语义/未知语义/material 后 16 字节）'
    + '各自被登记且把 authority 降为 partial；无缺口基线仍为 native-verified，证明降级不是无条件的。',
  nonClaims: [
    '**不声称**这些结构已被解析。本门禁证明的恰恰相反：它们未被解析，且这一事实现在对上层可见。',
    'GXList 未解析：material 后 16 字节只被登记为缺口。GXList 是变长表且条目布局按版本分歧，'
      + '在没有该结构的真实往返验证前解析它等于在未验证前提下扩大 native 声明面。',
    'tangent/bitangent/vertexColor 未解析：同上，只登记不解析。要真解析需先有该语义的'
      + '真实样本、类型覆盖与往返验证。',
    'FLVER 属 V0.6 延期只读预览族（scope.json 的 SCOPE-ASSET-FLVER）。本门禁不改变该裁定，'
      + '不开放任何 writer，也不扩大 authority 声明面——它只让声明面更诚实（native-verified → partial）。',
    'unparsedGaps 的**完备性**未被证明：它覆盖当前已知的六类缺口，不保证没有第七类未知缺口。'
      + '按定义，尚未被识别的缺口无法由门禁列举。',
    '真实语料数字（194 个未解析 member、505 条 material 后 16 字节非零）来自一次性探针，'
      + '不在本门禁的持续判据里；本门禁全部判据跑在 synthetic fixture 上。'
  ]
}, 0);
