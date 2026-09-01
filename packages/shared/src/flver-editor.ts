/**
 * Sekiro FLVER2（.flver / .flver.dcx）只读模型文档 wire 类型与三页投影。
 *
 * 与 Bridge 的 read-flver-document / read-flver-mesh / read-flver-skeleton /
 * read-flver-texture-slots / read-flver-dummies 一一对应（MODEL-51A）。
 * 布局权威在 C# 侧 FlverNativeDocument.cs；这里的类型只描述 wire 形状，
 * 不维护第二套 native parser。
 *
 * 语义：unknown layout 由 authority 表达——unparsedGaps/layoutWarnings 非空时
 * authority 为 partial，上层不得把「读出来了」伪装成「完整解析」。
 * `projectFlverDocumentPages` 是纯函数，消费方用它把单个 envelope 投影成
 * mesh / material-slot / bounds 三页，不做任何 I/O。
 */

/** 无修改往返报告（read-flver-document 内嵌）。 */
export interface FlverRoundTripReport {
  byteIdentical: boolean;
  semanticIdentical: boolean;
  sourceHash: string;
  rebuiltHash: string;
  skeletonTransformCount: number;
  materialCount: number;
  boneCount: number;
  meshCount: number;
}

/** GX 列表里的一项；payload 只报长度不报内容（材质着色参数未经往返验证不解码）。 */
export interface FlverGxItemWire {
  id: string;
  unk04: number;
  itemLength: number;
  dataLength: number;
}

/** FLVER2 GX 列表。 */
export interface FlverGxListWire {
  itemCount: number;
  byteLength: number;
  terminatorId: number;
  terminatorLength: number;
  terminatorPaddingAllZero: boolean;
  items: FlverGxItemWire[];
}

/** read-flver-document envelope 里的 material 行。 */
export interface FlverMaterialWire {
  name: string;
  mtdPath: string;
  textureCount: number;
  flags: number;
  gxOffset: number;
  unk18: number;
  gxList: FlverGxListWire | null;
}

/** read-flver-document envelope 里的 bone 行。 */
export interface FlverBoneWire {
  name: string;
  parentIndex: number;
  nextSiblingIndex: number;
}

/** read-flver-document envelope 里的 mesh 行。 */
export interface FlverMeshWire {
  index: number;
  dynamic: number;
  materialIndex: number;
  defaultBoneIndex: number;
  vertexCount: number;
  vertexStride: number;
  bufferLayoutIndex: number;
  faceSetCount: number;
  boneCount: number;
  indexFormat: number;
}

/** read-flver-document envelope 里的 buffer layout 行（semantic/type 为 "0x.." 字符串）。 */
export interface FlverBufferLayoutWire {
  index: number;
  members: Array<{
    unk00: number;
    structOffset: number;
    type: string;
    semantic: string;
    index: number;
  }>;
}

/** read-flver-texture-slots / envelope 里的 texture slot 行（material-slot page）。 */
export interface FlverTextureSlotWire {
  index: number;
  type: string;
  path: string;
  materialIndex: number;
}

/** read-flver-document 的完整 envelope。 */
export interface FlverDocument {
  format: 'FLVER';
  version: string;
  internalVersion: string;
  sourceSize: number;
  sourceHash: string;
  skeletonTransformCount: number;
  materialCount: number;
  boneCount: number;
  vertexBufferCount: number;
  meshCount: number;
  faceSetCount: number;
  bufferLayoutCount: number;
  textureCount: number;
  faceCount: number;
  totalFaceCount: number;
  vertexStride: number;
  vertexStrides: number[];
  unicode: boolean;
  boundingBox?: { min: number[]; max: number[] };
  materials?: FlverMaterialWire[];
  materialsTruncated: boolean;
  bones?: FlverBoneWire[];
  bonesTruncated: boolean;
  meshes?: FlverMeshWire[];
  meshesTruncated: boolean;
  bufferLayouts?: FlverBufferLayoutWire[];
  textureSlots?: FlverTextureSlotWire[];
  texturesTruncated: boolean;
  layoutWarnings: string[];
  unparsedGaps: string[];
  roundTrip: FlverRoundTripReport;
  authority: 'native-verified' | 'candidate' | 'fixture-confirmed' | 'unsupported' | 'partial';
}

