/**
 * CodeMirror 6 Editor Commands & Keymaps for EMEVD DarkScript3.
 *
 * Implements:
 * - Deterministic format document (Alt+Shift+F)
 * - Comment / uncomment (Ctrl+Shift+C / Ctrl+/)
 * - Line move up / down (Alt+Up / Alt+Down)
 * - Line duplicate (Shift+Alt+Up / Shift+Alt+Down)
 * - Search & Replace (Ctrl+H / Ctrl+F)
 */

import { type Extension } from '@codemirror/state';
import { keymap, type EditorView } from '@codemirror/view';
import { openSearchPanel } from '@codemirror/search';
import { formatEventDocument } from '@soulforge/core/dist/emevd/language-service/index.js';

export function formatDocument(view: EditorView): boolean {
  const currentDoc = view.state.doc.toString();
  const formatted = formatEventDocument(currentDoc);
  if (formatted === currentDoc) return true;

  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: formatted }
  });
  return true;
}

export function toggleLineComment(view: EditorView): boolean {
  const { from, to } = view.state.selection.main;
  const startLine = view.state.doc.lineAt(from);
  const endLine = view.state.doc.lineAt(to);

  let allCommented = true;
  for (let l = startLine.number; l <= endLine.number; l++) {
    const line = view.state.doc.line(l);
    if (line.text.trim().length > 0 && !line.text.trim().startsWith('//')) {
      allCommented = false;
      break;
    }
  }

  const changes: Array<{ from: number; to: number; insert: string }> = [];
  for (let l = startLine.number; l <= endLine.number; l++) {
    const line = view.state.doc.line(l);
    if (allCommented) {
      // Remove comment `// ` or `//`
      const commentIdx = line.text.indexOf('//');
      if (commentIdx >= 0) {
        const removeLen = line.text.startsWith('// ') ? 3 : 2;
        changes.push({
          from: line.from + commentIdx,
          to: line.from + commentIdx + removeLen,
          insert: ''
        });
      }
    } else {
      // Add `// `
      changes.push({
        from: line.from,
        to: line.from,
        insert: '// '
      });
    }
  }

  if (changes.length > 0) {
    view.dispatch({ changes });
    return true;
  }
  return false;
}

export function moveLine(view: EditorView, dir: -1 | 1): boolean {
  const { from, to } = view.state.selection.main;
  const startLine = view.state.doc.lineAt(from);
  const endLine = view.state.doc.lineAt(to);

  if (dir === -1 && startLine.number === 1) return false;
  if (dir === 1 && endLine.number === view.state.doc.lines) return false;

  const targetLineNumber = dir === -1 ? startLine.number - 1 : endLine.number + 1;
  const targetLine = view.state.doc.line(targetLineNumber);

  const selectedText = view.state.doc.sliceString(startLine.from, endLine.to);

  if (dir === -1) {
    view.dispatch({
      changes: [
        { from: startLine.from, to: endLine.to + 1, insert: '' },
        { from: targetLine.from, to: targetLine.from, insert: selectedText + '\n' }
      ]
    });
  } else {
    view.dispatch({
      changes: [
        { from: targetLine.to, to: targetLine.to, insert: '\n' + selectedText },
        { from: startLine.from, to: endLine.to + 1, insert: '' }
      ]
    });
  }
  return true;
}

export function duplicateLine(view: EditorView): boolean {
  const { from, to } = view.state.selection.main;
  const startLine = view.state.doc.lineAt(from);
  const endLine = view.state.doc.lineAt(to);
  const text = view.state.doc.sliceString(startLine.from, endLine.to);

  view.dispatch({
    changes: { from: endLine.to, to: endLine.to, insert: '\n' + text }
  });
  return true;
}

export function emevdEditingCommandsExtension(): Extension {
  return keymap.of([
    {
      key: 'Alt-Shift-f',
      run: (view) => formatDocument(view)
    },
    {
      key: 'Mod-Shift-c',
      run: (view) => toggleLineComment(view)
    },
    {
      key: 'Mod-/',
      run: (view) => toggleLineComment(view)
    },
    {
      key: 'Alt-ArrowUp',
      run: (view) => moveLine(view, -1)
    },
    {
      key: 'Alt-ArrowDown',
      run: (view) => moveLine(view, 1)
    },
    {
      key: 'Shift-Alt-ArrowUp',
      run: (view) => duplicateLine(view)
    },
    {
      key: 'Shift-Alt-ArrowDown',
      run: (view) => duplicateLine(view)
    },
    {
      key: 'Mod-h',
      run: (view) => {
        openSearchPanel(view);
        return true;
      }
    }
  ]);
}
