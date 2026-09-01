/**
 * Authoritative Client-Side Continuous Animation Sampler.
 *
 * Evaluates continuous-time skeletal animation poses (Spline and Interleaved)
 * and projects them to FLVER bone index order.
 *
 * Clean-room implementation matching C# Bridge ActionContinuousSampler.
 */

export interface BoneTransformData {
  translation: [number, number, number];
  rotation: [number, number, number, number]; // [x, y, z, w] quaternion
  scale: [number, number, number];
}

export interface SplineCurveData {
  degree: number;
  knots: number[];
  controlPoints: number[];
}

export interface SplineQuatCurveData {
  degree: number;
  knots: number[];
  controlPoints: Array<[number, number, number, number]>;
}

export interface TransformSplineTrackData {
  staticPosition: [number, number, number];
  staticRotation: [number, number, number, number];
  staticScale: [number, number, number];
  /** Raw decoder diagnostics; the sampler does not use these masks. */
  positionStaticMask?: number | undefined;
  positionSplineMask?: number | undefined;
  rotationHasStatic?: boolean | undefined;
  rotationHasSpline?: boolean | undefined;
  scaleStaticMask?: number | undefined;
  scaleSplineMask?: number | undefined;
  positionQuantizationType?: number | undefined;
  rotationQuantizationType?: number | undefined;
  scaleQuantizationType?: number | undefined;
  positionX?: SplineCurveData | undefined;
  positionY?: SplineCurveData | undefined;
  positionZ?: SplineCurveData | undefined;
  rotation?: SplineQuatCurveData | undefined;
  scaleX?: SplineCurveData | undefined;
  scaleY?: SplineCurveData | undefined;
  scaleZ?: SplineCurveData | undefined;
}

export interface SplineBlockData {
  tracks: TransformSplineTrackData[];
}

export interface TaeAnimationClipData {
  animId: number;
  motionAnimId: number;
  sourceContainer?: string | undefined;
  sourceHash?: string | undefined;
  animationContainerHash?: string | undefined;
  animationType: 'SplineCompressed' | 'Interleaved' | string;
  /** False means the clip payload contains local skeletal animation only. */
  rootMotionSupported?: boolean | undefined;
  duration: number;
  frameCount: number;
  frameDuration: number;
  transformTrackCount: number;
  hkxBoneCount: number;
  hkxBoneNames: string[];
  /** Parent indices in the HKX skeleton namespace; required for duplicate-name-safe retargeting. */
  hkxParentIndices: number[];
  hkxReferencePose: BoneTransformData[];
  trackToHkxBone: number[];
  hkxToFlverBoneMap?: number[] | undefined;
  binding?: {
    originalSkeletonName: string;
    transformTrackToBoneIndices: number[];
  } | undefined;
  skeleton?: {
    name: string;
  } | undefined;
  interleavedTransforms?: BoneTransformData[] | undefined;
  splineBlocks?: SplineBlockData[] | undefined;
  maxFramesPerBlock?: number | undefined;
  blockDuration?: number | undefined;
  blockInverseDuration?: number | undefined;
  splineRawPayloadBase64?: string | undefined;
  splineMaskAndQuantizationSize?: number | undefined;
  splineNumBlocks?: number | undefined;
  splineBlockOffsets?: number[] | undefined;
  splineFloatBlockOffsets?: number[] | undefined;
  splineTransformOffsets?: number[] | undefined;
  splineFloatOffsets?: number[] | undefined;
}

export class ActionContinuousSampler {
  private clip: TaeAnimationClipData;

  constructor(clip: TaeAnimationClipData) {
    validateClip(clip);
    this.clip = clip;
  }

  public get duration(): number {
    return this.clip.duration;
  }

  public get frameCount(): number {
    return this.clip.frameCount;
  }

  public get frameDuration(): number {
    return this.clip.frameDuration;
  }

  /**
   * Samples the continuous pose in HKX bone order.
   */
  public sampleHkxPose(timeSeconds: number, loop = true): BoneTransformData[] {
    const boneCount = this.clip.hkxBoneCount;
    const pose: BoneTransformData[] = new Array(boneCount);

    // 1. Initialize with reference pose
    for (let i = 0; i < boneCount; i++) {
      const ref = this.clip.hkxReferencePose[i]!;
      pose[i] = {
        translation: [ref.translation[0], ref.translation[1], ref.translation[2]],
        rotation: [ref.rotation[0], ref.rotation[1], ref.rotation[2], ref.rotation[3]],
        scale: [ref.scale[0], ref.scale[1], ref.scale[2]]
      };
    }

    const duration = this.clip.duration;
    let t = timeSeconds;
    if (duration > 0) {
      if (loop) {
        t = timeSeconds % duration;
        if (t < 0) t += duration;
      } else {
        t = Math.max(0, Math.min(timeSeconds, duration));
      }
    } else {
      t = 0;
    }

    if (this.clip.animationType === 'Interleaved') {
      this.sampleInterleaved(t, pose);
    } else if (this.clip.animationType === 'SplineCompressed') {
      this.sampleSpline(t, pose);
    }

    return pose;
  }

