/**
 * Production smoke: DSL typed plan → Bridge batch mutation → file_replace
 * PatchIR → WorkspaceTransaction (stage/validate/commit/backup/re-read/rollback).
 *
 * Sections:
 * - Synthetic success: full four-view submit chain against a tiny synthetic
 *   Sekiro EMEVD; asserts committed bytes re-read byte-consistently and the
 *   typed mutations are observable through the Bridge envelope.
 * - Synthetic rollback: Bridge-staged bytes committed through a transaction
 *   whose after-commit re-read validator fails; original bytes restored,
 *   staging cleaned, failure audited.
 * - Synthetic failure: wrong expectedDocumentHash is rejected with structured
 *   diagnostics and no file change.
 * - Synthetic outer-chain (EVENT-30C): the commit target is a DFLT-wrapped
 *   .dcx outer source resource; asserts sourceFormat=dcx, outer-hash byte
 *   consistency, payload identity preservation and observable typed mutations.
 * - Synthetic reopen-failure (EVENT-30C): a committed .dcx whose payload is
 *   corrupted cannot reopen → after-commit reopen validator rejects → the
 *   WorkspaceTransaction rolls the outer back to its before-image.
 * - Synthetic sibling-change (EVENT-30C): committing the outer target leaves a
 *   sibling .dcx in the same workspace byte-identical.
 * - Native variant (env-gated via with-local-has-game-env.mjs): the same
 *   production chain against the registered local common.emevd fixture with
 *   event-level typed mutations (id/rest). Honest skip when env is absent.
 *
 * Authority cap: partial. Synthetic fixture + registered native sample only;
 * no full EMEDF/layer/game-load claims.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { decompressDfltDcx } from '../util/dcxDflt.js';
import type { EmevdDslCompileRequest, ValidatorContract, ValidatorResult } from '@soulforge/shared';
import {
  createEmevdEditorDocument,
  submitEmevdDslPlanViaFourView
} from '../editing/emevdFourViewController.js';
import {
  buildEmevdFileReplacePatch,
  createEmevdReopenValidator,
  stageEmevdPlanViaBridge,
  type EmevdPlanStageResult
} from '../editing/emevdPlanCommit.js';
import { compileEmevdPatchDsl, fingerprintEmedfRegistry } from '../emevd/dslCompiler.js';
import { createSekiroFixtureEmedf } from '../emevd/emedfSchema.js';
import { formatEmevdAnchor } from '../emevd/stableIdentity.js';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { createWorkspaceTransaction } from '../transactions/workspaceTransaction.js';
import { createScaffoldValidators } from '../validators/index.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';
import {
  buildSyntheticEmevd,
  mutatedIfCondArgs,
  mutatedWaitForArgs,
  sha256Hex,
  standardSyntheticEmevd
} from './syntheticEmevdBytes.js';

interface EmevdEnvelope {
  sourceHash: string;
  /** "emevd" for raw payload; "dcx" when Bridge unwrapped a .dcx wrapper. */
  sourceFormat?: string;
  /** SHA-256 of the outer container bytes when opened from a .dcx. */
  outerFileHash?: string;
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

/**
 * Wrap an EMEVD payload in a DFLT-compressed DCX outer container (synthetic
 * fixture). Header layout mirrors bridge/SoulForge.Bridge/DcxNativeDocument.cs
 * expectations: DCX\0 magic, DCS\0 at 0x18, DCP\0 at 0x24, format at 0x28,
 * DCA sub-header at 0x30 with payload starting at 0x38.
 */
function compressDfltDcx(payload: Buffer): Buffer {
  const compressed = deflateSync(payload);
  const header = Buffer.alloc(0x38);
  header.write('DCX\0', 0, 'ascii');
  header.writeUInt32BE(0x02, 0x04); // version
  header.writeUInt32BE(0x02, 0x08); // unk
  header.writeUInt32BE(0, 0x0c);
  header.writeUInt32BE(0, 0x10);
  header.writeUInt32BE(0, 0x14);
  header.write('DCS\0', 0x18, 'ascii');
  header.writeUInt32BE(payload.length, 0x1c); // uncompressed size
  header.writeUInt32BE(compressed.length, 0x20); // compressed size
  header.write('DCP\0', 0x24, 'ascii');
  header.write('DFLT', 0x28, 'ascii');
  header.writeUInt32BE(0, 0x2c);
  header.write('DCA\0', 0x30, 'ascii');
  header.writeUInt32BE(8, 0x34); // dca length
  return Buffer.concat([header, compressed]);
}

function throwingAfterCommitValidator(): ValidatorContract {
  const fail = (): ValidatorResult => {
    throw new Error('injected after_commit re-read failure');
  };
  return {
    validatorId: 'emevd_plan_production_after_commit',
    targetResourceKinds: ['*'],
    validationScope: ['after_commit'],
    validateAfterCommit: fail
  };
}

