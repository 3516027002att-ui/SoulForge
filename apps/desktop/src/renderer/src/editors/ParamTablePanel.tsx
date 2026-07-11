import { useMemo, useState, type ReactElement } from 'react';

export interface ParamRowView {
  id: number;
  name?: string;
  /** Hex preview of raw row bytes (no Node Buffer). */
  dataHexPreview: string;
}

export interface ParamTablePanelProps {
  typeName: string;
  resourceUri: string;
  rows: ParamRowView[];
  onMutation?: (mutation: {
    kind: 'param_row_upsert' | 'param_row_delete';
    id: number;
    dataHexPreview?: string;
    /** When duplicating, source row id carries full Bridge payload for upsert. */
    sourceId?: number;
  }) => void;
}

/**
 * PARAM 专业表格骨架：虚拟化前的分页筛选 + row CRUD mutation 出口。
 * 字段级 paramdef 编辑仍标记为后续能力。
 */
export function ParamTablePanel(props: ParamTablePanelProps): ReactElement {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState(props.rows);
  const [page, setPage] = useState(0);
  const pageSize = 20;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) =>
      String(row.id).includes(q) || (row.name ?? '').toLowerCase().includes(q)
    );
  }, [rows, query]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageRows = filtered.slice(page * pageSize, page * pageSize + pageSize);

  function deleteRow(id: number): void {
    setRows((prev) => prev.filter((row) => row.id !== id));
    props.onMutation?.({ kind: 'param_row_delete', id });
  }

  function duplicateRow(id: number): void {
    const source = rows.find((row) => row.id === id);
    if (!source) return;
    const nextId = rows.reduce((max, row) => Math.max(max, row.id), 0) + 1;
    const next: ParamRowView = {
      id: nextId,
      dataHexPreview: source.dataHexPreview,
      ...(source.name ? { name: `${source.name}_copy` } : {})
    };
    setRows((prev) => [...prev, next]);
    props.onMutation?.({
      kind: 'param_row_upsert',
      id: nextId,
      dataHexPreview: source.dataHexPreview,
      sourceId: source.id
    });
  }

  return (
    <section className="panel" aria-label="PARAM 表格">
      <header className="panel-header">
        <h3>PARAM：{props.typeName}</h3>
        <span className="muted">{rows.length} 行 · 字段级 def 待启用</span>
      </header>
      <div className="row gap">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="筛选 row id / name"
        />
        <button type="button" disabled={page <= 0} onClick={() => setPage((p) => p - 1)}>上一页</button>
        <span className="muted">{page + 1}/{pageCount}</span>
        <button
          type="button"
          disabled={page >= pageCount - 1}
          onClick={() => setPage((p) => p + 1)}
        >
          下一页
        </button>
      </div>
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
      </div>
      <p className="muted">结构定义（paramdef）编辑将写入用户派生游戏适配包，不会改官方包。</p>
    </section>
  );
}
