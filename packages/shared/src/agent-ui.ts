/**
 * AGENT-60C — Agent 语义上下文、opaque 引用与流式消息的 renderer 安全纯逻辑。
 *
 * 本模块只放「不依赖 DOM / IPC 的判定」，renderer 侧单点 import，main 侧复用：
 *
 *  - §12.8 EditorSelectionContext 快照冻结：发送时冻结，切换编辑器不改变已发送目标；
 *  - renderer 安全白名单：绝对路径、raw parser / Hex dump 不得进入 DTO 或 DOM；
 *  - 跨 sender 的 opaque 引用 token（附件 / 资源）：签发、解析、跨 sender 拒绝；
 *  - §12.11 严格 event seq：重复 / 倒序丢弃并记结构化诊断；
 *  - bounded message pages（硬约束 17 大列表分页）：窗口、游标、追加去重；
 *  - scroll threshold：贴底自动滚动 / 顶部触发加载更早；
 *  - resume：承接会话时从尾部回放。
 *
 * §12.11 的 named DTO 类型与 runtime decoder 位于 editor-protocol.ts，本模块重新
 * 导出供 renderer 单点引用，并补上 UI 层判定。composer 状态机（reduceAgentComposer）
 * 已在 editor-protocol.ts，不在此重复。
 */

import {
  decodeEditorSelectionContext,
  type AgentContextSnapshot,
  type AgentMessageDto,
  type AgentMessagePageRequest,
  type AgentResourceReference,
  type AgentStreamEvent,
  type EditorSelectionContext
} from './editor-protocol.js';
import { expectStableId, expectString, fail, isAbsolutePathLike } from './editor-catalog.js';

// ---------------------------------------------------------------------------
// 类型重导出（renderer 单点 import）
// ---------------------------------------------------------------------------

export type {
  EditorSelectionContext,
  AgentContextSnapshot,
  AgentMessagePageRequest,
  AgentMessagePage,
  AgentMessageDto,
  AgentStreamEvent,
  AgentAttachmentReference,
  AgentResourceReference,
  SubmitAgentRunRequest,
  StopAgentRunRequest,
  DecideAgentApprovalRequest,
  AgentRunMode
} from './editor-protocol.js';

export {
  decodeEditorSelectionContext,
  decodeAgentRunMode,
  decodeAgentMessageDto,
  decodeAgentMessagePageRequest,
  decodeAgentMessagePage,
  decodeAgentStreamEvent,
  decodeAgentAttachmentReference,
  decodeAgentResourceReference,
  decodeSubmitAgentRunRequest,
  decodeStopAgentRunRequest,
  decodeDecideAgentApprovalRequest
} from './editor-protocol.js';

// ---------------------------------------------------------------------------
// §12.8 选区快照冻结
// ---------------------------------------------------------------------------

export interface FreezeAgentSelectionSnapshotOptions {
  /** 显式 snapshotId（测试注入；缺省随机生成）。 */
  readonly snapshotId?: string;
  /** 显式创建时间（测试注入；缺省 now）。 */
  readonly createdAt?: string;
}

function createSnapshotId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `snap-${Date.now().toString(36)}-${rand}`;
}

function deepFreezeSelection(selection: EditorSelectionContext): EditorSelectionContext {
  const cursor = selection.cursor === null ? null : Object.freeze({ ...selection.cursor });
  return Object.freeze({
    domain: selection.domain,
    libraryId: selection.libraryId,
    bankId: selection.bankId,
    documentId: selection.documentId,
    paramTableId: selection.paramTableId,
    rowId: selection.rowId,
    fieldId: selection.fieldId,
    fmgEntryId: selection.fmgEntryId,
    eventId: selection.eventId,
    cursor,
    revision: selection.revision
  });
}

/**
 * 发送时冻结上下文快照（§12.8「发送时冻结上下文快照，运行中切换编辑器不能改变
 * 任务目标」）。返回的 snapshot 与 selection 均深度冻结；调用方之后改原 selection
 * 对象也不会改变已发送快照。
 */
