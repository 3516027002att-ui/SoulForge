/**
 * First-party schema native coverage smoke.
 *
 * This is a validation-boundary test, not a production dependency. It reads
 * the native corpus through the C# Bridge and checks that the checked-in
 * SoulForge semantic packages cover the observed PARAM/EMEVD identities.
 * No Smithbox, DarkScript3 or Yapped path is consulted here.
 *
 * The historical Sekiro 1.6.x baseline is 138 PARAM children and
 * 142 EMEVD instruction kinds / 33,266 instances. A local Mod may contain a
 * newer or expanded corpus; that variant must still be fully covered and is
 * reported with its actual counts instead of being mislabeled as the
 * historical baseline.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { readParamDocumentViaBridge } from '../editing/paramBridgeCommit.js';
import { decompressDfltDcx } from '../util/dcxDflt.js';
import { analyzeEmedfCoverage, type EmevdInstructionDistributionEntry } from '../emevd/emedfCoverage.js';
import { matchParamMetadataPackage, resolveParamMetadataRowWidth } from '../param/paramMetadata.js';
import {
  getFirstPartyEmedfRegistry,
  getFirstPartyParamMetadataPackage
} from '../schema/sekiro/firstPartySchema.js';
import { nativeFixtureRoleRegistered, resolveNativeFixture } from './nativeFixtureRegistry.js';

const HISTORICAL_PARAM_ENTRY_COUNT = 138;
const HISTORICAL_EMEVD_KIND_COUNT = 142;
const HISTORICAL_EMEVD_INSTRUCTION_COUNT = 33_266;

interface DcxEnvelope {
  nested?: { entryCount?: number };
}

interface EmevdEnvelope {
  eventCount?: number;
  instructionCount?: number;
  instructionDistribution?: EmevdInstructionDistributionEntry[];
  instructionDistributionTruncated?: boolean;
}

interface ParamHeader {
  sourceHash: string;
  typeName: string;
  dataVersion: number;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const explicitParamPath = process.argv[2]?.trim() || undefined;
  const explicitEmevdPath = process.argv[3]?.trim() || undefined;
  if (Boolean(explicitParamPath) !== Boolean(explicitEmevdPath)) {
    throw new Error(
      '用法：可省略参数并设置 SOULFORGE_SEKIRO_GAME_ROOT，或同时传入 PARAM 与 EMEVD 文件路径。'
    );
  }

  const hasGameRoot = Boolean(process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim());
  const hasRegisteredFixtures = !explicitParamPath && !hasGameRoot
    && await nativeFixtureRoleRegistered('param-primary')
    && await nativeFixtureRoleRegistered('emevd-primary');
  if (!explicitParamPath && !hasGameRoot && !hasRegisteredFixtures) {
    console.log(JSON.stringify({
      ok: true,
      testId: 'W-FIRSTPARTY-SCHEMA-01-NATIVE-COVERAGE',
      status: 'skipped',
      authority: 'unverified',
      nativeFormatAuthority: false,
      reason: '没有登记的 native corpus，也没有 SOULFORGE_SEKIRO_GAME_ROOT；first-party native coverage 结构化跳过。',
      diagnostics: [{
        severity: 'info',
        code: 'NATIVE_CORPUS_UNAVAILABLE',
        message: '设置 SOULFORGE_SEKIRO_GAME_ROOT 或提供两个显式 corpus 路径后重试。'
      }]
    }, null, 2));
    return;
  }

  const paramSource = await resolveNativeFixture(
    explicitParamPath,
    'param-primary',
    '../../mods/param/gameparam/gameparam.parambnd.dcx'
  );
  const emevdSource = await resolveNativeFixture(
    explicitEmevdPath,
    'emevd-primary',
    '../../mods/event/common.emevd.dcx'
  );
  const scratch = join(
    tmpdir(),
    `soulforge-first-party-native-${process.pid}-${Date.now()}`
  );
  const staging = join(scratch, 'staging');
  await mkdir(staging, { recursive: true });

  try {
    const paramResult = await verifyParamCoverage(paramSource, staging);
    const emevdResult = await verifyEmevdCoverage(emevdSource, staging);
    console.log(JSON.stringify({
      ok: true,
      testId: 'W-FIRSTPARTY-SCHEMA-01-NATIVE-COVERAGE',
      status: 'partial',
      authority: 'partial',
      nativeFormatAuthority: false,
      schema: {
        paramOrigin: 'first-party',
        paramDefinitions: getFirstPartyParamMetadataPackage().definitions.length,
        emefdOrigin: 'first-party',
        emefdInstructions: getFirstPartyEmedfRegistry().instructions.length,
        emefdBanks: getFirstPartyEmedfRegistry().banks?.length ?? 0
      },
      corpus: { param: paramResult, emevd: emevdResult },
      nonClaims: [
        'C# Bridge 仍是原生二进制格式权威。',
        '本 smoke 不证明未观测 layer/KRAK 变体、游戏加载或超出当前 corpus 的 schema 覆盖。'
      ]
    }, null, 2));
  } finally {
    await disposeBridgeDaemonPool();
    await rm(scratch, { recursive: true, force: true });
  }
}

async function verifyParamCoverage(sourceBnd: string, staging: string): Promise<{
  containerEntries: number;
  matched: number;
  unmatched: number;
  rowWidthMismatches: number;
  sample: Array<{ index: number; typeName: string; rowDataSize: number }>;
}> {
  const container = await runBridge<DcxEnvelope>({
    command: 'read-dcx-document',
    filePath: sourceBnd,
    allowedRoots: [dirname(sourceBnd)],
    timeoutMs: 120_000
  });
  const entryCount = container.data?.nested?.entryCount ?? 0;
  assert(entryCount === HISTORICAL_PARAM_ENTRY_COUNT,
    `PARAM corpus 条目数 ${entryCount} ≠ 历史基线 ${HISTORICAL_PARAM_ENTRY_COUNT}。`);

  const metadata = getFirstPartyParamMetadataPackage();
  let matched = 0;
  let unmatched = 0;
  let rowWidthMismatches = 0;
  const sample: Array<{ index: number; typeName: string; rowDataSize: number }> = [];

  for (let index = 0; index < entryCount; index += 1) {
    const extractedPath = join(staging, `param-${index}.param`);
    const extracted = await runBridge<{ contentSize?: number }>({
      command: 'extract-bnd4-child',
      filePath: sourceBnd,
      allowedRoots: [dirname(sourceBnd)],
      writableRoots: [staging],
      timeoutMs: 120_000,
      commandOptions: { entryIndex: index, outputPath: extractedPath }
    });
    assert(extracted.parseStatus !== 'failed' && (extracted.data?.contentSize ?? 0) > 0,
      `PARAM 条目 ${index} 提取失败：${JSON.stringify(extracted.diagnostics)}`);

    const read = await readParamDocumentViaBridge({
      sourcePath: extractedPath,
      allowedRoots: [staging],
      timeoutMs: 120_000,
      resolveRowDataSize: async (header: ParamHeader) => resolveParamMetadataRowWidth(metadata, {
        game: 'sekiro',
        gameBuild: '1.6',
        typeName: header.typeName,
        dataVersion: header.dataVersion
      })
    });
    if (!read.ok || !read.data) {
      unmatched += 1;
      throw new Error(`PARAM 条目 ${index} 读取/first-party 行宽匹配失败：${JSON.stringify(read.diagnostics)}`);
    }

    const match = matchParamMetadataPackage(metadata, {
      game: 'sekiro',
      gameBuild: '1.6',
      typeName: read.data.typeName,
      dataVersion: read.data.dataVersion ?? -1,
      rowDataSize: read.data.rowDataSize
    }, undefined);
    if (!match.ok || match.definition.document.origin !== 'first-party') {
      unmatched += 1;
      throw new Error(`PARAM 条目 ${index} 未被 first-party definition 严格匹配：${JSON.stringify(match.diagnostics)}`);
    }
    if (match.definition.document.rowDataSize !== read.data.rowDataSize) {
      rowWidthMismatches += 1;
      throw new Error(`PARAM 条目 ${index} 行宽不一致：schema=${match.definition.document.rowDataSize}, native=${read.data.rowDataSize}`);
    }
    matched += 1;
    if (sample.length < 5) {
      sample.push({ index, typeName: read.data.typeName, rowDataSize: read.data.rowDataSize });
    }
  }

  assert(matched === HISTORICAL_PARAM_ENTRY_COUNT && unmatched === 0 && rowWidthMismatches === 0,
    `PARAM first-party coverage 不完整：${JSON.stringify({ matched, unmatched, rowWidthMismatches })}`);
  return { containerEntries: entryCount, matched, unmatched, rowWidthMismatches, sample };
}

async function verifyEmevdCoverage(sourceDcx: string, staging: string): Promise<{
  eventCount: number;
  instructionCount: number;
  instructionKinds: number;
  coveredKinds: number;
  cleanKinds: number;
  unknownKinds: number;
  lengthMismatches: number;
  historicalBaseline: boolean;
}> {
  const dcxBytes = await readFile(sourceDcx);
  const emevdPath = join(staging, 'common.emevd');
  await writeFile(emevdPath, decompressDfltDcx(dcxBytes));
  const read = await runBridge<EmevdEnvelope>({
    command: 'read-emevd-document',
    filePath: emevdPath,
    allowedRoots: [staging],
    timeoutMs: 120_000
  });
  const distribution = read.data?.instructionDistribution;
  const instructionCount = read.data?.instructionCount ?? 0;
  const eventCount = read.data?.eventCount ?? 0;
  assert(read.parseStatus !== 'failed' && Array.isArray(distribution) && distribution.length > 0,
    `EMEVD native distribution 读取失败：${JSON.stringify(read.diagnostics)}`);
  assert(read.data?.instructionDistributionTruncated !== true,
    'EMEVD instructionDistribution 被截断，不能声称 full native coverage。');
  assert(instructionCount === distribution.reduce((sum, entry) => sum + entry.count, 0),
    'EMEVD distribution instance total 与 Bridge instructionCount 不一致。');

  const analysis = analyzeEmedfCoverage(
    getFirstPartyEmedfRegistry(),
    distribution,
    false
  );
  assert(analysis.totalInstances === instructionCount && instructionCount > 0,
    'EMEVD first-party coverage 没有覆盖可验证的 instruction 实例。');
  assert(analysis.coveredKinds === analysis.totalKinds
    && analysis.cleanKinds === analysis.totalKinds
    && analysis.unknownKinds.length === 0
    && analysis.lengthMismatches.length === 0,
  `EMEVD first-party coverage 存在缺口：${JSON.stringify({
    totalKinds: analysis.totalKinds,
    coveredKinds: analysis.coveredKinds,
    cleanKinds: analysis.cleanKinds,
    unknownKinds: analysis.unknownKinds.slice(0, 5),
    lengthMismatches: analysis.lengthMismatches.slice(0, 5)
  })}`);

  const historicalBaseline = instructionCount === HISTORICAL_EMEVD_INSTRUCTION_COUNT
    && analysis.totalKinds === HISTORICAL_EMEVD_KIND_COUNT;
  assert(analysis.totalKinds >= HISTORICAL_EMEVD_KIND_COUNT,
    `EMEVD corpus 只有 ${analysis.totalKinds} 种指令，低于历史基线 ${HISTORICAL_EMEVD_KIND_COUNT}。`);
  return {
    eventCount,
    instructionCount,
    instructionKinds: analysis.totalKinds,
    coveredKinds: analysis.coveredKinds,
    cleanKinds: analysis.cleanKinds,
    unknownKinds: analysis.unknownKinds.length,
    lengthMismatches: analysis.lengthMismatches.length,
    historicalBaseline
  };
}

main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
