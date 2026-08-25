/**
 * Real Sekiro ACTION corpus smoke.
 *
 * This is read-only: the Bridge reads the real ANIBND, while the test compares
 * its native C# sampler with the TypeScript client sampler. It also inventories
 * the actual spline channel and quantization modes encountered by the selected
 * clips. No real game asset or oracle output is stored in the repository.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ActionContinuousSampler, type BoneTransformData, type TaeAnimationClipData } from '@soulforge/shared';
import { loadTaeAnimationClip, sampleTaeAnimationPose } from '../action/taeAnimationBridge.js';
import { disposeBridgeDaemonPool, runBridge } from '../bridge/runBridge.js';

const DEFAULT_GAME_ROOT = 'D:\\mystream\\Sekiro Shadows Die Twice\\Sekiro';
const DEFAULT_DIFFERENTIAL_IDS = [10, 11, 12, 13, 100, 101, 200, 300, 400, 500, 600, 1200];
const MAX_TRANSLATION_SCALE_ERROR = 1e-3;
const MAX_ROTATION_ERROR = 1e-3;
const BRIDGE_MAX_FRAME_BYTES = 16 * 1024 * 1024;

interface PoseResult {
  sampledPose: BoneTransformData[];
  duration: number;
}

interface AnimationEntry {
  id: number;
  name: string;
}

function gameRoot(): string {
  return process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim() || DEFAULT_GAME_ROOT;
}

function comparePose(nativePose: BoneTransformData[], tsPose: BoneTransformData[], label: string): {
  maxTranslationScaleError: number;
  maxRotationError: number;
} {
  if (nativePose.length !== tsPose.length) {
    throw new Error(`${label}: C# / TS bone count mismatch ${nativePose.length} != ${tsPose.length}`);
  }
  let maxTranslationScaleError = 0;
  let maxRotationError = 0;
  for (let i = 0; i < nativePose.length; i += 1) {
    const left = nativePose[i]!;
    const right = tsPose[i]!;
    for (let c = 0; c < 3; c += 1) {
      maxTranslationScaleError = Math.max(
        maxTranslationScaleError,
        Math.abs(left.translation[c]! - right.translation[c]!),
        Math.abs(left.scale[c]! - right.scale[c]!)
      );
    }
    const dot = Math.abs(
      left.rotation[0]! * right.rotation[0]!
      + left.rotation[1]! * right.rotation[1]!
      + left.rotation[2]! * right.rotation[2]!
      + left.rotation[3]! * right.rotation[3]!
    );
    maxRotationError = Math.max(maxRotationError, Math.abs(1 - dot));
  }
  if (maxTranslationScaleError > MAX_TRANSLATION_SCALE_ERROR || maxRotationError > MAX_ROTATION_ERROR) {
    throw new Error(
      `${label}: C# / TS sampler mismatch translationScale=${maxTranslationScaleError} rotation=${maxRotationError}`
    );
  }
  return { maxTranslationScaleError, maxRotationError };
}

function assertClipData(result: Awaited<ReturnType<typeof loadTaeAnimationClip>>, filePath: string, animId: number): TaeAnimationClipData {
  if (result.parseStatus === 'failed' || !result.data) {
    throw new Error(`ACTION clip ${animId} read failed: ${JSON.stringify(result.diagnostics)}`);
  }
  if (result.data.animationType !== 'SplineCompressed') {
    throw new Error(`ACTION clip ${animId} is not SplineCompressed: ${result.data.animationType}`);
  }
  if (!result.data.splineBlocks?.length) {
    throw new Error(`ACTION clip ${animId} has no decoded spline blocks (${filePath})`);
  }
  return result.data;
}

async function sampleNative(filePath: string, animId: number, timeSeconds: number): Promise<PoseResult> {
  const root = gameRoot();
  const result = await sampleTaeAnimationPose({
    filePath,
    animId,
    timeSeconds,
    loop: false,
    animationContainerPath: join(root, 'chr', 'c0000_a000_lo.anibnd.dcx'),
    skeletonContainerPath: filePath,
    allowedRoots: [gameRoot()],
    oodleRuntimeRoot: gameRoot(),
    timeoutMs: 180_000
  });
  if (result.parseStatus === 'failed' || !result.data) {
    throw new Error(`ACTION native pose ${animId}@${timeSeconds} failed: ${JSON.stringify(result.diagnostics)}`);
  }
  if (result.data.rootMotionSupported !== false
    || !result.diagnostics.some((diagnostic) => diagnostic.code === 'ACTION_ROOT_MOTION_UNSUPPORTED')) {
    throw new Error(
      `ACTION native pose ${animId}@${timeSeconds} must explicitly expose unsupported root motion: ${JSON.stringify({
        rootMotionSupported: result.data.rootMotionSupported,
        diagnostics: result.diagnostics
      })}`
    );
  }
  return result.data;
}

async function enumerateAnimationEntries(containerPath: string, root: string): Promise<AnimationEntry[]> {
  const result = await runBridge<{
    nested?: { entries?: Array<{ id?: number; name?: string }> };
  }>({
    command: 'read-dcx-document',
    filePath: containerPath,
    allowedRoots: [root],
    oodleRuntimeRoot: root,
    timeoutMs: 180_000
  });
  if (result.parseStatus === 'failed' || !result.data) {
    throw new Error(`ACTION animation container inventory failed: ${JSON.stringify(result.diagnostics)}`);
  }
  const entries = (result.data.nested?.entries ?? [])
    .map((entry) => {
      const name = entry.name ?? '';
      const match = /(?:^|[\\/])a\d{3}_(\d{6})\.hkx$/i.exec(name);
      if (!match) return undefined;
      const id = Number(match[1]);
      return Number.isInteger(id) ? { id, name } : undefined;
    })
    .filter((entry): entry is AnimationEntry => entry !== undefined);
  const unique = new Map(entries.map((entry) => [entry.id, entry] as const));
  if (unique.size === 0) throw new Error('ACTION animation container inventory has no aNNN_NNNNNN.hkx entries.');
  return [...unique.values()].sort((a, b) => a.id - b.id);
}

async function main(): Promise<void> {
  const root = gameRoot();
  const filePath = join(root, 'chr', 'c0000.anibnd.dcx');
  const animationContainerPath = join(root, 'chr', 'c0000_a000_lo.anibnd.dcx');
  if (!existsSync(filePath)) {
    console.log(JSON.stringify({
      ok: true,
      status: 'skipped',
      code: 'ACTION_REAL_CORPUS_UNAVAILABLE',
      filePath
    }));
    return;
  }

  const requested = (process.argv[2] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 0);
  const inventoryEntries = requested.length > 0
    ? requested.map((id) => ({ id, name: `cli:${id}` }))
    : await enumerateAnimationEntries(animationContainerPath, root);
  const animationIds = inventoryEntries.map((entry) => entry.id);
  const differentialIds = requested.length > 0
    ? requested
    : DEFAULT_DIFFERENTIAL_IDS.filter((id) => animationIds.includes(id));
  const reports: Array<Record<string, unknown>> = [];
  const failedClips: Array<Record<string, unknown>> = [];
  const loadedClips = new Map<number, TaeAnimationClipData>();
  const positionQuantization = new Set<number>();
  const rotationQuantization = new Set<number>();
  const scaleQuantization = new Set<number>();
  let totalDynamicPosition = 0;
  let totalDynamicRotation = 0;
  let totalDynamicScale = 0;
  let maxSerializedClipBytes = 0;
  let maxSerializedClipAnimId: number | undefined;

  try {
    for (const entry of inventoryEntries) {
      const animId = entry.id;
      const loaded = await loadTaeAnimationClip({
          filePath,
          animId,
          animationContainerPath,
          skeletonContainerPath: filePath,
          allowedRoots: [root],
          oodleRuntimeRoot: root,
          timeoutMs: 180_000
        });
      if (loaded.parseStatus === 'failed' || !loaded.data) {
        const codes = loaded.diagnostics.map((diagnostic) => diagnostic.code);
        if (!codes.some((code) => code.startsWith('ACTION_') || code.startsWith('TAE_'))) {
          throw new Error(`ACTION clip ${animId} failed without a structured ACTION/TAE code: ${JSON.stringify(loaded.diagnostics)}`);
        }
        failedClips.push({ animId, name: entry.name, diagnostics: loaded.diagnostics });
        continue;
      }
      const clip = assertClipData(loaded, filePath, animId);
      loadedClips.set(animId, clip);
      const serializedClipBytes = Buffer.byteLength(JSON.stringify(clip), 'utf8');
      if (serializedClipBytes > maxSerializedClipBytes) {
        maxSerializedClipBytes = serializedClipBytes;
        maxSerializedClipAnimId = animId;
      }
      if (serializedClipBytes >= BRIDGE_MAX_FRAME_BYTES) {
        throw new Error(
          `ACTION clip ${animId} serialized payload ${serializedClipBytes} bytes reaches the ${BRIDGE_MAX_FRAME_BYTES}-byte Bridge frame budget.`
        );
      }
      const sampler = new ActionContinuousSampler(clip);
      let dynamicPosition = 0;
      let dynamicRotation = 0;
      let dynamicScale = 0;
      for (const block of clip.splineBlocks ?? []) {
        for (const track of block.tracks) {
          if (track.positionQuantizationType !== undefined) positionQuantization.add(track.positionQuantizationType);
          if (track.rotationQuantizationType !== undefined) rotationQuantization.add(track.rotationQuantizationType);
          if (track.scaleQuantizationType !== undefined) scaleQuantization.add(track.scaleQuantizationType);
          if (track.positionX || track.positionY || track.positionZ) dynamicPosition += 1;
          if (track.rotation) dynamicRotation += 1;
          if (track.scaleX || track.scaleY || track.scaleZ) dynamicScale += 1;
        }
      }
      totalDynamicPosition += dynamicPosition;
      totalDynamicRotation += dynamicRotation;
      totalDynamicScale += dynamicScale;

      const sampleErrors: Array<Record<string, number>> = [];
      if (differentialIds.includes(animId)) {
        for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
          const timeSeconds = clip.duration * fraction;
          const native = await sampleNative(filePath, animId, timeSeconds);
          const tsPose = sampler.sampleHkxPose(timeSeconds, false);
          const error = comparePose(native.sampledPose, tsPose, `anim=${animId} fraction=${fraction}`);
          sampleErrors.push(error);
        }
      }
      reports.push({
        animId,
        name: entry.name,
        duration: clip.duration,
        frameCount: clip.frameCount,
        transformTrackCount: clip.transformTrackCount,
        hkxBoneCount: clip.hkxBoneCount,
        dynamicPosition,
        dynamicRotation,
        dynamicScale,
        sampleErrors
      });
    }

    if (totalDynamicPosition === 0 || totalDynamicRotation === 0 || totalDynamicScale === 0) {
      throw new Error(`真实 corpus 未覆盖三类动态 channel：position=${totalDynamicPosition} rotation=${totalDynamicRotation} scale=${totalDynamicScale}`);
    }
    console.log(JSON.stringify({
      ok: true,
      status: 'PASS',
      authority: 'partial',
      filePath,
      animationIds,
      inventory: {
        requestedEntries: inventoryEntries.length,
        decodedEntries: loadedClips.size,
        failedEntries: failedClips.length,
        failedClips
      },
      differentialIds,
      dynamicChannels: {
        position: totalDynamicPosition,
        rotation: totalDynamicRotation,
        scale: totalDynamicScale
      },
      quantizationModes: {
        position: [...positionQuantization].sort((a, b) => a - b),
        rotation: [...rotationQuantization].sort((a, b) => a - b),
        scale: [...scaleQuantization].sort((a, b) => a - b)
      },
      payloadBudget: {
        bridgeMaxFrameBytes: BRIDGE_MAX_FRAME_BYTES,
        maxSerializedClipBytes,
        maxSerializedClipAnimId,
        withinBudget: maxSerializedClipBytes < BRIDGE_MAX_FRAME_BYTES
      },
      reports,
      nonClaims: [
        'full Sekiro corpus outside c0000_a000_lo was not included in this bounded run',
        'failed native entries remain structured failures and are not counted as decoded',
        'root motion and mature-oracle differential are separate checks'
      ]
    }, null, 2));
  } finally {
    await disposeBridgeDaemonPool();
  }
}

main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
