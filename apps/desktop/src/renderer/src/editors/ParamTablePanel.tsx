import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ParamPhysicalRowIdentity, ParamRowPayload } from '@soulforge/shared';

export interface ParamRowView {
  /** Native physical row ordinal; PARAM id is not necessarily unique. */
  rowIndex: number;
  id: number;
  dataHash: string;
  name?: string;
  /** Hex preview of raw row bytes (no Node Buffer). */
  dataHexPreview: string;
  /** Selected-row payload only; index rows intentionally leave this empty. */
  dataBase64?: string;
}

export interface ParamTablePanelProps {
  typeName: string;
  resourceUri: string;
  /** Index rows returned by openParamSession/readParamIndexPage. */
  rows: ParamRowView[];
  live?: boolean;
  rowCount?: number;
  indexLoading?: boolean;
  indexDiagnostic?: string | null;
  /** Selected-row payload route; the panel never falls back to loadAll. */
  onReadRows?: (
    identities: readonly ParamPhysicalRowIdentity[]
  ) => Promise<readonly ParamRowPayload[]>;
  revealRowId?: number | null | undefined;
  onRevealHandled?: () => void;
  onMutation?: (mutation: {
    kind: 'param_row_upsert' | 'param_row_delete';
    id: number;
    identity?: ParamPhysicalRowIdentity;
    sourceIdentity?: ParamPhysicalRowIdentity;
    dataHexPreview?: string;
    dataBase64?: string;
    sourceId?: number;
  }) => void;
}

function rowIdentity(row: ParamRowView): ParamPhysicalRowIdentity | null {
  if (!Number.isSafeInteger(row.rowIndex) || row.rowIndex < 0) return null;
  if (!Number.isSafeInteger(row.id)) return null;
  if (!row.dataHash) return null;
  return { rowIndex: row.rowIndex, id: row.id, dataHash: row.dataHash };
}

