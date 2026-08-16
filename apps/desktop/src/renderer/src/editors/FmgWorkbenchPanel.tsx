import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { FMG_PAGE_SIZE } from '@soulforge/shared';
import type { FmgEntryPage } from '@soulforge/shared';
import type { SoulForgeApi } from '../../../preload/index.js';
import { getRendererBridge } from '../runtime/rendererRuntime.js';
import { isRowTabEntry, selectableRowAttributes } from '../a11y/selectableRow.js';
import { WorkbenchLayout, type WorkbenchColumnSpec } from '../workbench/WorkbenchLayout.js';

/**
 * 目录响应类型：直接从 preload 的 `readTextCatalog` 返回类型推断，不重复声明
 * 一份结构（TEXT-20A 已把 languageId/containerId/tableId 做成 Bridge metadata，
 * renderer 只消费 typed ID，绝不自行从物理路径解析语言/容器）。
 */
type TextCatalogResponse = Awaited<ReturnType<NonNullable<SoulForgeApi['readTextCatalog']>>>;
type TextContainerNode = TextCatalogResponse['languages'][number]['containers'][number];

export interface FmgEntryRow {
  id: number;
  text: string;
}

export interface FmgWorkbenchPanelProps {
  resourceUri: string;
  /**
   * Demo/fallback entries。只在 live 目录不可用时按条目渲染（browser-preview）。
   * Live 模式下面板经 `readTextCatalog` + `readFmgTablePage` 走 Bridge 目录链，
   * 不再消费本 prop —— 选择链每一级都有 typed ID。
   */
  entries: FmgEntryRow[];
  /** True when the source is a live Bridge FMG document (catalog-fetchable). */
  live?: boolean;
  onMutation?: (mutation: {
    kind: 'fmg_entry_upsert' | 'fmg_entry_delete' | 'fmg_entry_add';
    id: number;
    text?: string;
    /** 选中表 typed ID（TEXT-20C 容器写路由用）；demo 模式无选中表时缺省。 */
    tableId?: string;
  }) => void;
}

/*
 * 分页页大小（硬约束 17）来自 @soulforge/shared，与主进程 `resource.readFmgTablePage`
 * 用同一常量。此前两侧各写一遍 100，改一侧不报错，症状是分页错位或末页重复。
 */

/**
 * FMG 本地化工作台（TEXT-20B；S13 对照 Smithbox Text Editor 三列竖排）：
 *
 *   Text Categories | Text Entries | Text（三列，各自独立滚动）
 *
 * Categories 是「语言筛选在顶上 + 表名平铺」：表名是 main 投影的逻辑名
 * （basename 去 .fmg，同名加序号），绝不用路径打码占位当表名；没有缩进树、
 * 没有左栏底下空 Tools。
 *
 * ── 选择链 ──
 *
 * language（语言银行）→ container（item/menu msgbnd）→ table（FMG 表）→
 * entry → content。languageId/containerId/tableId 全部来自 Bridge
 * `read-text-catalog` 的 metadata（TEXT-20A Flow）；renderer 不解析物理
 * 路径、不构造 typed ID。从 Files 领域点开具体 msgbnd 时自动定位到该容器
 * 的第一个表，让「选文件即见条目」的既有入口继续成立。
 *
 * ── 失败语义 ──
 *
 * · 目录读取失败 / 容器读取失败 → 结构化诊断（danger），绝不被伪装成空表；
 * · 表读取失败 → `!result.ok` 只上抛诊断并清空当前页，绝不回退 demo entries；
 * · 真空表（ok 且 0 条）→ muted「当前页无条目」；无匹配（有查询）→
 *   muted「没有匹配的条目」——三个空态分离，不共用一个渲染分支。
 *
 * ── 写入 ──
 *
 * 编辑 / 新增 / 删除只以 typed mutation 上抛给 App（fmg_entry_*），经审查
 * 队列在 App 侧落 Patch；面板内没有 bytes replace fallback。
 * Tools 栏保持诚实空态（TEXT-20C 才接线深层写链）。
 */