export function freezeAgentSelectionSnapshot(
  selection: EditorSelectionContext,
  options: FreezeAgentSelectionSnapshotOptions = {}
): AgentContextSnapshot {
  const snapshot: AgentContextSnapshot = Object.freeze({
    snapshotId: options.snapshotId ?? createSnapshotId(),
    selection: deepFreezeSelection(selection),
    createdAt: options.createdAt ?? new Date().toISOString()
  });
  return snapshot;
}

/** 快照与其 selection 是否已冻结（负向测试断言「切换编辑器不改变已发送快照」的依据）。 */
export function isSelectionSnapshotFrozen(snapshot: AgentContextSnapshot): boolean {
  return Object.isFrozen(snapshot) && Object.isFrozen(snapshot.selection);
}

/** §12.11 AgentContextSnapshot 的 runtime decoder（snapshotId/selection/createdAt）。 */
export function decodeAgentContextSnapshot(value: unknown, path = 'AgentContextSnapshot'): AgentContextSnapshot {
  const r = expectRecordLike(value, path);
  for (const key of Object.keys(r)) {
    if (key !== 'snapshotId' && key !== 'selection' && key !== 'createdAt') {
      fail(`${path}.${key}`, `unknown field "${key}"`);
    }
  }
  return {
    snapshotId: expectStableId(r.snapshotId, `${path}.snapshotId`),
    selection: decodeEditorSelectionContext(r.selection, `${path}.selection`),
    createdAt: expectString(r.createdAt, `${path}.createdAt`)
  };
}

// ---------------------------------------------------------------------------
// renderer 安全白名单：绝对路径 / raw parser / Hex dump 不进入 DTO 或 DOM
// ---------------------------------------------------------------------------

export type AgentSelectionIssueCode =
  | 'AGENT_SELECTION_ABSOLUTE_PATH'
  | 'AGENT_SELECTION_RAW_PARSER'
  | 'AGENT_SELECTION_HEX_DUMP';

export interface AgentSelectionIssue {
  readonly code: AgentSelectionIssueCode;
  readonly path: string;
  readonly message: string;
}

/** 明确禁用的 raw parser / Hex 泄漏标记（出现在选区 id 字符串里即拒绝）。 */
const RAW_PARSER_HEX_MARKERS = ['#hex', '#raw', 'raw://', 'parser:', 'hexdump'] as const;

/** 形如 `XX XX XX ...`（≥8 组双位十六进制）的整行 hex dump。 */
const HEX_DUMP_LINE = /(?:^|[^\dA-Fa-f])(?:[0-9A-Fa-f]{2} ){8,}/;

function looksLikeRawParserMarker(value: string): boolean {
  return RAW_PARSER_HEX_MARKERS.some((marker) => value.includes(marker));
}

function looksLikeHexDump(value: string): boolean {
  return HEX_DUMP_LINE.test(value);
}

function looksLikeAbsolutePath(value: string): boolean {
  return isAbsolutePathLike(value) || /^file:\/\/\//i.test(value);
}

/**
 * 选区 renderer 安全白名单。返回结构化诊断列表；空数组 = 安全。
 *
 * 负向判定（§19.5「Evidence、Hex、parser dump、绝对路径不进入默认 editor/Agent DOM」）：
 * 任一字符串字段携带绝对路径、raw parser 标记或整行 hex dump 都会被拒。
 */
export function selectionRendererSafetyIssues(selection: EditorSelectionContext): readonly AgentSelectionIssue[] {
  const issues: AgentSelectionIssue[] = [];
  const check = (field: keyof EditorSelectionContext, value: string | null): void => {
    if (value === null || value === '') return;
    if (looksLikeAbsolutePath(value)) {
      issues.push({
        code: 'AGENT_SELECTION_ABSOLUTE_PATH',
        path: field,
        message: `${field} 不得包含绝对路径。`
      });
    }
    if (looksLikeRawParserMarker(value) || looksLikeHexDump(value)) {
      issues.push({
        code: looksLikeHexDump(value) ? 'AGENT_SELECTION_HEX_DUMP' : 'AGENT_SELECTION_RAW_PARSER',
        path: field,
        message: `${field} 不得携带 raw parser / Hex dump 内容。`
      });
    }
  };
  check('libraryId', selection.libraryId);
  check('bankId', selection.bankId);
  check('documentId', selection.documentId);
  check('paramTableId', selection.paramTableId);
  check('rowId', selection.rowId);
  check('fieldId', selection.fieldId);
  check('fmgEntryId', selection.fmgEntryId);
  check('eventId', selection.eventId);
  check('revision', selection.revision);
  return issues;
}