  /**
   * Samples the continuous pose and remaps to FLVER bone index order.
   */
  public sampleFlverPose(
    timeSeconds: number,
    flverBoneCount: number,
    flverReferencePose?: BoneTransformData[] | undefined,
    loop = true,
    flverParentIndices?: readonly number[] | undefined
  ): BoneTransformData[] {
    const hkxPose = this.sampleHkxPose(timeSeconds, loop);
    const map = this.clip.hkxToFlverBoneMap;

    if (!flverReferencePose || flverReferencePose.length !== flverBoneCount) {
      throw new Error(`ACTION_FLVER_REFERENCE_POSE_REQUIRED: bones=${flverBoneCount}`);
    }

    const result: BoneTransformData[] = new Array(flverBoneCount);
    for (let i = 0; i < flverBoneCount; i++) {
      const ref = flverReferencePose[i]!;
      result[i] = {
        translation: [ref.translation[0], ref.translation[1], ref.translation[2]],
        rotation: [ref.rotation[0], ref.rotation[1], ref.rotation[2], ref.rotation[3]],
        scale: [ref.scale[0], ref.scale[1], ref.scale[2]]
      };
    }

    if (map && flverParentIndices !== undefined) {
      return retargetHkxPoseToFlverAbsolute(
        this.clip.hkxParentIndices,
        this.clip.hkxReferencePose,
        hkxPose,
        map,
        flverReferencePose,
        flverParentIndices
      );
    }

    if (map) {
      for (let hkxBone = 0; hkxBone < map.length && hkxBone < hkxPose.length; hkxBone++) {
        const flverBone = map[hkxBone];
        if (flverBone !== undefined && flverBone >= 0 && flverBone < flverBoneCount) {
          // Compatibility path for callers that have not supplied the target
          // hierarchy yet.  The production ACTION preview always supplies
          // flverParentIndices and uses the absolute skeleton retarget below;
          // this fallback only preserves the old wire-compatible API.
          result[flverBone] = applyHkxDeltaToFlver(
            this.clip.hkxReferencePose[hkxBone]!,
            hkxPose[hkxBone]!,
            flverReferencePose[flverBone]!
          );
        }
      }
    }

    return result;
  }

  private sampleInterleaved(time: number, pose: BoneTransformData[]): void {
    const numFrames = this.clip.frameCount;
    const numTracks = this.clip.transformTrackCount;
    const transforms = this.clip.interleavedTransforms;
    if (!transforms) throw new Error('ACTION_INTERLEAVED_DATA_MISSING');

    const frameDuration = this.clip.frameDuration > 0 ? this.clip.frameDuration : (1 / 30);
    const framePos = time / frameDuration;

    let frame0 = Math.floor(framePos);
    let frame1 = Math.ceil(framePos);

    frame0 = Math.max(0, Math.min(frame0, numFrames - 1));
    frame1 = Math.max(0, Math.min(frame1, numFrames - 1));
    const alpha = Math.max(0, Math.min(framePos - frame0, 1));

    for (let t = 0; t < numTracks && t < this.clip.trackToHkxBone.length; t++) {
      const boneIdx = this.clip.trackToHkxBone[t];
      if (boneIdx === undefined || boneIdx < 0 || boneIdx >= pose.length) {
        throw new Error(`ACTION_TRACK_BONE_MAPPING_INVALID: track=${t} bone=${String(boneIdx)}`);
      }

      const idx0 = frame0 * numTracks + t;
      const idx1 = frame1 * numTracks + t;

      const t0 = transforms[idx0]!;
      const t1 = transforms[idx1]!;

      const pos = lerpVector3(t0.translation, t1.translation, alpha);
      const rot = slerpQuaternion(t0.rotation, t1.rotation, alpha);
      const scale = lerpVector3(t0.scale, t1.scale, alpha);

      pose[boneIdx] = { translation: pos, rotation: rot, scale };
    }
  }

