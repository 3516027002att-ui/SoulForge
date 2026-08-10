/**
 * 通用只读条目工作台：左条目列表 / 右属性表。
 *
 * ── 为什么做成通用组件 ──
 *
 * ESD（状态组）、TAE（动画）、TPF（贴图）三个面板的结构是同一个形状：
 * 一份文档摘要 + 一个条目列表 + 选中条目的字段表。此前各写一遍，结果是
 * 三种略有差异的表格与选择行为，而其中 ESD/TAE/TPF 三处的行选择都是
 * 裸 `<tr onClick>` —— 键盘完全不可达，且「漏的那一处」不会有任何信号。
 *
 * 这里把结构收敛成一个组件，行选择走共用的 selectableRowAttributes
 * （键盘契约由其单测锁定），各面板只提供「条目怎么投影成属性对」。
 *
 * ── 只读是设计而非欠缺 ──
 *
 * ESD/TAE/FLVER 已由治理层延期至 V0.6（shared 的
 * DEFERRED_PREVIEW_EDITOR_KINDS）。TPF 不在延期清单里，它的只读是另一回事
 * （写回链尚未接通），所以延期横幅由调用方按实际情况传入，本组件不替它们
 * 编造理由 —— 把「延期」和「未实现」混成一句话会让用户无法判断该等还是该报 bug。
 *
 * ── 分页 ──
 *
 * 硬约束 17。真实语料的条目数不可控（ESD 状态组、TAE 动画都可达数千），
 * 一次性建全部行会让首屏卡顿。只读浏览用分页足够，不需要虚拟滚动的手感。
 */

import { useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { isRowTabEntry, selectableRowAttributes } from '../a11y/selectableRow.js';
import { WorkbenchLayout, type WorkbenchColumnSpec } from './WorkbenchLayout.js';

/** 属性对：标签 + 已格式化的值。顺序即显示顺序。 */
export type ReadOnlyPropertyPair = readonly [label: string, value: string];

export interface ReadOnlyEntry {
  /** 稳定标识（React key 与选择状态用）。 */
  id: string;
  /** 主显示文本。 */
  label: string;
  /** 次要文本，右对齐显示（例如条目数、尺寸）。 */
  meta?: string;
  /** 选中后在右栏展示的字段。 */
  properties: ReadOnlyPropertyPair[];
}

export interface ReadOnlyEntryWorkbenchProps {
  /** 工作台可访问名，例如「ESD 状态机工作台」。 */
  label: string;
  /** 工具条面包屑左侧的类别名。 */
  kindLabel: string;
  /** 文档级摘要，显示在工具条右侧。 */
  summary?: string;
  /** 条目栏标题，例如「State Groups」。 */
  entriesTitle: string;
  /** 属性栏标题，默认 Properties。 */
  propertiesTitle?: string;
  entries: ReadOnlyEntry[];
  /** 筛选框占位文案。 */
  filterPlaceholder: string;
  /** 非空时显示延期标记与说明。 */
  deferredPreviewRelease?: 'V0.6';
  /**
   * 只读原因说明（延期之外的情形，例如写回链未接通）。
   * 与 deferredPreviewRelease 互不替代 —— 两者含义不同。
   */
  readOnlyNote?: string;
  /** 条目栏底部的附加内容（例如文档级统计）。 */
  footer?: ReactNode;
  /** 未加载时的提示。 */
  emptyHint: string;
}

const ENTRY_PAGE_SIZE = 100;

export function ReadOnlyEntryWorkbench(props: ReadOnlyEntryWorkbenchProps): ReactElement {
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return props.entries;
    return props.entries.filter((entry) =>
      entry.label.toLowerCase().includes(needle)
      || (entry.meta ?? '').toLowerCase().includes(needle));
  }, [props.entries, filter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / ENTRY_PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const visible = useMemo(
    () => filtered.slice(clampedPage * ENTRY_PAGE_SIZE, (clampedPage + 1) * ENTRY_PAGE_SIZE),
    [filtered, clampedPage]
  );
  const selected = useMemo(
    () => props.entries.find((entry) => entry.id === selectedId) ?? null,
    [props.entries, selectedId]
  );

  const columns: WorkbenchColumnSpec[] = [
    {
      id: 'entries',
      title: props.entriesTitle,
      hint: props.entries.length > 0 ? `${filtered.length}/${props.entries.length}` : '',
      initialWidth: 320,
      minWidth: 200,
      children: (
        <div className="wb-list">
          {props.entries.length === 0 && <p className="wb-empty">{props.emptyHint}</p>}
          {props.entries.length > 0 && (
            <>
              <div style={{ padding: '4px 8px' }}>
                <input
                  value={filter}
                  onChange={(event) => {
                    setFilter(event.target.value);
                    setPage(0);
                  }}
                  placeholder={props.filterPlaceholder}
                  aria-label={props.filterPlaceholder}
                  style={{ width: '100%' }}
                />
              </div>
              {pageCount > 1 && (
                <div style={{ padding: '0 8px 4px', display: 'flex', gap: 6, alignItems: 'center' }}>
                  <button
                    type="button"
                    className="secondary-action"
                    disabled={clampedPage <= 0}
                    onClick={() => setPage((current) => Math.max(0, current - 1))}
                  >上一页</button>
                  <span className="muted" style={{ fontSize: 11 }}>{clampedPage + 1}/{pageCount}</span>
                  <button
                    type="button"
                    className="secondary-action"
                    disabled={clampedPage >= pageCount - 1}
                    onClick={() => setPage((current) => current + 1)}
                  >下一页</button>
                </div>
              )}
              {visible.length === 0 && <p className="wb-empty">无匹配条目。</p>}
              {visible.map((entry, index) => (
                <div
                  key={entry.id}
                  className="wb-row"
                  {...selectableRowAttributes({
                    selected: selectedId === entry.id,
                    isTabEntry: isRowTabEntry(index, selectedId !== null),
                    onSelect: () => setSelectedId(entry.id)
                  })}
                >
                  <span className="wb-row__name" title={entry.label}>{entry.label}</span>
                  {entry.meta && <span className="wb-row__meta">{entry.meta}</span>}
                </div>
              ))}
            </>
          )}
        </div>
      )
    },
    {
      id: 'properties',
      title: props.propertiesTitle ?? 'Properties',
      hint: selected ? `${selected.properties.length} 项` : '',
      minWidth: 220,
      children: (
        <div className="wb-props">
          {selected === null && <p className="wb-empty">先在左栏选择条目。</p>}
          {/* 只读值用 readOnly input 而不是 span：用户要能选中复制。
              这些面板的全部价值就是「看这个条目的数值」，而看完通常要抄走 ——
              span 里的文本在表格里不易选中，disabled input 完全不能选。 */}
          {selected?.properties.map(([label, value]) => (
            <div className="wb-prop" key={label}>
              <span className="wb-prop__name" title={label}>{label}</span>
              <span className="wb-prop__value">
                <input
                  className="is-readonly"
                  value={value === '' ? '—' : value}
                  readOnly
                  aria-label={`${label}（只读）`}
                  aria-readonly="true"
                  title={value}
                />
              </span>
            </div>
          ))}
        </div>
      )
    }
  ];

  const footerParts: ReactNode[] = [];
  if (props.deferredPreviewRelease) {
    footerParts.push(
      <span key="deferred" className="muted" style={{ fontSize: 11 }} role="note">
        {props.kindLabel}编辑已延期至 {props.deferredPreviewRelease}：本版仅提供只读浏览，
        不提供提交入口。
      </span>
    );
  }
  if (props.readOnlyNote) {
    footerParts.push(
      <span key="readonly" className="muted" style={{ fontSize: 11 }}>{props.readOnlyNote}</span>
    );
  }
  if (props.footer) footerParts.push(<div key="extra">{props.footer}</div>);

  return (
    <WorkbenchLayout
      label={props.label}
      columns={columns}
      toolbar={
        <>
          <span className="crumb"><b>{props.kindLabel}</b></span>
          {props.summary && (
            <span className="muted" style={{ fontSize: 11 }}>{props.summary}</span>
          )}
          <span className="toolbar-spacer" style={{ flex: 1 }}></span>
          {props.deferredPreviewRelease && (
            <span className="pill pill--warn">{props.deferredPreviewRelease} 只读</span>
          )}
        </>
      }
      {...(footerParts.length > 0
        ? {
            footer: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{footerParts}</div>
            )
          }
        : {})}
    />
  );
}
