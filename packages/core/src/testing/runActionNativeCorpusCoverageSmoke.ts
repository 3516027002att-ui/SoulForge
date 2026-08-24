import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import {
  ActionContinuousSampler,
  type BridgeResult,
  type TaeAnimationClipData
} from '@soulforge/shared';
import { disposeBridgeDaemonPool, runBridge } from '../bridge/runBridge.js';

const DEFAULT_GAME_ROOT = 'D:/mystream/Sekiro Shadows Die Twice/Sekiro';
const DEFAULT_BRIDGE = 'D:/Repository/SoulForge/bridge/SoulForge.Bridge/bin/Debug/net10.0/win-x64/SoulForge.Bridge.exe';
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

interface TaeAnimationSummary {
  animId: number;
  hkxName?: string;
}

interface TaeEnvelope {
  format: string;
  animationCount: number;
  animations?: TaeAnimationSummary[];
}

interface CoverageRow {
  animId: number;
  status: 'payload' | 'unsupported' | 'failed';
  animationType?: string;
  sourceFormat?: string;
  frameCount?: number;
  duration?: number;
  trackCount?: number;
  boneCount?: number;
  hasExtractedMotion?: boolean;
  rootMotionSampled?: boolean;
  movingBones?: number;
  diagnosticCodes: string[];
  error?: string;
}

/**
 * Real-corpus ACTION coverage probe.
 *
 * This intentionally does not turn unsupported or malformed HKX into a test
 * failure that looks like success.  Every TAE animation identity is sent
 * through the production Bridge clip command; the output distinguishes a
 * typed payload from a structured unsupported/failed result.  The command is
 * separate from the default test suite because a full c0000 corpus probe is
 * deliberately expensive.
 *
 * Authority: partial — corpus coverage and fail-closed diagnostics, not a
 * native writer or game-load claim.
 */
