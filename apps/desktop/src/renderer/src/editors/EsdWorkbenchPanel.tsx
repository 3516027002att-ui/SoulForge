import { type ReactElement } from 'react';
import { formatListTruncation } from '../format/uiText.js';
import { ReadOnlyEntryWorkbench } from '../workbench/ReadOnlyEntryWorkbench.js';

/**
 * 状态组表渲染上限。ESD 是 V0.6 延期的只读预览族，不加分页控件（超出当前范围），
 * 但静默截断会让用户把部分状态组当成全部——搜索框已能定位具体 ID，说清即可。
 */
const STATE_GROUP_RENDER_LIMIT = 200;

export interface EsdStateGroupSummary {
  groupId: number;
  stateCount: number;
}

export interface EsdDocumentData {
  format: string;
  version: number;
  sourceSize: number;
  sourceHash: string;
  stateGroupCount: number;
  stateCount: number;
  conditionCount: number;
  commandCallCount: number;
  commandArgCount: number;
  commandBanks: number[];
  authority: string;
  stateGroups?: EsdStateGroupSummary[];
}

export interface EsdWorkbenchPanelProps {
  resourceUri: string;
  data: EsdDocumentData | null;
}

/**
 * ESD 状态机只读面板：显示状态组、条件和命令统计。
 */
export function EsdWorkbenchPanel(props: EsdWorkbenchPanelProps): ReactElement {
  const data = props.data;

  /*
   * 筛选与选中态已由 ReadOnlyEntryWorkbench 承担，这里只做上游截断。
   *
   * 保留 STATE_GROUP_RENDER_LIMIT 的理由：它限制的是**投影出多少条目**，
   * 与工作台内部的分页是两件事。去掉它会让极端语料一次性构造出全部条目对象。
   */
  const visibleGroups = (data?.stateGroups ?? []).slice(0, STATE_GROUP_RENDER_LIMIT);
  const filtered = data?.stateGroups ?? [];
  const truncationNote = formatListTruncation({
    total: filtered.length,
    shown: visibleGroups.length,
    noun: '个状态组',
    hint: '用搜索框按 ID 缩小范围'
  });

  /*
   * 改为通用只读工作台（左状态组 / 右属性）。
   *
   * 此前是纵向堆叠的 <table>，且行选择是裸 `<tr onClick>` —— 键盘完全不可达，
   * 而选中行才出现右侧详情，于是键盘用户根本看不到任何状态组的字段。
   * 现在走共用的 selectableRowAttributes（键盘契约由其单测锁定）。
   *
   * 截断说明保留 data-testid="esd-truncation"：test:esd-gap-visibility 断言它。
   * 通用工作台已内置分页，但截断说明说的是**上游数据**的截断
   * （stateGroups 只带回前 N 组），与分页无关，因此仍要显示。
   */
  const entries = visibleGroups.map((group) => ({
    id: String(group.groupId),
    label: `状态组 ${group.groupId}`,
    meta: `${group.stateCount} 状态`,
    properties: [
      ['State Group ID', String(group.groupId)],
      ['State Count', String(group.stateCount)]
    ] as Array<readonly [string, string]>
  }));

  return (
    <section className="panel" aria-label="ESD 状态机面板">
      {truncationNote && (
        <p className="muted" data-testid="esd-truncation">{truncationNote}</p>
      )}
      <ReadOnlyEntryWorkbench
        label="ESD 状态机工作台"
        kindLabel="ESD 状态机"
        entriesTitle="State Groups"
        filterPlaceholder="搜索状态组 ID…"
        deferredPreviewRelease="V0.6"
        entries={entries}
        emptyHint="选择 .esd 文件以查看状态机数据。"
        {...(data
          ? {
              summary: `${data.stateGroupCount} groups · ${data.stateCount} states`
                + ` · ${data.conditionCount} conds · ${data.authority}`,
              footer: (
                <span className="muted" style={{ fontSize: 11 }}>
                  命令 banks：{data.commandBanks?.join(', ') ?? '—'} ·
                  命令调用：{data.commandCallCount} ·
                  命令参数：{data.commandArgCount}
                </span>
              )
            }
          : {})}
      />
    </section>
  );
}
