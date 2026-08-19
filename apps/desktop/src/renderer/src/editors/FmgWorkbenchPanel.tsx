import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
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

/**
 * S30：FMG 文本的显示投影（011833）。
 *
 * FMG 字符串池里 `<?...?>` 是文件真实字节 —— 游戏用它嵌入图标 / 地名 /
 * BMSG 等引用（packages/core 的 fmgReferenceIntegrity 记录同一语法），
 * 不是脏数据。列表里原样显示会被当成乱码正文；这里只投影**显示层**，
 * 编辑框仍保留原文（写回保真，用户可编辑标签本身）。
 *
 * 投影规则：
 *   `<?null?>`        → 空（「无内容」标记 = 空槽/空串，地名表 47 槽里
 *                       1100、1102–1120 等 offset=0 空槽就是它）
 *   `<?placeName@N?>` → [地名 N]
 *   `<?kgiconKc@N?>`  → [图标 N]
 *   `<?bmsg?>`        → [BMSG]
 *   其他 `<?name@N?>` → [name N]
 */
const FMG_TAG_PATTERN = /<\?([A-Za-z][A-Za-z0-9_]*)(?:@(-?\d+))?\?>/g;

export function projectFmgDisplayText(text: string): string {
  return text.replace(FMG_TAG_PATTERN, (_whole, name: string, num?: string) => {
    if (name === 'null') return '';
    const suffix = num !== undefined ? ` ${num}` : '';
    switch (name) {
      case 'placeName': return `[地名${suffix}]`;
      case 'kgiconKc': return `[图标${suffix}]`;
      case 'bmsg': return '[BMSG]';
      default: return `[${name}${suffix}]`;
    }
  });
}

/**
 * S10 扩展：FMG 条目行是可引用节点。table 用 typed tableId（stableId，含冒号
 * 是合法形态，main 的 decodeCiteHit 按非路径校验）；text 用显示投影文本
 * （前 80 字，图标/地名标签已投影）。未选表时不挂 data-cite（诚实态）。
 */
function citeEntryAttr(entryId: number, tableId: string | null, text: string): Record<string, string> {
  if (tableId === null) return {};
  const projected = projectFmgDisplayText(text).slice(0, 80);
  return {
    'data-cite': JSON.stringify({
      kind: 'text-entry',
      library: 'text',
      table: tableId,
      entryId,
      ...(projected ? { text: projected } : {})
    })
  };
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
  /**
   * S31：外部 reveal 请求 —— 选中 tableId 对应表并定位到 entryId 条目。
   * 面板消费后经 onRevealHandled 通知 App 清除（一次性）。
   */
  revealRequest?: { tableId: string; entryId: number } | null | undefined;
  /** S31：reveal 请求已处理（无论命中或不足证据）后回调，App 据此清除请求。 */
  onRevealHandled?: () => void;
  onMutation?: (mutation: {
    kind: 'fmg_entry_upsert' | 'fmg_entry_delete' | 'fmg_entry_add';
    id: number;
    text?: string;
    /** 选中表 typed ID（TEXT-20C 容器写路由用）；demo 模式无选中表时缺省。 */
    tableId?: string;
  }) => void;
}

/**
 * S31：在文本目录里按 typed tableId 找表所在的语言/容器。
 * 纯函数（无 DOM、无 IPC），供 reveal 与单测共用。
 */
export function findTableInCatalog(
  catalog: TextCatalogResponse,
  tableId: string
): { languageId: string; containerId: string; tableId: string } | null {
  for (const language of catalog.languages) {
    for (const container of language.containers) {
      const table = container.tables.find((candidate) => candidate.tableId === tableId);
      if (table) {
        return {
          languageId: language.languageId,
          containerId: container.containerId,
          tableId: table.tableId
        };
      }
    }
  }
  return null;
}

/*
 * 3-C 起 renderer 不再分页：选中表后一次拿全量（REVEAL_SCAN_PAGE_SIZE，main 已
 * 缓存整表）。shared 的 FMG_PAGE_SIZE 仍被主进程 readFmgTablePage 当缺省页大小，
 * 但 renderer 已不消费它。
 */