function hashOf(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Canonical DSL patch for the synthetic fixture (id/rest/args). */
function canonicalDslSource(schemaFingerprint: string, document: ReturnType<typeof createEmevdEditorDocument>): string {
  const event0 = document.events[0]!;
  const instr0 = event0.instructions[0]!;
  const instr1 = event0.instructions[1]!;
  if (!event0.anchor || !instr0.anchor || !instr1.anchor) throw new Error('anchors missing');
  return `resource "file://event/common.emevd"
base revision 0 schema "${schemaFingerprint}"
event ${formatEmevdAnchor('event', event0.anchor)} {
  set id = 51;
  set rest = 1;
  instruction ${formatEmevdAnchor('instruction', instr0.anchor)} {
    set arg conditionGroup = -2;
  }
  instruction ${formatEmevdAnchor('instruction', instr1.anchor)} {
    set arg resultConditionGroup = 5;
    set arg desiredComparisonType = 1;
  }
}`;
}

function compileRequestFor(
  sourceText: string,
  schemaFingerprint: string,
  document: ReturnType<typeof createEmevdEditorDocument>
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

async function syntheticSuccessChain(root: string): Promise<number> {
  const registry = createSekiroFixtureEmedf();
  const schemaFingerprint = fingerprintEmedfRegistry(registry);
  const original = standardSyntheticEmevd();

  const overlayRoot = join(root, 'mod');
  const stagingRoot = join(root, 'staging');
  const backupRoot = join(root, 'backups');
  await mkdir(join(overlayRoot, 'event'), { recursive: true });
  await mkdir(stagingRoot, { recursive: true });
  await mkdir(backupRoot, { recursive: true });
  const target = join(overlayRoot, 'event', 'common.emevd');
  await writeFile(target, original);
  const sourceHash = sha256Hex(original);

  const document = createEmevdEditorDocument({
    resourceUri: 'file://event/common.emevd',
    documentInstanceId: 'emevd-plan-production-smoke',
    bytesBase64: original.toString('base64'),
    events: [
      {
        eventId: 50,
        restBehavior: 0,
        instructions: [
          { bank: 1000, id: 0, argsBase64: Buffer.from([0xff, 0, 0, 0, 0, 0, 0, 0]).toString('base64'), unknown: false },
          { bank: 2000, id: 0, argsBase64: Buffer.from([1, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64'), unknown: false },
          { bank: 9999, id: 1, argsBase64: '', unknown: true }
        ]
      },
      { eventId: 100, restBehavior: 0, instructions: [] }
    ]
  });

  const session = await openWorkspaceSession({ overlayRoot, game: 'sekiro' });

  // Bridge cross-check: source hash from read-emevd-document equals TS sha256.
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

  // Four-view production submit: DSL → plan → Bridge batch → PatchIR transaction → re-read.
  const compiled = compileEmevdPatchDsl(
    compileRequestFor(canonicalDslSource(schemaFingerprint, document), schemaFingerprint, document),
    document,
    registry
  );
  if (!compiled.ok || !compiled.plan) throw new Error(`compile failed: ${JSON.stringify(compiled.diagnostics)}`);
  if (compiled.plan.operations.length !== 5) {
    throw new Error(`expected 5 plan operations, got ${compiled.plan.operations.length}`);
  }

  const submitted = await submitEmevdDslPlanViaFourView({
    compileRequest: compileRequestFor(canonicalDslSource(schemaFingerprint, document), schemaFingerprint, document),
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
    title: 'emevd plan production smoke'
  });
  if (!submitted.ok || !submitted.commit) {
    throw new Error(`submit failed: ${JSON.stringify(submitted.diagnostics)}`);
  }
  const commit = submitted.commit;
  if (!commit.ok) throw new Error(`commit failed: ${JSON.stringify(commit.diagnostics)}`);
  if (commit.mutationCount !== 4) throw new Error(`expected 4 Bridge mutations, got ${commit.mutationCount}`);
  if (!commit.reRead) throw new Error('re-read report missing');
  if (!commit.reRead.ok) throw new Error(`re-read failed: ${JSON.stringify(commit.diagnostics)}`);
  if (!commit.reRead.byteConsistent) throw new Error('committed bytes are not byte-consistent');
  if (!commit.reRead.semanticIdentical) throw new Error('committed file semantic re-read failed');
  if (!commit.opId || !commit.committedPath) throw new Error('opId/committedPath missing');
  if (commit.committedPath !== target) throw new Error('committed path mismatch');
  if (!commit.diagnostics.some((d) => d.code === 'EMEVD_REREAD_VERIFIED')) {
    throw new Error('EMEVD_REREAD_VERIFIED missing');
  }

  // nextDocument: revision +1 with plan applied.
  if (!submitted.nextDocument) throw new Error('nextDocument missing');
  if (submitted.nextDocument.revision !== 1) throw new Error('nextDocument revision must be 1');
  if (submitted.nextDocument.events[0]!.eventId !== 51) throw new Error('event id not reflected');
  if (submitted.nextDocument.events[0]!.restBehavior !== 1) throw new Error('rest not reflected');

  // Byte-level: committed file hash equals the Bridge-staged output hash.
  const committedBytes = await readFile(target);
  if (hashOf(committedBytes) !== commit.outputHash) {
    throw new Error('committed file hash does not match staged output hash');
  }

  // Independent re-read: typed mutations observable through the Bridge envelope.
  const after = await runBridge<EmevdEnvelope>({
    command: 'read-emevd-document',
    filePath: target,
    allowedRoots: [overlayRoot, stagingRoot],
    timeoutMs: 120_000
  });
  if (after.parseStatus === 'failed') throw new Error('post-commit read failed');
  if (after.data!.sourceHash !== commit.reRead.outputHash) throw new Error('re-read hash mismatch');
  if (after.data!.eventCount !== 2 || after.data!.instructionCount !== 3) {
    throw new Error(`unexpected counts ${after.data!.eventCount}/${after.data!.instructionCount}`);
  }
  const renamed = after.data!.events.find((e) => e.id === 51);
  if (!renamed || renamed.restBehavior !== 1) throw new Error('renamed event/rest not observable');
  if (after.data!.events.some((e) => e.id === 50)) throw new Error('old event id still present');
  const sample0 = after.data!.instructionsSample?.find((i) => i.index === 0);
  const sample1 = after.data!.instructionsSample?.find((i) => i.index === 1);
  if (!sample0 || Buffer.from(sample0.argsBase64, 'base64').equals(mutatedWaitForArgs()) === false) {
    throw new Error('instruction 0 args not observable');
  }
  if (!sample1 || Buffer.from(sample1.argsBase64, 'base64').equals(mutatedIfCondArgs()) === false) {
    throw new Error('instruction 1 args not observable');
  }
  const unknownSample = after.data!.instructionsSample?.find((i) => i.index === 2);
  if (!unknownSample || unknownSample.bank !== 9999) throw new Error('unknown instruction must survive');

  return 1;
}

async function syntheticRollbackChain(root: string): Promise<number> {
  const registry = createSekiroFixtureEmedf();
  const schemaFingerprint = fingerprintEmedfRegistry(registry);
  const original = standardSyntheticEmevd();

  const overlayRoot = join(root, 'mod-rollback');
  const stagingRoot = join(root, 'staging-rollback');
  const backupRoot = join(root, 'backups-rollback');
  await mkdir(join(overlayRoot, 'event'), { recursive: true });
  await mkdir(stagingRoot, { recursive: true });
  await mkdir(backupRoot, { recursive: true });
  const target = join(overlayRoot, 'event', 'common.emevd');
  await writeFile(target, original);
  const sourceHash = sha256Hex(original);

  const document = createEmevdEditorDocument({
    resourceUri: 'file://event/common.emevd',
    documentInstanceId: 'emevd-plan-rollback-smoke',
    events: [
      {
        eventId: 50,
        restBehavior: 0,
        instructions: [
          { bank: 1000, id: 0, argsBase64: Buffer.from([0xff, 0, 0, 0, 0, 0, 0, 0]).toString('base64'), unknown: false },
          { bank: 2000, id: 0, argsBase64: Buffer.from([1, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64'), unknown: false },
          { bank: 9999, id: 1, argsBase64: '', unknown: true }
        ]
      },
      { eventId: 100, restBehavior: 0, instructions: [] }
    ]
  });
  const session = await openWorkspaceSession({ overlayRoot, game: 'sekiro' });

  // Stage the same DSL plan via Bridge batch.
  const staged: EmevdPlanStageResult = await stageEmevdPlanViaBridge({
    plan: (() => {
      const compiled = compileEmevdPatchDsl(
        compileRequestFor(canonicalDslSource(schemaFingerprint, document), schemaFingerprint, document),
        document,
        registry
      );
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

  // Commit with an after-commit re-read validator that fails → auto-rollback.
  const patch = buildEmevdFileReplacePatch({
    workspaceId: session.meta.workspaceId,
    title: 'emevd plan rollback production',
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
  if (!restored.equals(original)) {
    throw new Error('rollback did not restore original bytes');
  }
  const audit = transaction.getAuditLog().list({ transactionId: transaction.transactionId });
  if (!audit.some((entry) => entry.eventKind === 'failure_recovery')) {
    throw new Error('rollback failure was not audited');
  }
  return 1;
}

async function syntheticFailureChain(root: string): Promise<number> {
  const registry = createSekiroFixtureEmedf();
  const schemaFingerprint = fingerprintEmedfRegistry(registry);
  const original = standardSyntheticEmevd();

  const overlayRoot = join(root, 'mod-failure');
  const stagingRoot = join(root, 'staging-failure');
  await mkdir(join(overlayRoot, 'event'), { recursive: true });
  await mkdir(stagingRoot, { recursive: true });
  const target = join(overlayRoot, 'event', 'common.emevd');
  await writeFile(target, original);

  const document = createEmevdEditorDocument({
    resourceUri: 'file://event/common.emevd',
    documentInstanceId: 'emevd-plan-failure-smoke',
    events: [
      {
        eventId: 50,
        restBehavior: 0,
        instructions: [
          { bank: 1000, id: 0, argsBase64: Buffer.from([0xff, 0, 0, 0, 0, 0, 0, 0]).toString('base64'), unknown: false },
          { bank: 2000, id: 0, argsBase64: Buffer.from([1, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64'), unknown: false },
          { bank: 9999, id: 1, argsBase64: '', unknown: true }
        ]
      },
      { eventId: 100, restBehavior: 0, instructions: [] }
    ]
  });
  const session = await openWorkspaceSession({ overlayRoot, game: 'sekiro' });

  // Wrong expectedDocumentHash → Bridge rejects with structured diagnostics.
  const submitted = await submitEmevdDslPlanViaFourView({
    compileRequest: compileRequestFor(canonicalDslSource(schemaFingerprint, document), schemaFingerprint, document),
    document,
    registry,
    sourcePath: target,
    expectedDocumentHash: 'f'.repeat(64),
    allowedRoots: [overlayRoot, stagingRoot],
    workspaceId: session.meta.workspaceId,
    workspaceRoot: overlayRoot,
    stagingRoot,
    title: 'emevd plan failure smoke'
  });
  if (submitted.ok) throw new Error('wrong source hash must fail closed');
  if (!submitted.diagnostics.some((d) => d.severity === 'error')) {
    throw new Error('failure must carry structured error diagnostics');
  }
  if (!submitted.diagnostics.some((d) => d.code === 'EMEVD_STAGING_WRITE_FAILED')) {
    throw new Error(`expected EMEVD_STAGING_WRITE_FAILED: ${JSON.stringify(submitted.diagnostics)}`);
  }
  const untouched = await readFile(target);
  if (!untouched.equals(original)) {
    throw new Error('failed submission must not modify the target');
  }
  return 1;
}

/**
 * EVENT-30C outer-chain success: the commit target is a DFLT-wrapped .dcx outer
 * source resource. Bridge stages a rebuilt DCX (outerFileHash sealed), the
 * file_replace precondition compares against the on-disk .dcx bytes, and the
 * byte-consistency re-read compares outer container hashes.
 */
async function syntheticOuterChain(root: string): Promise<number> {
  const registry = createSekiroFixtureEmedf();
  const schemaFingerprint = fingerprintEmedfRegistry(registry);
  const payload = standardSyntheticEmevd();
  const outer = compressDfltDcx(payload);
  const payloadHash = sha256Hex(payload);
  const outerHash = hashOf(outer);

  const overlayRoot = join(root, 'mod-outer');
  const stagingRoot = join(root, 'staging-outer');
  const backupRoot = join(root, 'backups-outer');
  await mkdir(join(overlayRoot, 'event'), { recursive: true });
  await mkdir(stagingRoot, { recursive: true });
  await mkdir(backupRoot, { recursive: true });
  const target = join(overlayRoot, 'event', 'common.emevd.dcx');
  await writeFile(target, outer);

  // Bridge opens the .dcx outer: sourceFormat=dcx, outerFileHash == sealed outer
  // hash, sourceHash == payload hash.
  const before = await runBridge<EmevdEnvelope>({
    command: 'read-emevd-document',
    filePath: target,
    allowedRoots: [overlayRoot, stagingRoot],
    timeoutMs: 120_000
  });
  if (before.parseStatus === 'failed' || !before.data?.roundTrip?.semanticIdentical) {
    throw new Error(`synthetic DCX EMEVD rejected by Bridge: ${JSON.stringify(before.diagnostics)}`);
  }
  if (before.data.sourceFormat !== 'dcx') {
    throw new Error(`expected sourceFormat=dcx, got ${before.data.sourceFormat}`);
  }
  if (before.data.outerFileHash !== outerHash) {
    throw new Error(`outer hash mismatch: ${before.data.outerFileHash} vs ${outerHash}`);
  }
  if (before.data.sourceHash !== payloadHash) {
    throw new Error(`payload hash mismatch: ${before.data.sourceHash} vs ${payloadHash}`);
  }

  const document = createEmevdEditorDocument({
    resourceUri: 'file://event/common.emevd',
    documentInstanceId: 'emevd-plan-production-outer',
    bytesBase64: payload.toString('base64'),
    events: [
      {
        eventId: 50,
        restBehavior: 0,
        instructions: [
          { bank: 1000, id: 0, argsBase64: Buffer.from([0xff, 0, 0, 0, 0, 0, 0, 0]).toString('base64'), unknown: false },
          { bank: 2000, id: 0, argsBase64: Buffer.from([1, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64'), unknown: false },
          { bank: 9999, id: 1, argsBase64: '', unknown: true }
        ]
      },
      { eventId: 100, restBehavior: 0, instructions: [] }
    ]
  });

  const session = await openWorkspaceSession({ overlayRoot, game: 'sekiro' });

  const submitted = await submitEmevdDslPlanViaFourView({
    compileRequest: compileRequestFor(canonicalDslSource(schemaFingerprint, document), schemaFingerprint, document),
    document,
    registry,
    sourcePath: target,
    expectedDocumentHash: payloadHash,
    expectedOuterFileHash: outerHash,
    allowedRoots: [overlayRoot, stagingRoot],
    workspaceId: session.meta.workspaceId,
    workspaceRoot: overlayRoot,
    stagingRoot,
    backupBaseDir: backupRoot,
    session,
    title: 'emevd plan outer-chain smoke'
  });
  if (!submitted.ok || !submitted.commit) {
    throw new Error(`outer submit failed: ${JSON.stringify(submitted.diagnostics)}`);
  }
  const commit = submitted.commit;
  if (!commit.ok) throw new Error(`outer commit failed: ${JSON.stringify(commit.diagnostics)}`);
  if (commit.sourceFormat !== 'dcx') throw new Error(`expected commit sourceFormat=dcx, got ${commit.sourceFormat}`);
  if (!commit.outerFileHash || commit.outerFileHash !== commit.outputHash) {
    throw new Error('outer commit must expose outerFileHash == outputHash');
  }
  if (!commit.reRead?.ok) throw new Error(`outer re-read failed: ${JSON.stringify(commit.diagnostics)}`);
  if (!commit.reRead.byteConsistent) throw new Error('outer committed bytes are not byte-consistent (outer hash)');
  if (!commit.reRead.semanticIdentical) throw new Error('outer committed payload semantic re-read failed');

  // Committed file on disk is still a .dcx whose outer hash equals the staged output.
  const committedOuter = await readFile(target);
  if (hashOf(committedOuter) !== commit.outputHash) {
    throw new Error('committed .dcx outer hash does not match staged output hash');
  }
  // The rebuilt payload inside the committed .dcx reopens through the same
  // Bridge read boundary (payload identity preserved, outer identity replaced).
  const after = await runBridge<EmevdEnvelope>({
    command: 'read-emevd-document',
    filePath: target,
    allowedRoots: [overlayRoot, stagingRoot],
    timeoutMs: 120_000
  });
  if (after.parseStatus === 'failed') throw new Error('post-commit DCX read failed');
  if (after.data!.sourceFormat !== 'dcx') throw new Error('post-commit sourceFormat must stay dcx');
  if (after.data!.outerFileHash !== commit.outputHash) throw new Error('post-commit outer hash mismatch');
  if (after.data!.sourceHash !== sha256Hex(decompressDfltDcx(committedOuter))) {
    throw new Error('committed .dcx payload does not match Bridge re-read payload');
  }
  const renamed = after.data!.events.find((e) => e.id === 51);
  if (!renamed || renamed.restBehavior !== 1) throw new Error('outer renamed event/rest not observable');
  if (after.data!.events.some((e) => e.id === 50)) throw new Error('outer old event id still present');
  const sample0 = after.data!.instructionsSample?.find((i) => i.index === 0);
  const sample1 = after.data!.instructionsSample?.find((i) => i.index === 1);
  if (!sample0 || Buffer.from(sample0.argsBase64, 'base64').equals(mutatedWaitForArgs()) === false) {
    throw new Error('outer instruction 0 args not observable');
  }
  if (!sample1 || Buffer.from(sample1.argsBase64, 'base64').equals(mutatedIfCondArgs()) === false) {
    throw new Error('outer instruction 1 args not observable');
  }
  return 1;
}

/**
 * EVENT-30C reopen-failure: an after-commit Bridge reopen that cannot parse the
 * committed artifact fails the WorkspaceTransaction and rolls the .dcx outer
 * resource back to its before-image. The committed bytes here are deliberately
 * not a valid EMEVD/DCX, so the reopen validator must reject and roll back.
 */
async function syntheticReopenFailureChain(root: string): Promise<number> {
  const payload = standardSyntheticEmevd();
  const outer = compressDfltDcx(payload);
  const outerHash = hashOf(outer);

  const overlayRoot = join(root, 'mod-reopen-failure');
  const stagingRoot = join(root, 'staging-reopen-failure');
  const backupRoot = join(root, 'backups-reopen-failure');
  await mkdir(join(overlayRoot, 'event'), { recursive: true });
  await mkdir(stagingRoot, { recursive: true });
  await mkdir(backupRoot, { recursive: true });
  const target = join(overlayRoot, 'event', 'common.emevd.dcx');
  await writeFile(target, outer);

  const session = await openWorkspaceSession({ overlayRoot, game: 'sekiro' });

  // Stage a real plan through Bridge (the production staging boundary) so the
  // reopen-failure path is exercised end-to-end, then corrupt the staged bytes
  // so the after-commit Bridge reopen cannot succeed.
  const registry = createSekiroFixtureEmedf();
  const schemaFingerprint = fingerprintEmedfRegistry(registry);
  const document = createEmevdEditorDocument({
    resourceUri: 'file://event/common.emevd',
    documentInstanceId: 'emevd-plan-reopen-failure',
    bytesBase64: payload.toString('base64'),
    events: [
      {
        eventId: 50,
        restBehavior: 0,
        instructions: [
          { bank: 1000, id: 0, argsBase64: Buffer.from([0xff, 0, 0, 0, 0, 0, 0, 0]).toString('base64'), unknown: false },
          { bank: 2000, id: 0, argsBase64: Buffer.from([1, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64'), unknown: false },
          { bank: 9999, id: 1, argsBase64: '', unknown: true }
        ]
      },
      { eventId: 100, restBehavior: 0, instructions: [] }
    ]
  });
  const compiled = compileEmevdPatchDsl(
    compileRequestFor(canonicalDslSource(schemaFingerprint, document), schemaFingerprint, document),
    document,
    registry
  );
  if (!compiled.ok || !compiled.plan) throw new Error('reopen-failure compile failed');
  const staged: EmevdPlanStageResult = await stageEmevdPlanViaBridge({
    plan: compiled.plan,
    document,
    registry,
    sourcePath: target,
    expectedDocumentHash: sha256Hex(payload),
    allowedRoots: [overlayRoot, stagingRoot],
    stagingRoot,
    timeoutMs: 120_000
  });
  if (!staged.ok || !staged.bytes) {
    throw new Error(`reopen-failure staging failed: ${JSON.stringify(staged.diagnostics)}`);
  }
  if (staged.sourceFormat !== 'dcx') throw new Error('staged artifact must be a dcx outer');
  // Corrupt the staged bytes: flip a payload byte so the rebuilt outer cannot
  // reopen as EMEVD (zlib decompression or EMEVD parse must fail).
  const corrupted = Buffer.from(staged.bytes);
  const corruptAt = 0x38 + Math.floor(corrupted.length * 0.6);
  const originalByte = corrupted[corruptAt] ?? 0;
  corrupted[corruptAt] = originalByte ^ 0xff;

  const patch = buildEmevdFileReplacePatch({
    workspaceId: session.meta.workspaceId,
    title: 'emevd reopen failure production',
    targetUri: 'file://event/common.emevd.dcx',
    targetPath: target,
    stagedBytes: corrupted,
    expectedHash: outerHash
  });
  const transaction = createWorkspaceTransaction({
    workspaceId: session.meta.workspaceId,
    workspaceRoot: overlayRoot,
    stagingBaseDir: stagingRoot,
    backupBaseDir: backupRoot,
    validators: [
      ...createScaffoldValidators(),
      createEmevdReopenValidator({ allowedRoots: [overlayRoot, stagingRoot] })
    ]
  });
  if (!transaction.addPatch(patch).ok) throw new Error('reopen-failure patch admission failed');
  const stagedResult = await transaction.stage();
  if (!stagedResult.ok) throw new Error(`reopen-failure stage failed: ${JSON.stringify(stagedResult.diagnostics)}`);
  const validated = await transaction.validate();
  if (!validated.ok) throw new Error(`reopen-failure validate failed: ${JSON.stringify(validated.diagnostics)}`);
  const committed = await transaction.commit();
  if (committed.ok || committed.committedPaths.length !== 0) {
    throw new Error('reopen-failure must not leave committed files');
  }
  if (!committed.diagnostics.some((d) => d.code === 'EMEVD_REOPEN_FAILED')) {
    throw new Error(`missing EMEVD_REOPEN_FAILED: ${JSON.stringify(committed.diagnostics)}`);
  }
  if (transaction.getStatus() !== 'failed') {
    throw new Error(`reopen-failure transaction status ${transaction.getStatus()}, expected failed`);
  }
  const restored = await readFile(target);
  if (!restored.equals(outer)) {
    throw new Error('reopen-failure rollback did not restore the original .dcx outer bytes');
  }
  const audit = transaction.getAuditLog().list({ transactionId: transaction.transactionId });
  if (!audit.some((entry) => entry.eventKind === 'failure_recovery')) {
    throw new Error('reopen-failure rollback was not audited');
  }
  return 1;
}

/**
 * EVENT-30C sibling-change: committing the outer target must leave a sibling
 * resource in the same workspace byte-identical (the write path is scoped to
 * the target file only).
 */
async function syntheticSiblingChain(root: string): Promise<number> {
  const registry = createSekiroFixtureEmedf();
  const schemaFingerprint = fingerprintEmedfRegistry(registry);
  const payload = standardSyntheticEmevd();
  const outer = compressDfltDcx(payload);
  const siblingPayload = buildSyntheticEmevd([
    { id: 100, restBehavior: 1, instructions: [{ bank: 1000, id: 0, args: Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]) }] }
  ]);
  const siblingOuter = compressDfltDcx(siblingPayload);
  const siblingOuterHash = hashOf(siblingOuter);

  const overlayRoot = join(root, 'mod-sibling');
  const stagingRoot = join(root, 'staging-sibling');
  const backupRoot = join(root, 'backups-sibling');
  await mkdir(join(overlayRoot, 'event'), { recursive: true });
  await mkdir(stagingRoot, { recursive: true });
  await mkdir(backupRoot, { recursive: true });
  const target = join(overlayRoot, 'event', 'common.emevd.dcx');
  const sibling = join(overlayRoot, 'event', 'menu.emevd.dcx');
  await writeFile(target, outer);
  await writeFile(sibling, siblingOuter);

  const document = createEmevdEditorDocument({
    resourceUri: 'file://event/common.emevd',
    documentInstanceId: 'emevd-plan-production-sibling',
    bytesBase64: payload.toString('base64'),
    events: [
      {
        eventId: 50,
        restBehavior: 0,
        instructions: [
          { bank: 1000, id: 0, argsBase64: Buffer.from([0xff, 0, 0, 0, 0, 0, 0, 0]).toString('base64'), unknown: false },
          { bank: 2000, id: 0, argsBase64: Buffer.from([1, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64'), unknown: false },
          { bank: 9999, id: 1, argsBase64: '', unknown: true }
        ]
      },
      { eventId: 100, restBehavior: 0, instructions: [] }
    ]
  });

  const session = await openWorkspaceSession({ overlayRoot, game: 'sekiro' });

  const submitted = await submitEmevdDslPlanViaFourView({
    compileRequest: compileRequestFor(canonicalDslSource(schemaFingerprint, document), schemaFingerprint, document),
    document,
    registry,
    sourcePath: target,
    expectedDocumentHash: sha256Hex(payload),
    expectedOuterFileHash: hashOf(outer),
    allowedRoots: [overlayRoot, stagingRoot],
    workspaceId: session.meta.workspaceId,
    workspaceRoot: overlayRoot,
    stagingRoot,
    backupBaseDir: backupRoot,
    session,
    title: 'emevd plan sibling smoke'
  });
  if (!submitted.ok || !submitted.commit?.ok) {
    throw new Error(`sibling submit failed: ${JSON.stringify(submitted.diagnostics)}`);
  }
  // Target mutated; sibling bytes must be byte-identical.
  const targetBytes = await readFile(target);
  if (targetBytes.equals(outer)) throw new Error('sibling target must be mutated');
  const siblingBytes = await readFile(sibling);
  if (hashOf(siblingBytes) !== siblingOuterHash) {
    throw new Error('sibling .dcx outer bytes changed');
  }
  if (!siblingBytes.equals(siblingOuter)) throw new Error('sibling .dcx outer bytes are not byte-identical');
  const siblingAfter = await runBridge<EmevdEnvelope>({
    command: 'read-emevd-document',
    filePath: sibling,
    allowedRoots: [overlayRoot, stagingRoot],
    timeoutMs: 120_000
  });
  if (siblingAfter.parseStatus === 'failed') throw new Error('sibling reopen failed');
  if (siblingAfter.data!.sourceHash !== sha256Hex(siblingPayload)) {
    throw new Error('sibling payload changed');
  }
  return 1;
}

async function nativeChain(root: string, fixturePathArg: string | undefined): Promise<number> {
  const registry = createSekiroFixtureEmedf();
  const schemaFingerprint = fingerprintEmedfRegistry(registry);

  const overlayRoot = join(root, 'mod-native');
  const stagingRoot = join(root, 'staging-native');
  await mkdir(join(overlayRoot, 'event'), { recursive: true });
  await mkdir(stagingRoot, { recursive: true });

  const sourceDcx = await resolveNativeFixture(
    fixturePathArg,
    'emevd-primary',
    '../../mods/event/common.emevd.dcx'
  );
  const dcxBytes = await readFile(sourceDcx);
  const target = join(overlayRoot, 'event', 'common.emevd.dcx');
  // Keep the real outer bytes intact.  Sekiro's installed common.emevd.dcx is
  // KRAK on this machine; decompression and re-wrapping here would bypass the
  // Bridge/DCX authority and would turn a production smoke into a DFLT test.
  await writeFile(target, dcxBytes);
  const sourceOuterHash = hashOf(dcxBytes);
  const oodleRuntimeRoot = process.env.SOULFORGE_OODLE_RUNTIME_ROOT?.trim()
    || process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();

  const envelope = await runBridge<EmevdEnvelope>({
    command: 'read-emevd-document',
    filePath: target,
    allowedRoots: [overlayRoot, stagingRoot, ...(oodleRuntimeRoot ? [oodleRuntimeRoot] : [])],
    ...(oodleRuntimeRoot ? { oodleRuntimeRoot } : {}),
    timeoutMs: 120_000
  });
  if (envelope.parseStatus === 'failed' || !envelope.data) {
    throw new Error(`native EMEVD read failed: ${JSON.stringify(envelope.diagnostics)}`);
  }
  if (envelope.data.sourceFormat !== 'dcx') {
    throw new Error(`native sourceFormat must stay dcx, got ${envelope.data.sourceFormat}`);
  }
  if (envelope.data.outerFileHash !== sourceOuterHash) {
    throw new Error(`native outer hash mismatch: ${envelope.data.outerFileHash} vs ${sourceOuterHash}`);
  }
  const targetEvent = envelope.data.events.find((e) => e.id !== 0 && e.instructionCount !== 0)
    ?? envelope.data.events.find((e) => e.id !== 0)
    ?? envelope.data.events[0]!;
  const newId = 9_000_003;
  if (envelope.data.events.some((e) => e.id === newId)) {
    throw new Error(`native event id ${newId} already exists`);
  }
  const newRest = targetEvent.restBehavior === 0 ? 1 : 0;

  // Event-level typed mutations only (global instruction indices are not
  // derivable from the sampled envelope, so instructions stay untouched).
  const document = createEmevdEditorDocument({
    resourceUri: 'file://event/common.emevd',
    documentInstanceId: 'emevd-plan-production-native',
    events: envelope.data.events.map((e) => ({ eventId: e.id, restBehavior: e.restBehavior }))
  });
  const event = document.events.find((e) => e.eventId === targetEvent.id);
  if (!event?.anchor) throw new Error('target event anchor missing');
  const source = `resource "file://event/common.emevd"
base revision 0 schema "${schemaFingerprint}"
event ${formatEmevdAnchor('event', event.anchor)} {
  set rest = ${newRest};
  set id = ${newId};
}`;

  const session = await openWorkspaceSession({ overlayRoot, game: 'sekiro' });
  const submitted = await submitEmevdDslPlanViaFourView({
    compileRequest: compileRequestFor(source, schemaFingerprint, document),
    document,
    registry,
    sourcePath: target,
    expectedDocumentHash: envelope.data.sourceHash,
    expectedOuterFileHash: sourceOuterHash,
    allowedRoots: [overlayRoot, stagingRoot, ...(oodleRuntimeRoot ? [oodleRuntimeRoot] : [])],
    workspaceId: session.meta.workspaceId,
    workspaceRoot: overlayRoot,
    stagingRoot,
    ...(oodleRuntimeRoot ? { oodleRuntimeRoot } : {}),
    title: 'emevd plan native smoke'
  });
  if (!submitted.ok || !submitted.commit) {
    throw new Error(`native submit failed: ${JSON.stringify(submitted.diagnostics)}`);
  }
  if (!submitted.commit.ok || !submitted.commit.reRead?.ok) {
    throw new Error(`native commit/re-read failed: ${JSON.stringify(submitted.commit.diagnostics)}`);
  }
  if (!submitted.commit.reRead.byteConsistent) {
    throw new Error('native committed bytes are not byte-consistent');
  }
  const after = await runBridge<EmevdEnvelope>({
    command: 'read-emevd-document',
    filePath: target,
    allowedRoots: [overlayRoot, stagingRoot, ...(oodleRuntimeRoot ? [oodleRuntimeRoot] : [])],
    ...(oodleRuntimeRoot ? { oodleRuntimeRoot } : {}),
    timeoutMs: 120_000
  });
  if (after.parseStatus === 'failed') throw new Error('native post-commit read failed');
  const renamed = after.data!.events.find((e) => e.id === newId);
  if (!renamed || renamed.restBehavior !== newRest) {
    throw new Error(`native mutation not observable: ${JSON.stringify(after.data!.events.find((e) => e.id === targetEvent.id))}`);
  }
  if (after.data!.events.some((e) => e.id === targetEvent.id)) {
    throw new Error('native old event id still present');
  }
  if (after.data!.eventCount !== envelope.data.eventCount) {
    throw new Error('native event count changed unexpectedly');
  }
  if (after.data!.instructionCount !== envelope.data.instructionCount) {
    throw new Error('native instruction count changed unexpectedly');
  }
  if (!submitted.nextDocument?.diagnostics.some((d) => d.code === 'EMEVD_CANONICAL_REREAD')) {
    throw new Error('native nextDocument must come from canonical Bridge reread');
  }
  return 1;
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-emevd-plan-production-'));
  const nativeFixtureArg = process.argv[2]?.trim() || undefined;
  const nativeEnvAvailable = Boolean(
    (process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY?.trim() && process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim())
    || nativeFixtureArg
  );
  let syntheticPassed = 0;
  let nativePassed = 0;
  let nativeSkipped = false;
  try {
    syntheticPassed += await syntheticSuccessChain(root);
    syntheticPassed += await syntheticRollbackChain(root);
    syntheticPassed += await syntheticFailureChain(root);
    syntheticPassed += await syntheticOuterChain(root);
    syntheticPassed += await syntheticReopenFailureChain(root);
    syntheticPassed += await syntheticSiblingChain(root);

    if (nativeEnvAvailable) {
      nativePassed += await nativeChain(root, nativeFixtureArg);
    } else {
      nativeSkipped = true;
    }

    console.log(JSON.stringify({
      ok: true,
      message: nativeSkipped
        ? 'EMEVD DSL plan → Bridge batch → PatchIR transaction production smoke: ok (native variant skipped)'
        : 'EMEVD DSL plan → Bridge batch → PatchIR transaction production smoke: ok (synthetic + native)',
      syntheticCases: syntheticPassed,
      nativeCases: nativePassed,
      nativeSkipped,
      nativeSkipReason: nativeSkipped
        ? 'SOULFORGE_NATIVE_FIXTURE_REGISTRY/SOULFORGE_NATIVE_FIXTURE_ROOT 未设置；通过 node scripts/with-local-has-game-env.mjs 运行可注入本机 corpus 环境。'
        : undefined,
      assertions: {
        byteConsistency: 'committed hash == Bridge staged output hash == re-read source hash',
        rollback: 'after-commit validator failure restores original bytes, staging cleaned, failure audited',
        failurePath: 'wrong expectedDocumentHash → structured EMEVD_STAGING_WRITE_FAILED, target untouched',
        outerChain: 'dcx outer target → sourceFormat=dcx, outer-hash byte consistency, payload identity preserved, typed mutations observable',
        reopenFailure: 'corrupted committed .dcx → after-commit reopen rejects → outer rolled back to before-image',
        siblingChange: 'target .dcx mutated; sibling .dcx in same workspace byte-identical',
        native: nativeSkipped ? 'skipped' : 'registered local common.emevd event-level typed mutation + re-read'
      },
      nonClaims: [
        'synthetic fixture 是微小合法构造样本，不构成 native 完成声明。',
        'native 变体只覆盖事件级 typed mutation，不覆盖全局指令索引或完整 EMEDF/layer/游戏加载。',
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
