/**
 * Problems Pane for EMEVD DarkScript3.
 *
 * Displays live diagnostics (Errors & Warnings) and enables click-to-navigate.
 */

import React, { useState, type ReactElement } from 'react';
import type { EventDiagnostic } from '@soulforge/core';

export interface EventProblemsPaneProps {
  diagnostics: readonly EventDiagnostic[];
  onSelectDiagnostic: (diagnostic: EventDiagnostic) => void;
  onClose?: () => void;
}

export function EventProblemsPane(props: EventProblemsPaneProps): ReactElement {
  const { diagnostics, onSelectDiagnostic, onClose } = props;
  const [filter, setFilter] = useState<'all' | 'error' | 'warning'>('all');

  const filtered = diagnostics.filter((d) => {
    if (filter === 'error') return d.severity === 'error';
    if (filter === 'warning') return d.severity === 'warning';
    return true;
  });

  const errorCount = diagnostics.filter((d) => d.severity === 'error').length;
  const warningCount = diagnostics.filter((d) => d.severity === 'warning').length;

  return (
    <div className="esw-problems" role="region" aria-label="事件问题">
      <div className="esw-problems__header">
        <div className="esw-problems__filters">
          <span className="esw-problems__title">问题</span>
          <button
            type="button"
            className={filter === 'all' ? 'toolbar-button is-active' : 'toolbar-button'}
            onClick={() => setFilter('all')}
          >
            全部 ({diagnostics.length})
          </button>
          <button
            type="button"
            className={filter === 'error' ? 'toolbar-button is-active' : 'toolbar-button'}
            onClick={() => setFilter('error')}
          >
            错误 ({errorCount})
          </button>
          <button
            type="button"
            className={filter === 'warning' ? 'toolbar-button is-active' : 'toolbar-button'}
            onClick={() => setFilter('warning')}
          >
            警告 ({warningCount})
          </button>
        </div>
        {onClose && (
          <button type="button" className="toolbar-button" onClick={onClose} title="关闭问题面板">
            ✕
          </button>
        )}
      </div>

      <div className="esw-problems__list" role="list">
        {filtered.map((d, index) => (
          <button
            key={`${d.line}-${d.from}-${index}`}
            type="button"
            className={`esw-problems__item esw-problems__item--${d.severity}`}
            onClick={() => onSelectDiagnostic(d)}
            role="listitem"
          >
            <span className="esw-problems__icon">
              {d.severity === 'error' ? '✕' : d.severity === 'warning' ? '⚠' : 'ℹ'}
            </span>
            <span className="esw-problems__line">第 {d.line} 行</span>
            <span className="esw-problems__message">{d.message}</span>
            <span className="esw-problems__code muted">[{d.code}]</span>
          </button>
        ))}
        {filtered.length === 0 && (
          <div className="muted esw-problems__empty">暂无诊断问题。</div>
        )}
      </div>
    </div>
  );
}
