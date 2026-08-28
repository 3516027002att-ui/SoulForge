import type { Diagnostic } from '@soulforge/shared';
import type { FlverPreviewBone, FlverPreviewMesh, FlverPreviewModel, CharacterPreviewBundle } from '@soulforge/shared';

export interface RemapResult {
  ok: boolean;
  bundle?: CharacterPreviewBundle;
  diagnostics: Diagnostic[];
}

function buildLeaderNameToIndex(leaderBones: readonly FlverPreviewBone[]): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const bone of leaderBones) {
    const list = map.get(bone.name) ?? [];
    list.push(bone.index);
    map.set(bone.name, list);
  }
  return map;
}

function hierarchyIdFor(bones: readonly FlverPreviewBone[], index: number): string {
  const bone = bones[index];
  if (!bone) return '';
  if (bone.hierarchyId) return bone.hierarchyId;
  // fallback: name#occurrence
  return `${bone.name}#${index}`;
}

/**
 * Remap all body part skin indices to leader bone space. This runs in
 * core/main (renderer-independent). Renderer receives a single leader skeleton.
 *
 * Positive-weight influences with missing leader mapping fail closed.
 * Zero-weight slots are ignored.
 */
export function remapCharacterBundleToLeader(
  leaderModel: FlverPreviewModel,
  bodyPartModels: readonly FlverPreviewModel[]
): RemapResult {
  const diagnostics: Diagnostic[] = [];
  const leaderBones = leaderModel.bones;
  const leaderByName = buildLeaderNameToIndex(leaderBones);
  const leaderByHierarchy = new Map<string, number>();
  for (const bone of leaderBones) {
    leaderByHierarchy.set(bone.hierarchyId, bone.index);
  }

  // Validate leader duplicate names -> ambiguous
  const ambiguousLeaderNames = new Set<string>();
  for (const [name, indices] of leaderByName) {
    if (indices.length > 1) ambiguousLeaderNames.add(name);
  }

  const remappedModels: FlverPreviewModel[] = [];
  // Leader model stays as-is (single skeleton)
  remappedModels.push({
    ...leaderModel,
    meshes: leaderModel.meshes.map((m) => ({ ...m, skeletonId: leaderModel.modelId, boneIndexSpace: m.boneIndexSpace ?? 'flver-global' as const }))
  });

  for (const part of bodyPartModels) {
    const partBones = part.bones;
    const partIndexToLeader = new Map<number, number>();
    for (const bone of partBones) {
      const hid = bone.hierarchyId || hierarchyIdFor(partBones, bone.index);
      let leaderIndex = leaderByHierarchy.get(hid);
      if (leaderIndex === undefined) {
        const candidates = leaderByName.get(bone.name) ?? [];
        if (candidates.length === 1) {
          leaderIndex = candidates[0];
        } else if (candidates.length === 0) {
          leaderIndex = -1;
        } else {
          // ambiguous leader name — fail closed for any positive-weight use
          diagnostics.push({
            severity: 'error',
            code: 'CHARACTER_BONE_AMBIGUOUS',
            message: `Leader bone name ambiguous: ${bone.name}`,
            details: { partModelId: part.modelId, boneName: bone.name, leaderIndices: candidates }
          });
          leaderIndex = -1;
        }
      }
      if (leaderIndex !== undefined) partIndexToLeader.set(bone.index, leaderIndex);
    }

    const remappedMeshes: FlverPreviewMesh[] = [];
    for (const mesh of part.meshes) {
      if (mesh.skinningMode === 'static' || !mesh.boneIndicesBase64 || !mesh.boneWeightsBase64) {
        // static meshes: no remapping needed, but assign leader skeletonId for consistency
        remappedMeshes.push({ ...mesh, boneIndexSpace: 'none' as const } as FlverPreviewMesh);
        continue;
      }
      // Decode base64 to check positive-weight mapping
      try {
        const indicesBytes = atob(mesh.boneIndicesBase64);
        const weightsBytes = atob(mesh.boneWeightsBase64);
        // We do lightweight checks without full Float32 decode: length already validated elsewhere.
        // For correctness, decode via shared logic if available: use DataView checks.
        // To avoid heavy deps, decode indices/weights via Buffer
        const indices = decodeIndices(mesh.boneIndicesBase64, mesh.vertexCount);
        const weights = decodeWeights(mesh.boneWeightsBase64, mesh.vertexCount);
        let missingForPositiveWeight = false;
        let missingBoneName = '';
        let missingVertex = -1;
        for (let v = 0; v < mesh.vertexCount; v += 1) {
          for (let k = 0; k < 4; k += 1) {
            const offset = v * 4 + k;
            const w = weights[offset] ?? 0;
            if (w > 1e-6) {
              const partIndex = indices[offset] ?? 0;
              const leaderIdx = partIndexToLeader.get(partIndex);
              if (leaderIdx === undefined || leaderIdx < 0) {
                const partBoneName = partBones[partIndex]?.name ?? String(partIndex);
                missingForPositiveWeight = true;
                missingBoneName = partBoneName;
                missingVertex = v;
                break;
              }
            }
          }
          if (missingForPositiveWeight) break;
        }
        if (missingForPositiveWeight) {
          return {
            ok: false,
            diagnostics: [
              ...diagnostics,
              {
                severity: 'error',
                code: 'CHARACTER_BONE_REMAP_MISSING',
                message: `Body part mesh ${part.modelId}:mesh[${mesh.meshIndex}] requires leader bone '${missingBoneName}' with positive weight at vertex ${missingVertex}, but leader skeleton has no such bone.`,
                details: { partModelId: part.modelId, meshIndex: mesh.meshIndex, boneName: missingBoneName, vertex: missingVertex }
              }
            ]
          };
        }
        // Perform actual remap: rewrite indices
        const remappedIndices = new Uint16Array(indices.length);
        for (let i = 0; i < indices.length; i += 1) {
          const partIdx = indices[i]!;
          const w = weights[i]!;
          if (w > 1e-6) {
            const leaderIdx = partIndexToLeader.get(partIdx) ?? partIdx;
            remappedIndices[i] = leaderIdx >= 0 ? leaderIdx : 0;
          } else {
            // zero-weight slots: keep original or 0, ignored by renderer
            remappedIndices[i] = partIndexToLeader.get(partIdx) ?? 0;
          }
        }
        const indicesBase64 = encodeUint16Array(remappedIndices);
        remappedMeshes.push({
          ...mesh,
          boneIndicesBase64: indicesBase64,
          boneIndexSpace: 'flver-global' as const
        });
        void indicesBytes; void weightsBytes;
      } catch (e) {
        return {
          ok: false,
          diagnostics: [
            ...diagnostics,
            {
              severity: 'error',
              code: 'CHARACTER_BONE_REMAP_FAILED',
              message: e instanceof Error ? e.message : String(e),
              details: { partModelId: part.modelId, meshIndex: mesh.meshIndex }
            }
          ]
        };
      }
    }

    // Body part model becomes geometry-only, no bones, bound to leader skeleton
    remappedModels.push({
      ...part,
      bones: [],
      boneCount: 0,
      meshes: remappedMeshes.map((m) => ({ ...m }))
    });
  }

  // Aggregate counts: boneCount = leader only
  const meshCount = remappedModels.reduce((sum, m) => sum + m.meshCount, 0);
  const vertexCount = remappedModels.reduce((sum, m) => sum + m.meshes.reduce((s, mesh) => s + mesh.vertexCount, 0), 0);
  const bundle: CharacterPreviewBundle = {
    meshCount,
    vertexCount,
    boneCount: leaderBones.length,
    leaderModelId: leaderModel.modelId,
    models: remappedModels.map((m, idx) => ({
      ...m,
      // All skinned meshes point to leader skeletonId
      meshes: m.meshes.map((mesh) => ({
        ...mesh,
        ...(mesh.skinningMode !== 'static' ? { skeletonId: leaderModel.modelId } : {})
      }))
    }))
  };

  return { ok: true, bundle, diagnostics };
}

