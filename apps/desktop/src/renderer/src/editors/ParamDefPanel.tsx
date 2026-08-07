import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { ParamDefDocument, ParamFieldDef, ParamRowPage } from '@soulforge/shared';
import { base64ToUint8Array } from '../utils/binary.js';
import { getRendererBridge } from '../runtime/rendererRuntime.js';
import { isRowTabEntry, selectableRowAttributes } from '../a11y/selectableRow.js';

export interface ParamDefPanelProps {
  typeName: string;
  rowDataSize: number;
  origin: string;
  /** 分页读取目标（live 模式下经 resource.readParamPage 按页取行）。 */
  resourceUri: string;
  /** True when the source is a live Bridge PARAM document (page-fetchable). */
  live?: boolean;
  /**
   * 字段级结构定义。为 null 表示当前没有可用的 paramdef 定义（官方适配包
   * 只读；用户派生定义尚未接入），此时字段视图保持只读/不可用。
   */
  definition: ParamDefDocument | null;
  /** 真实 PARAM 行（与 ParamTablePanel 的 loadParam 一致）。 */
  rows: Array<{ id: number; name?: string; dataHexPreview?: string }>;
  /** 行的完整字节（base64）；截断/不可得的行返回 undefined。 */
  getRowDataBase64: (rowId: number) => string | undefined;
  /**
   * 提交字段 mutation（App 负责调用 applyParamFieldMutation 并刷新行数据）。
   * 返回结构化结果以便面板显示失败诊断。
   */
  onApplyFieldMutation?: (input: {
    rowId: number;
    fieldId: string;
    value: number | string | boolean;
    rowDataBase64: string;
    definition: unknown;
  }) => Promise<{ ok: boolean; diagnostics?: Array<{ code: string; message: string }> }>;
}

interface DecodedFieldView {
  fieldId: string;
  name: string;
  type: string;
  offset: number;
  size: number;
  bitfield?: { bitOffset: number; bitWidth: number };
  display: string;
  editable: boolean;
  diagnostic?: string;
}

interface CommitResultView {
  fieldId: string;
  ok: boolean;
  message: string;
  diagnostics: Array<{ code: string; message: string }>;
}

const PAGE_SIZE = 20;
/** 字段表每页字段数。宽 PARAM 的 paramdef 可达数百字段，全量渲染会建出同样多的受控 input。 */
const FIELD_PAGE_SIZE = 40;

/**
 * PARAM 字段级查看/编辑面板。
 *
 * Live 模式下行选择列表经 `resource.readParamPage` 按页读取（renderer 只
 * 持有一页，导航可覆盖完整行表），字段解码的字节取自当前页行的 base64；
 * 演示/回退路径继续使用 props.rows + getRowDataBase64。接入真实 PARAM 行
 * 数据与 paramdef 定义（定义目前只有演示 fixture 时，字段提交保持关闭——
 * fixture 布局绝不允许写真实游戏数据）。字段解码是只读展示投影，不是 native
 * authority；写入只经 applyParamFieldMutation 的 whole-row Bridge upsert +
 * Patch Engine。
 */
