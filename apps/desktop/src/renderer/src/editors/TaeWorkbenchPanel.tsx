/**
 * ANIMATION-56B / T3 / S17（2026-08-15）：动作工作台（grok T3/T17，对照 DSAS）。
 *
 * 三栏：`Animations | 词条 | 预览（只读）`，词条详情沉到三栏底 footer。
 *
 * ── S17 拍死的五件事 ──
 *
 * 1. 真拖栏：WorkbenchLayout 量宽按栏内容宽（不含 4px resizer），监听器用
 *    propsRef + 空依赖 useCallback 稳定；拖完仍可再拖，松手不弹回。
 * 2. 动画命名：hkxName 茎合法（ASCII 文件名）就用茎（a000_003013）；乱码/空/
 *    非文件名字符一律丢弃，回退 `a000_` + 至少 6 位 animId（a000_000600）。
 *    禁止「动画 N」、禁止乱码。C# 侧名字指针已修（fileInfo+0x10，UTF-16LE），
 *    这里只做显示层防御，不在 renderer 猜编码。
 * 3. 词条行：`{完整 typeId}  {类型名}`（`0 JumpTable`），类型名来自本机
 *    TAE.Template.SDT.xml（main 只读注入 eventTypeNames）；无模板名显示
 *    `{typeId} 未命名`。列表不显示秒。
 * 4. 详情下沉 footer：选中词条时三栏底下出现 起始帧/结束帧（主标签帧，可附
 *    ≈秒小字）、完整 typeId + 类型名、事件下标、全部参数字段（按模板解码；
 *    解不出写「未解码」+ 有界 hex，禁止编造字段含义）。时间编辑（update-
 *    event-times）留在 footer，输入用帧、提交内部秒。
 * 5. 右栏挂伴生 chrbnd 模型：overlay `chr/<id>.chrbnd.dcx` → 已挂载原版同样
 *    相对路径（原版只读）；有则 FlverViewer 只读预览，无则空态给下一步。
 *
 * ── 写回（ANIMATION-56C 保留，收进 footer）──
 *
 * footer 时间编辑经 preload 的 commitTaeEvent（write-tae-document）提交。
 * mutation 定位用 animId + 事件表下标；expectedDocumentHash 取读信封的
 * sourceHash。提交成功后经 readTaeDocument 重读并覆盖本地文档
 * （refreshedDocument）；失败展示 diagnostics + 回滚提示。提交期间禁用重复
 * 提交。写回不经过通用文本保存/字节直写，只有 commitTaeEvent 一个 typed 出口。
 * 右栏始终只读。
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
  type TaeTemplateFieldValue,
  type TaeTimelineEventRow
} from '@soulforge/shared';
import { formatListTruncation } from '../format/uiText.js';
import { isRowTabEntry, selectableRowAttributes } from '../a11y/selectableRow.js';
import { getRendererBridge } from '../runtime/rendererRuntime.js';
import { WorkbenchLayout } from '../workbench/WorkbenchLayout.js';
import { FlverViewer } from './FlverViewer.js';

/** 动画表渲染上限（上游数据截断；列表本身由布局栏滚动承载）。 */
const ANIMATION_RENDER_LIMIT = 200;
/** 词条事件渲染上限。 */
const EVENT_RENDER_LIMIT = 200;
/** 帧率换算（Sekiro 常见 30fps；frame = second × 30）。 */
const FRAME_RATE = 30;

/** 合法 hkx 茎（ASCII 文件名：字母/数字/下划线/连字符，不以符号开头）。 */
const HKX_STEM = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

export interface TaeWorkbenchPanelProps {
  resourceUri: string;
  data: TaeDocument | null;
  /**
   * S17：read-tae-document 附带的 DSAS 事件类型名表（`0 JumpTable` 的「类型名」）。
   * 只投影文档实际出现过的 eventTypeId；模板缺失时该 id 不在表里，回退「未命名」。
   */
  eventTypeNames?: Record<string, string> | null;
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

/** 时间编辑草稿（帧字符串输入态，提交时 /30 换秒）。 */
export interface TaeTimeDraft {
  startFrameText: string;
  endFrameText: string;
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
 * 动画 id 显示名（S17）：hkxName 茎合法（ASCII 文件名，a000_003013 风格）用茎；
 * 乱码/空/非文件名字符丢弃，回退 `a000_` + 至少 6 位 animId。禁止「动画 N」。
 */
export function animationIdLabel(animation: TaeAnimationWire): string {
  const raw = (animation.hkxName ?? '').replace(/\.(hkx|hkt)$/i, '').trim();
  if (raw && HKX_STEM.test(raw)) return raw;
  return `a000_${String(animation.animId).padStart(6, '0')}`;
}

/** 秒 → 帧（30fps）。非有限返回 '—'，不编造数值。 */
export function secondsToFrame(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * FRAME_RATE)) : '—';
}

