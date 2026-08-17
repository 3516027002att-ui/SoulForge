/**
 * Native FXR smoke（VFX-54A）：read-fxr-document 三页投影（effect/node/field）。
 *
 * 路径 A（真实语料）：registry 已登记 fxr-primary → 真实读，断言三页 wire 形状
 * 与 authority ∈ {candidate, partial, fixture-confirmed}。FXR 是 ffxbnd.dcx
 * 容器内子项，容器路径先经 extract-bnd4-child 提取子项，再 read-fxr-document。
 * 未识别的 node type / Section11 无 schema 由 C# 侧 unparsedGaps 反映并降 partial，
 * smoke 不把「读出来了」冒充「完整解析」。
 *
 * 路径 B（合成 fixture）：registry 未登记 → 用微小、合法、显式 syntheticFixture
 * 标记的合成 FXR3 文件（Section1→2→3 链 + Section4 树 + Section6 host +
 * Section7 属性 + Section8 条目 + Section11 不透明值）跑 read-fxr-document，
 * 断言三页形状 + roundTrip.consistent + unparsedGaps 如实。合成语料所有 node
 * type 都在闭集，因此**不应**出现 unknown-type gap；但 Section11 有数据 + Section12-14
 * 恒空，authority 因此恒为 partial——这是如实结论，不是解析缺陷。
 *
 * 缺语料处置：FXR 在真实 corpus 中未登记是合法状态（本机 ffxbnd 语料未登记），
 * 此时走路径 B 而非静默 skip——合成 fixture 仍真实经过 C# FxrNativeDocument
 * 验证三页投影，不冒充 native authority（syntheticFixture: true）。
 *
 * 运行需要已构建的 Bridge daemon（read-fxr-document 由 C# 服务；TS 不维护
 * 第二套 production native parser）。
 *
 * 注意：read-fxr-document 尚未加入 BridgeCommand TS union（由后续 IPC 接线卡
 * MODEL-51A 补齐），这里用显式断言标记的 cast 绕过类型检查，接线完成后应移除。
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { nativeFixtureRoleRegistered, resolveNativeFixture } from './nativeFixtureRegistry.js';
import { classifyChildExtract, reportInfrastructureFailure } from './nativeFixtureExtract.js';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';

/**
 * read-fxr-document（VFX-54A）。已在 BridgeCommand TS union 中（主会话 IPC 接线补齐）。
 */
const FX_READ_COMMAND = 'read-fxr-document' as const;

interface FxrRoundTrip {
  consistent?: boolean;
  sourceHash?: string;
  reparsedHash?: string;
  nodeCount?: number;
  propertyCount?: number;
  section11ValueCount?: number;
  note?: string | null;
}

interface FxrSectionCounts {
  section1?: number;
  section2?: number;
  section3?: number;
  section4?: number;
  section5?: number;
  section6?: number;
  section7?: number;
  section8?: number;
  section9?: number;
  section10?: number;
  section11?: number;
  section12?: number;
  section13?: number;
  section14?: number;
}

interface FxrNodeWire {
  typeId?: number;
  childCount?: number;
  drawEntityCount?: number;
  drawEntityRefCount?: number;
  children?: FxrNodeWire[];
  childrenTruncated?: boolean;
}

interface FxrSection8Wire {
  typeId?: number;
  unk04?: number;
  section11Count?: number;
  section9Count?: number;
  values?: number[];
  valuesTruncated?: boolean;
  section9?: Array<{ typeId?: number; unk04?: number; section11Count?: number; values?: number[] }>;
  section9Truncated?: boolean;
}

interface FxrPropertyWire {
  typeId?: number;
  unk04?: number;
  section11Count?: number;
  section8Count?: number;
  values?: number[];
  valuesTruncated?: boolean;
  section8?: FxrSection8Wire[];
  section8Truncated?: boolean;
}

