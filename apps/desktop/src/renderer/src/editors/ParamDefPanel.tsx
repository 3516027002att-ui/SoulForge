import { useMemo, useState, type ReactElement } from 'react';

export interface ParamDefFieldView {
  id: string;
  name: string;
  type: string;
  offset: number;
  size: number;
  valuePreview?: string;
}

export interface ParamDefPanelProps {
  typeName: string;
  rowDataSize: number;
  origin: string;
  fields: ParamDefFieldView[];
  validationMessages?: string[];
  onFieldChange?: (fieldId: string, value: string) => void;
}

/**
 * 参数结构定义查看/字段编辑骨架。
 * 官方游戏适配包只读；用户派生结构定义才能改字段布局。
 */
export function ParamDefPanel(props: ParamDefPanelProps): ReactElement {
  const [selectedId, setSelectedId] = useState<string | null>(props.fields[0]?.id ?? null);
  const selected = useMemo(
    () => props.fields.find((f) => f.id === selectedId) ?? null,
    [props.fields, selectedId]
  );
  const [draft, setDraft] = useState(selected?.valuePreview ?? '');

  return (
    <section className="panel" aria-label="参数结构定义">
      <header className="panel-header">
        <h3>参数结构定义：{props.typeName}</h3>
        <span className="muted">
          行大小 {props.rowDataSize} · 来源 {originLabel(props.origin)} · {fieldsCountLabel(props.fields.length)}
        </span>
      </header>
      {props.validationMessages && props.validationMessages.length > 0 && (
        <div className="save-diagnostics">
          {props.validationMessages.map((message) => (
            <span key={message}>{message}</span>
          ))}
        </div>
      )}
      <div className="binder-child-table" role="table">
        <div className="binder-child-row binder-child-header" role="row">
          <span>字段</span>
          <span>类型</span>
          <span>偏移</span>
          <span>预览</span>
        </div>
        {props.fields.map((field) => (
          <div
            key={field.id}
            className="binder-child-row"
            role="row"
            onClick={() => {
              setSelectedId(field.id);
              setDraft(field.valuePreview ?? '');
            }}
          >
            <span>{field.name}</span>
            <span className="muted">{field.type}</span>
            <span className="muted">0x{field.offset.toString(16)}/{field.size}</span>
            <span>{field.valuePreview ?? '—'}</span>
          </div>
        ))}
      </div>
      {selected && (
        <div className="stack gap">
          <label>
            编辑字段 {selected.name}
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label={`编辑 ${selected.name}`}
            />
          </label>
          <button
            type="button"
            onClick={() => props.onFieldChange?.(selected.id, draft)}
          >
            应用字段 mutation
          </button>
          <p className="muted">mutation 须经补丁引擎提交；结构定义修改不得写回官方游戏适配包。</p>
        </div>
      )}
    </section>
  );
}

function originLabel(origin: string): string {
  if (origin === 'user-derived') return '用户派生';
  if (origin === 'fixture') return '测试夹具';
  if (origin === 'imported') return '导入';
  return origin;
}

function fieldsCountLabel(count: number): string {
  return `${count} 个字段`;
}
