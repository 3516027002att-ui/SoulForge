/**
 * ANIMATION-56B / T3（2026-08-15）：动作工作台（grok T3，对照 DSAS）。
 *
 * 三栏：`Animations | 词条 + 详情 | 预览（只读）`。
 *
 * ── T3 重构（行为 + 动画合并为「动作」）──
 *
 * 左栏列动画 id（hkxName 去扩展，如 a000_003013；无 hkxName 用「动画 N」）。
 * 中栏列当前动画的词条事件列表——envelope 只有 eventTypeId 与起止时间，词条文本名
 * （PlaySound_ByStateInfo 等）当前未解码，诚实显示「事件类型 N」；选中后在中栏下方
 * 详情列出 Start Frame / End Frame / Id 与能解出的全部字段；解不出的字段写
 * 「未解码」+ 原始数值，禁止编造 SoundType 含义。右栏是只读 3D 预览：TAE/anibnd
 * 不是模型文件，本夜不挂伴生 chrbnd 的 FLVER，诚实空态「预览不可用」+ 文档诊断。
 * 不要时间轴图、不要 Inspector 第三栏（详情收进中栏）、不要 64 KiB 条。
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
 * 中栏详情在选中事件时保留「编辑事件时间」与「新增事件（模板）」两个入口，经
 * preload 的 commitTaeEvent（write-tae-document）提交。mutation 定位用 animId +
 * 事件表下标：eventIndex 是选中事件在其动画 events 数组内的下标（中栏词条列表
 * 就是该动画的 events，下标直接可回推）；templateEventIndex 同理用于新增事件。
 * expectedDocumentHash 取读信封的 sourceHash。提交成功后经 readTaeDocument 重读
 * 并覆盖本地文档（refreshedDocument）；失败展示 diagnostics + 回滚提示。提交期间
 * 禁用重复提交。写回不经过通用文本保存/字节直写，只有 commitTaeEvent 一个 typed
 * 出口。右栏始终只读。
 *
 * ── invalid time range ──
 *
 * 存在 startTime > endTime 或非有限时间时，C# 侧降 partial 并在 diagnostics 里给
 * TAE_INVALID_TIME_RANGE。面板必须把 diagnostics 暴露给用户，并把非法时间行标记
 * 出来；时间编辑本身可用来修复非法范围。提交后仍非法、或时间槽被兄弟事件共享时
 * C# 侧 fail-closed，面板展示诊断并保持事件表原状（失败不清空）。
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  isTaeDocument,
  projectTaeDocumentPages,
  TAE_INVALID_TIME_RANGE,
  type Diagnostic,
  type TaeAnimationWire,
  type TaeDocument,
  type TaeTimelineEventRow
} from '@soulforge/shared';
import { formatListTruncation } from '../format/uiText.js';
import { isRowTabEntry, selectableRowAttributes } from '../a11y/selectableRow.js';
import { getRendererBridge } from '../runtime/rendererRuntime.js';
import { WorkbenchLayout } from '../workbench/WorkbenchLayout.js';

/** 动画表渲染上限（上游数据截断；列表本身由布局栏滚动承载）。 */
const ANIMATION_RENDER_LIMIT = 200;
/** 词条事件渲染上限。 */
const EVENT_RENDER_LIMIT = 200;
/** 帧率换算（Sekiro 常见 30fps；frame = second × 30）。 */
const FRAME_RATE = 30;

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

/** 时间编辑草稿（字符串输入态，提交时再解析为 number）。 */
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

/** 动画 id 显示名：hkxName 去扩展（a000_003013.hkx → a000_003013）；缺省用「动画 N」。 */
export function animationIdLabel(animation: TaeAnimationWire): string {
  const base = (animation.hkxName ?? '').replace(/\.hkx$/i, '');
  return base || `动画 ${animation.animId}`;
}

/** 秒 → 帧（30fps）。非有限返回 '—'，不编造数值。 */
export function secondsToFrame(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * FRAME_RATE)) : '—';
}

/** 时间数值格式化：有限数保留两位小数，非法值明说。 */
function formatTime(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '非法';
}

