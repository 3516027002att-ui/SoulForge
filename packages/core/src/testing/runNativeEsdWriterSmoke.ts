/**
 * Native ESD writer smoke（BEHAVIOR-55C）——behavior-transition-upsert 与 roundtrip。
 *
 * 路径 A（真实语料）：registry 已登记 esd-primary → 提取容器子项 → 读真实 ESD →
 * 选一条真实转移边清空目标（set-transition-target 到 -1）→ write-esd-document →
 * reopen 断言 ESD_STAGING_WRITE_VERIFIED + 目标字段为 -1。
 *
 * 路径 B（合成 fixture）：registry 未登记 → 微小、合法构造、显式 syntheticFixture
 * 标记的合成 ESD → 写回 → reopen，断言：
 *   - **set-transition-target 生效**：条件 0x190 的转移目标从 state1(0xB0) 改为
 *     state2(0xF8)；字节级 diff 恰为一个区间且落在 targetStateOffset 字段内
 *     （字节外科替换的直接证明）；重读 edge 的 targetStateId=2；
 *   - **insert-transition 生效**：状态 0x68 追加一条裸跳转条件（目标 0xF8）；
 *     声明/解析条件数 +1、转移图 edgeCount 2、新条件目标命中；全局
 *     condition-offset 表重定位后旧条目保留（entry 表内操作）；
 *   - **未知保留**：源带 RPN 字节码 evaluator（unparsedGaps 非空），写回重读后
 *     unparsedGaps 逐项一致，authority 保持 partial；
 *   - **block 语义**：set-command-arg（命令参数体是 RPN 字节码，永久不解码）→
 *     ESD_WRITE_BLOCKED_UNKNOWN_STRUCTURE 且不落盘（未知字段无法无损保留时不写坏）；
 *   - **失败注入**：目标状态不存在 / 源状态不存在 / 条件不属于状态 / hash 篡改 →
 *     ESD_STAGING_WRITE_FAILED 且不落盘；before image（源文件）字节不变；
 *   - **reopen-failure before-image 恢复**：输出损坏后 read 必须结构化失败，
 *     源 before-image 哈希可恢复；暂存区无 .soulforge-esd-*.tmp 残留。
 *
 * 缺语料处置：esd-primary 未登记是合法状态（ESD 曾延期 V0.6），此时走路径 B——
 * 合成 fixture 仍真实经过 C# EsdNativeWriter 验证写回，不冒充 native authority
 * （syntheticFixture: true）。只有 registry 配置损坏等环境问题才失败关闭。
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BridgeResult } from '@soulforge/shared';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { nativeFixtureRoleRegistered, resolveNativeFixture } from './nativeFixtureRegistry.js';
import { classifyChildExtract, reportInfrastructureFailure } from './nativeFixtureExtract.js';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';

const ESD_WRITE_COMMAND = 'write-esd-document' as const;
const ESD_READ_COMMAND = 'read-esd-document' as const;

const ESD_STAGING_WRITE_VERIFIED = 'ESD_STAGING_WRITE_VERIFIED';
const ESD_STAGING_WRITE_FAILED = 'ESD_STAGING_WRITE_FAILED';
const ESD_WRITE_BLOCKED_UNKNOWN_STRUCTURE = 'ESD_WRITE_BLOCKED_UNKNOWN_STRUCTURE';
const ESD_DOCUMENT_READ_FAILED = 'ESD_DOCUMENT_READ_FAILED';

/** 合成 fixture 的关键 rel 偏移（相对 DataStart 0x6C），与 buildSyntheticEsd 同源。 */
const SYN = {
  state0Rel: 0x68,
  state1Rel: 0xB0,
  state2Rel: 0xF8,
  condArrRel: 0x188,
  conditionRel: 0x190,
  bytecodeRel: 0x1C8,
  condOffsetsRel: 0x1CC,
  dataSize: 0x1D4
} as const;

interface EsdEnvelope {
  sourceHash?: string;
  sourceSize?: number;
  stateGroupCount?: number;
  stateCount?: number;
  parsedStateRecordCount?: number;
  declaredStateCount?: number;
  conditionCount?: number;
  parsedConditionCount?: number;
  stateSentinelModelConsistent?: boolean;
  coverageComplete?: boolean;
  coverageShortfalls?: string[];
  commandCallCount?: number;
  commandArgCount?: number;
  conditionSamples?: Array<{
    conditionRelOffset?: number;
    sourceGroupId?: number;
    sourceStateRelOffset?: number;
    targetStateRelOffset?: number;
    subConditionCount?: number;
    evaluatorLength?: number;
    passCommandCount?: number;
  }>;
  transitionGraph?: {
    edgeCount?: number;
    resolved?: number;
    none?: number;
    closed?: boolean;
    edges?: Array<{
      sourceGroupId?: number;
      conditionRelOffset?: number;
      targetGroupId?: number | null;
      targetStateId?: number | null;
      resolution?: string;
    }>;
  };
  unparsedGaps?: string[];
  authority?: string;
}

