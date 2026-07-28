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
  span: EmevdDslSourceSpan;
}

export interface EmevdDslCompileRequest {
  schemaVersion: 1;
  resourceUri: string;
  documentInstanceId: string;
  baseRevision: number;
  emedfSchemaFingerprint: string;
  sourceText: string;
  mode: 'patch';
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
      kind: 'set_instruction_arg';
      eventAnchor: string;
      instructionAnchor: string;
      bank: number;
      id: number;
      argument: string;
      before: EmevdDslLiteral;
      after: EmevdDslLiteral;
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
