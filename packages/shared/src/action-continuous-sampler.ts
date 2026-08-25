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
    loop = true
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

    if (map) {
      for (let hkxBone = 0; hkxBone < map.length && hkxBone < hkxPose.length; hkxBone++) {
        const flverBone = map[hkxBone];
        if (flverBone !== undefined && flverBone >= 0 && flverBone < flverBoneCount) {
          result[flverBone] = hkxPose[hkxBone]!;
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
  if (clip.hkxBoneNames.length !== clip.hkxBoneCount || clip.hkxReferencePose.length !== clip.hkxBoneCount) {
    throw new Error('ACTION_CLIP_REFERENCE_POSE_MISMATCH');
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

/**
 * Converts Euler angles in XYZ order (radians) to a unit Quaternion [x, y, z, w].
 */
export function eulerXYZToQuaternion(
  euler: [number, number, number] | readonly [number, number, number]
): [number, number, number, number] {
  const [x, y, z] = euler;
  const c1 = Math.cos(x / 2);
  const c2 = Math.cos(y / 2);
  const c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2);
  const s2 = Math.sin(y / 2);
  const s3 = Math.sin(z / 2);

  // Intrinsic XYZ Euler rotation: q = qx * qy * qz
  const qx = s1 * c2 * c3 + c1 * s2 * s3;
  const qy = c1 * s2 * c3 - s1 * c2 * s3;
  const qz = c1 * c2 * s3 + s1 * s2 * c3;
  const qw = c1 * c2 * c3 - s1 * s2 * s3;

  return normalizeQuaternion([qx, qy, qz, qw]);
}

export const flverEulerToQuaternion = eulerXYZToQuaternion;
