import type { EmevdDslCompileRequest, EmevdPlannedMutation } from '@soulforge/shared';
import {
  applyEmevdEditorMutation,
  createEmevdEditorDocument,
  renderEmevdDsl
} from '../editing/emevdFourViewController.js';
import {
  compileEmevdPatchDsl,
  fingerprintEmedfRegistry
} from '../emevd/dslCompiler.js';
import { renderEmevdPatchDsl, renderEmevdPatchDslBounded } from '../emevd/dslRenderer.js';
import { formatEmevdAnchor } from '../emevd/stableIdentity.js';
import {
  createSekiroFixtureEmedf,
  encodeInstructionArgs,
  type EmedfRegistry
} from '../emevd/emedfSchema.js';

function main(): void {
  const registry = createSekiroFixtureEmedf();
  const encoded = encodeInstructionArgs(registry, 1000, 0, {
    conditionGroup: -1,
    pad0: 0,
    pad1: 0,
    unknown: 0
  });
  if (!encoded.ok) throw new Error(JSON.stringify(encoded));

  const document = createEmevdEditorDocument({
    resourceUri: 'file://event/common.emevd',
    documentInstanceId: 'emevd-dsl-smoke-document',
    events: [
      {
        eventId: 50,
        restBehavior: 0,
        instructions: [
          {
            bank: 1000,
            id: 0,
            argsBase64: encoded.args.toString('base64'),
            unknown: false
          },
          {
            bank: 9999,
            id: 1,
            argsBase64: '',
            unknown: true
          }
        ]
      },
      { eventId: 100, restBehavior: 0, instructions: [] }
    ]
  });

  const event = document.events[0]!;
  const typedInstruction = event.instructions[0]!;
  const unknownInstruction = event.instructions[1]!;
  if (!document.documentInstanceId || !event.anchor || !typedInstruction.anchor || !unknownInstruction.anchor) {
    throw new Error('stable identity missing');
  }
  if (
    event.anchor.localNodeId.length < 24
    || typedInstruction.anchor.localNodeId.length < 24
    || unknownInstruction.anchor.localNodeId.length < 24
  ) {
    throw new Error('stable anchor entropy is below the 96-bit contract');
  }
  const eventAnchor = formatEmevdAnchor('event', event.anchor);
  const typedAnchor = formatEmevdAnchor('instruction', typedInstruction.anchor);
  const unknownAnchor = formatEmevdAnchor('instruction', unknownInstruction.anchor);
  if (!renderEmevdDsl(document).includes(eventAnchor)) throw new Error('projection missing event anchor');

  const schemaFingerprint = fingerprintEmedfRegistry(registry);
  const source = sourceFor({
    resourceUri: document.resourceUri,
    schemaFingerprint,
    eventAnchor,
    instructionAnchor: typedAnchor,
    eventId: 51,
    restBehavior: 1,
    conditionGroup: -2
  });
  const request: EmevdDslCompileRequest = {
    schemaVersion: 1,
    resourceUri: document.resourceUri,
    documentInstanceId: document.documentInstanceId,
    baseRevision: document.revision,
    emedfSchemaFingerprint: schemaFingerprint,
    sourceText: source,
    mode: 'patch'
  };

  const renderedPatch = renderEmevdPatchDsl(document, registry);
  const renderedRoundtrip = compileEmevdPatchDsl(
    { ...request, sourceText: renderedPatch },
    document,
    registry
  );
  if (!renderedRoundtrip.ok) throw new Error(JSON.stringify(renderedRoundtrip.diagnostics));
  if (renderedRoundtrip.plan.operations.length !== 0) {
    throw new Error('untouched rendered patch template must compile to an empty plan');
  }
  const renderedEvent = renderedRoundtrip.ast.events.find((item) => item.anchor === eventAnchor);
  if (!renderedEvent) throw new Error('rendered patch did not bind the event anchor');
  if (!renderedEvent.instructions.some((item) => item.anchor === typedAnchor)) {
    throw new Error('rendered patch did not bind the typed instruction anchor');
  }
  if (!renderedPatch.includes(unknownAnchor) || !renderedPatch.includes('read-only')) {
    throw new Error('unknown instruction must remain visible as a read-only comment');
  }

  // Bounded template (hard constraint 17): the cap must truncate at an
  // event-block boundary with a comment marker, and compiling the truncated
  // template must stay a deterministic no-op.
  const bounded = renderEmevdPatchDslBounded(document, registry, 8);
  if (!bounded.truncated) throw new Error('bounded template must be truncated under the cap');
  if (!bounded.text.includes('\n}\n\n// EMEVD_DSL_TEMPLATE_TRUNCATED')) {
    throw new Error('truncation must end at an event-block boundary with the marker comment');
  }
  const boundedRoundtrip = compileEmevdPatchDsl(
    { ...request, sourceText: bounded.text },
    document,
    registry
  );
  if (!boundedRoundtrip.ok) {
    throw new Error(`truncated template must parse: ${JSON.stringify(boundedRoundtrip.diagnostics)}`);
  }
  if (boundedRoundtrip.plan.operations.length !== 0) {
    throw new Error('truncated template must still compile to an empty plan');
  }
  const boundedFull = renderEmevdPatchDslBounded(document, registry, 1_000_000);
  if (boundedFull.truncated || boundedFull.totalLines !== boundedFull.shownLines) {
    throw new Error('unbounded-cap template must not truncate');
  }

  const compiled = compileEmevdPatchDsl(request, document, registry);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  if (compiled.plan.operations.length !== 3) throw new Error('expected three typed mutations');
  if (compiled.plan.impact.argumentWrites !== 1) throw new Error('argument impact mismatch');
  if (document.events[0]!.eventId !== 50 || document.revision !== 0) {
    throw new Error('compile mutated authority document');
  }
  if (!compiled.plan.operations.every((operation) => operation.sourceSpan.start.line > 0)) {
    throw new Error('source spans missing');
  }

  const repeated = compileEmevdPatchDsl(request, document, registry);
  if (!repeated.ok || repeated.plan.planFingerprint !== compiled.plan.planFingerprint) {
    throw new Error('same input must produce same plan fingerprint');
  }
  const whitespaceSource = `resource "${document.resourceUri}" base revision 0 schema "${schemaFingerprint}"
    event ${eventAnchor}{set id=51;set rest=1;instruction ${typedAnchor}{set arg conditionGroup=-2;}}`;
  const whitespaceResult = compileEmevdPatchDsl(
    { ...request, sourceText: whitespaceSource },
    document,
    registry
  );
  if (!whitespaceResult.ok || whitespaceResult.plan.planFingerprint !== compiled.plan.planFingerprint) {
    throw new Error('semantic fingerprint must ignore whitespace and source spans');
  }

  const noOpSource = sourceFor({
    resourceUri: document.resourceUri,
    schemaFingerprint,
    eventAnchor,
    instructionAnchor: typedAnchor,
    eventId: 50,
    restBehavior: 0,
    conditionGroup: -1
  });
  const noOp = compileEmevdPatchDsl({ ...request, sourceText: noOpSource }, document, registry);
  if (!noOp.ok || noOp.plan.operations.length !== 0) throw new Error('no-op plan must be empty');

  const stale = compileEmevdPatchDsl(
    { ...request, baseRevision: 1 },
    document,
    registry
  );
  assertDiagnostic(stale, 'EMEVD_DSL_STALE_REVISION');

  const missingSchema = compileEmevdPatchDsl(request, document);
  assertDiagnostic(missingSchema, 'EMEVD_DSL_SCHEMA_REQUIRED');

  const changedSchema = 'sha256:deadbeef';
  const changedSchemaSource = source.replaceAll(schemaFingerprint, changedSchema);
  const changed = compileEmevdPatchDsl(
    { ...request, emedfSchemaFingerprint: changedSchema, sourceText: changedSchemaSource },
    document,
    registry
  );
  assertDiagnostic(changed, 'EMEVD_DSL_SCHEMA_CHANGED');

  const overflowSource = source.replace('conditionGroup = -2', 'conditionGroup = 128');
  const overflow = compileEmevdPatchDsl({ ...request, sourceText: overflowSource }, document, registry);
  assertDiagnostic(overflow, 'EMEVD_DSL_INTEGER_OUT_OF_RANGE');

  const unknownSource = `resource "${document.resourceUri}"
base revision 0 schema "${schemaFingerprint}"
event ${eventAnchor} {
  instruction ${unknownAnchor} { set arg value = 1 }
}`;
  const unknown = compileEmevdPatchDsl({ ...request, sourceText: unknownSource }, document, registry);
  assertDiagnostic(unknown, 'EMEVD_DSL_UNKNOWN_INSTRUCTION_READONLY');

  const duplicateSource = source.replace('set id = 51', 'set id = 100');
  const duplicate = compileEmevdPatchDsl({ ...request, sourceText: duplicateSource }, document, registry);
  assertDiagnostic(duplicate, 'EMEVD_DSL_EVENT_ID_DUPLICATE');

  const duplicateWriteSource = source.replace('set rest = 1', 'set rest = 1\n  set rest = 2');
  const duplicateWrite = compileEmevdPatchDsl(
    { ...request, sourceText: duplicateWriteSource },
    document,
    registry
  );
  assertDiagnostic(duplicateWrite, 'EMEVD_DSL_DUPLICATE_WRITE');

  const duplicateArgumentSource = source.replace(
    'set arg conditionGroup = -2',
    'set arg conditionGroup = -2\n    set arg conditionGroup = -3'
  );
  const duplicateArgument = compileEmevdPatchDsl(
    { ...request, sourceText: duplicateArgumentSource },
    document,
    registry
  );
  assertDiagnostic(duplicateArgument, 'EMEVD_DSL_DUPLICATE_ARGUMENT');

  // Top-level instruction blocks: global instruction-level typed mutation
  // without an enclosing event block.
  const topLevelSource = `resource "${document.resourceUri}"
base revision 0 schema "${schemaFingerprint}"
instruction ${typedAnchor} { set arg conditionGroup = -2 }`;
  const topLevel = compileEmevdPatchDsl({ ...request, sourceText: topLevelSource }, document, registry);
  if (!topLevel.ok) throw new Error(JSON.stringify(topLevel.diagnostics));
  if (topLevel.plan.operations.length !== 1) throw new Error('top-level instruction must produce one typed mutation');
  if (topLevel.plan.operations[0]!.kind !== 'set_instruction_arg') {
    throw new Error('top-level mutation must be a typed instruction arg write');
  }
  if (topLevel.ast.topLevelInstructions?.length !== 1) {
    throw new Error('topLevelInstructions AST field missing');
  }
  // Semantic equivalence: the same write expressed inside the owning event
  // block must compile to an identical plan fingerprint.
  const eventScopedOnly = `resource "${document.resourceUri}"
base revision 0 schema "${schemaFingerprint}"
event ${eventAnchor} {
  instruction ${typedAnchor} { set arg conditionGroup = -2 }
}`;
  const eventScoped = compileEmevdPatchDsl({ ...request, sourceText: eventScopedOnly }, document, registry);
  if (!eventScoped.ok) throw new Error(JSON.stringify(eventScoped.diagnostics));
  // Plan fingerprints are source-shape-bound (a top-level block is a different
  // AST shape), so equivalence is asserted on the plan operations themselves.
  const planOperationsKey = (plan: { operations: EmevdPlannedMutation[] }): string => JSON.stringify(
    plan.operations.map((operation) => operation.kind === 'set_instruction_arg'
      ? [operation.kind, operation.eventAnchor, operation.instructionAnchor, operation.bank, operation.id,
        operation.argument, operation.before, operation.after]
      : [operation.kind])
  );
  if (planOperationsKey(eventScoped.plan) !== planOperationsKey(topLevel.plan)) {
    throw new Error('top-level and event-scoped writes must produce identical plan operations');
  }

  const topLevelMissing = compileEmevdPatchDsl(
    { ...request, sourceText: `resource "${document.resourceUri}" base revision 0 schema "${schemaFingerprint}"
instruction @i:111111111111111111111111 { set arg conditionGroup = -2 }` },
    document,
    registry
  );
  assertDiagnostic(topLevelMissing, 'EMEVD_DSL_ANCHOR_NOT_FOUND');

  const topLevelUnknown = compileEmevdPatchDsl(
    { ...request, sourceText: `resource "${document.resourceUri}" base revision 0 schema "${schemaFingerprint}"
instruction ${unknownAnchor} { set arg value = 1 }` },
    document,
    registry
  );
  assertDiagnostic(topLevelUnknown, 'EMEVD_DSL_UNKNOWN_INSTRUCTION_READONLY');

  // A write repeated across top-level and event-scoped blocks must be caught
  // by the shared anchor-keyed duplicate registry.
  const crossScopeDuplicate = compileEmevdPatchDsl(
    { ...request, sourceText: `resource "${document.resourceUri}"
base revision 0 schema "${schemaFingerprint}"
event ${eventAnchor} {
  instruction ${typedAnchor} { set arg conditionGroup = -2 }
}
instruction ${typedAnchor} { set arg conditionGroup = -3 }` },
    document,
    registry
  );
  assertDiagnostic(crossScopeDuplicate, 'EMEVD_DSL_DUPLICATE_ARGUMENT');

  const syntax = compileEmevdPatchDsl(
    { ...request, sourceText: `resource "${document.resourceUri}" base revision broken` },
    document,
    registry
  );
  assertDiagnostic(syntax, 'EMEVD_DSL_SYNTAX_ERROR');

  const changedId = applyEmevdEditorMutation(document, {
    kind: 'emevd_update_id',
    eventUri: event.eventUri,
    newEventId: 51,
    baseRevision: 0
  });
  if (!changedId.ok) throw new Error(JSON.stringify(changedId));
  if (changedId.document.events[0]!.anchor?.localNodeId !== event.anchor.localNodeId) {
    throw new Error('event anchor drifted after event ID mutation');
  }
  if (
    changedId.document.events[0]!.instructions[0]!.anchor?.localNodeId
    !== typedInstruction.anchor.localNodeId
  ) {
    throw new Error('instruction anchor drifted after event ID mutation');
  }

  // ---- Schema-driven control-flow validation (warning-only) ----
  // Event ID references are extracted from any schema-known instruction (arg
  // name contains "eventId" / description mentions "event"), not hardcoded to
  // InitializeEvent 2000:0, so a GotoEvent-style jump is covered once its
  // EMEDF is imported.
  const controlRegistry: EmedfRegistry = {
    schemaVersion: 1,
    game: 'sekiro',
    origin: 'user-derived',
    instructions: [
      { bank: 2001, id: 5, name: 'GotoEvent', args: [{ name: 'eventId', type: 'u32' }] },
      {
        bank: 2000,
        id: 0,
        name: 'IfConditionGroup',
        args: [
          { name: 'resultConditionGroup', type: 's8' },
          { name: 'desiredComparisonType', type: 'u8' },
          { name: 'targetConditionGroup', type: 's8' },
          { name: 'pad0', type: 'u8' },
          { name: 'pad1', type: 'u32' },
          { name: 'pad2', type: 'u32' }
        ]
      },
      {
        bank: 1000,
        id: 0,
        name: 'WaitFor',
        args: [
          { name: 'conditionGroup', type: 's8' },
          { name: 'pad0', type: 'u8' },
          { name: 'pad1', type: 'u16' },
          { name: 'unknown', type: 'u32' }
        ]
      }
    ]
  };
  const controlFingerprint = fingerprintEmedfRegistry(controlRegistry);

  // GotoEvent-style instruction must be caught even though the registry has no
  // InitializeEvent (2000:0): the check is schema-driven, not hardcoded.
  const gotoEncoded = encodeInstructionArgs(controlRegistry, 2001, 5, { eventId: 60 });
  if (!gotoEncoded.ok) throw new Error(JSON.stringify(gotoEncoded));
  const gotoDocument = createEmevdEditorDocument({
    resourceUri: 'file://event/goto.emevd',
    documentInstanceId: 'emevd-dsl-control-goto',
    events: [
      {
        eventId: 50,
        restBehavior: 0,
        instructions: [
          { bank: 2001, id: 5, argsBase64: gotoEncoded.args.toString('base64'), unknown: false }
        ]
      },
      { eventId: 60, restBehavior: 0, instructions: [] }
    ]
  });
  if (!gotoDocument.documentInstanceId || !gotoDocument.events[1]!.anchor) {
    throw new Error('goto document stable identity missing');
  }
  const gotoEventAnchor = formatEmevdAnchor('event', gotoDocument.events[1]!.anchor);
  const gotoCompiled = compileEmevdPatchDsl(
    {
      schemaVersion: 1,
      resourceUri: gotoDocument.resourceUri,
      documentInstanceId: gotoDocument.documentInstanceId,
      baseRevision: gotoDocument.revision,
      emedfSchemaFingerprint: controlFingerprint,
      sourceText: `resource "${gotoDocument.resourceUri}"
base revision ${gotoDocument.revision} schema "${controlFingerprint}"
event ${gotoEventAnchor} { set id = 61 }`,
      mode: 'patch'
    },
    gotoDocument,
    controlRegistry
  );
  assertWarning(gotoCompiled, 'EMEVD_DSL_EVENT_ID_REFERENCE_STALE');
  if (gotoCompiled.plan.operations.some((op) => op.kind !== 'set_event_id')) {
    throw new Error('goto case must only change the event ID');
  }

  // Condition group reference value 0 → invalid reference warning.
  const zeroCgEncoded = encodeInstructionArgs(controlRegistry, 1000, 0, {
    conditionGroup: 0, pad0: 0, pad1: 0, unknown: 0
  });
  if (!zeroCgEncoded.ok) throw new Error(JSON.stringify(zeroCgEncoded));
  const zeroCgDocument = createEmevdEditorDocument({
    resourceUri: 'file://event/zero-cg.emevd',
    documentInstanceId: 'emevd-dsl-control-zero-cg',
    events: [{ eventId: 50, restBehavior: 0, instructions: [
      { bank: 1000, id: 0, argsBase64: zeroCgEncoded.args.toString('base64'), unknown: false }
    ] }]
  });
  if (!zeroCgDocument.documentInstanceId) throw new Error('zero cg document identity missing');
  const zeroCgCompiled = compileEmevdPatchDsl(
    {
      schemaVersion: 1,
      resourceUri: zeroCgDocument.resourceUri,
      documentInstanceId: zeroCgDocument.documentInstanceId,
      baseRevision: zeroCgDocument.revision,
      emedfSchemaFingerprint: controlFingerprint,
      sourceText: renderEmevdPatchDsl(zeroCgDocument, controlRegistry),
      mode: 'patch'
    },
    zeroCgDocument,
    controlRegistry
  );
  if (!zeroCgCompiled.ok || zeroCgCompiled.plan.operations.length !== 0) {
    throw new Error('zero cg rendered template must compile to an empty plan');
  }
  assertWarning(zeroCgCompiled, 'EMEVD_DSL_CONDITION_GROUP_INVALID_REFERENCE');

  // Condition group reference to a never-initialized group → warning.
  const uninitCgEncoded = encodeInstructionArgs(controlRegistry, 1000, 0, {
    conditionGroup: 5, pad0: 0, pad1: 0, unknown: 0
  });
  if (!uninitCgEncoded.ok) throw new Error(JSON.stringify(uninitCgEncoded));
  const uninitCgDocument = createEmevdEditorDocument({
    resourceUri: 'file://event/uninit-cg.emevd',
    documentInstanceId: 'emevd-dsl-control-uninit-cg',
    events: [{ eventId: 50, restBehavior: 0, instructions: [
      { bank: 1000, id: 0, argsBase64: uninitCgEncoded.args.toString('base64'), unknown: false }
    ] }]
  });
  if (!uninitCgDocument.documentInstanceId) throw new Error('uninit cg document identity missing');
  const uninitCgCompiled = compileEmevdPatchDsl(
    {
      schemaVersion: 1,
      resourceUri: uninitCgDocument.resourceUri,
      documentInstanceId: uninitCgDocument.documentInstanceId,
      baseRevision: uninitCgDocument.revision,
      emedfSchemaFingerprint: controlFingerprint,
      sourceText: renderEmevdPatchDsl(uninitCgDocument, controlRegistry),
      mode: 'patch'
    },
    uninitCgDocument,
    controlRegistry
  );
  assertWarning(uninitCgCompiled, 'EMEVD_DSL_CONDITION_GROUP_UNINITIALIZED');

  // A group produced by IfConditionGroup.resultConditionGroup is initialized:
  // referencing it must not warn.
  const initCgDefined = encodeInstructionArgs(controlRegistry, 2000, 0, {
    resultConditionGroup: 7, desiredComparisonType: 1, targetConditionGroup: 7,
    pad0: 0, pad1: 0, pad2: 0
  });
  if (!initCgDefined.ok) throw new Error(JSON.stringify(initCgDefined));
  const initCgConsumed = encodeInstructionArgs(controlRegistry, 1000, 0, {
    conditionGroup: 7, pad0: 0, pad1: 0, unknown: 0
  });
  if (!initCgConsumed.ok) throw new Error(JSON.stringify(initCgConsumed));
  const initCgDocument = createEmevdEditorDocument({
    resourceUri: 'file://event/init-cg.emevd',
    documentInstanceId: 'emevd-dsl-control-init-cg',
    events: [{ eventId: 50, restBehavior: 0, instructions: [
      { bank: 2000, id: 0, argsBase64: initCgDefined.args.toString('base64'), unknown: false },
      { bank: 1000, id: 0, argsBase64: initCgConsumed.args.toString('base64'), unknown: false }
    ] }]
  });
  if (!initCgDocument.documentInstanceId) throw new Error('init cg document identity missing');
  const initCgCompiled = compileEmevdPatchDsl(
    {
      schemaVersion: 1,
      resourceUri: initCgDocument.resourceUri,
      documentInstanceId: initCgDocument.documentInstanceId,
      baseRevision: initCgDocument.revision,
      emedfSchemaFingerprint: controlFingerprint,
      sourceText: renderEmevdPatchDsl(initCgDocument, controlRegistry),
      mode: 'patch'
    },
    initCgDocument,
    controlRegistry
  );
  if (!initCgCompiled.ok) throw new Error(JSON.stringify(initCgCompiled.diagnostics));
  if (initCgCompiled.diagnostics.some((d) => d.code === 'EMEVD_DSL_CONDITION_GROUP_INVALID_REFERENCE'
    || d.code === 'EMEVD_DSL_CONDITION_GROUP_UNINITIALIZED')) {
    throw new Error('initialized condition groups must not warn');
  }

  // Instructions without schema or marked unknown are skipped silently: no
  // control-flow diagnostic may be produced even when an event ID changes.
  const noSchemaDocument = createEmevdEditorDocument({
    resourceUri: 'file://event/no-schema.emevd',
    documentInstanceId: 'emevd-dsl-control-no-schema',
    events: [
      {
        eventId: 50,
        restBehavior: 0,
        instructions: [
          { bank: 9000, id: 0, argsBase64: Buffer.alloc(4).toString('base64'), unknown: false },
          { bank: 9999, id: 1, argsBase64: '', unknown: true }
        ]
      },
      { eventId: 60, restBehavior: 0, instructions: [] }
    ]
  });
  if (!noSchemaDocument.documentInstanceId || !noSchemaDocument.events[1]!.anchor) {
    throw new Error('no-schema document identity missing');
  }
  const noSchemaEventAnchor = formatEmevdAnchor('event', noSchemaDocument.events[1]!.anchor);
  const noSchemaCompiled = compileEmevdPatchDsl(
    {
      schemaVersion: 1,
      resourceUri: noSchemaDocument.resourceUri,
      documentInstanceId: noSchemaDocument.documentInstanceId,
      baseRevision: noSchemaDocument.revision,
      emedfSchemaFingerprint: controlFingerprint,
      sourceText: `resource "${noSchemaDocument.resourceUri}"
base revision ${noSchemaDocument.revision} schema "${controlFingerprint}"
event ${noSchemaEventAnchor} { set id = 61 }`,
      mode: 'patch'
    },
    noSchemaDocument,
    controlRegistry
  );
  if (!noSchemaCompiled.ok) throw new Error(JSON.stringify(noSchemaCompiled.diagnostics));
  if (noSchemaCompiled.diagnostics.some((d) => [
    'EMEVD_DSL_EVENT_ID_REFERENCE_STALE',
    'EMEVD_DSL_CONDITION_GROUP_INVALID_REFERENCE',
    'EMEVD_DSL_CONDITION_GROUP_UNINITIALIZED'
  ].includes(d.code))) {
    throw new Error('no-schema instructions must be skipped silently');
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'EMEVD DSL Slice A+B stable identity/parser/deterministic plan smoke passed',
    planFingerprint: compiled.plan.planFingerprint,
    renderedRoundtripFingerprint: renderedRoundtrip.plan.planFingerprint,
    operations: compiled.plan.operations.map((operation) => operation.kind),
    diagnosticsCovered: [
      'EMEVD_DSL_ANCHOR_NOT_FOUND',
      'EMEVD_DSL_STALE_REVISION',
      'EMEVD_DSL_SCHEMA_REQUIRED',
      'EMEVD_DSL_SCHEMA_CHANGED',
      'EMEVD_DSL_INTEGER_OUT_OF_RANGE',
      'EMEVD_DSL_UNKNOWN_INSTRUCTION_READONLY',
      'EMEVD_DSL_EVENT_ID_DUPLICATE',
      'EMEVD_DSL_DUPLICATE_WRITE',
      'EMEVD_DSL_DUPLICATE_ARGUMENT',
      'EMEVD_DSL_SYNTAX_ERROR',
      'EMEVD_DSL_EVENT_ID_REFERENCE_STALE',
      'EMEVD_DSL_CONDITION_GROUP_INVALID_REFERENCE',
      'EMEVD_DSL_CONDITION_GROUP_UNINITIALIZED'
    ]
  }, null, 2));
}

