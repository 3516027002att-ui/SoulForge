/**
 * Native FLVER writer smoke（MODEL-51C）——material-slot-set 字节补丁写回与 roundtrip。
 *
 * 覆盖两种 storage profile：
 *  - loose：从真实 chrbnd 提取的裸 .flver 源 → material-slot-set typed mutation
 *    → write-flver → 重读目标 mesh materialIndex 匹配、兄弟 mesh 不变、before image
 *    （源文件）字节不变；并在 smoke 层独立重推 mesh 表偏移做逐字节 diff（改的字节
 *    必须恰好是目标偏移一个 int32）。
 *  - container child：把真实 flver payload 包进合成 BND4（明确标记 synthetic，
 *    载荷是真实的）→ write-flver 带 entryIndex（容器模式，直接走 FlverNativeWriter
 *    的 WriteContainerAsync）→ 从输出容器重提取重读目标值匹配，且输出仍是 DCX、
 *    压缩格式保留。
 *
 * 失败注入（必须 FLVER_STAGING_WRITE_FAILED 且不落盘）：
 *  - meshStableId 越界 / materialStableId 越界 / slotIndex ≠ 0 /
 *    同一 mesh 重复 mutation / no-op（目标材质与当前一致） / expectedDocumentHash
 *    不匹配 / 空 mutations。
 *  - 注入 reopen failure：输出文件被破坏后 read-flver-document 必须结构化失败
 *    （FLVER_* 码），且 before image 完好可恢复——rollback 的前提证据。
 *
 * 运行需要 SOULFORGE_NATIVE_FIXTURE_ROOT / SOULFORGE_SEKIRO_GAME_ROOT（或 argv[2]）
 * 指向 Sekiro mod 根（mods/chr 里有 chrbnd 容器）。未配置时诚实跳过（exit 0）。
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';

interface FlverEnvelope {
  sourceHash?: string;
  skeletonTransformCount?: number;
  materialCount?: number;
  boneCount?: number;
  meshCount?: number;
  meshes?: Array<{ index?: number; materialIndex?: number }>;
  layoutWarnings?: string[];
  authority?: string;
}

interface WriteEnvelope {
  mutationCount?: number;
  outputHash?: string;
  meshCount?: number;
  materialCount?: number;
  outputSize?: number;
  rereadVerified?: boolean;
  storageProfile?: string;
}

interface DcxEnvelope {
  compressionFormat?: string;
  sourceHash?: string;
  payloadBase64?: string;
  nested?: { entryCount?: number };
}

interface ExtractEnvelope {
  name?: string;
  contentHash?: string;
}

interface Bnd4Envelope {
  entryCount?: number;
  outputHash?: string;
  rereadVerified?: boolean;
  fieldPreservation?: boolean;
}

function fixtureRoot(): string {
  return process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim()
    ?? process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim()
    ?? process.argv[2]?.trim()
    ?? '';
}

async function readFlver(path: string, allowedRoots: string[]): Promise<FlverEnvelope> {
  const result = await runBridge<FlverEnvelope>({
    command: 'read-flver-document',
    filePath: path,
    allowedRoots,
    timeoutMs: 120_000
  });
  if (result.parseStatus === 'failed' || !result.data?.sourceHash) {
    throw new Error(`read-flver-document ${path} 失败：${JSON.stringify(result.diagnostics)}`);
  }
  return result.data;
}

function meshTableOffsetOf(
  doc: FlverEnvelope,
  meshIndex: number
): number {
  // 与 FlverNativeWriter 的 mesh 表定位一致：Header(0x80) → Dummies(64) →
  // Materials(32) → Bones(128) → Meshes(48)，materialIndex 在 mesh entry +0x04。
  return 0x80
    + (doc.skeletonTransformCount ?? 0) * 64
    + (doc.materialCount ?? 0) * 32
    + (doc.boneCount ?? 0) * 128
    + meshIndex * 48
    + 4;
}

/** 独立逐字节 diff：changed 偏移集合必须恰好等于目标偏移集合。 */
function assertByteDiffIsExactly(source: Buffer, output: Buffer, targetOffsets: number[]): void {
  if (source.length !== output.length) {
    throw new Error(`字节补丁改变了文件长度：${source.length} → ${output.length}`);
  }
  const changed: number[] = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== output[i]) changed.push(i);
  }
  const targetSet = new Set(targetOffsets);
  const changedSet = new Set(changed);
  const unexpected = changed.filter((i) => !targetSet.has(i));
  const untouched = targetOffsets.filter((i) => !changedSet.has(i));
  if (changed.length === 0) throw new Error('字节补丁没有任何变化（目标偏移未写）');
  if (unexpected.length > 0) throw new Error(`目标偏移之外被改 ${unexpected.length} 个：${unexpected.slice(0, 8).join(',')}`);
  if (untouched.length > 0) throw new Error(`目标偏移漏改 ${untouched.length} 个：${untouched.join(',')}`);
  for (const offset of targetOffsets) {
    const value = output.readInt32LE(offset);
    if (!Number.isInteger(value)) throw new Error(`目标偏移 ${offset} 读出非整数 ${value}`);
  }
}

