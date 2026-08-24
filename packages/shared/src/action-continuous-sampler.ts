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
  positionStaticMask?: number | undefined;
  positionSplineMask?: number | undefined;
  rotationHasStatic?: boolean | undefined;
  rotationHasSpline?: boolean | undefined;
  scaleStaticMask?: number | undefined;
  scaleSplineMask?: number | undefined;
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

export interface ExtractedMotionSampleData {
  raw: [number, number, number, number];
  translation: [number, number, number];
  rotationAngle: number;
}

export interface ExtractedMotionData {
  frameType: number;
  up: [number, number, number, number];
  forward: [number, number, number, number];
  duration: number;
  frameCount: number;
  samples: ExtractedMotionSampleData[];
}

export interface TaeAnimationClipData {
  animId: number;
  motionAnimId: number;
  sourceContainer?: string | undefined;
  /** Native HKX container family used by Bridge: packfile or TAG0 tagfile. */
  sourceFormat?: 'packfile' | 'tagfile' | string | undefined;
  animationType: 'SplineCompressed' | 'Interleaved' | string;
  /** Bridge 发现 hkaAnimation.extractedMotion 时保留的完整 native reference-frame 数据。 */
  hasExtractedMotion?: boolean | undefined;
  extractedMotion?: ExtractedMotionData | undefined;
  /** Havok binding blend hint；非零表示 additive/非 absolute pose。 */
  blendHint?: number | undefined;
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
    validateClipShape(clip);
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
    if (!Number.isFinite(timeSeconds)) {
      throw new Error(`ACTION sample time must be finite, got ${timeSeconds}.`);
    }
    const boneCount = this.clip.hkxBoneCount;
    if (!Number.isInteger(boneCount) || boneCount <= 0
      || this.clip.hkxReferencePose.length !== boneCount) {
      throw new Error(
        `HKX reference pose count mismatch: expected ${boneCount}, got ${this.clip.hkxReferencePose.length}.`);
    }
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
        throw new Error(`HKX reference pose is missing bone ${i}; refusing to fabricate identity pose.`);
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
    }

    if (this.clip.animationType === 'Interleaved') {
      this.sampleInterleaved(t, pose);
    } else if (this.clip.animationType === 'SplineCompressed') {
      this.sampleSpline(t, pose);
    } else {
      throw new Error(`Unsupported ACTION animation type: ${this.clip.animationType}.`);
    }

    return pose;
  }

  /**
   * Samples the extracted reference-frame stream without applying it to the
   * in-place bone pose. This keeps root translation and rotation available to
   * the game/renderer integration layer.
   */
  public sampleExtractedMotion(
    timeSeconds: number,
    loop = true
  ): ExtractedMotionSampleData | undefined {
    const motion = this.clip.extractedMotion;
    if (!motion) return undefined;
    if (!Number.isFinite(timeSeconds)) {
      throw new Error(`Extracted-motion sample time must be finite, got ${timeSeconds}.`);
    }
    if (!Number.isFinite(motion.duration) || motion.duration <= 0
      || !Number.isInteger(motion.frameCount) || motion.frameCount <= 0
      || motion.samples.length !== motion.frameCount) {
      throw new Error('Extracted-motion payload has an invalid frame/duration contract.');
    }
    if (motion.frameCount === 1) return copyExtractedMotionSample(motion.samples[0]!);

    let t = timeSeconds;
    if (loop) {
      t %= motion.duration;
      if (t < 0) t += motion.duration;
    } else {
      t = Math.max(0, Math.min(t, motion.duration));
    }
    const frame = t / motion.duration * (motion.frameCount - 1);
    const frame0 = Math.max(0, Math.min(Math.floor(frame), motion.frameCount - 1));
    const frame1 = Math.max(0, Math.min(Math.ceil(frame), motion.frameCount - 1));
    const alpha = Math.max(0, Math.min(frame - frame0, 1));
    const a = motion.samples[frame0]!;
    const b = motion.samples[frame1]!;
    const raw: [number, number, number, number] = [
      a.raw[0] + (b.raw[0] - a.raw[0]) * alpha,
      a.raw[1] + (b.raw[1] - a.raw[1]) * alpha,
      a.raw[2] + (b.raw[2] - a.raw[2]) * alpha,
      a.raw[3] + (b.raw[3] - a.raw[3]) * alpha
    ];
    return {
      raw,
      translation: [raw[0], raw[1], raw[2]],
      rotationAngle: raw[3]
    };
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

    if (!Number.isInteger(flverBoneCount) || flverBoneCount < 0) {
      throw new Error(`Invalid FLVER bone count: ${flverBoneCount}.`);
    }
    if (!map || map.length !== this.clip.hkxBoneCount) {
      throw new Error(
        `HKX-to-FLVER map count mismatch: expected ${this.clip.hkxBoneCount}, got ${map?.length ?? 0}.`);
    }
    if (flverReferencePose && flverReferencePose.length !== flverBoneCount) {
      throw new Error(
        `FLVER reference pose count mismatch: expected ${flverBoneCount}, got ${flverReferencePose.length}.`);
    }
    const result: Array<BoneTransformData | undefined> = new Array(flverBoneCount);
    for (let i = 0; i < flverBoneCount; i++) {
      const ref = flverReferencePose?.[i];
      if (ref) {
        result[i] = {
          translation: [ref.translation[0], ref.translation[1], ref.translation[2]],
          rotation: [ref.rotation[0], ref.rotation[1], ref.rotation[2], ref.rotation[3]],
          scale: [ref.scale[0], ref.scale[1], ref.scale[2]]
        };
      }
    }

    for (let hkxBone = 0; hkxBone < map.length; hkxBone++) {
      const flverBone = map[hkxBone];
      if (flverBone === undefined || flverBone < 0 || flverBone >= flverBoneCount) {
        throw new Error(`HKX-to-FLVER map contains invalid target at HKX bone ${hkxBone}.`);
      }
      result[flverBone] = hkxPose[hkxBone]!;
    }

    const missing = result.findIndex((value) => value === undefined);
    if (missing >= 0) {
      throw new Error(
        `FLVER bone ${missing} has no HKX mapping; a real FLVER bind/reference pose is required.`);
    }
    return result as BoneTransformData[];
  }

  private sampleInterleaved(time: number, pose: BoneTransformData[]): void {
    const numFrames = this.clip.frameCount;
    const numTracks = this.clip.transformTrackCount;
    const transforms = this.clip.interleavedTransforms;
    if (!transforms || numFrames <= 0 || numTracks <= 0) {
      throw new Error('Interleaved ACTION payload is incomplete.');
    }
    if (transforms.length !== numFrames * numTracks) {
      throw new Error(
        `Interleaved transform count mismatch: expected ${numFrames * numTracks}, got ${transforms.length}.`);
    }
    if (this.clip.trackToHkxBone.length !== numTracks) {
      throw new Error(
        `Interleaved track map count mismatch: expected ${numTracks}, got ${this.clip.trackToHkxBone.length}.`);
    }

    const frameDuration = this.clip.frameDuration;
    const framePos = time / frameDuration;

    let frame0 = Math.floor(framePos);
    let frame1 = Math.ceil(framePos);

    frame0 = Math.max(0, Math.min(frame0, numFrames - 1));
    frame1 = Math.max(0, Math.min(frame1, numFrames - 1));
    const alpha = Math.max(0, Math.min(framePos - frame0, 1));

    for (let t = 0; t < numTracks; t++) {
      const boneIdx = this.clip.trackToHkxBone[t];
      if (boneIdx === undefined || boneIdx < 0 || boneIdx >= pose.length) {
        throw new Error(`Interleaved track ${t} has an invalid HKX bone target.`);
      }

      const idx0 = frame0 * numTracks + t;
      const idx1 = frame1 * numTracks + t;

      const t0 = transforms[idx0];
      const t1 = transforms[idx1];
      if (!t0 || !t1) {
        throw new Error(`Interleaved transform payload is missing frame data for track ${t}.`);
      }

      const pos = lerpVector3(t0.translation, t1.translation, alpha);
      const rot = slerpQuaternion(t0.rotation, t1.rotation, alpha);
      const scale = lerpVector3(t0.scale, t1.scale, alpha);

      pose[boneIdx] = { translation: pos, rotation: rot, scale };
    }
  }

  private sampleSpline(time: number, pose: BoneTransformData[]): void {
    const blocks = this.clip.splineBlocks;
    const numTracks = this.clip.transformTrackCount;
    if (!blocks || blocks.length === 0 || numTracks <= 0) {
      throw new Error('Spline ACTION payload is incomplete.');
    }
    if (this.clip.trackToHkxBone.length !== numTracks) {
      throw new Error(
        `Spline track map count mismatch: expected ${numTracks}, got ${this.clip.trackToHkxBone.length}.`);
    }

    const frameDuration = this.clip.frameDuration;
    const frame = time / frameDuration;
    const maxFramesPerBlock = this.clip.maxFramesPerBlock;
    if (blocks.length > 1 && (typeof maxFramesPerBlock !== 'number'
      || !Number.isInteger(maxFramesPerBlock) || maxFramesPerBlock <= 0)) {
      throw new Error('Spline ACTION payload is missing a valid maxFramesPerBlock value.');
    }

    let blockIdx = 0;
    let blockFrame = frame;
    if (blocks.length > 1) {
      const framesPerBlock = maxFramesPerBlock as number;
      blockIdx = Math.max(0, Math.min(Math.floor(frame / framesPerBlock), blocks.length - 1));
      blockFrame = frame - (blockIdx * framesPerBlock);
    }

    const block = blocks[blockIdx];
    if (!block || !block.tracks || block.tracks.length !== numTracks) {
      throw new Error(
        `Spline block track count mismatch: expected ${numTracks}, got ${block?.tracks?.length ?? 0}.`);
    }

    for (let t = 0; t < numTracks; t++) {
      const boneIdx = this.clip.trackToHkxBone[t];
      if (boneIdx === undefined || boneIdx < 0 || boneIdx >= pose.length) {
        throw new Error(`Spline track ${t} has an invalid HKX bone target.`);
      }

      const track = block.tracks[t];
      if (!track) throw new Error(`Spline track ${t} is missing.`);

      const hasChannelMetadata = track.positionStaticMask !== undefined
        || track.positionSplineMask !== undefined
        || track.rotationHasStatic !== undefined
        || track.rotationHasSpline !== undefined
        || track.scaleStaticMask !== undefined
        || track.scaleSplineMask !== undefined;
      const positionStaticMask = track.positionStaticMask ?? 0;
      const positionSplineMask = track.positionSplineMask ?? 0;
      const scaleStaticMask = track.scaleStaticMask ?? 0;
      const scaleSplineMask = track.scaleSplineMask ?? 0;
      const px = resolveScalarChannel(track.positionX, (positionStaticMask & 0x01) !== 0,
        (positionSplineMask & 0x01) !== 0, track.staticPosition[0], pose[boneIdx]!.translation[0], blockFrame,
        hasChannelMetadata);
      const py = resolveScalarChannel(track.positionY, (positionStaticMask & 0x02) !== 0,
        (positionSplineMask & 0x02) !== 0, track.staticPosition[1], pose[boneIdx]!.translation[1], blockFrame,
        hasChannelMetadata);
      const pz = resolveScalarChannel(track.positionZ, (positionStaticMask & 0x04) !== 0,
        (positionSplineMask & 0x04) !== 0, track.staticPosition[2], pose[boneIdx]!.translation[2], blockFrame,
        hasChannelMetadata);

      let rot: [number, number, number, number];
      if (track.rotation) {
        rot = evaluateBSplineQuat(track.rotation, blockFrame);
      } else if (!hasChannelMetadata || (track.rotationHasStatic ?? false)) {
        rot = track.staticRotation;
      } else if (track.rotationHasSpline ?? false) {
        throw new Error('HKX rotation channel declares a spline but contains no curve data.');
      } else {
        rot = pose[boneIdx]!.rotation;
      }

      const sx = resolveScalarChannel(track.scaleX, (scaleStaticMask & 0x01) !== 0,
        (scaleSplineMask & 0x01) !== 0, track.staticScale[0], pose[boneIdx]!.scale[0], blockFrame,
        hasChannelMetadata);
      const sy = resolveScalarChannel(track.scaleY, (scaleStaticMask & 0x02) !== 0,
        (scaleSplineMask & 0x02) !== 0, track.staticScale[1], pose[boneIdx]!.scale[1], blockFrame,
        hasChannelMetadata);
      const sz = resolveScalarChannel(track.scaleZ, (scaleStaticMask & 0x04) !== 0,
        (scaleSplineMask & 0x04) !== 0, track.staticScale[2], pose[boneIdx]!.scale[2], blockFrame,
        hasChannelMetadata);

      pose[boneIdx] = {
        translation: [px, py, pz],
        rotation: rot,
        scale: [sx, sy, sz]
      };
    }
  }
}

