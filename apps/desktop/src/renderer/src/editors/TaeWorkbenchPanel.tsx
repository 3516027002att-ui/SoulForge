import { type ReactElement } from 'react';
import { formatListTruncation } from '../format/uiText.js';
import { ReadOnlyEntryWorkbench } from '../workbench/ReadOnlyEntryWorkbench.js';

/**
 * 动画表渲染上限。TAE 是 V0.6 延期的只读预览族，不加分页控件（超出当前范围），
 * 但静默截断会让用户把部分动画当成全部——搜索框已能定位具体 ID / HKX。
 */
const ANIMATION_RENDER_LIMIT = 200;

/** 事件类型摘要行的上限。此前已报总数，但没报「未显示多少」。 */
const EVENT_TYPE_RENDER_LIMIT = 20;

export interface TaeAnimationSummary {
  animId: number;
  eventCount: number;
  groupCount: number;
  timesCount: number;
  hkxName?: string;
}

export interface TaeDocumentData {
  format: string;
  version: number;
  sourceSize: number;
  sourceHash: string;
  animationCount: number;
  totalEventCount: number;
  totalGroupCount: number;
  eventTypes: number[];
  authority: string;
  animations?: TaeAnimationSummary[];
}

export interface TaeWorkbenchPanelProps {
  resourceUri: string;
  data: TaeDocumentData | null;
}

/**
 * TAE 动画事件只读面板：显示动画列表、事件类型和统计信息。
 */
export function TaeWorkbenchPanel(props: TaeWorkbenchPanelProps): ReactElement {
  const data = props.data;

  /*
   * 筛选与选中态已由 ReadOnlyEntryWorkbench 承担；这里只做上游截断。
   * ANIMATION_RENDER_LIMIT 限制的是投影出多少条目对象，与工作台内部分页不同。
   */
  const visibleAnimations = (data?.animations ?? []).slice(0, ANIMATION_RENDER_LIMIT);
  const filtered = data?.animations ?? [];
  const truncationNote = formatListTruncation({
    total: filtered.length,
    shown: visibleAnimations.length,
    noun: '个动画',
    hint: '用搜索框按动画 ID 或 HKX 名称缩小范围'
  });

  const entries = visibleAnimations.map((anim) => ({
    id: String(anim.animId),
    label: `动画 ${anim.animId}`,
    meta: anim.hkxName ?? `${anim.eventCount} 事件`,
    properties: [
      ['Animation ID', String(anim.animId)],
      ['Event Count', String(anim.eventCount)],
      ['Group Count', String(anim.groupCount)],
      ['Times Count', String(anim.timesCount)],
      ['HKX Name', anim.hkxName ?? '']
    ] as Array<readonly [string, string]>
  }));

  return (
    <section className="panel" aria-label="TAE 动画事件面板">
      {truncationNote && (
        <p className="muted" data-testid="tae-truncation">{truncationNote}</p>
      )}
      <ReadOnlyEntryWorkbench
        label="TAE 动画事件工作台"
        kindLabel="TAE 动画事件"
        entriesTitle="Animations"
        filterPlaceholder="搜索动画 ID 或 HKX 名称…"
        deferredPreviewRelease="V0.6"
        entries={entries}
        emptyHint="选择 .tae 文件以查看动画事件数据。"
        {...(data
          ? {
              summary: `${data.animationCount} anims · ${data.totalEventCount} events · ${data.authority}`,
              footer: (
                <span className="muted" style={{ fontSize: 11 }}>
                  事件类型：{data.eventTypes?.slice(0, EVENT_TYPE_RENDER_LIMIT).join(', ')}
                  {(data.eventTypes?.length ?? 0) > EVENT_TYPE_RENDER_LIMIT
                    ? ` …共 ${data.eventTypes.length} 种，未显示 ${data.eventTypes.length - EVENT_TYPE_RENDER_LIMIT} 种`
                    : ''}
                </span>
              )
            }
          : {})}
      />
    </section>
  );
}
