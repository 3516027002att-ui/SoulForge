// Exercise the actual optional main-process phase tracer without Electron.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const filename = fileURLToPath(new URL('../apps/desktop/src/main/scriptSaveTrace.ts', import.meta.url));
const create = existsSync(filename) ? createRequire(import.meta.url)('./typescript-test-loader.cjs')()(filename).createScriptSaveTrace : undefined;
function tracer(options = {}) {
  assert.equal(typeof create, 'function', 'The real main-only phase tracer must exist');
  const events = [];
  let time = 1;
  return { trace: create({ enabled: true, clock: () => time++, write: line => events.push(JSON.parse(line.slice('[SoulForge script save phase] '.length))), ...options }), events };
}

test('disabled tracing preserves callback result and error without emitting or reading the clock', async () => {
  const h = tracer({ enabled: false, clock: () => { throw new Error('clock must not run'); } });
  const value = { exact: true };
  assert.equal(await h.trace.run('ensure-log', () => value), value);
  const error = new Error('owned error');
  await assert.rejects(h.trace.run('native-reread', () => { throw error; }), received => received === error);
  assert.deepEqual(h.events, []);
});
test('enabled tracing emits only static phases, state, sequence and monotonic timing', async () => {
  const h = tracer(); const value = { body: 'PRIVATE_BODY', path: '/PRIVATE_PATH' };
  assert.equal(await h.trace.run('native-reread', () => value), value);
  const error = new Error('PRIVATE_ERROR');
  await assert.rejects(h.trace.run('commit-entry', () => { throw error; }), received => received === error);
  assert.deepEqual(h.events.map(event => [event.phase, event.state]), [['native-reread','start'],['native-reread','finish'],['commit-entry','start'],['commit-entry','throw']]);
  assert.equal(h.events[0].request, h.events[3].request);
  assert.ok(h.events[1].atMs >= h.events[0].atMs);
  assert.equal(h.events[1].elapsedMs, 1);
  assert.doesNotMatch(JSON.stringify(h.events), /PRIVATE_|body|path|error/i);
});
test('throwing or asynchronously rejecting sinks cannot change a business outcome or leak rejection', async () => {
  const unhandled = [];
  const listener = error => unhandled.push(error);
  process.on('unhandledRejection', listener);
  try {
    for (const write of [() => { throw new Error('sink failed'); }, () => Promise.reject(new Error('sink failed'))]) {
      const h = tracer({ write }); const value = {};
      assert.equal(await h.trace.run('stage-roots', () => value), value);
      const error = new Error('business failed');
      await assert.rejects(h.trace.run('native-reread', () => Promise.reject(error)), received => received === error);
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', listener); }
});
test('invalid clock and unknown phases cannot affect original business work', async () => {
  for (const clock of [() => { throw new Error('clock failed'); }, () => NaN, () => Infinity, () => -1]) {
    const h = tracer({ clock }); assert.equal(await h.trace.run('ensure-log', () => 7), 7); assert.deepEqual(h.events, []);
  }
  const h = tracer(); assert.equal(await h.trace.run('PRIVATE_PHASE', () => 7), 7); assert.deepEqual(h.events, []);
});
test('candidate completion is emitted once before commit entry even when finish is called again', async () => {
  const h = tracer(); const finish = h.trace.begin('candidate-staging');
  finish('finish'); finish('throw');
  await h.trace.run('commit-entry', () => ({ ok: true }));
  assert.deepEqual(h.events.map(event => [event.phase,event.state]), [['candidate-staging','start'],['candidate-staging','finish'],['commit-entry','start'],['commit-entry','finish']]);
});
test('concurrent requests use independent non-sensitive process sequence numbers', async () => {
  const a = tracer(), b = tracer(); let release;
  const deferred = new Promise(resolve => { release = resolve; });
  const first = a.trace.run('native-reread', () => deferred);
  await b.trace.run('native-reread', () => 'second'); release('first');
  assert.equal(await first, 'first');
  assert.notEqual(a.events[0].request, b.events[0].request);
  assert.equal(a.events[0].request, a.events[1].request);
});
test('main environment opt-in is exact and disabled by default', async () => {
  const prior = process.env.SOULFORGE_EDITOR_SAVE_TRACE;
  try {
    for (const setting of [undefined, '0', 'true', '1']) {
      if (setting === undefined) delete process.env.SOULFORGE_EDITOR_SAVE_TRACE;
      else process.env.SOULFORGE_EDITOR_SAVE_TRACE = setting;
      const h = tracer({ enabled: undefined });
      await h.trace.run('read-roots', () => undefined);
      assert.equal(h.events.length, setting === '1' ? 2 : 0);
    }
  } finally { if (prior === undefined) delete process.env.SOULFORGE_EDITOR_SAVE_TRACE; else process.env.SOULFORGE_EDITOR_SAVE_TRACE = prior; }
});
