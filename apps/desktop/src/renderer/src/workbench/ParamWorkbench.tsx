/**
 * PARAM 三栏工作台（对照 Smithbox 2.2.4 的 Param Editor）。
 *
 * 左：Param List —— parambnd 容器内的 param 条目
 * 中：Row List   —— 选中 param 的行（id + name），分页 + 筛选
 * 右：Field List —— 选中行的字段（名 + 值）
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

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { PARAM_PAGE_SIZE } from '@soulforge/shared';
import type { ParamDefDocument, ParamFieldDef } from '@soulforge/shared';
import { getRendererBridge } from '../runtime/rendererRuntime.js';
import { isRowTabEntry, selectableRowAttributes } from '../a11y/selectableRow.js';
import { base64ToUint8Array } from '../utils/binary.js';
// 复用 ParamDefPanel 的解码器：解码权威必须单一（见该处导出注释）。
import { decodeFieldView } from '../editors/ParamDefPanel.js';
import { WorkbenchLayout, type WorkbenchColumnSpec } from './WorkbenchLayout.js';

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

/** 一行。 */
export interface ParamRowLine {
  id: number;
  name?: string;
  dataBase64?: string;
  dataHexPreview?: string;
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
    rowId: number;
    fieldId: string;
    value: number | string | boolean;
    rowDataBase64: string;
    definition: ParamDefDocument;
  }) => Promise<{ ok: boolean; message?: string }>;
}

