export const MAP_NATIVE_TIMING_CODE = 'MAP_NATIVE_TIMINGS';
export const MAP_NATIVE_TIMING_SUMMARY_CODE = 'MAP_NATIVE_TIMING_SUMMARY';
export const MAP_NATIVE_TIMING_TOP_LIMIT = 16;
export const MAP_NATIVE_TIMING_SESSION_LIMIT = 64;

export const MAP_NATIVE_TIMING_PHASES = new Set([
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

export type MapNativeTimingPhase = {
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  topSlowMs: number[];
};

type MapNativeTimingAggregate = {
  requestCount: number;
  phases: Record<string, MapNativeTimingPhase>;
  unavailablePhases: Set<string>;
};

const timingAggregates = new Map<string, MapNativeTimingAggregate>();
const timingSessionKeys = new Map<string, string>();

function boundedTimingKey(key: string): string {
  while (timingAggregates.size >= MAP_NATIVE_TIMING_SESSION_LIMIT) {
    const oldest = timingAggregates.keys().next().value;
    if (typeof oldest !== 'string') break;
    timingAggregates.delete(oldest);
  }
  return key;
}

export function beginMapNativeTimingSession(key: string): void {
  timingAggregates.delete(key);
  timingAggregates.set(boundedTimingKey(key), {
    requestCount: 0,
    phases: Object.create(null),
    unavailablePhases: new Set()
  });
}

export function bindNativeTimingSession(nativeSessionToken: string, key: string): void {
  if (!nativeSessionToken) return;
  timingSessionKeys.delete(nativeSessionToken);
  while (timingSessionKeys.size >= MAP_NATIVE_TIMING_SESSION_LIMIT) {
    const oldest = timingSessionKeys.keys().next().value;
    if (typeof oldest !== 'string') break;
    timingSessionKeys.delete(oldest);
  }
  timingSessionKeys.set(nativeSessionToken, key);
}

export function timingKeyForNativeSession(nativeSessionToken: string | null | undefined): string | null {
  if (!nativeSessionToken) return null;
  return timingSessionKeys.get(nativeSessionToken) ?? `native:${nativeSessionToken}`;
}

export function recordMapNativeTiming(
  key: string,
  diagnostics: readonly { code: string; details?: unknown }[]
): { code: string; message: string; details: unknown } | null {
  const timing = diagnostics.find((item) => item.code === MAP_NATIVE_TIMING_CODE);
  const details = timing?.details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const timingRecord = details as Record<string, unknown>;
  if (timingRecord.schemaVersion !== 1 || timingRecord.unit !== 'ms') return null;
  const aggregate = timingAggregates.get(key) ?? {
    requestCount: 0,
    phases: Object.create(null),
    unavailablePhases: new Set<string>()
  };
  if (!timingAggregates.has(key)) timingAggregates.set(boundedTimingKey(key), aggregate);
  aggregate.requestCount += 1;
  if (Array.isArray(timingRecord.unavailablePhases)) {
    for (const phase of timingRecord.unavailablePhases) {
      if (typeof phase === 'string' && MAP_NATIVE_TIMING_PHASES.has(phase)) aggregate.unavailablePhases.add(phase);
    }
  }
  for (const [phase, rawValue] of Object.entries(timingRecord)) {
    if (!MAP_NATIVE_TIMING_PHASES.has(phase) || typeof rawValue !== 'number' || !Number.isFinite(rawValue) || rawValue < 0) continue;
    const current = aggregate.phases[phase] ?? {
      count: 0,
      totalMs: 0,
      minMs: Number.POSITIVE_INFINITY,
      maxMs: 0,
      topSlowMs: []
    };
    current.count += 1;
    current.totalMs += rawValue;
    current.minMs = Math.min(current.minMs, rawValue);
    current.maxMs = Math.max(current.maxMs, rawValue);
    current.topSlowMs.push(rawValue);
    current.topSlowMs.sort((left: number, right: number) => right - left);
    if (current.topSlowMs.length > MAP_NATIVE_TIMING_TOP_LIMIT) current.topSlowMs.length = MAP_NATIVE_TIMING_TOP_LIMIT;
    aggregate.phases[phase] = current;
  }
  timingAggregates.set(key, aggregate);
  const phaseEntries = Object.entries(aggregate.phases) as Array<[string, MapNativeTimingPhase]>;
  return {
    code: MAP_NATIVE_TIMING_SUMMARY_CODE,
    message: '地图静态几何 native 读链路的 main 聚合计时摘要。',
    details: {
      schemaVersion: 1,
      unit: 'ms',
      requestCount: aggregate.requestCount,
      unavailablePhases: [...aggregate.unavailablePhases].sort(),
      phases: Object.fromEntries(phaseEntries.map(([phase, value]) => [phase, {
        count: value.count,
        totalMs: value.totalMs,
        minMs: value.minMs,
        maxMs: value.maxMs,
        topSlowMs: value.topSlowMs.slice()
      }]))
    }
  };
}

export function clearMapNativeTimingSession(key: string): void {
  timingAggregates.delete(key);
  for (const [token, sessionKey] of timingSessionKeys) {
    if (sessionKey === key) timingSessionKeys.delete(token);
  }
}

export function timingSessionCountForTest(): number {
  return timingAggregates.size;
}

export function timingAliasCountForTest(): number {
  return timingSessionKeys.size;
}