export function ParamDefPanel(props: ParamDefPanelProps): ReactElement {
  const bridge = getRendererBridge();
  const liveMode = props.live === true
    && bridge !== null
    && typeof bridge.readParamPage === 'function';
  const [page, setPage] = useState(0);
  const [pageRows, setPageRows] = useState<Array<{
    id: number;
    name?: string;
    dataHexPreview?: string;
    dataBase64?: string;
  }>>([]);
  const [pageCount, setPageCount] = useState(1);
  const [loading, setLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [selectedRowId, setSelectedRowId] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState<CommitResultView | null>(null);

  // Live path: fetch one page from main (complete coverage via navigation).
  useEffect(() => {
    if (!liveMode || bridge === null || !props.resourceUri) return;
    let cancelled = false;
    setLoading(true);
    setPageError(null);
    bridge.readParamPage(props.resourceUri, page, PAGE_SIZE, '')
      .then((result: ParamRowPage) => {
        if (cancelled) return;
        if (!result.ok) {
          setPageError(result.diagnostics?.[0]?.message ?? 'PARAM 分页读取失败。');
          setPageRows([]);
        } else {
          setPageRows(result.rows);
          setPageCount(result.pageCount);
          setPage(result.page);
          setPageError(null);
        }
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPageError(error instanceof Error ? error.message : 'PARAM 分页读取异常。');
        setPageRows([]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [liveMode, bridge, props.resourceUri, page]);

  // Demo/fallback path: client-side page window over props.rows.
  useEffect(() => {
    if (liveMode) return;
    const demoPageCount = Math.max(1, Math.ceil(props.rows.length / PAGE_SIZE));
    const clamped = Math.min(Math.max(0, page), demoPageCount - 1);
    const slice = props.rows.slice(
      clamped * PAGE_SIZE,
      Math.min((clamped + 1) * PAGE_SIZE, props.rows.length)
    );
    setPageRows(slice);
    setPageCount(demoPageCount);
    if (clamped !== page) setPage(clamped);
  }, [liveMode, props.rows, page]);

  const selectedRow = useMemo(
    () => pageRows.find((row) => row.id === selectedRowId) ?? null,
    [pageRows, selectedRowId]
  );

  function rowDataBase64(rowId: number): string | undefined {
    const pageRow = pageRows.find((row) => row.id === rowId);
    if (pageRow?.dataBase64) return pageRow.dataBase64;
    return props.getRowDataBase64(rowId);
  }

  const selectedRowDataBase64 = selectedRow ? rowDataBase64(selectedRow.id) : undefined;
  const selectedRowBytes = useMemo(() => {
    if (!selectedRowDataBase64) return null;
    try {
      return base64ToUint8Array(selectedRowDataBase64);
    } catch {
      return null;
    }
  }, [selectedRowDataBase64]);

  const fieldViews = useMemo(() => {
    if (!selectedRowBytes || !props.definition) return [];
    return props.definition.fields.map((field) => decodeFieldView(selectedRowBytes, field));
  }, [selectedRowBytes, props.definition]);

  /**
   * 字段表分页。
   *
   * 行表本来就分页（PAGE_SIZE 行/页），但字段表此前是 fieldViews 全量 map，每个
   * 字段一个 <input>。宽 PARAM 的 paramdef 有数百字段——一次建出数百个受控输入，
   * 首屏卡顿且每次 keystroke 都触发整表重渲染。硬约束 17 要求大规模访问分页，
   * 字段数与行数一样不可控。
   *
   * 选中行变化时回到第一页：否则在字段少的行上会停在一个空页面。
   */
  const [fieldPage, setFieldPage] = useState(0);
  useEffect(() => {
    setFieldPage(0);
  }, [selectedRowId, props.definition]);
  const fieldPageCount = Math.max(1, Math.ceil(fieldViews.length / FIELD_PAGE_SIZE));
  const visibleFieldViews = useMemo(
    () => fieldViews.slice(fieldPage * FIELD_PAGE_SIZE, (fieldPage + 1) * FIELD_PAGE_SIZE),
    [fieldViews, fieldPage]
  );

  const definitionCanCommit = props.definition !== null
    && (props.definition.origin === 'user-derived' || props.definition.origin === 'imported')
    && props.definition.rowDataSize === props.rowDataSize
    && props.onApplyFieldMutation !== undefined;

  function selectRow(id: number): void {
    setSelectedRowId((current) => (current === id ? null : id));
    setDrafts({});
    setCommitResult(null);
  }

  async function commitField(fieldId: string, value: number | string | boolean): Promise<void> {
    if (!selectedRow || !props.definition || !selectedRowDataBase64) return;
    if (!props.onApplyFieldMutation) return;
    setCommitting(true);
    setCommitResult(null);
    try {
      const result = await props.onApplyFieldMutation({
        rowId: selectedRow.id,
        fieldId,
        value,
        rowDataBase64: selectedRowDataBase64,
        definition: props.definition
      });
      const message = result.ok
        ? '字段已应用并提交（whole-row Bridge upsert + Patch Engine）。'
        : (result.diagnostics?.[0]?.message ?? '字段提交失败。');
      setCommitResult({ fieldId, ok: result.ok, message, diagnostics: result.diagnostics ?? [] });
      if (result.ok) setDrafts({});
    } catch (error) {
      setCommitResult({
        fieldId,
        ok: false,
        message: error instanceof Error ? error.message : '字段提交异常。',
        diagnostics: []
      });
    } finally {
      setCommitting(false);
    }
  }

  const definitionOriginLabel = props.definition ? originLabel(props.definition.origin) : originLabel(props.origin);

  return (
    <section className="panel" aria-label="PARAM 字段定义">
      <header className="panel-header">
        <h3>PARAM 字段编辑：{props.typeName}</h3>
        <span className="muted">
          行大小 {props.rowDataSize} · 定义来源 {definitionOriginLabel} · {props.definition?.fields.length ?? 0} 个字段
        </span>
      </header>

      {props.definition === null && (
        <p className="muted">
          当前没有可用的 paramdef 定义：官方适配包只读，用户派生定义尚未接入。字段视图不可用，仅展示行的原始字节预览。
        </p>
      )}
      {props.definition !== null && props.definition.origin === 'fixture' && (
        <p className="muted">
          当前为演示 fixture 定义（仅用于布局预览），其偏移不匹配真实 PARAM，字段提交已关闭；需用户派生 paramdef 定义才能编辑真实字段。
        </p>
      )}
      {props.definition !== null && props.definition.rowDataSize !== props.rowDataSize && (
        <p className="danger">
          定义 rowDataSize（{props.definition.rowDataSize}）与真实 PARAM 行大小（{props.rowDataSize}）不一致，字段提交已关闭。
        </p>
      )}

      <div className="row gap pager">
        <span className="muted">选择下方行后编辑字段。</span>
        <button type="button" disabled={page <= 0 || loading} onClick={() => setPage((p) => p - 1)}>上一页</button>
        <span className="muted">{pageCount > 0 ? page + 1 : 0}/{pageCount}</span>
        <button
          type="button"
          disabled={page >= pageCount - 1 || loading}
          onClick={() => setPage((p) => p + 1)}
        >
          下一页
        </button>
        {loading && <span className="muted">加载中…</span>}
      </div>
      {pageError && <p className="danger">{pageError}</p>}

      <div className="binder-child-table" role="table">
        <div className="binder-child-row binder-child-header" role="row">
          <span>ID</span>
          <span>Name</span>
          <span>Raw 预览</span>
        </div>
        {/* 行选择必须键盘可达：字段表只在选中行后出现，此前键盘用户根本进不去
            字段编辑态。属性由 selectableRowAttributes 统一产出。 */}
        {pageRows.map((row, rowIndex) => (
          <div
            key={row.id}
            className={row.id === selectedRowId ? 'binder-child-row selected' : 'binder-child-row'}
            {...selectableRowAttributes({
              selected: row.id === selectedRowId,
              isTabEntry: isRowTabEntry(rowIndex, selectedRowId !== null),
              onSelect: () => selectRow(row.id)
            })}
          >
            <span>{row.id}</span>
            <span>{row.name ?? '—'}</span>
            <span title={row.dataHexPreview}>{row.dataHexPreview?.slice(0, 24) ?? '—'}</span>
          </div>
        ))}
        {pageRows.length === 0 && !loading && <p className="muted">无 PARAM 行数据。</p>}
      </div>

      {selectedRow && !selectedRowDataBase64 && (
        <p className="muted">该行缺少完整字节（截断或演示行），无法做字段级查看。</p>
      )}

      {selectedRow && selectedRowDataBase64 && props.definition && fieldViews.length > 0 && (
        <>
        {fieldViews.length > FIELD_PAGE_SIZE && (
          <div className="row gap pager">
            <button
              type="button"
              disabled={fieldPage <= 0}
              onClick={() => setFieldPage((current) => current - 1)}
            >
              上一组字段
            </button>
            <span className="muted">
              字段 {fieldPage * FIELD_PAGE_SIZE + 1}–
              {Math.min((fieldPage + 1) * FIELD_PAGE_SIZE, fieldViews.length)}
              {' / '}共 {fieldViews.length} 个
            </span>
            <button
              type="button"
              disabled={fieldPage >= fieldPageCount - 1}
              onClick={() => setFieldPage((current) => current + 1)}
            >
              下一组字段
            </button>
          </div>
        )}
        <div className="binder-child-table paramdef-field-table" role="table">
          <div className="binder-child-row binder-child-header paramdef-field-row" role="row">
            <span>字段</span>
            <span>类型</span>
            <span>偏移/大小</span>
            <span>位域</span>
            <span>当前值</span>
            <span>操作</span>
          </div>
          {visibleFieldViews.map((field) => {
            const draft = drafts[field.fieldId];
            const displayValue = draft !== undefined
              ? draft
              : field.display;
            return (
              <div key={field.fieldId} className="binder-child-row paramdef-field-row" role="row">
                <span title={field.fieldId}>{field.name}</span>
                <span className="muted">{field.type}</span>
                <span className="muted">0x{field.offset.toString(16)}/{field.size}</span>
                <span className="muted">
                  {field.bitfield ? `${field.bitfield.bitOffset}+${field.bitfield.bitWidth} bit` : '—'}
                </span>
                <span>
                  {field.editable ? (
                    <input
                      value={displayValue}
                      onChange={(event) => {
                        setDrafts((current) => ({ ...current, [field.fieldId]: event.target.value }));
                        setCommitResult(null);
                      }}
                      aria-label={`编辑 ${field.name}`}
                    />
                  ) : (
                    <span className="muted">{field.display}</span>
                  )}
                </span>
                <span className="row gap">
                  {field.editable ? (
                    <button
                      type="button"
                      disabled={!definitionCanCommit || committing}
                      title={definitionCanCommit ? undefined : '需要用户派生 paramdef 定义才能提交字段'}
                      onClick={() => {
                        const parsed = parseFieldValue(field, draft ?? field.display);
                        if (parsed === undefined) {
                          setCommitResult({
                            fieldId: field.fieldId,
                            ok: false,
                            message: `字段 ${field.name} 的值无法解析为 ${field.type}。`,
                            diagnostics: []
                          });
                          return;
                        }
                        void commitField(field.fieldId, parsed);
                      }}
                    >
                      应用
                    </button>
                  ) : (
                    <span className="muted">只读</span>
                  )}
                </span>
              </div>
            );
          })}
          {props.definition.fields.length === 0 && <p className="muted">定义不含字段。</p>}
        </div>
        </>
      )}

      {selectedRow && selectedRowDataBase64 && props.definition && fieldViews.length === 0 && (
        <p className="muted">定义不含可解码字段。</p>
      )}

      {commitResult && (
        <div className="stack gap">
          <p className={commitResult.ok ? undefined : 'danger'}>
            {commitResult.fieldId}: {commitResult.message}
          </p>
          {commitResult.diagnostics.length > 0 && (
            <div className="save-diagnostics">
              {commitResult.diagnostics.map((diagnostic) => (
                <span key={`${diagnostic.code}-${diagnostic.message}`}>
                  {diagnostic.code}: {diagnostic.message}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {!definitionCanCommit && props.definition !== null && (
        <p className="muted">
          字段提交须经 Patch Engine 提交（whole-row upsert）；当前定义不是用户派生/导入来源，或行大小不匹配，提交已关闭。
        </p>
      )}
      <p className="muted">结构定义编辑写入用户派生游戏适配包，不修改官方包；未知/不支持类型的字段保持只读展示。</p>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Display-only field projection (not native authority)              */
/* ------------------------------------------------------------------ */

const SCALAR_SIZES: Record<string, number> = {
  u8: 1,
  s8: 1,
  u16: 2,
  s16: 2,
  u32: 4,
  s32: 4,
  f32: 4,
  f64: 8,
  bool: 1
};

const NUMERIC_TYPES = new Set<string>(['u8', 's8', 'u16', 's16', 'u32', 's32', 'f32', 'f64']);

function decodeFieldView(bytes: Uint8Array, field: ParamFieldDef): DecodedFieldView {
  const base = {
    fieldId: field.id,
    name: field.name,
    type: field.type,
    offset: field.offset,
    size: field.size,
    ...(field.bitfield ? { bitfield: field.bitfield } : {})
  };
  if (field.offset + field.size > bytes.length) {
    return { ...base, display: '（行字节不足）', editable: false, diagnostic: '行字节不足' };
  }
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    switch (field.type) {
      case 'u8': return scalarFieldView(base, view.getUint8(field.offset));
      case 's8': return scalarFieldView(base, view.getInt8(field.offset));
      case 'u16': return scalarFieldView(base, view.getUint16(field.offset, true));
      case 's16': return scalarFieldView(base, view.getInt16(field.offset, true));
      case 'u32': return scalarFieldView(base, view.getUint32(field.offset, true));
      case 's32': return scalarFieldView(base, view.getInt32(field.offset, true));
      case 'f32': return scalarFieldView(base, view.getFloat32(field.offset, true));
      case 'f64': return scalarFieldView(base, view.getFloat64(field.offset, true));
      case 'bool': return {
        ...base,
        display: view.getUint8(field.offset) !== 0 ? 'true' : 'false',
        editable: true
      };
      case 'fix': {
        let end = field.offset;
        while (end < field.offset + field.size && view.getUint8(end) !== 0) end += 1;
        const text = new TextDecoder('utf-8').decode(bytes.subarray(field.offset, end));
        return { ...base, display: text || '（空串）', editable: false };
      }
      case 'bytes': {
        const hex = Array.from(bytes.subarray(field.offset, field.offset + field.size))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(' ');
        return { ...base, display: hex || '（空）', editable: false };
      }
      default:
        return { ...base, display: '（未知类型，只读）', editable: false, diagnostic: '未知类型' };
    }
  } catch (error) {
    return {
      ...base,
      display: '（解码失败）',
      editable: false,
      diagnostic: error instanceof Error ? error.message : '解码失败'
    };
  }
}

function scalarFieldView(
  base: Omit<DecodedFieldView, 'display' | 'editable'>,
  value: number
): DecodedFieldView {
  let display = String(value);
  let resolved = value;
  if (base.bitfield) {
    const { bitOffset, bitWidth } = base.bitfield;
    resolved = (value >>> bitOffset) & ((1 << bitWidth) - 1);
    display = String(resolved);
  }
  if (base.type === 'f32' || base.type === 'f64') {
    display = formatFloat(resolved);
  }
  return { ...base, display, editable: true };
}

function formatFloat(value: number): string {
  if (Number.isFinite(value)) {
    const rounded = Math.round(value * 1e4) / 1e4;
    return String(rounded);
  }
  return String(value);
}

function parseFieldValue(
  field: DecodedFieldView,
  raw: string
): number | string | boolean | undefined {
  if (field.type === 'bool') {
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
    return undefined;
  }
  if (NUMERIC_TYPES.has(field.type)) {
    const parsed = Number(raw.trim());
    if (raw.trim() === '' || !Number.isFinite(parsed)) return undefined;
    if (field.type !== 'f32' && field.type !== 'f64') {
      if (!Number.isSafeInteger(parsed)) return undefined;
      if (field.type === 'u8' || field.type === 'u16' || field.type === 'u32') {
        if (parsed < 0) return undefined;
        const max = Number.parseInt('ff'.repeat(SCALAR_SIZES[field.type]!), 16);
        if (parsed > max) return undefined;
      }
      return parsed;
    }
    return parsed;
  }
  // fix/bytes/未知类型保持只读，不能提交。
  return undefined;
}

function originLabel(origin: string): string {
  if (origin === 'user-derived') return '用户派生';
  if (origin === 'fixture') return '测试夹具';
  if (origin === 'imported') return '导入';
  return origin;
}
