import { useMemo, useState, type ReactElement } from 'react';

export interface EsdStateGroupSummary {
  groupId: number;
  stateCount: number;
}

export interface EsdDocumentData {
  format: string;
  version: number;
  sourceSize: number;
  sourceHash: string;
  stateGroupCount: number;
  stateCount: number;
  conditionCount: number;
  commandCallCount: number;
  commandArgCount: number;
  commandBanks: number[];
  authority: string;
  stateGroups?: EsdStateGroupSummary[];
}

export interface EsdWorkbenchPanelProps {
  resourceUri: string;
  data: EsdDocumentData | null;
}

/**
 * ESD 状态机只读面板：显示状态组、条件和命令统计。
 */
export function EsdWorkbenchPanel(props: EsdWorkbenchPanelProps): ReactElement {
  const [query, setQuery] = useState('');
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null);
  const data = props.data;

  const filtered = useMemo(() => {
    if (!data?.stateGroups) return [];
    const q = query.trim().toLowerCase();
    if (!q) return data.stateGroups;
    return data.stateGroups.filter((g) => String(g.groupId).includes(q));
  }, [data?.stateGroups, query]);

  const selected = data?.stateGroups?.find((g) => g.groupId === selectedGroupId) ?? null;

  return (
    <section className="panel" aria-label="ESD 状态机面板">
      <header className="panel-header">
        <h3>ESD 状态机 · V0.6 只读预览</h3>
        <span className="muted">
          {data
            ? `${data.stateGroupCount} groups · ${data.stateCount} states · ${data.conditionCount} conds · ${data.authority}`
            : '未加载'}
        </span>
      </header>
      <p className="muted" role="note">
        ESD 编辑已延期至 V0.6：本面板为只读预览，不属于 V0.5 发布编辑器清单。
      </p>
      {!data && <p className="muted">选择 .esd 文件以查看状态机数据。</p>}
      {data && (
        <>
          <div className="row gap">
            <input
              className="input"
              placeholder="搜索状态组 ID…"
              aria-label="搜索状态组 ID"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="row gap" style={{ marginTop: 8 }}>
            <div style={{ flex: 1, overflowY: 'auto', maxHeight: 300 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>状态组 ID</th>
                    <th>状态数</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, 200).map((group) => (
                    <tr
                      key={group.groupId}
                      className={group.groupId === selectedGroupId ? 'selected' : ''}
                      onClick={() => setSelectedGroupId(group.groupId)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td>{group.groupId}</td>
                      <td>{group.stateCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {selected && (
              <div style={{ width: 280, padding: 8 }}>
                <h4>状态组 {selected.groupId}</h4>
                <dl>
                  <dt>状态数</dt><dd>{selected.stateCount}</dd>
                </dl>
              </div>
            )}
          </div>
          <div className="row gap" style={{ marginTop: 8 }}>
            <span className="muted">
              命令 banks：{data.commandBanks?.join(', ') ?? '—'} ·
              命令调用：{data.commandCallCount} ·
              命令参数：{data.commandArgCount}
            </span>
          </div>
        </>
      )}
    </section>
  );
}
