import type { EmevdNodeAnchor } from './emevd-editor-ir.js';

export interface EmevdDslSourcePosition {
  offset: number;
  line: number;
  column: number;
}

export interface EmevdDslSourceSpan {
  start: EmevdDslSourcePosition;
  end: EmevdDslSourcePosition;
}

export type EmevdDslDiagnosticSeverity = 'error' | 'warning' | 'info';

export interface EmevdDslDiagnostic {
  severity: EmevdDslDiagnosticSeverity;
  code: string;
  message: string;
  span: EmevdDslSourceSpan;
  resourceUri?: string;
  targetAnchor?: string;
}

export type EmevdDslLiteral = number | boolean;

export interface EmevdDslSetEventField {
  kind: 'set_event_field';
  field: 'id' | 'rest';
  value: number;
  span: EmevdDslSourceSpan;
}

export interface EmevdDslSetInstructionArg {
  kind: 'set_instruction_arg';
  argument: string;
  value: EmevdDslLiteral;
  span: EmevdDslSourceSpan;
}

export interface EmevdDslInstructionPatch {
  anchor: string;
  operations: EmevdDslSetInstructionArg[];
  span: EmevdDslSourceSpan;
}

export interface EmevdDslEventPatch {
  anchor: string;
  operations: EmevdDslSetEventField[];
  instructions: EmevdDslInstructionPatch[];
  span: EmevdDslSourceSpan;
}

export interface EmevdDslDocument {
  schemaVersion: 1;
  resourceUri: string;
  baseRevision: number;
  emedfSchemaFingerprint: string;
  events: EmevdDslEventPatch[];
  /**
   * Top-level instruction blocks: global instruction-level mutation without an
   * enclosing event block. Anchors still resolve through the document's stable
   * instruction identity; the owning event is looked up by the compiler.
   */
  topLevelInstructions?: EmevdDslInstructionPatch[];
  span: EmevdDslSourceSpan;
}

export interface EmevdDslCompileRequest {
  schemaVersion: 1;
  resourceUri: string;
  documentInstanceId: string;
  baseRevision: number;
  emedfSchemaFingerprint: string;
  sourceText: string;
  /**
   * 'patch'：旧 hash Patch-DSL（`event @e:` / `instruction @i:` 按 anchor 增量写）。
   * 'dark-script'：DarkScript3 式 `$Event(...)` 源码，按「反汇编形状逐事件逐行对齐」
   *   编译成 typed mutation（S14）。没有 DarkScript → 二进制全量编译器，因此
   *   指令增删与 WaitFor 折叠块内容变化会给出结构化诊断，不锁整份文档。
   */
  mode: 'patch' | 'dark-script';
}

interface EmevdPlannedMutationBase {
  target: EmevdNodeAnchor;
  targetPreconditionHash: string;
  sourceSpan: EmevdDslSourceSpan;
}

export type EmevdPlannedMutation =
  | (EmevdPlannedMutationBase & {
      kind: 'set_event_id';
      eventAnchor: string;
      before: number;
      after: number;
    })
  | (EmevdPlannedMutationBase & {
      kind: 'set_event_rest_behavior';
      eventAnchor: string;
      before: number;
      after: number;
    })
  | (EmevdPlannedMutationBase & {
      kind: 'set_event_parameters';
      eventAnchor: string;
      eventId: number;
      parameters: Array<{
        instructionIndex: number;
        targetStartByte: number;
        sourceStartByte: number;
        byteCount: number;
        unkId: number;
      }>;
    })
  | (EmevdPlannedMutationBase & {
      kind: 'set_instruction_arg';
      eventAnchor: string;
      instructionAnchor: string;
      bank: number;
      id: number;
      argument: string;
      before: EmevdDslLiteral;
      after: EmevdDslLiteral;
    })
  | (EmevdPlannedMutationBase & {
      kind: 'insert_instruction';
      /** 空串表示目标是同一份计划里 insert_event 新建的事件。 */
      eventAnchor: string;
      eventId: number;
      /** 插入位置：该事件「删除已应用后」的指令列表下标。 */
      index: number;
      bank: number;
      id: number;
      argsBase64: string;
    })
  | (EmevdPlannedMutationBase & {
      kind: 'delete_instruction';
      eventAnchor: string;
      eventId: number;
      instructionAnchor: string;
      /** 删除位置：原始文档中该事件内的指令下标。 */
      index: number;
      bank: number;
      id: number;
    })
  | (EmevdPlannedMutationBase & {
      kind: 'insert_event';
      eventId: number;
      restBehavior: number;
    })
  | (EmevdPlannedMutationBase & {
      kind: 'delete_event';
      eventAnchor: string;
      eventId: number;
    });

export interface EmevdMutationPlan {
  schemaVersion: 1;
  resourceUri: string;
  documentInstanceId: string;
  baseRevision: number;
  sourceFingerprint: string;
  schemaFingerprint: string;
  planFingerprint: string;
  operations: EmevdPlannedMutation[];
  impact: {
    touchedEvents: string[];
    touchedInstructions: string[];
    inserts: number;
    deletes: number;
    argumentWrites: number;
  };
}

export type EmevdDslCompileResult =
  | {
      ok: true;
      ast: EmevdDslDocument;
      plan: EmevdMutationPlan;
      diagnostics: EmevdDslDiagnostic[];
    }
  | {
      ok: false;
      ast?: EmevdDslDocument;
      diagnostics: EmevdDslDiagnostic[];
    };
