/**
 * Imported-registry coverage cross-validation smoke.
 *
 * 1) Deterministic synthetic checks (always run): the synthetic DarkScript3
 *    registry imported through the adapter is analyzed against synthetic
 *    distributions — clean kinds, vararg kinds, length-mismatch diagnostics,
 *    unknown kinds and instance-level accounting.
 * 2) Real corpus cross-validation (env-gated): `read-emevd-document` aggregate
 *    distribution of the registered common.emevd (142 kinds / 33,266
 *    instructions) is analyzed against an imported registry. Mismatch and
 *    unknown kinds get structured diagnostics (bank:id, observed length vs
 *    schema length). The imported registry comes from our synthetic DS3 JSON
 *    (deterministic leg) or from the user's real DarkScript3 EMEDF file when
 *    SOULFORGE_EMEDF_PATH / arg 2 is provided. Real EMEDF absence is a
 *    fail-closed skip, recorded in the output.
 *
 * DarkScript3 EMEDF data is All Rights Reserved and never bundled; the
 * synthetic DS3 JSON is our own tiny sample.
 *
 * Authority cap: partial — aggregate distribution only, no payload semantics.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { decompressDfltDcx } from '../util/dcxDflt.js';
import {
  analyzeEmedfCoverage,
  type EmevdCoverageAnalysis,
  type EmevdInstructionDistributionEntry
} from '../emevd/emedfCoverage.js';
import { importDs3EmedfFile } from '../emevd/emedfExternalAdapter.js';
import { decodeInstructionArgs, type EmedfRegistry } from '../emevd/emedfSchema.js';
import {
  createSyntheticImportedEmedf
} from './syntheticEmevdBytes.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';

interface EmevdEnvelope {
  sourceHash: string;
  eventCount: number;
  instructionCount: number;
  instructionDistribution?: EmevdInstructionDistributionEntry[];
  instructionDistributionTruncated?: boolean;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** A registry augmented with a deliberately wrong-length instruction (probe). */
function mismatchProbeRegistry(base: EmedfRegistry): EmedfRegistry {
  return {
    ...base,
    instructions: [
      ...base.instructions,
      {
        bank: 1000,
        id: 4,
        // Claimed 8 bytes; the real corpus observes 1000:4 at 4 bytes. This is a
        // test-only probe that proves length-signature mismatch diagnostics fire.
        name: 'WaitClaimedWrongLength',
        args: [
          { name: 'claimedA', type: 'u32' },
          { name: 'claimedB', type: 'u32' }
        ]
      }
    ]
  };
}

function structuredDiagnostics(analysis: EmevdCoverageAnalysis): {
  mismatches: Array<{
    bankId: string;
    count: number;
    schemaLength: number;
    observedLengths: number[];
    vararg: boolean;
  }>;
  unknowns: Array<{ bankId: string; count: number }>;
} {
  return {
    mismatches: analysis.lengthMismatches.map((m) => ({
      bankId: `${m.bank}:${m.id}`,
      count: m.count,
      schemaLength: m.schemaLength,
      observedLengths: m.observedLengths,
      vararg: m.vararg
    })),
    unknowns: analysis.unknownKinds.slice(0, 30).map((u) => ({
      bankId: `${u.bank}:${u.id}`,
      count: u.count
    }))
  };
}

/* ------------------------------------------------------------------ */
/*  Synthetic checks (always run)                                     */
/* ------------------------------------------------------------------ */

