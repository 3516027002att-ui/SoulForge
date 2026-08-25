/**
 * EMEVD full-corpus typed-mutation matrix smoke.
 *
 * Uses the imported EMEDF registry (synthetic DarkScript3 format via
 * createSyntheticImportedEmedf) to run a systematic typed-mutation matrix
 * against the registered native common.emevd corpus:
 *
 *  1. Every schema-covered kind present in the corpus is sampled (1-2
 *     instances) for a typed arg / eventId mutation, committed through the
 *     production write chain (DSL compile -> typed plan -> Bridge batch
 *     staging -> file_replace PatchIR -> WorkspaceTransaction -> Bridge
 *     re-read) and independently re-read to confirm the mutation is observable
 *     at the same global instruction index.
 *  2. Every kind NOT covered by the schema stays opaque: its payload is never
 *     decoded, never re-encoded and never given a fabricated arg layout.
 *     A commit that touches only covered kinds + a representative event must
 *     leave every opaque instruction byte-for-byte identical, verified across
 *     the full document before/after.
 *  3. Opaque instructions fail closed under the DSL compiler
 *     (EMEVD_DSL_UNKNOWN_INSTRUCTION_READONLY, zero plan operations) and under
 *     decode (EMEDF_UNKNOWN_INSTRUCTION), so arg types are never invented for
 *     unschematized kinds.
 *  4. 2000:0 multi-length variants (12/16/20/24/32 observed) are distinguished
 *     by vararg length signature and never conflated; invalid lengths
 *     (e.g. 10) and below-base lengths fail decode structurally
 *     (EMEDF_ARGS_LENGTH_MISMATCH) instead of being prefix-decoded.
 *
 * The synthetic leg (deterministic) always runs and goes through the full
 * production chain; the real-corpus leg runs when a registered native fixture
 * is injected; the real-EMEDF leg runs when SOULFORGE_EMEDF_PATH is provided
 * (otherwise fail-closed skip).
 *
 * The generic sampling / fail-closed / verification helpers live in
 * emevdCorpusMatrix.ts and are shared with runEmevdMultiCorpusMatrixSmoke.
 *
 * DarkScript3 EMEDF data is All Rights Reserved and never bundled; the
 * synthetic DS3 JSON is our own tiny sample (syntheticEmevdBytes).
 *
 * Authority cap: partial — proves the imported-registry -> production write
 * matrix on the registered native sample; no full EMEDF/layer/game-load claims.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EmevdEditorDocument } from '@soulforge/shared';
import {
  createEmevdEditorDocument,
  submitEmevdDslPlanViaFourView
} from '../editing/emevdFourViewController.js';
import { readFullEmevdDocumentViaBridge } from '../editing/emevdFullDocument.js';
import { compileEmevdPatchDsl, fingerprintEmedfRegistry } from '../emevd/dslCompiler.js';
import { decodeInstructionArgs, type EmedfRegistry } from '../emevd/emedfSchema.js';
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
  verifySyntheticSamples,
  verifyUnknownKindFailClosed,
  verifyVarargLengthSignature,
  type EmevdEnvelope,
  type EventMutationSpec,
  type MatrixSample,
  type MultiLengthKindInfo
} from '../emevd/emevdCorpusMatrix.js';
import { importDs3EmedfFile } from '../emevd/emedfExternalAdapter.js';
// searchRealEmedf 与候选路径清单共享自 realEmedfLocator，与另三条 emevd smoke
// 同源。此前本文件**只读 env 与 argv、不调定位器**，于是同一台机器上另三条能
// 跑到真实 EMEDF leg、唯独这条恒跳过——两道判据之间的盲区，各自都有理由不管。
import { searchRealEmedf } from './realEmedfLocator.js';
import {
  analyzeEmedfCoverage,
  type EmevdInstructionDistributionEntry
} from '../emevd/emedfCoverage.js';
import { formatEmevdAnchor } from '../emevd/stableIdentity.js';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { decompressDfltDcx } from '../util/dcxDflt.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';
import {
  buildSyntheticEmevd,
  createSyntheticImportedEmedf,
  sha256Hex
} from './syntheticEmevdBytes.js';

interface RealCorpusMatrixResult {
  label: string;
  registryOrigin: EmedfRegistry['origin'];
  coverage: {
    totalKinds: number;
    totalInstances: number;
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
    eventIdMutation: { oldId: number; newId: number; rest: number };
    coveredKindsPresent: Array<{ bank: number; id: number; count: number; mutableArgCount: number }>;
    coveredKindsAbsent: Array<{ bank: number; id: number }>;
    skippedInstances: Array<{ bank: number; id: number; globalIndex: number; code: string; message: string }>;
    opaquePreservedKinds: number;
    opaquePreservedInstances: number;
    opaqueTotalKinds: number;
    opaqueTotalInstances: number;
    opaqueViolations: string[];
    coveredUntouchedPreserved: number;
    coveredUntouchedTotal: number;
    multiLengthKinds: MultiLengthKindInfo[];
    failClosed: { unknownKindsChecked: number; readOnlyDiagnostics: number; decodeFailCodes: string[] };
    /** Kinds without schema coverage: bank:id + instance count (engineering trail for future EMEDF coverage). */
    uncoveredKinds: Array<{ bank: number; id: number; count: number }>;
    /** Per-sample typed mutations applied and verified (global index + arg + before/after + vararg tail). */
    mutations: Array<{
      globalIndex: number;
      bank: number;
      id: number;
      argument: string;
      before: number;
      after: number;
      varargTailPreserved: boolean;
    }>;
  };
  byteConsistent: boolean;
  semanticIdentical: boolean;
  instructionTotal: number;
}

