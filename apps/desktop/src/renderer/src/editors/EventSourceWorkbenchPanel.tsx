/**
 * EVENT-30B — DarkScript3 式 Event 源码工作台。
 *
 * 布局对照 DarkScript3（§11），不是 260/320 三栏：
 *   [文档标签栏] 逻辑文档标签（EMEVD 文档，§3.4），带 dirty 标记与关闭
 *   [工具条]     反汇编只读标签 / 编译并提交（旧 patch-dsl 路径）· Ctrl+F 走 CM search
 *   [主区]       CodeMirror 6 源码占满（T4：无四钮、无 Outline/Inspector/Problems）
 *
 * Negative DOM（EVENT-30B）：Flow / Hex / Raw Bytes 不在默认 viewport；原始
 * bytes 只能经 Developer Diagnostics 打开（本面板不提供）；查找替换 / Outline /
 * Inspector / Problems 四个开关与选中节点面板、底部 dock 均不渲染。
 *
 * 数据流：renderer 不持有文件系统路径与完整 document。App 经 `pendingTab`
 * （有界 DSL 投影 + 派生 document）按资源 URI 提供标签；提交以 `EventSourceTabData`
 * 上抛，由 App 走 Bridge → Patch 管线。dirty 与编辑文本（draft）只在工作台内部，
 * 跨 tab 隔离（per-tab EditorState 缓存 undo/redo 历史）。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement
} from 'react';
import type { EmevdEditorDocument } from '@soulforge/shared';
import type { EmedfCompletionItem } from '@soulforge/core';
import { getRendererBridge } from '../runtime/rendererRuntime.js';
import {
  appendSourceSlices,
  emptyEventLineScan,
  indexEventLinesIncremental,
  splitSourceForFirstFrame,
  type EventLineScanState
} from '../emevd/emevdSourceMount.js';
import { EditorState, type Extension } from '@codemirror/state';
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
  indentOnInput,
  syntaxHighlighting
} from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  type CompletionContext,
  type CompletionResult
} from '@codemirror/autocomplete';
import { search, searchKeymap } from '@codemirror/search';
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
   * - 'dark-script'：EMEDF 反汇编的 DarkScript3 式源码，只读展示；
   * - 'patch-dsl'：旧 hash DSL（历史路径）；
   * - 'none'：EMEDF 缺失失败关闭（不提供伪解码）。
   */
  sourceStyle?: 'dark-script' | 'patch-dsl' | 'none' | undefined;
}

export interface EventSourceWorkbenchPanelProps {
  /** App 最近一次打开/刷新的 EMEVD 文档；工作台按 tabId 去重后追加或更新标签。 */
  pendingTab: EventSourceTabData | null;
  onDslSubmit?: (
    tab: EventSourceTabData,
    sourceText: string
  ) => Promise<EventSourceSubmitResult>;
}

interface InternalTab extends EventSourceTabData {
  /** 用户已编辑未提交。 */
  dirty: boolean;
  /** 当前源码文本（含用户编辑）。 */
  draft: string;
  /** 该标签的 CodeMirror 状态（含 undo/redo 历史），切换标签时保留。 */
  editorState: EditorState;
  /** 增量灌入的目标全文。null 表示已齐或无需再灌。 */
  sourceFillTarget: string | null;
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

export function isSourceReadOnly(tab: Pick<EventSourceTabData, 'live' | 'dslTemplate' | 'sourceStyle'>): boolean {
  return !tab.live || tab.dslTemplate === null || tab.sourceStyle === 'dark-script';
}

export function baselineText(tab: EventSourceTabData): string {
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
  const lines = text.split('\n');
  let blockIndex = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const anchorMatch = /^event\s+@e:(\S+)/.exec(lines[i]!);
    if (!anchorMatch && !/^\$Event\(/.test(lines[i]!)) continue;
    const row = (anchorMatch ? byEventId.get(anchorMatch[1]!) : undefined) ?? rows[blockIndex];
    blockIndex += 1;
    if (!row) continue;
    if (row.warnings > 0) map.set(i + 1, { eventId: row.eventId, warnings: row.warnings });
  }
  return map;
}

/** DarkScript 风格高亮：注释灰、指令名强调、数字亮色、字符串绿、只读注释加深。 */
const darkScriptStyle = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--ink-3)', fontStyle: 'italic' },
  { tag: tags.lineComment, color: 'var(--ink-3)', fontStyle: 'italic' },
  { tag: tags.keyword, color: 'var(--ember-text)', fontWeight: '600' },
  { tag: tags.atom, color: 'var(--ember-text)' },
  { tag: tags.number, color: 'var(--ok)' },
  { tag: tags.string, color: 'var(--ok)' },
  { tag: tags.propertyName, color: 'var(--ink-0)' },
  { tag: tags.function(tags.variableName), color: 'var(--ink-0)', fontWeight: '600' },
  { tag: tags.variableName, color: 'var(--ink-1)' },
  { tag: tags.punctuation, color: 'var(--ink-3)' },
  { tag: tags.operator, color: 'var(--ember-text)' },
  { tag: tags.invalid, color: 'var(--danger-text)', fontWeight: '600' }
]);

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

