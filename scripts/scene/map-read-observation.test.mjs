import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { observeMapGeometryRead } from '../../apps/desktop/src/renderer/src/scene/mapReadObservation.ts';
import { summarizeMapRequestTimeline } from '../map-request-timeline.mjs';

// Exercise the actual browser installer without importing the executable probe.
const source = readFileSync(new URL('../verify-map-streaming-native.mjs', import.meta.url), 'utf8');
const begin = source.indexOf('async function installMapApiTimingTelemetry(page)');
const end = source.indexOf('\nasync function setMapApiTimingPhase(page, phase)', begin);
assert.ok(begin >= 0 && end > begin);
const install = eval(`(${source.slice(begin, end)})`);

async function harness(t) {
  const previous = Object.fromEntries(['window', 'soulforge', '__sfMapApiTiming'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const window = new EventTarget();
  const readMapStaticGeometry = () => {};
  globalThis.window = window;
  globalThis.soulforge = Object.freeze({ readMapStaticGeometry });
  delete globalThis.__sfMapApiTiming;
  t.after(() => {
    globalThis.__sfMapApiTiming?.dispose?.();
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const page = { evaluate: callback => callback() };
  await install(page);
  const timing = globalThis.__sfMapApiTiming;
  return { timing, window, page, assertFrozen: () => assert.equal(globalThis.soulforge.readMapStaticGeometry, readMapStaticGeometry) };
}

const metadata = requestId => ({ modelName: 'fixture', cursorPresent: false, sessionPresent: false, requestId });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function readyAndFrame(window) {
  const canvas = {};
  window.dispatchEvent(new CustomEvent('sf-map-model-ready', { detail: { modelName: 'fixture', canvas, readyAtUnixMs: performance.timeOrigin + performance.now() } }));
  window.dispatchEvent(new CustomEvent('sf-scene-frame-submitted', { detail: { canvas, submittedAtUnixMs: performance.timeOrigin + performance.now() } }));
}

for (const [from, to] of [['ui-load', 'done'], ['done', 'ui-load']]) {
  test(`an actual read retains its dispatch phase across ${from} to ${to}`, async t => {
    const h = await harness(t);
    h.timing.setPhase(from);
    const read = deferred();
    let invoked = 0, pendingAtInvoke;
    const pending = observeMapGeometryRead(() => {
      invoked++;
      pendingAtInvoke = h.timing.snapshot().phaseAttribution?.pendingCount;
      return read.promise;
    }, metadata('phase-read'));
    h.timing.setPhase(to);
    const nativeAt = performance.timeOrigin + performance.now();
    const result = { ok: true, diagnostics: [{ code: 'MAP_REQUEST_TIMELINE', details: { schemaVersion: 1, nativeEnqueuedAtUnixMs: nativeAt, nativeStartedAtUnixMs: nativeAt, nativeCompletedAtUnixMs: nativeAt, clockAlignmentToleranceMs: 0 } }] };
    read.resolve(result);
    assert.equal(await pending, result);
    assert.equal(invoked, 1);
    readyAndFrame(h.window);
    const snapshot = h.timing.snapshot();
    assert.equal(snapshot.timeline[0].phase, from);
    assert.equal(pendingAtInvoke, 1, 'start is observed before invoke');
    assert.equal(snapshot.timeline[0].phaseAttribution, 'captured');
    assert.equal(snapshot.recent[0].phase, from);
    assert.equal(snapshot.phaseStats[from].calls, 1);
    assert.equal(snapshot.phaseStats[to], undefined);
    assert.equal(snapshot.phaseAttribution?.pendingCount, 0);
    assert.equal(JSON.stringify(snapshot).includes('observationId'), false, 'opaque invocation identity is never serialized');
    const summary = summarizeMapRequestTimeline(snapshot);
    assert.equal(summary.models.length, from === 'ui-load' ? 1 : 0);
    assert.equal(summary.availableModelCount, from === 'ui-load' ? 1 : 0);
    assert.equal(summary.criticalPathVerified, false);
    h.assertFrozen();
  });
}

for (const name of ['ordinary throw', 'cancellation']) {
  test(`${name} retains error identity and dispatch phase`, async t => {
    const h = await harness(t);
    h.timing.setPhase('ui-load');
    const read = deferred();
    const error = name === 'cancellation' ? new DOMException('cancelled', 'AbortError') : new Error('fixture failure');
    const pending = observeMapGeometryRead(() => read.promise, metadata(name));
    h.timing.setPhase('done');
    read.reject(error);
    await assert.rejects(pending, actual => actual === error);
    const snapshot = h.timing.snapshot();
    assert.equal(snapshot.failedCount, 1);
    assert.equal(snapshot.phaseStats['ui-load'].failedCount, 1);
    assert.equal(snapshot.timeline[0].phase, 'ui-load');
    assert.equal(snapshot.phaseAttribution?.pendingCount, 0);
    h.assertFrozen();
  });
}

test('metadata identity is captured before the awaited callback can mutate it', async t => {
  const h = await harness(t);
  h.timing.setPhase('ui-load');
  const request = metadata('original');
  const result = { ok: true };
  assert.equal(await observeMapGeometryRead(async () => {
    request.requestId = 'mutated';
    request.modelName = 'mutated';
    h.timing.setPhase('done');
    return result;
  }, request), result);
  const snapshot = h.timing.snapshot();
  assert.equal(snapshot.timeline[0].requestId, 'original');
  assert.equal(snapshot.timeline[0].modelName, 'fixture');
  assert.equal(snapshot.timeline[0].phase, 'ui-load');
});

test('simultaneously duplicated request identities remain unavailable and drain', async t => {
  const h = await harness(t);
  h.timing.setPhase('ui-load');
  const a = deferred(), b = deferred();
  const first = observeMapGeometryRead(() => a.promise, metadata('duplicate'));
  h.timing.setPhase('done');
  const second = observeMapGeometryRead(() => b.promise, metadata('duplicate'));
  const resultA = { ok: true }, resultB = { ok: false };
  b.resolve(resultB); a.resolve(resultA);
  assert.equal(await first, resultA);
  assert.equal(await second, resultB);
  const snapshot = h.timing.snapshot();
  assert.deepEqual(snapshot.timeline.map(entry => entry.phase), ['unlabelled', 'unlabelled']);
  assert.deepEqual(snapshot.timeline.map(entry => entry.phaseAttribution), ['REQUEST_ID_DUPLICATE', 'REQUEST_ID_DUPLICATE']);
  assert.equal(snapshot.phaseAttribution?.unavailableCount, 2);
  assert.equal(snapshot.phaseAttribution?.pendingCount, 0);
  assert.equal(snapshot.phaseStats['ui-load'], undefined);
  assert.equal(snapshot.phaseStats.done, undefined);
});

test('missing identity and dropped starts never borrow the completion phase', async t => {
  const h = await harness(t);
  h.timing.setPhase('ui-load');
  const result = { ok: true };
  assert.equal(await observeMapGeometryRead(async () => result, metadata('')), result);
  const dispatch = h.window.dispatchEvent.bind(h.window);
  h.window.dispatchEvent = event => event.type === 'sf-map-read-start' ? true : dispatch(event);
  assert.equal(await observeMapGeometryRead(async () => result, metadata('dropped')), result);
  const snapshot = h.timing.snapshot();
  assert.deepEqual(snapshot.timeline.map(entry => entry.phase), ['unlabelled', 'unlabelled']);
  assert.deepEqual(snapshot.timeline.map(entry => entry.phaseAttribution), ['REQUEST_ID_MISSING', 'REQUEST_START_UNOBSERVED']);
  assert.equal(snapshot.phaseAttribution?.pendingCount, 0);
  assert.equal(snapshot.phaseAttribution?.unavailableCount, 2);
});

test('a mismatched completion cannot consume another precise pending start', async t => {
  const h = await harness(t);
  h.timing.setPhase('ui-load');
  const detail = { ...metadata('same-id'), observationId: {}, startedAt: 1, timeOrigin: 1000 };
  h.window.dispatchEvent(new CustomEvent('sf-map-read-start', { detail }));
  h.timing.setPhase('done');
  h.window.dispatchEvent(new CustomEvent('sf-map-read-timing', { detail: { ...detail, startedAt: 2, completedAt: 3, result: { ok: true } } }));
  assert.equal(h.timing.snapshot().phaseAttribution?.pendingCount, 1);
  h.window.dispatchEvent(new CustomEvent('sf-map-read-timing', { detail: { ...detail, completedAt: 4, result: { ok: true } } }));
  const snapshot = h.timing.snapshot();
  assert.deepEqual(snapshot.timeline.map(entry => entry.phaseAttribution), ['REQUEST_START_IDENTITY_MISMATCH', 'captured']);
  assert.deepEqual(snapshot.timeline.map(entry => entry.phase), ['unlabelled', 'ui-load']);
  assert.equal(snapshot.phaseAttribution?.pendingCount, 0);
});

test('pending start overflow is bounded and explicitly unavailable', async t => {
  const h = await harness(t);
  h.timing.setPhase('ui-load');
  const limit = 10_000;
  for (let index = 0; index < limit; index++) {
    h.window.dispatchEvent(new CustomEvent('sf-map-read-start', { detail: { ...metadata(`pending-${index}`), observationId: {}, startedAt: index, timeOrigin: 1000 } }));
  }
  assert.equal(h.timing.snapshot().phaseAttribution?.pendingCount, limit);
  const result = { ok: true };
  assert.equal(await observeMapGeometryRead(async () => result, metadata('overflow')), result);
  const snapshot = h.timing.snapshot();
  assert.equal(snapshot.phaseAttribution?.pendingLimit, limit);
  assert.equal(snapshot.phaseAttribution?.pendingCount, 0);
  assert.equal(snapshot.phaseAttribution?.overflow, true);
  assert.equal(snapshot.timeline[0].phaseAttribution, 'REQUEST_START_OVERFLOW');
  assert.equal(snapshot.timeline[0].phase, 'unlabelled');
});

test('observation dispatch failure preserves successful and thrown values', async t => {
  const h = await harness(t);
  h.window.dispatchEvent = () => { throw new Error('observer unavailable'); };
  const result = { ok: true };
  assert.equal(await observeMapGeometryRead(async () => result, metadata('success')), result);
  const error = new DOMException('cancelled', 'AbortError');
  await assert.rejects(observeMapGeometryRead(async () => { throw error; }, metadata('cancelled')), actual => actual === error);
  assert.equal(h.timing.snapshot().calls, 0);
  h.assertFrozen();
});

test('a failed clock-origin observation cannot prevent success, throw or cancellation', async t => {
  const h = await harness(t);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  const now = performance.now.bind(performance);
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now, get timeOrigin() { throw new Error('clock observer unavailable'); } } });
  t.after(() => Object.defineProperty(globalThis, 'performance', descriptor));
  let invoked = 0;
  const result = { ok: true };
  assert.equal(await observeMapGeometryRead(async () => { invoked++; return result; }, metadata('clock-success')), result);
  for (const error of [new Error('original failure'), new DOMException('cancelled', 'AbortError')]) {
    await assert.rejects(observeMapGeometryRead(async () => { invoked++; throw error; }, metadata(error.name)), actual => actual === error);
  }
  assert.equal(invoked, 3);
  h.assertFrozen();
});

test('a dropped duplicate start cannot steal attribution with quantized identical clocks', async t => {
  const h = await harness(t);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => 1, timeOrigin: 1000 } });
  t.after(() => Object.defineProperty(globalThis, 'performance', descriptor));
  h.timing.setPhase('ui-load');
  const dispatch = h.window.dispatchEvent.bind(h.window);
  let starts = 0;
  h.window.dispatchEvent = event => event.type === 'sf-map-read-start' && ++starts === 2 ? true : dispatch(event);
  const a = deferred(), b = deferred();
  const first = observeMapGeometryRead(() => a.promise, metadata('same-id'));
  h.timing.setPhase('done');
  const second = observeMapGeometryRead(() => b.promise, metadata('same-id'));
  const resultA = { ok: true }, resultB = { ok: true };
  b.resolve(resultB);
  assert.equal(await second, resultB);
  assert.equal(h.timing.snapshot().phaseAttribution?.pendingCount, 1);
  h.timing.setPhase('done');
  a.resolve(resultA);
  assert.equal(await first, resultA);
  const snapshot = h.timing.snapshot();
  assert.deepEqual(snapshot.timeline.map(entry => entry.phaseAttribution), ['REQUEST_START_IDENTITY_MISMATCH', 'captured']);
  assert.deepEqual(snapshot.timeline.map(entry => entry.phase), ['unlabelled', 'ui-load']);
  assert.equal(snapshot.phaseAttribution?.pendingCount, 0);
});

