/** Correlated model timelines. Request sums are explicitly not a MAP critical path. */
export function mapModelTimelineKey(identity) {
  if (!identity || !Number.isSafeInteger(identity.sceneId) || identity.sceneId < 1
    || !['modelName', 'loadId', 'sourceUri'].every((key) => typeof identity[key] === 'string' && identity[key].length > 0)
    || typeof identity.sourceRevision !== 'string' || !/^[0-9a-f]{64}$/i.test(identity.sourceRevision)) return null;
  return JSON.stringify([identity.sceneId, identity.loadId, identity.sourceUri, identity.sourceRevision, identity.modelName]);
}

function projectPostReturn(request, ready) {
  const unavailable = (reason) => ({ available: false, reason, sourceBindingScope: 'logical-map-document-revision-and-load' });
  const raw = ready.postReturn;
  if (raw?.schemaVersion !== 1 || !raw.preparation || !raw.upload) return unavailable('POST_RETURN_BOUNDARIES_UNOBSERVED');
  const prepare = raw.preparation, upload = raw.upload;
  if (typeof raw.preparedJobId !== 'string' || raw.preparedJobId.length === 0 || raw.preparedJobId !== prepare.jobId) return unavailable('PREPARE_IDENTITY_MISMATCH');
  if (prepare.status !== 'completed') return unavailable('PREPARATION_NOT_COMPLETED');
  const origins = [request.rendererTimeOrigin, prepare.timeOriginAtEnqueue, prepare.timeOriginAtCompletion, upload.timeOriginAtEnqueue, upload.timeOriginAtStart, upload.timeOriginAtCompletion];
  if (!origins.every(Number.isFinite)) return unavailable('RENDERER_CLOCK_ORIGIN_UNOBSERVED');
  if (!origins.every((origin) => origin === origins[0])) return unavailable('RENDERER_CLOCK_ORIGIN_CHANGED');
  const preparationPoints = [prepare.enqueuedAtMs, prepare.startedAtMs, prepare.completedAtMs];
  if (!preparationPoints.every(Number.isFinite)) return unavailable('PREPARE_BOUNDARIES_UNOBSERVED');
  if (prepare.startedAtMs < prepare.enqueuedAtMs || prepare.completedAtMs < prepare.startedAtMs) return unavailable('PREPARE_BOUNDARIES_NONCAUSAL');
  const uploadPoints = [upload.enqueuedAtMs, upload.startedAtMs, upload.completedAtMs];
  if (!uploadPoints.every(Number.isFinite)) return unavailable('UPLOAD_BOUNDARIES_UNOBSERVED');
  if (upload.startedAtMs < upload.enqueuedAtMs || upload.completedAtMs < upload.startedAtMs) return unavailable('UPLOAD_BOUNDARIES_NONCAUSAL');
  const origin = origins[0];
  const returnAt = request.rendererCompletedAtUnixMs;
  if (origin + prepare.enqueuedAtMs < returnAt) return unavailable('PREPARE_PRECEDES_FINAL_RETURN');
  if (upload.enqueuedAtMs < prepare.completedAtMs) return unavailable('UPLOAD_PRECEDES_PREPARE_COMPLETE');
  if (ready.readyAtUnixMs !== origin + upload.completedAtMs) return unavailable('REPLACEMENT_READY_BOUNDARY_MISMATCH');
  const phases = {
    beforePrepareMs: origin + prepare.enqueuedAtMs - returnAt,
    prepareQueueMs: prepare.startedAtMs - prepare.enqueuedAtMs,
    prepareTurnaroundMs: prepare.completedAtMs - prepare.startedAtMs,
    beforeUploadMs: upload.enqueuedAtMs - prepare.completedAtMs,
    uploadQueueMs: upload.startedAtMs - upload.enqueuedAtMs,
    replacementMs: upload.completedAtMs - upload.startedAtMs
  };
  const measuredTailMs = ready.readyAtUnixMs - returnAt;
  const workerDurationKnown = Number.isFinite(prepare.reportedWorkerDurationMs) && prepare.reportedWorkerDurationMs >= 0;
  return {
    available: true,
    sourceBindingScope: 'logical-map-document-revision-and-load',
    geometryPhysicalSourceHash: 'unobserved',
    phases,
    measuredTailMs,
    accountingErrorMs: Object.values(phases).reduce((sum, value) => sum + value, 0) - measuredTailMs,
    containedWithin: 'returnProcessingMs',
    replacementKind: 'synchronous-renderer-callback-not-GPU-completion',
    workerDurationStatus: workerDurationKnown ? 'reported' : 'unavailable',
    ...(workerDurationKnown ? { reportedWorkerDurationMs: prepare.reportedWorkerDurationMs } : { workerDurationReason: 'WORKER_DURATION_UNOBSERVED' }),
    workerDurationAccounting: 'diagnostic-contained-within-renderer-turnaround-not-added'
  };
}

export function summarizeMapRequestTimeline(snapshot) {
  const timeline = (snapshot?.timeline ?? []).filter((entry) => entry.phase === 'ui-load');
  const groups = new Map();
  const intervals = [];
  for (const [index, entry] of timeline.entries()) {
    const key = mapModelTimelineKey(entry) ?? `unbound:${index}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
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
  const models = [...groups].map(([key, requests]) => {
    requests.sort((a, b) => a.rendererStartedAtUnixMs - b.rendererStartedAtUnixMs);
    const { modelName, loadId, sourceUri, sourceRevision, sceneId } = requests[0];
    const binding = { modelName, loadId, sourceUri, sourceRevision, sceneId };
    const unavailable = (reason) => ({ ...binding, available: false, reason, requestCount: requests.length });
    if (mapModelTimelineKey(binding) === null) return unavailable('MODEL_IDENTITY_UNOBSERVED');
    if (snapshot?.timelineOverflow) return unavailable('TIMELINE_OVERFLOW');
    const ready = snapshot?.modelReady?.[key]
      ?? Object.values(snapshot?.modelReady ?? {}).find((entry) => mapModelTimelineKey(entry) === key);
    if (!ready) return unavailable('MODEL_UPLOAD_UNOBSERVED');
    if (!Number.isFinite(ready.readyAtUnixMs)) return unavailable('MODEL_READY_CLOCK_UNOBSERVED');
    const frame = snapshot.frames?.find((entry) => entry.sceneId === ready.sceneId && Number.isFinite(entry.submittedAtUnixMs) && entry.submittedAtUnixMs >= ready.readyAtUnixMs);
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
    return { ...binding, available: true, requestCount: requests.length, phases, postReturn: projectPostReturn(requests.at(-1), ready), nativeQueueWaitMs, preNativeMeaning: 'renderer invocation through native start, including IPC, transport, main preparation and native queue wait', endToFirstFrameMs, accountingErrorMs, allowedAccountingErrorMs: requests.length * 10, firstFrameKind: 'renderer-submitted-not-display-presented' };
  });
  return { schemaVersion: 1, unit: 'ms', models, availableModelCount: models.filter((model) => model.available).length, requestWallCoverageMs, summedRequestMs, overlapMs: summedRequestMs - requestWallCoverageMs, criticalPathVerified: false, criticalPathReason: 'Model timelines and overlap coverage are measured; cross-model scheduler dependencies and MAP opening/render milestones are not yet a complete causal DAG' };
}