  private sampleSpline(time: number, pose: BoneTransformData[]): void {
    const blocks = this.clip.splineBlocks;
    const numTracks = this.clip.transformTrackCount;
    if (!blocks || blocks.length === 0) throw new Error('ACTION_SPLINE_DATA_MISSING');

    const frameDuration = this.clip.frameDuration > 0 ? this.clip.frameDuration : (1 / 30);
    const frame = time / frameDuration;
    const maxFramesPerBlock = this.clip.maxFramesPerBlock ?? 256;

    let blockIdx = 0;
    let blockFrame: number;
    if (blocks.length > 1
      && (this.clip.blockDuration ?? 0) > 0
      && Number.isFinite(this.clip.blockInverseDuration)
      && (this.clip.blockInverseDuration ?? 0) > 0) {
      blockIdx = Math.max(0, Math.min(
        Math.floor(time * (this.clip.blockInverseDuration ?? 0)),
        blocks.length - 1
      ));
      blockFrame = Math.max(0, (time - (blockIdx * (this.clip.blockDuration ?? 0))) / frameDuration);
    } else if (maxFramesPerBlock > 0 && blocks.length > 1) {
      blockIdx = Math.max(0, Math.min(Math.floor(frame / maxFramesPerBlock), blocks.length - 1));
      blockFrame = frame - (blockIdx * maxFramesPerBlock);
    } else {
      blockFrame = frame;
    }

    const block = blocks[blockIdx];
    if (!block || block.tracks.length !== numTracks) throw new Error('ACTION_SPLINE_TRACK_DATA_MISSING');

    for (let t = 0; t < numTracks && t < this.clip.trackToHkxBone.length; t++) {
      const boneIdx = this.clip.trackToHkxBone[t];
      if (boneIdx === undefined || boneIdx < 0 || boneIdx >= pose.length) {
        throw new Error(`ACTION_TRACK_BONE_MAPPING_INVALID: track=${t} bone=${String(boneIdx)}`);
      }

      const track = block.tracks[t];
      if (!track) throw new Error(`ACTION_SPLINE_TRACK_MISSING: track=${t}`);

      const reference = pose[boneIdx]!;
      const px = track.positionX
        ? evaluateBSpline(track.positionX, blockFrame)
        : hasMask(track.positionStaticMask, 1) ? track.staticPosition[0] : reference.translation[0];
      const py = track.positionY
        ? evaluateBSpline(track.positionY, blockFrame)
        : hasMask(track.positionStaticMask, 2) ? track.staticPosition[1] : reference.translation[1];
      const pz = track.positionZ
        ? evaluateBSpline(track.positionZ, blockFrame)
        : hasMask(track.positionStaticMask, 4) ? track.staticPosition[2] : reference.translation[2];

      const rot = track.rotation
        ? evaluateBSplineQuat(track.rotation, blockFrame)
        : track.rotationHasStatic ? track.staticRotation : reference.rotation;

      const sx = track.scaleX
        ? evaluateBSpline(track.scaleX, blockFrame)
        : hasMask(track.scaleStaticMask, 1) ? track.staticScale[0] : reference.scale[0];
      const sy = track.scaleY
        ? evaluateBSpline(track.scaleY, blockFrame)
        : hasMask(track.scaleStaticMask, 2) ? track.staticScale[1] : reference.scale[1];
      const sz = track.scaleZ
        ? evaluateBSpline(track.scaleZ, blockFrame)
        : hasMask(track.scaleStaticMask, 4) ? track.staticScale[2] : reference.scale[2];

      pose[boneIdx] = {
        translation: [px, py, pz],
        rotation: rot,
        scale: [sx, sy, sz]
      };
    }
  }
}

export function evaluateBSpline(curve: SplineCurveData, t: number): number {
  validateScalarCurve(curve, t);
  if (curve.controlPoints.length === 1) return curve.controlPoints[0]!;

  const degree = curve.degree;
  const knots = curve.knots;
  const cp = curve.controlPoints;
  const n = cp.length;

  const tMin = knots[degree] ?? 0;
  const tMax = knots[n] ?? tMin;
  const clampedT = Math.max(tMin, Math.min(t, tMax));

  let k = degree;
  for (let i = degree; i < n; i++) {
    if (clampedT >= (knots[i] ?? 0) && clampedT < (knots[i + 1] ?? 0)) {
      k = i;
      break;
    }
    if (clampedT >= (knots[i + 1] ?? 0)) {
      k = i;
    }
  }

  const d = new Float32Array(degree + 1);
  for (let j = 0; j <= degree; j++) {
    const cpIdx = k - degree + j;
    if (cpIdx < 0 || cpIdx >= n) throw new Error(`ACTION_SPLINE_CONTROL_POINT_INDEX_INVALID: ${cpIdx}`);
    d[j] = cp[cpIdx]!;
  }

  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const knotIdx = k - degree + j;
      const knotLeft = knots[knotIdx] ?? 0;
      const knotRight = knots[knotIdx + degree - r + 1] ?? 0;
      const denom = knotRight - knotLeft;
      const alpha = Math.abs(denom) > 1e-6 ? (clampedT - knotLeft) / denom : 0;
      d[j] = (1 - alpha) * d[j - 1]! + alpha * d[j]!;
    }
  }

  return d[degree] ?? 0;
}

