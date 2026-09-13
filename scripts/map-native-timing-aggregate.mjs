/**
 * Shared, bounded aggregation for MAP native timing summaries.
 *
 * The production main harness and its probe both consume the same helper so
 * the fixture exercises the exact validation/aggregation path used by a real
 * MAP run.  This module is deliberately free of Electron, filesystem, and
 * renderer dependencies; it is copied into immutable production snapshots
 * because production-main.mjs imports it from the snapshot root.
 */

export const MAP_NATIVE_TIMING_SCHEMA_VERSION = 1;
export const MAP_NATIVE_TIMING_UNIT = 'ms';
export const MAP_NATIVE_TIMING_TOP_LIMIT = 16;

export const MAP_NATIVE_TIMING_PHASES = Object.freeze([
  'queueWaitMs',
  'fileReadMs',
  'sourceHashMs',
  'sessionLookupMs',
  'bndResolveMs',
  'flverReadMs',
  'sessionCreateMs',
  'resourceAcquireMs',
  'textureResolveManyMs',
  'buildChunkMs',
  'serializeMs',
  'totalMs'
]);

export const MAP_NATIVE_TIMING_BUCKETS = Object.freeze(['direct', 'ui-load']);

const PHASE_SET = new Set(MAP_NATIVE_TIMING_PHASES);
const BUCKET_SET = new Set(MAP_NATIVE_TIMING_BUCKETS);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function invalid(reason) {
  return { ok: false, reason };
}

function clonePhaseStats(value) {
  return {
    count: value.count,
    totalMs: value.totalMs,
    minMs: value.minMs,
    maxMs: value.maxMs,
    topSlowMs: [...value.topSlowMs]
  };
}

/**
 * Validate one MAP_NATIVE_TIMING_SUMMARY diagnostic payload.
 *
 * Validation is intentionally fail-closed: unknown phase names, malformed
 * numbers, and oversized top lists are rejected instead of being silently
 * folded into an apparently complete timing result.
 */
export function validateMapNativeTimingSummary(value) {
  if (!isRecord(value)) return invalid('SUMMARY_NOT_OBJECT');
  if (value.schemaVersion !== MAP_NATIVE_TIMING_SCHEMA_VERSION) {
    return invalid('SUMMARY_SCHEMA_UNSUPPORTED');
  }
  if (value.unit !== MAP_NATIVE_TIMING_UNIT) return invalid('SUMMARY_UNIT_UNSUPPORTED');
  if (!Number.isSafeInteger(value.requestCount) || value.requestCount < 0) {
    return invalid('SUMMARY_REQUEST_COUNT_INVALID');
  }
  if (!Array.isArray(value.unavailablePhases)) return invalid('SUMMARY_UNAVAILABLE_PHASES_INVALID');

  const unavailablePhases = [];
  const unavailableSet = new Set();
  for (const phase of value.unavailablePhases) {
    if (typeof phase !== 'string' || !PHASE_SET.has(phase)) {
      return invalid('SUMMARY_UNAVAILABLE_PHASE_UNKNOWN');
    }
    if (unavailableSet.has(phase)) return invalid('SUMMARY_UNAVAILABLE_PHASE_DUPLICATE');
    unavailableSet.add(phase);
    unavailablePhases.push(phase);
  }

  if (!isRecord(value.phases)) return invalid('SUMMARY_PHASES_INVALID');
  const phases = {};
  for (const [phase, raw] of Object.entries(value.phases)) {
    if (!PHASE_SET.has(phase)) return invalid('SUMMARY_PHASE_UNKNOWN');
    if (!isRecord(raw)) return invalid('SUMMARY_PHASE_NOT_OBJECT');
    // Production's session aggregate keeps a phase observed on an earlier
    // page while its unavailablePhases field is a union across all pages;
    // therefore a phase may be present in both collections legitimately.
    if (!Number.isSafeInteger(raw.count) || raw.count < 0) {
      return invalid('SUMMARY_PHASE_COUNT_INVALID');
    }
    if (!isFiniteNonNegative(raw.totalMs)
      || !isFiniteNonNegative(raw.minMs)
      || !isFiniteNonNegative(raw.maxMs)
      || raw.minMs > raw.maxMs) {
      return invalid('SUMMARY_PHASE_VALUE_INVALID');
    }
    if (!Array.isArray(raw.topSlowMs) || raw.topSlowMs.length > MAP_NATIVE_TIMING_TOP_LIMIT) {
      return invalid('SUMMARY_PHASE_TOP_SLOW_INVALID');
    }
    const topSlowMs = [];
    for (const duration of raw.topSlowMs) {
      if (!isFiniteNonNegative(duration)) return invalid('SUMMARY_PHASE_TOP_SLOW_VALUE_INVALID');
      topSlowMs.push(duration);
    }
    phases[phase] = {
      count: raw.count,
      totalMs: raw.totalMs,
      minMs: raw.minMs,
      maxMs: raw.maxMs,
      topSlowMs
    };
  }

  return {
    ok: true,
    value: {
      schemaVersion: MAP_NATIVE_TIMING_SCHEMA_VERSION,
      unit: MAP_NATIVE_TIMING_UNIT,
      requestCount: value.requestCount,
      unavailablePhases,
      phases
    }
  };
}

