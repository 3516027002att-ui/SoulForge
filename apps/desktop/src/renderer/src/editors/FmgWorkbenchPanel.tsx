import { useMemo, useState, type ReactElement } from 'react';

export interface FmgEntryRow {
  id: number;
  text: string;
  stringIndex?: number;
}

export interface FmgWorkbenchPanelProps {
  resourceUri: string;
  entries: FmgEntryRow[];
  onMutation?: (mutation: {
    kind: 'fmg_entry_upsert' | 'fmg_entry_delete' | 'fmg_entry_insert' | 'fmg_entry_reorder';
    id: number;
    text?: string;
    stringIndex?: number;
    beforeStringIndex?: number;
  }) => void;
}

/**
 * FMG 本地化工作台：筛选、编辑、增删条目；mutation 上抛给主进程/EditorDocumentStore。
 */
export function FmgWorkbenchPanel(props: FmgWorkbenchPanelProps): ReactElement {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState(props.entries);
  const [selectedKey, setSelectedKey] = useState<string | null>(
    props.entries[0] ? rowKey(props.entries[0]) : null
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => String(row.id).includes(q) || row.text.toLowerCase().includes(q));
  }, [rows, query]);
  const selected = rows.find((row) => rowKey(row) === selectedKey) ?? null;

  function updateText(text: string): void {
    if (!selected) return;
    setRows((prev) => prev.map((row) => (rowKey(row) === selectedKey ? { ...row, text } : row)));
  }

  function commitText(): void {
    if (!selected) return;
    if (selected.stringIndex === undefined) {
      // 本地草稿行：按当前已提交槽位数 append，走 typed insert。
      const insertIndex = rows.filter((row) => row.stringIndex !== undefined).length;
      props.onMutation?.({
        kind: 'fmg_entry_insert',
        id: selected.id,
        text: selected.text,
        stringIndex: insertIndex
      });
      return;
    }
    props.onMutation?.({
      kind: 'fmg_entry_upsert',
      id: selected.id,
      text: selected.text,
      stringIndex: selected.stringIndex
    });
  }

  function addEntry(): void {
    const id = (rows.reduce((max, row) => Math.max(max, row.id), 0) || 0) + 1;
    const next = { id, text: '' };
    setRows((prev) => [...prev, next]);
    setSelectedKey(rowKey(next));
    // 仅本地草稿；用户点击「提交文本」后才走 typed insert。
  }

  function deleteSelected(): void {
    if (!selected) return;
    const id = selected.id;
    const stringIndex = selected.stringIndex;
    if (stringIndex === undefined) {
      // Unsaved local drafts have no native slot and must not trigger an id-wide delete.
      setRows((prev) => prev.filter((row) => row.id !== id));
      setSelectedKey(null);
      return;
    }
    setRows((prev) => prev.filter((row) => row.stringIndex !== stringIndex));
    setSelectedKey(null);
    props.onMutation?.({ kind: 'fmg_entry_delete', id, stringIndex });
  }

  function moveSelected(direction: 'up' | 'down'): void {
    if (!selected || selected.stringIndex === undefined) return;
    const stringIndex = selected.stringIndex;
    const committedCount = rows.filter((row) => row.stringIndex !== undefined).length;
    if (direction === 'up') {
      if (stringIndex <= 0) return;
      props.onMutation?.({
        kind: 'fmg_entry_reorder',
        id: selected.id,
        stringIndex,
        beforeStringIndex: stringIndex - 1
      });
      return;
    }
    if (stringIndex >= committedCount - 1) return;
    const afterNextIndex = stringIndex + 2;
    props.onMutation?.({
      kind: 'fmg_entry_reorder',
      id: selected.id,
      stringIndex,
      ...(afterNextIndex < committedCount ? { beforeStringIndex: afterNextIndex } : {})
    });
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
        <button type="button" disabled={!selected} onClick={deleteSelected}>
          {selected?.stringIndex === undefined ? '删除草稿' : '删除选中槽位'}
        </button>
        <button
          type="button"
          disabled={selected?.stringIndex === undefined || selected.stringIndex <= 0}
          onClick={() => moveSelected('up')}
        >
          上移
        </button>
        <button
          type="button"
          disabled={selected?.stringIndex === undefined
            || selected.stringIndex >= rows.filter((row) => row.stringIndex !== undefined).length - 1}
          onClick={() => moveSelected('down')}
        >
          下移
        </button>
      </div>
      <div className="binder-child-table" role="table">
        <div className="binder-child-row binder-child-header" role="row">
          <span>ID</span>
          <span>文本</span>
        </div>
        {filtered.slice(0, 200).map((row) => (
          <div
            key={rowKey(row)}
            className="binder-child-row"
            role="row"
            onClick={() => setSelectedKey(rowKey(row))}
            style={rowKey(row) === selectedKey ? { background: '#243044' } : undefined}
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
          <button type="button" onClick={commitText}>提交文本</button>
        </label>
      )}
    </section>
  );
}

function rowKey(row: FmgEntryRow): string {
  return row.stringIndex === undefined ? `new:${row.id}` : `slot:${row.stringIndex}`;
}
