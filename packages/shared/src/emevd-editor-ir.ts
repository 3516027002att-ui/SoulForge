/**
 * Renderer-safe EMEVD editor IR for four-view sync.
 * Instruction args stay opaque until EMEDF schema is bound.
 */

export type EmevdViewId = 'flow' | 'table' | 'dsl' | 'bytes';

export interface EmevdInstructionIr {
  instructionUri: string;
  bank: number;
  id: number;
  /** Opaque payload base64 until typed schema exists. */
  argsBase64: string;
  unknown: boolean;
}

export interface EmevdEventIr {
  eventUri: string;
  eventId: number;
  restBehavior: number;
  layer: number;
  instructions: EmevdInstructionIr[];
}

export interface EmevdEditorDocument {
  schemaVersion: 1;
  resourceUri: string;
  revision: number;
  events: EmevdEventIr[];
  /** Full file bytes for read-only hex view (base64). */
  bytesBase64: string;
  diagnostics: Array<{ severity: 'info' | 'warning' | 'error'; code: string; message: string }>;
}

export interface EmevdSelection {
  eventUri?: string;
  instructionUri?: string;
  view: EmevdViewId;
}

export type EmevdEditorMutation =
  | {
      kind: 'emevd_set_rest_behavior';
      eventUri: string;
      restBehavior: number;
      baseRevision: number;
    }
  | {
      kind: 'emevd_update_id';
      eventUri: string;
      newEventId: number;
      baseRevision: number;
    }
  | {
      kind: 'emevd_set_instruction_args';
      eventUri: string;
      instructionUri: string;
      argsBase64: string;
      baseRevision: number;
    };

export interface EmevdDslSourceLocation {
  line: number;
  column: number;
}

export interface EmevdDslDiagnostic {
  severity: 'error';
  code: string;
  message: string;
  location?: EmevdDslSourceLocation;
}

export type EmevdDslLiteral = number | boolean;

export type EmevdDslInstructionAst =
  | {
      kind: 'typed';
      instructionUri: string;
      bank: number;
      id: number;
      args: Record<string, EmevdDslLiteral>;
      location: EmevdDslSourceLocation;
    }
  | {
      kind: 'unknown';
      instructionUri: string;
      bank: number;
      id: number;
      argsBase64: string;
      location: EmevdDslSourceLocation;
    };

export interface EmevdDslEventAst {
  eventUri: string;
  eventId: number;
  restBehavior: number;
  layer: number;
  instructions: EmevdDslInstructionAst[];
  location: EmevdDslSourceLocation;
}

export interface EmevdDslDocumentAst {
  schemaVersion: 1;
  resourceUri: string;
  events: EmevdDslEventAst[];
}

export interface EmevdDslMutationProposal {
  schemaVersion: 1;
  authority: 'fixture-confirmed';
  resourceUri: string;
  baseRevision: number;
  mutations: EmevdEditorMutation[];
  diagnostics: EmevdDslDiagnostic[];
}
