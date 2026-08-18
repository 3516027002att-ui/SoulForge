import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement
} from 'react';
import type { ScriptContainerEntryEvidence, ScriptSourceView } from '@soulforge/shared';
import {
  SCRIPT_CLASSIFICATION_ORDER,
  SCRIPT_PAGE_SIZE,
  scriptClassificationLabel
} from '@soulforge/shared';
import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers
} from '@codemirror/view';
import { bracketMatching, foldGutter, indentOnInput } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { search, searchKeymap } from '@codemirror/search';
import { WorkbenchLayout } from '../workbench/WorkbenchLayout.js';
import { describeBridgeAbsence, getRendererBridge } from '../runtime/rendererRuntime.js';
import { isRowTabEntry, selectableRowAttributes } from '../a11y/selectableRow.js';

/*
 * 脚本 IDE（S16）。
 *
 * 两形态：
 * - 容器（luabnd 等）：Files | Source 两栏。左栏分页条目表，右栏点开的条目
 *   源码；`\x1bLua` 字节码条目由主进程调本机 DSLuaDecompiler 反编译为 Lua
 *   文本（main spawn，renderer 只收文本，不接触路径）。
 * - 独立脚本文件（.hks/.lua）：单 Source 栏，打开即按字节判定/反编译。
 *
 * 写回：Ctrl+S 应用（同 S14 话术「正在应用…」「已应用，可回滚。」），容器条目
 * 走 Patch Engine replaceContainerChild（回传 child/container hash 乐观校验），
 * 独立文件走 saveRawReplace。打开时哪套编码（ascii / utf8 / utf8-bom /
 * shift_jis / mixed-unknown / 反编译 utf8），保存必须用回那套；混合编码只改
 * 纯 ASCII 行。反编译失败/非 Lua 字节码给结构化原因，绝不把字节码呈现为可编辑源码。
 */

export interface ScriptContainerPanelProps {
  /** 脚本资源 uri（luabnd 容器或独立 .hks/.lua）。 */
  resourceUri: string;
  /** 写回成功提交后，通知 App 刷新操作历史。 */
  onMutationCommitted?: () => void | Promise<void>;
}

/** 源码形态的展示标签（§10.2：来源必须明示）。 */
function sourceKindLabel(source: ScriptSourceView): string {
  if (!source.ok) return '读取失败';
  if (source.kind === 'plaintext') return '明文源码';
  if (source.kind === 'decompiled') return '反编译源码';
  return '不可编辑';
}

/**
 * 只取 error 级诊断作为页级红字。容器的 diagnostics[0] 经常是
 * 「DCX 完整 payload 重建…通过」这类 info——它不是失败，不该涂红。
 */
function firstPageError(diagnostics: readonly { severity?: string; message: string }[]): string | null {
  const error = diagnostics.find((d) => d.severity === 'error');
  return error ? error.message : null;
}

function buildScriptEditorExtensions(
  onDocChange: (text: string) => void,
  onSave: () => void
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
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onDocChange(update.state.doc.toString());
    }),
    keymap.of([
      // Ctrl+S 直接应用；应用前自动备份，失败或撤销走审计与回滚（同 S14 话术）。
      { key: 'Mod-s', run: () => { onSave(); return true; } },
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
      '.cm-activeLineGutter': { backgroundColor: 'var(--forge-2)', color: 'var(--ink-2)' }
    })
  ];
}

