/**
 * MSB 地图数据工作台（对照 Smithbox 2.2.4 的 Map Data Editor）。
 *
 * 左：Base Categories —— Model / Event / Region / Part
 * 中：Entries         —— 该类别下的条目
 * 右：Properties      —— 选中条目的字段
 *
 * ── 与 MsbScenePanel 的分工 ──
 *
 * MsbScenePanel 是三维代理场景（看空间关系），本组件是属性表（看数值）。
 * 截图里 Smithbox 的 Map Data Editor 是后者，而此前 SoulForge 只有前者 ——
 * 于是「地图里这个 ObjAct 的 Entity ID 是多少」这类问题在界面上无从回答。
 * 两者并存，不互相替代。
 *
 * ── 只读浏览，写入在 MsbScenePanel ──
 *
 * MSB 写入已由 S36 开闸（write-msb → Patch Engine），但提交入口在姊妹组件
 * MsbScenePanel（三维代理场景：part/region 位置微调与 part transform）。
 * 本组件是属性对照表，专注只读浏览；属性值以只读呈现，不重复造第二套
 * 提交入口——改数值交给场景面板的 typed mutation，这里不假装能编辑。
 */

import { useMemo, useState, type ReactElement } from 'react';
import { isRowTabEntry, selectableRowAttributes } from '../a11y/selectableRow.js';
import { WorkbenchLayout, type WorkbenchColumnSpec } from './WorkbenchLayout.js';

/** 一个条目的可展示字段对。顺序即显示顺序。 */
type PropertyPair = readonly [label: string, value: string];

export interface MsbEntryLike {
  /** 条目名（Smithbox 的 Name 列）。 */
  name: string;
  /** 属性对，由调用方按类别投影。 */
  properties: PropertyPair[];
}

export interface MsbDataWorkbenchProps {
  /** 资源相对路径，用于面包屑。 */
  sourcePath: string;
  /** 各类别的条目。键即左栏类别名。 */
  categories: Array<{ id: string; label: string; entries: MsbEntryLike[] }>;
}

/**
 * 条目渲染上限。
 *
 * 硬约束 17：大表必须分页/虚拟化。真实 MSB 的 part 数可达数千，一次性建出
 * 全部行会让首屏卡顿。这里用分页而非虚拟滚动 —— 分页的实现面小得多，
 * 而本组件是只读浏览，不需要连续滚动的手感。
 */
const ENTRY_PAGE_SIZE = 100;

export function MsbDataWorkbench(props: MsbDataWorkbenchProps): ReactElement {
  const [categoryId, setCategoryId] = useState<string | null>(
    props.categories.find((category) => category.entries.length > 0)?.id ?? null
  );
  const [entryFilter, setEntryFilter] = useState('');
  const [entryPage, setEntryPage] = useState(0);
  const [selectedName, setSelectedName] = useState<string | null>(null);

  const activeCategory = useMemo(
    () => props.categories.find((category) => category.id === categoryId) ?? null,
    [props.categories, categoryId]
  );

  const filteredEntries = useMemo(() => {
    const entries = activeCategory?.entries ?? [];
    const needle = entryFilter.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((entry) => entry.name.toLowerCase().includes(needle));
  }, [activeCategory, entryFilter]);

  const pageCount = Math.max(1, Math.ceil(filteredEntries.length / ENTRY_PAGE_SIZE));
  const clampedPage = Math.min(entryPage, pageCount - 1);
  const visibleEntries = useMemo(
    () => filteredEntries.slice(clampedPage * ENTRY_PAGE_SIZE, (clampedPage + 1) * ENTRY_PAGE_SIZE),
    [filteredEntries, clampedPage]
  );

  const selectedEntry = useMemo(
    () => filteredEntries.find((entry) => entry.name === selectedName) ?? null,
    [filteredEntries, selectedName]
  );

  const columns: WorkbenchColumnSpec[] = [
    {
      id: 'categories',
      title: 'Base Categories',
      // 0.2 / 0.4 / 0.4：直接采用参照工具地图数据编辑器的那组初值 ——
      // 它是那份实现里唯一写死栏宽比例的地方（其余编辑器交给 docking 运行时），
      // 说明这组比例是针对这三栏内容量刻意选的。用比例而非固定像素：
      // 窗口缩放时能跟随。
      initialFlex: 0.2,
      minWidth: 120,
      children: (
        <div className="wb-list">
          {props.categories.map((category, index) => (
            <div
              key={category.id}
              className="wb-row"
              {...selectableRowAttributes({
                selected: categoryId === category.id,
                isTabEntry: isRowTabEntry(index, categoryId !== null),
                onSelect: () => {
                  setCategoryId(category.id);
                  setEntryPage(0);
                  setEntryFilter('');
                  setSelectedName(null);
                }
              })}
            >
              <span className="wb-row__name">{category.label}</span>
              <span className="wb-row__meta">{category.entries.length}</span>
            </div>
          ))}
        </div>
      )
    },
    {
      id: 'entries',
      title: 'Entries',
      hint: activeCategory ? `${filteredEntries.length}/${activeCategory.entries.length}` : '',
      initialFlex: 0.4,
      minWidth: 180,
      children: (
        <div className="wb-list">
          {activeCategory === null && <p className="wb-empty">先在左栏选择类别。</p>}
          {activeCategory !== null && (
            <>
              <div style={{ padding: '4px 8px' }}>
                <input
                  value={entryFilter}
                  onChange={(event) => {
                    setEntryFilter(event.target.value);
                    setEntryPage(0);
                  }}
                  placeholder="筛选条目名"
                  aria-label={`筛选 ${activeCategory.label} 条目`}
                  style={{ width: '100%' }}
                />
              </div>
              {pageCount > 1 && (
                <div style={{ padding: '0 8px 4px', display: 'flex', gap: 6, alignItems: 'center' }}>
                  <button
                    type="button"
                    className="secondary-action"
                    disabled={clampedPage <= 0}
                    onClick={() => setEntryPage((page) => Math.max(0, page - 1))}
                  >上一页</button>
                  <span className="muted" style={{ fontSize: 11 }}>{clampedPage + 1}/{pageCount}</span>
                  <button
                    type="button"
                    className="secondary-action"
                    disabled={clampedPage >= pageCount - 1}
                    onClick={() => setEntryPage((page) => page + 1)}
                  >下一页</button>
                </div>
              )}
              {visibleEntries.length === 0 && <p className="wb-empty">无匹配条目。</p>}
              {visibleEntries.map((entry, index) => (
                <div
                  key={`${entry.name}:${index}`}
                  className="wb-row"
                  {...selectableRowAttributes({
                    selected: selectedName === entry.name,
                    isTabEntry: isRowTabEntry(index, selectedName !== null),
                    onSelect: () => setSelectedName(entry.name)
                  })}
                >
                  <span className="wb-row__name" title={entry.name}>{entry.name}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )
    },
    {
      id: 'properties',
      title: 'Properties',
      hint: selectedEntry ? `${selectedEntry.properties.length} 项` : '',
      initialFlex: 0.4,
      minWidth: 220,
      children: (
        <div className="wb-props">
          {selectedEntry === null && <p className="wb-empty">先在中栏选择条目。</p>}
          {/* 只读值用 readOnly input 而不是 span：MSB 属性（Entity ID、Part Name、
              坐标）最常见的用途就是抄到别处对照，必须能选中复制。 */}
          {selectedEntry?.properties.map(([label, value]) => (
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

  return (
    <WorkbenchLayout
      label="MSB 地图数据工作台"
      columns={columns}
    />
  );
}
