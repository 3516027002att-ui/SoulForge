import { useMemo, useState, type ReactElement } from 'react';

export interface TaeAnimationSummary {
  animId: number;
  eventCount: number;
  groupCount: number;
  timesCount: number;
  hkxName?: string;
}

export interface TaeDocumentData {
  format: string;
  version: number;
  sourceSize: number;
  sourceHash: string;
  animationCount: number;
  totalEventCount: number;
  totalGroupCount: number;
  eventTypes: number[];
  authority: string;
  animations?: TaeAnimationSummary[];
}

export interface TaeWorkbenchPanelProps {
  resourceUri: string;
  data: TaeDocumentData | null;
}

/**
 * TAE 动画事件只读面板：显示动画列表、事件类型和统计信息。
 */
export function TaeWorkbenchPanel(props: TaeWorkbenchPanelProps): ReactElement {
  const [query, setQuery] = useState('');
  const [selectedAnimId, setSelectedAnimId] = useState<number | null>(null);
  const data = props.data;

  const filtered = useMemo(() => {
    if (!data?.animations) return [];
    const q = query.trim().toLowerCase();
    if (!q) return data.animations;
    return data.animations.filter(
      (a) => String(a.animId).includes(q) || (a.hkxName ?? '').toLowerCase().includes(q)
    );
  }, [data?.animations, query]);

  const selected = data?.animations?.find((a) => a.animId === selectedAnimId) ?? null;

  return (
    <section className="panel" aria-label="TAE 动画事件面板">
      <header className="panel-header">
        <h3>TAE 动画事件 · V0.6 只读预览</h3>
        <span className="muted">
          {data ? `${data.animationCount} anims · ${data.totalEventCount} events · ${data.authority}` : '未加载'}
        </span>
      </header>
      <p className="muted" role="note">
        TAE 编辑已延期至 V0.6：本面板为只读预览，不属于 V0.5 发布编辑器清单。
      </p>
      {!data && <p className="muted">选择 .tae 文件以查看动画事件数据。</p>}
      {data && (
        <>
          <div className="row gap">
            <input
              className="input"
              placeholder="搜索动画 ID 或 HKX 名称…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="row gap" style={{ marginTop: 8 }}>
            <div style={{ flex: 1, overflowY: 'auto', maxHeight: 300 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>动画 ID</th>
                    <th>事件</th>
                    <th>组</th>
                    <th>时间</th>
                    <th>HKX</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, 200).map((anim) => (
                    <tr
                      key={anim.animId}
                      className={anim.animId === selectedAnimId ? 'selected' : ''}
                      onClick={() => setSelectedAnimId(anim.animId)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td>{anim.animId}</td>
                      <td>{anim.eventCount}</td>
                      <td>{anim.groupCount}</td>
                      <td>{anim.timesCount}</td>
                      <td className="muted">{anim.hkxName ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {selected && (
              <div style={{ width: 280, padding: 8 }}>
                <h4>动画 {selected.animId}</h4>
                <dl>
                  <dt>事件数</dt><dd>{selected.eventCount}</dd>
                  <dt>事件组</dt><dd>{selected.groupCount}</dd>
                  <dt>时间值</dt><dd>{selected.timesCount}</dd>
                  <dt>HKX 文件</dt><dd>{selected.hkxName ?? '—'}</dd>
                </dl>
              </div>
            )}
          </div>
          <div className="row gap" style={{ marginTop: 8 }}>
            <span className="muted">
              事件类型：{data.eventTypes?.slice(0, 20).join(', ')}
              {(data.eventTypes?.length ?? 0) > 20 ? ` …共 ${data.eventTypes.length} 种` : ''}
            </span>
          </div>
        </>
      )}
    </section>
  );
}