export function ScriptContainerPanel(props: ScriptContainerPanelProps): ReactElement {
  const [mode, setMode] = useState<'container' | 'standalone' | null>(null);
  /** Paginated entry table served by `resource.listScriptContainerEntriesPage`. */
  const [pageEntries, setPageEntries] = useState<ScriptContainerEntryEvidence[]>([]);
  const [page, setPage] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [entryCount, setEntryCount] = useState(0);
  const [pageSummary, setPageSummary] = useState<Record<string, number> | null>(null);
  const [entriesComplete, setEntriesComplete] = useState(true);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  /** 当前选中的容器条目（index 是读链主键，不打码后的名字）。 */
  const [selectedEntry, setSelectedEntry] = useState<{ name: string; index: number } | null>(null);
  /** 当前展示的源码视图。 */
  const [source, setSource] = useState<ScriptSourceView | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  /** 编辑器草稿（始终最新，经 ref 供 CM 闭包与 Ctrl+S 读取）。 */
  const [dirty, setDirtyState] = useState(false);
  const dirtyRef = useRef(false);
  /** S14 话术的状态文本：'' | '正在应用…' | '已应用，可回滚。' | 失败原因。 */
  const [status, setStatus] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const editorHostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const draftRef = useRef('');
  const submitRef = useRef<() => void>(() => {});

  const bridge = getRendererBridge();

  function setDirty(value: boolean): void {
    dirtyRef.current = value;
    setDirtyState(value);
  }

  /* ── 形态识别：容器（分页条目表）还是独立脚本文件（单 Source） ──── */
  const probeMode = useCallback(async (): Promise<void> => {
    setMode(null);
    setPageError(null);
    // 独立 .hks / .lua 单文件：按后缀直接 standalone，不对单文件调分页通道
    // （避免「仅部分条目」「输入不是容器」的误探测，见问题 13 截图 2）。
    const rawUri = props.resourceUri.toLowerCase();
    if (/\.hks$/i.test(rawUri) || /\.lua$/i.test(rawUri)) {
      setMode('standalone');
      return;
    }
    if (bridge === null || typeof bridge.listScriptContainerEntriesPage !== 'function') {
      // 通道不可用时按独立文件读（readScriptSource 不依赖分页通道）。
      setMode('standalone');
      return;
    }
    try {
      const result = await bridge.listScriptContainerEntriesPage(props.resourceUri, 0, SCRIPT_PAGE_SIZE);
      if (result.ok && result.containerFormat !== 'unknown') {
        setMode('container');
        setPageEntries(result.entries);
        setPage(result.page);
        setPageCount(result.pageCount);
        setEntryCount(result.entryCount);
        setPageSummary(result.classificationSummary);
        setEntriesComplete(result.entriesComplete);
        setPageError(firstPageError(result.diagnostics));
      } else {
        setMode('standalone');
      }
    } catch (error) {
      // 反编译入口优先：容器探测失败按独立文件尝试，读不出再报错。
      setMode('standalone');
      setPageError(error instanceof Error ? error.message : '脚本资源形态识别异常。');
    }
  }, [props.resourceUri, bridge]);

  useEffect(() => {
    void probeMode();
  }, [probeMode]);

  useEffect(() => {
    if (mode === 'standalone') void loadSource(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  /* ── 源码读取（容器条目或独立文件）────────────────────────────── */
  // 容器内条目的内层地址（uri 井号片段）由主进程构造，渲染器只传
  // resourceUri + 条目名 + entryIndex（index 是 native 读链的主键）。
  const loadSource = useCallback(async (entry: { name: string; index: number } | null): Promise<void> => {
    if (props.resourceUri === '') {
      setSource(null);
      setSourceError(null);
      return;
    }
    if (bridge === null || typeof bridge.readScriptSource !== 'function') {
      setSource(null);
      setSourceError(describeBridgeAbsence('读取脚本源码'));
      return;
    }
    setSourceLoading(true);
    setSourceError(null);
    setSource(null);
    try {
      const view = await bridge.readScriptSource(
        props.resourceUri,
        entry ? entry.name : undefined,
        entry ? entry.index : undefined
      );
      setSource(view);
      if (view.ok && view.sourceText !== undefined) {
        draftRef.current = view.sourceText;
        setDirty(false);
      } else {
        draftRef.current = '';
        setDirty(false);
      }
      if (!view.ok) {
        setSourceError(view.diagnostics?.[0]?.message ?? '脚本源码读取失败。');
      }
    } catch (error) {
      setSource(null);
      setSourceError(error instanceof Error ? error.message : '脚本源码读取异常。');
    } finally {
      setSourceLoading(false);
    }
  }, [props.resourceUri, bridge]);

  /* ── CodeMirror 编辑器：随 source 单例重建（切换条目即重建）────── */
  useEffect(() => {
    const host = editorHostRef.current;
    if (!host || !source || source.kind === 'failure' || source.sourceText === undefined) {
      return;
    }
    const extensions = buildScriptEditorExtensions(
      (text) => {
        draftRef.current = text;
        if (!dirtyRef.current) setDirty(true);
      },
      () => submitRef.current()
    );
    const view = new EditorView({
      doc: source.sourceText,
      extensions,
      parent: host
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  /* ── 保存（Ctrl+S）：容器条目 / 独立文件统一走 readScriptSource 回带的
      hash 与 writeSupported，由主进程选 replaceContainerChild 或
      saveTextResource。 ─────────────────────────────────────────── */
  const submitSource = useCallback(async (): Promise<void> => {
    if (submittingRef.current) return;
    if (bridge === null || typeof bridge.saveScriptSource !== 'function') {
      setStatus(describeBridgeAbsence('保存脚本源码'));
      return;
    }
    if (!source || !source.ok || source.writeSupported === false) return;
    submittingRef.current = true;
    setSubmitting(true);
    setStatus('正在应用…');
    try {
      const result = await bridge.saveScriptSource(
        props.resourceUri,
        source.entryName,
        source.childHash,
        source.containerHash,
        draftRef.current,
        // S34：按打开编码写回 —— main 侧用这个编码重新编码文本落盘。
        source.encoding
      );
      if (result.ok) {
        setDirty(false);
        setStatus('已应用，可回滚。');
        await props.onMutationCommitted?.();
        // 重新读取基线：写回后条目字节变了（容器内是 plaintext Lua），
        // 拿新的 child/container hash 与真实文本做下一次乐观校验。
        // 容器条目按 entryIndex 重读（保存回传的 index 是 native 读链主键）。
        void loadSource(
          source.entryName !== undefined && source.entryIndex !== undefined
            ? { name: source.entryName, index: source.entryIndex }
            : null
        );
      } else {
        setStatus(result.diagnostics?.[0]?.message ?? '应用失败。');
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '应用脚本源码异常。');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [bridge, props.resourceUri, props.onMutationCommitted, source, loadSource]);

  submitRef.current = () => { void submitSource(); };

  /* ── 分页 ─────────────────────────────────────────────────────── */
  const loadPage = useCallback(async (targetPage: number): Promise<void> => {
    if (bridge === null || typeof bridge.listScriptContainerEntriesPage !== 'function') return;
    setPageLoading(true);
    setPageError(null);
    try {
      const result = await bridge.listScriptContainerEntriesPage(
        props.resourceUri,
        targetPage,
        SCRIPT_PAGE_SIZE
      );
      if (result.ok) {
        setPageEntries(result.entries);
        setPage(result.page);
        setPageCount(result.pageCount);
        setEntryCount(result.entryCount);
        setPageSummary(result.classificationSummary);
        setEntriesComplete(result.entriesComplete);
        setPageError(firstPageError(result.diagnostics));
      } else {
        setPageEntries([]);
        setPageError(result.diagnostics?.[0]?.message ?? '脚本容器条目分页读取失败。');
      }
    } catch (error) {
      setPageEntries([]);
      setPageError(error instanceof Error ? error.message : '脚本容器条目分页读取异常。');
    } finally {
      setPageLoading(false);
    }
  }, [props.resourceUri, bridge]);

  async function changePage(next: number): Promise<void> {
    if (dirtyRef.current
      && !window.confirm('当前脚本有未保存修改，翻页将丢失这些修改。继续翻页？')) {
      return;
    }
    setSelectedEntry(null);
    setSource(null);
    setStatus('');
    await loadPage(next);
  }

  function selectEntry(entry: { name: string; index: number }): void {
    if (selectedEntry
      && entry.name === selectedEntry.name
      && entry.index === selectedEntry.index) {
      return;
    }
    if (dirtyRef.current
      && !window.confirm('当前脚本有未保存修改，切换条目将丢弃这些修改。继续切换？')) {
      return;
    }
    setSelectedEntry(entry);
    setStatus('');
    void loadSource(entry);
  }

  const summaryChips = useMemo(() => {
    if (!pageSummary) return [];
    return SCRIPT_CLASSIFICATION_ORDER
      .filter((classification) => (pageSummary[classification] ?? 0) > 0)
      .map((classification) => ({
        classification,
        count: pageSummary[classification] ?? 0
      }));
  }, [pageSummary]);

  /* ── 左栏：Files（容器条目分页表）────────────────────────────── */
  const filesColumn = (
    <div className="stack gap script-files">
      <div className="native-chip-row">
        {summaryChips.map((chip) => (
          <span key={chip.classification}>
            {scriptClassificationLabel(chip.classification)}：{chip.count}
          </span>
        ))}
        {summaryChips.length === 0 && <span className="muted">无分类统计</span>}
      </div>
      <div className="row gap pager">
        <button
          type="button"
          disabled={page <= 0 || pageLoading}
          onClick={() => void changePage(page - 1)}
        >
          上一页
        </button>
        <span className="muted">{pageCount > 0 ? page + 1 : 0}/{pageCount}</span>
        <button
          type="button"
          disabled={page >= pageCount - 1 || pageLoading}
          onClick={() => void changePage(page + 1)}
        >
          下一页
        </button>
        {pageLoading && <span className="muted">加载中…</span>}
      </div>
      {!entriesComplete && (
        <p className="muted">仅部分条目（不是完整列表）。</p>
      )}
      {pageError && <p className="danger">{pageError}</p>}
      {!pageLoading && !pageError && pageEntries.length === 0 && (
        <p className="muted">当前页无条目。</p>
      )}
      <div className="script-entry-table" role="table">
        <div className="script-entry-row script-entry-header" role="row">
          <span>名称</span>
          <span>分类</span>
          <span>大小</span>
          <span>索引</span>
        </div>
        {pageEntries.map((entry, rowIndex) => (
          <div
            key={`${entry.index}-${entry.name}`}
            className={entry.index === selectedEntry?.index
              ? 'script-entry-row selected'
              : 'script-entry-row'}
            {...selectableRowAttributes({
              selected: entry.index === selectedEntry?.index,
              isTabEntry: isRowTabEntry(rowIndex, selectedEntry !== null),
              onSelect: () => selectEntry({ name: entry.name, index: entry.index })
            })}
          >
            <span title={entry.name}>{entry.name}</span>
            <span className="muted">{scriptClassificationLabel(entry.classification)}</span>
            <span>{entry.size}</span>
            <span className="muted">{entry.index}</span>
          </div>
        ))}
      </div>
    </div>
  );

  /* ── 右栏：Source（可编辑源码 IDE）────────────────────────────── */
  const sourceColumn = (
    <div className="stack gap script-source">
      {sourceLoading && <span className="muted" role="status">正在读取/反编译源码…</span>}
      {!sourceLoading && !source && (
        <p className="muted">
          {mode === 'container' ? '在 Files 中选择要编辑的脚本条目。' : '正在读取脚本源码…'}
        </p>
      )}
      {sourceError && <p className="danger">{sourceError}</p>}
      {source && (
        <>
          <div className="native-chip-row script-source__meta">
            <span>{source.logicalName}</span>
            <span>{sourceKindLabel(source)}</span>
            {source.kind === 'decompiled' && source.decompiler && (
              <span title="反编译在 main 进程进行，renderer 只收文本">{source.decompiler}</span>
            )}
            {source.encoding && <span className="muted">{source.encoding}</span>}
            {source.ok && source.writeSupported && (
              <span className="muted" title="Ctrl+S 直接应用，应用前自动备份，可回滚">可编辑 · Ctrl+S 应用</span>
            )}
            {dirty && <span className="scp-dirty">未保存</span>}
          </div>
          {source.kind === 'failure' && (
            <div className="stack gap">
              <p className="danger">{source.diagnostics?.[0]?.message ?? '该脚本不能编辑。'}</p>
              {source.diagnostics.length > 1 && (
                <div className="save-diagnostics">
                  {source.diagnostics.slice(1).map((diagnostic) => (
                    <span key={`${diagnostic.code}-${diagnostic.message}`}>
                      {diagnostic.code}: {diagnostic.message}
                    </span>
                  ))}
                </div>
              )}
              <p className="muted">
                只读：SoulForge 不把字节码呈现为可编辑源码，也不伪造反编译结果。
              </p>
            </div>
          )}
          {(source.kind === 'plaintext' || source.kind === 'decompiled') && (
            <>
              <div ref={editorHostRef} className="scp-source__host" data-editor-engine="codemirror" />
              {status && (
                <span
                  className={status.startsWith('已应用') || !status.includes('失败') ? 'muted' : 'diag-error'}
                  data-testid="scp-status"
                  role="status"
                >
                  {status}
                </span>
              )}
            </>
          )}
        </>
      )}
    </div>
  );

  const toolbar = (
    <span className="muted" data-testid="scp-toolbar">
      {mode === null
        ? '脚本资源 · 识别中…'
        : mode === 'container'
          ? `脚本容器 · ${entryCount} 条条目 · Files | Source`
          : '独立脚本文件 · Source'}
    </span>
  );

  return (
    <WorkbenchLayout
      label={mode === 'container' ? '脚本容器工作台' : '脚本编辑'}
      toolbar={toolbar}
      columns={mode === 'container'
        ? [
            { id: 'files', title: 'Files', hint: `${entryCount} 条`, initialWidth: 320, minWidth: 220, children: filesColumn },
            { id: 'source', title: 'Source', initialFlex: 2, minWidth: 260, children: sourceColumn }
          ]
        : [
            { id: 'source', title: 'Source', children: sourceColumn }
          ]}
    />
  );
}