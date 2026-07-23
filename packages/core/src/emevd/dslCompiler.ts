import { createHash } from 'node:crypto';
import type {
  EmevdDslCompileRequest,
  EmevdDslCompileResult,
  EmevdDslDiagnostic,
  EmevdDslDocument,
  EmevdDslLiteral,
  EmevdEditorDocument,
  EmevdMutationPlan,
  EmevdPlannedMutation
} from '@soulforge/shared';
import type { EmedfArgType, EmedfRegistry } from './emedfSchema.js';
import { decodeInstructionArgs, findInstructionDef } from './emedfSchema.js';
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
      const instruction = bound.instruction;
      if (instruction.unknown) {
        add(diagnostic(
          'EMEVD_DSL_UNKNOWN_INSTRUCTION_READONLY',
          'Unknown instruction is read-only.',
          instructionPatch.span,
          { resourceUri: request.resourceUri, targetAnchor: instructionPatch.anchor }
        ));
        continue;
      }
      const definition = findInstructionDef(registry, instruction.bank, instruction.id);
      if (!definition) {
        add(diagnostic(
          'EMEVD_DSL_UNKNOWN_INSTRUCTION_READONLY',
          'Instruction has no EMEDF schema and is read-only.',
          instructionPatch.span,
          { resourceUri: request.resourceUri, targetAnchor: instructionPatch.anchor }
        ));
        continue;
      }
      let rawArgs: Buffer;
      try {
        rawArgs = decodeStrictBase64(instruction.argsBase64, { allowEmpty: true });
      } catch {
        add(diagnostic('EMEVD_DSL_ANCHOR_PRECONDITION_FAILED', 'Instruction payload is not valid base64.', instructionPatch.span, {
          resourceUri: request.resourceUri,
          targetAnchor: instructionPatch.anchor
        }));
        continue;
      }
      const decoded = decodeInstructionArgs(registry, instruction.bank, instruction.id, rawArgs);
      if (!decoded.ok) {
        add(diagnostic('EMEVD_DSL_ANCHOR_PRECONDITION_FAILED', decoded.message, instructionPatch.span, {
          resourceUri: request.resourceUri,
          targetAnchor: instructionPatch.anchor
        }));
        continue;
      }
      const decodedByName = new Map(decoded.args.map((arg) => [arg.name, arg]));
      const seenArgs = new Set<string>();
      for (const operation of instructionPatch.operations) {
        if (seenArgs.has(operation.argument)) {
          add(diagnostic('EMEVD_DSL_DUPLICATE_ARGUMENT', `Duplicate argument ${operation.argument}.`, operation.span, {
            resourceUri: request.resourceUri,
            targetAnchor: instructionPatch.anchor
          }));
          continue;
        }
        seenArgs.add(operation.argument);
        const argDef = definition.args.find((arg) => arg.name === operation.argument);
        const before = decodedByName.get(operation.argument);
        if (!argDef || !before) {
          add(diagnostic('EMEVD_DSL_UNKNOWN_ARGUMENT', `Unknown argument ${operation.argument}.`, operation.span, {
            resourceUri: request.resourceUri,
            targetAnchor: instructionPatch.anchor
          }));
          continue;
        }
        const valueError = validateTypedLiteral(argDef.type, operation.value);
        if (valueError) {
          add(diagnostic(valueError.code, valueError.message, operation.span, {
            resourceUri: request.resourceUri,
            targetAnchor: instructionPatch.anchor
          }));
          continue;
        }
        if (!Object.is(before.value, operation.value)) {
          operations.push({
            kind: 'set_instruction_arg',
            eventAnchor: eventPatch.anchor,
            instructionAnchor: instructionPatch.anchor,
            target: instructionAnchor,
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
  }

  const ids = new Map<number, string>();
  for (const [anchor, id] of nextEventIds) {
    const previous = ids.get(id);
    if (previous !== undefined && previous !== anchor) {
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

function compareDiagnostics(a: EmevdDslDiagnostic, b: EmevdDslDiagnostic): number {
  return a.span.start.offset - b.span.start.offset || a.code.localeCompare(b.code) || a.message.localeCompare(b.message);
}
