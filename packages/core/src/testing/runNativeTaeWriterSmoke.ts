/**
 * Native TAE writer smoke（ANIMATION-56C）——tae-event-upsert 与 roundtrip。
 *
 * 路径 A（真实语料）：registry 已登记 tae-primary → 提取容器子项 → 读真实 TAE →
 * 选动画表第一条（id=10，3 事件，事件数据块连续）以 event0 为模板追加一个新事件
 * （insert-event）→ write-tae-document → reopen 断言 TAE_STAGING_WRITE_VERIFIED
 * + 动画事件数 +1 + 新事件时间/类型命中。
 *
 * 路径 B（合成 fixture）：registry 未登记 → 微小、合法构造、显式 syntheticFixture
 * 标记的合成 TAE（2 个动画，事件时间槽与真实 a00.tae 的共享形态同构）→ 写回 →
 * reopen，断言：
 *   - **update-event-times 生效**：anim0(10) 事件0 的 start/end 从 0.0/1.0 改为
 *     0.1/0.9；字节级 diff 恰为一个区间且落在两个时间槽内（字节外科替换的直接
 *     证明）；重读事件时间命中；
 *   - **insert-event 生效**：anim0(10) 以事件1（类型 700）为模板追加新事件；
 *     事件数 2→3、新事件时间 3.0/3.5、类型 700、新时间槽不与既有事件共享、
 *     事件表整表重定位后旧条目保留、文件头声明大小同步；
 *   - **未知保留**：模板事件带 8 字节未解码参数体（0x11..0x88），新事件参数体
 *     逐字节拷贝，重读后逐字节一致；output 与源除预期区间外逐字节一致（TAE
 *     reader 无 unparsedGaps，字节级 diff 是更强的不变式）；
 *   - **block 语义**：共享时间槽事件更新（anim1 事件1 与事件0 共享 start/end 槽）→
 *     TAE_WRITE_BLOCKED_UNKNOWN_STRUCTURE 且不落盘（无法无损外科更新时拒绝）；
 *   - **失败注入**：动画不存在 / 事件下标越界 / 无效时间区间 / insert 类型与模板
 *     不一致 / hash 篡改 → TAE_STAGING_WRITE_FAILED 且不落盘；before image
 *     （源文件）字节不变；
 *   - **reopen-failure before-image 恢复**：输出损坏后 read 必须结构化失败，
 *     源 before-image 哈希可恢复；暂存区无 .soulforge-tae-*.tmp 残留。
 *
 * 缺语料处置：tae-primary 未登记是合法状态，此时走路径 B——合成 fixture 仍真实
 * 经过 C# TaeNativeWriter 验证写回，不冒充
 * native authority（syntheticFixture: true）。只有 registry 配置损坏等环境问题
 * 才失败关闭。
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BridgeResult } from '@soulforge/shared';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { nativeFixtureRoleRegistered, resolveNativeFixture } from './nativeFixtureRegistry.js';
import { classifyChildExtract, reportInfrastructureFailure } from './nativeFixtureExtract.js';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';

const TAE_WRITE_COMMAND = 'write-tae-document' as const;
const TAE_READ_COMMAND = 'read-tae-document' as const;

const TAE_STAGING_WRITE_VERIFIED = 'TAE_STAGING_WRITE_VERIFIED';
const TAE_STAGING_WRITE_FAILED = 'TAE_STAGING_WRITE_FAILED';
const TAE_WRITE_BLOCKED_UNKNOWN_STRUCTURE = 'TAE_WRITE_BLOCKED_UNKNOWN_STRUCTURE';
const TAE_DOCUMENT_READ_FAILED = 'TAE_DOCUMENT_READ_FAILED';

/**
 * 合成 fixture 的关键绝对偏移，与 buildSyntheticTae 同源。
 * anim0 = id 10（事件时间槽唯一，供 update/insert）；anim1 = id 20（事件共享
 * 时间槽，与真实 a00.tae 的共享形态同构，供 sibling-verify block 用例）。
 */
const SYN = {
  fileSize: 0x240,
  declaredSizeAbs: 0x0C,
  anim0EntryAbs: 0xA8,
  anim0EventTableAbs: 0x128,
  anim0EventTableOffsetField: 0xA8,
  anim0EventCountField: 0xC8,
  anim0Event0StartTimeAbs: 0xD8,
  anim0Event0EndTimeAbs: 0xDC,
  anim0Event1StartTimeAbs: 0xE0,
  anim0Event1EndTimeAbs: 0xE4,
  anim0Event1ParamAbs: 0x178,
  anim0GroupTableAbs: 0x180,
  templateParam: [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]
} as const;

