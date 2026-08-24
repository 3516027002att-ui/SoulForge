import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import {
  ActionContinuousSampler,
  eulerXYZToQuaternion,
  type BoneTransformData,
  type BridgeResult,
  type TaeAnimationClipData
} from '@soulforge/shared';
import { disposeBridgeDaemonPool, runBridge } from '../bridge/runBridge.js';

const DEFAULT_GAME_ROOT = 'D:/mystream/Sekiro Shadows Die Twice/Sekiro';
const DEFAULT_BRIDGE = 'D:/Repository/SoulForge/bridge/SoulForge.Bridge/bin/Debug/net10.0/win-x64/SoulForge.Bridge.exe';

interface SampledPoseResponse {
  sampledPose: BoneTransformData[];
}

interface FlverPreviewResponse {
  bones: Array<{
    name: string;
    translation: number[];
    rotation: number[];
  }>;
}

export async function runActionNativeDifferentialSmoke(): Promise<void> {
  const gameRoot = resolve(process.env.SOULFORGE_SEKIRO_GAME_ROOT ?? DEFAULT_GAME_ROOT);
  const bridgeExecutablePath = resolve(process.env.SOULFORGE_BRIDGE_EXE ?? DEFAULT_BRIDGE);
  const filePath = join(gameRoot, 'chr', 'c0000.anibnd.dcx');
  if (!existsSync(filePath) || !existsSync(bridgeExecutablePath)) {
    console.log(JSON.stringify({
      ok: true,
      status: 'NOT_RUN_ENVIRONMENTAL',
      message: '真实 ACTION 差分未运行：缺少 Sekiro c0000.anibnd.dcx 或 Debug Bridge 可执行文件。',
      filePath,
      bridgeExecutablePath
    }));
    return;
  }

  const bridgeOptions = {
    bridgeExecutablePath,
    allowedRoots: [gameRoot] as string[],
    oodleRuntimeRoot: gameRoot,
    timeoutMs: 120_000
  };

  try {
    const clipResult = await runBridge<TaeAnimationClipData>({
      ...bridgeOptions,
      command: 'read-tae-animation-clip',
      filePath,
      commandOptions: { animId: 10 }
    });
    const clip = requireData(clipResult, 'read-tae-animation-clip');
    assert.equal(clip.animationType, 'SplineCompressed');
    assert.ok(clip.splineBlocks && clip.splineBlocks.length > 0, '真实 clip 必须携带 spline payload。');

    const sampler = new ActionContinuousSampler(clip);
    const differentialPoints = [
      { label: 't=0', timeSeconds: 0, loop: false },
      { label: 't=25%', timeSeconds: clip.duration * 0.25, loop: false },
      { label: 't=50%', timeSeconds: clip.duration * 0.5, loop: false },
      { label: 't=75%', timeSeconds: clip.duration * 0.75, loop: false },
      { label: 't=end', timeSeconds: clip.duration, loop: false },
      { label: 'loop-over', timeSeconds: clip.duration + 0.123, loop: true },
      { label: 'loop-negative', timeSeconds: -0.123, loop: true }
    ];
    const nativeSamples: Array<BridgeResult<SampledPoseResponse>> = [];
    for (const point of differentialPoints) {
      nativeSamples.push(await runBridge<SampledPoseResponse>({
        ...bridgeOptions,
        command: 'sample-tae-animation-pose',
        filePath,
        commandOptions: { animId: 10, timeSeconds: point.timeSeconds, loop: point.loop }
      }));
    }

    let maxTranslationError = 0;
    let maxRotationError = 0;
    let maxScaleError = 0;
    for (let index = 0; index < differentialPoints.length; index++) {
      const point = differentialPoints[index]!;
      const tsPose = sampler.sampleHkxPose(point.timeSeconds, point.loop);
      const nativePose = requireData(nativeSamples[index]!, `sample-tae-animation-pose@${point.label}`).sampledPose;
      assert.equal(nativePose.length, tsPose.length);
      for (let bone = 0; bone < tsPose.length; bone++) {
        const ts = tsPose[bone]!;
        const native = nativePose[bone]!;
        maxTranslationError = Math.max(maxTranslationError, maxAbs(ts.translation, native.translation));
        maxRotationError = Math.max(maxRotationError, quaternionError(ts.rotation, native.rotation));
        maxScaleError = Math.max(maxScaleError, maxAbs(ts.scale, native.scale));
      }
    }

    const pose0 = sampler.sampleHkxPose(0, false);
    const poseMid = sampler.sampleHkxPose(clip.duration / 2, false);
    const movingBones = pose0.reduce((count, pose, index) => {
      const mid = poseMid[index]!;
      return count + (
        maxAbs(pose.translation, mid.translation) > 1e-5
        || quaternionError(pose.rotation, mid.rotation) > 1e-5
        || maxAbs(pose.scale, mid.scale) > 1e-5
          ? 1
          : 0);
    }, 0);

    assert.ok(movingBones >= 2, `真实动画至少应有两个发生运动的骨骼，实际 ${movingBones}。`);
    assert.ok(maxTranslationError <= 2e-4, `translation differential too large: ${maxTranslationError}`);
    assert.ok(maxRotationError <= 2e-4, `rotation differential too large: ${maxRotationError}`);
    assert.ok(maxScaleError <= 2e-4, `scale differential too large: ${maxScaleError}`);

    const flverFilePath = join(gameRoot, 'chr', 'c0000.chrbnd.dcx');
    const flverPreview = requireData(await runBridge<FlverPreviewResponse>({
      ...bridgeOptions,
      command: 'read-chrbnd-flver-preview',
      filePath: flverFilePath,
      commandOptions: { meshIndex: 0, maxVertices: 1, maxIndices: 3 }
    }), 'read-chrbnd-flver-preview');
    const hkxNames = new Set(clip.hkxBoneNames);
    const flverBones = flverPreview.bones.filter((bone) => hkxNames.has(bone.name));
    assert.equal(flverBones.length, clip.hkxBoneCount, '真实 FLVER 必须覆盖目标 HKX 骨骼名称。');
    assert.equal(new Set(flverBones.map((bone) => bone.name)).size, flverBones.length);
    const flverBoneNames = flverBones.map((bone) => bone.name);
    const flverReferencePose = flverBones.map((bone) => ({
      translation: toVector3(bone.translation),
      rotation: eulerXYZToQuaternion(toVector3(bone.rotation)),
      scale: [1, 1, 1] as [number, number, number]
    }));
    const flverClip = requireData(await runBridge<TaeAnimationClipData>({
      ...bridgeOptions,
      command: 'read-tae-animation-clip',
      filePath,
      commandOptions: { animId: 10, flverBoneNames }
    }), 'read-tae-animation-clip with FLVER names');
    assert.ok(flverClip.hkxToFlverBoneMap?.some((target, index) => target !== index),
      '真实 FLVER 顺序应证明映射不是 index identity。');
    const flverNative = requireData(await runBridge<SampledPoseResponse>({
      ...bridgeOptions,
      command: 'sample-tae-animation-pose',
      filePath,
      commandOptions: {
        animId: 10,
        timeSeconds: clip.duration / 2,
        loop: true,
        flverBoneNames,
        flverReferencePose
      }
    }), 'sample-tae-animation-pose in FLVER order');
    const flverTs = new ActionContinuousSampler(flverClip).sampleFlverPose(
      clip.duration / 2,
      flverBoneNames.length,
      flverReferencePose,
      true
    );
    const flverErrors = comparePoses(flverTs, flverNative.sampledPose);
    assert.ok(flverErrors.maxTranslationError <= 2e-4);
    assert.ok(flverErrors.maxRotationError <= 2e-4);
    assert.ok(flverErrors.maxScaleError <= 2e-4);
    const movingBoneNames = clip.hkxBoneNames.filter((_, index) => {
      const a = pose0[index]!;
      const b = poseMid[index]!;
      return maxAbs(a.translation, b.translation) > 1e-5
        || quaternionError(a.rotation, b.rotation) > 1e-5
        || maxAbs(a.scale, b.scale) > 1e-5;
    });
    console.log(JSON.stringify({
      ok: false,
      status: 'BLOCKED',
      authority: 'partial',
      source: filePath,
      sourceHash: clip.sourceHash,
      animationContainerHash: clip.animationContainerHash,
      skeletonContainerHash: clip.skeletonContainerHash,
      animId: clip.animId,
      motionAnimId: clip.motionAnimId,
      animationType: clip.animationType,
      type: clip.animationType,
      frameCount: clip.frameCount,
      duration: clip.duration,
      hkxBoneCount: clip.hkxBoneCount,
      transformTrackCount: clip.transformTrackCount,
      track: {
        count: clip.transformTrackCount,
        trackToHkxBone: clip.trackToHkxBone
      },
      skeleton: clip.skeleton,
      binding: clip.binding,
      movingBones,
      bones: clip.hkxBoneNames,
      movingBoneNames,
      sampleTimes: differentialPoints.map((point) => point.timeSeconds),
      sampleLabels: differentialPoints.map((point) => point.label),
      timestamps: differentialPoints,
      maxTranslationError,
      maxRotationError,
      maxScaleError,
      errors: {
        translation: maxTranslationError,
        quaternion: maxRotationError,
        scale: maxScaleError
      },
      oracle: {
        source: 'PredatorCZ/HavokLib mature hkaSplineCompressedAnimation semantics',
        status: 'BLOCKED',
        reason: '本次未执行独立成熟 oracle 的真实 quantization quaternion differential；合成 probe 已移除，不能把同公式自比当作证据。'
      },
      flver: {
        source: flverFilePath,
        boneCount: flverBoneNames.length,
        mappingNonIdentity: true,
        maxTranslationError: flverErrors.maxTranslationError,
        maxRotationError: flverErrors.maxRotationError,
        maxScaleError: flverErrors.maxScaleError
      },
      nonClaims: ['不替代真实 FLVER mesh skin deformation 的视觉验收。']
    }));
    process.exitCode = 1;
  } catch (error) {
    const diagnostics = error instanceof Error ? error.message : String(error);
    console.log(JSON.stringify({
      ok: false,
      status: 'BLOCKED',
      authority: 'partial',
      source: filePath,
      animId: 10,
      motionAnimId: null,
      type: null,
      track: null,
      skeleton: null,
      binding: null,
      timestamps: [],
      bones: [],
      errors: [diagnostics],
      oracle: {
        source: 'PredatorCZ/HavokLib mature hkaSplineCompressedAnimation semantics',
        status: 'BLOCKED',
        reason: '真实 fixture 或 binding context 不足，未生成成功 payload。'
      }
    }));
    process.exitCode = 1;
  } finally {
    await disposeBridgeDaemonPool();
  }
}

