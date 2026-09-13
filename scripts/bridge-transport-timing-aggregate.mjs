/**
 * Bounded aggregation for the client-side Bridge transport timing nested in
 * CHARACTER_MAIN_TIMING_SUMMARY. Native MAP/character timing remains in its
 * own schemas and is never folded into these metrics.
 */
export const BRIDGE_TRANSPORT_TIMING_SCHEMA_VERSION = 1;
export const BRIDGE_TRANSPORT_TIMING_UNIT = 'ms';
export const BRIDGE_TRANSPORT_TIMING_TOP_LIMIT = 16;
export const BRIDGE_TRANSPORT_TIMING_METRICS = Object.freeze([
  'poolAcquireMs',
  'daemonRequestMs',
  'artifactRequestCount',
  'artifactRequestMs',
  'base64DecodeMs',
  'concatJsonParseMs',
  'materializeTotalMs',
  'totalMs'
]);
export const BRIDGE_TRANSPORT_TIMING_KINDS = Object.freeze({
  poolAcquireMs: 'ms',
  daemonRequestMs: 'ms',
  artifactRequestCount: 'count',
  artifactRequestMs: 'ms',
  base64DecodeMs: 'ms',
  concatJsonParseMs: 'ms',
  materializeTotalMs: 'ms',
  totalMs: 'ms'
});

