import { useRef, type KeyboardEvent, type ReactElement } from 'react';
import type { DomainSummary, EditorDomainId } from '@soulforge/shared';
import { LiquidTabGroup, LiquidTabItem } from '../components/motion/index.js';

export interface DomainNavigationBarProps {
  domain: EditorDomainId;
  /** §4.1：只接收 DomainSummary[]，不接收 files；顶部无物理计数（§3.3）。 */
  domains: readonly DomainSummary[];
  onSelect: (domain: EditorDomainId) => void;
  /**
   * 「开始」的选中态跟着资源栏开闭走（`!sidebarCollapsed && sidebarView==='explorer'`），
   * 不是 `activeDomain==='project'`。有工作区后开始只召唤资源栏，不是一页。
   */
  resourceSidebarOpen: boolean;
}

/** 顶层工作域导航；只消费 catalog 生成的领域摘要，不接触任何物理文件数据。 */
export function DomainNavigationBar({ domain, domains, onSelect, resourceSidebarOpen }: DomainNavigationBarProps): ReactElement {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const visible = domains.filter((entry) => entry.visibility !== 'hidden');
  const activeTabId = resourceSidebarOpen ? 'project' : domain;

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (index + 1) % visible.length;
    if (event.key === 'ArrowLeft') next = (index - 1 + visible.length) % visible.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = visible.length - 1;
    if (next === null) return;
    event.preventDefault();
    tabRefs.current[next]?.focus();
  }

  return (
    <nav className="domain-bar" aria-label="工作域导航">
      <LiquidTabGroup
        activeId={activeTabId}
        fill="var(--forge-hover)"
        blur={5}
        contrast={18}
        radius={4}
        className="domain-bar__tabs"
        role="tablist"
        aria-label="工作区工作域"
        data-testid="domain-bar"
      >
        {visible.map((entry, index) => {
          // 「开始」的选中态 = 资源栏打开；其余领域仍按 activeDomain。
          const selected = entry.domain === 'project' ? resourceSidebarOpen : entry.domain === domain;
          const disabled = entry.visibility === 'disabled';
          const description = capabilityDescription(entry);
          return (
            <LiquidTabItem
              key={entry.domain}
              id={entry.domain}
              as="button"
              ref={(element: HTMLElement | null) => { tabRefs.current[index] = element as HTMLButtonElement | null; }}
              type="button"
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              disabled={disabled}
              className={selected ? 'domain-tab is-selected' : 'domain-tab'}
              data-domain={entry.domain}
              title={description}
              onClick={() => onSelect(entry.domain)}
              onKeyDown={(event: KeyboardEvent<any>) => handleKeyDown(event, index)}
            >
              <span className="domain-tab__label">{entry.label}</span>
            </LiquidTabItem>
          );
        })}
      </LiquidTabGroup>
    </nav>
  );
}

/** §3.2：入口可操作性的 title 说明；不显示任何无单位文件数（§3.3）。 */
function capabilityDescription(entry: DomainSummary): string {
  if (entry.capability === 'deferred') return `${entry.label}：read contract 尚未接线`;
  if (entry.capability === 'runtime-blocked') return `${entry.label}：read contract 已注册，但当前运行条件不满足`;
  return `${entry.label}：${entry.defaultTarget ? '可直接打开' : '从左侧打开一个文件'}`;
}
