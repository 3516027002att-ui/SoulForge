import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export type SemanticRefreshOrigin = 'postcommit' | 'deferred';
export type SemanticRefreshStage =
  | 'scan'
  | 'analyze'
  | 'nativeDecode'
  | 'ragBuild'
  | 'diff'
  | 'persistBatch';

export interface SemanticRefreshStageDetails {
  fileCount?: number;
  changedSourceCount?: number;
  parsedFiles?: number;
  inspectedFiles?: number;
  sourceCount?: number;
  partialSourceCount?: number;
  failedSourceCount?: number;
  chunkCount?: number;
  referenceCount?: number;
  changedSourceCountInDiff?: number;
  upsertChunks?: number;
  deletedChunks?: number;
  batchCount?: number;
  dbEnqueueMs?: number;
  dbDurationMs?: number;
  dbMaxDurationMs?: number;
  firstEnqueuedAt?: string;
  lastEndedAt?: string;
}

export interface SemanticRefreshStageSnapshot extends SemanticRefreshStageDetails {
  count: number;
  elapsedMs: number;
  maxElapsedMs: number;
}

export interface SemanticRefreshTelemetrySnapshot {
  refreshId: string;
  origin: SemanticRefreshOrigin;
  status: 'completed' | 'partial' | 'failed' | 'invalidated';
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  stages: Partial<Record<SemanticRefreshStage, SemanticRefreshStageSnapshot>>;
  error?: string;
}

export interface SemanticRefreshTelemetry {
  readonly refreshId: string;
  readonly origin: SemanticRefreshOrigin;
  record(stage: SemanticRefreshStage, elapsedMs: number, details?: SemanticRefreshStageDetails): void;
  finish(status: SemanticRefreshTelemetrySnapshot['status'], error?: unknown): void;
}

type NumericDetailKey =
  | 'fileCount'
  | 'changedSourceCount'
  | 'parsedFiles'
  | 'inspectedFiles'
  | 'sourceCount'
  | 'partialSourceCount'
  | 'failedSourceCount'
  | 'chunkCount'
  | 'referenceCount'
  | 'changedSourceCountInDiff'
  | 'upsertChunks'
  | 'deletedChunks'
  | 'batchCount'
  | 'dbEnqueueMs'
  | 'dbDurationMs';

const NUMERIC_DETAIL_KEYS: readonly NumericDetailKey[] = [
  'fileCount',
  'changedSourceCount',
  'parsedFiles',
  'inspectedFiles',
  'sourceCount',
  'partialSourceCount',
  'failedSourceCount',
  'chunkCount',
  'referenceCount',
  'changedSourceCountInDiff',
  'upsertChunks',
  'deletedChunks',
  'batchCount',
  'dbEnqueueMs',
  'dbDurationMs'
];

/**
 * One bounded aggregate per semantic refresh. The sink is intentionally
 * callback-based so the host can keep the receipt in its process log without
 * making core or the database utility depend on Electron logging.
 */
export function createSemanticRefreshTelemetry(
  origin: SemanticRefreshOrigin,
  sink: (snapshot: SemanticRefreshTelemetrySnapshot) => void = logSemanticRefreshTelemetry
): SemanticRefreshTelemetry {
  const refreshId = randomUUID();
  const startedMonotonic = performance.now();
  const startedAt = new Date().toISOString();
  const stages = new Map<SemanticRefreshStage, SemanticRefreshStageSnapshot>();
  let finished = false;

  return {
    refreshId,
    origin,
    record(stage, elapsedMs, details = {}): void {
      if (finished) return;
      const safeElapsed = finiteNonNegative(elapsedMs);
      const current = stages.get(stage) ?? {
        count: 0,
        elapsedMs: 0,
        maxElapsedMs: 0
      };
      current.count += 1;
      current.elapsedMs += safeElapsed;
      current.maxElapsedMs = Math.max(current.maxElapsedMs, safeElapsed);
      for (const key of NUMERIC_DETAIL_KEYS) {
        const value = details[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
          current[key] = (current[key] as number | undefined ?? 0) + Math.max(0, value);
        }
      }
      if (details.dbMaxDurationMs !== undefined) {
        current.dbMaxDurationMs = Math.max(current.dbMaxDurationMs ?? 0, finiteNonNegative(details.dbMaxDurationMs));
      }
      if (details.firstEnqueuedAt !== undefined && current.firstEnqueuedAt === undefined) {
        current.firstEnqueuedAt = details.firstEnqueuedAt;
      }
      if (details.lastEndedAt !== undefined) current.lastEndedAt = details.lastEndedAt;
      stages.set(stage, current);
    },
    finish(status, error): void {
      if (finished) return;
      finished = true;
      const finishedAt = new Date().toISOString();
      const snapshot: SemanticRefreshTelemetrySnapshot = {
        refreshId,
        origin,
        status,
        startedAt,
        finishedAt,
        elapsedMs: finiteNonNegative(performance.now() - startedMonotonic),
        stages: Object.fromEntries(stages.entries()),
        ...(error === undefined ? {} : { error: boundError(error) })
      };
      try {
        sink(snapshot);
      } catch {
        // Telemetry must never alter the refresh result.
      }
    }
  };
}

export function measureSemanticRefreshStage<T>(
  telemetry: SemanticRefreshTelemetry,
  stage: SemanticRefreshStage,
  operation: () => Promise<T>,
  details?: (value: T) => SemanticRefreshStageDetails
): Promise<T> {
  const started = performance.now();
  return operation().then((value) => {
    telemetry.record(stage, performance.now() - started, details?.(value));
    return value;
  }, (error: unknown) => {
    telemetry.record(stage, performance.now() - started);
    throw error;
  });
}

export function measureSemanticRefreshStageSync<T>(
  telemetry: SemanticRefreshTelemetry,
  stage: SemanticRefreshStage,
  operation: () => T,
  details?: (value: T) => SemanticRefreshStageDetails
): T {
  const started = performance.now();
  try {
    const value = operation();
    telemetry.record(stage, performance.now() - started, details?.(value));
    return value;
  } catch (error) {
    telemetry.record(stage, performance.now() - started);
    throw error;
  }
}

function logSemanticRefreshTelemetry(snapshot: SemanticRefreshTelemetrySnapshot): void {
  console.info(`[SoulForge semantic-refresh] ${JSON.stringify(snapshot)}`);
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function boundError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 500 ? message : `${message.slice(0, 499)}…`;
}
