import assert from 'node:assert/strict';
import { test } from 'node:test';
const module = await import('../map-request-timeline.mjs').catch(() => ({}));
const binding = model => ({ modelName: model, loadId: `${model}-load`, sourceUri: 'fixture://map', sourceRevision: 'a'.repeat(64), sceneId: 1 });
const ready = (model, at) => ({ ...binding(model), readyAtUnixMs: at });
const request = (model, start, nativeStart, nativeEnd, end, enqueued = nativeStart) => ({ ...binding(model), rendererTimeOrigin: 0, phase: 'ui-load', modelName: model, requestId: `${model}-${start}`, rendererStartedAtUnixMs: start, rendererCompletedAtUnixMs: end, nativeTimeline: { schemaVersion: 1, nativeEnqueuedAtUnixMs: enqueued, nativeStartedAtUnixMs: nativeStart, nativeCompletedAtUnixMs: nativeEnd, clockAlignmentToleranceMs: 5 } });
test('sequential pages produce four causal phases matching model end-to-first-frame time', () => {
  assert.equal(typeof module.summarizeMapRequestTimeline, 'function');
  const result = module.summarizeMapRequestTimeline({ timeline: [request('a', 0, 10, 30, 40), request('a', 50, 60, 80, 90)], modelReady: { a: ready('a', 100) }, frames: [{ sceneId: 2, submittedAtUnixMs: 101 }, { sceneId: 1, submittedAtUnixMs: 110 }] });
  assert.equal(result.models[0].available, true);
  assert.deepEqual(result.models[0].phases, { preNativeMs: 20, nativeExecutionMs: 40, returnProcessingMs: 40, firstFrameMs: 10 });
  assert.equal(result.models[0].endToFirstFrameMs, 110);
  assert.equal(result.models[0].accountingErrorMs, 0);
});
test('main and IPC preparation are not misattributed to native queue wait', () => {
  const result = module.summarizeMapRequestTimeline({ timeline: [request('a', 0, 100, 110, 120, 80)], modelReady: { a: ready('a', 120) }, frames: [{ sceneId: 1, submittedAtUnixMs: 130 }] });
  assert.equal(result.models[0].phases.preNativeMs, 100);
  assert.equal(result.models[0].nativeQueueWaitMs, 20);
  assert.equal(result.models[0].accountingErrorMs, 0);
});
test('overlapping models never become a summed fake map critical path', () => {
  assert.equal(typeof module.summarizeMapRequestTimeline, 'function');
  const result = module.summarizeMapRequestTimeline({ timeline: [request('a', 0, 10, 90, 100), request('b', 0, 10, 90, 100)], modelReady: { a: ready('a', 100), b: ready('b', 100) }, frames: [{ sceneId: 1, submittedAtUnixMs: 110 }] });
  assert.equal(result.requestWallCoverageMs, 100);
  assert.equal(result.summedRequestMs, 200);
  assert.equal(result.overlapMs, 100);
  assert.equal(result.criticalPathVerified, false);
});
test('missing native boundaries and noncausal clocks remain unavailable', () => {
  assert.equal(typeof module.summarizeMapRequestTimeline, 'function');
  const result = module.summarizeMapRequestTimeline({ timeline: [{ ...request('a', 0, 10, 30, 40), nativeTimeline: null }, request('b', 0, 100, 90, 40)], modelReady: {}, frames: [] });
  assert.equal(result.availableModelCount, 0);
  assert.equal(result.models.every((model) => model.available === false), true);
});
