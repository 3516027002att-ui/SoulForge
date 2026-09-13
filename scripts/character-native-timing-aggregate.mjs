/**
 * Bounded aggregation for the independent character native timing summary.
 * Static MAP timing remains in map-native-timing-aggregate.mjs; keeping these
 * allowlists separate prevents a role summary from changing the static
 * contract or making an unknown phase look valid.
 */
export const CHARACTER_NATIVE_TIMING_SCHEMA_VERSION = 1;
export const CHARACTER_NATIVE_TIMING_UNIT = 'ms';
export const CHARACTER_NATIVE_TIMING_TOP_LIMIT = 16;
export const CHARACTER_NATIVE_TIMING_PHASES = Object.freeze([
  'queueWaitMs',
  'resolveFlverLeavesMs',
  'flverReadMs',
  'texturePackageResolveMs',
  'texturePreviewMs',
  'materialResolveMs',
  'buildOutputMs',
  'totalMs'
]);
export const CHARACTER_NATIVE_TIMING_BUCKETS = Object.freeze(['direct', 'ui-load']);

const PHASE_SET = new Set(CHARACTER_NATIVE_TIMING_PHASES);
const BUCKET_SET = new Set(CHARACTER_NATIVE_TIMING_BUCKETS);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function emptyPhase() {
  return { count: 0, scopeCount: 0, totalMs: 0, minMs: null, maxMs: null, topSlowMs: [] };
}

function emptyBucket() {
  return {
    ipcCallCount: 0,
    callsWithoutSummary: 0,
    summarySeenCount: 0,
    invalidSummaryCount: 0,
    invalidReasons: [],
    nativeRequestCount: 0,
    nativeTotalMs: 0,
    characterMainWallRequestCount: 0,
    characterMainWallTotalMs: 0,
    characterMainWallMinMs: null,
    characterMainWallMaxMs: null,
    phases: Object.fromEntries(CHARACTER_NATIVE_TIMING_PHASES.map((phase) => [phase, emptyPhase()]))
  };
}

export function createCharacterNativeTimingAccumulator() {
  return {
    ignoredCallCount: 0,
    buckets: Object.fromEntries(CHARACTER_NATIVE_TIMING_BUCKETS.map((bucket) => [bucket, emptyBucket()]))
  };
}

function addTopSlow(target, values) {
  target.push(...values);
  target.sort((left, right) => right - left);
  if (target.length > CHARACTER_NATIVE_TIMING_TOP_LIMIT) target.length = CHARACTER_NATIVE_TIMING_TOP_LIMIT;
}

export function validateCharacterNativeTimingSummary(value) {
  if (!isRecord(value)) return { ok: false, reason: 'SUMMARY_NOT_OBJECT' };
  if (value.schemaVersion !== CHARACTER_NATIVE_TIMING_SCHEMA_VERSION) return { ok: false, reason: 'SUMMARY_SCHEMA_UNSUPPORTED' };
  if (value.unit !== CHARACTER_NATIVE_TIMING_UNIT) return { ok: false, reason: 'SUMMARY_UNIT_UNSUPPORTED' };
  if (value.requestCount !== 1) return { ok: false, reason: 'SUMMARY_REQUEST_COUNT_INVALID' };
  if (!Array.isArray(value.unavailablePhases)) return { ok: false, reason: 'SUMMARY_UNAVAILABLE_PHASES_INVALID' };
  const unavailable = new Set();
  for (const phase of value.unavailablePhases) {
    if (typeof phase !== 'string' || !PHASE_SET.has(phase) || unavailable.has(phase)) {
      return { ok: false, reason: 'SUMMARY_UNAVAILABLE_PHASE_UNKNOWN_OR_DUPLICATE' };
    }
    unavailable.add(phase);
  }
  if (!isRecord(value.phases)) return { ok: false, reason: 'SUMMARY_PHASES_INVALID' };
  const phases = {};
  for (const [phase, raw] of Object.entries(value.phases)) {
    if (!PHASE_SET.has(phase) || !isRecord(raw)) return { ok: false, reason: 'SUMMARY_PHASE_UNKNOWN_OR_INVALID' };
    if (unavailable.has(phase)
      || raw.count !== 1
      || (raw.scopeCount !== undefined && (!Number.isSafeInteger(raw.scopeCount) || raw.scopeCount < 1))
      || !finiteNonNegative(raw.totalMs)
      || !finiteNonNegative(raw.minMs)
      || !finiteNonNegative(raw.maxMs)
      || raw.minMs > raw.maxMs
      || !Array.isArray(raw.topSlowMs)
      || raw.topSlowMs.length !== 1
      || raw.topSlowMs.some((item) => !finiteNonNegative(item))) {
      return { ok: false, reason: 'SUMMARY_PHASE_VALUE_INVALID' };
    }
    if (raw.minMs !== raw.maxMs || raw.maxMs !== raw.totalMs || raw.topSlowMs[0] !== raw.totalMs) {
      return { ok: false, reason: 'SUMMARY_PHASE_SAMPLE_INCONSISTENT' };
    }
    phases[phase] = {
      count: 1,
      scopeCount: raw.scopeCount ?? 1,
      totalMs: raw.totalMs,
      minMs: raw.minMs,
      maxMs: raw.maxMs,
      topSlowMs: [...raw.topSlowMs]
    };
  }
  for (const phase of CHARACTER_NATIVE_TIMING_PHASES) {
    if (!phases[phase] && !unavailable.has(phase)) return { ok: false, reason: 'SUMMARY_PHASE_MISSING' };
  }
  if (!phases.queueWaitMs || !phases.totalMs || unavailable.has('queueWaitMs') || unavailable.has('totalMs')) {
    return { ok: false, reason: 'SUMMARY_REQUIRED_PHASE_MISSING' };
  }
  return { ok: true, value: { requestCount: value.requestCount, phases } };
}

