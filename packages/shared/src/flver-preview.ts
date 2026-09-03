import type { Diagnostic } from './types.js';

export type FlverRotationOrder = 'XZY';
export type FlverSkinningMode = 'weighted' | 'rigid' | 'static';
/**
 * Generic albedo preview cannot reproduce native projected-decal materials.
 * A compatibility-projected mesh is a separate, explicit read-only path for
 * a verified assembly mapping; it is not a generic fallback for native decal
 * materials.
 */
export type FlverPreviewRenderMode = 'surface' | 'projected-decal' | 'compatibility-projected';
export type FlverPreviewVertexColorStatus =
  'absent' | 'decoded' | 'unsupported' | 'truncated' | 'invalid';
export type FlverPreviewVertexColorLayoutName = 'Float4' | 'Color' | 'UByte4Norm';

/** 一个原生 VertexColor member 的完整 RGBA 只读诊断。 */
export interface FlverPreviewVertexColorDiagnostic {
  memberOrdinal: number;
  memberIndex: number;
  /** SoulsFormats LayoutType numeric value: Float4=3, Color=16, UByte4Norm=19. */
  layoutType: number;
  layoutTypeName: FlverPreviewVertexColorLayoutName;
  vertexBufferIndex: number;
  bufferLayoutIndex: number;
  structOffset: number;
  /** Little-endian float[4] RGBA, base64 encoded per vertex. */
  rgbaBase64: string;
}

export interface FlverContainerEntryIdentity {
  index: number;
  id: number;
  name: string;
  duplicateOrdinal: number;
  contentHash: string;
}

export interface FlverPreviewBone {
  index: number;
  name: string;
  parentIndex: number;
  childIndex: number;
  nextSiblingIndex: number;
  /** Parent-chain identity; duplicate sibling names carry an occurrence ordinal. */
  hierarchyId: string;
  translation: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  rotationOrder: FlverRotationOrder;
}

export interface FlverPreviewMesh {
  meshIndex: number;
  /** FLVER material table index; -1 means the native mesh has no valid material. */
  materialIndex?: number | undefined;
  vertexCount: number;
  indexSize: 16 | 32;
  positionsBase64: string;
  indicesBase64: string;
  uvsBase64?: string | undefined;
  /** 全部原生 UV 组；UVPair/Short4 等一个 member 展开为多组。 */
  uvSetsBase64?: string[] | undefined;
  normalsBase64?: string | undefined;
  /** 所有原生 VertexColor member 的 RGBA，只读诊断；失败时不返回部分结果。 */
  vertexColorStatus?: FlverPreviewVertexColorStatus | undefined;
  vertexColorFailure?: string | undefined;
  vertexColorDiagnostics?: FlverPreviewVertexColorDiagnostic[] | undefined;
  /** 兼容字段：首个 VertexColor 的 alpha，绝不是全局透明度。 */
  vertexAlphaBase64?: string | undefined;
  /** Selected native FaceSet.CullBackfaces; undefined means no display FaceSet. */
  cullBackfaces?: boolean | undefined;
  /** Explicit compatibility-only projection source; native decal identity stays separate. */
  projectionTextureName?: string | null | undefined;
  projectionTexturePreviewToken?: string | null | undefined;
  projectionTextureColorSpace?: string | null | undefined;
  boneWeightsBase64?: string | undefined;
  boneIndicesBase64?: string | undefined;
  skinningMode: FlverSkinningMode;
  boneIndexSpace: 'flver-global' | 'none';
  /**
   * Native FLVER mesh.Dynamic contract. Dynamic==0 is rendered by mature
   * viewers with absolute reference-pose bone matrices; dynamic meshes use
   * the conventional inverse-bind delta path.
   */
  skinningTransformMode?: 'absolute' | 'delta' | undefined;
  /**
   * Original part-local skin indices retained when a character part is
   * assembled through a follower skeleton. `boneIndicesBase64` remains the
   * leader-space compatibility projection for existing callers, while the
   * renderer uses this source payload with the part's own bind inverses.
   */
  sourceBoneIndicesBase64?: string | undefined;
  skeletonId?: string | undefined;
  renderMode?: FlverPreviewRenderMode | undefined;
}

