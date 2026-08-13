/**
 * Native FXR writer smoke（VFX-54C）——vfx-field-set 与 roundtrip。
 *
 * 路径 A（真实语料）：registry 已登记 fxr-primary → 提取容器子项 → 读真实 FXR →
 * 尝试对第一个 host 的 Section11 值做 vfx-field-set。真实语料含未识别 node type 时
 * C# 侧已知布局门以 FXR_WRITE_BLOCKED_UNKNOWN_STRUCTURE fail-closed——那是诚实
 * 结论（布局未完全已知不开放写），不是解析缺陷；此时如实报告 skipped/blocked。
 *
 * 路径 B（合成 fixture）：registry 未登记 → 微小、合法构造、显式 syntheticFixture
 * 标记的合成 FXR3（Section1→2→3 链 + Section4 根 + Section6 host + Section7 属性 +
 * Section8 条目 + Section11 不透明值）→ write-fxr-document，断言：
 *   - **host field set 生效**：host[0] Section11 valueIndex 1（0x01020304）→ 重读
 *     命中；字节级 diff 恰为一个区间且落在目标 Int32 上（字节外科替换的直接证明）；
 *   - **property field set 生效**：host[0] property[0] Section11 valueIndex 0 → 999；
 *   - **section8 field set 生效**：host[0] property[0] section8[0] valueIndex 1 → -123；
 *   - **多条 mutation 顺序应用**：同 host 两个 valueIndex 各设一个新值；
 *   - **已知布局门 block**：未知 node type（unknown-type gap）与 layout warning 都
 *     按 FXR_WRITE_BLOCKED_UNKNOWN_STRUCTURE 失败关闭且不落盘；
 *   - **失败注入**：hash 篡改 / hostIndex 越界 / valueIndex 越界 / 未知容器 →
 *     FXR_STAGING_WRITE_FAILED 且不落盘；before image（源文件）字节不变；
 *   - **reopen-failure before-image 恢复**：输出损坏后 read 必须结构化失败，
 *     源 before-image 哈希可恢复；暂存区无 .soulforge-fxr-*.tmp 残留。
 *
 * 缺语料处置：fxr-primary 未登记是合法状态（本机 ffxbnd 语料未登记），此时走
 * 路径 B——合成 fixture 仍真实经过 C# FxrNativeWriter 验证写回，不冒充 native
 * authority（syntheticFixture: true）。只有 registry 配置损坏等环境问题才失败关闭。
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BridgeResult } from '@soulforge/shared';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { nativeFixtureRoleRegistered, resolveNativeFixture } from './nativeFixtureRegistry.js';
import { classifyChildExtract, reportInfrastructureFailure } from './nativeFixtureExtract.js';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';

const FX_WRITE_COMMAND = 'write-fxr-document' as const;
const FX_READ_COMMAND = 'read-fxr-document' as const;

const FXR_STAGING_WRITE_VERIFIED = 'FXR_STAGING_WRITE_VERIFIED';
const FXR_STAGING_WRITE_FAILED = 'FXR_STAGING_WRITE_FAILED';
const FXR_WRITE_BLOCKED_UNKNOWN_STRUCTURE = 'FXR_WRITE_BLOCKED_UNKNOWN_STRUCTURE';
const FXR_DOCUMENT_READ_FAILED = 'FXR_DOCUMENT_READ_FAILED';

/**
 * 合成 fixture 的关键绝对偏移，与 buildSyntheticFxr 同源。
 * Section11 值布局：host[0] values 在 0x1D0（[1,2]），property[0] values 在 0x1D8
 * （[3,4]），section8[0] values 在 0x1E0（[5,6]）；Section3 两个偏移指 0x1C8/0x1CC。
 */
const SYN = {
  fileSize: 0x1E8,
  section1Abs: 0x090,
  section4RootTypeAbs: 0x110,
  section6HostAbs: 0x140,
  hostSection11ValueIndex1Abs: 0x1D4,
  propertySection11ValueIndex0Abs: 0x1D8,
  section8Section11ValueIndex1Abs: 0x1E4
} as const;

interface FxrEnvelope {
  format?: string;
  formatId?: string;
  version?: number;
  sourceSize?: number;
  sourceHash?: string;
  resourceId?: number;
  rootNodeCount?: number;
  totalNodeCount?: number;
  hostCount?: number;
  propertyCount?: number;
  section11ValueCount?: number;
  unparsedGaps?: string[];
  layoutWarnings?: string[];
  roundTrip?: { consistent?: boolean };
  authority?: string;
  fields?: {
    hosts?: Array<{
      typeId?: number;
      values?: number[];
      properties?: Array<{
        typeId?: number;
        values?: number[];
        section8?: Array<{ typeId?: number; values?: number[] }>;
      }>;
    }>;
  };
}

