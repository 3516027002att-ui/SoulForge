/**
 * Problems Pane for EMEVD DarkScript3.
 *
 * Displays live diagnostics (Errors & Warnings) and enables click-to-navigate.
 */

import React, { useState, type ReactElement } from 'react';
import type { EventDiagnostic } from '@soulforge/core';
import { Button, IconButton } from '../components/Button.js';

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
          <Button variant="ghost" size="sm" pressed={filter === 'all'} onClick={() => setFilter('all')}>
            全部 ({diagnostics.length})
          </Button>
          <Button variant="ghost" size="sm" pressed={filter === 'error'} onClick={() => setFilter('error')}>
            错误 ({errorCount})
          </Button>
          <Button variant="ghost" size="sm" pressed={filter === 'warning'} onClick={() => setFilter('warning')}>
            警告 ({warningCount})
          </Button>
        </div>
        {onClose && <IconButton icon="x" size="sm" label="关闭问题面板" onClick={onClose} />}
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