interface FxrHostWire {
  typeId?: number;
  unk02?: number;
  unk03?: number;
  unk04?: number;
  section11Count?: number;
  section10Count?: number;
  section7Count?: number;
  properties?: FxrPropertyWire[];
  propertiesTruncated?: boolean;
  section10?: Array<{ section11Offset?: number; section11Count?: number }>;
  section10Truncated?: boolean;
  values?: number[];
  valuesTruncated?: boolean;
}

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
  sectionCounts?: FxrSectionCounts;
  effect?: {
    format?: string;
    version?: number;
    resourceId?: number;
    rootNodeCount?: number;
    nodes?: FxrNodeWire[];
    nodesTruncated?: boolean;
  };
  nodes?: {
    total?: number;
    byType?: Array<{ typeId?: number; count?: number }>;
  };
  fields?: {
    hosts?: FxrHostWire[];
    hostsTruncated?: boolean;
  };
  unparsedGaps?: string[];
  layoutWarnings?: string[];
  roundTrip?: FxrRoundTrip;
  authority?: string;
}

/**
 * 构造一个微小、合法、显式 syntheticFixture 标记的合成 FXR3 文件。
 *
 * 布局严格按逆向结论：文件头 0x90，Section1(1)→Section2(1)→Section3(1) 链，
 * Section4 根节点(1) → Section6 host(1) → Section7 属性(1) → Section8 条目(1)，
 * Section11 共 8 个 Int32。所有 node type 取闭集内值（2000/0/0/0xD050），
 * 保证「干净」——不触发 unknown-type gap。
 */
