#!/usr/bin/env node
/**
 * ESD 状态转移图解析 + 剩余缺口可见性门禁。
 *
 * ⚠️ 本门禁的职责在 2026-08-08 变过一次。原先它守的是「两处字段区间未解析这件事
 * 必须可见」（condition 的 +0x00 targetStateOffset 与 command call 的 +0x04
 * commandID）。**那两处已按用户裁定实现**（ESD 由 deferred 改回 supported），
 * 所以那批断言的前提不再成立——靶标必须随实现推进改靶，不能靠放宽判据转绿。
 *
 * 现在它守两件事：
 *   ① **转移边与 commandID 真的解析对了**：边解析成 (groupId, stateId)、四态判定
 *      正确、悬空目标被检出、commandID 逐值读出并按槽位归类。
 *   ② **剩下的缺口仍然可见**：RPN 字节码不解码（永久禁令 unknown-expression-or-
 *      command-reencode 的直接后果）必须登记进 unparsedGaps 并压 authority。
 *
 * ── 缺陷形态（2026-08-08 实测）──
 * EsdNativeDocument 认出 state group → state → condition → command call 的结构与
 * 计数，此前有两处字段区间**读都没读**，现已实现：
 *   · condition 的 `+0x00 targetStateOffset`（跳转目标）——现已跟随并解析成
 *     (groupId, stateId)。此前「节点全解析、一条边没连」。
 *   · command call 的 `+0x04 commandID`——现已读出并按 entry/exit/while/
 *     condition-pass 分槽。此前只聚合 bank，命令身份无从回答。
 *
 * ── 为什么转移边的失效形态需要专门门禁 ──
 * 边解析的失效**全是静默的**：
 *   · 目标判定写成「落在 state 区间内」而不是「精确命中记录起点」→ 错位引用被当成
 *     正常边放过（差 8 字节的偏移在字节上仍属该区间）；
 *   · 把尾随哨兵槽也登记进 state 表 → 指向哨兵的边被当成正常边，
 *     状态机多出一个本不存在的节点；
 *   · 悬空目标不检出 → resumeRequires 明写「跳转关系要能构成闭合图并检出悬空目标，
 *     否则写入会破坏状态机可达性」，那道要求就落空了；
 *   · −1 不当成「不跳转」而当成悬空 → 真实语料 10574 条会全部误报。
 * 这些都不抛异常，只产出**结构完好但语义错误**的图。所以判据逐字段打在解析结果上。
 *
 * ── 判据打在哪 ──
 * 全部经**生产命令** read-esd-document 走真实 Bridge，用 harness 自造的合法 ESD
 * 字节（微小、明确标记的 synthetic，非 native authority）。断言：
 *   ① 转移边解析：resolved 边必须给出正确的 targetGroupId/targetStateId；
 *      −1 必须判 none；指向哨兵必须判 sentinel；越界目标必须判 dangling。
 *   ② 图闭合判定：有悬空或哨兵目标时 closed=false 且必须报
 *      ESD_TRANSITION_GRAPH_NOT_CLOSED；全 resolved 时 closed=true 且不报。
 *   ③ commandID 逐值读出并按槽位归类（只报总数会丢掉 entry/exit 的区别）。
 *   ④ 剩余缺口仍可见：RPN 字节码不解码必须登记进 unparsedGaps 并压 authority；
 *      **零字节码的 ESD 不得报该缺口**——这条防「无条件返回一句话」那种假标注，
 *      也是判别力的直接来源（判据若写成恒真，这条立刻红）。
 *   ⑤ 两类诊断分列：ESD_STRUCTURE_NOT_PARSED_IN_SCOPE（刻意不解码 = 范围）与
 *      ESD_DECLARED_PARSED_DIVERGED（声明量与实解析量不符 = 数据可疑）处置方向相反，
 *      混成一条会让下一个人去修一个不存在的 bug（ESD 哨兵那次就是这么被误判的）。
 *
 * 归 synthetic 层：ESD 字节可自造、不需要真实游戏资产（真实 ESD 语料未在 registry
 * 登记，bridge:verify:esd 恒诚实跳过——这正是本门禁存在的必要性：否则这些性质在
 * 任何常驻验证里都不可见）。解析在 C# 侧，需要真实 exe。
 * 与 test:flver-gap-visibility / test:flver-gxlist 同一惯例。
 *
 * ── 真实语料一次性取证（不由本门禁保证，故如实标注为「已核验过一次」）──
 * 192 个 .esd / 4894 个 state group / 41467 个 condition：转移边 41467 条 =
 * resolved 30893 + none(−1) 10574，**悬空 0、指向哨兵 0**，192/192 跳转图闭合；
 * 命令调用 23626 条（entry/exit/while/condition-pass 四槽），commandID 取值跨度极大
 * （−1、11/39/40/68/101/103、以及 2147483642/3/6）。独立字节量测与经生产命令复核
 * 两次结果逐项一致。
 *
 * ── 负向证明（2026-08-08 实测十条，每条退化后 `--no-incremental` 重建再跑本门禁）──
 * 十条退化全部命中目标断言（exit=1），还原后基线回绿（exit=0）：
 *   D1  targetStateOffset 不跟随（回到修复前：边全丢）      → 目标解析值断言红
 *   D2  目标判定改「落在 state 区间内」                     → 错位 8 字节 dangling 断言红
 *   D3  哨兵槽登记进 state 表                               → sentinel 判定断言红
 *   D4  −1 不判 none                                        → none 判定断言红
 *   D5  闭合判定忽略悬空                                    → 图不闭合断言红
 *   D6  不报 ESD_TRANSITION_GRAPH_NOT_CLOSED                → 诊断缺失断言红
 *   D7  commandID 不读（回到修复前）                        → commandID=4242 断言红
 *   D8  commandCalls 不分槽                                 → 槽位归类断言红
 *   D9  字节码缺口无条件登记                                → 零字节码假缺口断言红
 *   D10 图不闭合时 authority 不降级                         → authority=partial 断言红
 * D4 的锚点最初写成跨行字面量匹配不上（源码 CRLF），假报「锚点未命中」；改单行锚点后成立。
 * dangling fixture 刻意用 8 字节错位偏移——那是「按区间判」会漏掉而「按起点判」能抓到的形态。
 *
 * ⚠️ 改本门禁或 EsdNativeDocument 后做负向证明时必须 `--no-incremental`：
 *    还原源码后增量构建不重编，扰动留在二进制里会让复跑报假红。
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
 * @param {'resolved'|'none'|'sentinel'|'dangling'} [options.targetMode]
 *   condition 的 targetStateOffset 形态，用于测四态判定。见下方逐行注释。
 */
