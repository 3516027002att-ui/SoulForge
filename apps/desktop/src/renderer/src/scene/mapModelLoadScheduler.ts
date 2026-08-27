import type { SceneDrawItem } from '@soulforge/shared';

export type MapMeshGeometry = NonNullable<SceneDrawItem['mesh']>;

export function normalizeMapModelKey(modelName: string): string {
  const base = modelName.replace(/\\/g, '/').split('/').pop() ?? modelName;
  return base.toLowerCase().replace(/\.(flver|mapbnd|objbnd|chrbnd)(\.dcx)?$/i, '');
}

/**
 * One map/revision owns one cache. Resolved misses are cached as well so a
 * selection click cannot restart an already failed Bridge lookup.
 */
export class MapModelLoadCache {
  private readonly resolved = new Map<string, MapMeshGeometry | null>();
  private readonly inFlight = new Map<string, Promise<MapMeshGeometry | null>>();
  private disposed = false;

  public constructor(
    private readonly loader: (modelName: string) => Promise<MapMeshGeometry | null>
  ) {}

  public load(modelName: string): Promise<MapMeshGeometry | null> {
    const key = normalizeMapModelKey(modelName);
    if (this.resolved.has(key)) return Promise.resolve(this.resolved.get(key) ?? null);
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const request = this.loader(modelName)
      .then((geometry) => {
        if (!this.disposed) this.resolved.set(key, geometry);
        return geometry;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, request);
    return request;
  }

  public dispose(): void {
    this.disposed = true;
    this.resolved.clear();
    this.inFlight.clear();
  }
}

type FrameScheduler = (callback: FrameRequestCallback) => number;
type FrameCanceller = (handle: number) => void;

interface QueuedFrameTask {
  run: () => void;
  resolve: (ran: boolean) => void;
  reject: (error: unknown) => void;
}

/**
 * Drains synchronous GPU upload work inside a small per-frame budget. A large
 * Bridge batch can therefore finish without turning into one long renderer
 * task when all promises settle together.
 */
export class FrameTaskQueue {
  private readonly tasks: QueuedFrameTask[] = [];
  private frameHandle: number | null = null;
  private disposed = false;

  public constructor(
    private readonly scheduleFrame: FrameScheduler = requestAnimationFrame,
    private readonly cancelFrame: FrameCanceller = cancelAnimationFrame,
    private readonly now: () => number = () => performance.now(),
    private readonly frameBudgetMs = 6
  ) {}

  public enqueue(run: () => void): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    const pending = new Promise<boolean>((resolve, reject) => {
      this.tasks.push({ run, resolve, reject });
    });
    this.ensureFrame();
    return pending;
  }

  public dispose(): void {
    this.disposed = true;
    if (this.frameHandle !== null) this.cancelFrame(this.frameHandle);
    this.frameHandle = null;
    for (const task of this.tasks.splice(0)) task.resolve(false);
  }

  private ensureFrame(): void {
    if (this.disposed || this.frameHandle !== null || this.tasks.length === 0) return;
    this.frameHandle = this.scheduleFrame(() => this.drainFrame());
  }

  private drainFrame(): void {
    this.frameHandle = null;
    if (this.disposed) return;
    const startedAt = this.now();
    do {
      const task = this.tasks.shift();
      if (!task) break;
      try {
        task.run();
        task.resolve(true);
      } catch (error) {
        task.reject(error);
      }
    } while (this.tasks.length > 0 && this.now() - startedAt < this.frameBudgetMs);
    this.ensureFrame();
  }
}
