import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type ReactElement } from 'react';
import type {
  Diagnostic,
  RendererContainerChild,
  ScriptContainerEntryEvidence,
  ScriptContainerEvidence,
  ScriptEntryClassification,
  ScriptEntryEncoding,
  ScriptEntryPlaintextView
} from '@soulforge/shared';
import {
  SCRIPT_CLASSIFICATION_ORDER,
  SCRIPT_PAGE_SIZE,
  scriptClassificationLabel
} from '@soulforge/shared';
import { HexEditorPanel } from './HexEditorPanel.js';
import { WorkbenchLayout } from '../workbench/WorkbenchLayout.js';
import { isLikelyBase64, uint8ArrayToBase64 } from '../utils/binary.js';
import { describeBridgeAbsence, getRendererBridge } from '../runtime/rendererRuntime.js';
import { isRowTabEntry, selectableRowAttributes } from '../a11y/selectableRow.js';

/*
 * 分页页大小（硬约束 17）来自 @soulforge/shared，与主进程
 * `resource.listScriptContainerEntriesPage` 同一常量。
 */

export interface ScriptContainerPanelProps {
  /** Selected script container (e.g. a luabnd/bnd4 container). */
  resourceUri: string;
  /** 内层文件替换成功提交后，通知 App 刷新操作历史。 */
  onMutationCommitted?: () => void | Promise<void>;
}

interface ReplaceContext {
  entry: ScriptContainerEntryEvidence;
  childUri: string;
  containerHash: string;
  childHash: string;
  supported: boolean;
  message: string;
}

interface ReplaceResultView {
  ok: boolean;
  message: string;
  diagnostics: Diagnostic[];
}

/** 编码标签的中文显示（§10.2：encoding 必须明示）。 */
function encodingLabel(encoding: ScriptEntryEncoding): string {
  switch (encoding) {
    case 'ascii':
      return 'ASCII';
    case 'utf8':
      return 'UTF-8';
    case 'utf8-bom':
      return 'UTF-8（带 BOM）';
    case 'shift_jis':
      return 'Shift-JIS (CP932)';
    case 'mixed-unknown':
      return '混合 / 未知编码';
    default:
      return encoding;
  }
}

/**
 * 脚本容器工作台（SCRIPT-41）。
 *
 * 三栏 Container/Files | Source/只读反汇编（主区 flex）| Metadata，不用四栏
 * 模板 —— 没有真实符号解析（V0.5 无 HKS 重编译器），Symbols 栏无从填充，
 * 不造空栏（§10.2）。SoulForge 不反编译、不重编译、不执行脚本：内层 `.lua`/
 * `.hks` 是 Havok Script 编译字节码（`\x1bLuaQ`）。明文条目按真实 encoding
 * 解码展示（BOM/newline/NUL 明示）；字节码条目只展示只读字节视图，绝不把
 * 字节码呈现为可编辑源码。唯一的写路径是"用户提供字节的整个内层文件替换"。
 */