interface WriteEnvelope {
  mutationCount?: number;
  insertCount?: number;
  outputHash?: string;
  outputSize?: number;
  rereadVerified?: boolean;
  structurePreserved?: boolean;
  byteSurgical?: boolean;
  mutations?: Array<{
    mutation?: string;
    stateRelOffset?: number;
    conditionRelOffset?: number;
    targetStateRelOffset?: number;
    inserted?: {
      conditionRelOffset?: number;
      arrayRelOffset?: number;
      tableRelOffset?: number;
      tableRelocated?: boolean;
      reservedEndOffsetsUpdated?: boolean;
    } | null;
  }>;
}

interface ExtractEnvelope {
  contentSize?: number;
}

type EsdMutation = {
  mutation: string;
  stateRelOffset?: number;
  conditionRelOffset?: number;
  targetStateRelOffset?: number;
};

/** 微小、合法构造、明确标记的合成 ESD（syntheticFixture: true，非 native authority）。 */
function buildSyntheticEsd(): Buffer {
  const dataStart = 0x6c;
  const header = Buffer.alloc(dataStart);
  header.write('fsSL', 0, 'ascii');
  header.writeInt32LE(1, 0x04); // version
  header.writeInt32LE(3, 0x08); // darkSoulsCount
  header.writeInt32LE(3, 0x0c);
  header.writeInt32LE(0x54, 0x10); // headerSize
  header.writeInt32LE(6, 0x18); // unk18
  header.writeInt32LE(0x48, 0x1c); // conditionSize
  header.writeInt32LE(1, 0x20); // unk20
  header.writeInt32LE(0x20, 0x24); // stateGroupSize
  header.writeInt32LE(1, 0x28); // declaredStateGroupCount
  header.writeInt32LE(0x48, 0x2c); // stateSize
  header.writeInt32LE(4, 0x30); // declaredStateCount = 3 states + 1 尾随哨兵
  header.writeInt32LE(0x38, 0x34); // conditionStructSize
  header.writeInt32LE(1, 0x38); // declaredConditionCount
  header.writeInt32LE(0x18, 0x3c); // commandCallSize
  header.writeInt32LE(0, 0x40); // declaredCommandCallCount
  header.writeInt32LE(0x10, 0x44); // commandArgSize
  header.writeInt32LE(0, 0x48); // declaredCommandArgCount
  header.writeInt32LE(SYN.condOffsetsRel, 0x4c); // condOffsetsOffset
  header.writeInt32LE(1, 0x50); // condOffsetsCount

  const dataHeader = Buffer.alloc(0x48);
  dataHeader.writeInt32LE(1, 0x00); // one
  dataHeader.writeBigInt64LE(0x48n, 0x18); // stateGroupsRelOffset (0x84-0x6C)
  dataHeader.writeBigInt64LE(1n, 0x20); // dataHeaderGroupCount (0x8C-0x6C)

  const groupTable = Buffer.alloc(0x20);
  groupTable.writeBigInt64LE(0n, 0x00); // groupId 0
  groupTable.writeBigInt64LE(0x68n, 0x08); // statesRel
  groupTable.writeBigInt64LE(3n, 0x10); // stateCount
  groupTable.writeBigInt64LE(0x68n, 0x18); // statesRel2

  const states = Buffer.alloc(4 * 0x48);
  const writeState = (rel: number, stateId: number, condRel: number, condCount: number): void => {
    const off = rel - 0x68;
    states.writeBigInt64LE(BigInt(stateId), off + 0x00);
    states.writeBigInt64LE(BigInt(condRel), off + 0x08);
    states.writeBigInt64LE(BigInt(condCount), off + 0x10);
    states.writeBigInt64LE(-1n, off + 0x18); // entryCmdRel
    states.writeBigInt64LE(0n, off + 0x20);
    states.writeBigInt64LE(-1n, off + 0x28); // exitCmdRel
    states.writeBigInt64LE(0n, off + 0x30);
    states.writeBigInt64LE(-1n, off + 0x38); // whileCmdRel
    states.writeBigInt64LE(0n, off + 0x40);
  };
  writeState(SYN.state0Rel, 0, SYN.condArrRel, 1);
  writeState(SYN.state1Rel, 1, -1, 0);
  writeState(SYN.state2Rel, 2, -1, 0);
  // 尾随哨兵槽 = 本组 slot 0 的逐字节副本（EsdNativeDocument 哨兵模型）
  Buffer.from(states.subarray(0, 0x48)).copy(states, 3 * 0x48);

  const condArray = Buffer.alloc(8);
  condArray.writeBigInt64LE(BigInt(SYN.conditionRel), 0x00);

  const condition = Buffer.alloc(0x38);
  condition.writeBigInt64LE(BigInt(SYN.state1Rel), 0x00); // targetStateOffset → state1
  condition.writeBigInt64LE(-1n, 0x08); // passCmdRel
  condition.writeBigInt64LE(0n, 0x10);
  condition.writeBigInt64LE(-1n, 0x18); // subcondRel
  condition.writeBigInt64LE(0n, 0x20);
  condition.writeBigInt64LE(BigInt(SYN.bytecodeRel), 0x28); // evalRel（RPN 字节码 → unparsedGap）
  condition.writeBigInt64LE(4n, 0x30); // evalLength

  const bytecode = Buffer.from([0xde, 0xad, 0xbe, 0xef]); // 刻意不解码的 evaluator 字节码

  const condOffsets = Buffer.alloc(8);
  condOffsets.writeBigInt64LE(BigInt(SYN.conditionRel), 0x00);

  const data = Buffer.concat([
    dataHeader, groupTable, states, condArray, condition, bytecode, condOffsets
  ]);
  const dataSize = data.length;
  if (dataSize !== SYN.dataSize) {
    throw new Error(`合成 ESD dataSize 计算不符：${dataSize} vs 预期 ${SYN.dataSize}`);
  }
  header.writeInt32LE(dataSize, 0x14);
  // 0x54–0x6B：三个 int64 dataSize 镜像（真实语料实测全等于 dataSize）
  header.writeBigInt64LE(BigInt(dataSize), 0x54);
  header.writeBigInt64LE(BigInt(dataSize), 0x5c);
  header.writeBigInt64LE(BigInt(dataSize), 0x64);
  return Buffer.concat([header, data]);
}

