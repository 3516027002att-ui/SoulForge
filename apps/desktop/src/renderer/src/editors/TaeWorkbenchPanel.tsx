/**
 * ANIMATION-56B / T3（2026-08-15）：动作工作台（grok T3，对照 DSAS）。
 *
 * 三栏：`Animations | 词条 + 详情 | 预览（只读）`。
 *
 * ── T3 重构（行为 + 动画合并为「动作」）──
 *
 * 左栏列动画 id（hkxName 去扩展，如 a000_003013；无 hkxName 用干净数字 id）。
 * 中栏列当前动画的词条事件列表——envelope 只有 eventTypeId 与起止时间，词条文本名
 * （PlaySound_ByStateInfo 等）当前未解码，诚实显示「事件类型 N」；选中后在中栏下方
 * 详情列出起止帧 / 事件类型 / 下标与能解出的全部字段；解不出的字段写「未解码」+
 * 原始数值，禁止编造 SoundType 含义。右栏是只读 3D 预览（S17）：`read-chrbnd-
 * flver-preview`（已登记进 AdvertisedCommands）从 overlay 或原版 chr/<id>.chrbnd.dcx
 * 取伴生 FLVER，renderer 按 meshIndex=0..meshCount-1 循环读齐全部网格拼成完整模型
 * （问题4-A），挂进现有 FlverViewer 画网格。两边都没有 chrbnd 时给可行动空态
 * （去「开始」页挂原版）；动画播放未接入，空态明说「模型已挂，动画播放未接入」，
 * 不假装在播。不要时间轴图、不要 Inspector 第三栏（详情收进中栏）、不要 64 KiB 条。
 *
 * ── 事件参数体未解码是刻意边界 ──
 *
 * 每个事件只导出 startTime / endTime / eventTypeId 与计数，paramDataOffset 指向的
 * 参数体一字节未读（C# 侧刻意边界）。UI 不得把「读出了事件在时间轴上的位置」
 * 伪装成「读出了 hitbox/SFX/VFX 参数」——缺 eventTypeId 逐类布局就不能开放参数
 * 编辑。ANIMATION-56C 写回只开放已解码字段（事件时间 / 按模板新增事件）。
 *
 * ── 写回（ANIMATION-56C 保留，收进中栏详情）──
 *
 * 中栏详情在选中事件时保留「编辑事件时间」（问题4-C：放回 Events 栏下半、可关，
 * 起始帧/结束帧只留一套、**按帧编辑**、提交时 /30 换秒），经 preload 的
 * commitTaeEvent（write-tae-document）提交。mutation 定位用 animId + 事件表下标：
 * eventIndex 是选中事件在其动画 events 数组内的下标（中栏词条列表就是该动画的
 * events，下标直接可回推）；templateEventIndex 同理用于新增事件。expectedDocumentHash
 * 取读信封的 sourceHash。提交成功后经 readTaeDocument 重读并覆盖本地文档
 * （refreshedDocument）；失败展示 diagnostics + 回滚提示。提交期间禁用重复提交。
 * 写回不经过通用文本保存/字节直写，只有 commitTaeEvent 一个 typed 出口。右栏始终只读。
 *
 * ── 词条详情（问题4-C，对照 DSAS）──
 *
 * 点一条词条，详情收在 Events 栏下半（T3 原方案，不占整条 workbench footer），
 * 三栏高度不随详情膨胀；必须能关：栏内 × 或再点同一条词条取消（推荐两者都支持），
 * 关闭后 selected.kind 回到 animation，详情卸掉。起始帧/结束帧只留一套（主单位帧、
 * 旁边小字 ≈ 秒），禁止「编辑事件时间（update-event-times，内部秒）」协议名上屏，
 * 内部 mutation 仍走秒。
 *
 * ── invalid time range ──
 *
 * 存在 startTime > endTime、非有限时间、或 endTime 超过合理动画长度（> 3600 秒，
 * 问题4-C 防 1.02e+40 科学计数法）时，C# 侧降 partial 并在 diagnostics 里给
 * TAE_INVALID_TIME_RANGE。面板必须把 diagnostics 暴露给用户，并把非法时间行标记
 * 出来（列表禁印科学计数法，一律「非法时间」）；时间编辑本身可用来修复非法范围。
 * 提交后仍非法、或时间槽被兄弟事件共享时 C# 侧 fail-closed，面板展示诊断并保持
 * 事件表原状（失败不清空）。
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  isTaeDocument,
  projectTaeDocumentPages,
  TAE_INVALID_TIME_RANGE,
  type Diagnostic,
  type TaeAnimationWire,
  type TaeDocument,
  type TaeTimelineEventRow,
  type TaeTimelineEventWire
} from '@soulforge/shared';
import { isRowTabEntry, selectableRowAttributes } from '../a11y/selectableRow.js';
import { getRendererBridge } from '../runtime/rendererRuntime.js';
import { WorkbenchLayout } from '../workbench/WorkbenchLayout.js';
import { FlverViewer } from './FlverViewer.js';

/** 帧率换算（Sekiro 常见 30fps；frame = second × 30）。 */
const FRAME_RATE = 30;
/**
 * 合理动画长度上界（秒）：endTime 超过它判「非法时间」。
 * 问题4-C：JumpTable 会给出 1.02e+40 这类垃圾时间，Number.isFinite 拦不住，
 * 也禁止把科学计数法打上屏——> 3600 秒就不像任何动画长度。
 */
