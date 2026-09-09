export const CHARACTER_NATIVE_TIMING_CODE = 'CHARACTER_NATIVE_TIMINGS';
export const CHARACTER_NATIVE_TIMING_SUMMARY_CODE = 'CHARACTER_NATIVE_TIMING_SUMMARY';
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
] as const);

type RecordLike = Record<string, unknown>;

function isRecord(value: unknown): value is RecordLike {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function invalid(reason: string): null {
  // Timing is diagnostic-only. A malformed diagnostic must not affect the
  // native result or leak through as an apparently valid timing summary.
  void reason;
  return null;
}

/**
 * Convert one Bridge-native character timing diagnostic into the bounded
 * first-page summary consumed by production-main. This is deliberately a
 * one-call conversion: the character Bridge request is not a native paging
 * session, and page/session replay must never be counted as another call.
 */
export function summarizeCharacterNativeTiming(
  diagnostics: readonly { code: string; details?: unknown }[]
): { code: string; message: string; details: RecordLike } | null {
  const diagnostic = diagnostics.find((item) => item.code === CHARACTER_NATIVE_TIMING_CODE);
  if (!isRecord(diagnostic?.details)) return null;
  const raw = diagnostic.details;
  if (raw.schemaVersion !== 1 || raw.unit !== 'ms') return invalid('SCHEMA_OR_UNIT');

  const unavailableRaw = raw.unavailablePhases;
  if (!Array.isArray(unavailableRaw)) return invalid('UNAVAILABLE_PHASES');
  const unavailablePhases: string[] = [];
  for (const phase of unavailableRaw) {
    if (typeof phase !== 'string'
      || !(CHARACTER_NATIVE_TIMING_PHASES as readonly string[]).includes(phase)
      || unavailablePhases.includes(phase)) return invalid('UNKNOWN_OR_DUPLICATE_PHASE');
    unavailablePhases.push(phase);
  }
  if (!isRecord(raw.phaseCounts)) return invalid('PHASE_COUNTS');
  for (const [phase, countValue] of Object.entries(raw.phaseCounts)) {
    if (!(CHARACTER_NATIVE_TIMING_PHASES as readonly string[]).includes(phase)
      || !isSafeNonNegativeInteger(countValue)
      || countValue < 1) return invalid('INVALID_PHASE_COUNT');
  }

  const phases: RecordLike = {};
  for (const phase of CHARACTER_NATIVE_TIMING_PHASES) {
    const value = raw[phase];
    if (value === null || value === undefined) {
      if (!unavailablePhases.includes(phase)) return invalid('MISSING_PHASE');
      continue;
    }
    if (unavailablePhases.includes(phase)) return invalid('PHASE_PRESENT_AND_UNAVAILABLE');
    if (!isFiniteNonNegative(value)) return invalid('INVALID_PHASE_VALUE');
    const countValue = raw.phaseCounts[phase];
    const scopeCount = countValue === undefined ? 1 : countValue;
    phases[phase] = {
      count: 1,
      scopeCount,
      totalMs: value,
      minMs: value,
      maxMs: value,
      topSlowMs: [value].slice(0, CHARACTER_NATIVE_TIMING_TOP_LIMIT)
    };
  }
  if (!phases.queueWaitMs || !phases.totalMs) return invalid('REQUIRED_PHASE_MISSING');

  return {
    code: CHARACTER_NATIVE_TIMING_SUMMARY_CODE,
    message: '角色 FLVER native 读链路的首 native 请求计时摘要。',
    details: {
      schemaVersion: 1,
      unit: 'ms',
      requestCount: 1,
      unavailablePhases: unavailablePhases.sort(),
      phases
    }
  };
}