/** 时间范围非法：startTime > endTime 或任一非有限。 */
export function isInvalidTimeRange(startTime: number, endTime: number): boolean {
  return !Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime > endTime;
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
 * 把时间编辑草稿解析成 update-event-times mutation；时间非法（非有限）返回 null。
 * startTime > endTime 不在这里拦截：时间编辑可能正用于修复现存非法范围，C# 侧
 * 对非有限/start>end/共享时间槽 fail-closed，失败由提交诊断回显。
 */
export function buildUpdateEventTimesMutation(
  row: TaeTimelineEventRow,
  eventIndex: number,
  draft: TaeTimeDraft
): { mutation: 'update-event-times'; animId: number; eventIndex: number; startTime: number; endTime: number } | null {
  const startTime = Number(draft.startText);
  const endTime = Number(draft.endText);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return null;
  return { mutation: 'update-event-times', animId: row.animId, eventIndex, startTime, endTime };
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
export interface TaeEventEditorProps {
  row: TaeTimelineEventRow;
  /** 事件在所属动画 events 数组内的下标；undefined 时禁用提交。 */
  eventIndex: number | undefined;
  timeDraft: TaeTimeDraft | null;
  insertDraft: TaeInsertDraft | null;
  saving: boolean;
  notice: TaeWriteNotice | null;
  onTimeDraftChange: (draft: TaeTimeDraft) => void;
  onInsertDraftChange: (draft: TaeInsertDraft) => void;
  onSubmitTime: () => void;
  onSubmitInsert: () => void;
}

export function TaeEventEditor(props: TaeEventEditorProps): ReactElement {
  const { row, eventIndex, saving, notice } = props;
  const startText = props.timeDraft?.startText ?? String(row.startTime);
  const endText = props.timeDraft?.endText ?? String(row.endTime);
  const insertTypeText = props.insertDraft?.eventTypeIdText ?? String(row.eventTypeId);
  const insertStartText = props.insertDraft?.startText ?? String(row.startTime);
  const insertEndText = props.insertDraft?.endText ?? String(row.endTime);

  return (
    <div className="tae-edit" data-testid="tae-event-editor">
      {notice && (
        <p className={notice.kind === 'error' ? 'diag-error' : 'muted'} data-testid="tae-write-notice">
          {notice.message}
        </p>
      )}
      <div className="wb-list__group-label">编辑事件时间（update-event-times）</div>
      {eventIndex === undefined && (
        <p className="wb-empty diag-error" data-testid="tae-event-index-missing">
          无法确定该事件在动画事件表中的下标，写回已禁用。
        </p>
      )}
      <div className="wb-prop">
        <span className="wb-prop__name">起始时间</span>
        <span className="wb-prop__value">
          <input
            type="number"
            step="any"
            aria-label="新开始时间"
            value={startText}
            disabled={saving}
            onChange={(event) => props.onTimeDraftChange({ startText: event.target.value, endText })}
          />
        </span>
      </div>
      <div className="wb-prop">
        <span className="wb-prop__name">结束时间</span>
        <span className="wb-prop__value">
          <input
            type="number"
            step="any"
            aria-label="新结束时间"
            value={endText}
            disabled={saving}
            onChange={(event) => props.onTimeDraftChange({ startText, endText: event.target.value })}
          />
        </span>
      </div>
      <div className="wb-prop">
        <span className="wb-prop__name" />
        <span className="wb-prop__value">
          <button type="button" disabled={saving || eventIndex === undefined} onClick={props.onSubmitTime}>
            更新事件时间
          </button>
        </span>
      </div>
      <div className="wb-list__group-label">新增事件（模板：当前事件）</div>
      <p className="muted" style={{ fontSize: 11 }}>
        新增事件的参数区从模板事件逐字节拷贝；事件类型与模板不一致会被 C# 侧拒绝。
      </p>
      <div className="wb-prop">
        <span className="wb-prop__name">类型 ID</span>
        <span className="wb-prop__value">
          <input
            type="number"
            step="1"
            aria-label="新事件类型 ID"
            value={insertTypeText}
            disabled={saving}
            onChange={(event) => props.onInsertDraftChange({
              eventTypeIdText: event.target.value,
              startText: insertStartText,
              endText: insertEndText
            })}
          />
        </span>
      </div>
      <div className="wb-prop">
        <span className="wb-prop__name">起始时间</span>
        <span className="wb-prop__value">
          <input
            type="number"
            step="any"
            aria-label="新事件开始时间"
            value={insertStartText}
            disabled={saving}
            onChange={(event) => props.onInsertDraftChange({
              eventTypeIdText: insertTypeText,
              startText: event.target.value,
              endText: insertEndText
            })}
          />
        </span>
      </div>
      <div className="wb-prop">
        <span className="wb-prop__name">结束时间</span>
        <span className="wb-prop__value">
          <input
            type="number"
            step="any"
            aria-label="新事件结束时间"
            value={insertEndText}
            disabled={saving}
            onChange={(event) => props.onInsertDraftChange({
              eventTypeIdText: insertTypeText,
              startText: insertStartText,
              endText: insertEndText
            })}
          />
        </span>
      </div>
      <div className="wb-prop">
        <span className="wb-prop__name" />
        <span className="wb-prop__value">
          <button type="button" disabled={saving || eventIndex === undefined} onClick={props.onSubmitInsert}>
            新增事件
          </button>
        </span>
      </div>
    </div>
  );
}

/** 中栏详情区：文件/动画/事件级统计明细 + 事件写回（ANIMATION-56C）。 */
function DetailsSection(props: {
  selected: TaeSelection | null;
  document: TaeDocument | null;
  pages: ReturnType<typeof projectTaeDocumentPages> | null;
  selectedAnimation: TaeAnimationWire | undefined;
  selectedAnimationEvents: TaeAnimationWire['events'];
  selectedEvent: TaeTimelineEventRow | undefined;
  selectedEventIndex: number | undefined;
  timeDraft: TaeTimeDraft | null;
  insertDraft: TaeInsertDraft | null;
  saving: boolean;
  writeNotice: TaeWriteNotice | null;
  onTimeDraftChange: (draft: TaeTimeDraft) => void;
  onInsertDraftChange: (draft: TaeInsertDraft) => void;
  onSubmitTime: () => void;
  onSubmitInsert: () => void;
}): ReactElement {
  const { selected, document } = props;
  if (document === null) return <p className="wb-empty">选择 .tae / .anibnd.dcx 文件后查看详情。</p>;

  const rows: Array<readonly [string, string]> = (() => {
    if (selected?.kind === 'event' && props.selectedEvent) {
      const event = props.selectedEvent;
      return [
        ['Start Frame', `${secondsToFrame(event.startTime)}（≈ ${formatTime(event.startTime)}s @ ${FRAME_RATE}fps）`],
        ['End Frame', `${secondsToFrame(event.endTime)}（≈ ${formatTime(event.endTime)}s @ ${FRAME_RATE}fps）`],
        ['动画 Id', String(selected.animationId)],
        ['事件下标', String(props.selectedEventIndex)],
        ['事件类型 Id', String(event.eventTypeId)],
        ['时间范围', isInvalidTimeRange(event.startTime, event.endTime) ? '非法（startTime > endTime）' : '合法'],
        ['参数体', '未解码（envelope 只有类型与起止时间；无词条文本与参数布局）'],
        ['原始值', `start=${formatTime(event.startTime)} end=${formatTime(event.endTime)} typeId=${event.eventTypeId}`]
      ];
    }
    if (selected?.kind === 'animation' && props.selectedAnimation) {
      const anim = props.selectedAnimation;
      return [
        ['动画 Id', String(anim.animId)],
        ['事件数', String(anim.eventCount)],
        ['组数', String(anim.groupCount)],
        ['时间数', String(anim.timesCount)],
        ['HKX 名称', anim.hkxName ?? '—'],
        ['事件时间表', anim.eventsTruncated ? '已截断（未全量）' : '完整（本动画）'],
        ['参数体', '未解码（能力边界；事件参数体不开放编辑）']
      ];
    }
    return [
      ['格式', document.format ?? 'TAE'],
      ['版本', document.version ?? '—'],
      ['动画数', String(props.pages?.animations.animationCount ?? 0)],
      ['事件总数', String(props.pages?.events.totalEventCount ?? 0)],
      ['事件组总数', String(props.pages?.events.totalGroupCount ?? 0)],
      ['事件类型数', String(props.pages?.events.eventTypeCount ?? 0)],
      ['authority', document.authority ?? '—']
    ];
  })();

  const detailTitle = selected?.kind === 'event'
    ? (selected.label ?? '事件详情')
    : selected?.kind === 'animation'
      ? '动画详情'
      : '文件统计';

  return (
    <div className="wb-list" data-testid="tae-details">
      <div className="wb-list__group-label">{detailTitle}</div>
      <div className="wb-props">
        {rows.map(([name, value]) => (
          <div key={name} className="wb-prop">
            <span className="wb-prop__name">{name}</span>
            <span className="wb-prop__value wb-prop__value--readonly">{value}</span>
          </div>
        ))}
      </div>
      {selected?.kind === 'event' && props.selectedEvent ? (
        <TaeEventEditor
          row={{ animId: selected.animationId, ...props.selectedEvent }}
          eventIndex={props.selectedEventIndex}
          timeDraft={props.timeDraft}
          insertDraft={props.insertDraft}
          saving={props.saving}
          notice={props.writeNotice}
          onTimeDraftChange={props.onTimeDraftChange}
          onInsertDraftChange={props.onInsertDraftChange}
          onSubmitTime={props.onSubmitTime}
          onSubmitInsert={props.onSubmitInsert}
        />
      ) : (
        <p className="wb-empty" data-testid="tae-write-hint">
          {selected?.kind === 'animation'
            ? '选中词条事件后，可编辑事件时间（update-event-times）或按当前事件为模板新增事件（insert-event）。事件参数体未解码，不开放参数编辑。'
            : '左栏选动画、中栏选词条事件后，可编辑事件时间或按模板新增事件。'}
        </p>
      )}
    </div>
  );
}

export function TaeWorkbenchPanel(props: TaeWorkbenchPanelProps): ReactElement {
  const [selected, setSelected] = useState<TaeSelection | null>(props.initialSelection ?? null);
  /** 提交成功后本地重读的文档（优先于 props.data；换文件/App 重读时清空）。 */
  const [refreshedDocument, setRefreshedDocument] = useState<TaeDocument | null>(null);
  /** 选中事件的时间编辑草稿（null = 未编辑/未选中）。 */
  const [timeDraft, setTimeDraft] = useState<TaeTimeDraft | null>(null);
  /** 选中事件的新增事件草稿。 */
  const [insertDraft, setInsertDraft] = useState<TaeInsertDraft | null>(null);
  /** 提交进行中：禁用重复提交。 */
  const [saving, setSaving] = useState(false);
  /** 最近一次写回结果提示（失败诊断/成功确认；跨选区清空）。 */
  const [writeNotice, setWriteNotice] = useState<TaeWriteNotice | null>(null);

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
  }, [props.resourceUri, props.data]);

  // 离开事件选择时清空编辑草稿与写回提示（避免跨选区残留）。
  useEffect(() => {
    if (selected?.kind !== 'event') {
      setTimeDraft(null);
      setInsertDraft(null);
      setWriteNotice(null);
    }
  }, [selected]);

  const animations: TaeAnimationWire[] = pages?.animations.animations ?? [];
  const eventsPage = pages?.events;

  const selectedAnimation = selected?.kind === 'animation' || selected?.kind === 'event'
    ? animations.find((animation) => animation.animId === selected.animationId)
    : undefined;
  const selectedAnimationEvents = selectedAnimation?.events ?? [];

  const visibleAnimations = animations.slice(0, ANIMATION_RENDER_LIMIT);
  const animationsTruncation = formatListTruncation({
    total: animations.length,
    shown: visibleAnimations.length,
    noun: '个动画'
  });

  const visibleEvents = selectedAnimationEvents.slice(0, EVENT_RENDER_LIMIT);
  const eventsTruncation = formatListTruncation({
    total: selectedAnimationEvents.length,
    shown: visibleEvents.length,
    noun: '个词条事件'
  });

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

  function selectEvent(index: number): void {
    const event = selectedAnimationEvents[index];
    if (!event || !selectedAnimation) return;
    setSelected({
      kind: 'event',
      id: `ev-${selectedAnimation.animId}-${index}`,
      label: `事件类型 ${event.eventTypeId} @${formatTime(event.startTime)}s`,
      animationId: selectedAnimation.animId,
      eventIndex: index
    });
    setTimeDraft({ startText: String(event.startTime), endText: String(event.endTime) });
    setInsertDraft({
      eventTypeIdText: String(event.eventTypeId),
      startText: String(event.startTime),
      endText: String(event.endTime)
    });
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

  /** 提交 insert-event：以选中事件为模板追加新事件。 */
  async function submitInsert(): Promise<void> {
    if (selected?.kind !== 'event' || !selectedEvent || selectedEventIndex === undefined) return;
    if (!insertDraft) return;
    const row: TaeTimelineEventRow = { animId: selected.animationId, ...selectedEvent };
    const mutation = buildInsertEventMutation(row, selectedEventIndex, insertDraft);
    if (!mutation) {
      setWriteNotice({ kind: 'error', message: '事件类型与时间必须是有限数字。' });
      return;
    }
    await commitMutations([mutation], '已新增事件并重读验证。');
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
          minWidth: 200,
          children: (
            <div className="wb-list">
              {document === null ? (
                <p className="wb-empty">选择 .tae / .anibnd.dcx 文件以查看动画事件数据。</p>
              ) : (
                <>
                  <div className="wb-list__group-label">动画</div>
                  {visibleAnimations.map((animation) => (
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
                    >
                      <span className="wb-row__name">{animationIdLabel(animation)}</span>
                      <span className="wb-row__meta">
                        {animation.hkxName ? `id ${animation.animId}` : `${animation.eventCount} 事件`}
                      </span>
                    </div>
                  ))}
                  {animationsTruncation && (
                    <p className="muted" data-testid="tae-truncation">{animationsTruncation}</p>
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
                  {visibleEvents.map((event, index) => {
                    const invalid = isInvalidTimeRange(event.startTime, event.endTime);
                    return (
                      <div
                        key={`${selectedAnimation.animId}-${index}`}
                        className={invalid ? 'wb-row wb-row--failed' : 'wb-row'}
                        {...selectableRowAttributes({
                          selected: selected?.kind === 'event' && selected.eventIndex === index,
                          isTabEntry: false,
                          onSelect: () => selectEvent(index)
                        })}
                      >
                        <span className="wb-row__name">事件类型 {event.eventTypeId}</span>
                        <span className="wb-row__meta">
                          {formatTime(event.startTime)}s → {formatTime(event.endTime)}s
                          {invalid ? ' · 非法时间' : ''}
                        </span>
                      </div>
                    );
                  })}
                  {eventsTruncation && (
                    <p className="muted" data-testid="tae-events-truncation">{eventsTruncation}</p>
                  )}
                  {visibleEvents.length === 0 && (
                    <p className="wb-empty">该动画没有可显示的词条事件。</p>
                  )}
                </>
              )}
              {/* 中栏下方：选中后详情 + 写回（T3：详情收进中栏，无 Inspector 第三栏）。 */}
              <div className="wb-list__group-label">详情</div>
              <DetailsSection
                selected={selected}
                document={document}
                pages={pages}
                selectedAnimation={selectedAnimation}
                selectedAnimationEvents={selectedAnimationEvents}
                selectedEvent={selectedEvent}
                selectedEventIndex={selectedEventIndex}
                timeDraft={timeDraft}
                insertDraft={insertDraft}
                saving={saving}
                writeNotice={writeNotice}
                onTimeDraftChange={(draft) => setTimeDraft(draft)}
                onInsertDraftChange={(draft) => setInsertDraft(draft)}
                onSubmitTime={() => void submitTimeEdit()}
                onSubmitInsert={() => void submitInsert()}
              />
            </div>
          )
        },
        {
          id: 'preview',
          title: '预览（只读）',
          initialFlex: 0.34,
          minWidth: 220,
          children: (
            <div className="wb-list">
              {document === null && <p className="wb-empty">选择 .tae / .anibnd.dcx 文件后查看预览。</p>}
              {document !== null && (
                <>
                  <p className="wb-empty" data-testid="tae-preview-unavailable">
                    预览不可用
                  </p>
                  <p className="muted" style={{ fontSize: 11 }}>
                    TAE / anibnd 是动作数据文件，不是模型；本夜不挂伴生 chrbnd 的 FLVER 预览。
                  </p>
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
                      {document.diagnostics.length} 条文档诊断（见底部日志）。
                    </p>
                  )}
                </>
              )}
            </div>
          )
        }
      ]}
      toolbar={
        <>
          <span className="crumb">动作 · {fileLabel(props.resourceUri)}</span>
          {document && (
            <span className="muted" style={{ fontSize: 11 }}>
              {pages?.animations.animationCount ?? 0} anims · {eventsPage?.totalEventCount ?? 0} events · {authority}
            </span>
          )}
        </>
      }
    />
  );
}
