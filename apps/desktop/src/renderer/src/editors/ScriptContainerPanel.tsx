import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type ReactElement } from 'react';
import type {
  Diagnostic,
  RendererContainerChild,
  ScriptContainerEntryEvidence,
  ScriptContainerEvidence,
  ScriptEntryClassification
} from '@soulforge/shared';
import {
  SCRIPT_CLASSIFICATION_ORDER,
  SCRIPT_PAGE_SIZE,
  scriptClassificationLabel
} from '@soulforge/shared';
import { HexEditorPanel } from './HexEditorPanel.js';
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

/**
 * 脚本容器只读证据面板。
 *
 * SoulForge 不反编译、不重编译、不执行脚本：内层 `.lua`/`.hks` 是 Havok
 * Script 编译字节码（`\x1bLuaQ`），本面板只展示只读证据，绝不把字节码
 * 呈现为可编辑源码。唯一的写路径是"用户提供字节的整个内层文件替换"，
 * 替换字节必须由用户提供，SoulForge 不生成字节码。
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

  async function changePage(next: number): Promise<void> {
    setSelectedName(null);
    setReplaceCtx(null);
    setReplaceBytes('');
    setReplaceResult(null);
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
    setSelectedName((current) => (current === name ? null : name));
    setReplaceCtx(null);
    setReplaceBytes('');
    setReplaceResult(null);
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

  return (
    <section className="panel" aria-label="脚本容器只读证据">
      <header className="panel-header">
        <h3>脚本容器只读证据</h3>
        <span className="muted">
          {evidence
            ? `${evidence.containerFormat} · ${displayEntryCount} 条`
            : '未加载'}
        </span>
      </header>

      {loading && <p className="muted">正在构建证据…</p>}
      {loadError && <p className="danger">{loadError}</p>}
      {!loading && !loadError && !evidence && <p className="muted">选择左侧脚本容器后显示只读证据。</p>}

      {evidence && (
        <>
          <div className="structured-preview-grid">
            <span>容器格式：{evidence.containerFormat ?? 'unknown'}</span>
            <span>条目总数：{displayEntryCount}</span>
            <span>{pageChannelAvailable
              ? `分页枚举 · 每页 ${SCRIPT_PAGE_SIZE} 条`
              : `证据投影 ${evidence.entries.length} 条`}</span>
            {/* 「Bridge 仅返回采样条目，导航覆盖采样子集」是内部说法：用户不需要
                知道是谁返回的采样，只需要知道看到的不是全部。 */}
            <span>{entriesComplete ? '条目完整' : '仅部分条目（不是完整列表）'}</span>
          </div>

          {/* 降级截断必须可见：无分页通道时表格只渲染前一页，界面必须说清「还有
              更多但看不到」，否则用户会把截断当成完整数据。 */}
          {/* 措辞说后果不说内部原因：用户要知道的是「还有多少没显示」，
              而不是「分页通道不可用」这种实现细节。 */}
          {fallbackTruncated && (
            <p className="muted">
              共 {fallbackEntries.length} 条条目，当前仅显示前 {SCRIPT_PAGE_SIZE} 条。
            </p>
          )}

          <div className="native-chip-row">
            {summaryChips.map((chip) => (
              <span key={chip.classification}>
                {scriptClassificationLabel(chip.classification)}：{chip.count}
              </span>
            ))}
            {summaryChips.length === 0 && <span>无分类统计</span>}
          </div>

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

          {selected && (
            <div className="stack gap">
              <p className="muted">
                已选：{selected.name}（{scriptClassificationLabel(selected.classification)}）
                {selected.magicLabel ? ` · ${selected.magicLabel}` : ''}
              </p>
              <button type="button" disabled={replacing} onClick={() => void openReplace()}>
                替换内层文件（用户提供字节）
              </button>
              <p className="muted">
                替换字节必须由用户提供，SoulForge 不生成/反编译字节码；字节不会在此视图显示为可编辑源码。
              </p>
            </div>
          )}

          {replaceCtx && (
            <div className="stack gap">
              <p className="muted">
                替换目标：{replaceCtx.entry.name}
                {replaceCtx.containerHash
                  ? ` · 容器校验 ${shortHash(replaceCtx.containerHash)}`
                  : ''}
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
                      rows={3}
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
                  <p className="muted">提交会经 Patch Engine 事务并弹出主进程确认对话框；替换字节必须由用户提供。</p>
                </>
              )}
            </div>
          )}

          {evidence.diagnostics.length > 0 && (
            <div className="save-diagnostics">
              {evidence.diagnostics.map((diagnostic) => (
                <span key={`${diagnostic.code}-${diagnostic.message}`}>
                  {diagnostic.code}: {diagnostic.message}
                </span>
              ))}
            </div>
          )}

          {selected?.headerHex && (
            <HexEditorPanel
              title={`${selected.name} 头部证据（前 ${selected.headerHex.length / 2} 字节，只读）`}
              initialBytesBase64={hexToBase64(selected.headerHex)}
            />
          )}
        </>
      )}
    </section>
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
