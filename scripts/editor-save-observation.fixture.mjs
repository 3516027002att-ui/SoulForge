import assert from 'node:assert/strict';
import test from 'node:test';
import { createEditorSaveObservation } from '../apps/desktop/e2e/playwright/editor-save-observation.mjs';

function ports(clock = (() => { let time = 0; return () => ++time; })()) {
  const handlers = new Map();
  const ipcMain = { handle: (name, listener) => { handlers.set(name, listener); return 'registered'; } };
  const writes = [];
  const stream = { write(...args) { writes.push(args); return false; } };
  const observation = createEditorSaveObservation({ ipcMain, stdout: { ...stream }, stderr: { ...stream }, clock });
  return { ...observation, handlers, ipcMain, writes };
}

test('observed IPC preserves original listener arguments, exact result and rejection without replay', async () => {
  const h = ports(); let calls = 0;
  const value = { ok: true, body: 'PRIVATE_PAYLOAD', diagnostics: [
    { code: 'POSTCOMMIT_REFRESH_FAILED', message: 'PRIVATE_TEXT' }, { code: 'BRIDGE_PRIVATE_PAYLOAD' }
  ] };
  const args = [{ sender: 'owned' }, 'PRIVATE_URI', { secret: 'PRIVATE_PAYLOAD' }];
  assert.equal(h.ipcMain.handle('resource.saveScriptSource', (...received) => {
    calls++; assert.deepEqual(received, args); return value;
  }), 'registered');
  assert.equal(await h.handlers.get('resource.saveScriptSource')(...args), value);
  const denied = new Error('PRIVATE_ERROR');
  h.ipcMain.handle('resource.applyContainerParamFieldMutation', () => { calls++; throw denied; });
  await assert.rejects(h.handlers.get('resource.applyContainerParamFieldMutation')(...args), error => error === denied);
  assert.equal(calls, 2);
  assert.doesNotMatch(JSON.stringify(h.snapshot()), /PRIVATE_|sender|secret/);
  assert.deepEqual(h.snapshot().events[1].codes, ['POSTCOMMIT_REFRESH_FAILED']);
  assert.deepEqual(h.snapshot().events.map(event => event.state), ['start', 'finish', 'start', 'throw']);
  h.restore();
});

test('partial observer installation failure restores hooks and preserves normal IPC startup', async () => {
  const handlers = new Map();
  const originalHandle = (name, listener) => handlers.set(name, listener);
  const ipcMain = { handle: originalHandle };
  const originalWrite = () => true;
  const stdout = { write: originalWrite };
  const stderr = Object.freeze({ write: originalWrite });
  const h = createEditorSaveObservation({ ipcMain, stdout, stderr, clock: () => 1 });
  assert.equal(ipcMain.handle, originalHandle); assert.equal(stdout.write, originalWrite);
  ipcMain.handle('resource.saveScriptSource', () => 'normal');
  assert.equal(await handlers.get('resource.saveScriptSource')(), 'normal');
  assert.ok(h.snapshot().observerErrors > 0);
});

test('existing database trace admits only known fields and never payload/SQL/path data', () => {
  const h = ports();
  const trace = { method: 'finalizeCommit', event: 'finish', side: 'worker', outcome: 'ok', dbDurationMs: 4,
    requestId: 'PRIVATE_ID', sql: 'PRIVATE_SQL', body: 'PRIVATE_BODY', path: '/PRIVATE_PATH' };
  const line = `[SoulForge database utility trace] ${JSON.stringify(trace)}\n`;
  assert.equal(h.stderr.write(line), false);
  assert.deepEqual(h.writes[0], [line]);
  assert.equal(h.snapshot().events[0].method, 'finalizeCommit');
  assert.equal(h.snapshot().events[0].state, 'finish');
  assert.doesNotMatch(JSON.stringify(h.snapshot()), /PRIVATE_|sql|body|path|requestId/);
  h.restore();
});

test('observer clock/parser failures do not change original return/error or create a rejection', async () => {
  const h = ports(() => { throw new Error('observer failure'); });
  h.ipcMain.handle('resource.saveScriptSource', () => 'exact');
  assert.equal(await h.handlers.get('resource.saveScriptSource')(), 'exact');
  assert.equal(h.stderr.write('[SoulForge database utility trace] invalid\n'), false);
  assert.ok(h.snapshot().observerErrors > 0);
  h.restore();
});

test('fixed tail and input limits report dropped observations without retaining large frames', async () => {
  const h = ports(); h.ipcMain.handle('resource.saveScriptSource', () => ({ ok: true }));
  for (let index = 0; index < 100; index++) await h.handlers.get('resource.saveScriptSource')();
  assert.equal(h.stderr.write('x'.repeat(70_000)), false);
  const snapshot = h.snapshot();
  assert.equal(snapshot.events.length, snapshot.limit);
  assert.ok(snapshot.droppedEvents > 0); assert.ok(snapshot.droppedInput > 0);
  h.restore();
});