export interface FlverPreviewModel {
  modelId: string;
  entry: FlverContainerEntryIdentity;
  meshCount: number;
  boneCount: number;
  meshes: FlverPreviewMesh[];
  bones: FlverPreviewBone[];
  /** Original part skeleton retained for follower binding in a read-only character preview. */
  bindingBones?: FlverPreviewBone[] | undefined;
  /** Source FLVER bone index -> leader bone index; -1 means intentionally unmapped/unweighted. */
  bindingBoneMap?: number[] | undefined;
  sourceRole?: 'character' | 'part' | 'map' | 'object' | undefined;
  sourceName?: string | undefined;
  /** Bridge 解析出的首个 albedo PNG data URI，供旧 renderer/调用方回退。 */
  texturePreviewToken?: string | undefined;
  textureColorSpace?: string | undefined;
  /** FLVER material index -> albedo preview. 一个 FLVER 可能同时使用多张纹理。 */
  texturePreviews?: FlverPreviewTexture[] | undefined;
}

export interface FlverPreviewTexture {
  materialIndex: number;
  textureName: string;
  texturePreviewToken: string;
  width: number;
  height: number;
  colorSpace: string;
  /** Native MTD alpha policy. AO/SSS character surfaces may use RGBA as color data, not cutout coverage. */
  alphaMode?: 'opaque' | 'cutout' | undefined;
  /** Native second diffuse/albedo layer, kept separate from the primary map. */
  albedo2?: FlverPreviewTextureLayer | undefined;
  /** Native second normal layer, if the material declares one. */
  normal2?: FlverPreviewTextureLayer | undefined;
  /** Only emitted for a source-mapped native diffuse blend configuration. */
  diffuseBlend?: FlverPreviewDiffuseBlend | undefined;
  /** Exact same-TPF companion maps; these are preview inputs, not native shader equivalence. */
  normalTextureName?: string | undefined;
  normalTexturePreviewToken?: string | undefined;
  normalTextureColorSpace?: string | undefined;
  metalnessTextureName?: string | undefined;
  metalnessTexturePreviewToken?: string | undefined;
  metalnessTextureColorSpace?: string | undefined;
  /** Native MTD Mask1 companion used by a colour-blend operation, never opacity. */
  mask1TextureName?: string | undefined;
  mask1TexturePreviewToken?: string | undefined;
  mask1TextureColorSpace?: string | undefined;
}

export interface FlverPreviewTextureLayer {
  textureName: string;
  texturePreviewToken: string;
  width: number;
  height: number;
  colorSpace: string;
}

export interface FlverPreviewDiffuseBlend {
  mode: 'multiply';
  albedo2UvIndex: number;
  blendMaskUvIndex: number;
  undefinedBlendMaskValue: number;
  enableTextureAlpha: boolean;
  multiplyBlendMaskByAlbedo2Alpha: boolean;
}

/**
 * Atomic preview payload. After explicit CharacterAssemblyContext resolution,
 * the bundle is leader-remapped: exactly one leader skeleton drives the pose.
 * Body parts retain their original bind skeleton metadata and use a follower
 * mapping so their native inverse bind matrices are not discarded. The
 * leader-space skin indices remain as a compatibility projection. Positive-
 * weight missing mapping is fail-closed. Attachments are not body parts — they
 * use explicit attachBoneName.
 */
export interface CharacterPreviewBundle {
  meshCount: number;
  vertexCount: number;
  boneCount: number;
  leaderModelId: string;
  models: FlverPreviewModel[];
  assemblyParts?: string[] | undefined;
  /** A compatibility preview is deterministic, but does not represent save-game equipment. */
  assemblyMode?: 'explicit' | 'compatibility-preview' | undefined;
}

export interface CharacterPreviewReadResult {
  ok: boolean;
  sourceUri?: string | undefined;
  relativePath?: string | undefined;
  data?: CharacterPreviewBundle | undefined;
  diagnostics: Diagnostic[];
}