/**
 * S31：reveal 宽读的扫描窗口。normalizePageWindow 不设上限，取「一次拿全过滤
 * 结果」的足够大值；过滤条件是精确条目 id，返回量本身很小。3-C 起这个窗口也
 * 用于主表读取（选中表后一次拿全量）。
 */
const REVEAL_SCAN_PAGE_SIZE = 100_000;

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

  // ── 选中表条目：全量列表（3-C 不再分页）──
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [pageEntries, setPageEntries] = useState<FmgEntryRow[]>([]);
  const [entryCount, setEntryCount] = useState(0);
  const [maxId, setMaxId] = useState(0);
  const [loading, setLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  /** S31：外部 reveal 的不足证据说明（面板内可见，不猜测、不跳错条目）。 */
  const [revealError, setRevealError] = useState<string | null>(null);
  /** S31：条目列表容器，reveal 滚动定位用。 */
  const entriesListRef = useRef<HTMLDivElement | null>(null);
  /** S31：宽读定位出的目标条目所在页（null = 还没定页）。 */
  const [revealTargetPage, setRevealTargetPage] = useState<number | null>(null);
  /** S31：当前 pageEntries 属于哪一页（读回窗口后登记，判 reveal 窗口是否到位）。 */
  const [loadedPage, setLoadedPage] = useState<number | null>(null);

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
          // 从 Files 领域点开具体 msgbnd 时，Categories 只列该容器的表（3-B：
          // 资源浏览器点开什么就是什么）；空 container 也选中容器，让中栏能报诊断。
          if (props.resourceUri) {
            for (const language of result.languages) {
              for (const container of language.containers) {
                if (container.sourceUri === props.resourceUri) {
                  setSelectedLanguageId(language.languageId);
                  setSelectedContainerId(container.containerId);
                  if (container.tables.length > 0) {
                    setSelectedTableId(container.tables[0]!.tableId);
                  }
                  return;
                }
              }
            }
          }
          // 3-B：没点具体 msgbnd（resourceUri 空）时不回落「默认 item 组」——只
          // 默认选语言，Categories 走空态，等用户在左侧资源浏览器点 item / menu。
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
    commitDraftRef.current();
    setSelectedLanguageId(languageId);
    setSelectedContainerId(null);
    setSelectedTableId(null);
    setSelectedId(null);
    setPage(0);
    setLoadedPage(null);
    setQuery('');
    setPageEntries([]);
    setPageError(null);
  }

  function handleSelectContainer(containerId: string): void {
    if (containerId === selectedContainerId) return;
    commitDraftRef.current();
    setSelectedContainerId(containerId);
    setSelectedTableId(null);
    setSelectedId(null);
    setPage(0);
    setLoadedPage(null);
    setQuery('');
    setPageEntries([]);
    setPageError(null);
  }

  function handleSelectTable(tableId: string): void {
    if (tableId === selectedTableId) return;
    commitDraftRef.current();
    setSelectedTableId(tableId);
    setSelectedId(null);
    setPage(0);
    setLoadedPage(null);
    setQuery('');
    setPageEntries([]);
    setPageError(null);
  }

  // ── 选中表：一次拿回该表全部条目（3-C：不再分页。main 已缓存整表，renderer
  // 用 100_000 的扫描窗口拿全量；query 在 main 端作用于完整表）──
  useEffect(() => {
    if (!liveMode || bridge === null || selectedTableId === null) return;
    let cancelled = false;
    setLoading(true);
    setPageError(null);
    bridge.readFmgTablePage(selectedTableId, 0, REVEAL_SCAN_PAGE_SIZE, query)
      .then((result: FmgEntryPage) => {
        if (cancelled) return;
        if (!result.ok) {
          // parse failure：只上抛诊断、绝不返回「0 条空表」伪装成功
          //（TEXT-20A Done 禁止）。demo 回退被 liveMode 挡在门外。
          setPageError(result.diagnostics?.[0]?.message ?? 'FMG 表读取失败。');
          setPageEntries([]);
        } else {
          setPageEntries(result.entries);
          setEntryCount(result.entryCount);
          setMaxId(result.maxId);
          setPage(0);
          setLoadedPage(0);
          setPageError(null);
        }
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPageError(error instanceof Error ? error.message : 'FMG 表读取异常。');
        setPageEntries([]);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [liveMode, bridge, selectedTableId, query]);

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
    // 3-C：demo 也是全量渲染（无分页切片）。
    setPageEntries(demoFiltered);
    setEntryCount(demoFiltered.length);
    setMaxId(props.entries.reduce((max, row) => Math.max(max, row.id), 0));
    setPage(0);
    setLoadedPage(0);
  }, [liveMode, demoFiltered, props.entries]);

  /**
   * S31：外部 reveal 第一步 —— 目录就绪后选中目标表，并把筛选设为精确条目 id。
   *
   * 接着用一次宽读（整张过滤结果）确认目标条目存在；3-C 起主窗口页恒为 0
   * （主读取 effect 一次拿全量过滤结果），宽读只负责「是否真存在」，不再换算分页页
   * —— 只信「第 0 页必含目标」对短 id 不成立（id 5 会命中几十上百条含「5」
   * 的条目），宁可在这一步多读一次。
   */
  useEffect(() => {
    const request = props.revealRequest;
    if (!request) return;
    if (!liveMode) {
      setRevealError('insufficient_evidence：文本目录不可用（browser-preview），无法定位条目。');
      props.onRevealHandled?.();
      return;
    }
    if (!catalog) {
      // 目录还在加载；读取失败时给不足证据，避免请求永久悬挂。
      if (catalogError) {
        setRevealError('insufficient_evidence：文本目录读取失败，无法定位条目。');
        props.onRevealHandled?.();
      }
      return;
    }
    commitDraftRef.current();
    const found = findTableInCatalog(catalog, request.tableId);
    if (!found) {
      setRevealError(`insufficient_evidence：文本目录里没有目标表，条目 ${request.entryId} 无法定位。`);
      props.onRevealHandled?.();
      return;
    }
    setRevealError(null);
    setSelectedLanguageId(found.languageId);
    setSelectedContainerId(found.containerId);
    setSelectedTableId(found.tableId);
    setSelectedId(null);
    setPage(0);
    setLoadedPage(null);
    setQuery(String(request.entryId));
    setRevealTargetPage(null);
    let cancelled = false;
    bridge?.readFmgTablePage(request.tableId, 0, REVEAL_SCAN_PAGE_SIZE, String(request.entryId))
      .then((result: FmgEntryPage) => {
        if (cancelled) return;
        if (!result.ok) {
          // 常规分页会给出同样的诊断面；这里不重复报，只清掉 reveal 挂起态。
          setRevealError('insufficient_evidence：文本表读取失败，无法定位条目。');
          props.onRevealHandled?.();
          return;
        }
        const index = result.entries.findIndex((entry) => entry.id === request.entryId);
        if (index < 0) {
          setRevealError(`insufficient_evidence：已打开的表里没有条目 ${request.entryId}。`);
          props.onRevealHandled?.();
          return;
        }
        // 3-C：主窗口页恒为 0（全表一次进 DOM），reveal 无需翻页。
        setRevealTargetPage(0);
      })
      .catch(() => {
        if (cancelled) return;
        setRevealError('insufficient_evidence：文本表读取异常，无法定位条目。');
        props.onRevealHandled?.();
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.revealRequest, catalog, catalogError, liveMode, bridge]);

  /**
   * S31：外部 reveal 第二步 —— 目标表 + 精确 id 过滤 + 全量窗口就绪后选中目标
   * 条目并滚动。窗口还没到位 / 宽读还没确认 / 用户改了筛选时不判；窗口里没有
   * 目标条目就是表里确实没有，不猜别的行。
   *
   * 3-C 起主窗口页恒为 0：reveal 第一步宽读确认目标存在后会置 revealTargetPage=0，
   * 等主读取 effect 的全量过滤结果（loadedPage=0）到位，直接在 pageEntries 里找。
   */
  useEffect(() => {
    const request = props.revealRequest;
    if (!request) return;
    if (selectedTableId !== request.tableId) return;
    if (query !== String(request.entryId)) return;
    if (revealTargetPage === null) return;
    if (page !== revealTargetPage) {
      if (!loading) setPage(revealTargetPage);
      return;
    }
    if (loading || loadedPage !== revealTargetPage) return;
    const row = pageEntries.find((entry) => entry.id === request.entryId);
    if (row) {
      setSelectedId(row.id);
      setRevealError(null);
      const element = entriesListRef.current?.querySelector(`[data-fmg-entry-id="${row.id}"]`);
      element?.scrollIntoView({ block: 'center' });
      props.onRevealHandled?.();
      return;
    }
    setRevealError(`insufficient_evidence：已打开的表里没有条目 ${request.entryId}。`);
    props.onRevealHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.revealRequest, selectedTableId, query, page, revealTargetPage, loadedPage, loading, pageEntries]);

  const selected = pageEntries.find((row) => row.id === selectedId) ?? null;
  const selectedContainer = useMemo(() => {
    if (!catalog || selectedLanguageId === null || selectedContainerId === null) return null;
    const language = catalog.languages.find((l) => l.languageId === selectedLanguageId);
    return language?.containers.find((c) => c.containerId === selectedContainerId) ?? null;
  }, [catalog, selectedLanguageId, selectedContainerId]);
  const containerFailed = selectedContainer?.parseStatus === 'failed';
  // 3-A：目录元数据里的 filledCount / entryCount（Bridge 仍上报，RAG/Agent 用）
  // 不再画成「槽 / 有字」；表名一行只留表名。

  // S29：编辑只落到本地草稿，失焦 / Ctrl+S 再提交一次（直写，不先进审查队列）。
  // 切换条目 / 翻页 / 换表前先提交当前草稿，避免选中行换掉后草稿被吞。
  const [draftText, setDraftText] = useState<string | null>(null);
  const commitDraftRef = useRef<() => void>(() => {});

  function updateText(text: string): void {
    if (selectedId === null) return;
    setPageEntries((prev) => prev.map((row) => (row.id === selectedId ? { ...row, text } : row)));
    setDraftText(text);
  }

  function commitDraft(): void {
    if (selectedId === null || draftText === null) return;
    props.onMutation?.({
      kind: 'fmg_entry_upsert',
      id: selectedId,
      text: draftText,
      ...(selectedTableId !== null ? { tableId: selectedTableId } : {})
    });
    setDraftText(null);
  }
  commitDraftRef.current = commitDraft;

  function addEntry(): void {
    if (selectedTableId === null) return;
    commitDraft();
    const id = maxId + 1;
    setPageEntries((prev) => [...prev, { id, text: '' }]);
    setMaxId(id);
    setSelectedId(id);
    props.onMutation?.({ kind: 'fmg_entry_add', id, text: '', tableId: selectedTableId });
  }

  function deleteSelected(): void {
    if (selectedId === null) return;
    setDraftText(null);
    const id = selectedId;
    setPageEntries((prev) => prev.filter((row) => row.id !== id));
    setSelectedId(null);
    props.onMutation?.({
      kind: 'fmg_entry_delete',
      id,
      ...(selectedTableId !== null ? { tableId: selectedTableId } : {})
    });
  }

  // ── 左栏 Categories（3-B）：语言筛选在顶上。资源浏览器点开哪个容器，就只列
  // 那一个容器里的表（container.sourceUri === props.resourceUri）；没有具体
  // msgbnd（resourceUri 空）时不列任何容器，走空态。不再有 ITEM/MENU 组头，
  // 也不再平铺两个容器 33 张表。
  // 表名是 main 投影的逻辑名（shared logicalFmgTableName），renderer 不做二次解析。
  const selectedLanguage = catalog?.languages.find((l) => l.languageId === selectedLanguageId) ?? null;
  const categoryContainer = selectedLanguage?.containers.find(
    (container) => container.sourceUri === props.resourceUri
  ) ?? null;
  const categoryTables = useMemo(() => {
    if (!catalog || selectedLanguage === null || categoryContainer === null) return [];
    if (categoryContainer.parseStatus !== 'confirmed') return [];
    const q = treeQuery.trim().toLowerCase();
    return categoryContainer.tables
      .filter((table) => !q || table.entryName.toLowerCase().includes(q))
      .map((table) => ({
        key: `table:${table.tableId}`,
        label: table.entryName,
        title: `${categoryContainer.containerKind} / ${table.entryName}`,
        selected: table.tableId === selectedTableId,
        onSelect: () => {
          // 选表即选其容器：容器读取失败/诊断跟随表所属容器。
          setSelectedContainerId(categoryContainer.containerId);
          handleSelectTable(table.tableId);
        }
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, selectedLanguage, categoryContainer, selectedContainerId, selectedTableId, treeQuery]);

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
                {language.languageId}
              </option>
            ))}
          </select>
        </label>
        <input
          value={treeQuery}
          onChange={(e) => setTreeQuery(e.target.value)}
          placeholder="筛选表名"
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
        {catalog && !catalogLoading && !props.resourceUri && (
          <p className="wb-empty">在左侧资源浏览器点 item 或 menu</p>
        )}
        {categoryContainer && categoryContainer.parseStatus !== 'confirmed' && (
          <p className="wb-empty diag-warn">该容器读取失败，查看中栏诊断。</p>
        )}
        {categoryTables.map((row, index) => (
          <div
            key={row.key}
            className="wb-row"
            {...selectableRowAttributes({
              selected: row.selected,
              isTabEntry: isRowTabEntry(index, categoryTables.some((t) => t.selected)),
              onSelect: row.onSelect
            })}
          >
            <span className="wb-row__name" title={row.title}>{row.label}</span>
          </div>
        ))}
        {catalog && !catalogLoading && props.resourceUri && categoryTables.length === 0 && (
          <p className="wb-empty">当前语言没有匹配的表。</p>
        )}
      </div>
    </>
  );

  // ── 中栏：全量条目表（真空表 / 无匹配 / 未选择三种空态分离，3-C 不再分页）──
  const hasSelection = selectedTableId !== null;
  const entriesColumn = (
    <>
      <div style={{ padding: '4px 8px', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
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
        {loading && <span className="muted">加载中…</span>}
      </div>
      {pageError && <p className="danger">{pageError}</p>}
      {revealError && <p className="muted">{revealError}</p>}
      {containerFailed && (
        <p className="danger">
          {selectedContainer?.diagnostics?.[0]?.message ?? '该容器读取失败。'}
        </p>
      )}
      <div className="binder-child-table" role="table" ref={entriesListRef}>
        <div className="binder-child-row binder-child-header" role="row">
          <span>ID</span>
          <span>文本</span>
        </div>
        {pageEntries.map((row, rowIndex) => {
          // S30：列表显示投影文本（图标/地名/空标记不再是乱码正文）；
          // 投影为空的槽（<?null?> / 空串）弱化为 —，行与 ID 照常在场 ——
          // 地名表 47 槽的 41 个空槽因此看得见，不是「缺漏」。
          const projected = projectFmgDisplayText(row.text).slice(0, 80);
          return (
            <div
              key={rowIndex}
              className="binder-child-row"
              data-fmg-entry-id={row.id}
              {...selectableRowAttributes({
                selected: row.id === selectedId,
                isTabEntry: isRowTabEntry(rowIndex, selectedId !== null),
                onSelect: () => { commitDraftRef.current(); setSelectedId(row.id); }
              })}
              {...citeEntryAttr(row.id, selectedTableId, row.text)}
            >
              <span>{row.id}</span>
              {projected
                ? <span>{projected}</span>
                : <span className="muted">—</span>}
            </div>
          );
        })}
        {pageEntries.length === 0 && !loading && !pageError && !containerFailed && (
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
          value={draftText ?? selected.text}
          onChange={(e) => updateText(e.target.value)}
          onBlur={() => commitDraftRef.current()}
          onKeyDown={(e) => {
            // S29：Ctrl+S 直接提交本表当前编辑（与 PARAM 行备注同一把尺子）。
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
              e.preventDefault();
              commitDraftRef.current();
            }
          }}
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
      // 3-A：hint 不再报「槽 · 有字」；总数如要报只给光秃数字（3-C），不加单位。
      hint: selectedTableId !== null && entryCount > 0 ? String(entryCount) : '',
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
        columns={columns}
      />
    </section>
  );
}
