/**
 * EMEVD full-corpus typed-mutation matrix smoke.
 *
 * Uses the imported EMEDF registry (synthetic DarkScript3 format via
 * createSyntheticImportedEmedf) to run a systematic typed-mutation matrix
 * against the registered native common.emevd (33,266 instructions / 142 kinds):
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
 *     the full 33,266-instruction document before/after.
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
import type { EmevdDslCompileRequest, EmevdEditorDocument } from '@soulforge/shared';
import {
  createEmevdEditorDocument,
  submitEmevdDslPlanViaFourView
} from '../editing/emevdFourViewController.js';
import { readFullEmevdDocumentViaBridge } from '../editing/emevdFullDocument.js';
import { compileEmevdPatchDsl, fingerprintEmedfRegistry } from '../emevd/dslCompiler.js';
import {
  decodeInstructionArgs,
  encodedEmedfArgsLength,
  findInstructionDef,
  hasVararg,
  varargCount,
  type EmedfInstructionDef,
  type EmedfRegistry
} from '../emevd/emedfSchema.js';
import { importDs3EmedfFile } from '../emevd/emedfExternalAdapter.js';
import {
  analyzeEmedfCoverage,
  type EmevdInstructionDistributionEntry
} from '../emevd/emedfCoverage.js';
import { decodeStrictBase64 } from '../util/base64.js';
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

interface EmevdEnvelope {
  sourceHash: string;
  eventCount: number;
  instructionCount: number;
  events?: Array<{ id: number; restBehavior: number; instructionCount?: number }>;
  instructionsSample?: Array<{ index: number; bank: number; id: number; argsBase64: string }>;
  instructionDistribution?: EmevdInstructionDistributionEntry[];
  instructionDistributionTruncated?: boolean;
  roundTrip?: { semanticIdentical: boolean; byteIdentical: boolean };
  authority?: string;
}

interface FlatInstruction {
  globalIndex: number;
  event: EmevdEditorDocument['events'][number];
  instruction: EmevdEditorDocument['events'][number]['instructions'][number];
}

/** One sampled covered instruction with its planned typed mutation. */
interface MatrixSample {
  globalIndex: number;
  instructionAnchor: string;
  bank: number;
  id: number;
  argument: string;
  before: number;
  after: number;
  /** Base64 of the args before commit (equal-length replacement proof). */
  argsBase64Before: string;
  /** Raw vararg tail bytes before commit (byte-exact preservation proof). */
  tailBefore?: Buffer;
}

interface CoveredMutationPlan {
  samples: MatrixSample[];
  skippedInstances: Array<{ bank: number; id: number; globalIndex: number; code: string; message: string }>;
  coveredKindsPresent: Array<{ bank: number; id: number; count: number; mutableArgCount: number }>;
  coveredKindsAbsent: Array<{ bank: number; id: number }>;
}

interface EventMutationSpec {
  eventAnchor: string;
  newId: number;
  newRest: number;
}

interface MultiLengthKindInfo {
  bank: number;
  id: number;
  count: number;
  lengths: number[];
  covered: boolean;
  vararg: boolean;
  allValidVarargMultiples?: boolean;
}

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

