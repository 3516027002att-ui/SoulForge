#!/usr/bin/env node
/**
 * ESD「未解析结构必须可见」门禁。
 *
 * 守的不是某一条解析，而是**缺口不可见**这个根因。
 *
 * ── 缺陷形态（2026-08-08 实测）──
 * EsdNativeDocument 认出 state group → state → condition → command call 的结构与
 * 计数，但有两处字段区间**读都没读**：
 *   · condition 的 `+0x00 targetStateOffset`（跳转目标）不跟随
 *     → **节点全解析、一条边没连**，文档只能回答「有哪些状态」，
 *       不能回答「状态之间怎么跳」。
 *   · command call 的 `+0x04 commandID` 未读（只聚合了 bank）
 *     → 命令身份未知。
 * 而此前这两处只是两行**被动注释**（`// ... (graph edge, not followed)`）：
 * 不进任何集合、不影响 authority、不出现在 envelope 里。于是缺口对消费方
 * 根本不存在，同时 envelope 还发着 ESD_DOCUMENT_ROUNDTRIP_VERIFIED
 * （那条只证明同一份字节解析两遍一致，parser 确定性下恒真）。
 *
 * 更糟的一处：commandID 那行注释写的是「read but only bank is aggregated」，
 * 而实际从未对 `cOff + 0x04` 发起过读取。**注释自称读过而实际没读**比不写注释
 * 更有害——它让审阅者以为 commandID 已在手、只差往外导。
 *
 * ── 为什么是标注而不是实现 ──
 * ESD 是 user-approved 的 V0.6 延期项（scope.json 的 SCOPE-BEHAVIOR-ESD，范围原文
 * 就写着「跳转关系的完整读写」，resumeRequires 还要求跳转关系双向解析且能检出悬空
 * 目标）。本版实现转移边解析等于在未验证前提下扩大 native 声明面，属越界。
 * 「本版不做」是正确状态，「本版不做但看不出来」才是缺陷。这与 FLVER 的 GX list
 * 处置口径完全一致（bf00f28：只登记缺口、不解析 GXList）。
 *
 * ── 判据打在哪 ──
 * 全部经**生产命令** read-esd-document 走真实 Bridge，用 harness 自造的合法 ESD
 * 字节（微小、明确标记的 synthetic，非 native authority）。断言四件事：
 *   ① envelope 的 unparsedGaps 必须点名这两处，且文本含可定位的字段偏移；
 *   ② authority 必须因此为 partial，**不得**停留在 candidate；
 *   ③ 诊断必须单列 ESD_STRUCTURE_NOT_PARSED_IN_SCOPE，与
 *      ESD_DECLARED_PARSED_DIVERGED **分开**——两者都压 authority，但处置方向相反：
 *      前者指向「本版范围如此，要做得先走 V0.6 承接」，后者指向「去查 parser 为什么
 *      少读了」。混成一条会让下一个人去修一个不存在的 bug（ESD 哨兵那次就是这么被
 *      误判的），也会让真实解析缺口被结构性缺口的噪音盖住。
 *   ④ **无 condition / 无 command call 的 ESD 不得报对应缺口**——这条防「无条件返回
 *      一句话」那种假标注。空 ESD 报「转移边未解析」是假缺口，会稀释真缺口的信号。
 *      这也是判别力的直接来源：若把判据写成恒真，④ 立刻红。
 *
 * 归 synthetic 层：ESD 字节可自造、不需要真实游戏资产（真实 ESD 语料按 V0.6 延期
 * 未在 registry 登记，bridge:verify:esd 恒诚实跳过——这正是本门禁存在的必要性：
 * 否则这两处缺口在任何常驻验证里都不可见）。解析在 C# 侧，需要真实 exe。
 * 与 test:flver-gap-visibility 同一惯例。
 *
 * ── 负向证明（2026-08-08 实测七条，逐条退化 C# 后强制重建再跑）──
 * 本门禁首跑即全绿，而「首跑全绿」正是假门禁最常见的表现，故逐条证明：
 *   E1 UnparsedGaps 恒返回空（即修复前行为）  → 7 条红，含点名 targetStateOffset
 *   E2 缺口不压 authority（停在 candidate）    → 1 条红，点名 authority 必须 partial
 *   E3 envelope 字段改名（unparsedGaps 消失）  → 6 条红，点名字段必须导出
 *   E4 诊断码合并进 DIVERGED                   → 2 条红，点名「两类缺口必须分列」
 *   E5 缺口文本去掉 +0x00 偏移                 → 1 条红，点名须含可定位偏移
 *   E6 判据改成恒真（无条件报缺口）            → 1 条红，点名零 condition 不得报假缺口
 *   E7 那句错注释回归                          → 已删除该判据，理由见下方 catch 前注释
 * 六条（E1–E6）全部红在**目标断言**上；还原后强制重建复跑回全绿。
 * E2 与 E6 是本门禁的两个支点：前者证明「登记了但不压 authority」会被抓，
 * 后者证明判据不是恒真——只有 E6 能区分「真判据」与「无条件返回一句话」。
 *
 * ⚠️ 复现必须 `--no-incremental`：还原源码后增量构建不重编，扰动留在二进制里会
 *    让复跑报假红，看起来像判据自己有 bug。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'esd-gap-visibility';
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

const checks = [];
const findings = [];
function check(label, ok, detail) {
  checks.push({ label, ok });
  if (!ok) findings.push({ label, detail });
}

const scratch = mkdtempSync(join(tmpdir(), 'sf-esdgap-'));
const sourceRoot = join(scratch, 'source');
mkdirSync(sourceRoot, { recursive: true });
const SESSION = 'esd-gap-visibility-gate';

// ---------------------------------------------------------------------------
// 合法 ESD 构造器
//
// 布局取自 EsdNativeDocument.Read 实际读取的偏移（不是凭印象）：
//   文件头 0x00-0x6B：magic/version/darkSoulsCount×2/结构尺寸常量/五组声明计数
//   数据头 0x6C 起：one=1、stateGroups 相对偏移(0x84)、组数(0x8C)
//   全部 post-header 偏移相对 DataStart=0x6C
//   stateGroup 32B: groupId / statesRel / stateCount / statesRel2(须等于 statesRel)
//   state 72B: stateId / condArrRel / condArrCount / entry(rel,count) /
//              exit(rel,count) / while(rel,count)
//   每组 states 数组尾随一个**哨兵槽**，须与 slot 0 逐字节相同，且 0x30 计入它
//   condition 56B: targetStateOffset / passCmd(rel,count) / subcond(rel,count) /
//                  eval(rel,length)
//   commandCall 24B: bank / commandID / args(rel,count)
// ---------------------------------------------------------------------------

const DATA_START = 0x6c;
const STATE_GROUP_SIZE = 32;
const STATE_SIZE = 72;
const CONDITION_SIZE = 56;
const COMMAND_CALL_SIZE = 24;

/**
 * 构造单组 ESD。
 * @param {object} options
 * @param {number} options.stateCount 语义状态数（不含哨兵）
 * @param {number} options.conditionCount 每个状态挂几个 condition（0 = 不挂）
 * @param {number} options.commandCallCount 每个状态的 entry 命令数（0 = 不挂）
 */