export function evaluateBSplineQuat(curve: SplineQuatCurveData, t: number): [number, number, number, number] {
  validateQuatCurve(curve, t);
  if (curve.controlPoints.length === 1) return normalizeQuaternion(curve.controlPoints[0]!);

  const degree = curve.degree;
  const knots = curve.knots;
  const cp = curve.controlPoints;
  const n = cp.length;

  const tMin = knots[degree] ?? 0;
  const tMax = knots[n] ?? tMin;
  const clampedT = Math.max(tMin, Math.min(t, tMax));

  let k = degree;
  for (let i = degree; i < n; i++) {
    if (clampedT >= (knots[i] ?? 0) && clampedT < (knots[i + 1] ?? 0)) {
      k = i;
      break;
    }
    if (clampedT >= (knots[i + 1] ?? 0)) {
      k = i;
    }
  }

  const d: Array<[number, number, number, number]> = new Array(degree + 1);
  for (let j = 0; j <= degree; j++) {
    const cpIdx = k - degree + j;
    if (cpIdx < 0 || cpIdx >= n) throw new Error(`ACTION_SPLINE_QUAT_CONTROL_POINT_INDEX_INVALID: ${cpIdx}`);
    d[j] = [...cp[cpIdx]!];
  }

  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const knotIdx = k - degree + j;
      const knotLeft = knots[knotIdx] ?? 0;
      const knotRight = knots[knotIdx + degree - r + 1] ?? 0;
      const denom = knotRight - knotLeft;
      const alpha = Math.abs(denom) > 1e-6 ? (clampedT - knotLeft) / denom : 0;

      const q0 = d[j - 1]!;
      const q1 = d[j]!;
      // Havok evaluates spline quaternion control points component-wise and
      // normalizes the De Boor result; Slerp changes the native curve.
      d[j] = normalizeQuaternion([
        (1 - alpha) * q0[0] + alpha * q1[0],
        (1 - alpha) * q0[1] + alpha * q1[1],
        (1 - alpha) * q0[2] + alpha * q1[2],
        (1 - alpha) * q0[3] + alpha * q1[3]
      ]);
    }
  }

  return normalizeQuaternion(d[degree]!);
}

function hasMask(mask: number | undefined, bit: number): boolean {
  return mask !== undefined && (mask & bit) !== 0;
}

function validateClip(clip: TaeAnimationClipData): void {
  if (!Number.isFinite(clip.duration) || clip.duration < 0) throw new Error('ACTION_CLIP_DURATION_INVALID');
  if (!Number.isFinite(clip.frameDuration) || clip.frameDuration <= 0) throw new Error('ACTION_CLIP_FRAME_DURATION_INVALID');
  if (!Number.isInteger(clip.frameCount) || clip.frameCount <= 0) throw new Error('ACTION_CLIP_FRAME_COUNT_INVALID');
  if (!Number.isInteger(clip.transformTrackCount) || clip.transformTrackCount <= 0) throw new Error('ACTION_CLIP_TRACK_COUNT_INVALID');
  if (!Number.isInteger(clip.hkxBoneCount) || clip.hkxBoneCount <= 0) throw new Error('ACTION_CLIP_BONE_COUNT_INVALID');
  if (
    clip.hkxBoneNames.length !== clip.hkxBoneCount
    || clip.hkxParentIndices.length !== clip.hkxBoneCount
    || clip.hkxReferencePose.length !== clip.hkxBoneCount
  ) {
    throw new Error('ACTION_CLIP_REFERENCE_POSE_MISMATCH');
  }
  for (let index = 0; index < clip.hkxParentIndices.length; index += 1) {
    const parent = clip.hkxParentIndices[index];
    if (!Number.isInteger(parent) || parent === index || parent! < -1 || parent! >= clip.hkxBoneCount) {
      throw new Error(`ACTION_CLIP_PARENT_INDEX_INVALID: bone=${index} parent=${String(parent)}`);
    }
  }
  if (clip.trackToHkxBone.length !== clip.transformTrackCount) throw new Error('ACTION_CLIP_TRACK_MAPPING_MISMATCH');
  const seenBones = new Set<number>();
  for (const [track, bone] of clip.trackToHkxBone.entries()) {
    if (!Number.isInteger(bone) || bone < 0 || bone >= clip.hkxBoneCount || seenBones.has(bone)) {
      throw new Error(`ACTION_CLIP_TRACK_MAPPING_INVALID: track=${track} bone=${bone}`);
    }
    seenBones.add(bone);
  }
  if (clip.hkxToFlverBoneMap && clip.hkxToFlverBoneMap.length !== clip.hkxBoneCount) throw new Error('ACTION_CLIP_FLVER_MAPPING_MISMATCH');
  if (clip.animationType === 'Interleaved') {
    if (!clip.interleavedTransforms || clip.interleavedTransforms.length !== clip.frameCount * clip.transformTrackCount) {
      throw new Error('ACTION_INTERLEAVED_DATA_MISMATCH');
    }
  } else if (clip.animationType === 'SplineCompressed') {
    if (!clip.splineBlocks || clip.splineBlocks.length === 0 || clip.splineBlocks.some(block => block.tracks.length !== clip.transformTrackCount)) {
      throw new Error('ACTION_SPLINE_DATA_MISMATCH');
    }
  } else {
    throw new Error(`ACTION_ANIMATION_TYPE_UNSUPPORTED: ${clip.animationType}`);
  }
}