function hashOf(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/* ------------------------------------------------------------------ */
/*  Synthetic leg                                                      */
/* ------------------------------------------------------------------ */

/**
 * Synthetic EMEVD with 9 instructions: 2x 0:0, five 2000:0 at every observed
 * real-corpus vararg length (12/16/20/24/32), and 2 opaque unknown kinds
 * (one non-empty payload, one empty) so opaque preservation is exercised on
 * both shapes.
 */
function buildMatrixSyntheticEmevd(): Buffer {
  return buildSyntheticEmevd([
    {
      id: 50,
      restBehavior: 0,
      instructions: [
        // 0:0 IfConditionGroup: resultConditionGroup=1, desiredConditionGroupState=0, targetConditionGroup=2
        { bank: 0, id: 0, args: Buffer.from([0x01, 0x00, 0x02, 0x00]) },
        // 0:0 IfConditionGroup: resultConditionGroup=3, desiredConditionGroupState=1, targetConditionGroup=4
        { bank: 0, id: 0, args: Buffer.from([0x03, 0x01, 0x04, 0x00]) },
        // 2000:0 InitializeEvent vararg lengths: 12 / 16 / 20 / 24 / 32 (1/2/3/4/6 params)
        { bank: 2000, id: 0, args: Buffer.from([0x0a, 0, 0, 0, 0x64, 0, 0, 0, 0x07, 0, 0, 0]) },
        { bank: 2000, id: 0, args: Buffer.from([0x0b, 0, 0, 0, 0x65, 0, 0, 0, 8, 0, 0, 0, 9, 0, 0, 0]) },
        { bank: 2000, id: 0, args: Buffer.from([0x0c, 0, 0, 0, 0x66, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0]) },
        { bank: 2000, id: 0, args: Buffer.from([0x0d, 0, 0, 0, 0x67, 0, 0, 0, 4, 0, 0, 0, 5, 0, 0, 0, 6, 0, 0, 0, 7, 0, 0, 0]) },
        { bank: 2000, id: 0, args: Buffer.from([0x0e, 0, 0, 0, 0x68, 0, 0, 0, 10, 0, 0, 0, 11, 0, 0, 0, 12, 0, 0, 0, 13, 0, 0, 0, 14, 0, 0, 0, 15, 0, 0, 0]) },
        // opaque: non-empty payload
        { bank: 9999, id: 1, args: Buffer.alloc(8, 0xaa) },
        // opaque: empty payload
        { bank: 7000, id: 5, args: Buffer.alloc(0) }
      ]
    },
    { id: 100, restBehavior: 0, instructions: [] }
  ]);
}

function createMatrixSyntheticDocument(): EmevdEditorDocument {
  return createEmevdEditorDocument({
    resourceUri: 'file://event/common.emevd',
    documentInstanceId: 'emevd-matrix-synthetic',
    events: [
      {
        eventId: 50,
        restBehavior: 0,
        instructions: [
          { bank: 0, id: 0, argsBase64: Buffer.from([0x01, 0x00, 0x02, 0x00]).toString('base64'), unknown: false },
          { bank: 0, id: 0, argsBase64: Buffer.from([0x03, 0x01, 0x04, 0x00]).toString('base64'), unknown: false },
          { bank: 2000, id: 0, argsBase64: Buffer.from([0x0a, 0, 0, 0, 0x64, 0, 0, 0, 0x07, 0, 0, 0]).toString('base64'), unknown: false },
          { bank: 2000, id: 0, argsBase64: Buffer.from([0x0b, 0, 0, 0, 0x65, 0, 0, 0, 8, 0, 0, 0, 9, 0, 0, 0]).toString('base64'), unknown: false },
          { bank: 2000, id: 0, argsBase64: Buffer.from([0x0c, 0, 0, 0, 0x66, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0]).toString('base64'), unknown: false },
          { bank: 2000, id: 0, argsBase64: Buffer.from([0x0d, 0, 0, 0, 0x67, 0, 0, 0, 4, 0, 0, 0, 5, 0, 0, 0, 6, 0, 0, 0, 7, 0, 0, 0]).toString('base64'), unknown: false },
          { bank: 2000, id: 0, argsBase64: Buffer.from([0x0e, 0, 0, 0, 0x68, 0, 0, 0, 10, 0, 0, 0, 11, 0, 0, 0, 12, 0, 0, 0, 13, 0, 0, 0, 14, 0, 0, 0, 15, 0, 0, 0]).toString('base64'), unknown: false },
          { bank: 9999, id: 1, argsBase64: Buffer.alloc(8, 0xaa).toString('base64'), unknown: true },
          { bank: 7000, id: 5, argsBase64: '', unknown: true }
        ]
      },
      { eventId: 100, restBehavior: 0, instructions: [] }
    ]
  });
}

/** Explicit samples covering all five 2000:0 vararg lengths plus both 0:0 instances. */
function buildSyntheticSamples(document: EmevdEditorDocument): MatrixSample[] {
  const event = document.events[0]!;
  const b64 = (index: number): string => event.instructions[index]!.argsBase64;
  const anchor = (index: number): string =>
    formatEmevdAnchor('instruction', event.instructions[index]!.anchor!);
  return [
    {
      globalIndex: 0,
      instructionAnchor: anchor(0),
      bank: 0,
      id: 0,
      argument: 'resultConditionGroup',
      before: 1,
      after: 2,
      argsBase64Before: b64(0)
    },
    {
      globalIndex: 1,
      instructionAnchor: anchor(1),
      bank: 0,
      id: 0,
      argument: 'desiredConditionGroupState',
      before: 1,
      after: 2,
      argsBase64Before: b64(1)
    },
    {
      globalIndex: 2,
      instructionAnchor: anchor(2),
      bank: 2000,
      id: 0,
      argument: 'eventId',
      before: 100,
      after: 101,
      argsBase64Before: b64(2),
      tailBefore: Buffer.from([0x07, 0, 0, 0])
    },
    {
      globalIndex: 3,
      instructionAnchor: anchor(3),
      bank: 2000,
      id: 0,
      argument: 'eventSlotId',
      before: 11,
      after: 12,
      argsBase64Before: b64(3),
      tailBefore: Buffer.from([8, 0, 0, 0, 9, 0, 0, 0])
    },
    {
      globalIndex: 6,
      instructionAnchor: anchor(6),
      bank: 2000,
      id: 0,
      argument: 'eventId',
      before: 104,
      after: 105,
      argsBase64Before: b64(6),
      tailBefore: Buffer.from([10, 0, 0, 0, 11, 0, 0, 0, 12, 0, 0, 0, 13, 0, 0, 0, 14, 0, 0, 0, 15, 0, 0, 0])
    }
  ];
}

async function syntheticMatrixLeg(root: string): Promise<void> {
  const registry = createSyntheticImportedEmedf();
  const schemaFingerprint = fingerprintEmedfRegistry(registry);
  const original = buildMatrixSyntheticEmevd();

  const overlayRoot = join(root, 'mod-matrix-synthetic');
  const stagingRoot = join(root, 'staging-matrix-synthetic');
  const backupRoot = join(root, 'backups-matrix-synthetic');
  await mkdir(join(overlayRoot, 'event'), { recursive: true });
  await mkdir(stagingRoot, { recursive: true });
  await mkdir(backupRoot, { recursive: true });
  const target = join(overlayRoot, 'event', 'common.emevd');
  await writeFile(target, original);
  const sourceHash = sha256Hex(original);

  const document = createMatrixSyntheticDocument();
  const resourceUri = document.resourceUri;
  const event0 = document.events[0]!;

  // 1. Multi-length vararg signature distinction (decode level, no Bridge).
  const varargSignature = verifyVarargLengthSignature(registry);

  // 2. Fail-closed negative checks (compile + decode level).
  const unknownWrite = compileEmevdPatchDsl(
    compileRequestFor(
      singleInstructionDsl(schemaFingerprint, resourceUri, formatEmevdAnchor('instruction', event0.instructions[7]!.anchor!), 'unknownArg', 1),
      schemaFingerprint,
      document
    ),
    document,
    registry
  );
  assert(unknownWrite.ok === false, 'unknown write must fail closed');
  assert(!('plan' in unknownWrite), 'unknown write must not produce a plan');
  assert(unknownWrite.diagnostics.some((d) => d.code === 'EMEVD_DSL_UNKNOWN_INSTRUCTION_READONLY'), 'unknown write read-only diagnostic');

  const varargTailWrite = compileEmevdPatchDsl(
    compileRequestFor(
      singleInstructionDsl(schemaFingerprint, resourceUri, formatEmevdAnchor('instruction', event0.instructions[2]!.anchor!), 'parameters', 99),
      schemaFingerprint,
      document
    ),
    document,
    registry
  );
  assert(varargTailWrite.ok === false, 'vararg tail write must fail closed');
  assert(varargTailWrite.diagnostics.some((d) => d.code === 'EMEVD_DSL_VARARG_ARG_READONLY'), 'vararg tail read-only diagnostic');

  const unknownArgWrite = compileEmevdPatchDsl(
    compileRequestFor(
      singleInstructionDsl(schemaFingerprint, resourceUri, formatEmevdAnchor('instruction', event0.instructions[0]!.anchor!), 'nonexistent', 1),
      schemaFingerprint,
      document
    ),
    document,
    registry
  );
  assert(unknownArgWrite.ok === false, 'unknown arg write must fail closed');
  assert(unknownArgWrite.diagnostics.some((d) => d.code === 'EMEVD_DSL_UNKNOWN_ARGUMENT'), 'unknown arg diagnostic');

  const unknownDecode = decodeInstructionArgs(registry, 9999, 1, Buffer.alloc(8, 0xaa));
  assert(!unknownDecode.ok && unknownDecode.code === 'EMEDF_UNKNOWN_INSTRUCTION', 'unknown decode must fail closed');

  // 3. Build the matrix DSL patch (5 typed arg mutations + event id/rest).
  const samples = buildSyntheticSamples(document);
  const eventMutation: EventMutationSpec = {
    eventAnchor: formatEmevdAnchor('event', event0.anchor!),
    newId: 51,
    newRest: 1
  };
  const dslSource = buildMatrixDslSource(schemaFingerprint, resourceUri, eventMutation, samples);
  const compiled = compileEmevdPatchDsl(compileRequestFor(dslSource, schemaFingerprint, document), document, registry);
  if (!compiled.ok || !compiled.plan) {
    throw new Error(`matrix compile failed: ${JSON.stringify(compiled.diagnostics)}`);
  }
  const expectedOps = 2 + samples.length; // event id + event rest + instruction args
  assert(compiled.plan.operations.length === expectedOps, `expected ${expectedOps} plan operations, got ${compiled.plan.operations.length}`);
  const eventIdOp = compiled.plan.operations.find((op) => op.kind === 'set_instruction_arg' && op.argument === 'eventId');
  if (!eventIdOp || eventIdOp.kind !== 'set_instruction_arg' || eventIdOp.after !== 101) {
    throw new Error(`synthetic eventId typed mutation missing: ${JSON.stringify(compiled.plan.operations)}`);
  }

  // Bridge cross-check before commit.
  const before = await runBridge<EmevdEnvelope>({
    command: 'read-emevd-document',
    filePath: target,
    allowedRoots: [overlayRoot, stagingRoot],
    timeoutMs: 120_000
  });
  if (before.parseStatus === 'failed' || !before.data?.roundTrip?.semanticIdentical) {
    throw new Error(`matrix synthetic EMEVD rejected by Bridge: ${JSON.stringify(before.diagnostics)}`);
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
    backupBaseDir: backupRoot,
    session,
    title: 'emevd corpus matrix synthetic'
  });
  if (!submitted.ok || !submitted.commit) throw new Error(`submit failed: ${JSON.stringify(submitted.diagnostics)}`);
  const commit = submitted.commit;
  assert(commit.ok, 'commit failed');
  assert(commit.mutationCount === expectedOps, `expected ${expectedOps} Bridge mutations, got ${commit.mutationCount}`);
  assert(commit.reRead?.ok, 're-read failed');
  assert(commit.reRead.byteConsistent, 'committed bytes not byte-consistent');
  assert(commit.reRead.semanticIdentical, 'semantic roundtrip failed');

  const committedBytes = await readFile(target);
  assert(hashOf(committedBytes) === commit.outputHash, 'committed file hash does not match staged output hash');

  // 4. Independent re-read.
  const after = await runBridge<EmevdEnvelope>({
    command: 'read-emevd-document',
    filePath: target,
    allowedRoots: [overlayRoot, stagingRoot],
    timeoutMs: 120_000
  });
  if (after.parseStatus === 'failed' || !after.data) throw new Error('post-commit read failed');
  assert(after.data.eventCount === 2, `event count ${after.data.eventCount}`);
  assert(after.data.instructionCount === 9, `instruction count ${after.data.instructionCount}`);
  const renamed = after.data.events?.find((e) => e.id === 51);
  assert(renamed !== undefined && renamed.restBehavior === 1, 'renamed event/rest not observable');
  if (after.data.events?.some((e) => e.id === 50)) throw new Error('old event id still present');

  verifySyntheticSamples(registry, after.data.instructionsSample ?? [], samples);
  const sampleByIndex = new Map((after.data.instructionsSample ?? []).map((e) => [e.index, e]));
  // Opaque kinds preserved byte-for-byte.
  const opaque7 = sampleByIndex.get(7);
  const opaque8 = sampleByIndex.get(8);
  assert(opaque7 !== undefined && opaque7.bank === 9999 && argsBytesEqual(opaque7.argsBase64, event0.instructions[7]!.argsBase64), 'opaque 9999:1 not preserved');
  assert(opaque8 !== undefined && opaque8.bank === 7000 && argsBytesEqual(opaque8.argsBase64, event0.instructions[8]!.argsBase64), 'opaque 7000:5 not preserved');
  // Covered-but-untouched 2000:0 @20/@24 (indices 4, 5) preserved.
  for (const idx of [4, 5]) {
    const entry = sampleByIndex.get(idx);
    assert(entry !== undefined && argsBytesEqual(entry.argsBase64, event0.instructions[idx]!.argsBase64), `covered untouched index ${idx} not preserved`);
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'EMEVD 全 corpus matrix 合成 leg 通过',
    planOperations: expectedOps,
    typedMutations: samples.map((s) => ({
      globalIndex: s.globalIndex,
      bank: s.bank,
      id: s.id,
      argument: s.argument,
      before: s.before,
      after: s.after,
      varargTailPreserved: s.tailBefore !== undefined
    })),
    varargLengthSignature: varargSignature,
    failClosed: {
      unknownWriteRejected: 'EMEVD_DSL_UNKNOWN_INSTRUCTION_READONLY',
      varargTailWriteRejected: 'EMEVD_DSL_VARARG_ARG_READONLY',
      unknownArgWriteRejected: 'EMEVD_DSL_UNKNOWN_ARGUMENT',
      unknownDecodeRejected: 'EMEDF_UNKNOWN_INSTRUCTION'
    },
    opaquePreserved: { '9999:1': true, '7000:5': true },
    coveredUntouchedPreserved: true,
    byteConsistent: commit.reRead.byteConsistent,
    semanticIdentical: commit.reRead.semanticIdentical
  }, null, 2));
}

