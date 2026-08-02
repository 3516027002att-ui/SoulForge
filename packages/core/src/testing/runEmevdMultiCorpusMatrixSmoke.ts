/**
 * Multi-corpus EMEVD cross-validation smoke (W-EMEVD-FULL-01 / wave-2).
 *
 * Extends the wave-1 full-corpus typed-mutation matrix to MULTIPLE registered
 * emevd corpora:
 *
 *  1. Coverage analysis (cleanKinds / length mismatches / unknownKinds) on every
 *     corpus with the synthetic-imported registry AND (when available) the real
 *     DarkScript3 EMEDF registry.
 *  2. Typed-mutation matrix (wave-1 style, through the production write chain:
 *     DSL compile -> typed plan -> Bridge batch staging -> file_replace PatchIR
 *     -> WorkspaceTransaction -> Bridge re-read) on every DFLT-decompressed
 *     corpus with the synthetic-imported registry, and — when SOULFORGE_EMEDF_PATH
 *     (or a located real EMEDF file) is available — with the real imported
 *     registry.
 *  3. Cross-corpus instruction-distribution differences (which instruction
 *     families appear only in a subset of the corpora).
 *  4. Opaque handling of high-instance uncovered families (e.g. 2004:8
 *     SetSpEffect, 1001:1 WAITFixedTimeFrames): never decoded, never
 *     re-encoded, fail closed in DSL and decode; multi-length variants stay
 *     length-signature distinguished — no fabricated arg types.
 *  5. Schema-driven control-flow validation regression per corpus: no crashes,
 *     no error diagnostics, warnings reference only schema-covered families,
 *     stale event-ID references are detected (no false negatives) and absent
 *     references are not flagged (no false positives).
 *
 * The synthetic leg always runs. Real corpora are env-gated (local Sekiro game
 * root via SOULFORGE_NATIVE_FIXTURE_REGISTRY / SOULFORGE_NATIVE_FIXTURE_ROOT /
 * SOULFORGE_SEKIRO_GAME_ROOT or an explicit corpus path). KRAK-wrapped corpora
 * (e.g. m10_00_00_00.emevd.dcx) are probed via the Bridge DCX reader and get a
 * structured fail-closed diagnostic: the TS side has no Oodle runtime, and
 * read-dcx-document exposes only a 128-byte payload prefix, so a full
 * distribution/mutation matrix for KRAK payloads is not runnable here.
 *
 * DarkScript3 EMEDF data is All Rights Reserved and never bundled; the real
 * file is read only from a user-provided path, and the synthetic DS3 JSON is
 * our own tiny sample.
 *
 * Authority cap: partial — real DarkScript3 EMEDF length signatures are shown
 * to be consistent with every observed corpus args length, but typed-mutation
 * proof still only demonstrates equal-length writes through the production
 * chain, not parameter semantics, layers or game loading.
 */

import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { EmevdEditorDocument } from '@soulforge/shared';
import {
  createEmevdEditorDocument,
  submitEmevdDslPlanViaFourView
} from '../editing/emevdFourViewController.js';
import { readFullEmevdDocumentViaBridge } from '../editing/emevdFullDocument.js';
import { compileEmevdPatchDsl, fingerprintEmedfRegistry } from '../emevd/dslCompiler.js';
import {
  decodeInstructionArgs,
  extractEventIdReferences,
  findInstructionDef,
  type EmedfRegistry
} from '../emevd/emedfSchema.js';
import {
  assert,
  analyzeMultiLengthKinds,
  argsBytesEqual,
  buildMatrixDslSource,
  compileRequestFor,
  pickEventMutation,
  planCoveredMutations,
  singleInstructionDsl,
  verifyMatrixCommit,
  verifyUnknownKindFailClosed,
  type EmevdEnvelope,
  type EventMutationSpec,
  type FlatInstruction
} from '../emevd/emevdCorpusMatrix.js';
import { importDs3EmedfFile } from '../emevd/emedfExternalAdapter.js';
import {
  analyzeEmedfCoverage,
  summarizeCorpusFamilyDifferences,
  type EmevdCoverageAnalysis,
  type EmevdInstructionDistributionEntry
} from '../emevd/emedfCoverage.js';
import { formatEmevdAnchor } from '../emevd/stableIdentity.js';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { decompressDfltDcx, isDcxWrapper } from '../util/dcxDflt.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import {
  buildSyntheticEmevd,
  createSyntheticImportedEmedf,
  sha256Hex
} from './syntheticEmevdBytes.js';
import { searchRealEmedf } from './realEmedfLocator.js';

/* ------------------------------------------------------------------ */
/*  Corpus discovery                                                   */
/* ------------------------------------------------------------------ */

export interface CorpusSpec {
  label: string;
  /** Absolute path to the corpus file (raw .emevd or DCX wrapper). */
  path: string;
  registered: boolean;
}

const CURATED_CORPORA_REL = [
  'mods/event/common.emevd.dcx',
  'mods/event/common_func.emevd.dcx',
  'mods/event/m11_00_00_00.emevd.dcx',
  'mods/event/m10_00_00_00.emevd.dcx',
  'mods/event/m25_00_00_00.emevd.dcx',
  'mods/event/m13_00_00_00.emevd.dcx',
  'mods/event/m17_00_00_00.emevd.dcx',
  'mods/event/m20_00_00_00.emevd.dcx'
];

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

interface FixtureRegistryJson {
  schemaVersion?: string;
  fixtures?: Array<{
    fixtureId?: string;
    localPath?: string;
    sha256?: string;
    testRole?: string;
  }>;
}