function buildSyntheticFxr(): Uint8Array {
  const size = 0x1E8; // 488 字节
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
  // 0x24..0x34 ×5 = 0
  i32(0x0B0 + 0x38, 0x0100FFFC); // Unk38
  i32(0x0B0 + 0x3C, 0);
  i32(0x0B0 + 0x40, 1);
  i32(0x0B0 + 0x44, 0);
  i32(0x0B0 + 0x48, 0x1CC); // section11Offset2 → 1 个 Int32
  // 0x4C..0x5C ×5 = 0

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
  // 0x34..0x3C ×3 = 0

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

/**
 * 根 + 紧随其后的孩子、section4Count≥2。
 * 旧实现把每个槽都当根再递归孩子，0x140 会被判成假环。
 */
function buildSyntheticFxrWithAdjacentChild(): Uint8Array {
  const size = 0x218;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  const u16 = (o: number, v: number): void => view.setUint16(o, v, true);
  const i16 = (o: number, v: number): void => view.setInt16(o, v, true);
  const u32 = (o: number, v: number): void => view.setUint32(o, v, true);
  const i32 = (o: number, v: number): void => view.setInt32(o, v, true);

  buf.set([0x46, 0x58, 0x52, 0x00], 0x00);
  i16(0x04, 0);
  u16(0x06, 5);
  i32(0x08, 1);
  i32(0x0C, 0x00094F00);
  i32(0x10, 0x090); i32(0x14, 1);
  i32(0x18, 0x0A0); i32(0x1C, 1);
  i32(0x20, 0x0B0); i32(0x24, 1);
  i32(0x28, 0x110); i32(0x2C, 2); // Section4 两槽：根 + 孩子
  i32(0x30, 0x000); i32(0x34, 0);
  i32(0x38, 0x170); i32(0x3C, 1);
  i32(0x40, 0x1B0); i32(0x44, 1);
  i32(0x48, 0x1D8); i32(0x4C, 1);
  i32(0x50, 0x000); i32(0x54, 0);
  i32(0x58, 0x000); i32(0x5C, 0);
  i32(0x60, 0x1F8); i32(0x64, 8);
  i32(0x68, 1);
  i32(0x6C, 0);
  i32(0x70, 0x000); i32(0x74, 0);
  i32(0x78, 0x000); i32(0x7C, 0);
  i32(0x80, 0x000); i32(0x84, 0);
  i32(0x88, 0);
  i32(0x8C, 0);

  i32(0x090 + 0x00, 0);
  i32(0x090 + 0x04, 1);
  i32(0x090 + 0x08, 0x0A0);
  i32(0x090 + 0x0C, 0);

  i32(0x0A0 + 0x00, 0);
  i32(0x0A0 + 0x04, 1);
  i32(0x0A0 + 0x08, 0x0B0);
  i32(0x0A0 + 0x0C, 0);

  i16(0x0B0 + 0x00, 11);
  buf[0x0B0 + 0x02] = 0;
  buf[0x0B0 + 0x03] = 1;
  i32(0x0B0 + 0x04, 0);
  i32(0x0B0 + 0x08, -1);
  i32(0x0B0 + 0x0C, 0);
  i32(0x0B0 + 0x10, 0x0100FFFC);
  i32(0x0B0 + 0x14, 0);
  i32(0x0B0 + 0x18, 1);
  i32(0x0B0 + 0x1C, 0);
  i32(0x0B0 + 0x20, 0x1F8);
  i32(0x0B0 + 0x38, 0x0100FFFC);
  i32(0x0B0 + 0x3C, 0);
  i32(0x0B0 + 0x40, 1);
  i32(0x0B0 + 0x44, 0);
  i32(0x0B0 + 0x48, 0x1FC);

  // 根 0x110：孩子紧随其后在 0x140
  i16(0x110 + 0x00, 2000);
  buf[0x110 + 0x02] = 0;
  buf[0x110 + 0x03] = 1;
  i32(0x110 + 0x04, 0);
  i32(0x110 + 0x08, 0);
  i32(0x110 + 0x0C, 1);
  i32(0x110 + 0x10, 1);
  i32(0x110 + 0x14, 0);
  i32(0x110 + 0x18, 0x000);
  i32(0x110 + 0x1C, 0);
  i32(0x110 + 0x20, 0x170);
  i32(0x110 + 0x24, 0);
  i32(0x110 + 0x28, 0x140);
  i32(0x110 + 0x2C, 0);

  // 孩子 0x140
  i16(0x140 + 0x00, 2001);
  buf[0x140 + 0x02] = 0;
  buf[0x140 + 0x03] = 1;
  i32(0x140 + 0x04, 0);
  i32(0x140 + 0x08, 0);
  i32(0x140 + 0x0C, 0);
  i32(0x140 + 0x10, 0);
  i32(0x140 + 0x14, 0);
  i32(0x140 + 0x18, 0);
  i32(0x140 + 0x1C, 0);
  i32(0x140 + 0x20, 0);
  i32(0x140 + 0x24, 0);
  i32(0x140 + 0x28, 0);
  i32(0x140 + 0x2C, 0);

  i16(0x170 + 0x00, 0);
  buf[0x170 + 0x02] = 0;
  buf[0x170 + 0x03] = 1;
  i32(0x170 + 0x04, 0);
  i32(0x170 + 0x08, 2);
  i32(0x170 + 0x0C, 0);
  i32(0x170 + 0x10, 1);
  i32(0x170 + 0x14, 0);
  i32(0x170 + 0x18, 0);
  i32(0x170 + 0x1C, 0);
  i32(0x170 + 0x20, 0x200);
  i32(0x170 + 0x24, 0);
  i32(0x170 + 0x28, 0x000);
  i32(0x170 + 0x2C, 0);
  i32(0x170 + 0x30, 0x1B0);

  i16(0x1B0 + 0x00, 0);
  buf[0x1B0 + 0x02] = 0;
  buf[0x1B0 + 0x03] = 1;
  i32(0x1B0 + 0x04, 0);
  i32(0x1B0 + 0x08, 2);
  i32(0x1B0 + 0x0C, 0);
  i32(0x1B0 + 0x10, 0x208);
  i32(0x1B0 + 0x14, 0);
  i32(0x1B0 + 0x18, 0x1D8);
  i32(0x1B0 + 0x1C, 0);
  i32(0x1B0 + 0x20, 1);
  i32(0x1B0 + 0x24, 0);

  u16(0x1D8 + 0x00, 0xD050);
  buf[0x1D8 + 0x02] = 0;
  buf[0x1D8 + 0x03] = 1;
  i32(0x1D8 + 0x04, 0);
  i32(0x1D8 + 0x08, 2);
  i32(0x1D8 + 0x0C, 0);
  i32(0x1D8 + 0x10, 0x210);
  i32(0x1D8 + 0x14, 0);
  i32(0x1D8 + 0x18, 0x000);
  i32(0x1D8 + 0x1C, 0);

  i32(0x1F8 + 0x00, 0x3F800000);
  i32(0x1F8 + 0x04, 0x40000000);
  i32(0x1F8 + 0x08, 0x00000001);
  i32(0x1F8 + 0x0C, 0x00000002);
  i32(0x1F8 + 0x10, 0x00000003);
  i32(0x1F8 + 0x14, 0x00000004);
  i32(0x1F8 + 0x18, 0x00000005);
  i32(0x1F8 + 0x1C, 0x00000006);

  return buf;
}

async function readFxr(path: string, allowedRoots: string[], oodleRuntimeRoot?: string): Promise<FxrEnvelope> {
  const result = await runBridge<FxrEnvelope>({
    command: FX_READ_COMMAND,
    filePath: path,
    allowedRoots,
    timeoutMs: 120_000,
    ...(oodleRuntimeRoot ? { oodleRuntimeRoot } : {})
  });
  if (result.parseStatus === 'failed' || !result.data) {
    throw new Error(`read-fxr-document ${path} 失败：${JSON.stringify(result.diagnostics)}`);
  }
  return result.data;
}

/** 三页 wire 形状断言（只断言形状，不断言 authority 的具体值——那由调用方按语料裁）。 */
function assertThreePages(d: FxrEnvelope): void {
  if (d.format !== 'FXR3') throw new Error(`unexpected format: ${d.format}`);
  if (d.formatId !== 'fxr') throw new Error(`unexpected formatId: ${d.formatId}`);
  if (typeof d.sourceHash !== 'string' || !d.sourceHash) throw new Error('missing source hash');
  if (typeof d.version !== 'number') throw new Error('missing version');
  if (typeof d.rootNodeCount !== 'number') throw new Error('missing rootNodeCount');
  if (!Array.isArray(d.unparsedGaps)) throw new Error('missing unparsedGaps array');
  if (!Array.isArray(d.layoutWarnings)) throw new Error('missing layoutWarnings array');
  if (!d.roundTrip || typeof d.roundTrip.consistent !== 'boolean') {
    throw new Error('missing roundTrip.consistent');
  }
  if (!d.effect || !Array.isArray(d.effect.nodes)) throw new Error('missing effect.nodes array');
  if (!d.nodes || !Array.isArray(d.nodes.byType)) throw new Error('missing nodes.byType array');
  if (!d.fields || !Array.isArray(d.fields.hosts)) throw new Error('missing fields.hosts array');
}

async function syntheticLeg(): Promise<void> {
  await withSmokeWorkspace('native-fxr-smoke', async (workspace) => {
    const syntheticPath = join(workspace.root, 'synthetic_smoke.fxr');
    await writeFile(syntheticPath, buildSyntheticFxr());
    const d = await readFxr(syntheticPath, [workspace.root]);
    assertThreePages(d);

    // 合成语料结构应如实解析出来（不是「读出来了但空壳」）。
    if (d.rootNodeCount !== 1) throw new Error(`rootNodeCount 应为 1，实际 ${d.rootNodeCount}`);
    if (d.totalNodeCount !== 1) throw new Error(`totalNodeCount 应为 1，实际 ${d.totalNodeCount}`);
    if (d.hostCount !== 1) throw new Error(`hostCount 应为 1，实际 ${d.hostCount}`);
    if (d.propertyCount !== 1) throw new Error(`propertyCount 应为 1，实际 ${d.propertyCount}`);
    if (d.section11ValueCount !== 8) throw new Error(`section11ValueCount 应为 8，实际 ${d.section11ValueCount}`);
    if (d.sectionCounts?.section11 !== 8) throw new Error(`sectionCounts.section11 应为 8，实际 ${d.sectionCounts?.section11}`);
    const rootNode = d.effect?.nodes?.[0];
    if (rootNode?.typeId !== 2000) throw new Error(`root node typeId 应为 2000，实际 ${rootNode?.typeId}`);
    const host = d.fields?.hosts?.[0];
    if (host?.typeId !== 0) throw new Error(`host typeId 应为 0，实际 ${host?.typeId}`);
    const prop = host?.properties?.[0];
    if (prop?.typeId !== 0) throw new Error(`property typeId 应为 0，实际 ${prop?.typeId}`);
    if (prop?.section8?.[0]?.typeId !== 0xD050) {
      throw new Error(`section8 typeId 应为 0xD050，实际 ${prop?.section8?.[0]?.typeId}`);
    }

    // 合成干净语料：authority 应属于 candidate/partial（Section11 无 schema +
    // Section12-14 恒空 → 恒 partial，这是如实结论，不能冒充 candidate 之上的 authority）。
    if (d.authority !== 'partial' && d.authority !== 'candidate') {
      throw new Error(`合成干净 FXR 的 authority 应属于 candidate/partial，实际 ${d.authority}`);
    }
    if (!d.roundTrip?.consistent) {
      throw new Error('合成干净 FXR 的 roundTrip.consistent 应为 true');
    }

    // unparsedGaps 如实：所有 type 都在闭集 → 无 unknown-type gap；
    // Section11 有数据 → 必须登记 section11 opacity；Section12-14 恒空 → 必须登记。
    const gaps = d.unparsedGaps ?? [];
    const unknownTypeGaps = gaps.filter((g) => g.startsWith('unknown-type:'));
    if (unknownTypeGaps.length > 0) {
      throw new Error(`合成干净 FXR 不应有 unknown-type gaps：${JSON.stringify(unknownTypeGaps)}`);
    }
    if (!gaps.some((g) => g.startsWith('section11:'))) {
      throw new Error(`合成 FXR 含 Section11 数据，unparsedGaps 应如实登记 section11 opacity：${JSON.stringify(gaps)}`);
    }
    if (!gaps.some((g) => g.includes('section12-14'))) {
      throw new Error(`合成 FXR 的 Section12-14 恒空，unparsedGaps 应如实登记 empty-samples gap：${JSON.stringify(gaps)}`);
    }

    const adjacentPath = join(workspace.root, 'synthetic_smoke_adjacent_child.fxr');
    await writeFile(adjacentPath, buildSyntheticFxrWithAdjacentChild());
    const adjacent = await readFxr(adjacentPath, [workspace.root]);
    assertThreePages(adjacent);
    if (adjacent.sectionCounts?.section4 !== 2) {
      throw new Error(`adjacent-child section4Count 应为 2，实际 ${adjacent.sectionCounts?.section4}`);
    }
    if (adjacent.rootNodeCount !== 1) {
      throw new Error(`adjacent-child rootNodeCount 应为 1，实际 ${adjacent.rootNodeCount}`);
    }
    if (adjacent.totalNodeCount !== 2) {
      throw new Error(`adjacent-child totalNodeCount 应为 2，实际 ${adjacent.totalNodeCount}`);
    }
    const adjacentRoot = adjacent.effect?.nodes?.[0];
    if (adjacentRoot?.typeId !== 2000) {
      throw new Error(`adjacent-child 根 typeId 应为 2000，实际 ${adjacentRoot?.typeId}`);
    }
    if (adjacentRoot?.childCount !== 1 || adjacentRoot.children?.[0]?.typeId !== 2001) {
      throw new Error(`adjacent-child 必须解析出 type 2001 的紧随孩子，不得判假环：${JSON.stringify(adjacentRoot)}`);
    }

    console.log(JSON.stringify({
      ok: true,
      status: 'synthetic-fixture',
      syntheticFixture: true,
      fixtureRole: 'fxr-primary',
      message: `FXR synthetic fixture 读取验证通过（${d.rootNodeCount} roots, ${d.hostCount} hosts, ${d.propertyCount} properties, ${d.section11ValueCount} section11 values；adjacent-child roots=${adjacent.rootNodeCount} nodes=${adjacent.totalNodeCount}）`,
      format: d.format,
      version: d.version,
      resourceId: d.resourceId,
      rootNodeCount: d.rootNodeCount,
      totalNodeCount: d.totalNodeCount,
      hostCount: d.hostCount,
      propertyCount: d.propertyCount,
      section11ValueCount: d.section11ValueCount,
      rootNodeTypeId: rootNode?.typeId,
      hostTypeId: host?.typeId,
      propertyTypeId: prop?.typeId,
      section8TypeId: prop?.section8?.[0]?.typeId,
      unparsedGaps: d.unparsedGaps,
      layoutWarnings: d.layoutWarnings,
      authority: d.authority,
      roundTrip: d.roundTrip
    }, null, 2));
  });
}

async function corpusLeg(explicitPath: string | undefined): Promise<void> {
  const source = await resolveNativeFixture(
    explicitPath,
    'fxr-primary',
    '../../mods/sfx/ffxbnd.dcx'
  );

  // FXR 是 ffxbnd.dcx 容器内子项；容器路径先提取子项再读。
  const isContainer = source.endsWith('.dcx') || source.endsWith('.bnd');
  let fxrPath = source;
  if (isContainer) {
    const tmpDir = process.env.SOULFORGE_SCRATCH ?? (await import('node:os')).tmpdir();
    const { mkdirSync } = await import('node:fs');
    mkdirSync(tmpDir, { recursive: true });
    fxrPath = join(tmpDir, `soulforge-fxr-smoke-${Date.now()}.fxr`);
    const gameRoot = process.env.SOULFORGE_SEKIRO_GAME_ROOT ?? process.env.SOULFORGE_NATIVE_FIXTURE_ROOT;

    const extract = await runBridge<{ contentSize?: number }>({
      command: 'extract-bnd4-child',
      filePath: source,
      allowedRoots: [source.replace(/[/\\][^/\\]+$/, '')],
      writableRoots: [tmpDir],
      commandOptions: { entryIndex: 0, outputPath: fxrPath },
      timeoutMs: 120_000,
      ...(gameRoot ? { oodleRuntimeRoot: gameRoot } : {})
    });
    // 「缺语料」与「环境/基础设施坏了」必须区分（硬约束 7）。判定逻辑与理由见
    // nativeFixtureExtract.ts —— TPF/TAE smoke 用同一份，不各写一遍。
    const verdict = classifyChildExtract(extract);
    if (verdict.kind === 'infrastructure-failure') {
      reportInfrastructureFailure('FXR', 'FXR_FIXTURE_EXTRACT_INFRASTRUCTURE_FAILURE', verdict);
      await disposeBridgeDaemonPool();
      return;
    }
    if (verdict.kind === 'missing-child') {
      console.log(JSON.stringify({
        ok: true,
        status: 'skipped',
        message: 'FXR fixture not available in container (子项不存在).',
        diagnostics: verdict.codes
      }));
      await disposeBridgeDaemonPool();
      return;
    }
  }

  const d = await readFxr(fxrPath, [fxrPath.replace(/[/\\][^/\\]+$/, '')]);
  assertThreePages(d);
  const allowed = new Set(['candidate', 'partial', 'fixture-confirmed']);
  if (d.authority === undefined || !allowed.has(d.authority)) {
    throw new Error(`真实语料 authority 应属于 ${[...allowed].join('/')}，实际 ${d.authority}`);
  }

  console.log(JSON.stringify({
    ok: true,
    syntheticFixture: false,
    message: `FXR native 读取验证通过（${d.rootNodeCount} roots, ${d.hostCount} hosts, ${d.propertyCount} properties, ${d.section11ValueCount} section11 values）`,
    format: d.format,
    version: d.version,
    resourceId: d.resourceId,
    rootNodeCount: d.rootNodeCount,
    totalNodeCount: d.totalNodeCount,
    hostCount: d.hostCount,
    propertyCount: d.propertyCount,
    section11ValueCount: d.section11ValueCount,
    nodeTypes: d.nodes?.byType,
    unparsedGaps: d.unparsedGaps,
    layoutWarnings: d.layoutWarnings,
    authority: d.authority,
    roundTrip: d.roundTrip
  }, null, 2));
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