interface WriteEnvelope {
  mutationCount?: number;
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

type FxrMutation = {
  mutation: string;
  address: {
    container: string;
    hostIndex: number;
    propertyIndex?: number;
    section8Index?: number;
    valueIndex: number;
  };
  value: number;
};

/** 微小、合法构造、明确标记的合成 FXR3（syntheticFixture: true，非 native authority）。 */
function buildSyntheticFxr(): Uint8Array {
  const size = SYN.fileSize;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  const u16 = (o: number, v: number): void => view.setUint16(o, v, true);
  const i16 = (o: number, v: number): void => view.setInt16(o, v, true);
  const u32 = (o: number, v: number): void => view.setUint32(o, v, true);
  const i32 = (o: number, v: number): void => view.setInt32(o, v, true);

  // ── 文件头 0x90 ──
  buf.set([0x46, 0x58, 0x52, 0x00], 0x00); // "FXR\0"
  i16(0x04, 0);
  u16(0x06, 5); // version = 5
  i32(0x08, 1);
  i32(0x0C, 0x00094F00); // id（资源 id 区间内）
  i32(0x10, 0x090); i32(0x14, 1); // Section1 offset/count
  i32(0x18, 0x0A0); i32(0x1C, 1); // Section2
  i32(0x20, 0x0B0); i32(0x24, 1); // Section3
  i32(0x28, 0x110); i32(0x2C, 1); // Section4（根）
  i32(0x30, 0x000); i32(0x34, 0); // Section5
  i32(0x38, 0x140); i32(0x3C, 1); // Section6
  i32(0x40, 0x180); i32(0x44, 1); // Section7
  i32(0x48, 0x1A8); i32(0x4C, 1); // Section8
  i32(0x50, 0x000); i32(0x54, 0); // Section9
  i32(0x58, 0x000); i32(0x5C, 0); // Section10
  i32(0x60, 0x1C8); i32(0x64, 8); // Section11（8 个 Int32）
  i32(0x68, 1);
  i32(0x6C, 0);
  i32(0x70, 0x000); i32(0x74, 0); // Section12（恒空）
  i32(0x78, 0x000); i32(0x7C, 0); // Section13（恒空）
  i32(0x80, 0x000); i32(0x84, 0); // Section14（恒空）
  i32(0x88, 0);
  i32(0x8C, 0);

  // ── Section1 (0x090, 0x10) ──
  i32(0x090 + 0x00, 0);
  i32(0x090 + 0x04, 1); // section2Count
  i32(0x090 + 0x08, 0x0A0); // section2Offset
  i32(0x090 + 0x0C, 0);

  // ── Section2 (0x0A0, 0x10) ──
  i32(0x0A0 + 0x00, 0);
  i32(0x0A0 + 0x04, 1); // section3Count
  i32(0x0A0 + 0x08, 0x0B0); // section3Offset
  i32(0x0A0 + 0x0C, 0);

  // ── Section3 (0x0B0, 0x60) ──
  i16(0x0B0 + 0x00, 11); // 固定 tag
  buf[0x0B0 + 0x02] = 0;
  buf[0x0B0 + 0x03] = 1;
  i32(0x0B0 + 0x04, 0);
  i32(0x0B0 + 0x08, -1); // Unk08
  i32(0x0B0 + 0x0C, 0);
  i32(0x0B0 + 0x10, 0x0100FFFC); // Unk10
  i32(0x0B0 + 0x14, 0);
  i32(0x0B0 + 0x18, 1);
  i32(0x0B0 + 0x1C, 0);
  i32(0x0B0 + 0x20, 0x1C8); // section11Offset1 → 1 个 Int32
  i32(0x0B0 + 0x38, 0x0100FFFC); // Unk38
  i32(0x0B0 + 0x3C, 0);
  i32(0x0B0 + 0x40, 1);
  i32(0x0B0 + 0x44, 0);
  i32(0x0B0 + 0x48, 0x1CC); // section11Offset2 → 1 个 Int32

  // ── Section4 根节点 (0x110, 0x30) ──
  i16(0x110 + 0x00, 2000); // type id（闭集）
  buf[0x110 + 0x02] = 0;
  buf[0x110 + 0x03] = 1;
  i32(0x110 + 0x04, 0);
  i32(0x110 + 0x08, 0); // section5Count
  i32(0x110 + 0x0C, 1); // section6Count
  i32(0x110 + 0x10, 0); // section4Count（子节点）
  i32(0x110 + 0x14, 0);
  i32(0x110 + 0x18, 0x000); // section5Offset
  i32(0x110 + 0x1C, 0);
  i32(0x110 + 0x20, 0x140); // section6Offset
  i32(0x110 + 0x24, 0);
  i32(0x110 + 0x28, 0x000); // section4Offset（无子）
  i32(0x110 + 0x2C, 0);

  // ── Section6 host (0x140, 0x40) ──
  i16(0x140 + 0x00, 0); // type id（闭集）
  buf[0x140 + 0x02] = 0; // Unk02(bool)
  buf[0x140 + 0x03] = 1; // Unk03(bool)
  i32(0x140 + 0x04, 0); // Unk04
  i32(0x140 + 0x08, 2); // section11Count1
  i32(0x140 + 0x0C, 0); // section10Count
  i32(0x140 + 0x10, 1); // section7Count1
  i32(0x140 + 0x14, 0); // section11Count2
  i32(0x140 + 0x18, 0);
  i32(0x140 + 0x1C, 0); // section7Count2
  i32(0x140 + 0x20, 0x1D0); // section11Offset
  i32(0x140 + 0x24, 0);
  i32(0x140 + 0x28, 0x000); // section10Offset
  i32(0x140 + 0x2C, 0);
  i32(0x140 + 0x30, 0x180); // section7Offset

  // ── Section7 属性 (0x180, 0x28) ──
  i16(0x180 + 0x00, 0); // type id（闭集）
  buf[0x180 + 0x02] = 0;
  buf[0x180 + 0x03] = 1;
  i32(0x180 + 0x04, 0); // Unk04
  i32(0x180 + 0x08, 2); // section11Count
  i32(0x180 + 0x0C, 0);
  i32(0x180 + 0x10, 0x1D8); // section11Offset
  i32(0x180 + 0x14, 0);
  i32(0x180 + 0x18, 0x1A8); // section8Offset
  i32(0x180 + 0x1C, 0);
  i32(0x180 + 0x20, 1); // section8Count
  i32(0x180 + 0x24, 0);

  // ── Section8 条目 (0x1A8, 0x20) ──
  u16(0x1A8 + 0x00, 0xD050); // type id（闭集）
  buf[0x1A8 + 0x02] = 0;
  buf[0x1A8 + 0x03] = 1;
  i32(0x1A8 + 0x04, 0); // Unk04
  i32(0x1A8 + 0x08, 2); // section11Count
  i32(0x1A8 + 0x0C, 0); // section9Count
  i32(0x1A8 + 0x10, 0x1E0); // section11Offset
  i32(0x1A8 + 0x14, 0);
  i32(0x1A8 + 0x18, 0x000); // section9Offset
  i32(0x1A8 + 0x1C, 0);

  // ── Section11 值 (0x1C8, 8×Int32) ──
  i32(0x1C8 + 0x00, 0x3F800000); // Section3 offset1：1.0f
  i32(0x1C8 + 0x04, 0x40000000); // Section3 offset2：2.0f
  i32(0x1C8 + 0x08, 0x00000001); // host values ×2
  i32(0x1C8 + 0x0C, 0x00000002);
  i32(0x1C8 + 0x10, 0x00000003); // property values ×2
  i32(0x1C8 + 0x14, 0x00000004);
  i32(0x1C8 + 0x18, 0x00000005); // section8 values ×2
  i32(0x1C8 + 0x1C, 0x00000006);

  return buf;
}

function byteDiffRegions(source: Uint8Array, output: Uint8Array): Array<{ start: number; end: number }> {
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

async function readFxr(path: string, allowedRoots: string[]): Promise<FxrEnvelope> {
  const result = await runBridge<FxrEnvelope>({
    command: FX_READ_COMMAND,
    filePath: path,
    allowedRoots,
    timeoutMs: 120_000
  });
  if (result.parseStatus === 'failed' || !result.data?.sourceHash) {
    throw new Error(`read-fxr-document ${path} 失败：${JSON.stringify(result.diagnostics)}`);
  }
  return result.data;
}

async function writeFxr(
  sourcePath: string,
  allowedRoots: string[],
  writableRoots: string[],
  outputPath: string,
  expectedDocumentHash: string,
  mutations: FxrMutation[]
): Promise<BridgeResult<WriteEnvelope>> {
  return runBridge<WriteEnvelope>({
    command: FX_WRITE_COMMAND,
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
    (name) => name.startsWith('.soulforge-fxr-') && name.endsWith('.tmp')
  );
  if (residue.length > 0) {
    throw new Error(`暂存区残留半成品临时文件：${residue.join(', ')}`);
  }
}

async function syntheticLeg(): Promise<void> {
  await withSmokeWorkspace('native-fxr-writer', async (workspace) => {
    const root = workspace.root;
    const staging = join(root, 'staging');
    await mkdir(staging, { recursive: true });

    // ---- 0. 源：合成 FXR，读 + 断言基础形态。 ----
    const srcPath = join(root, 'synthetic_writer_smoke.fxr');
    const srcBytes = buildSyntheticFxr();
    await writeFile(srcPath, srcBytes);
    const srcDoc = await readFxr(srcPath, [root]);
    const srcHash = srcDoc.sourceHash!;
    const srcBytesOnDisk = await readFile(srcPath);
    if (!srcBytesOnDisk.equals(srcBytes)) {
      throw new Error('合成 FXR 落盘字节与构造不一致');
    }
    if (srcDoc.hostCount !== 1 || srcDoc.propertyCount !== 1 || srcDoc.section11ValueCount !== 8) {
      throw new Error(`合成 FXR 形态异常：${JSON.stringify({
        hostCount: srcDoc.hostCount, propertyCount: srcDoc.propertyCount, section11ValueCount: srcDoc.section11ValueCount
      })}`);
    }

    // ---- 1. host field set：host[0] valueIndex 1 → 0x01020304。 ----
    const hostNewValue = 0x01020304; // 16909060（位模式，任意 int32）
    const outA = join(staging, 'out-a.fxr');
    const writeA = await writeFxr(srcPath, [root], [staging], outA, srcHash, [
      { mutation: 'vfx-field-set', address: { container: 'host', hostIndex: 0, valueIndex: 1 }, value: hostNewValue }
    ]);
    if (writeA.parseStatus === 'failed' || !writeA.data?.rereadVerified) {
      throw new Error(`host field set 未重读验证：${JSON.stringify(writeA.diagnostics)}`);
    }
    if (!writeA.diagnostics.some((d) => d.code === FXR_STAGING_WRITE_VERIFIED)) {
      throw new Error(`host field set 未发 ${FXR_STAGING_WRITE_VERIFIED}：${JSON.stringify(writeA.diagnostics)}`);
    }
    if (writeA.data.byteSurgical !== true) {
      throw new Error('host field set 应标记 byteSurgical=true');
    }
    if (writeA.data.mutationCount !== 1) {
      throw new Error(`mutationCount 应为 1：${JSON.stringify(writeA.data)}`);
    }
    const outABytes = await readFile(outA);
    const diffA = byteDiffRegions(srcBytes, outABytes);
    if (diffA.length !== 1) {
      throw new Error(`host field set 应恰好一个差异区间，实际 ${JSON.stringify(diffA)}`);
    }
    const hostAbs = SYN.hostSection11ValueIndex1Abs;
    if (diffA[0]!.start < hostAbs || diffA[0]!.end > hostAbs + 4) {
      throw new Error(`差异区间应落在目标 Int32 [0x${hostAbs.toString(16)}, 0x${(hostAbs + 4).toString(16)}) 内，实际 ${JSON.stringify(diffA[0])}`);
    }
    if (outABytes.readInt32LE(hostAbs) !== hostNewValue) {
      throw new Error(`写回后 host[0] valueIndex 1 应为 ${hostNewValue}（0x${hostAbs.toString(16)}）。`);
    }

    // ---- 2. 重读 out-a：host[0].values[1] 命中、host 计数不变。 ----
    const outADoc = await readFxr(outA, [staging]);
    const hostA = outADoc.fields?.hosts?.[0];
    if (hostA?.values?.[1] !== hostNewValue) {
      throw new Error(`重读后 host[0].values[1] 应为 ${hostNewValue}：${JSON.stringify(hostA?.values)}`);
    }
    if (outADoc.section11ValueCount !== srcDoc.section11ValueCount) {
      throw new Error(`host field set 不应改变 Section11 总条数：${outADoc.section11ValueCount} vs ${srcDoc.section11ValueCount}`);
    }

    // ---- 3. property field set：host[0] property[0] valueIndex 0 → 999。 ----
    const outB = join(staging, 'out-b.fxr');
    const writeB = await writeFxr(srcPath, [root], [staging], outB, srcHash, [
      { mutation: 'vfx-field-set', address: { container: 'property', hostIndex: 0, propertyIndex: 0, valueIndex: 0 }, value: 999 }
    ]);
    if (writeB.parseStatus === 'failed' || !writeB.data?.rereadVerified) {
      throw new Error(`property field set 未重读验证：${JSON.stringify(writeB.diagnostics)}`);
    }
    if (!writeB.diagnostics.some((d) => d.code === FXR_STAGING_WRITE_VERIFIED)) {
      throw new Error(`property field set 未发 ${FXR_STAGING_WRITE_VERIFIED}：${JSON.stringify(writeB.diagnostics)}`);
    }
    const outBBytes = await readFile(outB);
    if (outBBytes.readInt32LE(SYN.propertySection11ValueIndex0Abs) !== 999) {
      throw new Error(`写回后 property[0] valueIndex 0 应为 999。`);
    }
    const outBDoc = await readFxr(outB, [staging]);
    if (outBDoc.fields?.hosts?.[0]?.properties?.[0]?.values?.[0] !== 999) {
      throw new Error(`重读后 property[0].values[0] 应为 999：${JSON.stringify(outBDoc.fields?.hosts?.[0]?.properties?.[0]?.values)}`);
    }

    // ---- 4. section8 field set：host[0] property[0] section8[0] valueIndex 1 → -123。 ----
    const outC = join(staging, 'out-c.fxr');
    const writeC = await writeFxr(srcPath, [root], [staging], outC, srcHash, [
      { mutation: 'vfx-field-set', address: { container: 'section8', hostIndex: 0, propertyIndex: 0, section8Index: 0, valueIndex: 1 }, value: -123 }
    ]);
    if (writeC.parseStatus === 'failed' || !writeC.data?.rereadVerified) {
      throw new Error(`section8 field set 未重读验证：${JSON.stringify(writeC.diagnostics)}`);
    }
    if (!writeC.diagnostics.some((d) => d.code === FXR_STAGING_WRITE_VERIFIED)) {
      throw new Error(`section8 field set 未发 ${FXR_STAGING_WRITE_VERIFIED}：${JSON.stringify(writeC.diagnostics)}`);
    }
    const outCBytes = await readFile(outC);
    if (outCBytes.readInt32LE(SYN.section8Section11ValueIndex1Abs) !== -123) {
      throw new Error(`写回后 section8[0] valueIndex 1 应为 -123。`);
    }
    const outCDoc = await readFxr(outC, [staging]);
    if (outCDoc.fields?.hosts?.[0]?.properties?.[0]?.section8?.[0]?.values?.[1] !== -123) {
      throw new Error(`重读后 section8[0].values[1] 应为 -123：${JSON.stringify(outCDoc.fields?.hosts?.[0]?.properties?.[0]?.section8)}`);
    }

    // ---- 5. 多条 mutation 顺序应用：同 host 两个 valueIndex（含 uint32 位模式）。 ----
    const outD = join(staging, 'out-d.fxr');
    const writeD = await writeFxr(srcPath, [root], [staging], outD, srcHash, [
      // 0xAAAAAAAA 超出 int32，按 uint32 十进制表达（C# 截断成位模式 → 读回为 -1431655766）。
      { mutation: 'vfx-field-set', address: { container: 'host', hostIndex: 0, valueIndex: 0 }, value: 0xAAAAAAAA },
      { mutation: 'vfx-field-set', address: { container: 'host', hostIndex: 0, valueIndex: 1 }, value: 0x55555555 }
    ]);
    if (writeD.parseStatus === 'failed' || !writeD.data?.rereadVerified) {
      throw new Error(`multi-mutation 未重读验证：${JSON.stringify(writeD.diagnostics)}`);
    }
    if (writeD.data.mutationCount !== 2) {
      throw new Error(`multi-mutation 应计 2 条：${JSON.stringify(writeD.data)}`);
    }
    const outDDoc = await readFxr(outD, [staging]);
    const hostD = outDDoc.fields?.hosts?.[0];
    // Section11 值是 int32 语义：0xAAAAAAAA 读回为 -1431655766，0x55555555 读回为 1431655765。
    if (hostD?.values?.[0] !== -1431655766 || hostD?.values?.[1] !== 1431655765) {
      throw new Error(`multi-mutation 后 host[0].values 应为 [-1431655766, 1431655765]：${JSON.stringify(hostD?.values)}`);
    }

    // ---- 6. 已知布局门：未知 node type 与 layout warning 都 block 且不落盘。 ----
    const unknownTypeBytes = buildSyntheticFxr();
    new DataView(unknownTypeBytes.buffer).setInt16(SYN.section4RootTypeAbs, 0x7FFF, true); // 闭集外的 type
    const unknownSrc = join(staging, 'unknown-type.fxr');
    await writeFile(unknownSrc, unknownTypeBytes);
    const unknownDoc = await readFxr(unknownSrc, [staging]);
    const unknownTypeGaps = (unknownDoc.unparsedGaps ?? []).filter((g) => g.startsWith('unknown-type:'));
    if (unknownTypeGaps.length === 0) {
      throw new Error(`合成未知 type 语料应如实登记 unknown-type gap：${JSON.stringify(unknownDoc.unparsedGaps)}`);
    }
    const blockedOut = join(staging, 'blocked.fxr');
    const blocked = await writeFxr(unknownSrc, [staging], [staging], blockedOut, unknownDoc.sourceHash!, [
      { mutation: 'vfx-field-set', address: { container: 'host', hostIndex: 0, valueIndex: 0 }, value: 7 }
    ]);
    if (blocked.parseStatus !== 'failed'
      || !blocked.diagnostics.some((d) => d.code === FXR_WRITE_BLOCKED_UNKNOWN_STRUCTURE)) {
      throw new Error(`未知 node type 未按 ${FXR_WRITE_BLOCKED_UNKNOWN_STRUCTURE} 失败关闭：${JSON.stringify(blocked.diagnostics)}`);
    }
    if ((await fileSize(blockedOut)) !== 0) {
      throw new Error('未知 type block 用例落盘了输出文件（fail-closed 必须不落盘）');
    }

    const warningBytes = buildSyntheticFxr();
    new DataView(warningBytes.buffer).setInt32(SYN.section1Abs, 1, true); // Section1[0]+0x00 非零 → layout warning
    const warningSrc = join(staging, 'layout-warning.fxr');
    await writeFile(warningSrc, warningBytes);
    const warningDoc = await readFxr(warningSrc, [staging]);
    if ((warningDoc.layoutWarnings ?? []).length === 0) {
      throw new Error(`合成 layout-warning 语料应如实登记 layoutWarnings：${JSON.stringify(warningDoc.layoutWarnings)}`);
    }
    const warningOut = join(staging, 'warning-blocked.fxr');
    const warningBlocked = await writeFxr(warningSrc, [staging], [staging], warningOut, warningDoc.sourceHash!, [
      { mutation: 'vfx-field-set', address: { container: 'host', hostIndex: 0, valueIndex: 0 }, value: 7 }
    ]);
    if (warningBlocked.parseStatus !== 'failed'
      || !warningBlocked.diagnostics.some((d) => d.code === FXR_WRITE_BLOCKED_UNKNOWN_STRUCTURE)) {
      throw new Error(`layout warning 未按 ${FXR_WRITE_BLOCKED_UNKNOWN_STRUCTURE} 失败关闭：${JSON.stringify(warningBlocked.diagnostics)}`);
    }
    if ((await fileSize(warningOut)) !== 0) {
      throw new Error('layout warning block 用例落盘了输出文件（fail-closed 必须不落盘）');
    }

    // ---- 7. 失败注入：hash / 越界 / 未知容器 → FAILED 且不落盘。 ----
    const badCases: Array<{ label: string; hash: string; mutations: FxrMutation[] }> = [
      {
        label: 'hash篡改',
        hash: '0'.repeat(64),
        mutations: [{ mutation: 'vfx-field-set', address: { container: 'host', hostIndex: 0, valueIndex: 0 }, value: 1 }]
      },
      {
        label: 'hostIndex越界',
        hash: srcHash,
        mutations: [{ mutation: 'vfx-field-set', address: { container: 'host', hostIndex: 999, valueIndex: 0 }, value: 1 }]
      },
      {
        label: 'valueIndex越界',
        hash: srcHash,
        mutations: [{ mutation: 'vfx-field-set', address: { container: 'host', hostIndex: 0, valueIndex: 99 }, value: 1 }]
      },
      {
        label: 'propertyIndex越界',
        hash: srcHash,
        mutations: [{ mutation: 'vfx-field-set', address: { container: 'property', hostIndex: 0, propertyIndex: 5, valueIndex: 0 }, value: 1 }]
      },
      {
        label: '未知容器',
        hash: srcHash,
        mutations: [{ mutation: 'vfx-field-set', address: { container: 'header', hostIndex: 0, valueIndex: 0 }, value: 1 }]
      }
    ];
    for (const bad of badCases) {
      const badOut = join(staging, `bad-${bad.label}.fxr`);
      const attempt = await writeFxr(srcPath, [root], [staging], badOut, bad.hash, bad.mutations);
      if (attempt.parseStatus !== 'failed'
        || !attempt.diagnostics.some((d) => d.code === FXR_STAGING_WRITE_FAILED)) {
        throw new Error(`${bad.label} 未按 ${FXR_STAGING_WRITE_FAILED} 失败关闭：${JSON.stringify(attempt.diagnostics)}`);
      }
      if ((await fileSize(badOut)) !== 0) {
        throw new Error(`${bad.label} 落盘了输出文件（fail-closed 必须不落盘）`);
      }
    }
    if (!(await readFile(srcPath)).equals(srcBytes)) {
      throw new Error('失败注入后源文件（before image）被改动');
    }

    // ---- 8. reopen-failure before-image 恢复：输出损坏后 read 结构化失败，源可恢复。 ----
    const corruptedPath = join(staging, 'corrupted.fxr');
    await writeFile(corruptedPath, srcBytes.subarray(0, 0x40));
    const reopen = await runBridge<FxrEnvelope>({
      command: FX_READ_COMMAND,
      filePath: corruptedPath,
      allowedRoots: [staging],
      timeoutMs: 60_000
    });
    if (reopen.parseStatus !== 'failed'
      || !reopen.diagnostics.some((d) => d.code === FXR_DOCUMENT_READ_FAILED)) {
      throw new Error(`reopen failure 未结构化失败：${JSON.stringify(reopen.diagnostics)}`);
    }
    const beforeImage = await readFxr(srcPath, [root]);
    if (beforeImage.sourceHash !== srcHash) {
      throw new Error('reopen failure 后 before image 不可恢复（rollback 前提失败）');
    }

    // ---- 9. 无 .soulforge-fxr-*.tmp 残留。 ----
    await assertNoTempResidue(staging);

    // ---- 10. 输出（绝对路径脱敏）。 ----
    const output = JSON.stringify({
      ok: true,
      status: 'synthetic-fixture',
      syntheticFixture: true,
      fixtureRole: 'fxr-primary',
      message: 'FXR 字段写回/重读/未知保留/已知布局门/block/失败注入验证通过',
      authority: 'candidate', // 合成语料不冒充 native authority（write 语义 authority 仍上限 candidate）
      hostFieldSet: {
        code: FXR_STAGING_WRITE_VERIFIED,
        rereadVerified: writeA.data.rereadVerified,
        byteSurgical: writeA.data.byteSurgical,
        byteDiffExactlyOneRegion: diffA.length === 1,
        targetAbsOffset: `0x${hostAbs.toString(16)}`,
        valueBefore: 0x00000002,
        valueAfter: hostNewValue,
        reopenedValues: hostA?.values
      },
      propertyFieldSet: {
        code: FXR_STAGING_WRITE_VERIFIED,
        valueAfter: 999,
        reopenedValues: outBDoc.fields?.hosts?.[0]?.properties?.[0]?.values
      },
      section8FieldSet: {
        code: FXR_STAGING_WRITE_VERIFIED,
        valueAfter: -123,
        reopenedValues: outCDoc.fields?.hosts?.[0]?.properties?.[0]?.section8?.[0]?.values
      },
      multiMutation: {
        code: FXR_STAGING_WRITE_VERIFIED,
        mutationCount: writeD.data.mutationCount,
        reopenedValues: hostD?.values
      },
      knownLayoutGate: {
        unknownTypeBlocked: blocked.parseStatus === 'failed',
        layoutWarningBlocked: warningBlocked.parseStatus === 'failed',
        noOutputLanded: (await fileSize(blockedOut)) === 0 && (await fileSize(warningOut)) === 0
      },
      unknownPreserved: {
        byteLevelDiffOnlyInExpectedRegions: true,
        outputHash: writeA.data.outputHash
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
  await withSmokeWorkspace('native-fxr-writer-corpus', async (workspace) => {
    const root = workspace.root;
    const staging = join(root, 'staging');
    await mkdir(staging, { recursive: true });

    const source = await resolveNativeFixture(
      explicitPath,
      'fxr-primary',
      '../../mods/sfx/ffxbnd.dcx'
    );

    // 真实 FXR 在 ffxbnd 容器内：先提取子项再读（与 read smoke 同路径）。
    let fxrPath = source;
    if (source.endsWith('.dcx') || source.endsWith('.bnd')) {
      const tmpDir = join(root, 'extract');
      await mkdir(tmpDir, { recursive: true });
      fxrPath = join(tmpDir, 'extracted.fxr');
      const extract = await runBridge<ExtractEnvelope>({
        command: 'extract-bnd4-child',
        filePath: source,
        allowedRoots: [source.replace(/[/\\][^/\\]+$/, '')],
        writableRoots: [tmpDir],
        commandOptions: { entryIndex: 0, outputPath: fxrPath },
        timeoutMs: 180_000
      });
      const verdict = classifyChildExtract(extract);
      if (verdict.kind === 'infrastructure-failure') {
        reportInfrastructureFailure('FXR', 'FXR_WRITER_FIXTURE_EXTRACT_INFRASTRUCTURE_FAILURE', verdict);
        return;
      }
      if (verdict.kind === 'missing-child') {
        console.log(JSON.stringify({
          ok: true,
          status: 'skipped',
          message: 'FXR fixture not available in container (子项不存在).',
          diagnostics: verdict.codes
        }));
        return;
      }
    }

    // 源先拷进暂存工作区，再在 staging 内读写：daemon 的 writableRoots 必须落在
    // allowedRoots 内，而 registry 源（游戏 mod 目录）与临时 staging 是两个根。
    const srcInStaging = join(staging, 'source.fxr');
    await writeFile(srcInStaging, await readFile(fxrPath));
    const doc = await readFxr(srcInStaging, [staging]);

    // 只对第一个 host 的第一个 Section11 值做 field set；真实语料若被已知布局门
    // block（未识别 node type / Section9 非空等），如实报告，不冒充写回成功。
    const outPath = join(staging, 'out.fxr');
    const write = await writeFxr(srcInStaging, [staging], [staging], outPath, doc.sourceHash!, [
      { mutation: 'vfx-field-set', address: { container: 'host', hostIndex: 0, valueIndex: 0 }, value: 0x10203040 }
    ]);
    if (write.parseStatus === 'failed') {
      const blocked = write.diagnostics.some((d) => d.code === FXR_WRITE_BLOCKED_UNKNOWN_STRUCTURE);
      console.log(JSON.stringify({
        ok: true,
        syntheticFixture: false,
        status: blocked ? 'skipped' : 'failed',
        message: blocked
          ? '真实 FXR 语料被已知布局门 fail-closed（未识别 node type / 未验证布局段），不开放写入口。'
          : `真实 FXR 语料写回失败：${JSON.stringify(write.diagnostics)}`,
        authority: doc.authority,
        unparsedGaps: doc.unparsedGaps,
        diagnostics: write.diagnostics
      }, null, 2));
      return;
    }
    if (!write.data?.rereadVerified
      || !write.diagnostics.some((d) => d.code === FXR_STAGING_WRITE_VERIFIED)) {
      throw new Error(`真实语料 write 未重读验证：${JSON.stringify(write.diagnostics)}`);
    }
    const reopened = await readFxr(outPath, [staging]);
    const hostAfter = reopened.fields?.hosts?.[0];
    if (hostAfter?.values?.[0] !== 0x10203040) {
      throw new Error(`真实语料重读后 host[0].values[0] 未命中：${JSON.stringify(hostAfter?.values)}`);
    }
    console.log(JSON.stringify({
      ok: true,
      syntheticFixture: false,
      message: 'FXR native 写回验证通过（host field set）',
      authority: doc.authority,
      rereadVerified: write.data.rereadVerified,
      structurePreserved: write.data.structurePreserved,
      outputHash: write.data.outputHash,
      reopenedValue: hostAfter?.values?.[0],
      sourceFile: source.split(/[\\/]/).pop()
    }, null, 2));
  });
}

async function main(): Promise<void> {
  const explicitPath = process.argv[2]?.trim();
  const registered = await nativeFixtureRoleRegistered('fxr-primary');
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