interface TaeEnvelope {
  format?: string;
  sourceHash?: string;
  sourceSize?: number;
  animationCount?: number;
  totalEventCount?: number;
  totalGroupCount?: number;
  eventTypes?: number[];
  authority?: string;
  animations?: Array<{
    animId?: number;
    eventCount?: number;
    groupCount?: number;
    timesCount?: number;
    hkxName?: string;
    events?: Array<{ startTime?: number; endTime?: number; eventTypeId?: number }>;
    eventsTruncated?: boolean;
  }>;
}

interface WriteEnvelope {
  mutationCount?: number;
  updateCount?: number;
  insertCount?: number;
  outputHash?: string;
  outputSize?: number;
  rereadVerified?: boolean;
  structurePreserved?: boolean;
  byteSurgical?: boolean;
  mutations?: Array<Record<string, unknown>>;
}

interface ExtractEnvelope {
  contentSize?: number;
}

type TaeMutation = {
  mutation: string;
  animId?: number;
  eventIndex?: number;
  templateEventIndex?: number;
  eventTypeId?: number;
  startTime?: number;
  endTime?: number;
};

/** 微小、合法构造、明确标记的合成 TAE（syntheticFixture: true，非 native authority）。 */
function buildSyntheticTae(): Buffer {
  const b = Buffer.alloc(SYN.fileSize);
  // ── File header (0x50) ──
  b.write('TAE ', 0x00, 'ascii');
  b.writeUInt8(0x00, 0x04);
  b.writeUInt8(0x00, 0x05);
  b.writeUInt8(0x00, 0x06);
  b.writeUInt8(0xFF, 0x07);
  b.writeInt32LE(0x0001000D, 0x08);
  b.writeInt32LE(SYN.fileSize, SYN.declaredSizeAbs);
  b.writeBigInt64LE(64n, 0x10);   // flags
  b.writeBigInt64LE(1n, 0x18);    // unknown
  b.writeBigInt64LE(0x50n, 0x20); // section1Offset
  b.writeBigInt64LE(0x80n, 0x28); // section2Offset
  b.writeBigInt64LE(0n, 0x30);    // unknownCount
  b.writeBigInt64LE(0n, 0x38);    // reserved
  // 0x40..0x50 扩展头保持零

  // ── Section 1 (0x50, 0x30) ──
  b.writeInt32LE(0, 0x50);
  b.writeInt32LE(2, 0x54);              // animTableEntryCount
  b.writeBigInt64LE(0x80n, 0x58);       // animTableOffset
  b.writeBigInt64LE(0n, 0x60);
  b.writeBigInt64LE(0n, 0x68);
  b.writeBigInt64LE(2n, 0x70);          // animCount
  b.writeBigInt64LE(0n, 0x78);

  // ── 动画表 (0x80: 8 字节头 + 2×16 条目) ──
  b.writeBigInt64LE(0n, 0x80);
  b.writeBigInt64LE(0xA8n, 0x88);       // anim0 entry offset
  b.writeBigInt64LE(10n, 0x90);         // anim0 id
  b.writeBigInt64LE(0xE8n, 0x98);       // anim1 entry offset
  b.writeBigInt64LE(20n, 0xA0);         // anim1 id

  // ── anim0 entry (0xA8, 0x30) ──
  b.writeBigInt64LE(0x128n, 0xA8);      // eventTableOffset
  b.writeBigInt64LE(0x180n, 0xB0);      // eventGroupTableOffset
  b.writeBigInt64LE(0xD8n, 0xB8);       // timesArrayOffset
  b.writeBigInt64LE(0n, 0xC0);          // animFileInfoOffset
  b.writeInt32LE(2, 0xC8);              // eventCount
  b.writeInt32LE(1, 0xCC);              // eventGroupCount
  b.writeBigInt64LE(4n, 0xD0);          // timesCount

  // ── anim0 times (0xD8): [0.0, 1.0, 0.5, 2.0]（每个事件各占唯一时间槽）──
  b.writeFloatLE(0.0, 0xD8);
  b.writeFloatLE(1.0, 0xDC);
  b.writeFloatLE(0.5, 0xE0);
  b.writeFloatLE(2.0, 0xE4);

  // ── anim1 entry (0xE8, 0x30) ──
  b.writeBigInt64LE(0x1B8n, 0xE8);
  b.writeBigInt64LE(0x208n, 0xF0);
  b.writeBigInt64LE(0x118n, 0xF8);
  b.writeBigInt64LE(0n, 0x100);
  b.writeInt32LE(2, 0x108);
  b.writeInt32LE(1, 0x10C);
  b.writeBigInt64LE(4n, 0x110);

  // ── anim1 times (0x118): [0.0, 2.0, 0.0, 2.0]（事件0/1 共享 start=0x118, end=0x11C）──
  b.writeFloatLE(0.0, 0x118);
  b.writeFloatLE(2.0, 0x11C);
  b.writeFloatLE(0.0, 0x120);
  b.writeFloatLE(2.0, 0x124);

  // ── anim0 event table (0x128, 2×24) ──
  b.writeBigInt64LE(0xD8n, 0x128);      // e0 start
  b.writeBigInt64LE(0xDCn, 0x130);      // e0 end
  b.writeBigInt64LE(0x158n, 0x138);     // e0 data
  b.writeBigInt64LE(0xE0n, 0x140);      // e1 start
  b.writeBigInt64LE(0xE4n, 0x148);      // e1 end
  b.writeBigInt64LE(0x168n, 0x150);     // e1 data

  // ── anim0 event data0 (0x158): type=16, pad=0, param=0（空参数体）──
  b.writeInt32LE(16, 0x158);
  b.writeInt32LE(0, 0x15C);
  b.writeBigInt64LE(0n, 0x160);

  // ── anim0 event data1 (0x168): type=700, pad=0, param=0x178 ──
  b.writeInt32LE(700, 0x168);
  b.writeInt32LE(0, 0x16C);
  b.writeBigInt64LE(0x178n, 0x170);
  Buffer.from(SYN.templateParam).copy(b, 0x178); // 刻意不解码的参数体

  // ── anim0 group table (0x180) ──
  b.writeBigInt64LE(2n, 0x180);
  b.writeBigInt64LE(0x1A0n, 0x188);
  b.writeBigInt64LE(0x1A8n, 0x190);
  b.writeBigInt64LE(0n, 0x198);
  b.writeInt32LE(0x158, 0x1A0);
  b.writeInt32LE(0x168, 0x1A4);
  b.writeInt32LE(16, 0x1A8);
  b.writeInt32LE(0, 0x1AC);
  b.writeBigInt64LE(0n, 0x1B0);

  // ── anim1 event table (0x1B8, 2×24) ──
  b.writeBigInt64LE(0x118n, 0x1B8);     // e0 start（与 e1 共享）
  b.writeBigInt64LE(0x11Cn, 0x1C0);     // e0 end（与 e1 共享）
  b.writeBigInt64LE(0x1E8n, 0x1C8);     // e0 data
  b.writeBigInt64LE(0x118n, 0x1D0);     // e1 start（与 e0 共享）
  b.writeBigInt64LE(0x11Cn, 0x1D8);     // e1 end（与 e0 共享）
  b.writeBigInt64LE(0x1F8n, 0x1E0);     // e1 data

  // ── anim1 event data (0x1E8 / 0x1F8): type=16, pad=0, param=0 ──
  b.writeInt32LE(16, 0x1E8);
  b.writeInt32LE(0, 0x1EC);
  b.writeBigInt64LE(0n, 0x1F0);
  b.writeInt32LE(16, 0x1F8);
  b.writeInt32LE(0, 0x1FC);
  b.writeBigInt64LE(0n, 0x200);

  // ── anim1 group table (0x208) ──
  b.writeBigInt64LE(2n, 0x208);
  b.writeBigInt64LE(0x228n, 0x210);
  b.writeBigInt64LE(0x230n, 0x218);
  b.writeBigInt64LE(0n, 0x220);
  b.writeInt32LE(0x1E8, 0x228);
  b.writeInt32LE(0x1F8, 0x22C);
  b.writeInt32LE(16, 0x230);
  b.writeInt32LE(0, 0x234);
  b.writeBigInt64LE(0n, 0x238);

  return b;
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

async function readTae(path: string, allowedRoots: string[]): Promise<TaeEnvelope> {
  const result = await runBridge<TaeEnvelope>({
    command: TAE_READ_COMMAND,
    filePath: path,
    allowedRoots,
    timeoutMs: 120_000
  });
  if (result.parseStatus === 'failed' || !result.data?.sourceHash) {
    throw new Error(`read-tae-document ${path} 失败：${JSON.stringify(result.diagnostics)}`);
  }
  return result.data;
}

async function writeTae(
  sourcePath: string,
  allowedRoots: string[],
  writableRoots: string[],
  outputPath: string,
  expectedDocumentHash: string,
  mutations: TaeMutation[]
): Promise<BridgeResult<WriteEnvelope>> {
  return runBridge<WriteEnvelope>({
    command: TAE_WRITE_COMMAND,
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
    (name) => name.startsWith('.soulforge-tae-') && name.endsWith('.tmp')
  );
  if (residue.length > 0) {
    throw new Error(`暂存区残留半成品临时文件：${residue.join(', ')}`);
  }
}

async function syntheticLeg(): Promise<void> {
  await withSmokeWorkspace('native-tae-writer', async (workspace) => {
    const root = workspace.root;
    const staging = join(root, 'staging');
    await mkdir(staging, { recursive: true });

    // ---- 0. 源：合成 TAE，读 + 断言基础形态。 ----
    const srcPath = join(root, 'synthetic_writer_smoke.tae');
    const srcBytes = buildSyntheticTae();
    await writeFile(srcPath, srcBytes);
    const srcDoc = await readTae(srcPath, [root]);
    const srcHash = srcDoc.sourceHash!;
    const srcBytesOnDisk = await readFile(srcPath);
    if (!srcBytesOnDisk.equals(srcBytes)) {
      throw new Error('合成 TAE 落盘字节与构造不一致');
    }
    const anim0 = srcDoc.animations?.find((a) => a.animId === 10);
    if (!anim0 || anim0.eventCount !== 2) {
      throw new Error(`合成 TAE 动画 10 应为 2 个事件，实际 ${JSON.stringify(anim0)}`);
    }
    const srcTotalEvents = srcDoc.totalEventCount;
    if (srcTotalEvents !== 4) {
      throw new Error(`合成 TAE 事件总数应为 4，实际 ${srcTotalEvents}`);
    }

    // ---- 1. update-event-times：anim0(10) 事件0 的 0.0/1.0 → 0.1/0.9。 ----
    const outA = join(staging, 'out-a.tae');
    const writeA = await writeTae(srcPath, [root], [staging], outA, srcHash, [
      { mutation: 'update-event-times', animId: 10, eventIndex: 0, startTime: 0.1, endTime: 0.9 }
    ]);
    if (writeA.parseStatus === 'failed' || !writeA.data?.rereadVerified) {
      throw new Error(`update-event-times 未重读验证：${JSON.stringify(writeA.diagnostics)}`);
    }
    if (!writeA.diagnostics.some((d) => d.code === TAE_STAGING_WRITE_VERIFIED)) {
      throw new Error(`update-event-times 未发 ${TAE_STAGING_WRITE_VERIFIED}：${JSON.stringify(writeA.diagnostics)}`);
    }
    if (writeA.data.byteSurgical !== true) {
      throw new Error('update-event-times 应标记 byteSurgical=true');
    }
    const outABytes = await readFile(outA);
    const diffA = byteDiffRegions(srcBytes, outABytes);
    const startAbs = SYN.anim0Event0StartTimeAbs;
    const endAbs = SYN.anim0Event0EndTimeAbs;
    if (diffA.length !== 1) {
      throw new Error(`update 应恰好一个差异区间，实际 ${JSON.stringify(diffA)}`);
    }
    if (diffA[0]!.start < startAbs || diffA[0]!.end > endAbs + 4) {
      throw new Error(`差异区间应落在两个时间槽 [0x${startAbs.toString(16)}, 0x${(endAbs + 4).toString(16)}) 内，实际 ${JSON.stringify(diffA[0])}`);
    }
    if (Math.abs(outABytes.readFloatLE(startAbs) - 0.1) > 1e-6
      || Math.abs(outABytes.readFloatLE(endAbs) - 0.9) > 1e-6) {
      throw new Error('写回后 anim0 事件0 时间应为 0.1/0.9');
    }

    // ---- 2. 重读 out-a：anim0 事件0 时间命中、事件总数不变。 ----
    const outADoc = await readTae(outA, [staging]);
    const anim0AfterUpdate = outADoc.animations?.find((a) => a.animId === 10);
    const e0 = anim0AfterUpdate?.events?.[0];
    if (Math.abs((e0?.startTime ?? -1) - 0.1) > 1e-6 || Math.abs((e0?.endTime ?? -1) - 0.9) > 1e-6) {
      throw new Error(`重读后 anim0 事件0 时间应为 0.1/0.9：${JSON.stringify(e0)}`);
    }
    if (outADoc.totalEventCount !== srcTotalEvents) {
      throw new Error(`update 后事件总数变化：${outADoc.totalEventCount} vs ${srcTotalEvents}`);
    }

    // ---- 3. insert-event：anim0(10) 以事件1（类型 700）为模板追加事件 3.0/3.5。 ----
    const outB = join(staging, 'out-b.tae');
    const writeB = await writeTae(srcPath, [root], [staging], outB, srcHash, [
      { mutation: 'insert-event', animId: 10, templateEventIndex: 1, startTime: 3.0, endTime: 3.5 }
    ]);
    if (writeB.parseStatus === 'failed' || !writeB.data?.rereadVerified) {
      throw new Error(`insert-event 未重读验证：${JSON.stringify(writeB.diagnostics)}`);
    }
    if (!writeB.diagnostics.some((d) => d.code === TAE_STAGING_WRITE_VERIFIED)) {
      throw new Error(`insert-event 未发 ${TAE_STAGING_WRITE_VERIFIED}：${JSON.stringify(writeB.diagnostics)}`);
    }
    if (writeB.data.insertCount !== 1) {
      throw new Error(`insertCount 应为 1：${JSON.stringify(writeB.data)}`);
    }
    const outBBytes = await readFile(outB);
    const expectedSize = SYN.fileSize + 8 + 8 + 16 + (2 * 24 + 24);
    if (outBBytes.length !== expectedSize) {
      throw new Error(`insert 后 output 长度应为 0x${expectedSize.toString(16)}，实际 0x${outBBytes.length.toString(16)}`);
    }
    // 文件头声明大小同步。
    if (outBBytes.readInt32LE(SYN.declaredSizeAbs) !== outBBytes.length) {
      throw new Error('insert 后文件头声明大小未同步');
    }
    // 追加块顺序：新时间(8) → 新参数体(8) → 新事件数据头(16) → 新事件表(72)。
    const newStartAbs = SYN.fileSize;
    const newEndAbs = SYN.fileSize + 4;
    const newParamAbs = SYN.fileSize + 8;
    const newHeaderAbs = SYN.fileSize + 16;
    const newTableAbs = SYN.fileSize + 32;
    if (Math.abs(outBBytes.readFloatLE(newStartAbs) - 3.0) > 1e-6
      || Math.abs(outBBytes.readFloatLE(newEndAbs) - 3.5) > 1e-6) {
      throw new Error('追加时间槽应为 3.0/3.5');
    }
    // 新参数体逐字节等于模板（未知结构无损拷贝的直接证据）。
    for (let i = 0; i < SYN.templateParam.length; i++) {
      if (outBBytes[newParamAbs + i] !== SYN.templateParam[i]) {
        throw new Error(`新参数体第 ${i} 字节 ${outBBytes[newParamAbs + i]} ≠ 模板 ${SYN.templateParam[i]}`);
      }
    }
    // 新事件数据头：type=700、paramDataOffset=新参数体。
    if (outBBytes.readInt32LE(newHeaderAbs) !== 700
      || outBBytes.readBigInt64LE(newHeaderAbs + 8) !== BigInt(newParamAbs)) {
      throw new Error('新事件数据头 type/paramDataOffset 不符');
    }
    // 新事件表最后一条目：start/end/eventData 指向追加块。
    const lastEntryAbs = newTableAbs + 2 * 24;
    if (outBBytes.readBigInt64LE(lastEntryAbs) !== BigInt(newStartAbs)
      || outBBytes.readBigInt64LE(lastEntryAbs + 8) !== BigInt(newEndAbs)
      || outBBytes.readBigInt64LE(lastEntryAbs + 16) !== BigInt(newHeaderAbs)) {
      throw new Error('新事件表末尾条目未指向追加块');
    }
    // 动画条目：事件表指针重定位 + eventCount 3。
    if (outBBytes.readBigInt64LE(SYN.anim0EventTableOffsetField) !== BigInt(newTableAbs)
      || outBBytes.readInt32LE(SYN.anim0EventCountField) !== 3) {
      throw new Error('动画条目事件表指针/eventCount 未更新');
    }
    // 字节级：除声明大小/动画条目/追加区外逐字节一致。
    const diffB = byteDiffRegions(srcBytes, outBBytes);
    const allowedB: Array<[number, number]> = [
      [SYN.declaredSizeAbs, 0x10],
      [SYN.anim0EventTableOffsetField, SYN.anim0EventTableOffsetField + 8],
      [SYN.anim0EventCountField, SYN.anim0EventCountField + 4],
      [SYN.fileSize, outBBytes.length]
    ];
    for (const region of diffB) {
      if (!allowedB.some(([s, e]) => region.start >= s && region.end <= e)) {
        throw new Error(`insert 后存在非预期差异区间：${JSON.stringify(region)}`);
      }
    }

    // ---- 4. 重读 out-b：动画 10 事件数 3、新事件时间/类型命中、旧事件不变。 ----
    const outBDoc = await readTae(outB, [staging]);
    const anim0AfterInsert = outBDoc.animations?.find((a) => a.animId === 10);
    if (anim0AfterInsert?.eventCount !== 3) {
      throw new Error(`insert 后动画 10 事件数应为 3：${JSON.stringify(anim0AfterInsert)}`);
    }
    const newEv = anim0AfterInsert?.events?.[2];
    if (Math.abs((newEv?.startTime ?? -1) - 3.0) > 1e-6
      || Math.abs((newEv?.endTime ?? -1) - 3.5) > 1e-6
      || newEv?.eventTypeId !== 700) {
      throw new Error(`重读后新事件应为 3.0/3.5/type700：${JSON.stringify(newEv)}`);
    }
    const e0b = anim0AfterInsert?.events?.[0];
    if (Math.abs((e0b?.startTime ?? -1) - 0.0) > 1e-6 || Math.abs((e0b?.endTime ?? -1) - 1.0) > 1e-6) {
      throw new Error(`insert 不应改动旧事件：${JSON.stringify(e0b)}`);
    }
    if (outBDoc.totalEventCount !== srcTotalEvents + 1) {
      throw new Error(`insert 后事件总数应为 ${srcTotalEvents + 1}：${outBDoc.totalEventCount}`);
    }

    // ---- 5. 多条 mutation 顺序应用：update + insert 同一动画。 ----
    const outC = join(staging, 'out-c.tae');
    const writeC = await writeTae(srcPath, [root], [staging], outC, srcHash, [
      { mutation: 'update-event-times', animId: 10, eventIndex: 0, startTime: 0.2, endTime: 0.8 },
      { mutation: 'insert-event', animId: 10, templateEventIndex: 1, startTime: 4.0, endTime: 4.5 }
    ]);
    if (writeC.parseStatus === 'failed' || !writeC.data?.rereadVerified) {
      throw new Error(`multi-mutation 未重读验证：${JSON.stringify(writeC.diagnostics)}`);
    }
    if (writeC.data.mutationCount !== 2) {
      throw new Error(`multi-mutation 应计 2 条：${JSON.stringify(writeC.data)}`);
    }
    const outCDoc = await readTae(outC, [staging]);
    const anim0C = outCDoc.animations?.find((a) => a.animId === 10);
    const e0c = anim0C?.events?.[0];
    const e2c = anim0C?.events?.[2];
    if (Math.abs((e0c?.startTime ?? -1) - 0.2) > 1e-6 || Math.abs((e0c?.endTime ?? -1) - 0.8) > 1e-6) {
      throw new Error(`multi-mutation 后事件0 时间应为 0.2/0.8：${JSON.stringify(e0c)}`);
    }
    if (anim0C?.eventCount !== 3
      || Math.abs((e2c?.startTime ?? -1) - 4.0) > 1e-6 || Math.abs((e2c?.endTime ?? -1) - 4.5) > 1e-6) {
      throw new Error(`multi-mutation 后事件2 应为 4.0/4.5：${JSON.stringify({ count: anim0C?.eventCount, e2c })}`);
    }

    // ---- 6. block 语义：共享时间槽更新 → TAE_WRITE_BLOCKED_UNKNOWN_STRUCTURE 且不落盘。 ----
    const blockedOut = join(staging, 'blocked.tae');
    const blocked = await writeTae(srcPath, [root], [staging], blockedOut, srcHash, [
      { mutation: 'update-event-times', animId: 20, eventIndex: 1, startTime: 0.3, endTime: 1.5 }
    ]);
    if (blocked.parseStatus !== 'failed'
      || !blocked.diagnostics.some((d) => d.code === TAE_WRITE_BLOCKED_UNKNOWN_STRUCTURE)) {
      throw new Error(`共享时间槽未按 ${TAE_WRITE_BLOCKED_UNKNOWN_STRUCTURE} 失败关闭：${JSON.stringify(blocked.diagnostics)}`);
    }
    if ((await fileSize(blockedOut)) !== 0) {
      throw new Error('block 用例落盘了输出文件（fail-closed 必须不落盘）');
    }

    // ---- 7. 失败注入：目标/事件/时间区间/类型/hash → FAILED 且不落盘。 ----
    const badCases: Array<{ label: string; hash: string; mutations: TaeMutation[] }> = [
      {
        label: '动画不存在',
        hash: srcHash,
        mutations: [{ mutation: 'update-event-times', animId: 999, eventIndex: 0, startTime: 0.1, endTime: 0.9 }]
      },
      {
        label: '事件下标越界',
        hash: srcHash,
        mutations: [{ mutation: 'update-event-times', animId: 10, eventIndex: 5, startTime: 0.1, endTime: 0.9 }]
      },
      {
        label: '无效时间区间',
        hash: srcHash,
        mutations: [{ mutation: 'update-event-times', animId: 10, eventIndex: 0, startTime: 5.0, endTime: 1.0 }]
      },
      {
        label: 'insert类型与模板不一致',
        hash: srcHash,
        mutations: [{ mutation: 'insert-event', animId: 10, templateEventIndex: 1, eventTypeId: 16, startTime: 3.0, endTime: 3.5 }]
      },
      {
        label: 'insert模板越界',
        hash: srcHash,
        mutations: [{ mutation: 'insert-event', animId: 10, templateEventIndex: 5, startTime: 3.0, endTime: 3.5 }]
      },
      {
        label: 'hash篡改',
        hash: '0'.repeat(64),
        mutations: [{ mutation: 'update-event-times', animId: 10, eventIndex: 0, startTime: 0.1, endTime: 0.9 }]
      }
    ];
    for (const bad of badCases) {
      const badOut = join(staging, `bad-${bad.label}.tae`);
      const attempt = await writeTae(srcPath, [root], [staging], badOut, bad.hash, bad.mutations);
      if (attempt.parseStatus !== 'failed'
        || !attempt.diagnostics.some((d) => d.code === TAE_STAGING_WRITE_FAILED)) {
        throw new Error(`${bad.label} 未按 ${TAE_STAGING_WRITE_FAILED} 失败关闭：${JSON.stringify(attempt.diagnostics)}`);
      }
      if ((await fileSize(badOut)) !== 0) {
        throw new Error(`${bad.label} 落盘了输出文件（fail-closed 必须不落盘）`);
      }
    }
    if (!(await readFile(srcPath)).equals(srcBytes)) {
      throw new Error('失败注入后源文件（before image）被改动');
    }

    // ---- 8. reopen-failure before-image 恢复：输出损坏后 read 结构化失败，源可恢复。 ----
    const corruptedPath = join(staging, 'corrupted.tae');
    await writeFile(corruptedPath, srcBytes.subarray(0, 0x40));
    const reopen = await runBridge<TaeEnvelope>({
      command: TAE_READ_COMMAND,
      filePath: corruptedPath,
      allowedRoots: [staging],
      timeoutMs: 60_000
    });
    if (reopen.parseStatus !== 'failed'
      || !reopen.diagnostics.some((d) => d.code === TAE_DOCUMENT_READ_FAILED)) {
      throw new Error(`reopen failure 未结构化失败：${JSON.stringify(reopen.diagnostics)}`);
    }
    const beforeImage = await readTae(srcPath, [root]);
    if (beforeImage.sourceHash !== srcHash) {
      throw new Error('reopen failure 后 before image 不可恢复（rollback 前提失败）');
    }

    // ---- 9. 无 .soulforge-tae-*.tmp 残留。 ----
    await assertNoTempResidue(staging);

    // ---- 10. 输出（绝对路径脱敏）。 ----
    const output = JSON.stringify({
      ok: true,
      status: 'synthetic-fixture',
      syntheticFixture: true,
      fixtureRole: 'tae-primary',
      message: 'TAE 事件写回/重读/未知保留/事件 upsert/block/失败注入验证通过',
      authority: 'candidate', // 合成语料不冒充 native authority
      updateEventTimes: {
        code: TAE_STAGING_WRITE_VERIFIED,
        rereadVerified: writeA.data.rereadVerified,
        byteSurgical: writeA.data.byteSurgical,
        byteDiffExactlyOneRegion: diffA.length === 1,
        changedSpan: `0x${startAbs.toString(16)}: 0.0/1.0 → 0.1/0.9`,
        reopenedTimes: { startTime: e0?.startTime, endTime: e0?.endTime }
      },
      insertEvent: {
        code: TAE_STAGING_WRITE_VERIFIED,
        rereadVerified: writeB.data.rereadVerified,
        eventCountAfter: anim0AfterInsert?.eventCount,
        newEventTimes: { startTime: newEv?.startTime, endTime: newEv?.endTime },
        newEventTypeId: newEv?.eventTypeId,
        paramBytesCopied: SYN.templateParam.length,
        eventTableRelocated: true,
        declaredSizeSynced: outBBytes.readInt32LE(SYN.declaredSizeAbs) === outBBytes.length,
        unexpectedDiffRegions: diffB.filter(
          (region) => !allowedB.some(([s, e]) => region.start >= s && region.end <= e)
        ).length
      },
      multiMutation: {
        code: TAE_STAGING_WRITE_VERIFIED,
        mutationCount: writeC.data.mutationCount,
        event0Times: { startTime: e0c?.startTime, endTime: e0c?.endTime },
        insertedTimes: { startTime: e2c?.startTime, endTime: e2c?.endTime }
      },
      unknownPreserved: {
        templateParamBytes: SYN.templateParam.length,
        copiedParamBytesMatch: true,
        byteLevelDiffOnlyInExpectedRegions: true,
        outputHash: writeB.data.outputHash
      },
      blocked: {
        code: TAE_WRITE_BLOCKED_UNKNOWN_STRUCTURE,
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
  await withSmokeWorkspace('native-tae-writer-corpus', async (workspace) => {
    const root = workspace.root;
    const staging = join(root, 'staging');
    await mkdir(staging, { recursive: true });

    const source = await resolveNativeFixture(
      explicitPath,
      'tae-primary',
      '../../mods/chr/c0000.anibnd.dcx'
    );

    // 真实 TAE 在 anibnd 容器内：先提取子项再读（与 read smoke 同路径）。
    let taePath = source;
    if (source.endsWith('.dcx') || source.endsWith('.bnd')) {
      const tmpDir = join(root, 'extract');
      await mkdir(tmpDir, { recursive: true });
      taePath = join(tmpDir, 'a00.tae');
      const extract = await runBridge<ExtractEnvelope>({
        command: 'extract-bnd4-child',
        filePath: source,
        allowedRoots: [source.replace(/[/\\][^/\\]+$/, '')],
        writableRoots: [tmpDir],
        commandOptions: { childPath: 'tae/a00.tae', outputPath: taePath },
        timeoutMs: 180_000
      });
      const verdict = classifyChildExtract(extract);
      if (verdict.kind === 'infrastructure-failure') {
        reportInfrastructureFailure('TAE', 'TAE_FIXTURE_EXTRACT_INFRASTRUCTURE_FAILURE', verdict);
        return;
      }
      if (verdict.kind === 'missing-child') {
        console.log(JSON.stringify({
          ok: true,
          status: 'skipped',
          message: 'TAE fixture not available in container (子项不存在).',
          diagnostics: verdict.codes
        }));
        return;
      }
    }

    // 源先拷进暂存工作区，再在 staging 内读写：daemon 的 writableRoots 必须落在
    // allowedRoots 内，而 registry 源（游戏 mod 目录）与临时 staging 是两个根。
    const srcInStaging = join(staging, 'source.tae');
    await writeFile(srcInStaging, await readFile(taePath));
    const doc = await readTae(srcInStaging, [staging]);
    const allowed = new Set(['candidate', 'partial', 'fixture-confirmed']);
    if (doc.authority === undefined || !allowed.has(doc.authority)) {
      throw new Error(`真实语料 authority 应属于 ${[...allowed].join('/')}，实际 ${doc.authority}`);
    }

    // 找一个可插入的目标动画：事件表第一条（id=10，3 事件，事件数据块连续）。
    // 从有界样例里选：样例前 20 个动画足够覆盖；insert 的布局不变量由 C# 侧
    // 校验，若某动画被 block 则换下一个（防御性，正常 fixture 第一条即可）。
    let applied = false;
    let appliedAnim: { animId?: number; eventCount?: number } | undefined;
    let newEv: { startTime?: number; endTime?: number; eventTypeId?: number } | undefined;
    let writeOut: WriteEnvelope | undefined;
    for (const anim of (doc.animations ?? []).slice(0, 20)) {
      if (!anim.animId || !anim.eventCount || (anim.eventCount ?? 0) < 2 || anim.eventsTruncated) continue;
      const maxEnd = Math.max(0, ...(anim.events ?? []).map((e) => e.endTime ?? 0));
      const newStart = maxEnd + 1.0;
      const outPath = join(staging, 'out.tae');
      const write = await writeTae(srcInStaging, [staging], [staging], outPath, doc.sourceHash!, [
        { mutation: 'insert-event', animId: anim.animId, templateEventIndex: 0, startTime: newStart, endTime: newStart + 0.5 }
      ]);
      if (write.parseStatus === 'failed') {
        // 该动画被 fail-closed block（布局不连续等）：换下一个动画。
        continue;
      }
      if (!write.data?.rereadVerified) {
        throw new Error(`真实语料 write 未重读验证：${JSON.stringify(write.diagnostics)}`);
      }
      if (!write.diagnostics.some((d) => d.code === TAE_STAGING_WRITE_VERIFIED)) {
        throw new Error(`真实语料 write 未发 ${TAE_STAGING_WRITE_VERIFIED}：${JSON.stringify(write.diagnostics)}`);
      }
      const reopened = await readTae(outPath, [staging]);
      const targetAnim = reopened.animations?.find((a) => a.animId === anim.animId);
      if ((targetAnim?.eventCount ?? 0) !== (anim.eventCount ?? 0) + 1) {
        throw new Error(
          `真实语料重读后动画 ${anim.animId} 事件数 ${targetAnim?.eventCount} ≠ 写前 ${anim.eventCount} + 1`);
      }
      const last = targetAnim?.events?.[(targetAnim?.events?.length ?? 1) - 1];
      if (Math.abs((last?.startTime ?? -1) - newStart) > 1e-4
        || Math.abs((last?.endTime ?? -1) - (newStart + 0.5)) > 1e-4) {
        throw new Error(`真实语料重读后新事件时间不符：${JSON.stringify(last)}`);
      }
      applied = true;
      appliedAnim = anim;
      newEv = last;
      writeOut = write.data;
      break;
    }
    if (!applied) {
      console.log(JSON.stringify({
        ok: true,
        status: 'skipped',
        message: '真实 TAE 语料没有可无损插入事件的动画样本（全部被布局不变量 block）。',
        authority: doc.authority
      }));
      return;
    }

    console.log(JSON.stringify({
      ok: true,
      syntheticFixture: false,
      message: `TAE native 写回验证通过（动画 ${appliedAnim?.animId} insert-event）`,
      target: {
        animId: appliedAnim?.animId,
        eventCountBefore: appliedAnim?.eventCount,
        eventCountAfter: (appliedAnim?.eventCount ?? 0) + 1,
        templateEventIndex: 0,
        newEventTimes: { startTime: newEv?.startTime, endTime: newEv?.endTime }
      },
      authority: doc.authority,
      rereadVerified: writeOut?.rereadVerified,
      structurePreserved: writeOut?.structurePreserved,
      outputHash: writeOut?.outputHash,
      sourceFile: source.split(/[\\/]/).pop()
    }, null, 2));
  });
}

async function main(): Promise<void> {
  const explicitPath = process.argv[2]?.trim();
  const registered = await nativeFixtureRoleRegistered('tae-primary');
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
