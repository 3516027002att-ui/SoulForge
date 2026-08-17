/**
 * Sekiro FXR3（.fxr / ffxbnd.dcx 子项，FFX particle effect）只读文档 wire 类型
 * 与三页投影（VFX-54A）。与 Bridge 的 read-fxr-document 一一对应。
 *
 * 布局权威在 C# 侧 FxrNativeDocument.cs；这里的类型只描述 wire 形状，
 * 不维护第二套 native parser。
 *
 * 语义：
 *  - authority 上限是 candidate（无 writer、Section11 无 schema、Section9 /
 *    Section12-14 未在真实样本验证）；真实语料恒为 partial——发现未识别 node
 *    type 或 Section11 有数据时 C# 侧登记 unparsedGaps 并降 partial，
 *    上层不得把「读出来了」伪装成「完整解析」。
 *  - `unparsedGaps` 表达**能力边界**（本版没读/没验证），`layoutWarnings`
 *    表达**数据可疑**（读到的东西不对）。两者都会压 authority，但处置方向相反。
 *  - Section11 值是混合 int/float 位模式的 int32，无 schema，C# 按不透明
 *    int 数组上报；消费方不得据值做类型推断。
 *
 * `projectFxrDocumentPages` 是纯函数，消费方用它把单个 envelope 投影成
 * effect / nodes / fields 三页，不做任何 I/O。
 */

/** 无修改往返报告（read-fxr-document 内嵌）。只证明重复解析确定性，不构成解析完整性声明。 */
export interface FxrRoundTripReport {
  consistent: boolean;
  sourceHash: string;
  reparsedHash: string;
  nodeCount: number;
  propertyCount: number;
  section11ValueCount: number;
  note?: string | null;
}

/** 文件头声明的各节计数（declared）。实解析量见 FxrDocument.hostCount/propertyCount/...。 */
export interface FxrSectionCounts {
  section1: number;
  section2: number;
  section3: number;
  section4: number;
  section5: number;
  section6: number;
  section7: number;
  section8: number;
  section9: number;
  section10: number;
  section11: number;
  section12: number;
  section13: number;
  section14: number;
}

/** Section4 递归树节点投影。children 递归展开（bounded）。 */
export interface FxrNodeWire {
  typeId: number;
  childCount: number;
  /** 本节点直接引用的 Section6（FFXDrawEntityHost）数量。 */
  drawEntityCount: number;
  /** 本节点直接引用的 Section5（draw entity 引用块）数量。 */
  drawEntityRefCount: number;
  children: FxrNodeWire[];
  childrenTruncated: boolean;
}

/** Section9 条目（SoulsFormats 布局，121 样本全部未实测）。 */
export interface FxrSection9Wire {
  typeId: number;
  unk04: number;
  section11Count: number;
  values: number[];
}

/** Section8 条目。 */
export interface FxrSection8Wire {
  typeId: number;
  unk04: number;
  section11Count: number;
  section9Count: number;
  values: number[];
  valuesTruncated: boolean;
  section9: FxrSection9Wire[];
  section9Truncated: boolean;
}

/** Section7 = FFXProperty。 */
export interface FxrPropertyWire {
  typeId: number;
  unk04: number;
  section11Count: number;
  section8Count: number;
  values: number[];
  valuesTruncated: boolean;
  section8: FxrSection8Wire[];
  section8Truncated: boolean;
}

/** Section10 条目（→ Section11 偏移/条数）。 */
export interface FxrSection10Wire {
  section11Offset: number;
  section11Count: number;
}

/** Section6 = FFXDrawEntityHost。Properties1 与 Properties2 已合并进 properties。 */
export interface FxrHostWire {
  typeId: number;
  unk02: number;
  unk03: number;
  unk04: number;
  section11Count: number;
  section10Count: number;
  section7Count: number;
  properties: FxrPropertyWire[];
  propertiesTruncated: boolean;
  section10: FxrSection10Wire[];
  section10Truncated: boolean;
  values: number[];
  valuesTruncated: boolean;
}

