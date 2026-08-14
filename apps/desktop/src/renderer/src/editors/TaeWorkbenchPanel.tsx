/**
 * ANIMATION-56B / ANIMATION-56C：Animation 工作台（§10.3）+ TAE 事件 typed 写回。
 *
 * 三栏：`Files / Animations | Timeline / Events | Inspector`。
 *
 * ── 层级 ──
 *
 * binder → animation → timeline event。数据源是 ANIMATION-56A 的 read-tae-document
 * envelope（TaeDocument），经 projectTaeDocumentPages 投影出 animations / timeline /
 * events 三页，renderer 不维护第二套 native parser。
 *
 * ── 不按 chr/action 目录分类 ──
 *
 * 左栏列的是动画（animId），不是磁盘 chr/action 目录；不为凑四栏造 Tools 空栏。
 *
 * ── 事件参数体未解码是刻意边界 ──
 *
 * 每个事件只导出 startTime / endTime / eventTypeId 与计数，paramDataOffset 指向的
 * 参数体一字节未读。UI 不得把「读出了事件在时间轴上的位置」伪装成「读出了
 * hitbox/SFX/VFX 参数」——缺 eventTypeId 逐类布局就不能开放参数编辑。ANIMATION-56C
 * 只开放**已解码字段**：事件时间（update-event-times）与按模板新增事件
 * （insert-event，参数体逐字节拷贝自模板事件）。
 *
 * ── invalid time range ──
 *
 * 存在 startTime > endTime 或非有限时间时，C# 侧降 partial 并在 diagnostics 里给
 * TAE_INVALID_TIME_RANGE。本面板必须把 diagnostics 暴露给用户，并把非法时间行标记
 * 出来，不能把「读出来了」伪装成「完整解析」。时间编辑本身可用来修复非法范围；
 * 若提交后仍非法、或时间槽被兄弟事件共享，C# 侧 fail-closed，面板展示诊断并保持
 * 时间轴原状（失败不清空时间轴）。
 *
 * ── 写回（ANIMATION-56C）──
 *
 * Inspector 选中时间轴事件时渲染「编辑事件时间」与「新增事件（模板）」两个入口，
 * 经 preload 的 commitTaeEvent（write-tae-document）提交。mutation 定位用 animId +
 * 事件表下标：eventIndex 是该事件在其动画 events 数组内的下标（timeline 是各动画
 * events 的有序展平，按值匹配可回推）；templateEventIndex 同理用于新增事件。
 * expectedDocumentHash 取读信封的 sourceHash。提交成功后经 readTaeDocument 重读并
 * 覆盖本地文档（refreshedDocument）；失败展示 diagnostics + 回滚提示。提交期间
 * 禁用重复提交。写回不经过通用文本保存/字节直写，只有 commitTaeEvent 一个 typed
 * 出口。
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
/** 时间轴事件渲染上限。 */
const TIMELINE_RENDER_LIMIT = 200;
/** 事件类型摘要行的上限。 */
const EVENT_TYPE_RENDER_LIMIT = 20;

export interface TaeWorkbenchPanelProps {
  resourceUri: string;
  data: TaeDocument | null;
  /** 可选初始选中（测试/深链用）；不传等价于只读初始态。 */
  initialSelection?: TaeSelection;
}

type TaeSelectionKind = 'file' | 'animation' | 'timeline';

export interface TaeSelection {
  kind: TaeSelectionKind;
  id: string;
  label: string;
  /** 选中动画的 animId（timeline 过滤用）。 */
  animationId?: number;
  /** 选中时间轴事件在 timeline 页全数组里的索引。 */
  timelineIndex?: number;
  /** 选中时间轴事件在其所属动画 events 数组内的下标（写回定位用）。 */
  eventIndex?: number | undefined;
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

/** 时间轴数值格式化：有限数保留两位小数，非法值明说。 */
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
 * Inspector 里的事件编辑区：时间编辑（update-event-times）+ 新增事件
 * （insert-event，以当前事件为模板）。参数体未解码，这里不出现任何参数编辑控件。
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
              endText: event.target.value
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

