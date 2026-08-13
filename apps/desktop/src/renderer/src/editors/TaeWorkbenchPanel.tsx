/**
 * ANIMATION-56B：Animation 工作台（§10.3）。
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
 * hitbox/SFX/VFX 参数」——缺 eventTypeId 逐类布局就不能开放 writer（ANIMATION-56C）。
 *
 * ── invalid time range ──
 *
 * 存在 startTime > endTime 或非有限时间时，C# 侧降 partial 并在 diagnostics 里给
 * TAE_INVALID_TIME_RANGE。本面板必须把 diagnostics 暴露给用户，并把非法时间行标记
 * 出来，不能把「读出来了」伪装成「完整解析」。
 */

import { useMemo, useState, type ReactElement } from 'react';
import {
  isTaeDocument,
  projectTaeDocumentPages,
  TAE_INVALID_TIME_RANGE,
  type TaeAnimationWire,
  type TaeDocument
} from '@soulforge/shared';
import { formatListTruncation } from '../format/uiText.js';
import { isRowTabEntry, selectableRowAttributes } from '../a11y/selectableRow.js';
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
}

type TaeSelectionKind = 'file' | 'animation' | 'timeline';

interface TaeSelection {
  kind: TaeSelectionKind;
  id: string;
  label: string;
  /** 选中动画的 animId（timeline 过滤用）。 */
  animationId?: number;
  /** 选中时间轴事件在 timeline 页全数组里的索引。 */
  timelineIndex?: number;
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

export function TaeWorkbenchPanel(props: TaeWorkbenchPanelProps): ReactElement {
  const [selected, setSelected] = useState<TaeSelection | null>(null);

  const document = useMemo(
    () => (props.data && isTaeDocument(props.data) ? props.data : null),
    [props.data]
  );
  const pages = useMemo(
    () => (document ? projectTaeDocumentPages(document) : null),
    [document]
  );

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
      timelineIndex: index
    });
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
        ['时间范围', isInvalidTimeRange(row.startTime, row.endTime) ? '非法（startTime > endTime）' : '合法']
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
        ['参数体', '未解码（能力边界，ANIMATION-56C 前不开放 writer）']
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
                  <p className="wb-empty">
                    TAE 写回链尚未接通（ANIMATION-56C），当前为只读工作台；
                    事件参数体未解码，不开放任何事件编辑入口。
                  </p>
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