export function isSelectionRendererSafe(selection: EditorSelectionContext): boolean {
  return selectionRendererSafetyIssues(selection).length === 0;
}

/** §12.8 无选区时的固定展示文案（renderer 侧）。 */
export const AGENT_NO_SELECTION_LABEL = '未选择逻辑资源';

/**
 * 选区的 opaque 展示摘要：只暴露逻辑层级，不携带任何路径。缺省时给固定空态文案。
 */
export function agentSelectionSummary(selection: EditorSelectionContext | null): string {
  if (selection === null) return AGENT_NO_SELECTION_LABEL;
  const doc = selection.documentId
    ?? selection.paramTableId
    ?? selection.fmgEntryId
    ?? selection.eventId
    ?? selection.bankId
    ?? selection.libraryId;
  if (doc !== null && doc !== '') return `${selection.domain} · ${doc}`;
  return `${selection.domain} · 逻辑库`;
}

// ---------------------------------------------------------------------------
// 跨 sender 的 opaque 引用 token（附件 / 资源）
// ---------------------------------------------------------------------------

export type AgentReferenceTokenKind = 'attachment' | 'resource' | 'citation';

/** 引用 token 默认 TTL：30 分钟。 */
export const AGENT_REFERENCE_TOKEN_TTL_MS = 30 * 60_000;

export interface AgentReferenceTokenPayload {
  readonly v: 1;
  readonly kind: AgentReferenceTokenKind;
  readonly tokenId: string;
  /** 签发者作用域（main 侧 = webContents.id；跑批场景 = sessionId）。 */
  readonly ownerId: string;
  /** 过期 epoch ms。 */
  readonly exp: number;
  readonly domain?: string;
  readonly label?: string;
  readonly byteLength?: number;
  readonly mediaType?: string;
}

export interface MintAgentReferenceTokenInput {
  readonly kind: AgentReferenceTokenKind;
  readonly tokenId: string;
  readonly ownerId: string;
  readonly ttlMs?: number;
  readonly now?: number;
  readonly domain?: string;
  readonly label?: string;
  readonly byteLength?: number;
  readonly mediaType?: string;
}

function base64urlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(text: string): string {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (text.length % 4)) % 4);
  // P3 裁定：atob 输入必须严格校验——token 被污染（含非 Latin1 字符）时抛
  // 可行动错误而不是让 atob 抛 DOMException。
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new AgentReferenceTokenError('引用 token 载荷不是合法 base64（含非 Latin1 字符）。');
  }
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * 签发 opaque 引用 token。token 只携带 tokenId / ownerId / 过期 / 逻辑元数据，
 * 不携带任何路径。真正的防伪由 main 侧注册表承担——renderer 永远不调用本函数。
 */
export function mintAgentReferenceToken(input: MintAgentReferenceTokenInput): string {
  const now = input.now ?? Date.now();
  const payload: AgentReferenceTokenPayload = {
    v: 1,
    kind: input.kind,
    tokenId: input.tokenId,
    ownerId: input.ownerId,
    exp: now + (input.ttlMs ?? AGENT_REFERENCE_TOKEN_TTL_MS),
    ...(input.domain !== undefined ? { domain: input.domain } : {}),
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.byteLength !== undefined ? { byteLength: input.byteLength } : {}),
    ...(input.mediaType !== undefined ? { mediaType: input.mediaType } : {})
  };
  return `agent-ref:${base64urlEncode(JSON.stringify(payload))}`;
}

export class AgentReferenceTokenError extends Error {
  readonly code: 'AGENT_TOKEN_MALFORMED';
  constructor(message: string) {
    super(message);
    this.name = 'AgentReferenceTokenError';
    this.code = 'AGENT_TOKEN_MALFORMED';
  }
}

