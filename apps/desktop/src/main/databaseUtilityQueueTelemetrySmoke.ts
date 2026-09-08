import type { App } from 'electron';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import type { OperationLogUtilityClient } from './operationLogUtilityClient.js';
import {
  OPERATION_LOG_UTILITY_PROTOCOL,
  type OperationLogUtilityRequest,
  type OperationLogUtilityResponse
} from './operationLogUtilityProtocol.js';
import {
  DATABASE_UTILITY_TRACE_PREFIX,
  createQueueObservationWriter
} from './databaseUtilityTelemetry.js';

const TRACE_PREFIX = DATABASE_UTILITY_TRACE_PREFIX;
const writeFixtureTrace = createQueueObservationWriter({ side: 'worker' });

if (process.parentPort) {
  runFixtureWorker();
} else {
  Promise.all([
    import('electron'),
    import('./operationLogUtilityClient.js')
  ]).then(([{ app }, { OperationLogUtilityClient }]) => app.whenReady().then(() => runFixture(app, OperationLogUtilityClient))).catch((error) => {
    process.stderr.write(`database utility queue telemetry smoke failed: ${formatError(error)}\n`);
    process.exitCode = 1;
  });
}

async function runFixture(app: App, Client: typeof OperationLogUtilityClient): Promise<void> {
  const traceLines: string[] = [];
  const stderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    traceLines.push(...text.split(/\r?\n/)
      .map((line) => line.slice(line.indexOf(TRACE_PREFIX)))
      .filter((line) => line.startsWith(TRACE_PREFIX)));
    return stderrWrite(chunk, ...(args as []));
  }) as typeof process.stderr.write;

  const client = new Client(fileURLToPath(import.meta.url), 250);
  try {
    await client.openAppDatabase('fixture-app-database');

    const slowRequest = client.providerUsageSummary();
    const queuedRequest = client.health();
    const [slowResult, queuedResult] = await Promise.allSettled([slowRequest, queuedRequest]);
    assertTimeout(slowResult, 'execution-slow request');
    assertTimeout(queuedResult, 'queue-wait request');

    // The worker completes both requests after the client has timed them out;
    // the late responses must be ignored without an unhandled rejection.
    await sleep(700);
    const recovered = await client.health();
    if (!recovered.appReady) throw new Error('worker did not recover after late completion');

    const requestFailure = client.list();
    await assertRejected(requestFailure, 'request-failed request');
    const workerFailure = client.providerUsageSummary().then(
      () => false,
      () => true
    );
    await sleep(5);
    await client.restart();
    if (!(await workerFailure)) throw new Error('worker-fail request unexpectedly resolved');

    if (!(await client.health()).appReady) throw new Error('worker restart did not reopen the app database');
    await client.dispose();

    const traces = traceLines.map(parseTrace).filter((trace): trace is TraceRecord => trace !== null);
    const slowFinish = traces.find((trace) => trace.event === 'finish'
      && trace.side === 'worker'
      && trace.method === 'providerUsageSummary'
      && trace.dbDurationMs !== null
      && trace.dbDurationMs >= 500);
    const queuedStart = traces.find((trace) => trace.event === 'start'
      && trace.side === 'worker'
      && trace.method === 'health'
      && trace.queueWaitMs !== null
      && trace.queueWaitMs >= 500);
    if (!slowFinish) throw new Error('fixture did not observe an execution-slow completion');
    if (!queuedStart) throw new Error('fixture did not observe a queue-wait start');
    if (!traces.some((trace) => trace.side === 'client' && trace.event === 'workerfail')) {
      throw new Error('fixture did not observe workerfail handling');
    }
    if (!traces.some((trace) => trace.side === 'client' && trace.event === 'finish' && trace.outcome === 'close')) {
      throw new Error('fixture did not observe close handling');
    }
    if (!traces.some((trace) => trace.side === 'client' && trace.event === 'finish' && trace.outcome === 'request-failed')) {
      throw new Error('fixture did not observe request-failed handling');
    }

    stderrWrite(`database utility queue telemetry smoke passed: ${JSON.stringify({
      executionSlowMs: slowFinish.dbDurationMs,
      queueWaitMs: queuedStart.queueWaitMs,
      workerFailObserved: true,
      closeObserved: true
    })}\n`);
    app.exit(0);
  } catch (error) {
    try {
      await client.dispose();
    } catch {
      // Preserve the original fixture failure.
    }
    stderrWrite(`database utility queue telemetry smoke failed: ${formatError(error)}\n`);
    app.exit(1);
  }
}

