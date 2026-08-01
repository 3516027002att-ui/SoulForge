/**
 * Unified professional-editor mutation protocol for V0.5 desktop.
 * Editors emit only these mutations; main/core maps them to PatchIR.
 */

export type EditorKind =
  | 'hex'
  | 'bnd4'
  | 'fmg'
  | 'param'
  | 'emevd'
  | 'msb'
  | 'tae'
  | 'esd'
  | 'script'
  | 'flver'
  | 'text'
  | 'raw';

export type EditorMutationKind =
  | 'fmg_entry_upsert'
  | 'fmg_entry_delete'
  | 'fmg_entry_add'
  | 'param_row_upsert'
  | 'param_row_delete'
  | 'param_field_set'
  | 'emevd_set_rest_behavior'
  | 'emevd_update_id'
  | 'msb_set_part_position'
  | 'msb_set_part_transform';

/** 延期编辑器的目标里程碑。 */
export const DEFERRED_PREVIEW_TARGET_RELEASE = 'V0.6' as const;
export type DeferredPreviewTargetRelease = typeof DEFERRED_PREVIEW_TARGET_RELEASE;

/**
 * 已移出 V0.5 范围、仅保留标记只读预览的编辑器。与
 * `docs/V0_5_IMPLEMENTATION_HANDOFF.md` §18.2.1
 * `SCOPE-EDITORS.deferredPreviewEditors.editorIds` 对应。
 *
 * 放在 shared 而非 core：renderer 需要在运行时读取该清单来打标并隐藏
 * 提交入口，而 core 含 Node-only 模块，不能进入浏览器包。core 的能力
 * 契约仍是写入放行的唯一权威，两者一致性由 release-editor acceptance
 * smoke 断言，避免出现两份可漂移的清单。
 */
export const DEFERRED_PREVIEW_EDITOR_KINDS = [
  'msb',
  'tae',
  'esd',
  'flver'
] as const satisfies readonly EditorKind[];

export type DeferredPreviewEditorKind = typeof DEFERRED_PREVIEW_EDITOR_KINDS[number];

export function isDeferredPreviewEditorKind(
  editorKind: EditorKind
): editorKind is DeferredPreviewEditorKind {
  return (DEFERRED_PREVIEW_EDITOR_KINDS as readonly EditorKind[]).includes(editorKind);
}

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

/**
 * One page of FMG entries served by the paginated editor access channel
 * (`resource.readFmgPage`). The renderer only ever receives a bounded page
 * plus navigation metadata; the complete document is assembled in main
 * (hard constraint 17).
 */
export interface FmgEntryPage {
  ok: boolean;
  sourceUri: string;
  sourceHash: string | null;
  /** Total entry count across all pages (after the active query filter). */
  entryCount: number;
  /** Largest entry id observed in the whole document (safe id for add). */
  maxId: number;
  page: number;
  pageSize: number;
  pageCount: number;
  entries: Array<{ id: number; text: string }>;
  authority?: string;
  diagnostics: Array<{ severity: string; code: string; message: string }>;
}

/**
 * One page of PARAM rows served by the paginated editor access channel
 * (`resource.readParamPage`). Rows carry the full row bytes (base64) so the
 * renderer can duplicate rows and drive field-level editing without holding
 * the whole document.
 */
export interface ParamRowPage {
  ok: boolean;
  sourceUri: string;
  sourceHash: string | null;
  typeName?: string;
  rowDataSize?: number;
  /** Total row count across all pages (after the active query filter). */
  rowCount: number;
  page: number;
  pageSize: number;
  pageCount: number;
  rows: Array<{
    id: number;
    name?: string;
    dataBase64?: string;
    dataHexPreview?: string;
  }>;
  /** True when the native document exposes more rows than this channel covers. */
  rowsTruncated: boolean;
  authority?: string;
  diagnostics: Array<{ severity: string; code: string; message: string }>;
}