export async function runActionNativeCorpusCoverageSmoke(): Promise<void> {
  const explicitPath = process.argv[2]?.trim();
  const gameRoot = resolve(process.env.SOULFORGE_SEKIRO_GAME_ROOT ?? DEFAULT_GAME_ROOT);
  const filePath = resolve(explicitPath ?? join(gameRoot, 'chr', 'c0000.anibnd.dcx'));
  const bridgeExecutablePath = resolve(
    process.env.SOULFORGE_BRIDGE_EXE ?? DEFAULT_BRIDGE
  );

  if (!existsSync(filePath) || !existsSync(bridgeExecutablePath)) {
    console.log(JSON.stringify({
      ok: true,
      status: 'NOT_RUN_ENVIRONMENTAL',
      message: 'ACTION corpus coverage 未运行：缺少 c0000.anibnd.dcx 或 Debug Bridge 可执行文件。',
      filePath,
      bridgeExecutablePath
    }));
    return;
  }

  const bridgeOptions = {
    bridgeExecutablePath,
    allowedRoots: [...new Set([dirname(filePath), gameRoot])],
    oodleRuntimeRoot: process.env.SOULFORGE_OODLE_RUNTIME_ROOT ?? gameRoot,
    timeoutMs: 120_000,
    maxFrameBytes: MAX_FRAME_BYTES
  };

  try {
    const envelopeResult = await runBridge<TaeEnvelope>({
      ...bridgeOptions,
      command: 'read-tae-document',
      filePath
    });
    const envelope = requireData(envelopeResult, 'read-tae-document');
    assert.equal(envelope.format, 'TAE');
    assert.equal(envelope.animationCount, envelope.animations?.length ?? 0);
    const animations = envelope.animations ?? [];
    assert.ok(animations.length > 0, '真实 TAE corpus 必须有 animation identity。');

    const identities = new Set<number>();
    for (const animation of animations) {
      assert.ok(Number.isInteger(animation.animId), `非法 animation ID: ${animation.animId}`);
      assert.ok(!identities.has(animation.animId), `TAE animation ID 重复: ${animation.animId}`);
      identities.add(animation.animId);
    }

    const rows = await mapWithConcurrency(animations, 2, async (animation): Promise<CoverageRow> => {
      const result = await runBridge<TaeAnimationClipData>({
        ...bridgeOptions,
        command: 'read-tae-animation-clip',
        filePath,
        commandOptions: { animId: animation.animId }
      });
      return inspectClipResult(animation.animId, result);
    });

    const payloadRows = rows.filter((row) => row.status === 'payload');
    const unsupportedRows = rows.filter((row) => row.status === 'unsupported');
    const failedRows = rows.filter((row) => row.status === 'failed');
    const sourceFormats = countBy(payloadRows, (row) => row.sourceFormat ?? 'missing');
    const animationTypes = countBy(payloadRows, (row) => row.animationType ?? 'missing');
    const failureCodes = countBy(
      [...unsupportedRows, ...failedRows].flatMap((row) => row.diagnosticCodes),
      (code) => code
    );
    const rootMotionPayloads = payloadRows.filter((row) => row.hasExtractedMotion === true).length;
    const invalidPayloadRows = rows.filter((row) => row.error?.startsWith('PAYLOAD_CONTRACT:') ?? false);

    // A transport/contract failure is an infrastructure error.  A native
    // parser's typed unsupported/failed result is evidence and stays visible
    // in the report rather than being silently promoted to coverage.
    if (invalidPayloadRows.length > 0) {
      throw new Error(`ACTION clip payload contract invalid: ${JSON.stringify(invalidPayloadRows.slice(0, 5))}`);
    }

    console.log(JSON.stringify({
      ok: true,
      status: failedRows.length > 0 || unsupportedRows.length > 0 ? 'partial' : 'PASS',
      authority: 'partial',
      source: filePath,
      animationCount: animations.length,
      payloadCount: payloadRows.length,
      unsupportedCount: unsupportedRows.length,
      failedCount: failedRows.length,
      animationTypes,
      sourceFormats,
      rootMotionPayloads,
      movingBoneSamples: payloadRows.filter((row) => (row.movingBones ?? 0) >= 2).length,
      failureCodes,
      unsupportedSamples: unsupportedRows.slice(0, 12),
      failedSamples: failedRows.slice(0, 12),
      nonClaims: [
        '不把 unsupported/failed 提升为已解析能力。',
        '不替代真实 FLVER mesh skin deformation 视觉验收。',
        '不证明 writer 或游戏内加载。'
      ]
    }, null, 2));
  } finally {
    await disposeBridgeDaemonPool();
  }
}

