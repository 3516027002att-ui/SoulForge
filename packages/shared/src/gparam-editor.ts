/**
 * Sekiro GPARAM（.gparam / .gparam.dcx）typed 文档类型。
 *
 * 与 Bridge 的 read-gparam-document envelope 一一对应（GPARAM-11A）。
 * 布局权威在 C# 侧 GparamNativeDocument.cs；这里的类型只描述 wire 形状，
 * 不维护第二套 native parser。
 *
 * 值语义：values 里 byte/short/int/float 都是 number（double），
 * bool 是 0/1，byte4 是 4 个 0-255，float2/3/4 是 2/3/4 个 f32。
 */

/** GPARAM 值类型名（与 Bridge GparamValueTypeSizes 的名称一致）。 */
export type GparamValueTypeName =
  | 'byte'
  | 'short'
  | 'int'
  | 'bool'
  | 'float'
  | 'float2'
  | 'float3'
  | 'float4'
  | 'byte4';

/** 单个 param：同一组值控制同一图形参数的多个情景。 */
export interface GparamParamDocument {
  /** group 内序号，稳定。 */
  paramId: number;
  /** 具体名（如 "Directional Light Angle0"）。 */
  name1: string;
  /** 通用名（如 "Angle"）。 */
  name2: string;
  type: GparamValueTypeName;
  /** 原始类型码（SoulsFormats ParamType 数值）。 */
  typeCode: number;
  valueCount: number;
  /** 解码后的值，长度 = valueCount × 分量数（float2/3/4/byte4 展开）。 */
  values: number[];
  /** 每值一个 ID（Sekiro 区每值 i32+f32 中的 i32）。 */
  valueIds: number[];
  /** 每值一个未知 f32（Sekiro 特有）。 */
  unkFloats: number[];
}

/** 一个 group（Smithbox 的编辑面板）。 */
export interface GparamGroupDocument {
  groupId: number;
  /** 面板名（如 "LightSet ParamEditor"）。 */
  name1: string;
  /** 短名（如 "LightSet"）。 */
  name2: string;
  paramCount: number;
  comments: string[];
  /** 单 group 的 param 预览上限（超限时 UI 应分页，字段仍有 valueCount 元数据）。 */
  paramPreviewLimit: number;
  params: GparamParamDocument[];
}

/** 无修改往返报告。 */
export interface GparamRoundTripReport {
  byteIdentical: boolean;
  semanticIdentical: boolean;
  sourceHash: string;
  rebuiltHash: string;
  groupCount: number;
  paramCount: number;
  valueCount: number;
  note: string | null;
}

/** read-gparam-document 的完整 envelope（分组分页）。 */
export interface GparamDocument {
  format: 'GPARAM';
  game: 'sekiro';
  gameCode: number;
  groupCount: number;
  unk14: number;
  unk50: number;
  unk0D: boolean;
  unk3Count: number;
  sourceSize: number;
  sourceHash: string;
  groups: GparamGroupDocument[];
  /** 分页元数据：请求的页与每页大小。 */
  groupPage: number;
  groupPageSize: number;
  groupPageCount: number;
  groupsTruncated: boolean;
  roundTrip: GparamRoundTripReport;
  authority: 'native-verified' | 'candidate' | 'fixture-confirmed' | 'unsupported';
  fieldLayout: 'typed-gparam-values';
}
