/**
 * CodeMirror 6 Live Diagnostics & Quick Fix Extension for EMEVD DarkScript3.
 *
 * Implements:
 * - Real-time squiggly error / warning underlines
 * - Hover tooltip with diagnostic message and Quick Fix buttons
 * - Ctrl+. (Mod-.) keymap to apply quick fix at cursor
 * - onDiagnosticsUpdate callback for UI Problems pane
 */

import { StateField, StateEffect, type Extension, type Transaction } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  hoverTooltip,
  keymap,
  type Tooltip
} from '@codemirror/view';
import type { EmedfCompletionItem, EmedfEnumDef, EventDiagnostic } from '@soulforge/core';
import { computeDocumentDiagnostics, getQuickFixesAt } from '@soulforge/core/dist/emevd/language-service/index.js';
import {
  sourceFillAnnotation,
  sourceFillCompletionAnnotation
} from './incrementalSourceInjection.js';

const setDiagnosticsEffect = StateEffect.define<EventDiagnostic[]>();

const errorMark = Decoration.mark({ class: 'cm-diagnostic-error' });
const warnMark = Decoration.mark({ class: 'cm-diagnostic-warning' });
const infoMark = Decoration.mark({ class: 'cm-diagnostic-info' });

/** 增量源码追加不应在每片到达时重新扫描不断增长的全文。 */
export function isSourceFillTransaction(transaction: Transaction): boolean {
  return transaction.annotation(sourceFillAnnotation) === true;
}

/** 最后一次 source fill 使文档从 partial 变 complete 时，允许一次全文 diagnostics。 */
export function isSourceFillCompletionTransaction(transaction: Transaction): boolean {
  return transaction.annotation(sourceFillCompletionAnnotation) === true;
}

export const diagnosticsStateField = StateField.define<EventDiagnostic[]>({
  create() {
    return [];
  },
  update(diags, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setDiagnosticsEffect)) {
        return effect.value;
      }
    }
    return diags;
  }
});

const diagnosticsDecorationField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    let diags: EventDiagnostic[] | null = null;
    for (const effect of tr.effects) {
      if (effect.is(setDiagnosticsEffect)) {
        diags = effect.value;
      }
    }
    if (diags !== null) {
      const docLen = tr.state.doc.length;
      const widgets = diags
        .filter((d) => d.from < d.to && d.from >= 0 && d.to <= docLen)
        .map((d) => {
          const mark = d.severity === 'error' ? errorMark : d.severity === 'warning' ? warnMark : infoMark;
          return mark.range(d.from, d.to);
        });
      return Decoration.set(widgets, true);
    }
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f)
});

/** diagnostics 结果事务只更新 StateField，不能被空诊断结果再次调度全文分析。 */
function isDiagnosticsResultTransaction(transaction: Transaction): boolean {
  return transaction.effects.some((effect) => effect.is(setDiagnosticsEffect));
}

