/**
 * Sekiro MTD（.mtd / .matbin，MaTerial Definition）只读材质文档 wire 类型与三页投影。
 *
 * 与 Bridge 的 read-mtd-document 一一对应（MATERIAL-53A）。布局权威在 C# 侧
 * MtdNativeDocument.cs；这里的类型只描述 wire 形状，不维护第二套 native parser。
 *
 * 语义：
 *  - MTD 在 Sekiro 是 XML 文本材质定义；本卡只做安全 XML 结构投影（无 writer、
 *    无字节重建）。MTD schema 必须从真实字节建立、禁止推断（infer-mtd-schema
 *    永久禁令，scope.json SCOPE-ASSET-MTD），因此 authority 上限是 candidate——
 *    发现未识别 XML 元素/属性时 C# 侧登记 unparsedGaps 并降 partial，上层不得把
 *    「读出来了」伪装成「完整解析」。
 *  - `formatId` 保持 'mtd'；MATERIAL-53D 的 MATBIN read 复用同一 DTO，
 *    用 formatId: 'matbin' 区分（本卡不建 MATBIN parser，catalog 里留 Files）。
 *  - unknown property（param 的未识别属性）由 C# 原样保留在
 *    MaterialPropertyWire.unknown 里，同时进 unparsedGaps；可见但不可编辑。
 *
 * `projectMaterialDocumentPages` 是纯函数，消费方用它把单个 envelope 投影成
 * material / properties / textureReferences 三页，不做任何 I/O。
 */

/** MTD 无修改往返报告（read-mtd-document 内嵌）。只证明重复解析确定性，不构成解析完整性声明。 */
export interface MtdRoundTripReport {
  consistent: boolean;
  sourceHash: string;
  reparsedHash: string;
  paramCount: number;
  textureRefCount: number;
  note?: string | null;
}

/** read-mtd-document envelope 里的材质属性行（原 MtdParamEntry）。 */
export interface MaterialPropertyWire {
  id?: string | null;
  type?: string | null;
  name?: string | null;
  value?: string | null;
  /** param 元素上的未识别属性（原样保留）；非空时 authority 必为 partial。 */
  unknown?: Record<string, string> | null;
}

/** read-mtd-document envelope 里的纹理引用行。 */
export interface MaterialTextureRefWire {
  path?: string | null;
  type?: string | null;
  name?: string | null;
}

/** read-mtd-document 的完整 envelope。 */
export interface MtdDocument {
  format: 'MTD-XML';
  /** 'mtd' 为 MTD 只读投影；'matbin' 由 MATERIAL-53D 复用同一 DTO。 */
  formatId: 'mtd' | 'matbin';
  sourceSize: number;
  sourceHash: string;
  /** root 元素名（合法 MTD 为 material；非该名由 C# 侧登记 layoutWarnings 并在 envelope 里如实下发）。 */
  rootElement?: string | null;
  name?: string | null;
  version?: string | null;
  /** root 元素的 header 文本（若存在）。 */
  header?: string | null;
  /** 约定式 best-effort（param type="shader" 的 text），不构成 schema authority。 */
  shaderPath?: string | null;
  /** 单个 MTD 文件 = 单材质定义；复数材质容器会被 unparsedGaps 反映并降 partial。 */
  materialCount: number;
  properties?: MaterialPropertyWire[];
  propertiesTruncated: boolean;
  textureRefs?: MaterialTextureRefWire[];
  textureRefsTruncated: boolean;
  /** 未识别 XML 元素/属性；非空时 authority 必为 partial。 */
  unparsedGaps: string[];
  layoutWarnings: string[];
  roundTrip: MtdRoundTripReport;
  authority: 'native-verified' | 'candidate' | 'fixture-confirmed' | 'unsupported' | 'partial';
}

/** material page：材质头（rootElement/name/version/header/shaderPath 若可得）。 */
export interface MtdMaterialPage {
  format: 'MTD-XML';
  formatId: 'mtd' | 'matbin';
  rootElement?: string | null;
  name?: string | null;
  version?: string | null;
  header?: string | null;
  /** 约定式 best-effort（param type="shader" 的 text），不构成 schema authority。 */
  shaderPath?: string | null;
  materialCount: number;
  authority: string;
}

/** properties page：属性列表 + 截断元数据。 */
export interface MtdPropertiesPage {
  properties: MaterialPropertyWire[];
  propertiesTruncated: boolean;
  authority: string;
}

/** texture references page：纹理引用 + 截断元数据。 */
export interface MtdTextureReferencesPage {
  textureRefs: MaterialTextureRefWire[];
  textureRefsTruncated: boolean;
  authority: string;
}

/** 单个 MTD envelope 投影出的三页。 */
export interface MtdDocumentPages {
  material: MtdMaterialPage;
  properties: MtdPropertiesPage;
  textureReferences: MtdTextureReferencesPage;
}

/** 把 read-mtd-document envelope 投影成三页。纯函数，不吞异常、不做 I/O。 */
export function projectMaterialDocumentPages(doc: MtdDocument): MtdDocumentPages {
  return {
    material: {
      format: doc.format,
      formatId: doc.formatId,
      rootElement: doc.rootElement ?? null,
      name: doc.name ?? null,
      version: doc.version ?? null,
      header: doc.header ?? null,
      shaderPath: doc.shaderPath ?? null,
      materialCount: doc.materialCount,
      authority: doc.authority,
    },
    properties: {
      properties: doc.properties ?? [],
      propertiesTruncated: doc.propertiesTruncated,
      authority: doc.authority,
    },
    textureReferences: {
      textureRefs: doc.textureRefs ?? [],
      textureRefsTruncated: doc.textureRefsTruncated,
      authority: doc.authority,
    },
  };
}

/** 窄守卫：判读一个 read-mtd-document 响应是不是 MtdDocument。 */
export function isMtdDocument(value: unknown): value is MtdDocument {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.format === 'MTD-XML'
    && (v.formatId === 'mtd' || v.formatId === 'matbin')
    && typeof v.sourceHash === 'string'
    && typeof v.authority === 'string';
}
