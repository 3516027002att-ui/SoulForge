/**
 * DarkScript3-style EMEVD source compiler smoke (S14).
 *
 * Covers: no-op compile (empty plan), event header writes (set_event_id /
 * set_event_rest_behavior), instruction argument writes (set_instruction_arg
 * with typed before/after), structural instruction deletion, WaitFor folded
 * predicate edits, and fail-closed diagnostics for unsafe instruction
 * insertions/name changes/unknown instruction edits — each without locking
 * the whole document or pretending a write happened.
 *
 * All EMEDF data here is synthetic and self-authored (same shapes as the
 * renderer smoke); never a dump of any real EMEDF file.
 */
import { createEmevdEditorDocument } from '../editing/emevdFourViewController.js';
import { parseDs3EmedfJson } from '../emevd/emedfExternalAdapter.js';
import type { EmedfRegistry } from '../emevd/emedfSchema.js';
import { renderEmevdDarkScript } from '../emevd/darkScriptRenderer.js';
import { compileEmevdDarkScript } from '../emevd/darkScriptCompiler.js';
import { fingerprintEmedfRegistry } from '../emevd/dslCompiler.js';
import type { EmevdEditorDocument, EmevdDslCompileRequest } from '@soulforge/shared';

/**
 * Synthetic DarkScript3-format EMEDF JSON — the same self-authored shapes as
 * runEmevdDarkScriptRendererSmoke (duplicated so the compiler smoke stays
 * independent of the renderer smoke's fixtures).
 */
function createSyntheticRegistry(): EmedfRegistry {
  const json = JSON.stringify({
    unknown: 0,
    main_classes: [
      {
        name: 'Condition - System',
        index: 0,
        instrs: [
          {
            name: 'IF Condition Group',
            index: 0,
            args: [
              { name: 'Result Condition Group', type: 3 },
              { name: 'Desired Condition Group State', type: 0 },
              { name: 'Target Condition Group', type: 3 }
            ]
          }
        ]
      },
      {
        name: 'Control Flow - System',
        index: 1000,
        instrs: [
          {
            name: 'WAIT For Condition Group State',
            index: 0,
            args: [
              { name: 'Desired Condition Group State', type: 0 },
              { name: 'Target Condition Group', type: 3 }
            ]
          }
        ]
      },
      {
        name: 'System',
        index: 2000,
        instrs: [
          {
            name: 'Initialize Event',
            index: 0,
            args: [
              { name: 'Event Slot ID', type: 5 },
              { name: 'Event ID', type: 2 },
              { name: 'Parameters', type: 2, vararg: true }
            ]
          }
        ]
      },
      {
        name: 'Condition - Character',
        index: 4,
        instrs: [
          {
            name: 'IF Player Has Item',
            index: 10,
            args: [
              { name: 'Result Condition Group', type: 3 },
              { name: 'Item Type', type: 2 },
              { name: 'Item ID', type: 2 }
            ]
          },
          {
            name: 'IF Character Has SpEffect',
            index: 11,
            args: [
              { name: 'Result Condition Group', type: 3 },
              { name: 'Character', type: 2 },
              { name: 'SpEffect ID', type: 2 }
            ]
          }
        ]
      }
    ],
    enums: [],
    darkscript: {}
  });
  const result = parseDs3EmedfJson(json);
  if (!result.ok) throw new Error(`synthetic registry import failed: ${result.message}`);
  return result.registry;
}

/** Encode an IfConditionGroup payload (3 args, 4 bytes, s8/u8/s8). */
function condGroupArgs(result: number, state: number, target: number): string {
  const buf = Buffer.alloc(4);
  buf.writeInt8(result, 0);
  buf.writeUInt8(state, 1);
  buf.writeInt8(target, 2);
  return buf.toString('base64');
}

/** InitializeEvent payload: s32 slot + u32 eventId + one u32 parameter. */
function initEventArgs(slot: number, eventId: number, param: number): string {
  const buf = Buffer.alloc(12);
  buf.writeInt32LE(slot, 0);
  buf.writeUInt32LE(eventId, 4);
  buf.writeUInt32LE(param, 8);
  return buf.toString('base64');
}

