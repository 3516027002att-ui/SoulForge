/**
 * SF-11 Smoke Test Suite
 * 验证 TAE 最终事件状态、完整时间表 COW、未知布局守卫与无快照克隆写入。
 *
 * 命令行用法：
 *   node dist/testing/runAuditSf11Smoke.js --layer unit
 *   node dist/testing/runAuditSf11Smoke.js --layer native
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BridgeResult } from '@soulforge/shared';
import {
  validateTaeEventHandle,
  taeEventHandleKey,
  type TaeEventHandle
} from '@soulforge/shared';
import { runBridge } from '../bridge/runBridge.js';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';
import { classifyChildExtract, reportInfrastructureFailure } from './nativeFixtureExtract.js';

const TAE_WRITE_COMMAND = 'write-tae-document' as const;
const TAE_READ_COMMAND = 'read-tae-document' as const;

const TAE_STAGING_WRITE_VERIFIED = 'TAE_STAGING_WRITE_VERIFIED';
const TAE_STAGING_WRITE_FAILED = 'TAE_STAGING_WRITE_FAILED';
const TAE_WRITE_BLOCKED_UNKNOWN_STRUCTURE = 'TAE_WRITE_BLOCKED_UNKNOWN_STRUCTURE';

interface TaeEnvelope {
  format?: string;
  sourceHash?: string;
  sourceSize?: number;
  animationCount?: number;
  totalEventCount?: number;
  animations?: Array<{
    animId?: number;
    eventCount?: number;
    events?: Array<{ startTime?: number; endTime?: number; eventTypeId?: number; parameterDataOffset?: number }>;
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

type TaeMutation = {
  mutation: string;
  animId?: number;
  eventIndex?: number;
  templateEventIndex?: number;
  eventTypeId?: number;
  startTime?: number;
  endTime?: number;
};

const SYN = {
  fileSize: 0x240,
  declaredSizeAbs: 0x0C,
  anim0EntryAbs: 0xA8,
  anim0EventTableAbs: 0x128,
  anim0Event0StartTimeAbs: 0xD8,
  anim0Event0EndTimeAbs: 0xDC,
  anim0Event1StartTimeAbs: 0xE0,
  anim0Event1EndTimeAbs: 0xE4,
  anim0Event1ParamAbs: 0x178,
  anim1EntryAbs: 0xE8,
  anim1EventTableAbs: 0x1B8,
  templateParam: [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]
} as const;

function buildStandardSyntheticTae(): Buffer {
  const b = Buffer.alloc(SYN.fileSize);
  // Header
  b.write('TAE ', 0x00, 'ascii');
  b.writeUInt8(0x00, 0x04);
  b.writeUInt8(0x00, 0x05);
  b.writeUInt8(0x00, 0x06);
  b.writeUInt8(0xFF, 0x07);
  b.writeInt32LE(0x0001000D, 0x08);
  b.writeInt32LE(SYN.fileSize, SYN.declaredSizeAbs);
  b.writeBigInt64LE(64n, 0x10);
  b.writeBigInt64LE(1n, 0x18);
  b.writeBigInt64LE(0x50n, 0x20); // section1Offset
  b.writeBigInt64LE(0x80n, 0x28); // section2Offset

  // Section 1
  b.writeInt32LE(0, 0x50);
  b.writeInt32LE(2, 0x54);
  b.writeBigInt64LE(0x80n, 0x58);
  b.writeBigInt64LE(0n, 0x60);
  b.writeBigInt64LE(0n, 0x68);
  b.writeBigInt64LE(2n, 0x70);
  b.writeBigInt64LE(0n, 0x78);

  // Animation Table (0x80)
  b.writeBigInt64LE(10n, 0x80); // anim0 id
  b.writeBigInt64LE(0xA8n, 0x88); // anim0 entry
  b.writeBigInt64LE(20n, 0x90);   // anim1 id
  b.writeBigInt64LE(0xE8n, 0x98); // anim1 entry

  // anim0 Entry (0xA8)
  b.writeBigInt64LE(0x128n, 0xA8); // eventTableOffset
  b.writeBigInt64LE(0x180n, 0xB0); // eventGroupTableOffset
  b.writeBigInt64LE(0xD8n, 0xB8);  // timesArrayOffset
  b.writeInt32LE(2, 0xC8);         // eventCount
  b.writeInt32LE(1, 0xCC);         // eventGroupCount
  b.writeBigInt64LE(4n, 0xD0);

  // anim0 Times (0xD8): [0.0, 1.0, 0.5, 2.0]
  b.writeFloatLE(0.0, 0xD8);
  b.writeFloatLE(1.0, 0xDC);
  b.writeFloatLE(0.5, 0xE0);
  b.writeFloatLE(2.0, 0xE4);

  // anim1 Entry (0xE8)
  b.writeBigInt64LE(0x1B8n, 0xE8);
  b.writeBigInt64LE(0x208n, 0xF0);
  b.writeBigInt64LE(0x118n, 0xF8);
  b.writeInt32LE(2, 0x108);
  b.writeInt32LE(1, 0x10C);
  b.writeBigInt64LE(4n, 0x110);

  // anim1 Times (0x118): [0.0, 2.0] (event0 and event1 share slots 0x118 & 0x11C)
  b.writeFloatLE(0.0, 0x118);
  b.writeFloatLE(2.0, 0x11C);
  b.writeFloatLE(0.0, 0x120);
  b.writeFloatLE(2.0, 0x124);

  // anim0 Event Table (0x128)
  b.writeBigInt64LE(0xD8n, 0x128);
  b.writeBigInt64LE(0xDCn, 0x130);
  b.writeBigInt64LE(0x158n, 0x138);
  b.writeBigInt64LE(0xE0n, 0x140);
  b.writeBigInt64LE(0xE4n, 0x148);
  b.writeBigInt64LE(0x168n, 0x150);

  // anim0 Event 0 Data (0x158): type=16
  b.writeInt32LE(16, 0x158);
  b.writeInt32LE(0, 0x15C);
  b.writeBigInt64LE(0n, 0x160);

  // anim0 Event 1 Data (0x168): type=700, param=0x178
  b.writeInt32LE(700, 0x168);
  b.writeInt32LE(0, 0x16C);
  b.writeBigInt64LE(0x178n, 0x170);
  Buffer.from(SYN.templateParam).copy(b, 0x178);

  // anim0 Group Table (0x180)
  b.writeBigInt64LE(2n, 0x180);
  b.writeBigInt64LE(0x1A0n, 0x188);
  b.writeBigInt64LE(0x1A8n, 0x190);
  b.writeInt32LE(0x128, 0x1A0); // group members reference event headers, not event data
  b.writeInt32LE(0x140, 0x1A4);
  b.writeInt32LE(16, 0x1A8);
  b.writeInt32LE(0, 0x1AC);

  // anim1 Event Table (0x1B8): e0 and e1 share 0x118/0x11C
  b.writeBigInt64LE(0x118n, 0x1B8);
  b.writeBigInt64LE(0x11Cn, 0x1C0);
  b.writeBigInt64LE(0x1E8n, 0x1C8);
  b.writeBigInt64LE(0x118n, 0x1D0);
  b.writeBigInt64LE(0x11Cn, 0x1D8);
  b.writeBigInt64LE(0x1F8n, 0x1E0);

  // anim1 Event Data
  b.writeInt32LE(16, 0x1E8);
  b.writeInt32LE(0, 0x1EC);
  b.writeBigInt64LE(0n, 0x1F0);
  b.writeInt32LE(16, 0x1F8);
  b.writeInt32LE(0, 0x1FC);
  b.writeBigInt64LE(0n, 0x200);

  // anim1 Group Table (0x208)
  b.writeBigInt64LE(2n, 0x208);
  b.writeBigInt64LE(0x228n, 0x210);
  b.writeBigInt64LE(0x230n, 0x218);
  b.writeInt32LE(0x1B8, 0x228);
  b.writeInt32LE(0x1D0, 0x22C);
  b.writeInt32LE(16, 0x230);
  b.writeInt32LE(0, 0x234);

  return b;
}

/** 构造带跨动画共享槽与单事件点事件的专用合成 TAE */
function buildCrossSharedAndPointSyntheticTae(): Buffer {
  const b = buildStandardSyntheticTae();
  // 1. 点事件：将 anim0 事件 0 的 end 槽偏移也改成 0xD8 (与 start 共享 0xD8，形成点事件)
  b.writeBigInt64LE(0xD8n, 0x130);

  // 2. 跨动画共享槽：将 anim1 事件 0 的 start 槽改成 0xE0 (借用 anim0 事件 1 的 start 槽)
  b.writeBigInt64LE(0xE0n, 0x1B8);
  return b;
}

