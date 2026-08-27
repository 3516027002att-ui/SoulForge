import type { Diagnostic } from './types.js';

export type FlverRotationOrder = 'XZY';
export type FlverSkinningMode = 'weighted' | 'rigid' | 'static';

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
  vertexCount: number;
  indexSize: 16 | 32;
  positionsBase64: string;
  indicesBase64: string;
  uvsBase64?: string | undefined;
  normalsBase64?: string | undefined;
  boneWeightsBase64?: string | undefined;
  boneIndicesBase64?: string | undefined;
  skinningMode: FlverSkinningMode;
  boneIndexSpace: 'flver-global' | 'none';
  skeletonId?: string | undefined;
}

export interface FlverPreviewModel {
  modelId: string;
  entry: FlverContainerEntryIdentity;
  meshCount: number;
  boneCount: number;
  meshes: FlverPreviewMesh[];
  bones: FlverPreviewBone[];
  sourceRole?: 'character' | 'part' | 'map' | 'object' | undefined;
  sourceName?: string | undefined;
}

/**
 * Atomic preview payload. After explicit CharacterAssemblyContext resolution,
 * the bundle is leader-remapped: exactly one leader skeleton remains, all body
 * part meshes have their skin indices rewritten to leader bone space, and the
 * renderer receives this single skeleton. Positive-weight missing mapping is
 * fail-closed. Attachments are not body parts — they use explicit attachBoneName.
 */
export interface CharacterPreviewBundle {
  meshCount: number;
  vertexCount: number;
  boneCount: number;
  leaderModelId: string;
  models: FlverPreviewModel[];
  assemblyParts?: string[] | undefined;
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
    || !Array.isArray(value.models)) return false;
  return value.models.every((candidate) => {
    if (!isRecord(candidate)
      || typeof candidate.modelId !== 'string'
      || !isNonNegativeInteger(candidate.meshCount)
      || !isNonNegativeInteger(candidate.boneCount)
      || !Array.isArray(candidate.meshes)
      || !Array.isArray(candidate.bones)
      || !isRecord(candidate.entry)) return false;
    const entry = candidate.entry;
    if (!isNonNegativeInteger(entry.index)
      || !Number.isInteger(entry.id)
      || typeof entry.name !== 'string'
      || !isNonNegativeInteger(entry.duplicateOrdinal)
      || typeof entry.contentHash !== 'string') return false;
    if (candidate.meshes.length !== candidate.meshCount || candidate.bones.length !== candidate.boneCount) return false;
    return candidate.meshes.every(isPreviewMesh) && candidate.bones.every(isPreviewBone);
  });
}

function isPreviewMesh(value: unknown): boolean {
  if (!isRecord(value)
    || !isNonNegativeInteger(value.meshIndex)
    || !isNonNegativeInteger(value.vertexCount)
    || (value.indexSize !== 16 && value.indexSize !== 32)
    || typeof value.positionsBase64 !== 'string'
    || typeof value.indicesBase64 !== 'string'
    || (value.skinningMode !== 'weighted' && value.skinningMode !== 'rigid' && value.skinningMode !== 'static')
    || (value.boneIndexSpace !== 'flver-global' && value.boneIndexSpace !== 'none')) return false;
  return ['uvsBase64', 'normalsBase64', 'boneWeightsBase64', 'boneIndicesBase64']
    .every((key) => value[key] === undefined || typeof value[key] === 'string');
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

function isNumberTuple(value: unknown, length: number): value is number[] {
  return Array.isArray(value)
    && value.length === length
    && value.every((item) => typeof item === 'number' && Number.isFinite(item));
}