function syntheticChecks(): void {
  const registry = createSyntheticImportedEmedf();
  assert(registry.origin === 'imported', 'registry must be imported');

  // Clean + vararg + unknown + zero-arg kinds.
  const analysis = analyzeEmedfCoverage(registry, [
    { bank: 0, id: 0, count: 100, argsLengths: { '4': 100 } },
    { bank: 2000, id: 0, count: 60, argsLengths: { '12': 20, '16': 20, '24': 20 } },
    { bank: 2003, id: 1, count: 5, argsLengths: { '0': 5 } },
    { bank: 9999, id: 1, count: 10, argsLengths: { '4': 10 } }
  ]);
  assert(analysis.totalKinds === 4, `totalKinds ${analysis.totalKinds}`);
  assert(analysis.coveredKinds === 3, `coveredKinds ${analysis.coveredKinds}`);
  assert(analysis.cleanKinds === 3, `cleanKinds ${analysis.cleanKinds}`);
  assert(analysis.varargKinds === 1, `varargKinds ${analysis.varargKinds}`);
  assert(analysis.unknownKinds.length === 1 && analysis.unknownKinds[0]!.bank === 9999, 'unknown kind');
  assert(analysis.totalInstances === 175, `totalInstances ${analysis.totalInstances}`);
  assert(analysis.cleanInstances === 165, `cleanInstances ${analysis.cleanInstances}`);
  assert(analysis.mismatchInstances === 0, `mismatchInstances ${analysis.mismatchInstances}`);
  assert(analysis.unknownInstances === 10, `unknownInstances ${analysis.unknownInstances}`);

  // Same bank:id multi-length variant split by length signature: 12 is a valid
  // vararg multiple, 10 is not — both buckets must be reported separately.
  const split = analyzeEmedfCoverage(registry, [
    { bank: 2000, id: 0, count: 5, argsLengths: { '12': 3, '10': 2 } }
  ]);
  assert(split.cleanKinds === 0, 'invalid vararg length must not be clean');
  assert(split.cleanInstances === 3, `split cleanInstances ${split.cleanInstances}`);
  assert(split.mismatchInstances === 2, `split mismatchInstances ${split.mismatchInstances}`);
  assert(split.lengthMismatches.length === 1
    && split.lengthMismatches[0]!.vararg === true
    && split.lengthMismatches[0]!.observedLengths.join(',') === '10,12',
    'vararg mismatch detail');

  // A fixed-length schema vs a mismatched observed length must be a structured
  // mismatch (length signature, never a prefix decode).
  const probe = analyzeEmedfCoverage(mismatchProbeRegistry(registry), [
    { bank: 1000, id: 4, count: 1, argsLengths: { '4': 1 } }
  ]);
  assert(probe.cleanKinds === 0, 'wrong-length probe must not be clean');
  assert(probe.lengthMismatches.length === 1
    && probe.lengthMismatches[0]!.bank === 1000
    && probe.lengthMismatches[0]!.id === 4
    && probe.lengthMismatches[0]!.schemaLength === 8
    && probe.lengthMismatches[0]!.observedLengths.join(',') === '4'
    && probe.lengthMismatches[0]!.vararg === false,
    'wrong-length probe mismatch detail');

  // Unknown-kind diagnostics.
  const unknownDiag = structuredDiagnostics(analysis);
  assert(unknownDiag.unknowns.length === 1 && unknownDiag.unknowns[0]!.bankId === '9999:1', 'unknown diagnostic');

  // Direct decode-level length-signature gate (opaque handling, Goal 3): a
  // payload whose length does not match the schema-claimed layout must fail
  // decode with EMEDF_ARGS_LENGTH_MISMATCH instead of fabricating arg values.
  const badVararg = decodeInstructionArgs(registry, 2000, 0, Buffer.alloc(10)); // 10 is not a valid vararg multiple of base 8
  assert(!badVararg.ok && badVararg.code === 'EMEDF_ARGS_LENGTH_MISMATCH',
    'invalid vararg length must fail decode');
  const badFixed = decodeInstructionArgs(registry, 0, 0, Buffer.alloc(8)); // 0:0 schema claims 4 bytes
  assert(!badFixed.ok && badFixed.code === 'EMEDF_ARGS_LENGTH_MISMATCH',
    'mismatched fixed length must fail decode');
  const okVararg = decodeInstructionArgs(registry, 2000, 0, Buffer.alloc(12));
  assert(okVararg.ok, 'valid vararg length must decode');
  const okFixed = decodeInstructionArgs(registry, 0, 0, Buffer.from([1, 0, 2, 0]));
  assert(okFixed.ok, 'valid fixed length must decode');

  console.log(JSON.stringify({
    ok: true,
    message: '导入 registry 覆盖分析合成断言通过',
    cleanKinds: analysis.cleanKinds,
    varargKinds: analysis.varargKinds,
    cleanInstances: analysis.cleanInstances,
    mismatchInstances: analysis.mismatchInstances,
    unknownInstances: analysis.unknownInstances,
    lengthSignatureSplit: { clean: split.cleanInstances, mismatch: split.mismatchInstances },
    wrongLengthProbeRejected: true,
    decodeLengthGate: {
      invalidVarargLengthRejected: badVararg.code,
      mismatchedFixedLengthRejected: badFixed.code,
      validVarargDecoded: okVararg.ok,
      validFixedDecoded: okFixed.ok
    }
  }));
}