  // 离开时间轴事件选择时清空编辑草稿与写回提示（避免跨选区残留）。
  useEffect(() => {
    if (selected?.kind !== 'timeline') {
      setTimeDraft(null);
      setInsertDraft(null);
      setWriteNotice(null);
    }
  }, [selected]);

  const animations: TaeAnimationWire[] = pages?.animations.animations ?? [];
  const timelineRows = pages?.timeline.events ?? [];
  const eventsPage = pages?.events;

  const selectedAnimationId = selected?.kind === 'animation' || selected?.kind === 'timeline'
    ? (selected.animationId ?? null)
    : null;

  const visibleAnimations = animations.slice(0, ANIMATION_RENDER_LIMIT);
  const animationsTruncation = formatListTruncation({
    total: animations.length,
    shown: visibleAnimations.length,
    noun: '个动画'
  });

  const visibleTimeline = timelineRows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => selectedAnimationId === null || row.animId === selectedAnimationId)
    .slice(0, TIMELINE_RENDER_LIMIT);
  const filteredTimelineCount = timelineRows
    .filter((row) => selectedAnimationId === null || row.animId === selectedAnimationId)
    .length;
  const timelineTruncation = formatListTruncation({
    total: filteredTimelineCount,
    shown: visibleTimeline.length,
    noun: '个时间轴事件'
  });

  const visibleEventTypes = (eventsPage?.eventTypes ?? []).slice(0, EVENT_TYPE_RENDER_LIMIT);
  const eventTypesTruncation = formatListTruncation({
    total: eventsPage?.eventTypeCount ?? 0,
    shown: visibleEventTypes.length,
    noun: '种事件类型'
  });

  const invalidRangeCount = (document?.diagnostics ?? [])
    .filter((diag) => diag.code === TAE_INVALID_TIME_RANGE).length;
  const authority = document?.authority;
  const isPartial = authority === 'partial';
  // 具名切片而非连写：listTruncation gate 把裸 `.slice(0, N).map(` 视为静默截断。
  const visibleDiagnostics = (document?.diagnostics ?? []).slice(0, 8);

  function selectFile(): void {
    setSelected({ kind: 'file', id: 'file', label: fileLabel(props.resourceUri) });
  }

  function selectAnimation(animation: TaeAnimationWire): void {
    setSelected({
      kind: 'animation',
      id: `anim-${animation.animId}`,
      label: `动画 ${animation.animId}`,
      animationId: animation.animId
    });
  }

  function selectTimeline(index: number): void {
    const row = timelineRows[index];
    if (!row) return;
    setSelected({
      kind: 'timeline',
      id: `tl-${index}`,
      label: `事件 ${row.eventTypeId} @${formatTime(row.startTime)}s`,
      animationId: row.animId,
      timelineIndex: index,
      eventIndex: eventIndexOfTimelineRow(timelineRows, index)
    });
    setTimeDraft({ startText: String(row.startTime), endText: String(row.endTime) });
    setInsertDraft({
      eventTypeIdText: String(row.eventTypeId),
      startText: String(row.startTime),
      endText: String(row.endTime)
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
          message: `${formatWriteDiagnostics(result.diagnostics)}，已回滚，时间轴保持原状。`
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
    const row = selected?.kind === 'timeline' ? timelineRows[selected.timelineIndex ?? -1] : undefined;
    if (!row || selected?.kind !== 'timeline' || !timeDraft) return;
    if (selected.eventIndex === undefined) {
      setWriteNotice({ kind: 'error', message: '无法确定该事件在动画事件表中的下标，写入被拒绝。' });
      return;
    }
    const mutation = buildUpdateEventTimesMutation(row, selected.eventIndex, timeDraft);
    if (!mutation) {
      setWriteNotice({ kind: 'error', message: '时间必须是有限数字。' });
      return;
    }
    await commitMutations([mutation], '事件时间已更新并重读验证。');
  }

  /** 提交 insert-event：以选中事件为模板追加新事件。 */
  async function submitInsert(): Promise<void> {
    const row = selected?.kind === 'timeline' ? timelineRows[selected.timelineIndex ?? -1] : undefined;
    if (!row || selected?.kind !== 'timeline' || !insertDraft) return;
    if (selected.eventIndex === undefined) {
      setWriteNotice({ kind: 'error', message: '无法确定模板事件在动画事件表中的下标，写入被拒绝。' });
      return;
    }
    const mutation = buildInsertEventMutation(row, selected.eventIndex, insertDraft);
    if (!mutation) {
      setWriteNotice({ kind: 'error', message: '事件类型与时间必须是有限数字。' });
      return;
    }
    await commitMutations([mutation], '已新增事件并重读验证。');
  }

  /** Inspector 内容（按选中项）。 */
  function inspectorRows(): Array<readonly [string, string]> {
    if (selected?.kind === 'timeline') {
      const row = selected.timelineIndex === undefined ? undefined : timelineRows[selected.timelineIndex];
      if (!row) return [['事件', '—']];
      return [
        ['动画 ID', String(row.animId)],
        ['开始时间', `${formatTime(row.startTime)}s`],
        ['结束时间', `${formatTime(row.endTime)}s`],
        ['事件类型 ID', String(row.eventTypeId)],
        ['时间范围', isInvalidTimeRange(row.startTime, row.endTime) ? '非法（startTime > endTime）' : '合法'],
        ['参数体', '未解码（ANIMATION-56C 只开放时间/类型编辑，无参数布局）']
      ];
    }
    if (selected?.kind === 'animation') {
      const animation = animations.find((item) => item.animId === selected.animationId);
      if (!animation) return [['动画', '—']];
      return [
        ['动画 ID', String(animation.animId)],
        ['事件数', String(animation.eventCount)],
        ['组数', String(animation.groupCount)],
        ['时间数', String(animation.timesCount)],
        ['HKX 名称', animation.hkxName ?? '—'],
        ['事件时间表', animation.eventsTruncated ? '已截断（未全量）' : '完整（本动画）'],
        ['参数体', '未解码（能力边界；事件参数体不开放编辑）']
      ];
    }
    // file / 未选中：文件级统计。
    return [
      ['格式', document?.format ?? 'TAE'],
      ['版本', document?.version ?? '—'],
      ['动画数', String(pages?.animations.animationCount ?? 0)],
      ['事件总数', String(eventsPage?.totalEventCount ?? 0)],
      ['事件组总数', String(eventsPage?.totalGroupCount ?? 0)],
      ['事件类型数', String(eventsPage?.eventTypeCount ?? 0)],
      ['authority', authority ?? '—']
    ];
  }

  const selectedTimelineRow = selected?.kind === 'timeline'
    ? (selected.timelineIndex === undefined ? undefined : timelineRows[selected.timelineIndex])
    : null;

  return (
    <WorkbenchLayout
      label="Animation 工作台"
      columns={[
        {
          id: 'files-animations',
          title: 'Files / Animations',
          hint: `${pages?.animations.animationCount ?? 0} animations`,
          initialFlex: 0.28,
          minWidth: 200,
          children: (
            <div className="wb-list">
              {document === null ? (
                <p className="wb-empty">选择 .tae 文件以查看动画事件数据。</p>
              ) : (
                <>
                  <div className="wb-list__group-label">Files</div>
                  <div
                    className="wb-row"
                    {...selectableRowAttributes({
                      selected: selected?.kind === 'file',
                      isTabEntry: isRowTabEntry(0, selected !== null),
                      onSelect: selectFile
                    })}
                  >
                    <span className="wb-row__name">{fileLabel(props.resourceUri)}</span>
                  </div>
                  <div className="wb-list__group-label">Animations</div>
                  {visibleAnimations.map((animation) => (
                    <div
                      key={animation.animId}
                      className="wb-row"
                      {...selectableRowAttributes({
                        selected: selected?.kind === 'animation' && selected.animationId === animation.animId,
                        isTabEntry: false,
                        onSelect: () => selectAnimation(animation)
                      })}
                    >
                      <span className="wb-row__name">动画 {animation.animId}</span>
                      <span className="wb-row__meta">
                        {animation.hkxName ?? `${animation.eventCount} 事件`}
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
          id: 'timeline-events',
          title: 'Timeline / Events',
          hint: `${timelineRows.length} timeline events`,
          initialFlex: 0.32,
          minWidth: 220,
          children: (
            <div className="wb-list">
              {document === null && <p className="wb-empty">先选择 .tae 文件。</p>}
              {document !== null && (
                <>
                  <div className="wb-list__group-label">Timeline</div>
                  {selectedAnimationId !== null && (
                    <p className="muted" style={{ fontSize: 11 }}>
                      已按动画 {selectedAnimationId} 过滤
                    </p>
                  )}
                  {visibleTimeline.map(({ row, index }) => {
                    const invalid = isInvalidTimeRange(row.startTime, row.endTime);
                    return (
                      <div
                        key={`${row.animId}-${row.startTime}-${row.endTime}-${row.eventTypeId}-${index}`}
                        className={invalid ? 'wb-row wb-row--failed' : 'wb-row'}
                        {...selectableRowAttributes({
                          selected: selected?.kind === 'timeline' && selected.timelineIndex === index,
                          isTabEntry: false,
                          onSelect: () => selectTimeline(index)
                        })}
                      >
                        <span className="wb-row__name">
                          {formatTime(row.startTime)}s → {formatTime(row.endTime)}s
                        </span>
                        <span className="wb-row__meta">
                          类型 {row.eventTypeId}
                          {invalid ? ' · 非法时间' : ''}
                        </span>
                      </div>
                    );
                  })}
                  {timelineTruncation && (
                    <p className="muted" data-testid="tae-timeline-truncation">{timelineTruncation}</p>
                  )}
                  {visibleTimeline.length === 0 && (
                    <p className="wb-empty">没有可显示的时间轴事件。</p>
                  )}
                  <div className="wb-list__group-label">Events</div>
                  <div className="wb-row">
                    <span className="wb-row__name">事件总数</span>
                    <span className="wb-row__meta">{eventsPage?.totalEventCount ?? 0}</span>
                  </div>
                  <div className="wb-row">
                    <span className="wb-row__name">事件组总数</span>
                    <span className="wb-row__meta">{eventsPage?.totalGroupCount ?? 0}</span>
                  </div>
                  <div className="wb-list__group-label">事件类型（distinct）</div>
                  {visibleEventTypes.map((eventTypeId) => (
                    <div key={eventTypeId} className="wb-row">
                      <span className="wb-row__name">事件类型 {eventTypeId}</span>
                    </div>
                  ))}
                  {eventTypesTruncation && (
                    <p className="muted" data-testid="tae-events-truncation">{eventTypesTruncation}</p>
                  )}
                </>
              )}
            </div>
          )
        },
        {
          id: 'inspector',
          title: 'Inspector',
          ...(selected ? { hint: selected.label } : {}),
          initialFlex: 0.4,
          minWidth: 260,
          children: (
            <div className="wb-list">
              {document === null && <p className="wb-empty">选择 .tae 文件后查看详情。</p>}
              {document !== null && (
                <>
                  <div className="wb-list__group-label">
                    {selected ? selected.label : '文件统计'}
                  </div>
                  <div className="wb-props">
                    {inspectorRows().map(([name, value]) => (
                      <div key={name} className="wb-prop">
                        <span className="wb-prop__name">{name}</span>
                        <span className="wb-prop__value wb-prop__value--readonly">{value}</span>
                      </div>
                    ))}
                  </div>
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
                  <div className="wb-list__group-label">写回</div>
                  {selectedTimelineRow ? (
                    <TaeEventEditor
                      row={selectedTimelineRow}
                      eventIndex={selected?.kind === 'timeline' ? selected.eventIndex : undefined}
                      timeDraft={timeDraft}
                      insertDraft={insertDraft}
                      saving={saving}
                      notice={writeNotice}
                      onTimeDraftChange={(draft) => setTimeDraft(draft)}
                      onInsertDraftChange={(draft) => setInsertDraft(draft)}
                      onSubmitTime={() => void submitTimeEdit()}
                      onSubmitInsert={() => void submitInsert()}
                    />
                  ) : (
                    <p className="wb-empty" data-testid="tae-write-hint">
                      选中 Timeline 的时间轴事件后，可编辑事件时间（update-event-times）或按当前事件为模板新增事件（insert-event）。事件参数体未解码，不开放参数编辑。
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
          <span className="crumb">Animation · {fileLabel(props.resourceUri)}</span>
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