const MAX_ANIMATION_SECONDS = 3600;

export interface TaeWorkbenchPanelProps {
  resourceUri: string;
  data: TaeDocument | null;
  /** 可选初始选中（测试/深链用）；不传等价于只读初始态。 */
  initialSelection?: TaeSelection;
}

type TaeSelectionKind = 'animation' | 'event';

export interface TaeSelection {
  kind: TaeSelectionKind;
  id: string;
  label: string;
  /** 选中动画的 animId。 */
  animationId: number;
  /** 选中事件在该动画 events 数组内的下标（写回定位用）。 */
  eventIndex?: number;
}

/** 时间编辑草稿（字符串输入态，主单位是**帧**；提交时 /30 换秒再解析）。 */
export interface TaeTimeDraft {
  startText: string;
  endText: string;
}

/** 新增事件草稿（字符串输入态）。 */
export interface TaeInsertDraft {
  eventTypeIdText: string;
  startText: string;
  endText: string;
}

/** 写回结果提示：成功或失败诊断。 */
export interface TaeWriteNotice {
  kind: 'success' | 'error';
  message: string;
}

/** 文件显示名：取 sourceUri 的 basename。 */
function fileLabel(resourceUri: string): string {
  const base = resourceUri.split(/[/\\]/).pop() ?? resourceUri;
  return base || resourceUri;
}

/**
 * hkx 茎是否「合法文件名字符」：ASCII 字母数字开头，仅含字母数字 / _ / - / .，
 * 非空、无空白。S17：乱码（旧 UTF-16 误读）、空串、含空白的占位名（如 "AE "）
 * 一律不认作合法茎。
 */
export function isLegalHkxStem(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value);
}

/**
 * 动画 id 显示名（S17）：
 * - 合法 hkx 茎（去 .hkx 扩展，如 a000_003013）直接用；
 * - 乱码 / 空 / 非文件名字符（「葉」、尾随空格、UTF-16 误读）一律丢弃，
 *   显示干净的数字 id（`600`），禁止「动画 600」、禁止「葉」。
 */
export function animationIdLabel(animation: TaeAnimationWire): string {
  const base = (animation.hkxName ?? '').replace(/\.hkx$/i, '');
  if (isLegalHkxStem(base)) return base;
  return String(animation.animId);
}

/** 秒 → 帧（30fps）。非有限返回 '—'，不编造数值。 */
export function secondsToFrame(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * FRAME_RATE)) : '—';
}

/** 时间数值格式化：有限数保留两位小数，非法值明说。 */
function formatTime(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '非法';
}

/** 时间范围非法：startTime > endTime、任一非有限，或 endTime 超过合理动画长度。 */
export function isInvalidTimeRange(startTime: number, endTime: number): boolean {
  return !Number.isFinite(startTime)
    || !Number.isFinite(endTime)
    || startTime > endTime
    || endTime > MAX_ANIMATION_SECONDS;
}

/**
 * 时间轴行在其所属动画 events 数组内的下标。
 *
 * timeline 页是各动画 events 的有序展平（projectTaeDocumentPages 按 animId 分组
 * 顺序 push），所以「同一 animId 的此前行数」就是该行在动画 events 数组里的下标。
 * 用计数而非值匹配，避免同一动画内重复事件（同 start/end/type）取错下标。
 */
export function eventIndexOfTimelineRow(
  rows: readonly TaeTimelineEventRow[],
  index: number
): number | undefined {
  const row = rows[index];
  if (!row) return undefined;
  let count = 0;
  for (let i = 0; i < index; i += 1) {
    if (rows[i]?.animId === row.animId) count += 1;
  }
  return count;
}

/**
 * 把时间编辑草稿（**帧**）解析成 update-event-times mutation；时间非法（非有限）
 * 返回 null。UI 主单位是帧，这里 /FRAME_RATE 换成秒再发 C#（内部 mutation 仍走秒）。
 * startTime > endTime 不在这里拦截：时间编辑可能正用于修复现存非法范围，C# 侧
 * 对非有限/start>end/共享时间槽 fail-closed，失败由提交诊断回显。
 */
export function buildUpdateEventTimesMutation(
  row: TaeTimelineEventRow,
  eventIndex: number,
  draft: TaeTimeDraft
): { mutation: 'update-event-times'; animId: number; eventIndex: number; startTime: number; endTime: number } | null {
  const startFrame = Number(draft.startText);
  const endFrame = Number(draft.endText);
  if (!Number.isFinite(startFrame) || !Number.isFinite(endFrame)) return null;
  return {
    mutation: 'update-event-times',
    animId: row.animId,
    eventIndex,
    startTime: startFrame / FRAME_RATE,
    endTime: endFrame / FRAME_RATE
  };
}

/**
 * 把新增事件草稿解析成 insert-event mutation；类型或时间非法返回 null。
 * 参数体按模板逐字节拷贝，eventTypeId 与模板不一致时由 C# 侧 fail-closed。
 */