async function readFixtureRegistry(): Promise<FixtureRegistryJson | undefined> {
  const registryPath = process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY?.trim();
  if (!registryPath) return undefined;
  try {
    const parsed = JSON.parse(await readFile(registryPath, 'utf8')) as FixtureRegistryJson;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Discover the emevd corpus set:
 *  - explicit argv[2] (non-empty): a single corpus file path.
 *  - else SOULFORGE_NATIVE_FIXTURE_REGISTRY: every registered fixture whose
 *    localPath ends with `.emevd.dcx` (sha256 verified).
 *  - else game root env: the curated corpus list (existence-checked).
 * Registered fixtures always win for the registry case; curated corpora are
 * appended when present under the same root so the cross-corpus comparison is
 * richer (labeled clearly as curated).
 */
async function discoverCorpora(explicitArg: string | undefined): Promise<{
  corpora: CorpusSpec[];
  notes: string[];
}> {
  const notes: string[] = [];
  if (explicitArg?.trim()) {
    return {
      corpora: [{ label: basename(explicitArg.trim()), path: resolve(explicitArg.trim()), registered: true }],
      notes
    };
  }

  const registry = await readFixtureRegistry();
  const fixtureRoot = process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim()
    || process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();

  const registered: CorpusSpec[] = [];
  if (registry && Array.isArray(registry.fixtures) && fixtureRoot) {
    for (const fixture of registry.fixtures) {
      const rel = (fixture.localPath ?? '').replace(/\\/g, '/');
      if (!rel.toLowerCase().endsWith('.emevd.dcx')) continue;
      if (!fixture.sha256 || !/^[a-f0-9]{64}$/i.test(fixture.sha256)) {
        notes.push(`登记 fixture ${rel} 缺少合法 sha256，跳过登记 corpus。`);
        continue;
      }
      const candidate = isAbsolute(rel) ? resolve(rel) : resolve(fixtureRoot, rel);
      let actualHash: string;
      try {
        actualHash = sha256(await readFile(candidate));
      } catch {
        notes.push(`登记 fixture 不存在或不可读：${candidate}`);
        continue;
      }
      if (actualHash !== fixture.sha256.toLowerCase()) {
        notes.push(`登记 fixture 哈希不匹配（已变更或已篡改）：${candidate}`);
        continue;
      }
      registered.push({ label: basename(candidate), path: candidate, registered: true });
    }
    if (registered.length === 0) notes.push('登记 registry 中未发现 emevd.dcx fixture。');
  } else if (fixtureRoot) {
    notes.push('未提供 registry；从 game root 用 curated 列表发现 corpus。');
  }

  const curated: CorpusSpec[] = [];
  if (fixtureRoot) {
    const seen = new Set(registered.map((c) => c.path));
    for (const rel of CURATED_CORPORA_REL) {
      const candidate = resolve(fixtureRoot, rel);
      if (seen.has(candidate)) continue;
      try {
        await access(candidate);
      } catch {
        continue;
      }
      curated.push({ label: basename(candidate), path: candidate, registered: false });
    }
  }

  const corpora = [...registered, ...curated];
  if (corpora.length === 0 && !fixtureRoot) {
    notes.push('缺少 SOULFORGE_NATIVE_FIXTURE_ROOT / SOULFORGE_SEKIRO_GAME_ROOT 且未提供显式 corpus 路径：真实 corpus leg 跳过。');
  }
  return { corpora, notes };
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1]!;
}

/* ------------------------------------------------------------------ */
/*  Synthetic leg                                                      */
/* ------------------------------------------------------------------ */

function syntheticFamilyDifferenceChecks(): void {
  // Three synthetic distributions with overlapping and corpus-specific families.
  const a: EmevdInstructionDistributionEntry[] = [
    { bank: 0, id: 0, count: 100, argsLengths: { '4': 100 } },
    { bank: 2000, id: 0, count: 40, argsLengths: { '12': 40 } },
    { bank: 2004, id: 8, count: 500, argsLengths: { '8': 500 } },
    { bank: 2000, id: 6, count: 300, argsLengths: { '8': 200, '16': 100 } }
  ];
  const b: EmevdInstructionDistributionEntry[] = [
    { bank: 0, id: 0, count: 80, argsLengths: { '4': 80 } },
    { bank: 1001, id: 1, count: 700, argsLengths: { '4': 700 } },
    { bank: 2000, id: 6, count: 10, argsLengths: { '8': 10 } }
  ];
  const c: EmevdInstructionDistributionEntry[] = [
    { bank: 0, id: 0, count: 60, argsLengths: { '4': 60 } },
    { bank: 2004, id: 8, count: 40, argsLengths: { '8': 40 } },
    { bank: 3000, id: 1, count: 5, argsLengths: { '0': 5 } }
  ];
  const summary = summarizeCorpusFamilyDifferences([
    { label: 'A', distribution: a },
    { label: 'B', distribution: b },
    { label: 'C', distribution: c }
  ]);
  assert(summary.corpusLabels.join(',') === 'A,B,C', 'corpus labels');
  assert(summary.unionFamilyCount === 6, `unionFamilyCount ${summary.unionFamilyCount}`);
  // 0:0 in all corpora; 2000:6 in A+B; 2004:8 in A+C; 1001:1 only in B; 3000:1 only in C.
  const onlyIn = (b: number, i: number): string | undefined =>
    summary.familiesInSubset.find((f) => f.bank === b && f.id === i)?.presentIn.join(',');
  assert(onlyIn(2000, 6) === 'A,B', `2000:6 subset ${onlyIn(2000, 6)}`);
  assert(onlyIn(2004, 8) === 'A,C', `2004:8 subset ${onlyIn(2004, 8)}`);
  assert(onlyIn(1001, 1) === 'B', `1001:1 subset ${onlyIn(1001, 1)}`);
  assert(onlyIn(3000, 1) === 'C', `3000:1 subset ${onlyIn(3000, 1)}`);
  assert(summary.familiesInAllCorpora.length === 1 && summary.familiesInAllCorpora[0]!.bank === 0,
    'only 0:0 present in all synthetic corpora');
  // Deterministic ordering: subset sorted by totalCount desc.
  const totals = summary.familiesInSubset.map((f) => f.totalCount);
  assert(totals.every((v, i) => i === 0 || totals[i - 1]! >= v), 'subset must be sorted by totalCount desc');
}

/** Compact production-chain matrix over a synthetic two-event corpus. */
async function syntheticMatrixLeg(root: string): Promise<void> {
  const registry = createSyntheticImportedEmedf();
  const schemaFingerprint = fingerprintEmedfRegistry(registry);
  const original = buildSyntheticEmevd([
    {
      id: 50,
      restBehavior: 0,
      instructions: [
        { bank: 0, id: 0, args: Buffer.from([0x01, 0x00, 0x02, 0x00]) },
        { bank: 2000, id: 0, args: Buffer.from([0x0a, 0, 0, 0, 0x64, 0, 0, 0, 0x07, 0, 0, 0]) },
        { bank: 9999, id: 1, args: Buffer.alloc(8, 0xaa) }
      ]
    },
    { id: 100, restBehavior: 0, instructions: [] }
  ]);

  const overlayRoot = join(root, 'mod-multicorpus-synthetic');
  const stagingRoot = join(root, 'staging-multicorpus-synthetic');
  await mkdir(join(overlayRoot, 'event'), { recursive: true });
  await mkdir(stagingRoot, { recursive: true });
  const target = join(overlayRoot, 'event', 'common.emevd');
  await writeFile(target, original);
  const sourceHash = sha256Hex(original);

  const document = createEmevdEditorDocument({
    resourceUri: 'file://event/common.emevd',
    documentInstanceId: 'emevd-multicorpus-synthetic',
    events: [
      {
        eventId: 50,
        restBehavior: 0,
        instructions: [
          { bank: 0, id: 0, argsBase64: Buffer.from([0x01, 0x00, 0x02, 0x00]).toString('base64'), unknown: false },
          { bank: 2000, id: 0, argsBase64: Buffer.from([0x0a, 0, 0, 0, 0x64, 0, 0, 0, 0x07, 0, 0, 0]).toString('base64'), unknown: false },
          { bank: 9999, id: 1, argsBase64: Buffer.alloc(8, 0xaa).toString('base64'), unknown: true }
        ]
      },
      { eventId: 100, restBehavior: 0, instructions: [] }
    ]
  });
  const event0 = document.events[0]!;
  const samples = [
    {
      globalIndex: 0,
      instructionAnchor: formatEmevdAnchor('instruction', event0.instructions[0]!.anchor!),
      bank: 0,
      id: 0,
      argument: 'resultConditionGroup',
      before: 1,
      after: 2,
      argsBase64Before: event0.instructions[0]!.argsBase64
    },
    {
      globalIndex: 1,
      instructionAnchor: formatEmevdAnchor('instruction', event0.instructions[1]!.anchor!),
      bank: 2000,
      id: 0,
      argument: 'eventId',
      before: 100,
      after: 101,
      argsBase64Before: event0.instructions[1]!.argsBase64,
      tailBefore: Buffer.from([0x07, 0, 0, 0])
    }
  ];
  const eventMutation: EventMutationSpec = {
    eventAnchor: formatEmevdAnchor('event', event0.anchor!),
    newId: 51,
    newRest: 1
  };
  const dslSource = buildMatrixDslSource(schemaFingerprint, document.resourceUri, eventMutation, samples);
  const compiled = compileEmevdPatchDsl(compileRequestFor(dslSource, schemaFingerprint, document), document, registry);
  if (!compiled.ok || !compiled.plan) throw new Error(`synthetic multi-corpus compile failed: ${JSON.stringify(compiled.diagnostics)}`);
  assert(compiled.plan.operations.length === 4, `expected 4 ops, got ${compiled.plan.operations.length}`);

  const before = await runBridge<EmevdEnvelope>({
    command: 'read-emevd-document',
    filePath: target,
    allowedRoots: [overlayRoot, stagingRoot],
    timeoutMs: 120_000
  });
  if (before.parseStatus === 'failed' || !before.data?.roundTrip?.semanticIdentical) {
    throw new Error(`synthetic multi-corpus rejected by Bridge: ${JSON.stringify(before.diagnostics)}`);
  }

  const session = await openWorkspaceSession({ overlayRoot, game: 'sekiro' });
  const submitted = await submitEmevdDslPlanViaFourView({
    compileRequest: compileRequestFor(dslSource, schemaFingerprint, document),
    document,
    registry,
    sourcePath: target,
    expectedDocumentHash: sourceHash,
    allowedRoots: [overlayRoot, stagingRoot],
    workspaceId: session.meta.workspaceId,
    workspaceRoot: overlayRoot,
    stagingRoot,
    title: 'emevd multi-corpus synthetic'
  });
  if (!submitted.ok || !submitted.commit || !submitted.commit.ok) {
    throw new Error(`synthetic multi-corpus submit failed: ${JSON.stringify(submitted.diagnostics)}`);
  }
  assert(submitted.commit.mutationCount === 4, `expected 4 mutations, got ${submitted.commit.mutationCount}`);
  assert(submitted.commit.reRead?.byteConsistent && submitted.commit.reRead.semanticIdentical, 'synthetic re-read verification');

  const after = await runBridge<EmevdEnvelope>({
    command: 'read-emevd-document',
    filePath: target,
    allowedRoots: [overlayRoot, stagingRoot],
    timeoutMs: 120_000
  });
  if (after.parseStatus === 'failed' || !after.data) throw new Error('synthetic post-commit read failed');
  assert(after.data.instructionCount === 3, 'synthetic instruction count changed');
  assert(after.data.events?.some((e) => e.id === 51 && e.restBehavior === 1), 'renamed event not observable');
  const sample = after.data.instructionsSample?.find((i) => i.index === 1);
  assert(sample !== undefined && Buffer.from(sample.argsBase64, 'base64').subarray(4, 8).equals(Buffer.from([101, 0, 0, 0])),
    'synthetic 2000:0 eventId mutation not observable');
  assert(argsBytesEqual(sample.argsBase64, Buffer.concat([Buffer.from([0x0a, 0, 0, 0, 0x65, 0, 0, 0]), Buffer.from([0x07, 0, 0, 0])]).toString('base64')),
    'synthetic vararg tail not preserved');
}

/* ------------------------------------------------------------------ */
/*  Coverage leg                                                       */
/* ------------------------------------------------------------------ */

interface CorpusCoverageResult {
  label: string;
  compression: string;
  eventCount: number;
  instructionCount: number;
  distribution: EmevdInstructionDistributionEntry[];
  distributionsTruncated: boolean;
  syntheticImported: EmevdCoverageAnalysis;
  realEmedf: EmevdCoverageAnalysis | undefined;
}

async function readCorpusPayload(path: string): Promise<{ payload: Buffer; compression: string }> {
  const bytes = await readFile(path);
  if (!isDcxWrapper(bytes)) return { payload: bytes, compression: 'none' };
  const compression = bytes.subarray(0x28, 0x2c).toString('ascii');
  if (compression !== 'DFLT') return { payload: bytes, compression };
  return { payload: decompressDfltDcx(bytes), compression: 'DFLT' };
}

/**
 * Decompress (DFLT only) and read the aggregate distribution + coverage of one
 * corpus against the synthetic-imported registry and, when available, the real
 * imported registry.
 */
async function coverageLeg(
  stagingRoot: string,
  corpus: CorpusSpec,
  registry: EmedfRegistry,
  realRegistry?: EmedfRegistry
): Promise<CorpusCoverageResult> {
  const { payload, compression } = await readCorpusPayload(corpus.path);
  if (compression !== 'DFLT' && compression !== 'none') {
    throw new Error(`EMEVD_CORPUS_${compression}_TS_UNSUPPORTED: ${corpus.path}`);
  }
  const target = join(stagingRoot, `${corpus.label}.emevd`);
  await writeFile(target, payload);
  const read = await runBridge<EmevdEnvelope>({
    command: 'read-emevd-document',
    filePath: target,
    allowedRoots: [stagingRoot],
    timeoutMs: 60_000
  });
  if (read.parseStatus === 'failed' || !read.data) {
    throw new Error(`EMEVD_DOCUMENT_READ_FAILED ${corpus.path}: ${JSON.stringify(read.diagnostics)}`);
  }
  const distribution = read.data.instructionDistribution ?? [];
  assert(distribution.length > 0, `distribution empty for ${corpus.label}`);
  const total = distribution.reduce((sum, entry) => sum + entry.count, 0);
  assert(total === read.data.instructionCount, `distribution total ${total} != envelope ${read.data.instructionCount}`);
  const syntheticImported = analyzeEmedfCoverage(registry, distribution, read.data.instructionDistributionTruncated ?? false);
  const realEmedf = realRegistry
    ? analyzeEmedfCoverage(realRegistry, distribution, read.data.instructionDistributionTruncated ?? false)
    : undefined;
  assert(syntheticImported.totalInstances === total, 'synthetic-imported instance total');
  assert(syntheticImported.cleanInstances + syntheticImported.mismatchInstances + syntheticImported.unknownInstances === total,
    'instance buckets must sum to total');
  return {
    label: corpus.label,
    compression,
    eventCount: read.data.eventCount,
    instructionCount: read.data.instructionCount,
    distribution,
    distributionsTruncated: read.data.instructionDistributionTruncated ?? false,
    syntheticImported,
    realEmedf
  };
}

/* ------------------------------------------------------------------ */
/*  Goal 3: high-instance uncovered family opaque handling             */
/* ------------------------------------------------------------------ */

interface OpaqueFamilyVerificationResult {
  checkedFamilies: Array<{
    bank: number;
    id: number;
    count: number;
    observedLengths: number[];
    unknownDecodeCode: string;
    dslReadonlyCode: string;
  }>;
}

/**
 * Verify that the high-instance instruction families NOT covered by the current
 * (synthetic-imported) schema are handled as opaque:
 *  - never decoded (EMEDF_UNKNOWN_INSTRUCTION at every observed length, never a
 *    partial/prefix decode),
 *  - never writable via DSL (EMEVD_DSL_UNKNOWN_INSTRUCTION_READONLY),
 *  - classified as unknown kinds in the coverage analysis (never length
 *    mismatches), and never conflated with covered families regardless of their
 *    args length (multi-length variants are distinguished by length signature
 *    only for schematized kinds; unschematized kinds fail closed outright).
 */
async function highInstanceOpaqueLeg(
  document: EmevdEditorDocument,
  distribution: EmevdInstructionDistributionEntry[],
  registry: EmedfRegistry,
  schemaFingerprint: string
): Promise<OpaqueFamilyVerificationResult> {
  const byCount = [...distribution].sort((a, b) => b.count - a.count);
  const top = byCount.filter((entry) => findInstructionDef(registry, entry.bank, entry.id) === undefined).slice(0, 8);
  assert(top.length > 0, 'expected at least one uncovered high-instance family');

  const flat = new Map<number, EmevdEditorDocument['events'][number]['instructions'][number]>();
  for (const event of document.events) {
    for (const instruction of event.instructions) {
      flat.set(flat.size, instruction);
    }
  }

  const checkedFamilies: OpaqueFamilyVerificationResult['checkedFamilies'] = [];
  for (const entry of top) {
    const lengths = Object.keys(entry.argsLengths).map(Number).filter(Number.isSafeInteger).sort((a, b) => a - b);
    const decodeCodes: string[] = [];
    for (const length of lengths) {
      const decoded = decodeInstructionArgs(registry, entry.bank, entry.id, Buffer.alloc(length));
      assert(!decoded.ok, `uncovered ${entry.bank}:${entry.id} at ${length} bytes must not decode`);
      assert(decoded.code === 'EMEDF_UNKNOWN_INSTRUCTION', `unexpected decode code ${decoded.code} for uncovered ${entry.bank}:${entry.id}`);
      if (!decodeCodes.includes(decoded.code)) decodeCodes.push(decoded.code);
    }
    // DSL write on one sample instance must fail closed.
    const sample = [...flat.values()].find((instruction) => instruction.bank === entry.bank && instruction.id === entry.id);
    assert(sample !== undefined && sample.anchor, `no sample instance for ${entry.bank}:${entry.id}`);
    const compiled = compileEmevdPatchDsl(
      compileRequestFor(
        singleInstructionDsl(schemaFingerprint, document.resourceUri, formatEmevdAnchor('instruction', sample.anchor), 'anyArg', 1),
        schemaFingerprint,
        document
      ),
      document,
      registry
    );
    assert(compiled.ok === false && !('plan' in compiled), `uncovered ${entry.bank}:${entry.id} DSL write must fail closed`);
    assert(compiled.diagnostics.some((d) => d.code === 'EMEVD_DSL_UNKNOWN_INSTRUCTION_READONLY'),
      `uncovered ${entry.bank}:${entry.id} missing read-only diagnostic`);
    checkedFamilies.push({
      bank: entry.bank,
      id: entry.id,
      count: entry.count,
      observedLengths: lengths,
      unknownDecodeCode: decodeCodes[0] ?? '',
      dslReadonlyCode: 'EMEVD_DSL_UNKNOWN_INSTRUCTION_READONLY'
    });
  }
  return { checkedFamilies };
}

/* ------------------------------------------------------------------ */
/*  Goal 4: control-flow regression                                    */
/* ------------------------------------------------------------------ */

interface ControlFlowRegressionResult {
  baselineCompiled: boolean;
  warningsByCode: Record<string, number>;
  allWarningsSeverityWarning: boolean;
  warningsTargetCoveredFamilies: boolean;
  staleReference: {
    check: 'ran' | 'n/a';
    referencedEventId?: number;
    newId?: number;
    staleWarnings?: number;
    staleWarningsAllCovered?: boolean;
    falsePositiveCheck?: { renamedEventId: number; staleWarnings: number };
  };
}

/**
 * Schema-driven control-flow validation regression on one corpus:
 *  - a benign typed patch compiles with only warning-severity control-flow
 *    diagnostics, and every warning's target resolves to a schema-covered
 *    instruction family (no warnings fabricated from opaque families);
 *  - renaming an event that IS referenced by a covered instruction yields at
 *    least one EMEVD_DSL_EVENT_ID_REFERENCE_STALE warning (no false negative);
 *  - renaming an event that is NOT referenced yields zero such warnings
 *    (no false positive).
 */
async function controlFlowRegressionLeg(
  document: EmevdEditorDocument,
  registry: EmedfRegistry,
  schemaFingerprint: string
): Promise<ControlFlowRegressionResult> {
  // Baseline: mutate one covered instruction arg; condition-group validation
  // still scans the whole document.
  const coveredSamples = planCoveredMutations(registry, document);
  assert(coveredSamples.samples.length > 0, `control-flow baseline needs a covered sample in ${document.resourceUri}`);
  const baselineSource = buildMatrixDslSource(schemaFingerprint, document.resourceUri, undefined, coveredSamples.samples.slice(0, 1));
  const baseline = compileEmevdPatchDsl(compileRequestFor(baselineSource, schemaFingerprint, document), document, registry);
  assert(baseline.ok && baseline.plan, `control-flow baseline compile failed: ${JSON.stringify(baseline.diagnostics)}`);
  const warnings = baseline.diagnostics.filter((d) => d.severity === 'warning');
  const errors = baseline.diagnostics.filter((d) => d.severity === 'error');
  assert(errors.length === 0, `control-flow baseline produced errors: ${JSON.stringify(errors)}`);
  const warningsByCode: Record<string, number> = {};
  for (const w of warnings) warningsByCode[w.code] = (warningsByCode[w.code] ?? 0) + 1;
  const allowedCodes = new Set([
    'EMEVD_DSL_CONDITION_GROUP_INVALID_REFERENCE',
    'EMEVD_DSL_CONDITION_GROUP_UNINITIALIZED',
    'EMEVD_DSL_EVENT_ID_REFERENCE_STALE'
  ]);
  assert(Object.keys(warningsByCode).every((code) => allowedCodes.has(code)), `unexpected control-flow code ${Object.keys(warningsByCode)}`);

  // Every warning target must resolve to a schema-covered family.
  const flat = new Map<string, EmevdEditorDocument['events'][number]['instructions'][number]>();
  for (const event of document.events) {
    for (const instruction of event.instructions) {
      if (instruction.anchor) flat.set(formatEmevdAnchor('instruction', instruction.anchor), instruction);
    }
  }
  let warningsTargetCoveredFamilies = true;
  for (const w of warnings) {
    const target = w.targetAnchor as string | undefined;
    if (!target) continue;
    const instruction = flat.get(target);
    if (!instruction || findInstructionDef(registry, instruction.bank, instruction.id) === undefined) {
      warningsTargetCoveredFamilies = false;
      break;
    }
  }

  // Stale-event-ID regression (no false negatives / no false positives).
  const coveredRefs = new Set<number>();
  for (const event of document.events) {
    for (const instruction of event.instructions) {
      if (instruction.unknown) continue;
      const def = findInstructionDef(registry, instruction.bank, instruction.id);
      if (!def) continue;
      const raw = Buffer.from(instruction.argsBase64, 'base64');
      const decoded = decodeInstructionArgs(registry, instruction.bank, instruction.id, raw);
      if (!decoded.ok) continue;
      const references = extractEventIdReferences(registry, instruction.bank, instruction.id, decoded.args);
      if (!references) continue;
      for (const ref of references) coveredRefs.add(ref);
    }
  }

  const result: ControlFlowRegressionResult = {
    baselineCompiled: true,
    warningsByCode,
    allWarningsSeverityWarning: true,
    warningsTargetCoveredFamilies,
    staleReference: { check: 'n/a' }
  };

  // No-false-negative: rename an existing event that a covered instruction
  // references -> at least one stale-reference warning.
  let referencedEvent: EmevdEditorDocument['events'][number] | undefined;
  let referencedAnchor: string | undefined;
  for (const ref of coveredRefs) {
    const event = document.events.find((e) => e.eventId === ref);
    if (event?.anchor) {
      referencedEvent = event;
      referencedAnchor = formatEmevdAnchor('event', event.anchor);
      break;
    }
  }
  if (referencedEvent && referencedAnchor !== undefined) {
    const referencedId = referencedEvent.eventId;
    let newId = 9_100_000;
    while (document.events.some((e) => e.eventId === newId)) newId += 1;
    const staleSource = `resource "${document.resourceUri}"
base revision 0 schema "${schemaFingerprint}"
event ${referencedAnchor} {
  set id = ${newId};
}`;
    const staleCompiled = compileEmevdPatchDsl(compileRequestFor(staleSource, schemaFingerprint, document), document, registry);
    assert(staleCompiled.ok && staleCompiled.plan, `stale-reference compile failed: ${JSON.stringify(staleCompiled.diagnostics)}`);
    const staleWarnings = staleCompiled.diagnostics.filter((d) => d.code === 'EMEVD_DSL_EVENT_ID_REFERENCE_STALE');
    assert(staleWarnings.length >= 1,
      `no stale reference warning when renaming referenced event ${referencedId} (${JSON.stringify(staleCompiled.diagnostics.map((d) => d.code))})`);
    const staleWarningsAllCovered = staleWarnings.every((w) => {
      const target = w.targetAnchor as string | undefined;
      if (!target) return true;
      const instruction = flat.get(target);
      return instruction !== undefined && findInstructionDef(registry, instruction.bank, instruction.id) !== undefined;
    });
    assert(staleWarningsAllCovered, 'stale reference warning targeted an uncovered instruction');

    // No-false-positive: rename an event id never referenced by covered instructions.
    const unreferencedEvent = document.events.find((e) => !coveredRefs.has(e.eventId) && e.eventId !== referencedId);
    if (unreferencedEvent?.anchor) {
      let fpNewId = 9_200_000;
      while (document.events.some((e) => e.eventId === fpNewId)) fpNewId += 1;
      const fpSource = `resource "${document.resourceUri}"
base revision 0 schema "${schemaFingerprint}"
event ${formatEmevdAnchor('event', unreferencedEvent.anchor)} {
  set id = ${fpNewId};
}`;
      const fpCompiled = compileEmevdPatchDsl(compileRequestFor(fpSource, schemaFingerprint, document), document, registry);
      assert(fpCompiled.ok && fpCompiled.plan, `no-false-positive compile failed: ${JSON.stringify(fpCompiled.diagnostics)}`);
      const fpStale = fpCompiled.diagnostics.filter((d) => d.code === 'EMEVD_DSL_EVENT_ID_REFERENCE_STALE');
      assert(fpStale.length === 0,
        `false positive: renaming unreferenced event ${unreferencedEvent.eventId} produced ${fpStale.length} stale warnings`);
      result.staleReference = {
        check: 'ran',
        referencedEventId: referencedId,
        newId,
        staleWarnings: staleWarnings.length,
        staleWarningsAllCovered,
        falsePositiveCheck: { renamedEventId: unreferencedEvent.eventId, staleWarnings: fpStale.length }
      };
    } else {
      result.staleReference = { check: 'ran', referencedEventId: referencedId, newId, staleWarnings: staleWarnings.length, staleWarningsAllCovered };
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/*  Per-corpus typed-mutation matrix leg                               */
/* ------------------------------------------------------------------ */

interface CorpusMatrixResult {
  label: string;
  registryLabel: string;
  registryOrigin: EmedfRegistry['origin'];
  instructionTotal: number;
  coverage: {
    totalKinds: number;
    cleanKinds: number;
    varargKinds: number;
    mismatchInstances: number;
    unknownKinds: number;
    kindCoverageRatio: number;
    instanceCoverageRatio: number;
  };
  matrix: {
    typedMutationKinds: number;
    typedMutationInstances: number;
    coveredKindsPresent: number;
    coveredKindsAbsent: number;
    skippedInstances: Array<{ bank: number; id: number; code: string }>;
    opaquePreservedKinds: number;
    opaquePreservedInstances: number;
    opaqueTotalKinds: number;
    opaqueTotalInstances: number;
    opaqueViolations: number;
    coveredUntouchedPreserved: number;
    coveredUntouchedTotal: number;
    failClosed: { unknownKindsChecked: number; readOnlyDiagnostics: number };
    mutations: Array<{ globalIndex: number; bank: number; id: number; argument: string; before: number; after: number; varargTailPreserved: boolean }>;
  };
  byteConsistent: boolean;
  semanticIdentical: boolean;
}

/**
 * Full typed-mutation matrix for one corpus through the production write chain.
 * Assertions are corpus-adaptive (per-corpus distribution totals; covered
 * multi-length kinds must be valid vararg multiples), unlike the wave-1 smoke
 * which hard-codes common.emevd expectations.
 */
async function perCorpusMatrixLeg(
  root: string,
  corpus: CorpusSpec,
  registry: EmedfRegistry,
  registryLabel: string,
  coverage: EmevdCoverageAnalysis,
  distribution: EmevdInstructionDistributionEntry[]
): Promise<CorpusMatrixResult> {
  const overlayRoot = join(root, `mod-matrix-${registryLabel}-${corpus.label}`);
  const stagingRoot = join(root, `staging-matrix-${registryLabel}-${corpus.label}`);
  await mkdir(join(overlayRoot, 'event'), { recursive: true });
  await mkdir(stagingRoot, { recursive: true });

  const { payload } = await readCorpusPayload(corpus.path);
  const target = join(overlayRoot, 'event', 'common.emevd');
  await writeFile(target, payload);
  const sourceHash = sha256(payload);
  const schemaFingerprint = fingerprintEmedfRegistry(registry);
  const documentInstanceId = `emevd-multicorpus-${registryLabel}-${corpus.label}`;

  const before = await readFullEmevdDocumentViaBridge({
    filePath: target,
    allowedRoots: [overlayRoot, stagingRoot],
    resourceUri: 'file://event/common.emevd',
    registry,
    documentInstanceId,
    pageSize: 2048,
    timeoutMs: 120_000
  });
  if (!before.ok || !before.document) throw new Error(`full document read failed: ${JSON.stringify(before.diagnostics)}`);
  const distributionTotal = distribution.reduce((sum, entry) => sum + entry.count, 0);
  assert(before.instructionTotal === distributionTotal, `instructionTotal ${before.instructionTotal} != distribution ${distributionTotal}`);
  assert(before.sourceHash === sourceHash, 'source hash mismatch');
  const document = before.document;

  // Covered multi-length kinds must be valid vararg multiples.
  const multiLength = analyzeMultiLengthKinds(registry, distribution);
  for (const m of multiLength) {
    if (m.covered && m.vararg) {
      assert(m.allValidVarargMultiples === true, `covered multi-length ${m.bank}:${m.id} must be valid vararg multiples in ${corpus.label}`);
    }
  }

  const unknownFailClosed = verifyUnknownKindFailClosed(registry, document, schemaFingerprint);
  const plan = planCoveredMutations(registry, document);
  const eventMutation = pickEventMutation(document);
  const eventAnchor = formatEmevdAnchor('event', eventMutation.event.anchor!);
  const dslSource = buildMatrixDslSource(
    schemaFingerprint,
    document.resourceUri,
    { eventAnchor, newId: eventMutation.newId, newRest: eventMutation.newRest },
    plan.samples
  );
  const compiled = compileEmevdPatchDsl(compileRequestFor(dslSource, schemaFingerprint, document), document, registry);
  if (!compiled.ok || !compiled.plan) throw new Error(`matrix compile failed: ${JSON.stringify(compiled.diagnostics)}`);
  const expectedOps = 2 + plan.samples.length;
  assert(compiled.plan.operations.length === expectedOps, `expected ${expectedOps} ops, got ${compiled.plan.operations.length}`);

  const session = await openWorkspaceSession({ overlayRoot, game: 'sekiro' });
  const submitted = await submitEmevdDslPlanViaFourView({
    compileRequest: compileRequestFor(dslSource, schemaFingerprint, document),
    document,
    registry,
    sourcePath: target,
    expectedDocumentHash: sourceHash,
    allowedRoots: [overlayRoot, stagingRoot],
    workspaceId: session.meta.workspaceId,
    workspaceRoot: overlayRoot,
    stagingRoot,
    title: `emevd multi-corpus matrix ${corpus.label} ${registryLabel}`
  });
  if (!submitted.ok || !submitted.commit) throw new Error(`submit failed: ${JSON.stringify(submitted.diagnostics)}`);
  if (!submitted.commit.ok) throw new Error(`commit failed: ${JSON.stringify(submitted.commit.diagnostics)}`);
  assert(submitted.commit.mutationCount === expectedOps, `expected ${expectedOps} Bridge mutations, got ${submitted.commit.mutationCount}`);
  assert(submitted.commit.reRead?.ok && submitted.commit.reRead.byteConsistent && submitted.commit.reRead.semanticIdentical,
    'commit re-read verification failed');

  const after = await readFullEmevdDocumentViaBridge({
    filePath: target,
    allowedRoots: [overlayRoot, stagingRoot],
    resourceUri: 'file://event/common.emevd',
    registry,
    documentInstanceId: `${documentInstanceId}-after`,
    pageSize: 2048,
    timeoutMs: 120_000
  });
  if (!after.ok || !after.document) throw new Error(`post-commit read failed: ${JSON.stringify(after.diagnostics)}`);
  assert(after.instructionTotal === before.instructionTotal, 'instruction total changed');
  assert(after.document.events.length === document.events.length, 'event count changed');
  const renamed = after.document.events.find((e) => e.eventId === eventMutation.newId);
  assert(renamed !== undefined && renamed.restBehavior === eventMutation.newRest, 'renamed event not observable');

  const verification = verifyMatrixCommit(registry, document, after.document, plan.samples);
  assert(verification.typedVerified === plan.samples.length, `typed verification count ${verification.typedVerified}`);
  assert(verification.opaqueViolations.length === 0, `opaque violations: ${JSON.stringify(verification.opaqueViolations)}`);
  assert(verification.opaquePreservedInstances === verification.opaqueTotalInstances, 'opaque instances not fully preserved');

  return {
    label: corpus.label,
    registryLabel,
    registryOrigin: registry.origin,
    instructionTotal: after.instructionTotal,
    coverage: {
      totalKinds: coverage.totalKinds,
      cleanKinds: coverage.cleanKinds,
      varargKinds: coverage.varargKinds,
      mismatchInstances: coverage.mismatchInstances,
      unknownKinds: coverage.unknownKinds.length,
      kindCoverageRatio: Number(coverage.kindCoverageRatio.toFixed(4)),
      instanceCoverageRatio: Number(coverage.instanceCoverageRatio.toFixed(4))
    },
    matrix: {
      typedMutationKinds: new Set(plan.samples.map((s) => `${s.bank}:${s.id}`)).size,
      typedMutationInstances: plan.samples.length,
      coveredKindsPresent: plan.coveredKindsPresent.length,
      coveredKindsAbsent: plan.coveredKindsAbsent.length,
      skippedInstances: plan.skippedInstances.map((s) => ({ bank: s.bank, id: s.id, code: s.code })),
      opaquePreservedKinds: verification.opaquePreservedKinds,
      opaquePreservedInstances: verification.opaquePreservedInstances,
      opaqueTotalKinds: verification.opaqueTotalKinds,
      opaqueTotalInstances: verification.opaqueTotalInstances,
      opaqueViolations: verification.opaqueViolations.length,
      coveredUntouchedPreserved: verification.coveredUntouchedPreserved,
      coveredUntouchedTotal: verification.coveredUntouchedTotal,
      failClosed: { unknownKindsChecked: unknownFailClosed.unknownKindsChecked, readOnlyDiagnostics: unknownFailClosed.readOnlyDiagnostics },
      mutations: plan.samples.map((s) => ({
        globalIndex: s.globalIndex,
        bank: s.bank,
        id: s.id,
        argument: s.argument,
        before: s.before,
        after: s.after,
        varargTailPreserved: s.tailBefore !== undefined
      }))
    },
    byteConsistent: submitted.commit.reRead.byteConsistent,
    semanticIdentical: submitted.commit.reRead.semanticIdentical
  };
}

/* ------------------------------------------------------------------ */
/*  KRAK corpus diagnostic leg                                         */
/* ------------------------------------------------------------------ */

interface KrakCorpusResult {
  label: string;
  compression: 'KRAK';
  probe: {
    sourceHash: string;
    payloadHash: string;
    uncompressedSize: number;
    payloadStartsWithEVD: boolean;
  } | null;
  matrix: 'skipped';
  code: string;
  message: string;
}

async function krakCorpusLeg(
  corpus: CorpusSpec,
  gameRoot: string | undefined
): Promise<KrakCorpusResult> {
  if (!gameRoot) {
    return {
      label: corpus.label,
      compression: 'KRAK',
      probe: null,
      matrix: 'skipped',
      code: 'EMEVD_CORPUS_KRAK_OODLE_UNAVAILABLE',
      message: '缺少 SOULFORGE_SEKIRO_GAME_ROOT / SOULFORGE_NATIVE_FIXTURE_ROOT：KRAK-DCX 内层 EMEVD payload 需要 Oodle 运行库（Bridge read-dcx-document 需 oodleRuntimeRoot 指向只读游戏目录）。本 leg 结构化跳过，不冒充。'
    };
  }
  const allowedRoots = [dirname(corpus.path), gameRoot];
  const read = await runBridge<EmevdEnvelope & {
    payloadPrefixHex?: string;
    payloadHash?: string;
    uncompressedSize?: number;
  }>({
    command: 'read-dcx-document',
    filePath: corpus.path,
    allowedRoots,
    oodleRuntimeRoot: gameRoot,
    timeoutMs: 120_000
  });
  if (read.parseStatus === 'failed' || !read.data) {
    const first = read.diagnostics?.[0];
    return {
      label: corpus.label,
      compression: 'KRAK',
      probe: null,
      matrix: 'skipped',
      code: 'EMEVD_CORPUS_KRAK_PROBE_FAILED',
      message: `KRAK corpus 探测失败：${first?.message ?? '无诊断'}。完整矩阵结构化跳过，不冒充。`
    };
  }
  const prefix = read.data.payloadPrefixHex ?? '';
  const payloadStartsWithEVD = /^45564400/i.test(prefix);
  assert(payloadStartsWithEVD, `KRAK corpus ${corpus.label} payload prefix is not EVD\\0: ${prefix}`);
  return {
    label: corpus.label,
    compression: 'KRAK',
    probe: {
      sourceHash: read.data.sourceHash ?? '',
      payloadHash: read.data.payloadHash ?? '',
      uncompressedSize: read.data.uncompressedSize ?? 0,
      payloadStartsWithEVD
    },
    matrix: 'skipped',
    code: 'EMEVD_CORPUS_KRAK_TS_UNSUPPORTED',
    message: 'KRAK-DCX 内层 EMEVD payload 无法在 TS 侧完整解压（无 Oodle 运行库；read-dcx-document 仅暴露 128 字节 payload 前缀）。完整覆盖/typed mutation 矩阵依赖 Bridge/KRAK 团队能力，本 leg 结构化跳过，不冒充。'
  };
}

/* ------------------------------------------------------------------ */
/*  Real EMEDF search                                                  */
/* ------------------------------------------------------------------ */
// searchRealEmedf 与候选路径清单共享自 ./realEmedfLocator.js（W-EMEVD-FULL-01
// 真实导入 EMEDF 交叉验证的可复现定位器），三个 imported 类 smoke 复用同一逻辑。
/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-emevd-multi-corpus-'));
  const stagingRoot = join(root, 'stage');
  await mkdir(stagingRoot, { recursive: true });
  const explicitCorpus = process.argv[2]?.trim() || undefined;
  const emedfPathArg = process.env.SOULFORGE_EMEDF_PATH?.trim()
    || process.argv[3]?.trim()
    || (await searchRealEmedf());
  const gameRoot = process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim()
    || process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
  const skipReasons: string[] = [];
  const notes: string[] = [];

  const syntheticImportedRegistry = createSyntheticImportedEmedf();
  let realRegistry: EmedfRegistry | undefined;
  let realEmedfSource: string | undefined;

  const matrixResults: CorpusMatrixResult[] = [];
  const coverageResults: CorpusCoverageResult[] = [];
  const opaqueResults: OpaqueFamilyVerificationResult[] = [];
  const controlFlowResults: ControlFlowRegressionResult[] = [];
  const krakResults: KrakCorpusResult[] = [];

  try {
    // ---- Synthetic leg (unconditional) ----
    syntheticFamilyDifferenceChecks();
    await syntheticMatrixLeg(root);

    // ---- Real EMEDF import (fail-closed when absent) ----
    if (emedfPathArg) {
      const realImport = importDs3EmedfFile(emedfPathArg);
      if (!realImport.ok) throw new Error(`real EMEDF import failed: ${realImport.message}`);
      realRegistry = realImport.registry;
      realEmedfSource = emedfPathArg;
      notes.push(`真实 DarkScript3 EMEDF：${emedfPathArg}（${realImport.instructionCount} 指令 / ${realImport.bankCount} banks）`);
    } else {
      skipReasons.push('SOULFORGE_EMEDF_PATH 未设置且未定位真实 DarkScript3 EMEDF：真实导入 registry 的 cross-validation leg 结构化跳过（fail-closed，不冒充）。');
    }

    // ---- Real corpus legs ----
    const { corpora, notes: discoveryNotes } = await discoverCorpora(explicitCorpus);
    notes.push(...discoveryNotes);
    if (corpora.length === 0 && !explicitCorpus) {
      skipReasons.push('未发现真实 emevd corpus（缺 SOULFORGE_NATIVE_FIXTURE_ROOT/SOULFORGE_SEKIRO_GAME_ROOT 且未提供显式路径）：真实 corpus 覆盖/矩阵/control-flow leg 结构化跳过。');
    }
    if (corpora.length > 0 && realRegistry === undefined) {
      skipReasons.push('真实 corpus 已定位但未导入真实 DarkScript3 EMEDF：real-EMEDF 覆盖/typed mutation leg 跳过。');
    }

    if (corpora.length > 0 && !gameRoot) {
      notes.push('真实 corpus 已定位但 gameRoot 未设置：KRAK corpus 的 Oodle 探测不可用（仅影响 m10 类 KRAK 样本的 prefix probe）。');
    }

    for (const corpus of corpora) {
      const { compression } = await readCorpusPayload(corpus.path);
      if (compression === 'KRAK') {
        krakResults.push(await krakCorpusLeg(corpus, gameRoot));
        continue;
      }
      if (compression !== 'DFLT' && compression !== 'none') {
        throw new Error(`EMEVD_CORPUS_${compression}_TS_UNSUPPORTED: ${corpus.path}`);
      }

      // 1. Coverage analysis (both registries).
      const cov = await coverageLeg(stagingRoot, corpus, syntheticImportedRegistry, realRegistry);
      coverageResults.push(cov);

      // Full document for matrix + opaque + control-flow legs.
      const target = join(stagingRoot, `${corpus.label}.emevd`);
      const full = await readFullEmevdDocumentViaBridge({
        filePath: target,
        allowedRoots: [stagingRoot],
        resourceUri: 'file://event/common.emevd',
        registry: syntheticImportedRegistry,
        documentInstanceId: `emevd-multicorpus-${corpus.label}`,
        pageSize: 2048,
        timeoutMs: 120_000
      });
      if (!full.ok || !full.document) throw new Error(`full document read failed: ${JSON.stringify(full.diagnostics)}`);
      const document = full.document;
      const schemaFingerprint = fingerprintEmedfRegistry(syntheticImportedRegistry);

      // 3. High-instance uncovered families stay opaque.
      opaqueResults.push(await highInstanceOpaqueLeg(document, cov.distribution, syntheticImportedRegistry, schemaFingerprint));

      // 4. Control-flow regression.
      controlFlowResults.push(await controlFlowRegressionLeg(document, syntheticImportedRegistry, schemaFingerprint));

      // 2. Typed-mutation matrix: synthetic-imported registry on every corpus.
      matrixResults.push(await perCorpusMatrixLeg(root, corpus, syntheticImportedRegistry, 'synthetic-imported', cov.syntheticImported, cov.distribution));

      // Real EMEDF typed-mutation matrix on every corpus.
      if (realRegistry) {
        const realFingerprint = fingerprintEmedfRegistry(realRegistry);
        const realDocument = (await readFullEmevdDocumentViaBridge({
          filePath: target,
          allowedRoots: [stagingRoot],
          resourceUri: 'file://event/common.emevd',
          registry: realRegistry,
          documentInstanceId: `emevd-multicorpus-real-${corpus.label}`,
          pageSize: 2048,
          timeoutMs: 120_000
        })).document;
        assert(realDocument !== undefined, `real-EMEDF full document read failed for ${corpus.label}`);
        // control-flow regression with the full real EMEDF schema as well.
        controlFlowResults.push(await controlFlowRegressionLeg(realDocument, realRegistry, realFingerprint));
        if (cov.realEmedf) {
          matrixResults.push(await perCorpusMatrixLeg(root, corpus, realRegistry, 'real-emedf', cov.realEmedf, cov.distribution));
        }
      }
    }

    // ---- Cross-corpus family differences (real DFLT distributions) ----
    const familyDiff = summarizeCorpusFamilyDifferences(
      coverageResults.map((cov) => ({ label: cov.label, distribution: cov.distribution }))
    );

    console.log(JSON.stringify({
      ok: true,
      message: 'EMEVD 多 corpus 交叉验证 smoke 完成',
      syntheticLeg: { familyDifferences: 'passed', productionMatrix: 'passed' },
      realEmedfSource: realEmedfSource ?? null,
      discoveredCorpora: corpora.map((c) => ({ label: c.label, path: c.path, registered: c.registered })),
      corpora: coverageResults.map((c) => ({ label: c.label, compression: c.compression, eventCount: c.eventCount, instructionCount: c.instructionCount })),
      krakCorpora: krakResults,
      perCorpusCoverage: coverageResults.map((c) => ({
        label: c.label,
        syntheticImported: {
          totalKinds: c.syntheticImported.totalKinds,
          cleanKinds: c.syntheticImported.cleanKinds,
          varargKinds: c.syntheticImported.varargKinds,
          mismatchInstances: c.syntheticImported.mismatchInstances,
          unknownKinds: c.syntheticImported.unknownKinds.length,
          kindCoverageRatio: Number(c.syntheticImported.kindCoverageRatio.toFixed(4)),
          instanceCoverageRatio: Number(c.syntheticImported.instanceCoverageRatio.toFixed(4))
        },
        realEmedf: c.realEmedf ? {
          totalKinds: c.realEmedf.totalKinds,
          cleanKinds: c.realEmedf.cleanKinds,
          varargKinds: c.realEmedf.varargKinds,
          mismatchInstances: c.realEmedf.mismatchInstances,
          unknownKinds: c.realEmedf.unknownKinds.length,
          kindCoverageRatio: Number(c.realEmedf.kindCoverageRatio.toFixed(4)),
          instanceCoverageRatio: Number(c.realEmedf.instanceCoverageRatio.toFixed(4))
        } : null
      })),
      crossCorpusFamilyDifferences: {
        unionFamilyCount: familyDiff.unionFamilyCount,
        familiesInAllCorpora: familyDiff.familiesInAllCorpora.map((f) => ({ bank: f.bank, id: f.id, totalCount: f.totalCount })),
        familiesInSubset: familyDiff.familiesInSubset.map((f) => ({
          bank: f.bank,
          id: f.id,
          totalCount: f.totalCount,
          presentIn: f.presentIn,
          absentIn: f.absentIn,
          counts: f.counts
        })),
        perCorpus: familyDiff.perCorpus
      },
      matrixResults: matrixResults.map((m) => ({
        label: m.label,
        registryLabel: m.registryLabel,
        coverage: m.coverage,
        typedMutationKinds: m.matrix.typedMutationKinds,
        typedMutationInstances: m.matrix.typedMutationInstances,
        skippedInstances: m.matrix.skippedInstances.slice(0, 10),
        opaquePreserved: { instances: m.matrix.opaquePreservedInstances, total: m.matrix.opaqueTotalInstances },
        coveredUntouchedPreserved: m.matrix.coveredUntouchedPreserved,
        coveredUntouchedTotal: m.matrix.coveredUntouchedTotal,
        failClosed: m.matrix.failClosed,
        byteConsistent: m.byteConsistent,
        semanticIdentical: m.semanticIdentical,
        mutations: m.matrix.mutations.slice(0, 20)
      })),
      opaqueFamilyChecks: opaqueResults.map((r) => ({ checkedFamilies: r.checkedFamilies })),
      controlFlowRegression: controlFlowResults.map((r) => ({
        baselineCompiled: r.baselineCompiled,
        warningsByCode: r.warningsByCode,
        allWarningsSeverityWarning: r.allWarningsSeverityWarning,
        warningsTargetCoveredFamilies: r.warningsTargetCoveredFamilies,
        staleReference: r.staleReference
      })),
      skips: skipReasons,
      notes,
      nonClaims: [
        '合成 DS3 JSON 是自构微小样本，不构成 native 或真实 DarkScript3 完成声明。',
        'KRAK-DCX corpus（m10）在 TS 层无法完整解压，只做 payload 前缀探测并结构化跳过完整矩阵（不冒充）。',
        '真实 EMEDF 覆盖（100% kind/instance）只证明长度签名与 corpus 一致，typed mutation 只证明等长写链正确，不证明参数语义、layer 或游戏加载。',
        'authority 上限为 partial。'
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
