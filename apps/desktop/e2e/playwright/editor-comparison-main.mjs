// Observe the real guarded receiver and existing DB trace, without replacing
// business handlers, renderer capabilities, arguments, bytes or outcomes.
import { ipcMain } from 'electron';
import { performance } from 'node:perf_hooks';
import { createEditorSaveObservation, EDITOR_SAVE_OBSERVATION_PREFIX } from './editor-save-observation.mjs';
// Bypass the observation hook itself; only bounded sanitized packets leave main.
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const observation = createEditorSaveObservation({ ipcMain,
  stdout: process.stdout, stderr: process.stderr, clock: () => performance.now(),
  publish: (event, counters) => originalStdoutWrite(`${EDITOR_SAVE_OBSERVATION_PREFIX}${JSON.stringify({ event, counters })}\n`) });
global.__editorSaveObservation = observation.snapshot;
await import('./production-main.mjs');
