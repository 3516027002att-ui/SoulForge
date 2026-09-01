/**
 * EVENT-30B — DarkScript3 式 Event 源码工作台。
 *
 * 布局对照 DarkScript3（§11），不是 260/320 三栏：
 *   [文档标签栏] 逻辑文档标签（EMEVD 文档，§3.4），带 dirty 标记与关闭
 *   [工具条]     保存 / 撤回 · Ctrl+F 查找 · Ctrl+S 保存
 *   [主区]       源码（可并排第二视口）+ 右栏词义（S31）
 *
 * Negative DOM（EVENT-30B）：Flow / Hex / Raw Bytes 不在默认 viewport；原始
 * bytes 只能经 Developer Diagnostics 打开（本面板不提供）；查找替换 / Outline /
 * Inspector / Problems 四个开关与选中节点面板、底部 dock 均不渲染。
 *
 * 数据流：renderer 不持有文件系统路径与完整 document。App 经 `pendingTab`
 * （有界 DSL 投影 + 派生 document）按资源 URI 提供标签；提交以 `EventSourceTabData`
 * 上抛，由 App 走 Bridge → Patch 管线。dirty 与编辑文本（draft）只在工作台内部，
 * 跨 tab 隔离（per-tab EditorState 缓存 undo/redo 历史）。
 *
 * S35（超长 EMEVD，规格 event-common-load.md §3.2）：打开回包只有 outline +
 * 前 400 行 + opaque source token，不再预先灌完 7 万行。面板首帧用前缀建缓冲，
 * 随后只在用户滚近已加载底部时续载一片；不在打开路径自动拉到 EOF。查找（Ctrl+F）
 * / 提交仍一次拉齐，追加永远发生在文档末尾，不扰动用户编辑、光标与滚动位置。
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement
} from 'react';
import type { EmevdEditorDocument } from '@soulforge/shared';
import type {
  EmedfCompletionItem,
  EmedfEnumDef,
  EventSymbol,
  EventDiagnostic,
  EventCursorContext,
  EventSignatureHelp
} from '@soulforge/core';
import {
  analyzeCursorContext,
  getSignatureHelp,
  indexDocumentSymbols,
  formatEventDocument
} from '@soulforge/core/dist/emevd/language-service/index.js';
import { getRendererBridge } from '../runtime/rendererRuntime.js';
import { createCompleteSourceState } from '../emevd/emevdSourceMount.js';
import {
  appendSourceTail,
  createIncrementalSourceState,
  fetchAllRemainingSource,
  fetchNextSourceSlice,
  isIncrementalSourceComplete,
  isNearLoadedBottom,
  sourceFillAnnotation,
  sourceFillCompletionAnnotation,
  type IncrementalSourceState
} from '../emevd/incrementalSourceInjection.js';
import {
  fmgSemanticOf,
  indexEventHeaders,
  inspectSourceLine,
  inspectAtCursor,
  insufficientEvidence,
  isFmgRole,
  resolveEventJump,
  type EventJump,
  type LineInspection,
  type ResourceJumpRequest,
  type ResourceJumpResult
} from '../emevd/eventSourceNavigate.js';
import { emevdCompletionExtension } from '../emevd/cmCompletion.js';
import { signatureHelpExtension, setSignatureHelpCatalogEffect } from '../emevd/cmSignatureHelp.js';
import { emevdDiagnosticsExtension } from '../emevd/cmDiagnostics.js';
import { emevdEditingCommandsExtension, formatDocument } from '../emevd/cmEditorCommands.js';
import { emevdNavigationExtension } from '../emevd/cmNavigation.js';
import { EventOutlinePane } from './EventOutlinePane.js';
import { WorkbenchLayout } from '../workbench/WorkbenchLayout.js';
import { EditorState, Transaction, type Extension } from '@codemirror/state';
import {
  EditorView,
  GutterMarker,
  drawSelection,
  dropCursor,
  gutter,
  highlightActiveLine,
  highlightActiveLineGutter,
  hoverTooltip,
  keymap,
  lineNumbers,
  type Tooltip
} from '@codemirror/view';
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  foldGutter,
  foldService,
  indentOnInput,
  syntaxHighlighting
} from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  closeBrackets,
  closeBracketsKeymap
} from '@codemirror/autocomplete';
import {
  search,
  searchKeymap,
  openSearchPanel
} from '@codemirror/search';
import { tags } from '@lezer/highlight';

export interface EventSourceSubmitResult {
  ok: boolean;
  diagnostics: Array<{ severity: string; code: string; message: string }>;
  nextDslTemplate?: string;
}

/**
 * 事件块的 gutter 判据行（按文档顺序）。
 *
 * 工作台只需要「第 N 个事件块是哪个 eventId、有几条未知指令」。以前它从
 * `document.events` 里 filter 出来，逼着 App 为此保留一份带指令体的投影 ——
 * 而那份投影只能来自另一次 `readEmevdDocument`（EVENT-30A envelope 默认只采样
 * 256 条指令，第 256 条之后的事件会被整段误判为「全未知」，1730 事件的真实
 * 文件里几乎每个 gutter 标记都是假的）。
 *
 * 现在改由 `readEmevdFullDocument` 的 outline 直接给：unknownCount 是主进程按
 * 完整 EMEDF registry 逐条判的，覆盖 4096 个事件（实测最大 common_func 2124）。
 */
export interface EventWarningRow {
  eventId: number;
  /** 该事件里 EMEDF 无定义的指令条数；0 表示不打标记。 */
  warnings: number;
}

/** 一个逻辑 EMEVD 文档标签的只读数据（App 侧维护，renderer 只展示与编辑）。 */
export interface EventSourceTabData {
  tabId: string;
  title: string;
  resourceUri: string;
  document: EmevdEditorDocument;
  /**
   * gutter 判据。live 文档由 outline 给（权威）；缺省时退回按 `document.events`
   * 现算，保持只读 demo / 读取失败 / 单测里手搓文档的既有行为。
   *
   * 显式带 `| undefined`：换文档时必须能把上一份判据清掉（`exactOptionalPropertyTypes`
   * 下「不写这个键」与「写 undefined」是两件事，而合并 tab 时只能后者）。
   */
  eventWarnings?: readonly EventWarningRow[] | undefined;
  sourceHash: string | null;
  live: boolean;
  dslTemplate: string | null;
  dslTemplateTruncated: boolean;
  dslTemplateTotalLines: number;
  /**
   * 源码形态（R3/P4 裁定）：
   * - 'dark-script'：EMEDF 反汇编的 DarkScript3 式源码，可编辑（S14）；
   * - 'patch-dsl'：旧 hash DSL（历史路径）；
   * - 'none'：EMEDF 缺失失败关闭（不提供伪解码）。
   */
  sourceStyle?: 'dark-script' | 'patch-dsl' | 'none' | undefined;
  /**
   * S35 增量源（超长 EMEVD）：打开首帧只有前 400 行 + opaque source token，
   * 全文按视口续载（incrementalSourceInjection）。有 sourceToken 且 dslTemplate
   * 为 null 时，首帧缓冲 = sourcePrefix；查找（Ctrl+F）/ 提交等明确的全文需求时才拉齐，
   * 脏标记不会触发全量读取。
   * 提交后的重读回灌走完整 dslTemplate，不带这三项。
   */
  sourceToken?: string | null;
  sourcePrefix?: string | null;
  sourceTotalLines?: number;
}

export interface EventSourceWorkbenchPanelProps {
  /** App 最近一次打开/刷新的 EMEVD 文档；工作台按 tabId 去重后追加或更新标签。 */
  pendingTab: EventSourceTabData | null;
  /** 面板当前是否在可视工作区。不可见时 App 用 hidden 包住但保持挂载。 */
  active?: boolean | undefined;
  /** App 侧是否正在读 EMEVD（Bridge 分页读 + worker 反汇编 + 切片拼齐）。 */
  opening?: boolean | undefined;
  /** 全文未齐时的只读前缀（不是 EditorState）。 */
  openingPreview?: string | null | undefined;
  onDslSubmit?: (
    tab: EventSourceTabData,
    sourceText: string
  ) => Promise<EventSourceSubmitResult>;
  /**
   * S31：文本 / PARAM 实参跳转。App 只切到 openTabs 里已打开的资源并下发
   * reveal 请求，工作区不新开磁盘文件；对不上时返回 insufficient_evidence。
   */
  onJumpResource?: (request: ResourceJumpRequest) => Promise<ResourceJumpResult>;
}