function byteDiffRegions(source: Buffer, output: Buffer): Array<{ start: number; end: number }> {
  const regions: Array<{ start: number; end: number }> = [];
  let i = 0;
  const maxLen = Math.max(source.length, output.length);
  while (i < maxLen) {
    const s = i < source.length ? source[i] : -1;
    const o = i < output.length ? output[i] : -1;
    if (s === o) { i += 1; continue; }
    const start = i;
    while (i < maxLen) {
      const ss = i < source.length ? source[i] : -1;
      const oo = i < output.length ? output[i] : -1;
      if (ss !== oo) { i += 1; continue; }
      break;
    }
    regions.push({ start, end: i });
  }
  return regions;
}

async function readEsd(path: string, allowedRoots: string[]): Promise<EsdEnvelope> {
  const result = await runBridge<EsdEnvelope>({
    command: ESD_READ_COMMAND,
    filePath: path,
    allowedRoots,
    timeoutMs: 120_000
  });
  if (result.parseStatus === 'failed' || !result.data?.sourceHash) {
    throw new Error(`read-esd-document ${path} 失败：${JSON.stringify(result.diagnostics)}`);
  }
  return result.data;
}

async function writeEsd(
  sourcePath: string,
  allowedRoots: string[],
  writableRoots: string[],
  outputPath: string,
  expectedDocumentHash: string,
  mutations: EsdMutation[]
): Promise<BridgeResult<WriteEnvelope>> {
  return runBridge<WriteEnvelope>({
    command: ESD_WRITE_COMMAND,
    filePath: sourcePath,
    allowedRoots,
    writableRoots,
    timeoutMs: 120_000,
    commandOptions: { outputPath, expectedDocumentHash, mutations }
  });
}

const fileSize = async (p: string): Promise<number> =>
  stat(p).then((s) => s.size).catch(() => 0);

async function assertNoTempResidue(staging: string): Promise<void> {
  const residue = (await readdir(staging)).filter(
    (name) => name.startsWith('.soulforge-esd-') && name.endsWith('.tmp')
  );
  if (residue.length > 0) {
    throw new Error(`暂存区残留半成品临时文件：${residue.join(', ')}`);
  }
}