// This oracle is an explicitly specified byte layout, not offsets/values
// obtained from read-tae-document, the writer receipt or its output pointers.
function expectSyntheticTimeCow(
  source: Buffer, output: Buffer, entry: number, table: number,
  times: readonly number[], eventSlots: readonly [number, number, number, number]
): void {
  const expected = Buffer.concat([source, Buffer.alloc(times.length * 4)]);
  expected.writeInt32LE(expected.length, SYN.declaredSizeAbs);
  expected.writeBigInt64LE(BigInt(SYN.fileSize), entry + 0x10);
  expected.writeInt32LE(times.length, entry + 0x28);
  times.forEach((time, index) => expected.writeFloatLE(time, SYN.fileSize + index * 4));
  for (const [index, offset] of [0, 8, 24, 32].entries()) {
    expected.writeBigInt64LE(BigInt(SYN.fileSize + eventSlots[index]! * 4), table + offset);
  }
  if (!output.equals(expected)) {
    const firstDifference = expected.findIndex((byte, index) => byte !== output[index]);
    fail(`完整时间表 COW 字节不符：expected size=${expected.length}, actual=${output.length}, firstDifference=${firstDifference}`);
  }
}

async function readTae(path: string, allowedRoots: string[]): Promise<TaeEnvelope> {
  const res = await runBridge<TaeEnvelope>({
    command: TAE_READ_COMMAND,
    filePath: path,
    allowedRoots,
    timeoutMs: 60_000
  });
  if (res.parseStatus === 'failed' || !res.data) {
    throw new Error(`read-tae-document ${path} 失败: ${JSON.stringify(res.diagnostics)}`);
  }
  return res.data;
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
    timeoutMs: 60_000,
    commandOptions: { outputPath, expectedDocumentHash, mutations }
  });
}