/** 解析 token 载荷（不含任何路径字段）。格式非法抛 AgentReferenceTokenError。 */
export function parseAgentReferenceToken(token: string): AgentReferenceTokenPayload {
  if (typeof token !== 'string' || !token.startsWith('agent-ref:')) {
    throw new AgentReferenceTokenError('引用 token 格式非法。');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(base64urlDecode(token.slice('agent-ref:'.length)));
  } catch {
    throw new AgentReferenceTokenError('引用 token 载荷不可解析。');
  }
  const r = expectRecordLike(payload, 'AgentReferenceToken');
  const kind = r.kind;
  const v = r.v;
  if (v !== 1) throw new AgentReferenceTokenError('引用 token 版本不兼容。');
  if (kind !== 'attachment' && kind !== 'resource' && kind !== 'citation') {
    throw new AgentReferenceTokenError('引用 token 类型非法。');
  }
  const tokenId = expectStableId(r.tokenId, 'AgentReferenceToken.tokenId');
  const ownerId = expectStableId(r.ownerId, 'AgentReferenceToken.ownerId');
  if (typeof r.exp !== 'number' || !Number.isFinite(r.exp)) {
    throw new AgentReferenceTokenError('引用 token 过期时间非法。');
  }
  return {
    v: 1,
    kind,
    tokenId,
    ownerId,
    exp: r.exp,
    ...(typeof r.domain === 'string' ? { domain: r.domain } : {}),
    ...(typeof r.label === 'string' ? { label: r.label } : {}),
    ...(typeof r.byteLength === 'number' ? { byteLength: r.byteLength } : {}),
    ...(typeof r.mediaType === 'string' ? { mediaType: r.mediaType } : {})
  };
}

export type AgentReferenceScopeValidation =
  | { ok: true; payload: AgentReferenceTokenPayload }
  | { ok: false; code: 'AGENT_TOKEN_MALFORMED' | 'AGENT_TOKEN_EXPIRED' | 'AGENT_TOKEN_SENDER_MISMATCH'; message: string };

/**
 * 跨 sender token / handle 拒绝（§12.11「附件和资源引用只使用 main-issued token」）。
 * ownerId 与 token 签发作用域不一致即拒绝——A sender 签发的 token 不能由 B 提交。
 */
export function validateAgentReferenceScope(
  token: string,
  ownerId: string,
  nowMs: number = Date.now()
): AgentReferenceScopeValidation {
  let payload: AgentReferenceTokenPayload;
  try {
    payload = parseAgentReferenceToken(token);
  } catch (error) {
    return {
      ok: false,
      code: 'AGENT_TOKEN_MALFORMED',
      message: error instanceof Error ? error.message : '引用 token 格式非法。'
    };
  }
  if (nowMs > payload.exp) {
    return { ok: false, code: 'AGENT_TOKEN_EXPIRED', message: '引用 token 已过期，请重新获取。' };
  }
  if (payload.ownerId !== ownerId) {
    return { ok: false, code: 'AGENT_TOKEN_SENDER_MISMATCH', message: '引用 token 属于其他发送方。' };
  }
  return { ok: true, payload };
}

/** token 的过期 ISO 时间（main 侧签发引用对象时与 token 内的 exp 保持同一口径）。 */
export function agentReferenceExpiresAt(now: number = Date.now(), ttlMs: number = AGENT_REFERENCE_TOKEN_TTL_MS): string {
  return new Date(now + ttlMs).toISOString();
}

// ---------------------------------------------------------------------------
// §12.11 严格 event seq（重复 / 倒序丢弃并记诊断）
// ---------------------------------------------------------------------------

export interface AgentStreamSeqDiagnostic {
  readonly code: 'DUPLICATE_SEQ' | 'REVERSED_SEQ';
  readonly sessionId: string;
  readonly seq: number;
  readonly lastSeq: number;
}