function resolveScalarChannel(
  curve: SplineCurveData | undefined,
  hasStaticValue: boolean,
  hasSplineValue: boolean,
  staticValue: number,
  referenceValue: number,
  parameter: number,
  hasChannelMetadata: boolean
): number {
  if (curve) return evaluateBSpline(curve, parameter);
  if (!hasChannelMetadata || hasStaticValue) return staticValue;
  if (hasSplineValue) throw new Error('HKX spline channel declares a curve but contains no curve data.');
  return referenceValue;
}

export function evaluateBSpline(curve: SplineCurveData, t: number): number {
  if (curve.controlPoints.length === 0) throw new Error('HKX scalar spline has no control points.');
  if (curve.controlPoints.length === 1) return curve.controlPoints[0]!;

  const degree = curve.degree;
  const knots = curve.knots;
  const cp = curve.controlPoints;
  const n = cp.length;

  const expectedKnots = n + degree + 1;
  if (degree < 0 || degree > 3 || knots.length !== expectedKnots) {
    throw new Error(`HKX scalar spline shape is invalid: degree=${degree}, knots=${knots.length}, controlPoints=${n}.`);
  }
  const tMin = knots[degree]!;
  const tMax = knots[n]!;
  const clampedT = Math.max(tMin, Math.min(t, tMax));

  let k = degree;
  for (let i = degree; i < n; i++) {
    if (clampedT >= knots[i]! && clampedT < knots[i + 1]!) {
      k = i;
      break;
    }
    if (clampedT >= knots[i + 1]!) {
      k = i;
    }
  }

  const d = new Float32Array(degree + 1);
  for (let j = 0; j <= degree; j++) {
    const cpIdx = k - degree + j;
    if (cpIdx < 0 || cpIdx >= n) {
      throw new Error(`HKX scalar spline control-point index ${cpIdx} is outside 0..${n - 1}.`);
    }
    d[j] = cp[cpIdx]!;
  }

  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const knotIdx = k - degree + j;
      const knotLeft = knots[knotIdx]!;
      const knotRight = knots[knotIdx + degree - r + 1]!;
      const denom = knotRight - knotLeft;
      const alpha = Math.abs(denom) > 1e-6 ? (clampedT - knotLeft) / denom : 0;
      d[j] = (1 - alpha) * d[j - 1]! + alpha * d[j]!;
    }
  }

  return d[degree]!;
}

