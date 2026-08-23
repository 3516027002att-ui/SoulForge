/**
 * Unified professional-editor mutation protocol for V0.5 desktop.
 * Editors emit only these mutations; main/core maps them to PatchIR.
 *
 * front-end.md 新增契约（§5.2 WorkbenchRoute、§12 Agent）追加在本文件尾部。
 * §14 DocumentStore 契约因与 V0.5 legacy `EditorMutation` 重名，整体位于
 * editor-catalog.ts（见该文件头部说明）。
 */

import type {
  EditorDomainId,
  LogicalDocumentRef
} from './editor-catalog.js';
import {
  expectArray,
  expectBoolean,
  expectEnum,
  expectNullableString,
  expectNumber,
  expectRecord,
  expectStableId,
  expectString,
  fail,
  rejectAbsolutePath,
  rejectUnknownFields,
  valueOf,
  decodeEditorDomainId,
  decodeLogicalDocumentRef
} from './editor-catalog.js';

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
  | 'msb_set_part_transform'
  | 'flver_material_slot_set';

/** 延期编辑器的目标里程碑。 */
export const DEFERRED_PREVIEW_TARGET_RELEASE = 'V0.6' as const;
export type DeferredPreviewTargetRelease = typeof DEFERRED_PREVIEW_TARGET_RELEASE;

/**
 * 已移出当前版本范围、仅保留标记只读预览的编辑器。与
 * `docs/V0_5_IMPLEMENTATION_HANDOFF.md` §18.2.1
 * `SCOPE-EDITORS.deferredPreviewEditors.editorIds` 对应。
 *
 * S36/S38 已开闸：msb（write-msb typed mutation）与 flver（write-flver
 * material-slot-set）恢复写入，不再出现在本清单；tae/esd 保持延期只读。
 *
 * 放在 shared 而非 core：renderer 需要在运行时读取该清单来打标并隐藏
 * 提交入口，而 core 含 Node-only 模块，不能进入浏览器包。core 的能力
 * 契约仍是写入放行的唯一权威，两者一致性由 release-editor acceptance
 * smoke 断言，避免出现两份可漂移的清单。
 */
