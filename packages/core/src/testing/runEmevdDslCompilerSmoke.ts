import type { EmevdDslCompileRequest } from '@soulforge/shared';
import {
  applyEmevdEditorMutation,
  createEmevdEditorDocument,
  renderEmevdDsl
} from '../editing/emevdFourViewController.js';
import {
  compileEmevdPatchDsl,
  fingerprintEmedfRegistry
} from '../emevd/dslCompiler.js';
import { formatEmevdAnchor } from '../emevd/stableIdentity.js';
import {
  createSekiroFixtureEmedf,
  encodeInstructionArgs
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

  console.log(JSON.stringify({
    ok: true,
    message: 'EMEVD DSL Slice A+B stable identity/parser/deterministic plan smoke passed',
    planFingerprint: compiled.plan.planFingerprint,
    operations: compiled.plan.operations.map((operation) => operation.kind),
    diagnosticsCovered: [
      'EMEVD_DSL_STALE_REVISION',
      'EMEVD_DSL_SCHEMA_REQUIRED',
      'EMEVD_DSL_SCHEMA_CHANGED',
      'EMEVD_DSL_INTEGER_OUT_OF_RANGE',
      'EMEVD_DSL_UNKNOWN_INSTRUCTION_READONLY',
      'EMEVD_DSL_EVENT_ID_DUPLICATE',
      'EMEVD_DSL_SYNTAX_ERROR'
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

main();