/** PARAM 索引表：先显示轻量 row directory，payload 只按物理身份选择读取。 */
export function ParamTablePanel(props: ParamTablePanelProps): ReactElement {
  const [query, setQuery] = useState('');
  const [allRows, setAllRows] = useState<ParamRowView[]>(props.rows);
  const [pageError, setPageError] = useState<string | null>(null);
  const [payloadLoadingRow, setPayloadLoadingRow] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setAllRows(props.rows);
  }, [props.rows]);

  const sourceRows = props.live ? allRows : props.rows;
  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sourceRows;
    return sourceRows.filter(
      (row) => String(row.id).includes(q) || (row.name ?? '').toLowerCase().includes(q)
    );
  }, [sourceRows, query]);
  const maxId = useMemo(
    () => sourceRows.reduce((max, row) => Math.max(max, row.id), 0),
    [sourceRows]
  );
  const loading = props.indexLoading === true || payloadLoadingRow !== null;

  const virtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28,
    overscan: 12
  });

  const [revealMissed, setRevealMissed] = useState<string | null>(null);
  useEffect(() => {
    const target = props.revealRowId;
    if (target === null || target === undefined || loading) return;
    const matches = visibleRows.filter((row) => row.id === target);
    if (matches.length === 1) {
      setRevealMissed(null);
      virtualizer.scrollToIndex(visibleRows.indexOf(matches[0]!), { align: 'center' });
    } else if (matches.length > 1) {
      setRevealMissed(`行 ${target} 存在 ${matches.length} 个物理实例，需按物理行身份定位。`);
    } else if (sourceRows.some((row) => row.id === target)) {
      setQuery('');
      return;
    } else {
      setRevealMissed(`当前 PARAM 索引中未找到行 ${target}。`);
    }
    props.onRevealHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.revealRowId, loading, visibleRows, sourceRows]);

  function deleteRow(row: ParamRowView): void {
    const identity = rowIdentity(row);
    setAllRows((prev) => prev.filter((candidate) => candidate.rowIndex !== row.rowIndex));
    props.onMutation?.({
      kind: 'param_row_delete',
      id: row.id,
      ...(identity ? { identity } : {})
    });
  }

  async function duplicateRow(source: ParamRowView): Promise<void> {
    const sourceIdentity = rowIdentity(source);
    if (!sourceIdentity) {
      setPageError('缺少完整物理行身份（rowIndex + id + dataHash），拒绝按 id 猜测复制目标。');
      return;
    }
    let dataBase64 = source.dataBase64;
    if (!dataBase64 && props.onReadRows) {
      setPayloadLoadingRow(source.rowIndex);
      setPageError(null);
      try {
        const payloads = await props.onReadRows([sourceIdentity]);
        const payload = payloads.find((item) => (
          item.identity.rowIndex === sourceIdentity.rowIndex
          && item.identity.id === sourceIdentity.id
          && item.identity.dataHash === sourceIdentity.dataHash
        ));
        dataBase64 = payload?.dataBase64;
      } catch (error) {
        setPageError(error instanceof Error ? error.message : '读取选中 PARAM 行失败。');
      } finally {
        setPayloadLoadingRow(null);
      }
    }
    if (!dataBase64) {
      setPageError('Bridge 未返回该物理行的完整 payload，拒绝复制。');
      return;
    }
    const nextId = maxId + 1;
    const next: ParamRowView = {
      rowIndex: -1,
      id: nextId,
      dataHash: source.dataHash,
      dataHexPreview: source.dataHexPreview,
      dataBase64,
      ...(source.name ? { name: `${source.name}_copy` } : {})
    };
    setAllRows((prev) => [...prev, next]);
    props.onMutation?.({
      kind: 'param_row_upsert',
      id: nextId,
      sourceId: source.id,
      sourceIdentity,
      dataHexPreview: source.dataHexPreview,
      dataBase64
    });
  }

  const rowCount = props.rowCount ?? sourceRows.length;
  return (
    <section className="panel" aria-label="PARAM 表格">
      <header className="panel-header">
        <h3>PARAM：{props.typeName}</h3>
        <span className="muted">
          {rowCount} 行 · {sourceRows.length}/{rowCount} 行索引 · payload 按选中行读取
        </span>
      </header>
      <div className="row gap">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="筛选已加载索引的 row id / name"
          aria-label="筛选 PARAM 行 id 或 name"
        />
        {loading && <span className="muted">索引/行 payload 读取中…</span>}
      </div>
      {props.indexDiagnostic && <p className="muted">{props.indexDiagnostic}</p>}
      {pageError && <p className="danger">{pageError}</p>}
      {revealMissed && <p className="muted">{revealMissed}</p>}
      <div className="binder-child-table" role="table">
        <div className="binder-child-row binder-child-header" role="row">
          <span>ID</span>
          <span>Name</span>
          <span>Raw</span>
          <span>操作</span>
        </div>
        <div ref={scrollRef} style={{ overflowY: 'auto', maxHeight: 420, position: 'relative' }}>
          <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = visibleRows[virtualRow.index];
              if (!row) return null;
              const key = `${row.rowIndex}:${row.id}:${row.dataHash}`;
              return (
                <div
                  key={key}
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
                  <span title={row.dataHexPreview}>{row.dataHexPreview.slice(0, 24) || '按需读取'}</span>
                  <span className="row gap">
                    <button
                      type="button"
                      disabled={payloadLoadingRow === row.rowIndex}
                      onClick={() => { void duplicateRow(row); }}
                    >复制</button>
                    <button type="button" onClick={() => deleteRow(row)}>删除</button>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        {visibleRows.length === 0 && !loading && <p className="muted">没有匹配的索引行。</p>}
      </div>
      <p className="muted">结构定义（paramdef）编辑将写入用户派生游戏适配包，不会改官方包。</p>
    </section>
  );
}
