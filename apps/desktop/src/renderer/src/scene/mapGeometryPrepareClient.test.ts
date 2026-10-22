import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  preparedGeometryTransferables,
  prepareMapStaticGeometryChunks,
  type MapGeometryPrepareWorkerRequest,
  type MapGeometryPrepareWorkerResponse
} from './mapGeometryPrepare.js';
import {
  MapGeometryPrepareClient,
  type MapGeometryPrepareObservation,
  type MapGeometryPrepareTelemetryEvent,
  type MapGeometryPrepareWorkerPort
} from './mapGeometryPrepareClient.js';

function encodeFloat32(values: readonly number[]): string {
  const bytes = new Uint8Array(values.length * Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, value, true));
  return Buffer.from(bytes).toString('base64');
}

function geometryChunk(offset: number) {
  return {
    positionsBase64: encodeFloat32([
      offset, 0, 0,
      offset + 1, 0, 0,
      offset, 1, 0
    ]),
    indicesBase64: Buffer.from(new Uint16Array([0, 1, 2]).buffer).toString('base64'),
    indexElementBytes: 2 as const,
    uvsBase64: encodeFloat32([0, 0, 1, 0, 0, 1]),
    normalsBase64: encodeFloat32([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    materialIndex: 0,
    texturePreviewToken: 'not-a-data-uri'
  };
}

class FakeWorker implements MapGeometryPrepareWorkerPort {
  public onmessage: ((event: MessageEvent<MapGeometryPrepareWorkerResponse>) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;
  public posted: MapGeometryPrepareWorkerRequest[] = [];
  public terminated = false;

  public postMessage(message: MapGeometryPrepareWorkerRequest): void {
    this.posted.push(message);
  }

  public terminate(): void {
    this.terminated = true;
  }

  public result(offset: number, prepareDurationMs = 1.25): void {
    const request = this.posted.at(-1);
    assert.ok(request);
    const prepared = prepareMapStaticGeometryChunks([geometryChunk(offset)]);
    this.onmessage?.({
      data: { kind: 'result', jobId: request.jobId, prepared, prepareDurationMs }
    } as MessageEvent<MapGeometryPrepareWorkerResponse>);
  }

  public error(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

class StartupErrorWorker implements MapGeometryPrepareWorkerPort {
  private messageHandler: ((event: MessageEvent<MapGeometryPrepareWorkerResponse>) => void) | null = null;
  private errorHandler: ((event: ErrorEvent) => void) | null = null;

  public get onmessage(): ((event: MessageEvent<MapGeometryPrepareWorkerResponse>) => void) | null {
    return this.messageHandler;
  }

  public set onmessage(handler: ((event: MessageEvent<MapGeometryPrepareWorkerResponse>) => void) | null) {
    this.messageHandler = handler;
  }

  public get onerror(): ((event: ErrorEvent) => void) | null {
    return this.errorHandler;
  }

  public set onerror(handler: ((event: ErrorEvent) => void) | null) {
    this.errorHandler = handler;
    if (handler) queueMicrotask(() => this.errorHandler?.({ message: 'startup failed' } as ErrorEvent));
  }

  public postMessage(_message: MapGeometryPrepareWorkerRequest): void {}
  public terminate(): void {}
}

async function withRendererClock(
  clock: { now: () => number; readonly timeOrigin: number },
  run: () => Promise<void>
): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'performance')!;
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: clock });
  try {
    await run();
  } finally {
    Object.defineProperty(globalThis, 'performance', original);
  }
}

describe('MAP geometry prepare per-call observations', () => {
  it('records one raw renderer interval and diagnostic worker duration for repeated terminal callbacks', async () => {
    let now = 20;
    let origin = 1000;
    let clockReads = 0;
    await withRendererClock({
      now: () => { clockReads += 1; return now; },
      get timeOrigin() { return origin; }
    }, async () => {
      const worker = new FakeWorker();
      const observations: MapGeometryPrepareObservation[] = [];
      const telemetry: MapGeometryPrepareTelemetryEvent[] = [];
      const client = new MapGeometryPrepareClient(() => {
        now = 10;
        return worker;
      }, {
        concurrency: 1,
        onTelemetry: (event) => {
          telemetry.push(event);
          now = 999;
          origin = 9999;
        }
      });
      try {
        const promise = client.prepare([geometryChunk(0)], undefined, {}, (event) => observations.push(event));
        const callback = worker.onmessage!;
        const jobId = worker.posted[0]!.jobId;
        now = 5;
        origin = 2000;
        const prepared = prepareMapStaticGeometryChunks([geometryChunk(0)]);
        const response: MapGeometryPrepareWorkerResponse = {
          kind: 'result', jobId, prepared, prepareDurationMs: -7
        };
        callback({ data: response } as MessageEvent<MapGeometryPrepareWorkerResponse>);
        callback({ data: response } as MessageEvent<MapGeometryPrepareWorkerResponse>);
        callback({ data: { kind: 'error', jobId, error: { code: 'late', message: 'late' } } } as MessageEvent<MapGeometryPrepareWorkerResponse>);
        const result = await promise;
        assert.equal(clockReads, 3, 'enqueue, worker start and one terminal sample');
        assert.deepEqual(observations, [{
          jobId,
          status: 'completed',
          enqueuedAtMs: 20,
          startedAtMs: 10,
          completedAtMs: 5,
          timeOriginAtEnqueue: 1000,
          timeOriginAtCompletion: 2000,
          reportedWorkerDurationMs: -7
        }]);
        assert.equal(result.positionsBytes, prepared.positionsBytes);
        assert.deepEqual(result, { ...prepared, cacheKey: jobId });
        assert.equal(client.getStats().completed, 1);
        assert.equal(client.getStats().totalDurationMs, 0);
        assert.equal(client.getStats().totalPrepareDurationMs, 0);
        assert.deepEqual(telemetry, [{
          kind: 'map-geometry-prepare', status: 'completed', clientDurationMs: 0,
          prepareDurationMs: -7, queueWaitMs: 0, activeWorkers: 0, queuedJobs: 0
        }]);
      } finally {
        client.dispose();
      }
    });
  });

  it('keeps identical shared geometry calls independent and observation data off the worker DTO', async () => {
    let now = 10;
    await withRendererClock({ now: () => now, timeOrigin: 1000 }, async () => {
      const worker = new FakeWorker();
      const observationsA: MapGeometryPrepareObservation[] = [];
      const observationsB: MapGeometryPrepareObservation[] = [];
      const client = new MapGeometryPrepareClient(() => worker, { concurrency: 1 });
      try {
        const chunks = [geometryChunk(0)];
        const prepared = prepareMapStaticGeometryChunks(chunks);
        const metadata = { textureColorSpace: 'srgb' };
        const promiseA = client.prepare(chunks, undefined, metadata, (event) => observationsA.push(event));
        const idA = worker.posted[0]!.jobId;
        now = 20;
        const promiseB = client.prepare(chunks, undefined, metadata, (event) => observationsB.push(event));
        now = 30;
        worker.onmessage!({ data: { kind: 'result', jobId: idA, prepared } } as MessageEvent<MapGeometryPrepareWorkerResponse>);
        const idB = worker.posted[1]!.jobId;
        assert.notEqual(idA, idB);
        assert.deepEqual(Object.keys(worker.posted[0]!).sort(), ['chunks', 'jobId', 'kind', 'textureColorSpace']);
        assert.deepEqual(Object.keys(worker.posted[1]!).sort(), ['chunks', 'jobId', 'kind', 'textureColorSpace']);
        // An older job's repeat on the same current port cannot settle B.
        worker.onmessage!({ data: { kind: 'result', jobId: idA, prepared } } as MessageEvent<MapGeometryPrepareWorkerResponse>);
        assert.equal(observationsB.length, 0);
        now = 40;
        worker.onmessage!({ data: { kind: 'result', jobId: idB, prepared } } as MessageEvent<MapGeometryPrepareWorkerResponse>);
        const [resultA, resultB] = await Promise.all([promiseA, promiseB]);
        assert.deepEqual(observationsA, [{
          jobId: idA, status: 'completed', enqueuedAtMs: 10, startedAtMs: 10,
          completedAtMs: 30, timeOriginAtEnqueue: 1000, timeOriginAtCompletion: 1000
        }]);
        assert.deepEqual(observationsB, [{
          jobId: idB, status: 'completed', enqueuedAtMs: 20, startedAtMs: 30,
          completedAtMs: 40, timeOriginAtEnqueue: 1000, timeOriginAtCompletion: 1000
        }]);
        assert.equal(resultA.positionsBytes, prepared.positionsBytes);
        assert.equal(resultB.positionsBytes, prepared.positionsBytes);
        assert.deepEqual(resultA, { ...prepared, cacheKey: idA });
        assert.deepEqual(resultB, { ...prepared, cacheKey: idB });
        assert.equal(client.getStats().completed, 2);
      } finally {
        client.dispose();
      }
    });
  });

  it('ignores the old port after active cancellation and replacement even with the current job id', async () => {
    const workers: FakeWorker[] = [];
    const observationsA: MapGeometryPrepareObservation[] = [];
    const observationsB: MapGeometryPrepareObservation[] = [];
    const client = new MapGeometryPrepareClient(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    }, { concurrency: 1 });
    try {
      const abort = new AbortController();
      const promiseA = client.prepare([geometryChunk(0)], abort.signal, {}, (event) => {
        observationsA.push(event);
        throw new Error('cancel observer unavailable');
      });
      const oldCallback = workers[0]!.onmessage!;
      const oldError = workers[0]!.onerror!;
      const idA = workers[0]!.posted[0]!.jobId;
      abort.abort();
      await assert.rejects(promiseA, { code: 'MAP_PREPARE_CANCELLED' });
      const promiseB = client.prepare([geometryChunk(10)], undefined, {}, (event) => observationsB.push(event));
      const workerB = workers[1]!;
      const idB = workerB.posted[0]!.jobId;
      for (const jobId of [idA, idB]) {
        oldCallback({ data: { kind: 'result', jobId, prepared: prepareMapStaticGeometryChunks([geometryChunk(999)]) } } as MessageEvent<MapGeometryPrepareWorkerResponse>);
      }
      oldError({ message: 'late cancelled worker error' } as ErrorEvent);
      assert.equal(observationsB.length, 0);
      workerB.result(10);
      const result = await promiseB;
      assert.deepEqual(result.bounds?.min, [10, 0, 0]);
      assert.deepEqual(observationsA.map((event) => [event.jobId, event.status]), [[idA, 'cancelled']]);
      assert.deepEqual(observationsB.map((event) => [event.jobId, event.status]), [[idB, 'completed']]);
      assert.equal(client.getStats().cancelled, 1);
      assert.equal(client.getStats().completed, 1);
    } finally {
      client.dispose();
    }
  });

  it('reports queued cancellation and active or queued disposal once without completing them', async () => {
    const worker = new FakeWorker();
    const client = new MapGeometryPrepareClient(() => worker, { concurrency: 1, maxQueued: 2 });
    const active: MapGeometryPrepareObservation[] = [];
    const cancelled: MapGeometryPrepareObservation[] = [];
    const queued: MapGeometryPrepareObservation[] = [];
    const abort = new AbortController();
    const promiseA = client.prepare([geometryChunk(0)], undefined, {}, (event) => {
      active.push(event);
      throw new Error('active disposal observer unavailable');
    });
    const promiseB = client.prepare([geometryChunk(1)], abort.signal, {}, (event) => {
      cancelled.push(event);
      throw new Error('queued cancel observer unavailable');
    });
    const promiseC = client.prepare([geometryChunk(2)], undefined, {}, (event) => {
      queued.push(event);
      throw new Error('queued disposal observer unavailable');
    });
    const oldCallback = worker.onmessage!;
    const idA = worker.posted[0]!.jobId;
    const outcomes = Promise.all([
      assert.rejects(promiseA, { code: 'MAP_PREPARE_CLIENT_DISPOSED' }),
      assert.rejects(promiseB, { code: 'MAP_PREPARE_CANCELLED' }),
      assert.rejects(promiseC, { code: 'MAP_PREPARE_CLIENT_DISPOSED' })
    ]);
    abort.abort();
    client.dispose();
    client.dispose();
    oldCallback({ data: { kind: 'result', jobId: idA, prepared: prepareMapStaticGeometryChunks([geometryChunk(999)]) } } as MessageEvent<MapGeometryPrepareWorkerResponse>);
    await outcomes;
    assert.deepEqual(active.map((event) => event.status), ['cancelled']);
    assert.deepEqual(cancelled.map((event) => event.status), ['cancelled']);
    assert.deepEqual(queued.map((event) => event.status), ['cancelled']);
    assert.equal(typeof active[0]!.startedAtMs, 'number');
    assert.equal(cancelled[0]!.startedAtMs, null);
    assert.equal(queued[0]!.startedAtMs, null);
    assert.equal(new Set([active[0]!.jobId, cancelled[0]!.jobId, queued[0]!.jobId]).size, 3);
    assert.equal(client.getStats().completed, 0);
    assert.equal(client.getStats().cancelled, 3);
    assert.equal(client.getStats().activeWorkers, 0);
    assert.equal(client.getStats().queuedJobs, 0);
  });

  it('reports worker failure from the real callback without changing its structured error', async () => {
    const worker = new FakeWorker();
    const observations: MapGeometryPrepareObservation[] = [];
    const client = new MapGeometryPrepareClient(() => worker, { concurrency: 1 });
    try {
      const promise = client.prepare([geometryChunk(0)], undefined, {}, (event) => {
        observations.push(event);
        throw new Error('failure observer unavailable');
      });
      const jobId = worker.posted[0]!.jobId;
      const response: MapGeometryPrepareWorkerResponse = {
        kind: 'error', jobId, error: { code: 'DECODE_FAILED', message: 'decode failed' }, prepareDurationMs: Infinity
      };
      worker.onmessage!({ data: response } as MessageEvent<MapGeometryPrepareWorkerResponse>);
      worker.onmessage!({ data: response } as MessageEvent<MapGeometryPrepareWorkerResponse>);
      await assert.rejects(promise, { code: 'MAP_PREPARE_WORKER_FAILED', message: 'decode failed' });
      assert.equal(observations.length, 1);
      assert.equal(observations[0]!.jobId, jobId);
      assert.equal(observations[0]!.status, 'failed');
      assert.equal(observations[0]!.reportedWorkerDurationMs, Infinity);
      assert.equal(client.getStats().failed, 1);
      assert.equal(client.getStats().totalPrepareDurationMs, 0);
    } finally {
      client.dispose();
    }
  });

  it('reports timeout once and ignores a saved callback from the timed-out worker', async () => {
    const workers: FakeWorker[] = [];
    const observations: MapGeometryPrepareObservation[] = [];
    const client = new MapGeometryPrepareClient(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    }, { concurrency: 1, timeoutMs: 5 });
    try {
      const promise = client.prepare([geometryChunk(0)], undefined, {}, (event) => {
        observations.push(event);
        throw new Error('timeout observer unavailable');
      });
      const oldCallback = workers[0]!.onmessage!;
      const jobId = workers[0]!.posted[0]!.jobId;
      await assert.rejects(promise, { code: 'MAP_PREPARE_TIMEOUT' });
      oldCallback({ data: { kind: 'result', jobId, prepared: prepareMapStaticGeometryChunks([geometryChunk(999)]) } } as MessageEvent<MapGeometryPrepareWorkerResponse>);
      assert.deepEqual(observations.map((event) => [event.jobId, event.status]), [[jobId, 'timeout']]);
      assert.equal(client.getStats().timedOut, 1);
      assert.equal(client.getStats().completed, 0);
      assert.equal(workers.length, 2);
    } finally {
      client.dispose();
    }
  });

  for (const [label, enqueueOrigin, completionOrigin] of [
    ['throwing enqueue', () => { throw new Error('origin unavailable'); }, () => 1000],
    ['throwing completion', () => 1000, () => { throw new Error('origin unavailable'); }],
    ['nonfinite origins', () => NaN, () => Infinity]
  ] as const) {
    it(`preserves success when ${label} and a throwing observer cannot supply diagnostics`, async () => {
      let atCompletion = false;
      await withRendererClock({
        now: () => 25,
        get timeOrigin() { return (atCompletion ? completionOrigin : enqueueOrigin)(); }
      }, async () => {
        const worker = new FakeWorker();
        const observations: MapGeometryPrepareObservation[] = [];
        const client = new MapGeometryPrepareClient(() => worker, { concurrency: 1 });
        try {
          const promise = client.prepare([geometryChunk(0)], undefined, {}, (event) => {
            observations.push(event);
            throw new Error('observer unavailable');
          });
          const jobId = worker.posted[0]!.jobId;
          const prepared = prepareMapStaticGeometryChunks([geometryChunk(0)]);
          atCompletion = true;
          worker.onmessage!({ data: { kind: 'result', jobId, prepared } } as MessageEvent<MapGeometryPrepareWorkerResponse>);
          const result = await promise;
          assert.deepEqual(result, { ...prepared, cacheKey: jobId });
          assert.equal(result.positionsBytes, prepared.positionsBytes);
          assert.equal(observations.length, 1);
          assert.equal(observations[0]!.status, 'completed');
          assert.equal(observations[0]!.timeOriginAtEnqueue, label === 'throwing completion' ? 1000 : null);
          assert.equal(observations[0]!.timeOriginAtCompletion, label === 'throwing enqueue' ? 1000 : null);
          assert.equal(client.getStats().completed, 1);
          assert.equal(client.getStats().failed, 0);
          assert.equal(client.getStats().activeWorkers, 0);
          assert.equal(client.getStats().queuedJobs, 0);
        } finally {
          client.dispose();
        }
      });
    });
  }
});

