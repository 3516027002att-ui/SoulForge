import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';

export type SemanticRefreshOrigin = 'postcommit' | 'deferred';
export type SemanticRefreshStage =
  | 'scan'
  | 'analyze'
  | 'nativeDecode'
  | 'publish'
  | 'referenceBuild'
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
  finalUpserts?: number;
  newUpserts?: number;
  bodyChangedUpserts?: number;
  metadataOnlyUpserts?: number;
  ftsRebuilds?: number;
  embeddingDeletes?: number;
  ragStatsUnavailable?: boolean;
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

export interface SemanticRefreshStageStart {
  refreshId: string;
  origin: SemanticRefreshOrigin;
  stage: SemanticRefreshStage;
  startedAt: string;
  pid: number;
  heapUsedMb: number;
  heapLimitMb: number;
  rssMb: number;
}

export interface SemanticRefreshStageComplete extends SemanticRefreshStageDetails {
  refreshId: string;
  origin: SemanticRefreshOrigin;
  stage: SemanticRefreshStage;
  outcome: 'completed' | 'failed';
  finishedAt: string;
  elapsedMs: number;
  pid: number;
  heapUsedMb: number;
  heapLimitMb: number;
  rssMb: number;
}

export interface SemanticRefreshTelemetry {
  readonly refreshId: string;
  readonly origin: SemanticRefreshOrigin;
  begin(stage: SemanticRefreshStage): void;
  record(
    stage: SemanticRefreshStage,
    elapsedMs: number,
    details?: SemanticRefreshStageDetails,
    outcome?: SemanticRefreshStageComplete['outcome']
  ): void;
  complete(stage: SemanticRefreshStage, outcome?: SemanticRefreshStageComplete['outcome']): void;
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
  | 'finalUpserts'
  | 'newUpserts'
  | 'bodyChangedUpserts'
  | 'metadataOnlyUpserts'
  | 'ftsRebuilds'
  | 'embeddingDeletes'
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
  'finalUpserts',
  'newUpserts',
  'bodyChangedUpserts',
  'metadataOnlyUpserts',
  'ftsRebuilds',
  'embeddingDeletes',
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
  sink: (snapshot: SemanticRefreshTelemetrySnapshot) => void = logSemanticRefreshTelemetry,
  stageStartSink: (start: SemanticRefreshStageStart) => void = logSemanticRefreshStageStart,
  stageCompleteSink: (complete: SemanticRefreshStageComplete) => void = logSemanticRefreshStageComplete
): SemanticRefreshTelemetry {
  const refreshId = randomUUID();
  const startedMonotonic = performance.now();
  const startedAt = new Date().toISOString();
  const stages = new Map<SemanticRefreshStage, SemanticRefreshStageSnapshot>();
  const startedStages = new Set<SemanticRefreshStage>();
  const stageStartedMonotonic = new Map<SemanticRefreshStage, number>();
  let finished = false;

  return {
    refreshId,
    origin,
    begin(stage): void {
      if (finished || startedStages.has(stage)) return;
      startedStages.add(stage);
      stageStartedMonotonic.set(stage, performance.now());
      try {
        const memory = process.memoryUsage();
        const heap = getHeapStatistics();
        stageStartSink({
          refreshId,
          origin,
          stage,
          startedAt: new Date().toISOString(),
          pid: process.pid,
          heapUsedMb: toMiB(heap.used_heap_size),
          heapLimitMb: toMiB(heap.heap_size_limit),
          rssMb: toMiB(memory.rss)
        });
      } catch {
        // Diagnostics must never alter the refresh result.
      }
    },
    record(stage, elapsedMs, details = {}, outcome = 'completed'): void {
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
      if (details.ragStatsUnavailable === true) current.ragStatsUnavailable = true;
      stages.set(stage, current);
      try {
        const memory = process.memoryUsage();
        const heap = getHeapStatistics();
        stageCompleteSink({
          refreshId,
          origin,
          stage,
          outcome,
          finishedAt: new Date().toISOString(),
          elapsedMs: safeElapsed,
          pid: process.pid,
          heapUsedMb: toMiB(heap.used_heap_size),
          heapLimitMb: toMiB(heap.heap_size_limit),
          rssMb: toMiB(memory.rss),
          ...details
        });
      } catch {
        // Diagnostics must never alter the refresh result.
      }
    },
    complete(stage, outcome = 'completed'): void {
      if (finished) return;
      const startedAt = stageStartedMonotonic.get(stage);
      if (startedAt === undefined) return;
      this.record(stage, performance.now() - startedAt, {}, outcome);
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
  telemetry.begin(stage);
  const started = performance.now();
  return operation().then((value) => {
    telemetry.record(stage, performance.now() - started, details?.(value));
    return value;
  }, (error: unknown) => {
    telemetry.record(stage, performance.now() - started, {}, 'failed');
    throw error;
  });
}

export function measureSemanticRefreshStageSync<T>(
  telemetry: SemanticRefreshTelemetry,
  stage: SemanticRefreshStage,
  operation: () => T,
  details?: (value: T) => SemanticRefreshStageDetails
): T {
  telemetry.begin(stage);
  const started = performance.now();
  try {
    const value = operation();
    telemetry.record(stage, performance.now() - started, details?.(value));
    return value;
  } catch (error) {
    telemetry.record(stage, performance.now() - started, {}, 'failed');
    throw error;
  }
}

function logSemanticRefreshTelemetry(snapshot: SemanticRefreshTelemetrySnapshot): void {
  console.info(`[SoulForge semantic-refresh] ${JSON.stringify(snapshot)}`);
}

function logSemanticRefreshStageStart(start: SemanticRefreshStageStart): void {
  console.info(`[SoulForge semantic-refresh-stage] ${JSON.stringify(start)}`);
}

function logSemanticRefreshStageComplete(complete: SemanticRefreshStageComplete): void {
  console.info(`[SoulForge semantic-refresh-stage-complete] ${JSON.stringify(complete)}`);
}

function toMiB(bytes: number): number {
  return Number((bytes / (1024 * 1024)).toFixed(1));
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function boundError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 500 ? message : `${message.slice(0, 499)}…`;
}
