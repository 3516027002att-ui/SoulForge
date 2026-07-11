/**
 * Unified professional-editor mutation protocol for V0.5 desktop.
 * Editors emit only these mutations; main/core maps them to PatchIR.
 */

export type EditorKind = 'hex' | 'fmg' | 'param' | 'emevd' | 'msb' | 'text' | 'raw';

export type EditorMutationKind =
  | 'hex_byte_patch'
  | 'fmg_entry_upsert'
  | 'fmg_entry_delete'
  | 'param_row_upsert'
  | 'param_row_delete'
  | 'emevd_set_rest_behavior'
  | 'emevd_update_id'
  | 'msb_set_part_position'
  | 'msb_set_part_transform';

export interface EditorDocumentRef {
  documentId: string;
  editorKind: EditorKind;
  resourceUri: string;
  /** Revision monotically increases on each accepted mutation. */
  revision: number;
  title: string;
}

export interface EditorMutation {
  mutationId: string;
  documentId: string;
  kind: EditorMutationKind;
  resourceUri: string;
  baseRevision: number;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface EditorValidationIssue {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  resourceUri?: string;
}

export interface EditorMutationBatch {
  batchId: string;
  documentId: string;
  mutations: EditorMutation[];
  /** Only PatchIR-bound batches may be committed. */
  requiresPatchEngine: true;
}