const NUMERIC_RANGE: Record<string, [number, number]> = {
  u8: [0, 0xff],
  s8: [-0x80, 0x7f],
  u16: [0, 0xffff],
  s16: [-0x8000, 0x7fff],
  u32: [0, 0xffff_ffff],
  s32: [-0x8000_0000, 0x7fff_ffff]
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function hashOf(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function argsBytesEqual(a: string, b: string): boolean {
  return Buffer.from(a, 'base64').equals(Buffer.from(b, 'base64'));
}

function argsLengthOf(argsBase64: string): number {
  return Buffer.from(argsBase64, 'base64').length;
}

function flipInRange(value: number, min: number, max: number): number {
  if (value === max) return Math.max(min, max - 1);
  if (value === min) return Math.min(max, min + 1);
  return value + 1;
}

function numericRangeOf(type: string): [number, number] {
  const range = NUMERIC_RANGE[type];
  if (!range) throw new Error(`unexpected numeric arg type ${type}`);
  return range;
}

function flatInstructions(document: EmevdEditorDocument): FlatInstruction[] {
  const result: FlatInstruction[] = [];
  for (const event of document.events) {
    for (const instruction of event.instructions) {
      result.push({ globalIndex: result.length, event, instruction });
    }
  }
  return result;
}

function compileRequestFor(
  sourceText: string,
  schemaFingerprint: string,
  document: EmevdEditorDocument
): EmevdDslCompileRequest {
  if (!document.documentInstanceId) throw new Error('documentInstanceId missing');
  return {
    schemaVersion: 1,
    resourceUri: document.resourceUri,
    documentInstanceId: document.documentInstanceId,
    baseRevision: document.revision,
    emedfSchemaFingerprint: schemaFingerprint,
    sourceText,
    mode: 'patch'
  };
}

function buildMatrixDslSource(
  schemaFingerprint: string,
  resourceUri: string,
  eventMutation: EventMutationSpec | undefined,
  samples: MatrixSample[]
): string {
  const lines = [
    `resource "${resourceUri}"`,
    `base revision 0 schema "${schemaFingerprint}"`
  ];
  if (eventMutation) {
    lines.push(`event ${eventMutation.eventAnchor} {`);
    lines.push(`  set id = ${eventMutation.newId};`);
    lines.push(`  set rest = ${eventMutation.newRest};`);
    lines.push('}');
  }
  for (const sample of samples) {
    lines.push(`instruction ${sample.instructionAnchor} {`);
    lines.push(`  set arg ${sample.argument} = ${sample.after};`);
    lines.push('}');
  }
  return lines.join('\n');
}

function singleInstructionDsl(
  schemaFingerprint: string,
  resourceUri: string,
  anchor: string,
  argName: string,
  value: number
): string {
  return `resource "${resourceUri}"
base revision 0 schema "${schemaFingerprint}"
instruction ${anchor} {
  set arg ${argName} = ${value};
}`;
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

/** 2000:0 length-signature distinction: 8/12/16/20/24/32 -> 0/1/2/3/4/6 params. */
function verifyVarargLengthSignature(registry: EmedfRegistry): {
  counts: Array<{ length: number; varargCount: number }>;
  invalidLengthRejectedCode: string;
  belowBaseRejectedCode: string;
  fixedMismatchRejectedCode: string;
} {
  const def = findInstructionDef(registry, 2000, 0);
  assert(def !== undefined, '2000:0 def missing');
  assert(hasVararg(def), '2000:0 must be vararg');
  const counts: Array<{ length: number; varargCount: number }> = [];
  for (const length of [8, 12, 16, 20, 24, 32]) {
    const decoded = decodeInstructionArgs(registry, 2000, 0, Buffer.alloc(length));
    assert(decoded.ok, `2000:0 at ${length} bytes must decode under vararg signature`);
    counts.push({ length, varargCount: varargCount(def, length) });
  }
  assert(
    counts.map((c) => c.varargCount).join(',') === '0,1,2,3,4,6',
    `unexpected vararg counts ${JSON.stringify(counts)}`
  );
  const invalid = decodeInstructionArgs(registry, 2000, 0, Buffer.alloc(10));
  assert(!invalid.ok && invalid.code === 'EMEDF_ARGS_LENGTH_MISMATCH', 'invalid vararg length must fail decode');
  const belowBase = decodeInstructionArgs(registry, 2000, 0, Buffer.alloc(6));
  assert(!belowBase.ok && belowBase.code === 'EMEDF_ARGS_LENGTH_MISMATCH', 'below-base length must fail decode');
  const fixedMismatch = decodeInstructionArgs(registry, 0, 0, Buffer.alloc(8));
  assert(!fixedMismatch.ok && fixedMismatch.code === 'EMEDF_ARGS_LENGTH_MISMATCH', 'fixed length mismatch must fail decode');
  return {
    counts,
    invalidLengthRejectedCode: invalid.code,
    belowBaseRejectedCode: belowBase.code,
    fixedMismatchRejectedCode: fixedMismatch.code
  };
}

function verifySyntheticSamples(
  registry: EmedfRegistry,
  sample: NonNullable<EmevdEnvelope['instructionsSample']>,
  samples: MatrixSample[]
): void {
  const byIndex = new Map(sample.map((entry) => [entry.index, entry]));
  for (const s of samples) {
    const entry = byIndex.get(s.globalIndex);
    assert(entry !== undefined, `sample ${s.globalIndex} missing in re-read`);
    assert(entry.bank === s.bank && entry.id === s.id, `sample ${s.globalIndex} bank/id changed`);
    const raw = decodeStrictBase64(entry.argsBase64, { allowEmpty: true });
    const beforeLen = decodeStrictBase64(s.argsBase64Before, { allowEmpty: true }).length;
    assert(raw.length === beforeLen, `sample ${s.globalIndex} args length changed`);
    const decoded = decodeInstructionArgs(registry, s.bank, s.id, raw);
    if (!decoded.ok) {
      throw new Error(`sample ${s.globalIndex} after-decode failed: ${decoded.message}`);
    }
    const arg = decoded.args.find((a) => a.name === s.argument);
    assert(arg !== undefined && arg.value === s.after, `sample ${s.globalIndex} arg ${s.argument} not mutated to ${s.after}`);
    if (s.tailBefore) {
      const baseSize = encodedEmedfArgsLength(decoded.def);
      const tail = raw.subarray(baseSize);
      assert(tail.equals(s.tailBefore), `sample ${s.globalIndex} vararg tail changed`);
    }
  }
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
/*  Shared matrix sampling / verification                              */
/* ------------------------------------------------------------------ */

/** Prefer a second sample at a different args length so vararg variants are hit. */
function pickSampleIndices(entries: FlatInstruction[], count: number): number[] {
  if (entries.length === 0) return [];
  if (count <= 1) return [0];
  if (entries.length === 1) return [0];
  const firstLength = argsLengthOf(entries[0]!.instruction.argsBase64);
  const different = entries.findIndex((entry, i) => i > 0 && argsLengthOf(entry.instruction.argsBase64) !== firstLength);
  return different > 0 ? [0, different] : [0, Math.floor(entries.length / 2)];
}

function chooseArgName(def: EmedfInstructionDef, sampleIndex: number): string | undefined {
  const writable = def.args.filter((arg) => !arg.vararg && arg.type !== 'f32');
  if (writable.length === 0) return undefined;
  if (sampleIndex === 0 && def.bank === 2000 && def.id === 0) {
    const eventId = writable.find((arg) => arg.name === 'eventId');
    if (eventId) return eventId.name;
  }
  return writable[0]!.name;
}

/** Sample 1-2 instances per schema-covered kind present in the corpus and plan typed mutations. */
function planCoveredMutations(
  registry: EmedfRegistry,
  document: EmevdEditorDocument
): CoveredMutationPlan {
  const flat = flatInstructions(document);
  const byKind = new Map<string, FlatInstruction[]>();
  for (const entry of flat) {
    if (entry.instruction.unknown) continue;
    const key = `${entry.instruction.bank}:${entry.instruction.id}`;
    const list = byKind.get(key) ?? [];
    list.push(entry);
    byKind.set(key, list);
  }

  const samples: MatrixSample[] = [];
  const skippedInstances: CoveredMutationPlan['skippedInstances'] = [];
  const coveredKindsPresent: CoveredMutationPlan['coveredKindsPresent'] = [];
  const coveredKindsAbsent: CoveredMutationPlan['coveredKindsAbsent'] = [];

  for (const def of registry.instructions) {
    const key = `${def.bank}:${def.id}`;
    const entries = byKind.get(key) ?? [];
    if (entries.length === 0) {
      coveredKindsAbsent.push({ bank: def.bank, id: def.id });
      continue;
    }
    const mutableArgCount = def.args.filter((arg) => !arg.vararg && arg.type !== 'f32').length;
    coveredKindsPresent.push({ bank: def.bank, id: def.id, count: entries.length, mutableArgCount });

    const indices = pickSampleIndices(entries, Math.min(2, entries.length));
    for (let s = 0; s < indices.length; s++) {
      const entry = entries[indices[s]!]!;
      let raw: Buffer;
      try {
        raw = decodeStrictBase64(entry.instruction.argsBase64, { allowEmpty: true });
      } catch (error) {
        skippedInstances.push({
          bank: def.bank,
          id: def.id,
          globalIndex: entry.globalIndex,
          code: 'BASE64_INVALID',
          message: error instanceof Error ? error.message : String(error)
        });
        continue;
      }
      const decoded = decodeInstructionArgs(registry, def.bank, def.id, raw);
      if (!decoded.ok) {
        skippedInstances.push({ bank: def.bank, id: def.id, globalIndex: entry.globalIndex, code: decoded.code, message: decoded.message });
        continue;
      }
      const anchor = entry.instruction.anchor;
      if (!anchor) {
        skippedInstances.push({ bank: def.bank, id: def.id, globalIndex: entry.globalIndex, code: 'ANCHOR_MISSING', message: 'instruction anchor missing' });
        continue;
      }
      const argName = chooseArgName(def, s);
      if (!argName) {
        skippedInstances.push({ bank: def.bank, id: def.id, globalIndex: entry.globalIndex, code: 'EMEDF_NO_WRITABLE_ARG', message: `schema ${def.name} 无可写非 vararg 参数` });
        continue;
      }
      const decodedArg = decoded.args.find((a) => a.name === argName);
      if (!decodedArg || typeof decodedArg.value !== 'number') {
        skippedInstances.push({ bank: def.bank, id: def.id, globalIndex: entry.globalIndex, code: 'EMEDF_ARG_NOT_DECODED', message: `参数 ${argName} 无法解码为数值` });
        continue;
      }
      const [min, max] = numericRangeOf(decodedArg.type);
      const after = flipInRange(decodedArg.value, min, max);
      if (after === decodedArg.value) {
        skippedInstances.push({ bank: def.bank, id: def.id, globalIndex: entry.globalIndex, code: 'EMEDF_ARG_NO_DELTA', message: `参数 ${argName} 无法生成不同值` });
        continue;
      }
      const sample: MatrixSample = {
        globalIndex: entry.globalIndex,
        instructionAnchor: formatEmevdAnchor('instruction', anchor),
        bank: def.bank,
        id: def.id,
        argument: argName,
        before: decodedArg.value,
        after,
        argsBase64Before: entry.instruction.argsBase64
      };
      if (hasVararg(def)) {
        sample.tailBefore = raw.subarray(encodedEmedfArgsLength(def));
      }
      samples.push(sample);
    }
  }

  return { samples, skippedInstances, coveredKindsPresent, coveredKindsAbsent };
}

function pickEventMutation(document: EmevdEditorDocument): {
  event: EmevdEditorDocument['events'][number];
  newId: number;
  newRest: number;
} {
  const targetEvent = document.events.find((e) => e.eventId !== 0 && e.instructions.length > 0)
    ?? document.events.find((e) => e.eventId !== 0)
    ?? document.events[0]!;
  let newId = 9_000_004;
  while (document.events.some((e) => e.eventId === newId)) newId += 1;
  const newRest = targetEvent.restBehavior === 0 ? 1 : 0;
  return { event: targetEvent, newId, newRest };
}

/**
 * Every unknown kind must fail closed twice: decode (EMEDF_UNKNOWN_INSTRUCTION)
 * and DSL write (EMEVD_DSL_UNKNOWN_INSTRUCTION_READONLY with zero plan ops).
 */
function verifyUnknownKindFailClosed(
  registry: EmedfRegistry,
  document: EmevdEditorDocument,
  schemaFingerprint: string
): { unknownKindsChecked: number; readOnlyDiagnostics: number; decodeFailCodes: string[] } {
  const flat = flatInstructions(document);
  const unknownByKind = new Map<string, FlatInstruction>();
  for (const entry of flat) {
    if (!entry.instruction.unknown) continue;
    const key = `${entry.instruction.bank}:${entry.instruction.id}`;
    if (!unknownByKind.has(key)) unknownByKind.set(key, entry);
  }
  const entries = [...unknownByKind.values()];
  assert(entries.length > 0, 'expected unknown kinds to verify');

  const decodeFailCodes: string[] = [];
  for (const entry of entries) {
    const raw = decodeStrictBase64(entry.instruction.argsBase64, { allowEmpty: true });
    const decoded = decodeInstructionArgs(registry, entry.instruction.bank, entry.instruction.id, raw);
    assert(!decoded.ok, `unknown ${entry.instruction.bank}:${entry.instruction.id} must not decode`);
    assert(decoded.code === 'EMEDF_UNKNOWN_INSTRUCTION', `unexpected unknown decode code ${decoded.code}`);
    if (!decodeFailCodes.includes(decoded.code)) decodeFailCodes.push(decoded.code);
  }

  const lines = [`resource "${document.resourceUri}"`, `base revision 0 schema "${schemaFingerprint}"`];
  for (const entry of entries) {
    const anchor = entry.instruction.anchor;
    assert(anchor !== undefined, 'unknown instruction anchor missing');
    lines.push(`instruction ${formatEmevdAnchor('instruction', anchor)} {`);
    lines.push('  set arg unknownArg = 1;');
    lines.push('}');
  }
  const compiled = compileEmevdPatchDsl(
    compileRequestFor(lines.join('\n'), schemaFingerprint, document),
    document,
    registry
  );
  assert(compiled.ok === false, 'unknown-kind patch must fail closed');
  assert(!('plan' in compiled), 'unknown-kind patch must not produce a plan');
  const readOnly = compiled.diagnostics.filter((d) => d.code === 'EMEVD_DSL_UNKNOWN_INSTRUCTION_READONLY').length;
  assert(readOnly === entries.length, `expected ${entries.length} read-only diagnostics, got ${readOnly}`);
  const unexpected = compiled.diagnostics.filter((d) => d.code !== 'EMEVD_DSL_UNKNOWN_INSTRUCTION_READONLY');
  assert(unexpected.length === 0, `unexpected diagnostics: ${JSON.stringify(unexpected)}`);

  return { unknownKindsChecked: unknownByKind.size, readOnlyDiagnostics: readOnly, decodeFailCodes };
}

/** Kinds observed at more than one args length; covered vararg kinds are length-signature valid. */
function analyzeMultiLengthKinds(registry: EmedfRegistry, distribution: EmevdInstructionDistributionEntry[]): MultiLengthKindInfo[] {
  const results: MultiLengthKindInfo[] = [];
  for (const entry of distribution) {
    const lengths = Object.keys(entry.argsLengths)
      .map(Number)
      .filter(Number.isSafeInteger)
      .sort((a, b) => a - b);
    if (lengths.length <= 1) continue;
    const def = findInstructionDef(registry, entry.bank, entry.id);
    const covered = def !== undefined;
    const vararg = def ? hasVararg(def) : false;
    results.push({
      bank: entry.bank,
      id: entry.id,
      count: entry.count,
      lengths,
      covered,
      vararg,
      ...(covered && vararg ? { allValidVarargMultiples: lengths.every((l) => varargCount(def!, l) >= 0) } : {})
    });
  }
  return results;
}

/**
 * Verify a committed matrix against full before/after documents:
 * typed mutations observable, opaque instructions byte-preserved, covered
 * untouched instructions byte-preserved.
 */
function verifyMatrixCommit(
  registry: EmedfRegistry,
  beforeDoc: EmevdEditorDocument,
  afterDoc: EmevdEditorDocument,
  samples: MatrixSample[]
): {
  typedVerified: number;
  opaquePreservedKinds: number;
  opaquePreservedInstances: number;
  opaqueTotalKinds: number;
  opaqueTotalInstances: number;
  opaqueViolations: string[];
  coveredUntouchedPreserved: number;
  coveredUntouchedTotal: number;
} {
  const beforeFlat = flatInstructions(beforeDoc);
  const afterByIndex = new Map(flatInstructions(afterDoc).map((f) => [f.globalIndex, f.instruction]));

  let typedVerified = 0;
  for (const sample of samples) {
    const afterInstr = afterByIndex.get(sample.globalIndex);
    assert(afterInstr !== undefined, `mutated instruction ${sample.globalIndex} missing after commit`);
    assert(afterInstr.bank === sample.bank && afterInstr.id === sample.id, `sample ${sample.globalIndex} bank/id changed`);
    const beforeRaw = decodeStrictBase64(sample.argsBase64Before, { allowEmpty: true });
    const afterRaw = decodeStrictBase64(afterInstr.argsBase64, { allowEmpty: true });
    assert(afterRaw.length === beforeRaw.length, `sample ${sample.globalIndex} args length changed`);
    const decoded = decodeInstructionArgs(registry, sample.bank, sample.id, afterRaw);
    if (!decoded.ok) {
      throw new Error(`sample ${sample.globalIndex} after-decode failed: ${decoded.message}`);
    }
    const arg = decoded.args.find((a) => a.name === sample.argument);
    assert(arg !== undefined && arg.value === sample.after, `sample ${sample.globalIndex} arg ${sample.argument} not mutated to ${sample.after}`);
    if (sample.tailBefore) {
      const baseSize = encodedEmedfArgsLength(decoded.def);
      const tail = afterRaw.subarray(baseSize);
      assert(tail.equals(sample.tailBefore), `sample ${sample.globalIndex} vararg tail changed`);
    }
    typedVerified += 1;
  }

  let opaqueTotalKinds = 0;
  let opaqueTotalInstances = 0;
  let opaquePreservedKinds = 0;
  let opaquePreservedInstances = 0;
  const opaqueViolations: string[] = [];
  const opaqueKindResults = new Map<string, boolean>();
  for (const before of beforeFlat) {
    if (!before.instruction.unknown) continue;
    opaqueTotalInstances += 1;
    const key = `${before.instruction.bank}:${before.instruction.id}`;
    if (!opaqueKindResults.has(key)) {
      opaqueTotalKinds += 1;
      opaqueKindResults.set(key, true);
    }
    const afterInstr = afterByIndex.get(before.globalIndex);
    assert(afterInstr !== undefined, `opaque instruction ${before.globalIndex} missing after commit`);
    const preserved = argsBytesEqual(afterInstr.argsBase64, before.instruction.argsBase64);
    if (!preserved) {
      opaqueViolations.push(`${before.globalIndex}:${key}`);
      opaqueKindResults.set(key, false);
    } else {
      opaquePreservedInstances += 1;
    }
  }
  for (const preserved of opaqueKindResults.values()) {
    if (preserved) opaquePreservedKinds += 1;
  }

  let coveredUntouchedTotal = 0;
  let coveredUntouchedPreserved = 0;
  const mutatedIndices = new Set(samples.map((s) => s.globalIndex));
  for (const before of beforeFlat) {
    if (before.instruction.unknown || mutatedIndices.has(before.globalIndex)) continue;
    const afterInstr = afterByIndex.get(before.globalIndex);
    assert(afterInstr !== undefined, `covered instruction ${before.globalIndex} missing after commit`);
    coveredUntouchedTotal += 1;
    if (argsBytesEqual(afterInstr.argsBase64, before.instruction.argsBase64)) coveredUntouchedPreserved += 1;
  }

  return {
    typedVerified,
    opaquePreservedKinds,
    opaquePreservedInstances,
    opaqueTotalKinds,
    opaqueTotalInstances,
    opaqueViolations,
    coveredUntouchedPreserved,
    coveredUntouchedTotal
  };
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
    pageSize: 2048,
    timeoutMs: 120_000
  });
  if (!before.ok || !before.document) {
    throw new Error(`full document read failed: ${JSON.stringify(before.diagnostics)}`);
  }
  assert(before.instructionTotal === 33_266, `unexpected instruction total ${before.instructionTotal}`);
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
  assert(coverage.totalInstances === 33_266, `analysis instance total ${coverage.totalInstances}`);

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
    assert(coverage.unknownKinds.length === 140, `synthetic-imported unknownKinds ${coverage.unknownKinds.length}`);
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
    || undefined;
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
        skipReasons.push('SOULFORGE_EMEDF_PATH 未设置且未提供 arg 3：真实 DarkScript3 EMEDF 文件缺失，真实导入 registry 的 matrix leg 结构化跳过（fail-closed）。');
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
        '导入 schema 只覆盖真实 corpus 中 0:0 / 2000:0（2003:1 在 corpus 中缺席），其余 140 种保持 opaque/unsupported；未覆盖指令族清单见 matrixSummary.multiLengthKinds 与 coverage.unknownKinds。',
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