export function evaluateBSplineQuat(curve: SplineQuatCurveData, t: number): [number, number, number, number] {
  if (curve.controlPoints.length === 0) throw new Error('HKX quaternion spline has no control points.');
  if (curve.controlPoints.length === 1) return normalizeQuaternion(curve.controlPoints[0]!);

  const degree = curve.degree;
  const knots = curve.knots;
  const cp = curve.controlPoints;
  const n = cp.length;

  const expectedKnots = n + degree + 1;
  if (degree < 0 || degree > 3 || knots.length !== expectedKnots) {
    throw new Error(`HKX quaternion spline shape is invalid: degree=${degree}, knots=${knots.length}, controlPoints=${n}.`);
  }
  const tMin = knots[degree]!;
  const tMax = knots[n]!;
  const clampedT = Math.max(tMin, Math.min(t, tMax));

  let k = degree;
  for (let i = degree; i < n; i++) {
    if (clampedT >= knots[i]! && clampedT < knots[i + 1]!) {
      k = i;
      break;
    }
    if (clampedT >= knots[i + 1]!) {
      k = i;
    }
  }

  const d: Array<[number, number, number, number]> = new Array(degree + 1);
  for (let j = 0; j <= degree; j++) {
    const cpIdx = k - degree + j;
    if (cpIdx < 0 || cpIdx >= n) {
      throw new Error(`HKX quaternion spline control-point index ${cpIdx} is outside 0..${n - 1}.`);
    }
    d[j] = [...cp[cpIdx]!];
  }

  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const knotIdx = k - degree + j;
      const knotLeft = knots[knotIdx]!;
      const knotRight = knots[knotIdx + degree - r + 1]!;
      const denom = knotRight - knotLeft;
      const alpha = Math.abs(denom) > 1e-6 ? (clampedT - knotLeft) / denom : 0;

      const q0 = d[j - 1]!;
      let q1 = d[j]!;
      // Havok evaluates quaternion control points as a four-component
      // shortest-arc spline and normalizes only the completed result. Slerp
      // changes the compressed curve and therefore is reserved for interleaved
      // keyframe interpolation.
      if (q0[0] * q1[0] + q0[1] * q1[1] + q0[2] * q1[2] + q0[3] * q1[3] < 0) {
        q1 = [-q1[0], -q1[1], -q1[2], -q1[3]];
      }
      d[j] = [
        q0[0] + (q1[0] - q0[0]) * alpha,
        q0[1] + (q1[1] - q0[1]) * alpha,
        q0[2] + (q1[2] - q0[2]) * alpha,
        q0[3] + (q1[3] - q0[3]) * alpha
      ];
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
  if (!Number.isFinite(lenSq) || lenSq <= 1e-12) {
    throw new Error('ACTION quaternion is non-finite or zero-length.');
  }
  const invLen = 1 / Math.sqrt(lenSq);
  return [q[0] * invLen, q[1] * invLen, q[2] * invLen, q[3] * invLen];
}

