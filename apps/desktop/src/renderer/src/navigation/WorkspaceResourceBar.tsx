import { useRef, type KeyboardEvent, type ReactElement } from 'react';
import type { ResourceKind } from '@soulforge/shared';
import { RESOURCE_FAMILIES, type ResourceMode } from './resourceFamilies.js';

export interface WorkspaceResourceBarProps {
  mode: ResourceMode;
  counts: Record<ResourceKind, number> | null;
  onSelect: (mode: ResourceMode) => void;
}

/**
 * SHELL-09：Files 领域内嵌的物理目录过滤条。
 *
 * §16 迁移表：本组件已从顶部全局 shell 断开（顶部由 DomainNavigationBar
 * 取代）；只在 Files 领域作为物理浏览的高级过滤条出现，与命令面板共用
 * RESOURCE_FAMILIES 配置源。语义领域不得渲染它。
 */
export function WorkspaceResourceBar({ mode, counts, onSelect }: WorkspaceResourceBarProps): ReactElement {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const totalCount = counts
    ? RESOURCE_FAMILIES.reduce((sum, family) =>
      family.id === 'all' ? sum : sum + (counts[family.id] ?? 0), 0) + (counts.unknown ?? 0)
    : null;
  const unknownCount = counts?.unknown ?? 0;

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (index + 1) % RESOURCE_FAMILIES.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + RESOURCE_FAMILIES.length) % RESOURCE_FAMILIES.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = RESOURCE_FAMILIES.length - 1;
    if (next === null) return;
    event.preventDefault();
    tabRefs.current[next]?.focus();
  }

  return (
    <nav className="resource-bar" aria-label="物理目录过滤">
      <div className="resource-bar__tabs" role="tablist" aria-label="物理目录" data-testid="resource-bar">
        {RESOURCE_FAMILIES.map((family, index) => {
          const selected = family.id === mode;
          const count = family.id === 'all'
            ? totalCount
            : counts?.[family.id] ?? null;
          return (
            <button
              key={family.id}
              ref={(element) => { tabRefs.current[index] = element; }}
              type="button"
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              className={selected ? 'resource-tab is-selected' : 'resource-tab'}
              data-resource-mode={family.id}
              onClick={() => onSelect(family.id)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
            >
              <span className="resource-tab__label">{family.label}</span>
              {counts && count !== null && <span className="resource-tab__count">{count}</span>}
            </button>
          );
        })}
      </div>
      {unknownCount > 0 && (
        <span
          className="resource-bar__unknown"
          role="note"
          title="存在未归类资源；仅在 all 中显示，不合并进 other"
        >
          unknown {unknownCount}
        </span>
      )}
    </nav>
  );
}
