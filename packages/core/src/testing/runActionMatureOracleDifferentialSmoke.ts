import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  ActionContinuousSampler,
  type BoneTransformData,
  type BridgeResult,
  type SplineBlockData,
  type SplineCurveData,
  type SplineQuatCurveData,
  type TaeAnimationClipData,
  type TransformSplineTrackData
} from '@soulforge/shared';
import { disposeBridgeDaemonPool, runBridge } from '../bridge/runBridge.js';

const execFileAsync = promisify(execFile);

const DEFAULT_GAME_ROOT = 'D:/mystream/Sekiro Shadows Die Twice/Sekiro';
const DEFAULT_BRIDGE = 'D:/Repository/SoulForge/bridge/SoulForge.Bridge/bin/Debug/net10.0/win-x64/SoulForge.Bridge.exe';
const DEFAULT_ORACLE_ROOT = 'D:/mystream/Sekiro Shadows Die Twice/tools/DSAnimStudio-4.9.9[Build 4999]';
const ORACLE_REPOSITORY = 'Meowmaritus/SoulsAssetPipeline';
const ORACLE_COMMIT = 'd11caf989c917c7a43e2c7559915b1c5af218153';
const ORACLE_LICENSE = 'GPL-3.0 (external runtime only; no GPL source or binary is committed)';
// SoulsAssetPipeline exposes float transforms through a separate runtime
// path; the real fixture's worst static translation delta is 2.8834882e-4.
// Keep the observed, bounded 5e-4 envelope explicit rather than silently
// rounding the differential away.
const TRANSLATION_TOLERANCE = 5e-4;
const ROTATION_ANGLE_TOLERANCE = 5e-4;
const SCALE_TOLERANCE = 2e-4;

interface DifferentialPoint {
  label: string;
  timeSeconds: number;
  loop: boolean;
}

interface OracleTransform {
  translation: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

interface OracleSample extends DifferentialPoint {
  tracks: OracleTransform[];
}

interface MatureOracleResult {
  ok: true;
  sourceContainer: string;
  sourceContainerHash: string;
  baseContainer: string;
  baseContainerHash: string;
  animationEntry: string;
  animationEntryHash: string;
  compendiumHash: string;
  animationType: string;
  animId: number;
  duration: number;
  frameCount: number;
  transformTrackCount: number;
  blockCount: number;
  framesPerBlock: number;
  binding: {
    originalSkeletonName: string;
    blendHint: number;
    transformTrackToBoneIndices: number[];
  };
  skeleton: {
    name: string;
    boneNames: string[];
  };
  samples: OracleSample[];
  oracleAssemblyHash: string;
}

interface DifferentialMetrics {
  maxTranslationError: number;
  maxQuaternionAngularError: number;
  maxScaleError: number;
  movingBoneCount: number;
  movingBoneNames: string[];
}

interface DifferentialReport {
  ok: boolean;
  status: 'PASS' | 'FAIL' | 'BLOCKED';
  authority: 'partial';
  sourceContainer: string;
  sourceHash?: string;
  animationContainerHash?: string;
  skeletonContainerHash?: string;
  animId: number;
  motionAnimId?: number;
  animationType?: string;
  track?: { count: number; trackToHkxBone: number[] };
  skeleton?: { count: number; sampledBones: string[] };
  binding?: TaeAnimationClipData['binding'];
  rawSpline?: {
    bytes: number;
    sha256: string;
    maskAndQuantizationSize: number;
    blockCount: number;
    blockOffsets: number[];
    floatBlockOffsets: number[];
    transformOffsets: number[];
    maskBytesValidated: number;
    quantization: {
      position: Record<string, number>;
      rotation: Record<string, number>;
      scale: Record<string, number>;
    };
    independentPoseErrors?: {
      translation: number;
      quaternionAngular: number;
      scale: number;
    };
  };
  timestamps: DifferentialPoint[];
  sampledBones?: Array<{
    name: string;
    hkxBoneIndex: number;
    samples: Array<{
      label: string;
      translation: [number, number, number];
      rotation: [number, number, number, number];
      scale: [number, number, number];
    }>;
  }>;
  errors?: {
    translation: number;
    quaternionAngular: number;
    scale: number;
  };
  metrics?: DifferentialMetrics;
  oracle: {
    repository: string;
    commit: string;
    license: string;
    runtimeAssemblySha256?: string;
    sourceContainer?: string;
    sourceHash?: string;
    animationEntry?: string;
    animationEntryHash?: string;
    compendiumHash?: string;
    status: 'PASS' | 'FAIL' | 'BLOCKED';
    reason?: string;
  };
  diagnostics?: string[];
  nonClaims: string[];
}

class MatureOracleBlockedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MatureOracleBlockedError';
  }
}

/**
 * Real ACTION differential against the external SoulsAssetPipeline runtime.
 *
 * The oracle is intentionally not a dependency of SoulForge and is never
 * loaded by production code. A short-lived PowerShell reflection process
 * invokes the installed GPL tool against the user's real c0000 corpus and
 * returns only hashes, metadata, binding identity, and sampled transforms.
 * The repository contains no oracle source, DLL, or game bytes.
 */
