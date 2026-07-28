import {
  parseEmevdDsl,
  renderTypedEmevdDsl
} from '../emevd/emevdDsl.js';
import { createSekiroFixtureEmedf } from '../emevd/emedfSchema.js';
import {
  applyEmevdEditorMutation,
  compileEmevdEditorDsl,
  createEmevdEditorDocument
} from '../editing/emevdFourViewController.js';

function main(): void {
  const registry = createSekiroFixtureEmedf();
  const typedArgs = Buffer.alloc(12);
  typedArgs.writeInt8(1, 0);
  typedArgs.writeUInt8(0, 1);
  typedArgs.writeInt8(-1, 2);
  const opaqueArgs = Buffer.from([0xaa, 0xbb]);
  const document = createEmevdEditorDocument({
    resourceUri: 'file://event/common.emevd',
    events: [{
      eventId: 50,
      restBehavior: 0,
      layer: -1,
      instructions: [
        { bank: 2000, id: 0, argsBase64: typedArgs.toString('base64'), unknown: false },
        { bank: 9999, id: 7, argsBase64: opaqueArgs.toString('base64'), unknown: true }
      ]
    }]
  });

  const canonical = renderTypedEmevdDsl(document, registry);
  const parsed = parseEmevdDsl(`// fixture-confirmed parser smoke\n${canonical}`);
  if (!parsed.ok || parsed.ast.events.length !== 1) {
    throw new Error(`canonical parse failed: ${JSON.stringify(parsed)}`);
  }
  const noOp = compileEmevdEditorDsl({ text: canonical, document, registry });
  if (!noOp.ok || noOp.proposal.mutations.length !== 0) {
    throw new Error(`canonical no-op failed: ${JSON.stringify(noOp)}`);
  }
  const trailingBytes = Buffer.concat([typedArgs, Buffer.from([1, 2, 3, 4])]);
  const trailingDocument = createEmevdEditorDocument({
    resourceUri: 'file://event/trailing.emevd',
    events: [{
      eventId: 1,
      restBehavior: 0,
      instructions: [{
        bank: 2000,
        id: 0,
        argsBase64: trailingBytes.toString('base64'),
        unknown: false
      }]
    }]
  });
  const trailingDsl = renderTypedEmevdDsl(trailingDocument, registry);
  if (!trailingDsl.includes('unknown(')) {
    throw new Error('non-roundtrippable typed payload must render as opaque');
  }
  const trailingNoOp = compileEmevdEditorDsl({
    text: trailingDsl,
    document: trailingDocument,
    registry
  });
  if (!trailingNoOp.ok || trailingNoOp.proposal.mutations.length !== 0) {
    throw new Error('opaque trailing bytes no-op must remain lossless');
  }

  const edited = canonical
    .replace('Rest=0', 'Rest=1')
    .replace('resultConditionGroup=1', 'resultConditionGroup=5');
  const compiled = compileEmevdEditorDsl({ text: edited, document, registry });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled));
  if (compiled.proposal.authority !== 'fixture-confirmed') throw new Error('authority escalated');
  if (compiled.proposal.mutations.length !== 2) throw new Error('expected arg + rest mutations');
  if (compiled.proposal.mutations[0]?.kind !== 'emevd_set_instruction_args'
    || compiled.proposal.mutations[0].baseRevision !== 0
    || compiled.proposal.mutations[1]?.kind !== 'emevd_set_rest_behavior'
    || compiled.proposal.mutations[1].baseRevision !== 1) {
    throw new Error(`mutation ordering/revision mismatch: ${JSON.stringify(compiled.proposal)}`);
  }
  if (document.revision !== 0 || document.events[0]?.restBehavior !== 0) {
    throw new Error('compiler mutated the source document');
  }

  let applied = document;
  for (const mutation of compiled.proposal.mutations) {
    const result = applyEmevdEditorMutation(applied, mutation);
    if (!result.ok) throw new Error(JSON.stringify(result));
    applied = result.document;
  }
  if (applied.revision !== 2 || applied.events[0]?.restBehavior !== 1) {
    throw new Error('proposal did not apply through structured mutation controller');
  }
  const appliedArgs = Buffer.from(applied.events[0]!.instructions[0]!.argsBase64, 'base64');
  if (appliedArgs.readInt8(0) !== 5) throw new Error('typed arg mutation missing');

  expectCompileCode(
    canonical.replace(opaqueArgs.toString('base64'), Buffer.from([0xaa, 0xbc]).toString('base64')),
    document,
    registry,
    'EMEVD_DSL_UNKNOWN_INSTRUCTION_EDIT_FORBIDDEN'
  );
  expectCompileCode(
    canonical.replace('resultConditionGroup=1', 'resultConditionGroup=999'),
    document,
    registry,
    'EMEDF_ARG_OUT_OF_RANGE'
  );
  expectCompileCode(
    canonical.replace('pad2=0)', 'pad2=0, extra=1)'),
    document,
    registry,
    'EMEDF_EXTRA_ARG'
  );
  expectCompileCode(
    canonical.replace('Rest=0', 'Rest=-1'),
    document,
    registry,
    'EMEVD_DSL_REST_BEHAVIOR_OUT_OF_RANGE'
  );
  const duplicateRegistry = {
    ...registry,
    instructions: [...registry.instructions, { ...registry.instructions[0]! }]
  };
  expectCompileCode(
    canonical,
    document,
    duplicateRegistry,
    'EMEDF_DUPLICATE_INSTRUCTION'
  );

  const unknownInstruction = document.events[0]!.instructions[1]!;
  const unknownLine = `  unknown(Uri=${JSON.stringify(unknownInstruction.instructionUri)}, Bank=9999, Id=7, ArgsBase64=${JSON.stringify(unknownInstruction.argsBase64)});`;
  const falselyTypedLine = `  typed(Uri=${JSON.stringify(unknownInstruction.instructionUri)}, Bank=9999, Id=7, Args=());`;
  expectCompileCode(
    canonical.replace(unknownLine, falselyTypedLine),
    document,
    registry,
    'EMEVD_DSL_OPAQUE_INSTRUCTION'
  );
  expectCompileCode(
    canonical.replace(/\n  unknown\([^\n]+/, ''),
    document,
    registry,
    'EMEVD_DSL_INSTRUCTION_STRUCTURE_CHANGED'
  );

  const syntaxFailure = parseEmevdDsl('$Resource(Uri="file://event/common.emevd")\n$Event(');
  if (syntaxFailure.ok || syntaxFailure.diagnostics[0]?.location?.line !== 2) {
    throw new Error(`syntax diagnostics missing location: ${JSON.stringify(syntaxFailure)}`);
  }

  const idEdited = canonical.replace('$Event(Id=50', '$Event(Id=51');
  const idProposal = compileEmevdEditorDsl({ text: idEdited, document, registry });
  if (!idProposal.ok || idProposal.proposal.mutations.length !== 1
    || idProposal.proposal.mutations[0]?.kind !== 'emevd_update_id') {
    throw new Error(`event id proposal failed: ${JSON.stringify(idProposal)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'EMEVD DSL lexer/parser/EMEDF typecheck/proposal smoke passed',
    authority: compiled.proposal.authority,
    noOpRoundTrip: true,
    opaqueTrailingBytesPreserved: true,
    mutationKinds: compiled.proposal.mutations.map((mutation) => mutation.kind),
    negativeCodes: [
      'EMEVD_DSL_UNKNOWN_INSTRUCTION_EDIT_FORBIDDEN',
      'EMEDF_ARG_OUT_OF_RANGE',
      'EMEDF_EXTRA_ARG',
      'EMEVD_DSL_REST_BEHAVIOR_OUT_OF_RANGE',
      'EMEDF_DUPLICATE_INSTRUCTION',
      'EMEVD_DSL_OPAQUE_INSTRUCTION',
      'EMEVD_DSL_INSTRUCTION_STRUCTURE_CHANGED'
    ],
    sourceLocationDiagnostics: true,
    bridgeWrites: 0
  }, null, 2));
}

function expectCompileCode(
  text: string,
  document: Parameters<typeof compileEmevdEditorDsl>[0]['document'],
  registry: Parameters<typeof compileEmevdEditorDsl>[0]['registry'],
  code: string
): void {
  const result = compileEmevdEditorDsl({ text, document, registry });
  if (result.ok || !result.diagnostics.some((item) => item.code === code)) {
    throw new Error(`expected ${code}: ${JSON.stringify(result)}`);
  }
}

main();
