// Observe the real guarded receiver and existing DB trace, without replacing
// business handlers, renderer capabilities, arguments, bytes or outcomes.
import { ipcMain } from 'electron';
import { performance } from 'node:perf_hooks';
import { createEditorSaveObservation } from './editor-save-observation.mjs';
const observation = createEditorSaveObservation({ ipcMain,
  stdout: process.stdout, stderr: process.stderr, clock: () => performance.now() });
global.__editorSaveObservation = observation.snapshot;
process.env.SOULFORGE_EDITOR_SAVE_TRACE = '1';
await import('./production-main.mjs');
