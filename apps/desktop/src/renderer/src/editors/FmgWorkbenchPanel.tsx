import { useMemo, useState, type ReactElement } from 'react';

export interface FmgEntryRow {
  id: number;
  text: string;
}

export interface FmgWorkbenchPanelProps {
  resourceUri: string;
  entries: FmgEntryRow[];
  onMutation?: (mutation: {
    kind: 'fmg_entry_upsert' | 'fmg_entry_delete';
    id: number;
    text?: string;
  }) => void;
}

/**
 * FMG 本地化工作台：筛选、编辑、增删条目；mutation 上抛给主进程/EditorDocumentStore。
 */
export function FmgWorkbenchPanel(props: FmgWorkbenchPanelProps): ReactElement {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState(props.entries);
  const [selectedId, setSelectedId] = useState<number | null>(props.entries[0]?.id ?? null);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => String(row.id).includes(q) || row.text.toLowerCase().includes(q));
  }, [rows, query]);
  const selected = rows.find((row) => row.id === selectedId) ?? null;

  function updateText(text: string): void {
    if (!selected) return;
    setRows((prev) => prev.map((row) => (row.id === selected.id ? { ...row, text } : row)));
    props.onMutation?.({ kind: 'fmg_entry_upsert', id: selected.id, text });
  }

  function addEntry(): void {
    const id = (rows.reduce((max, row) => Math.max(max, row.id), 0) || 0) + 1;
    const next = { id, text: '' };
    setRows((prev) => [...prev, next]);
    setSelectedId(id);
    props.onMutation?.({ kind: 'fmg_entry_upsert', id, text: '' });
  }

  function deleteSelected(): void {
    if (!selected) return;
    const id = selected.id;
    setRows((prev) => prev.filter((row) => row.id !== id));
    setSelectedId(null);
    props.onMutation?.({ kind: 'fmg_entry_delete', id });
  }

  return (
    <section className="panel" aria-label="FMG 本地化工作台">
      <header className="panel-header">
        <h3>FMG 本地化工作台</h3>
        <span className="muted">{rows.length} 条 · {props.resourceUri}</span>
      </header>
      <div className="row gap">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="筛选 ID 或文本"
          aria-label="筛选 FMG"
        />
        <button type="button" onClick={addEntry}>新增</button>
        <button type="button" disabled={!selected} onClick={deleteSelected}>删除</button>
      </div>
      <div className="binder-child-table" role="table">
        <div className="binder-child-row binder-child-header" role="row">
          <span>ID</span>
          <span>文本</span>
        </div>
        {filtered.slice(0, 200).map((row) => (
          <div
            key={row.id}
            className="binder-child-row"
            role="row"
            onClick={() => setSelectedId(row.id)}
            style={row.id === selectedId ? { background: '#243044' } : undefined}
          >
            <span>{row.id}</span>
            <span>{row.text.slice(0, 80)}</span>
          </div>
        ))}
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
