/**
 * PARAM 三栏工作台（对照 Smithbox 2.2.4 的 Param Editor）。
 *
 * 一：Params —— parambnd 容器内的 param 条目
 * 二：Rows   —— 选中 param 的行（id + name），筛选 + 虚拟滚动，行名可编辑
 * 三：Fields —— 选中行的字段（中文名 + 悬停 Description + 值）；应用 ParamDef
 *               失败时保留失败 param 并标「读取失败」
 *
 * 顶部工具条（T5-4）：导出行 / 导入行 / 导出备注 / 导入备注（CSV，主进程对话框，
 * 导入写入走 Patch Engine）。不再有第四栏 Tools —— 未接通的工具不渲染假按钮
 * （§7.6）。
 *
 * ── 为什么需要它 ──
 *
 * 用户报「param 页面重证据、无工作、不可用、不可编辑」。此前打开
 * gameparam.parambnd.dcx 只能看到「只读 Hex 证据」和一个 0 行的表：
 *   · read-param-document 不解 DCX/BND4，容器路径直接喂进去必失败；
 *   · 「容器 → 内部 param」这一跳没有 IPC 出口，于是列得出名字也读不到字节。
 * 两条都已在 main 侧补上（resource.listContainerParams /
 * resource.readContainerParamPage），本组件是它们的第一个消费者。
 *
 * ── 分页是硬约束（17）──
 *
 * 行数与字段数都不可控：BEHAVIOR_PARAM_ST 有 5275 行，ATK_PARAM_ST 有 221 个字段。
 * 行分页在 main 侧（查询作用于完整行表，导航可覆盖完整文档）；字段分页在本地，
 * 因为字段集随选中行的 paramdef 而定、总量有界。
 *
 * ── 写入 ──
 *
 * 字段值编辑经 onApplyFieldMutation 出口交给宿主，由宿主走 Patch Engine。
 * 本组件不直接写盘，也不在 origin 未授信时放行提交 —— 那道授权门守的是
 * 「元数据包与真实 PARAM 的字段偏移是否对得上」，绕过它等于往错误偏移写数值。
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ParamDefDocument, ParamFieldDef } from '@soulforge/shared';
import { getRendererBridge } from '../runtime/rendererRuntime.js';
import { isRowTabEntry, selectableRowAttributes } from '../a11y/selectableRow.js';
import { base64ToUint8Array, uint8ArrayToBase64 } from '../utils/binary.js';
// 复用 ParamDefPanel 的解码器：解码权威必须单一（见该处导出注释）。
import { decodeFieldView } from '../editors/ParamDefPanel.js';
import { isParamCheckboxField } from './paramCheckboxField.js';
import { WorkbenchLayout, type WorkbenchColumnSpec } from './WorkbenchLayout.js';

/** 容器 PARAM 选中行 payload 的物理页大小；必须与 main 侧页契约一致。 */
const PARAM_PAGE_SIZE = 20;

/** 容器内的一个 param 条目。 */
export interface ParamEntryView {
  entryIndex: number;
  name: string;
  size: number;
}

/**
 * 读取失败的 param 记录。
 *
 * ── 为什么要留这份记录 ──
 *
 * 对照 Smithbox：某个 param 应用 ParamDef 失败时，它把该 param 从列表里**彻底
 * 移除**（`paramBank.Add` 在 try 内、异常路径直接跳过），用户看到的是「param
 * 凭空不见了」加菜单栏一行会淡出的红字，两者之间没有关联线索。用户截图里那句
 * `Could not apply ParamDef for TentativePlayerParam.param in Primary` 正是它。
 *
 * 那是它的可用性缺陷，本项目不照抄 —— 硬约束要求 unsupported/failed 必须返回
 * 结构化诊断、不能吞异常。所以失败的 param 仍留在左栏，标记为失败态，
 * 点开后右栏显示具体原因，而不是让它从列表里消失。
 *
 * 不预先校验全部 138 个 param：那要把每个都解包一遍，打开容器会变得极慢。
 * 失败在点开时才知道，但一旦知道就记下来并显示。
 */
interface ParamEntryFailure {
  /** 失败原因（已是人话，来自后端结构化诊断的 message）。 */
  message: string;
  /** 诊断码，供排查与日志对照。 */
  code: string;
}

/** 一行。物理身份为 rowIndex + id + dataHash，渲染与写入均以 rowIndex 为键，禁止以 id 去重或 first-match。 */
export interface ParamRowLine {
  rowIndex: number;
  id: number;
  dataHash: string;
  name?: string;
  dataBase64?: string;
  dataHexPreview?: string;
}

/**
 * S10 引用框选 data-cite（PARAM 先行）：行与字段是可引用节点，JSON 只含逻辑 id
 * （library/table/rowId/fieldId/name/label/value），禁止绝对路径。paramName 为
 * null（该 param 读取失败）时不给 data-cite——「这块还不能引用」的诚实态，
 * 不瞎编。table 用 param 条目名（去 `.param` 后缀），与引用标签固定格式一致。
 */
function stripParamExtension(name: string): string {
  return name.replace(/\.param$/i, '');
}

function citeRowAttr(row: ParamRowLine, paramName: string | null): Record<string, string> {
  if (paramName === null) return {};
  return {
    'data-cite': JSON.stringify({
      kind: 'param-row',
      library: 'gameparam',
      table: stripParamExtension(paramName),
      rowId: row.id,
      ...(row.name !== undefined && row.name !== '' ? { name: row.name } : {})
    })
  };
}

function citeFieldAttr(
  field: ParamFieldDef,
  shown: string,
  rowId: number,
  paramName: string | null
): Record<string, string> {
  if (paramName === null) return {};
  return {
    'data-cite': JSON.stringify({
      kind: 'param-field',
      library: 'gameparam',
      table: stripParamExtension(paramName),
      rowId,
      fieldId: field.id,
      label: field.name,
      value: shown
    })
  };
}

export interface ParamWorkbenchProps {
  /** 容器资源 URI（parambnd.dcx）。 */
  containerUri: string;
  /** 容器显示名，用于工具条面包屑。 */
  containerLabel: string;
  /**
   * 字段定义查询：给定 typeName 返回该 param 的字段定义。
   *
   * 由宿主提供而不是本组件自己取：定义要经元数据包匹配与信任策略，那是
   * main 侧的权威路径，渲染器不该自行拼装。
   */
  resolveDefinition?: (typeName: string, rowDataSize: number) => ParamDefDocument | null;
  /**
   * 枚举表（enumRef → 值列表）。
   *
   * values 为空数组是正常状态而非缺失：元数据包里多数 enum 没有值表。
   * UI 要把空 values 当「无标签」而不是「无枚举」。
   */
  fieldEnums?: Array<{
    id: string;
    name: string;
    values: Array<{ value: number; label: string }>;
  }> | null;
  /**
   * 字段写入出口。缺省即只读。
   *
   * 两个哈希由本组件从 readContainerParamPage 取得并透传，宿主原样交给
   * applyContainerParamFieldMutation —— 它们是并发保护的凭据，不是可选装饰。
   */
  onApplyFieldMutation?: (input: {
    paramName: string;
    entryIndex: number;
    expectedContainerHash: string;
    expectedChildHash: string;
    rowIndex: number;
    rowId: number;
    expectedDataHash: string;
    expectedRowDataSize: number;
    fieldId: string;
    value: number | string | boolean;
    rowDataBase64: string;
    definition: ParamDefDocument;
  }) => Promise<{ ok: boolean; message?: string }>;
  /**
   * 行名写入出口（T5-3）。缺省即行名只读。
   *
   * 与字段写入同一条 Patch 链（write-param upsert 带 name → write-bnd4 →
   * Patch Engine）。rowDataBase64 是当前行字节，原样回传不修改。
   */
  onApplyRowNameMutation?: (input: {
    paramName: string;
    entryIndex: number;
    expectedContainerHash: string;
    expectedChildHash: string;
    rowIndex: number;
    rowId: number;
    expectedDataHash: string;
    expectedRowDataSize: number;
    name: string;
    rowDataBase64: string;
  }) => Promise<{ ok: boolean; message?: string }>;
  /**
   * 行级写入出口（问题 4）：新建行 / 复制当前行 / 删除当前行。
   *
   * 与字段/行名写入同一条 Patch 链（write-param add/delete → write-bnd4 →
   * Patch Engine），缺省即行级只读。rowId 由本组件按「当前表最大 id + 1」给出
   * （不跳过空洞，对照 Yapped）；add/copy 携带整行字节（copy = 当前行原样，
   * add = 行宽 0 行），delete 不带字节。
   */
  onApplyRowMutation?: (input: {
    paramName: string;
    entryIndex: number;
    expectedContainerHash: string;
    expectedChildHash: string;
    kind: 'add' | 'copy' | 'delete';
    rowId: number;
    rowDataBase64: string;
  }) => Promise<{ ok: boolean; message?: string }>;
}

