import { performance } from 'node:perf_hooks';

export const DATABASE_UTILITY_TRACE_PREFIX = '[SoulForge database utility trace] ';

export type QueueObservationEvent = 'enqueue' | 'start' | 'finish';
export type QueueObservationOutcome = 'ok' | 'request-failed' | 'workerfail' | 'close';

export interface QueueObservation {
  event: QueueObservationEvent;
  requestId: string;
  method: string;
  enqueue: number;
  start: number | null;
  finish: number | null;
  depth: number;
  queueWaitMs: number | null;
  dbDurationMs: number | null;
  timeout: boolean;
  outcome?: QueueObservationOutcome;
  errorCode?: string;
}

export interface QueueObservationWriterOptions {
  side: 'worker' | 'client';
  pid?: number;
  clockOrigin?: number;
  write?: (line: string) => unknown;
}

export type QueueObservationWriter = (observation: QueueObservation) => void;

const MAX_TRACE_STRING = 128;
const MAX_TRACE_LINE_LENGTH = 16_384;

/**
 * Emits bounded, process-identifying queue observations. The caller still owns
 * scheduling and request handling; this helper only normalizes diagnostics.
 */
export function createQueueObservationWriter(
  options: QueueObservationWriterOptions
): QueueObservationWriter {
  const pid = boundedTraceNumber(options.pid ?? process.pid);
  const clockOrigin = boundedClockOrigin(
    options.clockOrigin ?? performance.timeOrigin
  );
  const write = options.write ?? ((line: string) => process.stderr.write(line));

  return (observation) => {
    try {
      const payload = {
        side: options.side,
        pid,
        clockOrigin,
        event: observation.event,
        requestId: boundedTraceString(observation.requestId, MAX_TRACE_STRING),
        method: boundedTraceString(observation.method, 64),
        enqueue: boundedTraceNumber(observation.enqueue),
        start: nullableTraceNumber(observation.start),
        finish: nullableTraceNumber(observation.finish),
        depth: boundedTraceNumber(observation.depth),
        queueWaitMs: nullableTraceNumber(observation.queueWaitMs),
        dbDurationMs: nullableTraceNumber(observation.dbDurationMs),
        timeout: observation.timeout === true,
        ...(observation.outcome ? { outcome: observation.outcome } : {}),
        ...(observation.errorCode
          ? { errorCode: boundedTraceString(observation.errorCode, 96) }
          : {})
      };
      write(`${DATABASE_UTILITY_TRACE_PREFIX}${boundedTraceJson(payload)}\n`);
    } catch {
      // Diagnostics must never change database RPC behavior.
    }
  };
}

function boundedTraceJson(value: Record<string, unknown>): string {
  const encoded = JSON.stringify(value);
  if (encoded.length <= MAX_TRACE_LINE_LENGTH) return encoded;
  return JSON.stringify({
    side: value.side,
    pid: value.pid,
    clockOrigin: value.clockOrigin,
    event: value.event,
    requestId: boundedTraceString(String(value.requestId ?? ''), 32),
    method: boundedTraceString(String(value.method ?? ''), 32),
    timeout: value.timeout === true
  });
}

function boundedTraceNumber(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.round(value * 100) / 100, 0), 86_400_000);
}

function boundedClockOrigin(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.round(value), 0), Number.MAX_SAFE_INTEGER);
}

function nullableTraceNumber(value: number | null): number | null {
  return value === null ? null : boundedTraceNumber(value);
}

function boundedTraceString(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}
