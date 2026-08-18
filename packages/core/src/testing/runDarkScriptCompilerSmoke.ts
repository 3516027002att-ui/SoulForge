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
        id: 11,
        name: 'WAIT Fixed Time Frames',
        args: [
          { name: 'frames', type: 'u32' }
        ]
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
    mode: 'dark-script' as const
  };

  const unchanged = compileEmevdDarkScript(request, document, emedf);
  if (!unchanged.ok) fail(JSON.stringify(unchanged.diagnostics));
  if (unchanged.plan.operations.length !== 0) fail('identical source must be a no-op plan');

  // 旧 patch 枚举仍须兼容（测试与外部调用方可能沿用）。
  const legacyMode = compileEmevdDarkScript({ ...request, mode: 'patch' as const }, document, emedf);
  if (!legacyMode.ok) fail(`patch mode must stay accepted: ${JSON.stringify(legacyMode.diagnostics)}`);

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

  // 新增一行可编码指令 → insert_instruction（下标按删除已应用后的列表）。
  const insertedLine = source.replace(
    '    InitializeEvent(0, 77770001, 0);',
    '    InitializeEvent(0, 77770001, 0);\n    WaitFixedTimeFrames(30);'
  );
  const insertResult = compileEmevdDarkScript({ ...request, sourceText: insertedLine }, document, emedf);
  if (!insertResult.ok) fail(`insert 编译失败: ${JSON.stringify(insertResult.diagnostics)}`);
  const insertOp = insertResult.plan.operations.find((operation) => operation.kind === 'insert_instruction');
  if (!insertOp || insertOp.kind !== 'insert_instruction') fail('expected insert_instruction');
  if (insertOp.bank !== 2000 || insertOp.id !== 11 || insertOp.index !== 1) {
    fail(JSON.stringify(insertOp));
  }

  // 删除一行 → delete_instruction（下标是原始文档中该事件内的位置）。
  const deletedLine = source.replace('    InitializeEvent(0, 77770001, 0);\n', '');
  const deleteResult = compileEmevdDarkScript({ ...request, sourceText: deletedLine }, document, emedf);
  if (!deleteResult.ok) fail(`delete 编译失败: ${JSON.stringify(deleteResult.diagnostics)}`);
  const deleteOp = deleteResult.plan.operations.find((operation) => operation.kind === 'delete_instruction');
  if (!deleteOp || deleteOp.kind !== 'delete_instruction') fail('expected delete_instruction');
  if (deleteOp.index !== 0 || deleteOp.bank !== 2000 || deleteOp.id !== 6) {
    fail(JSON.stringify(deleteOp));
  }

  // 新增 $Event 块 → insert_event + insert_instruction（指向新事件）。
  const extraEvent = `${source}\n\n$Event(99, Default, function() {\n    EndEvent();\n});`;
  const extra = compileEmevdDarkScript({ ...request, sourceText: extraEvent }, document, emedf);
  if (!extra.ok) fail(`新增事件应编译成功: ${JSON.stringify(extra.diagnostics)}`);
  const insertEventOp = extra.plan.operations.find((operation) => operation.kind === 'insert_event');
  if (!insertEventOp || insertEventOp.kind !== 'insert_event' || insertEventOp.eventId !== 99) {
    fail(JSON.stringify(extra.plan.operations));
  }
  const newEventInstr = extra.plan.operations.find((operation) => operation.kind === 'insert_instruction');
  if (!newEventInstr || newEventInstr.kind !== 'insert_instruction'
    || newEventInstr.eventId !== 99 || newEventInstr.eventAnchor !== '' || newEventInstr.index !== 0) {
    fail(JSON.stringify(extra.plan.operations));
  }

  // 删掉原事件、只留一个新 id 的块：按位置配对视为改 id（1:1），走 set_event_id。
  const renamedOnlySource = '$Event(99, Default, function() {\n    EndEvent();\n});';
  const deletedEvent = compileEmevdDarkScript({ ...request, sourceText: renamedOnlySource }, document, emedf);
  if (!deletedEvent.ok) fail(`改 id 场景应编译成功: ${JSON.stringify(deletedEvent.diagnostics)}`);
  if (!deletedEvent.plan.operations.some((operation) => operation.kind === 'set_event_id')) {
    fail(`改 id 场景应产生 set_event_id: ${JSON.stringify(deletedEvent.plan.operations)}`);
  }

  // 新增一个无法编码的指令行 → 该事件结构性改动抑制，只留 warning。
  const badInsert = source.replace(
    '    InitializeEvent(0, 77770001, 0);',
    '    NotARealInstruction(1, 2, 3);\n    InitializeEvent(0, 77770001, 0);'
  );
  const badInsertResult = compileEmevdDarkScript({ ...request, sourceText: badInsert }, document, emedf);
  if (badInsertResult.ok && badInsertResult.plan.operations.length > 0) {
    fail(`无法编码的新增行不得产生结构性写入: ${JSON.stringify(badInsertResult.plan.operations)}`);
  }
  if (!badInsertResult.diagnostics.some((item) => item.code === 'DARKSCRIPT_LINE_UNDECODED')) {
    fail(JSON.stringify(badInsertResult.diagnostics));
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
