/** Correlated model timelines. Request sums are explicitly not a MAP critical path. */
export function summarizeMapRequestTimeline(snapshot) {
  const timeline = (snapshot?.timeline ?? []).filter((entry) => entry.phase === 'ui-load');
  const groups = new Map();
  const intervals = [];
  for (const entry of timeline) {
    const group = groups.get(entry.modelName) ?? [];
    group.push(entry);
    groups.set(entry.modelName, group);
    if (Number.isFinite(entry.rendererStartedAtUnixMs) && Number.isFinite(entry.rendererCompletedAtUnixMs) && entry.rendererCompletedAtUnixMs >= entry.rendererStartedAtUnixMs) intervals.push([entry.rendererStartedAtUnixMs, entry.rendererCompletedAtUnixMs]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let requestWallCoverageMs = 0;
  let end = Number.NEGATIVE_INFINITY;
  let summedRequestMs = 0;
  for (const [start, finish] of intervals) {
    summedRequestMs += finish - start;
    requestWallCoverageMs += Math.max(0, finish - Math.max(start, end));
    end = Math.max(end, finish);
  }
  const models = [...groups].map(([modelName, requests]) => {
    requests.sort((a, b) => a.rendererStartedAtUnixMs - b.rendererStartedAtUnixMs);
    const unavailable = (reason) => ({ modelName, available: false, reason, requestCount: requests.length });
    if (snapshot?.timelineOverflow) return unavailable('TIMELINE_OVERFLOW');
    const ready = snapshot?.modelReady?.[modelName];
    if (!ready) return unavailable('MODEL_UPLOAD_UNOBSERVED');
    const frame = snapshot.frames?.find((entry) => entry.sceneId === ready.sceneId && entry.submittedAtUnixMs >= ready.readyAtUnixMs);
    if (!frame) return unavailable('MODEL_FIRST_FRAME_UNOBSERVED');
    const phases = { preNativeMs: 0, nativeExecutionMs: 0, returnProcessingMs: 0, firstFrameMs: frame.submittedAtUnixMs - ready.readyAtUnixMs };
    let nativeQueueWaitMs = 0;
    let previousEnd = null;
    for (const request of requests) {
      const native = request.nativeTimeline;
      const points = [request.rendererStartedAtUnixMs, native?.nativeStartedAtUnixMs, native?.nativeCompletedAtUnixMs, request.rendererCompletedAtUnixMs];
      if (native?.schemaVersion !== 1 || !points.every(Number.isFinite)) return unavailable('NATIVE_BOUNDARIES_UNOBSERVED');
      const tolerance = Math.min(5, Math.max(0, native.clockAlignmentToleranceMs ?? 0));
      if (points[2] < points[1] || points[3] < points[0] || points[1] < points[0] - tolerance || points[2] > points[3] + tolerance) return unavailable('CLOCK_ALIGNMENT_NONCAUSAL');
      if (!Number.isFinite(native.nativeEnqueuedAtUnixMs) || native.nativeEnqueuedAtUnixMs < points[0] - tolerance || native.nativeEnqueuedAtUnixMs > points[1] + tolerance) return unavailable('NATIVE_QUEUE_BOUNDARIES_UNOBSERVED');
      nativeQueueWaitMs += Math.max(0, points[1] - native.nativeEnqueuedAtUnixMs);
      if (previousEnd !== null) {
        if (points[0] < previousEnd) return unavailable('MODEL_REQUESTS_OVERLAP');
        phases.returnProcessingMs += points[0] - previousEnd;
      }
      // Native clock calibration is bounded at 5 ms; never silently drop a
      // larger negative interval. Tiny cross-clock jitter stays explicit.
      phases.preNativeMs += Math.max(0, points[1] - points[0]);
      phases.nativeExecutionMs += points[2] - points[1];
      phases.returnProcessingMs += Math.max(0, points[3] - points[2]);
      previousEnd = points[3];
    }
    if (ready.readyAtUnixMs < previousEnd) return unavailable('UPLOAD_PRECEDES_RETURN');
    phases.returnProcessingMs += ready.readyAtUnixMs - previousEnd;
    const endToFirstFrameMs = frame.submittedAtUnixMs - requests[0].rendererStartedAtUnixMs;
    const accountingErrorMs = Object.values(phases).reduce((sum, value) => sum + value, 0) - endToFirstFrameMs;
    return { modelName, available: true, requestCount: requests.length, phases, nativeQueueWaitMs, preNativeMeaning: 'renderer invocation through native start, including IPC, transport, main preparation and native queue wait', endToFirstFrameMs, accountingErrorMs, allowedAccountingErrorMs: requests.length * 10, firstFrameKind: 'renderer-submitted-not-display-presented' };
  });
  return { schemaVersion: 1, unit: 'ms', models, availableModelCount: models.filter((model) => model.available).length, requestWallCoverageMs, summedRequestMs, overlapMs: summedRequestMs - requestWallCoverageMs, criticalPathVerified: false, criticalPathReason: 'Model timelines and overlap coverage are measured; cross-model scheduler dependencies and MAP opening/render milestones are not yet a complete causal DAG' };
}