export function FmgWorkbenchPanel(props: FmgWorkbenchPanelProps): ReactElement {
  const bridge = getRendererBridge();
  const liveMode = props.live === true
    && bridge !== null
    && typeof bridge.readTextCatalog === 'function'
    && typeof bridge.readFmgTablePage === 'function';

  // ── 目录（language → container → table）──
  const [catalog, setCatalog] = useState<TextCatalogResponse | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  // ── 选择链：三级 typed ID ──
  const [selectedLanguageId, setSelectedLanguageId] = useState<string | null>(null);
  const [selectedContainerId, setSelectedContainerId] = useState<string | null>(null);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);

  // ── 左树搜索（§9.3 每区搜索）：只过滤目录行显示，不动选择链 ──
  const [treeQuery, setTreeQuery] = useState('');

  // ── 条目分页（与 `resource.readFmgTablePage` 的窗口对应）──
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [pageEntries, setPageEntries] = useState<FmgEntryRow[]>([]);
  const [pageCount, setPageCount] = useState(1);
  const [entryCount, setEntryCount] = useState(0);
  const [maxId, setMaxId] = useState(0);
  const [loading, setLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // ── 目录加载：唯一入口是 Bridge readTextCatalog ──
  useEffect(() => {
    if (!liveMode || bridge === null) return;
    let cancelled = false;
    setCatalogLoading(true);
    setCatalogError(null);
    bridge.readTextCatalog()
      .then((result: TextCatalogResponse) => {
        if (cancelled) return;
        setCatalogLoading(false);
        if (result.ok) {
          setCatalog(result);
          // 从 Files 领域打开时自动定位到该容器第一个表；不命中则保持未选，
          // 用户手动走语言 → 容器 → 表链。
          if (props.resourceUri) {
            for (const language of result.languages) {
              for (const container of language.containers) {
                if (container.sourceUri === props.resourceUri && container.tables.length > 0) {
                  setSelectedLanguageId(language.languageId);
                  setSelectedContainerId(container.containerId);
                  setSelectedTableId(container.tables[0]!.tableId);
                  return;
                }
              }
            }
          }
          // S13：语言是 Categories 顶上筛选；没命中资源定位时默认第一个语言。
          if (result.languages.length > 0 && selectedLanguageId === null) {
            setSelectedLanguageId(result.languages[0]!.languageId);
          }
        } else {
          setCatalogError(result.diagnostics?.[0]?.message ?? '文本目录读取失败。');
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setCatalogLoading(false);
        setCatalogError(error instanceof Error ? error.message : '文本目录读取异常。');
      });
    return () => { cancelled = true; };
  }, [liveMode, bridge, props.resourceUri]);

  // ── 父级切换清理：逐级清空下游选择与状态，杜绝跨表残留 ──
  function handleSelectLanguage(languageId: string): void {
    if (languageId === selectedLanguageId) return;
    setSelectedLanguageId(languageId);
    setSelectedContainerId(null);
    setSelectedTableId(null);
    setSelectedId(null);
    setPage(0);
    setQuery('');
    setPageEntries([]);
    setPageError(null);
  }

  function handleSelectContainer(containerId: string): void {
    if (containerId === selectedContainerId) return;
    setSelectedContainerId(containerId);
    setSelectedTableId(null);
    setSelectedId(null);
    setPage(0);
    setQuery('');
    setPageEntries([]);
    setPageError(null);
  }

  function handleSelectTable(tableId: string): void {
    if (tableId === selectedTableId) return;
    setSelectedTableId(tableId);
    setSelectedId(null);
    setPage(0);
    setQuery('');
    setPageEntries([]);
    setPageError(null);
  }

  // ── 选中表：条目分页读取（query 在 main 端作用于完整表，覆盖所有页）──
  useEffect(() => {
    if (!liveMode || bridge === null || selectedTableId === null) return;
    let cancelled = false;
    setLoading(true);
    setPageError(null);
    bridge.readFmgTablePage(selectedTableId, page, FMG_PAGE_SIZE, query)
      .then((result: FmgEntryPage) => {
        if (cancelled) return;
        if (!result.ok) {
          // parse failure：只上抛诊断、绝不返回「0 条空表」伪装成功
          //（TEXT-20A Done 禁止）。demo 回退被 liveMode 挡在门外。
          setPageError(result.diagnostics?.[0]?.message ?? 'FMG 表分页读取失败。');
          setPageEntries([]);
        } else {
          setPageEntries(result.entries);
          setPageCount(result.pageCount);
          setEntryCount(result.entryCount);
          setMaxId(result.maxId);
          setPage(result.page);
          setPageError(null);
        }
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPageError(error instanceof Error ? error.message : 'FMG 表分页读取异常。');
        setPageEntries([]);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [liveMode, bridge, selectedTableId, page, query]);

  // ── Demo/fallback（无 live 目录：browser-preview）──
  const demoFiltered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return props.entries;
    return props.entries.filter(
      (row) => String(row.id).includes(q) || row.text.toLowerCase().includes(q)
    );
  }, [props.entries, query]);

  useEffect(() => {
    if (liveMode) return;
    const demoPageCount = Math.max(1, Math.ceil(demoFiltered.length / FMG_PAGE_SIZE));
    const clamped = Math.min(Math.max(0, page), demoPageCount - 1);
    const slice = demoFiltered.slice(
      clamped * FMG_PAGE_SIZE,
      clamped * FMG_PAGE_SIZE + FMG_PAGE_SIZE
    );
    setPageEntries(slice);
    setPageCount(demoPageCount);
    setEntryCount(demoFiltered.length);
    setMaxId(props.entries.reduce((max, row) => Math.max(max, row.id), 0));
    if (clamped !== page) setPage(clamped);
  }, [liveMode, demoFiltered, props.entries, page]);

  const selected = pageEntries.find((row) => row.id === selectedId) ?? null;
  const selectedContainer = useMemo(() => {
    if (!catalog || selectedLanguageId === null || selectedContainerId === null) return null;
    const language = catalog.languages.find((l) => l.languageId === selectedLanguageId);
    return language?.containers.find((c) => c.containerId === selectedContainerId) ?? null;
  }, [catalog, selectedLanguageId, selectedContainerId]);
  const containerFailed = selectedContainer?.parseStatus === 'failed';

  function updateText(text: string): void {
    if (selectedId === null) return;
    setPageEntries((prev) => prev.map((row) => (row.id === selectedId ? { ...row, text } : row)));
    props.onMutation?.({
      kind: 'fmg_entry_upsert',
      id: selectedId,
      text,
      ...(selectedTableId !== null ? { tableId: selectedTableId } : {})
    });
  }

  function addEntry(): void {
    if (selectedTableId === null) return;
    const id = maxId + 1;
    setPageEntries((prev) => [...prev, { id, text: '' }]);
    setMaxId(id);
    setSelectedId(id);
    props.onMutation?.({ kind: 'fmg_entry_add', id, text: '', tableId: selectedTableId });
  }

  function deleteSelected(): void {
    if (selectedId === null) return;
    const id = selectedId;
    setPageEntries((prev) => prev.filter((row) => row.id !== id));
    setSelectedId(null);
    props.onMutation?.({
      kind: 'fmg_entry_delete',
      id,
      ...(selectedTableId !== null ? { tableId: selectedTableId } : {})
    });
  }

  // ── 左栏 Categories（S13）：语言筛选在顶上，表名平铺为一行一表 ──
  // 不再用「语言 → 容器 → 表」缩进树把表名挤没，也不要左栏底下空 Tools。
  // 表名是 main 投影的逻辑名（shared logicalFmgTableName），renderer 不做二次解析。
  const selectedLanguage = catalog?.languages.find((l) => l.languageId === selectedLanguageId) ?? null;
  const categoryRows = useMemo(() => {
    if (!catalog || selectedLanguage === null) return [];
    const q = treeQuery.trim().toLowerCase();
    const rows: Array<{
      key: string;
      label: string;
      meta: string;
      title: string;
      failed: boolean;
      selected: boolean;
      onSelect: () => void;
    }> = [];
    for (const container of selectedLanguage.containers) {
      const contHit = !q || container.containerKind.toLowerCase().includes(q);
      if (container.parseStatus !== 'confirmed') {
        if (contHit) {
          rows.push({
            key: `container:${container.containerId}`,
            label: container.containerKind,
            meta: '读取失败',
            title: container.containerKind,
            failed: true,
            selected: selectedContainerId === container.containerId,
            onSelect: () => handleSelectContainer(container.containerId)
          });
        }
        continue;
      }
      for (const table of container.tables) {
        const label = table.entryName;
        if (q && !contHit && !label.toLowerCase().includes(q)) continue;
        rows.push({
          key: `table:${table.tableId}`,
          label,
          meta: `${container.containerKind} · ${table.entryCount} 条`,
          title: `${container.containerKind} / ${label}`,
          failed: false,
          selected: table.tableId === selectedTableId,
          onSelect: () => {
            // 选表即选其容器：容器读取失败/诊断跟随表所属容器。
            setSelectedContainerId(container.containerId);
            handleSelectTable(table.tableId);
          }
        });
      }
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, selectedLanguage, selectedLanguageId, selectedContainerId, selectedTableId, treeQuery]);

  const categoriesColumn = (
    <>
      <div className="fmg-categories__search">
        <label className="stack gap">
          <span className="muted">语言</span>
          <select
            value={selectedLanguageId ?? ''}
            onChange={(event) => handleSelectLanguage(event.target.value)}
            aria-label="文本语言"
          >
            {catalog?.languages.length === 0 && <option value="">无语言</option>}
            {catalog?.languages.map((language) => (
              <option key={language.languageId} value={language.languageId}>
                {language.languageId}（{language.containers.length} 容器）
              </option>
            ))}
          </select>
        </label>
        <input
          value={treeQuery}
          onChange={(e) => setTreeQuery(e.target.value)}
          placeholder="筛选表名 / 容器"
          aria-label="筛选文本表"
        />
      </div>
      <div className="wb-list">
        {catalogLoading && <p className="wb-empty">正在读取文本目录…</p>}
        {catalogError && <p className="wb-empty diag-error">{catalogError}</p>}
        {!catalogLoading && !catalogError && catalog === null && (
          <p className="wb-empty">文本目录需要桌面版才能读取。</p>
        )}
        {catalog && selectedLanguage === null && (
          <p className="wb-empty">先选择语言。</p>
        )}
        {categoryRows.map((row, index) => (
          <div
            key={row.key}
            className={row.failed ? 'wb-row wb-row--failed' : 'wb-row'}
            {...selectableRowAttributes({
              selected: row.selected,
              isTabEntry: isRowTabEntry(index, categoryRows.some((r) => r.selected)),
              onSelect: row.onSelect
            })}
          >
            <span className="wb-row__name" title={row.title}>{row.label}</span>
            <span className="wb-row__meta">{row.meta}</span>
          </div>
        ))}
        {catalog && !catalogLoading && categoryRows.length === 0 && (
          <p className="wb-empty">当前语言没有匹配的表。</p>
        )}
      </div>
    </>
  );

  // ── 中栏：分页条目表（真空表 / 无匹配 / 未选择三种空态分离）──  // ── 中栏：分页条目表（真空表 / 无匹配 / 未选择三种空态分离）──
  const hasSelection = selectedTableId !== null;
  const entriesColumn = (
    <>
      <div style={{ padding: '4px 8px', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
          placeholder="筛选 ID 或文本（作用于完整表）"
          aria-label="筛选 FMG"
          style={{ flex: 1, minWidth: 120 }}
        />
        <button
          type="button"
          className="secondary-action"
          disabled={!hasSelection}
          onClick={addEntry}
        >新增</button>
        <button
          type="button"
          className="secondary-action"
          disabled={selectedId === null}
          onClick={deleteSelected}
        >删除</button>
      </div>
      <div className="row gap pager" style={{ padding: '0 8px 4px' }}>
        <button
          type="button"
          className="secondary-action"
          disabled={page <= 0 || loading}
          onClick={() => setPage((p) => p - 1)}
        >
          上一页
        </button>
        <span className="muted">{pageCount > 0 ? page + 1 : 0}/{pageCount}</span>
        <button
          type="button"
          className="secondary-action"
          disabled={page >= pageCount - 1 || loading}
          onClick={() => setPage((p) => p + 1)}
        >
          下一页
        </button>
        {loading && <span className="muted">加载中…</span>}
      </div>
      {pageError && <p className="danger">{pageError}</p>}
      {containerFailed && (
        <p className="danger">
          {selectedContainer?.diagnostics?.[0]?.message ?? '该容器读取失败。'}
        </p>
      )}
      <div className="binder-child-table" role="table">
        <div className="binder-child-row binder-child-header" role="row">
          <span>ID</span>
          <span>文本</span>
        </div>
        {pageEntries.map((row, rowIndex) => (
          <div
            key={rowIndex}
            className="binder-child-row"
            {...selectableRowAttributes({
              selected: row.id === selectedId,
              isTabEntry: isRowTabEntry(rowIndex, selectedId !== null),
              onSelect: () => setSelectedId(row.id)
            })}
          >
            <span>{row.id}</span>
            <span>{row.text.slice(0, 80)}</span>
          </div>
        ))}
        {pageEntries.length === 0 && !loading && (
          hasSelection
            ? query.trim().length > 0
              ? <p className="muted">没有匹配的条目。</p>
              : <p className="muted">当前页无条目。</p>
            : <p className="muted">先选择语言与文本表。</p>
        )}
      </div>
    </>
  );

  const textColumn = selected ? (
    <div style={{ padding: '6px 10px', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <label className="stack gap" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        编辑 ID {selected.id}
        <textarea
          value={selected.text}
          onChange={(e) => updateText(e.target.value)}
          spellCheck={false}
          style={{ flex: 1, minHeight: 120, resize: 'none' }}
        />
      </label>
    </div>
  ) : (
    <p className="wb-empty">选择左侧条目后在此编辑文本。</p>
  );

  // ── §9.1 拓扑（S13）：Categories | Entries | Text 三列竖排，不是左树 +
  // 右上下两块，也不要左栏底下空 Tools ──
  const columns: WorkbenchColumnSpec[] = [
    {
      id: 'categories',
      title: 'Text Categories',
      hint: catalog ? `${catalog.languages.length} languages` : '',
      initialWidth: 300,
      minWidth: 200,
      children: <div className="fmg-categories">{categoriesColumn}</div>
    },
    {
      id: 'entries',
      title: 'Text Entries',
      hint: selectedTableId !== null ? `${entryCount} 条` : '',
      initialFlex: 2,
      minWidth: 240,
      children: entriesColumn
    },
    {
      id: 'text',
      title: 'Text',
      initialFlex: 2,
      minWidth: 240,
      children: textColumn
    }
  ];

  return (
    <section className="panel" aria-label="FMG 本地化工作台">
      <WorkbenchLayout
        label="FMG 文本工作台"
        toolbar={
          <>
            <span className="crumb"><b>文本</b></span>
            <span className="muted" style={{ fontSize: 11 }}>
              {catalog
                ? `${catalog.title}`
                : `${entryCount} 条 · 每页 ${FMG_PAGE_SIZE}`}
            </span>
          </>
        }
        columns={columns}
      />
    </section>
  );
}
