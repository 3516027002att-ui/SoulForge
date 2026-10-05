import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { observeMapGeometryRead } from '../../apps/desktop/src/renderer/src/scene/mapReadObservation.ts';
import { summarizeMapRequestTimeline } from '../map-request-timeline.mjs';

const observation = await import('../../apps/desktop/src/renderer/src/scene/mapModelLoadObservation.ts').catch(() => ({}));
const prepareClientSource = readFileSync(new URL('../../apps/desktop/src/renderer/src/scene/mapGeometryPrepareClient.ts', import.meta.url), 'utf8');
const typeImports = prepareClientSource.match(/^import \{([\s\S]*?)\} from '\.\/mapGeometryPrepare\.js';/);
assert.ok(typeImports && typeImports[1].split(',').filter(value => value.trim()).every(value => value.trim().startsWith('type ')));
// Elide the verified type-only header, as the maintained TS build does.
const clientJavaScript = stripTypeScriptTypes(prepareClientSource.slice(typeImports[0].length), { mode: 'transform' });
const { MapGeometryPrepareClient } = await import(`data:text/javascript;base64,${Buffer.from(clientJavaScript).toString('base64')}`);
const queueSource = readFileSync(new URL('../../apps/desktop/src/renderer/src/scene/mapModelLoadScheduler.ts', import.meta.url), 'utf8');
const queueBegin = queueSource.indexOf('export class FrameTaskQueue');
assert.ok(queueBegin >= 0);
// Compile the actual maintained queue class; no alternate queue implementation.
const FrameTaskQueue = new Function(`${stripTypeScriptTypes(queueSource.slice(queueBegin).replace('export class', 'class'), { mode: 'transform' })}; return FrameTaskQueue;`)();
const verifierSource = readFileSync(new URL('../verify-map-streaming-native.mjs', import.meta.url), 'utf8');
const installerBegin = verifierSource.indexOf('async function installMapApiTimingTelemetry(page)');
const installerEnd = verifierSource.indexOf('\nasync function setMapApiTimingPhase(page, phase)', installerBegin);
const install = eval(`(${verifierSource.slice(installerBegin, installerEnd)})`);

