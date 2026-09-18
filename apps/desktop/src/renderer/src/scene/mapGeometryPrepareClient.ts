import {
  type MapGeometryPrepareWorkerRequest,
  type MapGeometryPrepareWorkerResponse,
  type MapStaticGeometryChunk,
  type PreparedMapGeometry
} from './mapGeometryPrepare.js';

export type MapGeometryPrepareWorkerPort = {
  postMessage(message: MapGeometryPrepareWorkerRequest): void;
  terminate(): void | Promise<void>;
  onmessage: ((event: MessageEvent<MapGeometryPrepareWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
};

export type MapGeometryPrepareWorkerFactory = () => MapGeometryPrepareWorkerPort;

export type MapGeometryPrepareErrorCode =
  | 'MAP_PREPARE_WORKER_UNAVAILABLE'
  | 'MAP_PREPARE_WORKER_FAILED'
  | 'MAP_PREPARE_QUEUE_FULL'
  | 'MAP_PREPARE_CANCELLED'
  | 'MAP_PREPARE_TIMEOUT'
  | 'MAP_PREPARE_CLIENT_DISPOSED';

export interface MapGeometryPrepareTelemetryEvent {
  kind: 'map-geometry-prepare';
  status: 'completed' | 'failed' | 'cancelled' | 'timeout';
  /** Client turnaround after a worker slot starts; includes transfer/wait. */
  clientDurationMs: number;
  /** Pure worker prepare duration reported by the worker, when available. */
  prepareDurationMs?: number;
  queueWaitMs: number;
  activeWorkers: number;
  queuedJobs: number;
  errorCode?: MapGeometryPrepareErrorCode;
}

export interface MapGeometryPrepareStats {
  submitted: number;
  completed: number;
  failed: number;
  cancelled: number;
  timedOut: number;
  activeWorkers: number;
  queuedJobs: number;
  totalDurationMs: number;
  totalPrepareDurationMs: number;
}

export class MapGeometryPrepareError extends Error {
  public readonly code: MapGeometryPrepareErrorCode;

  public constructor(code: MapGeometryPrepareErrorCode, message: string) {
    super(message);
    this.name = 'MapGeometryPrepareError';
    this.code = code;
  }
}

function createDefaultWorker(): MapGeometryPrepareWorkerPort {
  if (typeof Worker === 'undefined') {
    throw new MapGeometryPrepareError(
      'MAP_PREPARE_WORKER_UNAVAILABLE',
      'MAP_PREPARE_WORKER_UNAVAILABLE: renderer Worker API is unavailable'
    );
  }
  return new Worker(new URL('./mapGeometryPrepareWorker.ts', import.meta.url), { type: 'module' });
}

interface PrepareJob {
  id: string;
  chunks: MapStaticGeometryChunk[];
  resolve: (prepared: PreparedMapGeometry) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal | undefined;
  abortListener?: () => void;
  enqueuedAt: number;
  startedAt?: number;
  timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  metadata: { texturePreviewToken?: string; textureColorSpace?: string };
}

interface WorkerSlot {
  worker: MapGeometryPrepareWorkerPort;
  job: PrepareJob | null;
  /** Incremented whenever a worker is replaced; stale callbacks are ignored. */
  epoch: number;
  /** Startup failures are fail-closed before an unbounded replacement loop. */
  hasRunJob: boolean;
  restartAttempts: number;
}

/**
 * Bounded renderer-side CPU preparation pool. GPU/Three work is intentionally
 * not performed here; this pool only moves decode, merge, index-offset and
 * renderer-local texture identity work off the renderer event loop.
 */
export class MapGeometryPrepareClient {
  private readonly slots: WorkerSlot[] = [];
  private readonly queued: PrepareJob[] = [];
  private readonly jobs = new Map<string, PrepareJob>();
  private readonly concurrency: number;
  private readonly maxQueued: number;
  private readonly timeoutMs: number;
  private readonly onTelemetry: ((event: MapGeometryPrepareTelemetryEvent) => void) | undefined;
  private sequence = 0;
  private disposed = false;
  private unavailable: MapGeometryPrepareError | null = null;
  private submitted = 0;
  private completed = 0;
  private failed = 0;
  private cancelled = 0;
  private timedOut = 0;
  private totalDurationMs = 0;
  private totalPrepareDurationMs = 0;

  public constructor(
    private readonly workerFactory: MapGeometryPrepareWorkerFactory = createDefaultWorker,
    options: {
      concurrency?: number;
      maxQueued?: number;
      timeoutMs?: number;
      onTelemetry?: (event: MapGeometryPrepareTelemetryEvent) => void;
    } = {}
  ) {
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));
    this.maxQueued = Math.max(this.concurrency, Math.floor(options.maxQueued ?? 32));
    this.timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 120_000));
    this.onTelemetry = options.onTelemetry;
  }

  public getStats(): MapGeometryPrepareStats {
    return {
      submitted: this.submitted,
      completed: this.completed,
      failed: this.failed,
      cancelled: this.cancelled,
      timedOut: this.timedOut,
      activeWorkers: this.slots.filter((slot) => slot.job !== null).length,
      queuedJobs: this.queued.length,
      totalDurationMs: this.totalDurationMs,
      totalPrepareDurationMs: this.totalPrepareDurationMs
    };
  }

  public prepare(
    chunks: readonly MapStaticGeometryChunk[],
    signal?: AbortSignal,
    metadata: { texturePreviewToken?: string; textureColorSpace?: string } = {}
  ): Promise<PreparedMapGeometry> {
    if (this.disposed) {
      return Promise.reject(new MapGeometryPrepareError(
        'MAP_PREPARE_CLIENT_DISPOSED',
        'MAP_PREPARE_CLIENT_DISPOSED: preparation client has been disposed'
      ));
    }
    if (signal?.aborted) {
      return Promise.reject(new MapGeometryPrepareError(
        'MAP_PREPARE_CANCELLED',
        'MAP_PREPARE_CANCELLED: model preparation was aborted before enqueue'
      ));
    }
    if (this.unavailable) return Promise.reject(this.unavailable);
    if (this.queued.length >= this.maxQueued) {
      return Promise.reject(new MapGeometryPrepareError(
        'MAP_PREPARE_QUEUE_FULL',
        `MAP_PREPARE_QUEUE_FULL: at most ${this.maxQueued} queued models are allowed`
      ));
    }

    const id = `map-prepare-${Date.now().toString(36)}-${(++this.sequence).toString(36)}`;
    return new Promise<PreparedMapGeometry>((resolve, reject) => {
      const job: PrepareJob = {
        id,
        chunks: chunks.map((chunk) => ({ ...chunk })),
        resolve,
        reject,
        signal,
        enqueuedAt: performance.now(),
        timeoutHandle: undefined,
        metadata
      };
      this.submitted += 1;
      job.abortListener = () => this.cancelJob(id);
      signal?.addEventListener('abort', job.abortListener, { once: true });
      this.queued.push(job);
      this.jobs.set(id, job);
      try {
        this.ensureSlots();
        this.pump();
      } catch (error) {
        this.failUnavailable(error);
      }
    });
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = new MapGeometryPrepareError(
      'MAP_PREPARE_CLIENT_DISPOSED',
      'MAP_PREPARE_CLIENT_DISPOSED: preparation client has been disposed'
    );
    const jobs = [...new Set(this.jobs.values())];
    for (const job of jobs) {
      this.cleanupJob(job);
      this.recordJobOutcome(job, error);
      job.reject(error);
    }
    this.queued.splice(0);
    this.jobs.clear();
    for (const slot of this.slots.splice(0)) {
      slot.job = null;
      this.terminateWorker(slot.worker);
    }
  }

  private ensureSlots(): void {
    if (this.slots.length >= this.concurrency) return;
    try {
      while (this.slots.length < this.concurrency) {
        const slot: WorkerSlot = {
          worker: this.workerFactory(),
          job: null,
          epoch: 0,
          hasRunJob: false,
          restartAttempts: 0
        };
        this.attachWorker(slot, slot.worker);
        this.slots.push(slot);
      }
    } catch (error) {
      for (const slot of this.slots.splice(0)) {
        try { void slot.worker.terminate(); } catch { /* best effort */ }
      }
      throw new MapGeometryPrepareError(
        'MAP_PREPARE_WORKER_UNAVAILABLE',
        `MAP_PREPARE_WORKER_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private pump(): void {
    if (this.disposed || this.unavailable) return;
    for (const slot of this.slots) {
      if (slot.job || this.queued.length === 0) continue;
      const job = this.queued.shift()!;
      if (job.signal?.aborted) {
        this.finishJob(slot, job, new MapGeometryPrepareError(
          'MAP_PREPARE_CANCELLED',
          'MAP_PREPARE_CANCELLED: model preparation was aborted while queued'
        ));
        continue;
      }
      slot.job = job;
      slot.hasRunJob = true;
      job.startedAt = performance.now();
      const worker = slot.worker;
      const epoch = slot.epoch;
      try {
        worker.postMessage({
          kind: 'prepare',
          jobId: job.id,
          chunks: job.chunks,
          ...(job.metadata.texturePreviewToken ? { texturePreviewToken: job.metadata.texturePreviewToken } : {}),
          ...(job.metadata.textureColorSpace ? { textureColorSpace: job.metadata.textureColorSpace } : {})
        });
        job.timeoutHandle = setTimeout(() => this.handleTimeout(slot, worker, epoch, job), this.timeoutMs);
      } catch (error) {
        this.finishJob(slot, job, new MapGeometryPrepareError(
          'MAP_PREPARE_WORKER_FAILED',
          `MAP_PREPARE_WORKER_FAILED: ${error instanceof Error ? error.message : String(error)}`
        ));
        this.failUnavailable(error);
      }
    }
  }

  private handleMessage(slot: WorkerSlot, response: MapGeometryPrepareWorkerResponse): void {
    const job = slot.job;
    if (!job || response.jobId !== job.id || !this.jobs.has(job.id)) return;
    if (response.kind === 'result' && response.prepared) {
      this.finishJob(slot, job, null, { ...response.prepared, cacheKey: job.id }, response.prepareDurationMs);
      this.pump();
      return;
    }
    const detail = response.error?.message ?? 'worker returned no prepared geometry';
    this.finishJob(
      slot,
      job,
      new MapGeometryPrepareError('MAP_PREPARE_WORKER_FAILED', detail),
      undefined,
      response.prepareDurationMs
    );
    this.pump();
  }

  private handleWorkerError(slot: WorkerSlot, event: ErrorEvent): void {
    const job = slot.job;
    const detail = event.message || 'worker error';
    const hadActiveJob = job !== null;
    if (job && this.jobs.has(job.id)) {
      this.finishJob(slot, job, new MapGeometryPrepareError(
        'MAP_PREPARE_WORKER_FAILED',
        `MAP_PREPARE_WORKER_FAILED: ${detail}`
      ));
    }
    // A worker that emitted an error is not reusable. Replace only this slot;
    // queued jobs in other slots must keep progressing. If replacement itself
    // is unavailable, fail closed for the whole client with a structured code.
    // An idle worker that failed before ever accepting a job is a startup
    // failure, not a transient model failure; do not restart it indefinitely.
    if (!hadActiveJob && !slot.hasRunJob) {
      this.failUnavailable(new MapGeometryPrepareError(
        'MAP_PREPARE_WORKER_UNAVAILABLE',
        `MAP_PREPARE_WORKER_UNAVAILABLE: startup failed: ${detail}`
      ));
      return;
    }
    this.replaceWorker(slot, new Error(detail));
    this.pump();
  }

  private handleTimeout(
    slot: WorkerSlot,
    worker: MapGeometryPrepareWorkerPort,
    epoch: number,
    job: PrepareJob
  ): void {
    if (this.disposed || slot.worker !== worker || slot.epoch !== epoch || slot.job?.id !== job.id) return;
    this.timedOut += 1;
    this.finishJob(slot, job, new MapGeometryPrepareError(
      'MAP_PREPARE_TIMEOUT',
      `MAP_PREPARE_TIMEOUT: preparation exceeded ${this.timeoutMs}ms`
    ));
    this.terminateWorker(worker);
    if (!this.disposed && !this.unavailable) {
      try {
        slot.hasRunJob = false;
        slot.restartAttempts = 0;
        this.attachWorker(slot, this.workerFactory());
      } catch (error) {
        this.failUnavailable(error);
        return;
      }
      this.pump();
    }
  }

  private cancelJob(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    const error = new MapGeometryPrepareError(
      'MAP_PREPARE_CANCELLED',
      'MAP_PREPARE_CANCELLED: model preparation was aborted'
    );
    const queuedIndex = this.queued.indexOf(job);
    if (queuedIndex >= 0) {
      this.queued.splice(queuedIndex, 1);
      this.cleanupJob(job);
      this.jobs.delete(id);
      this.recordJobOutcome(job, error);
      job.reject(error);
      return;
    }
    const slot = this.slots.find((candidate) => candidate.job?.id === id);
    if (!slot) return;
    this.finishJob(slot, job, error);
    const worker = slot.worker;
    this.terminateWorker(worker);
    if (!this.disposed && !this.unavailable) {
      try {
        slot.hasRunJob = false;
        slot.restartAttempts = 0;
        this.attachWorker(slot, this.workerFactory());
      } catch (replacementError) {
        this.failUnavailable(replacementError);
      }
      this.pump();
    }
  }

  private finishJob(
    slot: WorkerSlot,
    job: PrepareJob,
    error: unknown | null,
    prepared?: PreparedMapGeometry,
    prepareDurationMs?: number
  ): void {
    if (slot.job?.id === job.id) slot.job = null;
    this.jobs.delete(job.id);
    this.cleanupJob(job);
    this.recordJobOutcome(job, error, prepareDurationMs);
    if (error) job.reject(error);
    else if (prepared) job.resolve(prepared);
    else job.reject(new MapGeometryPrepareError('MAP_PREPARE_WORKER_FAILED', 'worker returned no result'));
  }

  private recordJobOutcome(job: PrepareJob, error: unknown | null, prepareDurationMs?: number): void {
    const clientDurationMs = Math.max(0, performance.now() - (job.startedAt ?? job.enqueuedAt));
    const queueWaitMs = Math.max(0, (job.startedAt ?? performance.now()) - job.enqueuedAt);
    this.totalDurationMs += clientDurationMs;
    if (prepareDurationMs !== undefined && Number.isFinite(prepareDurationMs) && prepareDurationMs >= 0) {
      this.totalPrepareDurationMs += prepareDurationMs;
    }
    const errorCode = error instanceof MapGeometryPrepareError ? error.code : undefined;
    const status = errorCode === 'MAP_PREPARE_CANCELLED' || errorCode === 'MAP_PREPARE_CLIENT_DISPOSED'
      ? 'cancelled'
      : errorCode === 'MAP_PREPARE_TIMEOUT'
        ? 'timeout'
        : error
          ? 'failed'
          : 'completed';
    if (status === 'completed') this.completed += 1;
    else if (status === 'cancelled') this.cancelled += 1;
    else if (status === 'timeout') this.failed += 1;
    else this.failed += 1;
    try {
      this.onTelemetry?.({
        kind: 'map-geometry-prepare',
        status,
        clientDurationMs,
        ...(prepareDurationMs === undefined ? {} : { prepareDurationMs }),
        queueWaitMs,
        activeWorkers: this.slots.filter((candidate) => candidate.job !== null).length,
        queuedJobs: this.queued.length,
        ...(errorCode ? { errorCode } : {})
      });
    } catch {
      // Observability must never change the prepare/commit result.
    }
  }

  private cleanupJob(job: PrepareJob): void {
    if (job.signal && job.abortListener) job.signal.removeEventListener('abort', job.abortListener);
    if (job.timeoutHandle !== undefined) clearTimeout(job.timeoutHandle);
    job.timeoutHandle = undefined;
  }

  private attachWorker(slot: WorkerSlot, worker: MapGeometryPrepareWorkerPort): void {
    slot.worker = worker;
    slot.epoch += 1;
    const epoch = slot.epoch;
    worker.onmessage = (event) => {
      if (slot.worker !== worker || slot.epoch !== epoch) return;
      this.handleMessage(slot, event.data);
    };
    worker.onerror = (event) => {
      if (slot.worker !== worker || slot.epoch !== epoch) return;
      this.handleWorkerError(slot, event);
    };
  }

  private terminateWorker(worker: MapGeometryPrepareWorkerPort): void {
    worker.onmessage = null;
    worker.onerror = null;
    try { void worker.terminate(); } catch { /* best effort */ }
  }

  private replaceWorker(slot: WorkerSlot, error: unknown): void {
    const oldWorker = slot.worker;
    this.terminateWorker(oldWorker);
    if (this.disposed || this.unavailable) return;
    if (slot.restartAttempts >= 2) {
      this.failUnavailable(error);
      return;
    }
    slot.restartAttempts += 1;
    slot.hasRunJob = false;
    try {
      this.attachWorker(slot, this.workerFactory());
    } catch (replacementError) {
      this.failUnavailable(replacementError ?? error);
    }
  }

  private failUnavailable(error: unknown): void {
    if (this.unavailable || this.disposed) return;
    this.unavailable = error instanceof MapGeometryPrepareError && error.code === 'MAP_PREPARE_WORKER_UNAVAILABLE'
      ? error
      : new MapGeometryPrepareError(
        'MAP_PREPARE_WORKER_FAILED',
        `MAP_PREPARE_WORKER_FAILED: ${error instanceof Error ? error.message : String(error)}`
      );
    const jobs = [...new Set(this.jobs.values())];
    for (const job of jobs) {
      this.cleanupJob(job);
      this.recordJobOutcome(job, this.unavailable);
      job.reject(this.unavailable);
    }
    this.queued.splice(0);
    this.jobs.clear();
    for (const slot of this.slots) {
      slot.job = null;
      this.terminateWorker(slot.worker);
    }
  }
}