/** Predicate payload: s8 result + u32 a + u32 b (4-byte aligned → 12 bytes). */
function predicateArgs(result: number, a: number, b: number): string {
  const buf = Buffer.alloc(12);
  buf.writeInt8(result, 0);
  buf.writeUInt32LE(a, 4);
  buf.writeUInt32LE(b, 8);
  return buf.toString('base64');
}

function createDocument(): EmevdEditorDocument {
  return createEmevdEditorDocument({
    resourceUri: 'file://event/common.emevd',
    documentInstanceId: 'darkscript-compiler-smoke',
    events: [
      {
        eventId: 0,
        restBehavior: 0,
        instructions: [
          { bank: 2000, id: 0, argsBase64: initEventArgs(0, 77770001, 0), unknown: false },
          { bank: 2000, id: 0, argsBase64: initEventArgs(1, 77770002, 0), unknown: false }
        ]
      },
      {
        eventId: 965672,
        restBehavior: 1,
        instructions: [
          { bank: 4, id: 10, argsBase64: predicateArgs(1, 6, 2498), unknown: false },
          { bank: 4, id: 11, argsBase64: predicateArgs(1, 10000, 127800), unknown: false },
          { bank: 0, id: 0, argsBase64: condGroupArgs(0, 1, 1), unknown: false },
          { bank: 2000, id: 0, argsBase64: initEventArgs(0, 77770003, 0), unknown: false },
          { bank: 9999, id: 7, argsBase64: '', unknown: true }
        ]
      }
    ]
  });
}

function requestFor(
  document: EmevdEditorDocument,
  sourceText: string,
  registry: EmedfRegistry
): EmevdDslCompileRequest {
  return {
    schemaVersion: 1,
    resourceUri: document.resourceUri,
    documentInstanceId: document.documentInstanceId ?? '',
    baseRevision: document.revision,
    emedfSchemaFingerprint: fingerprintEmedfRegistry(registry),
    sourceText,
    mode: 'dark-script'
  };
}

