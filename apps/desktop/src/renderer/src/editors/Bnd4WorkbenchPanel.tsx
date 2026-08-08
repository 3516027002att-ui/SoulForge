import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type ReactElement } from 'react';
import { CONTAINER_PAGE_SIZE } from '@soulforge/shared';
import type {
  Diagnostic,
  RendererContainerChild,
  RendererContainerTreeSummary
} from '@soulforge/shared';
import { HexEditorPanel } from './HexEditorPanel.js';
import { isLikelyBase64, uint8ArrayToBase64 } from '../utils/binary.js';
import { describeBridgeAbsence, getRendererBridge } from '../runtime/rendererRuntime.js';
import { isRowTabEntry, selectableRowAttributes } from '../a11y/selectableRow.js';

export interface Bnd4WorkbenchPanelProps {
  resourceUri: string;
  onMutationCommitted?: () => void | Promise<void>;
}

interface ReplaceResultView {
  ok: boolean;
  message: string;
  diagnostics: Diagnostic[];
}

/**
 * BND4 容器工作台：只读条目树 + 子项 Hex 证据 + 用户提供字节的整个
 * 子项替换。不提供 typed mutation（bnd4 contract mutationKinds=[]）；
 * 替换字节必须由用户提供，SoulForge 不生成内容。
 */
/**
 * 逐项容器诊断（按需加载）。
 *
 * inspectContainerTree 给的是聚合结论——三个布尔回答「能不能」，但不回答
 * 「为什么不能」。这三条 IPC 各答一个：
 *   roundTripContainer        往返是否逐字节安全，不安全时差在哪
 *   validateContainer         结构校验，unsupported 时的结构化原因
 *   probeContainerCapabilities 能力探测，决定工作台开放哪些操作
 *
 * 刻意做成按需展开而不是随面板加载：三条都要读整个容器字节（roundTrip 还要
 * 重建一遍），对 168 MB 的容器默认就跑等于每次点开文件都做一次全量往返。
 */
interface ContainerDiagnosticsView {
  loading: boolean;
  error: string | null;
  roundTrip: Record<string, unknown> | null;
  validation: Record<string, unknown> | null;
  capabilities: Record<string, unknown> | null;
}