/** ffxbnd 包内一条 .fxr 子项（逻辑名，禁止绝对路径）。 */
export interface FxrContainerEntry {
  entryIndex: number;
  entryName: string;
}

/** read-fxr-document 的完整 envelope。 */
export interface FxrDocument {
  format: 'FXR3';
  formatId: 'fxr';
  version: number;
  sourceSize: number;
  sourceHash: string;
  /** 资源 id（如 0x00094F00~0x00094F3E）。 */
  resourceId: number;
  rootNodeCount: number;
  totalNodeCount: number;
  /** 实解析的 Section6 host 总数（跨整棵 Section4 树）。 */
  hostCount: number;
  /** 实解析的 Section7 属性总数（Properties1+Properties2）。 */
  propertyCount: number;
  section11ValueCount: number;
  sectionCounts: FxrSectionCounts;
  effect: {
    format: 'FXR3';
    version: number;
    resourceId: number;
    rootNodeCount: number;
    nodes: FxrNodeWire[];
    nodesTruncated: boolean;
  };
  nodes: {
    total: number;
    byType: Array<{ typeId: number; count: number }>;
  };
  fields: {
    hosts: FxrHostWire[];
    hostsTruncated: boolean;
  };
  /** 能力边界（本版没读/没验证）；非空时 authority 必为 partial。 */
  unparsedGaps: string[];
  /** 数据可疑（读到的东西不对）。 */
  layoutWarnings: string[];
  roundTrip: FxrRoundTripReport;
  authority: 'native-verified' | 'candidate' | 'fixture-confirmed' | 'unsupported' | 'partial';
  /** ffxbnd 包内全部 .fxr；裸 .fxr 为空或缺省。 */
  containerEntries?: FxrContainerEntry[];
  selectedEntryIndex?: number | null;
  selectedEntryName?: string | null;
}

/** effect page：文档头 + 根节点树。 */
export interface FxrEffectPage {
  format: 'FXR3';
  version: number;
  resourceId: number;
  rootNodeCount: number;
  nodes: FxrNodeWire[];
  nodesTruncated: boolean;
  authority: string;
}

/** nodes page：全部 Section4 节点按 type 聚合。 */
export interface FxrNodesPage {
  total: number;
  byType: Array<{ typeId: number; count: number }>;
  authority: string;
}

/** fields page：host 属性树（bounded samples）。 */
export interface FxrFieldsPage {
  hosts: FxrHostWire[];
  hostsTruncated: boolean;
  authority: string;
}

/** 单个 FXR envelope 投影出的三页。 */
export interface FxrDocumentPages {
  effect: FxrEffectPage;
  nodes: FxrNodesPage;
  fields: FxrFieldsPage;
}

/** 把 read-fxr-document envelope 投影成三页。纯函数，不吞异常、不做 I/O。 */
export function projectFxrDocumentPages(doc: FxrDocument): FxrDocumentPages {
  return {
    effect: {
      format: doc.format,
      version: doc.version,
      resourceId: doc.resourceId,
      rootNodeCount: doc.rootNodeCount,
      nodes: doc.effect?.nodes ?? [],
      nodesTruncated: doc.effect?.nodesTruncated ?? false,
      authority: doc.authority,
    },
    nodes: {
      total: doc.nodes?.total ?? 0,
      byType: doc.nodes?.byType ?? [],
      authority: doc.authority,
    },
    fields: {
      hosts: doc.fields?.hosts ?? [],
      hostsTruncated: doc.fields?.hostsTruncated ?? false,
      authority: doc.authority,
    },
  };
}

/** 窄守卫：判读一个 read-fxr-document 响应是不是 FxrDocument。 */
export function isFxrDocument(value: unknown): value is FxrDocument {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.format === 'FXR3'
    && v.formatId === 'fxr'
    && typeof v.sourceHash === 'string'
    && typeof v.authority === 'string'
    && typeof v.roundTrip === 'object'
    && v.roundTrip !== null;
}