const METRIC_SET = new Set(BRIDGE_TRANSPORT_TIMING_METRICS);
const STATUS_SET = new Set(['measured', 'skipped', 'unavailable']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validMetricOrder(value) {
  return Array.isArray(value)
    && value.length === BRIDGE_TRANSPORT_TIMING_METRICS.length
    && value.every((metric, index) => metric === BRIDGE_TRANSPORT_TIMING_METRICS[index]);
}

function validUniqueMetricList(value) {
  if (!Array.isArray(value)) return null;
  const result = new Set();
  for (const metric of value) {
    if (typeof metric !== 'string' || !METRIC_SET.has(metric) || result.has(metric)) return null;
    result.add(metric);
  }
  return result;
}

function invalid(reason) {
  return { ok: false, reason };
}

/** Validate one request-local Bridge transport summary. */
export function validateBridgeTransportTimingSummary(value) {
  if (!isRecord(value)) return invalid('SUMMARY_NOT_OBJECT');
  if (value.schemaVersion !== BRIDGE_TRANSPORT_TIMING_SCHEMA_VERSION) return invalid('SUMMARY_SCHEMA_UNSUPPORTED');
  if (value.unit !== BRIDGE_TRANSPORT_TIMING_UNIT) return invalid('SUMMARY_UNIT_UNSUPPORTED');
  if (value.requestCount !== 1) return invalid('SUMMARY_REQUEST_COUNT_INVALID');
  if (!['ok', 'failed', 'cancelled'].includes(value.outcome)) return invalid('SUMMARY_OUTCOME_INVALID');
  if (!validMetricOrder(value.metricOrder)) return invalid('SUMMARY_METRIC_ORDER_INVALID');
  const unavailable = validUniqueMetricList(value.unavailableMetrics);
  const skipped = validUniqueMetricList(value.skippedMetrics);
  if (!unavailable || !skipped) return invalid('SUMMARY_METRIC_LIST_INVALID');
  for (const metric of skipped) {
    if (unavailable.has(metric)) return invalid('SUMMARY_METRIC_STATUS_OVERLAP');
  }
  if (!isRecord(value.metricKinds)) return invalid('SUMMARY_METRIC_KINDS_INVALID');
  if (!isRecord(value.metricStatus)) return invalid('SUMMARY_METRIC_STATUS_INVALID');
  if (!isRecord(value.metrics)) return invalid('SUMMARY_METRICS_INVALID');

  const metrics = {};
  for (const metric of BRIDGE_TRANSPORT_TIMING_METRICS) {
    if (value.metricKinds[metric] !== BRIDGE_TRANSPORT_TIMING_KINDS[metric]) {
      return invalid('SUMMARY_METRIC_KIND_INVALID');
    }
    const status = value.metricStatus[metric];
    if (!STATUS_SET.has(status)) return invalid('SUMMARY_METRIC_STATUS_INVALID');
    if (status === 'unavailable' && !unavailable.has(metric)) return invalid('SUMMARY_UNAVAILABLE_STATUS_MISMATCH');
    if (status === 'skipped' && !skipped.has(metric)) return invalid('SUMMARY_SKIPPED_STATUS_MISMATCH');
    if (status === 'measured' && (unavailable.has(metric) || skipped.has(metric))) {
      return invalid('SUMMARY_MEASURED_STATUS_MISMATCH');
    }
    const sample = value.metrics[metric];
    if (!isRecord(sample) || sample.status !== status) return invalid('SUMMARY_METRIC_SAMPLE_INVALID');
    const raw = sample.value;
    if (status === 'measured') {
      const valid = metric === 'artifactRequestCount'
        ? Number.isSafeInteger(raw) && raw >= 0
        : finiteNonNegative(raw);
      if (!valid) return invalid('SUMMARY_MEASURED_VALUE_INVALID');
      metrics[metric] = { status, value: raw };
    } else {
      if (raw !== null) return invalid('SUMMARY_NON_MEASURED_VALUE_INVALID');
      metrics[metric] = { status, value: null };
    }
  }
  if (value.metricStatus.totalMs !== 'measured' && value.outcome !== 'cancelled') {
    return invalid('SUMMARY_TOTAL_MISSING');
  }
  return {
    ok: true,
    value: {
      schemaVersion: value.schemaVersion,
      unit: value.unit,
      requestCount: value.requestCount,
      outcome: value.outcome,
      metricOrder: [...BRIDGE_TRANSPORT_TIMING_METRICS],
      unavailableMetrics: [...unavailable],
      skippedMetrics: [...skipped],
      metricKinds: { ...BRIDGE_TRANSPORT_TIMING_KINDS },
      metricStatus: Object.fromEntries(BRIDGE_TRANSPORT_TIMING_METRICS.map((metric) => [
        metric,
        value.metricStatus[metric]
      ])),
      metrics
    }
  };
}

function emptyMetric() {
  return {
    measuredCount: 0,
    skippedCount: 0,
    unavailableCount: 0,
    count: 0,
    total: 0,
    min: null,
    max: null,
    topValues: []
  };
}

function emptyAccumulator() {
  return {
    calls: 0,
    callsWithoutSummary: 0,
    summarySeenCount: 0,
    invalidSummaryCount: 0,
    invalidReasons: [],
    metrics: Object.fromEntries(BRIDGE_TRANSPORT_TIMING_METRICS.map((metric) => [metric, emptyMetric()]))
  };
}

export function createBridgeTransportTimingAccumulator() {
  return emptyAccumulator();
}

function recordInvalid(accumulator, reason) {
  accumulator.invalidSummaryCount += 1;
  if (accumulator.invalidReasons.length < BRIDGE_TRANSPORT_TIMING_TOP_LIMIT
    && !accumulator.invalidReasons.includes(reason)) {
    accumulator.invalidReasons.push(reason);
  }
}

function addTopValues(target, value) {
  target.push(value);
  target.sort((left, right) => right - left);
  if (target.length > BRIDGE_TRANSPORT_TIMING_TOP_LIMIT) target.length = BRIDGE_TRANSPORT_TIMING_TOP_LIMIT;
}

export function recordBridgeTransportTimingCall(accumulator, summary) {
  if (!isRecord(accumulator)) return { accepted: false, reason: 'ACCUMULATOR_INVALID' };
  accumulator.calls += 1;
  if (summary === null || summary === undefined) {
    accumulator.callsWithoutSummary += 1;
    return { accepted: false, reason: 'NO_SUMMARY' };
  }
  accumulator.summarySeenCount += 1;
  const validated = validateBridgeTransportTimingSummary(summary);
  if (!validated.ok) {
    recordInvalid(accumulator, validated.reason);
    return { accepted: false, reason: validated.reason };
  }
  for (const metric of BRIDGE_TRANSPORT_TIMING_METRICS) {
    const sample = validated.value.metrics[metric];
    const target = accumulator.metrics[metric];
    if (sample.status === 'measured') {
      target.measuredCount += 1;
      target.count += 1;
      target.total += sample.value;
      target.min = target.min === null ? sample.value : Math.min(target.min, sample.value);
      target.max = target.max === null ? sample.value : Math.max(target.max, sample.value);
      addTopValues(target.topValues, sample.value);
    } else if (sample.status === 'skipped') {
      target.skippedCount += 1;
    } else {
      target.unavailableCount += 1;
    }
  }
  return { accepted: true, value: validated.value };
}

export function snapshotBridgeTransportTimingAccumulator(accumulator) {
  const source = isRecord(accumulator) ? accumulator : emptyAccumulator();
  return {
    schemaVersion: BRIDGE_TRANSPORT_TIMING_SCHEMA_VERSION,
    unit: BRIDGE_TRANSPORT_TIMING_UNIT,
    calls: Number.isSafeInteger(source.calls) ? source.calls : 0,
    callsWithoutSummary: Number.isSafeInteger(source.callsWithoutSummary) ? source.callsWithoutSummary : 0,
    summarySeenCount: Number.isSafeInteger(source.summarySeenCount) ? source.summarySeenCount : 0,
    invalidSummaryCount: Number.isSafeInteger(source.invalidSummaryCount) ? source.invalidSummaryCount : 0,
    invalidReasons: Array.isArray(source.invalidReasons) ? [...source.invalidReasons] : [],
    metricKinds: { ...BRIDGE_TRANSPORT_TIMING_KINDS },
    metrics: Object.fromEntries(BRIDGE_TRANSPORT_TIMING_METRICS.map((metric) => {
      const value = source.metrics?.[metric] ?? emptyMetric();
      return [metric, {
        measuredCount: value.measuredCount,
        skippedCount: value.skippedCount,
        unavailableCount: value.unavailableCount,
        count: value.count,
        total: value.total,
        min: value.min,
        max: value.max,
        topValues: [...value.topValues]
      }];
    }))
  };
}
