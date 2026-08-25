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

  // === P0 Parameter Binding Reindexing & Generation Tests ===
  // 1. 前插指令导致已有 X 参数指令的 instructionIndex 重排（从 1 变 2）
  const paramEventDoc = createEmevdEditorDocument({
    resourceUri: 'file://event/param_test.emevd',
    documentInstanceId: 'darkscript-param-test',
    events: [
      {
        eventId: 100,
        restBehavior: 0,
        parameters: [
          {
            instructionIndex: 1,
            targetStartByte: 8,
            sourceStartByte: 0,
            byteCount: 4,
            unkId: 0
          }
        ],
        instructions: [
          {
            bank: 2003,
            id: 1,
            argsBase64: '',
            unknown: false
          },
          {
            bank: 2000,
            id: 6,
            argsBase64: encoded.args.toString('base64'),
            unknown: false
          }
        ]
      }
    ]
  });

  const paramSource = renderEmevdDarkScript(paramEventDoc, emedf);
  if (!paramSource.includes('InitializeEvent(0, 77770001, X0_4)')) {
    fail(`parameter render missing:\n${paramSource}`);
  }

  const paramReq = {
    schemaVersion: 1 as const,
    resourceUri: paramEventDoc.resourceUri,
    documentInstanceId: paramEventDoc.documentInstanceId ?? 'darkscript-param-test',
    baseRevision: paramEventDoc.revision,
    emedfSchemaFingerprint: fingerprintEmedfRegistry(emedf),
    sourceText: paramSource,
    mode: 'dark-script' as const
  };

  // 在最前面插入 WaitFixedTimeFrames(10)
  const paramSourceInserted = paramSource.replace(
    '    EndEvent();',
    '    WaitFixedTimeFrames(10);\n    EndEvent();'
  );
  const paramInsertResult = compileEmevdDarkScript({ ...paramReq, sourceText: paramSourceInserted }, paramEventDoc, emedf);
  if (!paramInsertResult.ok) fail(`前插指令编译失败: ${JSON.stringify(paramInsertResult.diagnostics)}`);
  const paramSetOp = paramInsertResult.plan.operations.find((op) => op.kind === 'set_event_parameters');
  if (!paramSetOp || paramSetOp.kind !== 'set_event_parameters') {
    fail('前插指令后必须产生 set_event_parameters');
  }
  if (paramSetOp.parameters.length !== 1 || paramSetOp.parameters[0]!.instructionIndex !== 2) {
    fail(`前插指令后 instructionIndex 必须从 1 变 2，得到: ${JSON.stringify(paramSetOp.parameters)}`);
  }
  if (paramSetOp.parameters[0]!.targetStartByte !== 8 || paramSetOp.parameters[0]!.sourceStartByte !== 0 || paramSetOp.parameters[0]!.byteCount !== 4) {
    fail(`参数 offset/byteCount 错误: ${JSON.stringify(paramSetOp.parameters[0])}`);
  }

  // 2. 删除第一条指令导致已有 X 参数指令 instructionIndex 整体前移（从 1 变 0）
  const paramSourceDeleted = paramSource.replace('    EndEvent();\n', '');
  const paramDeleteResult = compileEmevdDarkScript({ ...paramReq, sourceText: paramSourceDeleted }, paramEventDoc, emedf);
  if (!paramDeleteResult.ok) fail(`删除前置指令编译失败: ${JSON.stringify(paramDeleteResult.diagnostics)}`);
  const paramDeleteSetOp = paramDeleteResult.plan.operations.find((op) => op.kind === 'set_event_parameters');
  if (!paramDeleteSetOp || paramDeleteSetOp.kind !== 'set_event_parameters') {
    fail('删除前置指令后必须产生 set_event_parameters');
  }
  if (paramDeleteSetOp.parameters.length !== 1 || paramDeleteSetOp.parameters[0]!.instructionIndex !== 0) {
    fail(`删除前置指令后 instructionIndex 必须从 1 变 0，得到: ${JSON.stringify(paramDeleteSetOp.parameters)}`);
  }

  // 3. 新插入指令中带 X 参数必须生成参数绑定
  const paramSourceNewX = paramSource.replace(
    '    InitializeEvent(0, 77770001, X0_4);',
    '    InitializeEvent(0, 77770001, X0_4);\n    InitializeEvent(X4_4, 77770002, 0);'
  );
  const paramNewXResult = compileEmevdDarkScript({ ...paramReq, sourceText: paramSourceNewX }, paramEventDoc, emedf);
  if (!paramNewXResult.ok) fail(`插入带 X 参数指令编译失败: ${JSON.stringify(paramNewXResult.diagnostics)}`);
  const paramNewXSetOp = paramNewXResult.plan.operations.find((op) => op.kind === 'set_event_parameters');
  if (!paramNewXSetOp || paramNewXSetOp.kind !== 'set_event_parameters') {
    fail('插入带 X 参数指令后必须产生 set_event_parameters');
  }
  if (paramNewXSetOp.parameters.length !== 2) {
    fail(`必须包含 2 条参数绑定，得到: ${JSON.stringify(paramNewXSetOp.parameters)}`);
  }
  const newBinding = paramNewXSetOp.parameters.find((p) => p.sourceStartByte === 4);
  if (!newBinding || newBinding.instructionIndex !== 2 || newBinding.targetStartByte !== 0 || newBinding.byteCount !== 4) {
    fail(`新插入指令参数绑定错位: ${JSON.stringify(newBinding)}`);
  }

  // 4. 同一指令包含多个 X 参数
  const multiParamSource = paramSource.replace(
    '    InitializeEvent(0, 77770001, X0_4);',
    '    InitializeEvent(X0_4, X4_4, X8_4);'
  );
  const multiParamResult = compileEmevdDarkScript({ ...paramReq, sourceText: multiParamSource }, paramEventDoc, emedf);
  if (!multiParamResult.ok) fail(`多参数编译失败: ${JSON.stringify(multiParamResult.diagnostics)}`);
  const multiParamSetOp = multiParamResult.plan.operations.find((op) => op.kind === 'set_event_parameters');
  if (!multiParamSetOp || multiParamSetOp.kind !== 'set_event_parameters' || multiParamSetOp.parameters.length !== 3) {
    fail(`同一指令 3 参数必须生成 3 条绑定: ${JSON.stringify(multiParamSetOp?.parameters)}`);
  }
  if (multiParamSetOp.parameters[0]!.targetStartByte !== 0 || multiParamSetOp.parameters[1]!.targetStartByte !== 4 || multiParamSetOp.parameters[2]!.targetStartByte !== 8) {
    fail(`多参数 targetStartByte 不正确: ${JSON.stringify(multiParamSetOp.parameters)}`);
  }

  // 5. 修改 X 符号（X0_4 -> X16_4）
  const modSymbolSource = paramSource.replaceAll('X0_4', 'X16_4');
  const modSymbolResult = compileEmevdDarkScript({ ...paramReq, sourceText: modSymbolSource }, paramEventDoc, emedf);
  if (!modSymbolResult.ok) fail(`修改 X 符号编译失败: ${JSON.stringify(modSymbolResult.diagnostics)}`);
  const modSymbolOp = modSymbolResult.plan.operations.find((op) => op.kind === 'set_event_parameters');
  if (!modSymbolOp || modSymbolOp.kind !== 'set_event_parameters' || modSymbolOp.parameters[0]!.sourceStartByte !== 16) {
    fail(`修改 X 符号后 sourceStartByte 必须变 16: ${JSON.stringify(modSymbolOp?.parameters)}`);
  }

  // 6. X 改成 literal（绑定消失）
  const xToLitSource = paramSource.replace('InitializeEvent(0, 77770001, X0_4);', 'InitializeEvent(0, 77770001, 12345);').replace('function(X0_4)', 'function()');
  const xToLitResult = compileEmevdDarkScript({ ...paramReq, sourceText: xToLitSource }, paramEventDoc, emedf);
  if (!xToLitResult.ok) fail(`X 改 literal 编译失败: ${JSON.stringify(xToLitResult.diagnostics)}`);
  const xToLitOp = xToLitResult.plan.operations.find((op) => op.kind === 'set_event_parameters');
  if (!xToLitOp || xToLitOp.kind !== 'set_event_parameters' || xToLitOp.parameters.length !== 0) {
    fail(`X 改 literal 后参数表必须清空: ${JSON.stringify(xToLitOp?.parameters)}`);
  }

  // 7. 新增整个 Event 携带 X 参数
  const addEventWithXSource = `${source}\n\n$Event(200, Default, function(X0_4, X4_4) {\n    InitializeEvent(X0_4, 10, X4_4);\n});`;
  const addEventWithXResult = compileEmevdDarkScript({ ...request, sourceText: addEventWithXSource }, document, emedf);
  if (!addEventWithXResult.ok) fail(`新增带 X 参数事件编译失败: ${JSON.stringify(addEventWithXResult.diagnostics)}`);
  const addEventSetParamsOp = addEventWithXResult.plan.operations.find(
    (op) => op.kind === 'set_event_parameters' && op.eventId === 200
  );
  if (!addEventSetParamsOp || addEventSetParamsOp.kind !== 'set_event_parameters') {
    fail('新增带 X 参数事件必须生成 set_event_parameters');
  }
  if (addEventSetParamsOp.parameters.length !== 2) {
    fail(`新增事件应有 2 条参数绑定，得到: ${JSON.stringify(addEventSetParamsOp.parameters)}`);
  }
  if (addEventSetParamsOp.parameters[0]!.instructionIndex !== 0 || addEventSetParamsOp.parameters[0]!.targetStartByte !== 0 || addEventSetParamsOp.parameters[0]!.sourceStartByte !== 0) {
    fail(`新增事件参数 0 绑定错误: ${JSON.stringify(addEventSetParamsOp.parameters[0])}`);
  }
  if (addEventSetParamsOp.parameters[1]!.instructionIndex !== 0 || addEventSetParamsOp.parameters[1]!.targetStartByte !== 8 || addEventSetParamsOp.parameters[1]!.sourceStartByte !== 4) {
    fail(`新增事件参数 1 绑定错误: ${JSON.stringify(addEventSetParamsOp.parameters[1])}`);
  }

  // 8. opaque 指令的隐藏 binding 必须在 no-op roundtrip 中保留，并在前插后重排。
  const opaqueBindingDoc = createEmevdEditorDocument({
    resourceUri: 'file://event/opaque_binding.emevd',
    documentInstanceId: 'darkscript-opaque-binding-test',
    events: [
      {
        eventId: 300,
        restBehavior: 0,
        parameters: [
          {
            instructionIndex: 1,
            targetStartByte: 0,
            sourceStartByte: 4,
            byteCount: 4,
            unkId: 17
          }
        ],
        instructions: [
          { bank: 2003, id: 1, argsBase64: '', unknown: false },
          { bank: 9999, id: 7, argsBase64: 'AAAAAA==', unknown: true }
        ]
      }
    ]
  });
  const opaqueSource = renderEmevdDarkScript(opaqueBindingDoc, emedf);
  const opaqueRequest = {
    schemaVersion: 1 as const,
    resourceUri: opaqueBindingDoc.resourceUri,
    documentInstanceId: opaqueBindingDoc.documentInstanceId ?? 'darkscript-opaque-binding-test',
    baseRevision: opaqueBindingDoc.revision,
    emedfSchemaFingerprint: fingerprintEmedfRegistry(emedf),
    sourceText: opaqueSource,
    mode: 'dark-script' as const
  };
  const opaqueNoop = compileEmevdDarkScript(opaqueRequest, opaqueBindingDoc, emedf);
  if (!opaqueNoop.ok) fail(`opaque no-op 编译失败: ${JSON.stringify(opaqueNoop.diagnostics)}`);
  const opaqueNoopParams = opaqueNoop.plan.operations.find((op) => op.kind === 'set_event_parameters');
  if (opaqueNoopParams && (opaqueNoopParams.parameters.length !== 1
    || opaqueNoopParams.parameters[0]!.instructionIndex !== 1
    || opaqueNoopParams.parameters[0]!.targetStartByte !== 0
    || opaqueNoopParams.parameters[0]!.sourceStartByte !== 4
    || opaqueNoopParams.parameters[0]!.byteCount !== 4
    || opaqueNoopParams.parameters[0]!.unkId !== 17)) {
    fail(`opaque no-op 的参数绑定被错误改写: ${JSON.stringify(opaqueNoop.plan.operations)}`);
  }
  const opaqueInsertedSource = opaqueSource.replace(
    '    EndEvent();',
    '    WaitFixedTimeFrames(10);\n    EndEvent();'
  );
  const opaqueInserted = compileEmevdDarkScript({ ...opaqueRequest, sourceText: opaqueInsertedSource }, opaqueBindingDoc, emedf);
  if (!opaqueInserted.ok) fail(`opaque 前插编译失败: ${JSON.stringify(opaqueInserted.diagnostics)}`);
  const opaqueInsertedParams = opaqueInserted.plan.operations.find((op) => op.kind === 'set_event_parameters');
  if (!opaqueInsertedParams || opaqueInsertedParams.kind !== 'set_event_parameters'
    || opaqueInsertedParams.parameters.length !== 1
    || opaqueInsertedParams.parameters[0]!.instructionIndex !== 2
    || opaqueInsertedParams.parameters[0]!.targetStartByte !== 0
    || opaqueInsertedParams.parameters[0]!.sourceStartByte !== 4
    || opaqueInsertedParams.parameters[0]!.byteCount !== 4
    || opaqueInsertedParams.parameters[0]!.unkId !== 17) {
    fail(`opaque 前插后参数必须重排且保留字段: ${JSON.stringify(opaqueInserted.plan.operations)}`);
  }

  const opaqueDeletedSource = opaqueSource
    .split('\n')
    .filter((line) => !line.includes('// unknown bank=9999 id=7'))
    .join('\n');
  const opaqueDeleted = compileEmevdDarkScript({ ...opaqueRequest, sourceText: opaqueDeletedSource }, opaqueBindingDoc, emedf);
  if (!opaqueDeleted.ok) fail(`opaque 指令直接删除编译失败: ${JSON.stringify(opaqueDeleted.diagnostics)}`);
  const opaqueDeletedParams = opaqueDeleted.plan.operations.find((op) => op.kind === 'set_event_parameters');
  if (!opaqueDeletedParams || opaqueDeletedParams.kind !== 'set_event_parameters' || opaqueDeletedParams.parameters.length !== 0) {
    fail(`删除 opaque 指令后参数表必须清空: ${JSON.stringify(opaqueDeleted.plan.operations)}`);
  }

  // 9. 新增事件的 X 宽度不匹配必须失败关闭，不得泄漏 insert_event。
  const invalidAddedWidthSource = `${source}\n\n$Event(201, Default, function(X0_1) {\n    InitializeEvent(X0_1, 10, 0);\n});`;
  const invalidAddedWidth = compileEmevdDarkScript({ ...request, sourceText: invalidAddedWidthSource }, document, emedf);
  if (invalidAddedWidth.ok) fail('新增事件 X0_1 对 s32 参数必须失败关闭');
  if (!invalidAddedWidth.diagnostics.some((item) => item.code === 'EMEVD_PARAMETER_WIDTH_MISMATCH')) {
    fail(`新增事件错误宽度诊断缺失: ${JSON.stringify(invalidAddedWidth.diagnostics)}`);
  }
  // 失败结果没有 plan；这正是“不得泄漏 insert_event/insert_instruction”的契约。

  process.stdout.write('darkScriptCompiler smoke: ok\n');
}

main();
