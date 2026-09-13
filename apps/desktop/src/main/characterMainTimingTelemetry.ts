export const CHARACTER_MAIN_TIMING_CODE = 'CHARACTER_MAIN_TIMING_SUMMARY';
export const CHARACTER_MAIN_TIMING_PHASES = Object.freeze([
  'optionsPrepareMs',
  'bridgeAwaitMs',
  'bundleValidateMs',
  'compatibilityMs',
  'chunkBuildMs',
  'pageFirstMs',
  'totalMs'
] as const);

type CharacterMainTimingPhase = typeof CHARACTER_MAIN_TIMING_PHASES[number];
type PhaseStatus = 'measured' | 'skipped' | 'unavailable';
type PhaseStat = {
  count: number;
  totalMs: number;
  minMs: number | null;
  maxMs: number | null;
  topSlowMs: number[];
};

type TimingScope = {
  phase: CharacterMainTimingPhase;
  startedAt: bigint;
} | null;

type RecordLike = Record<string, unknown>;

const TOP_LIMIT = 16;

function monotonicNow(): bigint {
  return process.hrtime.bigint();
}

function elapsedMs(startedAt: bigint): number {
  const value = Number(monotonicNow() - startedAt) / 1_000_000;
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function emptyPhase(): PhaseStat {
  return {
    count: 0,
    totalMs: 0,
    minMs: null,
    maxMs: null,
    topSlowMs: []
  };
}

function addPhaseSample(target: PhaseStat, value: number): void {
  target.count += 1;
  target.totalMs += value;
  target.minMs = target.minMs === null ? value : Math.min(target.minMs, value);
  target.maxMs = target.maxMs === null ? value : Math.max(target.maxMs, value);
  target.topSlowMs.push(value);
  target.topSlowMs.sort((left, right) => right - left);
  if (target.topSlowMs.length > TOP_LIMIT) target.topSlowMs.length = TOP_LIMIT;
}

function phaseSnapshot(value: PhaseStat): RecordLike {
  return {
    count: value.count,
    totalMs: value.totalMs,
    minMs: value.minMs,
    maxMs: value.maxMs,
    topSlowMs: [...value.topSlowMs]
  };
}

export type CharacterMainTimingOutcome = 'ok' | 'failed' | 'empty';

export interface CharacterMainTimingCollector {
  /** Start one non-overlapping child phase; totalMs is closed by finish(). */
  begin(phase: CharacterMainTimingPhase): TimingScope;
  /** Finish a scope returned by begin; repeated or mismatched scopes are ignored. */
  end(scope: TimingScope): void;
  /** Mark a known non-executed phase, such as compatibility on a non-c0000 model. */
  skip(phase: CharacterMainTimingPhase): void;
  /** Emit one bounded diagnostic; subsequent calls return the same diagnostic. */
  finish(outcome: CharacterMainTimingOutcome, transport?: RecordLike | null): RecordLike;
}

/**
 * Request-local main-process timing for the first character native read.
 *
 * The collector deliberately does not instrument runBridge globally. The
 * bridgeAwait phase is measured at the MAP handler boundary and therefore
 * includes the request and any file-backed materialization without changing
 * the shared Bridge client or renderer-visible behavior.
 */
export function createCharacterMainTimingCollector(): CharacterMainTimingCollector {
  const startedAt = monotonicNow();
  const phases = new Map<CharacterMainTimingPhase, PhaseStat>(
    CHARACTER_MAIN_TIMING_PHASES.map((phase) => [phase, emptyPhase()])
  );
  const statuses = new Map<CharacterMainTimingPhase, PhaseStatus>();
  let active: TimingScope = null;
  let finished: RecordLike | null = null;

  const begin = (phase: CharacterMainTimingPhase): TimingScope => {
    if (finished || active || statuses.get(phase) === 'measured') return null;
    active = { phase, startedAt: monotonicNow() };
    return active;
  };

  const end = (scope: TimingScope): void => {
    if (!scope || finished || active !== scope) return;
    const value = elapsedMs(scope.startedAt);
    active = null;
    statuses.set(scope.phase, 'measured');
    addPhaseSample(phases.get(scope.phase)!, value);
  };

  const skip = (phase: CharacterMainTimingPhase): void => {
    if (finished || active || statuses.has(phase)) return;
    statuses.set(phase, 'skipped');
  };

  const finish = (outcome: CharacterMainTimingOutcome, transport?: RecordLike | null): RecordLike => {
    if (finished) return finished;
    if (active) {
      // A defensive close keeps a malformed caller from leaking an active
      // scope into the summary. Normal MAP paths always end scopes explicitly.
      end(active);
    }
    const unavailablePhases = CHARACTER_MAIN_TIMING_PHASES.filter(
      (phase) => !statuses.has(phase) && phase !== 'totalMs'
    );
    const skippedPhases = CHARACTER_MAIN_TIMING_PHASES.filter(
      (phase) => statuses.get(phase) === 'skipped'
    );
    const total = elapsedMs(startedAt);
    statuses.set('totalMs', 'measured');
    addPhaseSample(phases.get('totalMs')!, total);
    finished = {
      severity: 'info',
      code: CHARACTER_MAIN_TIMING_CODE,
      message: '角色首个 native 读请求的 main 进程阶段计时摘要。',
      details: {
        schemaVersion: 1,
        unit: 'ms',
        requestCount: 1,
        outcome,
        phaseOrder: [...CHARACTER_MAIN_TIMING_PHASES],
        unavailablePhases,
        skippedPhases,
        phaseStatus: Object.fromEntries(
          CHARACTER_MAIN_TIMING_PHASES.map((phase) => [phase, statuses.get(phase) ?? 'unavailable'])
        ),
        phases: Object.fromEntries(
          CHARACTER_MAIN_TIMING_PHASES.map((phase) => [phase, phaseSnapshot(phases.get(phase)!)])
        ),
        ...(transport && typeof transport === 'object' && !Array.isArray(transport)
          ? { transport }
          : {})
      }
    };
    return finished;
  };

  return { begin, end, skip, finish };
}