function requireData<T>(result: BridgeResult<T>, label: string): T {
  if (!result.data || result.parseStatus === 'failed') {
    throw new Error(`${label} failed: ${JSON.stringify(result.diagnostics)}`);
  }
  return result.data;
}

function maxAbs(a: readonly number[], b: readonly number[]): number {
  assert.equal(a.length, b.length);
  return a.reduce((max, value, index) => Math.max(max, Math.abs(value - b[index]!)), 0);
}

function quaternionError(a: readonly number[], b: readonly number[]): number {
  assert.equal(a.length, 4);
  assert.equal(b.length, 4);
  const direct = maxAbs(a, b);
  const negated = a.reduce((max, value, index) => Math.max(max, Math.abs(value + b[index]!)), 0);
  return Math.min(direct, negated);
}

function comparePoses(a: BoneTransformData[], b: BoneTransformData[]): {
  maxTranslationError: number;
  maxRotationError: number;
  maxScaleError: number;
} {
  assert.equal(a.length, b.length);
  let maxTranslationError = 0;
  let maxRotationError = 0;
  let maxScaleError = 0;
  for (let index = 0; index < a.length; index++) {
    maxTranslationError = Math.max(maxTranslationError, maxAbs(a[index]!.translation, b[index]!.translation));
    maxRotationError = Math.max(maxRotationError, quaternionError(a[index]!.rotation, b[index]!.rotation));
    maxScaleError = Math.max(maxScaleError, maxAbs(a[index]!.scale, b[index]!.scale));
  }
  return { maxTranslationError, maxRotationError, maxScaleError };
}

function toVector3(values: readonly number[]): [number, number, number] {
  if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) {
    throw new Error(`FLVER reference transform must have three finite components: ${JSON.stringify(values)}`);
  }
  return [values[0]!, values[1]!, values[2]!];
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('runActionNativeDifferentialSmoke.js')) {
  runActionNativeDifferentialSmoke().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
