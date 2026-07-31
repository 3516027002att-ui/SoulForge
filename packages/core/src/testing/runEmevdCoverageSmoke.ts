/**
 * EMEDF coverage smoke:
 * 1) Synthetic distribution assertions (always run, deterministic).
 * 2) Real corpus distribution when a native fixture is injected (arg 2),
 *    mirroring runNativeEmevdSmoke's fixture contract.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { decompressDfltDcx } from '../util/dcxDflt.js';
import { createSekiroFixtureEmedf } from '../emevd/emedfSchema.js';
import {
  analyzeEmedfCoverage,
  schemaLengthVsObserved,
  type EmevdInstructionDistributionEntry
} from '../emevd/emedfCoverage.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';

interface EmevdEnvelope {
  sourceHash: string;
  eventCount: number;
  instructionCount: number;
  instructionDistribution?: EmevdInstructionDistributionEntry[];
  instructionDistributionTruncated?: boolean;
  authority?: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function syntheticCoverageChecks(): void {
  const registry = createSekiroFixtureEmedf();

  const synthetic: EmevdInstructionDistributionEntry[] = [
    { bank: 2000, id: 0, count: 5, argsLengths: { '12': 5 } },
    { bank: 1000, id: 0, count: 3, argsLengths: { '8': 3 } },
    { bank: 9999, id: 1, count: 2, argsLengths: { '4': 2 } }
  ];
  const clean = analyzeEmedfCoverage(registry, synthetic);
  assert(clean.totalKinds === 3, `totalKinds ${clean.totalKinds}`);
  assert(clean.coveredKinds === 2, `coveredKinds ${clean.coveredKinds}`);
  assert(clean.cleanKinds === 2, `cleanKinds ${clean.cleanKinds}`);
  assert(clean.coveredInstances === 8 && clean.totalInstances === 10, 'instance counts');
  assert(clean.unknownKinds.length === 1 && clean.unknownKinds[0]!.bank === 9999, 'unknown kind reported');
  assert(clean.lengthMismatches.length === 0, 'no mismatches expected');

  // Length mismatch must be reported and exclude the kind from clean coverage.
  const mismatched = analyzeEmedfCoverage(registry, [
    { bank: 2000, id: 0, count: 1, argsLengths: { '20': 1 } }
  ]);
  assert(mismatched.cleanKinds === 0, `expected no clean kinds, got ${mismatched.cleanKinds}`);
  assert(mismatched.lengthMismatches.length === 1
    && mismatched.lengthMismatches[0]!.schemaLength === 12
    && mismatched.lengthMismatches[0]!.observedLengths.join(',') === '20', 'mismatch detail');

  // Empty distribution must not divide by zero.
  const empty = analyzeEmedfCoverage(registry, []);
  assert(empty.kindCoverageRatio === 0 && empty.instanceCoverageRatio === 0, 'empty ratios');

  // schemaLengthVsObserved roundtrip.
  const observed = schemaLengthVsObserved(registry.instructions[0]!, synthetic);
  assert(observed !== null && observed.schemaLength === 12 && observed.observedLengths.join(',') === '12', 'length vs observed');

  console.log(JSON.stringify({
    ok: true,
    message: 'EMEDF 覆盖分析合成断言通过',
    coveredKinds: clean.coveredKinds,
    cleanKinds: clean.cleanKinds,
    unknownKinds: clean.unknownKinds.length,
    lengthMismatches: mismatched.lengthMismatches.length
  }));
}

async function realCorpusCoverage(sourceDcx: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-emevd-coverage-'));
  const staging = join(root, 'staging');
  await mkdir(staging, { recursive: true });
  try {
    const dcxBytes = await readFile(sourceDcx);
    const payload = decompressDfltDcx(dcxBytes);
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

    const registry = createSekiroFixtureEmedf();
    const analysis = analyzeEmedfCoverage(registry, distribution, read.data?.instructionDistributionTruncated ?? false);
    assert(analysis.totalInstances === read.data?.instructionCount, 'analysis instance total');
    assert(analysis.totalInstances > 0, 'no instructions');

    // Fixture instructions that appear must match at least one observed args
    // length. Real Sekiro corpora contain multi-length variants for the same
    // bank/id (observed for 2000:0: 12/16/20/24/32), so a schema covers a kind
    // when its claimed length is among the observed lengths; additional lengths
    // are reported, not asserted away.
    const fixtureChecks = registry.instructions.map((def) => {
      const match = schemaLengthVsObserved(def, distribution);
      return {
        bank: def.bank,
        id: def.id,
        name: def.name,
        appears: match !== null,
        schemaLength: match?.schemaLength ?? null,
        observedLengths: match?.observedLengths ?? [],
        multiLength: match ? match.observedLengths.length > 1 : false
      };
    });
    const uncovered = fixtureChecks.filter((c) => c.appears && !c.observedLengths.includes(c.schemaLength!));
    assert(uncovered.length === 0, `fixture instruction schema length not observed: ${JSON.stringify(uncovered)}`);

    console.log(JSON.stringify({
      ok: true,
      message: 'EMEVD 真实 corpus 指令分布与覆盖分析通过',
      eventCount: read.data.eventCount,
      instructionCount: read.data.instructionCount,
      distributionKinds: analysis.totalKinds,
      distributionTruncated: read.data.instructionDistributionTruncated ?? false,
      coverage: {
        coveredKinds: analysis.coveredKinds,
        cleanKinds: analysis.cleanKinds,
        unknownKinds: analysis.unknownKinds.length,
        lengthMismatches: analysis.lengthMismatches.length,
        kindCoverageRatio: Number(analysis.kindCoverageRatio.toFixed(4)),
        instanceCoverageRatio: Number(analysis.instanceCoverageRatio.toFixed(4))
      },
      fixtureChecks,
      authority: read.data.authority
    }, null, 2));
  } finally {
    await disposeBridgeDaemonPool();
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  syntheticCoverageChecks();
  const nativeFixtureArg = process.argv[2]?.trim() || undefined;
  const nativeEnvAvailable = Boolean(
    (process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY?.trim() && process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim())
    || nativeFixtureArg
  );
  if (nativeEnvAvailable) {
    const sourceDcx = await resolveNativeFixture(nativeFixtureArg, 'emevd-primary', '../../mods/event/common.emevd.dcx');
    await realCorpusCoverage(sourceDcx);
  } else {
    console.log(JSON.stringify({
      ok: true,
      message: '真实 corpus 变体跳过：SOULFORGE_NATIVE_FIXTURE_REGISTRY/SOULFORGE_NATIVE_FIXTURE_ROOT 未设置；通过 node scripts/with-local-has-game-env.mjs 运行可注入本机 corpus 环境。'
    }));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
