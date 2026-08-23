/**
 * Outline & Go-to-Symbol Pane for EMEVD DarkScript3.
 *
 * Provides instant search, event listing, instruction counts, and line navigation.
 */

import React, { useState, useMemo, type ReactElement } from 'react';
import type { EventSymbol } from '@soulforge/core';
import { searchEventSymbols } from '@soulforge/core/dist/emevd/language-service/index.js';

export interface EventOutlinePaneProps {
  symbols: readonly EventSymbol[];
  activeEventId?: number | null | undefined;
  onSelectEvent: (symbol: EventSymbol) => void;
  onClose?: () => void;
  isModal?: boolean;
}

export function EventOutlinePane(props: EventOutlinePaneProps): ReactElement {
  const { symbols, activeEventId, onSelectEvent, onClose, isModal } = props;
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    return searchEventSymbols(query, symbols);
  }, [query, symbols]);

  return (
    <div className={isModal ? 'esw-outline esw-outline--modal' : 'esw-outline'} role="region" aria-label="事件大纲">
      <div className="esw-outline__header">
        <input
          type="text"
          className="esw-outline__search"
          placeholder="搜索事件 (ID / 行为)..."
          value={query}
          autoFocus={isModal}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="搜索事件符号"
        />
        {onClose && (
          <button type="button" className="toolbar-button" onClick={onClose} title="关闭大纲">
            ✕
          </button>
        )}
      </div>

      <div className="esw-outline__list" role="list">
        {filtered.map((sym) => {
          const isActive = sym.eventId === activeEventId;
          return (
            <button
              key={sym.eventId}
              type="button"
              className={isActive ? 'esw-outline__item is-active' : 'esw-outline__item'}
              onClick={() => onSelectEvent(sym)}
              role="listitem"
            >
              <div className="esw-outline__item-main">
                <span className="esw-outline__event-id">$Event({sym.eventId})</span>
                <span className="esw-outline__rest-badge">{sym.restBehavior}</span>
              </div>
              <div className="esw-outline__item-meta">
                <span className="muted">第 {sym.line} 行 · {sym.instructionCount} 条指令</span>
                {sym.parameterSlots.length > 0 && (
                  <span className="esw-outline__slots"> [{sym.parameterSlots.join(', ')}]</span>
                )}
                {sym.errors > 0 && <span className="esw-outline__error-tag"> ✕ {sym.errors}</span>}
                {sym.warnings > 0 && <span className="esw-outline__warn-tag"> ⚠ {sym.warnings}</span>}
              </div>
            </button>
          );
        })}
        {filtered.length === 0 && (
          <div className="muted esw-outline__empty">无匹配事件。</div>
        )}
      </div>
    </div>
  );
}