describe('MAP geometry prepare worker client', () => {
  it('cancellation terminates A and ignores its late callback before B commits', async () => {
    const workers: FakeWorker[] = [];
    const telemetry: MapGeometryPrepareTelemetryEvent[] = [];
    const client = new MapGeometryPrepareClient(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    }, {
      concurrency: 1,
      maxQueued: 2,
      onTelemetry: (event) => telemetry.push(event)
    });

    const abortA = new AbortController();
    const promiseA = client.prepare([geometryChunk(0)], abortA.signal);
    const workerA = workers[0]!;
    const oldCallback = workerA.onmessage!;
    const oldError = workerA.onerror!;
    abortA.abort();
    await assert.rejects(promiseA, (error: unknown) => (
      error instanceof Error && 'code' in error && error.code === 'MAP_PREPARE_CANCELLED'
    ));
    assert.equal(workerA.terminated, true);

    const promiseB = client.prepare([geometryChunk(10)]);
    const workerB = workers[1]!;
    oldCallback({
      data: {
        kind: 'result',
        jobId: workerA.posted[0]!.jobId,
        prepared: prepareMapStaticGeometryChunks([geometryChunk(999)])
      }
    } as MessageEvent<MapGeometryPrepareWorkerResponse>);
    oldError({ message: 'late A worker error' } as ErrorEvent);
    workerB.result(10);
    const preparedB = await promiseB;
    assert.equal(preparedB.vertexCount, 3);
    assert.deepEqual(preparedB.bounds?.min, [10, 0, 0]);
    assert.deepEqual(telemetry.map((event) => event.status), ['cancelled', 'completed']);
    assert.equal(telemetry[1]?.prepareDurationMs, 1.25);
    assert.equal(client.getStats().completed, 1);
    assert.equal(client.getStats().cancelled, 1);
    client.dispose();
  });

  it('timeout returns a structured error, terminates the worker and replaces its slot', async () => {
    const workers: FakeWorker[] = [];
    const client = new MapGeometryPrepareClient(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    }, { concurrency: 1, maxQueued: 2, timeoutMs: 5 });
    const promise = client.prepare([geometryChunk(0)]);
    await assert.rejects(promise, (error: unknown) => (
      error instanceof Error && 'code' in error && error.code === 'MAP_PREPARE_TIMEOUT'
    ));
    assert.equal(workers[0]!.terminated, true);
    assert.equal(workers.length, 2);
    assert.equal(client.getStats().timedOut, 1);
    client.dispose();
  });

  it('worker creation failure is structured and does not fabricate geometry', async () => {
    const client = new MapGeometryPrepareClient(() => {
      throw new Error('Worker API unavailable');
    });
    const promise = client.prepare([geometryChunk(0)]);
    await assert.rejects(promise, (error: unknown) => (
      error instanceof Error
      && 'code' in error
      && error.code === 'MAP_PREPARE_WORKER_UNAVAILABLE'
    ));
    assert.equal(client.getStats().completed, 0);
  });

  it('continuous startup errors fail closed with a bounded factory count', async () => {
    let factoryCalls = 0;
    const client = new MapGeometryPrepareClient(() => {
      factoryCalls += 1;
      return new StartupErrorWorker();
    }, { concurrency: 1, maxQueued: 2 });
    const promise = client.prepare([geometryChunk(0)]);
    await assert.rejects(promise, (error: unknown) => (
      error instanceof Error && 'code' in error && error.code === 'MAP_PREPARE_WORKER_FAILED'
    ));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(factoryCalls, 2);
    await assert.rejects(client.prepare([geometryChunk(1)]), (error: unknown) => (
      error instanceof Error && 'code' in error && error.code === 'MAP_PREPARE_WORKER_UNAVAILABLE'
    ));
    client.dispose();
  });

  it('prepared bytes are fresh, complete typed arrays and do not retain base64 payloads', () => {
    const preparedA = prepareMapStaticGeometryChunks([geometryChunk(0), geometryChunk(10)]);
    const preparedB = prepareMapStaticGeometryChunks([geometryChunk(20)]);
    assert.equal(preparedA.positionsBase64, '');
    assert.ok(preparedA.positionsBytes instanceof Uint8Array);
    assert.ok(preparedA.indicesBytes instanceof Uint8Array);
    assert.equal(preparedA.positionsBytes!.byteOffset, 0);
    assert.equal(preparedA.indicesBytes!.byteOffset, 0);
    assert.equal(preparedA.vertexCount, 6);
    assert.deepEqual(preparedA.materialGroups, [
      { start: 0, count: 3, materialIndex: 0 },
      { start: 3, count: 3, materialIndex: 0 }
    ]);
    assert.equal(preparedA.indexSize, 16);
    assert.deepEqual(
      Array.from(new Uint16Array(
        preparedA.indicesBytes!.buffer,
        preparedA.indicesBytes!.byteOffset,
        preparedA.indicesBytes!.byteLength / Uint16Array.BYTES_PER_ELEMENT
      )),
      [0, 1, 2, 3, 4, 5]
    );
    assert.equal(preparedA.textureIdentities[0]?.textureKey, null);

    const wideIndexChunk = {
      ...geometryChunk(0),
      indicesBase64: Buffer.from(new Uint32Array([0, 1, 2]).buffer).toString('base64'),
      indexElementBytes: 4 as const
    };
    const preparedWide = prepareMapStaticGeometryChunks([wideIndexChunk]);
    assert.equal(preparedWide.indexSize, 32);
    assert.deepEqual(
      Array.from(new Uint32Array(
        preparedWide.indicesBytes!.buffer,
        preparedWide.indicesBytes!.byteOffset,
        preparedWide.indicesBytes!.byteLength / Uint32Array.BYTES_PER_ELEMENT
      )),
      [0, 1, 2]
    );

    const largePositionChunk = {
      positionsBase64: Buffer.alloc(65_536 * 3 * Float32Array.BYTES_PER_ELEMENT).toString('base64'),
      indicesBase64: Buffer.from(new Uint16Array([0, 1, 2]).buffer).toString('base64'),
      indexElementBytes: 2 as const
    };
    const promoted = prepareMapStaticGeometryChunks([largePositionChunk, geometryChunk(0)]);
    assert.equal(promoted.indexSize, 32);
    assert.equal(
      new Uint32Array(
        promoted.indicesBytes!.buffer,
        promoted.indicesBytes!.byteOffset,
        promoted.indicesBytes!.byteLength / Uint32Array.BYTES_PER_ELEMENT
      )[3],
      65_536
    );

    // Model the worker postMessage transfer: B's source-side buffers detach,
    // while the older visible A payload and its sentinel remain readable.
    const sentinelA = preparedA.positionsBytes![0];
    const transferred = structuredClone(preparedB, {
      transfer: preparedGeometryTransferables(preparedB)
    });
    assert.equal(preparedB.positionsBytes!.byteLength, 0);
    assert.equal(preparedA.positionsBytes!.byteLength > 0, true);
    assert.equal(preparedA.positionsBytes![0], sentinelA);
    assert.ok(transferred.positionsBytes instanceof Uint8Array);
    assert.equal(transferred.positionsBytes!.byteLength, 3 * 3 * Float32Array.BYTES_PER_ELEMENT);
  });

  it('FaceSet cull 元数据按 source provenance 保留 true/false variant', () => {
    const prepared = prepareMapStaticGeometryChunks([
      {
        ...geometryChunk(0),
        chunkId: 'surface-a',
        sourceTriangleStart: 12,
        triangleCount: 1,
        selectedFaceSetOrdinals: [3],
        faceSetCullBackfaces: [true]
      },
      {
        ...geometryChunk(10),
        chunkId: 'surface-b',
        sourceTriangleStart: 13,
        triangleCount: 1,
        selectedFaceSetOrdinals: [7],
        faceSetCullBackfaces: [false]
      }
    ]);

    assert.deepEqual(prepared.materialGroups, [
      {
        start: 0,
        count: 3,
        materialIndex: 0,
        faceSetOrdinals: [3],
        faceSetCullBackfaces: [true],
        cullBackfaces: true,
        sourceChunkId: 'surface-a',
        sourceTriangleStart: 12,
        sourceTriangleCount: 1
      },
      {
        start: 3,
        count: 3,
        materialIndex: 0,
        faceSetOrdinals: [7],
        faceSetCullBackfaces: [false],
        cullBackfaces: false,
        sourceChunkId: 'surface-b',
        sourceTriangleStart: 13,
        sourceTriangleCount: 1
      }
    ]);
    assert.equal(prepared.diagnostics, undefined);
    assert.equal(prepared.indexSize, 16);
  });

  it('FaceSet cull 候选歧义时保留原数组并显式降级 unknown', () => {
    const prepared = prepareMapStaticGeometryChunks([
      {
        ...geometryChunk(0),
        chunkId: 'ambiguous',
        sourceTriangleStart: 0,
        triangleCount: 1,
        selectedFaceSetOrdinals: [3, 4],
        faceSetCullBackfaces: [true, false]
      },
      {
        ...geometryChunk(10),
        chunkId: 'mismatch',
        sourceTriangleStart: 1,
        triangleCount: 2,
        selectedFaceSetOrdinals: [7],
        faceSetCullBackfaces: [true]
      }
    ]);

    assert.deepEqual(prepared.materialGroups, [
      {
        start: 0,
        count: 3,
        materialIndex: 0,
        faceSetOrdinals: [3, 4],
        faceSetCullBackfaces: [true, false],
        sourceChunkId: 'ambiguous',
        sourceTriangleStart: 0,
        sourceTriangleCount: 1
      },
      {
        start: 3,
        count: 3,
        materialIndex: 0,
        faceSetOrdinals: [7],
        faceSetCullBackfaces: [true],
        sourceChunkId: 'mismatch',
        sourceTriangleStart: 1,
        sourceTriangleCount: 2
      }
    ]);
    assert.deepEqual(
      prepared.diagnostics?.map((diagnostic) => diagnostic.code),
      [
        'MAP_STATIC_GEOMETRY_CULL_METADATA_AMBIGUOUS',
        'MAP_STATIC_GEOMETRY_CULL_METADATA_AMBIGUOUS'
      ]
    );
    assert.equal(
      (prepared.materialGroups as Array<{ cullBackfaces?: boolean }> | undefined)
        ?.every((group) => group.cullBackfaces === undefined),
      true
    );
  });

  it('worker prepare computes missing normals and top-level texture identity', () => {
    const chunk = geometryChunk(0);
    const { normalsBase64: _nativeNormals, texturePreviewToken: _chunkToken, ...withoutNormals } = chunk;
    const prepared = prepareMapStaticGeometryChunks([withoutNormals], {
      texturePreviewToken: 'data:image/png;base64,AAAA',
      textureColorSpace: 'srgb'
    });
    const normals = new Float32Array(
      prepared.normalsBytes!.buffer,
      prepared.normalsBytes!.byteOffset,
      prepared.normalsBytes!.byteLength / Float32Array.BYTES_PER_ELEMENT
    );
    assert.deepEqual(Array.from(normals), [
      0, 0, 1,
      0, 0, 1,
      0, 0, 1
    ]);
    assert.equal(prepared.textureIdentities[0]?.materialIndex, 0);
    assert.equal(prepared.textureIdentities[0]?.textureKey, '0ce4918c');
  });
});