function buildEsd({ stateCount, conditionCount, commandCallCount }) {
  // 数据区布局（相对 DATA_START）：
  //   0x00  数据头 0x48 字节
  //   0x48  stateGroup 表（1 条）
  //   之后  states 数组（stateCount + 1 条，末条为哨兵）
  //   之后  condition 偏移数组（int64 × conditionCount）
  //   之后  condition 记录（conditionCount 条）
  //   之后  commandCall 记录（commandCallCount 条）
  const dataHeaderSize = 0x48;
  const groupTableRel = dataHeaderSize;
  const statesRel = groupTableRel + STATE_GROUP_SIZE;
  const stateSlots = stateCount + 1; // 含哨兵
  const condArrRel = statesRel + stateSlots * STATE_SIZE;
  const condRecRel = condArrRel + conditionCount * 8;
  const cmdRecRel = condRecRel + conditionCount * CONDITION_SIZE;
  const dataSize = cmdRecRel + commandCallCount * COMMAND_CALL_SIZE;

  const buffer = Buffer.alloc(DATA_START + dataSize);
  const abs = (rel) => DATA_START + rel;

  // ── 文件头 ──
  buffer.write('fsSL', 0, 'ascii');
  buffer.writeInt32LE(1, 0x04);        // version
  buffer.writeInt32LE(3, 0x08);        // darkSoulsCount
  buffer.writeInt32LE(3, 0x0c);        // darkSoulsCount2
  buffer.writeInt32LE(0x54, 0x10);     // headerSize
  buffer.writeInt32LE(dataSize, 0x14); // dataSize（须等于 length - 0x6C）
  buffer.writeInt32LE(6, 0x18);        // unk18
  buffer.writeInt32LE(0x48, 0x1c);     // conditionSize
  buffer.writeInt32LE(1, 0x20);        // unk20
  buffer.writeInt32LE(0x20, 0x24);     // stateGroupSize
  buffer.writeInt32LE(1, 0x28);        // declaredStateGroupCount
  buffer.writeInt32LE(0x48, 0x2c);     // stateSize
  // 0x30 计的是**物理记录数**（含每组哨兵）——写语义数会被覆盖率判据判红，
  // 那样测到的就不是「缺口可见性」而是「计数不符」，两件事必须分开。
  buffer.writeInt32LE(stateSlots, 0x30);
  buffer.writeInt32LE(0x38, 0x34);     // conditionStructSize
  buffer.writeInt32LE(conditionCount * stateCount === 0 ? 0 : conditionCount, 0x38);
  buffer.writeInt32LE(0x18, 0x3c);     // commandCallSize
  buffer.writeInt32LE(commandCallCount * stateCount === 0 ? 0 : commandCallCount, 0x40);
  buffer.writeInt32LE(0x10, 0x44);     // commandArgSize
  buffer.writeInt32LE(0, 0x48);        // declaredCommandArgCount

  // ── 数据头 ──
  buffer.writeInt32LE(1, abs(0x00));           // one
  buffer.writeBigInt64LE(BigInt(groupTableRel), abs(0x18)); // 0x84 绝对 = 0x6C + 0x18
  buffer.writeBigInt64LE(1n, abs(0x20));       // 0x8C 绝对：组数

  // ── stateGroup（1 条）──
  const g = abs(groupTableRel);
  buffer.writeBigInt64LE(7000n, g);                        // groupId
  buffer.writeBigInt64LE(BigInt(statesRel), g + 0x08);     // statesRel
  buffer.writeBigInt64LE(BigInt(stateCount), g + 0x10);    // stateCount（语义数）
  buffer.writeBigInt64LE(BigInt(statesRel), g + 0x18);     // statesRel2（须相等）

  // ── condition 偏移数组 + condition 记录 ──
  for (let c = 0; c < conditionCount; c++) {
    const recRel = condRecRel + c * CONDITION_SIZE;
    buffer.writeBigInt64LE(BigInt(recRel), abs(condArrRel + c * 8));
    const r = abs(recRel);
    // +0x00 targetStateOffset：**刻意给一个非 −1 的真实目标**。
    // 给 −1（哨兵）会让「没跟随」和「本来就没有目标」不可区分——那样即使实现
    // 真的跟随了边，也测不出差别。这里指向本组 slot 0 的相对偏移。
    buffer.writeBigInt64LE(BigInt(statesRel), r);
    buffer.writeBigInt64LE(-1n, r + 0x08);  // passCmd rel（−1 = 无）
    buffer.writeBigInt64LE(0n, r + 0x10);   // passCmd count
    buffer.writeBigInt64LE(-1n, r + 0x18);  // subcond rel
    buffer.writeBigInt64LE(0n, r + 0x20);   // subcond count
    buffer.writeBigInt64LE(-1n, r + 0x28);  // eval rel
    buffer.writeBigInt64LE(0n, r + 0x30);   // eval length
  }

  // ── commandCall 记录 ──
  for (let k = 0; k < commandCallCount; k++) {
    const r = abs(cmdRecRel + k * COMMAND_CALL_SIZE);
    buffer.writeInt32LE(1, r);          // bank（会被聚合）
    // +0x04 commandID：给一个**可辨识的非零值**。若将来实现真的读了它，
    // 应当能在 envelope 里看到这个值；现在读不到，正是缺口所在。
    buffer.writeInt32LE(4242 + k, r + 0x04);
    buffer.writeBigInt64LE(-1n, r + 0x08); // args rel（−1 = 无）
    buffer.writeBigInt64LE(0n, r + 0x10);  // args count
  }

  // ── states（slot 0..stateCount-1）+ 哨兵 ──
  for (let s = 0; s < stateCount; s++) {
    const r = abs(statesRel + s * STATE_SIZE);
    buffer.writeBigInt64LE(BigInt(9000 + s), r);           // stateId
    if (conditionCount > 0) {
      buffer.writeBigInt64LE(BigInt(condArrRel), r + 0x08); // condArrRel
      buffer.writeBigInt64LE(BigInt(conditionCount), r + 0x10);
    } else {
      buffer.writeBigInt64LE(-1n, r + 0x08);
      buffer.writeBigInt64LE(0n, r + 0x10);
    }
    if (commandCallCount > 0) {
      buffer.writeBigInt64LE(BigInt(cmdRecRel), r + 0x18);  // entry cmd rel
      buffer.writeBigInt64LE(BigInt(commandCallCount), r + 0x20);
    } else {
      buffer.writeBigInt64LE(-1n, r + 0x18);
      buffer.writeBigInt64LE(0n, r + 0x20);
    }
    buffer.writeBigInt64LE(-1n, r + 0x28); // exit cmd rel
    buffer.writeBigInt64LE(0n, r + 0x30);
    buffer.writeBigInt64LE(-1n, r + 0x38); // while cmd rel
    buffer.writeBigInt64LE(0n, r + 0x40);
  }
  // 哨兵槽必须是 slot 0 的逐字节副本，否则 StateRecordModelConsistent 会判失效，
  // 那时红的是哨兵模型而不是本门禁要测的缺口可见性。
  if (stateCount > 0) {
    buffer.copy(
      buffer,
      abs(statesRel + stateCount * STATE_SIZE),
      abs(statesRel),
      abs(statesRel) + STATE_SIZE
    );
  }

  return buffer;
}