export function isCharacterPreviewBundle(value: unknown): value is CharacterPreviewBundle {
  if (!isRecord(value)
    || !isNonNegativeInteger(value.meshCount)
    || !isNonNegativeInteger(value.vertexCount)
    || !isNonNegativeInteger(value.boneCount)
    || typeof value.leaderModelId !== 'string'
    || !Array.isArray(value.models)
    || (value.assemblyMode !== undefined
      && value.assemblyMode !== 'explicit'
      && value.assemblyMode !== 'compatibility-preview')
    || (value.assemblyParts !== undefined
      && (!Array.isArray(value.assemblyParts)
        || !value.assemblyParts.every((part) => typeof part === 'string')))) return false;
  return value.models.every((candidate) => {
    if (!isRecord(candidate)
      || typeof candidate.modelId !== 'string'
      || !isNonNegativeInteger(candidate.meshCount)
      || !isNonNegativeInteger(candidate.boneCount)
      || !Array.isArray(candidate.meshes)
      || !Array.isArray(candidate.bones)
      || (candidate.bindingBones !== undefined
        && (!Array.isArray(candidate.bindingBones)
          || !candidate.bindingBones.every(isPreviewBone)))
      || (candidate.bindingBoneMap !== undefined
        && (!Array.isArray(candidate.bindingBoneMap)
          || !candidate.bindingBoneMap.every((index) => Number.isInteger(index) && (index as number) >= -1)))
      || !isRecord(candidate.entry)
      || (candidate.texturePreviewToken !== undefined && typeof candidate.texturePreviewToken !== 'string')
      || (candidate.texturePreviews !== undefined
        && (!Array.isArray(candidate.texturePreviews)
          || !candidate.texturePreviews.every(isPreviewTexture)))) return false;
    const entry = candidate.entry;
    if (!isNonNegativeInteger(entry.index)
      || !Number.isInteger(entry.id)
      || typeof entry.name !== 'string'
      || !isNonNegativeInteger(entry.duplicateOrdinal)
      || typeof entry.contentHash !== 'string') return false;
    if (candidate.meshes.length !== candidate.meshCount || candidate.bones.length !== candidate.boneCount) return false;
    if ((candidate.bindingBones === undefined) !== (candidate.bindingBoneMap === undefined)) return false;
    if (candidate.bindingBones && candidate.bindingBoneMap) {
      const maxSourceIndex = candidate.bindingBones.reduce(
        (max, bone) => Math.max(max, bone.index),
        -1
      );
      if (candidate.bindingBoneMap.length <= maxSourceIndex) return false;
    }
    return candidate.meshes.every(isPreviewMesh) && candidate.bones.every(isPreviewBone);
  });
}

function isPreviewMesh(value: unknown): boolean {
  if (!isRecord(value)
    || !isNonNegativeInteger(value.meshIndex)
    || (value.materialIndex !== undefined && !Number.isInteger(value.materialIndex))
    || !isNonNegativeInteger(value.vertexCount)
    || (value.indexSize !== 16 && value.indexSize !== 32)
    || typeof value.positionsBase64 !== 'string'
    || typeof value.indicesBase64 !== 'string'
    || (value.cullBackfaces !== undefined && typeof value.cullBackfaces !== 'boolean')
    || (value.skinningMode !== 'weighted' && value.skinningMode !== 'rigid' && value.skinningMode !== 'static')
    || (value.boneIndexSpace !== 'flver-global' && value.boneIndexSpace !== 'none')
    || (value.skinningTransformMode !== undefined
      && value.skinningTransformMode !== 'absolute'
      && value.skinningTransformMode !== 'delta')
    || (value.vertexColorStatus !== undefined && !isPreviewVertexColorStatus(value.vertexColorStatus))
    || (value.renderMode !== undefined
      && value.renderMode !== 'surface'
      && value.renderMode !== 'projected-decal'
      && value.renderMode !== 'compatibility-projected')) return false;
  const optionalStrings = [
    'uvsBase64',
    'normalsBase64',
    'vertexColorFailure',
    'vertexAlphaBase64',
    'boneWeightsBase64',
    'boneIndicesBase64',
    'sourceBoneIndicesBase64',
    'skeletonId'
  ];
  if (!optionalStrings.every((key) => value[key] === undefined || typeof value[key] === 'string')) return false;
  if (value.uvSetsBase64 !== undefined
    && (!Array.isArray(value.uvSetsBase64)
      || !value.uvSetsBase64.every((set) => typeof set === 'string'))) return false;
  if (value.vertexColorDiagnostics !== undefined
    && (!Array.isArray(value.vertexColorDiagnostics)
      || !value.vertexColorDiagnostics.every(isPreviewVertexColorDiagnostic))) return false;
  return ['projectionTextureName', 'projectionTexturePreviewToken', 'projectionTextureColorSpace']
    .every((key) => value[key] === undefined || value[key] === null || typeof value[key] === 'string');
}