export const DEFERRED_PREVIEW_EDITOR_KINDS = [
  'tae',
  'esd'
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

/**
 * @deprecated V0.5 patchIR 计划形态。§14.4 的 `EditorMutation`
 * （kebab-case discriminated union）已移至 editor-catalog.ts 并取代本类型；
 * 本类型仅保留给迁移前仍在使用的 core 调用方。
 */
export interface LegacyEditorMutation {
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
  mutations: LegacyEditorMutation[];
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

// ---------------------------------------------------------------------------
// §5.2 WorkbenchRoute：每次打开只能得到一个 route
// ---------------------------------------------------------------------------

export type WorkbenchRoute =
  | { kind: 'ready'; editorId: string; document: LogicalDocumentRef; readOnly: boolean }
  | { kind: 'history'; recoveryOfResourceId: string | null }
  | { kind: 'files-candidate'; reasonCode: string }
  | { kind: 'runtime-blocked'; editorId: string; reasonCode: string }
  | { kind: 'unsupported'; reasonCode: string };

/**
 * §14.4 DocumentStore IPC 通道（DOCSTORE-04）。唯一声明点：main 注册与 preload
 * 暴露都引用这里的常量，改通道名时两侧同时变，不会出现一侧漂移。
 * 所有请求/响应为 named DTO（见 editor-catalog.ts 的 decoder），不保留
 * Promise<unknown> 旁路。
 */
export const EDITOR_DOCUMENT_IPC_CHANNELS = Object.freeze({
  open: 'document.open',
  get: 'document.get',
  page: 'document.page',
  readContent: 'document.readContent',
  apply: 'document.apply',
  close: 'document.close'
} as const);

export type EditorDocumentIpcChannel =
  typeof EDITOR_DOCUMENT_IPC_CHANNELS[keyof typeof EDITOR_DOCUMENT_IPC_CHANNELS];

export function decodeWorkbenchRoute(value: unknown, path = 'WorkbenchRoute'): WorkbenchRoute {
  const r = expectRecord(value, path);
  const kind = expectEnum(valueOf(r, 'kind', path), ['ready', 'history', 'files-candidate', 'runtime-blocked', 'unsupported'], `${path}.kind`);
  switch (kind) {
    case 'ready': {
      rejectUnknownFields(r, ['kind', 'editorId', 'document', 'readOnly'], path);
      return { kind, editorId: expectString(r.editorId, `${path}.editorId`), document: decodeLogicalDocumentRef(r.document, `${path}.document`), readOnly: expectBoolean(r.readOnly, `${path}.readOnly`) };
    }
    case 'history': {
      rejectUnknownFields(r, ['kind', 'recoveryOfResourceId'], path);
      return { kind, recoveryOfResourceId: expectNullableString(r.recoveryOfResourceId, `${path}.recoveryOfResourceId`) };
    }
    case 'files-candidate': {
      rejectUnknownFields(r, ['kind', 'reasonCode'], path);
      return { kind, reasonCode: expectString(r.reasonCode, `${path}.reasonCode`) };
    }
    case 'runtime-blocked': {
      rejectUnknownFields(r, ['kind', 'editorId', 'reasonCode'], path);
      return { kind, editorId: expectString(r.editorId, `${path}.editorId`), reasonCode: expectString(r.reasonCode, `${path}.reasonCode`) };
    }
    case 'unsupported': {
      rejectUnknownFields(r, ['kind', 'reasonCode'], path);
      return { kind, reasonCode: expectString(r.reasonCode, `${path}.reasonCode`) };
    }
  }
}

// ---------------------------------------------------------------------------
// §12.8 EditorSelectionContext（发送时冻结快照；不含绝对路径）
// ---------------------------------------------------------------------------

export interface EditorSelectionContext {
  readonly domain: EditorDomainId;
  readonly libraryId: string | null;
  readonly bankId: string | null;
  readonly documentId: string | null;
  readonly paramTableId: string | null;
  readonly rowId: string | null;
  readonly fieldId: string | null;
  readonly fmgEntryId: string | null;
  readonly eventId: string | null;
  readonly cursor: { line: number; column: number } | null;
  readonly revision: string | null;
}

export function decodeEditorSelectionContext(value: unknown, path = 'EditorSelectionContext'): EditorSelectionContext {
  const r = expectRecord(value, path);
  rejectUnknownFields(
    r,
    ['domain', 'libraryId', 'bankId', 'documentId', 'paramTableId', 'rowId', 'fieldId', 'fmgEntryId', 'eventId', 'cursor', 'revision'],
    path
  );
  const cursorValue = r.cursor;
  let cursor: { line: number; column: number } | null = null;
  if (cursorValue !== null) {
    const cr = expectRecord(cursorValue, `${path}.cursor`);
    rejectUnknownFields(cr, ['line', 'column'], `${path}.cursor`);
    cursor = { line: expectNumber(cr.line, `${path}.cursor.line`), column: expectNumber(cr.column, `${path}.cursor.column`) };
  }
  const id = (v: unknown, p: string): string | null => {
    if (v === null) return null;
    const s = expectString(v, p);
    rejectAbsolutePath(s, p);
    return s;
  };
  return {
    domain: decodeEditorDomainId(r.domain, `${path}.domain`),
    libraryId: id(r.libraryId, `${path}.libraryId`),
    bankId: id(r.bankId, `${path}.bankId`),
    documentId: id(r.documentId, `${path}.documentId`),
    paramTableId: id(r.paramTableId, `${path}.paramTableId`),
    rowId: id(r.rowId, `${path}.rowId`),
    fieldId: id(r.fieldId, `${path}.fieldId`),
    fmgEntryId: id(r.fmgEntryId, `${path}.fmgEntryId`),
    eventId: id(r.eventId, `${path}.eventId`),
    cursor,
    revision: id(r.revision, `${path}.revision`)
  };
}

// ---------------------------------------------------------------------------
// §12.11 Agent typed DTO（named DTO + runtime decoder）
// ---------------------------------------------------------------------------

export type AgentRunMode = 'ask' | 'plan' | 'edit';

export interface AgentContextSnapshot {
  readonly snapshotId: string;
  readonly selection: EditorSelectionContext;
  readonly createdAt: string;
}

export interface AgentMessagePageRequest {
  readonly sessionId: string;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface AgentMessagePage {
  readonly items: readonly AgentMessageDto[];
  readonly nextCursor: string | null;
}

export type AgentMessageDto =
  | { id: string; kind: 'user'; text: string; contextSnapshotId: string; createdAt: string }
  | { id: string; kind: 'assistant'; markdown: string; streaming: boolean; createdAt: string }
  | { id: string; kind: 'tool-activity'; summary: string; status: 'running' | 'succeeded' | 'failed'; createdAt: string }
  | { id: string; kind: 'approval'; reviewId: string; status: 'pending' | 'approved' | 'rejected' | 'committed' | 'failed'; createdAt: string };

export type AgentStreamEvent =
  | { seq: number; sessionId: string; kind: 'message-started'; message: AgentMessageDto }
  | { seq: number; sessionId: string; kind: 'message-delta'; messageId: string; delta: string }
  | { seq: number; sessionId: string; kind: 'message-finished'; messageId: string }
  | { seq: number; sessionId: string; kind: 'tool-updated'; message: AgentMessageDto }
  | { seq: number; sessionId: string; kind: 'approval-updated'; message: AgentMessageDto }
  | { seq: number; sessionId: string; kind: 'run-failed'; reasonCode: string; retryable: boolean };

export type AgentAttachmentMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'text/plain';

export interface AgentAttachmentReference {
  readonly token: string;
  readonly mediaType: AgentAttachmentMediaType;
  readonly byteLength: number;
  readonly expiresAt: string;
}

export interface AgentResourceReference {
  readonly token: string;
  readonly domain: EditorDomainId;
  readonly label: string;
  readonly expiresAt: string;
}

export interface SubmitAgentRunRequest {
  readonly sessionId: string;
  readonly prompt: string;
  readonly mode: AgentRunMode;
  readonly modelConfigId: string;
  readonly contextSnapshotId: string;
  readonly attachments: readonly AgentAttachmentReference[];
  readonly resources: readonly AgentResourceReference[];
}

export interface StopAgentRunRequest {
  readonly sessionId: string;
  readonly runId: string;
}

export interface DecideAgentApprovalRequest {
  readonly sessionId: string;
  readonly reviewId: string;
  readonly expectedRevision: string;
  readonly decision: 'approve-and-commit' | 'reject';
}

export function decodeAgentRunMode(value: unknown, path = 'AgentRunMode'): AgentRunMode {
  return expectEnum(value, ['ask', 'plan', 'edit'], path);
}

export function decodeAgentMessageDto(value: unknown, path = 'AgentMessageDto'): AgentMessageDto {
  const r = expectRecord(value, path);
  const kind = expectEnum(valueOf(r, 'kind', path), ['user', 'assistant', 'tool-activity', 'approval'], `${path}.kind`);
  const id = expectStableId(r.id, `${path}.id`);
  const createdAt = expectString(r.createdAt, `${path}.createdAt`);
  switch (kind) {
    case 'user': {
      rejectUnknownFields(r, ['id', 'kind', 'text', 'contextSnapshotId', 'createdAt'], path);
      return { id, kind, text: expectString(r.text, `${path}.text`), contextSnapshotId: expectStableId(r.contextSnapshotId, `${path}.contextSnapshotId`), createdAt };
    }
    case 'assistant': {
      rejectUnknownFields(r, ['id', 'kind', 'markdown', 'streaming', 'createdAt'], path);
      return { id, kind, markdown: expectString(r.markdown, `${path}.markdown`), streaming: expectBoolean(r.streaming, `${path}.streaming`), createdAt };
    }
    case 'tool-activity': {
      rejectUnknownFields(r, ['id', 'kind', 'summary', 'status', 'createdAt'], path);
      return { id, kind, summary: expectString(r.summary, `${path}.summary`), status: expectEnum(valueOf(r, 'status', path), ['running', 'succeeded', 'failed'], `${path}.status`), createdAt };
    }
    case 'approval': {
      rejectUnknownFields(r, ['id', 'kind', 'reviewId', 'status', 'createdAt'], path);
      return { id, kind, reviewId: expectStableId(r.reviewId, `${path}.reviewId`), status: expectEnum(valueOf(r, 'status', path), ['pending', 'approved', 'rejected', 'committed', 'failed'], `${path}.status`), createdAt };
    }
  }
}

export function decodeAgentMessagePageRequest(value: unknown, path = 'AgentMessagePageRequest'): AgentMessagePageRequest {
  const r = expectRecord(value, path);
  rejectUnknownFields(r, ['sessionId', 'cursor', 'limit'], path);
  const limit = expectNumber(r.limit, `${path}.limit`);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail(`${path}.limit`, `limit must be integer 1..100`);
  return { sessionId: expectStableId(r.sessionId, `${path}.sessionId`), cursor: expectNullableString(r.cursor, `${path}.cursor`), limit };
}

export function decodeAgentMessagePage(value: unknown, path = 'AgentMessagePage'): AgentMessagePage {
  const r = expectRecord(value, path);
  rejectUnknownFields(r, ['items', 'nextCursor'], path);
  return {
    items: expectArray(r.items, `${path}.items`).map((v, i) => decodeAgentMessageDto(v, `${path}.items[${i}]`)),
    nextCursor: expectNullableString(r.nextCursor, `${path}.nextCursor`)
  };
}

export function decodeAgentStreamEvent(value: unknown, path = 'AgentStreamEvent'): AgentStreamEvent {
  const r = expectRecord(value, path);
  const kind = expectEnum(
    valueOf(r, 'kind', path),
    ['message-started', 'message-delta', 'message-finished', 'tool-updated', 'approval-updated', 'run-failed'],
    `${path}.kind`
  );
  const seq = expectNumber(r.seq, `${path}.seq`);
  if (!Number.isInteger(seq)) fail(`${path}.seq`, `seq must be an integer`);
  const sessionId = expectStableId(r.sessionId, `${path}.sessionId`);
  switch (kind) {
    case 'message-started': {
      rejectUnknownFields(r, ['seq', 'sessionId', 'kind', 'message'], path);
      return { seq, sessionId, kind, message: decodeAgentMessageDto(r.message, `${path}.message`) };
    }
    case 'message-delta': {
      rejectUnknownFields(r, ['seq', 'sessionId', 'kind', 'messageId', 'delta'], path);
      return { seq, sessionId, kind, messageId: expectStableId(r.messageId, `${path}.messageId`), delta: expectString(r.delta, `${path}.delta`) };
    }
    case 'message-finished': {
      rejectUnknownFields(r, ['seq', 'sessionId', 'kind', 'messageId'], path);
      return { seq, sessionId, kind, messageId: expectStableId(r.messageId, `${path}.messageId`) };
    }
    case 'tool-updated':
    case 'approval-updated': {
      rejectUnknownFields(r, ['seq', 'sessionId', 'kind', 'message'], path);
      return { seq, sessionId, kind, message: decodeAgentMessageDto(r.message, `${path}.message`) };
    }
    case 'run-failed': {
      rejectUnknownFields(r, ['seq', 'sessionId', 'kind', 'reasonCode', 'retryable'], path);
      return { seq, sessionId, kind, reasonCode: expectString(r.reasonCode, `${path}.reasonCode`), retryable: expectBoolean(r.retryable, `${path}.retryable`) };
    }
  }
}

export function decodeAgentAttachmentReference(value: unknown, path = 'AgentAttachmentReference'): AgentAttachmentReference {
  const r = expectRecord(value, path);
  rejectUnknownFields(r, ['token', 'mediaType', 'byteLength', 'expiresAt'], path);
  const token = expectString(r.token, `${path}.token`);
  rejectAbsolutePath(token, `${path}.token`);
  return {
    token,
    mediaType: expectEnum(valueOf(r, 'mediaType', path), ['image/png', 'image/jpeg', 'image/webp', 'text/plain'], `${path}.mediaType`),
    byteLength: expectNumber(r.byteLength, `${path}.byteLength`),
    expiresAt: expectString(r.expiresAt, `${path}.expiresAt`)
  };
}

export function decodeAgentResourceReference(value: unknown, path = 'AgentResourceReference'): AgentResourceReference {
  const r = expectRecord(value, path);
  rejectUnknownFields(r, ['token', 'domain', 'label', 'expiresAt'], path);
  const token = expectString(r.token, `${path}.token`);
  rejectAbsolutePath(token, `${path}.token`);
  return { token, domain: decodeEditorDomainId(r.domain, `${path}.domain`), label: expectString(r.label, `${path}.label`), expiresAt: expectString(r.expiresAt, `${path}.expiresAt`) };
}

export function decodeSubmitAgentRunRequest(value: unknown, path = 'SubmitAgentRunRequest'): SubmitAgentRunRequest {
  const r = expectRecord(value, path);
  rejectUnknownFields(r, ['sessionId', 'prompt', 'mode', 'modelConfigId', 'contextSnapshotId', 'attachments', 'resources'], path);
  const prompt = expectString(r.prompt, `${path}.prompt`);
  const promptUnits = prompt.length;
  if (promptUnits < 1 || promptUnits > 65536) fail(`${path}.prompt`, `prompt must be 1..65536 UTF-16 code units`);
  const attachments = expectArray(r.attachments, `${path}.attachments`).map((v, i) => decodeAgentAttachmentReference(v, `${path}.attachments[${i}]`));
  if (attachments.length > 8) fail(`${path}.attachments`, `at most 8 attachments`);
  const resources = expectArray(r.resources, `${path}.resources`).map((v, i) => decodeAgentResourceReference(v, `${path}.resources[${i}]`));
  if (resources.length > 16) fail(`${path}.resources`, `at most 16 resources`);
  return {
    sessionId: expectStableId(r.sessionId, `${path}.sessionId`),
    prompt,
    mode: decodeAgentRunMode(r.mode, `${path}.mode`),
    modelConfigId: expectStableId(r.modelConfigId, `${path}.modelConfigId`),
    contextSnapshotId: expectStableId(r.contextSnapshotId, `${path}.contextSnapshotId`),
    attachments,
    resources
  };
}

export function decodeStopAgentRunRequest(value: unknown, path = 'StopAgentRunRequest'): StopAgentRunRequest {
  const r = expectRecord(value, path);
  rejectUnknownFields(r, ['sessionId', 'runId'], path);
  return { sessionId: expectStableId(r.sessionId, `${path}.sessionId`), runId: expectStableId(r.runId, `${path}.runId`) };
}

export function decodeDecideAgentApprovalRequest(value: unknown, path = 'DecideAgentApprovalRequest'): DecideAgentApprovalRequest {
  const r = expectRecord(value, path);
  rejectUnknownFields(r, ['sessionId', 'reviewId', 'expectedRevision', 'decision'], path);
  return {
    sessionId: expectStableId(r.sessionId, `${path}.sessionId`),
    reviewId: expectStableId(r.reviewId, `${path}.reviewId`),
    expectedRevision: expectString(r.expectedRevision, `${path}.expectedRevision`),
    decision: expectEnum(valueOf(r, 'decision', path), ['approve-and-commit', 'reject'], `${path}.decision`)
  };
}

// ---------------------------------------------------------------------------
// §12.11 Composer 固定状态机
// ---------------------------------------------------------------------------

export type AgentComposerState =
  | { kind: 'idle'; prompt: '' }
  | { kind: 'composing'; prompt: string }
  | { kind: 'submitting'; runId: string }
  | { kind: 'streaming'; runId: string }
  | { kind: 'tool-running'; runId: string; toolActivityId: string }
  | { kind: 'awaiting-approval'; runId: string; reviewId: string }
  | { kind: 'committing'; runId: string; reviewId: string }
  | { kind: 'verifying'; runId: string; reviewId: string }
  | { kind: 'failed'; prompt: string; reasonCode: string };

export type AgentComposerEvent =
  | { type: 'PROMPT_CHANGED'; prompt: string }
  | { type: 'SUBMIT'; runId: string }
  | { type: 'STREAM_STARTED'; runId: string }
  | { type: 'DELTA'; runId: string }
  | { type: 'TOOL_STARTED'; runId: string; toolActivityId: string }
  | { type: 'TOOL_FINISHED'; runId: string }
  | { type: 'APPROVAL_REQUIRED'; runId: string; reviewId: string }
  | { type: 'APPROVE'; runId: string; reviewId: string }
  | { type: 'REJECT'; runId: string; reviewId: string }
  | { type: 'COMMIT_FINISHED'; runId: string; reviewId: string }
  | { type: 'VERIFY_FINISHED'; runId: string; reviewId: string }
  | { type: 'STREAM_FINISHED'; runId: string }
  | { type: 'FAIL'; prompt: string; reasonCode: string }
  | { type: 'STOP'; runId: string }
  | { type: 'RESET' };

export type AgentComposerDiagnostic = { code: string; message: string; eventType: AgentComposerEvent['type']; stateKind: AgentComposerState['kind'] };

export interface ReduceAgentComposerResult {
  readonly state: AgentComposerState;
  /** 非法转换时的开发诊断；合法转换时为 null。 */
  readonly diagnostic: AgentComposerDiagnostic | null;
}

/**
 * §12.11 固定允许转换；其他组合必须返回原状态并记录开发诊断。
 * 不允许用多个互不约束的 boolean 表示同一状态机。
 */
export function reduceAgentComposer(
  state: AgentComposerState,
  event: AgentComposerEvent
): ReduceAgentComposerResult {
  const invalid = (message: string): ReduceAgentComposerResult => ({
    state,
    diagnostic: { code: 'ILLEGAL_TRANSITION', message, eventType: event.type, stateKind: state.kind }
  });

  switch (event.type) {
    case 'PROMPT_CHANGED': {
      if (state.kind === 'idle') return { state: { kind: 'composing', prompt: event.prompt }, diagnostic: null };
      if (state.kind === 'composing') return { state: { kind: 'composing', prompt: event.prompt }, diagnostic: null };
      return invalid(`PROMPT_CHANGED not allowed from ${state.kind}`);
    }
    case 'SUBMIT': {
      if (state.kind !== 'composing') return invalid(`SUBMIT requires composing, got ${state.kind}`);
      return { state: { kind: 'submitting', runId: event.runId }, diagnostic: null };
    }
    case 'STREAM_STARTED': {
      if (state.kind !== 'submitting') return invalid(`STREAM_STARTED requires submitting, got ${state.kind}`);
      return { state: { kind: 'streaming', runId: event.runId }, diagnostic: null };
    }
    case 'DELTA': {
      if (state.kind !== 'streaming' && state.kind !== 'tool-running') {
        return invalid(`DELTA requires streaming/tool-running, got ${state.kind}`);
      }
      return { state, diagnostic: null };
    }
    case 'TOOL_STARTED': {
      if (state.kind !== 'streaming') return invalid(`TOOL_STARTED requires streaming, got ${state.kind}`);
      return { state: { kind: 'tool-running', runId: event.runId, toolActivityId: event.toolActivityId }, diagnostic: null };
    }
    case 'TOOL_FINISHED': {
      if (state.kind !== 'tool-running') return invalid(`TOOL_FINISHED requires tool-running, got ${state.kind}`);
      return { state: { kind: 'streaming', runId: event.runId }, diagnostic: null };
    }
    case 'APPROVAL_REQUIRED': {
      if (state.kind !== 'streaming' && state.kind !== 'tool-running') {
        return invalid(`APPROVAL_REQUIRED requires streaming/tool-running, got ${state.kind}`);
      }
      return { state: { kind: 'awaiting-approval', runId: event.runId, reviewId: event.reviewId }, diagnostic: null };
    }
    case 'APPROVE': {
      if (state.kind !== 'awaiting-approval') return invalid(`APPROVE requires awaiting-approval, got ${state.kind}`);
      return { state: { kind: 'committing', runId: event.runId, reviewId: event.reviewId }, diagnostic: null };
    }
    case 'REJECT': {
      if (state.kind !== 'awaiting-approval') return invalid(`REJECT requires awaiting-approval, got ${state.kind}`);
      return { state: { kind: 'idle', prompt: '' }, diagnostic: null };
    }
    case 'COMMIT_FINISHED': {
      if (state.kind !== 'committing') return invalid(`COMMIT_FINISHED requires committing, got ${state.kind}`);
      return { state: { kind: 'verifying', runId: event.runId, reviewId: event.reviewId }, diagnostic: null };
    }
    case 'VERIFY_FINISHED': {
      if (state.kind !== 'verifying') return invalid(`VERIFY_FINISHED requires verifying, got ${state.kind}`);
      return { state: { kind: 'idle', prompt: '' }, diagnostic: null };
    }
    case 'STREAM_FINISHED': {
      if (state.kind !== 'streaming') return invalid(`STREAM_FINISHED requires streaming, got ${state.kind}`);
      return { state: { kind: 'idle', prompt: '' }, diagnostic: null };
    }
    case 'FAIL': {
      const active = ['submitting', 'streaming', 'tool-running', 'awaiting-approval', 'committing', 'verifying'] as const;
      if (!(active as readonly string[]).includes(state.kind)) return invalid(`FAIL requires active run, got ${state.kind}`);
      return { state: { kind: 'failed', prompt: event.prompt, reasonCode: event.reasonCode }, diagnostic: null };
    }
    case 'STOP': {
      const active = ['submitting', 'streaming', 'tool-running', 'awaiting-approval', 'committing', 'verifying'] as const;
      if (!(active as readonly string[]).includes(state.kind)) return invalid(`STOP requires active run, got ${state.kind}`);
      return { state: { kind: 'idle', prompt: '' }, diagnostic: null };
    }
    case 'RESET': {
      if (state.kind !== 'failed') return invalid(`RESET requires failed, got ${state.kind}`);
      return { state: { kind: 'idle', prompt: '' }, diagnostic: null };
    }
  }
}
