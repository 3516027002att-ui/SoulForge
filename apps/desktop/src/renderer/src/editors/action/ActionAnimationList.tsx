import { useMemo, type ReactElement } from 'react';
import {
  actionAnimationIdentity,
  filterActionAnimations,
  type ActionAnimationGroup,
  type TaeAnimationWire
} from '@soulforge/shared';
import { isRowTabEntry, selectableRowAttributes } from '../../a11y/selectableRow.js';

export interface ActionAnimationListProps {
  animations: readonly TaeAnimationWire[];
  groups: readonly ActionAnimationGroup[];
  selectedBankKey: string;
  searchQuery: string;
  selectedAnimation?: TaeAnimationWire | undefined;
  selectedKind?: 'animation' | 'event' | undefined;
  expandedGroups: ReadonlySet<string>;
  animationLabel: (animation: TaeAnimationWire) => string;
  onBankChange: (key: string) => void;
  onSearchChange: (query: string) => void;
  onToggleGroup: (key: string) => void;
  onSelectAnimation: (animation: TaeAnimationWire) => void;
  animationsTruncated?: boolean;
  paginationLoading?: boolean;
  paginationNotice?: string | null;
  onLoadMore?: () => void;
}

function groupDomId(groupKey: string, index: number): string {
  const safeKey = groupKey.replace(/[^A-Za-z0-9_-]/g, '-');
  return `tae-animation-group-${index}-${safeKey}`;
}

/**
 * TAE-DX 风格动作目录：先按 a00/a50/a200 等动作族折叠，再在组内选择
 * 具体 animation。组是纯 UI 状态，行的 key 始终使用 native TAE identity。
 */
export function ActionAnimationList(props: ActionAnimationListProps): ReactElement {
  const view = useMemo(
    () => filterActionAnimations(props.animations, {
      bankKey: props.selectedBankKey,
      query: props.searchQuery
    }),
    [props.animations, props.selectedBankKey, props.searchQuery]
  );
  const selectedGroup = props.selectedBankKey === 'all'
    ? null
    : props.groups.find((group) => group.key === props.selectedBankKey) ?? null;
  const flattenedAnimations = view.animations;

  return (
    <div className="wb-list">
      <div className="tae-filter-bar">
        {props.groups.length > 1 && (
          <div className="tae-filter-row">
            <span className="tae-filter-label">分区:</span>
            <select
              data-testid="tae-bank-selector"
              className="tae-filter-select"
              value={props.selectedBankKey}
              onChange={(event) => props.onBankChange(event.target.value)}
            >
              <option value="all">全部分区 ({props.animations.length})</option>
              {props.groups.map((group) => (
                <option key={group.key} value={group.key}>
                  {group.label} ({group.animations.length})
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="tae-filter-row">
          <input
            type="text"
            data-testid="tae-anim-search"
            className="tae-filter-input"
            placeholder="搜索动作 (ID / 名称)..."
            value={props.searchQuery}
            onChange={(event) => props.onSearchChange(event.target.value)}
          />
        </div>
      </div>
      <div className="wb-list__group-label">
        {props.selectedBankKey === 'all' ? '动画' : `动画 · ${selectedGroup?.label ?? '当前分组'}`}
        {flattenedAnimations.length !== props.animations.length
          ? ` (${flattenedAnimations.length}/${props.animations.length})`
          : ''}
      </div>
      {view.groups.map((group, groupIndex) => {
        const id = groupDomId(group.key, groupIndex);
        const isExpanded = props.expandedGroups.has(group.key);
        return (
          <div key={group.key} className="tae-animation-group" data-tae-group-key={group.key}>
            <button
              type="button"
              className="tae-animation-group__header"
              data-testid={`tae-animation-group-toggle-${groupIndex}`}
              aria-expanded={isExpanded}
              aria-controls={id}
              onClick={() => props.onToggleGroup(group.key)}
            >
              <span className="tae-animation-group__chevron" aria-hidden="true">
                {isExpanded ? '▾' : '▸'}
              </span>
              <span className="tae-animation-group__label">{group.label}</span>
              <span className="tae-animation-group__count">{group.animations.length}</span>
            </button>
            <div
              id={id}
              className="tae-animation-group__rows"
              role="group"
              aria-label={`${group.label} 动作`}
              hidden={!isExpanded}
            >
              {group.animations.map((animation) => {
                const name = props.animationLabel(animation);
                const isSelected = props.selectedKind !== 'event'
                  && props.selectedKind === 'animation'
                  && props.selectedAnimation !== undefined
                  && actionAnimationIdentity(props.selectedAnimation) === actionAnimationIdentity(animation);
                const rowIndex = flattenedAnimations.indexOf(animation);
                return (
                  <div
                    key={actionAnimationIdentity(animation)}
                    className="wb-row"
                    {...selectableRowAttributes({
                      selected: isSelected,
                      isTabEntry: isRowTabEntry(rowIndex, props.selectedAnimation !== undefined),
                      onSelect: () => props.onSelectAnimation(animation)
                    })}
                    title={animation.hkxName ? name : String(animation.animId)}
                  >
                    <span className="wb-row__name" title={name}>{name}</span>
                    <span className="wb-row__meta">{`${animation.eventCount} 事件`}</span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      {flattenedAnimations.length === 0 && <p className="wb-empty">无匹配动画</p>}
      {props.animationsTruncated && (
        <div className="wb-list__group-label" data-testid="tae-animations-truncated">
          动画列表已截断（仍有未加载项）
        </div>
      )}
      {props.paginationNotice && (
        <p className="muted" style={{ fontSize: 11 }} data-testid="tae-pagination-notice">
          {props.paginationNotice}
        </p>
      )}
      {props.animationsTruncated && props.onLoadMore && (
        <button
          type="button"
          disabled={props.paginationLoading}
          onClick={props.onLoadMore}
          data-testid="tae-load-more"
        >
          {props.paginationLoading ? '加载中…' : '加载更多'}
        </button>
      )}
    </div>
  );
}