interface InternalTab extends EventSourceTabData {
  /** 用户已编辑未提交。 */
  dirty: boolean;
  /** 当前源码文本（含用户编辑）。 */
  draft: string;
  /** 最近一次干净文本（打开时的缓冲 / 续载追加 / 保存成功）。撤回回到这里。 */
  lastSavedText: string;
  /**
   * 该标签的 CodeMirror 状态（含 undo/redo 历史），切换标签时保留。
   * 完整缓冲（拉齐后 / 提交后 / 小文档）一次 createCompleteSourceState；
   * S35 增量源首帧只有前缀，续载经 dispatch / EditorState.update 追加并
   * 同步回 editorState —— 不存在 sourceFillTarget / 16ms 分片态。
   */
  editorState: EditorState;
  /** S35：增量源已加载行数（首帧 = 前缀行数；续载后随追加增长）。 */
  sourceLoadedLines: number;
  /** S35：增量源全文总行数（main 口径）。 */
  sourceTotalLines: number;
  /** S35：增量源是否已拉齐（无 token 的 tab 恒为 true）。 */
  sourceComplete: boolean;
}

interface EventLineInfo {
  eventId: number;
  warnings: number;
}

/** 无 dslTemplate（只读 demo / 读取失败 / EMEDF 缺失失败关闭）时的结构化投影基线。 */
function renderSource(document: EmevdEditorDocument): string {
  const lines = [`resource ${JSON.stringify(document.resourceUri)}`];
  for (const event of document.events) {
    lines.push(`event @e:${event.anchor?.localNodeId ?? event.eventId} {`);
    lines.push(`  set id = ${event.eventId}`);
    lines.push(`  set rest = ${event.restBehavior}`);
    if (event.layer !== -1) {
      lines.push(`  // layer=${event.layer} is read-only in DSL Slice A+B`);
    }
    for (const instruction of event.instructions) {
      lines.push(
        `  // read-only ${instruction.anchor?.localNodeId ?? ''} bank=${instruction.bank} id=${instruction.id}`
      );
    }
    lines.push('}', '');
  }
  return lines.join('\n').trimEnd();
}

/**
 * R3/P4 裁定：没 EMEDF 必须失败关闭，不能再用 hash 伪源码冒充已解码。
 * 事件工作台在拿不到用户本机 EMEDF 时只显示这一句可行动说明，不渲染任何
 * `instruction @i:hash` / `event @e:` 伪源码。
 */
const EMEDF_MISSING_SOURCE = [
  '// 事件源码反汇编已失败关闭：未找到用户本机 EMEDF。',
  '// 需要 DarkScript3 安装里的 sekiro-common.emedf.json：',
  '//   1) 设置环境变量 SOULFORGE_EMEDF_PATH 指向该文件；或',
  '//   2) 把文件放到游戏根旁 tools/<工具目录>/Resources/sekiro-common.emedf.json。',
  '// 反汇编只消费 EMEDF 公开语法，数据留在本机，不会打进仓库。'
].join('\n');

/**
 * S15 失败面：读取失败（非 live 且无模板）时，源码区给 code + 人话 + 下一步，
 * 禁止再画 `resource "file://event/…"` 假源码。message 来自已过 sanitizer 的
 * IPC 诊断；KRAK 缺 Oodle 时 Bridge 的 message 本身就是可行动句，不再追加。
 */
export function readFailureSource(document: EmevdEditorDocument): string | null {
  const failure = document.diagnostics.find(
    (diagnostic) => diagnostic.severity === 'error' || diagnostic.severity === 'warning'
  );
  if (!failure) return null;
  const lines = [
    `// 事件脚本读不出来（${failure.code}）`,
    `// ${failure.message}`
  ];
  if (!failure.message.includes('开始')) {
    lines.push(
      '// 下一步：在「开始」页确认已挂载含 sekiro.exe 的原版目录后重新打开；',
      '// 仍未解决则检查该文件是否完整（KRAK 压缩需要 Oodle 运行库）。'
    );
  }
  return lines.join('\n');
}

export function isSourceReadOnly(tab: Pick<EventSourceTabData, 'live' | 'dslTemplate' | 'sourceStyle' | 'sourceToken'>): boolean {
  // S35：增量源 tab（dslTemplate 为 null 但持有 sourceToken）是 live 可编辑的，
  // 与「EMEDF 缺失失败关闭（无 token 无模板）」区分开。
  return !tab.live || (tab.dslTemplate === null && !tab.sourceToken);
}

export function baselineText(tab: EventSourceTabData): string {
  // S35：增量源首帧只有前缀；全文按视口续载，不在这里拼（打开时禁止同步拉全文）。
  if (tab.sourceToken && tab.sourcePrefix !== undefined && tab.sourcePrefix !== null) {
    return tab.sourcePrefix;
  }
  // live 但 dslTemplate 缺失 = EMEDF 缺失（主进程失败关闭，不给伪源码）。
  if (tab.live && tab.dslTemplate === null) return EMEDF_MISSING_SOURCE;
  // S15：读取失败（非 live 且无模板）→ 可行动失败句，禁止假 resource 源码。
  if (!tab.live && tab.dslTemplate === null) {
    return readFailureSource(tab.document) ?? renderSource(tab.document);
  }
  return tab.dslTemplate ?? renderSource(tab.document);
}

/**
 * 取一个标签的 gutter 判据行：优先用 App 下发的 outline 派生行（live 文档），
 * 否则按 `document.events` 现算（只读 demo / 读取失败 / 单测手搓文档）。
 */
export function eventWarningRowsOf(tab: EventSourceTabData): readonly EventWarningRow[] {
  if (tab.eventWarnings) return tab.eventWarnings;
  return tab.document.events.map((event) => ({
    eventId: event.eventId,
    warnings: event.instructions.reduce((n, instruction) => n + (instruction.unknown ? 1 : 0), 0)
  }));
}

/**
 * 定位 doc 里每个事件块的首行（1-based 行号），供 gutter 标记与 Go to Event。
 *
 * 三种锚形态都要认，且都按「块出现顺序 = rows 顺序」对齐：
 * - `$Event(`：R3/P4 DarkScript3 式模板，本身不带锚，只能按顺序。
 * - `event @e:<eventId>`：`renderSource` 在文档没挂锚时的形态，锚就是十进制 eventId。
 * - `event @e:<localNodeId>`：挂过 stableIdentity 的形态，锚是 24 位 hex，跟 eventId
 *   无关，从 rows 里查不到。
 *
 * 所以锚能解析成已知 eventId 就按锚取（模板重排也不会错位），否则退回按顺序取。
 * 原实现在锚查不到时直接 `continue`，等于「文档没挂锚 → 整列标记静默消失」；
 * 而生产路径正好就是没挂锚的那种，标记全靠 `$Event(` 分支才没露出来。
 * 行号随 draft 编辑变化，故在 draft 变化时重建。
 */
export function indexEventLines(
  text: string,
  rows: readonly EventWarningRow[]
): Map<number, EventLineInfo> {
  const byEventId = new Map<string, EventWarningRow>();
  for (const row of rows) byEventId.set(String(row.eventId), row);
  const map = new Map<number, EventLineInfo>();
  let blockIndex = 0;
  let lineNumber = 1;
  let lineStart = 0;

  // 流式扫行：七万行文档不额外 split 出一整份字符串数组。
  while (lineStart <= text.length) {
    const nl = text.indexOf('\n', lineStart);
    const line = nl < 0 ? text.slice(lineStart) : text.slice(lineStart, nl);
    const anchorMatch = /^event\s+@e:(\S+)/.exec(line);
    if (anchorMatch || /^\$Event\(/.test(line)) {
      const row = (anchorMatch ? byEventId.get(anchorMatch[1]!) : undefined) ?? rows[blockIndex];
      blockIndex += 1;
      if (row && row.warnings > 0) map.set(lineNumber, { eventId: row.eventId, warnings: row.warnings });
    }
    if (nl < 0) break;
    lineStart = nl + 1;
    lineNumber += 1;
  }
  return map;
}

/** DarkScript 风格高亮：注释灰、指令名强调、数字亮色、字符串绿、只读注释加深。 */
export const darkScriptStyle = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--ink-3)', fontStyle: 'italic' },
  { tag: tags.lineComment, color: 'var(--ink-3)', fontStyle: 'italic' },
  { tag: tags.blockComment, color: 'var(--ink-3)', fontStyle: 'italic' },
  { tag: tags.controlKeyword, color: 'var(--ember-text)', fontWeight: '700' },
  { tag: tags.keyword, color: 'var(--ember-text)', fontWeight: '600' },
  { tag: tags.atom, color: 'var(--ember-text)' },
  { tag: tags.function(tags.variableName), color: 'var(--ink-0)', fontWeight: '600' },
  { tag: tags.className, color: 'var(--ember-text)', fontStyle: 'italic' },
  { tag: tags.local(tags.variableName), color: 'var(--ink-2)' },
  { tag: tags.bool, color: 'var(--ok)' },
  { tag: tags.number, color: 'var(--ok)' },
  { tag: tags.string, color: 'var(--ok)' },
  { tag: tags.propertyName, color: 'var(--ink-0)' },
  { tag: tags.variableName, color: 'var(--ink-1)' },
  { tag: tags.punctuation, color: 'var(--ink-3)' },
  { tag: tags.operator, color: 'var(--ember-text)' },
  { tag: tags.invalid, color: 'var(--danger-text)', fontWeight: '600' }
]);

