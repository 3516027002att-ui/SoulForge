/**
 * MAP renderer 读取的 owner/request 注册表。
 *
 * requestId 只是 renderer 可序列化的不透明句柄；AbortController 永远只
 * 留在 main。槽位按 webContents.id + requestId 隔离，不能因为另一窗口
 * 使用了相同的 requestId 而互相取消。
 */

export interface MapRequestOwnerLifecycle {
  once(event: 'destroyed' | 'render-process-gone', listener: () => void): unknown;
  removeListener?(event: 'destroyed' | 'render-process-gone', listener: () => void): unknown;
}

export interface MapRequestLease {
  readonly ownerId: number;
  readonly requestId: string;
  readonly controller: AbortController;
}

export type MapRequestBeginResult =
  | { status: 'started'; lease: MapRequestLease }
  | { status: 'duplicate'; lease: null };

export type MapRequestCancelResult =
  | { status: 'cancelled'; lease: MapRequestLease }
  | { status: 'already-cancelled'; lease: MapRequestLease }
  | { status: 'not-found'; lease: null };

export type MapRequestExecutionResult<T> =
  | { outcome: 'completed'; value: T }
  | { outcome: 'cancelled' };

/**
 * Shared late-settlement guard for every MAP request generation.
 *
 * The work may resolve after the caller has cancelled its AbortController;
 * that value is deliberately discarded instead of being published.  Keeping
 * this helper independent of Electron lets the focused async test exercise
 * the exact production guard used by map.ts.
 */
export async function executeMapRequest<T>(
  controller: AbortController,
  work: (signal: AbortSignal) => Promise<T>
): Promise<MapRequestExecutionResult<T>> {
  // Cancellation can win between registry.begin() and the async executor
  // entering this helper. Do not start a Bridge read for an already-aborted
  // generation; the caller still receives the same structured cancellation
  // outcome as an in-flight abort.
  if (controller.signal.aborted) return { outcome: 'cancelled' };
  try {
    const value = await work(controller.signal);
    if (controller.signal.aborted) return { outcome: 'cancelled' };
    return { outcome: 'completed', value };
  } catch (error) {
    if (controller.signal.aborted || isMapRequestCancellationError(error)) {
      return { outcome: 'cancelled' };
    }
    throw error;
  }
}

export function isMapRequestCancellationError(error: unknown): boolean {
  return error instanceof Error && error.message === 'MAP_REQUEST_CANCELLED';
}

interface OwnerListener {
  readonly owner: MapRequestOwnerLifecycle;
  readonly listener: () => void;
}

function keyFor(ownerId: number, requestId: string): string {
  return `${ownerId}\u0000${requestId}`;
}

/**
 * MAP read request lifetime. The caller must call begin synchronously before
 * its first await and finish with the exact controller in a finally block.
 */
export class MapRequestCancellationRegistry {
  private readonly requests = new Map<string, MapRequestLease>();
  private readonly owners = new Map<number, OwnerListener>();

  public begin(ownerId: number, requestId: string): MapRequestBeginResult {
    const key = keyFor(ownerId, requestId);
    if (this.requests.has(key)) return { status: 'duplicate', lease: null };
    const lease: MapRequestLease = {
      ownerId,
      requestId,
      controller: new AbortController()
    };
    this.requests.set(key, lease);
    return { status: 'started', lease };
  }

  /** Register one destroyed/render-process-gone listener pair per owner. */
  public bindOwner(ownerId: number, owner: MapRequestOwnerLifecycle): void {
    if (this.owners.has(ownerId)) return;
    const listener = (): void => {
      this.disposeOwner(ownerId);
    };
    this.owners.set(ownerId, { owner, listener });
    owner.once('destroyed', listener);
    owner.once('render-process-gone', listener);
  }

  public cancel(ownerId: number, requestId: string): MapRequestCancelResult {
    const lease = this.requests.get(keyFor(ownerId, requestId));
    if (!lease) return { status: 'not-found', lease: null };
    if (lease.controller.signal.aborted) return { status: 'already-cancelled', lease };
    lease.controller.abort();
    return { status: 'cancelled', lease };
  }

  /** Remove only the still-current controller; a stale completion cannot erase a newer request. */
  public finish(ownerId: number, requestId: string, controller: AbortController): boolean {
    const key = keyFor(ownerId, requestId);
    const lease = this.requests.get(key);
    if (!lease || lease.controller !== controller) return false;
    this.requests.delete(key);
    this.detachOwnerIfIdle(ownerId);
    return true;
  }

  /** Window close is an owner-scoped cancellation, never a global cancellation. */
  public disposeOwner(ownerId: number): number {
    let cancelled = 0;
    for (const [key, lease] of this.requests) {
      if (lease.ownerId !== ownerId) continue;
      if (!lease.controller.signal.aborted) {
        lease.controller.abort();
        cancelled += 1;
      }
      this.requests.delete(key);
    }
    this.detachOwnerIfIdle(ownerId);
    return cancelled;
  }

  public get size(): number {
    return this.requests.size;
  }

  /** Focused-test visibility; no production caller needs the count. */
  public get ownerListenerCount(): number {
    return this.owners.size;
  }

  private detachOwnerIfIdle(ownerId: number): void {
    for (const lease of this.requests.values()) {
      if (lease.ownerId === ownerId) return;
    }
    const entry = this.owners.get(ownerId);
    if (!entry) return;
    entry.owner.removeListener?.('destroyed', entry.listener);
    entry.owner.removeListener?.('render-process-gone', entry.listener);
    this.owners.delete(ownerId);
  }
}

/** Renderer-facing request IDs are opaque but bounded before they enter a map key. */
export function normalizeMapRequestId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 160) return null;
  return normalized;
}
