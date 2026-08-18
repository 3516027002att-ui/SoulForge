import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ParamRowPage } from '@soulforge/shared';
import { getRendererBridge } from '../runtime/rendererRuntime.js';

export interface ParamRowView {
  id: number;
  name?: string;
  /** Hex preview of raw row bytes (no Node Buffer). */
  dataHexPreview: string;
  /** Full row bytes (base64) carried by the loaded document. */
  dataBase64?: string;
}

export interface ParamTablePanelProps {
  typeName: string;
  resourceUri: string;
  /** Demo/fallback rows; only rendered when live loading is unavailable. */
  rows: ParamRowView[];
  /** True when the source is a live Bridge PARAM document (loadAll-fetchable). */
  live?: boolean;
  /**
   * S31：外部 reveal 请求 —— 滚动定位到该行 id。面板消费后经 onRevealHandled
   * 通知 App 清除（一次性，避免用户后续筛选/滚动被反复拽回）。
   */
  revealRowId?: number | null | undefined;
  /** S31：reveal 请求已处理（无论命中或不足证据）后回调，App 据此清除请求。 */
  onRevealHandled?: () => void;
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

/**
 * PARAM 专业表格：全量行表（用户裁定 2026-08-14）+ row CRUD mutation 出口。
 *
 * Live 模式经 `resource.readParamPage(loadAll=true)` 一次取回全部行（含行字节，
 * main 侧 includeAllPayloads 跳过 Bridge 页门控），筛选在 renderer 本地做，
 * DOM 用虚拟滚动保持有界——打开表即全量到位，不再分批翻页。
 */
export function ParamTablePanel(props: ParamTablePanelProps): ReactElement {
  const bridge = getRendererBridge();
  const liveMode = props.live === true
    && bridge !== null
    && typeof bridge.readParamPage === 'function';
  const [query, setQuery] = useState('');
  const [allRows, setAllRows] = useState<ParamRowView[]>([]);
  const [rowCount, setRowCount] = useState(0);
  const [maxId, setMaxId] = useState(0);
  const [loading, setLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  /** 行列表滚动容器（虚拟化器测量视口）。 */
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Live path: fetch the complete row table once (loadAll), then filter locally.
  useEffect(() => {
    if (!liveMode || bridge === null || !props.resourceUri) return;
    let cancelled = false;
    setLoading(true);
    setPageError(null);
    bridge.readParamPage(props.resourceUri, 0, 1, '', true)
      .then((result: ParamRowPage) => {
        if (cancelled) return;
        if (!result.ok) {
          setPageError(result.diagnostics?.[0]?.message ?? 'PARAM 全量读取失败。');
          setAllRows([]);
        } else {
          setAllRows(result.rows.map((row) => ({
            id: row.id,
            dataHexPreview: row.dataHexPreview ?? '',
            ...(row.dataBase64 ? { dataBase64: row.dataBase64 } : {}),
            ...(row.name ? { name: row.name } : {})
          })));
          setRowCount(result.rowCount);
          setMaxId(result.rows.reduce((max, row) => Math.max(max, row.id), 0));
          setPageError(null);
        }
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPageError(error instanceof Error ? error.message : 'PARAM 全量读取异常。');
        setAllRows([]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [liveMode, bridge, props.resourceUri]);

  // Demo/fallback path: client-side filter over the demo rows.
  const sourceRows = liveMode ? allRows : props.rows;
  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sourceRows;
    return sourceRows.filter(
      (row) => String(row.id).includes(q) || (row.name ?? '').toLowerCase().includes(q)
    );
  }, [sourceRows, query]);

  // 虚拟滚动：全量数据一次在手，DOM 只渲染视口行（数万行也不卡）。
  const virtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28,
    overscan: 12
  });

  /**
   * S31：外部 reveal —— 行存在则清掉筛选并滚到该行；表里确实没有该行则给
   * insufficient_evidence（面板内可见，不猜测、不跳到别的行）。
   */
  const [revealMissed, setRevealMissed] = useState<string | null>(null);
  useEffect(() => {
    const target = props.revealRowId;
    if (target === null || target === undefined) return;
    if (loading) return; // 全量行还没到齐：等加载完成的那一轮再判。
    const index = visibleRows.findIndex((row) => row.id === target);
    if (index >= 0) {
      setRevealMissed(null);
      virtualizer.scrollToIndex(index, { align: 'center' });
    } else if (sourceRows.some((row) => row.id === target)) {
      // 行存在但被当前筛选挡住：清掉筛选让行可见；不处理请求，下一轮
      // visibleRows 含目标行后再滚（否则行出现了但永远不滚到）。
      setQuery('');
      return;
    } else {
      setRevealMissed(`insufficient_evidence：PARAM 表里没有行 ${target}。`);
    }
    props.onRevealHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.revealRowId, loading, visibleRows, sourceRows]);

  function deleteRow(id: number): void {
    setAllRows((prev) => prev.filter((row) => row.id !== id));
    props.onMutation?.({ kind: 'param_row_delete', id });
  }

  function duplicateRow(id: number): void {
    const source = visibleRows.find((row) => row.id === id);
    if (!source) return;
    const nextId = maxId + 1;
    const next: ParamRowView = {
      id: nextId,
      dataHexPreview: source.dataHexPreview,
      ...(source.dataBase64 ? { dataBase64: source.dataBase64 } : {}),
      ...(source.name ? { name: `${source.name}_copy` } : {})
    };
    setAllRows((prev) => [...prev, next]);
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
          {rowCount} 行 · 全量加载 · 字段级 def 见下方面板
        </span>
      </header>
      <div className="row gap">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="筛选 row id / name（全量数据本地过滤）"
          aria-label="筛选 PARAM 行 id 或 name（全量数据本地过滤）"
        />
        {loading && <span className="muted">加载中…</span>}
      </div>
      {pageError && <p className="danger">{pageError}</p>}
      {revealMissed && <p className="muted">{revealMissed}</p>}
      <div className="binder-child-table" role="table">
        <div className="binder-child-row binder-child-header" role="row">
          <span>ID</span>
          <span>Name</span>
          <span>Raw</span>
          <span>操作</span>
        </div>
        <div
          ref={scrollRef}
          style={{ overflowY: 'auto', maxHeight: 420, position: 'relative' }}
        >
          <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = visibleRows[virtualRow.index];
              if (!row) return null;
              return (
                <div
                  key={row.id}
                  className="binder-child-row"
                  role="row"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`
                  }}
                >
                  <span>{row.id}</span>
                  <span>{row.name ?? '—'}</span>
                  <span title={row.dataHexPreview}>{row.dataHexPreview.slice(0, 24)}</span>
                  <span className="row gap">
                    <button type="button" onClick={() => duplicateRow(row.id)}>复制</button>
                    <button type="button" onClick={() => deleteRow(row.id)}>删除</button>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        {visibleRows.length === 0 && !loading && <p className="muted">没有匹配的行。</p>}
      </div>
      <p className="muted">结构定义（paramdef）编辑将写入用户派生游戏适配包，不会改官方包。</p>
    </section>
  );
}