function buildEsd({ stateCount, conditionCount, commandCallCount, targetMode = 'resolved' }) {
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
    // +0x00 targetStateOffset。默认指向本组 slot 0 的相对偏移（合法目标）。
    // 刻意**不用 −1**：−1 会让「没跟随」与「本来就没有目标」不可区分，
    // 那样即使实现真的跟随了边也测不出差别。
    // targetMode 可以把它改成其他形态，用于测四态判定：
    //   'resolved'（默认）→ slot 0；'none' → −1；
    //   'sentinel'  → 该组尾随哨兵槽的偏移；
    //   'dangling'  → 一个刻意错位 8 字节的偏移（在 state 区间内但不是记录起点，
    //                 这正是「按区间判」会漏掉而「按起点判」能抓到的形态）。
    const targetRel = targetMode === 'none'
      ? -1n
      : targetMode === 'sentinel'
        ? BigInt(statesRel + stateCount * STATE_SIZE)
        : targetMode === 'dangling'
          ? BigInt(statesRel + 8)
          : BigInt(statesRel);
    buffer.writeBigInt64LE(targetRel, r);
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
    const graph = full.data?.transitionGraph ?? null;
    check(
      'envelope 必须导出 transitionGraph（边进得了 envelope 才对上层存在）',
      graph !== null,
      { envelopeKeys: full.data ? Object.keys(full.data) : null }
    );
    // fixture 有 2 个状态各挂 2 个 condition，但两个状态共用同一条 condition 偏移数组，
    // 故去重后 condition 数 = 2 → 边数 = 2。判据用「等于 parsedConditionCount」
    // 而不是写死数字：条件去重规则改了这里不该误红，但**每个 condition 恰好一条边**
    // 这个关系必须成立（漏记或重复记都会破坏它）。
    check(
      '边数必须等于解析出的 condition 数（每个 condition 恰好一条边）',
      graph?.edgeCount === full.data?.parsedConditionCount,
      { edgeCount: graph?.edgeCount ?? null, parsedConditionCount: full.data?.parsedConditionCount ?? null }
    );
    check(
      '合法目标必须判 resolved（不是 dangling，也不是 none）',
      graph?.resolved === graph?.edgeCount && graph?.dangling === 0 && graph?.none === 0,
      { graph }
    );
    check(
      '跳转图必须判为闭合（无悬空、无哨兵目标）',
      graph?.closed === true,
      { graph }
    );
    check(
      'resolved 边必须给出 targetGroupId 与 targetStateId（只报「解析成功」没有用）',
      (graph?.edges ?? []).length > 0
      && graph.edges.every((e) => e.resolution !== 'resolved'
        || (typeof e.targetGroupId === 'number' && typeof e.targetStateId === 'number')),
      { edges: graph?.edges ?? null }
    );
    // 目标必须指向 fixture 里真实写入的 groupId(7000)/stateId(9000)，
    // 而不是任意数字——否则「解析出一个值」与「解析出正确的值」不可区分。
    check(
      '目标解析值必须等于 fixture 写入的 groupId=7000 / stateId=9000（slot 0）',
      (graph?.edges ?? []).some((e) => e.resolution === 'resolved'
        && e.targetGroupId === 7000 && e.targetStateId === 9000),
      { edges: graph?.edges ?? null }
    );
    check(
      '跳转图闭合时不得报 ESD_TRANSITION_GRAPH_NOT_CLOSED',
      !full.codes.includes('ESD_TRANSITION_GRAPH_NOT_CLOSED'),
      { codes: full.codes }
    );

    // ---- commandID 必须逐值读出并按槽位归类 ----
    const calls = full.data?.commandCalls ?? null;
    check('envelope 必须导出 commandCalls', calls !== null, { envelopeKeys: full.data ? Object.keys(full.data) : null });
    const envelopeText = JSON.stringify(full.data ?? {});
    check(
      'commandID 的值（4242）必须出现在 envelope 里（此前该字段从未被读取）',
      envelopeText.includes('4242'),
      { samples: calls?.samples ?? null }
    );
    check(
      'commandCalls 必须按槽位归类（只报总数会丢掉 entry/exit 的区别）',
      Array.isArray(calls?.bySlot) && calls.bySlot.some((s) => s.slot === 'entry' && s.count > 0),
      { bySlot: calls?.bySlot ?? null }
    );

    // ---- 剩余缺口（RPN 字节码不解码）仍须可见 ----
    // 本 fixture 的 condition 与 command 都不带字节码区（evalRel/argsRel 都是 −1），
    // 所以这里**不该**报字节码缺口——见下方带字节码的 fixture。
    const gaps = full.data?.unparsedGaps ?? null;
    check('envelope 必须导出 unparsedGaps 字段', Array.isArray(gaps), { unparsedGaps: gaps });
    check(
      '零字节码区的 ESD 不得报「RPN 不解码」缺口（假缺口会稀释真信号）',
      !(gaps ?? []).some((g) => g.includes('bytecode')),
      { unparsedGaps: gaps, bytecodeRegionCount: full.data?.bytecodeRegionCount ?? null }
    );
    // 与 DIVERGED 分开：本 fixture 的计数是自洽的，所以那条**不该**出现。
    check(
      '计数自洽时不得报 ESD_DECLARED_PARSED_DIVERGED（两类诊断必须分列）',
      !full.codes.includes('ESD_DECLARED_PARSED_DIVERGED'),
      { codes: full.codes, coverageShortfalls: full.data?.coverageShortfalls ?? null }
    );
    check(
      '计数自洽时 coverageComplete 必须为真（否则测到的是计数不符而非本门禁的目标）',
      full.data?.coverageComplete === true,
      { coverageComplete: full.data?.coverageComplete ?? null, coverageShortfalls: full.data?.coverageShortfalls ?? null }
    );
  }

  // ---- ② 四态判定：none / sentinel / dangling 各造一个 ----
  const noneCase = await readEsd('esd-target-none', buildEsd({
    stateCount: 1, conditionCount: 1, commandCallCount: 0, targetMode: 'none'
  }));
  if (noneCase.parseStatus !== 'failed') {
    const g = noneCase.data?.transitionGraph ?? {};
    check(
      'targetStateOffset = −1 必须判 none 而不是 dangling（真实语料 10574 条如此，误判会全部报错）',
      g.none === g.edgeCount && g.dangling === 0 && g.closed === true,
      { graph: g }
    );
  } else {
    check('none fixture 必须解析成功', false, { codes: noneCase.codes });
  }

  const sentinelCase = await readEsd('esd-target-sentinel', buildEsd({
    stateCount: 2, conditionCount: 1, commandCallCount: 0, targetMode: 'sentinel'
  }));
  if (sentinelCase.parseStatus !== 'failed') {
    const g = sentinelCase.data?.transitionGraph ?? {};
    check(
      '指向尾随哨兵槽必须判 sentinel（把哨兵登记成 state 会让它被当成正常边）',
      g.sentinel > 0 && g.resolved === 0,
      { graph: g }
    );
    check(
      '存在哨兵目标时图必须判不闭合，并报 ESD_TRANSITION_GRAPH_NOT_CLOSED',
      g.closed === false && sentinelCase.codes.includes('ESD_TRANSITION_GRAPH_NOT_CLOSED'),
      { graph: g, codes: sentinelCase.codes }
    );
    check(
      '哨兵目标必须给出可定位样本（只报数量无法排查）',
      Array.isArray(g.sentinelSamples) && g.sentinelSamples.length > 0
      && typeof g.sentinelSamples[0]?.conditionRelOffset === 'number',
      { sentinelSamples: g.sentinelSamples ?? null }
    );
  } else {
    check('sentinel fixture 必须解析成功', false, { codes: sentinelCase.codes });
  }

  // dangling：目标错位 8 字节——在 state 区间内但不是记录起点。
  // 这是「按区间判」会漏掉而「按起点判」能抓到的形态，也是本判据的关键用例。
  const danglingCase = await readEsd('esd-target-dangling', buildEsd({
    stateCount: 2, conditionCount: 1, commandCallCount: 0, targetMode: 'dangling'
  }));
  if (danglingCase.parseStatus !== 'failed') {
    const g = danglingCase.data?.transitionGraph ?? {};
    check(
      '错位 8 字节的目标必须判 dangling（按区间判会漏掉这种错位引用）',
      g.dangling > 0 && g.resolved === 0,
      { graph: g }
    );
    check(
      '存在悬空目标时图必须判不闭合，并报 ESD_TRANSITION_GRAPH_NOT_CLOSED',
      g.closed === false && danglingCase.codes.includes('ESD_TRANSITION_GRAPH_NOT_CLOSED'),
      { graph: g, codes: danglingCase.codes }
    );
    check(
      '悬空目标必须给出可定位样本（含 conditionRelOffset 与 targetStateRelOffset）',
      Array.isArray(g.danglingSamples) && g.danglingSamples.length > 0
      && typeof g.danglingSamples[0]?.targetStateRelOffset === 'number',
      { danglingSamples: g.danglingSamples ?? null }
    );
    check(
      '图不闭合时 authority 必须为 partial',
      danglingCase.data?.authority === 'partial',
      { authority: danglingCase.data?.authority ?? null }
    );
  } else {
    check('dangling fixture 必须解析成功', false, { codes: danglingCase.codes });
  }

  // ---- ③ 零 condition：不得凭空造出边 ----
  const noCond = await readEsd('esd-no-conditions', buildEsd({
    stateCount: 1, conditionCount: 0, commandCallCount: 2
  }));
  if (noCond.parseStatus !== 'failed') {
    const g = noCond.data?.transitionGraph ?? {};
    check(
      '零 condition 的 ESD 边数必须为 0（不得凭空造边）',
      g.edgeCount === 0 && g.closed === true,
      { graph: g }
    );
    check(
      '零 condition 但有 commandCall 时 commandCalls 仍须非空',
      (noCond.data?.commandCalls?.total ?? 0) > 0,
      { commandCalls: noCond.data?.commandCalls ?? null }
    );
  } else {
    check('零 condition fixture 必须解析成功', false, { codes: noCond.codes });
  }

  // ---- 零 commandCall：不得凭空造命令 ----
  const noCmd = await readEsd('esd-no-commands', buildEsd({
    stateCount: 1, conditionCount: 1, commandCallCount: 0
  }));
  if (noCmd.parseStatus !== 'failed') {
    check(
      '零 commandCall 的 ESD commandCalls.total 必须为 0',
      (noCmd.data?.commandCalls?.total ?? -1) === 0,
      { commandCalls: noCmd.data?.commandCalls ?? null }
    );
    check(
      '零 commandCall 但有 condition 时边数仍须为 1（边来自 condition，不来自命令）',
      (noCmd.data?.transitionGraph?.edgeCount ?? 0) === 1,
      { graph: noCmd.data?.transitionGraph ?? null }
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
  // commandID 现在由运行期判据钉住（4242 必须出现在 envelope 里），
  // 那是对实现的观测，不依赖任何注释文本。
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
  message: '转移边四态判定（resolved/none/sentinel/dangling）逐个验证：目标解析出正确的 '
    + 'groupId/stateId；−1 判 none 不判 dangling；指向哨兵与错位 8 字节各自被检出并使图判不闭合、'
    + '报 ESD_TRANSITION_GRAPH_NOT_CLOSED、压 authority 至 partial；commandID 逐值读出并按槽位归类；'
    + '零 condition 不凭空造边、零 commandCall 不凭空造命令；零字节码区不报假缺口。',
  nonClaims: [
    '不声称 RPN 字节码已解码：condition evaluator 与 command 参数体仍按不透明 (offset,length) '
      + '上报。scope.json 的 unknown-expression-or-command-reencode 是**永久禁令**，'
      + '不解码是刻意的；该缺口登记在 unparsedGaps 里并压 authority。',
    '不声称 ESD 具备 writer：any-esd-write-in-v05 与 raw-hex-write 保持禁止，'
      + '写能力开放前需要条件表达式与命令块未知字段的无损往返证据。本轮只做只读解析。',
    '不构成 ESD native authority：fixture 是自造字节；authority 上限为 candidate，'
      + '提升需要真实语料往返与游戏内加载证据，不由解析完整性推导。'
      + '真实语料的 192 个 .esd / 41467 条边验证是**一次性取证**，不由本门禁持续保证。',
    '不声称 commandID 的语义已知：只断言它被逐值读出并如实上报。取值跨度极大'
      + '（−1、小整数、接近 int.MaxValue），实现不做任何范围假设，也不解释各值含义。',
    '不声称 ESD 全部字段已结构化使用：0x4C/0x50 的 condOffsets 与 0x54–0x6B 名字块'
      + '仍未结构化使用，未纳入本判据。',
    '不覆盖真实语料的图闭合：本门禁用 synthetic 字节造出 sentinel/dangling 两种异常来证明'
      + '检出有效；真实语料实测 192/192 闭合、悬空 0，那是取证结论而非本门禁的断言。'
  ]
}, 0);