function validateScalarCurve(curve: SplineCurveData, t: number): void {
  if (!Number.isFinite(t) || !Number.isInteger(curve.degree) || curve.degree < 0 || curve.degree > 4 || curve.controlPoints.length === 0 || curve.knots.length !== curve.controlPoints.length + curve.degree + 1) {
    throw new Error('ACTION_SCALAR_SPLINE_SHAPE_INVALID');
  }
  if (curve.knots.some((value, index) => !Number.isFinite(value) || (index > 0 && value < curve.knots[index - 1]!)) || curve.controlPoints.some(value => !Number.isFinite(value))) {
    throw new Error('ACTION_SCALAR_SPLINE_DATA_INVALID');
  }
}

function validateQuatCurve(curve: SplineQuatCurveData, t: number): void {
  if (!Number.isFinite(t) || !Number.isInteger(curve.degree) || curve.degree < 0 || curve.degree > 4 || curve.controlPoints.length === 0 || curve.knots.length !== curve.controlPoints.length + curve.degree + 1) {
    throw new Error('ACTION_QUAT_SPLINE_SHAPE_INVALID');
  }
  if (curve.knots.some((value, index) => !Number.isFinite(value) || (index > 0 && value < curve.knots[index - 1]!))) {
    throw new Error('ACTION_QUAT_SPLINE_KNOTS_INVALID');
  }
  for (const point of curve.controlPoints) normalizeQuaternion(point);
}

function lerpVector3(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t
  ];
}

function slerpQuaternion(
  qa: [number, number, number, number],
  qb: [number, number, number, number],
  t: number
): [number, number, number, number] {
  let [ax, ay, az, aw] = qa;
  let [bx, by, bz, bw] = qb;

  let cosHalfTheta = ax * bx + ay * by + az * bz + aw * bw;
  if (cosHalfTheta < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    cosHalfTheta = -cosHalfTheta;
  }

  if (Math.abs(cosHalfTheta) >= 1.0) {
    return [ax, ay, az, aw];
  }

  const halfTheta = Math.acos(Math.min(1.0, Math.max(-1.0, cosHalfTheta)));
  const sinHalfTheta = Math.sqrt(1.0 - cosHalfTheta * cosHalfTheta);

  if (Math.abs(sinHalfTheta) < 0.001) {
    return normalizeQuaternion([
      ax * 0.5 + bx * 0.5,
      ay * 0.5 + by * 0.5,
      az * 0.5 + bz * 0.5,
      aw * 0.5 + bw * 0.5
    ]);
  }

  const ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
  const ratioB = Math.sin(t * halfTheta) / sinHalfTheta;

  return normalizeQuaternion([
    ax * ratioA + bx * ratioB,
    ay * ratioA + by * ratioB,
    az * ratioA + bz * ratioB,
    aw * ratioA + bw * ratioB
  ]);
}

function normalizeQuaternion(q: [number, number, number, number]): [number, number, number, number] {
  const lenSq = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
  if (!Number.isFinite(lenSq) || lenSq <= 1e-12) throw new Error('ACTION_QUATERNION_INVALID');
  const invLen = 1 / Math.sqrt(lenSq);
  return [q[0] * invLen, q[1] * invLen, q[2] * invLen, q[3] * invLen];
}

type RetargetMatrix = Float64Array;

/**
 * Retargets one HKX pose into a different FLVER hierarchy using the same
 * absolute traversal as the mature animation tooling used for comparison.
 * The source animated absolute matrix is the target bone's desired absolute
 * matrix; the target local transform is then decomposed against the target
 * parent's current no-scale matrix.  This matters because HKX and FLVER
 * local reference rotations are not interchangeable, while copying source
 * child translations would change the target skeleton's physical bone
 * lengths and detach skinned parts.
 */