function isPreviewVertexColorStatus(value: unknown): value is FlverPreviewVertexColorStatus {
  return value === 'absent'
    || value === 'decoded'
    || value === 'unsupported'
    || value === 'truncated'
    || value === 'invalid';
}

function isPreviewVertexColorDiagnostic(value: unknown): value is FlverPreviewVertexColorDiagnostic {
  if (!isRecord(value)
    || !isNonNegativeInteger(value.memberOrdinal)
    || !isNonNegativeInteger(value.memberIndex)
    || !isNonNegativeInteger(value.layoutType)
    || !isNonNegativeInteger(value.vertexBufferIndex)
    || !isNonNegativeInteger(value.bufferLayoutIndex)
    || !isNonNegativeInteger(value.structOffset)
    || typeof value.rgbaBase64 !== 'string') return false;
  return (value.layoutTypeName === 'Float4' && value.layoutType === 3)
    || (value.layoutTypeName === 'Color' && value.layoutType === 16)
    || (value.layoutTypeName === 'UByte4Norm' && value.layoutType === 19);
}

function isPreviewTexture(value: unknown): boolean {
  return isRecord(value)
    && isNonNegativeInteger(value.materialIndex)
    && typeof value.textureName === 'string'
    && typeof value.texturePreviewToken === 'string'
    && isPositiveInteger(value.width)
    && isPositiveInteger(value.height)
    && typeof value.colorSpace === 'string'
    && (value.alphaMode === undefined || value.alphaMode === 'opaque' || value.alphaMode === 'cutout')
    && (value.albedo2 === undefined || isPreviewTextureLayer(value.albedo2))
    && (value.normal2 === undefined || isPreviewTextureLayer(value.normal2))
    && (value.diffuseBlend === undefined || isPreviewDiffuseBlend(value.diffuseBlend))
    && ['normalTextureName', 'normalTexturePreviewToken', 'normalTextureColorSpace',
      'metalnessTextureName', 'metalnessTexturePreviewToken', 'metalnessTextureColorSpace',
      'mask1TextureName', 'mask1TexturePreviewToken', 'mask1TextureColorSpace']
      .every((key) => value[key] === undefined || typeof value[key] === 'string');
}

function isPreviewTextureLayer(value: unknown): value is FlverPreviewTextureLayer {
  return isRecord(value)
    && typeof value.textureName === 'string'
    && typeof value.texturePreviewToken === 'string'
    && isPositiveInteger(value.width)
    && isPositiveInteger(value.height)
    && typeof value.colorSpace === 'string';
}

function isPreviewDiffuseBlend(value: unknown): value is FlverPreviewDiffuseBlend {
  return isRecord(value)
    && value.mode === 'multiply'
    && isNonNegativeInteger(value.albedo2UvIndex)
    && isNonNegativeInteger(value.blendMaskUvIndex)
    && typeof value.undefinedBlendMaskValue === 'number'
    && Number.isFinite(value.undefinedBlendMaskValue)
    && typeof value.enableTextureAlpha === 'boolean'
    && typeof value.multiplyBlendMaskByAlbedo2Alpha === 'boolean';
}

function isPreviewBone(value: unknown): boolean {
  return isRecord(value)
    && isNonNegativeInteger(value.index)
    && typeof value.name === 'string'
    && Number.isInteger(value.parentIndex)
    && Number.isInteger(value.childIndex)
    && Number.isInteger(value.nextSiblingIndex)
    && typeof value.hierarchyId === 'string'
    && isNumberTuple(value.translation, 3)
    && isNumberTuple(value.rotation, 3)
    && isNumberTuple(value.scale, 3)
    && value.rotationOrder === 'XZY';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && (value as number) > 0;
}

function isNumberTuple(value: unknown, length: number): value is number[] {
  return Array.isArray(value)
    && value.length === length
    && value.every((item) => typeof item === 'number' && Number.isFinite(item));
}