/** 取 pos 处标识符（含精确边界），无则 null。 */
function wordAtPos(state: EditorState, pos: number): { from: number; to: number; text: string } | null {
  const line = state.doc.lineAt(pos);
  const relative = pos - line.from;
  if (relative < 0 || relative > line.length) return null;
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line.text)) !== null) {
    const from = match.index;
    const to = from + match[0].length;
    if (from <= relative && relative <= to) {
      return { from: line.from + from, to: line.from + to, text: match[0] };
    }
  }
  return null;
}

/**
 * 指令名补全：只在大写开头的 PascalCase 词上触发（避免干扰参数名/数字/关键字）。
 * Ctrl+Space 显式触发时忽略前缀过滤。同名指令（不同 bank:id）全部列出。
 */
function createCompletionSource(
  getCatalog: () => EmedfCompletionItem[]
): (context: CompletionContext) => CompletionResult | null {
  return (context) => {
    const word = context.matchBefore(/^[A-Za-z_][A-Za-z0-9_]*$/);
    if (!word) return null;
    if (!context.explicit && !/^[A-Z]/.test(word.text)) return null;
    const items = getCatalog();
    if (items.length === 0) return null;
    const prefix = word.text.toLowerCase();
    const matches = items.filter((item) => item.name.toLowerCase().startsWith(prefix));
    if (matches.length === 0 && !context.explicit) return null;
    return {
      from: word.from,
      options: matches.map((item) => ({
        label: item.name,
        detail: `bank ${item.bank}:${item.id}`,
        info: `参数：${renderArgSummary(item)}`,
        type: 'function',
        boost: item.name === word.text ? 10 : 0,
        apply: item.name
      }))
    };
  };
}

/** 悬停在指令名上显示参数名列表。只读展示也有效。 */
function createHoverTooltipSource(
  getCatalog: () => EmedfCompletionItem[]
): (view: EditorView, pos: number, side: -1 | 1) => Tooltip | null {
  return (view, pos) => {
    const word = wordAtPos(view.state, pos);
    if (!word || word.text.length < 2) return null;
    const matches = getCatalog().filter((item) => item.name === word.text);
    if (matches.length === 0) return null;
    const element = document.createElement('div');
    element.className = 'cm-emedf-hover';
    const title = document.createElement('strong');
    title.textContent = word.text;
    element.appendChild(title);
    for (const item of matches) {
      const row = document.createElement('div');
      row.className = 'cm-emedf-hover__row';
      row.textContent = `bank ${item.bank}:${item.id} — ${renderArgSummary(item)}`;
      element.appendChild(row);
    }
    return {
      pos: word.from,
      end: word.to,
      create: () => ({ dom: element })
    };
  };
}

