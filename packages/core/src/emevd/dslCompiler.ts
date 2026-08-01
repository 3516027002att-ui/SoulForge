import { createHash } from 'node:crypto';
import type {
  EmevdDslCompileRequest,
  EmevdDslCompileResult,
  EmevdDslDiagnostic,
  EmevdDslDocument,
  EmevdDslInstructionPatch,
  EmevdDslLiteral,
  EmevdDslSourceSpan,
  EmevdEditorDocument,
  EmevdMutationPlan,
  EmevdPlannedMutation
} from '@soulforge/shared';
import type { EmedfArgType, EmedfRegistry } from './emedfSchema.js';
import {
  decodeInstructionArgs,
  extractConditionGroupReferences,
  extractConditionGroupResults,
  extractEventIdReferences,
  findInstructionDef
} from './emedfSchema.js';
import { decodeStrictBase64 } from '../util/base64.js';
import { parseEmevdPatchDsl } from './dslParser.js';
import { createEmevdDslDiagnostic as diagnostic } from './dslTokenizer.js';
import {
  computeEmevdEventFingerprint,
  computeEmevdInstructionFingerprint,
  formatEmevdAnchor
} from './stableIdentity.js';

function hashText(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

export function fingerprintEmedfRegistry(registry: EmedfRegistry): string {
  const normalized = {
    schemaVersion: registry.schemaVersion,
    game: registry.game,
    origin: registry.origin,
    instructions: [...registry.instructions]
      .sort((a, b) => a.bank - b.bank || a.id - b.id || a.name.localeCompare(b.name))
      .map((instruction) => ({
        bank: instruction.bank,
        id: instruction.id,
        name: instruction.name,
        args: instruction.args.map((arg) => ({ name: arg.name, type: arg.type }))
      }))
  };
  return hashText(stableJson(normalized));
}

export function compileEmevdPatchDsl(
  request: EmevdDslCompileRequest,
  document: EmevdEditorDocument,
  registry?: EmedfRegistry
): EmevdDslCompileResult {
  const parsed = parseEmevdPatchDsl(request.sourceText);
  const diagnostics = [...parsed.diagnostics];
  const ast = parsed.ast;
  if (!ast) return { ok: false, diagnostics };

  const add = (item: EmevdDslDiagnostic): void => { diagnostics.push(item); };
  if (request.mode !== 'patch') {
    add(diagnostic('EMEVD_DSL_MODE_UNSUPPORTED', 'Only patch mode is supported.', ast.span));
  }
  if (request.resourceUri !== document.resourceUri || ast.resourceUri !== request.resourceUri) {
    add(diagnostic('EMEVD_DSL_RESOURCE_MISMATCH', 'Resource URI does not match the opened document.', ast.span, {
      resourceUri: request.resourceUri
    }));
  }
  if (document.documentInstanceId === undefined || request.documentInstanceId !== document.documentInstanceId) {
    add(diagnostic(
      'EMEVD_DSL_DOCUMENT_INSTANCE_MISMATCH',
      'Document instance is missing or stale.',
      ast.span,
      { resourceUri: request.resourceUri }
    ));
  }
  if (request.baseRevision !== document.revision || ast.baseRevision !== request.baseRevision) {
    add(diagnostic('EMEVD_DSL_STALE_REVISION', 'Base revision is stale.', ast.span, {
      resourceUri: request.resourceUri
    }));
  }
  if (!registry) {
    add(diagnostic('EMEVD_DSL_SCHEMA_REQUIRED', 'EMEDF schema is required.', ast.span, {
      resourceUri: request.resourceUri
    }));
  }

  const actualSchemaFingerprint = registry ? fingerprintEmedfRegistry(registry) : undefined;
  if (
    actualSchemaFingerprint !== undefined
    && (request.emedfSchemaFingerprint !== actualSchemaFingerprint
      || ast.emedfSchemaFingerprint !== actualSchemaFingerprint)
  ) {
    add(diagnostic('EMEVD_DSL_SCHEMA_CHANGED', 'EMEDF schema fingerprint changed.', ast.span, {
      resourceUri: request.resourceUri
    }));
  }

  if (diagnostics.some((item) => item.severity === 'error') || !registry || !actualSchemaFingerprint) {
    return { ok: false, ast, diagnostics: diagnostics.sort(compareDiagnostics) };
  }

  const eventByAnchor = new Map<string, EmevdEditorDocument['events'][number]>();
  const instructionByAnchor = new Map<string, {
    event: EmevdEditorDocument['events'][number];
    instruction: EmevdEditorDocument['events'][number]['instructions'][number];
  }>();
  for (const event of document.events) {
    if (event.anchor) eventByAnchor.set(formatEmevdAnchor('event', event.anchor), event);
    for (const instruction of event.instructions) {
      if (instruction.anchor) {
        instructionByAnchor.set(formatEmevdAnchor('instruction', instruction.anchor), { event, instruction });
      }
    }
  }

  const operations: EmevdPlannedMutation[] = [];
  const nextEventIds = new Map<string, number>();
  for (const event of document.events) {
    if (event.anchor) nextEventIds.set(formatEmevdAnchor('event', event.anchor), event.eventId);
  }

  for (const eventPatch of ast.events) {
    const event = eventByAnchor.get(eventPatch.anchor);
    if (!event?.anchor) {
      add(diagnostic('EMEVD_DSL_ANCHOR_NOT_FOUND', 'Event anchor not found.', eventPatch.span, {
        resourceUri: request.resourceUri,
        targetAnchor: eventPatch.anchor
      }));
      continue;
    }
    if (event.anchor.documentInstanceId !== document.documentInstanceId) {
      add(diagnostic('EMEVD_DSL_ANCHOR_PRECONDITION_FAILED', 'Event anchor belongs to another document instance.', eventPatch.span, {
        resourceUri: request.resourceUri,
        targetAnchor: eventPatch.anchor
      }));
      continue;
    }
    const eventPreconditionHash = computeEmevdEventFingerprint(event);
    for (const operation of eventPatch.operations) {
      if (!Number.isSafeInteger(operation.value)) {
        add(diagnostic('EMEVD_DSL_INTEGER_OUT_OF_RANGE', 'Event values must be safe integers.', operation.span, {
          resourceUri: request.resourceUri,
          targetAnchor: eventPatch.anchor
        }));
        continue;
      }
      if (operation.field === 'id') {
        if (operation.value < 0) {
          add(diagnostic('EMEVD_DSL_INTEGER_OUT_OF_RANGE', 'Event ID must be non-negative.', operation.span, {
            resourceUri: request.resourceUri,
            targetAnchor: eventPatch.anchor
          }));
          continue;
        }
        nextEventIds.set(eventPatch.anchor, operation.value);
        if (operation.value !== event.eventId) {
          operations.push({
            kind: 'set_event_id',
            eventAnchor: eventPatch.anchor,
            target: event.anchor,
            targetPreconditionHash: eventPreconditionHash,
            sourceSpan: operation.span,
            before: event.eventId,
            after: operation.value
          });
        }
      } else {
        if (operation.value < 0 || operation.value > 255) {
          add(diagnostic('EMEVD_DSL_INTEGER_OUT_OF_RANGE', 'Rest behavior must fit u8.', operation.span, {
            resourceUri: request.resourceUri,
            targetAnchor: eventPatch.anchor
          }));
          continue;
        }
        if (operation.value !== event.restBehavior) {
          operations.push({
            kind: 'set_event_rest_behavior',
            eventAnchor: eventPatch.anchor,
            target: event.anchor,
            targetPreconditionHash: eventPreconditionHash,
            sourceSpan: operation.span,
            before: event.restBehavior,
            after: operation.value
          });
        }
      }
    }

    for (const instructionPatch of eventPatch.instructions) {
      const bound = instructionByAnchor.get(instructionPatch.anchor);
      const instructionAnchor = bound?.instruction.anchor;
      if (!bound || !instructionAnchor || bound.event !== event) {
        add(diagnostic('EMEVD_DSL_ANCHOR_NOT_FOUND', 'Instruction anchor not found under event.', instructionPatch.span, {
          resourceUri: request.resourceUri,
          targetAnchor: instructionPatch.anchor
        }));
        continue;
      }
      compileInstructionArgMutations(
        instructionPatch,
        bound.instruction,
        eventPatch.anchor,
        registry,
        operations,
        diagnostics,
        request.resourceUri
      );
    }
  }

  // Top-level instruction blocks: global instruction-level typed mutation
  // without an enclosing event block. The owning event is resolved from the
  // document's stable instruction identity, so the generated plan is
  // identical to expressing the same write inside that event block.
  for (const instructionPatch of ast.topLevelInstructions ?? []) {
    const bound = instructionByAnchor.get(instructionPatch.anchor);
    const instructionAnchor = bound?.instruction.anchor;
    if (!bound || !instructionAnchor) {
      add(diagnostic('EMEVD_DSL_ANCHOR_NOT_FOUND', 'Instruction anchor not found.', instructionPatch.span, {
        resourceUri: request.resourceUri,
        targetAnchor: instructionPatch.anchor
      }));
      continue;
    }
    const eventAnchor = bound.event.anchor;
    if (!eventAnchor) {
      add(diagnostic(
        'EMEVD_DSL_ANCHOR_PRECONDITION_FAILED',
        'Owning event has no anchor; top-level instruction writes require a stable event identity.',
        instructionPatch.span,
        { resourceUri: request.resourceUri, targetAnchor: instructionPatch.anchor }
      ));
      continue;
    }
    compileInstructionArgMutations(
      instructionPatch,
      bound.instruction,
      formatEmevdAnchor('event', eventAnchor),
      registry,
      operations,
      diagnostics,
      request.resourceUri
    );
  }

  // Collision check: only reject ids explicitly assigned by this plan when they
  // collide with any other event's final id. Pre-existing duplicate ids in the
  // source document (observed in real Sekiro corpora) are tolerated as long as
  // the plan does not modify those events.
  const explicitlySetIds = new Set<string>();
  for (const eventPatch of ast.events) {
    for (const operation of eventPatch.operations) {
      if (operation.field === 'id') explicitlySetIds.add(eventPatch.anchor);
    }
  }
  const ids = new Map<number, string>();
  for (const [anchor, id] of nextEventIds) {
    const previous = ids.get(id);
    const touched = explicitlySetIds.has(anchor)
      || (previous !== undefined && explicitlySetIds.has(previous));
    if (previous !== undefined && previous !== anchor && touched) {
      add(diagnostic('EMEVD_DSL_EVENT_ID_DUPLICATE', `Event ID ${id} would be duplicated.`, ast.span, {
        resourceUri: request.resourceUri,
        targetAnchor: anchor
      }));
    } else {
      ids.set(id, anchor);
    }
  }

  if (diagnostics.some((item) => item.severity === 'error')) {
    return { ok: false, ast, diagnostics: diagnostics.sort(compareDiagnostics) };
  }

  // Control-flow validation: warn when event ID changes create dangling
  // references. This is a best-effort, schema-driven check — it decodes the
  // args of every schema-known instruction (e.g. InitializeEvent or a
  // GotoEvent-style jump once its EMEDF is imported) and warns if the old
  // event ID appears as an event ID reference.
  validateEventIdReferences(document, operations, registry, diagnostics, request.resourceUri);
  validateConditionGroupReferences(document, registry, diagnostics, request.resourceUri);

  const touchedEvents = unique(operations.map((operation) => operation.eventAnchor));
  const touchedInstructions = unique(operations.flatMap((operation) =>
    operation.kind === 'set_instruction_arg' ? [operation.instructionAnchor] : []
  ));
  const sourceFingerprint = hashText(stableJson(normalizeAstForFingerprint(ast)));
  const planWithoutFingerprint = {
    schemaVersion: 1 as const,
    resourceUri: request.resourceUri,
    documentInstanceId: request.documentInstanceId,
    baseRevision: request.baseRevision,
    sourceFingerprint,
    schemaFingerprint: actualSchemaFingerprint,
    operations,
    impact: {
      touchedEvents,
      touchedInstructions,
      inserts: 0,
      deletes: 0,
      argumentWrites: operations.filter((operation) => operation.kind === 'set_instruction_arg').length
    }
  };
  const plan: EmevdMutationPlan = {
    ...planWithoutFingerprint,
    planFingerprint: hashText(stableJson(normalizePlanForFingerprint(planWithoutFingerprint)))
  };
  return { ok: true, ast, plan, diagnostics: diagnostics.sort(compareDiagnostics) };
}

/**
 * Compile one instruction block (event-nested or top-level) into typed
 * set_instruction_arg mutations. Shared by both block forms so global and
 * event-scoped writes go through identical schema/type/range validation.
 * Precondition (enforced by both callers): the instruction was resolved
 * through instructionByAnchor, so `instruction.anchor` is defined.
 */
function compileInstructionArgMutations(
  instructionPatch: EmevdDslInstructionPatch,
  instruction: EmevdEditorDocument['events'][number]['instructions'][number],
  eventAnchor: string,
  registry: EmedfRegistry,
  operations: EmevdPlannedMutation[],
  diagnostics: EmevdDslDiagnostic[],
  resourceUri: string
): void {
  const add = (item: EmevdDslDiagnostic): void => { diagnostics.push(item); };
  if (instruction.unknown) {
    add(diagnostic(
      'EMEVD_DSL_UNKNOWN_INSTRUCTION_READONLY',
      'Unknown instruction is read-only.',
      instructionPatch.span,
      { resourceUri, targetAnchor: instructionPatch.anchor }
    ));
    return;
  }
  const definition = findInstructionDef(registry, instruction.bank, instruction.id);
  if (!definition) {
    add(diagnostic(
      'EMEVD_DSL_UNKNOWN_INSTRUCTION_READONLY',
      'Instruction has no EMEDF schema and is read-only.',
      instructionPatch.span,
      { resourceUri, targetAnchor: instructionPatch.anchor }
    ));
    return;
  }
  let rawArgs: Buffer;
  try {
    rawArgs = decodeStrictBase64(instruction.argsBase64, { allowEmpty: true });
  } catch {
    add(diagnostic('EMEVD_DSL_ANCHOR_PRECONDITION_FAILED', 'Instruction payload is not valid base64.', instructionPatch.span, {
      resourceUri,
      targetAnchor: instructionPatch.anchor
    }));
    return;
  }
  const decoded = decodeInstructionArgs(registry, instruction.bank, instruction.id, rawArgs);
  if (!decoded.ok) {
    add(diagnostic('EMEVD_DSL_ANCHOR_PRECONDITION_FAILED', decoded.message, instructionPatch.span, {
      resourceUri,
      targetAnchor: instructionPatch.anchor
    }));
    return;
  }
  const decodedByName = new Map(decoded.args.map((arg) => [arg.name, arg]));
  const seenArgs = new Set<string>();
  for (const operation of instructionPatch.operations) {
    if (seenArgs.has(operation.argument)) {
      add(diagnostic('EMEVD_DSL_DUPLICATE_ARGUMENT', `Duplicate argument ${operation.argument}.`, operation.span, {
        resourceUri,
        targetAnchor: instructionPatch.anchor
      }));
      continue;
    }
    seenArgs.add(operation.argument);
    const argDef = definition.args.find((arg) => arg.name === operation.argument);
    const before = decodedByName.get(operation.argument);
    if (!argDef || !before) {
      add(diagnostic('EMEVD_DSL_UNKNOWN_ARGUMENT', `Unknown argument ${operation.argument}.`, operation.span, {
        resourceUri,
        targetAnchor: instructionPatch.anchor
      }));
      continue;
    }
    if (argDef.vararg) {
      // Vararg tails are opaque: their repetition count is determined by the
      // observed payload length, not by a name. Only fixed arguments are
      // writable; the tail is preserved byte-for-byte.
      add(diagnostic(
        'EMEVD_DSL_VARARG_ARG_READONLY',
        `Vararg tail argument ${operation.argument} is read-only; only fixed arguments can be written.`,
        operation.span,
        { resourceUri, targetAnchor: instructionPatch.anchor }
      ));
      continue;
    }
    const valueError = validateTypedLiteral(argDef.type, operation.value);
    if (valueError) {
      add(diagnostic(valueError.code, valueError.message, operation.span, {
        resourceUri,
        targetAnchor: instructionPatch.anchor
      }));
      continue;
    }
    if (!Object.is(before.value, operation.value)) {
      operations.push({
        kind: 'set_instruction_arg',
        eventAnchor,
        instructionAnchor: instructionPatch.anchor,
        target: instruction.anchor!,
        targetPreconditionHash: computeEmevdInstructionFingerprint(instruction),
        sourceSpan: operation.span,
        bank: instruction.bank,
        id: instruction.id,
        argument: operation.argument,
        before: before.value,
        after: operation.value
      });
    }
  }
}

function normalizeAstForFingerprint(ast: EmevdDslDocument): unknown {
  return {
    schemaVersion: ast.schemaVersion,
    resourceUri: ast.resourceUri,
    baseRevision: ast.baseRevision,
    emedfSchemaFingerprint: ast.emedfSchemaFingerprint,
    events: ast.events.map((event) => ({
      anchor: event.anchor,
      operations: event.operations.map((operation) => ({
        kind: operation.kind,
        field: operation.field,
        value: operation.value
      })),
      instructions: event.instructions.map((instruction) => ({
        anchor: instruction.anchor,
        operations: instruction.operations.map((operation) => ({
          kind: operation.kind,
          argument: operation.argument,
          value: operation.value
        }))
      }))
    })),
    topLevelInstructions: (ast.topLevelInstructions ?? []).map((instruction) => ({
      anchor: instruction.anchor,
      operations: instruction.operations.map((operation) => ({
        kind: operation.kind,
        argument: operation.argument,
        value: operation.value
      }))
    }))
  };
}

function normalizePlanForFingerprint(
  plan: Omit<EmevdMutationPlan, 'planFingerprint'>
): unknown {
  return {
    ...plan,
    operations: plan.operations.map(({ sourceSpan: _sourceSpan, ...operation }) => operation)
  };
}

function validateTypedLiteral(
  type: EmedfArgType,
  value: EmevdDslLiteral
): { code: string; message: string } | undefined {
  if (type === 'bool') {
    return typeof value === 'boolean'
      ? undefined
      : { code: 'EMEVD_DSL_TYPE_MISMATCH', message: 'Boolean argument requires true or false.' };
  }
  if (typeof value !== 'number') {
    return { code: 'EMEVD_DSL_TYPE_MISMATCH', message: `${type} argument requires a number.` };
  }
  if (type === 'f32') {
    return Number.isFinite(value)
      ? undefined
      : { code: 'EMEVD_DSL_FLOAT_NON_FINITE', message: 'f32 argument must be finite.' };
  }
  if (!Number.isInteger(value)) {
    return { code: 'EMEVD_DSL_TYPE_MISMATCH', message: `${type} argument requires an integer.` };
  }
  const range: Record<Exclude<EmedfArgType, 'bool' | 'f32'>, readonly [number, number]> = {
    u8: [0, 0xff],
    s8: [-0x80, 0x7f],
    u16: [0, 0xffff],
    s16: [-0x8000, 0x7fff],
    u32: [0, 0xffffffff],
    s32: [-0x80000000, 0x7fffffff]
  };
  const [minimum, maximum] = range[type];
  return value >= minimum && value <= maximum
    ? undefined
    : { code: 'EMEVD_DSL_INTEGER_OUT_OF_RANGE', message: `${type} value must be between ${minimum} and ${maximum}.` };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/* ------------------------------------------------------------------ */
/*  Control-flow validation                                           */
/* ------------------------------------------------------------------ */

/**
 * Zero source span for document-derived control-flow warnings: they point at
 * an instruction anchor in the authority document, not a DSL source position.
 */
const CONTROL_FLOW_ZERO_SPAN: EmevdDslSourceSpan = {
  start: { offset: 0, line: 0, column: 0 },
  end: { offset: 0, line: 0, column: 0 }
};

/**
 * Control-flow diagnostics are warning-only: they never block compilation.
 * createEmevdDslDiagnostic defaults to 'error', so the severity is overridden.
 */
function controlFlowWarning(
  code: string,
  message: string,
  resourceUri: string,
  targetAnchor?: string
): EmevdDslDiagnostic {
  return {
    ...diagnostic(code, message, CONTROL_FLOW_ZERO_SPAN, {
      resourceUri,
      ...(targetAnchor !== undefined ? { targetAnchor } : {})
    }),
    severity: 'warning'
  };
}

/**
 * Best-effort control-flow validation: when event IDs are changed by the
 * plan, scan every schema-known instruction in the document for references
 * to the old event ID and emit a warning for each dangling reference found.
 *
 * Schema-driven: any decoded arg that is an event ID reference (arg name
 * contains "eventId", or the description mentions "event") is covered, so an
 * imported GotoEvent-style instruction is checked automatically without
 * hardcoding a bank/id. Instructions with no schema or marked unknown are
 * skipped silently.
 *
 * This does NOT block compilation — it only emits warnings. The user may
 * intentionally update event IDs and fix references in a subsequent patch.
 */
function validateEventIdReferences(
  document: EmevdEditorDocument,
  operations: EmevdPlannedMutation[],
  registry: EmedfRegistry,
  diagnostics: EmevdDslDiagnostic[],
  resourceUri: string
): void {
  // Collect event ID changes: old ID → new ID
  const eventIdChanges = new Map<number, number>();
  for (const op of operations) {
    if (op.kind === 'set_event_id') {
      eventIdChanges.set(op.before, op.after);
    }
  }
  if (eventIdChanges.size === 0) return;

  const changedOldIds = new Set(eventIdChanges.keys());
  for (const event of document.events) {
    for (const instruction of event.instructions) {
      if (instruction.unknown) continue; // Unknown instructions stay opaque
      const definition = findInstructionDef(registry, instruction.bank, instruction.id);
      if (!definition) continue; // Can't validate without schema

      let rawArgs: Buffer;
      try {
        rawArgs = decodeStrictBase64(instruction.argsBase64, { allowEmpty: true });
      } catch {
        continue; // Can't decode, skip
      }

      const decoded = decodeInstructionArgs(registry, instruction.bank, instruction.id, rawArgs);
      if (!decoded.ok) continue;

      const references = extractEventIdReferences(registry, instruction.bank, instruction.id, decoded.args);
      if (!references) continue;

      for (const referencedEventId of references) {
        if (changedOldIds.has(referencedEventId)) {
          const newId = eventIdChanges.get(referencedEventId);
          const targetAnchor = instruction.anchor ? formatEmevdAnchor('instruction', instruction.anchor) : undefined;
          diagnostics.push(controlFlowWarning(
            'EMEVD_DSL_EVENT_ID_REFERENCE_STALE',
            `Instruction ${definition.name} (${instruction.bank}:${instruction.id}) in event ${event.eventId} references event ID ${referencedEventId} which is being changed to ${newId}. Update the reference or the target event ID will be dangling.`,
            resourceUri,
            targetAnchor
          ));
        }
      }
    }
  }
}

/**
 * Best-effort control-flow validation: warn on invalid or uninitialized
 * condition group references. A condition group reference is any decoded arg
 * whose name contains "conditionGroup" (or whose description mentions
 * "condition group"). References with value 0 or negative are invalid;
 * references to condition groups never produced by a resultConditionGroup-style
 * arg are dangling. Schema-driven and warning-only: unknown instructions and
 * instructions without schema are skipped silently, and warnings never block
 * the plan.
 */
function validateConditionGroupReferences(
  document: EmevdEditorDocument,
  registry: EmedfRegistry,
  diagnostics: EmevdDslDiagnostic[],
  resourceUri: string
): void {
  // Condition groups "initialized" by an instruction result arg (e.g.
  // IfConditionGroup.resultConditionGroup) may be referenced elsewhere.
  const initialized = new Set<number>();
  const references: Array<{
    value: number;
    event: EmevdEditorDocument['events'][number];
    instruction: EmevdEditorDocument['events'][number]['instructions'][number];
  }> = [];

  for (const event of document.events) {
    for (const instruction of event.instructions) {
      if (instruction.unknown) continue; // Unknown instructions stay opaque
      if (!findInstructionDef(registry, instruction.bank, instruction.id)) continue;

      let rawArgs: Buffer;
      try {
        rawArgs = decodeStrictBase64(instruction.argsBase64, { allowEmpty: true });
      } catch {
        continue; // Can't decode, skip
      }

      const decoded = decodeInstructionArgs(registry, instruction.bank, instruction.id, rawArgs);
      if (!decoded.ok) continue;

      const groupReferences = extractConditionGroupReferences(
        registry, instruction.bank, instruction.id, decoded.args
      );
      if (groupReferences) {
        for (const value of groupReferences) references.push({ value, event, instruction });
      }
      const results = extractConditionGroupResults(
        registry, instruction.bank, instruction.id, decoded.args
      );
      if (results) {
        for (const value of results) initialized.add(value);
      }
    }
  }

  for (const reference of references) {
    const { value, event, instruction } = reference;
    const targetAnchor = instruction.anchor ? formatEmevdAnchor('instruction', instruction.anchor) : undefined;
    if (value <= 0) {
      diagnostics.push(controlFlowWarning(
        'EMEVD_DSL_CONDITION_GROUP_INVALID_REFERENCE',
        `Condition group reference ${value} in event ${event.eventId} is invalid; condition groups must be positive integers.`,
        resourceUri,
        targetAnchor
      ));
    } else if (!initialized.has(value)) {
      diagnostics.push(controlFlowWarning(
        'EMEVD_DSL_CONDITION_GROUP_UNINITIALIZED',
        `Condition group ${value} referenced in event ${event.eventId} is never initialized.`,
        resourceUri,
        targetAnchor
      ));
    }
  }
}

function compareDiagnostics(a: EmevdDslDiagnostic, b: EmevdDslDiagnostic): number {
  return a.span.start.offset - b.span.start.offset || a.code.localeCompare(b.code) || a.message.localeCompare(b.message);
}