function retargetHkxPoseToFlverAbsolute(
  hkxParentIndices: readonly number[],
  hkxReferencePose: readonly BoneTransformData[],
  hkxAnimatedPose: readonly BoneTransformData[],
  hkxToFlverBoneMap: readonly number[],
  flverReferencePose: readonly BoneTransformData[],
  flverParentIndices: readonly number[]
): BoneTransformData[] {
  if (hkxReferencePose.length !== hkxAnimatedPose.length
    || hkxReferencePose.length !== hkxParentIndices.length
    || hkxReferencePose.length !== hkxToFlverBoneMap.length) {
    throw new Error('ACTION_RETARGET_SOURCE_HIERARCHY_MISMATCH');
  }
  if (flverReferencePose.length !== flverParentIndices.length) {
    throw new Error('ACTION_RETARGET_TARGET_HIERARCHY_MISMATCH');
  }

  validateParentIndices(hkxParentIndices, hkxReferencePose.length, 'ACTION_HKX_PARENT_INDEX_INVALID');
  validateParentIndices(flverParentIndices, flverReferencePose.length, 'ACTION_FLVER_PARENT_INDEX_INVALID');

  const sourceAnimatedAbs = buildMatureAbsoluteMatrices(hkxAnimatedPose, hkxParentIndices);
  const targetToHkx = new Array<number>(flverReferencePose.length).fill(-1);
  for (let hkxIndex = 0; hkxIndex < hkxToFlverBoneMap.length; hkxIndex += 1) {
    const flverIndex = hkxToFlverBoneMap[hkxIndex] ?? -1;
    if (flverIndex < 0) continue;
    if (flverIndex >= targetToHkx.length) {
      throw new Error(`ACTION_RETARGET_TARGET_INDEX_INVALID:${flverIndex}`);
    }
    if (targetToHkx[flverIndex] !== -1) {
      throw new Error(`ACTION_RETARGET_MAPPING_AMBIGUOUS:${flverIndex}`);
    }
    targetToHkx[flverIndex] = hkxIndex;
  }

  const result = clonePose(flverReferencePose);
  // Keep the target traversal matrix free of local scale when decomposing a
  // child. The mature remapper tracks scale separately; feeding a full scaled
  // parent into the inverse would otherwise turn scale/shear into rotation
  // and stretch descendant meshes.
  const targetCurrentAbsNoScale: Array<RetargetMatrix | undefined> = new Array(flverReferencePose.length);
  const visiting = new Set<number>();
  const resolveTarget = (flverIndex: number): RetargetMatrix => {
    const cached = targetCurrentAbsNoScale[flverIndex];
    if (cached) return cached;
    if (visiting.has(flverIndex)) throw new Error(`ACTION_RETARGET_TARGET_HIERARCHY_CYCLE:${flverIndex}`);
    visiting.add(flverIndex);

    const parent = flverParentIndices[flverIndex]!;
    const parentAbsNoScale = parent >= 0 ? resolveTarget(parent) : identityRetargetMatrix();
    const hkxIndex = targetToHkx[flverIndex]!;
    if (hkxIndex >= 0) {
      const desiredAbs = sourceAnimatedAbs[hkxIndex]!;
      const local = decomposeRetargetMatrix(
        multiplyRetargetMatrices(inverseRetargetMatrix(parentAbsNoScale), desiredAbs)
      );

      // Keep the target skeleton's physical bone length.  The source HKX
      // translation is still used while deriving orientation in absolute
      // space, but copying it into a FLVER child local position is what made
      // the head/limbs detach in the real C0000 preview.
      if (parent >= 0) {
        local.translation = [...flverReferencePose[flverIndex]!.translation];
      }
      result[flverIndex] = local;
    }

    const currentAbsNoScale = multiplyRetargetMatrices(
      parentAbsNoScale,
      composeRetargetNoScale(result[flverIndex]!)
    );
    targetCurrentAbsNoScale[flverIndex] = currentAbsNoScale;
    visiting.delete(flverIndex);
    return currentAbsNoScale;
  };

  for (let flverIndex = 0; flverIndex < flverReferencePose.length; flverIndex += 1) {
    resolveTarget(flverIndex);
  }
  return result;
}

function clonePose(pose: readonly BoneTransformData[]): BoneTransformData[] {
  return pose.map((transform) => ({
    translation: [...transform.translation] as [number, number, number],
    rotation: [...transform.rotation] as [number, number, number, number],
    scale: [...transform.scale] as [number, number, number]
  }));
}

function validateParentIndices(parents: readonly number[], count: number, code: string): void {
  if (parents.length !== count) throw new Error(`${code}:count=${parents.length}/${count}`);
  for (let index = 0; index < parents.length; index += 1) {
    const parent = parents[index];
    if (!Number.isInteger(parent) || parent === index || parent! < -1 || parent! >= count) {
      throw new Error(`${code}:bone=${index}:parent=${String(parent)}`);
    }
  }
}

function identityRetargetMatrix(): RetargetMatrix {
  const matrix = new Float64Array(16);
  matrix[0] = 1;
  matrix[5] = 1;
  matrix[10] = 1;
  matrix[15] = 1;
  return matrix;
}

function buildMatureAbsoluteMatrices(
  pose: readonly BoneTransformData[],
  parents: readonly number[]
): RetargetMatrix[] {
  const result: Array<RetargetMatrix | undefined> = new Array(pose.length);
  const accumulatedScales: Array<[number, number, number] | undefined> = new Array(pose.length);
  const visiting = new Set<number>();
  const resolve = (index: number): RetargetMatrix => {
    const cached = result[index];
    if (cached) return cached;
    if (visiting.has(index)) throw new Error(`ACTION_RETARGET_SOURCE_HIERARCHY_CYCLE:${index}`);
    visiting.add(index);
    const parent = parents[index]!;
    const local = composeRetargetNoScale(pose[index]!);
    const parentAbsolute = parent >= 0 ? resolve(parent) : identityRetargetMatrix();
    const parentScale = parent >= 0
      ? accumulatedScales[parent]!
      : [1, 1, 1] as [number, number, number];
    const transformScale = pose[index]!.scale;
    const accumulatedScale: [number, number, number] = [
      parentScale[0] * transformScale[0],
      parentScale[1] * transformScale[1],
      parentScale[2] * transformScale[2]
    ];
    const absoluteNoScale = multiplyRetargetMatrices(parentAbsolute, local);
    // System.Numerics builds CreateScale(accumulatedScale) * currentMatrix
    // with row vectors. Transposing that expression for Three's column-vector
    // matrices yields currentMatrix * CreateScale(accumulatedScale).
    const absolute = multiplyRetargetMatrices(
      absoluteNoScale,
      createScaleRetargetMatrix(accumulatedScale)
    );
    accumulatedScales[index] = accumulatedScale;
    result[index] = absolute;
    visiting.delete(index);
    return absolute;
  };
  for (let index = 0; index < pose.length; index += 1) resolve(index);
  return result as RetargetMatrix[];
}