function buildEditorExtensions(
  onDocChange: (text: string, state: EditorState) => void,
  readOnly: boolean,
  getCatalog: () => EmedfCompletionItem[]
): Extension[] {
  const extensions: Extension[] = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    foldGutter(),
    bracketMatching(),
    indentOnInput(),
    drawSelection(),
    dropCursor(),
    history(),
    closeBrackets(),
    search({ top: true }),
    syntaxHighlighting(darkScriptStyle),
    emevdDslStreamLanguage,
    eventDiagGutter,
    EditorState.readOnly.of(readOnly),
    // T4-3：EMEDF 指令名补全（Ctrl+Space + 输入时）与悬停参数名列表。
    hoverTooltip(createHoverTooltipSource(getCatalog)),
    autocompletion({ override: [createCompletionSource(getCatalog)] }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onDocChange(update.state.doc.toString(), update.state);
    }),
    keymap.of([
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

export function EventSourceWorkbenchPanel(props: EventSourceWorkbenchPanelProps): ReactElement {
  const [tabs, setTabs] = useState<InternalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState('就绪');
  const [completionItems, setCompletionItems] = useState<EmedfCompletionItem[]>([]);

  const editorHostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** T4-3：EMEDF 指令名目录，经 ref 供 CM extensions 闭包读最新值（异步到达）。 */
  const completionItemsRef = useRef<EmedfCompletionItem[]>([]);
  completionItemsRef.current = completionItems;
  /** 每 tab 的 event 块行映射，gutter 经该 ref 读取（CM 闭包拿不到 React state）。 */
  const eventLineInfoRef = useRef<Map<number, EventLineInfo>>(new Map());
  const eventLineScanRef = useRef<EventLineScanState>(emptyEventLineScan());
  const sourceFillGenerationRef = useRef(0);
  /** 始终指向最新 commitDraft，供各 tab 的 CM extensions 闭包安全调用。 */
  const commitDraftRef = useRef<(tabId: string, text: string, state: EditorState) => void>(() => {});

  const activeTab = tabs.find((tab) => tab.tabId === activeTabId) ?? null;

  /** T4-3：从主进程拉取本机 EMEDF 指令名目录（只读公开字段，一次性）。 */
  useEffect(() => {
    const bridge = getRendererBridge();
    if (!bridge) return;
    let cancelled = false;
    bridge
      .readEmedfCompletionCatalog()
      .then((result) => {
        if (!cancelled && result.ok) setCompletionItems(result.items);
      })
      .catch(() => {
        // 目录拉取失败只影响补全/悬停，不阻断源码展示。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const commitDraft = useCallback((tabId: string, text: string, state: EditorState) => {
    setTabs((previous) =>
      previous.map((tab) =>
        // 同步最新 CM state：切换 tab 时 view.setState(activeTab.editorState)
        // 换入的是缓存 state，若编辑后不更新它，切回来会回退到未编辑的模板。
        tab.tabId === tabId ? { ...tab, dirty: true, draft: text, editorState: state } : tab
      )
    );
  }, []);
  commitDraftRef.current = commitDraft;

  /** 每个 tab 的 extensions 绑定自己的 tabId；运行时经 ref 调最新 commitDraft。 */
  const createExtensionsFor = useCallback((tabId: string, readOnly: boolean): Extension[] => {
    return buildEditorExtensions(
      (text, state) => commitDraftRef.current(tabId, text, state),
      readOnly,
      () => completionItemsRef.current
    );
  }, []);

  /** 把 App 给的 pending tab 并入 tabs（去重 + 保留 dirty/draft）并激活。 */
  useEffect(() => {
    const pending = props.pendingTab;
    if (!pending) return;
    const base = baselineText(pending);
    setTabs((previous) => {
      const index = previous.findIndex((tab) => tab.tabId === pending.tabId);
      if (index >= 0) {
        const existing = previous[index]!;
        const merged: InternalTab = {
          ...existing,
          document: pending.document,
          // 必须显式跟着 document 走：`...existing` 会留住上一次的 gutter 判据，
          // 重开/提交后拿旧行给新文本打标记。pending 没有时也要清掉（undefined
          // = 回退到按 document.events 现算）。
          eventWarnings: pending.eventWarnings,
          sourceHash: pending.sourceHash,
          live: pending.live,
          dslTemplate: pending.dslTemplate,
          dslTemplateTruncated: pending.dslTemplateTruncated,
          dslTemplateTotalLines: pending.dslTemplateTotalLines,
          sourceStyle: pending.sourceStyle,
          sourceFillTarget: existing.sourceFillTarget
        };
        return previous.map((tab, i) => (i === index ? merged : tab));
      }
      const { head, rest } = splitSourceForFirstFrame(base);
      const created: InternalTab = {
        ...pending,
        dirty: false,
        draft: head,
        sourceFillTarget: rest.length > 0 ? base : null,
        editorState: EditorState.create({
          doc: head,
          extensions: createExtensionsFor(pending.tabId, isSourceReadOnly(pending))
        })
      };
      return [...previous, created];
    });
    setActiveTabId(pending.tabId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.pendingTab, createExtensionsFor]);

  const applyEventLineScan = useCallback((scan: EventLineScanState) => {
    eventLineScanRef.current = scan;
    eventLineInfoRef.current = scan.map;
    const view = viewRef.current;
    if (view) {
      (view as unknown as { _eventLineInfo: Map<number, EventLineInfo> })._eventLineInfo =
        eventLineInfoRef.current;
      view.requestMeasure();
    }
  }, []);

  const syncGutterInfo = useCallback((text: string, rows: readonly EventWarningRow[]) => {
    applyEventLineScan(indexEventLinesIncremental(emptyEventLineScan(), text, rows));
  }, [applyEventLineScan]);

  useEffect(() => {
    if (!activeTab) return;
    // 灌入进行中由 onSlice 增量扫新 chunk。这里若用 draft（仍是首帧前缀）
    // 从空状态重扫，会把已扫到的 gutter 整表清掉，并随 setTabs 退化成 O(N²)。
    if (activeTab.sourceFillTarget !== null) return;
    syncGutterInfo(activeTab.draft, eventWarningRowsOf(activeTab));
  }, [activeTabId, activeTab?.draft, activeTab?.sourceFillTarget, activeTab?.eventWarnings, syncGutterInfo]);

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
    return () => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);

  /** 提交/加载完整模板/mutation 后 App 回灌 pendingTab → 更新激活 tab 的基线（保留 dirty）。 */
  useEffect(() => {
    const pending = props.pendingTab;
    if (!pending || !activeTabId || pending.tabId !== activeTabId) return;
    const view = viewRef.current;
    if (!view) return;
    const current = tabs.find((tab) => tab.tabId === activeTabId);
    if (!current || current.dirty) return;
    const next = baselineText(pending);
    if (current.sourceFillTarget === next) return;
    if (next === current.draft && current.sourceFillTarget === null) return;
    const { head, rest } = splitSourceForFirstFrame(next);
    const nextState = EditorState.create({
      doc: head,
      extensions: createExtensionsFor(activeTabId, isSourceReadOnly(pending))
    });
    setTabs((previous) =>
      previous.map((tab) =>
        tab.tabId === activeTabId
          ? {
              ...tab,
              document: pending.document,
              eventWarnings: pending.eventWarnings,
              sourceHash: pending.sourceHash,
              dslTemplate: pending.dslTemplate,
              draft: head,
              dirty: false,
              sourceFillTarget: rest.length > 0 ? next : null,
              editorState: nextState
            }
          : tab
      )
    );
    view.setState(nextState);
    syncGutterInfo(head, eventWarningRowsOf(pending));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.pendingTab, activeTabId]);

  /** 后台把剩余源码灌进当前 tab。取消/切走会中止这一代填充。 */
  useEffect(() => {
    const tab = tabs.find((item) => item.tabId === activeTabId);
    if (!tab || tab.dirty || tab.sourceFillTarget === null) return;
    const remaining = tab.sourceFillTarget.slice(tab.editorState.doc.length);
    if (remaining.length === 0) return;
    const generation = sourceFillGenerationRef.current + 1;
    sourceFillGenerationRef.current = generation;
    const controller = new AbortController();
    const rows = eventWarningRowsOf(tab);
    void appendSourceSlices({
      state: tab.editorState,
      rest: remaining,
      signal: controller.signal,
      onSlice: (state, chunk) => {
        if (sourceFillGenerationRef.current !== generation) return;
        applyEventLineScan(indexEventLinesIncremental(eventLineScanRef.current, chunk, rows));
        const view = viewRef.current;
        if (view && view.state !== state) view.setState(state);
      }
    }).then((result) => {
      if (sourceFillGenerationRef.current !== generation || result.cancelled) return;
      setTabs((previous) =>
        previous.map((item) =>
          item.tabId === tab.tabId
            ? {
                ...item,
                draft: result.state.doc.toString(),
                editorState: result.state,
                sourceFillTarget: null
              }
            : item
        )
      );
      const view = viewRef.current;
      if (view) view.setState(result.state);
    });
    return () => {
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, activeTab?.sourceFillTarget, activeTab?.dirty]);

  function activateTab(tabId: string): void {
    setActiveTabId(tabId);
  }

  function closeTab(tabId: string): void {
    setTabs((previous) => {
      const index = previous.findIndex((tab) => tab.tabId === tabId);
      const next = previous.filter((tab) => tab.tabId !== tabId);
      if (activeTabId === tabId) {
        const neighbor = next[Math.max(0, index - 1)] ?? next[0] ?? null;
        setActiveTabId(neighbor?.tabId ?? null);
      }
      return next;
    });
  }

  async function submitSource(): Promise<void> {
    if (!activeTab || !props.onDslSubmit || submitting) return;
    setSubmitting(true);
    setStatus('源码提交中（compile → plan → staging）…');
    try {
      const result = await props.onDslSubmit(activeTab, activeTab.draft);
      if (result.ok) {
        const nextText = result.nextDslTemplate ?? activeTab.draft;
        const { head, rest } = splitSourceForFirstFrame(nextText);
        const nextState = EditorState.create({
          doc: head,
          extensions: createExtensionsFor(activeTab.tabId, isSourceReadOnly(activeTab))
        });
        setTabs((previous) =>
          previous.map((tab) =>
            tab.tabId === activeTab.tabId
              ? {
                  ...tab,
                  dirty: false,
                  draft: head,
                  dslTemplate: nextText,
                  dslTemplateTruncated: false,
                  dslTemplateTotalLines: nextText.split('\n').length,
                  sourceFillTarget: rest.length > 0 ? nextText : null,
                  editorState: nextState
                }
              : tab
          )
        );
        viewRef.current?.setState(nextState);
        // 提交刚成功、App 还没回灌 pendingTab：先按提交前的判据行给新文本打标记，
        // 下一轮 pendingTab 到达时会用权威 outline 覆盖。
        syncGutterInfo(head, eventWarningRowsOf(activeTab));
        setStatus('源码已通过提交管线；等待文档刷新。');
      } else {
        setStatus(result.diagnostics[0]?.message ?? '源码提交被拒绝。');
      }
    } catch (error) {
      setStatus(`源码提交异常：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSubmitting(false);
    }
  }

  const readOnly = activeTab
    ? (!activeTab.live || activeTab.dslTemplate === null || activeTab.sourceStyle === 'dark-script')
    : true;

  /**
   * R3/P4 裁定：DarkScript3 反汇编源码只读展示（没有对应的 DarkScript 编译器，
   * 编辑后无法提交）。写链保留给 future 的 DarkScript 编译器。
   */
  const darkScriptReadOnly = activeTab?.sourceStyle === 'dark-script';

  return (
    <section className="event-source-workbench" aria-label="Event 源码工作台">
      <header className="event-source__header">
        <div>
          <span className="event-source__eyebrow">EVENT / SOURCE</span>
          <h2>事件源码工作台</h2>
        </div>
        <span className="muted">{status}</span>
      </header>

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
        {tabs.length === 0 && <span className="muted esw-tabs__empty">暂无打开的事件文档。</span>}
      </div>

      <div className="esw-toolbar">
        <div className="esw-toolbar__group">
          <span className="muted" style={{ fontSize: 11 }} title="Ctrl+F 走 CodeMirror search keymap">
            查找：Ctrl+F
          </span>
          {darkScriptReadOnly ? (
            <span className="muted" style={{ fontSize: 11 }} title="EMEDF 反汇编源码只读展示；写入仍经 Bridge 写链。">
              反汇编源码只读
            </span>
          ) : (
            <button
              type="button"
              className="primary-action"
              disabled={!props.onDslSubmit || submitting || readOnly}
              onClick={() => void submitSource()}
            >
              {submitting ? '提交中…' : '编译并提交'}
            </button>
          )}
        </div>
      </div>

      <div className="esw-body">
        <section className="esw-source" aria-label="事件源码">
          <div ref={editorHostRef} className="esw-source__host" data-editor-engine="codemirror" />
          {activeTab?.live && activeTab.dslTemplate === null && (
            <div className="event-source__notice event-source__notice--blocked" role="alert">
              事件源码反汇编已失败关闭：未找到用户本机 EMEDF（DarkScript3 的
              sekiro-common.emedf.json）。配置后重新打开即可看到 DarkScript3 式源码。
            </div>
          )}
          {darkScriptReadOnly && (
            <div className="event-source__notice">
              DarkScript3 式反汇编源码（指令名来自用户本机 EMEDF）。本版只读展示；
              写入仍经 Bridge 与补丁引擎。
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