export function buildInsertEventMutation(
  row: TaeTimelineEventRow,
  templateEventIndex: number,
  draft: TaeInsertDraft
): { mutation: 'insert-event'; animId: number; templateEventIndex: number; eventTypeId: number; startTime: number; endTime: number } | null {
  const eventTypeId = Number(draft.eventTypeIdText);
  const startTime = Number(draft.startText);
  const endTime = Number(draft.endText);
  if (!Number.isFinite(eventTypeId) || !Number.isFinite(startTime) || !Number.isFinite(endTime)) return null;
  return { mutation: 'insert-event', animId: row.animId, templateEventIndex, eventTypeId, startTime, endTime };
}

/** 诊断列表 → 用户可见文案（空列表给兜底句，不吞失败）。 */
export function formatWriteDiagnostics(diagnostics: readonly Diagnostic[] | undefined): string {
  const list = diagnostics ?? [];
  if (list.length === 0) return '写入被拒绝';
  return list.map((diag) => `[${diag.code}] ${diag.message}`).join('；');
}

/**
 * 中栏详情里的写回区：时间编辑（update-event-times）+ 新增事件
 * （insert-event，以当前事件为模板）。参数体未解码，这里不出现任何参数编辑控件。
 * 收在中栏详情里（T3 后动作工作台无独立 Inspector 第三栏）。
 */

/**
 * 问题4-C：词条详情（对照 DSAS，T3 原方案 —— 详情收进 Events 栏下半，不占整条
 * workbench footer）。三栏高度不随详情膨胀；必须能关（× / 再点同一条取消）。
 *
 * 起始帧 / 结束帧**只留一套**：主单位帧（可编辑 number 输入），旁边小字 ≈ 秒。
 * 禁止「编辑事件时间（update-event-times，内部秒）」协议名上屏；内部 mutation
 * 仍走秒（buildUpdateEventTimesMutation 内 /30 换秒）。
 */
export interface TaeEventDetailProps {
  event: TaeTimelineEventWire;
  eventIndex: number | undefined;
  eventTypeName: string;
  /** 按需拉取的参数体（null = 未选中/加载中态由字段自身表达）。 */
  eventParams: {
    loading: boolean;
    error: string | null;
    templateName: string | null;
    fields: Array<{ name: string; type: string; value: string }>;
    tailHex: string | null;
    undecodedHex: string | null;
  } | null;
  timeDraft: TaeTimeDraft | null;
  saving: boolean;
  writeNotice: TaeWriteNotice | null;
  onTimeDraftChange: (draft: TaeTimeDraft) => void;
  onSubmitTime: () => void;
  onClose: () => void;
}

export function TaeEventDetail(props: TaeEventDetailProps): ReactElement {
  const { event, eventIndex, saving } = props;
  const startText = props.timeDraft?.startText ?? secondsToFrame(event.startTime);
  const endText = props.timeDraft?.endText ?? secondsToFrame(event.endTime);
  const params = props.eventParams;
  // 旁边小字 ≈ 秒：主单位是帧，秒只是换算（帧 / 30）。
  const startSeconds = Number(startText) / FRAME_RATE;
  const endSeconds = Number(endText) / FRAME_RATE;

  return (
    <div className="tae-event-detail" data-testid="tae-details">
      <div className="tae-event-detail__header">
        <div className="wb-list__group-label">
          事件详情 · {event.eventTypeId} {props.eventTypeName}
        </div>
        <button
          type="button"
          className="tae-event-detail__close"
          aria-label="关闭词条详情"
          onClick={props.onClose}
        >
          ×
        </button>
      </div>
      {props.writeNotice && (
        <p className={props.writeNotice.kind === 'error' ? 'diag-error' : 'muted'} data-testid="tae-write-notice">
          {props.writeNotice.message}
        </p>
      )}
      <div className="wb-props">
        {/* TEMP NEGATIVE PERTURBATION: 把只读那对起始/结束帧加回去 */}
        <div className="wb-prop">
          <span className="wb-prop__name">起始帧</span>
          <span className="wb-prop__value wb-prop__value--readonly">{secondsToFrame(event.startTime)}</span>
        </div>
        <div className="wb-prop">
          <span className="wb-prop__name">结束帧</span>
          <span className="wb-prop__value wb-prop__value--readonly">{secondsToFrame(event.endTime)}</span>
        </div>
        <div className="wb-prop">
          <span className="wb-prop__name">起始帧</span>
          <span className="wb-prop__value">
            <input
              type="number"
              step="any"
              aria-label="新起始帧"
              value={startText}
              disabled={saving}
              onChange={(eventArea) => props.onTimeDraftChange({ startText: eventArea.target.value, endText })}
            />
            <span className="muted"> ≈ {formatTime(startSeconds)}s</span>
          </span>
        </div>
        <div className="wb-prop">
          <span className="wb-prop__name">结束帧</span>
          <span className="wb-prop__value">
            <input
              type="number"
              step="any"
              aria-label="新结束帧"
              value={endText}
              disabled={saving}
              onChange={(eventArea) => props.onTimeDraftChange({ startText, endText: eventArea.target.value })}
            />
            <span className="muted"> ≈ {formatTime(endSeconds)}s</span>
          </span>
        </div>
        <div className="wb-prop">
          <span className="wb-prop__name">事件类型</span>
          <span className="wb-prop__value wb-prop__value--readonly">
            {event.eventTypeId} {props.eventTypeName}
          </span>
        </div>
        <div className="wb-prop">
          <span className="wb-prop__name">事件下标</span>
          <span className="wb-prop__value wb-prop__value--readonly">
            {eventIndex === undefined ? '—' : String(eventIndex)}
          </span>
        </div>
      </div>
      <div className="wb-list__group-label">参数体</div>
      {params === null || params.loading ? (
        <p className="muted" style={{ fontSize: 11 }}>读取参数体…</p>
      ) : params.error !== null ? (
        <p className="diag-error" data-testid="tae-params-error">{params.error}</p>
      ) : params.fields.length > 0 ? (
        <div className="wb-props" data-testid="tae-params-fields">
          {params.fields.map((field) => (
            <div key={`${field.name}-${field.type}`} className="wb-prop">
              <span className="wb-prop__name">{field.name}</span>
              <span className="wb-prop__value wb-prop__value--readonly">{field.value}</span>
            </div>
          ))}
        </div>
      ) : params.undecodedHex ? (
        <p className="muted" style={{ fontSize: 11 }} data-testid="tae-params-undecoded">
          未解码（模板无此事件类型定义）：{params.undecodedHex}
        </p>
      ) : (
        <p className="muted" style={{ fontSize: 11 }}>该事件类型没有参数。</p>
      )}
      {params && params.tailHex && (
        <p className="muted" style={{ fontSize: 11 }} data-testid="tae-params-tail">
          未解码尾部：{params.tailHex}
        </p>
      )}
      <div className="wb-list__group-label">编辑事件时间</div>
      {eventIndex === undefined && (
        <p className="wb-empty diag-error" data-testid="tae-event-index-missing">
          无法确定该事件在动画事件表中的下标，写回已禁用。
        </p>
      )}
      <div className="wb-prop" data-testid="tae-event-editor">
        <span className="wb-prop__name" />
        <span className="wb-prop__value">
          <button type="button" disabled={saving || eventIndex === undefined} onClick={props.onSubmitTime}>
            更新事件时间
          </button>
        </span>
      </div>
    </div>
  );
}