/** 字段分页大小。数百字段一次性建受控输入会让首屏卡顿。 */
const FIELD_PAGE_SIZE = 40;

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
  const [rowPage, setRowPage] = useState(0);
  const [rowPageCount, setRowPageCount] = useState(1);
  const [loadedRows, setLoadedRows] = useState<ParamRowLine[]>([]);
  const [loadedPages, setLoadedPages] = useState(0);
  const [appending, setAppending] = useState(false);
  /** 行栏滚动容器。虚拟化器要它测量视口与滚动位置。 */
  const rowScrollRef = useRef<HTMLDivElement | null>(null);
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
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [typeName, setTypeName] = useState<string | null>(null);
  const [rowDataSize, setRowDataSize] = useState(0);
  const [paramName, setParamName] = useState<string | null>(null);
  const [pageDiagnostics, setPageDiagnostics] = useState<string[]>([]);
  /**
   * 写回所需的两个哈希，由 readContainerParamPage 给出，写入时原样回传。
   *
   * 渲染器不自己算：它拿不到容器字节。容器哈希防「读与写之间容器被改过」，
   * 条目哈希防「同一条目被并发改过」—— 缺它们就没有并发保护，两个基于同一份
   * 旧字节的改动会互相静默覆盖。
   */
  const [containerHash, setContainerHash] = useState<string>('');
  const [childHash, setChildHash] = useState<string>('');

  const [selectedRowId, setSelectedRowId] = useState<number | null>(null);
  const [fieldPage, setFieldPage] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [commitMessage, setCommitMessage] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);

  /**
   * 元数据包的信任状态。
   *
   * 字段写入要放行必须先经用户确认这一步 —— 元数据的字段偏移若与真实 PARAM
   * 不符，按它写入就是往错误字节位置塞数值，存出来的 param 静默损坏。
   * 这个风险与「谁在改」无关：手动改也一样错，所以不能按操作者身份豁免。
   *
   * 「这个文件是不是那个发布」由机器校验（导入器核对归档/源树/许可证三个摘要）；
   * 「你愿不愿意用它」只能由用户回答。确认一次后本机后续都放行，
   * 包内容变化（升级、被替换）会因摘要不符而重新询问。
   */
  const [trustState, setTrustState] = useState<{
    ok: boolean;
    trusted: boolean;
    packageId: string | null;
    packageVersion: string | null;
    confirmedAt?: string;
  } | null>(null);
  const [trustBusy, setTrustBusy] = useState(false);

  const loadTrustState = useCallback(() => {
    if (!bridge || typeof bridge.getParamMetadataTrustState !== 'function') return;
    bridge.getParamMetadataTrustState()
      .then((result) => setTrustState({
        ok: result.ok,
        trusted: result.trusted,
        packageId: result.packageId,
        packageVersion: result.packageVersion,
        ...(result.confirmedAt ? { confirmedAt: result.confirmedAt } : {})
      }))
      .catch(() => setTrustState(null));
  }, [bridge]);

  useEffect(() => {
    loadTrustState();
  }, [loadTrustState]);


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
    setRowPage(0);
    setSelectedRowId(null);
    setDrafts({});
    setCommitMessage(null);
    // 连续列表必须清：残留会让新 param 的列表里混着上一个 param 的行，
    // 而两者行宽通常不同，选中后字段会按错误的定义解码。
    setLoadedRows([]);
    setLoadedPages(0);
  }, [selectedEntry]);

  useEffect(() => {
    setFieldPage(0);
    setDrafts({});
    setCommitMessage(null);
  }, [selectedRowId]);

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

  // ── 中栏：选中 param 的行分页 ──
  const loadRows = useCallback(() => {
    if (!bridge || typeof bridge.readContainerParamPage !== 'function') return;
    if (selectedEntry === null || !props.containerUri) return;
    let cancelled = false;
    setRowsLoading(true);
    setRowsError(null);
    bridge.readContainerParamPage(
      props.containerUri, selectedEntry, rowPage, PARAM_PAGE_SIZE, rowQueryDebounced
    )
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setRows([]);
          // 累积列表一并清空：否则失败后仍显示上一个 param 的行，
          // 用户会以为读到的是当前 param 的数据。
          setLoadedRows([]);
          setLoadedPages(0);
          const first = result.diagnostics?.[0];
          setRowsError(first?.message ?? 'PARAM 行读取失败。');
          setPageDiagnostics([]);
          // 登记失败：该 param 在左栏保留并标记，不像 Smithbox 那样从列表消失。
          if (selectedEntry !== null) {
            setEntryFailures((current) => {
              const next = new Map(current);
              next.set(selectedEntry, {
                message: first?.message ?? 'PARAM 行读取失败。',
                code: first?.code ?? 'PARAM_READ_FAILED'
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
          const mapped = result.rows.map((row) => ({
            id: row.id,
            ...(row.name ? { name: row.name } : {}),
            ...(row.dataBase64 ? { dataBase64: row.dataBase64 } : {}),
            ...(row.dataHexPreview ? { dataHexPreview: row.dataHexPreview } : {})
          }));
          setRows(mapped);
          /*
           * 累积到连续列表。
           *
           * 第 0 页替换（切 param、改筛选、写回后重读都从 0 开始），
           * 后续页按 id 去重追加 —— 去重是必需的：重读当前页会再拿到同一批 id，
           * 直接 concat 会让同一行在列表里出现两次，而用户会以为有重复数据。
           */
          setLoadedRows((current) => {
            if (result.page === 0) return mapped;
            const seen = new Set(current.map((row) => row.id));
            return [...current, ...mapped.filter((row) => !seen.has(row.id))];
          });
          setLoadedPages(result.page + 1);
          setRowPageCount(result.pageCount);
          setRowCount(result.rowCount);
          setTypeName(result.typeName ?? null);
          setRowDataSize(result.rowDataSize ?? 0);
          setParamName(result.paramName ?? null);
          setContainerHash(result.containerHash ?? '');
          setChildHash(result.childHash ?? '');
          setRowsError(null);
          // 只展示 info/warning 里对用户有行动意义的那部分（例如「本页无字节」）。
          setPageDiagnostics(
            (result.diagnostics ?? [])
              .filter((d) => d.code === 'PARAM_PAGE_PAYLOAD_OMITTED'
                || d.code === 'PARAM_PAGE_PAYLOAD_READ_FAILED')
              .map((d) => d.message)
          );
        }
        setRowsLoading(false);
        // 复位续取标志：不复位会让「继续加载」按钮永久禁用。
        setAppending(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setRows([]);
        setLoadedRows([]);
        setLoadedPages(0);
        setRowsError(error instanceof Error ? error.message : 'PARAM 行读取异常。');
        setRowsLoading(false);
        setAppending(false);
      });
    return () => { cancelled = true; };
    // 依赖用 debounced 值：用 rowQuery 会让每个字符都触发一次 IPC。
  }, [bridge, props.containerUri, selectedEntry, rowPage, rowQueryDebounced]);

  /*
   * 筛选生效时回到第 0 页并清累积。
   *
   * 不清会把上一次筛选的结果与新结果混在一起 —— 那正是「按 id 去重」也救不了的
   * 情形：两批行的 id 不重叠但都不属于当前筛选条件。
   */
  useEffect(() => {
    setRowPage(0);
    setLoadedRows([]);
    setLoadedPages(0);
    setSelectedRowId(null);
  }, [rowQueryDebounced]);

  useEffect(() => {
    const dispose = loadRows();
    return dispose;
  }, [loadRows]);

  /**
   * 记录/撤销信任。定义在 loadRows 之后，因为它要在成功后重新取行 ——
   * origin 变化会改变字段写入的放行状态。
   */
  async function confirmTrust(next: boolean): Promise<void> {
    if (!bridge || typeof bridge.setParamMetadataTrust !== 'function') return;
    setTrustBusy(true);
    setCommitMessage(null);
    try {
      const result = await bridge.setParamMetadataTrust(next);
      if (!result.ok) {
        setCommitMessage(result.diagnostics?.[0]?.message ?? '信任决定记录失败。');
      } else {
        loadTrustState();
        loadRows();
      }
    } catch (error) {
      setCommitMessage(error instanceof Error ? error.message : '信任决定记录异常。');
    } finally {
      setTrustBusy(false);
    }
  }

  // ── 右栏：选中行的字段 ──
  const definition = useMemo(() => {
    if (!typeName || !props.resolveDefinition) return null;
    return props.resolveDefinition(typeName, rowDataSize);
  }, [typeName, rowDataSize, props.resolveDefinition]);

  /**
   * 选中行。先查当前页再查累积列表。
   *
   * 必须查累积列表：连续滚动后用户会选到非当前页的行，只查 `rows` 会让字段栏
   * 报「本行未随分页下发字节」——那句话在这里是错的（字节其实取到过，
   * 只是不在最后一次请求的那一页里）。
   */
  const selectedRow = useMemo(
    () => rows.find((row) => row.id === selectedRowId)
      ?? loadedRows.find((row) => row.id === selectedRowId)
      ?? null,
    [rows, loadedRows, selectedRowId]
  );

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
   * origin 必须是已授信来源：那道门守的是「元数据包的字段偏移与这份真实 PARAM
   * 是否对得上」。偏移错了就是往错误字节位置写数值，存出来的 param 静默损坏。
   * 这个风险与「谁在改」无关，手动改也一样错，所以不能按操作者身份豁免。
   */
  const canCommitFields = definition !== null
    && (definition.origin === 'user-derived' || definition.origin === 'imported')
    && definition.rowDataSize === rowDataSize
    && props.onApplyFieldMutation !== undefined
    && selectedRow?.dataBase64 !== undefined;

  const fields: ParamFieldDef[] = definition?.fields ?? [];
  const fieldPageCount = Math.max(1, Math.ceil(fields.length / FIELD_PAGE_SIZE));
  const visibleFields = useMemo(
    () => fields.slice(fieldPage * FIELD_PAGE_SIZE, (fieldPage + 1) * FIELD_PAGE_SIZE),
    [fields, fieldPage]
  );

  const filteredParams = useMemo(() => {
    const needle = paramFilter.trim().toLowerCase();
    if (!needle) return params;
    return params.filter((entry) => entry.name.toLowerCase().includes(needle));
  }, [params, paramFilter]);

  /** enumRef → 枚举定义，供字段栏 O(1) 查表。 */
  const enumById = useMemo(() => {
    const map = new Map<string, { name: string; values: Array<{ value: number; label: string }> }>();
    for (const entry of props.fieldEnums ?? []) {
      map.set(entry.id, { name: entry.name, values: entry.values });
    }
    return map;
  }, [props.fieldEnums]);

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
  }, [selectedRowId]);

  /**
   * 行表虚拟化。
   *
   * 为什么必须虚拟化：BehaviorParam 有 5275 行。对照 Smithbox 的取舍 —— 它一次
   * 全画 5275 行（ImGui 每帧重建，无 DOM 节点成本），并且刻意**不**给 param 行
   * 用 clipper（因为它的行带 decorator，高度不齐一）。DOM 下全画不可行：每行是
   * 真实节点。所以我们的约束比它更紧，更该虚拟化，而不是退回分页。
   *
   * 行高锁定 22px（等高）：可变高度要测量模式，而 param 行的信息量固定
   * （id + name），锁等高 + 溢出省略号是更简单也更稳的选择。
   *
   * overscan 12：滚动时预渲染视口外 12 行，避免快速拖动出现空白。
   */
  const rowVirtualizer = useVirtualizer({
    count: loadedRows.length,
    getScrollElement: () => rowScrollRef.current,
    estimateSize: () => 22,
    overscan: 12
  });

  /*
   * 滚到接近底部时自动续取下一批。
   *
   * 取数仍按 PARAM_PAGE_SIZE（行字节的载荷门控按页算），但用户感知是连续滚动。
   * 阈值取「最后一个可见行进入末尾 20 行范围内」，而不是精确到底 —— 到底才取
   * 会让滚动停顿一下才继续。
   */
  const virtualRows = rowVirtualizer.getVirtualItems();
  // ?? 0 而不是非空断言：noUncheckedIndexedAccess 下索引访问可能是 undefined，
  // 用断言会把「列表为空」这个真实状态藏起来。
  const lastVisibleIndex = virtualRows[virtualRows.length - 1]?.index ?? 0;
  useEffect(() => {
    if (rowsLoading || appending) return;
    if (loadedPages >= rowPageCount) return;
    if (loadedRows.length === 0) return;
    if (lastVisibleIndex < loadedRows.length - 20) return;
    setAppending(true);
    setRowPage(loadedPages);
  }, [lastVisibleIndex, loadedRows.length, loadedPages, rowPageCount, rowsLoading, appending]);

  /**
   * 提交一个字段。
   *
   * explicitValue 用于枚举选值：点选后立即提交时，setDrafts 还没生效
   * （setState 异步），从闭包里的 drafts 取会读到**上一个**值 ——
   * 表现为「选了枚举值但提交的是旧值」，且没有任何报错。
   * 输入框失焦提交仍走 drafts（那时 state 已更新）。
   */
  async function commitField(field: ParamFieldDef, explicitValue?: string): Promise<void> {
    if (!canCommitFields || !definition || !selectedRow?.dataBase64 || selectedRow === null) return;
    if (!props.onApplyFieldMutation || selectedEntry === null) return;
    const raw = explicitValue ?? drafts[field.id];
    if (raw === undefined) return;
    setCommitting(true);
    setCommitMessage(null);
    try {
      const result = await props.onApplyFieldMutation({
        paramName: paramName ?? '',
        entryIndex: selectedEntry,
        expectedContainerHash: containerHash,
        expectedChildHash: childHash,
        rowId: selectedRow.id,
        fieldId: field.id,
        // 数值字段按数值提交；解析失败时原样传字符串，由 main 侧的编码器给出
        // 结构化诊断，而不是在这里悄悄改成 0。
        value: /^(u?int|f(loat|32|64)|[su]\d+)/i.test(field.type) && raw.trim() !== '' && !Number.isNaN(Number(raw))
          ? Number(raw)
          : raw,
        rowDataBase64: selectedRow.dataBase64,
        definition
      });
      setCommitMessage(result.ok
        ? `字段 ${field.name} 已提交到变更候选。`
        : (result.message ?? `字段 ${field.name} 提交失败。`));
      if (result.ok) {
        setDrafts((current) => {
          const next = { ...current };
          delete next[field.id];
          return next;
        });
        loadRows();
      }
    } catch (error) {
      setCommitMessage(error instanceof Error ? error.message : '字段提交异常。');
    } finally {
      setCommitting(false);
    }
  }

  const columns: WorkbenchColumnSpec[] = [
    {
      id: 'params',
      title: 'Params',
      // §7.3：table 数量只在栏头以 N tables 显示（Smithbox 形态）。
      hint: `${params.length} tables`,
      // §7.1 固定比例（REF-01 实测无冲突，沿用初值）：20/29/35/16，
      // 最小宽 180/260/320/200。比例模式随窗口缩放跟随，拖拽后转像素。
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
      // hint 要如实反映「已加载多少 / 共多少」：只显示总数会让用户以为
      // 列表已完整，而滚到底才发现还有「继续加载」。
      // typeName 移到工具栏 —— 它是文档级信息，不是这一列的属性。
      hint: loadedRows.length > 0 && loadedRows.length < rowCount
        ? `${loadedRows.length}/${rowCount} 行`
        : `${rowCount} 行`,
      initialFlex: 0.29,
      minWidth: 260,
      children: (
        // --virtual：本栏的滚动权交给内部虚拟容器，外层不滚（否则双滚动条）。
        <div className="wb-list wb-list--virtual">
          {selectedEntry === null && <p className="wb-empty">先在左栏选择一个 param。</p>}
          {selectedEntry !== null && (
            <>
              <div style={{ padding: '4px 8px', display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  value={rowQuery}
                  onChange={(event) => {
                    setRowQuery(event.target.value);
                    setRowPage(0);
                  }}
                  placeholder="筛选 id / name"
                  aria-label="筛选 PARAM 行 id 或 name（作用于完整行表）"
                  style={{ flex: 1, minWidth: 0 }}
                />
              </div>
              {rowsError && <p className="wb-empty diag-error">{rowsError}</p>}
              {!rowsLoading && !rowsError && loadedRows.length === 0 && (
                <p className="wb-empty">没有匹配的行。</p>
              )}
              {/* 虚拟滚动：一条连续长列表，DOM 只保留可见行 + overscan。
                  滚到接近底部自动续取（见 rowVirtualizer 附近的 effect）。
                  role=grid + aria-rowcount 给出**总行数**而不是渲染数 ——
                  否则屏幕阅读器会播报「共 20 行」而实际有 5275 行。 */}
              <div
                ref={rowScrollRef}
                className="wb-virtual-scroll"
                role="grid"
                aria-rowcount={rowCount}
                aria-label="PARAM 行列表"
              >
                <div
                  className="wb-virtual-sizer"
                  style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
                >
                  {virtualRows.map((virtualRow) => {
                    const row = loadedRows[virtualRow.index];
                    if (!row) return null;
                    return (
                      <div
                        key={row.id}
                        className="wb-row wb-virtual-row"
                        style={{
                          height: `${virtualRow.size}px`,
                          transform: `translateY(${virtualRow.start}px)`
                        }}
                        aria-rowindex={virtualRow.index + 1}
                        {...selectableRowAttributes({
                          selected: selectedRowId === row.id,
                          isTabEntry: isRowTabEntry(virtualRow.index, selectedRowId !== null),
                          onSelect: () => setSelectedRowId(row.id)
                        })}
                      >
                        <span className="wb-row__id">{row.id}</span>
                        <span className="wb-row__name" title={row.name ?? ''}>{row.name ?? '—'}</span>
                      </div>
                    );
                  })}
                </div>
                {(rowsLoading || appending) && loadedRows.length > 0 && (
                  <p className="wb-empty" style={{ padding: '4px 10px' }}>加载中…</p>
                )}
              </div>
            </>
          )}
        </div>
      )
    },
    {
      id: 'fields',
      title: 'Fields',
      hint: definition ? `${fields.length} 个字段` : (typeName ? '无字段定义' : ''),
      initialFlex: 0.35,
      minWidth: 320,
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
          {selectedRowId === null && selectedEntry !== null && !entryFailures.has(selectedEntry) && (
            <p className="wb-empty">先在中栏选择一行。</p>
          )}
          {selectedEntry === null && <p className="wb-empty">先在左栏选择一个 param。</p>}
          {selectedRowId !== null && definition === null && (
            <p className="wb-empty">
              没有可用的字段定义{typeName ? `（${typeName}）` : ''}。字段视图不可用。
            </p>
          )}
          {selectedRowId !== null && definition !== null && selectedRow?.dataBase64 === undefined && (
            <p className="wb-empty">
              本行未随分页下发字节，字段值无法解码。翻页或缩小页大小后重试。
            </p>
          )}
          {selectedRowId !== null && definition !== null && (
            <>
              {fieldPageCount > 1 && (
                <div style={{ padding: '4px 10px', display: 'flex', gap: 6, alignItems: 'center' }}>
                  <button
                    type="button"
                    className="secondary-action"
                    disabled={fieldPage <= 0}
                    onClick={() => setFieldPage((page) => page - 1)}
                  >上一页</button>
                  <span className="muted" style={{ fontSize: 11 }}>{fieldPage + 1}/{fieldPageCount}</span>
                  <button
                    type="button"
                    className="secondary-action"
                    disabled={fieldPage >= fieldPageCount - 1}
                    onClick={() => setFieldPage((page) => page + 1)}
                  >下一页</button>
                </div>
              )}
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
                  <div className="wb-prop" key={field.id}>
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
    },
    {
      id: 'tools',
      title: 'Tools',
      initialFlex: 0.16,
      minWidth: 200,
      children: (
        <div className="wb-list">
          {/* §7.6：未接通真实实现的工具必须隐藏，不能放 disabled 假按钮。
              当前 Sort Rows / Row Names / Data Comparison / Copy / Duplicate /
              Data Transfer / Mass Edit / Reference Jump / Undo/Redo 均未接通
              真实实现，因此整栏只给出诚实的空态说明，不渲染任何假入口。 */}
          <p className="wb-empty">
            暂无已接通的工具。工具只在真实能力（如排序、复制、批量编辑）可用时出现。
          </p>
        </div>
      )
    }
  ];

  const footerMessages = [
    ...pageDiagnostics,
    ...(commitMessage ? [commitMessage] : []),
    // 只读原因必须说清下一步动作。只说「未授信」会让用户以为功能坏了，
    // 而实际上点一次工具栏的确认按钮就能启用。行字节缺失是另一回事（翻页可解）。
    ...(selectedRowId !== null && definition !== null && !canCommitFields
      ? [
          selectedRow?.dataBase64 === undefined
            ? '字段写入未放行：本行字节未随分页下发。'
            : trustState?.trusted === false
              ? '字段写入未放行：点击右上角「信任此元数据包」确认一次即可启用（只需一次）。'
              : '字段写入未放行：字段定义来源未通过校验。数值可读，提交已关闭。'
        ]
      : [])
  ];

  return (
    <WorkbenchLayout
      label="PARAM 工作台"
      columns={columns}
      toolbar={
        <>
          {/* §7.8 正确标题：Game Parameters · 1 library · N tables。
              不显示容器物理路径/文件名（§7.3 禁止路径、DCX、BND、大小）。
              containerLabel prop 仍由宿主传入，但不再进入可见 DOM。 */}
          <span className="crumb">
            Game Parameters · 1 library · {params.length} tables
          </span>
          {paramName && <span className="muted" style={{ fontSize: 11 }}>{paramName}</span>}
          {typeName && <span className="muted" style={{ fontSize: 11 }}>{typeName}</span>}
          <span className="toolbar-spacer" style={{ flex: 1 }}></span>
          {rowDataSize > 0 && (
            <span className="muted" style={{ fontSize: 11 }}>行大小 {rowDataSize} 字节</span>
          )}
          {/* 信任确认入口：只在包可用且尚未确认时出现。
              确认一次后本机后续都放行，所以这里不做常驻按钮 —— 常驻会让用户
              以为每次编辑都要点一下。已确认时给一个可撤销的轻量指示。 */}
          {trustState?.ok === true && trustState.trusted === false && (
            <button
              type="button"
              className="primary-action"
              disabled={trustBusy}
              onClick={() => void confirmTrust(true)}
              title={`信任 ${trustState.packageId ?? '元数据包'} ${trustState.packageVersion ?? ''}`}
            >
              信任此元数据包以启用字段编辑
            </button>
          )}
          {trustState?.trusted === true && (
            <button
              type="button"
              className="secondary-action"
              disabled={trustBusy}
              onClick={() => void confirmTrust(false)}
              title={trustState.confirmedAt
                ? `已于 ${trustState.confirmedAt} 确认；点击撤销`
                : '点击撤销信任'}
            >
              字段编辑已启用
            </button>
          )}
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
  );
}
