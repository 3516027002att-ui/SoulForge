/**
 * EVENT-30B — DarkScript3 式 Event 源码工作台。
 *
 * 布局对照 DarkScript3（§11），不是 260/320 三栏：
 *   [文档标签栏] 逻辑文档标签（EMEVD 文档，§3.4），带 dirty 标记与关闭
 *   [工具条]     查找替换 toggle · Outline toggle · Inspector toggle · 编译并提交 · 加载完整源码
 *   [主区]       CodeMirror 6 源码占满；Outline / Inspector 仅用户显式打开
 *   [底部 dock]  Problems 折叠面板（只显示可行动问题）
 *
 * Negative DOM（EVENT-30B）：Flow / Hex / Raw Bytes 不在默认 viewport；原始
 * bytes 只能经 Developer Diagnostics 打开（本面板不提供）。
 *
 * 数据流：renderer 不持有文件系统路径与完整 document。App 经 `pendingTab`
 * （有界 DSL 投影 + 派生 document）按资源 URI 提供标签；提交/加载/结构化
 * mutation 都以 `EventSourceTabData` 上抛，由 App 走 Bridge → Patch 管线。
 * dirty 与编辑文本（draft）只在工作台内部，跨 tab 隔离（per-tab EditorState
 * 缓存 undo/redo 历史）。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement
} from 'react';
import type { EmevdEditorDocument, EmevdEventIr } from '@soulforge/shared';
import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  GutterMarker,
  drawSelection,
  dropCursor,
  gutter,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers
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
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { closeSearchPanel, openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { tags } from '@lezer/highlight';

export interface EventSourceSubmitResult {
  ok: boolean;
  diagnostics: Array<{ severity: string; code: string; message: string }>;
  nextDslTemplate?: string;
}

export interface EventSourceStructuredMutation {
  kind: 'emevd_set_rest_behavior' | 'emevd_update_id';
  eventUri: string;
  restBehavior?: number;
  newEventId?: number;
  baseRevision: number;
}

/** 一个逻辑 EMEVD 文档标签的只读数据（App 侧维护，renderer 只展示与编辑）。 */
export interface EventSourceTabData {
  tabId: string;
  title: string;
  resourceUri: string;
  document: EmevdEditorDocument;
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
  sourceStyle?: 'dark-script' | 'patch-dsl' | 'none';
}

export interface EventSourceWorkbenchPanelProps {
  /** App 最近一次打开/刷新的 EMEVD 文档；工作台按 tabId 去重后追加或更新标签。 */
  pendingTab: EventSourceTabData | null;
  onDslSubmit?: (
    tab: EventSourceTabData,
    sourceText: string
  ) => Promise<EventSourceSubmitResult>;
  onLoadFullDslTemplate?: (tab: EventSourceTabData) => void | Promise<void>;
  onStructuredMutation?: (
    tab: EventSourceTabData,
    mutation: EventSourceStructuredMutation
  ) => void;
}

