import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as observationModule from '../apps/desktop/e2e/playwright/editor-save-observation.mjs';
const { createEditorSaveObservation } = observationModule;

async function actualParamCompletionHelper() {
  const url = new URL('../apps/desktop/e2e/playwright/tests/editor-loaded-comparison.spec.mjs', import.meta.url);
  const source = await readFile(url, 'utf8');
  const ast = ts.createSourceFile(url.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const helper = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'paramIpcCompletion');
  assert.ok(helper, 'The production spec helper must remain discoverable');
  return new Function(`return (${helper.getText(ast)});`)();
}

test('actual PARAM refetch helper consumes the second Electron evaluate argument and rejects stale or failed pairs', async () => {
  const helper = await actualParamCompletionHelper(), method = 'resource.readContainerParamPage';
  const original = Object.getOwnPropertyDescriptor(globalThis, '__editorSaveObservation');
  const app = { evaluate: async (callback, argument) => callback(Object.freeze({ app: 'owned-electron-type' }), argument) };
  const start = { stage: 'ipc', method, state: 'start' };
  const finish = { stage: 'ipc', method, state: 'finish', ok: true };
  try {
    for (const [events, observedEvents, after, expected] of [
      [[start, finish], 12, 10, 12],
      [[start, finish], 12, 12, null],
      [[start, finish], 12, 11, null],
      [[start], 11, 10, null],
      [[start, { ...finish, ok: false }], 12, 10, null],
      [[start, { stage: 'ipc', method, state: 'throw' }], 12, 10, null],
      [[{ ...start, method: 'resource.readContainerParamRowIndex' }, { ...finish, method: 'resource.readContainerParamRowIndex' }], 12, 10, null]
    ]) {
      Reflect.set(globalThis, '__editorSaveObservation', () => ({ events, observedEvents }));
      assert.equal(await helper(app, after, method), expected);
    }
  } finally {
    if (original) Object.defineProperty(globalThis, '__editorSaveObservation', original);
    else Reflect.deleteProperty(globalThis, '__editorSaveObservation');
  }
});

test('current PARAM save remains pending until its original observed listener finishes, despite an older success', async () => {
  const helper = await actualParamCompletionHelper(), h = ports(), method = 'resource.applyContainerParamFieldMutation';
  const original = Object.getOwnPropertyDescriptor(globalThis, '__editorSaveObservation');
  const app = { evaluate: async (callback, argument) => callback(Object.freeze({ app: 'owned-electron-type' }), argument) };
  let resolve;
  try {
    h.ipcMain.handle(method, () => ({ ok: true }));
    await h.handlers.get(method)();
    const checkpoint = h.snapshot().observedEvents;
    h.ipcMain.handle(method, () => new Promise(done => { resolve = done; }));
    const pending = h.handlers.get(method)();
    Reflect.set(globalThis, '__editorSaveObservation', h.snapshot);
    assert.equal(await helper(app, checkpoint, method), null);
    resolve({ ok: true }); await pending;
    assert.equal(await helper(app, checkpoint, method), h.snapshot().observedEvents);
  } finally {
    h.restore();
    if (original) Object.defineProperty(globalThis, '__editorSaveObservation', original);
    else Reflect.deleteProperty(globalThis, '__editorSaveObservation');
  }
});

