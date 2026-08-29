/**
 * ANIMATION-56B / T3（2026-08-15）：动作工作台（grok T3，对照 DSAS）。
 *
 * 上三栏 + 底部终端：`[Animations | Events | Preview]` + 底部可拖动详情面板。
 *
 * ── T3 重构（行为 + 动画合并为「动作」）+ 底部 IDE 终端式详情 ──
 *
 * 左栏列动画 id（hkxName 去扩展，如 a000_003013；无 hkxName 用 a000_ + 6位 id）。
 * 次栏列当前动画的词条事件列表——envelope 只有 eventTypeId 与起止时间，词条文本名
 * （PlaySound_ByStateInfo 等）当前未解码，诚实显示「事件类型 N」；选中后详情在
 * 底部独立面板展示（起止帧 / 事件类型 / 下标与能解出的全部字段；解不出的字段写
 * 「未解码」+ 原始数值，禁止编造 SoundType 含义），支持拖拽调高、独立滚动。
 * 右栏是只读 3D 预览（S17）：
 * `read-chrbnd-flver-preview`（已登记进 AdvertisedCommands）从 overlay 或原版
 * chr/<id>.chrbnd.dcx 取伴生 FLVER，renderer 按 meshIndex=0..meshCount-1 循环读齐
 * 全部网格拼成完整模型（问题4-A），挂进现有 FlverViewer 画网格。两边都没有
 * chrbnd 时给可行动空态（去「开始」页挂原版）；动画播放未接入，空态明说
 * 「模型已挂，动画播放未接入」，不假装在播。不要时间轴图、不要 64 KiB 条。
 *
 * ── 事件参数体未解码是刻意边界 ──
 *
 * 每个事件只导出 startTime / endTime / eventTypeId 与计数，paramDataOffset 指向的
 * 参数体一字节未读（C# 侧刻意边界）。UI 不得把「读出了事件在时间轴上的位置」
 * 伪装成「读出了 hitbox/SFX/VFX 参数」——缺 eventTypeId 逐类布局就不能开放参数
 * 编辑。ANIMATION-56C 写回只开放已解码字段（事件时间 / 按模板新增事件）。
 *
 * ── 写回（ANIMATION-56C 保留，收进详情栏）──
 *
 * 详情栏在选中事件时保留「编辑事件时间」（问题4-C：独立第四栏前的第三栏、可关，
 * 起始帧/结束帧只留一套、**按帧编辑**、提交时 /30 换秒），经 preload 的
 * commitTaeEvent（write-tae-document）提交。mutation 定位用 animId + 事件表下标：
 * eventIndex 是选中事件在其动画 events 数组内的下标（中栏词条列表就是该动画的
 * events，下标直接可回推）；templateEventIndex 同理用于新增事件。expectedDocumentHash
 * 取读信封的 sourceHash。提交成功后经 readTaeDocument 重读并覆盖本地文档
 * （refreshedDocument）；失败展示 diagnostics + 回滚提示。提交期间禁用重复提交。
 * 写回不经过通用文本保存/字节直写，只有 commitTaeEvent 一个 typed 出口。右栏始终只读。
 *
 * ── 词条详情（底部 IDE 终端式面板，对照 DSAS）──
 *
 * 点一条词条，详情沉到底部独立面板展示（独立滚动，不与词条/动画列表共享滚动）；
 * 未选中时显示「选中词条以编辑」空态。必须能关：栏内 × 或再点同一条词条取消
 * （两者都支持），关闭后 selected.kind 回到 animation，详情卸掉。面板高度受控
 * state（默认 280px，min 160 max 60% 视口），顶部 6px drag handle 支持 pointer
 * 拖拽调高。起始帧/结束帧只留一套（主单位帧、旁边小字 ≈ 秒），禁止
 * 「编辑事件时间（update-event-times，内部秒）」协议名上屏，内部 mutation 仍走秒。
 *
 * ── 分页 ──
 *
 * 首次加载用 pageSize=1000 拉全量（覆盖 c0000 939）；若 envelope 仍截断
 * （animationsTruncated），展示警示并提供「加载更多」分页按钮逐页追加。
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

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  isTaeDocument,
  projectTaeDocumentPages,
  TAE_INVALID_TIME_RANGE,
  AnimationPlaybackClock,
  ActionContinuousSampler,
  eulerXYZToQuaternion,
  isCharacterPreviewBundle,
  type CharacterPreviewBundle,
  type TaeAnimationClipData,
  type BoneTransformData,
  buildTaeTimelineTracks,
  type TaeTimelineTrack,
  type TaeTimelineBlock,
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

function PlayIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PauseIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
    </svg>
  );
}

function StopIcon(): ReactElement {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M6 6h12v12H6z" />
    </svg>
  );
}

function PrevFrameIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
    </svg>
  );
}

function NextFrameIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
    </svg>
  );
}

function LoopIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 2l4 4-4 4" />
      <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
      <path d="M7 22l-4-4 4-4" />
      <path d="M21 13v1a4 4 0 0 1-4 4H3" />
    </svg>
  );
}

/**
 * TAE 动画分页的 renderer 状态。
 *
 * `hasMore` 只接受 Bridge 当前页的 `animationsTruncated`，不根据本地已加载数量
 * 推断 EOF。`nextPage` 也由页号推进，避免在去重或重读后用动画数量反推页码。
 */