function inspectClipResult(
  animId: number,
  result: BridgeResult<TaeAnimationClipData>
): CoverageRow {
  const diagnosticCodes = result.diagnostics.map((diagnostic) => diagnostic.code);
  if (result.parseStatus === 'unsupported') {
    return {
      animId,
      status: 'unsupported',
      diagnosticCodes,
      error: result.diagnostics[0]?.message ?? `Bridge parseStatus=${result.parseStatus}`
    };
  }
  if (result.parseStatus === 'failed' || !result.data) {
    return {
      animId,
      status: 'failed',
      diagnosticCodes,
      error: result.diagnostics[0]?.message ?? 'Bridge 返回 failed 但没有诊断。'
    };
  }

  const clip = result.data;
  try {
    assert.ok(clip.sourceFormat === 'packfile' || clip.sourceFormat === 'tagfile', 'sourceFormat 缺失或未知');
    assert.ok(clip.animationType === 'SplineCompressed' || clip.animationType === 'Interleaved', 'animationType 未进入已支持 clip contract');
    assert.ok(Number.isInteger(clip.frameCount) && clip.frameCount > 0, 'frameCount 无效');
    assert.ok(Number.isFinite(clip.duration) && clip.duration > 0, 'duration 无效');
    assert.ok(Number.isFinite(clip.frameDuration) && clip.frameDuration > 0, 'frameDuration 无效');
    assert.equal(clip.trackToHkxBone.length, clip.transformTrackCount, 'track binding count mismatch');
    assert.equal(clip.hkxReferencePose.length, clip.hkxBoneCount, 'reference pose count mismatch');
    if (clip.animationType === 'SplineCompressed') {
      assert.ok((clip.splineBlocks?.length ?? 0) > 0, 'Spline payload 缺失');
      assert.equal(clip.interleavedTransforms, undefined, 'Spline clip 不应伪装为 Interleaved payload');
    } else {
      assert.ok((clip.interleavedTransforms?.length ?? 0) > 0, 'Interleaved payload 缺失');
      assert.equal(clip.splineBlocks, undefined, 'Interleaved clip 不应伪装为 Spline payload');
      assert.equal(
        clip.interleavedTransforms!.length,
        clip.frameCount * clip.transformTrackCount,
        'Interleaved payload frame/track count mismatch'
      );
    }
    if (clip.hasExtractedMotion) {
      assert.ok(clip.extractedMotion, 'hasExtractedMotion=true 但没有 payload');
      assert.equal(clip.extractedMotion.samples.length, clip.extractedMotion.frameCount);
    }

    // The native clip is still a real payload, but the current sampler is
    // intentionally absolute-pose only.  Keep additive clips visible as a
    // truthful unsupported capability instead of attempting to sample them or
    // turning a deliberate fail-closed result into an infrastructure failure.
    if (clip.blendHint !== undefined && clip.blendHint !== 0) {
      return {
        animId,
        status: 'unsupported',
        animationType: clip.animationType,
        sourceFormat: clip.sourceFormat,
        frameCount: clip.frameCount,
        duration: clip.duration,
        trackCount: clip.transformTrackCount,
        boneCount: clip.hkxBoneCount,
        hasExtractedMotion: clip.hasExtractedMotion === true,
        diagnosticCodes: [...diagnosticCodes, 'ACTION_ADDITIVE_UNSUPPORTED'],
        error: `ACTION clip blendHint=${clip.blendHint} 目前只允许显式 unsupported，禁止按 absolute pose 播放。`
      };
    }

    const sampler = new ActionContinuousSampler(clip);
    let rootMotionSampled = false;
    if (clip.extractedMotion) {
      const root0 = sampler.sampleExtractedMotion(0, false);
      const rootMid = sampler.sampleExtractedMotion(clip.duration / 2, false);
      assert.ok(root0 && rootMid, 'root-motion payload 采样结果缺失');
      assert.ok([...root0.raw, ...rootMid.raw].every(Number.isFinite), 'root-motion raw sample 非有限数');
      assert.ok([...root0.translation, ...rootMid.translation, root0.rotationAngle, rootMid.rotationAngle]
        .every(Number.isFinite), 'root-motion sample 非有限数');
      rootMotionSampled = true;
    }
    const pose0 = sampler.sampleHkxPose(0, false);
    const poseMid = sampler.sampleHkxPose(clip.duration / 2, false);
    const movingBones = pose0.reduce((count, pose, index) => {
      const other = poseMid[index]!;
      return count + (
        maxAbs(pose.translation, other.translation) > 1e-5
        || quaternionError(pose.rotation, other.rotation) > 1e-5
        || maxAbs(pose.scale, other.scale) > 1e-5
          ? 1
          : 0
      );
    }, 0);

    return {
      animId,
      status: 'payload',
      animationType: clip.animationType,
      sourceFormat: clip.sourceFormat,
      frameCount: clip.frameCount,
      duration: clip.duration,
      trackCount: clip.transformTrackCount,
      boneCount: clip.hkxBoneCount,
      hasExtractedMotion: clip.hasExtractedMotion === true,
      rootMotionSampled,
      movingBones,
      diagnosticCodes
    };
  } catch (error) {
    return {
      animId,
      status: 'failed',
      diagnosticCodes,
      error: `PAYLOAD_CONTRACT: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function requireData<T>(result: BridgeResult<T>, label: string): T {
  if (!result.data || result.parseStatus === 'failed' || result.parseStatus === 'unsupported') {
    throw new Error(`${label} failed: ${JSON.stringify(result.diagnostics)}`);
  }
  return result.data;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const runWorker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await worker(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => runWorker()));
  return results;
}

function countBy<T>(values: T[], key: (value: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const label = key(value);
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
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

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('runActionNativeCorpusCoverageSmoke.js')) {
  runActionNativeCorpusCoverageSmoke().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
