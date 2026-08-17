import { performance } from 'node:perf_hooks';
import { ensureSyntaxTree, foldable } from '@codemirror/language';
import {
  buildEditorExtensions,
  indexEventLines
} from '../apps/desktop/src/renderer/src/editors/EventSourceWorkbenchPanel.tsx';
import { createCompleteSourceState } from '../apps/desktop/src/renderer/src/emevd/emevdSourceMount.ts';

(globalThis as unknown as { window?: unknown }).window =
  (globalThis as unknown as { window?: unknown }).window ?? {};

function makeDarkScript(events: number, instructionsPerEvent = 28): string {
  const parts: string[] = [];
  for (let i = 0; i < events; i += 1) {
    parts.push(`$Event(${i}, Default, function() {`);
    for (let j = 0; j < instructionsPerEvent; j += 1) {
      parts.push(`    InitializeEvent(${j}, ${70000000 + i}, 0);`);
    }
    parts.push('});');
    parts.push('');
  }
  return parts.join('\n');
}

function run(name: string, events: number): void {
  const text = makeDarkScript(events);
  const rows = Array.from({ length: events }, (_, i) => ({
    eventId: i,
    warnings: i % 7 === 0 ? 1 : 0
  }));
  const extensions = buildEditorExtensions(() => {}, true, 'dark-script', () => []);
  const createStart = performance.now();
  const state = createCompleteSourceState(text, extensions);
  const createMs = performance.now() - createStart;

  const indexStart = performance.now();
  const gutter = indexEventLines(text, rows);
  const indexMs = performance.now() - indexStart;

  ensureSyntaxTree(state, Math.min(state.doc.length, 20_000), 250);
  const firstLine = state.doc.line(1);
  const fold = foldable(state, firstLine.from, firstLine.to);

  console.log(JSON.stringify({
    name,
    events,
    lines: state.doc.lines,
    chars: state.doc.length,
    mb: Number((state.doc.length / 1048576).toFixed(2)),
    createMs: Number(createMs.toFixed(2)),
    indexMs: Number(indexMs.toFixed(2)),
    gutterEntries: gutter.size,
    foldable: Boolean(fold)
  }));
}

run('common_func-scale', 2400);
run('common-scale', 8000);