export interface AgentStreamSeqState {
  readonly lastSeqBySession: ReadonlyMap<string, number>;
  readonly diagnostics: readonly AgentStreamSeqDiagnostic[];
}

export type AgentStreamSeqVerdict = { accepted: true } | { accepted: false; reason: 'DUPLICATE_SEQ' | 'REVERSED_SEQ' };

export function createAgentStreamSeqState(): AgentStreamSeqState {
  return { lastSeqBySession: new Map(), diagnostics: [] };
}

/**
 * 严格递增 seq 判定：`seq` 必须大于该 session 的上一条已接受 seq。
 * 重复 / 倒序丢弃并追加结构化诊断；accepted 的调用返回包含新 lastSeq 的状态。
 */
export function applyAgentStreamSeq(
  state: AgentStreamSeqState,
  event: { readonly sessionId: string; readonly seq: number }
): { readonly state: AgentStreamSeqState; readonly verdict: AgentStreamSeqVerdict } {
  const last = state.lastSeqBySession.get(event.sessionId) ?? null;
  if (last !== null && event.seq <= last) {
    const reason = event.seq === last ? 'DUPLICATE_SEQ' : 'REVERSED_SEQ';
    const diagnostic: AgentStreamSeqDiagnostic = {
      code: reason,
      sessionId: event.sessionId,
      seq: event.seq,
      lastSeq: last
    };
    return {
      state: { ...state, diagnostics: [...state.diagnostics, diagnostic] },
      verdict: { accepted: false, reason }
    };
  }
  const nextLastSeqBySession = new Map(state.lastSeqBySession);
  nextLastSeqBySession.set(event.sessionId, event.seq);
  return {
    state: { lastSeqBySession: nextLastSeqBySession, diagnostics: state.diagnostics },
    verdict: { accepted: true }
  };
}

export interface AgentStreamSeqTracker {
  accept(event: { readonly sessionId: string; readonly seq: number }): boolean;
  readonly lastSeqBySession: ReadonlyMap<string, number>;
  readonly diagnostics: readonly AgentStreamSeqDiagnostic[];
}

/** 可变便捷封装（UI 侧用）；纯逻辑本体是 applyAgentStreamSeq。 */
export function createAgentStreamSeqTracker(): AgentStreamSeqTracker {
  let state: AgentStreamSeqState = createAgentStreamSeqState();
  return {
    accept(event) {
      const result = applyAgentStreamSeq(state, event);
      state = result.state;
      return result.verdict.accepted;
    },
    get lastSeqBySession() {
      return state.lastSeqBySession;
    },
    get diagnostics() {
      return state.diagnostics;
    }
  };
}

// ---------------------------------------------------------------------------
// bounded message pages（硬约束 17 大列表分页）
// ---------------------------------------------------------------------------

/** §12.11 limit 默认值（decoder 限制 1..100）。 */
export const AGENT_MESSAGE_PAGE_SIZE = 50;
/** 视口最多保留的消息条数；超出后丢弃最老消息（分页前提是有界）。 */
export const AGENT_MESSAGE_RETAIN_LIMIT = 200;

export function clampAgentMessagePageLimit(limit: number): number {
  if (!Number.isInteger(limit)) return AGENT_MESSAGE_PAGE_SIZE;
  return Math.min(100, Math.max(1, limit));
}

export function formatAgentMessageCursor(index: number): string {
  return `msg:${Math.max(0, Math.trunc(index))}`;
}

/** 解析 `msg:<index>` 游标；格式非法返回 null。 */
export function parseAgentMessageCursor(cursor: string): number | null {
  if (cursor.startsWith('msg:')) {
    const index = Number.parseInt(cursor.slice(4), 10);
    if (Number.isInteger(index) && index >= 0) return index;
  }
  return null;
}

function resolveMessageCursorIndex(messages: readonly AgentMessageDto[], cursor: string): number {
  if (cursor.startsWith('msg:')) {
    const index = Number.parseInt(cursor.slice(4), 10);
    if (Number.isInteger(index) && index >= 0) return Math.min(index, messages.length);
  }
  const byId = messages.findIndex((message) => message.id === cursor);
  return byId >= 0 ? byId + 1 : 0;
}