/** 帧 → 秒（编辑提交用；内部仍以秒为 mutation 单位）。 */
export function framesToSeconds(frameText: string): number {
  const frame = Number(frameText);
  if (!Number.isFinite(frame)) return Number.NaN;
  return frame / FRAME_RATE;
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
 * 词条行标签：`{完整 typeId}  {类型名}`（`0 JumpTable`）。类型名来自本机
 * DSAS 模板（main 注入）；模板缺失显示 `{typeId} 未命名`，禁止编造 PlaySound。
 */
export function eventTypeLabel(
  eventTypeId: number,
  eventTypeNames?: Record<string, string> | null
): string {
  const name = eventTypeNames?.[String(eventTypeId)]?.trim();
  return name ? `${eventTypeId} ${name}` : `${eventTypeId} 未命名`;
}

/** 参数字段值格式化：bool 显式 true/false，数值原样，字符串直出。 */
export function formatFieldValue(field: TaeTemplateFieldValue): string {
  if (typeof field.value === 'boolean') return field.value ? 'true' : 'false';
  return String(field.value);
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
 * 把帧草稿解析成 update-event-times mutation（内部秒 = 帧 / 30fps）。
 * 帧非有限返回 null。startFrame > endFrame 不在这里拦截：时间编辑可能正用于
 * 修复现存非法范围，C# 侧对非有限/start>end/共享时间槽 fail-closed。
 */
export function buildUpdateEventTimesMutation(
  row: TaeTimelineEventRow,
  eventIndex: number,
  draft: TaeTimeDraft
): { mutation: 'update-event-times'; animId: number; eventIndex: number; startTime: number; endTime: number } | null {
  const startTime = framesToSeconds(draft.startFrameText);
  const endTime = framesToSeconds(draft.endFrameText);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return null;
  return { mutation: 'update-event-times', animId: row.animId, eventIndex, startTime, endTime };
}

/** 诊断列表 → 用户可见文案（空列表给兜底句，不吞失败）。 */
export function formatWriteDiagnostics(diagnostics: readonly Diagnostic[] | undefined): string {
  const list = diagnostics ?? [];
  if (list.length === 0) return '写入被拒绝';
  return list.map((diag) => `[${diag.code}] ${diag.message}`).join('；');
}

/**
 * footer 里的时间编辑区（update-event-times，S17 下沉）：输入用帧、提交内部秒。
 * 参数体未解码时不出现任何参数编辑控件。
 */
export interface TaeEventFooterEditorProps {
  row: TaeTimelineEventRow;
  /** 事件在所属动画 events 数组内的下标；undefined 时禁用提交。 */
  eventIndex: number | undefined;
  timeDraft: TaeTimeDraft | null;
  saving: boolean;
  notice: TaeWriteNotice | null;
  onTimeDraftChange: (draft: TaeTimeDraft) => void;
  onSubmitTime: () => void;
}

export function TaeEventFooterEditor(props: TaeEventFooterEditorProps): ReactElement {
  const { row, eventIndex, saving, notice } = props;
  const startText = props.timeDraft?.startFrameText ?? secondsToFrame(row.startTime);
  const endText = props.timeDraft?.endFrameText ?? secondsToFrame(row.endTime);

  return (
    <div className="tae-edit" data-testid="tae-event-editor">
      {notice && (
        <p className={notice.kind === 'error' ? 'diag-error' : 'muted'} data-testid="tae-write-notice">
          {notice.message}
        </p>
      )}
      {eventIndex === undefined && (
        <p className="wb-empty diag-error" data-testid="tae-event-index-missing">
          无法确定该事件在动画事件表中的下标，写回已禁用。
        </p>
      )}
      <div className="wb-list__group-label">编辑事件时间（update-event-times，内部秒）</div>
      <div className="wb-prop">
        <span className="wb-prop__name">起始帧</span>
        <span className="wb-prop__value">
          <input
            type="number"
            step="1"
            aria-label="新开始帧"
            value={startText}
            disabled={saving}
            onChange={(event) => props.onTimeDraftChange({ startFrameText: event.target.value, endFrameText: endText })}
          />
        </span>
      </div>
      <div className="wb-prop">
        <span className="wb-prop__name">结束帧</span>
        <span className="wb-prop__value">
          <input
            type="number"
            step="1"
            aria-label="新结束帧"
            value={endText}
            disabled={saving}
            onChange={(event) => props.onTimeDraftChange({ startFrameText: startText, endFrameText: event.target.value })}
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
    </div>
  );
}

/** chrbnd 伴生模型解析结果（S17）。 */
type ChrbndPreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'found'; chrbndSourceUri: string; origin: 'overlay' | 'base' }
  | { status: 'absent'; message: string };

export function TaeWorkbenchPanel(props: TaeWorkbenchPanelProps): ReactElement {
  const [selected, setSelected] = useState<TaeSelection | null>(props.initialSelection ?? null);
  /** 提交成功后本地重读的文档（优先于 props.data；换文件/App 重读时清空）。 */
  const [refreshedDocument, setRefreshedDocument] = useState<TaeDocument | null>(null);
  /** 选中事件的帧编辑草稿（null = 未编辑/未选中）。 */
  const [timeDraft, setTimeDraft] = useState<TaeTimeDraft | null>(null);
  /** 提交进行中：禁用重复提交。 */
  const [saving, setSaving] = useState(false);
  /** 最近一次写回结果提示（失败诊断/成功确认；跨选区清空）。 */
  const [writeNotice, setWriteNotice] = useState<TaeWriteNotice | null>(null);
  /** S17：伴生 chrbnd 模型解析状态（overlay → 已挂载原版，原版只读）。 */
  const [chrbndPreview, setChrbndPreview] = useState<ChrbndPreviewState>({ status: 'idle' });

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
      setWriteNotice(null);
    }
  }, [selected]);

  // S17：解析伴生 chrbnd（overlay → 已挂载原版）。动作文件不变时只解析一次。
  useEffect(() => {
    let cancelled = false;
    setChrbndPreview({ status: 'loading' });
    const bridge = getRendererBridge();
    if (!bridge || typeof bridge.resolveChrbndPreview !== 'function') {
      setChrbndPreview({ status: 'idle' });
      return;
    }
    void (async () => {
      try {
        const raw = await bridge.resolveChrbndPreview(props.resourceUri) as {
          ok?: boolean;
          origin?: 'overlay' | 'base';
          chrbndSourceUri?: string;
          message?: string;
        };
        if (cancelled) return;
        if (raw.ok && raw.chrbndSourceUri) {
          setChrbndPreview({
            status: 'found',
            chrbndSourceUri: raw.chrbndSourceUri,
            origin: raw.origin ?? 'base'
          });
        } else {
          setChrbndPreview({ status: 'absent', message: raw.message ?? '没有找到伴生模型（chrbnd）。' });
        }
      } catch {
        if (!cancelled) setChrbndPreview({ status: 'idle' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.resourceUri]);

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
      label: eventTypeLabel(event.eventTypeId, props.eventTypeNames),
      animationId: selectedAnimation.animId,
      eventIndex: index
    });
    setTimeDraft({
      startFrameText: secondsToFrame(event.startTime),
      endFrameText: secondsToFrame(event.endTime)
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

  /** 提交 update-event-times：选中事件的 animId + 事件表下标 + 新起止帧（内部秒）。 */
  async function submitTimeEdit(): Promise<void> {
    if (selected?.kind !== 'event' || !selectedEvent || selectedEventIndex === undefined) return;
    if (!timeDraft) return;
    const row: TaeTimelineEventRow = { animId: selected.animationId, ...selectedEvent };
    const mutation = buildUpdateEventTimesMutation(row, selectedEventIndex, timeDraft);
    if (!mutation) {
      setWriteNotice({ kind: 'error', message: '帧必须是有限数字。' });
      return;
    }
    await commitMutations([mutation], '事件时间已更新并重读验证。');
  }

  /** footer 详情：选中事件时出现（起始帧/结束帧/类型/下标/参数字段 + 时间编辑）。 */
  const footer = selected?.kind === 'event' && selectedEvent ? (
    <div className="tae-footer" data-testid="tae-event-footer">
      <div className="tae-footer__meta">
        <span>
          起始帧 <strong>{secondsToFrame(selectedEvent.startTime)}</strong>
          <small className="muted"> ≈ {formatTime(selectedEvent.startTime)}s @ {FRAME_RATE}fps</small>
        </span>
        <span>
          结束帧 <strong>{secondsToFrame(selectedEvent.endTime)}</strong>
          <small className="muted"> ≈ {formatTime(selectedEvent.endTime)}s @ {FRAME_RATE}fps</small>
        </span>
        <span>
          类型 <strong>{eventTypeLabel(selectedEvent.eventTypeId, props.eventTypeNames)}</strong>
        </span>
        <span className="muted">事件下标 {selectedEventIndex}</span>
        {isInvalidTimeRange(selectedEvent.startTime, selectedEvent.endTime) && (
          <span className="diag-error">时间范围非法</span>
        )}
      </div>
      <div className="tae-footer__fields" data-testid="tae-event-fields">
        <div className="wb-list__group-label">参数字段</div>
        {selectedEvent.templateFields && selectedEvent.parameterDecoded ? (
          <div className="wb-props">
            {selectedEvent.templateFields.map((field, fieldIndex) => (
              <div key={`${field.name}-${fieldIndex}`} className="wb-prop">
                <span className="wb-prop__name">{field.name}</span>
                <span className="wb-prop__value wb-prop__value--readonly">
                  {formatFieldValue(field)}
                  <small className="muted"> [{field.kind}]</small>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="wb-empty" data-testid="tae-fields-undecoded">
            参数体未解码
            {selectedEvent.parameterBytesHex
              ? `（hex 前 ${selectedEvent.parameterBytesHex.length / 2} 字节：${selectedEvent.parameterBytesHex}）`
              : '（无可用字节）'}
          </p>
        )}
      </div>
      <TaeEventFooterEditor
        row={{ animId: selected.animationId, ...selectedEvent }}
        eventIndex={selectedEventIndex}
        timeDraft={timeDraft}
        saving={saving}
        notice={writeNotice}
        onTimeDraftChange={(draft) => setTimeDraft(draft)}
        onSubmitTime={() => void submitTimeEdit()}
      />
    </div>
  ) : null;

  const previewContent = (() => {
    if (document === null) {
      return <p className="wb-empty">选择 .tae / .anibnd.dcx 文件后查看预览。</p>;
    }
    if (chrbndPreview.status === 'loading') {
      return <p className="wb-empty" data-testid="tae-chrbnd-loading">正在查找伴生模型（chrbnd）…</p>;
    }
    if (chrbndPreview.status === 'found') {
      return (
        <>
          <FlverViewer
            sourceUri={chrbndPreview.chrbndSourceUri}
            meshIndex={0}
          />
          <p className="muted" data-testid="tae-chrbnd-summary" style={{ fontSize: 11 }}>
            伴生模型（chrbnd）· {chrbndPreview.origin === 'overlay' ? 'mods 覆盖层' : '已挂载原版（只读）'}
            {selectedAnimation ? ` · 选中动画 ${animationIdLabel(selectedAnimation)}` : ''}
          </p>
        </>
      );
    }
    if (chrbndPreview.status === 'absent') {
      return (
        <p className="wb-empty" data-testid="tae-chrbnd-absent">
          {chrbndPreview.message}
        </p>
      );
    }
    return <p className="wb-empty" data-testid="tae-chrbnd-idle">模型预览不可用。</p>;
  })();

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
                      <span className="wb-row__meta">{animation.eventCount} 事件</span>
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
                        <span className="wb-row__name">
                          {eventTypeLabel(event.eventTypeId, props.eventTypeNames)}
                        </span>
                        <span className="wb-row__meta">
                          {secondsToFrame(event.startTime)} → {secondsToFrame(event.endTime)} 帧
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
              {previewContent}
              {document !== null && (
                <>
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
      footer={footer}
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
