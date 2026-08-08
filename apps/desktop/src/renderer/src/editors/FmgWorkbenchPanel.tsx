import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { FMG_PAGE_SIZE } from '@soulforge/shared';
import type { FmgEntryPage } from '@soulforge/shared';
import { getRendererBridge } from '../runtime/rendererRuntime.js';
import { isRowTabEntry, selectableRowAttributes } from '../a11y/selectableRow.js';

export interface FmgEntryRow {
  id: number;
  text: string;
}

export interface FmgWorkbenchPanelProps {
  resourceUri: string;
  /**
   * Demo/fallback entries. Only rendered when live pagination is unavailable
   * (no live Bridge document or no `readFmgPage` channel).
   */
  entries: FmgEntryRow[];
  /** True when the source is a live Bridge FMG document (page-fetchable). */
  live?: boolean;
  onMutation?: (mutation: {
    kind: 'fmg_entry_upsert' | 'fmg_entry_delete' | 'fmg_entry_add';
    id: number;
    text?: string;
  }) => void;
}

/*
 * 分页页大小（硬约束 17）来自 @soulforge/shared，与主进程 `resource.readFmgPage`
 * 用同一常量。此前两侧各写一遍 100，改一侧不报错，症状是分页错位或末页重复。
 */

/**
 * FMG 本地化工作台：分页条目表 + 筛选/编辑/增删。
 *
 * Live 模式下经 `resource.readFmgPage` 按页读取（renderer 只持有一页，
 * 查询在 main 端作用于完整条目表），导航可覆盖完整文档；mutation 上抛给
 * 主进程/EditorDocumentStore。演示回退路径也在 renderer 内显式分页，
 * 不再一次渲染全部条目。
 */
export function FmgWorkbenchPanel(props: FmgWorkbenchPanelProps): ReactElement {
  const bridge = getRendererBridge();
  const liveMode = props.live === true
    && bridge !== null
    && typeof bridge.readFmgPage === 'function';
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [pageEntries, setPageEntries] = useState<FmgEntryRow[]>([]);
  const [pageCount, setPageCount] = useState(1);
  const [entryCount, setEntryCount] = useState(0);
  const [maxId, setMaxId] = useState(0);
  const [loading, setLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Live path: fetch one page from main (complete coverage via navigation).
  useEffect(() => {
    if (!liveMode || bridge === null || !props.resourceUri) return;
    let cancelled = false;
    setLoading(true);
    setPageError(null);
    bridge.readFmgPage(props.resourceUri, page, FMG_PAGE_SIZE, query)
      .then((result: FmgEntryPage) => {
        if (cancelled) return;
        if (!result.ok) {
          setPageError(result.diagnostics?.[0]?.message ?? 'FMG 分页读取失败。');
          setPageEntries([]);
        } else {
          setPageEntries(result.entries);
          setPageCount(result.pageCount);
          setEntryCount(result.entryCount);
          setMaxId(result.maxId);
          setPage(result.page);
          setPageError(null);
        }
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPageError(error instanceof Error ? error.message : 'FMG 分页读取异常。');
        setPageEntries([]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [liveMode, bridge, props.resourceUri, page, query]);

  // Demo/fallback path: client-side filter + explicit page window.
  const demoFiltered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return props.entries;
    return props.entries.filter(
      (row) => String(row.id).includes(q) || row.text.toLowerCase().includes(q)
    );
  }, [props.entries, query]);

  useEffect(() => {
    if (liveMode) return;
    const demoPageCount = Math.max(1, Math.ceil(demoFiltered.length / FMG_PAGE_SIZE));
    const clamped = Math.min(Math.max(0, page), demoPageCount - 1);
    const slice = demoFiltered.slice(
      clamped * FMG_PAGE_SIZE,
      clamped * FMG_PAGE_SIZE + FMG_PAGE_SIZE
    );
    setPageEntries(slice);
    setPageCount(demoPageCount);
    setEntryCount(demoFiltered.length);
    setMaxId(props.entries.reduce((max, row) => Math.max(max, row.id), 0));
    if (clamped !== page) setPage(clamped);
  }, [liveMode, demoFiltered, props.entries, page]);

  const selected = pageEntries.find((row) => row.id === selectedId) ?? null;

  function updateText(text: string): void {
    if (selectedId === null) return;
    setPageEntries((prev) => prev.map((row) => (row.id === selectedId ? { ...row, text } : row)));
    props.onMutation?.({ kind: 'fmg_entry_upsert', id: selectedId, text });
  }

  function addEntry(): void {
    const id = maxId + 1;
    setPageEntries((prev) => [...prev, { id, text: '' }]);
    setMaxId(id);
    setSelectedId(id);
    props.onMutation?.({ kind: 'fmg_entry_add', id, text: '' });
  }

  function deleteSelected(): void {
    if (selectedId === null) return;
    const id = selectedId;
    setPageEntries((prev) => prev.filter((row) => row.id !== id));
    setSelectedId(null);
    props.onMutation?.({ kind: 'fmg_entry_delete', id });
  }

  return (
    <section className="panel" aria-label="FMG 本地化工作台">
      <header className="panel-header">
        <h3>FMG 本地化工作台</h3>
        <span className="muted">
          {entryCount} 条 · 每页 {FMG_PAGE_SIZE}{props.resourceUri ? ` · ${props.resourceUri}` : ''}
        </span>
      </header>
      <div className="row gap">
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
          placeholder="筛选 ID 或文本（作用于完整条目表）"
          aria-label="筛选 FMG"
        />
        <button type="button" onClick={addEntry}>新增</button>
        <button type="button" disabled={selectedId === null} onClick={deleteSelected}>删除</button>
      </div>
      <div className="row gap pager">
        <button type="button" disabled={page <= 0 || loading} onClick={() => setPage((p) => p - 1)}>
          上一页
        </button>
        <span className="muted">{pageCount > 0 ? page + 1 : 0}/{pageCount}</span>
        <button
          type="button"
          disabled={page >= pageCount - 1 || loading}
          onClick={() => setPage((p) => p + 1)}
        >
          下一页
        </button>
        {loading && <span className="muted">加载中…</span>}
      </div>
      {pageError && <p className="danger">{pageError}</p>}
      <div className="binder-child-table" role="table">
        <div className="binder-child-row binder-child-header" role="row">
          <span>ID</span>
          <span>文本</span>
        </div>
        {/* 行选择必须键盘可达：编辑 textarea 只在选中后出现，此前键盘用户
            根本进不去编辑态。属性由 selectableRowAttributes 统一产出，行为契约
            （Enter/Space 触发、roving tabindex）由其单测锁定。 */}
        {pageEntries.map((row, rowIndex) => (
          <div
            key={row.id}
            className="binder-child-row"
            {...selectableRowAttributes({
              selected: row.id === selectedId,
              isTabEntry: isRowTabEntry(rowIndex, selectedId !== null),
              onSelect: () => setSelectedId(row.id)
            })}
            style={row.id === selectedId ? { background: '#243044' } : undefined}
          >
            <span>{row.id}</span>
            <span>{row.text.slice(0, 80)}</span>
          </div>
        ))}
        {pageEntries.length === 0 && !loading && <p className="muted">当前页无条目。</p>}
      </div>
      {selected && (
        <label className="stack gap">
          编辑 ID {selected.id}
          <textarea
            value={selected.text}
            onChange={(e) => updateText(e.target.value)}
            rows={3}
            spellCheck={false}
          />
        </label>
      )}
    </section>
  );
}
