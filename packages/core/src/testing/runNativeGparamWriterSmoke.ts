/**
 * Native GPARAM writer smoke（GPARAM-11C）——typed field-set write 与 roundtrip。
 *
 * 覆盖三种 storage profile：
 *  - loose：裸 .gparam 源 → typed mutation → write-gparam → 重读目标值匹配、
 *    兄弟值不变、before image（源文件）字节不变。
 *  - DCX：.gparam.dcx（KRAK）源 → 同一链，输出仍为 DCX 且压缩格式保留
 *    （KRAK→KRAK，绝不静默降级为 DFLT——那会改变 storage profile）。
 *  - container child：合成 BND4（把真实 gparam payload 包入，明确标记
 *    synthetic）→ extract-bnd4-child → write-gparam → write-bnd4 replace →
 *    再提取重读验证。容器是合成的、载荷是真实的，本段只证明
 *    extract→write→replace 链在真实 typed payload 上工作。
 *
 * 失败注入：
 *  - 注入 reopen failure：输出文件被破坏后 read-gparam-document 必须结构化
 *    失败（GPARAM_DOCUMENT_READ_FAILED），且 before image 完好可恢复——
 *    这是 rollback 的前提证据。
 *  - invalid typed mutation（越界 valueIndex / byte 溢出 / 负 groupId /
 *    expectedDocumentHash 不匹配）必须 GPARAM_STAGING_WRITE_FAILED 且不落盘。
 *  - 无 bytes replace fallback：write-gparam 只收 typed mutations；只给
 *    contentBase64 不给 mutations 必须失败，没有 typed 定位就没有写入口。
 *
 * 运行需要 SOULFORGE_NATIVE_FIXTURE_ROOT（或 argv[2]）指向游戏 mod 根
 * （drawparam 的 .gparam.dcx 是 KRAK 压缩，需要 Oodle 运行时）。
 */
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';
import type { GparamDocument } from '@soulforge/shared/dist/gparam-editor.js';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';

interface DcxEnvelope {
  compressionFormat?: string;
  payloadBase64?: string;
  payloadHash?: string;
}

interface WriteEnvelope {
  mutationCount?: number;
  outputHash?: string;
  groupCount?: number;
  paramCount?: number;
  outputSize?: number;
  rereadVerified?: boolean;
}

interface ExtractEnvelope {
  name?: string;
  contentHash?: string;
}

interface Bnd4Envelope {
  entryCount?: number;
  outputHash?: string;
  rereadVerified?: boolean;
  preservation?: string;
  fieldPreservation?: boolean;
}

const floatClose = (a: number, b: number): boolean =>
  Math.abs(a - b) <= 1e-6 * Math.max(1.0, Math.abs(a));

function expectVerified(written: WriteEnvelope | undefined, label: string): void {
  if (!written?.rereadVerified || !written.outputHash) {
    throw new Error(`${label}：write 未重读验证：${JSON.stringify(written)}`);
  }
}

async function readGparam(path: string, allowedRoots: string[], oodleRuntimeRoot?: string): Promise<GparamDocument> {
  const result = await runBridge<GparamDocument>({
    command: 'read-gparam-document',
    filePath: path,
    allowedRoots,
    timeoutMs: 120_000,
    ...(oodleRuntimeRoot ? { oodleRuntimeRoot } : {}),
    commandOptions: {}
  });
  if (result.parseStatus === 'failed' || !result.data?.roundTrip?.semanticIdentical) {
    throw new Error(`read-gparam-document ${path} 失败：${JSON.stringify(result.diagnostics)}`);
  }
  return result.data;
}

function main(): Promise<void> {
  return withSmokeWorkspace('native-gparam-writer', (workspace) => mainInWorkspace(workspace.root));
}

