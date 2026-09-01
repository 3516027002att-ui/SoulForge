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

function cloneBone(
  bone: FlverPreviewBone,
  index = bone.index,
  parentIndex = bone.parentIndex,
  childIndex = bone.childIndex,
  nextSiblingIndex = bone.nextSiblingIndex,
  hierarchyId = bone.hierarchyId
): FlverPreviewBone {
  return {
    ...bone,
    index,
    parentIndex,
    childIndex,
    nextSiblingIndex,
    hierarchyId,
    translation: [...bone.translation] as [number, number, number],
    rotation: [...bone.rotation] as [number, number, number],
    scale: [...bone.scale] as [number, number, number]
  };
}

/**
 * Appended compatibility bones are preview-only. Rebuild the two convenience
 * links after appending so the DTO remains a valid skeleton even though the
 * native FLVER bone table is never written back.
 */
function rebuildBoneLinks(bones: readonly FlverPreviewBone[]): FlverPreviewBone[] {
  const result = bones.map((bone) => cloneBone(bone, bone.index));
  const children = new Map<number, number[]>();
  for (const bone of result) {
    if (bone.parentIndex < 0 || bone.parentIndex >= result.length || bone.parentIndex === bone.index) continue;
    const list = children.get(bone.parentIndex) ?? [];
    list.push(bone.index);
    children.set(bone.parentIndex, list);
  }
  for (const bone of result) {
    bone.childIndex = -1;
    bone.nextSiblingIndex = -1;
  }
  for (const [parentIndex, childIndexes] of children) {
    const parent = result[parentIndex];
    if (!parent || childIndexes.length === 0) continue;
    parent.childIndex = childIndexes[0]!;
    for (let index = 0; index + 1 < childIndexes.length; index += 1) {
      const child = result[childIndexes[index]!];
      if (child) child.nextSiblingIndex = childIndexes[index + 1]!;
    }
  }
  return result;
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
  // Parts such as c0000's head use a small native extension of the common
  // skeleton (for example HD_L_bone1 -> HD_L_bone2). The old implementation
  // rejected those meshes because it treated the leader bone table as closed.
  // Keep the leader authoritative, but allow exact native part bones and their
  // exact parent chain to be appended to the read-only compatibility skeleton.
  const leaderBones = leaderModel.bones.map((bone) => cloneBone(bone, bone.index));
  const leaderByName = buildLeaderNameToIndex(leaderBones);
  const leaderByHierarchy = new Map<string, number>();
  for (const bone of leaderBones) {
    const hierarchyId = hierarchyIdFor(leaderBones, bone.index);
    const previous = leaderByHierarchy.get(hierarchyId);
    if (previous !== undefined && previous !== bone.index) {
      diagnostics.push({
        severity: 'error',
        code: 'CHARACTER_BONE_HIERARCHY_AMBIGUOUS',
        message: `Leader hierarchy id ambiguous: ${hierarchyId}`,
        details: { hierarchyId, leaderIndices: [previous, bone.index] }
      });
    } else {
      leaderByHierarchy.set(hierarchyId, bone.index);
    }
  }

  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    return { ok: false, diagnostics };
  }

  const sourceHierarchyToLeader = new Map<string, number>();
  let appendedBoneCount = 0;
  const remappedPartModels: FlverPreviewModel[] = [];

  for (const part of bodyPartModels) {
    const partBones = part.bones;
    const partIndexToLeader = new Map<number, number>();
    const partBonesByIndex = new Map<number, FlverPreviewBone>();
    for (const bone of partBones) {
      if (partBonesByIndex.has(bone.index)) {
        diagnostics.push({
          severity: 'error',
          code: 'CHARACTER_BONE_INDEX_AMBIGUOUS',
          message: `Body part ${part.modelId} contains duplicate bone index ${bone.index}.`,
          details: { partModelId: part.modelId, boneIndex: bone.index }
        });
      } else {
        partBonesByIndex.set(bone.index, bone);
      }
    }
    if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      return { ok: false, diagnostics };
    }

    const resolvingPartBones = new Set<number>();
    const failBone = (
      code: string,
      message: string,
      details: Record<string, unknown>
    ): null => {
      diagnostics.push({ severity: 'error', code, message, details });
      return null;
    };

    const resolvePartBone = (partIndex: number): number | null => {
      const alreadyMapped = partIndexToLeader.get(partIndex);
      if (alreadyMapped !== undefined) return alreadyMapped >= 0 ? alreadyMapped : null;
      const bone = partBonesByIndex.get(partIndex);
      if (!bone) {
        return failBone(
          'CHARACTER_BONE_INDEX_INVALID',
          `Body part ${part.modelId} references missing bone index ${partIndex}.`,
          { partModelId: part.modelId, boneIndex: partIndex }
        );
      }
      if (resolvingPartBones.has(partIndex)) {
        return failBone(
          'CHARACTER_BONE_HIERARCHY_CYCLE',
          `Body part ${part.modelId} has a cycle at bone '${bone.name}'.`,
          { partModelId: part.modelId, boneIndex: partIndex, boneName: bone.name }
        );
      }
      resolvingPartBones.add(partIndex);
      const hid = hierarchyIdFor(partBones, bone.index);

      let leaderIndex = leaderByHierarchy.get(hid);
      if (leaderIndex !== undefined) {
        const target = leaderBones[leaderIndex];
        if (!target || target.name !== bone.name) {
          resolvingPartBones.delete(partIndex);
          return failBone(
            'CHARACTER_BONE_HIERARCHY_AMBIGUOUS',
            `Body part ${part.modelId} hierarchy '${hid}' conflicts with leader bone name '${target?.name ?? '<missing>'}'.`,
            { partModelId: part.modelId, boneIndex: partIndex, hierarchyId: hid, boneName: bone.name, leaderIndex }
          );
        }
      }

      if (leaderIndex === undefined) {
        leaderIndex = sourceHierarchyToLeader.get(hid);
        if (leaderIndex !== undefined) {
          const target = leaderBones[leaderIndex];
          if (!target || target.name !== bone.name) {
            resolvingPartBones.delete(partIndex);
            return failBone(
              'CHARACTER_BONE_HIERARCHY_AMBIGUOUS',
              `Body part ${part.modelId} source hierarchy '${hid}' conflicts with an appended leader bone.`,
              { partModelId: part.modelId, boneIndex: partIndex, hierarchyId: hid, boneName: bone.name, leaderIndex }
            );
          }
        }
      }

      if (leaderIndex === undefined) {
        const candidates = leaderByName.get(bone.name) ?? [];
        if (candidates.length === 1) {
          leaderIndex = candidates[0];
        } else if (candidates.length > 1) {
          resolvingPartBones.delete(partIndex);
          return failBone(
            'CHARACTER_BONE_AMBIGUOUS',
            `Leader bone name ambiguous: ${bone.name}`,
            { partModelId: part.modelId, boneName: bone.name, leaderIndices: candidates }
          );
        }
      }

      if (leaderIndex === undefined) {
        const parentIndex = bone.parentIndex;
        let leaderParentIndex = -1;
        if (parentIndex >= 0) {
          if (!partBonesByIndex.has(parentIndex)) {
            resolvingPartBones.delete(partIndex);
            return failBone(
              'CHARACTER_BONE_PARENT_INVALID',
              `Body part ${part.modelId} bone '${bone.name}' references missing parent index ${parentIndex}.`,
              { partModelId: part.modelId, boneIndex: partIndex, boneName: bone.name, parentIndex }
            );
          }
          const resolvedParent = resolvePartBone(parentIndex);
          if (resolvedParent === null) {
            resolvingPartBones.delete(partIndex);
            return null;
          }
          leaderParentIndex = resolvedParent;
        } else if (parentIndex !== -1) {
          resolvingPartBones.delete(partIndex);
          return failBone(
            'CHARACTER_BONE_PARENT_INVALID',
            `Body part ${part.modelId} bone '${bone.name}' has invalid parent index ${parentIndex}.`,
            { partModelId: part.modelId, boneIndex: partIndex, boneName: bone.name, parentIndex }
          );
        }

        const appendedIndex = leaderBones.length;
        const appended = cloneBone(
          bone,
          appendedIndex,
          leaderParentIndex,
          -1,
          -1,
          hid || `${bone.name}#${appendedIndex}`
        );
        leaderBones.push(appended);
        leaderByHierarchy.set(appended.hierarchyId, appendedIndex);
        const nameList = leaderByName.get(appended.name) ?? [];
        nameList.push(appendedIndex);
        leaderByName.set(appended.name, nameList);
        sourceHierarchyToLeader.set(hid, appendedIndex);
        leaderIndex = appendedIndex;
        appendedBoneCount += 1;
      }

      partIndexToLeader.set(partIndex, leaderIndex);
      resolvingPartBones.delete(partIndex);
      return leaderIndex;
    };

    const remappedMeshes: FlverPreviewMesh[] = [];
    for (const mesh of part.meshes) {
      if (mesh.skinningMode === 'static' || !mesh.boneIndicesBase64 || !mesh.boneWeightsBase64) {
        // static meshes: no remapping needed, but assign leader skeletonId for consistency
        remappedMeshes.push({ ...mesh, boneIndexSpace: 'none' as const } as FlverPreviewMesh);
        continue;
      }
      // Decode base64 to check positive-weight mapping
      try {
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
              const leaderIdx = resolvePartBone(partIndex);
              if (leaderIdx === null) {
                const partBoneName = partBonesByIndex.get(partIndex)?.name ?? String(partIndex);
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
                message: `Body part mesh ${part.modelId}:mesh[${mesh.meshIndex}] requires leader bone '${missingBoneName}' with positive weight at vertex ${missingVertex}, but the exact native bone mapping could not be resolved.`,
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
    remappedPartModels.push({
      ...part,
      bones: [],
      boneCount: 0,
      meshes: remappedMeshes.map((m) => ({ ...m }))
    });
  }

  const finalLeaderBones = appendedBoneCount > 0 ? rebuildBoneLinks(leaderBones) : leaderBones;
  const remappedModels: FlverPreviewModel[] = [{
    ...leaderModel,
    bones: finalLeaderBones,
    boneCount: finalLeaderBones.length,
    meshes: leaderModel.meshes.map((m) => ({ ...m, skeletonId: leaderModel.modelId, boneIndexSpace: m.boneIndexSpace ?? 'flver-global' as const }))
  }, ...remappedPartModels];

  if (appendedBoneCount > 0) {
    diagnostics.push({
      severity: 'info',
      code: 'CHARACTER_BONE_AUGMENTED',
      message: `兼容预览按身体部件原生骨骼链补充了 ${appendedBoneCount} 根 leader 骨骼；仅用于只读预览，不写回原生文件。`,
      details: { leaderModelId: leaderModel.modelId, appendedBoneCount }
    });
  }

  // Aggregate counts: boneCount = the (possibly augmented) leader only.
  const meshCount = remappedModels.reduce((sum, m) => sum + m.meshCount, 0);
  const vertexCount = remappedModels.reduce((sum, m) => sum + m.meshes.reduce((s, mesh) => s + mesh.vertexCount, 0), 0);
  const bundle: CharacterPreviewBundle = {
    meshCount,
    vertexCount,
    boneCount: finalLeaderBones.length,
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