function recordInvalid(bucket, reason) {
  bucket.invalidSummaryCount += 1;
  if (bucket.invalidReasons.length < CHARACTER_NATIVE_TIMING_TOP_LIMIT && !bucket.invalidReasons.includes(reason)) {
    bucket.invalidReasons.push(reason);
  }
}

/** Record every IPC call; only a valid first-page role summary increments nativeRequestCount. */
export function recordCharacterNativeTimingCall(accumulator, bucketName, summary, mainWallMs) {
  if (!isRecord(accumulator?.buckets) || !BUCKET_SET.has(bucketName)) {
    if (accumulator && Number.isSafeInteger(accumulator.ignoredCallCount)) accumulator.ignoredCallCount += 1;
    return { accepted: false, reason: 'BUCKET_IGNORED' };
  }
  const bucket = accumulator.buckets[bucketName];
  bucket.ipcCallCount += 1;
  if (summary === null || summary === undefined) {
    bucket.callsWithoutSummary += 1;
    return { accepted: false, reason: 'NO_SUMMARY' };
  }
  bucket.summarySeenCount += 1;
  const validated = validateCharacterNativeTimingSummary(summary);
  if (!validated.ok) {
    recordInvalid(bucket, validated.reason);
    return { accepted: false, reason: validated.reason };
  }
  const value = validated.value;
  bucket.nativeRequestCount += value.requestCount;
  for (const [phase, phaseValue] of Object.entries(value.phases)) {
    const aggregate = bucket.phases[phase];
    aggregate.count += phaseValue.count;
    aggregate.scopeCount += phaseValue.scopeCount;
    aggregate.totalMs += phaseValue.totalMs;
    aggregate.minMs = aggregate.minMs === null ? phaseValue.minMs : Math.min(aggregate.minMs, phaseValue.minMs);
    aggregate.maxMs = aggregate.maxMs === null ? phaseValue.maxMs : Math.max(aggregate.maxMs, phaseValue.maxMs);
    addTopSlow(aggregate.topSlowMs, phaseValue.topSlowMs);
    if (phase === 'totalMs') bucket.nativeTotalMs += phaseValue.totalMs;
  }
  if (finiteNonNegative(mainWallMs)) {
    bucket.characterMainWallRequestCount += 1;
    bucket.characterMainWallTotalMs += mainWallMs;
    bucket.characterMainWallMinMs = bucket.characterMainWallMinMs === null
      ? mainWallMs : Math.min(bucket.characterMainWallMinMs, mainWallMs);
    bucket.characterMainWallMaxMs = bucket.characterMainWallMaxMs === null
      ? mainWallMs : Math.max(bucket.characterMainWallMaxMs, mainWallMs);
  }
  return { accepted: true, value };
}

function snapshotBucket(bucket) {
  return {
    ipcCallCount: bucket.ipcCallCount,
    callsWithoutSummary: bucket.callsWithoutSummary,
    summarySeenCount: bucket.summarySeenCount,
    invalidSummaryCount: bucket.invalidSummaryCount,
    invalidReasons: [...bucket.invalidReasons],
    nativeRequestCount: bucket.nativeRequestCount,
    nativeTotalMs: bucket.nativeTotalMs,
    mainWallMs: {
      requestCount: bucket.characterMainWallRequestCount,
      totalMs: bucket.characterMainWallTotalMs,
      minMs: bucket.characterMainWallMinMs,
      maxMs: bucket.characterMainWallMaxMs
    },
    phases: Object.fromEntries(CHARACTER_NATIVE_TIMING_PHASES.map((phase) => {
      const value = bucket.phases[phase];
      return [phase, {
        count: value.count,
        scopeCount: value.scopeCount,
        totalMs: value.totalMs,
        minMs: value.minMs,
        maxMs: value.maxMs,
        topSlowMs: [...value.topSlowMs]
      }];
    }))
  };
}

export function snapshotCharacterNativeTimingAccumulator(accumulator) {
  const source = accumulator && isRecord(accumulator.buckets) ? accumulator : createCharacterNativeTimingAccumulator();
  return {
    schemaVersion: CHARACTER_NATIVE_TIMING_SCHEMA_VERSION,
    unit: CHARACTER_NATIVE_TIMING_UNIT,
    ignoredCallCount: Number.isSafeInteger(source.ignoredCallCount) ? source.ignoredCallCount : 0,
    buckets: Object.fromEntries(CHARACTER_NATIVE_TIMING_BUCKETS.map((bucket) => [
      bucket,
      snapshotBucket(source.buckets[bucket] ?? emptyBucket())
    ]))
  };
}