/** read-flver-mesh 的响应（顶点/索引数据 base64）。 */
export interface FlverMeshData {
  meshIndex: number;
  vertexCount: number;
  vertexStride: number;
  bufferLayoutIndex: number;
  materialIndex: number;
  indexFormat: number;
  positionsBase64: string | null;
  indicesBase64: string | null;
  uvsBase64: string | null;
  normalsBase64: string | null;
  boneWeightsBase64: string | null;
  boneIndicesBase64: string | null;
  textureStatus?: 'ready' | 'missing' | undefined;
  textureMaterialName?: string | null | undefined;
  textureName?: string | null | undefined;
  texturePreviewToken?: string | null | undefined;
  textureWidth?: number | null | undefined;
  textureHeight?: number | null | undefined;
  textureColorSpace?: string | null | undefined;
}

/** read-flver-skeleton 的响应。 */
export interface FlverSkeletonData {
  boneCount: number;
  bones: Array<{
    index: number;
    name: string;
    parentIndex: number;
    nextSiblingIndex: number;
    translation: [number, number, number];
    rotation: [number, number, number];
  }>;
}

/** read-flver-dummies 的响应。 */
export interface FlverDummiesData {
  dummyCount: number;
  dummies: Array<{
    index: number;
    position: [number, number, number];
    referenceId: number;
    parentBoneIndex: number;
    attachBoneIndex: number;
  }>;
}

/** read-flver-texture-slots 的响应。 */
export interface FlverTextureSlotsData {
  textureCount: number;
  textures: FlverTextureSlotWire[];
}

/** bounds page：把 boundingBox 投影成可直接消费的几何量。 */
export interface FlverBoundsPage {
  min: [number, number, number];
  max: [number, number, number];
  extent: [number, number, number];
}

/** mesh page：网格列表 + 截断元数据。 */
export interface FlverMeshPage {
  meshCount: number;
  meshes: FlverMeshWire[];
  meshesTruncated: boolean;
}

/** material-slot page：纹理槽 + 所属材质。 */
export interface FlverMaterialSlotPage {
  textureCount: number;
  textures: FlverTextureSlotWire[];
  texturesTruncated: boolean;
  materials: FlverMaterialWire[];
}

/** 单个 FLVER envelope 投影出的三页。 */
export interface FlverDocumentPages {
  bounds: FlverBoundsPage;
  meshes: FlverMeshPage;
  materialSlots: FlverMaterialSlotPage;
}

/** 把 read-flver-document envelope 投影成三页。纯函数，不吞异常、不做 I/O。 */
export function projectFlverDocumentPages(doc: FlverDocument): FlverDocumentPages {
  const min: [number, number, number] = doc.boundingBox?.min
    ? [doc.boundingBox.min[0] ?? 0, doc.boundingBox.min[1] ?? 0, doc.boundingBox.min[2] ?? 0]
    : [0, 0, 0];
  const max: [number, number, number] = doc.boundingBox?.max
    ? [doc.boundingBox.max[0] ?? 0, doc.boundingBox.max[1] ?? 0, doc.boundingBox.max[2] ?? 0]
    : [0, 0, 0];
  return {
    bounds: {
      min,
      max,
      extent: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    },
    meshes: {
      meshCount: doc.meshCount,
      meshes: doc.meshes ?? [],
      meshesTruncated: doc.meshesTruncated,
    },
    materialSlots: {
      textureCount: doc.textureCount,
      textures: doc.textureSlots ?? [],
      texturesTruncated: doc.texturesTruncated,
      materials: doc.materials ?? [],
    },
  };
}

/** 窄守卫：判读一个 read-flver-document 响应是不是 FlverDocument。 */
export function isFlverDocument(value: unknown): value is FlverDocument {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.format === 'FLVER' && typeof v.sourceHash === 'string' && typeof v.authority === 'string';
}