/* ------------------------------------------------------------------ */
/*  Real corpus leg                                                    */
/* ------------------------------------------------------------------ */

async function realCorpusMatrixLeg(
  root: string,
  sourceDcx: string,
  registry: EmedfRegistry,
  label: string
): Promise<RealCorpusMatrixResult> {
  const overlayRoot = join(root, `mod-matrix-${label}`);
  const stagingRoot = join(root, `staging-matrix-${label}`);
  await mkdir(join(overlayRoot, 'event'), { recursive: true });
  await mkdir(stagingRoot, { recursive: true });

  const dcxBytes = await readFile(sourceDcx);
  const payload = decompressDfltDcx(dcxBytes);
  const target = join(overlayRoot, 'event', 'common.emevd');
  await writeFile(target, payload);
  const sourceHash = hashOf(payload);
  const schemaFingerprint = fingerprintEmedfRegistry(registry);
  const documentInstanceId = `emevd-matrix-${label}`;

  const before = await readFullEmevdDocumentViaBridge({
    filePath: target,
    allowedRoots: [overlayRoot, stagingRoot],
    resourceUri: 'file://event/common.emevd',
    registry,
    documentInstanceId,
    attachIdentity: true,
    pageSize: 2048,
    timeoutMs: 120_000
  });
  if (!before.ok || !before.document) {
    throw new Error(`full document read failed: ${JSON.stringify(before.diagnostics)}`);
  }
  assert(before.instructionTotal > 0, `unexpected instruction total ${before.instructionTotal}`);
  assert(before.sourceHash === sourceHash, `source hash mismatch ${before.sourceHash} vs ${sourceHash}`);
  const document = before.document;

  // Aggregate distribution + coverage analysis for the matrix report.
  const distRead = await runBridge<EmevdEnvelope>({
    command: 'read-emevd-document',
    filePath: target,
    allowedRoots: [overlayRoot, stagingRoot],
    timeoutMs: 60_000
  });
  const distribution = distRead.data?.instructionDistribution ?? [];
  assert(Array.isArray(distribution) && distribution.length > 0, 'instructionDistribution missing or empty');
  const coverage = analyzeEmedfCoverage(registry, distribution, distRead.data?.instructionDistributionTruncated ?? false);
  assert(coverage.totalInstances === distRead.data?.instructionCount,
    `analysis instance total ${coverage.totalInstances} != envelope ${distRead.data?.instructionCount}`);

  // Multi-length kinds: covered vararg variants valid by signature; unknown
  // multi-length kinds stay opaque + fail closed (verified below).
  const multiLength = analyzeMultiLengthKinds(registry, distribution);

  // Fail-closed for every unknown kind (decode + DSL write).
  const unknownFailClosed = verifyUnknownKindFailClosed(registry, document, schemaFingerprint);

  // Plan the covered mutation samples.
  const plan = planCoveredMutations(registry, document);

  // Event-level mutation on a representative event.
  const eventMutation = pickEventMutation(document);
  const eventAnchor = formatEmevdAnchor('event', eventMutation.event.anchor!);

  // Combined DSL patch: event id/rest + covered samples.
  const dslSource = buildMatrixDslSource(schemaFingerprint, document.resourceUri, { eventAnchor, newId: eventMutation.newId, newRest: eventMutation.newRest }, plan.samples);
  const compiled = compileEmevdPatchDsl(compileRequestFor(dslSource, schemaFingerprint, document), document, registry);
  if (!compiled.ok || !compiled.plan) {
    throw new Error(`matrix compile failed: ${JSON.stringify(compiled.diagnostics)}`);
  }
  const expectedOps = 2 + plan.samples.length;
  assert(compiled.plan.operations.length === expectedOps, `expected ${expectedOps} plan ops, got ${compiled.plan.operations.length}`);
  if (label === 'synthetic-imported') {
    assert(plan.samples.length > 0, 'synthetic-imported registry must cover instances in the corpus');
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
    title: `emevd corpus matrix ${label}`
  });
  if (!submitted.ok || !submitted.commit) throw new Error(`submit failed: ${JSON.stringify(submitted.diagnostics)}`);
  if (!submitted.commit.ok) throw new Error(`commit failed: ${JSON.stringify(submitted.commit.diagnostics)}`);
  assert(submitted.commit.mutationCount === expectedOps, `expected ${expectedOps} Bridge mutations, got ${submitted.commit.mutationCount}`);
  assert(submitted.commit.reRead?.ok, 'commit re-read failed');
  assert(submitted.commit.reRead.byteConsistent, 'committed bytes not byte-consistent');
  assert(submitted.commit.reRead.semanticIdentical, 'semantic roundtrip failed');

  // Independent full re-read of the committed file.
  const after = await readFullEmevdDocumentViaBridge({
    filePath: target,
    allowedRoots: [overlayRoot, stagingRoot],
    resourceUri: 'file://event/common.emevd',
    registry,
    documentInstanceId: `${documentInstanceId}-after`,
    attachIdentity: true,
    pageSize: 2048,
    timeoutMs: 120_000
  });
  if (!after.ok || !after.document) throw new Error(`post-commit read failed: ${JSON.stringify(after.diagnostics)}`);
  assert(after.instructionTotal === before.instructionTotal, 'instruction total changed');
  assert(after.document.events.length === document.events.length, 'event count changed');

  const renamed = after.document.events.find((e) => e.eventId === eventMutation.newId);
  assert(renamed !== undefined, 'renamed event missing after commit');
  assert(renamed.restBehavior === eventMutation.newRest, 'rest behavior not observable');

  const verification = verifyMatrixCommit(registry, document, after.document, plan.samples);
  assert(verification.typedVerified === plan.samples.length, `typed verification count ${verification.typedVerified}`);
  assert(verification.opaqueViolations.length === 0, `opaque violations: ${JSON.stringify(verification.opaqueViolations)}`);
  assert(verification.opaquePreservedInstances === verification.opaqueTotalInstances, 'opaque instances not fully preserved');
  assert(verification.opaquePreservedKinds === verification.opaqueTotalKinds, 'opaque kinds not fully preserved');

  const typedMutationKinds = new Set(plan.samples.map((s) => `${s.bank}:${s.id}`)).size;
  if (label === 'synthetic-imported') {
    // Deterministic strict assertions for the synthetic-imported registry.
    assert(coverage.cleanKinds === 2, `synthetic-imported cleanKinds ${coverage.cleanKinds}`);
    assert(coverage.mismatchInstances === 0, 'synthetic-imported must have no length mismatches');
    assert(coverage.unknownKinds.length === coverage.totalKinds - coverage.coveredKinds,
      `synthetic-imported unknownKinds ${coverage.unknownKinds.length}`);
    const ml2000 = multiLength.find((m) => m.bank === 2000 && m.id === 0);
    assert(ml2000 !== undefined, '2000:0 must be multi-length in real corpus');
    assert(ml2000.allValidVarargMultiples === true, '2000:0 lengths must all be valid vararg multiples');
    assert(ml2000.lengths.every((l) => [12, 16, 20, 24, 32].includes(l)), `unexpected 2000:0 lengths ${ml2000.lengths}`);
    for (const m of multiLength) {
      if (m.covered && !(m.bank === 2000 && m.id === 0)) {
        assert(m.allValidVarargMultiples === true, `covered multi-length ${m.bank}:${m.id} must be valid vararg multiples`);
      }
    }
  }

  const result: RealCorpusMatrixResult = {
    label,
    registryOrigin: registry.origin,
    coverage: {
      totalKinds: coverage.totalKinds,
      totalInstances: coverage.totalInstances,
      cleanKinds: coverage.cleanKinds,
      varargKinds: coverage.varargKinds,
      mismatchInstances: coverage.mismatchInstances,
      unknownKinds: coverage.unknownKinds.length,
      kindCoverageRatio: Number(coverage.kindCoverageRatio.toFixed(4)),
      instanceCoverageRatio: Number(coverage.instanceCoverageRatio.toFixed(4))
    },
    matrix: {
      typedMutationKinds,
      typedMutationInstances: plan.samples.length,
      eventIdMutation: { oldId: eventMutation.event.eventId, newId: eventMutation.newId, rest: eventMutation.newRest },
      coveredKindsPresent: plan.coveredKindsPresent,
      coveredKindsAbsent: plan.coveredKindsAbsent,
      skippedInstances: plan.skippedInstances,
      opaquePreservedKinds: verification.opaquePreservedKinds,
      opaquePreservedInstances: verification.opaquePreservedInstances,
      opaqueTotalKinds: verification.opaqueTotalKinds,
      opaqueTotalInstances: verification.opaqueTotalInstances,
      opaqueViolations: verification.opaqueViolations,
      coveredUntouchedPreserved: verification.coveredUntouchedPreserved,
      coveredUntouchedTotal: verification.coveredUntouchedTotal,
      multiLengthKinds: multiLength,
      failClosed: unknownFailClosed,
      uncoveredKinds: coverage.unknownKinds,
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
    semanticIdentical: submitted.commit.reRead.semanticIdentical,
    instructionTotal: after.instructionTotal
  };

  console.log(JSON.stringify({
    ok: true,
    message: `EMEVD 真实 corpus + 导入 registry(${label}) 全 corpus mutation 矩阵通过`,
    registryOrigin: registry.origin,
    coverage: result.coverage,
    matrix: result.matrix,
    byteConsistent: result.byteConsistent,
    semanticIdentical: result.semanticIdentical
  }, null, 2));
  return result;
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-emevd-matrix-'));
  const nativeFixtureArg = process.argv[2]?.trim() || undefined;
  const emedfPathArg = process.env.SOULFORGE_EMEDF_PATH?.trim()
    || process.argv[3]?.trim()
    || (await searchRealEmedf());
  const nativeEnvAvailable = Boolean(
    (process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY?.trim() && process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim())
    || nativeFixtureArg
  );
  const skipReasons: string[] = [];
  let syntheticPassed = false;
  let realCorpus: RealCorpusMatrixResult | undefined;
  let realEmedf: RealCorpusMatrixResult | undefined;
  try {
    await syntheticMatrixLeg(root);
    syntheticPassed = true;

    if (nativeEnvAvailable) {
      const sourceDcx = await resolveNativeFixture(nativeFixtureArg, 'emevd-primary', '../../mods/event/common.emevd.dcx');
      realCorpus = await realCorpusMatrixLeg(root, sourceDcx, createSyntheticImportedEmedf(), 'synthetic-imported');
      if (emedfPathArg) {
        const realImport = importDs3EmedfFile(emedfPathArg);
        if (!realImport.ok) throw new Error(`real EMEDF import failed: ${realImport.message}`);
        realEmedf = await realCorpusMatrixLeg(root, sourceDcx, realImport.registry, 'real-emedf');
      } else {
        skipReasons.push('SOULFORGE_EMEDF_PATH 未设置、未提供 arg 3、且 searchRealEmedf 未在本机定位到真实 DarkScript3 EMEDF：真实导入 registry 的 matrix leg 结构化跳过（fail-closed）。');
      }
    } else {
      skipReasons.push('SOULFORGE_NATIVE_FIXTURE_REGISTRY/SOULFORGE_NATIVE_FIXTURE_ROOT 未设置：真实 common.emevd corpus matrix leg 跳过。');
    }

    const coverageUnknownKinds = realCorpus?.matrix.uncoveredKinds ?? [];

    console.log(JSON.stringify({
      ok: true,
      message: 'EMEVD 全 corpus typed-mutation 矩阵 smoke 完成',
      syntheticLeg: syntheticPassed ? 'passed' : 'failed',
      realCorpusLeg: realCorpus ? { label: realCorpus.label, matrix: realCorpus.matrix } : 'skipped',
      realEmedfLeg: realEmedf ? { label: realEmedf.label, matrix: realEmedf.matrix } : 'skipped',
      skips: skipReasons,
      matrixSummary: realCorpus ? {
        typedMutationKinds: realCorpus.matrix.typedMutationKinds,
        typedMutationInstances: realCorpus.matrix.typedMutationInstances,
        opaquePreservedKinds: realCorpus.matrix.opaquePreservedKinds,
        opaquePreservedInstances: realCorpus.matrix.opaquePreservedInstances,
        opaqueTotalKinds: realCorpus.matrix.opaqueTotalKinds,
        opaqueTotalInstances: realCorpus.matrix.opaqueTotalInstances,
        coveredUntouchedPreserved: realCorpus.matrix.coveredUntouchedPreserved,
        coveredUntouchedTotal: realCorpus.matrix.coveredUntouchedTotal,
        failClosed: realCorpus.matrix.failClosed,
        multiLengthKinds: realCorpus.matrix.multiLengthKinds,
        mutations: realCorpus.matrix.mutations,
        uncoveredKinds: coverageUnknownKinds
      } : null,
      nonClaims: [
        'synthetic DS3 JSON 是自构微小样本，不构成 native 或真实 DarkScript3 完成声明。',
        '导入 schema 只覆盖真实 corpus 中 0:0 / 2000:0（2003:1 在 corpus 中缺席），其余未覆盖指令族保持 opaque/unsupported；清单见 matrixSummary.multiLengthKinds 与 coverage.unknownKinds。',
        'authority 上限为 partial；typed mutation 只证明写链与等长替换正确，不证明参数语义正确或完整 EMEDF/layer/游戏加载。'
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
