import { existsSync, readdirSync } from 'node:fs';
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

interface CorpusContainer {
  filePath: string;
  status: 'tae' | 'empty' | 'failed';
  animationCount: number;
  animations: TaeAnimationSummary[];
  diagnosticCodes: string[];
  error?: string;
}

interface ClipTarget extends TaeAnimationSummary {
  filePath: string;
}

interface CoverageRow {
  animId: number;
  filePath?: string;
  status: 'payload' | 'unsupported' | 'failed';
  sourceHash?: string | undefined;
  animationContainerHash?: string | undefined;
  skeletonContainerHash?: string | undefined;
  motionAnimId?: number | undefined;
  animationType?: string | undefined;
  type?: string | undefined;
  sourceFormat?: string | undefined;
  frameCount?: number | undefined;
  duration?: number | undefined;
  trackCount?: number | undefined;
  boneCount?: number | undefined;
  track?: { count: number; trackToHkxBone: number[] } | undefined;
  skeleton?: TaeAnimationClipData['skeleton'] | undefined;
  binding?: TaeAnimationClipData['binding'] | undefined;
  timestamps?: Array<{ label: string; timeSeconds: number; loop: boolean }> | undefined;
  bones?: string[] | undefined;
  errors?: unknown;
  oracle?: { source: string; status: 'BLOCKED'; reason: string } | undefined;
  hasExtractedMotion?: boolean;
  rootMotionSampled?: boolean;
  movingBones?: number;
  dynamicPositionTracks?: number;
  dynamicRotationTracks?: number;
  dynamicScaleTracks?: number;
  quantization?: string;
  diagnosticCodes: string[];
  error?: string;
}

