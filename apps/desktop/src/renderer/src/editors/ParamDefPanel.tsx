import { useMemo, useState, type ReactElement } from 'react';
import type { ParamDefDocument, ParamFieldDef } from '@soulforge/shared';
import { base64ToUint8Array } from '../utils/binary.js';

export interface ParamDefPanelProps {
  typeName: string;
  rowDataSize: number;
  origin: string;
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

/**
 * PARAM 字段级查看/编辑面板。
 *
 * 接入真实 PARAM 行数据与 paramdef 定义（定义目前只有演示 fixture 时，
 * 字段提交保持关闭——fixture 布局绝不允许写真实游戏数据）。字段解码是
 * 只读展示投影，不是 native authority；写入只经 applyParamFieldMutation
 * 的 whole-row Bridge upsert + Patch Engine。
 */
export function ParamDefPanel(props: ParamDefPanelProps): ReactElement {
  const [page, setPage] = useState(0);
  const [selectedRowId, setSelectedRowId] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState<CommitResultView | null>(null);

  const pageCount = Math.max(1, Math.ceil(props.rows.length / PAGE_SIZE));
  const pageRows = props.rows.slice(page * PAGE_SIZE, Math.min((page + 1) * PAGE_SIZE, props.rows.length));

  const selectedRow = useMemo(
    () => props.rows.find((row) => row.id === selectedRowId) ?? null,
    [props.rows, selectedRowId]
  );

  const selectedRowDataBase64 = selectedRow ? props.getRowDataBase64(selectedRow.id) : undefined;
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

      <div className="row gap">
        <span className="muted">选择下方行后编辑字段。</span>
        <button type="button" disabled={page <= 0} onClick={() => setPage((p) => p - 1)}>上一页</button>
        <span className="muted">{page + 1}/{pageCount}</span>
        <button
          type="button"
          disabled={page >= pageCount - 1}
          onClick={() => setPage((p) => p + 1)}
        >
          下一页
        </button>
      </div>

      <div className="binder-child-table" role="table">
        <div className="binder-child-row binder-child-header" role="row">
          <span>ID</span>
          <span>Name</span>
          <span>Raw 预览</span>
        </div>
        {pageRows.map((row) => (
          <div
            key={row.id}
            className={row.id === selectedRowId ? 'binder-child-row selected' : 'binder-child-row'}
            role="row"
            onClick={() => selectRow(row.id)}
          >
            <span>{row.id}</span>
            <span>{row.name ?? '—'}</span>
            <span title={row.dataHexPreview}>{row.dataHexPreview?.slice(0, 24) ?? '—'}</span>
          </div>
        ))}
        {props.rows.length === 0 && <p className="muted">无 PARAM 行数据。</p>}
      </div>

      {selectedRow && !selectedRowDataBase64 && (
        <p className="muted">该行缺少完整字节（截断或演示行），无法做字段级查看。</p>
      )}

      {selectedRow && selectedRowDataBase64 && props.definition && fieldViews.length > 0 && (
        <div className="binder-child-table paramdef-field-table" role="table">
          <div className="binder-child-row binder-child-header paramdef-field-row" role="row">
            <span>字段</span>
            <span>类型</span>
            <span>偏移/大小</span>
            <span>位域</span>
            <span>当前值</span>
            <span>操作</span>
          </div>
          {fieldViews.map((field) => {
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