function main(): Promise<void> {
  return withSmokeWorkspace('native-flver-writer', (workspace) => mainInWorkspace(workspace.root));
}

async function mainInWorkspace(root: string): Promise<void> {
  const fixture = fixtureRoot();
  const chrDir = join(fixture, 'mods', 'chr');
  if (!fixture || !existsSync(chrDir)) {
    console.log(JSON.stringify({ ok: true, status: 'skipped', reason: '缺少本机游戏 mod 语料（SOULFORGE_NATIVE_FIXTURE_ROOT 未配置）' }));
    return;
  }

  const staging = join(root, 'staging');
  await mkdir(staging, { recursive: true });

  // ---- 0. 选样本：第一个 meshCount ≥ 1 且 materialCount ≥ 2 的 chrbnd。 ----
  const containers = (await readdir(chrDir))
    .filter((name) => name.toLowerCase().endsWith('.chrbnd.dcx'))
    .sort();
  if (containers.length === 0) {
    throw new Error(`mods/chr 没有 chrbnd 容器：${chrDir}`);
  }
  let sampleId: string | null = null;
  let sampleDoc: FlverEnvelope | null = null;
  let samplePath = '';
  let sampleBytes: Buffer | null = null;
  for (const container of containers) {
    const id = container.replace(/\.chrbnd\.dcx$/i, '');
    const out = join(staging, `${id}.flver`);
    try {
      const ex = await runBridge<ExtractEnvelope>({
        command: 'extract-bnd4-child',
        filePath: join(chrDir, container),
        allowedRoots: [chrDir],
        writableRoots: [staging],
        oodleRuntimeRoot: fixture,
        timeoutMs: 180_000,
        commandOptions: { childPath: `${id}.flver`, outputPath: out }
      });
      if (ex.parseStatus === 'failed' || !ex.data?.contentHash) continue;
      const doc = await readFlver(out, [staging]);
      if ((doc.meshCount ?? 0) >= 1 && (doc.materialCount ?? 0) >= 2) {
        sampleId = id;
        sampleDoc = doc;
        samplePath = out;
        sampleBytes = await readFile(out);
        break;
      }
    } catch {
      // 该样本不可用，继续找下一个。
    }
  }
  if (!sampleId || !sampleDoc || !sampleBytes) {
    throw new Error(`没有满足写回前提的样本（meshCount ≥ 1 且 materialCount ≥ 2）：${chrDir}`);
  }
  if ((sampleDoc.layoutWarnings ?? []).length > 0) {
    throw new Error(`FLVER ${sampleId} layoutWarnings 非空，无法做写回（结构偏移不可信）：${JSON.stringify(sampleDoc.layoutWarnings)}`);
  }

  const meshIndex = 0;
  const currentMaterial = sampleDoc.meshes?.[meshIndex]?.materialIndex ?? -1;
  if (currentMaterial < 0 || currentMaterial >= (sampleDoc.materialCount ?? 0)) {
    throw new Error(`FLVER ${sampleId} mesh[${meshIndex}] materialIndex=${currentMaterial} 越界`);
  }
  // 目标材质：合法范围内 ≠ 当前（materialCount ≥ 2 保证存在）。
  let targetMaterial = -1;
  for (let m = 0; m < (sampleDoc.materialCount ?? 0); m++) {
    if (m !== currentMaterial) { targetMaterial = m; break; }
  }
  if (targetMaterial < 0) throw new Error('找不到不同的合法目标材质');
  const materialStableId = `material:${targetMaterial}`;
  const mutation = {
    kind: 'material-slot-set',
    meshStableId: `mesh:${meshIndex}`,
    slotIndex: 0,
    materialStableId
  };

  // ---- 1. loose profile：typed mutation → 重读目标匹配 + 兄弟 mesh 不变 + before image 保留 + 逐字节 diff。 ----
  const looseOut = join(staging, 'out.flver');
  const looseWrite = await runBridge<WriteEnvelope>({
    command: 'write-flver',
    filePath: samplePath,
    allowedRoots: [staging],
    writableRoots: [staging],
    timeoutMs: 120_000,
    commandOptions: {
      outputPath: looseOut,
      expectedDocumentHash: sampleDoc.sourceHash,
      mutations: [mutation]
    }
  });
  if (looseWrite.parseStatus === 'failed' || !looseWrite.data?.rereadVerified) {
    throw new Error(`loose write 未重读验证：${JSON.stringify(looseWrite.diagnostics)}`);
  }
  const looseOutDoc = await readFlver(looseOut, [staging]);
  if (looseOutDoc.meshes?.[meshIndex]?.materialIndex !== targetMaterial) {
    throw new Error(`loose 重读 mesh[${meshIndex}] materialIndex=${looseOutDoc.meshes?.[meshIndex]?.materialIndex} 与目标 ${targetMaterial} 不匹配`);
  }
  // 兄弟 mesh：除目标外全部 materialIndex 原样。
  for (const mesh of sampleDoc.meshes ?? []) {
    if (mesh.index === meshIndex) continue;
    const outMesh = (looseOutDoc.meshes ?? []).find((m) => m.index === mesh.index);
    if (!outMesh || outMesh.materialIndex !== mesh.materialIndex) {
      throw new Error(`兄弟 mesh[${mesh.index}] materialIndex 被改：${outMesh?.materialIndex} vs ${mesh.materialIndex}`);
    }
  }
  const beforeImage = await readFile(samplePath);
  if (!beforeImage.equals(sampleBytes)) {
    throw new Error('loose write 后源文件（before image）被改动');
  }
  const looseOutBytes = await readFile(looseOut);
  assertByteDiffIsExactly(sampleBytes, looseOutBytes, [meshTableOffsetOf(sampleDoc, meshIndex)]);
  const looseTargetValue = looseOutBytes.readInt32LE(meshTableOffsetOf(sampleDoc, meshIndex));
  if (looseTargetValue !== targetMaterial) {
    throw new Error(`目标偏移读出的 int32=${looseTargetValue} 与目标材质 ${targetMaterial} 不符`);
  }

  // ---- 2. container child：真实 flver payload 包进合成 BND4 → write-flver(entryIndex 容器模式)。 ----
  // 源容器是真实 chrbnd（只读），输出容器 = 源 + 一个追加的合成 child（载荷是真实
  // loose payload，明确标记 syntheticFixture）。本段证明 FlverNativeWriter 的容器
  // 模式在真实 typed payload 上闭环。
  const containerSource = join(chrDir, `${sampleId}.chrbnd.dcx`);
  const containerMeta = await runBridge<DcxEnvelope>({
    command: 'read-dcx-document',
    filePath: containerSource,
    allowedRoots: [chrDir],
    oodleRuntimeRoot: fixture,
    timeoutMs: 120_000,
    commandOptions: {}
  });
  const containerHash = containerMeta.data?.sourceHash;
  const entryCount = containerMeta.data?.nested?.entryCount ?? 0;
  const sourceCompression = containerMeta.data?.compressionFormat ?? '?';
  if (!containerHash || entryCount === 0) {
    throw new Error(`源容器读取失败：${JSON.stringify(containerMeta.diagnostics)}`);
  }
  const containerPath = join(staging, 'synthetic-extension.chrbnd.dcx');
  const childName = 'SoulForgeFixture.flver';
  const mkContainer = await runBridge<Bnd4Envelope>({
    command: 'write-bnd4',
    filePath: containerSource,
    allowedRoots: [chrDir],
    writableRoots: [staging],
    oodleRuntimeRoot: fixture,
    timeoutMs: 180_000,
    commandOptions: {
      outputPath: containerPath,
      expectedContainerHash: containerHash,
      mutations: [
        {
          mutation: 'add',
          id: 0x3C001,
          name: childName,
          flags: 0x40,
          contentBase64: sampleBytes.toString('base64'),
          syntheticFixture: true
        }
      ]
    }
  });
  if (!mkContainer.data?.rereadVerified || mkContainer.data.entryCount !== entryCount + 1) {
    throw new Error(`合成容器创建失败：${JSON.stringify(mkContainer.diagnostics)}`);
  }
  // 容器模式 write-flver：直接对合成容器的 entryCount 下标 child 写回。
  const containerOut = join(staging, 'out-container.chrbnd.dcx');
  const containerWrite = await runBridge<WriteEnvelope>({
    command: 'write-flver',
    filePath: containerPath,
    allowedRoots: [staging],
    writableRoots: [staging],
    oodleRuntimeRoot: fixture,
    timeoutMs: 180_000,
    commandOptions: {
      outputPath: containerOut,
      expectedDocumentHash: mkContainer.data.outputHash,
      entryIndex: entryCount,
      mutations: [mutation]
    }
  });
  if (containerWrite.parseStatus === 'failed' || !containerWrite.data?.rereadVerified) {
    throw new Error(`container write 未重读验证：${JSON.stringify(containerWrite.diagnostics)}`);
  }
  const containerOutMeta = await runBridge<DcxEnvelope>({
    command: 'read-dcx-document',
    filePath: containerOut,
    allowedRoots: [staging],
    oodleRuntimeRoot: fixture,
    timeoutMs: 120_000,
    commandOptions: {}
  });
  if (containerOutMeta.data?.compressionFormat !== sourceCompression) {
    throw new Error(`container write 改变了压缩格式：${containerOutMeta.data?.compressionFormat} vs 源 ${sourceCompression}`);
  }
  const reExtract = join(staging, 'child-back.flver');
  const reExtracted = await runBridge<ExtractEnvelope>({
    command: 'extract-bnd4-child',
    filePath: containerOut,
    allowedRoots: [staging],
    writableRoots: [staging],
    oodleRuntimeRoot: fixture,
    timeoutMs: 120_000,
    commandOptions: { entryIndex: entryCount, outputPath: reExtract }
  });
  if (!reExtracted.data?.contentHash) {
    throw new Error(`容器 write 后重提取失败：${JSON.stringify(reExtracted.diagnostics)}`);
  }
  const backDoc = await readFlver(reExtract, [staging]);
  if (backDoc.meshes?.[meshIndex]?.materialIndex !== targetMaterial) {
    throw new Error(`container 重读 mesh[${meshIndex}] materialIndex=${backDoc.meshes?.[meshIndex]?.materialIndex} 与目标 ${targetMaterial} 不匹配`);
  }

  // ---- 3. 注入 reopen failure：输出被破坏后 read 必须结构化失败，before image 完好。 ----
  const corrupted = join(staging, 'corrupted.flver');
  await writeFile(corrupted, sampleBytes.subarray(0, Math.floor(sampleBytes.length / 2)));
  const reopen = await runBridge<FlverEnvelope>({
    command: 'read-flver-document',
    filePath: corrupted,
    allowedRoots: [staging],
    timeoutMs: 60_000,
    commandOptions: {}
  });
  if (reopen.parseStatus !== 'failed' || !reopen.diagnostics.some((d) => d.code.startsWith('FLVER_'))) {
    throw new Error(`reopen failure 未结构化失败：${JSON.stringify(reopen.diagnostics)}`);
  }
  const beforeImageCheck = await readFlver(samplePath, [staging]);
  if (beforeImageCheck.sourceHash !== sampleDoc.sourceHash) {
    throw new Error('reopen failure 后 before image 不可恢复（rollback 前提失败）');
  }

  // ---- 4. invalid mutations：fail-closed，不落盘。 ----
  const badCases: Array<{ label: string; mutations: unknown[]; expectedHash?: string }> = [
    { label: 'mesh-越界', mutations: [{ kind: 'material-slot-set', meshStableId: 'mesh:99999', slotIndex: 0, materialStableId }] },
    { label: 'material-越界', mutations: [{ kind: 'material-slot-set', meshStableId: `mesh:${meshIndex}`, slotIndex: 0, materialStableId: 'material:99999' }] },
    { label: 'slotIndex-非0', mutations: [{ kind: 'material-slot-set', meshStableId: `mesh:${meshIndex}`, slotIndex: 1, materialStableId }] },
    { label: '重复-mesh', mutations: [
      { kind: 'material-slot-set', meshStableId: `mesh:${meshIndex}`, slotIndex: 0, materialStableId },
      { kind: 'material-slot-set', meshStableId: `mesh:${meshIndex}`, slotIndex: 0, materialStableId: `material:${currentMaterial}` }
    ] },
    { label: 'no-op', mutations: [{ kind: 'material-slot-set', meshStableId: `mesh:${meshIndex}`, slotIndex: 0, materialStableId: `material:${currentMaterial}` }] },
    { label: 'hash-不匹配', mutations: [mutation], expectedHash: '0'.repeat(64) },
    { label: '空-mutations', mutations: [] }
  ];
  for (const bad of badCases) {
    const outPath = join(staging, `bad-${bad.label}.flver`);
    const attempt = await runBridge<WriteEnvelope>({
      command: 'write-flver',
      filePath: samplePath,
      allowedRoots: [staging],
      writableRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: {
        outputPath: outPath,
        expectedDocumentHash: bad.expectedHash ?? sampleDoc.sourceHash,
        mutations: bad.mutations
      }
    });
    if (attempt.parseStatus !== 'failed'
      || !attempt.diagnostics.some((d) => d.code === 'FLVER_STAGING_WRITE_FAILED')) {
      throw new Error(`${bad.label} 未 fail-closed：${JSON.stringify(attempt.diagnostics)}`);
    }
    const size = await stat(outPath).then((s) => s.size).catch(() => 0);
    if (size !== 0) {
      throw new Error(`${bad.label} 落盘了输出文件（fail-closed 必须不落盘）`);
    }
  }
  const afterImage = await readFile(samplePath);
  if (!afterImage.equals(sampleBytes)) {
    throw new Error('invalid mutation 后 before image 被改动');
  }

  // ---- 5. 绝对路径脱敏 + 输出。 ----
  const output = JSON.stringify({
    ok: true,
    message: 'FLVER material-slot-set 字节补丁 writer 两 profile 覆盖与失败注入验证通过',
    authority: 'native-verified',
    sample: sampleId,
    mesh: { index: meshIndex, from: currentMaterial, to: targetMaterial },
    loose: {
      rereadVerified: looseWrite.data.rereadVerified,
      siblingMeshesPreserved: true,
      beforeImagePreserved: beforeImage.equals(sampleBytes),
      byteDiffExact: true,
      targetValueRead: looseTargetValue
    },
    containerChild: {
      synthetic: true,
      compressionPreserved: containerOutMeta.data?.compressionFormat === sourceCompression,
      rereadVerified: containerWrite.data.rereadVerified,
      roundTripVerified: true
    },
    reopenFailure: {
      structuredFailure: true,
      beforeImageRecoverable: beforeImageCheck.sourceHash === sampleDoc.sourceHash
    },
    invalidMutationsRejected: badCases.length
  });
  if (output.includes(fixture) || output.includes(root)) {
    throw new Error('smoke 输出泄漏了本机绝对路径（脱敏失败）');
  }
  console.log(output);
  await disposeBridgeDaemonPool();
}

main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