export interface TaeAnimationPaginationState {
  documentKey: string;
  baseAnimationIds: readonly number[];
  animations: readonly TaeAnimationWire[];
  nextPage: number;
  hasMore: boolean;
}

export function createTaeAnimationPaginationState(
  documentKey: string,
  document: TaeDocument
): TaeAnimationPaginationState {
  return {
    documentKey,
    baseAnimationIds: document.animations.map((animation) => animation.animId),
    animations: [],
    nextPage: 1,
    hasMore: document.animationsTruncated === true
  };
}

/**
 * 追加一个服务端动画页。页号不匹配时保持旧状态，调用方可安全忽略迟到响应；
 * 动画 id 去重保证重试/重复响应不会把同一动画插入两次。
 */
export function appendTaeAnimationPage(
  state: TaeAnimationPaginationState,
  page: TaeDocument,
  pageNumber: number
): TaeAnimationPaginationState {
  if (!state.hasMore || pageNumber !== state.nextPage) return state;
  const seen = new Set<number>([
    ...state.baseAnimationIds,
    ...state.animations.map((animation) => animation.animId)
  ]);
  const additions = page.animations.filter((animation) => {
    if (seen.has(animation.animId)) return false;
    seen.add(animation.animId);
    return true;
  });
  return {
    ...state,
    animations: [...state.animations, ...additions],
    nextPage: pageNumber + 1,
    hasMore: page.animationsTruncated === true
  };
}

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
  if (value.length < 3) return false;
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value);
}

/**
 * 动画 id 显示名（S17）：
 * - 合法 hkx 茎（去 .hkx/.hkt 扩展，如 a000_003013）直接用；
 * - 乱码 / 空 / 过短（"a"）/ 非文件名字符一律丢弃，回退为 a000_ + 6位 animId。
 */