async function harness(t) {
  const descriptors = Object.fromEntries(['window', 'soulforge', '__sfMapApiTiming', 'performance'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let tick = 0;
  const window = new EventTarget();
  const api = Object.freeze({ readMapStaticGeometry: () => {} });
  globalThis.window = window;
  globalThis.soulforge = api;
  globalThis.performance = { now: () => tick, timeOrigin: 1000 };
  delete globalThis.__sfMapApiTiming;
  await install({ evaluate: callback => callback() });
  const timing = globalThis.__sfMapApiTiming;
  timing.setPhase('ui-load');
  t.after(() => {
    timing.dispose();
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { window, timing, setTick: value => { tick = value; }, assertApi: () => assert.equal(globalThis.soulforge, api) };
}

const identity = (id, canvas = {}) => ({ modelName: 'same-model', loadId: `load-${id}`, sourceUri: `fixture://map/${id}`, sourceRevision: id.repeat(64), canvas });
function nativeResult(start) {
  return { ok: true, diagnostics: [{ code: 'MAP_REQUEST_TIMELINE', details: { schemaVersion: 1, nativeEnqueuedAtUnixMs: 1000 + start + 10, nativeStartedAtUnixMs: 1000 + start + 10, nativeCompletedAtUnixMs: 1000 + start + 30, clockAlignmentToleranceMs: 0 } }] };
}
async function read(h, binding, start = 0) {
  h.setTick(start);
  const result = nativeResult(start);
  assert.equal(await observeMapGeometryRead(async () => { h.setTick(start + 40); return result; }, { ...binding, requestId: `${binding.loadId}-page`, cursorPresent: false, sessionPresent: false }), result);
}
function ready(h, binding, at) {
  h.window.dispatchEvent(new CustomEvent('sf-map-model-ready', { detail: { ...binding, readyAtUnixMs: 1000 + at } }));
  h.window.dispatchEvent(new CustomEvent('sf-scene-frame-submitted', { detail: { canvas: binding.canvas, submittedAtUnixMs: 1010 + at } }));
}
function queue(h) {
  let frame;
  const actual = new FrameTaskQueue(callback => { frame = callback; return 1; }, () => { frame = undefined; }, () => performance.now());
  return { actual, drain(at) { h.setTick(at); const callback = frame; frame = undefined; assert.equal(typeof callback, 'function'); callback(at); } };
}
function record(binding, overrides = {}) {
  assert.equal(typeof observation.createMapModelLoadObservation, 'function');
  const captured = observation.createMapModelLoadObservation(binding);
  captured.observePreparation({ jobId: 'prepare-job', status: 'completed', enqueuedAtMs: 50, startedAtMs: 60, completedAtMs: 80, timeOriginAtEnqueue: 1000, timeOriginAtCompletion: 1000, reportedWorkerDurationMs: 15, ...overrides });
  return captured;
}

test('actual read and ready callbacks never merge the same model across load/source/scene identities', async t => {
  const h = await harness(t);
  for (const [id, start] of [['a', 0], ['b', 100]]) {
    const binding = identity(id);
    await read(h, binding, start);
    ready(h, binding, start + 50);
  }
  const result = summarizeMapRequestTimeline(h.timing.snapshot());
  assert.equal(result.models.length, 2);
  assert.deepEqual(result.models.map(model => model.loadId), ['load-a', 'load-b']);
  assert.deepEqual(result.models.map(model => model.endToFirstFrameMs), [60, 60]);
  assert.deepEqual(result.models.map(model => model.accountingErrorMs), [0, 0]);
  assert.equal(result.criticalPathVerified, false);
  h.assertApi();
});

test('actual queued upload gives a contained preparation/queue/replacement breakdown without double worker cost', async t => {
  const h = await harness(t), binding = identity('a');
  await read(h, binding);
  const captured = record(binding);
  const q = queue(h);
  h.setTick(90);
  let calls = 0;
  const pending = observation.observeMapModelUpload(q.actual, () => { calls++; h.setTick(130); return true; }, captured, 'prepare-job', () => true);
  assert.equal(calls, 0);
  q.drain(120);
  assert.equal(await pending, true);
  assert.equal(calls, 1);
  h.window.dispatchEvent(new CustomEvent('sf-scene-frame-submitted', { detail: { canvas: binding.canvas, submittedAtUnixMs: 1140 } }));
  const result = summarizeMapRequestTimeline(h.timing.snapshot()), model = result.models[0];
  assert.equal(model.available, true);
  assert.deepEqual(model.phases, { preNativeMs: 10, nativeExecutionMs: 20, returnProcessingMs: 100, firstFrameMs: 10 });
  assert.equal(model.accountingErrorMs, 0);
  assert.equal(model.postReturn.available, true);
  assert.deepEqual(model.postReturn.phases, { beforePrepareMs: 10, prepareQueueMs: 10, prepareTurnaroundMs: 20, beforeUploadMs: 10, uploadQueueMs: 30, replacementMs: 10 });
  assert.equal(model.postReturn.measuredTailMs, 90);
  assert.equal(model.postReturn.accountingErrorMs, 0);
  assert.equal(model.postReturn.reportedWorkerDurationMs, 15);
  assert.equal(model.postReturn.sourceBindingScope, 'logical-map-document-revision-and-load');
  assert.equal(result.criticalPathVerified, false);
});

test('the actual prepare worker callback, RAF callback and installer account for one bound load', async t => {
  const h = await harness(t), binding = identity('a');
  const workers = [];
  const client = new MapGeometryPrepareClient(() => {
    const worker = { messages: [], onmessage: null, onerror: null, postMessage(message) { this.messages.push(message); }, terminate() {} };
    workers.push(worker);
    return worker;
  }, { concurrency: 1 });
  t.after(() => client.dispose());
  const wire = { positionsBase64: 'AAAA', vertexCount: 1, textureIdentities: [] };
  const warmup = client.prepare([]);
  await read(h, binding);
  const captured = observation.createMapModelLoadObservation(binding);
  h.setTick(50);
  const pendingPrepare = client.prepare([], undefined, {}, captured.observePreparation);
  const worker = workers[0];
  h.setTick(60);
  worker.onmessage({ data: { kind: 'result', jobId: worker.messages[0].jobId, prepared: wire, prepareDurationMs: 1 } });
  await warmup;
  h.setTick(80);
  worker.onmessage({ data: { kind: 'result', jobId: worker.messages[1].jobId, prepared: wire, prepareDurationMs: 15 } });
  const prepared = await pendingPrepare;
  const q = queue(h);
  h.setTick(90);
  let uploadedGeometry;
  const pendingUpload = observation.observeMapModelUpload(q.actual, () => { uploadedGeometry = prepared; h.setTick(130); return true; }, captured, prepared.cacheKey, () => true);
  q.drain(120);
  assert.equal(await pendingUpload, true);
  assert.equal(uploadedGeometry, prepared);
  h.window.dispatchEvent(new CustomEvent('sf-scene-frame-submitted', { detail: { canvas: binding.canvas, submittedAtUnixMs: 1140 } }));
  const model = summarizeMapRequestTimeline(h.timing.snapshot()).models[0];
  assert.equal(model.available, true);
  assert.equal(model.postReturn.available, true);
  assert.deepEqual(model.postReturn.phases, { beforePrepareMs: 10, prepareQueueMs: 10, prepareTurnaroundMs: 20, beforeUploadMs: 10, uploadQueueMs: 30, replacementMs: 10 });
  assert.equal(model.postReturn.accountingErrorMs, 0);
  assert.equal(model.postReturn.reportedWorkerDurationMs, 15);
  assert.equal(model.accountingErrorMs, 0);
});

test('a shared cached geometry object cannot overwrite a deferred invocation record', async t => {
  const h = await harness(t), a = identity('a'), b = identity('b');
  const geometry = { cacheKey: 'prepare-job', positionsBase64: 'AAAA', vertexCount: 1 };
  let current = record(a);
  const invocationA = observation.captureMapModelLoadInvocation(() => Promise.resolve(geometry), () => current);
  current = record(b);
  const invocationB = observation.captureMapModelLoadInvocation(() => Promise.resolve(geometry), () => current);
  assert.equal(await invocationA.promise, geometry);
  assert.equal(await invocationB.promise, geometry);
  const q = queue(h);
  h.setTick(90);
  const uploadA = observation.observeMapModelUpload(q.actual, () => { h.setTick(130); return true; }, invocationA.observation, geometry.cacheKey, () => true);
  current = record(b);
  q.drain(120);
  assert.equal(await uploadA, true);
  const readyRecords = Object.values(h.timing.snapshot().modelReady);
  assert.equal(readyRecords.length, 1);
  assert.equal(readyRecords[0].loadId, 'load-a');
  assert.equal(readyRecords[0].sourceUri, a.sourceUri);
});

test('cancelled/disposed/replaced/false/throw upload callbacks never publish successful current ready', async t => {
  const h = await harness(t), captured = record(identity('a'));
  const disposed = queue(h);
  const noRun = observation.observeMapModelUpload(disposed.actual, () => { assert.fail('disposed queue ran callback'); }, captured, 'prepare-job', () => true);
  disposed.actual.dispose();
  assert.equal(await noRun, false);
  for (const [run, current, expected] of [[() => true, false, true], [() => false, true, false]]) {
    const q = queue(h);
    const pending = observation.observeMapModelUpload(q.actual, run, captured, 'prepare-job', () => current);
    q.drain(120);
    assert.equal(await pending, expected);
  }
  const error = new Error('replacement failed'), q = queue(h);
  const pending = observation.observeMapModelUpload(q.actual, () => { throw error; }, captured, 'prepare-job', () => true);
  q.drain(120);
  await assert.rejects(pending, actual => actual === error);
  assert.equal(Object.keys(h.timing.snapshot().modelReady).length, 0);
});

test('ready telemetry clock/event failures preserve a successful replacement', async t => {
  const h = await harness(t), captured = record(identity('a'));
  const q = queue(h);
  h.window.dispatchEvent = () => { throw new Error('event observer failed'); };
  const pending = observation.observeMapModelUpload(q.actual, () => true, captured, 'prepare-job', () => true);
  q.drain(120);
  assert.equal(await pending, true);
  globalThis.performance = { now: () => 120, get timeOrigin() { throw new Error('clock observer failed'); } };
  const clockQueue = queue(h);
  const clockPending = observation.observeMapModelUpload(clockQueue.actual, () => true, captured, 'prepare-job', () => true);
  clockQueue.drain(120);
  assert.equal(await clockPending, true);
});

test('missing source/load proof and noncausal prepare boundaries remain explicit', async t => {
  const h = await harness(t);
  const invalid = { ...identity('a'), sourceRevision: '未加载' };
  await read(h, invalid);
  ready(h, invalid, 50);
  const unknown = summarizeMapRequestTimeline(h.timing.snapshot());
  assert.equal(unknown.availableModelCount, 0);
  assert.equal(unknown.models[0].reason, 'MODEL_IDENTITY_UNOBSERVED');
  const valid = identity('b');
  await read(h, valid, 100);
  const captured = record(valid, { enqueuedAtMs: 150, startedAtMs: 160, completedAtMs: 140 });
  const q = queue(h);
  h.setTick(180);
  const pending = observation.observeMapModelUpload(q.actual, () => { h.setTick(210); return true; }, captured, 'prepare-job', () => true);
  q.drain(200); await pending;
  h.window.dispatchEvent(new CustomEvent('sf-scene-frame-submitted', { detail: { canvas: valid.canvas, submittedAtUnixMs: 1220 } }));
  const model = summarizeMapRequestTimeline(h.timing.snapshot()).models.find(entry => entry.loadId === valid.loadId);
  assert.equal(model.available, true);
  assert.equal(model.postReturn.available, false);
  assert.equal(model.postReturn.reason, 'PREPARE_BOUNDARIES_NONCAUSAL');
});

test('repeated ready callbacks retain the first exact load boundary', async t => {
  const h = await harness(t), binding = identity('a');
  await read(h, binding);
  ready(h, binding, 50);
  ready(h, binding, 500);
  const snapshot = h.timing.snapshot(), model = summarizeMapRequestTimeline(snapshot).models[0];
  assert.equal(snapshot.repeatedReadyCount, 1);
  assert.equal(model.endToFirstFrameMs, 60);
  assert.equal(model.accountingErrorMs, 0);
});

test('changed or missing clock origin and wrong prepare job stay unavailable without changing upload', async t => {
  const h = await harness(t);
  for (const [id, overrides, job, reason] of [
    ['a', { timeOriginAtCompletion: 2000 }, 'prepare-job', 'RENDERER_CLOCK_ORIGIN_CHANGED'],
    ['b', { timeOriginAtEnqueue: null }, 'prepare-job', 'RENDERER_CLOCK_ORIGIN_UNOBSERVED'],
    ['c', {}, 'foreign-job', 'PREPARE_IDENTITY_MISMATCH']
  ]) {
    const binding = identity(id);
    await read(h, binding);
    const captured = record(binding, overrides), q = queue(h);
    h.setTick(90);
    const upload = observation.observeMapModelUpload(q.actual, () => { h.setTick(130); return true; }, captured, job, () => true);
    q.drain(120);
    assert.equal(await upload, true);
    h.window.dispatchEvent(new CustomEvent('sf-scene-frame-submitted', { detail: { canvas: binding.canvas, submittedAtUnixMs: 1140 } }));
    const model = summarizeMapRequestTimeline(h.timing.snapshot()).models.find(entry => entry.loadId === binding.loadId);
    assert.equal(model.available, true);
    assert.equal(model.postReturn.available, false);
    assert.equal(model.postReturn.reason, reason);
  }
});
