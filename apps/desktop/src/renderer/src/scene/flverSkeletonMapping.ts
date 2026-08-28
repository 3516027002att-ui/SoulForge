export interface SkeletonIdentityBone {
  name: string;
  parentIndex: number;
  hierarchyId?: string | undefined;
}

export interface LocalBoneTransform {
  translation: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

export interface FlverRetargetBone extends SkeletonIdentityBone {
  translation: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

export interface FlverRetargetPlan {
  flverToHkx: number[];
}

function hierarchyIds(bones: readonly SkeletonIdentityBone[]): string[] {
  const ids = new Array<string>(bones.length);
  const visiting = new Set<number>();
  const build = (index: number): string => {
    const cached = ids[index];
    if (cached) return cached;
    const bone = bones[index];
    if (!bone) throw new Error(`FLVER_BONE_INDEX_INVALID:${index}`);
    if (bone.hierarchyId) {
      ids[index] = bone.hierarchyId;
      return bone.hierarchyId;
    }
    if (visiting.has(index)) throw new Error(`FLVER_BONE_HIERARCHY_CYCLE:${index}`);
    visiting.add(index);
    const parent = bone.parentIndex;
    const parentId = parent >= 0 && parent < bones.length && parent !== index
      ? build(parent)
      : 'root';
    let occurrence = 0;
    for (let candidate = 0; candidate < index; candidate += 1) {
      const sibling = bones[candidate];
      if (sibling?.parentIndex === parent && sibling.name === bone.name) occurrence += 1;
    }
    const id = `${parentId}/${bone.name}#${occurrence}`;
    ids[index] = id;
    visiting.delete(index);
    return id;
  };
  for (let index = 0; index < bones.length; index += 1) build(index);
  return ids;
}

/**
 * Map a follower skeleton into a leader skeleton without assuming numeric index
 * equality. Full hierarchy identity wins; a unique same-name/same-parent match is
 * the only fallback. Ambiguous or missing bones remain -1.
 */
export function mapFollowerSkeleton(
  leader: readonly SkeletonIdentityBone[],
  follower: readonly SkeletonIdentityBone[]
): number[] {
  const leaderIds = hierarchyIds(leader);
  const followerIds = hierarchyIds(follower);
  const leaderById = new Map<string, number>();
  const leaderByName = new Map<string, number[]>();
  for (let index = 0; index < leader.length; index += 1) {
    leaderById.set(leaderIds[index]!, index);
    const name = leader[index]!.name;
    const list = leaderByName.get(name) ?? [];
    list.push(index);
    leaderByName.set(name, list);
  }

  const result = new Array<number>(follower.length).fill(-1);
  const resolving = new Set<number>();
  const resolve = (index: number): number => {
    if (result[index] !== -1) return result[index]!;
    if (resolving.has(index)) return -1;
    resolving.add(index);
    const exact = leaderById.get(followerIds[index]!);
    if (exact !== undefined) {
      result[index] = exact;
      resolving.delete(index);
      return exact;
    }

    const bone = follower[index]!;
    const candidates = leaderByName.get(bone.name) ?? [];
    const followerParent = bone.parentIndex;
    const mappedParent = followerParent >= 0 && followerParent < follower.length
      ? resolve(followerParent)
      : -1;
    const compatible = candidates.filter((candidate) => leader[candidate]!.parentIndex === mappedParent);
    if (compatible.length === 1) result[index] = compatible[0]!;
    resolving.delete(index);
    return result[index]!;
  };
  for (let index = 0; index < follower.length; index += 1) resolve(index);
  return result;
}

type Quaternion = [number, number, number, number];

function multiplyQuaternion(a: Quaternion, b: Quaternion): Quaternion {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
  ];
}

function normalizeQuaternion(q: Quaternion): Quaternion {
  const length = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!Number.isFinite(length) || length <= 1e-12) throw new Error('SKELETON_QUATERNION_INVALID');
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

function inverseUnitQuaternion(q: Quaternion): Quaternion {
  const normalized = normalizeQuaternion(q);
  return [-normalized[0], -normalized[1], -normalized[2], normalized[3]];
}

/** FLVER local rotation: radians, intrinsic XZY row-vector `Rx*Rz*Ry` → column-vector `T*Ry*Rz*Rx*S`, quaternion `qy⊗qz⊗qx`. */
export function flverEulerXzyToQuaternion(rotation: readonly [number, number, number]): Quaternion {
  const [x, y, z] = rotation;
  const qx: Quaternion = [Math.sin(x / 2), 0, 0, Math.cos(x / 2)];
  const qz: Quaternion = [0, 0, Math.sin(z / 2), Math.cos(z / 2)];
  const qy: Quaternion = [0, Math.sin(y / 2), 0, Math.cos(y / 2)];
  const q = multiplyQuaternion(multiplyQuaternion(qy, qz), qx);
  return normalizeQuaternion(q);
}

/**
 * Retarget an HKX local pose to one FLVER-local skeleton. Numeric indices never
 * cross namespaces. Animation is applied as a delta from the HKX reference pose
 * so each parts FLVER keeps its own bind translation, orientation, and scale.
 */
export function retargetHkxPoseToFlver(
  hkxBones: readonly SkeletonIdentityBone[],
  hkxReferencePose: readonly LocalBoneTransform[],
  hkxAnimatedPose: readonly LocalBoneTransform[],
  flverBones: readonly FlverRetargetBone[],
  plan: FlverRetargetPlan = createFlverRetargetPlan(hkxBones, flverBones)
): LocalBoneTransform[] {
  if (hkxReferencePose.length !== hkxBones.length || hkxAnimatedPose.length !== hkxBones.length) {
    throw new Error('ACTION_HKX_POSE_LENGTH_MISMATCH');
  }
  if (plan.flverToHkx.length !== flverBones.length) throw new Error('ACTION_FLVER_RETARGET_PLAN_MISMATCH');
  return flverBones.map((bone, flverIndex) => {
    const bind: LocalBoneTransform = {
      translation: [...bone.translation],
      rotation: flverEulerXzyToQuaternion(bone.rotation),
      scale: [...bone.scale]
    };
    const hkxIndex = plan.flverToHkx[flverIndex] ?? -1;
    if (hkxIndex < 0) return bind;
    const reference = hkxReferencePose[hkxIndex];
    const animated = hkxAnimatedPose[hkxIndex];
    if (!reference || !animated) return bind;

    const rotationDelta = multiplyQuaternion(
      inverseUnitQuaternion(reference.rotation),
      normalizeQuaternion(animated.rotation)
    );
    const rotation = normalizeQuaternion(multiplyQuaternion(bind.rotation, rotationDelta));
    const scale: [number, number, number] = [0, 1, 2].map((axis) => {
      const referenceScale = reference.scale[axis]!;
      const ratio = Math.abs(referenceScale) > 1e-8
        ? animated.scale[axis]! / referenceScale
        : 1;
      const value = bind.scale[axis]! * ratio;
      return Number.isFinite(value) ? value : bind.scale[axis]!;
    }) as [number, number, number];
    return {
      translation: [
        bind.translation[0] + animated.translation[0] - reference.translation[0],
        bind.translation[1] + animated.translation[1] - reference.translation[1],
        bind.translation[2] + animated.translation[2] - reference.translation[2]
      ],
      rotation,
      scale
    };
  });
}

export function createFlverRetargetPlan(
  hkxBones: readonly SkeletonIdentityBone[],
  flverBones: readonly SkeletonIdentityBone[]
): FlverRetargetPlan {
  return { flverToHkx: mapFollowerSkeleton(hkxBones, flverBones) };
}