/* ------------------------------------------------------------------ */
/*  Real corpus cross-validation                                      */
/* ------------------------------------------------------------------ */

async function realCorpusCoverage(
  root: string,
  sourceDcx: string,
  registry: EmedfRegistry,
  label: string
): Promise<EmevdCoverageAnalysis> {
  const staging = join(root, `coverage-${label}`);
  await mkdir(staging, { recursive: true });
  const payload = decompressDfltDcx(await readFile(sourceDcx));
  const emevdPath = join(staging, 'common.emevd');
  await writeFile(emevdPath, payload);

  const read = await runBridge<EmevdEnvelope>({
    command: 'read-emevd-document',
    filePath: emevdPath,
    allowedRoots: [staging],
    timeoutMs: 60_000
  });
  const distribution = read.data?.instructionDistribution;
  assert(Array.isArray(distribution) && distribution.length > 0, 'instructionDistribution missing or empty');
  assert(read.data?.instructionCount === distribution.reduce((sum, e) => sum + e.count, 0),
    'distribution instance total must equal envelope instructionCount');

  const analysis = analyzeEmedfCoverage(registry, distribution, read.data?.instructionDistributionTruncated ?? false);
  assert(analysis.totalInstances === read.data?.instructionCount, 'analysis instance total');
  assert(analysis.totalInstances === 33_266, `expected 33,266 instances, got ${analysis.totalInstances}`);
  assert(analysis.cleanInstances + analysis.mismatchInstances + analysis.unknownInstances === analysis.totalInstances,
    'instance buckets must sum to total');

  const diagnostics = structuredDiagnostics(analysis);
  console.log(JSON.stringify({
    ok: true,
    message: `EMEVD 真实 corpus 与导入 registry(${label}) 覆盖交叉验证通过`,
    registryOrigin: registry.origin,
    distribution: {
      eventCount: read.data.eventCount,
      instructionCount: read.data.instructionCount,
      totalKinds: analysis.totalKinds,
      truncated: read.data.instructionDistributionTruncated ?? false
    },
    coverage: {
      coveredKinds: analysis.coveredKinds,
      cleanKinds: analysis.cleanKinds,
      varargKinds: analysis.varargKinds,
      unknownKinds: analysis.unknownKinds.length,
      lengthMismatches: analysis.lengthMismatches.length,
      kindCoverageRatio: Number(analysis.kindCoverageRatio.toFixed(4)),
      instanceCoverageRatio: Number(analysis.instanceCoverageRatio.toFixed(4))
    },
    instances: {
      covered: analysis.coveredInstances,
      clean: analysis.cleanInstances,
      mismatch: analysis.mismatchInstances,
      unknown: analysis.unknownInstances
    },
    structuredDiagnostics: diagnostics
  }, null, 2));
  return analysis;
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-emevd-imported-coverage-'));
  const nativeFixtureArg = process.argv[2]?.trim() || undefined;
  const emedfPathArg = process.env.SOULFORGE_EMEDF_PATH?.trim()
    || process.argv[3]?.trim()
    || undefined;
  const nativeEnvAvailable = Boolean(
    (process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY?.trim() && process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim())
    || nativeFixtureArg
  );
  const skipReasons: string[] = [];
  let realEmedfCovered = false;
  try {
    syntheticChecks();

    if (nativeEnvAvailable) {
      const sourceDcx = await resolveNativeFixture(nativeFixtureArg, 'emevd-primary', '../../mods/event/common.emevd.dcx');

      // Deterministic cross-validation: synthetic imported registry vs real corpus.
      const syntheticImported = createSyntheticImportedEmedf();
      const cleanAnalysis = await realCorpusCoverage(root, sourceDcx, syntheticImported, 'synthetic-imported');
      assert(cleanAnalysis.cleanKinds === 2, `synthetic-imported cleanKinds ${cleanAnalysis.cleanKinds}`);
      assert(cleanAnalysis.varargKinds === 1, `synthetic-imported varargKinds ${cleanAnalysis.varargKinds}`);
      assert(cleanAnalysis.mismatchInstances === 0, 'clean synthetic schema must have no mismatches');
      assert(cleanAnalysis.unknownKinds.length === 140, `synthetic-imported unknownKinds ${cleanAnalysis.unknownKinds.length}`);

      // Length-signature mismatch probe against real data: 1000:4 is observed at
      // 4 bytes but the probe schema claims 8 — must be a structured mismatch.
      const probeAnalysis = await realCorpusCoverage(root, sourceDcx, mismatchProbeRegistry(syntheticImported), 'mismatch-probe');
      const probeMismatch = probeAnalysis.lengthMismatches.find((m) => m.bank === 1000 && m.id === 4);
      assert(probeMismatch !== undefined, 'real-corpus mismatch probe must report 1000:4');
      assert(probeMismatch.schemaLength === 8 && probeMismatch.observedLengths.includes(4),
        'real-corpus mismatch probe detail');

      // Real EMEDF file cross-validation (fail-closed when absent).
      if (emedfPathArg) {
        const realImport = importDs3EmedfFile(emedfPathArg);
        if (!realImport.ok) throw new Error(`real EMEDF import failed: ${realImport.message}`);
        await realCorpusCoverage(root, sourceDcx, realImport.registry, 'real-emedf');
        realEmedfCovered = true;
      } else {
        skipReasons.push('SOULFORGE_EMEDF_PATH 未设置且未提供 arg 3：真实 DarkScript3 EMEDF 文件缺失，真实导入 EMEDF 的真实 corpus 交叉验证 fail-closed 跳过。');
      }
    } else {
      skipReasons.push('SOULFORGE_NATIVE_FIXTURE_REGISTRY/SOULFORGE_NATIVE_FIXTURE_ROOT 未设置：真实 corpus 分布 leg 跳过。');
    }

    console.log(JSON.stringify({
      ok: true,
      message: '导入 registry 覆盖交叉验证 smoke 完成',
      syntheticChecks: 'passed',
      realCorpusLegs: nativeEnvAvailable ? 'synthetic-imported + mismatch-probe（含真实 142 种 / 33,266 条）' : 'skipped',
      realEmedfCoverage: realEmedfCovered ? 'passed' : 'skipped',
      skips: skipReasons,
      nonClaims: [
        '覆盖分析只基于聚合分布（长度签名），不读取 payload 语义。',
        '合成导入 registry 只覆盖 0:0 / 2000:0 / 2003:1 三种指令族，真实 corpus 其余 140 种保持 unknown/unsupported。',
        'authority 上限为 partial；cleanKinds 高不代表参数类型正确，只代表长度签名一致。'
      ]
    }, null, 2));
  } finally {
    await disposeBridgeDaemonPool();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  disposeBridgeDaemonPool().finally(() => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
});