function composeRetargetTransform(transform: BoneTransformData): RetargetMatrix {
  const [x, y, z, w] = normalizeQuaternion(transform.rotation);
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  const sx = transform.scale[0];
  const sy = transform.scale[1];
  const sz = transform.scale[2];
  const matrix = new Float64Array(16);
  // Column-major layout matches Three.js Matrix4.compose and Object3D local
  // matrices: parentWorld * local.
  matrix[0] = (1 - (yy + zz)) * sx;
  matrix[1] = (xy + wz) * sx;
  matrix[2] = (xz - wy) * sx;
  matrix[4] = (xy - wz) * sy;
  matrix[5] = (1 - (xx + zz)) * sy;
  matrix[6] = (yz + wx) * sy;
  matrix[8] = (xz + wy) * sz;
  matrix[9] = (yz - wx) * sz;
  matrix[10] = (1 - (xx + yy)) * sz;
  matrix[12] = transform.translation[0];
  matrix[13] = transform.translation[1];
  matrix[14] = transform.translation[2];
  matrix[15] = 1;
  return matrix;
}

function composeRetargetNoScale(transform: BoneTransformData): RetargetMatrix {
  return composeRetargetTransform({
    translation: transform.translation,
    rotation: transform.rotation,
    scale: [1, 1, 1]
  });
}

function createScaleRetargetMatrix(scale: readonly [number, number, number]): RetargetMatrix {
  const matrix = identityRetargetMatrix();
  matrix[0] = scale[0]!;
  matrix[5] = scale[1]!;
  matrix[10] = scale[2]!;
  return matrix;
}

function multiplyRetargetMatrices(a: RetargetMatrix, b: RetargetMatrix): RetargetMatrix {
  const result = new Float64Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      result[column * 4 + row] =
        a[row]! * b[column * 4]!
        + a[4 + row]! * b[column * 4 + 1]!
        + a[8 + row]! * b[column * 4 + 2]!
        + a[12 + row]! * b[column * 4 + 3]!;
    }
  }
  return result;
}

function inverseRetargetMatrix(matrix: RetargetMatrix): RetargetMatrix {
  const a00 = matrix[0]!;
  const a01 = matrix[4]!;
  const a02 = matrix[8]!;
  const a10 = matrix[1]!;
  const a11 = matrix[5]!;
  const a12 = matrix[9]!;
  const a20 = matrix[2]!;
  const a21 = matrix[6]!;
  const a22 = matrix[10]!;
  const determinant = a00 * (a11 * a22 - a12 * a21)
    - a01 * (a10 * a22 - a12 * a20)
    + a02 * (a10 * a21 - a11 * a20);
  if (!Number.isFinite(determinant) || Math.abs(determinant) <= 1e-12) {
    throw new Error('ACTION_RETARGET_MATRIX_SINGULAR');
  }
  const inverseDeterminant = 1 / determinant;
  const i00 = (a11 * a22 - a12 * a21) * inverseDeterminant;
  const i01 = (a02 * a21 - a01 * a22) * inverseDeterminant;
  const i02 = (a01 * a12 - a02 * a11) * inverseDeterminant;
  const i10 = (a12 * a20 - a10 * a22) * inverseDeterminant;
  const i11 = (a00 * a22 - a02 * a20) * inverseDeterminant;
  const i12 = (a02 * a10 - a00 * a12) * inverseDeterminant;
  const i20 = (a10 * a21 - a11 * a20) * inverseDeterminant;
  const i21 = (a01 * a20 - a00 * a21) * inverseDeterminant;
  const i22 = (a00 * a11 - a01 * a10) * inverseDeterminant;
  const tx = matrix[12]!;
  const ty = matrix[13]!;
  const tz = matrix[14]!;
  const result = new Float64Array(16);
  result[0] = i00;
  result[1] = i10;
  result[2] = i20;
  result[4] = i01;
  result[5] = i11;
  result[6] = i21;
  result[8] = i02;
  result[9] = i12;
  result[10] = i22;
  result[12] = -(i00 * tx + i01 * ty + i02 * tz);
  result[13] = -(i10 * tx + i11 * ty + i12 * tz);
  result[14] = -(i20 * tx + i21 * ty + i22 * tz);
  result[15] = 1;
  return result;
}