/** Rows 栏 props。回调全部要求引用稳定（宿主用 useCallback 给），memo 才拦得住。 */
interface ParamRowsColumnProps {
  /** null = 尚未选择 param，显示占位提示。 */
  selectedEntry: number | null;
  visibleRows: ParamRowLine[];
  rowsLoading: boolean;
  rowsError: string | null;
  rowQuery: string;
  onRowQueryChange: (value: string) => void;
  selectedRowIndex: number | null;
  onSelectRow: (rowIndex: number) => void;
  /** 当前 param 条目名（S10 引用 data-cite 用）。 */
  paramName: string | null;
  /** 行名写入出口是否接通（缺省即行名只读）。 */
  rowNameEditable: boolean;
  /** 行名提交（宿主侧走 Patch Engine + toast + 重载）。名字已 trim。 */
  onCommitRowName: (row: ParamRowLine, normalizedName: string) => Promise<void>;
}

/**
 * Rows 栏：行表虚拟化内置，整体 memo。
 *
 * ── 为什么从 ParamWorkbench 拆出来 ──
 *
 * 虚拟滚动器订阅滚动事件。挂在主组件上时，**每个滚动帧都整体重渲染三栏**
 * —— 右栏字段可达数百个受控输入（字段全量渲染是用户裁定），帧耗时撑爆后
 * overscan 消耗完而新行还没渲染出来，快速滚动就露空白。拆出后滚动只重渲染
 * 本栏视口内的几十行，左栏 param 列表与右栏字段不再陪跑。
 *
 * ── 行 key 用虚拟化下标而不是 row.id ──
 *
 * 真实语料行 id 会重复（实测 10 个 param 共 52 行重复 id，如 CutsceneParam
 * 的 10000000 出现两次）。重复 key 让 React 协调复用错 DOM，重复 id 的行
 * 进出虚拟化窗口时表现就是行空白/串行。下标是虚拟化位置的稳定锚：全量数据
 * 加载后不会原地重排，切换 param 时整张列表连同 sizer 高度一起换掉。
 *
 * ── overscan 30 ──
 *
 * 行高锁定 22px（等高；可变高度要测量模式，param 行信息量固定，锁等高 +
 * 溢出省略号更稳）。overscan 30 ≈ 660px 视口外预渲染，快速滚轮/拖动单次
 * 位移通常落得进来；行本身廉价，预渲染成本可忽略。
 */