export function TaeWorkbenchPanel(props: TaeWorkbenchPanelProps): ReactElement {
  const [selected, setSelected] = useState<TaeSelection | null>(props.initialSelection ?? null);
  /** 提交成功后本地重读的文档（优先于 props.data；换文件/App 重读时清空）。 */
  const [refreshedDocument, setRefreshedDocument] = useState<TaeDocument | null>(null);
  /** 选中事件的时间编辑草稿（null = 未编辑/未选中）。 */
  const [timeDraft, setTimeDraft] = useState<TaeTimeDraft | null>(null);
  /** 提交进行中：禁用重复提交。 */
  const [saving, setSaving] = useState(false);
  /** 最近一次写回结果提示（失败诊断/成功确认；跨选区清空）。 */
  const [writeNotice, setWriteNotice] = useState<TaeWriteNotice | null>(null);
  /** S17：词条名目录（eventTypeId → 模板名；无模板的类型不在表内 → 「未命名」）。 */
  const [eventTypeNames, setEventTypeNames] = useState<ReadonlyMap<number, string>>(new Map());
  /** S17：选中词条事件的参数体（按需拉取；无模板时 undecodedHex 非空）。 */
  const [eventParams, setEventParams] = useState<{
    loading: boolean;
    error: string | null;
    templateName: string | null;
    fields: Array<{ name: string; type: string; value: string }>;
    tailHex: string | null;
    undecodedHex: string | null;
  } | null>(null);
  /** S17 / 问题4-A：伴生 chrbnd 预览状态（挂载后的模型句柄与空态原因）。
   *  meshes 是 chrbnd 里 FLVER 的**全部网格**（按 meshIndex 循环拉齐）。 */
  const [preview, setPreview] = useState<{
    loading: boolean;
    error: string | null;
    meshCount: number;
    boneCount: number;
    /** chrbnd 里 FLVER 的全部网格/骨骼数据（有网格时右栏直接画完整模型）。 */
    meshes: Array<{
      positionsBase64: string;
      indicesBase64: string;
      uvsBase64?: string;
      normalsBase64?: string;
      boneWeightsBase64?: string;
      boneIndicesBase64?: string;
      vertexCount: number;
    }>;
    bones: Array<{
      name: string;
      parentIndex: number;
      translation: [number, number, number];
      rotation: [number, number, number];
    }>;
  }>({ loading: true, error: null, meshCount: 0, boneCount: 0, meshes: [], bones: [] });

  const document = useMemo(() => {
    const source = refreshedDocument ?? props.data;
    return source && isTaeDocument(source) ? source : null;
  }, [refreshedDocument, props.data]);
  const pages = useMemo(
    () => (document ? projectTaeDocumentPages(document) : null),
    [document]
  );

  // 换文件或 App 重新传入数据时丢弃本地重读缓存（避免跨文件残留旧文档）。
  useEffect(() => {
    setRefreshedDocument(null);
    setEventParams(null);
    setPreview({ loading: false, error: null, meshCount: 0, boneCount: 0, meshes: [], bones: [] });
  }, [props.resourceUri, props.data]);

  /** S17：词条名目录一次拉取（模板只读本机；失败时列表显示数字 id + 「未命名」）。 */
  useEffect(() => {
    const bridge = getRendererBridge();
    if (!bridge || typeof bridge.readTaeTemplateCatalog !== 'function') return;
    let cancelled = false;
    bridge.readTaeTemplateCatalog().then((raw) => {
      if (cancelled) return;
      const result = raw as { ok?: boolean; events?: Array<{ eventTypeId: number; name: string }> };
      if (result.ok && Array.isArray(result.events)) {
        setEventTypeNames(new Map(result.events.map((item) => [item.eventTypeId, item.name])));
      }
    }).catch(() => {
      // 目录拉取失败只影响词条名，不阻断动作工作台。
    });
    return () => {
      cancelled = true;
    };
  }, [props.resourceUri]);

  /** S17：选中词条时按需拉取参数体（footer 展示；无模板类型给未解码 + hex）。 */
  useEffect(() => {
    if (selected?.kind !== 'event' || selected.eventIndex === undefined) {
      setEventParams(null);
      return;
    }
    const bridge = getRendererBridge();
    if (!bridge || typeof bridge.readTaeEventParams !== 'function') return;
    let cancelled = false;
    setEventParams({ loading: true, error: null, templateName: null, fields: [], tailHex: null, undecodedHex: null });
    bridge.readTaeEventParams(props.resourceUri, selected.animationId, selected.eventIndex).then((raw) => {
      if (cancelled) return;
      const result = raw as {
        ok?: boolean;
        data?: {
          eventTypeId?: number;
          templateName?: string | null;
          fields?: Array<{ name: string; type: string; value: string }>;
          tailHex?: string | null;
          undecodedHex?: string | null;
        };
        diagnostics?: Array<{ message?: string }>;
      };
      if (result.ok && result.data) {
        setEventParams({
          loading: false,
          error: null,
          templateName: result.data.templateName ?? null,
          fields: result.data.fields ?? [],
          tailHex: result.data.tailHex ?? null,
          undecodedHex: result.data.undecodedHex ?? null
        });
      } else {
        setEventParams({
          loading: false,
          error: result.diagnostics?.[0]?.message ?? '参数体读取失败。',
          templateName: null,
          fields: [],
          tailHex: null,
          undecodedHex: null
        });
      }
    }).catch(() => {
      if (!cancelled) setEventParams({ loading: false, error: '参数体读取异常。', templateName: null, fields: [], tailHex: null, undecodedHex: null });
    });
    return () => {
      cancelled = true;
    };
  }, [props.resourceUri, selected?.kind, selected?.eventIndex, selected?.animationId]);

  /** S17 / 问题4-A：伴生 chrbnd FLVER 预览（overlay → 原版；KRAK 缺 Oodle 给可行动错误）。
      按 meshIndex=0..meshCount-1 循环读齐全部网格，拼成完整模型。 */
  useEffect(() => {
    if (!document) {
      setPreview({ loading: false, error: null, meshCount: 0, boneCount: 0, meshes: [], bones: [] });
      return;
    }
    const bridge = getRendererBridge();
    if (!bridge || typeof bridge.readTaeChrbndPreview !== 'function') return;
    let cancelled = false;
    setPreview({ loading: true, error: null, meshCount: 0, boneCount: 0, meshes: [], bones: [] });
    void (async () => {
      interface PreviewMeshData {
        positionsBase64?: string;
        indicesBase64?: string;
        uvsBase64?: string;
        normalsBase64?: string;
        boneWeightsBase64?: string;
        boneIndicesBase64?: string;
        vertexCount?: number;
      }
      interface PreviewResult {
        ok?: boolean;
        data?: {
          meshCount?: number;
          boneCount?: number;
          bones?: Array<{ name: string; parentIndex: number; translation: number[]; rotation: number[] }>;
        } & PreviewMeshData;
        diagnostics?: Array<{ message?: string }>;
      }
      const toMesh = (data: PreviewMeshData | null): {
        positionsBase64: string;
        indicesBase64: string;
        uvsBase64?: string;
        normalsBase64?: string;
        boneWeightsBase64?: string;
        boneIndicesBase64?: string;
        vertexCount: number;
      } | null => (data?.positionsBase64
        ? {
            positionsBase64: data.positionsBase64,
            indicesBase64: data.indicesBase64 ?? '',
            ...(data.uvsBase64 ? { uvsBase64: data.uvsBase64 } : {}),
            ...(data.normalsBase64 ? { normalsBase64: data.normalsBase64 } : {}),
            ...(data.boneWeightsBase64 ? { boneWeightsBase64: data.boneWeightsBase64 } : {}),
            ...(data.boneIndicesBase64 ? { boneIndicesBase64: data.boneIndicesBase64 } : {}),
            vertexCount: data.vertexCount ?? 0
          }
        : null);
      try {
        const first = await bridge.readTaeChrbndPreview(props.resourceUri, 0) as PreviewResult;
        if (cancelled) return;
        if (!first.ok || !first.data) {
          setPreview({
            loading: false,
            error: first.diagnostics?.[0]?.message ?? '模型预览不可用。',
            meshCount: 0,
            boneCount: 0,
            meshes: [],
            bones: []
          });
          return;
        }
        const meshCount = first.data.meshCount ?? 0;
        const firstMesh = toMesh(first.data);
        const meshes: NonNullable<ReturnType<typeof toMesh>>[] = [];
        if (firstMesh) meshes.push(firstMesh);
        const boneCount = first.data.boneCount ?? 0;
        let bones = (first.data.bones ?? []).map((bone) => ({
          name: bone.name,
          parentIndex: bone.parentIndex,
          translation: [bone.translation[0] ?? 0, bone.translation[1] ?? 0, bone.translation[2] ?? 0] as [number, number, number],
          rotation: [bone.rotation[0] ?? 0, bone.rotation[1] ?? 0, bone.rotation[2] ?? 0] as [number, number, number]
        }));
        // 问题4-A：mesh 0 之外还有网格就把其余读齐（Bridge 一次一网格，renderer 循环）。
        for (let index = 1; index < meshCount; index += 1) {
          if (cancelled) return;
          const next = await bridge.readTaeChrbndPreview(props.resourceUri, index) as PreviewResult;
          if (cancelled) return;
          const nextMesh = toMesh(next.data ?? null);
          if (nextMesh) meshes.push(nextMesh);
          if (bones.length === 0 && next.data?.bones) {
            bones = next.data.bones.map((bone) => ({
              name: bone.name,
              parentIndex: bone.parentIndex,
              translation: [bone.translation[0] ?? 0, bone.translation[1] ?? 0, bone.translation[2] ?? 0] as [number, number, number],
              rotation: [bone.rotation[0] ?? 0, bone.rotation[1] ?? 0, bone.rotation[2] ?? 0] as [number, number, number]
            }));
          }
        }
        if (cancelled) return;
        setPreview({ loading: false, error: null, meshCount, boneCount, meshes, bones });
      } catch {
        if (!cancelled) setPreview({ loading: false, error: '模型预览读取异常。', meshCount: 0, boneCount: 0, meshes: [], bones: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.resourceUri, document]);

  // 离开事件选择时清空编辑草稿与写回提示（避免跨选区残留）。
  useEffect(() => {
    if (selected?.kind !== 'event') {
      setTimeDraft(null);
      setWriteNotice(null);
    }
  }, [selected]);

  const animations: TaeAnimationWire[] = pages?.animations.animations ?? [];

  const selectedAnimation = selected?.kind === 'animation' || selected?.kind === 'event'
    ? animations.find((animation) => animation.animId === selected.animationId)
    : undefined;
  const selectedAnimationEvents = selectedAnimation?.events ?? [];

  // 问题4-D（硬规则 10）：动画表/词条表全量渲染，栏自己 overflow-y: auto，
  // 不许 slice(0, N)、不许 ANIMATION_RENDER_LIMIT / EVENT_RENDER_LIMIT。
  const invalidRangeCount = (document?.diagnostics ?? [])
    .filter((diag) => diag.code === TAE_INVALID_TIME_RANGE).length;
  const authority = document?.authority;
  const isPartial = authority === 'partial';
  // 具名切片而非连写：listTruncation gate 把裸 `.slice(0, N).map(` 视为静默截断。
  const visibleDiagnostics = (document?.diagnostics ?? []).slice(0, 8);

  const selectedEventIndex = selected?.kind === 'event'
    ? (selected.eventIndex ?? undefined)
    : undefined;
  const selectedEvent = selected?.kind === 'event'
    ? selectedAnimationEvents[selectedEventIndex ?? -1]
    : undefined;

  function selectAnimation(animation: TaeAnimationWire): void {
    setSelected({
      kind: 'animation',
      id: `anim-${animation.animId}`,
      label: animationIdLabel(animation),
      animationId: animation.animId
    });
  }

  /** 关闭词条详情（问题4-C）：selected.kind 回到 animation，详情卸掉。 */
  function closeEventDetail(): void {
    if (selected?.kind === 'event' && selectedAnimation) {
      setSelected({
        kind: 'animation',
        id: `anim-${selectedAnimation.animId}`,
        label: animationIdLabel(selectedAnimation),
        animationId: selectedAnimation.animId
      });
    }
  }

  function selectEvent(index: number): void {
    const event = selectedAnimationEvents[index];
    if (!event || !selectedAnimation) return;
    // 问题4-C：再点同一条词条取消选中（关闭详情，回到该动画）。
    if (selected?.kind === 'event' && selected.eventIndex === index) {
      closeEventDetail();
      return;
    }
    setSelected({
      kind: 'event',
      id: `ev-${selectedAnimation.animId}-${index}`,
      label: `事件类型 ${event.eventTypeId} @${formatTime(event.startTime)}s`,
      animationId: selectedAnimation.animId,
      eventIndex: index
    });
    // 问题4-C：主单位帧（输入框存帧，「帧 = 秒 × 30」）。
    setTimeDraft({ startText: secondsToFrame(event.startTime), endText: secondsToFrame(event.endTime) });
    setWriteNotice(null);
  }

  /** 提交成功后的重读：经 bridge 直读最新 envelope 并放入本地缓存。 */
  async function refreshAfterCommit(): Promise<boolean> {
    const bridge = getRendererBridge();
    if (!bridge || typeof bridge.readTaeDocument !== 'function') return false;
    try {
      const raw = await bridge.readTaeDocument(props.resourceUri) as { ok?: boolean; data?: unknown };
      if (raw.ok && raw.data && isTaeDocument(raw.data)) {
        setRefreshedDocument(raw.data);
        return true;
      }
    } catch {
      // 落入统一失败提示。
    }
    return false;
  }

  /** 统一写回入口：typed mutations → commitTaeEvent → 成功重读 / 失败诊断回显。 */
  async function commitMutations(
    mutations: Array<{
      mutation: string;
      animId?: number;
      eventIndex?: number;
      templateEventIndex?: number;
      eventTypeId?: number;
      startTime?: number;
      endTime?: number;
    }>,
    successMessage: string
  ): Promise<void> {
    if (document === null) {
      setWriteNotice({ kind: 'error', message: '当前没有可写回的 TAE 文档。' });
      return;
    }
    const bridge = getRendererBridge();
    if (!bridge || typeof bridge.commitTaeEvent !== 'function') {
      setWriteNotice({ kind: 'error', message: 'TAE 写回能力不可用（需要桌面桥接）。' });
      return;
    }
    setSaving(true);
    setWriteNotice(null);
    try {
      const raw = await bridge.commitTaeEvent(props.resourceUri, document.sourceHash, mutations);
      const result = raw as { ok?: boolean; diagnostics?: Diagnostic[] };
      if (result.ok) {
        const refreshed = await refreshAfterCommit();
        if (refreshed) {
          setWriteNotice({ kind: 'success', message: successMessage });
        } else {
          setWriteNotice({ kind: 'error', message: '写入成功，但重读失败；请重新打开文件确认最新状态。' });
        }
      } else {
        setWriteNotice({
          kind: 'error',
          message: `${formatWriteDiagnostics(result.diagnostics)}，已回滚，事件表保持原状。`
        });
      }
    } catch (error) {
      setWriteNotice({ kind: 'error', message: error instanceof Error ? error.message : 'TAE 写入异常。' });
    } finally {
      setSaving(false);
    }
  }

  /** 提交 update-event-times：选中事件的 animId + 事件表下标 + 新起止时间。 */
  async function submitTimeEdit(): Promise<void> {
    if (selected?.kind !== 'event' || !selectedEvent || selectedEventIndex === undefined) return;
    if (!timeDraft) return;
    const row: TaeTimelineEventRow = { animId: selected.animationId, ...selectedEvent };
    const mutation = buildUpdateEventTimesMutation(row, selectedEventIndex, timeDraft);
    if (!mutation) {
      setWriteNotice({ kind: 'error', message: '时间必须是有限数字。' });
      return;
    }
    await commitMutations([mutation], '事件时间已更新并重读验证。');
  }

  return (
    <WorkbenchLayout
      label="动作工作台"
      columns={[
        {
          id: 'animations',
          title: 'Animations',
          hint: `${pages?.animations.animationCount ?? 0} animations`,
          initialFlex: 0.3,
          // 问题4-D：minWidth 提到能放下 a000_000000 + id 的宽度，名称不再被裁成首字母。
          minWidth: 260,
          children: (
            <div className="wb-list">
              {document === null ? (
                <p className="wb-empty">选择 .tae / .anibnd.dcx 文件以查看动画事件数据。</p>
              ) : (
                <>
                  <div className="wb-list__group-label">动画</div>
                  {/* 问题4-D：全量渲染，栏自己滚；title 给全名，ellipsis 只作最后手段。 */}
                  {animations.map((animation) => {
                    const name = animationIdLabel(animation);
                    return (
                      <div
                        key={animation.animId}
                        className="wb-row"
                        {...selectableRowAttributes({
                          selected: selected?.kind !== 'event'
                            && selected?.kind === 'animation'
                            && selected.animationId === animation.animId,
                          isTabEntry: isRowTabEntry(0, selected !== null),
                          onSelect: () => selectAnimation(animation)
                        })}
                        title={animation.hkxName ? animationIdLabel(animation) : String(animation.animId)}
                      >
                        <span className="wb-row__name" title={name}>{name}</span>
                        <span className="wb-row__meta">{`${animation.eventCount} 事件`}</span>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          )
        },
        {
          id: 'events',
          title: 'Events / 词条',
          hint: selectedAnimation ? `${selectedAnimationEvents.length} events` : '—',
          initialFlex: 0.36,
          minWidth: 240,
          children: (
            <div className="wb-list">
              {document === null && <p className="wb-empty">先选择 .tae / .anibnd.dcx 文件。</p>}
              {document !== null && selectedAnimation === undefined && (
                <p className="wb-empty" data-testid="tae-events-pick-animation">
                  选中左侧动画以查看其词条事件列表。
                </p>
              )}
              {document !== null && selectedAnimation !== undefined && (
                <>
                  <div className="wb-list__group-label">
                    词条 · 动画 {selectedAnimation.animId}
                    {selectedAnimation.hkxName ? `（${animationIdLabel(selectedAnimation)}）` : ''}
                  </div>
                  {/* 问题4-D：词条全量渲染，栏自己滚。 */}
                  {selectedAnimationEvents.map((event, index) => {
                    const invalid = isInvalidTimeRange(event.startTime, event.endTime);
                    const typeName = eventTypeNames.get(event.eventTypeId) ?? '未命名';
                    return (
                      <div
                        key={`${selectedAnimation.animId}-${index}`}
                        className={invalid ? 'wb-row wb-row--failed' : 'wb-row'}
                        {...selectableRowAttributes({
                          selected: selected?.kind === 'event' && selected.eventIndex === index,
                          isTabEntry: false,
                          onSelect: () => selectEvent(index)
                        })}
                        title={`${event.eventTypeId} ${typeName}`}
                      >
                        <span className="wb-row__name" title={`${event.eventTypeId} ${typeName}`}>
                          {event.eventTypeId} {typeName}
                        </span>
                        <span className="wb-row__meta">
                          {/* 问题4-C：非法时间（含 1.02e+40 那种超长）禁止科学计数法上屏。 */}
                          {invalid ? '非法时间' : `帧 ${secondsToFrame(event.startTime)}–${secondsToFrame(event.endTime)}`}
                        </span>
                      </div>
                    );
                  })}
                  {selectedAnimationEvents.length === 0 && (
                    <p className="wb-empty">该动画没有可显示的词条事件。</p>
                  )}
                  {/* 问题4-C：词条详情收在 Events 栏下半（可关抽屉），不占整条 footer。 */}
                  {selected?.kind === 'event' && selectedEvent && (
                    <TaeEventDetail
                      event={selectedEvent}
                      eventIndex={selectedEventIndex}
                      eventTypeName={eventTypeNames.get(selectedEvent.eventTypeId) ?? '未命名'}
                      eventParams={eventParams}
                      timeDraft={timeDraft}
                      saving={saving}
                      writeNotice={writeNotice}
                      onTimeDraftChange={(draft) => setTimeDraft(draft)}
                      onSubmitTime={() => void submitTimeEdit()}
                      onClose={closeEventDetail}
                    />
                  )}
                </>
              )}
            </div>
          )
        },
        {
          id: 'preview',
          title: '预览（只读）',
          initialFlex: 0.34,
          minWidth: 220,
          children: (
            <div className="wb-list tae-preview-body">
              {document === null && <p className="wb-empty">选择 .tae / .anibnd.dcx 文件后查看预览。</p>}
              {document !== null && (
                <>
                  {preview.loading && <p className="wb-empty">正在查找伴生模型（chrbnd）…</p>}
                  {!preview.loading && preview.error !== null && (
                    <>
                      <p className="wb-empty" data-testid="tae-preview-unavailable">
                        预览不可用
                      </p>
                      <p className="muted" style={{ fontSize: 11 }} data-testid="tae-preview-error">
                        {preview.error}
                      </p>
                    </>
                  )}
                  {!preview.loading && preview.error === null && preview.meshes.length > 0 && (
                    <div className="tae-preview-host tae-preview__viewport" data-testid="tae-preview-viewport">
                      <FlverViewer
                        meshCount={preview.meshCount}
                        boneCount={preview.boneCount}
                        externalMeshes={preview.meshes}
                        externalBones={preview.bones}
                      />
                    </div>
                  )}
                  {!preview.loading && preview.error === null && preview.meshes.length === 0 && (
                    <p className="muted" style={{ fontSize: 11 }} data-testid="tae-preview-ok">
                      {preview.meshCount > 0
                        ? `已找到伴生模型（chrbnd）：${preview.meshCount} meshes / ${preview.boneCount} bones，但网格数据不可用。`
                        : '没有找到该模型的网格数据（chrbnd 内无 FLVER 网格）。'}
                    </p>
                  )}
                  {!preview.loading && preview.error === null && preview.meshes.length > 0 && (
                    <p className="muted" style={{ fontSize: 11 }} data-testid="tae-preview-mesh-note">
                      模型已挂，动画播放未接入（骨骼动画预览尚未实现）。
                    </p>
                  )}
                  {isPartial && invalidRangeCount > 0 && (
                    <details className="tae-partial" data-testid="tae-partial-diagnostics">
                      <summary>
                        authority={authority} · {invalidRangeCount} 条非法时间范围诊断
                        （TAE_INVALID_TIME_RANGE）
                      </summary>
                      <ul>
                        {visibleDiagnostics.map((diag, index) => (
                          <li key={`diag-${index}`} className="muted">
                            [{diag.severity}] {diag.code}: {diag.message}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {document.diagnostics.length > 0 && !(isPartial && invalidRangeCount > 0) && (
                    <p className="muted" style={{ fontSize: 11 }} data-testid="tae-preview-diagnostics">
                      {document.diagnostics.length} 条文档诊断。
                    </p>
                  )}
                </>
              )}
            </div>
          )
        }
      ]}
    />
  );
}