async function syntheticLeg(): Promise<void> {
  await withSmokeWorkspace('native-esd-writer', async (workspace) => {
    const root = workspace.root;
    const staging = join(root, 'staging');
    await mkdir(staging, { recursive: true });

    // ---- 0. 源：合成 ESD，读 + 断言 unparsedGaps 非空（未知保留前提）。 ----
    const srcPath = join(root, 'synthetic_writer_smoke.esd');
    const srcBytes = buildSyntheticEsd();
    await writeFile(srcPath, srcBytes);
    const srcDoc = await readEsd(srcPath, [root]);
    const srcHash = srcDoc.sourceHash!;
    const srcGaps = srcDoc.unparsedGaps ?? [];
    const srcBytesOnDisk = await readFile(srcPath);
    if (!srcBytesOnDisk.equals(srcBytes)) {
      throw new Error('合成 ESD 落盘字节与构造不一致');
    }
    if (srcDoc.conditionCount !== 1 || srcDoc.parsedConditionCount !== 1) {
      throw new Error(`合成 ESD 条件数应为 1/1，实际 ${srcDoc.conditionCount}/${srcDoc.parsedConditionCount}`);
    }
    if (!srcDoc.coverageComplete) {
      throw new Error(`合成 ESD coverageComplete 应为 true：${JSON.stringify(srcDoc.coverageShortfalls)}`);
    }
    if (srcGaps.length === 0) {
      throw new Error('合成 ESD 应带 RPN 字节码 unparsedGap（未知保留测试前提）');
    }
    if (srcDoc.authority !== 'partial') {
      throw new Error(`含 unparsedGap 的源 authority 应为 partial，实际 ${srcDoc.authority}`);
    }

    // ---- 1. set-transition-target：条件 0x190 的目标 state1(0xB0) → state2(0xF8)。 ----
    const outA = join(staging, 'out-a.esd');
    const writeA = await writeEsd(srcPath, [root], [staging], outA, srcHash, [
      {
        mutation: 'set-transition-target',
        stateRelOffset: SYN.state0Rel,
        conditionRelOffset: SYN.conditionRel,
        targetStateRelOffset: SYN.state2Rel
      }
    ]);
    if (writeA.parseStatus === 'failed' || !writeA.data?.rereadVerified) {
      throw new Error(`set-transition-target 未重读验证：${JSON.stringify(writeA.diagnostics)}`);
    }
    if (!writeA.diagnostics.some((d) => d.code === ESD_STAGING_WRITE_VERIFIED)) {
      throw new Error(`set-transition-target 未发 ${ESD_STAGING_WRITE_VERIFIED}：${JSON.stringify(writeA.diagnostics)}`);
    }
    if (writeA.data.byteSurgical !== true) {
      throw new Error('set-transition-target 应标记 byteSurgical=true');
    }
    const outABytes = await readFile(outA);
    const diffRegions = byteDiffRegions(srcBytes, outABytes);
    const targetFieldAbs = 0x6c + SYN.conditionRel; // 0x1FC
    if (diffRegions.length !== 1) {
      throw new Error(`set-transition-target 应恰好一个差异区间，实际 ${JSON.stringify(diffRegions)}`);
    }
    if (diffRegions[0]!.start < targetFieldAbs || diffRegions[0]!.end > targetFieldAbs + 8) {
      throw new Error(`差异区间应落在 targetStateOffset 字段内 [0x${targetFieldAbs.toString(16)}, +8)，实际 ${JSON.stringify(diffRegions[0])}`);
    }
    if (outABytes.readBigInt64LE(targetFieldAbs) !== BigInt(SYN.state2Rel)) {
      throw new Error('写回后 targetStateOffset 应为 state2(0xF8)');
    }

    // ---- 2. 重读 out-a：edge 解析到 state2、计数不变、unparsedGaps 逐项一致。 ----
    const outADoc = await readEsd(outA, [staging]);
    const edgesA = outADoc.transitionGraph?.edges ?? [];
    const edgeA = edgesA.find((e) => e.conditionRelOffset === SYN.conditionRel);
    if (!edgeA || edgeA.targetStateId !== 2 || edgeA.resolution !== 'resolved') {
      throw new Error(`重读 edge 应解析到 state2：${JSON.stringify(edgeA)}`);
    }
    if (outADoc.conditionCount !== 1 || outADoc.parsedConditionCount !== 1) {
      throw new Error(`重读后条件数变化：${outADoc.conditionCount}/${outADoc.parsedConditionCount}`);
    }
    if (JSON.stringify(outADoc.unparsedGaps ?? []) !== JSON.stringify(srcGaps)) {
      throw new Error(`重读后 unparsedGaps 变化：${JSON.stringify(outADoc.unparsedGaps)} vs ${JSON.stringify(srcGaps)}`);
    }
    if (outADoc.authority !== 'partial') {
      throw new Error(`写回后 authority 应保持 partial，实际 ${outADoc.authority}`);
    }
    if (!outADoc.coverageComplete) {
      throw new Error('写回后 coverageComplete 应为 true');
    }

    // ---- 3. insert-transition：状态 0x68 追加一条裸跳转条件（目标 state2 0xF8）。 ----
    const outB = join(staging, 'out-b.esd');
    const writeB = await writeEsd(srcPath, [root], [staging], outB, srcHash, [
      {
        mutation: 'insert-transition',
        stateRelOffset: SYN.state0Rel,
        targetStateRelOffset: SYN.state2Rel
      }
    ]);
    if (writeB.parseStatus === 'failed' || !writeB.data?.rereadVerified) {
      throw new Error(`insert-transition 未重读验证：${JSON.stringify(writeB.diagnostics)}`);
    }
    if (!writeB.diagnostics.some((d) => d.code === ESD_STAGING_WRITE_VERIFIED)) {
      throw new Error(`insert-transition 未发 ${ESD_STAGING_WRITE_VERIFIED}：${JSON.stringify(writeB.diagnostics)}`);
    }
    if (writeB.data.insertCount !== 1) {
      throw new Error(`insertCount 应为 1：${JSON.stringify(writeB.data)}`);
    }
    const outBBytes = await readFile(outB);
    const newConditionRel = SYN.dataSize; // 新条件追加在旧数据区末尾
    // 新条件记录：targetStateOffset = state2(0xF8)
    if (outBBytes.readBigInt64LE(0x6c + newConditionRel) !== BigInt(SYN.state2Rel)) {
      throw new Error('追加条件记录的 targetStateOffset 应为 state2(0xF8)');
    }
    // 全局 condition-offset 表重定位后：旧条目 0x190 + 新条目 0x1D4
    // （newConditionRel 之后依次是 0x38 新条件 + 2×8 新条件数组 + 2×8 新表）
    const newTableAbs = 0x6c + newConditionRel + 0x38 + 16;
    const tableEntries = [outBBytes.readBigInt64LE(newTableAbs), outBBytes.readBigInt64LE(newTableAbs + 8)];
    if (tableEntries[0] !== BigInt(SYN.conditionRel) || tableEntries[1] !== BigInt(newConditionRel)) {
      throw new Error(`condition-offset 表应重定位为 [0x190, 0x1D4]，实际 ${tableEntries.map((v) => `0x${v.toString(16)}`).join(', ')}`);
    }
    // 状态 0x68 的条件数组 = 旧数组 + 新条目
    const newArrAbs = 0x6c + newConditionRel + 0x38;
    const arrEntries = [outBBytes.readBigInt64LE(newArrAbs), outBBytes.readBigInt64LE(newArrAbs + 8)];
    if (arrEntries[0] !== BigInt(SYN.conditionRel) || arrEntries[1] !== BigInt(newConditionRel)) {
      throw new Error(`状态条件数组应为 [0x190, 0x1D4]，实际 ${arrEntries.map((v) => `0x${v.toString(16)}`).join(', ')}`);
    }

    // ---- 4. 重读 out-b：条件数 +1、转移图 2 条边、新边指向 state2、unparsedGaps 不变。 ----
    const outBDoc = await readEsd(outB, [staging]);
    if (outBDoc.conditionCount !== 2 || outBDoc.parsedConditionCount !== 2) {
      throw new Error(`insert 后条件数应为 2/2，实际 ${outBDoc.conditionCount}/${outBDoc.parsedConditionCount}`);
    }
    const edgesB = outBDoc.transitionGraph?.edges ?? [];
    const newEdge = edgesB.find((e) => e.conditionRelOffset === newConditionRel);
    if (!newEdge || newEdge.targetStateId !== 2 || newEdge.resolution !== 'resolved') {
      throw new Error(`新边应解析到 state2：${JSON.stringify(newEdge)}`);
    }
    const oldEdgeB = edgesB.find((e) => e.conditionRelOffset === SYN.conditionRel);
    if (!oldEdgeB || oldEdgeB.targetStateId !== 1) {
      throw new Error(`旧条件边应保持指向 state1：${JSON.stringify(oldEdgeB)}`);
    }
    if ((outBDoc.transitionGraph?.edgeCount ?? 0) !== 2) {
      throw new Error(`转移图 edgeCount 应为 2：${outBDoc.transitionGraph?.edgeCount}`);
    }
    if (JSON.stringify(outBDoc.unparsedGaps ?? []) !== JSON.stringify(srcGaps)) {
      throw new Error(`insert 后 unparsedGaps 变化：${JSON.stringify(outBDoc.unparsedGaps)}`);
    }
    if (!outBDoc.coverageComplete) {
      throw new Error('insert 后 coverageComplete 应为 true');
    }

    // ---- 5. block 语义：set-command-arg → ESD_WRITE_BLOCKED_UNKNOWN_STRUCTURE 且不落盘。 ----
    const blockedOut = join(staging, 'blocked.esd');
    const blocked = await writeEsd(srcPath, [root], [staging], blockedOut, srcHash, [
      { mutation: 'set-command-arg', stateRelOffset: SYN.state0Rel, conditionRelOffset: SYN.conditionRel }
    ]);
    if (blocked.parseStatus !== 'failed'
      || !blocked.diagnostics.some((d) => d.code === ESD_WRITE_BLOCKED_UNKNOWN_STRUCTURE)) {
      throw new Error(`block 用例未按 ${ESD_WRITE_BLOCKED_UNKNOWN_STRUCTURE} 失败关闭：${JSON.stringify(blocked.diagnostics)}`);
    }
    if ((await fileSize(blockedOut)) !== 0) {
      throw new Error('block 用例落盘了输出文件（fail-closed 必须不落盘）');
    }

    // ---- 6. 失败注入：目标/源状态不存在、条件不属于状态、hash 篡改 → FAILED 且不落盘。 ----
    const badCases: Array<{ label: string; hash: string; mutations: EsdMutation[] }> = [
      {
        label: '目标状态不存在',
        hash: srcHash,
        mutations: [{ mutation: 'set-transition-target', stateRelOffset: SYN.state0Rel, conditionRelOffset: SYN.conditionRel, targetStateRelOffset: 0x123456 }]
      },
      {
        label: '源状态不存在',
        hash: srcHash,
        mutations: [{ mutation: 'set-transition-target', stateRelOffset: 0x999, conditionRelOffset: SYN.conditionRel, targetStateRelOffset: SYN.state2Rel }]
      },
      {
        label: '条件不属于状态',
        hash: srcHash,
        mutations: [{ mutation: 'set-transition-target', stateRelOffset: SYN.state0Rel, conditionRelOffset: 0x999, targetStateRelOffset: SYN.state2Rel }]
      },
      {
        label: 'insert目标不存在',
        hash: srcHash,
        mutations: [{ mutation: 'insert-transition', stateRelOffset: SYN.state0Rel, targetStateRelOffset: 0x123456 }]
      },
      {
        label: 'hash篡改',
        hash: '0'.repeat(64),
        mutations: [{ mutation: 'set-transition-target', stateRelOffset: SYN.state0Rel, conditionRelOffset: SYN.conditionRel, targetStateRelOffset: SYN.state2Rel }]
      }
    ];
    for (const bad of badCases) {
      const badOut = join(staging, `bad-${bad.label}.esd`);
      const attempt = await writeEsd(srcPath, [root], [staging], badOut, bad.hash, bad.mutations);
      if (attempt.parseStatus !== 'failed'
        || !attempt.diagnostics.some((d) => d.code === ESD_STAGING_WRITE_FAILED)) {
        throw new Error(`${bad.label} 未按 ${ESD_STAGING_WRITE_FAILED} 失败关闭：${JSON.stringify(attempt.diagnostics)}`);
      }
      if ((await fileSize(badOut)) !== 0) {
        throw new Error(`${bad.label} 落盘了输出文件（fail-closed 必须不落盘）`);
      }
    }
    if (!(await readFile(srcPath)).equals(srcBytes)) {
      throw new Error('失败注入后源文件（before image）被改动');
    }

    // ---- 7. reopen-failure before-image 恢复：输出损坏后 read 结构化失败，源可恢复。 ----
    const corruptedPath = join(staging, 'corrupted.esd');
    await writeFile(corruptedPath, srcBytes.subarray(0, 0x40));
    const reopen = await runBridge<EsdEnvelope>({
      command: ESD_READ_COMMAND,
      filePath: corruptedPath,
      allowedRoots: [staging],
      timeoutMs: 60_000
    });
    if (reopen.parseStatus !== 'failed'
      || !reopen.diagnostics.some((d) => d.code === ESD_DOCUMENT_READ_FAILED)) {
      throw new Error(`reopen failure 未结构化失败：${JSON.stringify(reopen.diagnostics)}`);
    }
    const beforeImage = await readEsd(srcPath, [root]);
    if (beforeImage.sourceHash !== srcHash) {
      throw new Error('reopen failure 后 before image 不可恢复（rollback 前提失败）');
    }

    // ---- 8. 无 .soulforge-esd-*.tmp 残留。 ----
    await assertNoTempResidue(staging);

    // ---- 9. 输出（绝对路径脱敏）。 ----
    const output = JSON.stringify({
      ok: true,
      status: 'synthetic-fixture',
      syntheticFixture: true,
      fixtureRole: 'esd-primary',
      message: 'ESD 状态转移写回/重读/未知保留/entry 表内新增/block/失败注入验证通过',
      authority: 'partial', // 源带 RPN 字节码 unparsedGap；写回后如实保持 partial，不冒充 candidate 以上。
      setTransitionTarget: {
        code: ESD_STAGING_WRITE_VERIFIED,
        rereadVerified: writeA.data.rereadVerified,
        byteSurgical: writeA.data.byteSurgical,
        byteDiffExactlyOneRegion: diffRegions.length === 1,
        changedSpan: `0x${targetFieldAbs.toString(16)}: 0xB0(state1) → 0xF8(state2)`,
        reopenedTargetStateId: edgeA?.targetStateId
      },
      insertTransition: {
        code: ESD_STAGING_WRITE_VERIFIED,
        rereadVerified: writeB.data.rereadVerified,
        newConditionRel: `0x${newConditionRel.toString(16)}`,
        conditionCountAfter: outBDoc.conditionCount,
        edgeCountAfter: outBDoc.transitionGraph?.edgeCount,
        newEdgeTargetStateId: newEdge?.targetStateId,
        oldConditionTargetPreserved: oldEdgeB?.targetStateId === 1,
        conditionOffsetTableRelocated: true,
        tableEntries: tableEntries.map((v) => `0x${v.toString(16)}`)
      },
      unknownPreserved: {
        sourceGapCount: srcGaps.length,
        rereadGapCount: (outADoc.unparsedGaps ?? []).length,
        unparsedGapsPreserved: JSON.stringify(outADoc.unparsedGaps ?? []) === JSON.stringify(srcGaps),
        authorityAfter: outADoc.authority
      },
      blocked: {
        code: ESD_WRITE_BLOCKED_UNKNOWN_STRUCTURE,
        noOutputLanded: (await fileSize(blockedOut)) === 0
      },
      invalidRejected: badCases.length,
      beforeImagePreserved: (await readFile(srcPath)).equals(srcBytes),
      reopenFailure: {
        structuredFailure: true,
        beforeImageRecoverable: beforeImage.sourceHash === srcHash
      },
      noResidue: {
        tempFilesClean: true
      }
    }, null, 2);
    if (output.includes(root)) {
      throw new Error('smoke 输出泄漏了本机绝对路径（脱敏失败）');
    }
    console.log(output);
  });
}

