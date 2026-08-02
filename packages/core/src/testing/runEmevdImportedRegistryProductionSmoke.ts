/**
 * Production smoke: a DarkScript3-format EMEDF JSON imported through the
 * external adapter drives the full DSL typed-mutation write chain
 * (compile → typed plan → Bridge batch staging → file_replace PatchIR →
 * WorkspaceTransaction commit → Bridge re-read).
 *
 * This closes the W-EMEVD-FULL-01 gap "adapter 已建立但尚未在 production 写链中
 * 使用导入 EMEDF 进行 typed mutation": every leg below uses an *imported*
 * registry (origin='imported'), never the built-in fixture.
 *
 * Legs:
 * - Synthetic success: tiny synthetic EMEVD built to match the imported schema;
 *   typed event id/rest + instruction-arg mutation (including a vararg base-arg
 *   write with byte-exact vararg-tail preservation) commits and re-reads.
 * - Synthetic rollback: after-commit validator failure restores original bytes.
 * - Synthetic failure: wrong expectedDocumentHash fails closed, target untouched.
 * - Real corpus (env-gated): the imported registry drives an event-level id/rest
 *   mutation plus a 2000:0 InitializeEvent eventId typed mutation on the real
 *   registered common.emevd (33,266 instructions); re-read verifies both.
 * - Real EMEDF file (SOULFORGE_EMEDF_PATH / arg 3): same real-corpus chain with
 *   the real file's imported registry; absent → structured skip recorded.
 *
 * DarkScript3 EMEDF data is All Rights Reserved. The synthetic DS3 JSON is our
 * own tiny sample (syntheticEmevdBytes.createSyntheticDs3EmedfJson); no real
 * DarkScript3 data is bundled or committed.
 *
 * Authority cap: partial. Proves the imported-registry → production write chain
 * on synthetic + registered native samples; no full EMEDF/layer/game-load claims.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import type {
  EmevdDslCompileRequest,
  EmevdEditorDocument,
  ValidatorContract,
  ValidatorResult
} from '@soulforge/shared';
import {
  createEmevdEditorDocument,
  submitEmevdDslPlanViaFourView
} from '../editing/emevdFourViewController.js';
import {
  buildEmevdFileReplacePatch,
  stageEmevdPlanViaBridge,
  type EmevdPlanStageResult
} from '../editing/emevdPlanCommit.js';
import { readFullEmevdDocumentViaBridge } from '../editing/emevdFullDocument.js';
import { compileEmevdPatchDsl, fingerprintEmedfRegistry } from '../emevd/dslCompiler.js';
import { decodeInstructionArgs, type EmedfRegistry } from '../emevd/emedfSchema.js';
import { importDs3EmedfFile } from '../emevd/emedfExternalAdapter.js';
import { decodeStrictBase64 } from '../util/base64.js';
import { formatEmevdAnchor } from '../emevd/stableIdentity.js';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { createWorkspaceTransaction } from '../transactions/workspaceTransaction.js';
import { createScaffoldValidators } from '../validators/index.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';
import {
  createSyntheticImportedEmedf,
  importedRegistrySyntheticEmevd,
  mutatedIfCondArgsForImported,
  mutatedInitEventArgsForImported,
  sha256Hex
} from './syntheticEmevdBytes.js';
import { searchRealEmedf } from './realEmedfLocator.js';

interface EmevdEnvelope {
  sourceHash: string;
  eventCount: number;
  instructionCount: number;
  events: Array<{ id: number; restBehavior: number; instructionCount?: number }>;
  instructionsSample?: Array<{
    index: number;
    bank: number;
    id: number;
    argsBase64: string;
  }>;
  roundTrip?: { semanticIdentical: boolean; byteIdentical: boolean };
}

function throwingAfterCommitValidator(): ValidatorContract {
  const fail = (): ValidatorResult => {
    throw new Error('injected after_commit re-read failure');
  };
  return {
    validatorId: 'emevd_imported_production_after_commit',
    targetResourceKinds: ['*'],
    validationScope: ['after_commit'],
    validateAfterCommit: fail
  };
}

/** DFLT-decompress a DCX container (same helper as runEmevdPlanCommitProductionSmoke). */
function decompressDfltDcx(source: Buffer): Buffer {
  if (source.subarray(0, 4).toString('ascii') !== 'DCX\0') throw new Error('not DCX');
  let dca = -1;
  for (let i = 0x30; i < 0x100; i++) {
    if (source[i] === 0x44 && source[i + 1] === 0x43 && source[i + 2] === 0x41 && source[i + 3] === 0) {
      dca = i;
      break;
    }
  }
  if (dca < 0) throw new Error('DCA missing');
  const dcaLen = source.readUInt32BE(dca + 4);
  const payloadOff = dca + dcaLen;
  const compressedSize = source.readUInt32BE(0x20);
  const format = source.subarray(0x28, 0x2c).toString('ascii');
  if (format !== 'DFLT') throw new Error(`expected DFLT, got ${format}`);
  const compressed = source.subarray(payloadOff, payloadOff + compressedSize);
  return inflateSync(compressed);
}