function fail(msg: string): never {
  throw new Error(msg);
}

async function runUnitLayer(): Promise<void> {
  // Case 1: TaeEventHandle 规范校验与 Key 生成 (SF-11 §2.6.1)
  {
    const handle: TaeEventHandle = {
      fileUri: 'action://c1050/A0200',
      animId: 200,
      originalEventIndex: 0,
      eventTypeId: 16,
      paramDataHash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      sourceVersion: 1
    };
    validateTaeEventHandle(handle);
    const key = taeEventHandleKey(handle);
    if (key !== 'action://c1050/A0200::anim:200::event:0') {
      fail('taeEventHandleKey 预期 action://c1050/A0200::anim:200::event:0，实际 ' + key);
    }

    // 负向校验
    try {
      validateTaeEventHandle({ ...handle, animId: -1 });
      fail('animId 为负应报错');
    } catch {
      // pass
    }
  }

  await withSmokeWorkspace('audit-sf11-unit', async (ws) => {
    const root = ws.root;
    const staging = join(root, 'staging');
    await mkdir(staging, { recursive: true });

    const stdSrcPath = join(root, 'std_synthetic.tae');
    const stdBytes = buildStandardSyntheticTae();
    await writeFile(stdSrcPath, stdBytes);
    const stdDoc = await readTae(stdSrcPath, [root]);
    const stdHash = stdDoc.sourceHash!;

    // Case 2: 同动画共享时间槽 COW；原时间表/兄弟事件值/未知字节全部保留。
    {
      const cowOut = join(staging, 'shared_same_anim.tae');
      const res = await writeTae(stdSrcPath, [root], [staging], cowOut, stdHash, [
        { mutation: 'update-event-times', animId: 20, eventIndex: 1, startTime: 0.3, endTime: 1.5 }
      ]);
      if (res.parseStatus === 'failed' || !res.data?.rereadVerified || res.data.byteSurgical !== false) {
        fail('同动画共享槽 COW 失败: ' + JSON.stringify(res.diagnostics));
      }
      expectSyntheticTimeCow(stdBytes, await readFile(cowOut), SYN.anim1EntryAbs, SYN.anim1EventTableAbs,
        [0, 0.3, 1.5, 2], [0, 3, 1, 2]);
      if (!(await readFile(stdSrcPath)).equals(stdBytes)) fail('共享槽 COW 改动了原文件');
    }

    // 构造跨动画共享与点事件样本
    const crossSrcPath = join(root, 'cross_synthetic.tae');
    const crossBytes = buildCrossSharedAndPointSyntheticTae();
    await writeFile(crossSrcPath, crossBytes);
    const crossDoc = await readTae(crossSrcPath, [root]);
    const crossHash = crossDoc.sourceHash!;

    // Case 3: 跨动画共享时间槽 COW，未选动画继续引用原槽。
    {
      const cowOut = join(staging, 'shared_cross_anim.tae');
      // anim 1 (id 20) 的事件 0 的 start 槽指向 0xE0，与 anim 0 (id 10) 的事件 1 共享
      const res = await writeTae(crossSrcPath, [root], [staging], cowOut, crossHash, [
        { mutation: 'update-event-times', animId: 20, eventIndex: 0, startTime: 0.8, endTime: 2.0 }
      ]);
      if (res.parseStatus === 'failed' || !res.data?.rereadVerified) fail('跨动画共享槽 COW 失败');
      expectSyntheticTimeCow(crossBytes, await readFile(cowOut), SYN.anim1EntryAbs, SYN.anim1EventTableAbs,
        [0, 0.8, 2], [1, 2, 0, 2]);
    }

    // Case 4: 点事件可 COW 拆分；仍为单值且未被其它事件共享时保留原位写法。
    {
      const splitPointOut = join(staging, 'split_point.tae');
      const splitRes = await writeTae(crossSrcPath, [root], [staging], splitPointOut, crossHash, [
        { mutation: 'update-event-times', animId: 10, eventIndex: 0, startTime: 1.0, endTime: 1.5 }
      ]);
      if (splitRes.parseStatus === 'failed' || !splitRes.data?.rereadVerified) fail('点事件 COW 拆分失败');
      expectSyntheticTimeCow(crossBytes, await readFile(splitPointOut), SYN.anim0EntryAbs, SYN.anim0EventTableAbs,
        [0.5, 1, 1.5, 2], [1, 2, 0, 3]);

      // 4.2 start == end 应成功
      const goodPointOut = join(staging, 'good_point.tae');
      const goodRes = await writeTae(crossSrcPath, [root], [staging], goodPointOut, crossHash, [
        { mutation: 'update-event-times', animId: 10, eventIndex: 0, startTime: 1.25, endTime: 1.25 }
      ]);
      if (goodRes.parseStatus === 'failed' || !goodRes.data?.rereadVerified) {
        fail('点事件 start == end 写回失败: ' + JSON.stringify(goodRes.diagnostics));
      }
      const goodDoc = await readTae(goodPointOut, [staging]);
      const e0 = goodDoc.animations?.find((a) => a.animId === 10)?.events?.[0];
      if (Math.abs((e0?.startTime ?? 0) - 1.25) > 1e-5 || Math.abs((e0?.endTime ?? 0) - 1.25) > 1e-5) {
        fail('点事件重读时间不符合 1.25');
      }
      const expected = Buffer.from(crossBytes); expected.writeFloatLE(1.25, SYN.anim0Event0StartTimeAbs);
      if (!(await readFile(goodPointOut)).equals(expected)) fail('点事件单值原位更新改动了其它字节');
    }

    // An in-bounds pointer into opaque bytes is NOT a declared time slot.
    // Preserve the old fail-closed guarantee instead of treating every shared
    // or arbitrary pointer as permission to write or to invent a new table.
    {
      const source = join(root, 'unknown_time_pointer.tae');
      const unknownBytes = Buffer.from(stdBytes); unknownBytes.writeBigInt64LE(0x23Cn, 0x1C0);
      await writeFile(source, unknownBytes);
      const document = await readTae(source, [root]);
      const output = join(staging, 'unknown_time_pointer.tae');
      await writeFile(output, Buffer.from([7, 8, 9]));
      const res = await writeTae(source, [root], [staging], output, document.sourceHash!, [
        { mutation: 'update-event-times', animId: 20, eventIndex: 1, startTime: 0.3, endTime: 1.5 }
      ]);
      if (res.parseStatus !== 'failed' || !res.diagnostics.some(d => d.code === TAE_WRITE_BLOCKED_UNKNOWN_STRUCTURE)) {
        fail('未知时间槽必须 fail closed');
      }
      if (!(await readFile(output)).equals(Buffer.from([7, 8, 9]))) fail('未知布局覆盖了既有暂存输出');
      if (!(await readFile(source)).equals(unknownBytes)) fail('未知布局修改了原文件');
    }

    // Case 5: Sibling verify (修改一事件不改兄弟事件) (SF-11 §2.6.4)
    {
      const sibOut = join(staging, 'sibling_verify.tae');
      const res = await writeTae(stdSrcPath, [root], [staging], sibOut, stdHash, [
        { mutation: 'update-event-times', animId: 10, eventIndex: 0, startTime: 0.125, endTime: 0.875 }
      ]);
      if (res.parseStatus === 'failed' || !res.data?.rereadVerified) fail('更新事件0 失败');
      const doc = await readTae(sibOut, [staging]);
      const anim0Events = doc.animations?.find((a) => a.animId === 10)?.events;
      if (!anim0Events || anim0Events.length !== 2) fail('anim0 事件数应为 2');
      const e1 = anim0Events[1]!;
      if (Math.abs((e1.startTime ?? 0) - 0.5) > 1e-5 || Math.abs((e1.endTime ?? 0) - 2.0) > 1e-5) {
        fail('兄弟事件 1 的时间被非预期篡改！');
      }
    }

    // Case 6: 模板类型不匹配拒绝 (SF-11 §2.6.3)
    {
      const typeMismatchOut = join(staging, 'type_mismatch.tae');
      const res = await writeTae(stdSrcPath, [root], [staging], typeMismatchOut, stdHash, [
        { mutation: 'insert-event', animId: 10, templateEventIndex: 1, eventTypeId: 999, startTime: 3.0, endTime: 3.5 }
      ]);
      if (res.parseStatus !== 'failed') fail('类型不匹配必须被拒绝');
      if (!res.diagnostics.some((d) => d.code === TAE_STAGING_WRITE_FAILED)) {
        fail('类型不匹配未报 TAE_STAGING_WRITE_FAILED');
      }
    }

    // Case 7: 同动画连续追加多个事件 (Grouped Animation Insert) (SF-11 §2.6.3)
    {
      const groupInsertOut = join(staging, 'group_insert.tae');
      const res = await writeTae(stdSrcPath, [root], [staging], groupInsertOut, stdHash, [
        { mutation: 'insert-event', animId: 10, templateEventIndex: 1, eventTypeId: 700, startTime: 3.0, endTime: 3.5 },
        { mutation: 'insert-event', animId: 10, templateEventIndex: 1, eventTypeId: 700, startTime: 4.0, endTime: 4.5 }
      ]);
      if (res.parseStatus === 'failed' || !res.data?.rereadVerified) fail('分组插入失败: ' + JSON.stringify(res.diagnostics));
      if (res.data.insertCount !== 2) fail('insertCount 应为 2');
      const doc = await readTae(groupInsertOut, [staging]);
      const anim0 = doc.animations?.find((a) => a.animId === 10);
      if (anim0?.eventCount !== 4) fail('动画 10 事件总数应为 4，实际 ' + anim0?.eventCount);
      const e2 = anim0.events?.[2];
      const e3 = anim0.events?.[3];
      if (Math.abs((e2?.startTime ?? 0) - 3.0) > 1e-5 || Math.abs((e2?.endTime ?? 0) - 3.5) > 1e-5) fail('新增事件 2 时间不符');
      if (Math.abs((e3?.startTime ?? 0) - 4.0) > 1e-5 || Math.abs((e3?.endTime ?? 0) - 4.5) > 1e-5) fail('新增事件 3 时间不符');
    }

    // Case 8: 同一事件多次连续修改 (区间合并与操作记录) (SF-11 §2.6.3)
    {
      const multiUpdateOut = join(staging, 'multi_update.tae');
      const res = await writeTae(stdSrcPath, [root], [staging], multiUpdateOut, stdHash, [
        { mutation: 'update-event-times', animId: 10, eventIndex: 0, startTime: 0.1, endTime: 0.9 },
        { mutation: 'update-event-times', animId: 10, eventIndex: 0, startTime: 0.2, endTime: 0.8 }
      ]);
      if (res.parseStatus === 'failed' || !res.data?.rereadVerified) fail('多次连续修改失败: ' + JSON.stringify(res.diagnostics));
      const doc = await readTae(multiUpdateOut, [staging]);
      const e0 = doc.animations?.find((a) => a.animId === 10)?.events?.[0];
      if (Math.abs((e0?.startTime ?? 0) - 0.2) > 1e-5 || Math.abs((e0?.endTime ?? 0) - 0.8) > 1e-5) {
        fail('多次修改后最终值不符合 0.2/0.8');
      }
    }

    // Case 9: 插入新事件后再修改旧事件的综合链路 (SF-11 §2.6.3)
    {
      const mixedOut = join(staging, 'mixed_pipeline.tae');
      const res = await writeTae(stdSrcPath, [root], [staging], mixedOut, stdHash, [
        { mutation: 'update-event-times', animId: 10, eventIndex: 0, startTime: 0.15, endTime: 0.85 },
        { mutation: 'insert-event', animId: 10, templateEventIndex: 1, startTime: 3.2, endTime: 3.7 },
        { mutation: 'update-event-times', animId: 10, eventIndex: 1, startTime: 0.6, endTime: 1.9 }
      ]);
      if (res.parseStatus === 'failed' || !res.data?.rereadVerified) fail('综合链路执行失败');
      const doc = await readTae(mixedOut, [staging]);
      const anim0 = doc.animations?.find((a) => a.animId === 10);
      if (anim0?.eventCount !== 3) fail('动画 10 事件数应为 3');
      const e0 = anim0.events?.[0];
      const e1 = anim0.events?.[1];
      const e2 = anim0.events?.[2];
      if (Math.abs((e0?.startTime ?? 0) - 0.15) > 1e-5 || Math.abs((e0?.endTime ?? 0) - 0.85) > 1e-5) fail('e0 不符');
      if (Math.abs((e1?.startTime ?? 0) - 0.6) > 1e-5 || Math.abs((e1?.endTime ?? 0) - 1.9) > 1e-5) fail('e1 不符');
      if (Math.abs((e2?.startTime ?? 0) - 3.2) > 1e-5 || Math.abs((e2?.endTime ?? 0) - 3.7) > 1e-5) fail('e2 不符');
    }

    // Case 10: 非法时间区间 (start > end / NaN) 失败关闭不落盘 (SF-11 §2.6.1)
    {
      const invalidOut = join(staging, 'invalid_times.tae');
      const res = await writeTae(stdSrcPath, [root], [staging], invalidOut, stdHash, [
        { mutation: 'update-event-times', animId: 10, eventIndex: 0, startTime: 5.0, endTime: 1.0 }
      ]);
      if (res.parseStatus !== 'failed') fail('start > end 必须失败');
      const outStat = await stat(invalidOut).catch(() => null);
      if (outStat && outStat.size > 0) fail('非法时间落盘了输出文件');
    }
  });

  console.log(JSON.stringify({
    ok: true,
    layer: 'unit',
    suite: 'test:audit-sf-11-unit',
    executedCases: 11,
    message: 'SF-11 unit tests passed: TaeEventHandle, independent complete-table COW bytes, unknown-slot guard, point events, sibling verify, template check, grouped insertion, and streaming verification.'
  }, null, 2));
}