async function corpusLeg(explicitPath: string | undefined): Promise<void> {
  await withSmokeWorkspace('native-esd-writer-corpus', async (workspace) => {
    const root = workspace.root;
    const staging = join(root, 'staging');
    await mkdir(staging, { recursive: true });

    const source = await resolveNativeFixture(
      explicitPath,
      'esd-primary',
      '../../mods/script/talk/m11_02_00_00.talkesdbnd.dcx'
    );

    // 真实 ESD 在 talkesdbnd.dcx 容器内：先提取子项再读（与 read smoke 同路径）。
    let esdPath = source;
    if (source.endsWith('.dcx') || source.endsWith('.bnd')) {
      const gameRoot = process.env.SOULFORGE_SEKIRO_GAME_ROOT ?? process.env.SOULFORGE_NATIVE_FIXTURE_ROOT;
      esdPath = join(staging, 'extracted.esd');
      const extract = await runBridge<ExtractEnvelope>({
        command: 'extract-bnd4-child',
        filePath: source,
        allowedRoots: [source.replace(/[/\\][^/\\]+$/, '')],
        writableRoots: [staging],
        commandOptions: { entryIndex: 0, outputPath: esdPath },
        timeoutMs: 180_000,
        ...(gameRoot ? { oodleRuntimeRoot: gameRoot } : {})
      });
      const verdict = classifyChildExtract(extract);
      if (verdict.kind === 'infrastructure-failure') {
        reportInfrastructureFailure('ESD', 'ESD_FIXTURE_EXTRACT_INFRASTRUCTURE_FAILURE', verdict);
        return;
      }
      if (verdict.kind === 'missing-child') {
        console.log(JSON.stringify({
          ok: true,
          status: 'skipped',
          message: 'ESD fixture not available in container (子项不存在).',
          diagnostics: verdict.codes
        }));
        return;
      }
    }

    // 源先拷进暂存工作区，再在 staging 内读写：daemon 的 writableRoots 必须落在
    // allowedRoots 内，而 registry 源（游戏 mod 目录）与临时 staging 是两个根。
    const srcInStaging = join(staging, 'source.esd');
    await writeFile(srcInStaging, await readFile(esdPath));
    const doc = await readEsd(srcInStaging, [staging]);
    const allowed = new Set(['candidate', 'partial', 'fixture-confirmed']);
    if (doc.authority === undefined || !allowed.has(doc.authority)) {
      throw new Error(`真实语料 authority 应属于 ${[...allowed].join('/')}，实际 ${doc.authority}`);
    }
    // 选一条真实转移边（targetStateRelOffset >= 0），清空转移目标（-1）。
    const sample = (doc.conditionSamples ?? []).find((c) => c.conditionRelOffset !== undefined
      && (c.targetStateRelOffset ?? -1) >= 0);
    if (!sample) {
      console.log(JSON.stringify({
        ok: true,
        status: 'skipped',
        message: '真实 ESD 语料没有可写回的解析转移边样本。',
        authority: doc.authority
      }));
      return;
    }
    const outPath = join(staging, 'out.esd');
    const write = await writeEsd(srcInStaging, [staging], [staging], outPath, doc.sourceHash!, [
      {
        mutation: 'set-transition-target',
        stateRelOffset: sample.sourceStateRelOffset!,
        conditionRelOffset: sample.conditionRelOffset!,
        targetStateRelOffset: -1
      }
    ]);
    if (write.parseStatus === 'failed' || !write.data?.rereadVerified) {
      throw new Error(`真实语料 write 未重读验证：${JSON.stringify(write.diagnostics)}`);
    }
    if (!write.diagnostics.some((d) => d.code === ESD_STAGING_WRITE_VERIFIED)) {
      throw new Error(`真实语料 write 未发 ${ESD_STAGING_WRITE_VERIFIED}：${JSON.stringify(write.diagnostics)}`);
    }
    // 字节级：目标条件记录的 targetStateOffset 应为 -1。
    const outBytes = await readFile(outPath);
    const fieldAbs = 0x6c + sample.conditionRelOffset!;
    if (outBytes.readBigInt64LE(fieldAbs) !== -1n) {
      throw new Error('真实语料写回后条件目标应为 -1');
    }
    const reopened = await readEsd(outPath, [staging]);
    if ((reopened.unparsedGaps ?? []).length !== (doc.unparsedGaps ?? []).length) {
      throw new Error(`真实语料重读 unparsedGaps 数量变化：${JSON.stringify(reopened.unparsedGaps)}`);
    }

    console.log(JSON.stringify({
      ok: true,
      syntheticFixture: false,
      message: `ESD native 写回验证通过（${doc.conditionCount ?? 0} conditions）`,
      target: {
        stateRelOffset: sample.sourceStateRelOffset,
        conditionRelOffset: sample.conditionRelOffset,
        targetCleared: true
      },
      authority: doc.authority,
      unparsedGaps: reopened.unparsedGaps,
      rereadVerified: write.data.rereadVerified,
      sourceFile: source.split(/[\\/]/).pop()
    }, null, 2));
  });
}

async function main(): Promise<void> {
  const explicitPath = process.argv[2]?.trim();
  const registered = await nativeFixtureRoleRegistered('esd-primary');
  if (!explicitPath && !registered) {
    // 缺语料（未登记且未显式给路径）：合成 fixture leg。native leg 在此状态下
    // 诚实 skip——合成语料带 syntheticFixture 标记，不冒充 native authority。
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
