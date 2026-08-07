/**
 * FMG 文本表编辑器。
 *
 * 从 App.tsx 尾部原样搬出（纯搬移，无逻辑改动）。EditableMsgRow 类型与行解析/
 * 序列化 helper 一并移到 format/msgRows.ts，因为它们是同一组关注点：把预览里的
 * 文本条目变成可编辑行、再变回规范 TSV。
 */
import type { ReactElement } from 'react';
import type { EditableMsgRow } from '../format/msgRows.js';

export function MsgTableEditor({
  rows,
  onAdd,
  onRemove,
  onUpdate
}: {
  rows: EditableMsgRow[];
  onAdd: () => void;
  onRemove: (index: number) => void;
  onUpdate: (index: number, patch: Partial<EditableMsgRow>) => void;
}): ReactElement {
  return (
    <section className="msg-table-editor">
      <div className="msg-table-toolbar">
        <strong>FMG 文本表</strong>
        <button type="button" onClick={onAdd}>新增文本</button>
      </div>
      <div className="msg-table-grid msg-table-header">
        <span>ID</span>
        <span>Text</span>
        <span>Action</span>
      </div>
      {rows.map((row, index) => (
        <div className="msg-table-grid" key={`${row.textId}-${index}`}>
          <input
            value={row.textId}
            onChange={(event) => onUpdate(index, { textId: event.target.value })}
            aria-label="text id"
          />
          <textarea
            value={row.text}
            onChange={(event) => onUpdate(index, { text: event.target.value })}
            aria-label="text value"
          />
          <button type="button" onClick={() => onRemove(index)}>删除</button>
        </div>
      ))}
      <p className="muted">表格编辑会同步生成规范 TSV 文本；保存仍走 Patch Engine，并会自动备份原文件。</p>
    </section>
  );
}