async function runNativeLayer(): Promise<void> {
  await withSmokeWorkspace('audit-sf11-native', async (ws) => {
    const root = ws.root;
    const staging = join(root, 'staging');
    await mkdir(staging, { recursive: true });

    // 检查真实 Sekiro 语料
    const sourceFixture = await resolveNativeFixture(
      undefined,
      'tae-primary',
      '../../mods/chr/c0000.anibnd.dcx'
    );

    let taeSourcePath = join(staging, 'native_test.tae');
    let hasRealCorpus = false;

    if (sourceFixture && (sourceFixture.endsWith('.dcx') || sourceFixture.endsWith('.bnd'))) {
      const extractDir = join(root, 'extract');
      await mkdir(extractDir, { recursive: true });
      const extractedTae = join(extractDir, 'a00.tae');
      const extractRes = await runBridge<{ contentSize?: number }>({
        command: 'extract-bnd4-child',
        filePath: sourceFixture,
        allowedRoots: [dirname(sourceFixture)],
        writableRoots: [extractDir],
        commandOptions: { childPath: 'tae/a00.tae', outputPath: extractedTae },
        timeoutMs: 180_000
      });
      const verdict = classifyChildExtract(extractRes);
      if (verdict.kind === 'ok') {
        await writeFile(taeSourcePath, await readFile(extractedTae));
        hasRealCorpus = true;
      }
    }

    if (!hasRealCorpus) {
      // 合成 native 级别验证
      await writeFile(taeSourcePath, buildStandardSyntheticTae());
    }

    const doc = await readTae(taeSourcePath, [staging]);
    const srcHash = doc.sourceHash!;

    // 找一个包含事件的动画
    const targetAnim = doc.animations?.find((a) => (a.eventCount ?? 0) >= 2 && !a.eventsTruncated);
    if (!targetAnim || typeof targetAnim.animId !== 'number') {
      fail('未找到具备充足事件的目标动画');
    }

    const outPath = join(staging, 'native_out.tae');
    const writeRes = await writeTae(taeSourcePath, [staging], [staging], outPath, srcHash, [
      {
        mutation: 'insert-event',
        animId: targetAnim.animId,
        templateEventIndex: 0,
        startTime: 10.0,
        endTime: 10.5
      }
    ]);

    if (writeRes.parseStatus === 'failed' || !writeRes.data?.rereadVerified) {
      fail('Native TAE write 失败: ' + JSON.stringify(writeRes.diagnostics));
    }

    // 校验重读
    const rereadDoc = await readTae(outPath, [staging]);
    const rereadAnim = rereadDoc.animations?.find((a) => a.animId === targetAnim.animId);
    if ((rereadAnim?.eventCount ?? 0) !== (targetAnim.eventCount ?? 0) + 1) {
      fail('重读后事件数不匹配');
    }

    // 校验无残留临时文件
    const residue = (await readdir(staging)).filter((f) => f.startsWith('.soulforge-tae-') && f.endsWith('.tmp'));
    if (residue.length > 0) {
      fail('暂存区残留临时文件: ' + residue.join(', '));
    }

    console.log(JSON.stringify({
      ok: true,
      layer: 'native',
      suite: 'test:audit-sf-11-native',
      realCorpusUsed: hasRealCorpus,
      targetAnimId: targetAnim.animId,
      message: 'SF-11 native smoke passed: insert-event verified on ' + (hasRealCorpus ? 'real Sekiro anibnd' : 'synthetic native TAE') + ', clean residue.'
    }, null, 2));
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const layerIdx = args.indexOf('--layer');
  if (layerIdx === -1 || !args[layerIdx + 1]) {
    console.error('用法: node dist/testing/runAuditSf11Smoke.js --layer unit|native');
    process.exit(2);
  }
  const layer = args[layerIdx + 1];
  try {
    if (layer === 'unit') {
      await runUnitLayer();
    } else if (layer === 'native') {
      await runNativeLayer();
    } else {
      console.error('未知 layer: ' + layer);
      process.exit(2);
    }
  } catch (err) {
    console.error('SF-11 smoke failure:', err);
    process.exit(1);
  }
}

main();