export function animationIdLabel(animation: TaeAnimationWire): string {
  const base = (animation.hkxName ?? '').replace(/\.(hkx|hkt)$/i, '');
  if (isLegalHkxStem(base)) return base;
  return `a000_${String(animation.animId).padStart(6, '0')}`;
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
 * 详情栏里的写回区：时间编辑（update-event-times）+ 新增事件
 * （insert-event，以当前事件为模板）。参数体未解码，这里不出现任何参数编辑控件。
 * 详情栏独立滚动，不与词条列表共享滚动容器。
 */

/**
 * 词条详情（独立第三栏，对照 DSAS）。详情在独立栏展示，未选中显示空态。
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
  /** App 传入的原始文档之外，分页「加载更多」追加的增量文档片段。 */
  const [pagination, setPagination] = useState<TaeAnimationPaginationState | null>(null);
  const [paginationNotice, setPaginationNotice] = useState<string | null>(null);
  const [paginationLoading, setPaginationLoading] = useState(false);
  /** 令迟到的旧文件/旧页响应失效，不得污染当前文档。 */
  const paginationRequestRef = useRef(0);
  /** 选中事件的时间编辑草稿（null = 未编辑/未选中）。 */
  const [timeDraft, setTimeDraft] = useState<TaeTimeDraft | null>(null);
  /** 提交进行中：禁用重复提交。 */
  const [saving, setSaving] = useState(false);
  /** 最近一次写回结果提示（失败诊断/成功确认；跨选区清空）。 */
  const [writeNotice, setWriteNotice] = useState<TaeWriteNotice | null>(null);
  /** S17：词条名目录（eventTypeId → 模板名；无模板的类型不在表内 → 「未命名」）。 */
  const [eventTypeNames, setEventTypeNames] = useState<ReadonlyMap<number, string>>(new Map());
  /** 动画播放器状态 */
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1.0);
  const [isLooping, setIsLooping] = useState(true);
  /** S17：选中词条事件的参数体（按需拉取；无模板时 undecodedHex 非空）。 */
  const [eventParams, setEventParams] = useState<{
    loading: boolean;
    error: string | null;
    templateName: string | null;
    fields: Array<{ name: string; type: string; value: string }>;
    tailHex: string | null;
    undecodedHex: string | null;
  } | null>(null);
  /** S17 / 问题4-A：伴生 chrbnd 预览状态（一次读取完整角色 bundle，不再逐 mesh 循环）。 */
  const [preview, setPreview] = useState<{
    loading: boolean;
    error: string | null;
    bundle: CharacterPreviewBundle | null;
  }>({ loading: true, error: null, bundle: null });

  const document = useMemo(() => {
    const source = refreshedDocument ?? props.data;
    return source && isTaeDocument(source) ? source : null;
  }, [refreshedDocument, props.data]);
  const documentKey = document
    ? `${props.resourceUri}\u0000${document.sourceHash}`
    : props.resourceUri;
  const documentKeyRef = useRef(documentKey);
  documentKeyRef.current = documentKey;
  const activePagination = pagination?.documentKey === documentKey ? pagination : null;
  const mergedDocument = useMemo(() => {
    if (!document) return null;
    if (!activePagination) return document;
    return {
      ...document,
      animations: [...document.animations, ...activePagination.animations],
      // 这是服务端页的 authority，不是 renderer 根据本地数量推断出来的状态。
      animationsTruncated: activePagination.hasMore
    } as TaeDocument;
  }, [activePagination, document]);
  const pages = useMemo(
    () => (mergedDocument ? projectTaeDocumentPages(mergedDocument) : null),
    [mergedDocument]
  );

  // 换文件或 App 重新传入数据时丢弃本地重读缓存（避免跨文件残留旧文档）。
  useEffect(() => {
    paginationRequestRef.current += 1;
    setRefreshedDocument(null);
    setPagination(null);
    setPaginationNotice(null);
    setPaginationLoading(false);
    setEventParams(null);
    setPreview({ loading: false, error: null, bundle: null });
  }, [props.resourceUri, props.data]);

  // 首次文档进入/提交重读后建立页 1 的权威游标；资源切换 effect 会先把旧状态清掉。
  useEffect(() => {
    if (!document) {
      setPagination(null);
      return;
    }
    setPagination(createTaeAnimationPaginationState(documentKey, document));
  }, [document, documentKey]);

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

  /** S17 / 问题4-A：伴生 chrbnd FLVER 预览（一次读取完整角色 bundle，不再逐 mesh 循环）。 */
  useEffect(() => {
    if (!document) {
      setPreview({ loading: false, error: null, bundle: null });
      return;
    }
    const bridge = getRendererBridge();
    if (!bridge || typeof bridge.readTaeChrbndPreview !== 'function') return;
    let cancelled = false;
    setPreview({ loading: true, error: null, bundle: null });
    void (async () => {
      try {
        const result = await bridge.readTaeChrbndPreview(props.resourceUri) as { ok?: boolean; data?: unknown; diagnostics?: Array<{ message?: string }> };
        if (cancelled) return;
        if (!result.ok || !result.data || !isCharacterPreviewBundle(result.data)) {
          setPreview({
            loading: false,
            error: (result as any).diagnostics?.[0]?.message ?? '模型预览不可用。',
            bundle: null
          });
          return;
        }
        if (cancelled) return;
        setPreview({ loading: false, error: null, bundle: result.data });
      } catch {
        if (!cancelled) setPreview({ loading: false, error: '模型预览读取异常。', bundle: null });
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

  // 底部 IDE 终端式详情面板（高度受控，拖拽 handle 调整）。
  const BOTTOM_DETAILS_MIN = 160;
  const BOTTOM_DETAILS_DEFAULT = 280;
  const [detailsHeight, setDetailsHeight] = useState(BOTTOM_DETAILS_DEFAULT);
  const detailsDragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const handleBottomDetailsPointerDown = useCallback((event: React.PointerEvent) => {
    detailsDragRef.current = { startY: event.clientY, startHeight: detailsHeight };
    try {
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    } catch {
      // 非 pointer 环境忽略。
    }
  }, [detailsHeight]);

  useEffect(() => {
    function onMove(event: PointerEvent): void {
      const drag = detailsDragRef.current;
      if (!drag) return;
      const delta = drag.startY - event.clientY; // 向上拖 → 高度增加
      const viewportH = typeof window !== 'undefined' ? window.innerHeight : 900;
      const max = Math.max(BOTTOM_DETAILS_MIN, Math.floor(viewportH * 0.6));
      const next = Math.min(max, Math.max(BOTTOM_DETAILS_MIN, drag.startHeight + delta));
      setDetailsHeight(next);
    }
    function onUp(): void {
      detailsDragRef.current = null;
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  const animations: TaeAnimationWire[] = pages?.animations.animations ?? [];

  const selectedAnimation = selected?.kind === 'animation' || selected?.kind === 'event'
    ? animations.find((animation) => animation.animId === selected.animationId)
    : undefined;
  const selectedAnimationEvents = selectedAnimation?.events ?? [];

  const invalidRangeCount = (mergedDocument?.diagnostics ?? [])
    .filter((diag) => diag.code === TAE_INVALID_TIME_RANGE).length;
  const authority = mergedDocument?.authority;
  const isPartial = authority === 'partial';
  // 具名切片而非连写：listTruncation gate 把裸 `.slice(0, N).map(` 视为静默截断。
  const visibleDiagnostics = (mergedDocument?.diagnostics ?? []).slice(0, 8);
  const isAnimationsTruncated = mergedDocument?.animationsTruncated === true;

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

  async function loadMoreAnimations(): Promise<void> {
    const bridge = getRendererBridge();
    const currentPagination = pagination?.documentKey === documentKey ? pagination : null;
    if (
      !bridge
      || typeof bridge.readTaeDocument !== 'function'
      || !mergedDocument
      || !currentPagination
      || !currentPagination.hasMore
      || paginationLoading
    ) return;
    const pageSize = 1000;
    const nextPage = currentPagination.nextPage;
    const requestDocumentKey = documentKey;
    const requestId = ++paginationRequestRef.current;
    setPaginationLoading(true);
    setPaginationNotice(null);
    try {
      const raw = await (bridge.readTaeDocument as (uri: string, opts?: { animationPage?: number; animationPageSize?: number }) => Promise<unknown>)(props.resourceUri, { animationPage: nextPage, animationPageSize: pageSize }) as { ok?: boolean; data?: unknown };
      if (requestId !== paginationRequestRef.current || documentKeyRef.current !== requestDocumentKey) return;
      if (raw.ok && raw.data && isTaeDocument(raw.data)) {
        const nextDoc = raw.data as TaeDocument;
        const next = appendTaeAnimationPage(currentPagination, nextDoc, nextPage);
        setPagination((previous) => (
          previous
            && previous.documentKey === requestDocumentKey
            && previous.nextPage === nextPage
            ? next
            : previous
        ));
        setPaginationNotice(
          next.hasMore
            ? `已加载 ${mergedDocument.animations.length + next.animations.length - currentPagination.animations.length} / ${nextDoc.animationCount}，仍有剩余。`
            : (next.animations.length === currentPagination.animations.length ? '没有更多动画。' : null)
        );
      } else {
        setPaginationNotice('加载更多失败。');
      }
    } catch {
      setPaginationNotice('加载更多异常。');
    } finally {
      if (requestId === paginationRequestRef.current) setPaginationLoading(false);
    }
  }

  /** 提交成功后的重读：经 bridge 直读最新 envelope 并放入本地缓存。 */
  async function refreshAfterCommit(): Promise<boolean> {
    const bridge = getRendererBridge();
    if (!bridge || typeof bridge.readTaeDocument !== 'function') return false;
    try {
      const raw = await (bridge.readTaeDocument as (uri: string, opts?: { animationPage?: number; animationPageSize?: number }) => Promise<unknown>)(props.resourceUri, { animationPage: 0, animationPageSize: 1000 }) as { ok?: boolean; data?: unknown };
      if (raw.ok && raw.data && isTaeDocument(raw.data)) {
        const refreshed = raw.data as TaeDocument;
        paginationRequestRef.current += 1;
        setRefreshedDocument(refreshed);
        setPagination(createTaeAnimationPaginationState(
          `${props.resourceUri}\u0000${refreshed.sourceHash}`,
          refreshed
        ));
        setPaginationNotice(null);
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
    if (mergedDocument === null) {
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
      const raw = await bridge.commitTaeEvent(props.resourceUri, mergedDocument.sourceHash, mutations);
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

  // 权威动画 Clip 数据与连续采样器
  const [activeClip, setActiveClip] = useState<TaeAnimationClipData | null>(null);
  const [activeSampler, setActiveSampler] = useState<ActionContinuousSampler | null>(null);

  useEffect(() => {
    if (!selectedAnimation || !props.resourceUri) {
      setActiveClip(null);
      setActiveSampler(null);
      return;
    }
    const bridge = getRendererBridge();
    if (!bridge || typeof (bridge as any).readTaeAnimationClip !== 'function') return;

    let cancelled = false;
    const leaderBones = (() => {
      if (!preview.bundle) return [] as Array<{ name: string }>;
      const leader = preview.bundle.models.find((m) => m.modelId === preview.bundle!.leaderModelId) ?? preview.bundle.models[0];
      return leader?.bones ?? [];
    })();
    const boneNames = leaderBones.map((b) => b.name);

    void (async () => {
      try {
        const res = (await (bridge as any).readTaeAnimationClip(
          props.resourceUri,
          selectedAnimation.animId,
          boneNames.length > 0 ? boneNames : undefined
        )) as { ok?: boolean; data?: TaeAnimationClipData };

        if (cancelled) return;
        if (res.ok && res.data) {
          setActiveClip(res.data);
          setActiveSampler(new ActionContinuousSampler(res.data));
        } else {
          setActiveClip(null);
          setActiveSampler(null);
        }
      } catch {
        if (!cancelled) {
          setActiveClip(null);
          setActiveSampler(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [props.resourceUri, selectedAnimation?.animId, preview.bundle]);

  // 采样 FLVER 骨骼位姿
  const sampledPose = useMemo(() => {
    const leaderBones = (() => {
      if (!preview.bundle) return [] as Array<{ translation: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number]; }>;
      const leader = preview.bundle.models.find((m) => m.modelId === preview.bundle!.leaderModelId) ?? preview.bundle.models[0];
      return leader?.bones ?? [];
    })();
    if (!activeSampler || leaderBones.length === 0) return undefined;
    const refPose: BoneTransformData[] = leaderBones.map((b) => ({
      translation: b.translation,
      rotation: eulerXYZToQuaternion(b.rotation),
      scale: b.scale ?? [1, 1, 1] as [number, number, number]
    }));
    return activeSampler.sampleFlverPose(playbackTime, leaderBones.length, refPose, isLooping);
  }, [activeSampler, playbackTime, preview.bundle, isLooping]);

  // 计算当前选中动画的总时长（根据真实 clip 时长，或事件最大 endTime，或默认 2.0s）
  const animDuration = useMemo(() => {
    if (activeClip && activeClip.duration > 0) {
      return activeClip.duration;
    }
    if (!selectedAnimationEvents || selectedAnimationEvents.length === 0) return 2.0;
    let max = 0;
    for (const ev of selectedAnimationEvents) {
      if (Number.isFinite(ev.endTime) && ev.endTime > 0 && ev.endTime < MAX_ANIMATION_SECONDS) {
        if (ev.endTime > max) max = ev.endTime;
      }
    }
    return max > 0 ? Math.max(0.5, max) : 2.0;
  }, [activeClip, selectedAnimationEvents]);

  // 权威播放时钟实例
  const clockRef = useRef<AnimationPlaybackClock>(
    new AnimationPlaybackClock({ fps: FRAME_RATE, duration: animDuration, loop: isLooping, playbackRate: playbackSpeed })
  );

  // 同步 duration / loop / speed 到权威时钟
  useEffect(() => {
    clockRef.current.setDuration(animDuration);
  }, [animDuration]);

  useEffect(() => {
    clockRef.current.setLoop(isLooping);
  }, [isLooping]);

  useEffect(() => {
    clockRef.current.setPlaybackRate(playbackSpeed);
  }, [playbackSpeed]);

  // 订阅时钟状态
  useEffect(() => {
    const unsub = clockRef.current.subscribe((state) => {
      setPlaybackTime(state.currentTime);
      setIsPlaying(state.isPlaying);
    });
    return unsub;
  }, []);

  // 切换动画时重置播放进度
  useEffect(() => {
    clockRef.current.stop();
  }, [selected?.animationId]);

  // 播放器 rAF 驱动权威时钟
  useEffect(() => {
    if (!isPlaying) return;
    let last = performance.now();
    let frameId: number;

    const tick = (now: number) => {
      const delta = (now - last) / 1000;
      last = now;
      clockRef.current.tick(delta);
      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [isPlaying]);

  // 快捷键监听：空格键切换播放/暂停
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        clockRef.current.togglePlay();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const totalFrames = Math.round(animDuration * FRAME_RATE);
  const currentFrame = Math.round(playbackTime * FRAME_RATE);

  const togglePlay = () => clockRef.current.togglePlay();
  const resetPlayback = () => clockRef.current.stop();
  const stepFrame = (frames: number) => clockRef.current.stepFrame(frames);
  const seekSeconds = (secs: number) => clockRef.current.seek(secs);

  // 构造结构化 Timeline Tracks
  const timelineTracks = useMemo(() => {
    if (!selectedAnimationEvents || selectedAnimationEvents.length === 0 || !selectedAnimation) return [];
    const rows: TaeTimelineEventRow[] = selectedAnimationEvents.map((ev) => ({
      animId: selectedAnimation.animId,
      ...ev
    }));
    return buildTaeTimelineTracks(rows, mergedDocument?.diagnostics, { fps: FRAME_RATE });
  }, [selectedAnimationEvents, selectedAnimation, mergedDocument?.diagnostics]);

  return (
    <WorkbenchLayout
      label="动作工作台"
      columns={[
        {
          id: 'animations',
          title: 'Animations',
          hint: `${pages?.animations.animationCount ?? 0} animations`,
          initialFlex: 0.22,
          minWidth: 220,
          children: (
            <div className="wb-list">
              {mergedDocument === null ? (
                <p className="wb-empty">选择 .tae / .anibnd.dcx 文件以查看动画事件数据。</p>
              ) : (
                <>
                  <div className="wb-list__group-label">动画</div>
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
                  {isAnimationsTruncated && (
                    <div className="wb-list__group-label" data-testid="tae-animations-truncated">
                      动画列表已截断（仍有未加载项）
                    </div>
                  )}
                  {paginationNotice && (
                    <p className="muted" style={{ fontSize: 11 }} data-testid="tae-pagination-notice">{paginationNotice}</p>
                  )}
                  {isAnimationsTruncated && (
                    <button
                      type="button"
                      disabled={paginationLoading}
                      onClick={() => void loadMoreAnimations()}
                      data-testid="tae-load-more"
                    >
                      {paginationLoading ? '加载中…' : '加载更多'}
                    </button>
                  )}
                </>
              )}
            </div>
          )
        },
        {
          id: 'events',
          title: 'Events / 词条',
          hint: selectedAnimation ? `${selectedAnimationEvents.length} events` : '—',
          initialFlex: 0.28,
          minWidth: 220,
          children: (
            <div className="wb-list">
              {mergedDocument === null && <p className="wb-empty">先选择 .tae / .anibnd.dcx 文件。</p>}
              {mergedDocument !== null && selectedAnimation === undefined && (
                <p className="wb-empty" data-testid="tae-events-pick-animation">
                  选中左侧动画以查看其词条事件列表。
                </p>
              )}
              {mergedDocument !== null && selectedAnimation !== undefined && (
                <>
                  <div className="wb-list__group-label">
                    词条 · 动画 {selectedAnimation.animId}
                    {selectedAnimation.hkxName ? `（${animationIdLabel(selectedAnimation)}）` : ''}
                  </div>
                  {selectedAnimationEvents.map((event, index) => {
                    const invalid = isInvalidTimeRange(event.startTime, event.endTime);
                    const typeName = eventTypeNames.get(event.eventTypeId) ?? '未命名';
                    const isTriggering = !invalid && event.startTime <= playbackTime && playbackTime <= event.endTime;
                    const rowClass = [
                      'wb-row',
                      invalid ? 'wb-row--failed' : '',
                      isTriggering ? 'is-triggering' : ''
                    ].filter(Boolean).join(' ');
                    return (
                      <div
                        key={`${selectedAnimation.animId}-${index}`}
                        className={rowClass}
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
                          {invalid ? '非法时间' : `帧 ${secondsToFrame(event.startTime)}–${secondsToFrame(event.endTime)}`}
                        </span>
                      </div>
                    );
                  })}
                  {selectedAnimationEvents.length === 0 && (
                    <p className="wb-empty">该动画没有可显示的词条事件。</p>
                  )}
                </>
              )}
            </div>
          )
        },
        {
          id: 'details',
          title: '详情',
          hint: selected?.kind === 'event' ? '词条详情' : '—',
          initialFlex: 0.28,
          minWidth: 240,
          children: (
            <div className="wb-list">
              {selected?.kind === 'event' && selectedEvent ? (
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
              ) : (
                <p className="wb-empty" data-testid="tae-details-empty">选中词条以编辑</p>
              )}
            </div>
          )
        },
        {
          id: 'preview',
          title: '预览（只读）',
          initialFlex: 0.22,
          minWidth: 220,
          children: (
            <div className="wb-list tae-preview-body">
              {mergedDocument === null && <p className="wb-empty">选择 .tae / .anibnd.dcx 文件后查看预览。</p>}
              {mergedDocument !== null && (
                <>
                  {preview.loading && <p className="wb-empty">正在查找伴生模型（chrbnd）与装配部件（partsbnd）…</p>}
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
                  {!preview.loading && preview.error === null && preview.bundle !== null && preview.bundle.meshCount > 0 && (
                    <div className="tae-preview-host tae-preview__viewport" data-testid="tae-preview-viewport">
                      <FlverViewer
                        externalBundle={preview.bundle}
                        playbackTime={playbackTime}
                        externalPose={sampledPose}
                      />
                    </div>
                  )}
                  {!preview.loading && preview.error === null && preview.bundle !== null && preview.bundle.meshCount === 0 && preview.bundle.boneCount > 0 && (
                    <div className="tae-preview-host tae-preview__viewport" data-testid="tae-preview-viewport">
                      <FlverViewer
                        externalBundle={preview.bundle}
                        playbackTime={playbackTime}
                        externalPose={sampledPose}
                      />
                    </div>
                  )}
                  {!preview.loading
                    && preview.error === null
                    && preview.bundle?.assemblyMode === 'compatibility-preview'
                    && (
                      <p className="muted" style={{ fontSize: 11 }} data-testid="tae-preview-compatibility-notice" role="status">
                        兼容预览：身体部件按 overlay 优先与文件名字典序，从 bd / am / lg 的有界候选中选择；这不代表存档当前装备。
                      </p>
                    )}
                  {/* 统一 Authoritative 播放控制栏与 Timeline 轨道 */}
                  <div className="tae-timeline-ctrl" data-testid="tae-timeline-ctrl">
                    <div className="tae-transport-bar">
                      <div className="tae-transport-group">
                        <button
                          type="button"
                          className="tae-transport-btn tae-transport-btn--play"
                          onClick={togglePlay}
                          aria-label={isPlaying ? '暂停' : '播放'}
                          title="空格键播放/暂停"
                        >
                          {isPlaying ? <PauseIcon /> : <PlayIcon />}
                          <span>{isPlaying ? '暂停' : '播放'}</span>
                        </button>
                        <button
                          type="button"
                          className="tae-transport-btn"
                          onClick={resetPlayback}
                          aria-label="重置到开头"
                          title="重置到开头"
                        >
                          <StopIcon />
                        </button>
                        <button
                          type="button"
                          className="tae-transport-btn"
                          onClick={() => stepFrame(-1)}
                          aria-label="上一帧"
                          title="上一帧"
                        >
                          <PrevFrameIcon />
                        </button>
                        <button
                          type="button"
                          className="tae-transport-btn"
                          onClick={() => stepFrame(1)}
                          aria-label="下一帧"
                          title="下一帧"
                        >
                          <NextFrameIcon />
                        </button>
                        <button
                          type="button"
                          className={`tae-transport-btn ${isLooping ? 'is-active' : ''}`}
                          onClick={() => setIsLooping(!isLooping)}
                          aria-label={isLooping ? '循环开启' : '循环关闭'}
                          aria-pressed={isLooping}
                          title="循环播放"
                        >
                          <LoopIcon />
                        </button>
                        <select
                          className="tae-speed-select"
                          value={playbackSpeed}
                          onChange={(e) => setPlaybackSpeed(Number(e.target.value))}
                          aria-label="播放速度"
                          title="播放速度"
                        >
                          <option value={0.25}>0.25x</option>
                          <option value={0.5}>0.5x</option>
                          <option value={1.0}>1.0x</option>
                          <option value={2.0}>2.0x</option>
                        </select>
                      </div>
                      <div className="tae-time-display">
                        帧 {currentFrame} / {totalFrames} ({formatTime(playbackTime)}s / {formatTime(animDuration)}s)
                      </div>
                    </div>
                    <div className="tae-timeline-slider-row">
                      <input
                        type="range"
                        className="tae-timeline-slider"
                        min={0}
                        max={totalFrames > 0 ? totalFrames : 100}
                        value={currentFrame}
                        onChange={(e) => {
                          const f = Number(e.target.value);
                          clockRef.current.seekFrame(f);
                        }}
                        aria-label="时间轴进度"
                      />
                    </div>
                    {/* 多轨时间轴视觉呈现 */}
                    {timelineTracks.length > 0 && (
                      <div className="tae-tracks-container" data-testid="tae-tracks-container">
                        {timelineTracks.map((track) => (
                          <div key={`track-${track.trackIndex}`} className="tae-track-row">
                            {track.blocks.map((block) => {
                              const leftPercent = totalFrames > 0 ? (block.startFrame / totalFrames) * 100 : 0;
                              const widthPercent = totalFrames > 0 ? Math.max(2, (block.durationFrames / totalFrames) * 100) : 10;
                              const isTriggering = !block.hasError && block.startTime <= playbackTime && playbackTime <= block.endTime;
                              const isSelected = selected?.kind === 'event' && selected.eventIndex === block.eventIndex;

                              const blockClass = [
                                'tae-track-block',
                                isSelected ? 'is-selected' : '',
                                isTriggering ? 'is-triggering' : '',
                                block.hasError ? 'has-error' : ''
                              ].filter(Boolean).join(' ');

                              return (
                                <div
                                  key={block.id}
                                  className={blockClass}
                                  onClick={() => selectEvent(block.eventIndex)}
                                  title={`${block.eventTypeId} (${block.startFrame}F - ${block.endFrame}F)${block.hasError ? ': ' + block.errorMessage : ''}`}
                                  style={{
                                    left: `${leftPercent}%`,
                                    width: `${widthPercent}%`
                                  }}
                                >
                                  {block.eventTypeId}
                                </div>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {!preview.loading && preview.error === null && preview.bundle === null && (
                    <p className="muted" style={{ fontSize: 11 }} data-testid="tae-preview-ok">
                      没有找到该模型的网格数据（chrbnd 内无 FLVER 网格）。
                    </p>
                  )}
                  {!preview.loading && preview.error === null && preview.bundle !== null && preview.bundle.meshCount === 0 && preview.bundle.boneCount > 0 && (
                    <p className="muted" style={{ fontSize: 11 }} data-testid="tae-preview-skeleton-note">
                      该模型为骨骼装配体（{preview.bundle.boneCount} bones）；没有找到可安全映射的 bd / am / lg 身体部件，当前显示骨架标记。这不代表存档当前装备。
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
                  {mergedDocument.diagnostics.length > 0 && !(isPartial && invalidRangeCount > 0) && (
                    <p className="muted" style={{ fontSize: 11 }} data-testid="tae-preview-diagnostics">
                      {mergedDocument.diagnostics.length} 条文档诊断。
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