const ACTION_ORACLE = {
  source: 'PredatorCZ/HavokLib mature hkaSplineCompressedAnimation semantics',
  status: 'BLOCKED' as const,
  reason: '本次 coverage 未执行独立成熟 oracle 的真实 quantization quaternion differential；合成 probe 已移除。'
};

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
  const mode = parseMode();
  const explicitPath = process.argv.slice(2).find((value) => !value.startsWith('--'))?.trim();
  const gameRoot = resolve(process.env.SOULFORGE_SEKIRO_GAME_ROOT ?? DEFAULT_GAME_ROOT);
  const bridgeExecutablePath = resolve(
    process.env.SOULFORGE_BRIDGE_EXE ?? DEFAULT_BRIDGE
  );
  const defaultFilePath = resolve(explicitPath ?? join(gameRoot, 'chr', 'c0000.anibnd.dcx'));
  const maxFiles = boundedEnvInt('SOULFORGE_ACTION_MAX_FILES', 137, 1, 1000);
  const maxClips = boundedEnvInt('SOULFORGE_ACTION_MAX_CLIPS', 16_384, 1, 100_000);
  const representativesPerFile = boundedEnvInt('SOULFORGE_ACTION_REPRESENTATIVES_PER_FILE', 3, 1, 32);

  if (!existsSync(bridgeExecutablePath)) {
    console.log(JSON.stringify({
      ok: false,
      status: 'BLOCKED',
      authority: 'partial',
      message: 'ACTION corpus coverage 未运行：缺少 Debug Bridge 可执行文件。',
      mode,
      bridgeExecutablePath,
      source: defaultFilePath,
      errors: ['ACTION_REAL_FIXTURE_OR_BRIDGE_MISSING'],
      oracle: ACTION_ORACLE
    }));
    return;
  }

  try {
    const files = mode === 'single'
      ? [defaultFilePath]
      : readdirSync(join(gameRoot, 'chr'), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.anibnd.dcx'))
        .map((entry) => resolve(join(gameRoot, 'chr', entry.name)))
        .sort((a, b) => a.localeCompare(b))
        .slice(0, maxFiles);
    const containers = await mapWithConcurrency(files, 2, (filePath) => readContainer(filePath, gameRoot, bridgeExecutablePath));
    const taeContainers = containers.filter((container) => container.status === 'tae');
    const nonEmptyAnimations = taeContainers.flatMap((container) => container.animations.map((animation) => ({
      ...animation,
      filePath: container.filePath
    })));
    const targets = selectTargets(nonEmptyAnimations, mode, representativesPerFile, maxClips);
    const rows = await mapWithConcurrency(targets, 2, async (target): Promise<CoverageRow> => {
      const result = await runBridge<TaeAnimationClipData>({
        ...bridgeOptions(target.filePath, gameRoot, bridgeExecutablePath),
        command: 'read-tae-animation-clip',
        filePath: target.filePath,
        commandOptions: { animId: target.animId }
      });
      const row = inspectClipResult(target.animId, result);
      return { ...row, filePath: target.filePath };
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

    const scanTruncated = nonEmptyAnimations.length > targets.length || files.length >= maxFiles;
    console.log(JSON.stringify({
      ok: true,
      status: failedRows.length > 0 || unsupportedRows.length > 0 || scanTruncated ? 'partial' : 'PASS',
      authority: 'partial',
      mode,
      source: mode === 'single' ? defaultFilePath : join(gameRoot, 'chr'),
      filesDiscovered: files.length,
      containersWithTae: taeContainers.length,
      containersEmpty: containers.filter((container) => container.status === 'empty').length,
      containerFailures: containers.filter((container) => container.status === 'failed').length,
      animationIdentitiesDiscovered: nonEmptyAnimations.length,
      selectedClipCount: targets.length,
      selectedClipCap: maxClips,
      scanTruncated,
      payloadCount: payloadRows.length,
      unsupportedCount: unsupportedRows.length,
      failedCount: failedRows.length,
      blockedCount: failedRows.length + unsupportedRows.length,
      animationTypes,
      sourceFormats,
      rootMotionPayloads,
      movingBoneSamples: payloadRows.filter((row) => (row.movingBones ?? 0) >= 2).length,
      quantization: countBy(payloadRows, (row) => row.quantization ?? 'missing'),
      containers: containers.map((container) => ({
        file: container.filePath,
        status: container.status,
        animationCount: container.animationCount,
        diagnosticCodes: container.diagnosticCodes,
        error: container.error
      })),
      failureCodes,
      oracle: ACTION_ORACLE,
      blockedSamples: [...unsupportedRows, ...failedRows].slice(0, 12),
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

function parseMode(): 'single' | 'representative' | 'full' {
  const value = process.argv.find((arg) => arg.startsWith('--mode='))?.slice('--mode='.length)
    ?? process.env.SOULFORGE_ACTION_CORPUS_MODE
    ?? 'single';
  if (value === 'representative' || value === 'full' || value === 'single') return value;
  throw new Error(`未知 ACTION corpus mode: ${value}`);
}

function boundedEnvInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function bridgeOptions(filePath: string, gameRoot: string, bridgeExecutablePath: string) {
  return {
    bridgeExecutablePath,
    allowedRoots: [...new Set([dirname(filePath), gameRoot])],
    oodleRuntimeRoot: process.env.SOULFORGE_OODLE_RUNTIME_ROOT ?? gameRoot,
    timeoutMs: 120_000,
    maxFrameBytes: MAX_FRAME_BYTES
  };
}

async function readContainer(filePath: string, gameRoot: string, bridgeExecutablePath: string): Promise<CorpusContainer> {
  if (!existsSync(filePath)) {
    return { filePath, status: 'failed', animationCount: 0, animations: [], diagnosticCodes: ['FILE_NOT_FOUND'], error: '文件不存在。' };
  }
  const result = await runBridge<TaeEnvelope>({
    ...bridgeOptions(filePath, gameRoot, bridgeExecutablePath),
    command: 'read-tae-document',
    filePath
  });
  const diagnosticCodes = result.diagnostics.map((diagnostic) => diagnostic.code);
  if (result.data && result.parseStatus !== 'failed' && result.parseStatus !== 'unsupported') {
    const envelope = result.data;
    assert.equal(envelope.format, 'TAE');
    assert.equal(envelope.animationCount, envelope.animations?.length ?? 0);
    const animations = envelope.animations ?? [];
    const identities = new Set<number>();
    for (const animation of animations) {
      assert.ok(Number.isInteger(animation.animId), `非法 animation ID: ${animation.animId}`);
      assert.ok(!identities.has(animation.animId), `TAE animation ID 重复: ${animation.animId}`);
      identities.add(animation.animId);
    }
    return { filePath, status: 'tae', animationCount: animations.length, animations, diagnosticCodes };
  }
  if (diagnosticCodes.includes('TAE_ANIBND_NO_TAE_ENTRY')) {
    return { filePath, status: 'empty', animationCount: 0, animations: [], diagnosticCodes };
  }
  return {
    filePath,
    status: 'failed',
    animationCount: 0,
    animations: [],
    diagnosticCodes,
    error: result.diagnostics[0]?.message ?? `read-tae-document parseStatus=${result.parseStatus}`
  };
}

function selectTargets(
  animations: ClipTarget[],
  mode: 'single' | 'representative' | 'full',
  representativesPerFile: number,
  maxClips: number
): ClipTarget[] {
  const sorted = [...animations].sort((a, b) => a.filePath.localeCompare(b.filePath) || a.animId - b.animId);
  if (mode !== 'representative') return sorted.slice(0, maxClips);
  const byFile = new Map<string, ClipTarget[]>();
  for (const animation of sorted) byFile.set(animation.filePath, [...(byFile.get(animation.filePath) ?? []), animation]);
  const selected: ClipTarget[] = [];
  for (const fileAnimations of byFile.values()) {
    const indexes = new Set([0, Math.floor((fileAnimations.length - 1) / 2), fileAnimations.length - 1]);
    for (const index of [...indexes].sort((a, b) => a - b).slice(0, representativesPerFile)) selected.push(fileAnimations[index]!);
  }
  return selected.slice(0, maxClips);
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
      errors: result.diagnostics,
      oracle: ACTION_ORACLE,
      error: result.diagnostics[0]?.message ?? `Bridge parseStatus=${result.parseStatus}`
    };
  }
  if (result.parseStatus === 'failed' || !result.data) {
    return {
      animId,
      status: 'failed',
      diagnosticCodes,
      errors: result.diagnostics,
      oracle: ACTION_ORACLE,
      error: result.diagnostics[0]?.message ?? 'Bridge 返回 failed 但没有诊断。'
    };
  }

  const clip = result.data;
  try {
    const nativeClip = clip as unknown as {
      splineBlocks?: Array<{ tracks?: Array<{ rotationQuantization?: number }> }>;
    };
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
        motionAnimId: clip.motionAnimId,
        sourceHash: clip.sourceHash,
        animationContainerHash: clip.animationContainerHash,
        skeletonContainerHash: clip.skeletonContainerHash,
        animationType: clip.animationType,
        type: clip.animationType,
        sourceFormat: clip.sourceFormat,
        frameCount: clip.frameCount,
        duration: clip.duration,
        trackCount: clip.transformTrackCount,
        boneCount: clip.hkxBoneCount,
        track: { count: clip.transformTrackCount, trackToHkxBone: clip.trackToHkxBone },
        skeleton: clip.skeleton,
        binding: clip.binding,
        timestamps: [],
        bones: clip.hkxBoneNames,
        errors: result.diagnostics,
        oracle: ACTION_ORACLE,
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
    const splineRows = clip.animationType === 'SplineCompressed'
      ? ((clip.splineBlocks ?? []).flatMap((block) => block.tracks ?? []))
      : [];
    const dynamicPositionTracks = splineRows.filter((track) =>
      track.positionX || track.positionY || track.positionZ).length;
    const dynamicRotationTracks = splineRows.filter((track) => track.rotation).length;
    const dynamicScaleTracks = splineRows.filter((track) =>
      track.scaleX || track.scaleY || track.scaleZ).length;

    return {
      animId,
      status: 'payload',
      sourceHash: clip.sourceHash,
      animationContainerHash: clip.animationContainerHash,
      skeletonContainerHash: clip.skeletonContainerHash,
      motionAnimId: clip.motionAnimId,
      animationType: clip.animationType,
      type: clip.animationType,
      sourceFormat: clip.sourceFormat,
      frameCount: clip.frameCount,
      duration: clip.duration,
      trackCount: clip.transformTrackCount,
      boneCount: clip.hkxBoneCount,
      track: { count: clip.transformTrackCount, trackToHkxBone: clip.trackToHkxBone },
      skeleton: clip.skeleton,
      binding: clip.binding,
      timestamps: [0, 0.25, 0.5, 0.75, 1].map((fraction) => ({
        label: fraction === 0 ? 't=0' : fraction === 1 ? 't=end' : `t=${fraction * 100}%`,
        timeSeconds: clip.duration * fraction,
        loop: false
      })),
      bones: clip.hkxBoneNames,
      errors: { nativeDifferential: 'not-run-in-coverage' },
      oracle: ACTION_ORACLE,
      hasExtractedMotion: clip.hasExtractedMotion === true,
      rootMotionSampled,
      movingBones,
      dynamicPositionTracks,
      dynamicRotationTracks,
      dynamicScaleTracks,
      quantization: clip.animationType === 'SplineCompressed'
        ? [...new Set((nativeClip.splineBlocks ?? []).flatMap((block) =>
          (block.tracks ?? []).map((track) => String(track.rotationQuantization ?? 'missing'))))].sort().join(',')
        : 'interleaved',
      diagnosticCodes
    };
  } catch (error) {
    return {
      animId,
      status: 'failed',
      diagnosticCodes,
      errors: [error instanceof Error ? error.message : String(error)],
      oracle: ACTION_ORACLE,
      error: `PAYLOAD_CONTRACT: ${error instanceof Error ? error.message : String(error)}`
    };
  }
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
