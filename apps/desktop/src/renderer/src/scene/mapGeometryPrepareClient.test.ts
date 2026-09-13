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