function decomposeRetargetMatrix(matrix: RetargetMatrix): BoneTransformData {
  let sx = Math.hypot(matrix[0]!, matrix[1]!, matrix[2]!);
  const sy = Math.hypot(matrix[4]!, matrix[5]!, matrix[6]!);
  const sz = Math.hypot(matrix[8]!, matrix[9]!, matrix[10]!);
  const determinant = matrix[0]! * (matrix[5]! * matrix[10]! - matrix[9]! * matrix[6]!)
    - matrix[4]! * (matrix[1]! * matrix[10]! - matrix[9]! * matrix[2]!)
    + matrix[8]! * (matrix[1]! * matrix[6]! - matrix[5]! * matrix[2]!);
  if (determinant < 0) sx = -sx;
  if (![sx, sy, sz].every((value) => Number.isFinite(value) && Math.abs(value) > 1e-12)) {
    throw new Error('ACTION_RETARGET_MATRIX_DECOMPOSE_FAILED');
  }

  const m11 = matrix[0]! / sx;
  const m12 = matrix[4]! / sy;
  const m13 = matrix[8]! / sz;
  const m21 = matrix[1]! / sx;
  const m22 = matrix[5]! / sy;
  const m23 = matrix[9]! / sz;
  const m31 = matrix[2]! / sx;
  const m32 = matrix[6]! / sy;
  const m33 = matrix[10]! / sz;
  const trace = m11 + m22 + m33;
  let rotation: [number, number, number, number];
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(Math.max(1e-12, trace + 1));
    rotation = [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s];
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(Math.max(1e-12, 1 + m11 - m22 - m33));
    rotation = [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s];
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(Math.max(1e-12, 1 + m22 - m11 - m33));
    rotation = [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s];
  } else {
    const s = 2 * Math.sqrt(Math.max(1e-12, 1 + m33 - m11 - m22));
    rotation = [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s];
  }

  return {
    translation: [matrix[12]!, matrix[13]!, matrix[14]!],
    rotation: normalizeQuaternion(rotation),
    scale: [sx, sy, sz]
  };
}

function inverseUnitQuaternion(q: [number, number, number, number]): [number, number, number, number] {
  const normalized = normalizeQuaternion(q);
  return [-normalized[0], -normalized[1], -normalized[2], normalized[3]];
}

function applyHkxDeltaToFlver(
  hkxReference: BoneTransformData,
  hkxAnimated: BoneTransformData,
  flverReference: BoneTransformData
): BoneTransformData {
  const rotationDelta = multiplyQuaternion(
    inverseUnitQuaternion(hkxReference.rotation),
    normalizeQuaternion(hkxAnimated.rotation)
  );
  const rotation = normalizeQuaternion(multiplyQuaternion(
    normalizeQuaternion(flverReference.rotation),
    rotationDelta
  ));
  const scale: [number, number, number] = [0, 1, 2].map((axis) => {
    const referenceScale = hkxReference.scale[axis]!;
    const ratio = Math.abs(referenceScale) > 1e-8
      ? hkxAnimated.scale[axis]! / referenceScale
      : 1;
    const value = flverReference.scale[axis]! * ratio;
    return Number.isFinite(value) ? value : flverReference.scale[axis]!;
  }) as [number, number, number];
  return {
    translation: [
      flverReference.translation[0] + hkxAnimated.translation[0] - hkxReference.translation[0],
      flverReference.translation[1] + hkxAnimated.translation[1] - hkxReference.translation[1],
      flverReference.translation[2] + hkxAnimated.translation[2] - hkxReference.translation[2]
    ],
    rotation,
    scale
  };
}

/**
 * Converts native FLVER Euler fields (radians) to a Three.js quaternion.
 *
 * SoulsFormats' FLVER bone local matrix is the row-vector product
 * `Scale * RotationX * RotationZ * RotationY * Translation`.  Transposing
 * that matrix for Three.js column-vector transforms gives
 * `Translation * RotationY * RotationZ * RotationX * Scale`, so the rotation
 * quaternion must be composed as `qy * qz * qx`.  This is intentionally not
 * Three.js' `Euler(..., 'XZY')` composition (`qx * qz * qy`).
 */
export function eulerXYZToQuaternion(
  euler: [number, number, number] | readonly [number, number, number]
): [number, number, number, number] {
  const [x, y, z] = euler;
  const qx: [number, number, number, number] = [Math.sin(x / 2), 0, 0, Math.cos(x / 2)];
  const qz: [number, number, number, number] = [0, 0, Math.sin(z / 2), Math.cos(z / 2)];
  const qy: [number, number, number, number] = [0, Math.sin(y / 2), 0, Math.cos(y / 2)];
  const q = multiplyQuaternion(multiplyQuaternion(qy, qz), qx);
  return normalizeQuaternion(q);
}

function multiplyQuaternion(a: [number, number, number, number], b: [number, number, number, number]): [number, number, number, number] {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
  ];
}

export const flverEulerToQuaternion = eulerXYZToQuaternion;
