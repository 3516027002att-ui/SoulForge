import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { ParamRowPage } from '@soulforge/shared';
import { getRendererBridge } from '../runtime/rendererRuntime.js';

export interface ParamRowView {
  id: number;
  name?: string;
  /** Hex preview of raw row bytes (no Node Buffer). */
  dataHexPreview: string;
  /** Full row bytes (base64) carried by the paginated page. */
  dataBase64?: string;
}

export interface ParamTablePanelProps {
  typeName: string;
  resourceUri: string;
  /** Demo/fallback rows; only rendered when live pagination is unavailable. */
  rows: ParamRowView[];
  /** True when the source is a live Bridge PARAM document (page-fetchable). */
  live?: boolean;
  onMutation?: (mutation: {
    kind: 'param_row_upsert' | 'param_row_delete';
    id: number;
    dataHexPreview?: string;
    /** Full row bytes (base64) for the upsert/duplicate payload. */
    dataBase64?: string;
    /** When duplicating, source row id carries full Bridge payload for upsert. */
    sourceId?: number;
  }) => void;
}

/** Fixed page size for the paginated PARAM row table (hard constraint 17). */
const PARAM_PAGE_SIZE = 20;

/**
 * PARAM 专业表格：分页行表 + row CRUD mutation 出口。
 *
 * Live 模式下经 `resource.readParamPage` 按页读取（renderer 只持有一页，
 * 查询在 main 端作用于完整行表，导航可覆盖完整文档）；字段级 paramdef
 * 编辑仍在 ParamDefPanel。演示回退路径在 renderer 内显式分页。
 */
export function ParamTablePanel(props: ParamTablePanelProps): ReactElement {
  const bridge = getRendererBridge();
  const liveMode = props.live === true
    && bridge !== null
    && typeof bridge.readParamPage === 'function';
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [pageRows, setPageRows] = useState<ParamRowView[]>([]);
  const [pageCount, setPageCount] = useState(1);
  const [rowCount, setRowCount] = useState(0);
  const [maxId, setMaxId] = useState(0);
  const [loading, setLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);

  // Live path: fetch one page from main (complete coverage via navigation).
  useEffect(() => {
    if (!liveMode || bridge === null || !props.resourceUri) return;
    let cancelled = false;
    setLoading(true);
    setPageError(null);
    bridge.readParamPage(props.resourceUri, page, PARAM_PAGE_SIZE, query)
      .then((result: ParamRowPage) => {
        if (cancelled) return;
        if (!result.ok) {
          setPageError(result.diagnostics?.[0]?.message ?? 'PARAM 分页读取失败。');
          setPageRows([]);
        } else {
          setPageRows(result.rows.map((row) => ({
            id: row.id,
            dataHexPreview: row.dataHexPreview ?? '',
            ...(row.dataBase64 ? { dataBase64: row.dataBase64 } : {}),
            ...(row.name ? { name: row.name } : {})
          })));
          setPageCount(result.pageCount);
          setRowCount(result.rowCount);
          setMaxId(result.rows.reduce((max, row) => Math.max(max, row.id), 0));
          setPage(result.page);
          setPageError(null);
        }
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPageError(error instanceof Error ? error.message : 'PARAM 分页读取异常。');
        setPageRows([]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [liveMode, bridge, props.resourceUri, page, query]);

  // Demo/fallback path: client-side filter + explicit page window.
  const demoFiltered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return props.rows;
    return props.rows.filter(
      (row) => String(row.id).includes(q) || (row.name ?? '').toLowerCase().includes(q)
    );
  }, [props.rows, query]);

  useEffect(() => {
    if (liveMode) return;
    const demoPageCount = Math.max(1, Math.ceil(demoFiltered.length / PARAM_PAGE_SIZE));
    const clamped = Math.min(Math.max(0, page), demoPageCount - 1);
    const slice = demoFiltered.slice(
      clamped * PARAM_PAGE_SIZE,
      clamped * PARAM_PAGE_SIZE + PARAM_PAGE_SIZE
    );
    setPageRows(slice);
    setPageCount(demoPageCount);
    setRowCount(demoFiltered.length);
    setMaxId(props.rows.reduce((max, row) => Math.max(max, row.id), 0));
    if (clamped !== page) setPage(clamped);
  }, [liveMode, demoFiltered, props.rows, page]);

  function deleteRow(id: number): void {
    setPageRows((prev) => prev.filter((row) => row.id !== id));
    props.onMutation?.({ kind: 'param_row_delete', id });
  }

  function duplicateRow(id: number): void {
    const source = pageRows.find((row) => row.id === id);
    if (!source) return;
    const nextId = maxId + 1;
    const next: ParamRowView = {
      id: nextId,
      dataHexPreview: source.dataHexPreview,
      ...(source.dataBase64 ? { dataBase64: source.dataBase64 } : {}),
      ...(source.name ? { name: `${source.name}_copy` } : {})
    };
    setPageRows((prev) => [...prev, next]);
    props.onMutation?.({
      kind: 'param_row_upsert',
      id: nextId,
      dataHexPreview: source.dataHexPreview,
      ...(source.dataBase64 ? { dataBase64: source.dataBase64 } : {}),
      sourceId: source.id
    });
  }

  return (
    <section className="panel" aria-label="PARAM 表格">
      <header className="panel-header">
        <h3>PARAM：{props.typeName}</h3>
        <span className="muted">
          {rowCount} 行 · 每页 {PARAM_PAGE_SIZE} · 字段级 def 见下方面板
        </span>
      </header>
      <div className="row gap">
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
          placeholder="筛选 row id / name（作用于完整行表）"
          aria-label="筛选 PARAM 行 id 或 name"
        />
        <button type="button" disabled={page <= 0 || loading} onClick={() => setPage((p) => p - 1)}>上一页</button>
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
          <span>Name</span>
          <span>Raw</span>
          <span>操作</span>
        </div>
        {pageRows.map((row) => (
          <div key={row.id} className="binder-child-row" role="row">
            <span>{row.id}</span>
            <span>{row.name ?? '—'}</span>
            <span title={row.dataHexPreview}>{row.dataHexPreview.slice(0, 24)}</span>
            <span className="row gap">
              <button type="button" onClick={() => duplicateRow(row.id)}>复制</button>
              <button type="button" onClick={() => deleteRow(row.id)}>删除</button>
            </span>
          </div>
        ))}
        {pageRows.length === 0 && !loading && <p className="muted">当前页无行。</p>}
      </div>
      <p className="muted">结构定义（paramdef）编辑将写入用户派生游戏适配包，不会改官方包。</p>
    </section>
  );
}