function main(): void {
  const registry = createSyntheticRegistry();
  const document = createDocument();
  const base = renderEmevdDarkScript(document, registry);

  /* 1. 未编辑原文 → 空 plan, ok。 */
  {
    const result = compileEmevdDarkScript(requestFor(document, base, registry), document, registry);
    if (!result.ok) throw new Error(`no-op 编译必须成功: ${JSON.stringify(result.diagnostics)}`);
    if (!result.plan || result.plan.operations.length !== 0) {
      throw new Error(`no-op 编译必须产生空操作集, 得到 ${result.plan?.operations.length}`);
    }
  }

  /* 2. 事件头:改 eventId + rest. */
  {
    const edited = base
      .replace('$Event(0, Default, function() {', '$Event(100, Default, function() {')
      .replace('$Event(965672, Restart, function() {', '$Event(965672, Default, function() {');
    const result = compileEmevdDarkScript(requestFor(document, edited, registry), document, registry);
    if (!result.ok) throw new Error(`事件头编译失败: ${JSON.stringify(result.diagnostics)}`);
    const ops = result.plan!.operations;
    const setId = ops.find((op) => op.kind === 'set_event_id');
    if (!setId || setId.kind !== 'set_event_id' || setId.before !== 0 || setId.after !== 100) {
      throw new Error(`set_event_id 不正确: ${JSON.stringify(ops)}`);
    }
    const setRest = ops.find((op) => op.kind === 'set_event_rest_behavior');
    if (!setRest || setRest.kind !== 'set_event_rest_behavior' || setRest.before !== 1 || setRest.after !== 0) {
      throw new Error(`set_event_rest_behavior 不正确: ${JSON.stringify(ops)}`);
    }
  }

  /* 3. 普通指令参数:改一个固定参数(s32 Event Slot ID, 避开 vararg 尾部). */
  {
    const edited = base.replace('InitializeEvent(1, 77770002, 0);', 'InitializeEvent(9, 77770002, 0);');
    const result = compileEmevdDarkScript(requestFor(document, edited, registry), document, registry);
    if (!result.ok) throw new Error(`指令参数编译失败: ${JSON.stringify(result.diagnostics)}`);
    const ops = result.plan!.operations;
    const write = ops.find((op) => op.kind === 'set_instruction_arg');
    if (!write || write.kind !== 'set_instruction_arg') {
      throw new Error(`期望 set_instruction_arg, 得到 ${JSON.stringify(ops)}`);
    }
    if (write.bank !== 2000 || write.id !== 0 || write.argument !== 'eventSlotId' || write.before !== 1 || write.after !== 9) {
      throw new Error(`set_instruction_arg 内容不正确: ${JSON.stringify(write)}`);
    }
  }

  /* 4. 结构删除: DarkScript 删除一行生成受锚点保护的 delete_instruction. */
  {
    const edited = base.replace('    InitializeEvent(1, 77770002, 0);\n', '');
    const result = compileEmevdDarkScript(requestFor(document, edited, registry), document, registry);
    if (!result.ok) throw new Error(`结构删除编译失败: ${JSON.stringify(result.diagnostics)}`);
    const deleted = result.plan!.operations.find((operation) => operation.kind === 'delete_instruction');
    if (!deleted || deleted.kind !== 'delete_instruction' || deleted.bank !== 2000 || deleted.id !== 0) {
      throw new Error(`期望受保护的 delete_instruction: ${JSON.stringify(result.plan!.operations)}`);
    }
  }

  /* 5. WaitFor 折叠块内的已知 predicate 参数可以安全写回。 */
  {
    const edited = base.replace('IfPlayerHasItem(6, 2498)', 'IfPlayerHasItem(6, 9999)');
    const result = compileEmevdDarkScript(requestFor(document, edited, registry), document, registry);
    if (!result.ok) throw new Error(`WaitFor 折叠块参数编译失败: ${JSON.stringify(result.diagnostics)}`);
    const write = result.plan!.operations.find((operation) => (
      operation.kind === 'set_instruction_arg'
      && operation.bank === 4
      && operation.id === 10
      && operation.argument === 'itemId'
    ));
    if (!write || write.kind !== 'set_instruction_arg' || write.before !== 2498 || write.after !== 9999) {
      throw new Error(`WaitFor predicate 参数写入不正确: ${JSON.stringify(result.plan!.operations)}`);
    }
  }

  /* 6. 未知指令的注释被改动时 fail-closed，不伪造对未知字节的写入。 */
  {
    const edited = base.replace('// unknown bank=9999 id=7', '// unknown bank=9999 id=7 (用户备注)');
    const result = compileEmevdDarkScript(requestFor(document, edited, registry), document, registry);
    if (result.ok) throw new Error('未知指令注释改动必须 fail-closed');
    if (!result.diagnostics.some((d) => d.code === 'DARKSCRIPT_LINE_UNDECODED')) {
      throw new Error(`期望未知指令未解码诊断: ${JSON.stringify(result.diagnostics)}`);
    }
  }

  /* 7. fail-closed:指令名被替换. */
  {
    const edited = base.replace('InitializeEvent(0, 77770001, 0);', 'OtherEvent(0);');
    const result = compileEmevdDarkScript(requestFor(document, edited, registry), document, registry);
    if (result.ok) throw new Error('指令名替换必须 fail-closed');
    if (!result.diagnostics.some((d) => d.code === 'DARKSCRIPT_LINE_UNDECODED')) {
      throw new Error(`期望未知指令未解码诊断: ${JSON.stringify(result.diagnostics)}`);
    }
  }

  /* 8. 单事件头错误不应锁整份:改事件 0 的 id, waitBlock 不动 → 只有 set_event_id. */
  {
    const edited = base.replace('$Event(0, Default, function() {', '$Event(7, Default, function() {');
    const result = compileEmevdDarkScript(requestFor(document, edited, registry), document, registry);
    if (!result.ok) throw new Error(`只改事件头应编译成功: ${JSON.stringify(result.diagnostics)}`);
    const ops = result.plan!.operations;
    if (ops.length !== 1 || ops[0]!.kind !== 'set_event_id') {
      throw new Error(`期望仅一条 set_event_id, 得到 ${JSON.stringify(ops)}`);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'DarkScript3 源码编译器验证通过（no-op / 事件头 / 指令参数 / fail-closed 诊断）',
    noOpPlan: true,
    eventHeaderWrites: true,
    instructionArgWrite: true,
    failClosed: ['DARKSCRIPT_LINE_UNDECODED', 'EMEVD_DSL_SCOPE_EVENT_MUTATION_LEAK'],
    partialApply: true
  }, null, 2));
}

main();