export interface AgentMessagePageSlice {
  readonly items: readonly AgentMessageDto[];
  readonly nextCursor: string | null;
}

/** 从游标处取一页（§12.11 AgentMessagePageRequest/AgentMessagePage 的纯逻辑）。 */
export function sliceAgentMessagePage(
  messages: readonly AgentMessageDto[],
  cursor: string | null,
  limit: number
): AgentMessagePageSlice {
  const safeLimit = clampAgentMessagePageLimit(limit);
  const start = cursor === null ? 0 : resolveMessageCursorIndex(messages, cursor);
  const items = messages.slice(start, start + safeLimit);
  const nextStart = start + safeLimit;
  return {
    items,
    nextCursor: nextStart < messages.length ? formatAgentMessageCursor(nextStart) : null
  };
}

export interface AgentMessageWindow {
  readonly items: readonly AgentMessageDto[];
  readonly startIndex: number;
  readonly endIndex: number;
  readonly hasOlder: boolean;
  readonly hasNewer: boolean;
}

/** 以窗口 [startIndex, startIndex+limit) 渲染的有界窗口。 */
export function agentMessageWindow(
  messages: readonly AgentMessageDto[],
  startIndex: number,
  limit: number
): AgentMessageWindow {
  const safeLimit = clampAgentMessagePageLimit(limit);
  const start = Math.max(0, Math.min(startIndex, messages.length));
  const end = Math.min(messages.length, start + safeLimit);
  return {
    items: messages.slice(start, end),
    startIndex: start,
    endIndex: end,
    hasOlder: start > 0,
    hasNewer: end < messages.length
  };
}

/** 尾部窗口（初始渲染 / resume 回放）。 */
export function agentMessageTail(messages: readonly AgentMessageDto[], limit: number = AGENT_MESSAGE_PAGE_SIZE): AgentMessageWindow {
  const safeLimit = clampAgentMessagePageLimit(limit);
  const start = Math.max(0, messages.length - safeLimit);
  return agentMessageWindow(messages, start, safeLimit);
}

/** 「加载更早」游标：指向当前窗口再往前一页的位置；无更早消息时为 null。 */
export function agentOlderCursor(window: AgentMessageWindow, limit: number): string | null {
  if (!window.hasOlder) return null;
  return formatAgentMessageCursor(Math.max(0, window.startIndex - clampAgentMessagePageLimit(limit)));
}

export interface AppendAgentMessagePageResult {
  readonly messages: readonly AgentMessageDto[];
  readonly added: number;
  readonly replaced: number;
  /** 超出 RETAIN_LIMIT 被丢弃的最老消息 id。 */
  readonly dropped: readonly string[];
}

/**
 * 流式增量合并：按 id 去重（同 id 视为 streaming 更新替换旧值），新消息追加到尾部；
 * 总长度超过 RETAIN_LIMIT 时丢弃最老消息，保持视口有界。
 */
export function appendAgentMessagePage(
  prev: readonly AgentMessageDto[],
  incoming: readonly AgentMessageDto[]
): AppendAgentMessagePageResult {
  let messages = [...prev];
  let added = 0;
  let replaced = 0;
  const seen = new Set(messages.map((message) => message.id));
  for (const message of incoming) {
    if (seen.has(message.id)) {
      messages = messages.map((existing) => existing.id === message.id ? message : existing);
      replaced += 1;
    } else {
      seen.add(message.id);
      messages = [...messages, message];
      added += 1;
    }
  }
  const dropped = messages.length > AGENT_MESSAGE_RETAIN_LIMIT
    ? messages.slice(0, messages.length - AGENT_MESSAGE_RETAIN_LIMIT).map((message) => message.id)
    : [];
  if (dropped.length > 0) messages = messages.slice(-AGENT_MESSAGE_RETAIN_LIMIT);
  return { messages, added, replaced, dropped };
}

/** §12.11 AgentMessagePageRequest 的构造（limit 收敛到 1..100）。 */
export function buildAgentMessagePageRequest(
  sessionId: string,
  cursor: string | null,
  limit: number
): AgentMessagePageRequest {
  return { sessionId, cursor, limit: clampAgentMessagePageLimit(limit) };
}