function validateClipShape(clip: TaeAnimationClipData): void {
  if (clip.hasExtractedMotion === true && !clip.extractedMotion) {
    throw new Error('ACTION clip marks extracted root motion but omits its native reference-frame payload.');
  }
  if (clip.extractedMotion) {
    const motion = clip.extractedMotion;
    if (!Number.isInteger(motion.frameType) || motion.frameType < 0 || motion.frameType > 2
      || !Number.isFinite(motion.duration) || motion.duration <= 0
      || !Number.isInteger(motion.frameCount) || motion.frameCount <= 0
      || motion.samples.length !== motion.frameCount) {
      throw new Error('ACTION extracted-motion payload has an invalid reference-frame shape.');
    }
    for (const sample of motion.samples) {
      if (!sample || sample.raw.length !== 4 || sample.translation.length !== 3
        || !sample.raw.every(Number.isFinite)
        || !sample.translation.every(Number.isFinite)
        || !Number.isFinite(sample.rotationAngle)) {
        throw new Error('ACTION extracted-motion sample contains invalid components.');
      }
    }
  }
  if (clip.blendHint !== undefined && (!Number.isInteger(clip.blendHint) || clip.blendHint !== 0)) {
    throw new Error(
      `ACTION clip uses unsupported non-absolute blend hint ${clip.blendHint}; refusing to sample it as an absolute pose.`
    );
  }
  if (!Number.isFinite(clip.duration) || clip.duration <= 0) {
    throw new Error(`ACTION clip duration must be positive and finite, got ${clip.duration}.`);
  }
  if (!Number.isInteger(clip.frameCount) || clip.frameCount <= 0) {
    throw new Error(`ACTION clip frameCount must be a positive integer, got ${clip.frameCount}.`);
  }
  if (!Number.isFinite(clip.frameDuration) || clip.frameDuration <= 0) {
    throw new Error(`ACTION clip frameDuration must be positive and finite, got ${clip.frameDuration}.`);
  }
  if (!Number.isInteger(clip.transformTrackCount) || clip.transformTrackCount <= 0) {
    throw new Error(`ACTION transformTrackCount must be a positive integer, got ${clip.transformTrackCount}.`);
  }
  if (!Number.isInteger(clip.hkxBoneCount) || clip.hkxBoneCount <= 0) {
    throw new Error(`ACTION hkxBoneCount must be a positive integer, got ${clip.hkxBoneCount}.`);
  }
  if (clip.hkxBoneNames.length !== clip.hkxBoneCount) {
    throw new Error(
      `HKX bone-name count mismatch: expected ${clip.hkxBoneCount}, got ${clip.hkxBoneNames.length}.`);
  }
  if (clip.hkxReferencePose.length !== clip.hkxBoneCount) {
    throw new Error(
      `HKX reference pose count mismatch: expected ${clip.hkxBoneCount}, got ${clip.hkxReferencePose.length}.`);
  }
  if (clip.trackToHkxBone.length !== clip.transformTrackCount) {
    throw new Error(
      `HKX track map count mismatch: expected ${clip.transformTrackCount}, got ${clip.trackToHkxBone.length}.`);
  }
  const usedBones = new Set<number>();
  for (const [track, bone] of clip.trackToHkxBone.entries()) {
    if (!Number.isInteger(bone) || bone < 0 || bone >= clip.hkxBoneCount || usedBones.has(bone)) {
      throw new Error(`HKX track ${track} has an invalid or duplicate bone target ${bone}.`);
    }
    usedBones.add(bone);
  }
  if (clip.hkxToFlverBoneMap && clip.hkxToFlverBoneMap.length !== clip.hkxBoneCount) {
    throw new Error(
      `HKX-to-FLVER map count mismatch: expected ${clip.hkxBoneCount}, got ${clip.hkxToFlverBoneMap.length}.`);
  }
}

function copyExtractedMotionSample(sample: ExtractedMotionSampleData): ExtractedMotionSampleData {
  return {
    raw: [...sample.raw] as [number, number, number, number],
    translation: [...sample.translation] as [number, number, number],
    rotationAngle: sample.rotationAngle
  };
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