// ---------------------------------------------------------------------------
// daemon
// ---------------------------------------------------------------------------

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

async function readEsd(name, bytes) {
  const path = join(sourceRoot, `${name}.esd`);
  writeFileSync(path, bytes);
  seq += 1;
  const response = await daemon.send({
    kind: 'request',
    protocolVersion: '1.0.0',
    requestId: `esdgap-${seq}`,
    workspaceSessionId: SESSION,
    payload: { command: 'read-esd-document', filePath: path, options: {} }
  });
  const result = response.payload?.result ?? null;
  return {
    kind: response.kind,
    parseStatus: result?.parseStatus ?? response.kind,
    data: result?.data ?? null,
    diagnostics: result?.diagnostics ?? [],
    codes: (result?.diagnostics ?? []).map((d) => d.code),
    raw: response
  };
}

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

  // ---- ① 有 condition + 有 commandCall：两条缺口都必须可见 ----
  const full = await readEsd('esd-with-edges', buildEsd({
    stateCount: 2, conditionCount: 2, commandCallCount: 2
  }));
  if (full.parseStatus === 'failed') {
    check('合法 synthetic ESD 必须解析成功（fixture 前提）', false, {
      codes: full.codes,
      messages: full.diagnostics.map((d) => d.message)
    });
  } else {
    const gaps = full.data?.unparsedGaps ?? null;
    check(
      'envelope 必须导出 unparsedGaps 字段（缺口进得了集合才对上层存在）',
      Array.isArray(gaps),
      { unparsedGaps: gaps, envelopeKeys: full.data ? Object.keys(full.data) : null }
    );
    const gapText = Array.isArray(gaps) ? gaps.join(' | ') : '';
    check(
      'unparsedGaps 必须点名 targetStateOffset（状态转移边未解析）',
      gapText.includes('targetStateOffset'),
      { unparsedGaps: gaps }
    );
    check(
      'unparsedGaps 必须点名 commandID（命令身份未知）',
      gapText.includes('commandID'),
      { unparsedGaps: gaps }
    );
    // 缺口文本必须带可定位的字段偏移：只说「有缺口」的文本无法让人找到位置，
    // 与「诊断消息只说失败了」同类问题。
    check(
      '缺口文本必须含可定位的字段偏移（+0x00 / +0x04）',
      gapText.includes('+0x00') && gapText.includes('+0x04'),
      { unparsedGaps: gaps }
    );
    check(
      'authority 必须为 partial，不得停留在 candidate',
      full.data?.authority === 'partial',
      { authority: full.data?.authority ?? null, unparsedGaps: gaps }
    );
    check(
      '必须单列 ESD_STRUCTURE_NOT_PARSED_IN_SCOPE 诊断',
      full.codes.includes('ESD_STRUCTURE_NOT_PARSED_IN_SCOPE'),
      { codes: full.codes }
    );
    // 与 DIVERGED 分开：本 fixture 的计数是自洽的，所以那条**不该**出现。
    // 若两者混成一条，这里会红——这正是「分列」的判别力所在。
    check(
      '计数自洽时不得报 ESD_DECLARED_PARSED_DIVERGED（两类缺口必须分列）',
      !full.codes.includes('ESD_DECLARED_PARSED_DIVERGED'),
      { codes: full.codes, coverageShortfalls: full.data?.coverageShortfalls ?? null }
    );
    check(
      '计数自洽时 coverageComplete 必须为真（否则测到的是计数不符而非缺口可见性）',
      full.data?.coverageComplete === true,
      { coverageComplete: full.data?.coverageComplete ?? null, coverageShortfalls: full.data?.coverageShortfalls ?? null }
    );
    // commandID 确实没被导出——这条钉住「缺口是真的」，防止将来有人只加标注
    // 却顺手把 commandID 读了（那时应当删标注，而不是留一句假缺口）。
    const envelopeText = JSON.stringify(full.data ?? {});
    check(
      'commandID 的值（4242）确实未出现在 envelope 里（缺口是真的，不是假标注）',
      !envelopeText.includes('4242'),
      { hint: '若此条红，说明 commandID 已被解析并导出，应当删除对应缺口标注而不是保留' }
    );
  }

  // ---- ④ 无 condition / 无 commandCall：不得报对应缺口 ----
  // 这是判别力的直接来源：判据若写成无条件返回两句话，这两条立刻红。
  const noCond = await readEsd('esd-no-conditions', buildEsd({
    stateCount: 1, conditionCount: 0, commandCallCount: 2
  }));
  if (noCond.parseStatus !== 'failed') {
    const gaps = (noCond.data?.unparsedGaps ?? []).join(' | ');
    check(
      '零 condition 的 ESD 不得报 targetStateOffset 缺口（假缺口会稀释真信号）',
      !gaps.includes('targetStateOffset'),
      { unparsedGaps: noCond.data?.unparsedGaps ?? null }
    );
    check(
      '零 condition 但有 commandCall 时仍须报 commandID 缺口',
      gaps.includes('commandID'),
      { unparsedGaps: noCond.data?.unparsedGaps ?? null }
    );
  } else {
    check('零 condition fixture 必须解析成功', false, { codes: noCond.codes });
  }

  const noCmd = await readEsd('esd-no-commands', buildEsd({
    stateCount: 1, conditionCount: 1, commandCallCount: 0
  }));
  if (noCmd.parseStatus !== 'failed') {
    const gaps = (noCmd.data?.unparsedGaps ?? []).join(' | ');
    check(
      '零 commandCall 的 ESD 不得报 commandID 缺口',
      !gaps.includes('commandID'),
      { unparsedGaps: noCmd.data?.unparsedGaps ?? null }
    );
    check(
      '零 commandCall 但有 condition 时仍须报 targetStateOffset 缺口',
      gaps.includes('targetStateOffset'),
      { unparsedGaps: noCmd.data?.unparsedGaps ?? null }
    );
  } else {
    check('零 commandCall fixture 必须解析成功', false, { codes: noCmd.codes });
  }

  // ⚠️ 这里刻意**没有**「源码不得出现某句注释」这类文本判据。
  //
  // 我写过一条：断言 EsdNativeDocument.cs 里不再出现旧注释
  // 「read but only bank is aggregated」（那句话自称读过 commandID 而实际没读）。
  // 它必须删除，两个理由：
  //   ① 本仓库已因同一形态删过一条门禁（e590bb3 删掉
  //      runThreeSceneModuleSmoke:58 的 includes('projection only')）：判据打在注释
  //      散文上对实现零判别力——改写注释即误红，而只要注释留着那几个词，实现真的
  //      违约也照样报绿。
  //   ② 更直接的自证问题：修复本身要在代码旁**引用**那句错注释来解释它为什么错
  //      （「原注释写的是……，那句话是错的」），于是原串仍在文件里，判据恒红；
  //      要让它转绿就得删掉解释，而那条解释正是防止缺陷回归的有效信息。
  //      一条逼你删除有用注释才能转绿的判据，方向是反的。
  // commandID 未读这件事由上面的运行期判据钉住（unparsedGaps 点名 + 4242 不出现在
  // envelope 里），那是对实现的观测，不依赖任何注释文本。
} catch (error) {
  report({
    ok: false,
    gate: LABEL,
    status: 'failed',
    code: 'ESD_GAP_HARNESS_FAILED',
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
    code: 'ESD_GAP_VISIBILITY_REGRESSION',
    message: 'ESD 未解析结构的可见性判据失败。',
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
  evidence: 'runtime-observed：经生产命令 read-esd-document 真实解析，观测 envelope 与诊断',
  fixture: 'synthetic 单组 ESD（微小、合法构造、明确标记，非 native authority）',
  message: '两处未解析字段区间（condition +0x00 targetStateOffset、commandCall +0x04 commandID）'
    + '在 unparsedGaps 中点名、带字段偏移、压 authority 至 partial、单列诊断码；'
    + '结构不存在时不报对应缺口（假缺口会稀释真信号）。',
  nonClaims: [
    '不声称状态转移边已解析：本门禁断言的恰恰相反——它守的是「未解析」这个事实必须可见。'
      + '真正实现转移边解析属 V0.6 承接动作（scope.json SCOPE-BEHAVIOR-ESD 的 resumeRequires 要求'
      + '跳转关系双向解析并能检出悬空目标），需用户裁定改回 supported。',
    '不声称 commandID 已可用：只断言它未被导出，且这个缺失是可见的。',
    '不构成 ESD native authority：fixture 是自造字节，真实 ESD 语料按 V0.6 延期未在'
      + ' registry 登记（bridge:verify:esd 恒诚实跳过）。本门禁不替代真实语料验证。',
    '不覆盖表达式字节码语义：RPN 仍按不透明 (offset,length) 上报，那是既有声明。',
    '不声称 unparsedGaps 已穷举 ESD 全部未解析区间：只覆盖已定位的这两处；'
      + '0x4C/0x50 的 condOffsets 与 0x54–0x6B 名字块同样未结构化使用，未纳入本判据。'
  ]
}, 0);