function ports(clock = (() => { let time = 0; return () => ++time; })(), publish) {
  const handlers = new Map();
  const ipcMain = { handle: (name, listener) => { handlers.set(name, listener); return 'registered'; } };
  const writes = [];
  const stream = { write(...args) { writes.push(args); return false; } };
  const observation = createEditorSaveObservation({ ipcMain, stdout: { ...stream }, stderr: { ...stream }, clock, publish });
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

test('original PARAM index/page listeners are observed in order with exact values and errors', async () => {
  const h = ports();
  const args = [{ sender: 'PRIVATE_SENDER' }, 'PRIVATE_URI', 0, 0, 20, undefined, false, 'PRIVATE_TOKEN'];
  const index = { ok: true, sessionToken: 'PRIVATE_TOKEN', rows: ['PRIVATE_ROW'] };
  const failure = new Error('PRIVATE_ERROR'); let calls = 0;
  h.ipcMain.handle('resource.readContainerParamRowIndex', (...received) => {
    calls++; assert.deepEqual(received, args.slice(0, 3)); return index;
  });
  h.ipcMain.handle('resource.readContainerParamPage', async (...received) => {
    calls++; assert.deepEqual(received, args); throw failure;
  });
  assert.equal(await h.handlers.get('resource.readContainerParamRowIndex')(...args.slice(0, 3)), index);
  await assert.rejects(h.handlers.get('resource.readContainerParamPage')(...args), error => error === failure);
  assert.equal(calls, 2);
  assert.deepEqual(h.snapshot().events.map(({ method, state }) => [method, state]), [
    ['resource.readContainerParamRowIndex', 'start'], ['resource.readContainerParamRowIndex', 'finish'],
    ['resource.readContainerParamPage', 'start'], ['resource.readContainerParamPage', 'throw']
  ]);
  assert.doesNotMatch(JSON.stringify(h.snapshot()), /PRIVATE_|sender|rows|sessionToken/);
  h.restore();
});

test('optional publisher exports only copied sanitized events and fixed counters', async () => {
  const published = [];
  const h = ports(undefined, (event, counters) => {
    published.push(JSON.parse(JSON.stringify({ event, counters })));
    event.method = 'PRIVATE_MUTATION';
  });
  const value = { ok: true, diagnostics: [{ code: 'PARAMDEF_ENCODE_FAILED', message: 'PRIVATE_BODY' }] };
  h.ipcMain.handle('resource.readContainerParamPage', () => value);
  assert.equal(await h.handlers.get('resource.readContainerParamPage')('PRIVATE_URI'), value);
  assert.equal(published.length, 2);
  assert.deepEqual(published[1].event.codes, ['PARAMDEF_ENCODE_FAILED']);
  assert.equal(published[1].counters.observedEvents, 2);
  assert.equal(published[1].counters.droppedPublished, 0);
  assert.doesNotMatch(JSON.stringify([published, h.snapshot()]), /PRIVATE_|message|sourceUri/);
  h.restore();
});

test('throwing or rejecting publishers preserve business settlement without an unhandled rejection', async () => {
  for (const publish of [() => { throw new Error('PRIVATE_PUBLISH_ERROR'); }, () => Promise.reject(new Error('PRIVATE_PUBLISH_ERROR'))]) {
    const h = ports(undefined, publish); const value = { ok: true }; const failure = new Error('PRIVATE_BUSINESS_ERROR');
    const unhandled = []; const onUnhandled = error => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    try {
      h.ipcMain.handle('resource.readContainerParamRowIndex', () => value);
      assert.equal(await h.handlers.get('resource.readContainerParamRowIndex')(), value);
      h.ipcMain.handle('resource.readContainerParamPage', async () => { throw failure; });
      await assert.rejects(h.handlers.get('resource.readContainerParamPage')(), error => error === failure);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(h.snapshot().droppedPublished, 4);
      assert.deepEqual(unhandled, []);
      assert.doesNotMatch(JSON.stringify(h.snapshot()), /PRIVATE_/);
    } finally { process.off('unhandledRejection', onUnhandled); h.restore(); }
  }
});

test('host receives the bounded original event tail and reports malformed, lost and oversized input', async () => {
  assert.equal(typeof observationModule.createEditorSaveObservationTail, 'function');
  const tail = observationModule.createEditorSaveObservationTail();
  const packets = [];
  const h = ports(undefined, (event, counters) => packets.push(`[SF_EDITOR_SAVE_OBSERVATION] ${JSON.stringify({ event, counters })}\n`));
  h.ipcMain.handle('resource.readContainerParamRowIndex', () => ({ ok: true }));
  for (let index = 0; index < 85; index++) await h.handlers.get('resource.readContainerParamRowIndex')();
  const joined = packets.filter((_, index) => index !== 3).join('');
  for (let index = 0; index < joined.length; index += 137) tail.consume(joined.slice(index, index + 137));
  tail.consume('[SF_EDITOR_SAVE_OBSERVATION] invalid\n');
  tail.consume(`[SF_EDITOR_SAVE_OBSERVATION] ${JSON.stringify({ event: { atMs: 171, stage: 'ipc', method: 'PRIVATE_CHANNEL', state: 'start' }, counters: {} })}\n`);
  tail.consume('x'.repeat(70_000));
  const snapshot = tail.snapshot();
  assert.equal(snapshot.events.length, 160);
  assert.equal(snapshot.droppedEvents, 10);
  assert.equal(snapshot.transportDroppedEvents, 1);
  assert.equal(snapshot.transportErrors, 2);
  assert.equal(snapshot.transportDroppedInput, 1);
  assert.deepEqual(snapshot.events.at(-1), h.snapshot().events.at(-1));
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_|invalid/);
  h.restore();
});

