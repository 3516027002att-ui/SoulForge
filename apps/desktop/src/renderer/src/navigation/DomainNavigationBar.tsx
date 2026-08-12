import { useRef, type KeyboardEvent, type ReactElement } from 'react';
import type { RendererIndexedFile } from '../../../main/rendererDto.js';
import {
  DOMAIN_NAV_ITEMS,
  domainLabel,
  filterFilesForDomain,
  type EditorDomainId
} from './domainNavigation.js';

export interface DomainNavigationBarProps {
  domain: EditorDomainId;
  files: RendererIndexedFile[];
  onSelect: (domain: EditorDomainId) => void;
}

/** 顶层工作域导航；不把 event/map/param 等物理目录直接暴露成产品 IA。 */
export function DomainNavigationBar({ domain, files, onSelect }: DomainNavigationBarProps): ReactElement {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (index + 1) % DOMAIN_NAV_ITEMS.length;
    if (event.key === 'ArrowLeft') next = (index - 1 + DOMAIN_NAV_ITEMS.length) % DOMAIN_NAV_ITEMS.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = DOMAIN_NAV_ITEMS.length - 1;
    if (next === null) return;
    event.preventDefault();
    tabRefs.current[next]?.focus();
  }

  return (
    <nav className="domain-bar" aria-label="工作域导航">
      <div className="domain-bar__tabs" role="tablist" aria-label="工作区工作域" data-testid="domain-bar">
        {DOMAIN_NAV_ITEMS.map((item, index) => {
          const selected = item.id === domain;
          const count = item.id === 'project' || item.id === 'gparam'
            ? null
            : filterFilesForDomain(files, item.id, '').length;
          return (
            <button
              key={item.id}
              ref={(element) => { tabRefs.current[index] = element; }}
              type="button"
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              className={selected ? 'domain-tab is-selected' : 'domain-tab'}
              data-domain={item.id}
              title={item.description}
              onClick={() => onSelect(item.id)}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              <span className="domain-tab__label">{domainLabel(item.id)}</span>
              {count !== null && <span className="domain-tab__count">{count}</span>}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