test('a missing opaque invocation identity is explicitly unavailable', async t => {
  const h = await harness(t);
  h.timing.setPhase('ui-load');
  const detail = { ...metadata('missing-invocation'), startedAt: 1, timeOrigin: 1000 };
  h.window.dispatchEvent(new CustomEvent('sf-map-read-start', { detail }));
  h.window.dispatchEvent(new CustomEvent('sf-map-read-timing', { detail: { ...detail, completedAt: 2, result: { ok: true } } }));
  const snapshot = h.timing.snapshot();
  assert.equal(snapshot.timeline[0].phase, 'unlabelled');
  assert.equal(snapshot.timeline[0].phaseAttribution, 'REQUEST_START_IDENTITY_MISSING');
  assert.equal(snapshot.phaseAttribution?.invalidStartCount, 1);
  assert.equal(snapshot.phaseAttribution?.pendingCount, 0);
});

test('disposal clears pending state and removes listeners before reinstallation', async t => {
  const h = await harness(t);
  const read = deferred();
  const pending = observeMapGeometryRead(() => read.promise, metadata('disposed'));
  assert.equal(h.timing.snapshot().phaseAttribution?.pendingCount, 1);
  assert.equal(typeof h.timing.dispose, 'function');
  h.timing.dispose();
  assert.equal(h.timing.snapshot().phaseAttribution?.pendingCount, 0);
  assert.equal(h.timing.installed, false);
  const result = { ok: true };
  read.resolve(result);
  assert.equal(await pending, result);
  assert.equal(h.timing.snapshot().calls, 0);
  await install(h.page);
  const replacement = globalThis.__sfMapApiTiming;
  assert.notEqual(replacement, h.timing);
  replacement.setPhase('ui-load');
  assert.equal(await observeMapGeometryRead(async () => result, metadata('replacement')), result);
  assert.equal(replacement.snapshot().calls, 1);
  assert.equal(h.timing.snapshot().calls, 0);
  h.window.dispatchEvent(new Event('pagehide'));
  assert.equal(replacement.installed, false);
  h.assertFrozen();
});
