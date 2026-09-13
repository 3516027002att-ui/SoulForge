import {
  prepareMapStaticGeometryChunks,
  preparedGeometryTransferables,
  type MapGeometryPrepareWorkerRequest,
  type MapGeometryPrepareWorkerResponse
} from './mapGeometryPrepare.js';

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<MapGeometryPrepareWorkerRequest>) => void) | null;
  postMessage(message: MapGeometryPrepareWorkerResponse, transfer?: Transferable[]): void;
};

workerScope.onmessage = (event: MessageEvent<MapGeometryPrepareWorkerRequest>): void => {
  const request = event.data;
  if (!request || request.kind !== 'prepare') return;
  const startedAt = performance.now();
  try {
    const prepared = prepareMapStaticGeometryChunks(request.chunks, {
      ...(request.texturePreviewToken ? { texturePreviewToken: request.texturePreviewToken } : {}),
      ...(request.textureColorSpace ? { textureColorSpace: request.textureColorSpace } : {})
    });
    const response: MapGeometryPrepareWorkerResponse = {
      kind: 'result',
      jobId: request.jobId,
      prepared,
      prepareDurationMs: Math.max(0, performance.now() - startedAt)
    };
    workerScope.postMessage(response, preparedGeometryTransferables(prepared));
  } catch (error) {
    const response: MapGeometryPrepareWorkerResponse = {
      kind: 'error',
      jobId: request.jobId,
      error: {
        code: 'MAP_GEOMETRY_PREPARE_FAILED',
        message: error instanceof Error ? error.message : String(error)
      },
      prepareDurationMs: Math.max(0, performance.now() - startedAt)
    };
    workerScope.postMessage(response);
  }
};