export function Bnd4WorkbenchPanel(props: Bnd4WorkbenchPanelProps): ReactElement {
  const [root, setRoot] = useState<RendererContainerTreeSummary | null>(null);
  const [pageChildren, setPageChildren] = useState<RendererContainerChild[]>([]);
  const [totalChildren, setTotalChildren] = useState(0);
  const [page, setPage] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [listDiagnostics, setListDiagnostics] = useState<Diagnostic[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedChildUri, setSelectedChildUri] = useState<string | null>(null);
  const [childHexBase64, setChildHexBase64] = useState<string | null>(null);
  const [childHash, setChildHash] = useState<string | null>(null);
  const [childReadDiagnostics, setChildReadDiagnostics] = useState<Diagnostic[]>([]);
  const [loadingChild, setLoadingChild] = useState(false);

  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replaceBytes, setReplaceBytes] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [replaceResult, setReplaceResult] = useState<ReplaceResultView | null>(null);
  /** 分页通道缺失时的降级说明。为 null 表示正常分页路径。 */
  const [degraded, setDegraded] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<ContainerDiagnosticsView | null>(null);

  /**
   * 并发调三条诊断 IPC。
   *
   * 三条互不依赖，串行只会让等待时间变成三倍——而它们各自都要读整个容器字节。
   * 用 allSettled 而不是 all：其中一条失败（例如 unsupported 容器的 roundTrip）
   * 不应让另两条的结果一起丢掉，那正是「聚合结论掩盖逐项原因」的老问题。
   *
   * 返回值逐字段取而不用 `as` 整体断言：IPC 边界上类型是断言出来的而非检查出来
   * 的，字段名对不上只会表现为「功能不工作」而 typecheck 照过（本轮 readRawRange
   * 接线就踩过：core 字段叫 base64 而我写 bytesBase64，翻页恒静默失败）。
   */
  const loadDiagnostics = useCallback(async (): Promise<void> => {
    const bridge = getRendererBridge();
    if (bridge === null) {
      setDiagnostics({
        loading: false,
        error: describeBridgeAbsence('读取逐项容器诊断'),
        roundTrip: null,
        validation: null,
        capabilities: null
      });
      return;
    }
    setDiagnostics({ loading: true, error: null, roundTrip: null, validation: null, capabilities: null });

    const asRecord = (value: unknown): Record<string, unknown> | null =>
      typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

    const [rt, vc, caps] = await Promise.allSettled([
      bridge.roundTripContainer(props.resourceUri),
      bridge.validateContainer(props.resourceUri),
      bridge.probeContainerCapabilities(props.resourceUri)
    ]);

    // 三条全失败才算整体失败；部分失败按「未报告」显示，理由见上面的注释。
    const rejected = [rt, vc, caps].filter((r) => r.status === 'rejected');
    const allFailed = rejected.length === 3;
    setDiagnostics({
      loading: false,
      error: allFailed
        ? `三条容器诊断全部失败：${rejected.map((r) => String((r as PromiseRejectedResult).reason)).join('；')}`
        : null,
      roundTrip: rt.status === 'fulfilled' ? asRecord(rt.value) : null,
      validation: vc.status === 'fulfilled' ? asRecord(vc.value) : null,
      capabilities: caps.status === 'fulfilled' ? asRecord(caps.value) : null
    });
  }, [props.resourceUri]);

  /*
   * 页大小（硬约束 17）来自 @soulforge/shared，与主进程
   * `resource.listContainerChildrenPage` 同一常量——此前是函数体内的局部
   * 字面量 50，与主进程各写一遍。
   */

  const bridge = getRendererBridge();

  const load = useCallback(async (): Promise<void> => {
    if (!props.resourceUri) {
      setRoot(null);
      setPageChildren([]);
      setTotalChildren(0);
      setPage(0);
      setPageCount(1);
      setListDiagnostics([]);
      setLoadError(null);
      setDegraded(null);
      return;
    }
    if (bridge === null) {
      setRoot(null);
      setPageChildren([]);
      setTotalChildren(0);
      setLoadError(describeBridgeAbsence('读取 BND4 容器'));
      return;
    }
    setLoading(true);
    setLoadError(null);
    setDegraded(null);
    try {
      const treePromise = bridge.inspectContainerTree(props.resourceUri);
      const pagePromise = typeof bridge.listContainerChildrenPage === 'function'
        ? bridge.listContainerChildrenPage(props.resourceUri, 0, CONTAINER_PAGE_SIZE, false)
        : null;
      const [tree, firstPage] = await Promise.all([treePromise, pagePromise]);
      setRoot(tree);
      if (firstPage && firstPage.ok) {
        setPageChildren(firstPage.children);
        setTotalChildren(firstPage.totalCount);
        setPageCount(firstPage.pageCount);
        setPage(firstPage.page);
        setListDiagnostics([...(tree.diagnostics ?? []), ...(firstPage.diagnostics ?? [])]);
        if (!tree.ok && firstPage.children.length === 0) {
          setLoadError(tree.diagnostics?.[0]?.message ?? '容器读取失败。');
        }
      } else {
        // 分页通道不可用：退回全量列表，但**真实截断到一页**并显式说明。
        //
        // 此前这里把全量结果整块塞进 pageChildren，同时按 ceil(len/PAGE) 算出
        // pageCount 照常渲染翻页按钮——而 changePage 在该路径开头就 return。
        // 结果是「按钮可见但点不动」，且首屏一次性渲染全部子项（大容器可达数千
        // 条 DOM）。两个问题都不会报错，用户只看到界面卡住且翻页无反应。
        //
        // 硬约束 17 要求大规模访问必须分页；分页通道缺失时正确的降级是「少给、
        // 说清」，不是「全给、装作能翻页」。
        const list = await bridge.listContainerChildren(props.resourceUri);
        const truncated = list.children.length > CONTAINER_PAGE_SIZE;
        setPageChildren(list.children.slice(0, CONTAINER_PAGE_SIZE));
        setTotalChildren(list.children.length);
        // pageCount=1：翻页按钮据此禁用，不再出现点不动的控件。
        setPageCount(1);
        setPage(0);
        setDegraded(truncated
          ? `分页通道不可用：已解析 ${list.children.length} 个子项，仅显示前 ${CONTAINER_PAGE_SIZE} 个。`
          : '分页通道不可用：已退回全量读取（本容器子项数未超过单页）。');
        setListDiagnostics([...(tree.diagnostics ?? []), ...(list.diagnostics ?? [])]);
        if (!tree.ok && list.children.length === 0) {
          setLoadError(tree.diagnostics?.[0]?.message ?? '容器读取失败。');
        }
      }
    } catch (error) {
      setRoot(null);
      setPageChildren([]);
      setTotalChildren(0);
      setLoadError(error instanceof Error ? error.message : '容器读取异常。');
    } finally {
      setLoading(false);
    }
  }, [props.resourceUri, bridge]);

  async function changePage(next: number): Promise<void> {
    if (bridge === null || typeof bridge.listContainerChildrenPage !== 'function') return;
    setPageLoading(true);
    setPageError(null);
    try {
      const result = await bridge.listContainerChildrenPage(
        props.resourceUri,
        next,
        CONTAINER_PAGE_SIZE,
        false
      );
      if (result.ok) {
        setPageChildren(result.children);
        setTotalChildren(result.totalCount);
        setPageCount(result.pageCount);
        setPage(result.page);
      } else {
        setPageError(result.diagnostics?.[0]?.message ?? '容器子项分页读取失败。');
      }
    } catch (error) {
      setPageError(error instanceof Error ? error.message : '容器子项分页读取异常。');
    } finally {
      setPageLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [load]);

  const selectedChild = useMemo(
    () => pageChildren.find((child) => child.childUri === selectedChildUri) ?? null,
    [pageChildren, selectedChildUri]
  );

  async function selectChild(child: RendererContainerChild): Promise<void> {
    setSelectedChildUri(child.childUri);
    setChildHexBase64(null);
    setChildHash(null);
    setChildReadDiagnostics([]);
    setReplaceOpen(false);
    setReplaceBytes('');
    setReplaceResult(null);
    if (bridge === null) {
      setChildReadDiagnostics([{
        severity: 'error',
        code: 'BRIDGE_UNAVAILABLE',
        message: describeBridgeAbsence('读取容器子项')
      }]);
      return;
    }
    setLoadingChild(true);
    try {
      const read = await bridge.readContainerChild(child.childUri);
      if (read.ok && read.bytes) {
        setChildHexBase64(uint8ArrayToBase64(read.bytes));
        setChildHash(read.hash ?? null);
        setChildReadDiagnostics([]);
      } else {
        setChildHexBase64(null);
        setChildHash(null);
        setChildReadDiagnostics(read.diagnostics ?? []);
      }
    } catch (error) {
      setChildHexBase64(null);
      setChildHash(null);
      setChildReadDiagnostics([{
        severity: 'error',
        code: 'CHILD_READ_EXCEPTION',
        message: error instanceof Error ? error.message : '读取子项失败。'
      }]);
    } finally {
      setLoadingChild(false);
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '');
      const comma = dataUrl.indexOf(',');
      setReplaceBytes(comma >= 0 ? dataUrl.slice(comma + 1) : '');
      setReplaceResult(null);
    };
    reader.readAsDataURL(file);
  }

  async function submitReplace(): Promise<void> {
    if (!selectedChild || !root?.root) return;
    if (bridge === null) {
      setReplaceResult({
        ok: false,
        message: describeBridgeAbsence('替换容器子项'),
        diagnostics: []
      });
      return;
    }
    const base64 = replaceBytes.trim();
    if (!isLikelyBase64(base64)) {
      setReplaceResult({
        ok: false,
        message: '请提供有效的 base64 字节（替换字节必须由用户提供）。',
        diagnostics: []
      });
      return;
    }
    const containerHash = root.root.hash;
    const expectedChildHash = selectedChild.hash;
    setReplacing(true);
    setReplaceResult(null);
    try {
      const result = await bridge.replaceContainerChild(
        selectedChild.childUri,
        containerHash,
        expectedChildHash,
        base64
      );
      const ok = Boolean(result.ok);
      setReplaceResult({
        ok,
        message: ok
          ? '子项已替换并提交（Patch Engine 事务 + 已建立可回滚备份）。'
          : (result.diagnostics?.[0]?.message ?? '子项替换失败。'),
        diagnostics: result.diagnostics ?? []
      });
      if (ok) {
        setReplaceOpen(false);
        setReplaceBytes('');
        await load();
        await props.onMutationCommitted?.();
      }
    } catch (error) {
      setReplaceResult({
        ok: false,
        message: error instanceof Error ? error.message : '子项替换调用异常。',
        diagnostics: []
      });
    } finally {
      setReplacing(false);
    }
  }

  const canReplace = Boolean(root?.root?.canReplaceChild);

  return (
    <section className="panel" aria-label="BND4 容器工作台">
      <header className="panel-header">
        <h3>BND4 容器工作台</h3>
        <span className="muted">{totalChildren} 个子项</span>
      </header>

      {loading && <p className="muted">正在读取容器…</p>}
      {loadError && <p className="danger">{loadError}</p>}
      {!loading && !loadError && !root && <p className="muted">选择左侧容器资源后显示工作台。</p>}

      {root?.root && (
        <>
          <div className="structured-preview-grid">
            <span>格式：{root.root.format}</span>
            <span>authority：{root.root.authority}</span>
            <span>大小：{root.root.size} 字节</span>
            <span>magic：{root.root.magic || '—'}</span>
            <span>容器校验：{shortHash(root.root.hash)}</span>
            <span>round-trip 安全：{root.root.containerRoundTripSafe ? '是' : '否'}</span>
            <span>可列出子项：{root.root.canListChildren ? '是' : '否'}</span>
            <span>可替换子项：{root.root.canReplaceChild ? '是' : '否'}</span>
          </div>
          {!root.root.canListChildren && (
            <p className="muted">
              该容器未提供子项列表（原生 BND 未带 SFBN 标记，或为不支持解压的 DCX）；只读证据层级不可用。
            </p>
          )}

          {/*
            逐项诊断：上面三个布尔回答「能不能」，这里回答「为什么」。
            按需触发——三条 IPC 都要读整个容器字节，默认跑等于每次点开文件都做
            一次全量往返。失败必须可见且带诊断码，静默失败会让用户以为容器没问题。
          */}
          <details className="container-diag">
            <summary>逐项容器诊断（按需读取）</summary>
            {diagnostics === null && (
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void loadDiagnostics()}
              >
                读取逐项诊断
              </button>
            )}
            {diagnostics?.loading === true && <p className="muted">读取中…</p>}
            {diagnostics?.error != null && <p className="diag-error">{diagnostics.error}</p>}
            {diagnostics !== null && !diagnostics.loading && diagnostics.error === null && (
              <div className="structured-preview-grid">
                <span>
                  往返逐字节：
                  {diagnostics.roundTrip?.byteIdentical === true ? '一致'
                    : diagnostics.roundTrip?.byteIdentical === false ? '不一致' : '未报告'}
                </span>
                <span>
                  结构校验：
                  {diagnostics.validation?.ok === true ? '通过'
                    : diagnostics.validation?.ok === false ? '未通过' : '未报告'}
                </span>
                <span>
                  能力探测 rawWritable：
                  {diagnostics.capabilities?.rawWritable === true ? '是'
                    : diagnostics.capabilities?.rawWritable === false ? '否' : '未报告'}
                </span>
                <span>
                  semanticReadTier：
                  {String(diagnostics.capabilities?.semanticReadTier ?? '未报告')}
                </span>
              </div>
            )}
            {/* 三条各自的结构化诊断码逐条列出——聚合布尔丢掉的正是这些原因。 */}
            {diagnostics !== null && !diagnostics.loading && (
              <ul className="muted container-diag__codes">
                {[
                  ['往返', diagnostics.roundTrip],
                  ['校验', diagnostics.validation],
                  ['能力', diagnostics.capabilities]
                ].flatMap(([label, payload]) => {
                  const list = Array.isArray((payload as Record<string, unknown>)?.diagnostics)
                    ? (payload as { diagnostics: Array<{ code?: unknown; message?: unknown }> }).diagnostics
                    : [];
                  return list.map((d, i) => (
                    <li key={`${String(label)}-${i}`}>
                      {String(label)}：{String(d.code ?? 'UNKNOWN')} — {String(d.message ?? '')}
                    </li>
                  ));
                })}
              </ul>
            )}
          </details>
        </>
      )}

      {/* 降级说明必须可见：否则「只显示了前 N 条」与「一共就这么多」在界面上
          无法区分，用户会把截断当成完整数据。 */}
      {degraded !== null && <p className="muted">{degraded}</p>}

      <div className="row gap pager">
        <button
          type="button"
          disabled={page <= 0 || pageLoading}
          onClick={() => void changePage(page - 1)}
        >
          上一页
        </button>
        <span className="muted">
          {pageCount > 0 ? page + 1 : 0}/{pageCount}
          {totalChildren > 0 && ` · 共 ${totalChildren} 项`}
        </span>
        <button
          type="button"
          disabled={page >= pageCount - 1 || pageLoading}
          onClick={() => void changePage(page + 1)}
        >
          下一页
        </button>
        {pageLoading && <span className="muted">加载中…</span>}
      </div>
      {pageError && <p className="danger">{pageError}</p>}

      <div className="binder-child-table script-entry-table" role="table">
        <div className="binder-child-row binder-child-header script-entry-row" role="row">
          <span>名称</span>
          <span>ID</span>
          <span>类型</span>
          <span>偏移</span>
          <span>大小</span>
          <span>嵌套</span>
          <span>替换</span>
        </div>
        {pageChildren.map((child, rowIndex) => (
          <div
            key={child.childUri}
            className={child.childUri === selectedChildUri
              ? 'binder-child-row bnd4-child-row selected'
              : 'binder-child-row bnd4-child-row'}
            {...selectableRowAttributes({
              selected: child.childUri === selectedChildUri,
              isTabEntry: isRowTabEntry(rowIndex, selectedChildUri !== null),
              onSelect: () => void selectChild(child)
            })}
          >
            <span title={child.name ?? ''}>{child.name ?? '（无名称）'}</span>
            <span className="muted">{child.childId}</span>
            <span className="muted">{child.formatKind}</span>
            <span className="muted">0x{child.offset.toString(16)}</span>
            <span>{child.size}{child.compressedSize !== undefined && child.compressedSize !== child.size
              ? ` / ${child.compressedSize}`
              : ''}</span>
            <span className="muted">{child.nestedFormat ?? '—'}</span>
            <span>{child.canReplace ? '可' : '只读'}</span>
          </div>
        ))}
        {pageChildren.length === 0 && !loading && <p className="muted">无子项列表。</p>}
      </div>

      {listDiagnostics.length > 0 && (
        <div className="save-diagnostics">
          {listDiagnostics.map((diagnostic) => (
            <span key={`${diagnostic.code}-${diagnostic.message}`}>
              {diagnostic.code}: {diagnostic.message}
            </span>
          ))}
        </div>
      )}

      {loadingChild && <p className="muted">正在读取子项字节…</p>}
      {childHexBase64 && (
        <>
          <HexEditorPanel
            title={`${selectedChild?.name ?? '子项'} 只读 Hex 证据${childHash ? ` · ${shortHash(childHash)}` : ''}`}
            initialBytesBase64={childHexBase64}
          />
          <p className="muted">子项字节为只读证据视图；替换须由用户提供字节，SoulForge 不生成内容。</p>
          <div className="row gap">
            <button
              type="button"
              disabled={!canReplace || !selectedChild?.canReplace}
              onClick={() => {
                setReplaceOpen((current) => !current);
                setReplaceResult(null);
              }}
            >
              {replaceOpen ? '收起替换表单' : '替换子项（用户提供字节）'}
            </button>
            {!canReplace && <span className="muted">当前容器不支持权威子项替换。</span>}
          </div>
        </>
      )}

      {childReadDiagnostics.length > 0 && (
        <div className="save-diagnostics">
          {childReadDiagnostics.map((diagnostic) => (
            <span key={`${diagnostic.code}-${diagnostic.message}`}>
              {diagnostic.code}: {diagnostic.message}
            </span>
          ))}
        </div>
      )}

      {replaceOpen && selectedChild && (
        <div className="stack gap">
          <p className="muted">
            替换目标：{selectedChild.name ?? selectedChild.childId}
            {childHash ? ` · 条目校验 ${shortHash(childHash)}` : ''}
            {root?.root ? ` · 容器校验 ${shortHash(root.root.hash)}` : ''}
          </p>
          <label className="stack gap">
            选择替换字节文件（由你提供）
            <input type="file" onChange={handleFileChange} />
          </label>
          <label className="stack gap">
            或粘贴 base64 字节
            <textarea
              value={replaceBytes}
              onChange={(event) => {
                setReplaceBytes(event.target.value);
                setReplaceResult(null);
              }}
              rows={3}
              spellCheck={false}
              placeholder="dataBase64…"
            />
          </label>
          <div className="row gap">
            <button
              type="button"
              disabled={replacing || replaceBytes.trim().length === 0}
              onClick={() => void submitReplace()}
            >
              {replacing ? '提交中…' : '经 Patch Engine 替换并提交'}
            </button>
            <button type="button" disabled={replacing} onClick={() => setReplaceOpen(false)}>
              取消
            </button>
          </div>
          {replaceResult && (
            <p className={replaceResult.ok ? undefined : 'danger'}>{replaceResult.message}</p>
          )}
          {replaceResult && replaceResult.diagnostics.length > 0 && (
            <div className="save-diagnostics">
              {replaceResult.diagnostics.map((diagnostic) => (
                <span key={`${diagnostic.code}-${diagnostic.message}`}>
                  {diagnostic.code}: {diagnostic.message}
                </span>
              ))}
            </div>
          )}
          <p className="muted">整个子项替换会经 Patch Engine 事务并弹出主进程确认对话框；不提供 typed mutation。</p>
        </div>
      )}
    </section>
  );
}

function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
}