function emptyPhaseAggregate() {
  return {
    count: 0,
    totalMs: 0,
    minMs: null,
    maxMs: null,
    topSlowMs: []
  };
}

function emptyPhaseCoverage() {
  return {
    observedSummaryCount: 0,
    unavailableSummaryCount: 0,
    missingSummaryCount: 0,
    coverage: 'no-observations'
  };
}

function emptyBucket() {
  return {
    callCount: 0,
    summarySeenCount: 0,
    summaryCount: 0,
    invalidSummaryCount: 0,
    callsWithoutSummary: 0,
    requestCount: 0,
    invalidReasons: [],
    phases: Object.fromEntries(MAP_NATIVE_TIMING_PHASES.map((phase) => [phase, emptyPhaseAggregate()])),
    phaseCoverage: Object.fromEntries(MAP_NATIVE_TIMING_PHASES.map((phase) => [phase, emptyPhaseCoverage()]))
  };
}

/** Create the mutable accumulator used by the harness, probe, and fixtures. */
export function createMapNativeTimingAccumulator() {
  return {
    ignoredCallCount: 0,
    buckets: Object.fromEntries(MAP_NATIVE_TIMING_BUCKETS.map((bucket) => [bucket, emptyBucket()]))
  };
}

function addTopSlowValues(target, values) {
  target.push(...values);
  target.sort((left, right) => right - left);
  if (target.length > MAP_NATIVE_TIMING_TOP_LIMIT) target.length = MAP_NATIVE_TIMING_TOP_LIMIT;
}

function recordInvalid(bucket, reason) {
  bucket.invalidSummaryCount += 1;
  if (bucket.invalidReasons.length < MAP_NATIVE_TIMING_TOP_LIMIT && !bucket.invalidReasons.includes(reason)) {
    bucket.invalidReasons.push(reason);
  }
}

/**
 * Record one IPC request.  `bucketName` must be captured at request start by
 * the caller; this function never reads a later/current phase, which keeps an
 * in-flight request from crossing direct -> ui-load boundaries incorrectly.
 */
export function recordMapNativeTimingCall(accumulator, bucketName, summary) {
  if (!isRecord(accumulator?.buckets) || !BUCKET_SET.has(bucketName)) {
    if (accumulator && Number.isSafeInteger(accumulator.ignoredCallCount)) accumulator.ignoredCallCount += 1;
    return { accepted: false, reason: 'BUCKET_IGNORED' };
  }
  const bucket = accumulator.buckets[bucketName];
  bucket.callCount += 1;
  if (summary === null || summary === undefined) {
    bucket.callsWithoutSummary += 1;
    return { accepted: false, reason: 'NO_SUMMARY' };
  }
  bucket.summarySeenCount += 1;
  const validated = validateMapNativeTimingSummary(summary);
  if (!validated.ok) {
    recordInvalid(bucket, validated.reason);
    return { accepted: false, reason: validated.reason };
  }

  const value = validated.value;
  bucket.summaryCount += 1;
  bucket.requestCount += value.requestCount;
  for (const phase of MAP_NATIVE_TIMING_PHASES) {
    const coverage = bucket.phaseCoverage[phase];
    const phaseValue = value.phases[phase];
    const unavailable = value.unavailablePhases.includes(phase);
    if (unavailable) coverage.unavailableSummaryCount += 1;
    if (!phaseValue) {
      if (!unavailable) coverage.missingSummaryCount += 1;
      continue;
    }
    coverage.observedSummaryCount += 1;
    const aggregate = bucket.phases[phase];
    aggregate.count += phaseValue.count;
    aggregate.totalMs += phaseValue.totalMs;
    aggregate.minMs = aggregate.minMs === null
      ? phaseValue.minMs
      : Math.min(aggregate.minMs, phaseValue.minMs);
    aggregate.maxMs = aggregate.maxMs === null
      ? phaseValue.maxMs
      : Math.max(aggregate.maxMs, phaseValue.maxMs);
    addTopSlowValues(aggregate.topSlowMs, phaseValue.topSlowMs);
  }
  return { accepted: true, value };
}