const ParamRowsColumn = memo(function ParamRowsColumn({
  selectedEntry,
  visibleRows,
  rowsLoading,
  rowsError,
  rowQuery,
  onRowQueryChange,
  selectedRowIndex,
  onSelectRow,
  paramName,
  rowNameEditable,
  onCommitRowName
}: ParamRowsColumnProps): ReactElement {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 行名编辑草稿：非 null 表示正在编辑选中行的名字。 */
  const [rowNameDraft, setRowNameDraft] = useState<string | null>(null);
  const [rowNameCommitting, setRowNameCommitting] = useState(false);

  // 换选中行即收起上一行的草稿（宿主在 selectedRowIndex 变化时会重置 drafts，
  // 行名草稿同理，落在栏内自治）。
  useEffect(() => {
    setRowNameDraft(null);
  }, [selectedRowIndex]);

  const virtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 22,
    overscan: 30
  });
  const virtualRows = virtualizer.getVirtualItems();

  /**
   * 提交一个行名（T5-3）。草稿语义在栏内闭环：名字没变（或只去掉首尾空白）
   * 不发请求直接收起；有变化才交给宿主的 Patch 链。
   */
  async function commitDraftName(row: ParamRowLine, rawName: string): Promise<void> {
    if (!rowNameEditable || !row.dataBase64) return;
    const normalized = rawName.trim();
    if (normalized === (row.name ?? '')) {
      setRowNameDraft(null);
      return;
    }
    setRowNameCommitting(true);
    try {
      await onCommitRowName(row, normalized);
      setRowNameDraft(null);
    } finally {
      setRowNameCommitting(false);
    }
  }

  return (
    <div className="wb-list wb-list--virtual">
      {selectedEntry === null && <p className="wb-empty">先在左栏选择一个 param。</p>}
      {selectedEntry !== null && (
        <>
          <div style={{ padding: '4px 8px', display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              value={rowQuery}
              onChange={(event) => onRowQueryChange(event.target.value)}
              placeholder="筛选 id / name（全量数据本地过滤）"
              aria-label="筛选 PARAM 行 id 或 name（索引数据本地过滤）"
              style={{ flex: 1, minWidth: 0 }}
            />
          </div>
          {rowsError && <p className="wb-empty diag-error">{rowsError}</p>}
          {rowsLoading && (
            <p className="wb-empty" role="status">读取行数据…</p>
          )}
          {!rowsLoading && !rowsError && visibleRows.length === 0 && (
            <p className="wb-empty">没有匹配的行。</p>
          )}
          {/* 虚拟滚动：轻量索引一次在手，DOM 只保留可见行 + overscan。
              role=grid + aria-rowcount 给出**总行数**而不是渲染数 ——
              否则屏幕阅读器会播报「共 20 行」而实际有 5275 行。 */}
          <div
            ref={scrollRef}
            className="wb-virtual-scroll"
            role="grid"
            aria-rowcount={visibleRows.length}
            aria-label="PARAM 行列表"
          >
            <div
              className="wb-virtual-sizer"
              style={{ height: `${virtualizer.getTotalSize()}px` }}
            >
              {virtualRows.map((virtualRow) => {
                const row = visibleRows[virtualRow.index];
                if (!row) return null;
                return (
                  <div
                    key={virtualRow.index}
                    className="wb-row wb-virtual-row"
                    style={{
                      height: `${virtualRow.size}px`,
                      transform: `translateY(${virtualRow.start}px)`
                    }}
                    aria-rowindex={virtualRow.index + 1}
                    {...selectableRowAttributes({
                      selected: selectedRowIndex === row.rowIndex,
                      isTabEntry: isRowTabEntry(virtualRow.index, selectedRowIndex !== null),
                      onSelect: () => onSelectRow(row.rowIndex)
                    })}
                    {...(citeRowAttr(row, paramName))}
                  >
                    <span className="wb-row__id">{row.id}</span>
                    {selectedRowIndex === row.rowIndex && rowNameEditable && row.dataBase64
                      ? (
                        <input
                          className="wb-row__name-input"
                          value={rowNameDraft ?? row.name ?? ''}
                          aria-label={`行 ${row.id} 的名字`}
                          disabled={rowNameCommitting}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => setRowNameDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.stopPropagation();
                              void commitDraftName(row, event.currentTarget.value);
                            } else if (event.key === 'Escape') {
                              event.stopPropagation();
                              setRowNameDraft(null);
                            }
                          }}
                          onBlur={() => {
                            if (rowNameDraft !== null) void commitDraftName(row, rowNameDraft);
                          }}
                        />
                      )
                      : (
                        <span className="wb-row__name" title={row.name ?? ''}>
                          {row.name ?? '—'}
                        </span>
                      )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
});

/** 字段全量渲染（用户裁定 2026-08-14）：字段不再分页，一次全部显示。 */
export function ParamWorkbench(props: ParamWorkbenchProps): ReactElement {
  const bridge = getRendererBridge();

  const [params, setParams] = useState<ParamEntryView[]>([]);
  const [paramsError, setParamsError] = useState<string | null>(null);
  const [paramsLoading, setParamsLoading] = useState(false);
  const [paramFilter, setParamFilter] = useState('');
  const [selectedEntry, setSelectedEntry] = useState<number | null>(null);

  const [rowQuery, setRowQuery] = useState('');
  /**
   * 选中 param 的**完整行索引**（只 id + name，无行字节），一次读入。
   *
   * ── 为什么改成一次读全表 ──
   *
   * 原先靠「滚到底取下一页」累积，那个形态有三处撑不住的地方（都实测过）：
   *
   *   ① 跨表引用跳转要落到第 42 页那种位置。往累积列表里塞不连续的一页，列表顺序
   *      就是假的；而靠行筛选跳转也不行 —— 后端 id 筛选是**子串**匹配，精确匹配项
   *      最远排在第 36 位而页大小 20，目标压根不在第 0 页。
   *   ② 有筛选时后端**刻意不下发行字节**（筛选页与 Bridge 物理页不对应，取了会对
   *      错行）。也就是说旧实现下「一边筛选一边编辑字段」是做不到的。
   *   ③ 虚拟滚动要一条完整长列表才成立，累积页数只是「已取到多少」。
   *
   * 成本反而更低：后端**每次**分页请求本来都要读一遍全表再切片（行字节必然缺失，
   * 见 readContainerParamPage 的实测因果），现在一个 param 只读一次索引。
   *
   * 行字节仍按页取（PARAM_PAGE_SIZE=20 是跨进程契约：实测载荷门控按页算，
   * 20/32 能下发字节、64 就超 512 KB 门限）—— 选中某行时只取包含它的那一页。
   */
  const [rows, setRows] = useState<ParamRowLine[]>([]);
  const [loadedRows, setLoadedRows] = useState<ParamRowLine[]>([]);
  /**
   * 筛选输入的 debounce 值。
   *
   * 对照结论：Smithbox 每帧重画 5000 行也不重跑搜索 —— 它把搜索结果缓存在
   * (viewIndex, param, searchString) 上，只在搜索串真的变了那一帧重算。
   * ImGui 每帧重建能扛，DOM diff 不能，所以这里除了 memo 还必须 debounce：
   * 每敲一个字符就发一次 IPC 会让 5275 行的表卡住。
   */
  const [rowQueryDebounced, setRowQueryDebounced] = useState('');
  /**
   * 读取失败的 param（按 entryIndex）。见 ParamEntryFailure 的注释。
   * 键是 entryIndex 而不是名字：容器内条目名经过 sanitize，可能重名。
   */
  const [entryFailures, setEntryFailures] = useState<Map<number, ParamEntryFailure>>(new Map());
  const [rowCount, setRowCount] = useState(0);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [payloadLoading, setPayloadLoading] = useState(false);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [typeName, setTypeName] = useState<string | null>(null);
  const [rowDataSize, setRowDataSize] = useState(0);
  const [paramName, setParamName] = useState<string | null>(null);
  const [pageDiagnostics, setPageDiagnostics] = useState<string[]>([]);
  /**
   * 写回所需的两个哈希由索引/分页结果给出，写入时原样回传；opaque session token
   * 只用于把 row-index 建好的 native session 传给 payload page，不进入 DOM 或写入参数。
   *
   * 渲染器不自己算：它拿不到容器字节。容器哈希防「读与写之间容器被改过」，
   * 条目哈希防「同一条目被并发改过」—— 缺它们就没有并发保护，两个基于同一份
   * 旧字节的改动会互相静默覆盖。
   */
  const [containerHash, setContainerHash] = useState<string>('');
  const [childHash, setChildHash] = useState<string>('');
  /** row index 建立的 opaque native session；选中行 payload 必须复用它。 */
  const [documentSessionToken, setDocumentSessionToken] = useState<string | null>(null);

  /**
   * 主进程随 readContainerParamPage 返回的字段定义（P1 裁定）。
   *
   * 此前字段定义只经 App 的 resolveDefinition prop 下发，而那条链的数据源是
   * readParamDocument(容器 URI)——容器喂进去必失败，于是容器工作台的 Fields
   * 栏永远是「没有可用的字段定义」。现在主进程在 readContainerParamPage 里用
   * 与 readParamDocument 相同的 resolveTrustedParamDefinition（包校验 + 行宽
   * 核对 + 用户信任策略）解析并随页返回；origin 仍由主进程裁定，渲染器只消费。
   */
  const [pageFieldDefs, setPageFieldDefs] = useState<ParamFieldDef[] | null>(null);
  const [pageFieldEnums, setPageFieldEnums] = useState<
    Array<{ id: string; name: string; values: Array<{ value: number; label: string }> }> | null
  >(null);
  const [pageFieldDefsOrigin, setPageFieldDefsOrigin] = useState<
    'fixture' | 'imported' | 'user-derived'
  >('fixture');
  const [pageFieldDefsDiagnostic, setPageFieldDefsDiagnostic] = useState<
    { code: string; message: string } | null
  >(null);

  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  /** 防止 StrictMode/重复渲染对同一物理行重复发起 payload 请求。 */
  const payloadRequestRef = useRef<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [committing, setCommitting] = useState(false);
  /** S28：工作台内短时保存提示（成功几秒后消失）；失败留在原处直到下次操作。 */
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'error' } | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  // useCallback：commitRowName 是 memo 化的 ParamRowsColumn 的 prop，
  // showToast 不稳定会把整台重渲染泄进中栏行表。
  const showToast = useCallback((text: string, kind: 'ok' | 'error'): void => {
    setToast({ text, kind });
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    // 失败不自动消失：用户要能读到原因；成功几秒后自己消失。
    if (kind === 'ok') {
      toastTimerRef.current = window.setTimeout(() => setToast(null), 2500);
    }
  }, []);
  /** CSV 导入导出（T5-4）进行中标记：防止重复点击。 */
  const [ioBusy, setIoBusy] = useState(false);
  /** 问题 4：新建/复制/删除行进行中标记：防止重复提交。 */
  const [rowMutationBusy, setRowMutationBusy] = useState(false);

  // ── 左栏：容器内 param 列表 ──
  useEffect(() => {
    if (!bridge || typeof bridge.listContainerParams !== 'function' || !props.containerUri) return;
    let cancelled = false;
    setParamsLoading(true);
    setParamsError(null);
    bridge.listContainerParams(props.containerUri)
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setParams([]);
          setParamsError(result.diagnostics?.[0]?.message ?? '容器内 param 列表读取失败。');
        } else {
          setParams(result.params);
          setParamsError(result.params.length === 0
            ? (result.diagnostics?.[0]?.message ?? '容器内没有 param 文件。')
            : null);
        }
        setParamsLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setParams([]);
        setParamsError(error instanceof Error ? error.message : '容器内 param 列表读取异常。');
        setParamsLoading(false);
      });
    return () => { cancelled = true; };
  }, [bridge, props.containerUri]);

  // 切换 param 时重置行与字段选择：否则会停在上一个 param 的行号/字段页上。
  useEffect(() => {
    setRowQuery('');
    setSelectedRowIndex(null);
    setDrafts({});
    setToast(null);
    // 索引与已 materialize 的 payload 都必须清：残留会让新 param 的列表里混着
    // 上一个 param 的行，而两者行宽通常不同，选中后字段会按错误的定义解码。
    setRows([]);
    setLoadedRows([]);
    setRowCount(0);
    setRowsLoading(false);
    setPayloadLoading(false);
    setRowsError(null);
    setTypeName(null);
    setRowDataSize(0);
    setParamName(null);
    setContainerHash('');
    setChildHash('');
    setDocumentSessionToken(null);
    setPageDiagnostics([]);
    payloadRequestRef.current = null;
    // 页面级字段定义同样按 param 重置：上一张表的字段列不能留到新表上。
    setPageFieldDefs(null);
    setPageFieldEnums(null);
    setPageFieldDefsDiagnostic(null);
    setPageFieldDefsOrigin('fixture');
  }, [selectedEntry]);

  useEffect(() => {
    setDrafts({});
    // 行名草稿随选中行重置的语义落在 ParamRowsColumn 内（栏内自治）。
  }, [selectedRowIndex]);

  /*
   * 筛选 debounce：220ms。
   *
   * 空串立即生效（清空筛选是「想马上看到全部」的动作，延迟会让人以为没反应）；
   * 非空才延迟。
   */
  useEffect(() => {
    if (rowQuery === '') {
      setRowQueryDebounced('');
      return;
    }
    const timer = setTimeout(() => setRowQueryDebounced(rowQuery), 220);
    return () => clearTimeout(timer);
  }, [rowQuery]);

  // ── 中栏：选中 param 的行 —— lazy index 首屏 ──
  //
  // 打开一张 param 先只取完整的 rowIndex/id/name/dataHash 索引；行字节等用户
  // 选中具体行后，再按该物理行所在页从现有 readContainerParamPage 取回。
  // 这样虚拟列表立即有真实行数，同时不把全表 payload 搬过 renderer IPC。
  const loadRows = useCallback(() => {
    if (selectedEntry === null || !props.containerUri) return;
    if (!bridge || typeof bridge.readContainerParamRowIndex !== 'function') {
      setRowsError('当前桌面 Bridge 未提供 PARAM 行索引通道。');
      return;
    }
    let cancelled = false;
    payloadRequestRef.current = null;
    setDocumentSessionToken(null);
    setRowsLoading(true);
    setPayloadLoading(false);
    setRowsError(null);
    setPageDiagnostics([]);
    setPageFieldDefs(null);
    setPageFieldEnums(null);
    setPageFieldDefsDiagnostic(null);
    setPageFieldDefsOrigin('fixture');
    bridge.readContainerParamRowIndex(props.containerUri, selectedEntry)
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setRows([]);
          setLoadedRows([]);
          // 字段定义随失败清空：不能拿上一张 param 的字段列读当前表的字节。
          setPageFieldDefs(null);
          setPageFieldEnums(null);
          setPageFieldDefsDiagnostic(null);
          setPageFieldDefsOrigin('fixture');
          const first = result.diagnostics?.[0];
          setRowsError(first?.message ?? 'PARAM 行索引读取失败。');
          setPageDiagnostics([]);
          // 登记失败：该 param 在左栏保留并标记，不像 Smithbox 那样从列表消失。
          if (selectedEntry !== null) {
            setEntryFailures((current) => {
              const next = new Map(current);
              next.set(selectedEntry, {
                message: first?.message ?? 'PARAM 行索引读取失败。',
                code: first?.code ?? 'PARAM_INDEX_READ_FAILED'
              });
              return next;
            });
          }
        } else {
          /*
           * 成功则清掉该项的失败标记（上次可能因容器未挂载而失败，现已可读）。
           *
           * 用函数式更新且不读 entryFailures 当前值：把它加进 loadRows 的依赖
           * 会造成「登记失败 → 依赖变化 → 重新加载 → 再登记」的循环。
           */
          if (selectedEntry !== null) {
            setEntryFailures((current) => {
              if (!current.has(selectedEntry)) return current;
              const next = new Map(current);
              next.delete(selectedEntry);
              return next;
            });
          }
          const invalidRow = result.rows.find((row) =>
            !Number.isSafeInteger(row.rowIndex)
            || row.rowIndex < 0
            || !Number.isSafeInteger(row.id)
            || typeof row.dataHash !== 'string'
            || row.dataHash.length === 0
          );
          if (invalidRow) {
            const message = 'PARAM 行索引缺少完整物理身份（rowIndex + id + dataHash）。';
            setRows([]);
            setLoadedRows([]);
            setRowsError(message);
            if (selectedEntry !== null) {
              setEntryFailures((current) => {
                const next = new Map(current);
                next.set(selectedEntry, { message, code: 'PARAM_ROW_IDENTITY_MISSING' });
                return next;
              });
            }
            setRowsLoading(false);
            return;
          }
          const sessionToken = typeof result.sessionToken === 'string'
            && result.sessionToken.trim().length > 0
            ? result.sessionToken
            : null;
          if (!sessionToken) {
            const message = 'PARAM 行索引未返回可复用 native session，拒绝退回二次解析。';
            setRows([]);
            setLoadedRows([]);
            setRowsError(message);
            if (selectedEntry !== null) {
              setEntryFailures((current) => {
                const next = new Map(current);
                next.set(selectedEntry, { message, code: 'PARAM_DOCUMENT_SESSION_MISSING' });
                return next;
              });
            }
            setRowsLoading(false);
            return;
          }
          setDocumentSessionToken(sessionToken);
          const mapped: ParamRowLine[] = result.rows.map((row) => ({
            rowIndex: row.rowIndex,
            id: row.id,
            dataHash: row.dataHash,
            ...(row.name ? { name: row.name } : {})
          }));
          // 索引首屏：rows/loadedRows 只放轻量身份；payload 由选中行 effect 合并。
          setRows(mapped);
          setLoadedRows(mapped);
          setRowCount(result.rowCount ?? mapped.length);
          setTypeName(result.typeName ?? null);
          setRowDataSize(result.rowDataSize ?? 0);
          setParamName(result.paramName ?? null);
          setContainerHash(result.containerHash ?? '');
          setChildHash(result.childHash ?? '');
          setRowsError(null);
          setPageDiagnostics(
            (result.diagnostics ?? [])
              .filter((diagnostic) => diagnostic.severity === 'warning' || diagnostic.severity === 'error')
              .map((diagnostic) => `${diagnostic.code}：${diagnostic.message}`)
          );
        }
        setRowsLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setRows([]);
        setLoadedRows([]);
        setRowsError(error instanceof Error ? error.message : 'PARAM 行读取异常。');
        setRowsLoading(false);
      });
    return () => { cancelled = true; };
    // 索引只在 param 切换/显式重载时读取；筛选在本地做，不触发全量 payload IPC。
  }, [bridge, props.containerUri, selectedEntry]);

  /**
   * 已取到的物理行索引上的本地筛选：筛选只在 renderer 过滤，不改变 rowIndex。
   */
  const visibleRows = useMemo(() => {
    const needle = rowQueryDebounced.trim().toLowerCase();
    if (!needle) return loadedRows;
    return loadedRows.filter(
      (row) => String(row.id).includes(needle) || (row.name ?? '').toLowerCase().includes(needle)
    );
  }, [loadedRows, rowQueryDebounced]);

  useEffect(() => {
    const dispose = loadRows();
    return dispose;
  }, [loadRows]);

  // ── 右栏：选中行的字段 ──
  const definition = useMemo(() => {
    if (!typeName) return null;
    // 优先宿主（App）经 readParamDocument 下发的定义（裸 param 路径）；
    // 容器路径下宿主拿不到（容器喂 readParamDocument 必失败），回落到
    // readContainerParamPage 随页下发的字段定义（P1 裁定）。
    const fromHost = props.resolveDefinition
      ? props.resolveDefinition(typeName, rowDataSize)
      : null;
    if (fromHost) return fromHost;
    if (!pageFieldDefs || pageFieldDefs.length === 0) return null;
    const fallback: ParamDefDocument = {
      schemaVersion: 1,
      typeName,
      version: 0,
      rowDataSize,
      // 授信来源由主进程裁定（resolveTrustedParamDefinition），渲染器不自行拼。
      origin: pageFieldDefsOrigin,
      fields: pageFieldDefs
    };
    return fallback;
  }, [typeName, rowDataSize, props.resolveDefinition, pageFieldDefs, pageFieldDefsOrigin]);

  /**
   * 选中行。先查当前页再查累积列表。
   *
   * 必须查累积列表：连续滚动后用户会选到非当前页的行，只查 `rows` 会让字段栏
   * 报「本行未随分页下发字节」——那句话在这里是错的（字节其实取到过，
   * 只是不在最后一次请求的那一页里）。
   */
  const selectedRow = useMemo(
    () => rows.find((row) => row.rowIndex === selectedRowIndex)
      ?? loadedRows.find((row) => row.rowIndex === selectedRowIndex)
      ?? null,
    [rows, loadedRows, selectedRowIndex]
  );

  /**
   * 选中行后按物理 rowIndex 取所在页的 payload。
   *
   * 这条请求显式传 false：main 会先建立 lazy session，再用 rowSelections
   * 读取这一页的行字节；不会回到 `includeAllPayloads` 或按过滤后位置猜行。
   */
  useEffect(() => {
    if (
      !bridge
      || typeof bridge.readContainerParamPage !== 'function'
      || selectedEntry === null
      || selectedRowIndex === null
      || !props.containerUri
      || !selectedRow
      || !documentSessionToken
    ) return;
    if (selectedRow.dataBase64 !== undefined) {
      setPayloadLoading(false);
      return;
    }
    if (
      !Number.isSafeInteger(selectedRow.rowIndex)
      || selectedRow.rowIndex < 0
      || typeof selectedRow.dataHash !== 'string'
      || selectedRow.dataHash.length === 0
    ) {
      setPageDiagnostics(['PARAM_ROW_IDENTITY_MISSING：选中行缺少完整物理身份，拒绝读取 payload。']);
      return;
    }

    const requestKey = [
      props.containerUri,
      selectedEntry,
      selectedRow.rowIndex,
      selectedRow.id,
      selectedRow.dataHash,
      documentSessionToken
    ].join('#');
    if (payloadRequestRef.current === requestKey) return;
    payloadRequestRef.current = requestKey;

    let cancelled = false;
    const page = Math.floor(selectedRow.rowIndex / PARAM_PAGE_SIZE);
    setPayloadLoading(true);
    bridge.readContainerParamPage(
      props.containerUri,
      selectedEntry,
      page,
      PARAM_PAGE_SIZE,
      '',
      false,
      documentSessionToken
    )
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          const first = result.diagnostics?.[0];
          setPageDiagnostics([
            `${first?.code ?? 'PARAM_PAGE_PAYLOAD_READ_FAILED'}：${first?.message ?? '选中行 payload 读取失败。'}`
          ]);
          return;
        }

        const payloadByIndex = new Map<number, {
          id: number;
          dataHash?: string;
          dataBase64?: string;
          dataHexPreview?: string;
        }>();
        for (const row of result.rows) {
          if (
            Number.isSafeInteger(row.rowIndex)
            && typeof row.dataBase64 === 'string'
            && typeof row.dataHash === 'string'
          ) {
            payloadByIndex.set(row.rowIndex, {
              id: row.id,
              dataHash: row.dataHash,
              dataBase64: row.dataBase64,
              ...(row.dataHexPreview ? { dataHexPreview: row.dataHexPreview } : {})
            });
          }
        }

        const mergePayload = (current: ParamRowLine[]): ParamRowLine[] => current.map((row) => {
          const payload = payloadByIndex.get(row.rowIndex);
          if (
            !payload
            || payload.id !== row.id
            || payload.dataHash !== row.dataHash
            || typeof payload.dataBase64 !== 'string'
          ) return row;
          return {
            ...row,
            dataBase64: payload.dataBase64,
            ...(payload.dataHexPreview ? { dataHexPreview: payload.dataHexPreview } : {})
          };
        });
        setRows(mergePayload);
        setLoadedRows(mergePayload);
        setTypeName(result.typeName ?? typeName);
        setRowDataSize(result.rowDataSize ?? rowDataSize);
        setParamName(result.paramName ?? paramName);
        setContainerHash(result.containerHash ?? containerHash);
        setChildHash(result.childHash ?? childHash);
        setPageFieldDefs(Array.isArray(result.fieldDefs) ? result.fieldDefs : null);
        setPageFieldEnums(
          Array.isArray(result.fieldEnums)
            ? result.fieldEnums
                .filter((entry) => typeof entry?.id === 'string')
                .map((entry) => ({
                  id: entry.id,
                  name: typeof entry.name === 'string' ? entry.name : entry.id,
                  values: Array.isArray(entry.values)
                    ? entry.values
                        .filter((value) => typeof value?.value === 'number' && typeof value?.label === 'string')
                        .map((value) => ({ value: value.value, label: value.label }))
                    : []
                }))
            : null
        );
        setPageFieldDefsOrigin(
          result.fieldDefsOrigin === 'imported' || result.fieldDefsOrigin === 'user-derived'
            ? result.fieldDefsOrigin
            : 'fixture'
        );
        setPageFieldDefsDiagnostic(
          result.fieldDefsDiagnostic
            && typeof result.fieldDefsDiagnostic.code === 'string'
            && typeof result.fieldDefsDiagnostic.message === 'string'
            ? { code: result.fieldDefsDiagnostic.code, message: result.fieldDefsDiagnostic.message }
            : null
        );
        setPageDiagnostics(
          (result.diagnostics ?? [])
            .filter((diagnostic) => diagnostic.code !== 'PARAM_ROW_PAYLOAD_READ' && diagnostic.code !== 'PARAM_DOCUMENT_SESSION')
            .map((diagnostic) => `${diagnostic.code}：${diagnostic.message}`)
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPageDiagnostics([
          `PARAM_PAGE_PAYLOAD_READ_FAILED：${error instanceof Error ? error.message : '选中行 payload 读取异常。'}`
        ]);
      })
      .finally(() => {
        if (!cancelled) setPayloadLoading(false);
      });
    return () => { cancelled = true; };
  }, [
    bridge,
    props.containerUri,
    selectedEntry,
    selectedRowIndex,
    selectedRow,
    documentSessionToken,
    typeName,
    rowDataSize,
    paramName,
    containerHash,
    childHash
  ]);

  /**
   * 解码选中行的字段值。
   *
   * 用共享的 decodeFieldView（含 bitfield 位提取），逐字段给出 display 与
   * 是否可编辑。解码失败的字段带 diagnostic，不静默显示 0 —— 把「解不出来」
   * 显示成一个具体数值是最坏的形态，用户会照着它改。
   */
  const decodedValues = useMemo(() => {
    if (!definition || !selectedRow?.dataBase64) return null;
    const bytes = base64ToUint8Array(selectedRow.dataBase64);
    const map = new Map<string, ReturnType<typeof decodeFieldView>>();
    for (const field of definition.fields) {
      map.set(field.id, decodeFieldView(bytes, field));
    }
    return map;
  }, [definition, selectedRow]);

  /**
   * 当前行的整数字段值，供条件引用判定（`Target(refType=1)` 里的 refType）。
   *
   * 从 display 字符串反解而不另走一条解码：display 已经是 decodeFieldView 的产物，
   * 再写一份解码逻辑就会出现两套可能不一致的真值。非整数（f32、串、字节块、解码
   * 失败）一律不进表 —— 条件字段实测全是整数标量，进表反而会让「解不出来」被当成
   * 一个具体值参与判定。
   */


  /**
   * 跳转到目标 param 的指定行。
   *
   * ── 为什么不用行筛选实现 ──
   *
   * 第一版把跳转做成「把筛选设成目标 id」，靠后端全表筛选把目标带到第 0 页。
   * 对真实 gameparam.parambnd.dcx（138 个 param、49476 行）实测后否掉，两处硬伤：
   *
   *   ① 后端的 id 筛选是**子串**匹配（`String(row.id).includes(q)`）。筛 "0" 会命中
   *      每个含 0 的 id，实测精确匹配项在筛选结果里最远排到第 36 位，而页大小是
   *      20 —— 目标根本不在第 0 页，跳转会误报「目标表里没有这一行」。
   *      也不能靠「id 升序所以精确匹配必然最靠前」救：实测 5 个 param
   *      （default_AIStandardInfoBank、default_EnemyBehaviorBank、MenuColorTableParam、
   *      NetworkAreaParam、SkeletonParam）的行 id 根本不升序。
   *   ② 后端在**有筛选时刻意不取行字节**（筛选后的页与 Bridge 的物理页不对应，
   *      取了会对错行）。所以哪怕跳到了，字段栏也是空的 —— 跳转的意义正是去看字段。
   *
   * ── 现在的做法 ──
   *
   * 先在无筛选的全表里定位目标行的**绝对下标**，再直接加载「包含该下标的那一页」。
   * 实测 Bridge 的 rowPage/rowPageSize 就是按绝对下标切片（页 0/1/7/42/末页逐一核对
   * 过 id 切片一致），且每页都带字节（payloadsIncluded=true）—— 于是跳过去就能编辑。
   *
   * 行 id 不唯一（实测 10 个 param 共 52 行重复 id，如 CutsceneParam 的 10000000
   * 出现两次），所以契约明确为**第一个匹配的行**，而不是假装唯一。
   */
  /**
   * 字段写入是否放行。
   *
   * T5-2：行宽匹配即授信。definition 非空已经意味着 resolveTrustedParamDefinition
   * 在包校验 + 行宽核对两层都通过（行宽不符根本不返回 document），所以这里不再
   * 检查 origin —— 把「必须先点信任」的路径去掉，行宽对上就放行字段写入。
   * 仍要求 onApplyFieldMutation 出口存在与选中行带行字节（那是写入的必要条件，
   * 不是授权门）。
   */
  const canCommitFields = definition !== null
    && definition.rowDataSize === rowDataSize
    && props.onApplyFieldMutation !== undefined
    && selectedRow?.dataBase64 !== undefined;

  const fields: ParamFieldDef[] = definition?.fields ?? [];
  // 用户裁定（2026-08-14）：右边的值也要全量——字段不再分页（40/页），
  // 一次渲染全部字段（数百个受控输入在选中行时挂载，可接受）。
  const visibleFields = fields;

  const filteredParams = useMemo(() => {
    const needle = paramFilter.trim().toLowerCase();
    if (!needle) return params;
    return params.filter((entry) => entry.name.toLowerCase().includes(needle));
  }, [params, paramFilter]);

  /** enumRef → 枚举定义，供字段栏 O(1) 查表。随页枚举优先于宿主级枚举。 */
  const enumById = useMemo(() => {
    const map = new Map<string, { name: string; values: Array<{ value: number; label: string }> }>();
    for (const entry of props.fieldEnums ?? []) {
      map.set(entry.id, { name: entry.name, values: entry.values });
    }
    for (const entry of pageFieldEnums ?? []) {
      if (!map.has(entry.id)) map.set(entry.id, { name: entry.name, values: entry.values });
    }
    return map;
  }, [props.fieldEnums, pageFieldEnums]);

  /**
   * 当前展开枚举列表的字段 id。
   *
   * 为什么用旁挂可搜索列表而不是 <select>：param 字段的「枚举」是元数据推断的
   * **软约束** —— 底层仍是任意整数，必须允许输入表外的值。下拉会把软约束变成
   * 硬约束，用户想填一个未列出的合法值就填不了。
   * 参照工具同样这么分：param 字段走右键可搜索列表，而 MSB 属性（真 C# enum，
   * 硬约束）才用真下拉。
   */
  const [enumOpenFieldId, setEnumOpenFieldId] = useState<string | null>(null);
  const [enumFilter, setEnumFilter] = useState('');

  // 切换选中行时收起枚举列表：它挂在具体字段上，换行后位置已无意义。
  useEffect(() => {
    setEnumOpenFieldId(null);
    setEnumFilter('');
  }, [selectedRowIndex]);

  // S28：点击枚举列表/展开钮之外任意处收起列表（换字段、点其他行、
  // 关 tab 都走到这里）。列表本身用 capture 阶段冒泡到 document，target
  // 是否在列表或按钮内由调用点判断。
  useEffect(() => {
    if (enumOpenFieldId === null) return;
    function onPointerDown(event: PointerEvent): void {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('.wb-enum-list, .wb-enum-toggle')) return;
      setEnumOpenFieldId(null);
      setEnumFilter('');
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [enumOpenFieldId]);

  /**
   * S29：bool 与 1bit 位字段用打勾（grok §1-9「布尔和 1bit 用打勾，不要数字框」）。
   * 1bit 是标量类型 + bitfield.bitWidth===1（bitOffset 任意）。
   */
  function isBoolLike(field: ParamFieldDef): boolean {
    // S29：判定唯一来源是 paramCheckboxField.ts（bool 整字段或 1bit 位域）。
    return isParamCheckboxField(field);
  }

  /**
   * 提交一个字段。
   *
   * explicitValue 用于枚举选值：点选后立即提交时，setDrafts 还没生效
   * （setState 异步），从闭包里的 drafts 取会读到**上一个**值 ——
   * 表现为「选了枚举值但提交的是旧值」，且没有任何报错。
   * 输入框失焦提交仍走 drafts（那时 state 已更新）。
   */
  async function commitField(field: ParamFieldDef, explicitValue?: string | boolean): Promise<void> {
    if (!canCommitFields || !definition || !selectedRow?.dataBase64 || selectedRow === null) return;
    if (!props.onApplyFieldMutation || selectedEntry === null) return;
    const raw = explicitValue ?? drafts[field.id];
    if (raw === undefined) return;
    setCommitting(true);
    try {
      const result = await props.onApplyFieldMutation({
        paramName: paramName ?? '',
        entryIndex: selectedEntry,
        expectedContainerHash: containerHash,
        expectedChildHash: childHash,
        rowIndex: selectedRow.rowIndex,
        rowId: selectedRow.id,
        expectedDataHash: selectedRow.dataHash,
        expectedRowDataSize: rowDataSize,
        fieldId: field.id,
        // 数值字段按数值提交；解析失败时原样传字符串，由 main 侧的编码器给出
        // 结构化诊断，而不是在这里悄悄改成 0。bool 字段把 'true'/'false'/'1'/'0'
        // 归一成 boolean —— core 写器按 truthy 判定，字符串 'false' 会误写为 1。
        value: field.type === 'bool'
          ? (typeof raw === 'boolean'
            ? raw
            : (raw.trim().toLowerCase() === 'true' || raw.trim() === '1'))
          : (typeof raw === 'string'
            && /^(u?int|f(loat|32|64)|[su]\d+)/i.test(field.type)
            && raw.trim() !== ''
            && !Number.isNaN(Number(raw))
            ? Number(raw)
            : raw),
        rowDataBase64: selectedRow.dataBase64,
        definition
      });
      // S28：保存成功给短时提示（几秒消失），失败留在屏幕上直到下次操作。
      if (result.ok) {
        showToast('已保存', 'ok');
        setDrafts((current) => {
          const next = { ...current };
          delete next[field.id];
          return next;
        });
        loadRows();
      } else {
        showToast(result.message ?? `字段 ${field.name} 提交失败。`, 'error');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '字段提交异常。', 'error');
    } finally {
      setCommitting(false);
    }
  }

  /**
   * 提交一个行名（T5-3）。
   *
   * 与字段写入同一条 Patch 链：onApplyRowNameMutation 由宿主接到
   * applyContainerParamRowNameMutation → write-param upsert(带 name) →
   * write-bnd4 → Patch Engine。名字为空串 = 清掉该行名字（允许）。
   *
   * 「名字没变即收起」与草稿/提交中状态都在 ParamRowsColumn 内闭环，到这里
   * 的只有真正改了名字的提交。useCallback 是硬要求：中栏整体 memo，回调不稳定
   * 会把本组件每次重渲染（字段草稿、枚举开合、toast）都泄进行表。
   */
  const commitRowName = useCallback(async (
    row: ParamRowLine,
    normalizedName: string
  ): Promise<void> => {
    if (!props.onApplyRowNameMutation || selectedEntry === null) return;
    if (!row.dataBase64) return;
    try {
      const result = await props.onApplyRowNameMutation({
        paramName: paramName ?? '',
        entryIndex: selectedEntry,
        expectedContainerHash: containerHash,
        expectedChildHash: childHash,
        rowIndex: row.rowIndex,
        rowId: row.id,
        expectedDataHash: row.dataHash,
        expectedRowDataSize: rowDataSize,
        name: normalizedName,
        rowDataBase64: row.dataBase64
      });
      if (result.ok) {
        showToast('已保存', 'ok');
        loadRows();
      } else {
        showToast(result.message ?? `行 ${row.id} 的名字提交失败。`, 'error');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '行名提交异常。', 'error');
    }
  }, [
    props.onApplyRowNameMutation, selectedEntry, paramName,
    containerHash, childHash, showToast, loadRows
  ]);

  /** 中栏行筛选受控回写。稳定引用（memo 门槛，同 commitRowName 注释）。 */
  const handleRowQueryChange = useCallback((value: string): void => setRowQuery(value), []);
  /** 中栏行选中。稳定引用（memo 门槛，同 commitRowName 注释）。 */
  const handleSelectRow = useCallback((rowIndex: number): void => setSelectedRowIndex(rowIndex), []);

  /**
   * 行级写入（问题 4）：新建行 / 复制当前行 / 删除当前行。
   *
   * 与字段/行名写入同一条 Patch 链：onApplyRowMutation 由宿主接到
   * applyContainerParamRowMutations → write-param add/delete → write-bnd4 →
   * Patch Engine（本组件始终不直接写盘）。
   *
   * 新行 id = 当前表最大 id + 1（不跳过空洞，对照 Yapped）。add/copy 需要整行
   * 字节：copy = 当前行原样；add = 长度=行宽的 0 行（新建一条空行）。delete 只
   * 需要 row id，行字节不发。成功后重读行列表；新建/复制把焦点落到新行。
   */
  async function commitRowMutation(kind: 'add' | 'copy' | 'delete'): Promise<void> {
    if (!props.onApplyRowMutation || selectedEntry === null) return;
    if ((kind === 'copy' || kind === 'delete') && selectedRow === null) return;
    if (kind === 'copy' && !selectedRow?.dataBase64) return;
    setRowMutationBusy(true);
    try {
      let targetId = 0;
      let rowDataBase64 = '';
      if (kind === 'add' || kind === 'copy') {
        targetId = loadedRows.reduce((max, row) => Math.max(max, row.id), 0) + 1;
        rowDataBase64 = kind === 'copy'
          ? (selectedRow?.dataBase64 ?? '')
          : uint8ArrayToBase64(new Uint8Array(Math.max(rowDataSize, 0)));
      } else {
        targetId = selectedRow?.id ?? 0;
      }
      const result = await props.onApplyRowMutation({
        paramName: paramName ?? '',
        entryIndex: selectedEntry,
        expectedContainerHash: containerHash,
        expectedChildHash: childHash,
        kind,
        rowId: targetId,
        rowDataBase64
      });
      const label = kind === 'add' ? '新建' : kind === 'copy' ? '复制' : '删除';
      if (result.ok) {
        showToast(`${label}行已保存`, 'ok');
        loadRows();
        if (kind === 'delete') {
          setSelectedRowIndex(null);
        } else {
          setSelectedRowIndex(targetId);
        }
      } else {
        showToast(result.message ?? `${label}行失败。`, 'error');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '行级写入异常。', 'error');
    } finally {
      setRowMutationBusy(false);
    }
  }

  /**
   * CSV 导入导出（T5-4）的统一提交与反馈。
   *
   * 对话框在 main 侧（save/open dialog）；这里只触发 bridge 方法并把结果诊断
   * 显示到 footer。导入（写入）由 main 经 Patch Engine 提交 —— 本组件始终不
   * 直接写盘。
   */
  async function runCsvIo(
    action: () => Promise<{ ok: boolean; message?: string; diagnostics?: Array<{ message?: string; severity?: string }> }>,
    successText: string
  ): Promise<void> {
    if (!bridge || ioBusy) return;
    setIoBusy(true);
    try {
      const result = await action();
      const primary = result.diagnostics?.find(
        (diagnostic) => diagnostic.severity === 'error' || diagnostic.severity === 'info'
      );
      if (result.ok) {
        showToast(primary?.message ?? successText, 'ok');
      } else {
        showToast(primary?.message ?? result.message ?? '操作失败，容器未修改。', 'error');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'CSV 导入导出异常。', 'error');
    } finally {
      setIoBusy(false);
    }
  }

  const columns: WorkbenchColumnSpec[] = [
    {
      id: 'params',
      title: 'Params',
      // §7.3：table 数量只在栏头以 N tables 显示（Smithbox 形态）。
      hint: `${params.length} tables`,
      // §7.1 固定比例（T5-4 删第四栏 Tools 后沿用前三角）：20/29/35，
      // 最小宽 180/260/320。比例模式随窗口缩放跟随，拖拽后转像素。
      initialFlex: 0.2,
      minWidth: 180,
      children: (
        <div className="wb-list">
          <div style={{ padding: '4px 8px' }}>
            <input
              value={paramFilter}
              onChange={(event) => setParamFilter(event.target.value)}
              placeholder="筛选 param"
              aria-label="筛选容器内 param 名称"
              style={{ width: '100%' }}
            />
          </div>
          {paramsLoading && <p className="wb-empty">加载中…</p>}
          {paramsError && <p className="wb-empty diag-error">{paramsError}</p>}
          {filteredParams.map((entry, index) => {
            const failure = entryFailures.get(entry.entryIndex);
            return (
              <div
                key={entry.entryIndex}
                className={failure ? 'wb-row wb-row--failed' : 'wb-row'}
                {...selectableRowAttributes({
                  selected: selectedEntry === entry.entryIndex,
                  isTabEntry: isRowTabEntry(index, selectedEntry !== null),
                  onSelect: () => setSelectedEntry(entry.entryIndex)
                })}
              >
                <span
                  className="wb-row__name"
                  title={failure ? `${entry.name}（${failure.code}）` : entry.name}
                >
                  {entry.name.replace(/\.param$/i, '')}
                </span>
                {/* 失败标记：该 param 仍留在列表里（不像 Smithbox 那样移除），
                    但明确标出读不出来。不只靠颜色 —— 加文字标记，
                    否则色觉障碍用户分辨不出。 */}
                {failure && <span className="wb-row__meta diag-error">读取失败</span>}
              </div>
            );
          })}
        </div>
      )
    },
    {
      id: 'rows',
      title: 'Rows',
      // 索引首屏：列表一次拿到完整轻量行表，hint 直接报总数。
      // typeName 移到工具栏 —— 它是文档级信息，不是这一列的属性。
      hint: `${visibleRows.length > 0 || rowQueryDebounced === '' ? rowCount : visibleRows.length} 行`,
      initialFlex: 0.29,
      minWidth: 260,
      children: (
        // 行表整体包进 memo 化的 ParamRowsColumn：虚拟化器随之搬进去，滚动驱动
        // 的重渲染被封在栏内，不再每帧拖着字段栏（数百受控输入）与左栏重渲染
        // —— 那是快滚掉帧露白的根因（组件注释有完整因果）。
        <ParamRowsColumn
          selectedEntry={selectedEntry}
          visibleRows={visibleRows}
          rowsLoading={rowsLoading}
          rowsError={rowsError}
          rowQuery={rowQuery}
          onRowQueryChange={handleRowQueryChange}
          selectedRowIndex={selectedRowIndex}
          onSelectRow={handleSelectRow}
          paramName={paramName}
          rowNameEditable={props.onApplyRowNameMutation !== undefined}
          onCommitRowName={commitRowName}
        />
      )
    },
    {
      id: 'fields',
      title: 'Fields',
      hint: definition ? `${fields.length} 个字段` : (typeName ? '无字段定义' : ''),
      initialFlex: 0.35,
      // 问题 3：320 → 240（与 FMG 文本列同档）。Agent 拉宽后主区装不下
      // 180+260+320=760，FIELDS 被挤出可视区像是被 Agent 盖住；降下限后
      // 默认侧栏宽度下三栏可完整入屏，更窄时仍可横向滚动（.workbench__columns
      // overflow-x: auto）兜底，不裁内容。
      minWidth: 240,
      children: (
        <div className="wb-props">
          {/* 选中的 param 读不出来时，右栏给出结构化原因而不是空白。
              对照 Smithbox：它的 Fields 栏永远不会显示「此 param 无 ParamDef」
              ——因为失败的 param 根本进不了列表，用户点不到。本项目不照抄那个
              形态，硬约束要求 failed 必须返回结构化诊断。 */}
          {selectedEntry !== null && entryFailures.has(selectedEntry) && (
            <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="diag-error">这个 param 读不出来</span>
              <span className="muted" style={{ fontSize: 11 }}>
                {entryFailures.get(selectedEntry)?.message}
              </span>
              <span className="muted mono" style={{ fontSize: 10 }}>
                {entryFailures.get(selectedEntry)?.code}
              </span>
              <span className="muted" style={{ fontSize: 11 }}>
                容器内其他 param 不受影响；完整诊断见底部日志。
              </span>
            </div>
          )}
          {selectedRowIndex === null && selectedEntry !== null && !entryFailures.has(selectedEntry) && (
            <p className="wb-empty">先在中栏选择一行。</p>
          )}
          {selectedEntry === null && <p className="wb-empty">先在左栏选择一个 param。</p>}
          {selectedRowIndex !== null && payloadLoading && (
            <p className="wb-empty" role="status">读取选中行字节…</p>
          )}
          {selectedRowIndex !== null && !payloadLoading && definition === null && (
            <p className="wb-empty">
              没有可用的字段定义{typeName ? `（${typeName}）` : ''}。字段视图不可用。
              {pageFieldDefsDiagnostic && (
                <span className="muted" style={{ display: 'block', fontSize: 11 }}>
                  {pageFieldDefsDiagnostic.code}：{pageFieldDefsDiagnostic.message}
                </span>
              )}
            </p>
          )}
          {selectedRowIndex !== null && !payloadLoading && definition !== null && selectedRow?.dataBase64 === undefined && (
            <p className="wb-empty">
              本行没有行字节，字段值无法解码（选中行 payload 未返回；请查看底部诊断）。
            </p>
          )}
          {selectedRowIndex !== null && definition !== null && (
            <>
              {visibleFields.map((field) => {
                const decoded = decodedValues?.get(field.id);
                const draft = drafts[field.id];
                const shown = draft ?? decoded?.display ?? '';
                const enumMeta = field.enumRef ? enumById.get(field.enumRef) : undefined;
                // 当前值对应的标签。找不到（值不在表内）时为 undefined ——
                // 那是合法情形：param 字段的枚举是软约束，允许表外值。
                const enumLabel = enumMeta && shown !== ''
                  ? enumMeta.values.find((option) => String(option.value) === shown)?.label
                  : undefined;
                const enumOpen = enumOpenFieldId === field.id;
                const enumOptions = enumMeta && enumOpen
                  ? enumMeta.values.filter((option) => {
                      const needle = enumFilter.trim().toLowerCase();
                      if (!needle) return true;
                      return String(option.value).includes(needle)
                        || option.label.toLowerCase().includes(needle);
                    })
                  : [];
                // 字段自身不可编辑（定长串、字节块、未知类型）时即使整体放行也要禁用：
                // 放开会让用户以为改得动，提交后才发现被编码器拒绝。
                const editable = canCommitFields && decoded?.editable === true;
                return (
                  <div className="wb-prop" key={field.id} {...citeFieldAttr(field, shown, selectedRow?.id ?? 0, paramName)}>
                    <span
                      className="wb-prop__name"
                      title={decoded?.diagnostic
                        ? `${field.name}（${decoded.diagnostic}）`
                        : (field.description ?? field.name)}
                    >
                      {field.name}
                      {/* 枚举名显示在字段名旁（对照参照工具的做法）。
                          有值表时显示当前值对应的标签，没有值表时只显示枚举名 ——
                          空 values 是正常状态（多数 enum 没有值表），
                          当成「无枚举」会让用户不知道这是个枚举字段。 */}
                      {field.enumRef && (
                        <span className="wb-prop__enum">
                          {' '}
                          {enumLabel ?? enumMeta?.name ?? field.enumRef}
                        </span>
                      )}
                    </span>
                    {/* 只读字段仍然是 input（readOnly）而不是 span。
                        对照结论：参照工具的只读列用「相同控件 + ReadOnly flag +
                        变色」，全仓无 BeginDisabled。理由是 disabled/span 都会丢掉
                        焦点与文本选中 —— 用户无法复制对照列或不可编辑字段的值，
                        而「把这个数值抄到别处」正是只读列最常见的用途。 */}
                    <span className="wb-prop__value">
                      {/* S29：bool 与 1bit 字段用打勾而不是数字框（grok §1-9）。
                          点勾即直接写入（§1-10），不需要失焦。 */}
                      {isBoolLike(field) ? (
                        <input
                          type="checkbox"
                          checked={draft !== undefined
                            ? (field.type === 'bool' ? draft === 'true' : draft === '1')
                            : (decoded?.display === 'true' || decoded?.display === '1')}
                          disabled={!editable || committing}
                          aria-label={`${field.name} 值${editable ? '' : '（只读）'}`}
                          aria-readonly={!editable}
                          title={decoded?.diagnostic ?? shown}
                          onChange={(event) => {
                            if (!editable) return;
                            const checked = event.target.checked;
                            // 保持与输入框同一条 draft 链：失焦/枚举的提交语义一致。
                            const next = field.type === 'bool'
                              ? (checked ? 'true' : 'false')
                              : (checked ? '1' : '0');
                            setDrafts((current) => ({ ...current, [field.id]: next }));
                            // bool 传 boolean（core 写器按 truthy 判定，字符串 'false'
                            // 会被误写成 1）；1bit 传 '0'/'1' 字符串。
                            void commitField(field, field.type === 'bool' ? checked : next);
                          }}
                        />
                      ) : (
                        <input
                          value={shown === '' && !editable ? '—' : shown}
                          readOnly={!editable}
                          className={editable
                            ? undefined
                            : (decoded?.diagnostic ? 'is-readonly diag-warn' : 'is-readonly')}
                          onChange={(event) => {
                            if (!editable) return;
                            setDrafts((current) => ({ ...current, [field.id]: event.target.value }));
                          }}
                          onBlur={() => {
                            if (editable && drafts[field.id] !== undefined) void commitField(field);
                          }}
                          // disabled 只表达「提交中」这个瞬时状态，不表达只读。
                          disabled={editable && committing}
                          aria-label={`${field.name} 值${editable ? '' : '（只读）'}`}
                          aria-readonly={!editable}
                          title={decoded?.diagnostic ?? shown}
                        />
                      )}
                      {/* 枚举选值入口：只在有值表且字段可编辑时出现。
                          空值表的枚举没有可选项，给个按钮会点开一个空列表。 */}
                      {editable && enumMeta && enumMeta.values.length > 0 && (
                        <button
                          type="button"
                          className="wb-enum-toggle"
                          aria-expanded={enumOpen}
                          aria-label={`选择 ${field.name} 的枚举值`}
                          onClick={() => {
                            setEnumOpenFieldId(enumOpen ? null : field.id);
                            setEnumFilter('');
                          }}
                        >▾</button>
                      )}
                      {enumOpen && enumMeta && (
                        <div className="wb-enum-list" role="listbox" aria-label={`${field.name} 枚举值`}>
                          <input
                            value={enumFilter}
                            onChange={(event) => setEnumFilter(event.target.value)}
                            placeholder="筛选值或名称"
                            aria-label="筛选枚举值"
                            autoFocus
                            onKeyDown={(event) => {
                              // S28：Esc 收起列表（回到输入框继续改数值）。
                              if (event.key === 'Escape') {
                                event.stopPropagation();
                                setEnumOpenFieldId(null);
                                setEnumFilter('');
                              }
                            }}
                          />
                          <div className="wb-enum-list__options">
                            {enumOptions.length === 0 && (
                              <p className="wb-empty">无匹配值。</p>
                            )}
                            {enumOptions.map((option) => (
                              <button
                                type="button"
                                key={option.value}
                                role="option"
                                aria-selected={String(option.value) === shown}
                                className="wb-enum-option"
                                onClick={() => {
                                  setDrafts((current) => ({
                                    ...current,
                                    [field.id]: String(option.value)
                                  }));
                                  setEnumOpenFieldId(null);
                                  setEnumFilter('');
                                  // 显式传值：setDrafts 还没生效，读 drafts 会拿到旧值。
                                  void commitField(field, String(option.value));
                                }}
                              >
                                <span className="wb-enum-option__value">{option.value}</span>
                                <span className="wb-enum-option__label">{option.label}</span>
                              </button>
                            ))}
                          </div>
                          <p className="muted" style={{ fontSize: 10, padding: '2px 6px' }}>
                            也可直接在输入框填表外的值（这里的枚举是元数据推断，不是硬约束）。
                          </p>
                        </div>
                      )}
                    </span>
                  </div>
                );
              })}
            </>
          )}
        </div>
      )
    }
  ];

  const footerMessages = [
    ...pageDiagnostics,
    // 页面级字段诊断（P1）：readContainerParamPage 随页下发，主进程在
    // resolveTrustedParamDefinition 里区分「包不可用/类型不存在/行宽不符/尚未授信」。
    ...(selectedRowIndex !== null && definition === null && pageFieldDefsDiagnostic
      ? [`字段定义不可用：${pageFieldDefsDiagnostic.code}——${pageFieldDefsDiagnostic.message}`]
      : []),
    // 只读原因必须说清下一步动作。T5-2 起行宽匹配即授信，字段写入不再被信任
    // 门挡着 —— 只剩行字节缺失这一种真实的只读原因。
    ...(selectedRowIndex !== null && definition !== null && !canCommitFields
      ? [
          selectedRow?.dataBase64 === undefined
            ? (payloadLoading ? '字段值读取中：等待选中行 payload。' : '字段写入未放行：本行字节未按需下发。')
            : '字段写入未放行：字段编辑出口未接通。数值可读，提交已关闭。'
        ]
      : [])
  ];

  return (
    <div className="param-workbench">
      {/* S28：保存提示条。成功几秒后自动消失；失败（kind=error）留在原处
          直到下一次操作，让用户有时间读到原因。绝对定位在整台左上角，
          不占布局。 */}
      {toast !== null && (
        <div
          className={`wb-toast wb-toast--${toast.kind}`}
          role="status"
          aria-live="polite"
        >
          {toast.text}
        </div>
      )}
      <WorkbenchLayout
      label="PARAM 工作台"
      columns={columns}
      toolbar={
        <>
          {/* T5-4：删掉旧的「Game Parameters · 1 library · N tables」crumb、类型名、
              行大小。换成真实工具条：新建行/复制当前行/删除当前行（问题 4，写入走
              onApplyRowMutation → Patch Engine）+ 导出行/导入行（字段值）、导出备注/
              导入备注（行名，对照 Yapped Export/Import Names）。对话框都在 main 侧，
              导入写入走 Patch Engine。未选表时按钮禁用（没有可操作的表格目标）。 */}
          <span className="toolbar-spacer" style={{ flex: 1 }}></span>
          {/* 问题 4：对照本地参数编辑器（Yapped/Smithbox）行级工具。未选表时全部
              禁用；选表未选行时「新建行」可用（新 id = 当前表最大 id + 1），
              复制/删除仍禁用。写入走 onApplyRowMutation → Patch Engine。 */}
          <button
            type="button"
            className="toolbar-button"
            disabled={rowMutationBusy || selectedEntry === null}
            title="新建一行（id = 当前表最大 id + 1，字节全 0）"
            onClick={() => { void commitRowMutation('add'); }}
          >新建行</button>
          <button
            type="button"
            className="toolbar-button"
            disabled={rowMutationBusy || selectedEntry === null || selectedRow === null}
            title="复制当前行到新 id（整行字节原样）"
            onClick={() => { void commitRowMutation('copy'); }}
          >复制当前行</button>
          <button
            type="button"
            className="toolbar-button"
            disabled={rowMutationBusy || selectedEntry === null || selectedRow === null}
            title="删除当前行（经 Patch Engine，含备份与回滚）"
            onClick={() => { void commitRowMutation('delete'); }}
          >删除当前行</button>
          <button
            type="button"
            className="toolbar-button"
            disabled={ioBusy || selectedEntry === null}
            title="导出当前表所有行（id,name,字段值）为 CSV"
            onClick={() => {
              if (!bridge || selectedEntry === null) return;
              void runCsvIo(() =>
                bridge.exportParamRowsCsv(props.containerUri, containerHash, selectedEntry),
                '已导出'
              );
            }}
          >导出行</button>
          <button
            type="button"
            className="toolbar-button"
            disabled={ioBusy || selectedEntry === null}
            title="从 CSV 导入行数据（表头 id,name,字段内部 id…；空单元格不改）"
            onClick={() => {
              if (!bridge || selectedEntry === null) return;
              void runCsvIo(() =>
                bridge.importParamRowsCsv(
                  props.containerUri, containerHash, selectedEntry, childHash
                ),
                '已保存'
              );
            }}
          >导入行</button>
          <button
            type="button"
            className="toolbar-button"
            disabled={ioBusy || selectedEntry === null}
            title="导出当前表行名（id,name）为 CSV，对照 Yapped Export Names"
            onClick={() => {
              if (!bridge || selectedEntry === null) return;
              void runCsvIo(() =>
                bridge.exportParamNamesCsv(props.containerUri, containerHash, selectedEntry),
                '已导出'
              );
            }}
          >导出备注</button>
          <button
            type="button"
            className="toolbar-button"
            disabled={ioBusy || selectedEntry === null}
            title="从 CSV 导入行名（表头 id,name），对照 Yapped Import Names"
            onClick={() => {
              if (!bridge || selectedEntry === null) return;
              void runCsvIo(() =>
                bridge.importParamNamesCsv(
                  props.containerUri, containerHash, selectedEntry, childHash
                ),
                '已保存'
              );
            }}
          >导入备注</button>
        </>
      }
      {...(footerMessages.length > 0
        ? {
            footer: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {footerMessages.map((message) => (
                  <span key={message} className="muted" style={{ fontSize: 11 }}>{message}</span>
                ))}
              </div>
            )
          }
        : {})}
    />
    </div>
  );
}
