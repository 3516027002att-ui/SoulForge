/**
 * CodeMirror 6 Navigation, References, Peek & Enhanced Hover Tooltips.
 *
 * Implements:
 * - F12 / Mod-Click: Go to Event definition
 * - Shift+F12: Find References
 * - Alt+F12: Peek Definition
 * - Rich Hover Tooltip for instructions, arguments, enums, and event parameters
 */

import { hoverTooltip, keymap, EditorView, type Tooltip } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import type { EmedfCompletionItem, EmedfEnumDef } from '@soulforge/core';
import {
  analyzeCursorContext,
  indexDocumentSymbols,
  findEventReferences,
  getSignatureHelp
} from '@soulforge/core/dist/emevd/language-service/index.js';

export interface NavigationCallbacks {
  onJumpToEvent: (eventId: number) => void;
  onFindReferences?: (eventId: number) => void;
  onPeekDefinition?: (eventId: number, previewText?: string) => void;
}

export function emevdNavigationExtension(
  getCatalog: () => EmedfCompletionItem[],
  getEnums: () => Record<string, EmedfEnumDef>,
  callbacks: NavigationCallbacks
): Extension {
  // Enhanced Hover Tooltip
  const hover = hoverTooltip((view: EditorView, pos: number): Tooltip | null => {
    const docText = view.state.doc.toString();
    const cursorContext = analyzeCursorContext(docText, pos);
    if (cursorContext.isInComment) return null;

    const catalog = getCatalog();
    const enums = getEnums();

    // 1. Hover on word/identifier
    const word = cursorContext.currentWord;
    if (!word) return null;

    // Check if hovering on an Event ID (e.g. $Event(10000) or InitializeEvent(0, 10000))
    if (/^\d+$/.test(word.text)) {
      const eventId = Number(word.text);
      const symbolIndex = indexDocumentSymbols(docText);
      const targetSym = symbolIndex.byEventId.get(eventId);
      if (targetSym) {
        return {
          pos: word.from,
          end: word.to,
          create: () => {
            const dom = document.createElement('div');
            dom.className = 'cm-emedf-hover';
            const title = document.createElement('strong');
            title.textContent = `$Event(${eventId})`;
            dom.appendChild(title);

            const detail = document.createElement('div');
            detail.className = 'cm-emedf-hover__row';
            detail.textContent = `第 ${targetSym.line} 行 · ${targetSym.restBehavior} · ${targetSym.instructionCount} 条指令`;
            dom.appendChild(detail);

            const action = document.createElement('div');
            action.className = 'cm-emedf-hover__action muted';
            action.textContent = '按 F12 或 Ctrl+Click 跳转到定义';
            dom.appendChild(action);

            return { dom };
          }
        };
      }
    }

    // Check if hovering on Instruction Name
    const matched = catalog.find((item) => item.name === word.text)
      ?? catalog.find((item) => item.name.toLowerCase() === word.text.toLowerCase());

    if (matched) {
      return {
        pos: word.from,
        end: word.to,
        create: () => {
          const dom = document.createElement('div');
          dom.className = 'cm-emedf-hover';

          const title = document.createElement('strong');
          title.textContent = `${matched.name} (bank ${matched.bank}:${matched.id})`;
          dom.appendChild(title);

          if (matched.description) {
            const desc = document.createElement('div');
            desc.className = 'cm-emedf-hover__doc';
            desc.textContent = matched.description;
            dom.appendChild(desc);
          }

          if (matched.args.length > 0) {
            const argsList = document.createElement('div');
            argsList.className = 'cm-emedf-hover__args';
            argsList.textContent = `参数: ${matched.args.map((a) => `${a.name}:${a.type}${a.enumName ? ` (${a.enumName})` : ''}`).join(', ')}`;
            dom.appendChild(argsList);
          }

          return { dom };
        }
      };
    }

    // Check if hovering on an Enum Member (e.g. ComparisonType.Equal)
    if (word.text.includes('.')) {
      const [enumName, memberName] = word.text.split('.');
      if (enumName && memberName && enums[enumName]) {
        const enumDef = enums[enumName]!;
        const member = enumDef.members.find((m) => m.name === memberName);
        if (member) {
          return {
            pos: word.from,
            end: word.to,
            create: () => {
              const dom = document.createElement('div');
              dom.className = 'cm-emedf-hover';
              const title = document.createElement('strong');
              title.textContent = `${enumName}.${member.name} = ${member.value}`;
              dom.appendChild(title);
              if (member.label) {
                const desc = document.createElement('div');
                desc.className = 'cm-emedf-hover__row';
                desc.textContent = member.label;
                dom.appendChild(desc);
              }
              return { dom };
            }
          };
        }
      }
    }

    return null;
  });

  // Keymaps for F12, Shift+F12, Alt+F12
  const navKeymap = keymap.of([
    {
      key: 'F12',
      run: (view: EditorView) => {
        const pos = view.state.selection.main.head;
        const docText = view.state.doc.toString();
        const cursorContext = analyzeCursorContext(docText, pos);
        const word = cursorContext.currentWord?.text;
        if (word && /^\d+$/.test(word)) {
          callbacks.onJumpToEvent(Number(word));
          return true;
        }
        return false;
      }
    },
    {
      key: 'Shift-F12',
      run: (view: EditorView) => {
        const pos = view.state.selection.main.head;
        const docText = view.state.doc.toString();
        const cursorContext = analyzeCursorContext(docText, pos);
        const word = cursorContext.currentWord?.text;
        if (word && /^\d+$/.test(word) && callbacks.onFindReferences) {
          callbacks.onFindReferences(Number(word));
          return true;
        }
        return false;
      }
    },
    {
      key: 'Alt-F12',
      run: (view: EditorView) => {
        const pos = view.state.selection.main.head;
        const docText = view.state.doc.toString();
        const cursorContext = analyzeCursorContext(docText, pos);
        const word = cursorContext.currentWord?.text;
        if (word && /^\d+$/.test(word) && callbacks.onPeekDefinition) {
          callbacks.onPeekDefinition(Number(word));
          return true;
        }
        return false;
      }
    }
  ]);

  // Click handler for Mod-Click (Ctrl+Click on Windows)
  const clickHandler = EditorView.domEventHandlers({
    click(event: MouseEvent, view: EditorView) {
      if (!event.ctrlKey && !event.metaKey) return;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return;

      const docText = view.state.doc.toString();
      const cursorContext = analyzeCursorContext(docText, pos);
      const word = cursorContext.currentWord?.text;
      if (word && /^\d+$/.test(word)) {
        callbacks.onJumpToEvent(Number(word));
        event.preventDefault();
      }
    }
  });

  return [hover, navKeymap, clickHandler];
}
