/**
 * Smoke: EMEVD DSL plan → Bridge mutation conversion and PatchIR commit wiring.
 *
 * Covers:
 * - planToBridgeMutations ordering (instruction args → rest behavior → event ID)
 * - EMEDF typed arg encoding into argsBase64
 * - Multiple arg changes on the same instruction merged into one Bridge mutation
 * - Global instruction index mapping from anchors
 * - Empty plan produces zero mutations
 * - Missing anchor fails closed
 * - Unknown instruction args are never re-encoded
 * - Full DSL → compile → plan → Bridge mutations pipeline
 * - buildEmevdFileReplacePatch op shape (hash precondition, validators, risk)
 * - PatchIR transaction rollback restores original bytes (after-commit validator failure)
 * - applyEmevdPlanToDocument applies the committed plan (revision +1)
 * - planToBridgeMutations structured failure on missing anchors
 * - Four-view submit entry: no-op plan short-circuits, stale revision fails closed
 *
 * Does NOT invoke the Bridge daemon at runtime (the Bridge/PatchIR production
 * chain is covered by runEmevdPlanCommitProductionSmoke.ts).
 * Authority cap: partial; only covers actual wired mutations, not full EMEDF/layer/game-load.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EmevdDslCompileRequest, EmevdMutationPlan, ValidatorContract, ValidatorResult } from '@soulforge/shared';
import {
  applyEmevdPlanToDocument,
  createEmevdEditorDocument,
  submitEmevdDslPlanViaFourView
} from '../editing/emevdFourViewController.js';
import {
  compileEmevdPatchDsl,
  fingerprintEmedfRegistry
} from '../emevd/dslCompiler.js';
import {
  createSekiroFixtureEmedf,
  encodeInstructionArgs
} from '../emevd/emedfSchema.js';
import { formatEmevdAnchor } from '../emevd/stableIdentity.js';
import {
  buildEmevdFileReplacePatch,
  planToBridgeMutations
} from '../editing/emevdPlanCommit.js';
import { createWorkspaceTransaction } from '../transactions/workspaceTransaction.js';
import { createScaffoldValidators } from '../validators/index.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import {
  mutatedIfCondArgs,
  mutatedWaitForArgs,
  sha256Hex,
  standardSyntheticEmevd
} from './syntheticEmevdBytes.js';

function throwingAfterCommitValidator(): ValidatorContract {
  const fail = (): ValidatorResult => {
    throw new Error('injected after_commit re-read failure');
  };
  return {
    validatorId: 'emevd_plan_smoke_after_commit',
    targetResourceKinds: ['*'],
    validationScope: ['after_commit'],
    validateAfterCommit: fail
  };
}

async function main(): Promise<void> {
  const registry = createSekiroFixtureEmedf();
  const schemaFingerprint = fingerprintEmedfRegistry(registry);

  const encodedWaitFor = encodeInstructionArgs(registry, 1000, 0, {
    conditionGroup: -1, pad0: 0, pad1: 0, unknown: 0
  });
  if (!encodedWaitFor.ok) throw new Error(JSON.stringify(encodedWaitFor));

  const encodedIfCond = encodeInstructionArgs(registry, 2000, 0, {
    resultConditionGroup: 1, desiredComparisonType: 0, targetConditionGroup: 2,
    pad0: 0, pad1: 0, pad2: 0
  });
  if (!encodedIfCond.ok) throw new Error(JSON.stringify(encodedIfCond));

  const document = createEmevdEditorDocument({
    resourceUri: 'file://event/common.emevd',
    documentInstanceId: 'emevd-plan-commit-smoke',
    events: [
      {
        eventId: 50,
        restBehavior: 0,
        instructions: [
          { bank: 1000, id: 0, argsBase64: encodedWaitFor.args.toString('base64'), unknown: false },
          { bank: 2000, id: 0, argsBase64: encodedIfCond.args.toString('base64'), unknown: false },
          { bank: 9999, id: 1, argsBase64: '', unknown: true }
        ]
      },
      { eventId: 100, restBehavior: 0, instructions: [] }
    ]
  });

  const event0 = document.events[0]!;
  const event1 = document.events[1]!;
  const instr0 = event0.instructions[0]!;
  const instr1 = event0.instructions[1]!;
  if (!document.documentInstanceId || !event0.anchor || !event1.anchor
    || !instr0.anchor || !instr1.anchor) {
    throw new Error('stable identity missing');
  }

  const eventAnchor0 = formatEmevdAnchor('event', event0.anchor);
  const eventAnchor1 = formatEmevdAnchor('event', event1.anchor);
  const instrAnchor0 = formatEmevdAnchor('instruction', instr0.anchor);
  const instrAnchor1 = formatEmevdAnchor('instruction', instr1.anchor);

  let passed = 0;

  // --- Case 1: Full pipeline DSL → compile → plan → Bridge mutations ---
  {
    const source = `resource "file://event/common.emevd"
base revision 0 schema "${schemaFingerprint}"
event ${eventAnchor0} {
  set id = 51;
  set rest = 1;
  instruction ${instrAnchor0} {
    set arg conditionGroup = -2;
  }
  instruction ${instrAnchor1} {
    set arg resultConditionGroup = 5;
    set arg desiredComparisonType = 1;
  }
}`;
    const request: EmevdDslCompileRequest = {
      schemaVersion: 1,
      resourceUri: document.resourceUri,
      documentInstanceId: document.documentInstanceId,
      baseRevision: document.revision,
      emedfSchemaFingerprint: schemaFingerprint,
      sourceText: source,
      mode: 'patch'
    };
    const compiled = compileEmevdPatchDsl(request, document, registry);
    if (!compiled.ok) throw new Error(`compile failed: ${JSON.stringify(compiled.diagnostics)}`);
    // 1 set_event_id + 1 set_rest_behavior + 3 set_instruction_arg = 5 operations
    if (compiled.plan.operations.length !== 5) {
      throw new Error(`expected 5 operations, got ${compiled.plan.operations.length}`);
    }

    const converted = planToBridgeMutations(compiled.plan, document, registry);
    if (!converted.ok) throw new Error(`conversion failed: ${converted.code} ${converted.message}`);
    // 2 instruction mutations (grouped) + 1 rest + 1 id = 4 Bridge mutations
    if (converted.mutations.length !== 4) {
      throw new Error(`expected 4 Bridge mutations, got ${converted.mutations.length}`);
    }

    // Ordering: instruction args first (order 0), then rest (order 1), then id (order 2)
    const kinds = converted.mutations.map((m) => m.kind);
    if (kinds[0] !== 'set_instruction_args' || kinds[1] !== 'set_instruction_args') {
      throw new Error(`instruction args must come first, got ${JSON.stringify(kinds)}`);
    }
    if (kinds[2] !== 'set_rest_behavior') {
      throw new Error(`rest behavior must be third, got ${JSON.stringify(kinds)}`);
    }
    if (kinds[3] !== 'update_id') {
      throw new Error(`update_id must be last, got ${JSON.stringify(kinds)}`);
    }

    // Verify instruction args mutation for instr0 (global index 0)
    const instrMut0 = converted.mutations[0] as { kind: 'set_instruction_args'; instructionIndex: number; argsBase64: string };
    if (instrMut0.instructionIndex !== 0) {
      throw new Error(`instr0 global index must be 0, got ${instrMut0.instructionIndex}`);
    }
    // Verify the encoded args contain conditionGroup = -2
    const decodedArgs0 = Buffer.from(instrMut0.argsBase64, 'base64');
    if (decodedArgs0.readInt8(0) !== -2) {
      throw new Error(`conditionGroup must be -2, got ${decodedArgs0.readInt8(0)}`);
    }

    // Verify instruction args mutation for instr1 (global index 1)
    const instrMut1 = converted.mutations[1] as { kind: 'set_instruction_args'; instructionIndex: number; argsBase64: string };
    if (instrMut1.instructionIndex !== 1) {
      throw new Error(`instr1 global index must be 1, got ${instrMut1.instructionIndex}`);
    }
    // Two args merged: resultConditionGroup=5, desiredComparisonType=1
    const decodedArgs1 = Buffer.from(instrMut1.argsBase64, 'base64');
    if (decodedArgs1.readInt8(0) !== 5) {
      throw new Error(`resultConditionGroup must be 5, got ${decodedArgs1.readInt8(0)}`);
    }
    if (decodedArgs1.readUInt8(1) !== 1) {
      throw new Error(`desiredComparisonType must be 1, got ${decodedArgs1.readUInt8(1)}`);
    }
    // targetConditionGroup must remain unchanged (2)
    if (decodedArgs1.readInt8(2) !== 2) {
      throw new Error(`targetConditionGroup must remain 2, got ${decodedArgs1.readInt8(2)}`);
    }

    // Verify rest behavior mutation
    const restMut = converted.mutations[2] as { kind: 'set_rest_behavior'; eventId: number; restBehavior: number };
    if (restMut.eventId !== 50 || restMut.restBehavior !== 1) {
      throw new Error(`rest mutation must be eventId=50 restBehavior=1`);
    }

    // Verify update_id mutation uses original eventId (before rename)
    const idMut = converted.mutations[3] as { kind: 'update_id'; eventId: number; newEventId: number };
    if (idMut.eventId !== 50 || idMut.newEventId !== 51) {
      throw new Error(`id mutation must be eventId=50 → 51`);
    }

    passed++;
  }

  // --- Case 2: Empty plan produces zero mutations ---
  {
    const source = `resource "file://event/common.emevd"
base revision 0 schema "${schemaFingerprint}"
event ${eventAnchor0} {
  set id = 50;
  set rest = 0;
  instruction ${instrAnchor0} {
    set arg conditionGroup = -1;
  }
}`;
    const request: EmevdDslCompileRequest = {
      schemaVersion: 1,
      resourceUri: document.resourceUri,
      documentInstanceId: document.documentInstanceId,
      baseRevision: document.revision,
      emedfSchemaFingerprint: schemaFingerprint,
      sourceText: source,
      mode: 'patch'
    };
    const compiled = compileEmevdPatchDsl(request, document, registry);
    if (!compiled.ok) throw new Error(`no-op compile failed: ${JSON.stringify(compiled.diagnostics)}`);
    if (compiled.plan.operations.length !== 0) {
      throw new Error('no-op plan must have zero operations');
    }
    const converted = planToBridgeMutations(compiled.plan, document, registry);
    if (!converted.ok) throw new Error(`empty conversion failed: ${converted.code}`);
    if (converted.mutations.length !== 0) {
      throw new Error('empty plan must produce zero Bridge mutations');
    }
    passed++;
  }

  // --- Case 3: Only rest behavior change (no instruction args) ---
  {
    const source = `resource "file://event/common.emevd"
base revision 0 schema "${schemaFingerprint}"
event ${eventAnchor1} {
  set rest = 3;
}`;
    const request: EmevdDslCompileRequest = {
      schemaVersion: 1,
      resourceUri: document.resourceUri,
      documentInstanceId: document.documentInstanceId,
      baseRevision: document.revision,
      emedfSchemaFingerprint: schemaFingerprint,
      sourceText: source,
      mode: 'patch'
    };
    const compiled = compileEmevdPatchDsl(request, document, registry);
    if (!compiled.ok) throw new Error(`rest-only compile failed: ${JSON.stringify(compiled.diagnostics)}`);
    if (compiled.plan.operations.length !== 1) throw new Error('expected 1 operation');
    const converted = planToBridgeMutations(compiled.plan, document, registry);
    if (!converted.ok) throw new Error(`rest-only conversion failed: ${converted.code}`);
    if (converted.mutations.length !== 1) throw new Error('expected 1 Bridge mutation');
    if (converted.mutations[0]!.kind !== 'set_rest_behavior') throw new Error('expected set_rest_behavior');
    const m = converted.mutations[0] as { eventId: number; restBehavior: number };
    if (m.eventId !== 100 || m.restBehavior !== 3) throw new Error('wrong rest mutation values');
    passed++;
  }

  // --- Case 4: Only event ID change ---
  {
    const source = `resource "file://event/common.emevd"
base revision 0 schema "${schemaFingerprint}"
event ${eventAnchor1} {
  set id = 200;
}`;
    const request: EmevdDslCompileRequest = {
      schemaVersion: 1,
      resourceUri: document.resourceUri,
      documentInstanceId: document.documentInstanceId,
      baseRevision: document.revision,
      emedfSchemaFingerprint: schemaFingerprint,
      sourceText: source,
      mode: 'patch'
    };
    const compiled = compileEmevdPatchDsl(request, document, registry);
    if (!compiled.ok) throw new Error(`id-only compile failed: ${JSON.stringify(compiled.diagnostics)}`);
    const converted = planToBridgeMutations(compiled.plan, document, registry);
    if (!converted.ok) throw new Error(`id-only conversion failed: ${converted.code}`);
    if (converted.mutations.length !== 1) throw new Error('expected 1 Bridge mutation');
    if (converted.mutations[0]!.kind !== 'update_id') throw new Error('expected update_id');
    passed++;
  }

  // --- Case 5: Unknown instruction is never re-encoded ---
  {
    const unknownInstr = event0.instructions[2]!;
    if (!unknownInstr.anchor) throw new Error('unknown instruction anchor missing');
    const unknownAnchor = formatEmevdAnchor('instruction', unknownInstr.anchor);
    const source = `resource "file://event/common.emevd"
base revision 0 schema "${schemaFingerprint}"
event ${eventAnchor0} {
  instruction ${unknownAnchor} {
    set arg value = 1;
  }
}`;
    const request: EmevdDslCompileRequest = {
      schemaVersion: 1,
      resourceUri: document.resourceUri,
      documentInstanceId: document.documentInstanceId,
      baseRevision: document.revision,
      emedfSchemaFingerprint: schemaFingerprint,
      sourceText: source,
      mode: 'patch'
    };
    const compiled = compileEmevdPatchDsl(request, document, registry);
    // The compiler rejects unknown instruction writes
    if (compiled.ok) throw new Error('unknown instruction write must fail');
    if (!compiled.diagnostics.some((d) => d.code === 'EMEVD_DSL_UNKNOWN_INSTRUCTION_READONLY')) {
      throw new Error('expected EMEVD_DSL_UNKNOWN_INSTRUCTION_READONLY');
    }
    passed++;
  }

  // --- Case 6: Multiple args on same instruction are merged ---
  {
    const source = `resource "file://event/common.emevd"
base revision 0 schema "${schemaFingerprint}"
event ${eventAnchor0} {
  instruction ${instrAnchor0} {
    set arg conditionGroup = 5;
    set arg pad0 = 1;
  }
}`;
    const request: EmevdDslCompileRequest = {
      schemaVersion: 1,
      resourceUri: document.resourceUri,
      documentInstanceId: document.documentInstanceId,
      baseRevision: document.revision,
      emedfSchemaFingerprint: schemaFingerprint,
      sourceText: source,
      mode: 'patch'
    };
    const compiled = compileEmevdPatchDsl(request, document, registry);
    if (!compiled.ok) throw new Error(`multi-arg compile failed: ${JSON.stringify(compiled.diagnostics)}`);
    // Two set_instruction_arg operations on the same instruction
    if (compiled.plan.operations.length !== 2) throw new Error('expected 2 operations');
    if (compiled.plan.operations[0]!.kind !== 'set_instruction_arg'
      || compiled.plan.operations[1]!.kind !== 'set_instruction_arg') {
      throw new Error('both must be set_instruction_arg');
    }
    const converted = planToBridgeMutations(compiled.plan, document, registry);
    if (!converted.ok) throw new Error(`multi-arg conversion failed: ${converted.code}`);
    // Merged into a single Bridge mutation
    if (converted.mutations.length !== 1) {
      throw new Error(`two args on same instruction must merge to 1 Bridge mutation, got ${converted.mutations.length}`);
    }
    const m = converted.mutations[0] as { kind: 'set_instruction_args'; instructionIndex: number; argsBase64: string };
    if (m.kind !== 'set_instruction_args') throw new Error('expected set_instruction_args');
    if (m.instructionIndex !== 0) throw new Error('global index must be 0');
    const decoded = Buffer.from(m.argsBase64, 'base64');
    if (decoded.readInt8(0) !== 5) throw new Error('conditionGroup must be 5');
    if (decoded.readUInt8(1) !== 1) throw new Error('pad0 must be 1');
    passed++;
  }

  // --- Case 7: Document is not mutated by conversion ---
  {
    if (document.events[0]!.eventId !== 50) throw new Error('document must not be mutated');
    if (document.revision !== 0) throw new Error('revision must not change');
    passed++;
  }

  // --- Case 8: buildEmevdFileReplacePatch op shape ---
  {
    const stagedBytes = Buffer.from('staged-emevd-bytes-0123456789');
    const expectedHash = 'a'.repeat(64);
    const patch = buildEmevdFileReplacePatch({
      workspaceId: 'w-smoke',
      title: 'emevd plan smoke',
      targetUri: 'file://event/common.emevd',
      targetPath: join('w-smoke', 'event', 'common.emevd'),
      stagedBytes,
      expectedHash
    });
    if (patch.operations.length !== 1) throw new Error('expected 1 operation');
    const op = patch.operations[0] as Extract<typeof patch.operations[number], { kind: 'file_replace' }>;
    if (op.kind !== 'file_replace') throw new Error('expected file_replace');
    if (op.expectedHash !== expectedHash) throw new Error('expectedHash must be preserved');
    if (op.newContentBase64 !== stagedBytes.toString('base64')) throw new Error('payload mismatch');
    if (op.resourceKind !== 'event') throw new Error('resourceKind must be event');
    if (op.riskLevel !== 'high') throw new Error('riskLevel must be high');
    if (!op.preconditions.some((p) => p.type === 'content_hash' && p.expectedHash === expectedHash)) {
      throw new Error('content_hash precondition missing');
    }
    if (!op.validatorRequirements.some((v) => v.validatorId === 'binary_roundtrip' && v.scope === 'after_commit')) {
      throw new Error('after-commit re-read validator requirement missing');
    }
    if (op.metadata?.nativeFormatAuthority !== true) {
      throw new Error('nativeFormatAuthority metadata missing');
    }
    passed++;
  }

  // --- Case 9: PatchIR transaction rollback restores original bytes ---
  {
    const root = await mkdtemp(join(tmpdir(), 'soulforge-emevd-plan-smoke-'));
    try {
      const overlayRoot = join(root, 'mod');
      const stagingBase = join(root, 'staging');
      const backupBase = join(root, 'backups');
      await mkdir(join(overlayRoot, 'event'), { recursive: true });
      await mkdir(stagingBase, { recursive: true });
      await mkdir(backupBase, { recursive: true });
      const target = join(overlayRoot, 'event', 'common.emevd');
      const original = standardSyntheticEmevd();
      await writeFile(target, original);

      // Simulated Bridge-staged bytes: same event table but rest behavior flipped to 1.
      const staged = Buffer.from(original);
      staged.writeUInt32LE(1, 0x90 + 40);

      const session = await openWorkspaceSession({ overlayRoot, game: 'sekiro' });
      const patch = buildEmevdFileReplacePatch({
        workspaceId: session.meta.workspaceId,
        title: 'emevd plan rollback smoke',
        targetUri: 'file://event/common.emevd',
        targetPath: target,
        stagedBytes: staged,
        expectedHash: sha256Hex(original)
      });
      const transaction = createWorkspaceTransaction({
        workspaceId: session.meta.workspaceId,
        workspaceRoot: overlayRoot,
        stagingBaseDir: stagingBase,
        backupBaseDir: backupBase,
        validators: [...createScaffoldValidators(), throwingAfterCommitValidator()]
      });
      if (!transaction.addPatch(patch).ok) throw new Error('patch admission failed');
      const stagedResult = await transaction.stage();
      if (!stagedResult.ok) throw new Error(`stage failed: ${JSON.stringify(stagedResult.diagnostics)}`);
      const validated = await transaction.validate();
      if (!validated.ok) throw new Error(`validate failed: ${JSON.stringify(validated.diagnostics)}`);
      const committed = await transaction.commit();
      if (committed.ok || committed.committedPaths.length !== 0) {
        throw new Error('after-commit validator failure must not commit files');
      }
      if (!committed.diagnostics.some((d) => d.code === 'VALIDATOR_AFTER_COMMIT_FAILED')) {
        throw new Error(`missing VALIDATOR_AFTER_COMMIT_FAILED: ${JSON.stringify(committed.diagnostics)}`);
      }
      if (transaction.getStatus() !== 'failed') {
        throw new Error(`status ${transaction.getStatus()}, expected failed`);
      }
      const restored = await readFile(target);
      if (!restored.equals(original)) {
        throw new Error('rollback did not restore original bytes');
      }
      const audit = transaction.getAuditLog().list({ transactionId: transaction.transactionId });
      if (!audit.some((entry) => entry.eventKind === 'failure_recovery')) {
        throw new Error('rollback failure was not audited');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    passed++;
  }

  // --- Case 10: applyEmevdPlanToDocument applies the committed plan ---
  {
    const source = `resource "file://event/common.emevd"
base revision 0 schema "${schemaFingerprint}"
event ${eventAnchor0} {
  set id = 51;
  set rest = 1;
  instruction ${instrAnchor0} {
    set arg conditionGroup = -2;
  }
  instruction ${instrAnchor1} {
    set arg resultConditionGroup = 5;
    set arg desiredComparisonType = 1;
  }
}`;
    const request: EmevdDslCompileRequest = {
      schemaVersion: 1,
      resourceUri: document.resourceUri,
      documentInstanceId: document.documentInstanceId!,
      baseRevision: document.revision,
      emedfSchemaFingerprint: schemaFingerprint,
      sourceText: source,
      mode: 'patch'
    };
    const compiled = compileEmevdPatchDsl(request, document, registry);
    if (!compiled.ok || !compiled.plan) throw new Error('compile failed');
    const applied = applyEmevdPlanToDocument(document, compiled.plan, registry);
    if (!applied.ok) throw new Error(JSON.stringify(applied));
    if (applied.document.revision !== 1) throw new Error('revision must bump to 1');
    const event0 = applied.document.events[0]!;
    if (event0.eventId !== 51) throw new Error('event id not applied');
    if (event0.restBehavior !== 1) throw new Error('rest behavior not applied');
    if (!event0.eventUri.endsWith('#event/51')) throw new Error('event uri not updated');
    const instr0Args = Buffer.from(event0.instructions[0]!.argsBase64, 'base64');
    if (instr0Args.readInt8(0) !== -2) throw new Error('conditionGroup not applied');
    const instr1Args = Buffer.from(event0.instructions[1]!.argsBase64, 'base64');
    if (instr1Args.readInt8(0) !== 5 || instr1Args.readUInt8(1) !== 1 || instr1Args.readInt8(2) !== 2) {
      throw new Error('if-condition args not applied');
    }
    if (!applied.document.diagnostics.some((d) => d.code === 'EMEVD_PLAN_APPLIED')) {
      throw new Error('EMEVD_PLAN_APPLIED diagnostic missing');
    }
    passed++;
  }

  // --- Case 11: planToBridgeMutations structured failure on missing anchor ---
  {
    const missingPlan: EmevdMutationPlan = {
      schemaVersion: 1,
      resourceUri: document.resourceUri,
      documentInstanceId: document.documentInstanceId!,
      baseRevision: 0,
      sourceFingerprint: 'smoke-fake',
      schemaFingerprint,
      planFingerprint: 'smoke-fake-plan',
      operations: [{
        kind: 'set_event_rest_behavior',
        eventAnchor: 'file://event/common.emevd#event/404-missing',
        target: { documentInstanceId: 'x', localNodeId: 'missing', sourceFingerprint: 'f' },
        targetPreconditionHash: 'h',
        sourceSpan: {
          start: { offset: 0, line: 0, column: 0 },
          end: { offset: 1, line: 0, column: 1 }
        },
        before: 0,
        after: 1
      }],
      impact: { touchedEvents: ['x'], touchedInstructions: [], inserts: 0, deletes: 0, argumentWrites: 0 }
    };
    const converted = planToBridgeMutations(missingPlan, document, registry);
    if (converted.ok) throw new Error('missing anchor must fail closed');
    if (converted.code !== 'EMEVD_PLAN_ANCHOR_NOT_FOUND') {
      throw new Error(`expected EMEVD_PLAN_ANCHOR_NOT_FOUND, got ${converted.code}`);
    }
    passed++;
  }

  // --- Case 12: Four-view submit entry without Bridge (no-op plan, stale revision) ---
  {
    const noOpSource = `resource "file://event/common.emevd"
base revision 0 schema "${schemaFingerprint}"
event ${eventAnchor0} {
  set id = 50;
  set rest = 0;
  instruction ${instrAnchor0} {
    set arg conditionGroup = -1;
  }
}`;
    const noOp: EmevdDslCompileRequest = {
      schemaVersion: 1,
      resourceUri: document.resourceUri,
      documentInstanceId: document.documentInstanceId!,
      baseRevision: document.revision,
      emedfSchemaFingerprint: schemaFingerprint,
      sourceText: noOpSource,
      mode: 'patch'
    };
    const submitted = await submitEmevdDslPlanViaFourView({
      compileRequest: noOp,
      document,
      registry,
      sourcePath: join('no-bridge', 'common.emevd'),
      expectedDocumentHash: 'x'.repeat(64),
      allowedRoots: ['no-bridge'],
      workspaceId: 'w-smoke',
      workspaceRoot: 'no-bridge',
      stagingRoot: 'no-bridge'
    });
    if (!submitted.ok) throw new Error(`no-op submit must succeed: ${JSON.stringify(submitted.diagnostics)}`);
    if (!submitted.commit || submitted.commit.mutationCount !== 0) {
      throw new Error('no-op plan must have zero mutations');
    }
    if (!submitted.commit.diagnostics.some((d) => d.code === 'EMEVD_PLAN_EMPTY')) {
      throw new Error('EMEVD_PLAN_EMPTY diagnostic missing');
    }
    if (submitted.nextDocument !== document) {
      throw new Error('no-op plan must not change the document');
    }

    const stale = await submitEmevdDslPlanViaFourView({
      compileRequest: { ...noOp, baseRevision: 99 },
      document,
      registry,
      sourcePath: join('no-bridge', 'common.emevd'),
      expectedDocumentHash: 'x'.repeat(64),
      allowedRoots: ['no-bridge'],
      workspaceId: 'w-smoke',
      workspaceRoot: 'no-bridge',
      stagingRoot: 'no-bridge'
    });
    if (stale.ok) throw new Error('stale revision must fail closed');
    if (!stale.diagnostics.some((d) => d.code === 'EMEVD_DSL_STALE_REVISION')) {
      throw new Error(`expected EMEVD_DSL_STALE_REVISION: ${JSON.stringify(stale.diagnostics)}`);
    }
    passed++;
  }

  // --- Case 13: Synthetic fixture layout is internally consistent ---
  {
    const synthetic = standardSyntheticEmevd();
    if (synthetic.length !== 0x170) {
      throw new Error(`expected 0x170-byte synthetic EMEVD, got 0x${synthetic.length.toString(16)}`);
    }
    if (synthetic.readUInt32LE(0x0c) !== synthetic.length) throw new Error('declared size mismatch');
    if (synthetic.readBigInt64LE(0x10) !== 2n) throw new Error('event count');
    if (synthetic.readBigInt64LE(0x20) !== 3n) throw new Error('instruction count');
    if (mutatedWaitForArgs().length !== 8 || mutatedIfCondArgs().length !== 12) {
      throw new Error('expected arg fixtures');
    }
    passed++;
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'emevd plan commit smoke: ok',
    passed,
    total: 13,
    nonClaims: [
      '不运行 Bridge daemon；Bridge/PatchIR production 链路由 runEmevdPlanCommitProductionSmoke 覆盖。',
      '不证明完整 EMEDF、layer 变体、KRAK 或游戏加载。',
      'authority 上限为 partial，仅覆盖实际接线的 mutation 类型。'
    ]
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