function runFixtureWorker(): void {
  let queue = Promise.resolve();
  let slowSummaryCalls = 0;
  let queueDepth = 0;
  process.parentPort.on('message', (event) => {
    const request = event.data as OperationLogUtilityRequest;
    const enqueuedAt = performance.now();
    const depth = ++queueDepth;
    writeFixtureTrace({
      event: 'enqueue',
      requestId: request.requestId,
      method: request.method,
      enqueue: enqueuedAt,
      start: null,
      finish: null,
      depth,
      queueWaitMs: null,
      dbDurationMs: null,
      timeout: false
    });
    queue = queue.then(async () => {
      const startedAt = performance.now();
      writeFixtureTrace({
        event: 'start',
        requestId: request.requestId,
        method: request.method,
        enqueue: enqueuedAt,
        start: startedAt,
        finish: null,
        depth,
        queueWaitMs: startedAt - enqueuedAt,
        dbDurationMs: null,
        timeout: false
      });
      let outcome: 'ok' | 'request-failed' | 'workerfail' = 'ok';
      try {
        if (request.method === 'providerUsageSummary' && slowSummaryCalls++ < 2) {
          await sleep(600);
        }
        if (request.method === 'openAppDatabase') {
          post(request.requestId, true, { appReady: true });
          return;
        }
        if (request.method === 'health') {
          post(request.requestId, true, { ready: false, appReady: true });
          return;
        }
        if (request.method === 'providerUsageSummary') {
          post(request.requestId, true, {
            calls: 0,
            reportedCalls: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            firstUsedAt: null,
            lastUsedAt: null,
            byService: [],
            latestSession: null
          });
          return;
        }
        if (request.method === 'close') {
          post(request.requestId, true, null);
          return;
        }
        outcome = 'request-failed';
        post(request.requestId, false, undefined, 'FIXTURE_UNSUPPORTED_METHOD');
      } catch {
        outcome = 'workerfail';
        throw new Error('fixture worker failure');
      } finally {
        const finishedAt = performance.now();
        writeFixtureTrace({
          event: 'finish',
          requestId: request.requestId,
          method: request.method,
          enqueue: enqueuedAt,
          start: startedAt,
          finish: finishedAt,
          depth,
          queueWaitMs: startedAt - enqueuedAt,
          dbDurationMs: finishedAt - startedAt,
          timeout: false,
          outcome
        });
        queueDepth -= 1;
      }
    });
  });
}

function post(requestId: string, ok: true, result: unknown): void;
function post(requestId: string, ok: false, result: undefined, error: string): void;
function post(requestId: string, ok: boolean, result: unknown, error?: string): void {
  const response: OperationLogUtilityResponse = {
    protocolVersion: OPERATION_LOG_UTILITY_PROTOCOL,
    requestId,
    ok,
    ...(ok ? { result } : { error: { code: error ?? 'FIXTURE_FAILED', message: 'fixture failure' } })
  };
  process.parentPort.postMessage(response);
}

interface TraceRecord {
  side: 'client' | 'worker';
  event: string;
  method: string;
  queueWaitMs: number | null;
  dbDurationMs: number | null;
  outcome?: string;
}

function parseTrace(line: string): TraceRecord | null {
  try {
    const value = JSON.parse(line.slice(TRACE_PREFIX.length)) as Partial<TraceRecord>;
    if ((value.side !== 'client' && value.side !== 'worker')
      || typeof value.event !== 'string'
      || typeof value.method !== 'string') return null;
    return {
      side: value.side,
      event: value.event,
      method: value.method,
      queueWaitMs: typeof value.queueWaitMs === 'number' ? value.queueWaitMs : null,
      dbDurationMs: typeof value.dbDurationMs === 'number' ? value.dbDurationMs : null,
      ...(typeof value.outcome === 'string' ? { outcome: value.outcome } : {})
    };
  } catch {
    return null;
  }
}

function assertTimeout(result: PromiseSettledResult<unknown>, label: string): void {
  if (result.status !== 'rejected' || !String(result.reason).includes('超时')) {
    throw new Error(`${label} did not deterministically timeout`);
  }
}

async function assertRejected(result: Promise<unknown>, label: string): Promise<void> {
  try {
    await result;
  } catch {
    return;
  }
  throw new Error(`${label} unexpectedly resolved`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