export async function runActionMatureOracleDifferentialSmoke(): Promise<void> {
  const gameRoot = resolve(process.env.SOULFORGE_SEKIRO_GAME_ROOT ?? DEFAULT_GAME_ROOT);
  const bridgeExecutablePath = resolve(process.env.SOULFORGE_BRIDGE_EXE ?? DEFAULT_BRIDGE);
  const oracleRoot = resolve(process.env.SOULFORGE_ACTION_ORACLE_ROOT ?? DEFAULT_ORACLE_ROOT);
  const sourceFilePath = join(gameRoot, 'chr', 'c0000.anibnd.dcx');
  const baseReport = createBaseReport(sourceFilePath);

  try {
    if (!existsSync(sourceFilePath)) {
      throw new MatureOracleBlockedError(`真实 Sekiro source 不存在：${sourceFilePath}`);
    }
    if (!existsSync(bridgeExecutablePath)) {
      throw new MatureOracleBlockedError(`Debug Bridge 不存在：${bridgeExecutablePath}`);
    }
    if (!existsSync(join(oracleRoot, 'SoulsAssetPipeline.dll'))
      || !existsSync(join(oracleRoot, 'SoulsFormats.dll'))) {
      throw new MatureOracleBlockedError(
        `成熟 oracle runtime 不完整：需要 ${join(oracleRoot, 'SoulsAssetPipeline.dll')} 和 SoulsFormats.dll`
      );
    }

    const bridgeOptions = {
      bridgeExecutablePath,
      allowedRoots: [gameRoot] as string[],
      oodleRuntimeRoot: gameRoot,
      timeoutMs: 120_000,
      maxFrameBytes: 16 * 1024 * 1024
    };
    const clipResult = await runBridge<TaeAnimationClipData>({
      ...bridgeOptions,
      command: 'read-tae-animation-clip',
      filePath: sourceFilePath,
      commandOptions: { animId: 10, includeRawSplinePayload: true }
    });
    const clip = requireData(clipResult, 'read-tae-animation-clip');
    const bridgeSourceContainer = clip.sourceContainer?.trim();
    if (!bridgeSourceContainer) {
      throw new MatureOracleBlockedError(
        `Bridge 未返回可用 sourceContainer：${clip.sourceContainer ?? '<empty>'}`
      );
    }
    // Bridge intentionally returns the selected animation container as a
    // basename to avoid leaking arbitrary absolute paths. Resolve it only
    // against the already allow-listed game's chr directory; the canonical
    // c0000.anibnd.dcx remains the base/skeleton container for the oracle.
    if (basename(bridgeSourceContainer) !== bridgeSourceContainer) {
      throw new MatureOracleBlockedError(
        `Bridge sourceContainer 不是安全 basename：${bridgeSourceContainer}`
      );
    }
    const sourceContainer = resolve(dirname(sourceFilePath), bridgeSourceContainer);
    if (!existsSync(sourceContainer)) {
      throw new MatureOracleBlockedError(
        `Bridge sourceContainer 不存在于 canonical chr 目录：${sourceContainer}`
      );
    }
    if (clip.animationType !== 'SplineCompressed' || !clip.splineBlocks?.length) {
      throw new Error(
        `真实 animId=10 没有可差分的 SplineCompressed payload：type=${clip.animationType}, blocks=${clip.splineBlocks?.length ?? 0}`
      );
    }
    const rawPayload = decodeRawSplinePayload(clip);

    const points: DifferentialPoint[] = [
      { label: 't=0', timeSeconds: 0, loop: false },
      { label: 't=25%', timeSeconds: clip.duration * 0.25, loop: false },
      { label: 't=50%', timeSeconds: clip.duration * 0.5, loop: false },
      { label: 't=75%', timeSeconds: clip.duration * 0.75, loop: false },
      { label: 't=end', timeSeconds: clip.duration, loop: false }
    ];
    const oracle = await runExternalOracle({
      oracleRoot,
      sourceContainer,
      baseContainer: sourceFilePath,
      animId: clip.animId,
      points
    });
    const report = compareClipToOracle({
      clip,
      sourceFilePath,
      sourceContainer,
      points,
      oracle,
      rawSpline: rawPayload.report,
      rawSplineBlocks: rawPayload.blocks
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    const blocked = error instanceof MatureOracleBlockedError;
    const report: DifferentialReport = {
      ...baseReport,
      ok: false,
      status: blocked ? 'BLOCKED' : 'FAIL',
      oracle: {
        ...baseReport.oracle,
        status: blocked ? 'BLOCKED' : 'FAIL',
        reason: error instanceof Error ? error.message : String(error)
      },
      diagnostics: [error instanceof Error ? error.message : String(error)]
    };
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
  } finally {
    await disposeBridgeDaemonPool();
  }
}

async function runExternalOracle(options: {
  oracleRoot: string;
  sourceContainer: string;
  baseContainer: string;
  animId: number;
  points: DifferentialPoint[];
}): Promise<MatureOracleResult> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    SOULFORGE_ACTION_ORACLE_ROOT: options.oracleRoot,
    SOULFORGE_ACTION_ORACLE_SOURCE_CONTAINER: options.sourceContainer,
    SOULFORGE_ACTION_ORACLE_BASE_CONTAINER: options.baseContainer,
    SOULFORGE_ACTION_ORACLE_ANIM_ID: String(options.animId),
    SOULFORGE_ACTION_ORACLE_POINTS: JSON.stringify(options.points)
  };
  let stdout = '';
  let stderr = '';
  try {
    const result = await execFileAsync(
      process.env.SOULFORGE_ACTION_ORACLE_PWSH
        ?? (process.platform === 'win32' ? 'pwsh.exe' : 'pwsh'),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(MATURE_ORACLE_POWERSHELL, 'utf16le').toString('base64')
      ],
      {
        cwd: options.oracleRoot,
        env: environment,
        windowsHide: true,
        timeout: 120_000,
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8'
      }
    );
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new MatureOracleBlockedError(
      `外部 mature oracle 进程未成功完成：${details}`
    );
  }

  const lastLine = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
  if (!lastLine) {
    throw new MatureOracleBlockedError(
      `外部 mature oracle 没有 JSON 输出${stderr ? `；stderr=${stderr.trim()}` : ''}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(lastLine) as unknown;
  } catch (error) {
    throw new MatureOracleBlockedError(
      `外部 mature oracle 输出不是 JSON：${error instanceof Error ? error.message : String(error)}；stdout=${stdout.slice(-2000)}`
    );
  }
  if (!isRecord(parsed) || parsed.ok !== true) {
    const message = isRecord(parsed) && typeof parsed.message === 'string'
      ? parsed.message
      : 'oracle 返回了非成功 payload';
    throw new MatureOracleBlockedError(message);
  }
  return decodeOracleResult(parsed);
}

function compareClipToOracle(options: {
  clip: TaeAnimationClipData;
  sourceFilePath: string;
  sourceContainer: string;
  points: DifferentialPoint[];
  oracle: MatureOracleResult;
  rawSpline: NonNullable<DifferentialReport['rawSpline']>;
  rawSplineBlocks: SplineBlockData[];
}): DifferentialReport {
  const {
    clip,
    sourceFilePath,
    sourceContainer,
    points,
    oracle,
    rawSpline,
    rawSplineBlocks
  } = options;
  const sampler = new ActionContinuousSampler(clip);
  const issues: string[] = [];
  const metrics: DifferentialMetrics = {
    maxTranslationError: 0,
    maxQuaternionAngularError: 0,
    maxScaleError: 0,
    movingBoneCount: 0,
    movingBoneNames: []
  };
  let worstTranslation: { error: number; track: number; label: string; hkxBone: number } | undefined;
  const sourceHash = sha256FileSync(sourceFilePath);
  const animationContainerHash = sha256FileSync(sourceContainer);

  if (oracle.baseContainerHash !== sourceHash) {
    issues.push(`base container hash mismatch: oracle=${oracle.baseContainerHash} local=${sourceHash}`);
  }
  if (oracle.sourceContainerHash !== animationContainerHash) {
    issues.push(`animation container hash mismatch: oracle=${oracle.sourceContainerHash} local=${animationContainerHash}`);
  }
  if (clip.sourceHash !== oracle.baseContainerHash) {
    issues.push(`Bridge sourceHash mismatch: bridge=${clip.sourceHash ?? '<missing>'} oracle=${oracle.baseContainerHash}`);
  }
  if (clip.animationContainerHash !== oracle.sourceContainerHash) {
    issues.push(`Bridge animationContainerHash mismatch: bridge=${clip.animationContainerHash ?? '<missing>'} oracle=${oracle.sourceContainerHash}`);
  }
  if (clip.animId !== oracle.animId) issues.push(`animId mismatch: bridge=${clip.animId} oracle=${oracle.animId}`);
  if (clip.animationType !== oracle.animationType) {
    issues.push(`animation type mismatch: bridge=${clip.animationType} oracle=${oracle.animationType}`);
  }
  if (Math.abs(clip.duration - oracle.duration) > 1e-6) {
    issues.push(`duration mismatch: bridge=${clip.duration} oracle=${oracle.duration}`);
  }
  if (clip.frameCount !== oracle.frameCount) {
    issues.push(`frame count mismatch: bridge=${clip.frameCount} oracle=${oracle.frameCount}`);
  }
  if (clip.transformTrackCount !== oracle.transformTrackCount) {
    issues.push(`track count mismatch: bridge=${clip.transformTrackCount} oracle=${oracle.transformTrackCount}`);
  }
  if (rawSpline.blockCount !== oracle.blockCount) {
    issues.push(`raw spline block count mismatch: bridge=${rawSpline.blockCount} oracle=${oracle.blockCount}`);
  }
  if (!sameNumberArray(clip.trackToHkxBone, oracle.binding.transformTrackToBoneIndices)) {
    issues.push('Bridge trackToHkxBone differs from mature binding TransformTrackToBoneIndices.');
  }
  if (clip.binding?.originalSkeletonName !== oracle.binding.originalSkeletonName) {
    issues.push(`skeleton identity mismatch: bridge=${clip.binding?.originalSkeletonName ?? '<missing>'} oracle=${oracle.binding.originalSkeletonName}`);
  }
  if (clip.skeleton?.name !== oracle.skeleton.name) {
    issues.push(`skeleton name mismatch: bridge=${clip.skeleton?.name ?? '<missing>'} oracle=${oracle.skeleton.name}`);
  }
  if (!sameStringArray(clip.hkxBoneNames, oracle.skeleton.boneNames)) {
    issues.push('Bridge HKX bone names differ from mature skeleton names.');
  }

  const bridgeSamples = new Map<string, BoneTransformData[]>();
  // Decode the returned data section independently from Bridge's structured
  // splineBlocks. The mature oracle comparison below still uses the Bridge
  // sampler, while this second sampler proves that raw masks, quantization,
  // offsets and compressed controls reconstruct the same poses.
  const rawSampler = new ActionContinuousSampler({
    ...clip,
    splineBlocks: rawSplineBlocks
  });
  const rawSamples = new Map<string, BoneTransformData[]>();
  for (const point of points) {
    bridgeSamples.set(point.label, sampler.sampleHkxPose(point.timeSeconds, point.loop));
    rawSamples.set(point.label, rawSampler.sampleHkxPose(point.timeSeconds, point.loop));
  }

  const independentPoseErrors = {
    translation: 0,
    quaternionAngular: 0,
    scale: 0
  };
  for (const point of points) {
    const bridgePose = bridgeSamples.get(point.label)!;
    const rawPose = rawSamples.get(point.label)!;
    if (bridgePose.length !== rawPose.length) {
      issues.push(`independent raw pose bone count mismatch at ${point.label}: bridge=${bridgePose.length}, raw=${rawPose.length}`);
      continue;
    }
    for (let bone = 0; bone < bridgePose.length; bone++) {
      const bridge = bridgePose[bone]!;
      const raw = rawPose[bone]!;
      independentPoseErrors.translation = Math.max(
        independentPoseErrors.translation,
        maxAbs(bridge.translation, raw.translation)
      );
      independentPoseErrors.quaternionAngular = Math.max(
        independentPoseErrors.quaternionAngular,
        quaternionAngularError(bridge.rotation, raw.rotation)
      );
      independentPoseErrors.scale = Math.max(
        independentPoseErrors.scale,
        maxAbs(bridge.scale, raw.scale)
      );
    }
  }
  if (independentPoseErrors.translation > TRANSLATION_TOLERANCE) {
    issues.push(`independent raw translation differential exceeds tolerance: ${independentPoseErrors.translation}`);
  }
  if (independentPoseErrors.quaternionAngular > ROTATION_ANGLE_TOLERANCE) {
    issues.push(`independent raw quaternion differential exceeds tolerance: ${independentPoseErrors.quaternionAngular}`);
  }
  if (independentPoseErrors.scale > SCALE_TOLERANCE) {
    issues.push(`independent raw scale differential exceeds tolerance: ${independentPoseErrors.scale}`);
  }

  const oracleSamplesByLabel = new Map(oracle.samples.map((sample) => [sample.label, sample]));
  for (const point of points) {
    const sample = oracleSamplesByLabel.get(point.label);
    if (!sample) {
      issues.push(`oracle sample missing: ${point.label}`);
      continue;
    }
    if (Math.abs(sample.timeSeconds - point.timeSeconds) > 1e-5 || sample.loop !== point.loop) {
      issues.push(`oracle timestamp mismatch at ${point.label}`);
    }
    const pose = bridgeSamples.get(point.label)!;
    if (sample.tracks.length !== clip.transformTrackCount) {
      issues.push(`oracle track payload mismatch at ${point.label}: ${sample.tracks.length}`);
      continue;
    }
    for (let track = 0; track < sample.tracks.length; track++) {
      const hkxBone = oracle.binding.transformTrackToBoneIndices[track];
      const actual = hkxBone === undefined ? undefined : pose[hkxBone];
      if (!actual) {
        issues.push(`missing Bridge pose for track=${track}, hkxBone=${hkxBone}, point=${point.label}`);
        continue;
      }
      const expected = sample.tracks[track]!;
      const translationError = maxAbs(actual.translation, expected.translation);
      const rotationError = quaternionAngularError(actual.rotation, expected.rotation);
      const scaleError = maxAbs(actual.scale, expected.scale);
      metrics.maxTranslationError = Math.max(metrics.maxTranslationError, translationError);
      metrics.maxQuaternionAngularError = Math.max(metrics.maxQuaternionAngularError, rotationError);
      metrics.maxScaleError = Math.max(metrics.maxScaleError, scaleError);
      if (!worstTranslation || translationError > worstTranslation.error) {
        worstTranslation = { error: translationError, track, label: point.label, hkxBone: hkxBone ?? -1 };
      }
    }
  }

  if (metrics.maxTranslationError > TRANSLATION_TOLERANCE) {
    issues.push(`translation differential exceeds tolerance: ${metrics.maxTranslationError} (track=${worstTranslation?.track ?? -1}, hkxBone=${worstTranslation?.hkxBone ?? -1}, point=${worstTranslation?.label ?? '<unknown>'})`);
  }
  if (metrics.maxQuaternionAngularError > ROTATION_ANGLE_TOLERANCE) {
    issues.push(`quaternion angular differential exceeds tolerance: ${metrics.maxQuaternionAngularError}`);
  }
  if (metrics.maxScaleError > SCALE_TOLERANCE) {
    issues.push(`scale differential exceeds tolerance: ${metrics.maxScaleError}`);
  }

  const firstPose = bridgeSamples.get('t=0')!;
  const sampledPoses = points.map((point) => bridgeSamples.get(point.label)!);
  const movingIndices: number[] = [];
  for (let index = 0; index < firstPose.length; index++) {
    const moved = sampledPoses.some((pose) => {
      const translationDelta = maxAbs(firstPose[index]!.translation, pose[index]!.translation);
      const rotationDelta = quaternionAngularError(firstPose[index]!.rotation, pose[index]!.rotation);
      const scaleDelta = maxAbs(firstPose[index]!.scale, pose[index]!.scale);
      return translationDelta > 1e-5 || rotationDelta > 1e-5 || scaleDelta > 1e-5;
    });
    if (moved) {
      movingIndices.push(index);
    }
  }
  metrics.movingBoneCount = movingIndices.length;
  metrics.movingBoneNames = movingIndices.map((index) => clip.hkxBoneNames[index] ?? `#${index}`);
  if (movingIndices.length === 0) issues.push('五个真实采样时间点没有任何骨骼发生变化。');

  const sampledIndices = chooseSampledBones(clip.hkxBoneNames, movingIndices);
  const sampledBones = sampledIndices.map((hkxBoneIndex) => ({
    name: clip.hkxBoneNames[hkxBoneIndex] ?? `#${hkxBoneIndex}`,
    hkxBoneIndex,
    samples: points.map((point) => {
      const pose = bridgeSamples.get(point.label)![hkxBoneIndex]!;
      return {
        label: point.label,
        translation: pose.translation,
        rotation: pose.rotation,
        scale: pose.scale
      };
    })
  }));

  return {
    ok: issues.length === 0,
    status: issues.length === 0 ? 'PASS' : 'FAIL',
    authority: 'partial',
    sourceContainer: relative(gameRootFromSource(sourceFilePath), sourceContainer),
    sourceHash,
    animationContainerHash,
    skeletonContainerHash: sourceHash,
    animId: clip.animId,
    motionAnimId: clip.motionAnimId,
    animationType: clip.animationType,
    track: { count: clip.transformTrackCount, trackToHkxBone: clip.trackToHkxBone },
    skeleton: { count: clip.hkxBoneCount, sampledBones: sampledBones.map((bone) => bone.name) },
    binding: clip.binding,
    rawSpline: { ...rawSpline, independentPoseErrors },
    timestamps: points,
    sampledBones,
    errors: {
      translation: metrics.maxTranslationError,
      quaternionAngular: metrics.maxQuaternionAngularError,
      scale: metrics.maxScaleError
    },
    metrics,
    oracle: {
      repository: ORACLE_REPOSITORY,
      commit: ORACLE_COMMIT,
      license: ORACLE_LICENSE,
      runtimeAssemblySha256: oracle.oracleAssemblyHash,
      sourceContainer: relative(gameRootFromSource(sourceFilePath), oracle.sourceContainer),
      sourceHash: oracle.baseContainerHash,
      animationEntry: oracle.animationEntry,
      animationEntryHash: oracle.animationEntryHash,
      compendiumHash: oracle.compendiumHash,
      status: issues.length === 0 ? 'PASS' : 'FAIL',
      ...(issues.length ? { reason: issues.join('; ') } : {})
    },
    ...(issues.length ? { diagnostics: issues } : {}),
    nonClaims: [
      '仅证明当前真实 c0000 animId=10 与外部成熟 runtime 的 clip/pose differential；不代表全 corpus 或 renderer mesh deformation 已完成。',
      'raw mask、block offsets、scalar/rotation quantization 与 compressed controls 已由独立 clean-room decoder 重建并与 Bridge pose 对比；当前样本只覆盖 position/rotation/scale quantization=1，不代表全部 Havok quantization。',
      '外部 GPL runtime 仅在开发期测试进程中加载；仓库不包含其源代码、DLL 或真实游戏资产。',
      'oracle.commit 是外部源码版本记录，runtimeAssemblySha256 是实际加载 DLL 的身份指纹；二者共同提供 provenance，但不单独证明该 DLL 必然由该 commit 构建。',
      '未将 root motion 自动叠加到骨骼；root motion 仍由 Bridge 的明确数据通道负责。'
    ]
  };
}

function createBaseReport(sourceContainer: string): DifferentialReport {
  return {
    ok: false,
    status: 'BLOCKED',
    authority: 'partial',
    sourceContainer,
    animId: 10,
    timestamps: [],
    oracle: {
      repository: ORACLE_REPOSITORY,
      commit: ORACLE_COMMIT,
      license: ORACLE_LICENSE,
      status: 'BLOCKED'
    },
    nonClaims: [
      '环境缺失或 oracle 进程失败时不得把真实 fixture 标成 skipped/pass。'
    ]
  };
}

interface DecodedRawSplinePayload {
  report: NonNullable<DifferentialReport['rawSpline']>;
  blocks: SplineBlockData[];
}

interface RawSplineMask {
  positionQuantization: number;
  rotationQuantization: number;
  scaleQuantization: number;
  position: number;
  rotation: number;
  scale: number;
}

interface RawVectorSpline {
  staticMask: number;
  splineMask: number;
  staticValue: [number, number, number];
  x?: SplineCurveData;
  y?: SplineCurveData;
  z?: SplineCurveData;
}

function decodeRawSplinePayload(clip: TaeAnimationClipData): DecodedRawSplinePayload {
  const encoded = clip.splineRawPayloadBase64?.trim();
  const maskAndQuantizationSizeValue = clip.splineMaskAndQuantizationSize;
  const blockCountValue = clip.splineNumBlocks;
  if (!encoded || typeof maskAndQuantizationSizeValue !== 'number'
    || !Number.isInteger(maskAndQuantizationSizeValue) || maskAndQuantizationSizeValue <= 0
    || typeof blockCountValue !== 'number' || !Number.isInteger(blockCountValue) || blockCountValue <= 0) {
    throw new Error('Bridge 未返回完整 raw spline payload、maskAndQuantizationSize 或 blockCount。');
  }
  const maskAndQuantizationSize = maskAndQuantizationSizeValue;
  const blockCount = blockCountValue;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(encoded, 'base64');
  } catch (error) {
    throw new Error(`raw spline payload base64 解码失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (bytes.length === 0) throw new Error('raw spline payload 为空。');
  const canonical = bytes.toString('base64').replace(/=+$/u, '');
  if (canonical !== encoded.replace(/=+$/u, '')) {
    throw new Error('raw spline payload 不是规范 base64。');
  }

  const blockOffsets = clip.splineBlockOffsets ?? [];
  const floatBlockOffsets = clip.splineFloatBlockOffsets ?? [];
  const transformOffsets = clip.splineTransformOffsets ?? [];
  const trackCount = clip.transformTrackCount;
  if (clip.splineBlocks?.length !== blockCountValue
    || blockOffsets.length !== blockCount
    || blockOffsets[0] !== 0
    || blockOffsets.some((offset) => !Number.isInteger(offset) || offset < 0 || offset >= bytes.length)) {
    throw new Error(
      `raw spline payload layout metadata 不一致：blocks=${clip.splineBlocks?.length ?? 0}, numBlocks=${blockCount}, offsets=${blockOffsets.length}, bytes=${bytes.length}`
    );
  }
  if (trackCount <= 0 || !Number.isInteger(trackCount)) {
    throw new Error(`raw spline transform track count 无效：${trackCount}`);
  }
  if (transformOffsets.length !== 0 && transformOffsets.length !== trackCount) {
    throw new Error(
      `raw spline transformOffsets 数量不一致：expected=${trackCount}, actual=${transformOffsets.length}`
    );
  }
  if (transformOffsets.length !== 0) {
    throw new Error(
      'raw spline transformOffsets 非空；当前 clean-room decoder 不把未经验证的 per-track offsets 冒充为已解码语义。'
    );
  }
  if (floatBlockOffsets.length > blockCount + 1
    || floatBlockOffsets.some((offset) => !Number.isInteger(offset) || offset < 0 || offset > bytes.length)) {
    throw new Error(`raw spline floatBlockOffsets 超出 payload：count=${floatBlockOffsets.length}, bytes=${bytes.length}`);
  }
  for (let index = 1; index < blockOffsets.length; index++) {
    if (blockOffsets[index]! < blockOffsets[index - 1]!) {
      throw new Error(`raw spline blockOffsets 非单调：${blockOffsets[index - 1]} -> ${blockOffsets[index]}`);
    }
  }

  const quantization = {
    position: {} as Record<string, number>,
    rotation: {} as Record<string, number>,
    scale: {} as Record<string, number>
  };
  let maskBytesValidated = 0;
  const blocks: SplineBlockData[] = [];
  for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
    const blockStart = blockOffsets[blockIndex]!;
    const blockEnd = blockIndex + 1 < blockCount ? blockOffsets[blockIndex + 1]! : bytes.length;
    if (blockStart < 0 || blockEnd <= blockStart || blockEnd > bytes.length) {
      throw new Error(`raw spline block ${blockIndex} bounds 无效：${blockStart}..${blockEnd}/${bytes.length}`);
    }
    const maskEnd = blockStart + maskAndQuantizationSize;
    if (maskEnd > blockEnd) {
      throw new Error(`raw spline block ${blockIndex} mask 区域越界：${maskEnd} > ${blockEnd}`);
    }
    const maskReader = new RawSplineReader(bytes, blockStart, maskEnd);
    const masks: RawSplineMask[] = [];
    for (let trackIndex = 0; trackIndex < trackCount; trackIndex++) {
      const mask = readRawSplineMask(maskReader, trackIndex);
      masks.push(mask);
      incrementCount(quantization.position, mask.positionQuantization);
      incrementCount(quantization.rotation, mask.rotationQuantization);
      incrementCount(quantization.scale, mask.scaleQuantization);
    }
    maskReader.align(4);
    if (maskReader.position > maskEnd) {
      throw new Error(`raw spline block ${blockIndex} mask 区域截断：${maskReader.position} > ${maskEnd}`);
    }
    const reader = new RawSplineReader(bytes, maskEnd, blockEnd);
    const tracks = masks.map((mask, trackIndex) => readRawSplineTrack(reader, mask, trackIndex));
    reader.align(16);
    if (reader.position !== blockEnd) {
      throw new Error(
        `raw spline block ${blockIndex} 存在未解析 payload：cursor=${reader.position}, end=${blockEnd}`
      );
    }
    maskBytesValidated += maskAndQuantizationSize;
    blocks.push({ tracks });
  }

  return {
    report: {
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      maskAndQuantizationSize,
      blockCount,
      blockOffsets: [...blockOffsets],
      floatBlockOffsets: [...floatBlockOffsets],
      transformOffsets: [...transformOffsets],
      maskBytesValidated,
      quantization
    },
    blocks
  };
}

class RawSplineReader {
  private positionValue: number;

  public constructor(
    private readonly bytes: Buffer,
    private readonly start: number,
    private readonly end: number
  ) {
    if (start < 0 || end < start || end > bytes.length) {
      throw new Error(`raw spline reader bounds 无效：${start}..${end}/${bytes.length}`);
    }
    this.positionValue = start;
  }

  public get position(): number {
    return this.positionValue;
  }

  public readByte(): number {
    this.ensure(1);
    return this.bytes[this.positionValue++]!;
  }

  public readInt16(): number {
    this.ensure(2);
    const value = this.bytes.readInt16LE(this.positionValue);
    this.positionValue += 2;
    return value;
  }

  public readUInt16(): number {
    this.ensure(2);
    const value = this.bytes.readUInt16LE(this.positionValue);
    this.positionValue += 2;
    return value;
  }

  public readFloat(): number {
    this.ensure(4);
    const value = this.bytes.readFloatLE(this.positionValue);
    this.positionValue += 4;
    return value;
  }

  public readBytes(count: number): Buffer {
    if (!Number.isInteger(count) || count < 0) throw new Error(`raw spline read length 无效：${count}`);
    this.ensure(count);
    const value = this.bytes.subarray(this.positionValue, this.positionValue + count);
    this.positionValue += count;
    return value;
  }

  public align(alignment: number): void {
    if (alignment <= 0) return;
    const remainder = this.positionValue % alignment;
    if (remainder === 0) return;
    this.ensure(alignment - remainder);
    this.positionValue += alignment - remainder;
  }

  private ensure(count: number): void {
    if (count < 0 || this.positionValue + count > this.end) {
      throw new Error(
        `raw spline compressed payload 截断：offset=0x${this.positionValue.toString(16)}, need=${count}, end=0x${this.end.toString(16)}`
      );
    }
  }
}

function readRawSplineMask(reader: RawSplineReader, trackIndex: number): RawSplineMask {
  const packedQuantization = reader.readByte();
  const position = reader.readByte();
  const rotation = reader.readByte();
  const scale = reader.readByte();
  const positionQuantization = packedQuantization & 0x03;
  const rotationQuantization = (packedQuantization >> 2) & 0x0F;
  const scaleQuantization = (packedQuantization >> 6) & 0x03;
  if (positionQuantization > 1 || scaleQuantization > 1) {
    throw new Error(
      `raw spline track ${trackIndex} 使用未验证的 scalar quantization：position=${positionQuantization}, scale=${scaleQuantization}`
    );
  }
  if (rotationQuantization > 5) {
    throw new Error(`raw spline track ${trackIndex} 使用未验证的 rotation quantization：${rotationQuantization}`);
  }
  if ((position & 0x88) !== 0 || (scale & 0x88) !== 0) {
    throw new Error(
      `raw spline track ${trackIndex} vector mask 含未验证 W 位：position=0x${position.toString(16)}, scale=0x${scale.toString(16)}`
    );
  }
  return { positionQuantization, rotationQuantization, scaleQuantization, position, rotation, scale };
}

function readRawSplineTrack(
  reader: RawSplineReader,
  mask: RawSplineMask,
  trackIndex: number
): TransformSplineTrackData {
  let staticPosition: [number, number, number] = [0, 0, 0];
  let staticRotation: [number, number, number, number] = [0, 0, 0, 1];
  let staticScale: [number, number, number] = [1, 1, 1];
  let positionStaticMask = 0;
  let positionSplineMask = 0;
  let scaleStaticMask = 0;
  let scaleSplineMask = 0;
  let positionX: SplineCurveData | undefined;
  let positionY: SplineCurveData | undefined;
  let positionZ: SplineCurveData | undefined;
  let rotation: SplineQuatCurveData | undefined;
  let scaleX: SplineCurveData | undefined;
  let scaleY: SplineCurveData | undefined;
  let scaleZ: SplineCurveData | undefined;

  if (hasRawSpline(mask.position)) {
    const vector = readRawVectorSpline(reader, mask.position, mask.positionQuantization, true, trackIndex);
    staticPosition = vector.staticValue;
    positionStaticMask = vector.staticMask;
    positionSplineMask = vector.splineMask;
    positionX = vector.x;
    positionY = vector.y;
    positionZ = vector.z;
  } else {
    const result = readRawStaticVector(reader, mask.position, staticPosition);
    staticPosition = result.value;
    positionStaticMask = result.mask;
  }
  reader.align(4);

  const rotationHasSpline = hasRawSpline(mask.rotation);
  const rotationHasStatic = hasRawStatic(mask.rotation);
  if (rotationHasSpline) {
    rotation = readRawQuaternionSpline(reader, mask.rotationQuantization, trackIndex);
  } else if (rotationHasStatic) {
    reader.align(rawRotationAlignment(mask.rotationQuantization));
    staticRotation = readRawQuantizedQuaternion(reader, mask.rotationQuantization, trackIndex);
  }
  reader.align(4);

  if (hasRawSpline(mask.scale)) {
    const vector = readRawVectorSpline(reader, mask.scale, mask.scaleQuantization, false, trackIndex);
    staticScale = vector.staticValue;
    scaleStaticMask = vector.staticMask;
    scaleSplineMask = vector.splineMask;
    scaleX = vector.x;
    scaleY = vector.y;
    scaleZ = vector.z;
  } else {
    const result = readRawStaticVector(reader, mask.scale, staticScale);
    staticScale = result.value;
    scaleStaticMask = result.mask;
  }
  reader.align(4);

  return {
    positionStaticMask,
    positionSplineMask,
    rotationHasStatic,
    rotationHasSpline,
    scaleStaticMask,
    scaleSplineMask,
    staticPosition,
    staticRotation,
    staticScale,
    positionX,
    positionY,
    positionZ,
    rotation,
    scaleX,
    scaleY,
    scaleZ
  };
}

function readRawVectorSpline(
  reader: RawSplineReader,
  mask: number,
  quantization: number,
  isPosition: boolean,
  trackIndex: number
): RawVectorSpline {
  const num = reader.readInt16();
  const degree = reader.readByte();
  if (num < 0 || degree > 3) {
    throw new Error(
      `raw spline track ${trackIndex} ${isPosition ? 'position' : 'scale'} NURBS header 无效：num=${num}, degree=${degree}`
    );
  }
  const controlPointCount = num + 1;
  const knotCount = controlPointCount + degree + 1;
  const knots = Array.from({ length: knotCount }, () => reader.readByte());
  reader.align(4);

  const staticValue: [number, number, number] = isPosition ? [0, 0, 0] : [1, 1, 1];
  const mins = [0, 0, 0];
  const maxs = [0, 0, 0];
  let staticMask = 0;
  let splineMask = 0;
  const staticFlags = [0x01, 0x02, 0x04];
  const splineFlags = [0x10, 0x20, 0x40];
  for (let component = 0; component < 3; component++) {
    if ((mask & splineFlags[component]!) !== 0) {
      const min = reader.readFloat();
      const max = reader.readFloat();
      if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) {
        throw new Error(
          `raw spline track ${trackIndex} ${isPosition ? 'position' : 'scale'} component ${component} quantization range 无效`
        );
      }
      mins[component] = min;
      maxs[component] = max;
      splineMask |= 1 << component;
    } else if ((mask & staticFlags[component]!) !== 0) {
      const value = reader.readFloat();
      if (!Number.isFinite(value)) throw new Error(`raw spline track ${trackIndex} static vector 含非 finite 值`);
      staticValue[component] = value;
      staticMask |= 1 << component;
    }
  }

  const values = [
    (splineMask & 0x01) !== 0 ? [] as number[] : undefined,
    (splineMask & 0x02) !== 0 ? [] as number[] : undefined,
    (splineMask & 0x04) !== 0 ? [] as number[] : undefined
  ];
  for (let index = 0; index < controlPointCount; index++) {
    for (let component = 0; component < 3; component++) {
      const channel = values[component];
      if (channel) channel.push(readRawQuantizedScalar(reader, mins[component]!, maxs[component]!, quantization));
    }
  }
  const makeCurve = (channel: number[] | undefined): SplineCurveData | undefined => channel
    ? { degree, knots: knots.map(Number), controlPoints: channel }
    : undefined;
  const x = makeCurve(values[0]);
  const y = makeCurve(values[1]);
  const z = makeCurve(values[2]);
  return {
    staticMask,
    splineMask,
    staticValue,
    ...(x ? { x } : {}),
    ...(y ? { y } : {}),
    ...(z ? { z } : {})
  };
}

function readRawStaticVector(
  reader: RawSplineReader,
  mask: number,
  initial: [number, number, number]
): { mask: number; value: [number, number, number] } {
  const value: [number, number, number] = [...initial];
  let staticMask = 0;
  const flags = [0x01, 0x02, 0x04];
  for (let component = 0; component < 3; component++) {
    if ((mask & flags[component]!) === 0) continue;
    value[component] = reader.readFloat();
    if (!Number.isFinite(value[component]!)) throw new Error('raw spline static vector 含非 finite 值');
    staticMask |= 1 << component;
  }
  return { mask: staticMask, value };
}

function readRawQuaternionSpline(
  reader: RawSplineReader,
  quantization: number,
  trackIndex: number
): SplineQuatCurveData {
  const num = reader.readInt16();
  const degree = reader.readByte();
  if (num < 0 || degree > 3) throw new Error(`raw spline track ${trackIndex} rotation NURBS header 无效`);
  const controlPointCount = num + 1;
  const knotCount = controlPointCount + degree + 1;
  const knots = Array.from({ length: knotCount }, () => reader.readByte());
  reader.align(rawRotationAlignment(quantization));
  const controlPoints = Array.from(
    { length: controlPointCount },
    () => readRawQuantizedQuaternion(reader, quantization, trackIndex)
  );
  return { degree, knots: knots.map(Number), controlPoints };
}

function readRawQuantizedScalar(
  reader: RawSplineReader,
  min: number,
  max: number,
  quantization: number
): number {
  const normalized = quantization === 0
    ? reader.readByte() / 255
    : quantization === 1
      ? reader.readUInt16() / 65535
      : (() => { throw new Error(`raw spline scalar quantization 未验证：${quantization}`); })();
  const value = min + (max - min) * normalized;
  if (!Number.isFinite(value)) throw new Error('raw spline quantized scalar 解码为非 finite 值');
  return value;
}

function readRawQuantizedQuaternion(
  reader: RawSplineReader,
  quantization: number,
  trackIndex: number
): [number, number, number, number] {
  const byteCount = rawQuaternionByteCount(quantization);
  const encoded = reader.readBytes(byteCount);
  switch (quantization) {
    case 0:
      return rawNormalizeQuaternion(rawUnpackPolar32(encoded.readUInt32LE(0)), trackIndex);
    case 1:
      return rawNormalizeQuaternion(rawUnpackThreeComp40(encoded), trackIndex);
    case 2:
      return rawNormalizeQuaternion(rawUnpackThreeComp48(encoded), trackIndex);
    case 3:
      throw new Error('raw spline ThreeComp24 quantization 未验证');
    case 4:
      throw new Error('raw spline Straight16 quantization 未验证');
    case 5:
      return rawNormalizeQuaternion([
        encoded.readFloatLE(0),
        encoded.readFloatLE(4),
        encoded.readFloatLE(8),
        encoded.readFloatLE(12)
      ], trackIndex);
    default:
      throw new Error(`raw spline track ${trackIndex} rotation quantization 未验证：${quantization}`);
  }
}

function rawQuaternionByteCount(quantization: number): number {
  switch (quantization) {
    case 0: return 4;
    case 1: return 5;
    case 2: return 6;
    case 3: return 3;
    case 4: return 2;
    case 5: return 16;
    default: throw new Error(`raw spline rotation quantization 未验证：${quantization}`);
  }
}

function rawRotationAlignment(quantization: number): number {
  switch (quantization) {
    case 0: return 4;
    case 1: return 1;
    case 2: return 2;
    case 3: return 1;
    case 4: return 2;
    case 5: return 4;
    default: throw new Error(`raw spline rotation quantization 未验证：${quantization}`);
  }
}

function rawUnpackPolar32(packed: number): [number, number, number, number] {
  const unsigned = packed >>> 0;
  let w = ((unsigned >>> 18) & 0x3FF) * 0.0009775171;
  w = 1 - w * w;
  const squareIndex = unsigned & 0x3FFFF;
  let root = Math.floor(Math.sqrt(squareIndex));
  let angle = 0;
  if (root > 0) {
    angle = Math.PI / 4 * (squareIndex - root * root) / root;
    root *= 0.0030739654;
  }
  const radius = Math.sqrt(Math.max(0, 1 - w * w));
  const result: [number, number, number, number] = [
    Math.sin(root) * Math.cos(angle) * radius,
    Math.sin(root) * Math.sin(angle) * radius,
    Math.cos(root) * radius,
    w
  ];
  if ((unsigned & 0x10000000) !== 0) result[0] = -result[0]!;
  if ((unsigned & 0x20000000) !== 0) result[1] = -result[1]!;
  if ((unsigned & 0x40000000) !== 0) result[2] = -result[2]!;
  if ((unsigned & 0x80000000) !== 0) result[3] = -result[3]!;
  return result;
}

function rawUnpackThreeComp40(bytes: Buffer): [number, number, number, number] {
  let packed = 0n;
  for (let index = 0; index < 5; index++) packed |= BigInt(bytes[index]!) << BigInt(index * 8);
  const c0 = Number(packed & 0xFFFn) - 2047;
  const c1 = Number((packed >> 12n) & 0xFFFn) - 2047;
  const c2 = Number((packed >> 24n) & 0xFFFn) - 2047;
  const omitted = Number((packed >> 36n) & 0x3n);
  const negative = ((packed >> 38n) & 1n) !== 0n;
  return rawReconstructSmallestThree(
    [c0 * 0.000345436, c1 * 0.000345436, c2 * 0.000345436],
    omitted,
    negative
  );
}

function rawUnpackThreeComp48(bytes: Buffer): [number, number, number, number] {
  const n1 = bytes.readInt16LE(0);
  const n2 = bytes.readInt16LE(2);
  const n3 = bytes.readInt16LE(4);
  const omitted = ((n2 >> 14) & 2) | ((n1 >> 15) & 1);
  const negative = (n3 >> 15) !== 0;
  return rawReconstructSmallestThree(
    [
      ((n1 & 0x7FFF) - 16383) * 4.3161e-5,
      ((n2 & 0x7FFF) - 16383) * 4.3161e-5,
      ((n3 & 0x7FFF) - 16383) * 4.3161e-5
    ],
    omitted,
    negative
  );
}

function rawReconstructSmallestThree(
  values: [number, number, number],
  omitted: number,
  negative: boolean
): [number, number, number, number] {
  if (omitted < 0 || omitted > 3) throw new Error(`raw spline smallest-three omitted index 无效：${omitted}`);
  const sum = values[0]! ** 2 + values[1]! ** 2 + values[2]! ** 2;
  const remaining = 1 - sum;
  if (!Number.isFinite(remaining) || remaining < -1e-4) {
    throw new Error('raw spline smallest-three quaternion 超出单位球');
  }
  const omittedValue = (negative ? -1 : 1) * Math.sqrt(Math.max(0, remaining));
  const result: number[] = [];
  let source = 0;
  for (let index = 0; index < 4; index++) {
    result.push(index === omitted ? omittedValue : values[source++]!);
  }
  return [result[0]!, result[1]!, result[2]!, result[3]!];
}

function rawNormalizeQuaternion(
  value: [number, number, number, number],
  trackIndex: number
): [number, number, number, number] {
  const length = Math.hypot(value[0]!, value[1]!, value[2]!, value[3]!);
  if (!Number.isFinite(length) || length <= 1e-12) {
    throw new Error(`raw spline track ${trackIndex} quaternion 长度无效`);
  }
  return [value[0]! / length, value[1]! / length, value[2]! / length, value[3]! / length];
}

function hasRawSpline(mask: number): boolean {
  return (mask & 0xF0) !== 0;
}

function hasRawStatic(mask: number): boolean {
  return (mask & 0x0F) !== 0;
}

function incrementCount(counts: Record<string, number>, value: number): void {
  const key = String(value);
  counts[key] = (counts[key] ?? 0) + 1;
}

function requireData<T>(result: BridgeResult<T>, label: string): T {
  if (!result.data || result.parseStatus === 'failed') {
    throw new Error(`${label} failed: ${JSON.stringify(result.diagnostics)}`);
  }
  return result.data;
}

function decodeOracleResult(value: Record<string, unknown>): MatureOracleResult {
  const samples = expectArray(value.samples, 'oracle.samples').map((sample, index) => {
    const row = expectRecord(sample, `oracle.samples[${index}]`);
    return {
      label: expectString(row.label, `${index}.label`),
      timeSeconds: expectFiniteNumber(row.timeSeconds, `${index}.timeSeconds`),
      loop: expectBoolean(row.loop, `${index}.loop`),
      tracks: expectArray(row.tracks, `${index}.tracks`).map((track, trackIndex) => decodeTransform(track, `${index}.tracks[${trackIndex}]`))
    };
  });
  const bindingValue = expectRecord(value.binding, 'oracle.binding');
  const skeletonValue = expectRecord(value.skeleton, 'oracle.skeleton');
  return {
    ok: true,
    sourceContainer: expectString(value.sourceContainer, 'oracle.sourceContainer'),
    sourceContainerHash: expectHash(value.sourceContainerHash, 'oracle.sourceContainerHash'),
    baseContainer: expectString(value.baseContainer, 'oracle.baseContainer'),
    baseContainerHash: expectHash(value.baseContainerHash, 'oracle.baseContainerHash'),
    animationEntry: expectString(value.animationEntry, 'oracle.animationEntry'),
    animationEntryHash: expectHash(value.animationEntryHash, 'oracle.animationEntryHash'),
    compendiumHash: expectHash(value.compendiumHash, 'oracle.compendiumHash'),
    animationType: expectString(value.animationType, 'oracle.animationType'),
    animId: expectInteger(value.animId, 'oracle.animId'),
    duration: expectFiniteNumber(value.duration, 'oracle.duration'),
    frameCount: expectInteger(value.frameCount, 'oracle.frameCount'),
    transformTrackCount: expectInteger(value.transformTrackCount, 'oracle.transformTrackCount'),
    blockCount: expectInteger(value.blockCount, 'oracle.blockCount'),
    framesPerBlock: expectInteger(value.framesPerBlock, 'oracle.framesPerBlock'),
    binding: {
      originalSkeletonName: expectString(bindingValue.originalSkeletonName, 'oracle.binding.originalSkeletonName'),
      blendHint: expectInteger(bindingValue.blendHint, 'oracle.binding.blendHint'),
      transformTrackToBoneIndices: expectArray(bindingValue.transformTrackToBoneIndices, 'oracle.binding.transformTrackToBoneIndices')
        .map((entry, index) => expectInteger(entry, `oracle.binding.transformTrackToBoneIndices[${index}]`))
    },
    skeleton: {
      name: expectString(skeletonValue.name, 'oracle.skeleton.name'),
      boneNames: expectArray(skeletonValue.boneNames, 'oracle.skeleton.boneNames')
        .map((entry, index) => expectString(entry, `oracle.skeleton.boneNames[${index}]`))
    },
    samples,
    oracleAssemblyHash: expectHash(value.oracleAssemblyHash, 'oracle.oracleAssemblyHash')
  };
}

function decodeTransform(value: unknown, path: string): OracleTransform {
  const row = expectRecord(value, path);
  return {
    translation: toTuple3(row.translation, `${path}.translation`),
    rotation: toTuple4(row.rotation, `${path}.rotation`),
    scale: toTuple3(row.scale, `${path}.scale`)
  };
}

function chooseSampledBones(boneNames: string[], movingIndices: number[]): number[] {
  const preferred = ['Master', 'Pelvis', 'Spine', 'L_UpperArm', 'L_Thigh', 'L_Foot', 'Head'];
  const selected: number[] = [];
  for (const name of preferred) {
    const index = boneNames.indexOf(name);
    if (index >= 0 && !selected.includes(index)) selected.push(index);
  }
  for (const index of movingIndices) {
    if (!selected.includes(index)) selected.push(index);
    if (selected.length >= 10) break;
  }
  return selected.slice(0, 10);
}

function sourceRootFromAbsolutePath(filePath: string): string {
  return dirname(dirname(filePath));
}

function gameRootFromSource(filePath: string): string {
  return sourceRootFromAbsolutePath(filePath);
}

function sha256FileSync(filePath: string): string {
  const bytes = readFileSync(filePath);
  return createHash('sha256').update(bytes).digest('hex');
}

function maxAbs(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  return a.reduce((max, value, index) => Math.max(max, Math.abs(value - b[index]!)), 0);
}

function quaternionAngularError(a: readonly number[], b: readonly number[]): number {
  if (a.length !== 4 || b.length !== 4) return Number.POSITIVE_INFINITY;
  const aLength = Math.hypot(a[0]!, a[1]!, a[2]!, a[3]!);
  const bLength = Math.hypot(b[0]!, b[1]!, b[2]!, b[3]!);
  if (!Number.isFinite(aLength) || !Number.isFinite(bLength) || aLength <= 1e-12 || bLength <= 1e-12) {
    return Number.POSITIVE_INFINITY;
  }
  const dot = Math.abs((a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!) / (aLength * bLength));
  return 2 * Math.acos(Math.min(1, dot));
}

function sameNumberArray(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new MatureOracleBlockedError(`${path} 不是 object。`);
  return value;
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new MatureOracleBlockedError(`${path} 不是 array。`);
  return value;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new MatureOracleBlockedError(`${path} 不是非空 string。`);
  return value;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new MatureOracleBlockedError(`${path} 不是 boolean。`);
  return value;
}

function expectFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new MatureOracleBlockedError(`${path} 不是 finite number。`);
  return value;
}

function expectInteger(value: unknown, path: string): number {
  const number = expectFiniteNumber(value, path);
  if (!Number.isInteger(number)) throw new MatureOracleBlockedError(`${path} 不是 integer。`);
  return number;
}

function expectHash(value: unknown, path: string): string {
  const hash = expectString(value, path).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new MatureOracleBlockedError(`${path} 不是 SHA-256。`);
  return hash;
}

function toTuple3(value: unknown, path: string): [number, number, number] {
  const array = expectArray(value, path);
  if (array.length !== 3) throw new MatureOracleBlockedError(`${path} 长度不是 3。`);
  return [
    expectFiniteNumber(array[0], `${path}[0]`),
    expectFiniteNumber(array[1], `${path}[1]`),
    expectFiniteNumber(array[2], `${path}[2]`)
  ];
}

function toTuple4(value: unknown, path: string): [number, number, number, number] {
  const array = expectArray(value, path);
  if (array.length !== 4) throw new MatureOracleBlockedError(`${path} 长度不是 4。`);
  return [
    expectFiniteNumber(array[0], `${path}[0]`),
    expectFiniteNumber(array[1], `${path}[1]`),
    expectFiniteNumber(array[2], `${path}[2]`),
    expectFiniteNumber(array[3], `${path}[3]`)
  ];
}

const MATURE_ORACLE_POWERSHELL = String.raw`
$ErrorActionPreference = 'Stop'
$oracleRoot = [Environment]::GetEnvironmentVariable('SOULFORGE_ACTION_ORACLE_ROOT')
$sourcePath = [Environment]::GetEnvironmentVariable('SOULFORGE_ACTION_ORACLE_SOURCE_CONTAINER')
$basePath = [Environment]::GetEnvironmentVariable('SOULFORGE_ACTION_ORACLE_BASE_CONTAINER')
$animId = [int][Environment]::GetEnvironmentVariable('SOULFORGE_ACTION_ORACLE_ANIM_ID')
$pointsJson = [Environment]::GetEnvironmentVariable('SOULFORGE_ACTION_ORACLE_POINTS')

function Write-Blocked {
    param([string]$Code, [string]$Message)
    [ordered]@{ ok = $false; status = 'BLOCKED'; authority = 'partial'; errorCode = $Code; message = $Message } |
        ConvertTo-Json -Depth 16 -Compress
    exit 0
}

function Hash-Bytes {
    param([byte[]]$Bytes)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([Convert]::ToHexString($sha.ComputeHash($Bytes))).ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Hash-File {
    param([string]$Path)
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Read-Binder {
    param([string]$Path)
    $bytes = [SoulsFormats.DCX]::Decompress($Path)
    $reader = [SoulsFormats.BinaryReaderEx]::new($false, $bytes)
    $binder = [SoulsFormats.BND4]::new()
    $method = $binder.GetType().GetMethod('Read', [System.Reflection.BindingFlags]'Public,NonPublic,Instance')
    if ($null -eq $method) { throw 'BND4.Read method is unavailable.' }
    [void]$method.Invoke($binder, [object[]]@($reader))
    return $binder
}

function Find-UniqueFile {
    param($Binder, [string]$Pattern, [string]$Description)
    $matches = @($Binder.Files | Where-Object { $_.Name -match $Pattern })
    if ($matches.Count -ne 1) {
        throw ("Expected exactly one {0}; found {1}." -f $Description, $matches.Count)
    }
    return $matches[0]
}

function Find-UniqueObject {
    param($Section, [Type]$Type, [string]$Description)
    $found = $null
    $count = 0
    foreach ($object in $Section.Objects) {
        if ($object.GetType() -eq $Type) {
            $found = $object
            $count++
        }
    }
    if ($count -ne 1) {
        throw ("Expected exactly one {0}; found {1}." -f $Description, $count)
    }
    return $found
}

try {
    if ([string]::IsNullOrWhiteSpace($oracleRoot) -or -not (Test-Path -LiteralPath (Join-Path $oracleRoot 'SoulsAssetPipeline.dll'))) {
        Write-Blocked 'ORACLE_RUNTIME_MISSING' 'SoulsAssetPipeline.dll is missing.'
    }
    if (-not (Test-Path -LiteralPath $sourcePath) -or -not (Test-Path -LiteralPath $basePath)) {
        Write-Blocked 'REAL_SOURCE_MISSING' 'Real ACTION source or base container is missing.'
    }
    if ([string]::IsNullOrWhiteSpace($pointsJson)) {
        Write-Blocked 'SAMPLE_POINTS_MISSING' 'No sample points were supplied.'
    }

    [Environment]::CurrentDirectory = $oracleRoot
    $env:PATH = $oracleRoot + ';' + $env:PATH
    [void][System.Reflection.Assembly]::LoadFrom((Join-Path $oracleRoot 'SoulsFormats.dll'))
    $sapAssembly = [System.Reflection.Assembly]::LoadFrom((Join-Path $oracleRoot 'SoulsAssetPipeline.dll'))

    $animationBinder = Read-Binder $sourcePath
    $baseBinder = Read-Binder $basePath
    $entryName = 'a000_' + $animId.ToString('D6') + '.hkx'
    $entry = Find-UniqueFile $animationBinder (('_{0}\.hkx$' -f $animId.ToString('D6'))) 'animation entry'
    if ($entry.Name -notmatch [regex]::Escape($entryName) + '$') {
        throw ("Animation entry identity mismatch: expected suffix {0}, actual {1}." -f $entryName, $entry.Name)
    }
    $compendium = Find-UniqueFile $animationBinder '\.compendium$' 'compendium'
    $skeletonEntry = Find-UniqueFile $baseBinder '\\skeleton\.hkx$' 'skeleton entry'

    $hkxType = $sapAssembly.GetType('SoulsAssetPipeline.Animation.HKX', $true)
    $animationHkx = [SoulsAssetPipeline.Animation.HKX]::GenFakeFromTagFile($entry.Bytes, $compendium.Bytes)
    $skeletonHkx = [SoulsAssetPipeline.Animation.HKX]::GenFakeFromTagFile($skeletonEntry.Bytes, $compendium.Bytes)
    $dataSection = $animationHkx.DataSection
    $animationType = $sapAssembly.GetType('SoulsAssetPipeline.Animation.HKX+HKASplineCompressedAnimation', $true)
    $bindingType = $sapAssembly.GetType('SoulsAssetPipeline.Animation.HKX+HKAAnimationBinding', $true)
    $skeletonType = $sapAssembly.GetType('SoulsAssetPipeline.Animation.HKX+HKASkeleton', $true)
    $animation = Find-UniqueObject $dataSection $animationType 'spline animation'
    $binding = Find-UniqueObject $dataSection $bindingType 'animation binding'
    $skeleton = Find-UniqueObject $skeletonHkx.DataSection $skeletonType 'skeleton'
    $animationTypeRaw = [string]$animation.AnimationType.ToString()
    if ($animationTypeRaw -notmatch 'SPLINE') {
        throw ('Mature oracle selected a non-spline animation: ' + $animation.AnimationType.ToString())
    }

    $shortType = $sapAssembly.GetType('SoulsAssetPipeline.Animation.HKX+HKShort', $true)
    $shortData = $shortType.GetField('data', [System.Reflection.BindingFlags]'Public,NonPublic,Instance')
    $trackMap = [System.Collections.Generic.List[int]]::new()
    for ($index = 0; $index -lt [int]$binding.TransformTrackToBoneIndices.Size; $index++) {
        [void]$trackMap.Add([int]$shortData.GetValue($binding.TransformTrackToBoneIndices[$index]))
    }

    $boneType = $sapAssembly.GetType('SoulsAssetPipeline.Animation.HKX+Bone', $true)
    $reflectionInstanceFields = [System.Reflection.BindingFlags]'Public,NonPublic,Instance'
    $boneNameField = $boneType.GetField('Name', $reflectionInstanceFields)
    $boneNames = [System.Collections.Generic.List[string]]::new()
    for ($index = 0; $index -lt [int]$skeleton.Bones.Size; $index++) {
        $bone = $skeleton.Bones[$index]
        $nameObject = $boneNameField.GetValue($bone)
        $name = [string]$nameObject.GetString()
        if ([string]::IsNullOrWhiteSpace($name)) { throw ('Skeleton bone name is empty at index ' + $index) }
        [void]$boneNames.Add($name)
    }

    $dataType = $sapAssembly.GetType('SoulsAssetPipeline.Animation.HavokAnimationData_SplineCompressed', $true)
    $constructor = $null
    foreach ($candidate in $dataType.GetConstructors()) {
        if ($candidate.GetParameters().Count -eq 2) { $constructor = $candidate; break }
    }
    if ($null -eq $constructor) { throw 'HavokAnimationData_SplineCompressed constructor is unavailable.' }
    $constructorArgs = [object[]]::new(2)
    $constructorArgs[0] = $entryName
    $constructorArgs[1] = $animation
    $data = $constructor.Invoke($constructorArgs)
    $matureTrackCount = if ([int]$data.Tracks.Count -gt 0) { [int]$data.Tracks[0].Length } else { 0 }
    if ($matureTrackCount -ne [int]$animation.TransformTrackCount) {
        throw ('Mature track payload count mismatch: data=' + $matureTrackCount + ' animation=' + $animation.TransformTrackCount)
    }

    $points = ConvertFrom-Json $pointsJson
    $sampleRows = [System.Collections.Generic.List[object]]::new()
    foreach ($point in $points) {
        $frame = [single]($point.timeSeconds / [single]$data.FrameDuration)
        $tracks = [System.Collections.Generic.List[object]]::new()
        for ($track = 0; $track -lt [int]$animation.TransformTrackCount; $track++) {
            $transform = $data.GetTransformOnFrame([int]$track, $frame, [bool]$point.loop)
            [void]$tracks.Add([ordered]@{
                translation = @([double]$transform.Translation.X, [double]$transform.Translation.Y, [double]$transform.Translation.Z)
                rotation = @([double]$transform.Rotation.X, [double]$transform.Rotation.Y, [double]$transform.Rotation.Z, [double]$transform.Rotation.W)
                scale = @([double]$transform.Scale.X, [double]$transform.Scale.Y, [double]$transform.Scale.Z)
            })
        }
        [void]$sampleRows.Add([ordered]@{
            label = [string]$point.label
            timeSeconds = [double]$point.timeSeconds
            loop = [bool]$point.loop
            tracks = $tracks
        })
    }

    [ordered]@{
        ok = $true
        status = 'PASS'
        authority = 'partial'
        sourceContainer = $sourcePath
        sourceContainerHash = Hash-File $sourcePath
        baseContainer = $basePath
        baseContainerHash = Hash-File $basePath
        animationEntry = [string]$entry.Name
        animationEntryHash = Hash-Bytes $entry.Bytes
        compendiumHash = Hash-Bytes $compendium.Bytes
        animationType = 'SplineCompressed'
        animId = $animId
        duration = [double]$animation.Duration
        frameCount = [int]$animation.FrameCount
        transformTrackCount = [int]$animation.TransformTrackCount
        blockCount = [int]$animation.BlockCount
        framesPerBlock = [int]$animation.FramesPerBlock
        binding = [ordered]@{
            originalSkeletonName = [string]$binding.OriginalSkeletonName
            blendHint = [int]$binding.BlendHint
            transformTrackToBoneIndices = $trackMap
        }
        skeleton = [ordered]@{
            name = [string]$skeleton.Name.GetString()
            boneNames = $boneNames
        }
        samples = $sampleRows
        oracleAssemblyHash = Hash-File (Join-Path $oracleRoot 'SoulsAssetPipeline.dll')
    } | ConvertTo-Json -Depth 16 -Compress
} catch {
    $position = $_.InvocationInfo.PositionMessage
    $scriptStack = $_.ScriptStackTrace
    $details = $_.Exception.ToString()
    if (-not [string]::IsNullOrWhiteSpace($position)) { $details += "\`n" + $position }
    if (-not [string]::IsNullOrWhiteSpace($scriptStack)) { $details += "\`n" + $scriptStack }
    Write-Blocked 'ORACLE_EXECUTION_FAILED' $details
}
`;

if (import.meta.url === `file://${process.argv[1]}`
  || process.argv[1]?.endsWith('runActionMatureOracleDifferentialSmoke.js')) {
  runActionMatureOracleDifferentialSmoke().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