// ---------------------------------------------------------------------------
// scroll threshold（贴底自动滚动 / 顶部加载更早）
// ---------------------------------------------------------------------------

export interface AgentScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** 距底部不足该值视为「贴底」，自动滚动到底部。 */
export const AGENT_SCROLL_THRESHOLD_PX = 48;

export function shouldAgentAutoScroll(metrics: AgentScrollMetrics, threshold: number = AGENT_SCROLL_THRESHOLD_PX): boolean {
  return metrics.scrollHeight - (metrics.scrollTop + metrics.clientHeight) <= threshold;
}

export function isAgentScrollNearTop(metrics: AgentScrollMetrics, threshold: number = AGENT_SCROLL_THRESHOLD_PX): boolean {
  return metrics.scrollTop <= threshold;
}

// ---------------------------------------------------------------------------
// resume（承接会话时从尾部回放）
// ---------------------------------------------------------------------------

/** 承接会话时回放的尾部消息条数（与 ai.agent.session.load 的 messagesPage 尾部一致）。 */
export const AGENT_RESUME_TAIL_MESSAGES = 20;

export function agentResumeStartIndex(total: number, tail: number = AGENT_RESUME_TAIL_MESSAGES): number {
  return Math.max(0, total - Math.max(0, Math.trunc(tail)));
}

export function buildAgentResumePageRequest(
  sessionId: string,
  totalMessages: number,
  limit: number = AGENT_MESSAGE_PAGE_SIZE
): AgentMessagePageRequest {
  return buildAgentMessagePageRequest(sessionId, formatAgentMessageCursor(agentResumeStartIndex(totalMessages)), limit);
}

// ---------------------------------------------------------------------------
// 流事件装配：严格 seq 过滤 + message 增量合并
// ---------------------------------------------------------------------------

export interface AgentStreamAssemblyResult {
  readonly messages: readonly AgentMessageDto[];
  readonly dropped: readonly AgentStreamSeqDiagnostic[];
  readonly lastSeqBySession: ReadonlyMap<string, number>;
}

function applyAssembledEvent(messages: readonly AgentMessageDto[], event: AgentStreamEvent): readonly AgentMessageDto[] {
  switch (event.kind) {
    case 'message-started':
      return appendAgentMessagePage(messages, [event.message]).messages;
    case 'message-delta': {
      const updated = messages.map((message) =>
        message.id === event.messageId && message.kind === 'assistant'
          ? { ...message, markdown: message.markdown + event.delta }
          : message
      );
      return updated;
    }
    case 'message-finished': {
      return messages.map((message) =>
        message.id === event.messageId && message.kind === 'assistant'
          ? { ...message, streaming: false }
          : message
      );
    }
    case 'tool-updated':
    case 'approval-updated':
      return appendAgentMessagePage(messages, [event.message]).messages;
    case 'run-failed':
      // run-failed 由 composer 状态机承担，不进消息流。
      return messages;
  }
}

/**
 * 把一段 §12.11 AgentStreamEvent 装配成有序消息列表：
 *  - 严格 seq：重复 / 倒序事件丢弃并记诊断（不重放）；
 *  - 同 id 增量更新（delta 追加、finished 关流、tool/approval 替换）；
 *  - 输出有界（RETAIN_LIMIT）。
 */
export function reduceAgentStreamToMessages(events: readonly AgentStreamEvent[]): AgentStreamAssemblyResult {
  let state = createAgentStreamSeqState();
  let messages: readonly AgentMessageDto[] = [];
  for (const event of events) {
    const result = applyAgentStreamSeq(state, { sessionId: event.sessionId, seq: event.seq });
    state = result.state;
    if (result.verdict.accepted) {
      messages = applyAssembledEvent(messages, event);
    }
  }
  return { messages, dropped: state.diagnostics, lastSeqBySession: state.lastSeqBySession };
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function expectRecordLike(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, `expected object, got ${typeof value}`);
  }
  return value as Record<string, unknown>;
}