function hashOf(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
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

/** Flat, Bridge-global-order instruction list of an assembled document. */
function flatInstructions(document: EmevdEditorDocument): Array<{
  globalIndex: number;
  event: EmevdEditorDocument['events'][number];
  instruction: EmevdEditorDocument['events'][number]['instructions'][number];
}> {
  const result: Array<{
    globalIndex: number;
    event: EmevdEditorDocument['events'][number];
    instruction: EmevdEditorDocument['events'][number]['instructions'][number];
  }> = [];
  for (const event of document.events) {
    for (const instruction of event.instructions) {
      result.push({ globalIndex: result.length, event, instruction });
    }
  }
  return result;
}

/** DSL patch bound to the imported-registry synthetic document. */
function importedSyntheticDslSource(
  schemaFingerprint: string,
  document: EmevdEditorDocument
): string {
  const event0 = document.events[0]!;
  const instr0 = event0.instructions[0]!; // 0:0 IfConditionGroup
  const instr1 = event0.instructions[1]!; // 2000:0 InitializeEvent (vararg)
  if (!event0.anchor || !instr0.anchor || !instr1.anchor) throw new Error('anchors missing');
  return `resource "file://event/common.emevd"
base revision 0 schema "${schemaFingerprint}"
event ${formatEmevdAnchor('event', event0.anchor)} {
  set id = 51;
  set rest = 1;
  instruction ${formatEmevdAnchor('instruction', instr0.anchor)} {
    set arg desiredConditionGroupState = 1;
  }
  instruction ${formatEmevdAnchor('instruction', instr1.anchor)} {
    set arg eventId = 200;
  }
}`;
}

function importedSyntheticDocument(): EmevdEditorDocument {
  return createEmevdEditorDocument({
    resourceUri: 'file://event/common.emevd',
    documentInstanceId: 'emevd-imported-synthetic',
    events: [
      {
        eventId: 50,
        restBehavior: 0,
        instructions: [
          { bank: 0, id: 0, argsBase64: Buffer.from([0x01, 0x00, 0x02, 0x00]).toString('base64'), unknown: false },
          { bank: 2000, id: 0, argsBase64: Buffer.from([0x0a, 0, 0, 0, 0x64, 0, 0, 0, 0x07, 0, 0, 0]).toString('base64'), unknown: false },
          { bank: 9999, id: 1, argsBase64: '', unknown: true }
        ]
      },
      { eventId: 100, restBehavior: 0, instructions: [] }
    ]
  });
}

async function importedSyntheticSuccessChain(root: string): Promise<number> {
  const registry = createSyntheticImportedEmedf();
  const schemaFingerprint = fingerprintEmedfRegistry(registry);
  const original = importedRegistrySyntheticEmevd();

  const overlayRoot = join(root, 'mod-imported');
  const stagingRoot = join(root, 'staging-imported');
  const backupRoot = join(root, 'backups-imported');
  await mkdir(join(overlayRoot, 'event'), { recursive: true });
  await mkdir(stagingRoot, { recursive: true });
  await mkdir(backupRoot, { recursive: true });
  const target = join(overlayRoot, 'event', 'common.emevd');
  await writeFile(target, original);
  const sourceHash = sha256Hex(original);

  const document = importedSyntheticDocument();
  const session = await openWorkspaceSession({ overlayRoot, game: 'sekiro' });

  // Bridge cross-check before commit.
  const before = await runBridge<EmevdEnvelope>({
    command: 'read-emevd-document',
    filePath: target,
    allowedRoots: [overlayRoot, stagingRoot],
    timeoutMs: 120_000
  });
  if (before.parseStatus === 'failed' || !before.data?.roundTrip?.semanticIdentical) {
    throw new Error(`synthetic EMEVD rejected by Bridge: ${JSON.stringify(before.diagnostics)}`);
  }
  if (before.data.sourceHash !== sourceHash) {
    throw new Error(`source hash mismatch: ${before.data.sourceHash} vs ${sourceHash}`);
  }

  const source = importedSyntheticDslSource(schemaFingerprint, document);
  const compiled = compileEmevdPatchDsl(compileRequestFor(source, schemaFingerprint, document), document, registry);
  if (!compiled.ok || !compiled.plan) throw new Error(`compile failed: ${JSON.stringify(compiled.diagnostics)}`);
  // set_event_id + set_event_rest_behavior + 2 typed instruction args = 4 ops
  if (compiled.plan.operations.length !== 4) {
    throw new Error(`expected 4 plan operations, got ${compiled.plan.operations.length}`);
  }
  const eventIdOp = compiled.plan.operations.find((op) => op.kind === 'set_instruction_arg' && op.argument === 'eventId');
  if (!eventIdOp || eventIdOp.kind !== 'set_instruction_arg' || eventIdOp.after !== 200) {
    throw new Error(`InitializeEvent eventId typed mutation missing: ${JSON.stringify(compiled.plan.operations)}`);
  }

  // Vararg tail args are opaque: a DSL write to `parameters` must be rejected
  // at compile time (structured read-only diagnostic), never turned into a plan.
  const varargWrite = compileEmevdPatchDsl(
    compileRequestFor(
      source.replace('set arg eventId = 200;', 'set arg parameters = 99;'),
      schemaFingerprint,
      document
    ),
    document,
    registry
  );
  if (varargWrite.ok || !varargWrite.diagnostics.some((d) => d.code === 'EMEVD_DSL_VARARG_ARG_READONLY')) {
    throw new Error('vararg tail arg write must be rejected as read-only');
  }
  if (compiled.plan.operations.some((op) => op.kind === 'set_instruction_arg' && op.argument === 'parameters')) {
    throw new Error('vararg tail arg must never reach the plan');
  }

  const submitted = await submitEmevdDslPlanViaFourView({
    compileRequest: compileRequestFor(source, schemaFingerprint, document),
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
    title: 'emevd imported registry synthetic'
  });
  if (!submitted.ok || !submitted.commit) throw new Error(`submit failed: ${JSON.stringify(submitted.diagnostics)}`);
  const commit = submitted.commit;
  if (!commit.ok) throw new Error(`commit failed: ${JSON.stringify(commit.diagnostics)}`);
  if (commit.mutationCount !== 4) throw new Error(`expected 4 Bridge mutations, got ${commit.mutationCount}`);
  if (!commit.reRead?.ok) throw new Error(`re-read failed: ${JSON.stringify(commit.diagnostics)}`);
  if (!commit.reRead.byteConsistent) throw new Error('committed bytes are not byte-consistent');
  if (!commit.reRead.semanticIdentical) throw new Error('committed file semantic re-read failed');

  // Byte-level: committed file hash equals staged output hash.
  const committedBytes = await readFile(target);
  if (hashOf(committedBytes) !== commit.outputHash) {
    throw new Error('committed file hash does not match staged output hash');
  }

  // Independent re-read: typed mutations observable; vararg tail preserved.
  const after = await runBridge<EmevdEnvelope>({
    command: 'read-emevd-document',
    filePath: target,
    allowedRoots: [overlayRoot, stagingRoot],
    timeoutMs: 120_000
  });
  if (after.parseStatus === 'failed') throw new Error('post-commit read failed');
  if (after.data!.eventCount !== 2 || after.data!.instructionCount !== 3) {
    throw new Error(`unexpected counts ${after.data!.eventCount}/${after.data!.instructionCount}`);
  }
  const renamed = after.data!.events.find((e) => e.id === 51);
  if (!renamed || renamed.restBehavior !== 1) throw new Error('renamed event/rest not observable');
  if (after.data!.events.some((e) => e.id === 50)) throw new Error('old event id still present');
  const sample0 = after.data!.instructionsSample?.find((i) => i.index === 0);
  const sample1 = after.data!.instructionsSample?.find((i) => i.index === 1);
  if (!sample0 || !Buffer.from(sample0.argsBase64, 'base64').equals(mutatedIfCondArgsForImported())) {
    throw new Error('instruction 0 (0:0) args not observable');
  }
  if (!sample1 || !Buffer.from(sample1.argsBase64, 'base64').equals(mutatedInitEventArgsForImported())) {
    throw new Error('instruction 1 (2000:0) eventId/tail not observable');
  }
  const unknownSample = after.data!.instructionsSample?.find((i) => i.index === 2);
  if (!unknownSample || unknownSample.bank !== 9999) throw new Error('unknown instruction must survive');

  return 1;
}

async function importedSyntheticRollbackChain(root: string): Promise<number> {
  const registry = createSyntheticImportedEmedf();
  const schemaFingerprint = fingerprintEmedfRegistry(registry);
  const original = importedRegistrySyntheticEmevd();

  const overlayRoot = join(root, 'mod-imported-rollback');
  const stagingRoot = join(root, 'staging-imported-rollback');
  const backupRoot = join(root, 'backups-imported-rollback');
  await mkdir(join(overlayRoot, 'event'), { recursive: true });
  await mkdir(stagingRoot, { recursive: true });
  await mkdir(backupRoot, { recursive: true });
  const target = join(overlayRoot, 'event', 'common.emevd');
  await writeFile(target, original);
  const sourceHash = sha256Hex(original);

  const document = importedSyntheticDocument();
  const session = await openWorkspaceSession({ overlayRoot, game: 'sekiro' });
  const source = importedSyntheticDslSource(schemaFingerprint, document);

  const staged: EmevdPlanStageResult = await stageEmevdPlanViaBridge({
    plan: (() => {
      const compiled = compileEmevdPatchDsl(compileRequestFor(source, schemaFingerprint, document), document, registry);
      if (!compiled.ok || !compiled.plan) throw new Error('compile failed');
      return compiled.plan;
    })(),
    document,
    registry,
    sourcePath: target,
    expectedDocumentHash: sourceHash,
    allowedRoots: [overlayRoot, stagingRoot],
    stagingRoot,
    timeoutMs: 120_000
  });
  if (!staged.ok || !staged.bytes) {
    throw new Error(`Bridge staging failed: ${JSON.stringify(staged.diagnostics)}`);
  }

  // Commit with a failing after-commit validator → auto-rollback.
  const patch = buildEmevdFileReplacePatch({
    workspaceId: session.meta.workspaceId,
    title: 'emevd imported registry rollback',
    targetUri: 'file://event/common.emevd',
    targetPath: target,
    stagedBytes: staged.bytes,
    expectedHash: sourceHash
  });
  const transaction = createWorkspaceTransaction({
    workspaceId: session.meta.workspaceId,
    workspaceRoot: overlayRoot,
    stagingBaseDir: stagingRoot,
    backupBaseDir: backupRoot,
    validators: [...createScaffoldValidators(), throwingAfterCommitValidator()]
  });
  if (!transaction.addPatch(patch).ok) throw new Error('patch admission failed');
  const stagedResult = await transaction.stage();
  if (!stagedResult.ok) throw new Error(`stage failed: ${JSON.stringify(stagedResult.diagnostics)}`);
  const validated = await transaction.validate();
  if (!validated.ok) throw new Error(`validate failed: ${JSON.stringify(validated.diagnostics)}`);
  const committed = await transaction.commit();
  if (committed.ok || committed.committedPaths.length !== 0) {
    throw new Error('after-commit failure must not leave committed files');
  }
  if (!committed.diagnostics.some((d) => d.code === 'VALIDATOR_AFTER_COMMIT_FAILED')) {
    throw new Error(`missing VALIDATOR_AFTER_COMMIT_FAILED: ${JSON.stringify(committed.diagnostics)}`);
  }
  if (transaction.getStatus() !== 'failed') {
    throw new Error(`transaction status ${transaction.getStatus()}, expected failed`);
  }
  const restored = await readFile(target);
  if (!restored.equals(original)) throw new Error('rollback did not restore original bytes');
  const audit = transaction.getAuditLog().list({ transactionId: transaction.transactionId });
  if (!audit.some((entry) => entry.eventKind === 'failure_recovery')) {
    throw new Error('rollback failure was not audited');
  }
  return 1;
}

async function importedSyntheticFailureChain(root: string): Promise<number> {
  const registry = createSyntheticImportedEmedf();
  const schemaFingerprint = fingerprintEmedfRegistry(registry);
  const original = importedRegistrySyntheticEmevd();

  const overlayRoot = join(root, 'mod-imported-failure');
  const stagingRoot = join(root, 'staging-imported-failure');
  await mkdir(join(overlayRoot, 'event'), { recursive: true });
  await mkdir(stagingRoot, { recursive: true });
  const target = join(overlayRoot, 'event', 'common.emevd');
  await writeFile(target, original);

  const document = importedSyntheticDocument();
  const session = await openWorkspaceSession({ overlayRoot, game: 'sekiro' });
  const source = importedSyntheticDslSource(schemaFingerprint, document);

  const submitted = await submitEmevdDslPlanViaFourView({
    compileRequest: compileRequestFor(source, schemaFingerprint, document),
    document,
    registry,
    sourcePath: target,
    expectedDocumentHash: 'f'.repeat(64),
    allowedRoots: [overlayRoot, stagingRoot],
    workspaceId: session.meta.workspaceId,
    workspaceRoot: overlayRoot,
    stagingRoot,
    title: 'emevd imported registry failure'
  });
  if (submitted.ok) throw new Error('wrong source hash must fail closed');
  if (!submitted.diagnostics.some((d) => d.severity === 'error')) {
    throw new Error('failure must carry structured error diagnostics');
  }
  if (!submitted.diagnostics.some((d) => d.code === 'EMEVD_STAGING_WRITE_FAILED')) {
    throw new Error(`expected EMEVD_STAGING_WRITE_FAILED: ${JSON.stringify(submitted.diagnostics)}`);
  }
  const untouched = await readFile(target);
  if (!untouched.equals(original)) throw new Error('failed submission must not modify the target');
  return 1;
}

/**
 * Real-corpus leg: the imported registry drives an event-level id/rest mutation
 * AND a typed 2000:0 InitializeEvent eventId mutation (vararg tail preserved)
 * on the registered local common.emevd. Re-read verifies both and counts stay.
 */
async function importedRealCorpusChain(
  root: string,
  sourceDcx: string,
  registry: EmedfRegistry,
  registryLabel: string
): Promise<void> {
  const overlayRoot = join(root, `mod-native-${registryLabel}`);
  const stagingRoot = join(root, `staging-native-${registryLabel}`);
  await mkdir(join(overlayRoot, 'event'), { recursive: true });
  await mkdir(stagingRoot, { recursive: true });

  const dcxBytes = await readFile(sourceDcx);
  const payload = decompressDfltDcx(dcxBytes);
  const target = join(overlayRoot, 'event', 'common.emevd');
  await writeFile(target, payload);
  const sourceHash = hashOf(payload);
  const schemaFingerprint = fingerprintEmedfRegistry(registry);

  const full = await readFullEmevdDocumentViaBridge({
    filePath: target,
    allowedRoots: [overlayRoot, stagingRoot],
    resourceUri: 'file://event/common.emevd',
    registry,
    documentInstanceId: `emevd-imported-${registryLabel}`,
    pageSize: 2048,
    timeoutMs: 120_000
  });
  if (!full.ok || !full.document) throw new Error(`full document read failed: ${JSON.stringify(full.diagnostics)}`);
  if (full.instructionTotal !== 33_266) throw new Error(`unexpected instruction total ${full.instructionTotal}`);
  if (full.sourceHash !== sourceHash) throw new Error(`source hash mismatch ${full.sourceHash} vs ${sourceHash}`);

  const document = full.document;

  // Event-level target (required case).
  const targetEvent = document.events.find((e) => e.eventId !== 0 && e.instructions.length > 0)
    ?? document.events.find((e) => e.eventId !== 0)
    ?? document.events[0]!;
  if (!targetEvent.anchor) throw new Error('target event anchor missing');
  let newId = 9_000_004;
  while (document.events.some((e) => e.eventId === newId)) newId += 1;
  const newRest = targetEvent.restBehavior === 0 ? 1 : 0;

  // Typed target: first 2000:0 InitializeEvent whose payload decodes under the
  // imported registry (vararg lengths 12/16/20/24/32 are all valid multiples).
  const flat = flatInstructions(document);
  const init = flat.find((entry) => entry.instruction.bank === 2000 && entry.instruction.id === 0);
  if (!init || !init.instruction.anchor) throw new Error('no InitializeEvent 2000:0 instance found');
  const initRaw = decodeStrictBase64(init.instruction.argsBase64, { allowEmpty: true });
  const initDecoded = decodeInstructionArgs(registry, 2000, 0, initRaw);
  if (!initDecoded.ok) throw new Error(`InitializeEvent decode failed: ${initDecoded.message}`);
  const eventIdArg = initDecoded.args.find((a) => a.name === 'eventId');
  if (!eventIdArg || typeof eventIdArg.value !== 'number' || eventIdArg.value >= 0xffff_ffff) {
    throw new Error('eventId arg missing or out of range');
  }
  const newInitEventId = eventIdArg.value + 1;
  const beforeInitArgs = Buffer.from(init.instruction.argsBase64, 'base64');

  const source = `resource "file://event/common.emevd"
base revision 0 schema "${schemaFingerprint}"
event ${formatEmevdAnchor('event', targetEvent.anchor)} {
  set rest = ${newRest};
  set id = ${newId};
}
instruction ${formatEmevdAnchor('instruction', init.instruction.anchor)} {
  set arg eventId = ${newInitEventId};
}`;
  const compiled = compileEmevdPatchDsl(compileRequestFor(source, schemaFingerprint, document), document, registry);
  if (!compiled.ok || !compiled.plan) {
    throw new Error(`real corpus compile failed: ${JSON.stringify(compiled.diagnostics)}`);
  }
  // 1 typed instruction arg + 1 rest + 1 id = 3 operations.
  if (compiled.plan.operations.length !== 3) {
    throw new Error(`expected 3 plan operations, got ${compiled.plan.operations.length}`);
  }

  const session = await openWorkspaceSession({ overlayRoot, game: 'sekiro' });
  const submitted = await submitEmevdDslPlanViaFourView({
    compileRequest: compileRequestFor(source, schemaFingerprint, document),
    document,
    registry,
    sourcePath: target,
    expectedDocumentHash: sourceHash,
    allowedRoots: [overlayRoot, stagingRoot],
    workspaceId: session.meta.workspaceId,
    workspaceRoot: overlayRoot,
    stagingRoot,
    title: `emevd imported registry ${registryLabel} native`
  });
  if (!submitted.ok || !submitted.commit) throw new Error(`submit failed: ${JSON.stringify(submitted.diagnostics)}`);
  if (!submitted.commit.ok || !submitted.commit.reRead?.ok) {
    throw new Error(`commit/re-read failed: ${JSON.stringify(submitted.commit.diagnostics)}`);
  }
  if (!submitted.commit.reRead.byteConsistent) throw new Error('committed bytes not byte-consistent');
  if (submitted.commit.mutationCount !== 3) {
    throw new Error(`expected 3 Bridge mutations, got ${submitted.commit.mutationCount}`);
  }

  // Independent re-read of the committed file.
  const after = await readFullEmevdDocumentViaBridge({
    filePath: target,
    allowedRoots: [overlayRoot, stagingRoot],
    resourceUri: 'file://event/common.emevd',
    registry,
    documentInstanceId: `emevd-imported-${registryLabel}-after`,
    pageSize: 2048,
    timeoutMs: 120_000
  });
  if (!after.ok || !after.document) throw new Error(`post-commit read failed: ${JSON.stringify(after.diagnostics)}`);
  if (after.instructionTotal !== full.instructionTotal) throw new Error('instruction total changed');
  if (after.document.events.length !== document.events.length) throw new Error('event count changed');
  const renamed = after.document.events.find((e) => e.eventId === newId);
  if (!renamed || renamed.restBehavior !== newRest) throw new Error('renamed event not observable');
  if (after.document.events.some((e) => e.eventId === targetEvent.eventId)) {
    throw new Error('old event id still present');
  }

  const afterFlat = flatInstructions(after.document);
  const afterInit = afterFlat.find((entry) => entry.globalIndex === init.globalIndex);
  if (!afterInit) throw new Error('mutated instruction missing after commit');
  const afterRaw = decodeStrictBase64(afterInit.instruction.argsBase64, { allowEmpty: true });
  const afterDecoded = decodeInstructionArgs(registry, 2000, 0, afterRaw);
  if (!afterDecoded.ok) throw new Error(`after decode failed: ${afterDecoded.message}`);
  const afterEventId = afterDecoded.args.find((a) => a.name === 'eventId');
  if (!afterEventId || afterEventId.value !== newInitEventId) {
    throw new Error(`InitializeEvent eventId not mutated: ${JSON.stringify(afterDecoded.args)}`);
  }
  const beforeTail = beforeInitArgs.subarray(8);
  const afterTail = afterRaw.subarray(8);
  if (!beforeTail.equals(afterTail)) throw new Error('InitializeEvent vararg tail changed');

  console.log(JSON.stringify({
    ok: true,
    message: `EMEVD 真实 corpus + 导入 registry(${registryLabel}) production typed mutation 通过`,
    registryOrigin: registry.origin,
    instructionTotal: after.instructionTotal,
    eventMutation: { oldId: targetEvent.eventId, newId, rest: newRest },
    typedMutation: {
      bank: 2000,
      id: 0,
      globalIndex: init.globalIndex,
      eventIdBefore: eventIdArg.value,
      eventIdAfter: newInitEventId,
      varargTailPreserved: true
    },
    byteConsistent: submitted.commit.reRead.byteConsistent
  }, null, 2));
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-emevd-imported-'));
  const nativeFixtureArg = process.argv[2]?.trim() || undefined;
  const emedfPathArg = process.env.SOULFORGE_EMEDF_PATH?.trim()
    || process.argv[3]?.trim()
    || (await searchRealEmedf());
  const nativeEnvAvailable = Boolean(
    (process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY?.trim() && process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim())
    || nativeFixtureArg
  );
  let syntheticPassed = 0;
  let realCorpusLegs = 0;
  let realEmedfLegs = 0;
  const skipReasons: string[] = [];
  try {
    syntheticPassed += await importedSyntheticSuccessChain(root);
    syntheticPassed += await importedSyntheticRollbackChain(root);
    syntheticPassed += await importedSyntheticFailureChain(root);

    if (nativeEnvAvailable) {
      const sourceDcx = await resolveNativeFixture(nativeFixtureArg, 'emevd-primary', '../../mods/event/common.emevd.dcx');
      // Deterministic imported-registry leg: our synthetic DS3 JSON drives the
      // production write chain on the real registered common.emevd.
      await importedRealCorpusChain(root, sourceDcx, createSyntheticImportedEmedf(), 'synthetic-imported');
      realCorpusLegs += 1;
      if (emedfPathArg) {
        const realImport = importDs3EmedfFile(emedfPathArg);
        if (!realImport.ok) throw new Error(`real EMEDF import failed: ${realImport.message}`);
        await importedRealCorpusChain(root, sourceDcx, realImport.registry, 'real-emedf');
        realEmedfLegs += 1;
      } else {
        skipReasons.push('SOULFORGE_EMEDF_PATH 未设置且未提供 arg 3：真实 DarkScript3 EMEDF 文件缺失，真实导入 registry 的真实 corpus typed-mutation leg 结构化跳过（fail-closed）。');
      }
    } else {
      skipReasons.push('SOULFORGE_NATIVE_FIXTURE_REGISTRY/SOULFORGE_NATIVE_FIXTURE_ROOT 未设置：真实 common.emevd corpus leg 跳过。');
    }

    console.log(JSON.stringify({
      ok: true,
      message: '导入 EMEDF 驱动 production 写链 typed-mutation smoke 通过',
      syntheticCases: syntheticPassed,
      realCorpusLegs,
      realEmedfLegs,
      skips: skipReasons,
      assertions: {
        synthetic: 'imported registry → DSL typed plan → Bridge batch → PatchIR transaction → re-read byte-consistent；事件级 + 指令级 typed mutation；vararg 尾部逐字节保留；未知指令保持 opaque',
        rollback: 'after-commit validator 失败恢复原字节 + 审计 failure_recovery',
        failurePath: 'wrong expectedDocumentHash → EMEVD_STAGING_WRITE_FAILED，目标文件未触碰',
        realCorpus: '真实 common.emevd 事件级 id/rest + 2000:0 InitializeEvent eventId typed mutation，重读可观测且计数不变'
      },
      nonClaims: [
        'synthetic DS3 JSON 是自构微小样本，不构成 native 或真实 DarkScript3 完成声明。',
        '导入 schema 只覆盖真实 corpus 中 0:0 / 2000:0 两种指令族，其余保持 opaque/unsupported。',
        'authority 上限为 partial；不证明完整 EMEDF 类型覆盖、layer 或游戏加载。'
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