/**
 * DarkScript3 式源码的流式词法。
 * 枚举通道覆盖 ComparisonType.Equal 一类 Namespace.Name；形参覆盖 X0_4。
 */
export const darkScriptStreamLanguage = StreamLanguage.define({
  name: 'dark-script',
  tokenTable: {
    eventHeader: tags.controlKeyword,
    controlKeyword: tags.controlKeyword,
    instruction: tags.function(tags.variableName),
    enumMember: tags.className,
    formalParameter: tags.local(tags.variableName),
    bool: tags.bool,
    readOnlyComment: tags.invalid
  },
  token(stream) {
    if (stream.match(/^\/\/.*/)) {
      return /^\/\/\s*(?:unknown|BASE64_INVALID|[A-Z][A-Z0-9_]{3,})\s+bank=/.test(stream.current())
        ? 'readOnlyComment'
        : 'lineComment';
    }
    if (stream.match(/^\/\*[\s\S]*?\*\//)) return 'blockComment';
    if (stream.match(/^\s+/)) return null;
    if (stream.match(/^\$Event\(/)) return 'eventHeader';
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return 'string';
    if (stream.match(/^\b(?:true|false)\b/)) return 'bool';
    if (stream.match(/^\b(?:Default|Restart)\b/)) return 'atom';
    if (stream.match(/^\b(?:WaitFor)\b/)) return 'controlKeyword';
    if (stream.match(/^\b(?:function|return|if|else|while|for)\b/)) return 'keyword';
    if (stream.match(/^[A-Z][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+/)) return 'enumMember';
    if (stream.match(/^X\d+_\d+/)) return 'formalParameter';
    if (stream.match(/^[A-Z][A-Za-z0-9_]*(?=\s*\()/)) return 'instruction';
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) return 'variableName';
    if (stream.match(/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/i)) return 'number';
    if (stream.match(/^[{}()\[\],;]/)) return 'punctuation';
    if (stream.match(/^(?:&&|\|\||[!<>=]=?|[-+*\/])/)) return 'operator';
    stream.next();
    return null;
  }
});

/**
 * EMEVD Patch-DSL 流式词法（renderEmevdPatchDsl 的输出语法）：
 *   resource "uri"
 *   base revision N schema "..."
 *   event @e:<local> { set id = N; set rest = N; ... }
 *   instruction @i:<local> { set arg <name> = <literal>; }
 *   // 注释 / // read-only ...（未知指令）
 */
const emevdDslStreamLanguage = StreamLanguage.define({
  name: 'emevd-dsl',
  token(stream) {
    if (stream.match(/^\/\/.*/)) return 'lineComment';
    if (stream.match(/^\s+/)) return null;
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return 'string';
    if (stream.match(/^\d+(?:\.\d+)?(?:e[+-]?\d+)?/i)) return 'number';
    if (stream.match(/^[{}()[\],;=]/)) return 'punctuation';
    if (stream.match(/^\b(?:resource|base|revision|schema|event|instruction|set|arg)\b/)) {
      return 'keyword';
    }
    if (stream.match(/^\b(?:id|rest|layer|bank|name)\b/)) return 'propertyName';
    if (stream.match(/^@[ei]:\S+/)) return 'atom';
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) return 'variableName';
    stream.next();
    return null;
  }
});

/** `$Event(` 块折叠：事件头行可折叠到对应的 `});`，折叠后事件边界仍在视口中。 */
export function eventBlockFoldRange(
  state: EditorState,
  lineStart: number,
  lineEnd: number
): { from: number; to: number } | null {
  const startLine = state.doc.lineAt(lineStart);
  if (!/^\$Event\(/.test(startLine.text)) return null;
  for (let lineNumber = startLine.number + 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const candidate = state.doc.line(lineNumber);
    if (/^\}\)\;/.test(candidate.text)) return { from: lineEnd, to: candidate.from };
  }
  return null;
}

const eventBlockFolding = foldService.of(eventBlockFoldRange);

/** gutter 的未知指令 warning 记号。toDOM 只在浏览器渲染 CM 时调用（SSR 不跑 effect）。 */
class EventDiagMarker extends GutterMarker {
  constructor(
    private readonly eventId: number,
    private readonly warnings: number
  ) {
    super();
  }

  override toDOM(): HTMLElement {
    const element = document.createElement('span');
    element.className = 'cm-event-diag__warn';
    element.textContent = '⚑';
    element.title = `Event ${this.eventId}：${this.warnings} 条未知指令（read-only）`;
    return element;
  }
}

/** gutter 读事件行映射：每 tab 的 event 块首行若含未知指令则标 warning 记号。 */
const eventDiagGutter = gutter({
  class: 'cm-event-diag',
  lineMarker(view, line) {
    const info = (view as unknown as { _eventLineInfo?: Map<number, EventLineInfo> })
      ._eventLineInfo;
    const lineNumber = view.state.doc.lineAt(line.from).number;
    const marker = info?.get(lineNumber);
    if (!marker || marker.warnings <= 0) return null;
    return new EventDiagMarker(marker.eventId, marker.warnings);
  }
});

/* ------------------------------------------------------------------ */
/*  T4-3：EMEDF 指令名 autocomplete + 悬停参数名                      */
/*  只读 EMEDF 公开字段（name/bank/id/args），数据留在本机不进仓库。   */
/* ------------------------------------------------------------------ */

/** 参数列表展示文本：`resultConditionGroup:s8, targetConditionGroup:s8`。 */
function renderArgSummary(item: EmedfCompletionItem): string {
  if (item.args.length === 0) return '（无参数）';
  return item.args
    .map((arg) => `${arg.name}:${arg.type}${arg.vararg ? '…' : ''}`)
    .join('，');
}

export interface EditorExtensionOptions {
  onDocChange: (text: string, state: EditorState) => void;
  readOnly: boolean;
  sourceStyle: EventSourceTabData['sourceStyle'];
  getCatalog: () => EmedfCompletionItem[];
  getEnums: () => Record<string, EmedfEnumDef>;
  getKnownEventIds: () => Array<{ eventId: number; title?: string }>;
  onSave?: () => void;
  onCursorPos?: (pos: number, lineText: string) => void;
  onViewportNearEnd?: (view: EditorView) => void;
  onFindRequest?: (view: EditorView) => void;
  onDiagnosticsUpdate?: (diags: EventDiagnostic[]) => void;
  onJumpToEvent: (eventId: number) => void;
}

export function buildEditorExtensions(
  onDocChange: (text: string, state: EditorState) => void,
  readOnly: boolean,
  sourceStyle: EventSourceTabData['sourceStyle'],
  getCatalog: () => EmedfCompletionItem[],
  onSave?: () => void,
  onCursor?: (lineText: string) => void,
  onViewportNearEnd?: (view: EditorView) => void,
  onFindRequest?: (view: EditorView) => void,
  getEnums?: () => Record<string, EmedfEnumDef>,
  getKnownEventIds?: () => Array<{ eventId: number; title?: string }>,
  onDiagnosticsUpdate?: (diags: EventDiagnostic[]) => void,
  onJumpToEvent?: (eventId: number) => void,
  onCursorPos?: (pos: number) => void
): Extension[] {
  const sourceLanguage = sourceStyle === 'dark-script'
    ? darkScriptStreamLanguage
    : emevdDslStreamLanguage;

  const enumsGetter = getEnums ?? (() => ({}));
  const eventIdsGetter = getKnownEventIds ?? (() => []);
  const jumpHandler = onJumpToEvent ?? (() => {});

  const extensions: Extension[] = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    foldGutter(),
    eventBlockFolding,
    bracketMatching(),
    indentOnInput(),
    drawSelection(),
    dropCursor(),
    history(),
    closeBrackets(),
    search({ top: true }),
    syntaxHighlighting(darkScriptStyle),
    sourceLanguage,
    eventDiagGutter,
    EditorState.readOnly.of(readOnly),
    // IDE Language Service Extensions:
    signatureHelpExtension(getCatalog, enumsGetter),
    emevdCompletionExtension(getCatalog, enumsGetter, eventIdsGetter),
    emevdDiagnosticsExtension(getCatalog, enumsGetter, onDiagnosticsUpdate),
    emevdEditingCommandsExtension(),
    emevdNavigationExtension(getCatalog, enumsGetter, { onJumpToEvent: jumpHandler }),
    EditorView.updateListener.of((update) => {
      // S35：增量源续载/拉齐的追加带 sourceFillAnnotation，不是用户编辑 ——
      // 不置 dirty、不进 undo、不触发「脏标记 → 拉齐」递归。
      const isSourceFill = update.transactions.some(
        (transaction) => transaction.annotation(sourceFillAnnotation) === true
      );
      if (update.docChanged && !isSourceFill) onDocChange(update.state.doc.toString(), update.state);
      // S35：视口滚动（geometryChanged / viewportChanged）时探测「滚近已加载
      // 底部」→ 面板续拉下一片；scrollDOM 原生事件再兜一道（见挂载 effect）。
      if (onViewportNearEnd && (update.geometryChanged || update.viewportChanged)) {
        onViewportNearEnd(update.view);
      }
      if (!isSourceFill && (update.selectionSet || update.docChanged || update.focusChanged)) {
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);
        if (onCursor) onCursor(line.text);
        if (onCursorPos) onCursorPos(head);
      }
    }),
    keymap.of([
      ...(onSave
        ? [{
            key: 'Mod-s',
            run: () => {
              onSave();
              return true;
            }
          }]
        : []),
      // S35：Ctrl+F 先把未加载部分一次拉齐，再开 CodeMirror 查找面板 ——
      // 禁止为「查找要全文」在打开时同步拉全文。本条目在 searchKeymap 之前
      // 注册，同名键先注册者生效。
      ...(onFindRequest
        ? [{
            key: 'Mod-f',
            run: (view: EditorView) => {
              onFindRequest(view);
              return true;
            }
          }]
        : []),
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      indentWithTab
    ]),
    EditorView.theme({
      '&': { height: '100%', fontSize: '12px', backgroundColor: 'transparent' },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
      '.cm-content': { caretColor: 'var(--ember-text)', padding: '8px 0' },
      '.cm-gutters': { backgroundColor: 'var(--forge-1)', color: 'var(--ink-3)', border: 'none' },
      '.cm-activeLine': { backgroundColor: 'var(--forge-2)' },
      '.cm-activeLineGutter': { backgroundColor: 'var(--forge-2)', color: 'var(--ink-2)' },
      '.cm-event-diag__warn': { color: 'var(--warn)' },
      '.cm-emedf-hover': { font: '11px var(--font-mono)', padding: '4px 8px', color: 'var(--ink-1)' },
      '.cm-emedf-hover strong': { display: 'block', color: 'var(--ink-0)', marginBottom: '2px' },
      '.cm-emedf-hover__row': { whiteSpace: 'nowrap' }
    })
  ];
  return extensions;
}