function phaseCoverageSnapshot(bucket, phase) {
  const coverage = bucket.phaseCoverage[phase];
  const hasObserved = coverage.observedSummaryCount > 0;
  const hasUnavailable = coverage.unavailableSummaryCount > 0;
  const hasMissing = coverage.missingSummaryCount > 0;
  let status = 'no-observations';
  if (hasObserved && !hasUnavailable && !hasMissing) status = 'complete';
  else if (!hasObserved && hasUnavailable && !hasMissing) status = 'unavailable';
  else if (hasObserved || hasUnavailable || hasMissing) status = 'partial-coverage';
  return {
    ...coverage,
    coverage: status
  };
}

function bucketSnapshot(bucket) {
  const hasNoSummaryCalls = bucket.callsWithoutSummary > 0;
  const hasInvalidSummaries = bucket.invalidSummaryCount > 0;
  let status = 'no-observations';
  if (bucket.summaryCount > 0) {
    const phaseCoverageValues = MAP_NATIVE_TIMING_PHASES.map((phase) => phaseCoverageSnapshot(bucket, phase));
    const hasPartialPhase = phaseCoverageValues.some((coverage) => coverage.coverage !== 'complete');
    status = hasNoSummaryCalls || hasInvalidSummaries || hasPartialPhase ? 'partial-coverage' : 'complete';
  } else if (bucket.callCount > 0 && (hasNoSummaryCalls || hasInvalidSummaries)) {
    status = 'no-observations';
  }
  const phases = {};
  const phaseCoverage = {};
  const unavailablePhases = [];
  const partialUnavailablePhases = [];
  for (const phase of MAP_NATIVE_TIMING_PHASES) {
    const aggregate = bucket.phases[phase];
    phases[phase] = clonePhaseStats(aggregate);
    phaseCoverage[phase] = phaseCoverageSnapshot(bucket, phase);
    if (phaseCoverage[phase].coverage === 'unavailable') unavailablePhases.push(phase);
    if (phaseCoverage[phase].coverage === 'partial-coverage'
      && phaseCoverage[phase].unavailableSummaryCount > 0) {
      partialUnavailablePhases.push(phase);
    }
  }
  return {
    callCount: bucket.callCount,
    summarySeenCount: bucket.summarySeenCount,
    summaryCount: bucket.summaryCount,
    invalidSummaryCount: bucket.invalidSummaryCount,
    callsWithoutSummary: bucket.callsWithoutSummary,
    requestCount: bucket.requestCount,
    invalidReasons: [...bucket.invalidReasons],
    coverage: {
      status,
      unavailablePhases,
      partialUnavailablePhases,
      phaseCoverage
    },
    phases
  };
}

/** Return a JSON-safe bounded snapshot of all direct/ui-load buckets. */
export function snapshotMapNativeTimingAccumulator(accumulator) {
  const source = accumulator && isRecord(accumulator.buckets)
    ? accumulator
    : createMapNativeTimingAccumulator();
  return {
    schemaVersion: MAP_NATIVE_TIMING_SCHEMA_VERSION,
    unit: MAP_NATIVE_TIMING_UNIT,
    ignoredCallCount: Number.isSafeInteger(source.ignoredCallCount) ? source.ignoredCallCount : 0,
    buckets: Object.fromEntries(MAP_NATIVE_TIMING_BUCKETS.map((bucket) => [
      bucket,
      bucketSnapshot(source.buckets[bucket] ?? emptyBucket())
    ]))
  };
}
