/**
 * Bounded aggregation for the main-process character timing summary.
 *
 * This is intentionally separate from character-native-timing-aggregate.mjs:
 * native phases measure the Bridge command, while these phases measure the
 * Electron main handler around that command and its first page construction.
 */
import {
  createBridgeTransportTimingAccumulator,
  recordBridgeTransportTimingCall,
  snapshotBridgeTransportTimingAccumulator,
  validateBridgeTransportTimingSummary
} from './bridge-transport-timing-aggregate.mjs';

export const CHARACTER_MAIN_TIMING_SCHEMA_VERSION = 1;
export const CHARACTER_MAIN_TIMING_UNIT = 'ms';
export const CHARACTER_MAIN_TIMING_TOP_LIMIT = 16;
export const CHARACTER_MAIN_TIMING_PHASES = Object.freeze([
  'optionsPrepareMs',
  'bridgeAwaitMs',
  'bundleValidateMs',
  'compatibilityMs',
  'chunkBuildMs',
  'pageFirstMs',
  'totalMs'
]);
export const CHARACTER_MAIN_TIMING_BUCKETS = Object.freeze(['direct', 'ui-load']);

const PHASE_SET = new Set(CHARACTER_MAIN_TIMING_PHASES);
const BUCKET_SET = new Set(CHARACTER_MAIN_TIMING_BUCKETS);
const PHASE_STATUSES = new Set(['measured', 'skipped', 'unavailable']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function emptyPhase() {
  return { count: 0, totalMs: 0, minMs: null, maxMs: null, topSlowMs: [] };
}

function emptyCoverage() {
  return { measuredSummaryCount: 0, skippedSummaryCount: 0, unavailableSummaryCount: 0 };
}

function emptyBucket() {
  return {
    ipcCallCount: 0,
    callsWithoutSummary: 0,
    summarySeenCount: 0,
    invalidSummaryCount: 0,
    invalidReasons: [],
    requestCount: 0,
    totalMs: 0,
    mainWallMs: {
      requestCount: 0,
      totalMs: 0,
      minMs: null,
      maxMs: null
    },
    phases: Object.fromEntries(CHARACTER_MAIN_TIMING_PHASES.map((phase) => [phase, emptyPhase()])),
    phaseCoverage: Object.fromEntries(CHARACTER_MAIN_TIMING_PHASES.map((phase) => [phase, emptyCoverage()])),
    transport: createBridgeTransportTimingAccumulator()
  };
}

export function createCharacterMainTimingAccumulator() {
  return {
    ignoredCallCount: 0,
    buckets: Object.fromEntries(CHARACTER_MAIN_TIMING_BUCKETS.map((bucket) => [bucket, emptyBucket()]))
  };
}

function addTopSlow(target, values) {
  target.push(...values);
  target.sort((left, right) => right - left);
  if (target.length > CHARACTER_MAIN_TIMING_TOP_LIMIT) target.length = CHARACTER_MAIN_TIMING_TOP_LIMIT;
}

function validPhaseOrder(value) {
  return Array.isArray(value)
    && value.length === CHARACTER_MAIN_TIMING_PHASES.length
    && value.every((phase, index) => phase === CHARACTER_MAIN_TIMING_PHASES[index]);
}

function validUniquePhaseList(value) {
  if (!Array.isArray(value)) return null;
  const result = new Set();
  for (const phase of value) {
    if (typeof phase !== 'string' || !PHASE_SET.has(phase) || result.has(phase)) return null;
    result.add(phase);
  }
  return result;
}

function invalid(reason) {
  return { ok: false, reason };
}

/** Validate and normalize one main-process timing summary. */
export function validateCharacterMainTimingSummary(value) {
  if (!isRecord(value)) return invalid('SUMMARY_NOT_OBJECT');
  if (value.schemaVersion !== CHARACTER_MAIN_TIMING_SCHEMA_VERSION) return invalid('SUMMARY_SCHEMA_UNSUPPORTED');
  if (value.unit !== CHARACTER_MAIN_TIMING_UNIT) return invalid('SUMMARY_UNIT_UNSUPPORTED');
  if (value.requestCount !== 1) return invalid('SUMMARY_REQUEST_COUNT_INVALID');
  if (!['ok', 'failed', 'empty'].includes(value.outcome)) return invalid('SUMMARY_OUTCOME_INVALID');
  if (!validPhaseOrder(value.phaseOrder)) return invalid('SUMMARY_PHASE_ORDER_INVALID');
  const unavailable = validUniquePhaseList(value.unavailablePhases);
  const skipped = validUniquePhaseList(value.skippedPhases);
  if (!unavailable || !skipped) return invalid('SUMMARY_PHASE_LIST_INVALID');
  for (const phase of skipped) {
    if (unavailable.has(phase)) return invalid('SUMMARY_PHASE_STATUS_OVERLAP');
  }
  if (!isRecord(value.phaseStatus)) return invalid('SUMMARY_PHASE_STATUS_INVALID');
  for (const phase of CHARACTER_MAIN_TIMING_PHASES) {
    const status = value.phaseStatus[phase];
    if (!PHASE_STATUSES.has(status)) return invalid('SUMMARY_PHASE_STATUS_INVALID');
    if (status === 'unavailable' && !unavailable.has(phase)) return invalid('SUMMARY_UNAVAILABLE_STATUS_MISMATCH');
    if (status === 'skipped' && !skipped.has(phase)) return invalid('SUMMARY_SKIPPED_STATUS_MISMATCH');
    if (status === 'measured' && (unavailable.has(phase) || skipped.has(phase))) {
      return invalid('SUMMARY_MEASURED_STATUS_MISMATCH');
    }
  }
  if (!isRecord(value.phases)) return invalid('SUMMARY_PHASES_INVALID');
  const phases = {};
  for (const [phase, raw] of Object.entries(value.phases)) {
    if (!PHASE_SET.has(phase) || !isRecord(raw)) return invalid('SUMMARY_PHASE_UNKNOWN_OR_INVALID');
    const status = value.phaseStatus[phase];
    if (status === 'measured') {
      if (raw.count !== 1
        || !finiteNonNegative(raw.totalMs)
        || !finiteNonNegative(raw.minMs)
        || !finiteNonNegative(raw.maxMs)
        || raw.minMs > raw.maxMs
        || !Array.isArray(raw.topSlowMs)
        || raw.topSlowMs.length !== 1
        || raw.topSlowMs.some((item) => !finiteNonNegative(item))
        || raw.minMs !== raw.maxMs
        || raw.maxMs !== raw.totalMs
        || raw.topSlowMs[0] !== raw.totalMs) {
        return invalid('SUMMARY_MEASURED_PHASE_INVALID');
      }
      phases[phase] = {
        count: 1,
        totalMs: raw.totalMs,
        minMs: raw.minMs,
        maxMs: raw.maxMs,
        topSlowMs: [...raw.topSlowMs]
      };
    } else {
      if (raw.count !== 0 || raw.totalMs !== 0 || raw.minMs !== null || raw.maxMs !== null
        || !Array.isArray(raw.topSlowMs) || raw.topSlowMs.length !== 0) {
        return invalid('SUMMARY_NON_MEASURED_PHASE_INVALID');
      }
      phases[phase] = emptyPhase();
    }
  }
  for (const phase of CHARACTER_MAIN_TIMING_PHASES) {
    if (!Object.prototype.hasOwnProperty.call(phases, phase)) return invalid('SUMMARY_PHASE_MISSING');
  }
  if (value.phaseStatus.totalMs !== 'measured' || !phases.totalMs) {
    return invalid('SUMMARY_TOTAL_PHASE_MISSING');
  }
  let transport;
  if (value.transport !== undefined) {
    const validatedTransport = validateBridgeTransportTimingSummary(value.transport);
    if (!validatedTransport.ok) return invalid(`SUMMARY_TRANSPORT_${validatedTransport.reason}`);
    transport = validatedTransport.value;
  }
  return {
    ok: true,
    value: {
      requestCount: value.requestCount,
      outcome: value.outcome,
      phases,
      phaseStatus: Object.fromEntries(CHARACTER_MAIN_TIMING_PHASES.map((phase) => [phase, value.phaseStatus[phase]])),
      ...(transport === undefined ? {} : { transport })
    }
  };
}

function recordInvalid(bucket, reason) {
  bucket.invalidSummaryCount += 1;
  if (bucket.invalidReasons.length < CHARACTER_MAIN_TIMING_TOP_LIMIT && !bucket.invalidReasons.includes(reason)) {
    bucket.invalidReasons.push(reason);
  }
}

/** Record every IPC call; only a valid first-page main summary adds a sample. */
export function recordCharacterMainTimingCall(accumulator, bucketName, summary, mainWallMs) {
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
  const validated = validateCharacterMainTimingSummary(summary);
  if (!validated.ok) {
    recordInvalid(bucket, validated.reason);
    return { accepted: false, reason: validated.reason };
  }
  const value = validated.value;
  bucket.requestCount += value.requestCount;
  bucket.totalMs += value.phases.totalMs.totalMs;
  for (const phase of CHARACTER_MAIN_TIMING_PHASES) {
    const status = value.phaseStatus[phase];
    const coverage = bucket.phaseCoverage[phase];
    if (status === 'measured') {
      coverage.measuredSummaryCount += 1;
      const phaseValue = value.phases[phase];
      const aggregate = bucket.phases[phase];
      aggregate.count += phaseValue.count;
      aggregate.totalMs += phaseValue.totalMs;
      aggregate.minMs = aggregate.minMs === null ? phaseValue.minMs : Math.min(aggregate.minMs, phaseValue.minMs);
      aggregate.maxMs = aggregate.maxMs === null ? phaseValue.maxMs : Math.max(aggregate.maxMs, phaseValue.maxMs);
      addTopSlow(aggregate.topSlowMs, phaseValue.topSlowMs);
    } else if (status === 'skipped') {
      coverage.skippedSummaryCount += 1;
    } else {
      coverage.unavailableSummaryCount += 1;
    }
  }
  if (finiteNonNegative(mainWallMs)) {
    bucket.mainWallMs.requestCount += 1;
    bucket.mainWallMs.totalMs += mainWallMs;
    bucket.mainWallMs.minMs = bucket.mainWallMs.minMs === null ? mainWallMs : Math.min(bucket.mainWallMs.minMs, mainWallMs);
    bucket.mainWallMs.maxMs = bucket.mainWallMs.maxMs === null ? mainWallMs : Math.max(bucket.mainWallMs.maxMs, mainWallMs);
  }
  recordBridgeTransportTimingCall(bucket.transport, value.transport ?? null);
  return { accepted: true, value };
}

function snapshotBucket(bucket) {
  return {
    ipcCallCount: bucket.ipcCallCount,
    callsWithoutSummary: bucket.callsWithoutSummary,
    summarySeenCount: bucket.summarySeenCount,
    invalidSummaryCount: bucket.invalidSummaryCount,
    invalidReasons: [...bucket.invalidReasons],
    requestCount: bucket.requestCount,
    totalMs: bucket.totalMs,
    mainWallMs: { ...bucket.mainWallMs },
    phases: Object.fromEntries(CHARACTER_MAIN_TIMING_PHASES.map((phase) => {
      const value = bucket.phases[phase];
      return [phase, {
        count: value.count,
        totalMs: value.totalMs,
        minMs: value.minMs,
        maxMs: value.maxMs,
        topSlowMs: [...value.topSlowMs]
      }];
    })),
    phaseCoverage: Object.fromEntries(CHARACTER_MAIN_TIMING_PHASES.map((phase) => [
      phase,
      { ...bucket.phaseCoverage[phase] }
    ])),
    transport: snapshotBridgeTransportTimingAccumulator(bucket.transport)
  };
}

export function snapshotCharacterMainTimingAccumulator(accumulator) {
  const source = accumulator && isRecord(accumulator.buckets)
    ? accumulator
    : createCharacterMainTimingAccumulator();
  return {
    schemaVersion: CHARACTER_MAIN_TIMING_SCHEMA_VERSION,
    unit: CHARACTER_MAIN_TIMING_UNIT,
    ignoredCallCount: Number.isSafeInteger(source.ignoredCallCount) ? source.ignoredCallCount : 0,
    buckets: Object.fromEntries(CHARACTER_MAIN_TIMING_BUCKETS.map((bucket) => [
      bucket,
      snapshotBucket(source.buckets[bucket] ?? emptyBucket())
    ]))
  };
}