export function ScriptContainerPanel(props: ScriptContainerPanelProps): ReactElement {
  const [evidence, setEvidence] = useState<ScriptContainerEvidence | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [replaceCtx, setReplaceCtx] = useState<ReplaceContext | null>(null);
  const [replaceBytes, setReplaceBytes] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [replaceResult, setReplaceResult] = useState<ReplaceResultView | null>(null);
  /** Paginated entry table served by `resource.listScriptContainerEntriesPage`. */
  const [pageEntries, setPageEntries] = useState<ScriptContainerEntryEvidence[]>([]);
  const [page, setPage] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [entryCount, setEntryCount] = useState(0);
  const [pageSummary, setPageSummary] = useState<Record<ScriptEntryClassification, number> | null>(null);
  const [entriesComplete, setEntriesComplete] = useState(true);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  /** Source 主区的源码级只读视图（SCRIPT-41）。 */
  const [sourceView, setSourceView] = useState<ScriptEntryPlaintextView | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);

  const bridge = getRendererBridge();

  const load = useCallback(async (): Promise<void> => {
    if (!props.resourceUri) {
      setEvidence(null);
      setLoadError(null);
      return;
    }
    if (bridge === null) {
      setEvidence(null);
      setLoadError(describeBridgeAbsence('读取脚本容器证据'));
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const result = await bridge.scriptContainerEvidence(props.resourceUri);
      setEvidence(result);
      if (!result.ok) {
        setLoadError(result.diagnostics?.[0]?.message ?? '脚本容器证据读取失败。');
      }
    } catch (error) {
      setEvidence(null);
      setLoadError(error instanceof Error ? error.message : '脚本容器证据读取异常。');
    } finally {
      setLoading(false);
    }
  }, [props.resourceUri, bridge]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Paginated entry enumeration (hard constraint 17): the complete classified
   * entry table is materialized in main; the renderer only holds one page.
   * When the channel is unavailable, the bounded evidence projection is shown
   * as a degraded fallback.
   */
  const pageChannelAvailable = bridge !== null
    && typeof bridge.listScriptContainerEntriesPage === 'function';

  const loadPage = useCallback(async (targetPage: number): Promise<void> => {
    if (!props.resourceUri || !pageChannelAvailable || bridge === null) return;
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
        setPageError(null);
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
  }, [props.resourceUri, pageChannelAvailable, bridge]);

  useEffect(() => {
    if (props.resourceUri) void loadPage(0);
  }, [props.resourceUri, loadPage]);

  /**
   * 源码级只读视图按真实字节逐条读取（SCRIPT-41）。选中条目时加载，
   * 主进程用 `classifyPlaintextBytes` 判定，渲染器只负责展示。
   */
  const sourceChannelAvailable = bridge !== null
    && typeof bridge.readScriptEntryPlaintext === 'function';

  const loadSource = useCallback(async (entryName: string): Promise<void> => {
    if (!props.resourceUri || !sourceChannelAvailable || bridge === null) {
      setSourceView(null);
      setSourceError(null);
      return;
    }
    setSourceLoading(true);
    setSourceError(null);
    setSourceView(null);
    try {
      const view = await bridge.readScriptEntryPlaintext(props.resourceUri, entryName);
      setSourceView(view);
      if (!view.ok) {
        setSourceError(view.diagnostics?.[0]?.message ?? '源码级只读视图读取失败。');
      }
    } catch (error) {
      setSourceView(null);
      setSourceError(error instanceof Error ? error.message : '源码级只读视图读取异常。');
    } finally {
      setSourceLoading(false);
    }
  }, [props.resourceUri, sourceChannelAvailable, bridge]);

  function resetSelection(): void {
    setSelectedName(null);
    setReplaceCtx(null);
    setReplaceBytes('');
    setReplaceResult(null);
    setSourceView(null);
    setSourceError(null);
  }

  async function changePage(next: number): Promise<void> {
    resetSelection();
    await loadPage(next);
  }

  /**
   * 分页通道不可用时的降级：真实截断到一页并说清，而不是全量渲染。
   *
   * 此前这里直接把 evidence.entries 整块渲染。脚本容器条目数可达数千，首屏一次
   * 建出全部 DOM；而翻页控件按 pageChannelAvailable 隐藏，用户既看不到「还有更多」
   * 也无法翻页——界面上「只显示了前 N 条」与「一共就这么多」不可区分。
   */
  const fallbackEntries = evidence?.entries ?? [];
  const fallbackTruncated = !pageChannelAvailable && fallbackEntries.length > SCRIPT_PAGE_SIZE;
  const tableEntries = pageChannelAvailable
    ? pageEntries
    : fallbackEntries.slice(0, SCRIPT_PAGE_SIZE);
  const displayEntryCount = pageChannelAvailable && entryCount > 0
    ? entryCount
    : (evidence?.entryCount ?? fallbackEntries.length);

  const selected = useMemo(
    () => tableEntries.find((entry) => entry.name === selectedName) ?? null,
    [tableEntries, selectedName]
  );

  function selectEntry(name: string): void {
    setSelectedName((current) => {
      const next = current === name ? null : name;
      setReplaceCtx(null);
      setReplaceBytes('');
      setReplaceResult(null);
      setSourceView(null);
      setSourceError(null);
      if (next !== null) void loadSource(next);
      return next;
    });
  }

  async function openReplace(): Promise<void> {
    if (!selected) return;
    if (bridge === null) {
      setReplaceCtx({
        entry: selected,
        childUri: '',
        containerHash: '',
        childHash: '',
        supported: false,
        message: describeBridgeAbsence('脚本容器内层替换')
      });
      return;
    }
    setReplacing(true);
    setReplaceResult(null);
    setReplaceBytes('');
    try {
      const container = await bridge.inspectContainerTree(props.resourceUri);
      const containerHash = container.root?.hash ?? '';
      const list = await bridge.listContainerChildren(props.resourceUri);
      const child: RendererContainerChild | undefined = list.children.find((item: RendererContainerChild) => item.name === selected.name);
      if (!child) {
        setReplaceCtx({
          entry: selected,
          childUri: '',
          containerHash,
          childHash: '',
          supported: false,
          message: '无法在容器子项列表中找到该条目：只读证据可展示，但整内层文件替换不可用（需要受支持的 synthetic / DCX(DFLT) 容器）。'
        });
        return;
      }
      const read = await bridge.readContainerChild(child.childUri);
      const supported = Boolean(container.root?.canReplaceChild)
        && child.canReplace
        && read.ok
        && read.hash !== undefined;
      setReplaceCtx({
        entry: selected,
        childUri: child.childUri,
        containerHash,
        childHash: read.hash ?? '',
        supported,
        message: supported
          ? ''
          : '当前容器不支持权威 child 替换（原生 BND 未带 SFBN 标记，或无法读取条目字节）。只读证据仍可展示。'
      });
    } catch (error) {
      setReplaceCtx({
        entry: selected,
        childUri: '',
        containerHash: '',
        childHash: '',
        supported: false,
        message: error instanceof Error ? error.message : '读取替换所需校验信息失败。'
      });
    } finally {
      setReplacing(false);
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '');
      const comma = dataUrl.indexOf(',');
      setReplaceBytes(comma >= 0 ? dataUrl.slice(comma + 1) : '');
      setReplaceResult(null);
    };
    reader.readAsDataURL(file);
  }

  async function submitReplace(): Promise<void> {
    if (!replaceCtx || !replaceCtx.supported) return;
    if (bridge === null) {
      setReplaceResult({
        ok: false,
        message: describeBridgeAbsence('脚本容器内层替换'),
        diagnostics: []
      });
      return;
    }
    const base64 = replaceBytes.trim();
    if (!isLikelyBase64(base64)) {
      setReplaceResult({
        ok: false,
        message: '请提供有效的 base64 字节（替换字节必须由用户提供，SoulForge 不生成字节码）。',
        diagnostics: []
      });
      return;
    }
    setReplacing(true);
    setReplaceResult(null);
    try {
      const result = await bridge.replaceContainerChild(
        replaceCtx.childUri,
        replaceCtx.containerHash,
        replaceCtx.childHash,
        base64
      );
      const ok = Boolean(result.ok);
      setReplaceResult({
        ok,
        message: ok
          ? '内层文件已替换并提交（Patch Engine 事务 + 已建立可回滚备份）。'
          : (result.diagnostics?.[0]?.message ?? '内层文件替换失败。'),
        diagnostics: result.diagnostics ?? []
      });
      if (ok) {
        setReplaceCtx(null);
        setReplaceBytes('');
        await load();
        await loadPage(0);
        await props.onMutationCommitted?.();
      }
    } catch (error) {
      setReplaceResult({
        ok: false,
        message: error instanceof Error ? error.message : '内层文件替换调用异常。',
        diagnostics: []
      });
    } finally {
      setReplacing(false);
    }
  }

  const summaryChips = useMemo(() => {
    const summary = pageSummary ?? evidence?.classificationSummary;
    if (!summary) return [];
    return SCRIPT_CLASSIFICATION_ORDER
      .filter((classification) => (summary[classification] ?? 0) > 0)
      .map((classification) => ({
        classification,
        count: summary[classification] ?? 0
      }));
  }, [pageSummary, evidence]);

  const verdictMessage = useMemo(() => {
    const diagnostics = sourceView?.diagnostics ?? [];
    const info = diagnostics.find((d) => d.code === sourceView?.verdictCode);
    return info?.message ?? (sourceView?.isPlaintext ? '条目确认为明文。' : '');
  }, [sourceView]);

  /* ── 左栏：Container / Files ─────────────────────────────────────── */
  const filesColumn = (
    <div className="stack gap">
      {loadError && <p className="danger">{loadError}</p>}
      {evidence && (
        <>
          <div className="structured-preview-grid">
            <span>容器格式：{evidence.containerFormat ?? 'unknown'}</span>
            <span>条目总数：{displayEntryCount}</span>
            <span>{pageChannelAvailable
              ? `分页枚举 · 每页 ${SCRIPT_PAGE_SIZE} 条`
              : `证据投影 ${evidence.entries.length} 条`}</span>
            <span>{entriesComplete ? '条目完整' : '仅部分条目（不是完整列表）'}</span>
          </div>
          <div className="native-chip-row">
            {summaryChips.map((chip) => (
              <span key={chip.classification}>
                {scriptClassificationLabel(chip.classification)}：{chip.count}
              </span>
            ))}
            {summaryChips.length === 0 && <span>无分类统计</span>}
          </div>
          {fallbackTruncated && (
            <p className="muted">
              共 {fallbackEntries.length} 条条目，当前仅显示前 {SCRIPT_PAGE_SIZE} 条。
            </p>
          )}
        </>
      )}
      {pageChannelAvailable && (
        <>
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
          {pageError && <p className="danger">{pageError}</p>}
          {!pageLoading && !pageError && pageEntries.length === 0 && (
            <p className="muted">当前页无条目。</p>
          )}
        </>
      )}
      <div className="binder-child-table script-entry-table" role="table">
        <div className="binder-child-row binder-child-header script-entry-row" role="row">
          <span>名称</span>
          <span>分类</span>
          <span>大小</span>
          <span>索引</span>
          <span>标识</span>
        </div>
        {tableEntries.map((entry, rowIndex) => (
          <div
            key={`${entry.index}-${entry.name}`}
            className={entry.name === selectedName
              ? 'binder-child-row script-entry-row selected'
              : 'binder-child-row script-entry-row'}
            {...selectableRowAttributes({
              selected: entry.name === selectedName,
              isTabEntry: isRowTabEntry(rowIndex, selectedName !== null),
              onSelect: () => selectEntry(entry.name)
            })}
          >
            <span title={entry.name}>{entry.name}</span>
            <span className="muted">{scriptClassificationLabel(entry.classification)}</span>
            <span>{entry.size}</span>
            <span className="muted">{entry.index}</span>
            <span className="muted" title={entry.magicLabel ?? ''}>
              {entry.headerHex ? formatHeaderHex(entry.headerHex) : entry.magicLabel ?? ''}
            </span>
          </div>
        ))}
        {tableEntries.length === 0 && !pageLoading && <p className="muted">无条目证据。</p>}
      </div>
      {evidence?.diagnostics.length ? (
        <div className="save-diagnostics">
          {evidence.diagnostics.map((diagnostic) => (
            <span key={`${diagnostic.code}-${diagnostic.message}`}>
              {diagnostic.code}: {diagnostic.message}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );

  /* ── 中栏：Source / 只读反汇编（主区 flex）──────────────────────── */
  const sourceColumn = (
    <div className="stack gap script-source">
      {!selected && (
        <p className="muted">选择左侧条目后显示源码级只读视图。</p>
      )}
      {selected && sourceLoading && <p className="muted">正在读取条目真实字节…</p>}
      {selected && sourceError && <p className="danger">{sourceError}</p>}
      {selected && sourceView && (
        <>
          <div className="native-chip-row script-source__meta">
            <span>判定：{sourceView.isPlaintext ? '明文' : '非明文'}</span>
            <span>编码：{encodingLabel(sourceView.encoding)}</span>
            {sourceView.hasBom && <span>BOM：UTF-8 BOM</span>}
            <span>{sourceView.totalBytes} 字节</span>
            {sourceView.trailingPaddingBytes > 0 && (
              <span>尾部对齐填充：{sourceView.trailingPaddingBytes} 字节</span>
            )}
          </div>
          {sourceView.isPlaintext && (
            <>
              <div className="native-chip-row script-source__meta">
                <span>换行：CRLF {sourceView.newlines.crlf} · LF {sourceView.newlines.lf} · CR {sourceView.newlines.cr}</span>
                <span>内容 NUL：{sourceView.containsNul ? '有' : '无'}</span>
              </div>
              <pre className="script-source__text" spellCheck={false}>
                {sourceView.text}
              </pre>
              {sourceView.text?.endsWith('\n') || sourceView.text?.endsWith('\r')
                ? <span className="muted">末尾换行：有</span>
                : <span className="muted">末尾换行：无</span>}
            </>
          )}
          {!sourceView.isPlaintext && (
            <>
              <p className="danger">
                编译产物，非明文源码（{scriptClassificationLabel(sourceView.classification)}）。
              </p>
              {verdictMessage && <p className="muted">{verdictMessage}</p>}
              <p className="muted">
                SoulForge 不反编译/不重编译/不执行脚本，字节码绝不显示为可编辑源码；
                下方为只读字节证据。
              </p>
              {selected.headerHex && (
                <HexEditorPanel
                  title={`${selected.name} 头部只读字节证据（前 ${selected.headerHex.length / 2} 字节）`}
                  initialBytesBase64={hexToBase64(selected.headerHex)}
                />
              )}
            </>
          )}
        </>
      )}
      {selected && sourceView && !sourceView.isPlaintext && selected.headerHex
        && <p className="muted">只读字节视图不提供编辑；整内层文件替换见底部表单（字节由你提供）。</p>}
    </div>
  );

  /* ── 右栏：Metadata ──────────────────────────────────────────────── */
  const metadataColumn = (
    <div className="stack gap">
      {!selected && <p className="muted">选择条目后显示元数据。</p>}
      {selected && (
        <div className="structured-preview-grid">
          <span>名称：{selected.name}</span>
          <span>分类：{scriptClassificationLabel(selected.classification)}</span>
          <span>索引：{selected.index}</span>
          <span>大小：{selected.size}</span>
          {selected.magicLabel && <span>magic：{selected.magicLabel}</span>}
        </div>
      )}
      {selected && sourceView && (
        <div className="structured-preview-grid">
          <span>判定：{sourceView.verdictCode}</span>
          <span>可打印比例：{sourceView.printableRatio.toFixed(4)}</span>
          <span>编码：{encodingLabel(sourceView.encoding)}</span>
          <span>带 BOM：{sourceView.hasBom ? '是' : '否'}</span>
          <span>内容含 NUL：{sourceView.containsNul ? '是' : '否'}</span>
          <span>尾部填充：{sourceView.trailingPaddingBytes} 字节</span>
          <span>换行 CRLF/LF/CR：{sourceView.newlines.crlf}/{sourceView.newlines.lf}/{sourceView.newlines.cr}</span>
        </div>
      )}
      {selected && sourceView?.diagnostics.length ? (
        <div className="save-diagnostics">
          {sourceView.diagnostics.map((diagnostic) => (
            <span key={`${diagnostic.code}-${diagnostic.message}`}>
              {diagnostic.code}: {diagnostic.message}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );

  /* ── footer：选中条目的整内层文件替换（唯一写路径）──────────────── */
  const footer = selected ? (
    <div className="stack gap">
      {!replaceCtx && (
        <div className="row gap">
          <span className="muted">
            已选：{selected.name}
            {selected.magicLabel ? ` · ${selected.magicLabel}` : ''}
          </span>
          <button type="button" disabled={replacing} onClick={() => void openReplace()}>
            替换内层文件（用户提供字节）
          </button>
        </div>
      )}
      {replaceCtx && (
        <div className="stack gap">
          <p className="muted">
            替换目标：{replaceCtx.entry.name}
            {replaceCtx.containerHash ? ` · 容器校验 ${shortHash(replaceCtx.containerHash)}` : ''}
            {replaceCtx.childHash ? ` · 条目校验 ${shortHash(replaceCtx.childHash)}` : ''}
          </p>
          {!replaceCtx.supported && <p className="danger">{replaceCtx.message}</p>}
          {replaceCtx.supported && (
            <>
              <label className="stack gap">
                选择替换字节文件（由你提供）
                <input type="file" onChange={handleFileChange} />
              </label>
              <label className="stack gap">
                或粘贴 base64 字节
                <textarea
                  value={replaceBytes}
                  onChange={(event) => {
                    setReplaceBytes(event.target.value);
                    setReplaceResult(null);
                  }}
                  rows={2}
                  spellCheck={false}
                  placeholder="dataBase64…"
                />
              </label>
              <div className="row gap">
                <button
                  type="button"
                  disabled={replacing || replaceBytes.trim().length === 0}
                  onClick={() => void submitReplace()}
                >
                  {replacing ? '提交中…' : '经 Patch Engine 替换并提交'}
                </button>
                <button type="button" disabled={replacing} onClick={() => setReplaceCtx(null)}>
                  取消
                </button>
              </div>
            </>
          )}
          {replaceResult && (
            <p className={replaceResult.ok ? undefined : 'danger'}>{replaceResult.message}</p>
          )}
          {replaceResult && replaceResult.diagnostics.length > 0 && (
            <div className="save-diagnostics">
              {replaceResult.diagnostics.map((diagnostic) => (
                <span key={`${diagnostic.code}-${diagnostic.message}`}>
                  {diagnostic.code}: {diagnostic.message}
                </span>
              ))}
            </div>
          )}
          <p className="muted">
            替换字节必须由用户提供，SoulForge 不生成/反编译字节码；字节不会在此视图显示为可编辑源码。
            提交会经 Patch Engine 事务并弹出主进程确认对话框。
          </p>
        </div>
      )}
    </div>
  ) : undefined;

  return (
    <WorkbenchLayout
      label="脚本容器工作台"
      toolbar={
        <span className="muted">
          {evidence
            ? `${evidence.containerFormat ?? ''} · ${displayEntryCount} 条条目 · 三栏：文件 / 源码 / 元数据`
            : '选择左侧脚本容器后显示工作台'}
        </span>
      }
      footer={footer}
      columns={[
        { id: 'files', title: 'Container / Files', hint: `${displayEntryCount} 条`, children: filesColumn },
        { id: 'source', title: 'Source / 只读反汇编', initialFlex: 2, minWidth: 260, children: sourceColumn },
        { id: 'metadata', title: 'Metadata', initialWidth: 280, minWidth: 180, children: metadataColumn }
      ]}
    />
  );
}

function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
}

function formatHeaderHex(hex: string): string {
  const cleaned = hex.replace(/[^0-9a-fA-F]/g, '');
  const bytes: string[] = [];
  for (let i = 0; i < Math.min(cleaned.length, 32); i += 2) {
    bytes.push(cleaned.slice(i, i + 2));
  }
  return bytes.join(' ');
}

function hexToBase64(hex: string): string {
  const cleaned = hex.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(Math.floor(cleaned.length / 2));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return uint8ArrayToBase64(out);
}