function decodeIndices(base64: string, vertexCount: number): Uint16Array {
  const bytes = Buffer.from(base64, 'base64');
  const expected = vertexCount * 4 * 2;
  if (bytes.length !== expected) throw new Error(`FLVER_SKIN_INDEX_LENGTH_MISMATCH: expected=${expected} actual=${bytes.length}`);
  const arr = new Uint16Array(vertexCount * 4);
  for (let i = 0; i < arr.length; i += 1) arr[i] = bytes.readUInt16LE(i * 2);
  return arr;
}

function decodeWeights(base64: string, vertexCount: number): Float32Array {
  const bytes = Buffer.from(base64, 'base64');
  const expected = vertexCount * 4 * 4;
  if (bytes.length !== expected) throw new Error(`FLVER_SKIN_WEIGHT_LENGTH_MISMATCH: expected=${expected} actual=${bytes.length}`);
  const arr = new Float32Array(vertexCount * 4);
  for (let i = 0; i < arr.length; i += 1) arr[i] = bytes.readFloatLE(i * 4);
  return arr;
}

function encodeUint16Array(arr: Uint16Array): string {
  const buf = Buffer.alloc(arr.length * 2);
  for (let i = 0; i < arr.length; i += 1) buf.writeUInt16LE(arr[i]!, i * 2);
  return buf.toString('base64');
}

export function isLeaderRemappedBundle(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const b = value as CharacterPreviewBundle;
  if (!Array.isArray(b.models) || typeof b.leaderModelId !== 'string') return false;
  // Exactly one model should have bones == boneCount, others boneCount 0
  const withBones = b.models.filter((m) => m.bones.length > 0);
  if (withBones.length !== 1) return false;
  if (withBones[0]!.modelId !== b.leaderModelId) return false;
  if (withBones[0]!.bones.length !== b.boneCount) return false;
  return b.models.every((m) => {
    if (m.modelId === b.leaderModelId) return true;
    return m.bones.length === 0 && m.boneCount === 0;
  });
}