export function emevdDiagnosticsExtension(
  getCatalog: () => EmedfCompletionItem[],
  getEnums?: () => Record<string, EmedfEnumDef>,
  onDiagnosticsUpdate?: (diagnostics: EventDiagnostic[]) => void
): Extension {
  // Tooltip on hovering diagnostics
  const diagTooltip = hoverTooltip((view: EditorView, pos: number): Tooltip | null => {
    const diags = view.state.field(diagnosticsStateField);
    const hit = diags.find((d) => d.from <= pos && pos <= d.to);
    if (!hit) return null;

    return {
      pos: hit.from,
      end: hit.to,
      create: () => {
        const dom = document.createElement('div');
        dom.className = 'cm-diagnostic-tooltip';

        const header = document.createElement('div');
        header.className = `cm-diagnostic-tooltip__header is-${hit.severity}`;
        header.textContent = `${hit.severity === 'error' ? '✕' : '⚠'} ${hit.message}`;
        dom.appendChild(header);

        const code = document.createElement('div');
        code.className = 'cm-diagnostic-tooltip__code muted';
        code.textContent = `[${hit.code}]`;
        dom.appendChild(code);

        if (hit.suggestedFixes && hit.suggestedFixes.length > 0) {
          const fixContainer = document.createElement('div');
          fixContainer.className = 'cm-diagnostic-tooltip__fixes';

          for (const fix of hit.suggestedFixes) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'toolbar-button';
            btn.textContent = `修复: ${fix.title}`;
            btn.onclick = () => {
              view.dispatch({
                changes: { from: fix.from, to: fix.to, insert: fix.replacement }
              });
            };
            fixContainer.appendChild(btn);
          }
          dom.appendChild(fixContainer);
        }

        return { dom };
      }
    };
  });

  // Debounced live diagnostics dispatcher
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listener = EditorView.updateListener.of((update) => {
    const hasSourceFill = update.transactions.some(isSourceFillTransaction);
    const hasSourceFillCompletion = update.transactions.some(isSourceFillCompletionTransaction);
    // 普通 source slice 只扩展展示缓冲；只有 completion annotation 才允许跑最终全文分析。
    if (hasSourceFill && !hasSourceFillCompletion) return;
    // 防止「最终结果为空 → StateField 仍为空 → 再次调度」的重复分析循环。
    if (update.transactions.some(isDiagnosticsResultTransaction)) return;
    if (
      hasSourceFillCompletion
      || update.docChanged
      || update.view.state.field(diagnosticsStateField).length === 0
    ) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const catalog = getCatalog();
        if (catalog.length === 0) return;
        const docText = update.view.state.doc.toString();
        const enums = getEnums ? getEnums() : {};
        const diags = computeDocumentDiagnostics(docText, catalog, enums);

        update.view.dispatch({
          effects: setDiagnosticsEffect.of(diags)
        });

        if (onDiagnosticsUpdate) {
          onDiagnosticsUpdate(diags);
        }
      }, 300);
    }
  });

  // Mod-. Quick Fix keymap
  const quickFixKeymap = keymap.of([
    {
      key: 'Mod-.',
      run: (view: EditorView) => {
        const catalog = getCatalog();
        const enums = getEnums ? getEnums() : {};
        const pos = view.state.selection.main.head;
        const docText = view.state.doc.toString();
        const diags = view.state.field(diagnosticsStateField);
        const fixes = getQuickFixesAt(pos, diags, docText, catalog, enums);
        if (fixes.length > 0 && fixes[0]) {
          const fix = fixes[0];
          view.dispatch({
            changes: { from: fix.from, to: fix.to, insert: fix.replacement }
          });
          return true;
        }
        return false;
      }
    }
  ]);

  return [
    diagnosticsStateField,
    diagnosticsDecorationField,
    diagTooltip,
    listener,
    quickFixKeymap,
    EditorView.theme({
      '.cm-diagnostic-error': {
        textDecoration: 'underline wavy var(--danger-text, #f44747)',
        textUnderlineOffset: '3px'
      },
      '.cm-diagnostic-warning': {
        textDecoration: 'underline wavy var(--warn, #cca700)',
        textUnderlineOffset: '3px'
      },
      '.cm-diagnostic-info': {
        textDecoration: 'underline dotted var(--ink-2, #888)',
        textUnderlineOffset: '3px'
      },
      '.cm-diagnostic-tooltip': {
        backgroundColor: 'var(--forge-1, #1e1e1e)',
        border: '1px solid var(--line, #333)',
        borderRadius: '4px',
        padding: '6px 10px',
        fontFamily: 'var(--font-mono, monospace)',
        fontSize: '11px',
        color: 'var(--ink-1, #d4d4d4)',
        boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        zIndex: '100',
        maxWidth: '480px'
      },
      '.cm-diagnostic-tooltip__header.is-error': {
        color: 'var(--danger-text, #f44747)',
        fontWeight: 'bold'
      },
      '.cm-diagnostic-tooltip__header.is-warning': {
        color: 'var(--warn, #cca700)',
        fontWeight: 'bold'
      },
      '.cm-diagnostic-tooltip__code': {
        fontSize: '10px',
        marginTop: '2px'
      },
      '.cm-diagnostic-tooltip__fixes': {
        marginTop: '6px',
        display: 'flex',
        gap: '4px'
      }
    })
  ];
}
