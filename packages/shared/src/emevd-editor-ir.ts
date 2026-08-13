/**
 * Renderer-safe EMEVD editor IR for four-view sync.
 * Instruction args stay opaque until EMEDF schema is bound.
 */

export type EmevdViewId = 'flow' | 'table' | 'dsl' | 'bytes';

/** Stable only for one opened editor-document instance; never derived from mutable URI alone. */
export interface EmevdNodeAnchor {
  documentInstanceId: string;
  localNodeId: string;
  sourceFingerprint: string;
}

export interface EmevdInstructionIr {
  instructionUri: string;
  bank: number;
  id: number;
  /** Opaque payload base64 until typed schema exists. */
  argsBase64: string;
  unknown: boolean;
  /** Optional during migration; DSL compilation requires it. */
  anchor?: EmevdNodeAnchor;
}

export interface EmevdEventIr {
  eventUri: string;
  eventId: number;
  restBehavior: number;
  layer: number;
  instructions: EmevdInstructionIr[];
  /** Optional during migration; DSL compilation requires it. */
  anchor?: EmevdNodeAnchor;
}

export interface EmevdEditorDocument {
  schemaVersion: 1;
  resourceUri: string;
  revision: number;
  events: EmevdEventIr[];
  /** Full file bytes for read-only hex view (base64). */
  bytesBase64: string;
  diagnostics: Array<{ severity: 'info' | 'warning' | 'error'; code: string; message: string }>;
  /** Distinguishes separate open-document lifetimes for stale-plan rejection. */
  documentInstanceId?: string;
}

/** Bounded event outline row for the DarkScript3-style source IDE navigator. */
export interface EmevdEventOutlineEntry {
  eventUri: string;
  eventId: number;
  restBehavior: number;
  layer: number;
  instructionCount: number;
  /** Instructions classified unknown under the bound EMEDF registry. */
  unknownCount: number;
}

/**
 * Bounded outline DTO for the source workbench (EVENT-30A). Summary rows only:
 * never carries instruction bodies, arg bytes, or string payloads, so a
 * 1,730-event real corpus stays far inside IPC/envelope budgets. Source URIs
 * are resource-relative (绝对路径脱敏): the outline must never expose the local
 * absolute file system path of the opened resource.
 */
export interface EmevdDocumentOutline {
  schemaVersion: 1;
  resourceUri: string;
  eventCount: number;
  instructionTotal: number;
  /** True when the source document exceeded `limit` and `events` is capped. */
  truncated: boolean;
  /** Upper bound applied to `events`. */
  limit: number;
  events: EmevdEventOutlineEntry[];
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
