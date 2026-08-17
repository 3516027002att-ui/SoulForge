import { createEmevdEditorDocument } from '../editing/emevdFourViewController.js';
import { compileEmevdDarkScript, looksLikeDarkScript } from '../emevd/darkScriptCompiler.js';
import { fingerprintEmedfRegistry } from '../emevd/dslCompiler.js';
import { renderEmevdDarkScript } from '../emevd/darkScriptRenderer.js';
import { encodeInstructionArgs, type EmedfRegistry } from '../emevd/emedfSchema.js';

function fail(message: string): never {
  throw new Error(message);
}

function registry(): EmedfRegistry {
  return {
    schemaVersion: 1,
    game: 'sekiro',
    origin: 'fixture',
    instructions: [
      {
        bank: 2003,
        id: 1,
        name: 'EndEvent',
        args: []
      },
      {
        bank: 2000,
        id: 6,
        name: 'InitializeEvent',
        args: [
          { name: 'slotNumber', type: 's32' },
          { name: 'eventId', type: 's32' },
          { name: 'arg', type: 's32' }
        ]
      }
    ]
  };
}

function main(): void {
  const emedf = registry();
  const encoded = encodeInstructionArgs(emedf, 2000, 6, {
    slotNumber: 0,
    eventId: 77770001,
    arg: 0
  });
  if (!encoded.ok) fail(JSON.stringify(encoded));

  const document = createEmevdEditorDocument({
    resourceUri: 'file://event/common.emevd',
    documentInstanceId: 'darkscript-compiler-smoke',
    events: [
      {
        eventId: 50,
        restBehavior: 0,
        instructions: [
          {
            bank: 2000,
            id: 6,
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
      }
    ]
  });
  const event = document.events[0]!;
  const typed = event.instructions[0]!;
  if (!document.documentInstanceId || !event.anchor || !typed.anchor) {
    fail('stable identity missing');
  }

  const source = renderEmevdDarkScript(document, emedf);
  if (!looksLikeDarkScript(source)) fail('renderer output should look like DarkScript');
  if (!source.includes('InitializeEvent(0, 77770001, 0)')) fail(`unexpected render:\n${source}`);

  const request = {
    schemaVersion: 1 as const,
    resourceUri: document.resourceUri,
    documentInstanceId: document.documentInstanceId,
    baseRevision: document.revision,
    emedfSchemaFingerprint: fingerprintEmedfRegistry(emedf),
    sourceText: source,
    mode: 'patch' as const
  };

  const unchanged = compileEmevdDarkScript(request, document, emedf);
  if (!unchanged.ok) fail(JSON.stringify(unchanged.diagnostics));
  if (unchanged.plan.operations.length !== 0) fail('identical source must be a no-op plan');

  const edited = source.replace('InitializeEvent(0, 77770001, 0)', 'InitializeEvent(1, 77770001, 0)');
  const changed = compileEmevdDarkScript({ ...request, sourceText: edited }, document, emedf);
  if (!changed.ok) fail(JSON.stringify(changed.diagnostics));
  const argOp = changed.plan.operations.find((operation) => operation.kind === 'set_instruction_arg');
  if (!argOp || argOp.kind !== 'set_instruction_arg') fail('expected set_instruction_arg');
  if (argOp.argument !== 'slotNumber' || argOp.before !== 0 || argOp.after !== 1) {
    fail(JSON.stringify(argOp));
  }

  const restEdited = source.replace('Default', 'Restart');
  const restChanged = compileEmevdDarkScript({ ...request, sourceText: restEdited }, document, emedf);
  if (!restChanged.ok) fail(JSON.stringify(restChanged.diagnostics));
  const restOp = restChanged.plan.operations.find((operation) => operation.kind === 'set_event_rest_behavior');
  if (!restOp || restOp.kind !== 'set_event_rest_behavior' || restOp.after !== 1) {
    fail(JSON.stringify(restChanged.plan.operations));
  }

  const extraEvent = `${source}\n\n$Event(99, Default, function() {\n    EndEvent();\n});`;
  const extra = compileEmevdDarkScript({ ...request, sourceText: extraEvent }, document, emedf);
  if (extra.ok) fail('new event must not fake-success');
  if (!extra.diagnostics.some((item) => item.code === 'DARKSCRIPT_LINE_UNDECODED')) {
    fail(JSON.stringify(extra.diagnostics));
  }

  const unknownTouched = source.replace('// unknown bank=9999 id=1', '// I deleted the unknown instruction');
  const opaque = compileEmevdDarkScript({ ...request, sourceText: unknownTouched }, document, emedf);
  if (opaque.ok) fail('rewriting an unknown comment must not fake-success');
  if (!opaque.diagnostics.some((item) => item.code === 'DARKSCRIPT_LINE_UNDECODED')) {
    fail(JSON.stringify(opaque.diagnostics));
  }

  process.stdout.write('darkScriptCompiler smoke: ok\n');
}

main();