interface InternalTab extends EventSourceTabData {
  /** 用户已编辑未提交。 */
  dirty: boolean;
  /** 当前源码文本（含用户编辑）。 */
  draft: string;
  /** 该标签的 CodeMirror 状态（含 undo/redo 历史），切换标签时保留。 */
  editorState: EditorState;
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

function baselineText(tab: EventSourceTabData): string {
  // live 但 dslTemplate 缺失 = EMEDF 缺失（主进程失败关闭，不给伪源码）。
  if (tab.live && tab.dslTemplate === null) return EMEDF_MISSING_SOURCE;
  return tab.dslTemplate ?? renderSource(tab.document);
}

/**
 * 定位 doc 里每个事件块的首行（1-based 行号），供 gutter 标记与 Go to Event。
 *
 * 兼容两种形态：
 * - 旧 Patch-DSL：`event @e:<anchor>`（有 anchor 的文档）；
 * - R3/P4 DarkScript3 式：`$Event(` —— 模板按 document.events 顺序渲染，
 *   所以按出现顺序映射到事件。
 * 行号随 draft 编辑变化，故在 draft 变化时重建。
 */
function indexEventLines(text: string, events: EmevdEventIr[]): Map<number, EventLineInfo> {
  const byAnchor = new Map<string, EmevdEventIr>();
  for (const event of events) {
    if (event.anchor?.localNodeId) byAnchor.set(event.anchor.localNodeId, event);
  }
  const map = new Map<number, EventLineInfo>();
  const lines = text.split('\n');
  let darkScriptIndex = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const anchorMatch = /^event\s+@e:(\S+)/.exec(lines[i]!);
    if (anchorMatch) {
      const event = byAnchor.get(anchorMatch[1]!);
      if (!event) continue;
      const warnings = event.instructions.filter((instruction) => instruction.unknown).length;
      if (warnings > 0) map.set(i + 1, { eventId: event.eventId, warnings });
      continue;
    }
    if (/^\$Event\(/.test(lines[i]!)) {
      const event = events[darkScriptIndex];
      darkScriptIndex += 1;
      if (!event) continue;
      const warnings = event.instructions.filter((instruction) => instruction.unknown).length;
      if (warnings > 0) map.set(i + 1, { eventId: event.eventId, warnings });
    }
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

function buildEditorExtensions(
  onDocChange: (text: string, state: EditorState) => void,
  readOnly: boolean
): Extension[] {
  return [
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
      '.cm-event-diag__warn': { color: 'var(--warn)' }
    })
  ];
}

export function EventSourceWorkbenchPanel(props: EventSourceWorkbenchPanelProps): ReactElement {
  const [tabs, setTabs] = useState<InternalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [showOutline, setShowOutline] = useState(false);
  const [showInspector, setShowInspector] = useState(false);
  const [showProblems, setShowProblems] = useState(true);
  const [showSearchPanel, setShowSearchPanel] = useState(false);
  const [selectedEventUri, setSelectedEventUri] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState('就绪');

  const editorHostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** 每 tab 的 event 块行映射，gutter 经该 ref 读取（CM 闭包拿不到 React state）。 */
  const eventLineInfoRef = useRef<Map<number, EventLineInfo>>(new Map());
  /** 始终指向最新 commitDraft，供各 tab 的 CM extensions 闭包安全调用。 */
  const commitDraftRef = useRef<(tabId: string, text: string, state: EditorState) => void>(() => {});

  const activeTab = tabs.find((tab) => tab.tabId === activeTabId) ?? null;

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
      readOnly
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
          sourceHash: pending.sourceHash,
          live: pending.live,
          dslTemplate: pending.dslTemplate,
          dslTemplateTruncated: pending.dslTemplateTruncated,
          dslTemplateTotalLines: pending.dslTemplateTotalLines
        };
        return previous.map((tab, i) => (i === index ? merged : tab));
      }
      const created: InternalTab = {
        ...pending,
        dirty: false,
        draft: base,
        editorState: EditorState.create({
          doc: base,
          extensions: createExtensionsFor(pending.tabId, !pending.live)
        })
      };
      return [...previous, created];
    });
    setActiveTabId(pending.tabId);
    setSelectedEventUri(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.pendingTab, createExtensionsFor]);

  const syncGutterInfo = useCallback((text: string, events: EmevdEventIr[]) => {
    eventLineInfoRef.current = indexEventLines(text, events);
    const view = viewRef.current;
    if (view) {
      (view as unknown as { _eventLineInfo: Map<number, EventLineInfo> })._eventLineInfo =
        eventLineInfoRef.current;
      view.requestMeasure();
    }
  }, []);

  useEffect(() => {
    if (!activeTab) return;
    syncGutterInfo(activeTab.draft, activeTab.document.events);
  }, [activeTab, syncGutterInfo]);

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
    if (next === current.draft) return;
    const nextState = EditorState.create({
      doc: next,
      extensions: createExtensionsFor(activeTabId, !pending.live)
    });
    setTabs((previous) =>
      previous.map((tab) =>
        tab.tabId === activeTabId
          ? { ...tab, document: pending.document, sourceHash: pending.sourceHash, dslTemplate: pending.dslTemplate, draft: next, dirty: false, editorState: nextState }
          : tab
      )
    );
    view.setState(nextState);
    syncGutterInfo(next, pending.document.events);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.pendingTab, activeTabId]);

  const problems = useMemo(() => {
    if (!activeTab) return [];
    return activeTab.document.diagnostics.filter((diagnostic) => diagnostic.severity !== 'info');
  }, [activeTab]);

  function activateTab(tabId: string): void {
    setActiveTabId(tabId);
    setSelectedEventUri(null);
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

  function toggleSearchPanel(): void {
    const view = viewRef.current;
    if (!view) return;
    if (showSearchPanel) {
      closeSearchPanel(view);
      setShowSearchPanel(false);
    } else {
      openSearchPanel(view);
      view.focus();
      setShowSearchPanel(true);
    }
  }

  function goToEvent(event: EmevdEventIr): void {
    if (!activeTab) return;
    setSelectedEventUri(event.eventUri);
    setShowInspector(true);
    const view = viewRef.current;
    if (!view) return;
    const anchor = event.anchor?.localNodeId ?? String(event.eventId);
    const pattern = new RegExp(`^event\\s+@e:${anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    const doc = view.state.doc;
    let targetLine = 0;
    // DarkScript3 式模板按 document.events 顺序渲染：定位第 N 个 `$Event(` 行。
    const eventIndex = activeTab.document.events.indexOf(event);
    let darkScriptIndex = 0;
    for (let line = 1; line <= doc.lines; line += 1) {
      const text = doc.line(line).text;
      if (pattern.test(text)) { targetLine = line; break; }
      if (/^\$Event\(/.test(text)) {
        if (darkScriptIndex === eventIndex) { targetLine = line; break; }
        darkScriptIndex += 1;
      }
    }
    if (targetLine > 0) {
      const from = doc.line(targetLine).from;
      view.dispatch({
        selection: { anchor: from },
        effects: EditorView.scrollIntoView(from, { y: 'center' })
      });
      view.focus();
    }
  }

  async function submitSource(): Promise<void> {
    if (!activeTab || !props.onDslSubmit || submitting) return;
    setSubmitting(true);
    setStatus('源码提交中（compile → plan → staging）…');
    try {
      const result = await props.onDslSubmit(activeTab, activeTab.draft);
      if (result.ok) {
        const nextText = result.nextDslTemplate ?? activeTab.draft;
        const nextState = EditorState.create({
          doc: nextText,
          extensions: createExtensionsFor(activeTab.tabId, !activeTab.live)
        });
        setTabs((previous) =>
          previous.map((tab) =>
            tab.tabId === activeTab.tabId
              ? {
                  ...tab,
                  dirty: false,
                  draft: nextText,
                  dslTemplate: nextText,
                  dslTemplateTruncated: false,
                  dslTemplateTotalLines: nextText.split('\n').length,
                  editorState: nextState
                }
              : tab
          )
        );
        viewRef.current?.setState(nextState);
        syncGutterInfo(nextText, activeTab.document.events);
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

  async function loadFullTemplate(): Promise<void> {
    if (!activeTab || !props.onLoadFullDslTemplate) return;
    setStatus('正在加载完整源码模板…');
    await props.onLoadFullDslTemplate(activeTab);
  }

  const selectedEvent = activeTab?.document.events.find(
    (event) => event.eventUri === selectedEventUri
  ) ?? null;

  function toggleRestBehavior(): void {
    if (!activeTab || !selectedEvent || !props.onStructuredMutation) return;
    const next = selectedEvent.restBehavior === 0 ? 1 : 0;
    props.onStructuredMutation(activeTab, {
      kind: 'emevd_set_rest_behavior',
      eventUri: selectedEvent.eventUri,
      restBehavior: next,
      baseRevision: activeTab.document.revision
    });
    setStatus(`已请求 restBehavior=${next}`);
  }

  const readOnly = activeTab
    ? (!activeTab.live || activeTab.dslTemplate === null || activeTab.sourceStyle === 'dark-script')
    : true;

  /**
   * R3/P4 裁定：DarkScript3 反汇编源码只读展示（没有对应的 DarkScript 编译器，
   * 编辑后无法提交）。结构化 mutation（restBehavior 等）仍可用；写链保留。
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
          <button
            type="button"
            className={showSearchPanel ? 'toolbar-button is-active' : 'toolbar-button'}
            onClick={toggleSearchPanel}
            aria-pressed={showSearchPanel}
          >
            查找替换
          </button>
          <button
            type="button"
            className={showOutline ? 'toolbar-button is-active' : 'toolbar-button'}
            onClick={() => setShowOutline((value) => !value)}
            aria-pressed={showOutline}
          >
            Outline
          </button>
          <button
            type="button"
            className={showInspector ? 'toolbar-button is-active' : 'toolbar-button'}
            onClick={() => setShowInspector((value) => !value)}
            aria-pressed={showInspector}
          >
            Inspector
          </button>
          <button
            type="button"
            className={showProblems ? 'toolbar-button is-active' : 'toolbar-button'}
            onClick={() => setShowProblems((value) => !value)}
            aria-pressed={showProblems}
          >
            Problems{problems.length > 0 ? ` (${problems.length})` : ''}
          </button>
        </div>
        <div className="esw-toolbar__group">
          {activeTab?.dslTemplateTruncated && (
            <button type="button" className="secondary-action" onClick={() => void loadFullTemplate()}>
              加载完整源码
            </button>
          )}
          {darkScriptReadOnly ? (
            <span className="muted" style={{ fontSize: 11 }} title="EMEDF 反汇编源码只读展示；写入仍经结构化 mutation（如 restBehavior 切换）与 Bridge 写链。">
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
        {showOutline && activeTab && (
          <section className="esw-outline" aria-label="事件大纲">
            <div className="esw-section-header">
              <strong>Outline</strong>
              <span className="muted">{activeTab.document.events.length} events</span>
            </div>
            <div className="esw-outline__list">
              {activeTab.document.events.map((event) => (
                <button
                  key={event.eventUri}
                  type="button"
                  className={event.eventUri === selectedEventUri ? 'esw-outline__item is-selected' : 'esw-outline__item'}
                  onClick={() => goToEvent(event)}
                >
                  <strong>Event {event.eventId}</strong>
                  <span>
                    rest {event.restBehavior}
                    {event.instructions.filter((instruction) => instruction.unknown).length > 0
                      ? ` · ${event.instructions.filter((instruction) => instruction.unknown).length} 未知指令`
                      : ''}
                  </span>
                </button>
              ))}
              {activeTab.document.events.length === 0 && <p className="empty-hint">暂无事件。</p>}
            </div>
          </section>
        )}

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
              写入请用右侧 Inspector 的结构化操作（如切换 restBehavior），提交仍经
              Bridge 与补丁引擎。
            </div>
          )}
          {activeTab?.dslTemplateTruncated && (
            <div className="event-source__notice">
              源码模板已按行截断，共 {activeTab.dslTemplateTotalLines} 行。可编辑的部分保持
              可编译；完整加载见工具条。
            </div>
          )}
        </section>

        {showInspector && (
          <section className="esw-inspector" aria-label="事件检查器">
            <div className="esw-section-header">
              <strong>Inspector</strong>
              <span className="muted">选中节点</span>
            </div>
            {selectedEvent ? (
              <>
                <dl className="event-source__facts">
                  <div><dt>Event ID</dt><dd>{selectedEvent.eventId}</dd></div>
                  <div><dt>Layer</dt><dd>{selectedEvent.layer}</dd></div>
                  <div><dt>Rest behavior</dt><dd>{selectedEvent.restBehavior}</dd></div>
                  <div><dt>Instructions</dt><dd>{selectedEvent.instructions.length}</dd></div>
                  <div><dt>URI</dt><dd title={selectedEvent.eventUri}>{selectedEvent.eventUri}</dd></div>
                </dl>
                <button
                  type="button"
                  className="secondary-action"
                  disabled={readOnly || !props.onStructuredMutation}
                  onClick={toggleRestBehavior}
                >
                  切换 restBehavior
                </button>
              </>
            ) : (
              <p className="empty-hint">从 Outline 选择一个事件。</p>
            )}
          </section>
        )}
      </div>

      {showProblems && (
        <div className="esw-dock" aria-label="事件问题">
          <div className="esw-section-header">
            <strong>Problems</strong>
            <span className={problems.length > 0 ? 'pill pill--warn' : 'pill'}>{problems.length}</span>
          </div>
          <div className="esw-dock__body">
            {problems.length === 0
              ? <p className="empty-hint">当前没有可行动的结构化问题。</p>
              : problems.map((problem) => (
                  <div className="event-source__problem" key={`${problem.code}:${problem.message}`}>
                    <strong>{problem.code}</strong>
                    <span>{problem.message}</span>
                  </div>
                ))}
          </div>
        </div>
      )}
    </section>
  );
}