function sourceFor(input: {
  resourceUri: string;
  schemaFingerprint: string;
  eventAnchor: string;
  instructionAnchor: string;
  eventId: number;
  restBehavior: number;
  conditionGroup: number;
}): string {
  return `resource "${input.resourceUri}"
base revision 0 schema "${input.schemaFingerprint}"

event ${input.eventAnchor} {
  set id = ${input.eventId}
  set rest = ${input.restBehavior}
  instruction ${input.instructionAnchor} {
    set arg conditionGroup = ${input.conditionGroup}
  }
}`;
}

function assertDiagnostic(
  result: ReturnType<typeof compileEmevdPatchDsl>,
  code: string
): void {
  if (result.ok || !result.diagnostics.some((item) => item.code === code)) {
    throw new Error(`missing diagnostic ${code}: ${JSON.stringify(result)}`);
  }
  const item = result.diagnostics.find((diagnostic) => diagnostic.code === code)!;
  if (item.span.start.line < 1 || item.span.start.column < 1) {
    throw new Error(`diagnostic ${code} has invalid source span`);
  }
}

/**
 * Control-flow diagnostics are warning-only and carry a zero source span plus
 * a targetAnchor on the authority instruction, so they cannot reuse the span
 * checks of assertDiagnostic.
 */
function assertWarning(
  result: ReturnType<typeof compileEmevdPatchDsl>,
  code: string
): asserts result is Extract<ReturnType<typeof compileEmevdPatchDsl>, { ok: true }> {
  if (!result.ok || !result.diagnostics.some((item) => item.code === code)) {
    throw new Error(`missing warning ${code}: ${JSON.stringify(result)}`);
  }
  const item = result.diagnostics.find((diagnostic) => diagnostic.code === code)!;
  if (item.severity !== 'warning') {
    throw new Error(`diagnostic ${code} must be a warning`);
  }
  if (item.targetAnchor === undefined) {
    throw new Error(`warning ${code} must carry a targetAnchor`);
  }
}

main();