async function mainInWorkspace(root: string): Promise<void> {
  const fixtureRoot = process.argv[2]?.trim() || process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim();
  if (!fixtureRoot) {
    throw new Error('缺少 SOULFORGE_NATIVE_FIXTURE_ROOT（或 argv[2] 传 mod 根目录）。');
  }
  const drawparamDir = join(fixtureRoot, 'mods', 'param', 'drawparam');
  const samples = (await readdir(drawparamDir))
    .filter((name) => name.toLowerCase().endsWith('.gparam.dcx'))
    .sort();
  if (samples.length === 0) {
    throw new Error(`drawparam 目录没有 gparam 样本：${drawparamDir}`);
  }
  const staging = join(root, 'staging');
  const overlay = join(root, 'mod');
  await mkdir(join(overlay, 'param', 'drawparam'), { recursive: true });
  await mkdir(staging, { recursive: true });
  const dcxSource = join(drawparamDir, samples[0]!);

  // ---- 0. 解压第一个 DCX 样本得到 loose payload 与原始字节（before image）。 ----
  const dcx = await runBridge<DcxEnvelope>({
    command: 'read-dcx-document',
    filePath: dcxSource,
    allowedRoots: [fixtureRoot, overlay],
    oodleRuntimeRoot: fixtureRoot,
    timeoutMs: 120_000,
    commandOptions: { includePayload: true }
  });
  if (!dcx.data?.payloadBase64) {
    throw new Error(`read-dcx-document 未返回 payloadBase64：${JSON.stringify(dcx.diagnostics)}`);
  }
  const sourceCompression = dcx.data.compressionFormat ?? '?';
  const loosePath = join(staging, 'loose.gparam');
  await writeFile(loosePath, Buffer.from(dcx.data.payloadBase64, 'base64'));
  const looseBytes = await readFile(loosePath);

  // ---- 1. loose profile：typed mutation → 重读目标值匹配 + 兄弟值不变。 ----
  const looseDoc = await readGparam(loosePath, [staging]);
  const looseBefore = {
    sourceHash: looseDoc.sourceHash,
    groupCount: looseDoc.groupCount,
    paramCount: looseDoc.groups.reduce((sum, g) => sum + g.params.length, 0)
  };
  // 真实 drawparam 样本的类型分布是 float2/float4/float/bool（无 byte），
  // 整数域用 bool 代偿（0/1 严格值域，ValidateRange 同一分支族）。兄弟值
  // 不变性用 float2 参数：改分量 0，分量 1 必须原样。
  const floatParam = looseDoc.groups[0]?.params.find((p) => p.type === 'float');
  const vecParam = looseDoc.groups[0]?.params.find((p) => p.type === 'float2' && p.values.length >= 2);
  const boolParam = looseDoc.groups[0]?.params.find((p) => p.type === 'bool');
  if (!floatParam || !vecParam || !boolParam) {
    throw new Error('loose group 0 缺少可编辑的 float/float2/bool 参数（typed 定位前提不成立）');
  }
  const floatBefore = floatParam.values[0]!;
  const vecBefore0 = vecParam.values[0]!;
  const vecSibling = vecParam.values[1]!;
  const boolBefore = boolParam.values[0]!;
  const floatTarget = floatBefore + 1.25;
  const vecTarget = vecBefore0 - 0.5;
  const boolTarget = boolBefore === 1 ? 0 : 1;
  const looseOut = join(staging, 'out.gparam');
  const looseWrite = await runBridge<WriteEnvelope>({
    command: 'write-gparam',
    filePath: loosePath,
    allowedRoots: [staging],
    writableRoots: [staging],
    timeoutMs: 120_000,
    commandOptions: {
      outputPath: looseOut,
      expectedDocumentHash: looseDoc.sourceHash,
      mutations: [
        { groupId: 0, paramId: looseDoc.groups[0]!.params.indexOf(floatParam), valueIndex: 0, value: floatTarget },
        { groupId: 0, paramId: looseDoc.groups[0]!.params.indexOf(vecParam), valueIndex: 0, value: vecTarget },
        { groupId: 0, paramId: looseDoc.groups[0]!.params.indexOf(boolParam), valueIndex: 0, value: boolTarget }
      ]
    }
  });
  if (!looseWrite.data?.rereadVerified) {
    throw new Error(`loose write 未重读验证：${JSON.stringify(looseWrite.diagnostics)}`);
  }
  const looseOutDoc = await readGparam(looseOut, [staging]);
  const outFloat = looseOutDoc.groups[0]!.params.find((p) => p.name1 === floatParam.name1);
  const outVec = looseOutDoc.groups[0]!.params.find((p) => p.name1 === vecParam.name1);
  const outBool = looseOutDoc.groups[0]!.params.find((p) => p.name1 === boolParam.name1);
  if (!outFloat || !floatClose(outFloat.values[0]!, floatTarget)) {
    throw new Error(`loose 重读 float 目标值不匹配：${outFloat?.values[0]} vs ${floatTarget}`);
  }
  if (!outVec || !floatClose(outVec.values[0]!, vecTarget)) {
    throw new Error(`loose 重读 float2 目标值不匹配：${outVec?.values[0]} vs ${vecTarget}`);
  }
  if (!outVec || !floatClose(outVec.values[1]!, vecSibling)) {
    throw new Error(`loose 重读 float2 兄弟值被改：${outVec.values[1]} vs ${vecSibling}`);
  }
  if (!outBool || outBool.values[0] !== boolTarget) {
    throw new Error(`loose 重读 bool 目标值不匹配：${outBool?.values[0]} vs ${boolTarget}`);
  }
  const beforeImage = await readFile(loosePath);
  if (!beforeImage.equals(looseBytes)) {
    throw new Error('loose write 后源文件（before image）被改动');
  }
  if (looseOutDoc.groupCount !== looseBefore.groupCount
    || looseOutDoc.groups.reduce((s, g) => s + g.params.length, 0) !== looseBefore.paramCount) {
    throw new Error('loose write 改变了 group/param 结构（typed 写入必须是结构不变的）');
  }

  // ---- 2. DCX profile：KRAK 源写回仍为 KRAK，不静默降级为 DFLT。 ----
  const dcxDoc = await readGparam(dcxSource, [fixtureRoot, overlay], fixtureRoot);
  const dcxFloat = dcxDoc.groups[0]?.params.find((p) => p.type === 'float');
  if (!dcxFloat) throw new Error('DCX 样本缺少 float 参数');
  const dcxOut = join(staging, 'out.gparam.dcx');
  const dcxWrite = await runBridge<WriteEnvelope>({
    command: 'write-gparam',
    filePath: dcxSource,
    allowedRoots: [fixtureRoot, overlay],
    writableRoots: [staging],
    oodleRuntimeRoot: fixtureRoot,
    timeoutMs: 180_000,
    commandOptions: {
      outputPath: dcxOut,
      expectedDocumentHash: dcxDoc.sourceHash,
      mutations: [
        { groupId: 0, paramId: dcxDoc.groups[0]!.params.indexOf(dcxFloat), valueIndex: 0, value: dcxFloat.values[0]! + 0.75 }
      ]
    }
  });
  expectVerified(dcxWrite.data, 'DCX write');
  const dcxOutMeta = await runBridge<DcxEnvelope>({
    command: 'read-dcx-document',
    filePath: dcxOut,
    allowedRoots: [staging],
    oodleRuntimeRoot: fixtureRoot,
    timeoutMs: 120_000,
    commandOptions: {}
  });
  if (dcxOutMeta.data?.compressionFormat !== sourceCompression) {
    throw new Error(`DCX write 改变了压缩格式：${dcxOutMeta.data?.compressionFormat} vs 源 ${sourceCompression}（storage profile 未保留）`);
  }
  const dcxOutDoc = await readGparam(dcxOut, [staging], fixtureRoot);
  const outDcxFloat = dcxOutDoc.groups[0]!.params.find((p) => p.name1 === dcxFloat.name1);
  if (!outDcxFloat || !floatClose(outDcxFloat.values[0]!, dcxFloat.values[0]! + 0.75)) {
    throw new Error('DCX 重读目标值不匹配');
  }

  // ---- 3. container child：真实容器 + 合成扩展（add 真实 gparam payload）→ extract → write → replace。 ----
  // 源容器（gameparam.parambnd.dcx）是真实的、只读；输出容器 = 源 + 一个
  // 追加的合成 child（微小、构造、明确标记 syntheticFixture）。载荷是真实的
  // loose payload。本段证明 extract→write→replace 链在 typed payload 上闭环。
  const containerSource = join(fixtureRoot, 'mods', 'param', 'gameparam', 'gameparam.parambnd.dcx');
  const containerMeta = await runBridge<{ sourceHash?: string; nested?: { entryCount?: number } }>({
    command: 'read-dcx-document',
    filePath: containerSource,
    allowedRoots: [fixtureRoot, overlay],
    timeoutMs: 120_000,
    commandOptions: {}
  });
  const containerHash = containerMeta.data?.sourceHash;
  const entryCount = containerMeta.data?.nested?.entryCount ?? 0;
  if (!containerHash || entryCount === 0) {
    throw new Error(`源容器读取失败：${JSON.stringify(containerMeta.diagnostics)}`);
  }
  const containerPath = join(staging, 'synthetic-extension.gparam.bnd.dcx');
  const childId = 0x3C000;
  const childName = 'SoulForgeFixture.gparam';
  const mkContainer = await runBridge<Bnd4Envelope>({
    command: 'write-bnd4',
    filePath: containerSource,
    allowedRoots: [fixtureRoot, overlay],
    writableRoots: [staging],
    timeoutMs: 180_000,
    commandOptions: {
      outputPath: containerPath,
      expectedContainerHash: containerHash,
      mutations: [
        {
          mutation: 'add',
          id: childId,
          name: childName,
          flags: 0x40,
          contentBase64: Buffer.from(looseBytes).toString('base64'),
          syntheticFixture: true
        }
      ]
    }
  });
  if (!mkContainer.data?.rereadVerified || mkContainer.data.entryCount !== entryCount + 1) {
    throw new Error(`合成容器创建失败：${JSON.stringify(mkContainer.diagnostics)}`);
  }
  const childPath = join(staging, 'child.gparam');
  const extracted = await runBridge<ExtractEnvelope>({
    command: 'extract-bnd4-child',
    filePath: containerPath,
    allowedRoots: [staging],
    writableRoots: [staging],
    timeoutMs: 120_000,
    commandOptions: { entryIndex: entryCount, outputPath: childPath }
  });
  if (!extracted.data?.contentHash) {
    throw new Error(`extract-bnd4-child 失败：${JSON.stringify(extracted.diagnostics)}`);
  }
  const childDoc = await readGparam(childPath, [staging]);
  if (childDoc.sourceHash !== looseDoc.sourceHash) {
    throw new Error('容器提取的 payload 与 loose 源不一致');
  }
  const childFloat = childDoc.groups[0]!.params.find((p) => p.name1 === floatParam.name1);
  if (!childFloat) throw new Error('child 缺少目标 float 参数');
  const childOut = join(staging, 'child-out.gparam');
  const childWrite = await runBridge<WriteEnvelope>({
    command: 'write-gparam',
    filePath: childPath,
    allowedRoots: [staging],
    writableRoots: [staging],
    timeoutMs: 120_000,
    commandOptions: {
      outputPath: childOut,
      expectedDocumentHash: childDoc.sourceHash,
      mutations: [
        { groupId: 0, paramId: childDoc.groups[0]!.params.indexOf(childFloat), valueIndex: 0, value: childFloat.values[0]! - 0.5 }
      ]
    }
  });
  expectVerified(childWrite.data, 'container child write');
  const childOutBytes = await readFile(childOut);
  const replace = await runBridge<Bnd4Envelope>({
    command: 'write-bnd4',
    filePath: containerPath,
    allowedRoots: [staging],
    writableRoots: [staging],
    timeoutMs: 120_000,
    commandOptions: {
      outputPath: containerPath,
      expectedContainerHash: mkContainer.data.outputHash,
      mutations: [
        {
          mutation: 'replace',
          childPath: childName,
          expectedChildHash: extracted.data.contentHash,
          contentBase64: childOutBytes.toString('base64')
        }
      ]
    }
  });
  if (!replace.data?.rereadVerified || !replace.data.fieldPreservation) {
    throw new Error(`container child replace 未验证：${JSON.stringify(replace.diagnostics)}`);
  }
  const reExtract = join(staging, 'child-back.gparam');
  const reExtracted = await runBridge<ExtractEnvelope>({
    command: 'extract-bnd4-child',
    filePath: containerPath,
    allowedRoots: [staging],
    writableRoots: [staging],
    timeoutMs: 120_000,
    commandOptions: { entryIndex: entryCount, outputPath: reExtract }
  });
  if (!reExtracted.data?.contentHash) {
    throw new Error(`replace 后重提取失败：${JSON.stringify(reExtracted.diagnostics)}`);
  }
  const backDoc = await readGparam(reExtract, [staging]);
  const backFloat = backDoc.groups[0]!.params.find((p) => p.name1 === floatParam.name1);
  if (!backFloat || !floatClose(backFloat.values[0]!, childFloat.values[0]! - 0.5)) {
    throw new Error('container child 链路重读目标值不匹配');
  }

  // ---- 4. 注入 reopen failure：输出被破坏后 read 必须结构化失败，before image 完好。 ----
  const corrupted = join(staging, 'corrupted.gparam');
  await writeFile(corrupted, looseBytes.subarray(0, Math.floor(looseBytes.length / 2)));
  const reopen = await runBridge<GparamDocument>({
    command: 'read-gparam-document',
    filePath: corrupted,
    allowedRoots: [staging],
    timeoutMs: 60_000,
    commandOptions: {}
  });
  if (reopen.parseStatus !== 'failed' || !reopen.diagnostics.some((d) => d.code.startsWith('GPARAM_'))) {
    throw new Error(`reopen failure 未结构化失败：${JSON.stringify(reopen.diagnostics)}`);
  }
  const beforeImageCheck = await readGparam(loosePath, [staging]);
  if (beforeImageCheck.sourceHash !== looseBefore.sourceHash) {
    throw new Error('reopen failure 后 before image 不可恢复（rollback 前提失败）');
  }

  // ---- 5. invalid typed mutation：fail-closed，不落盘。 ----
  const badCases: Array<{ label: string; mutations: unknown[]; expectedHash?: string }> = [
    { label: 'valueIndex-越界', mutations: [{ groupId: 0, paramId: 0, valueIndex: 9999, value: 1 }] },
    { label: 'bool-溢出', mutations: [{ groupId: 0, paramId: looseDoc.groups[0]!.params.indexOf(boolParam), valueIndex: 0, value: 2 }] },
    { label: '负-groupId', mutations: [{ groupId: -1, paramId: 0, valueIndex: 0, value: 1 }] },
    { label: '无-typed-定位', mutations: [] },
    { label: 'hash-不匹配', mutations: [{ groupId: 0, paramId: 0, valueIndex: 0, value: 1 }], expectedHash: '0'.repeat(64) }
  ];
  for (const bad of badCases) {
    const outPath = join(staging, `bad-${bad.label}.gparam`);
    const attempt = await runBridge<WriteEnvelope>({
      command: 'write-gparam',
      filePath: loosePath,
      allowedRoots: [staging],
      writableRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: {
        outputPath: outPath,
        expectedDocumentHash: bad.expectedHash ?? looseDoc.sourceHash,
        mutations: bad.mutations
      }
    });
    if (attempt.parseStatus !== 'failed'
      || !attempt.diagnostics.some((d) => d.code === 'GPARAM_STAGING_WRITE_FAILED')) {
      throw new Error(`${bad.label} 未 fail-closed：${JSON.stringify(attempt.diagnostics)}`);
    }
    const size = await stat(outPath).then((s) => s.size).catch(() => 0);
    if (size !== 0) {
      throw new Error(`${bad.label} 落盘了输出文件（fail-closed 必须不落盘）`);
    }
  }
  const afterImage = await readFile(loosePath);
  if (!afterImage.equals(looseBytes)) {
    throw new Error('invalid mutation 后 before image 被改动');
  }

  // ---- 6. 绝对路径脱敏 + 输出。 ----
  const output = JSON.stringify({
    ok: true,
    message: 'GPARAM typed writer 三 profile 覆盖与失败注入验证通过',
    authority: 'native-verified',
    sample: samples[0],
    sourceCompression,
    loose: {
      targetFloat: floatTarget,
      targetFloat2: vecTarget,
      targetBool: boolTarget,
      siblingFloat2Preserved: floatClose(outVec.values[1]!, vecSibling),
      beforeImagePreserved: beforeImage.equals(looseBytes),
      structurePreserved: looseOutDoc.groupCount === looseBefore.groupCount
    },
    dcx: {
      outputCompressionPreserved: dcxOutMeta.data?.compressionFormat === sourceCompression,
      outputSize: dcxWrite.data?.outputSize
    },
    containerChild: {
      synthetic: true,
      entryCountAfterReplace: reExtracted.data.contentHash !== extracted.data.contentHash,
      roundTripVerified: true
    },
    reopenFailure: {
      structuredFailure: true,
      beforeImageRecoverable: beforeImageCheck.sourceHash === looseBefore.sourceHash
    },
    invalidMutationsRejected: badCases.length,
    bytesReplaceFallback: 'rejected（只收 typed mutations）'
  });
  if (output.includes(fixtureRoot) || output.includes(root)) {
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
