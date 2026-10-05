import { useMemo, useState, type ReactElement, type ReactNode } from 'react';
import {
  compareLoadedFields,
  compareLoadedSource,
  type LoadedFieldIdentity,
  type LoadedFieldValue
} from './loadedVersionDiff.js';

export function LoadedVersionComparison(props: {
  children: ReactNode;
  onExpandedChange?: (expanded: boolean) => void;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  return (
    <details className="loaded-comparison" open={expanded} onToggle={(event) => {
      const next = event.currentTarget.open;
      setExpanded(next);
      props.onExpandedChange?.(next);
    }}>
      <summary>与载入版本比较</summary>
      {expanded && <div className="loaded-comparison__body">{props.children}</div>}
    </details>
  );
}

function ComparisonLegend(): ReactElement {
  return <p className="loaded-comparison__legend"><span className="is-remove">− 载入版本</span><span className="is-add">+ 当前草稿</span></p>;
}

export function LoadedScriptComparison(props: { before: string; after: string }): ReactElement {
  const comparison = useMemo(() => compareLoadedSource(props.before, props.after), [props.before, props.after]);
  return (
    <>
      <ComparisonLegend />
      <p className="muted loaded-comparison__note">应用并重新载入后，比较基线更新。␍ 表示回车。</p>
      {comparison.lines.length === 0 ? <p className="muted">没有草稿差异。</p> : (
        <>
          {comparison.coarse && <p className="muted">修改范围较大，按整段显示增删。</p>}
          {comparison.omittedLines > 0 && <p className="muted">仅显示首尾部分，中间 {comparison.omittedLines} 行未显示。</p>}
          <div className="loaded-comparison__source" aria-label="源码载入版本与当前草稿差异">
            {comparison.lines.map((line, index) => (
              <div key={index} className={`loaded-comparison__line is-${line.kind}`}>
                <span className="loaded-comparison__number">{line.oldLine ?? ''}</span>
                <span className="loaded-comparison__number">{line.newLine ?? ''}</span>
                <span className="loaded-comparison__sign">{line.kind === 'remove' ? '−' : line.kind === 'add' ? '+' : ' '}</span>
                <span className="loaded-comparison__text">{line.text === '' ? '（空行）' : line.text.slice(0, 2000).replace(/\r/g, '␍')}{line.text.length > 2000 && <span className="muted">…（本行 {line.text.length - 2000} 字符未显示）</span>}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

export function LoadedFieldComparison(props: {
  fields: readonly LoadedFieldIdentity[];
  loaded: ReadonlyMap<string, LoadedFieldValue> | null;
  drafts: Readonly<Record<string, string>>;
}): ReactElement {
  const changes = compareLoadedFields(props.fields, props.loaded, props.drafts);
  return (
    <>
      <ComparisonLegend />
      <p className="muted loaded-comparison__note">先展开再编辑可查看草稿。失焦、枚举和勾选仍直接保存；保存并重新载入后，比较基线更新。</p>
      {props.loaded === null ? <p className="muted">选择有字段数据的行后可比较。</p>
        : changes.length === 0 ? <p className="muted">没有草稿差异。</p>
          : changes.map(change => (
            <div className="loaded-comparison__field" key={change.id}>
              <p className="loaded-comparison__field-name">{change.name} <span className="muted">{change.type}</span></p>
              <div className="loaded-comparison__line is-remove"><span className="loaded-comparison__sign">−</span><span className="loaded-comparison__text">{change.before === '' ? '（空串）' : change.before}</span></div>
              <div className="loaded-comparison__line is-add"><span className="loaded-comparison__sign">+</span><span className="loaded-comparison__text">{change.after === '' ? '（空串）' : change.after}</span></div>
            </div>
          ))}
    </>
  );
}