test('actual failure summary uses the original host tail after Electron has closed', async () => {
  assert.equal(typeof observationModule.createEditorSaveObservationTail, 'function');
  const tail = observationModule.createEditorSaveObservationTail();
  const h = ports(undefined, (event, counters) => tail.consume(`[SF_EDITOR_SAVE_OBSERVATION] ${JSON.stringify({ event, counters })}\n`));
  h.ipcMain.handle('resource.readContainerParamRowIndex', () => ({ ok: true }));
  await h.handlers.get('resource.readContainerParamRowIndex')();
  const source = await readFile(new URL('../apps/desktop/e2e/playwright/tests/editor-loaded-comparison.spec.mjs', import.meta.url), 'utf8');
  const helper = source.slice(source.indexOf('async function reportOwnedFailure('), source.indexOf('\nasync function openResource('));
  const reports = [];
  const report = new Function('readFile', 'path', 'hash', 'console', `return (${helper});`)(
    async () => Buffer.from('owned bytes'), { join: (...parts) => parts.join('/') }, () => 'owned-hash',
    { log: (marker, body) => reports.push([marker, JSON.parse(body)]) }
  );
  const closed = { evaluate: async () => { throw new Error('PRIVATE_CLOSED_ERROR'); } };
  await report(closed, closed, { overlay: 'owned', scriptPath: 'script', paramPath: 'param' },
    { script: 'owned-hash', param: 'owned-hash' }, 'param-edit', tail);
  assert.equal(reports.length, 1);
  assert.equal(reports[0][1].observation.state, 'host-tail');
  assert.deepEqual(reports[0][1].observation.events, h.snapshot().events);
  assert.equal(reports[0][1].physical.param.changed, false);
  assert.doesNotMatch(JSON.stringify(reports), /PRIVATE_/);
  h.restore();
});

test('actual owned main publisher uses original stdout and excludes private read arguments', async () => {
  const source = await readFile(new URL('../apps/desktop/e2e/playwright/editor-comparison-main.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('// Bypass the observation hook'), source.indexOf("await import('./production-main.mjs')"));
  const handlers = new Map(); const writes = [];
  const ipcMain = { handle: (channel, listener) => handlers.set(channel, listener) };
  const stream = { write: value => { writes.push(value); return false; } };
  const fakeGlobal = {}; let time = 0;
  new Function('ipcMain', 'performance', 'process', 'global', 'createEditorSaveObservation', 'EDITOR_SAVE_OBSERVATION_PREFIX', body)(
    ipcMain, { now: () => ++time }, { stdout: { ...stream }, stderr: { ...stream } }, fakeGlobal,
    createEditorSaveObservation, observationModule.EDITOR_SAVE_OBSERVATION_PREFIX
  );
  const result = { ok: true, sessionToken: 'PRIVATE_TOKEN', rows: ['PRIVATE_ROW'] };
  ipcMain.handle('resource.readContainerParamRowIndex', () => result);
  assert.equal(await handlers.get('resource.readContainerParamRowIndex')('PRIVATE_URI', 0), result);
  assert.equal(writes.length, 2);
  const tail = observationModule.createEditorSaveObservationTail();
  for (const line of writes) tail.consume(line);
  assert.deepEqual(tail.snapshot().events, fakeGlobal.__editorSaveObservation().events);
  assert.doesNotMatch(writes.join(''), /PRIVATE_|sessionToken|rows|sourceUri/);
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

test('existing knowledge load trace is observed without SQL, args or identity data', () => {
  const h = ports();
  h.stdout.write('[SoulForge database utility trace] {"method":"loadKnowledgeSnapshot","event":"start","side":"worker","sql":"PRIVATE_SQL"}\n');
  assert.deepEqual(h.snapshot().events.map(event => event.stage), ['database']);
  assert.equal(h.snapshot().events[0].method, 'loadKnowledgeSnapshot');
  assert.doesNotMatch(JSON.stringify(h.snapshot()), /PRIVATE_|sql|body|path/);
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
