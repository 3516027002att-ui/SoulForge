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
  animationType: 'SplineCompressed' | 'Interleaved' | string;
  duration: number;
  frameCount: number;
  frameDuration: number;
  transformTrackCount: number;
  hkxBoneCount: number;
  hkxBoneNames: string[];
  hkxReferencePose: BoneTransformData[];
  trackToHkxBone: number[];
  hkxToFlverBoneMap?: number[] | undefined;
  interleavedTransforms?: BoneTransformData[] | undefined;
  splineBlocks?: SplineBlockData[] | undefined;
  maxFramesPerBlock?: number | undefined;
}

export class ActionContinuousSampler {
  private clip: TaeAnimationClipData;

  constructor(clip: TaeAnimationClipData) {
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
      const ref = this.clip.hkxReferencePose[i];
      if (ref) {
        pose[i] = {
          translation: [ref.translation[0], ref.translation[1], ref.translation[2]],
          rotation: [ref.rotation[0], ref.rotation[1], ref.rotation[2], ref.rotation[3]],
          scale: [ref.scale[0], ref.scale[1], ref.scale[2]]
        };
      } else {
        pose[i] = {
          translation: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1]
        };
      }
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

    if (this.clip.animationType === 'Interleaved' && this.clip.interleavedTransforms) {
      this.sampleInterleaved(t, pose);
    } else if (this.clip.splineBlocks && this.clip.splineBlocks.length > 0) {
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

    const result: BoneTransformData[] = new Array(flverBoneCount);
    for (let i = 0; i < flverBoneCount; i++) {
      const ref = flverReferencePose?.[i];
      if (ref) {
        result[i] = {
          translation: [ref.translation[0], ref.translation[1], ref.translation[2]],
          rotation: [ref.rotation[0], ref.rotation[1], ref.rotation[2], ref.rotation[3]],
          scale: [ref.scale[0], ref.scale[1], ref.scale[2]]
        };
      } else {
        result[i] = {
          translation: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1]
        };
      }
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
    if (!transforms || numFrames <= 0 || numTracks <= 0) return;

    const frameDuration = this.clip.frameDuration > 0 ? this.clip.frameDuration : (1 / 30);
    const framePos = time / frameDuration;

    let frame0 = Math.floor(framePos);
    let frame1 = Math.ceil(framePos);

    frame0 = Math.max(0, Math.min(frame0, numFrames - 1));
    frame1 = Math.max(0, Math.min(frame1, numFrames - 1));
    const alpha = Math.max(0, Math.min(framePos - frame0, 1));

    for (let t = 0; t < numTracks && t < this.clip.trackToHkxBone.length; t++) {
      const boneIdx = this.clip.trackToHkxBone[t];
      if (boneIdx === undefined || boneIdx < 0 || boneIdx >= pose.length) continue;

      const idx0 = frame0 * numTracks + t;
      const idx1 = frame1 * numTracks + t;

      if (idx0 < transforms.length && idx1 < transforms.length) {
        const t0 = transforms[idx0]!;
        const t1 = transforms[idx1]!;

        const pos = lerpVector3(t0.translation, t1.translation, alpha);
        const rot = slerpQuaternion(t0.rotation, t1.rotation, alpha);
        const scale = lerpVector3(t0.scale, t1.scale, alpha);

        pose[boneIdx] = { translation: pos, rotation: rot, scale };
      }
    }
  }

  private sampleSpline(time: number, pose: BoneTransformData[]): void {
    const blocks = this.clip.splineBlocks;
    const numTracks = this.clip.transformTrackCount;
    if (!blocks || blocks.length === 0 || numTracks <= 0) return;

    const frameDuration = this.clip.frameDuration > 0 ? this.clip.frameDuration : (1 / 30);
    const frame = time / frameDuration;
    const maxFramesPerBlock = this.clip.maxFramesPerBlock ?? 256;

    let blockIdx = 0;
    let blockFrame = frame;
    if (maxFramesPerBlock > 0 && blocks.length > 1) {
      blockIdx = Math.max(0, Math.min(Math.floor(frame / maxFramesPerBlock), blocks.length - 1));
      blockFrame = frame - (blockIdx * maxFramesPerBlock);
    }

    const block = blocks[blockIdx];
    if (!block || !block.tracks) return;

    for (let t = 0; t < numTracks && t < this.clip.trackToHkxBone.length; t++) {
      const boneIdx = this.clip.trackToHkxBone[t];
      if (boneIdx === undefined || boneIdx < 0 || boneIdx >= pose.length) continue;

      const track = block.tracks[t];
      if (!track) continue;

      const px = track.positionX ? evaluateBSpline(track.positionX, blockFrame) : track.staticPosition[0];
      const py = track.positionY ? evaluateBSpline(track.positionY, blockFrame) : track.staticPosition[1];
      const pz = track.positionZ ? evaluateBSpline(track.positionZ, blockFrame) : track.staticPosition[2];

      const rot = track.rotation ? evaluateBSplineQuat(track.rotation, blockFrame) : track.staticRotation;

      const sx = track.scaleX ? evaluateBSpline(track.scaleX, blockFrame) : track.staticScale[0];
      const sy = track.scaleY ? evaluateBSpline(track.scaleY, blockFrame) : track.staticScale[1];
      const sz = track.scaleZ ? evaluateBSpline(track.scaleZ, blockFrame) : track.staticScale[2];

      pose[boneIdx] = {
        translation: [px, py, pz],
        rotation: rot,
        scale: [sx, sy, sz]
      };
    }
  }
}

export function evaluateBSpline(curve: SplineCurveData, t: number): number {
  if (curve.controlPoints.length === 0) return 0;
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
    d[j] = (cpIdx >= 0 && cpIdx < n) ? cp[cpIdx]! : 0;
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
  if (curve.controlPoints.length === 0) return [0, 0, 0, 1];
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
    d[j] = (cpIdx >= 0 && cpIdx < n) ? [...cp[cpIdx]!] : [0, 0, 0, 1];
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
      d[j] = slerpQuaternion(q0, q1, alpha);
    }
  }

  return normalizeQuaternion(d[degree]!);
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
  if (lenSq === 0) return [0, 0, 0, 1];
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
