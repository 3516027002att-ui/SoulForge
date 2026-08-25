/**
 * Authoritative TAE Animation Clip & Pose Bridge Helper.
 *
 * Connects renderer / desktop to Bridge for loading real HKX animations and sampling poses.
 */

import type {
  BridgeResult,
  TaeAnimationClipData,
  BoneTransformData,
  ExtractedMotionSampleData
} from '@soulforge/shared';
import { runBridge } from '../bridge/runBridge.js';

export interface LoadTaeAnimationClipOptions {
  filePath: string;
  animId: number;
  flverBoneNames?: string[] | undefined;
  includeRawSplinePayload?: boolean | undefined;
  oodleRuntimeRoot?: string | undefined;
  allowedRoots?: string[] | undefined;
  timeoutMs?: number | undefined;
}

export interface SampleTaeAnimationPoseOptions {
  filePath: string;
  animId: number;
  timeSeconds: number;
  loop?: boolean | undefined;
  flverBoneNames?: string[] | undefined;
  flverReferencePose?: BoneTransformData[] | undefined;
  oodleRuntimeRoot?: string | undefined;
  allowedRoots?: string[] | undefined;
  timeoutMs?: number | undefined;
}

export interface SampledPoseResponse {
  animId: number;
  motionAnimId: number;
  timeSeconds: number;
  duration: number;
  boneCount: number;
  extractedMotion?: ExtractedMotionSampleData | null | undefined;
  sampledPose: BoneTransformData[];
}

export async function loadTaeAnimationClip(
  options: LoadTaeAnimationClipOptions
): Promise<BridgeResult<TaeAnimationClipData>> {
  return runBridge<TaeAnimationClipData>({
    command: 'read-tae-animation-clip',
    filePath: options.filePath,
    commandOptions: {
      animId: options.animId,
      ...(options.flverBoneNames?.length ? { flverBoneNames: options.flverBoneNames } : {}),
      ...(options.includeRawSplinePayload ? { includeRawSplinePayload: true } : {})
    },
    ...(options.oodleRuntimeRoot !== undefined ? { oodleRuntimeRoot: options.oodleRuntimeRoot } : {}),
    ...(options.allowedRoots !== undefined ? { allowedRoots: options.allowedRoots } : {}),
    timeoutMs: options.timeoutMs ?? 20_000
  });
}

export async function sampleTaeAnimationPose(
  options: SampleTaeAnimationPoseOptions
): Promise<BridgeResult<SampledPoseResponse>> {
  return runBridge<SampledPoseResponse>({
    command: 'sample-tae-animation-pose',
    filePath: options.filePath,
    commandOptions: {
      animId: options.animId,
      timeSeconds: options.timeSeconds,
      loop: options.loop ?? true,
      ...(options.flverBoneNames?.length ? { flverBoneNames: options.flverBoneNames } : {}),
      ...(options.flverReferencePose?.length ? { flverReferencePose: options.flverReferencePose } : {})
    },
    ...(options.oodleRuntimeRoot !== undefined ? { oodleRuntimeRoot: options.oodleRuntimeRoot } : {}),
    ...(options.allowedRoots !== undefined ? { allowedRoots: options.allowedRoots } : {}),
    timeoutMs: options.timeoutMs ?? 20_000
  });
}