function appendSavedText(saved: string, rest: string): string {
  if (rest.length === 0) return saved;
  const needsSeparator = saved.length > 0 && !saved.endsWith('\n');
  return `${needsSeparator ? `${saved}\n` : saved}${rest}`;
}

function revealLine(view: EditorView | null, lineNumber: number): void {
  if (!view) return;
  const safe = Math.max(1, Math.min(lineNumber, view.state.doc.lines));
  const line = view.state.doc.line(safe);
  view.dispatch({
    selection: { anchor: line.from },
    effects: EditorView.scrollIntoView(line.from, { y: 'center' })
  });
  view.focus();
}

/**
 * 词义列 / 指令与参数说明面板。
 * 共享 Language Service 统一语义模型（CursorContext & SignatureHelp），
 * 支持实参角色跳转与结构化 Enum 候选展示。
 */
export function EventMeaningPane(props: {
  inspection: LineInspection;
  signatureHelp?: EventSignatureHelp | null;
  jump: EventJump | null;
  resourceJump: ResourceJumpResult | null;
  onJumpEvent: (eventId: number) => void;
  onJumpResource: (request: ResourceJumpRequest) => void;
  documentTitle: string;
}): ReactElement {
  const { inspection, signatureHelp, jump, resourceJump, onJumpEvent, onJumpResource, documentTitle } = props;
  if (inspection.kind === 'empty' && !signatureHelp) {
    return <p className="muted esw-meaning__empty">把光标放在一条指令或 $Event 头上。</p>;
  }
  if (inspection.kind === 'event-header') {
    return (
      <div
        className="esw-meaning__block"
        data-cite={JSON.stringify({
          kind: 'event-line',
          document: documentTitle,
          eventId: inspection.eventId,
          line: 1
        })}
      >
        <strong>$Event({inspection.eventId})</strong>
        <p className="muted">事件块头。rest 是 Default / Restart。</p>
      </div>
    );
  }
  if (inspection.kind === 'undecoded') {
    return (
      <div className="esw-meaning__block">
        <strong>未解码</strong>
        <p className="muted">{inspection.text}</p>
      </div>
    );
  }
  if (inspection.kind === 'wait-for') {
    return (
      <div className="esw-meaning__block">
        <strong>WaitFor</strong>
        <p className="muted">条件折叠。下面是被折进去的谓词，不是单独一条可写指令。</p>
        {inspection.predicates.length === 0
          ? <p className="muted">谓词无法解析。</p>
          : (
            <ul className="esw-meaning__args">
              {inspection.predicates.map((predicate, index) => (
                <li key={`${predicate.name}-${index}`}>
                  <code>{predicate.name}</code>
                  <span className="muted"> {predicate.args.join(', ')}</span>
                </li>
              ))}
            </ul>
          )}
      </div>
    );
  }

  const instructionName = signatureHelp?.instructionName ?? (inspection.kind === 'instruction' ? inspection.name : '');
  const bankInfo = signatureHelp?.bank !== undefined
    ? `bank ${signatureHelp.bank}:${signatureHelp.id}`
    : (inspection.kind === 'instruction' && inspection.bank !== undefined ? `bank ${inspection.bank}:${inspection.id}` : 'EMEDF 指令');

  return (
    <div className="esw-meaning__block">
      <strong>{instructionName}</strong>
      <p className="muted">{bankInfo}</p>
      {signatureHelp?.docs && <p className="muted esw-meaning__doc">{signatureHelp.docs}</p>}

      {inspection.kind === 'instruction' && inspection.args.length > 0 && (
        <ul className="esw-meaning__args">
          {inspection.args.map((arg, idx) => {
            const isParamActive = signatureHelp && signatureHelp.activeParameterIndex === idx;
            const paramHelp = signatureHelp?.parameters[idx];
            const enumName = (isParamActive ? signatureHelp?.activeParameter?.enumName : undefined) ?? paramHelp?.enumName;
            const enumMembers = (isParamActive ? signatureHelp?.activeParameter?.enumMembers : undefined) ?? paramHelp?.enumMembers;
            return (
              <li key={arg.name} className={isParamActive ? 'esw-meaning__arg is-active' : 'esw-meaning__arg'}>
                <div>
                  <code>{arg.name}</code>
                  <span className="muted"> : {arg.type}</span>
                  {enumName && (
                    <span className="esw-meaning__enum-badge"> [{enumName}]</span>
                  )}
                </div>
                <div>{arg.value || '（空）'}</div>
                {paramHelp?.description && (
                  <div className="muted esw-meaning__arg-doc">{paramHelp.description}</div>
                )}
                {enumMembers && enumMembers.length > 0 && (
                  <div className="muted esw-meaning__enum-list">
                    可选值: {enumMembers.slice(0, 4).map((m) => `${m.name}(${m.value})`).join(', ')}
                    {enumMembers.length > 4 ? '…' : ''}
                  </div>
                )}
                {arg.role === 'event-id' && arg.eventId !== undefined && (
                  <button type="button" className="toolbar-button" onClick={() => onJumpEvent(arg.eventId!)}>
                    转到 $Event({arg.eventId})
                  </button>
                )}
                {isFmgRole(arg.role) && arg.resourceId !== undefined && (
                  <button
                    type="button"
                    className="toolbar-button"
                    onClick={() => onJumpResource({ kind: 'fmg', semantic: fmgSemanticOf(arg.role), id: arg.resourceId! })}
                  >
                    转到文本条目 {arg.resourceId}
                  </button>
                )}
                {arg.role === 'param-id' && arg.resourceId !== undefined && (
                  <button
                    type="button"
                    className="toolbar-button"
                    onClick={() => onJumpResource({ kind: 'param', id: arg.resourceId! })}
                  >
                    转到 PARAM 行 {arg.resourceId}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {jump && jump.kind === 'hit' && (
        <p className="muted">目标在 {jump.title} 第 {jump.line} 行。</p>
      )}
      {jump && jump.kind === 'insufficient_evidence' && (
        <p className="muted">{jump.message}</p>
      )}
      {resourceJump && resourceJump.kind === 'hit' && (
        <p className="muted">目标在 {resourceJump.title}（{resourceJump.detail ?? '已定位'}）。</p>
      )}
      {resourceJump && resourceJump.kind === 'insufficient_evidence' && (
        <p className="muted">{resourceJump.message}</p>
      )}
    </div>
  );
}

export function EventSourceWorkbenchPanel(props: EventSourceWorkbenchPanelProps): ReactElement {
  const [tabs, setTabs] = useState<InternalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState('就绪');
  const [completionItems, setCompletionItems] = useState<EmedfCompletionItem[]>([]);
  const [enums, setEnums] = useState<Record<string, EmedfEnumDef>>({});
  const [splitTabId, setSplitTabId] = useState<string | null>(null);
  const [inspection, setInspection] = useState<LineInspection>({ kind: 'empty' });
  const [signatureHelp, setSignatureHelp] = useState<EventSignatureHelp | null>(null);
  const [cursorPos, setCursorPos] = useState<number>(0);
  const [jump, setJump] = useState<EventJump | null>(null);
  const [resourceJump, setResourceJump] = useState<ResourceJumpResult | null>(null);
  const [inspectPane, setInspectPane] = useState<'a' | 'b'>('a');

  // IDE Modals：主工作台保持源码单主区；符号导航仅由快捷键唤起弹窗。
  const [showSymbolModal, setShowSymbolModal] = useState(false);

  const editorHostRef = useRef<HTMLDivElement>(null);
  const splitHostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const viewBRef = useRef<EditorView | null>(null);
  const pendingRevealRef = useRef<{ pane: 'a' | 'b'; line: number } | null>(null);
  /** T4-3：EMEDF 指令名目录与枚举映射，经 ref 供 CM extensions 闭包读最新值。 */
  const completionItemsRef = useRef<EmedfCompletionItem[]>([]);
  completionItemsRef.current = completionItems;
  const enumsRef = useRef<Record<string, EmedfEnumDef>>({});
  enumsRef.current = enums;

  /** 每 tab 的 event 块行映射，gutter 经该 ref 读取（CM 闭包拿不到 React state）。 */
  const eventLineInfoRef = useRef<Map<number, EventLineInfo>>(new Map());
  /** 始终指向最新 commitDraft，供各 tab 的 CM extensions 闭包安全调用。 */
  const commitDraftRef = useRef<(tabId: string, text: string, state: EditorState) => void>(() => {});
  const submitSourceRef = useRef<() => Promise<void>>(async () => {});
  /** S35：最新 tabs / activeTabId，供异步拉片落地时判断「该 tab 是否仍在前台」。 */
  const tabsRef = useRef<InternalTab[]>([]);
  const activeTabIdRef = useRef<string | null>(null);
  /** S35：每 tab 的增量源推进状态（操作权威，ref 供回调闭包读最新值）。 */
  const incrementalSourcesRef = useRef<Map<string, IncrementalSourceState>>(new Map());
  /** S35：单片续载在飞 Promise：同一 tab 同时只拉一片，避免重复取同一行区间。 */
  const slicePromisesRef = useRef<Map<string, Promise<void>>>(new Map());
  /** S35：拉齐在飞 Promise：提交 / 查找并发时共享同一次拉齐。 */
  const fillPromisesRef = useRef<Map<string, Promise<void>>>(new Map());
  const maybeFillMoreRef = useRef<(view: EditorView) => void>(() => {});
  const ensureTabCompleteRef = useRef<(tabId: string) => Promise<void>>(async () => {});
  /** 用户滚动过的 tab 才允许触发近底续载；挂载/切 tab 的几何事件不算显式需求。 */
  const userScrolledTabsRef = useRef<Set<string>>(new Set());
  /** 非活动 tab 完成 source fill 时，待其切回主视口后补发一次 completion diagnostics。 */
  const pendingSourceCompletionDiagnosticsRef = useRef<Set<string>>(new Set());
  /** 源填充只更新展示，不触发每片一次的全量 symbol/diagnostic 分析。 */
  const [analysisRevision, setAnalysisRevision] = useState(0);

  const activeTab = tabs.find((tab) => tab.tabId === activeTabId) ?? null;
  const splitTab = splitTabId ? tabs.find((tab) => tab.tabId === splitTabId) ?? null : null;
  tabsRef.current = tabs;
  activeTabIdRef.current = activeTabId;

  const eventIndexes = useMemo(
    () => tabs.map((tab) => ({
      tabId: tab.tabId,
      title: tab.title,
      headers: indexEventHeaders(tab.draft)
    })),
    [analysisRevision]
  );

  const documentSymbols = useMemo(() => {
    if (!activeTab) return [];
    return indexDocumentSymbols(activeTab.draft).symbols;
  }, [activeTabId, analysisRevision, showSymbolModal]);

  /** T4-3：从主进程拉取本机 EMEDF 指令名目录与结构化枚举。 */
  useEffect(() => {
    const bridge = getRendererBridge();
    if (!bridge) return;
    let cancelled = false;
    bridge
      .readEmedfCompletionCatalog()
      .then((result) => {
        if (!cancelled && result.ok) {
          setCompletionItems(result.items);
          if (result.enums) {
            setEnums(result.enums);
          }
        }
      })
      .catch(() => {
        // 目录拉取失败只影响补全/悬停，不阻断源码展示。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** 全局 Ctrl+Shift+O 唤起 Go to Symbol 弹窗。 */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'O' || e.key === 'o')) {
        e.preventDefault();
        setShowSymbolModal((v) => !v);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  /** S35：经 bridge 拉源文件切片；bridge 缺失时按失败关闭（不重试空转）。 */
  const readSliceFromBridge = useCallback(
    async (token: string, fromLine: number, lineCount: number) => {
      const bridge = getRendererBridge();
      if (!bridge || typeof bridge.readEmevdSourceSlice !== 'function') return { ok: false };
      return bridge.readEmevdSourceSlice(token, fromLine, lineCount);
    },
    []
  );

  /** S35：续载/拉齐落地 —— 把最新 EditorState 与行数同步回 tab（不置 dirty）。 */
  const commitSourceFill = useCallback((
    tabId: string,
    state: EditorState,
    loadedLines: number,
    complete: boolean,
    restText?: string | null
  ) => {
    setTabs((previous) =>
      previous.map((tab) => {
        if (tab.tabId !== tabId) return tab;
        const nextDraft = state.doc.toString();
        const nextSaved = tab.dirty
          ? (restText && restText.length > 0 ? appendSavedText(tab.lastSavedText, restText) : tab.lastSavedText)
          : nextDraft;
        return {
          ...tab,
          draft: nextDraft,
          lastSavedText: nextSaved,
          editorState: state,
          sourceLoadedLines: loadedLines,
          sourceComplete: complete
        };
      })
    );
    if (complete) setAnalysisRevision((revision) => revision + 1);
  }, []);

  /**
   * S35：把「文件后半」文本追加进指定 tab 的缓冲。
   * `complete=true` 时附加 completion annotation；普通续片不能带该标记。
   */
  const applyRestText = useCallback((tabId: string, restText: string | null, complete: boolean) => {
    const fillAnnotations = [
      sourceFillAnnotation.of(true),
      ...(complete ? [sourceFillCompletionAnnotation.of(true)] : []),
      Transaction.addToHistory.of(false)
    ];
    if (!restText || restText.length === 0) {
      if (complete) {
        const view = viewRef.current;
        const tab = tabsRef.current.find((item) => item.tabId === tabId);
        if (!tab) return;
        // 空的最终片也必须发一个 completion-only transaction，否则 diagnostics 不会知道
        // source 已经从 partial 变成 complete。
        if (view && activeTabIdRef.current === tabId) {
          view.dispatch({ annotations: fillAnnotations });
          commitSourceFill(tabId, view.state, view.state.doc.lines, true);
        } else {
          pendingSourceCompletionDiagnosticsRef.current.add(tabId);
          const nextState = tab.editorState.update({ annotations: fillAnnotations }).state;
          commitSourceFill(tabId, nextState, nextState.doc.lines, true);
        }
      }
      return;
    }
    const view = viewRef.current;
    if (view && activeTabIdRef.current === tabId) {
      view.dispatch({
        ...appendSourceTail(view.state, restText),
        annotations: fillAnnotations
      });
      commitSourceFill(tabId, view.state, view.state.doc.lines, complete, restText);
      return;
    }
    const tab = tabsRef.current.find((item) => item.tabId === tabId);
    if (!tab) return;
    const nextState = tab.editorState.update({
      ...appendSourceTail(tab.editorState, restText),
      annotations: fillAnnotations
    }).state;
    if (complete) pendingSourceCompletionDiagnosticsRef.current.add(tabId);
    commitSourceFill(tabId, nextState, nextState.doc.lines, complete, restText);
  }, [commitSourceFill]);

  /** S35：拉一片并追加。 */
  const fillOneSlice = useCallback(async (tabId: string) => {
    const current = incrementalSourcesRef.current.get(tabId);
    if (!current || isIncrementalSourceComplete(current)) return;
    const step = await fetchNextSourceSlice(current, readSliceFromBridge);
    const live = incrementalSourcesRef.current.get(tabId);
    if (!live || live.token !== step.state.token) return;
    incrementalSourcesRef.current.set(tabId, step.state);
    if (step.cancelled || step.state.failed) {
      if (step.state.failed && !step.cancelled) {
        setStatus('增量源码续载失败（令牌已失效或 Bridge 不可用），只展示已加载部分。');
      }
      return;
    }
    applyRestText(tabId, step.sliceText, step.state.eof);
  }, [applyRestText, readSliceFromBridge]);

  /** S35：单片续载的飞行通道登记。 */
  const fillOneSliceGuarded = useCallback((tabId: string): Promise<void> => {
    const existing = slicePromisesRef.current.get(tabId);
    if (existing) return existing;
    const promise = fillOneSlice(tabId).finally(() => {
      if (slicePromisesRef.current.get(tabId) === promise) slicePromisesRef.current.delete(tabId);
    });
    slicePromisesRef.current.set(tabId, promise);
    return promise;
  }, [fillOneSlice]);

  /** S35：一次拉齐。 */
  const ensureTabComplete = useCallback(async (tabId: string): Promise<void> => {
    const inFlight = fillPromisesRef.current.get(tabId);
    if (inFlight) return inFlight;
    const promise = (async () => {
      const pendingSlice = slicePromisesRef.current.get(tabId);
      if (pendingSlice) await pendingSlice;
      const current = incrementalSourcesRef.current.get(tabId);
      if (!current || isIncrementalSourceComplete(current)) return;
      const all = await fetchAllRemainingSource(current, readSliceFromBridge);
      const live = incrementalSourcesRef.current.get(tabId);
      if (!live || live.token !== all.state.token) return;
      incrementalSourcesRef.current.set(tabId, all.state);
      if (all.cancelled || all.state.failed) {
        if (all.state.failed && !all.cancelled) {
          setStatus('增量源码拉齐失败（令牌已失效或 Bridge 不可用），只展示已加载部分。');
        }
        return;
      }
      applyRestText(tabId, all.restText, all.state.eof);
    })();
    fillPromisesRef.current.set(tabId, promise);
    void promise.finally(() => {
      if (fillPromisesRef.current.get(tabId) === promise) fillPromisesRef.current.delete(tabId);
    });
    return promise;
  }, [applyRestText, readSliceFromBridge]);
  ensureTabCompleteRef.current = ensureTabComplete;

  /** S35：视口近底探测。 */
  const maybeFillMore = useCallback((view: EditorView) => {
    const tabId = activeTabIdRef.current;
    if (!tabId) return;
    if (!userScrolledTabsRef.current.has(tabId)) return;
    const state = incrementalSourcesRef.current.get(tabId);
    if (!state || isIncrementalSourceComplete(state)) return;
    if (
      fillPromisesRef.current.has(tabId)
      || slicePromisesRef.current.has(tabId)
    ) return;
    if (!isNearLoadedBottom(view)) return;
    void fillOneSliceGuarded(tabId);
  }, [fillOneSliceGuarded]);
  maybeFillMoreRef.current = maybeFillMore;

  const commitDraft = useCallback((tabId: string, text: string, state: EditorState) => {
    setTabs((previous) =>
      previous.map((tab) =>
        tab.tabId === tabId
          ? {
              ...tab,
              dirty: text !== tab.lastSavedText,
              draft: text,
              editorState: state
            }
          : tab
      )
    );
    // 用户编辑只置 dirty；完整源码是 Ctrl+F / 保存的显式需求，不在每次输入时拉齐。
    setAnalysisRevision((revision) => revision + 1);
  }, []);
  commitDraftRef.current = commitDraft;

  /** 每个 tab 的 extensions 绑定自己的 tabId；运行时经 ref 调最新 commitDraft。 */
  const createExtensionsFor = useCallback((
    tabId: string,
    readOnly: boolean,
    sourceStyle: EventSourceTabData['sourceStyle'],
    pane: 'a' | 'b' = 'a'
  ): Extension[] => {
    const isSatellite = tabId.endsWith(':sat');
    return buildEditorExtensions(
      (text, state) => {
        if (!isSatellite) commitDraftRef.current(tabId, text, state);
      },
      readOnly,
      sourceStyle,
      () => completionItemsRef.current,
      isSatellite ? undefined : () => { void submitSourceRef.current(); },
      (lineText) => {
        setInspectPane(pane);
      },
      // S35：主视口才驱动按视口续载；只读对照视口不拉片。
      isSatellite ? undefined : (view) => maybeFillMoreRef.current(view),
      // S35：Ctrl+F 先把未加载部分一次拉齐，再开查找面板。
      isSatellite ? undefined : (view) => {
        const targetTabId = activeTabIdRef.current;
        if (!targetTabId) return;
        void ensureTabCompleteRef.current(targetTabId).then(() => {
          if (viewRef.current === view && activeTabIdRef.current === targetTabId) {
            openSearchPanel(view);
          }
        });
      },
      () => enumsRef.current,
      () => tabsRef.current.flatMap((t) => Array.from(indexEventHeaders(t.draft).keys()).map((id) => ({ eventId: id, title: t.title }))),
      undefined,
      (eventId) => jumpToEvent(eventId),
      (pos) => {
        setCursorPos(pos);
        if (activeTabIdRef.current) {
          const tab = tabsRef.current.find((t) => t.tabId === activeTabIdRef.current);
          const docText = tab ? tab.draft : '';
          const ctx = analyzeCursorContext(docText, pos);
          const sig = getSignatureHelp(ctx, completionItemsRef.current, enumsRef.current);
          setSignatureHelp(sig);
          setInspection(inspectAtCursor(docText, pos, completionItemsRef.current, enumsRef.current));
          setJump(null);
          setResourceJump(null);
        }
      }
    );
  }, []);

  /** 把 App 给的 pending tab 并入 tabs。 */
  useEffect(() => {
    const pending = props.pendingTab;
    if (!pending) return;
    const base = baselineText(pending);
    const readOnly = isSourceReadOnly(pending);
    const incremental = createIncrementalSourceState({
      sourcePrefix: pending.sourcePrefix,
      sourceToken: pending.sourceToken,
      sourceTotalLines: pending.sourceTotalLines ?? pending.dslTemplateTotalLines
    });
    const createIncomingState = () => createCompleteSourceState(
      base,
      createExtensionsFor(pending.tabId, readOnly, pending.sourceStyle)
    );
    const existingLive = tabsRef.current.find((tab) => tab.tabId === pending.tabId);
    const tokenChanged = existingLive !== undefined
      && existingLive.sourceToken !== (pending.sourceToken ?? null);
    const keepFilled = Boolean(
      existingLive
      && !existingLive.dirty
      && existingLive.sourceHash === pending.sourceHash
      && existingLive.sourceLoadedLines > (incremental?.nextFromLine ?? 0)
    );
    if (!keepFilled) {
      if (incremental && !(existingLive && tokenChanged && existingLive.dirty)) {
        incrementalSourcesRef.current.set(pending.tabId, incremental);
      } else {
        incrementalSourcesRef.current.delete(pending.tabId);
      }
    }
    setTabs((previous) => {
      const index = previous.findIndex((tab) => tab.tabId === pending.tabId);
      const existing = index >= 0 ? previous[index] : undefined;
      if (existing) {
        const sourceChanged = existing.draft !== base;
        const retainFilled = Boolean(
          !existing.dirty
          && existing.sourceHash === pending.sourceHash
          && existing.sourceLoadedLines > (incremental?.nextFromLine ?? 0)
        );
        const merged: InternalTab = {
          ...existing,
          document: pending.document,
          eventWarnings: pending.eventWarnings,
          sourceHash: pending.sourceHash,
          live: pending.live,
          dslTemplate: pending.dslTemplate,
          dslTemplateTruncated: pending.dslTemplateTruncated,
          dslTemplateTotalLines: pending.dslTemplateTotalLines,
          sourceStyle: pending.sourceStyle,
          sourceToken: pending.sourceToken ?? null,
          sourcePrefix: pending.sourcePrefix ?? null,
          sourceTotalLines: pending.sourceTotalLines ?? pending.dslTemplateTotalLines ?? 0,
          ...(sourceChanged && !existing.dirty && !retainFilled
            ? {
                draft: base,
                lastSavedText: base,
                editorState: createIncomingState(),
                sourceLoadedLines: incremental?.nextFromLine ?? 0,
                sourceComplete: incremental ? incremental.eof : true
              }
            : {})
        };
        return previous.map((tab, i) => (i === index ? merged : tab));
      }
      const created: InternalTab = {
        ...pending,
        dirty: false,
        draft: base,
        lastSavedText: base,
        sourceLoadedLines: incremental?.nextFromLine ?? 0,
        sourceTotalLines: incremental?.totalLines ?? pending.dslTemplateTotalLines ?? 0,
        sourceComplete: incremental ? incremental.eof : true,
        editorState: createIncomingState()
      };
      return [...previous, created];
    });
    setActiveTabId(pending.tabId);
    setAnalysisRevision((revision) => revision + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.pendingTab, createExtensionsFor]);

  const applyEventLineInfo = useCallback((map: Map<number, EventLineInfo>) => {
    eventLineInfoRef.current = map;
    const view = viewRef.current;
    if (view) {
      (view as unknown as { _eventLineInfo: Map<number, EventLineInfo> })._eventLineInfo =
        eventLineInfoRef.current;
      view.requestMeasure();
    }
  }, []);

  const syncGutterInfo = useCallback((text: string, rows: readonly EventWarningRow[]) => {
    applyEventLineInfo(indexEventLines(text, rows));
  }, [applyEventLineInfo]);

  useEffect(() => {
    if (!activeTab) return;
    syncGutterInfo(activeTab.draft, eventWarningRowsOf(activeTab));
  }, [activeTabId, activeTab?.draft, activeTab?.eventWarnings, syncGutterInfo]);

  /** 挂载 EditorView（一次）；后续经 setState 换 tab state。 */
  useEffect(() => {
    if (!editorHostRef.current) return;
    const host = editorHostRef.current;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: '', extensions: [] })
    });
    (view as unknown as { _eventLineInfo: Map<number, EventLineInfo> })._eventLineInfo =
      eventLineInfoRef.current;
    viewRef.current = view;
    const onScrollerScroll = (): void => {
      const tabId = activeTabIdRef.current;
      if (tabId) userScrolledTabsRef.current.add(tabId);
      maybeFillMoreRef.current(view);
    };
    view.scrollDOM.addEventListener('scroll', onScrollerScroll, { passive: true });
    return () => {
      view.scrollDOM.removeEventListener('scroll', onScrollerScroll);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 激活 tab 切换：换入该 tab 缓存的 per-tab CM state。 */
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !activeTab) return;
    if (view.state === activeTab.editorState) return;
    view.setState(activeTab.editorState);
    (view as unknown as { _eventLineInfo: Map<number, EventLineInfo> })._eventLineInfo =
      eventLineInfoRef.current;
    if (pendingSourceCompletionDiagnosticsRef.current.delete(activeTab.tabId)) {
      view.dispatch({
        annotations: [
          sourceFillAnnotation.of(true),
          sourceFillCompletionAnnotation.of(true),
          Transaction.addToHistory.of(false)
        ]
      });
    }
    const pending = pendingRevealRef.current;
    if (pending?.pane === 'a') {
      pendingRevealRef.current = null;
      revealLine(view, pending.line);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);

  useEffect(() => {
    if (!splitTabId || !splitHostRef.current) return;
    const host = splitHostRef.current;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: '', extensions: [] })
    });
    viewBRef.current = view;
    return () => {
      view.destroy();
      viewBRef.current = null;
    };
  }, [splitTabId !== null]);

  useEffect(() => {
    const view = viewBRef.current;
    if (!view || !splitTab) return;
    if (splitTab.tabId === activeTabId) {
      view.setState(createCompleteSourceState(
        splitTab.draft,
        createExtensionsFor(`${splitTab.tabId}:sat`, true, splitTab.sourceStyle, 'b')
      ));
    } else {
      view.setState(splitTab.editorState);
    }
    const pending = pendingRevealRef.current;
    if (pending?.pane === 'b') {
      pendingRevealRef.current = null;
      revealLine(view, pending.line);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splitTabId, activeTabId, createExtensionsFor]);

  useEffect(() => {
    const view = viewBRef.current;
    if (!view || !splitTab || splitTab.tabId !== activeTabId) return;
    if (view.state.doc.toString() === splitTab.draft) return;
    const top = view.scrollDOM.scrollTop;
    view.setState(createCompleteSourceState(
      splitTab.draft,
      createExtensionsFor(`${splitTab.tabId}:sat`, true, splitTab.sourceStyle, 'b')
    ));
    view.scrollDOM.scrollTop = top;
  }, [splitTab?.draft, splitTabId, activeTabId, createExtensionsFor]);

  useEffect(() => {
    const pending = props.pendingTab;
    if (!pending || !activeTabId || pending.tabId !== activeTabId) return;
    const view = viewRef.current;
    if (!view) return;
    const current = tabs.find((tab) => tab.tabId === activeTabId);
    if (!current || current.dirty) return;
    const next = baselineText(pending);
    if (next === current.draft) return;
    if (
      current.sourceHash === pending.sourceHash
      && current.sourceLoadedLines > 0
      && current.draft.length > next.length
    ) return;
    const nextState = createCompleteSourceState(
      next,
      createExtensionsFor(activeTabId, isSourceReadOnly(pending), pending.sourceStyle)
    );
    setTabs((previous) =>
      previous.map((tab) =>
        tab.tabId === activeTabId
          ? {
              ...tab,
              document: pending.document,
              eventWarnings: pending.eventWarnings,
              sourceHash: pending.sourceHash,
              dslTemplate: pending.dslTemplate,
              draft: next,
              lastSavedText: next,
              dirty: false,
              editorState: nextState
            }
          : tab
      )
    );
    view.setState(nextState);
    syncGutterInfo(next, eventWarningRowsOf(pending));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.pendingTab, activeTabId]);

  useEffect(() => {
    if (props.active === false) return;
    const view = viewRef.current;
    if (view) view.requestMeasure();
  }, [props.active, activeTabId]);

  function activateTab(tabId: string): void {
    setActiveTabId(tabId);
  }

  function closeTab(tabId: string): void {
    incrementalSourcesRef.current.delete(tabId);
    fillPromisesRef.current.delete(tabId);
    slicePromisesRef.current.delete(tabId);
    userScrolledTabsRef.current.delete(tabId);
    pendingSourceCompletionDiagnosticsRef.current.delete(tabId);
    setAnalysisRevision((revision) => revision + 1);
    setTabs((previous) => {
      const index = previous.findIndex((tab) => tab.tabId === tabId);
      const next = previous.filter((tab) => tab.tabId !== tabId);
      if (activeTabId === tabId) {
        const neighbor = next[Math.max(0, index - 1)] ?? next[0] ?? null;
        setActiveTabId(neighbor?.tabId ?? null);
      }
      return next;
    });
    if (splitTabId === tabId) setSplitTabId(null);
  }

  function jumpToEvent(eventId: number): void {
    const result = resolveEventJump(
      eventId,
      eventIndexes,
      inspectPane === 'b' ? (splitTabId ?? undefined) : (activeTabId ?? undefined)
    );
    setJump(result);
    if (result.kind !== 'hit') return;
    if (result.tabId === activeTabId) {
      revealLine(viewRef.current, result.line);
      return;
    }
    if (result.tabId === splitTabId) {
      revealLine(viewBRef.current, result.line);
      return;
    }
    pendingRevealRef.current = { pane: 'b', line: result.line };
    setSplitTabId(result.tabId);
  }

  function jumpToResource(request: ResourceJumpRequest): void {
    const pending = props.onJumpResource?.(request);
    if (!pending) {
      setResourceJump(insufficientEvidence('跳转通道不可用：事件面板没有接线到已打开的资源。'));
      return;
    }
    pending
      .then(setResourceJump)
      .catch(() => setResourceJump(insufficientEvidence('跳转失败：目标资源解析异常。')));
  }

  async function submitSource(): Promise<void> {
    if (!activeTab || !props.onDslSubmit || submitting || isSourceReadOnly(activeTab)) return;
    setSubmitting(true);
    setStatus('正在应用…');
    try {
      await ensureTabCompleteRef.current(activeTab.tabId);
      const incremental = incrementalSourcesRef.current.get(activeTab.tabId);
      if (incremental && !incremental.eof) {
        setStatus('增量源码未拉齐（令牌已失效或 Bridge 不可用），已取消提交；重新打开该文件后再试。');
        return;
      }
      const current = tabsRef.current.find((tab) => tab.tabId === activeTab.tabId);
      const sourceText = current ? current.editorState.doc.toString() : activeTab.draft;
      const result = await props.onDslSubmit(activeTab, sourceText);
      if (result.ok) {
        const nextText = result.nextDslTemplate ?? sourceText;
        const nextState = createCompleteSourceState(
          nextText,
          createExtensionsFor(activeTab.tabId, isSourceReadOnly(activeTab), activeTab.sourceStyle)
        );
        incrementalSourcesRef.current.delete(activeTab.tabId);
        setTabs((previous) =>
          previous.map((tab) =>
            tab.tabId === activeTab.tabId
              ? {
                  ...tab,
                  dirty: false,
                  draft: nextText,
                  lastSavedText: nextText,
                  dslTemplate: nextText,
                  dslTemplateTruncated: false,
                  dslTemplateTotalLines: nextText.split('\n').length,
                  sourceToken: null,
                  sourcePrefix: null,
                  sourceTotalLines: 0,
                  sourceLoadedLines: nextText.split('\n').length,
                  sourceComplete: true,
                  editorState: nextState
                }
              : tab
          )
        );
        viewRef.current?.setState(nextState);
        syncGutterInfo(nextText, eventWarningRowsOf(activeTab));
        setStatus('已保存。');
      } else {
        setStatus(result.diagnostics[0]?.message ?? '应用失败。');
      }
    } catch (error) {
      setStatus(`应用异常：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSubmitting(false);
    }
  }
  submitSourceRef.current = submitSource;

  function revertSource(): void {
    const tab = activeTab;
    if (!tab || !tab.dirty || submitting || isSourceReadOnly(tab)) return;
    const nextState = createCompleteSourceState(
      tab.lastSavedText,
      createExtensionsFor(tab.tabId, isSourceReadOnly(tab), tab.sourceStyle)
    );
    setTabs((previous) =>
      previous.map((item) =>
        item.tabId === tab.tabId
          ? {
              ...item,
              dirty: false,
              draft: tab.lastSavedText,
              editorState: nextState
            }
          : item
      )
    );
    viewRef.current?.setState(nextState);
    syncGutterInfo(tab.lastSavedText, eventWarningRowsOf(tab));
    setStatus('已撤回未保存的修改');
  }

  const readOnly = activeTab ? isSourceReadOnly(activeTab) : true;

  const incrementalInfo = (activeTab && activeTab.sourceComplete === false && activeTab.sourceLoadedLines > 0)
    ? ` · 已加载 ${activeTab.sourceLoadedLines.toLocaleString()} / ${activeTab.sourceTotalLines.toLocaleString()} 行，后台拉取剩余`
    : '';
  const visibleStatus = props.opening
    ? '正在读取 EMEVD（Bridge → worker 反汇编 → 首帧前缀，全文按视口续载）…'
    : `${status}${incrementalInfo}`;

  // Current active event symbol at cursor position
  const activeSymbolAtCursor = useMemo(() => {
    return documentSymbols.find((s) => s.from <= cursorPos && cursorPos <= s.to) ?? null;
  }, [documentSymbols, cursorPos]);

  return (
    <section className="event-source-workbench" aria-label="Event 源码工作台">

      <div className="esw-tabs" role="tablist" aria-label="事件文档标签">
        {tabs.map((tab) => (
          <button
            key={tab.tabId}
            type="button"
            role="tab"
            aria-selected={tab.tabId === activeTabId}
            className={tab.tabId === activeTabId ? 'esw-tab is-active' : 'esw-tab'}
            onClick={() => activateTab(tab.tabId)}
          >
            <span className="esw-tab__title">
              {tab.dirty && <span className="esw-tab__dirty" aria-label="未保存" />}
              {tab.title}
            </span>
            <span
              className="esw-tab__close"
              role="button"
              tabIndex={-1}
              aria-label={`关闭 ${tab.title}`}
              onClick={(event) => { event.stopPropagation(); closeTab(tab.tabId); }}
            >
              ×
            </span>
          </button>
        ))}
        {tabs.length === 0 && (
          <span className="muted esw-tabs__empty">
            {props.opening ? '正在打开事件文档…' : '暂无打开的事件文档。'}
          </span>
        )}
      </div>

      <WorkbenchLayout
        label="Event 源码工作台主区"
        toolbar={(
          <div className="esw-toolbar__group">
            {!readOnly && (
              <>
                <button
                  type="button"
                  className="toolbar-button"
                  data-testid="esw-save"
                  disabled={submitting || !activeTab?.dirty}
                  title="保存（Ctrl+S）"
                  onClick={() => { void submitSource(); }}
                >
                  保存
                </button>
                <button
                  type="button"
                  className="toolbar-button"
                  data-testid="esw-revert"
                  disabled={submitting || !activeTab?.dirty}
                  title="撤回未保存的修改"
                  onClick={() => revertSource()}
                >
                  撤回
                </button>
                <button
                  type="button"
                  className="toolbar-button"
                  data-testid="esw-format"
                  disabled={submitting}
                  title="格式化文档（Alt+Shift+F）"
                  onClick={() => { if (viewRef.current) formatDocument(viewRef.current); }}
                >
                  格式化
                </button>
              </>
            )}

            <span className="muted" style={{ fontSize: 11 }} title="Ctrl+F 查找替换 · Ctrl+Shift+O 符号搜索 · Ctrl+Shift+Space 参数提示">
              快捷键: Ctrl+F 查找 · Ctrl+Shift+O 符号
            </span>

            {tabs.length > 0 && (
              <label className="esw-split-picker">
                并排
                <select
                  aria-label="并排对照"
                  value={splitTabId ?? ''}
                  onChange={(event) => {
                    const next = event.target.value;
                    setSplitTabId(next.length > 0 ? next : null);
                  }}
                >
                  <option value="">关</option>
                  {tabs.map((tab) => (
                    <option key={tab.tabId} value={tab.tabId}>
                      {tab.title}{tab.tabId === activeTabId ? '（本文件第二视口）' : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <span className="muted" style={{ fontSize: 11 }}>{visibleStatus}</span>
          </div>
        )}
        columns={[
          {
            id: 'source-a',
            title: activeTab?.title ?? '源码',
            hideHeader: true,
            minWidth: 240,
            initialFlex: 2,
            children: (
              <section className="esw-source" aria-label="事件源码">
                {/* Sticky Header & Breadcrumb */}
                {activeTab && (
                  <div className="esw-sticky-header" role="navigation" aria-label="事件面包屑">
                    <span className="esw-sticky-header__crumb esw-sticky-header__file">{activeTab.title}</span>
                    <span className="esw-sticky-header__sep">&gt;</span>
                    <button
                      type="button"
                      className="esw-sticky-header__crumb esw-sticky-header__event"
                      title="点击跳转到事件头"
                      onClick={() => {
                        if (activeSymbolAtCursor) revealLine(viewRef.current, activeSymbolAtCursor.line);
                      }}
                    >
                      {activeSymbolAtCursor ? `$Event(${activeSymbolAtCursor.eventId})` : '（事件全局）'}
                    </button>
                    {signatureHelp?.instructionName && (
                      <>
                        <span className="esw-sticky-header__sep">&gt;</span>
                        <span className="esw-sticky-header__crumb esw-sticky-header__instr">{signatureHelp.instructionName}</span>
                      </>
                    )}
                  </div>
                )}

                <div ref={editorHostRef} className="esw-source__host" data-editor-engine="codemirror" />

                {props.opening && !activeTab && (
                  <div className="esw-source__loading" role="status">
                    {props.openingPreview ? (
                      <pre className="esw-source__preview">{props.openingPreview}</pre>
                    ) : (
                      '正在读取并反汇编 EMEVD；就绪后先显示前缀，全文按视口续载。'
                    )}
                  </div>
                )}
                {activeTab?.live && activeTab.dslTemplate === null && !activeTab.sourceToken && (
                  <div className="event-source__notice event-source__notice--blocked" role="alert">
                    事件源码反汇编已失败关闭：未找到用户本机 EMEDF（DarkScript3 的
                    sekiro-common.emedf.json）。配置后重新打开即可看到 DarkScript3 式源码。
                  </div>
                )}

              </section>
            )
          },
          ...(splitTab
            ? [{
                id: 'source-b',
                title: splitTab.title,
                ...(splitTab.tabId === activeTabId ? { hint: '第二视口' } : {}),
                minWidth: 240,
                initialFlex: 2,
                children: (
                  <section className="esw-source" aria-label="对照源码">
                    <div className="esw-pane-bar">
                      <span className="muted">{splitTab.title}</span>
                      <button type="button" className="toolbar-button" onClick={() => setSplitTabId(null)}>
                        关闭分栏
                      </button>
                    </div>
                    <div ref={splitHostRef} className="esw-source__host" data-editor-engine="codemirror" />
                  </section>
                )
              }]
            : []),
          {
            id: 'meaning',
            title: '',
            ariaLabel: '指令说明',
            hideHeader: true,
            minWidth: 200,
            initialWidth: 280,
            children: (
              <div className="esw-meaning">
                <EventMeaningPane
                  inspection={inspection}
                  signatureHelp={signatureHelp}
                  jump={jump}
                  resourceJump={resourceJump}
                  onJumpEvent={jumpToEvent}
                  onJumpResource={jumpToResource}
                  documentTitle={activeTab?.title ?? 'event'}
                />
              </div>
            )
          }
        ]}
      />

      {/* Ctrl+Shift+O Go to Symbol Modal */}
      {showSymbolModal && (
        <div className="esw-modal-backdrop" onClick={() => setShowSymbolModal(false)}>
          <div className="esw-modal" onClick={(e) => e.stopPropagation()}>
            <EventOutlinePane
              symbols={documentSymbols}
              activeEventId={activeSymbolAtCursor?.eventId}
              isModal={true}
              onSelectEvent={(sym) => {
                revealLine(viewRef.current, sym.line);
                setShowSymbolModal(false);
              }}
              onClose={() => setShowSymbolModal(false)}
            />
          </div>
        </div>
      )}
    </section>
  );
}
