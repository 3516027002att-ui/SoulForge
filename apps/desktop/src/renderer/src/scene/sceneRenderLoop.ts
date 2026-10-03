/** Owns frame cadence/invalidation; callers own scene and semantic animation. */
export class SceneRenderLoop {
  private readonly render: () => void;
  private readonly update: (deltaSeconds: number) => void;
  private readonly now: () => number;
  private readonly schedule: (callback: FrameRequestCallback) => number;
  private readonly cancel: (id: number) => void;
  private requested = true;
  private disposed = false;
  private started = false;
  private frame: number | null = null;
  private lastTick = 0;
  private lastRenderAt = Number.NEGATIVE_INFINITY;
  constructor(options: {
    render: () => void;
    update: (deltaSeconds: number) => void;
    now?: () => number;
    schedule?: (callback: FrameRequestCallback) => number;
    cancel?: (id: number) => void;
  }) {
    this.render = options.render;
    this.update = options.update;
    this.now = options.now ?? (() => performance.now());
    this.schedule = options.schedule ?? ((callback) => requestAnimationFrame(callback));
    this.cancel = options.cancel ?? ((id) => cancelAnimationFrame(id));
  }
  requestRender = (): void => { if (!this.disposed) this.requested = true; };
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.lastTick = this.now();
    this.tick(this.lastTick);
  }
  private tick = (current: number): void => {
    if (this.disposed) return;
    const delta = Math.max(0, Math.min((current - this.lastTick) / 1000, 0.1));
    this.lastTick = current;
    this.update(delta);
    if (this.requested && current - this.lastRenderAt >= 1000 / 30) {
      // Clear before submitting so an invalidation during render is retained.
      this.requested = false;
      this.render();
      this.lastRenderAt = current;
    }
    this.frame = this.schedule(this.tick);
  };
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frame !== null) this.cancel(this.frame);
    this.frame = null;
  }
}
