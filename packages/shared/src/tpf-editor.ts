/**
 * Sekiro TPF（.tpf / .tpf.dcx，Texture Package File）只读纹理包文档 wire 类型
 * 与投影（TEXTURE-52A）。与 Bridge 的 read-tpf-document / read-tpf-texture-preview
 * 一一对应。
 *
 * 布局权威在 C# 侧 TpfNativeDocument.cs；这里的类型只描述 wire 形状，
 * 不维护第二套 native parser。
 *
 * 语义：
 *  - authority 只在所有纹理都含合法 DDS 头且宽高>0 时为 native-verified，
 *    否则 partial——上层不得把「读出来了」伪装成「完整解析」。
 *  - texture.format 是 TPF 条目表 formatByte 经 FormatName 查表的结果，
 *    **不是真实像素格式**（真实格式在 DDS 头里，见 ddsFourCC）。消费方展示
 *    格式时必须两者分开，不能把查表结果当像素格式上报。
 *  - rebuildCoverage 表达无修改重建的条件性无损：uncoveredNonZeroBytes>0 时
 *    roundTrip.byteIdentical 必然为 false，那是源文件里未覆盖区非零的事实，
 *    不是解析缺陷。
 *
 * `projectTpfDocumentPages` 是纯函数，消费方用它把单个 envelope 投影成
 * texture list / summary 两页，不做任何 I/O。
 */

/** 无修改往返报告（read-tpf-document 内嵌）。 */
export interface TpfRoundTripReport {
  byteIdentical: boolean;
  semanticIdentical: boolean;
  sourceHash: string;
  rebuiltHash: string;
  textureCount: number;
}

/** Rebuild 的覆盖面报告（read-tpf-document 内嵌）。 */
export interface TpfRebuildCoverage {
  uncoveredBytes: number;
  uncoveredNonZeroBytes: number;
  /** 第一处非零未覆盖字节偏移；全零时为 -1。 */
  firstNonZeroOffset: number;
}

/** read-tpf-document envelope 里的纹理行。 */
export interface TpfTextureWire {
  index: number;
  name: string;
  /** 条目表 formatByte 查表结果（"BC1"/"BC4"/"0x.."），**不是**真实像素格式。 */
  format: string;
  formatByte: number;
  mipCount: number;
  dataOffset: number;
  dataSize: number;
  width: number;
  height: number;
  /** DDS 头里的 fourCC（"DX10"/"DXT1"/"ATI1"/…），真实封装形态。 */
  ddsFourCC: string;
}

/** read-tpf-document 的完整 envelope。 */
export interface TpfDocument {
  format: 'TPF';
  sourceSize: number;
  sourceHash: string;
  textureCount: number;
  dataLength: number;
  platform: number;
  encoding: number;
  flags: number;
  textures?: TpfTextureWire[];
  roundTrip: TpfRoundTripReport;
  rebuildCoverage: TpfRebuildCoverage;
  authority: 'native-verified' | 'candidate' | 'fixture-confirmed' | 'unsupported' | 'partial';
}

/** read-tpf-texture-preview 的响应（受界 PNG 数据 URI，不落盘）。 */
export interface TpfTexturePreview {
  textureIndex: number;
  name: string;
  /** 预览图的尺寸（受 512 边长上限下采样后）。 */
  width: number;
  height: number;
  /** 原始 DDS 尺寸（预览下采样前的真实分辨率）。 */
  sourceWidth: number;
  sourceHeight: number;
  /** DDS 声明的色彩空间；非 DX10 fourCC 形态不携带该信息时为 unknown。 */
  colorSpace: 'srgb' | 'linear' | 'unknown';
  mediaType: 'image/png';
  byteLength: number;
  /** data:image/png;base64,… */
  previewToken: string;
}

/** texture list page：纹理列表 + 截断元数据。 */
export interface TpfTexturePage {
  textureCount: number;
  textures: TpfTextureWire[];
  authority: string;
}

/** summary page：容器头 + 往返/覆盖面报告。 */
export interface TpfSummaryPage {
  sourceSize: number;
  sourceHash: string;
  dataLength: number;
  platform: number;
  encoding: number;
  flags: number;
  roundTrip: TpfRoundTripReport;
  rebuildCoverage: TpfRebuildCoverage;
  authority: string;
}

/** 单个 TPF envelope 投影出的两页。 */
export interface TpfDocumentPages {
  textures: TpfTexturePage;
  summary: TpfSummaryPage;
}

/** 把 read-tpf-document envelope 投影成两页。纯函数，不吞异常、不做 I/O。 */
export function projectTpfDocumentPages(doc: TpfDocument): TpfDocumentPages {
  return {
    textures: {
      textureCount: doc.textureCount,
      textures: doc.textures ?? [],
      authority: doc.authority,
    },
    summary: {
      sourceSize: doc.sourceSize,
      sourceHash: doc.sourceHash,
      dataLength: doc.dataLength,
      platform: doc.platform,
      encoding: doc.encoding,
      flags: doc.flags,
      roundTrip: doc.roundTrip,
      rebuildCoverage: doc.rebuildCoverage,
      authority: doc.authority,
    },
  };
}

/** 窄守卫：判读一个 read-tpf-document 响应是不是 TpfDocument。 */
export function isTpfDocument(value: unknown): value is TpfDocument {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.format === 'TPF' && typeof v.sourceHash === 'string' && typeof v.authority === 'string';
}

/** 纹理稳定 ID，与 tpf-texture-replace mutation 的 textureStableId 同构。 */
export function tpfTextureStableId(index: number): string {
  return `texture:${index}`;
}

/** 由纹理稳定 ID 还原索引；非法（非 texture:N 或 N 非整数）返回 null。 */
export function tpfTextureIndexFromStableId(stableId: string): number | null {
  if (typeof stableId !== 'string') return null;
  const prefix = 'texture:';
  if (!stableId.startsWith(prefix)) return null;
  const rest = stableId.slice(prefix.length);
  if (!/^\d+$/.test(rest)) return null;
  return Number(rest);
}
