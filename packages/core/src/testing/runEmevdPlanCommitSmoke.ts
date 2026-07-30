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
 *
 * Does NOT invoke Bridge or PatchIR at runtime (those are covered by native smokes).
 * Authority cap: partial; only covers actual wired mutations, not full EMEDF/layer/game-load.
 */

import type { EmevdDslCompileRequest } from '@soulforge/shared';
import {
  createEmevdEditorDocument
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
import { planToBridgeMutations } from '../editing/emevdPlanCommit.js';

function main(): void {
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

  console.log(JSON.stringify({
    ok: true,
    message: 'emevd plan commit smoke: ok',
    passed,
    total: 7,
    nonClaims: [
      '不运行 Bridge 或 PatchIR；Bridge 集成由 native smoke 覆盖。',
      '不证明完整 EMEDF、layer 变体、KRAK 或游戏加载。',
      'authority 上限为 partial，仅覆盖实际接线的 mutation 类型。'
    ]
  }));
}

main();
