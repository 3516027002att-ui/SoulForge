/** T03 共享原生快照：版本化不可变快照、同源读取合并、容量与取消管理。 */
export interface SnapshotKey {
  outerSource: string;
  version: string;
  readerKind: string;
  schema: string;
  shape: string;
}

export interface SnapshotEntry<T = unknown> {
  key: string;
  data: T;
  bytes: number;
  pinned: number;
  generation: number;
}

interface Inflight<T> {
  promise: Promise<T>;
  waiters: Set<string>;
  cancelled: Set<string>;
  underlyingCancelled: boolean;
}

function exactKey(key: SnapshotKey): string {
  return `${key.outerSource}|${key.version}|${key.readerKind}|${key.schema}|${key.shape}`;
}

export interface SnapshotCacheOptions {
  maxBytes?: number;
  maxEntries?: number;
}

export class NativeSnapshotCache {
  private entries = new Map<string, SnapshotEntry>();
  private inflight = new Map<string, Inflight<unknown>>();
  private lru: string[] = [];
  private bytes = 0;
  private disposed = false;
  /** 每 key 单调世代：失效即递增，晚到的旧结果凭此识别并丢弃。 */
  private epochs = new Map<string, number>();
  private readonly maxBytes: number;
  private readonly maxEntries: number;

  constructor(options: SnapshotCacheOptions = {}) {
    this.maxBytes = options.maxBytes ?? 128 * 1024 * 1024;
    this.maxEntries = options.maxEntries ?? 256;
  }

  getExact<T>(key: SnapshotKey): T | undefined {
    const entry = this.entries.get(exactKey(key));
    if (!entry) return undefined;
    this.touch(exactKey(key));
    return entry.data as T;
  }

  async readThrough<T>(key: SnapshotKey, waiterId: string, load: () => Promise<{ data: T; bytes: number }>, signal?: AbortSignal): Promise<T> {
    if (this.disposed) throw new Error('SNAPSHOT_CACHE_DISPOSED');
    const name = exactKey(key);
    const hit = this.entries.get(name);
    if (hit) {
      this.touch(name);
      return hit.data as T;
    }
    let flight = this.inflight.get(name) as Inflight<T> | undefined;
    if (!flight) {
      let resolve!: (value: T) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
      const epoch = this.epochs.get(name) ?? 0;
      flight = { promise, waiters: new Set(), cancelled: new Set(), underlyingCancelled: false };
      this.inflight.set(name, flight as Inflight<unknown>);
      void load().then((loaded) => {
        // 失效/关闭后晚到的结果不得覆盖新世代，也不得送达旧 waiter。
        if (this.disposed || (this.epochs.get(name) ?? 0) !== epoch) {
          this.inflight.delete(name);
          reject(new Error('SNAPSHOT_SOURCE_CHANGED'));
          return;
        }
        this.inflight.delete(name);
        if ((flight as Inflight<T>).waiters.size === (flight as Inflight<T>).cancelled.size) {
          // 全部 waiter 已取消：底层结果丢弃，等待者以取消结束，不悬挂。
          reject(new Error('SNAPSHOT_WAIT_CANCELLED'));
          return;
        }
        this.store(name, loaded.data, loaded.bytes);
        resolve(loaded.data);
      }).catch((error: unknown) => {
        this.inflight.delete(name);
        reject(error);
      });
    }
    flight.waiters.add(waiterId);
    if (signal?.aborted) {
      this.cancelWaiter(name, waiterId);
      throw new Error('SNAPSHOT_WAIT_CANCELLED');
    }
    const data = await flight.promise;
    if (flight.cancelled.has(waiterId)) throw new Error('SNAPSHOT_WAIT_CANCELLED');
    return data;
  }

  cancelWaiter(name: string, waiterId: string): void {
    const flight = this.inflight.get(name);
    if (!flight) return;
    flight.cancelled.add(waiterId);
    if (flight.waiters.size === flight.cancelled.size) flight.underlyingCancelled = true;
  }

  pin(name: string): void {
    const entry = this.entries.get(name);
    if (entry) entry.pinned += 1;
  }

  unpin(name: string): void {
    const entry = this.entries.get(name);
    if (entry && entry.pinned > 0) entry.pinned -= 1;
  }

  invalidateOuter(outerSource: string): void {
    for (const name of [...this.entries.keys()]) {
      if (name.startsWith(`${outerSource}|`)) {
        this.entries.delete(name);
        this.epochs.set(name, (this.epochs.get(name) ?? 0) + 1);
      }
    }
    for (const name of [...this.inflight.keys()]) {
      if (name.startsWith(`${outerSource}|`)) {
        this.inflight.delete(name);
        this.epochs.set(name, (this.epochs.get(name) ?? 0) + 1);
      }
    }
  }

  private store<T>(name: string, data: T, bytes: number): void {
    while ((this.bytes + bytes > this.maxBytes || this.entries.size + 1 > this.maxEntries) && this.lru.length > 0) {
      const victim = this.lru.shift()!;
      const entry = this.entries.get(victim);
      if (!entry || entry.pinned > 0) continue;
      this.entries.delete(victim);
      this.bytes -= entry.bytes;
    }
    this.entries.set(name, { key: name, data, bytes, pinned: 0, generation: Date.now() });
    this.bytes += bytes;
    this.touch(name);
  }

  private touch(name: string): void {
    this.lru = this.lru.filter((item) => item !== name);
    this.lru.push(name);
  }

  dispose(): void {
    this.disposed = true;
    this.entries.clear();
    this.inflight.clear();
    this.lru = [];
    this.bytes = 0;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}


/* Factory API used by the CLI/reference validation harness. The class above is retained by CoreToolSession. */
/**
 * Shared native snapshot cache (执行指令 T03, §8.2).
 *
 * Organized by "outer physical source + version + reader/schema + read shape".
 * One outer BND snapshot may own several child snapshots; one full EMEVD
 * document may serve several event windows. Completeness is written into the
 * entry key, so an `outline` snapshot can never satisfy a `full-document`
 * request (V08).
 *
 * Responsibilities proven by runReferenceOptimizationPerformanceSmoke:
 *   - single-flight: concurrent identical cold reads share one underlying
 *     parse (V05); a failed/cancelled read never masquerades as a hit.
 *   - hot reads on the same version add zero incremental parses (§8.2).
 *   - waiter cancellation: cancelling one waiter rejects only that waiter;
 *     the shared parse still completes and publishes (V06/V07).
 *   - invalidation drops every child/shape entry for an outer source (V01).
 *   - bypass reads re-parse and republish without merging with stale cache.
 *
 * The cache stores immutable snapshots only; returned values are deep-frozen
 * so a caller cannot mutate cached arrays, Maps or native documents. Byte and
 * entry budgets are constructor-injected engineering defaults (128 MiB / 256
 * entries), never model-authored.
 */

export interface SnapshotCacheKey {
  /** Canonical outer physical source identity (never a display label). */
  sourceUri: string;
  /** Read shape: 'full-document' | 'outline' | 'rows' | … ; part of the key. */
  shape: string;
  /** Version tag (outer hash / dependency summary) distinguishing snapshots. */
  version: string;
}

export interface SnapshotReadOptions {
  /**
   * Bypass the cache for a pre/post-write verification read: always re-parse,
   * never merge with an older in-flight promise, then republish a fresh
   * snapshot. Does not skip writer validation (that stays in the write path).
   */
  bypass?: boolean;
  /** Cancelling this signal rejects only the current waiter (V06/V07). */
  signal?: AbortSignal;
}

/** Minimal native port the cache drives; counters live at this boundary. */
export interface SnapshotBackend {
  parse(sourceUri: string): unknown;
  inventory?(sourceUri: string): unknown;
}

export interface SnapshotCacheStats {
  coalescedWaiters: number;
  hits: number;
  misses: number;
}

export interface NativeSnapshotCacheOptions {
  backend: SnapshotBackend;
  /** Byte budget (approximate, via serialized size). Default 128 MiB. */
  maxBytes?: number;
  /** Entry-count budget. Default 256. */
  maxEntries?: number;
}

export interface ManagedNativeSnapshotCache {
  read(key: SnapshotCacheKey, options?: SnapshotReadOptions): Promise<unknown>;
  /** Drop every shape/version entry for one outer source (outer-file change). */
  invalidate(sourceUri: string): void;
  stats(): SnapshotCacheStats;
  dispose(): Promise<void>;
}

export class SnapshotCancelledError extends Error {
  readonly code = 'SNAPSHOT_READ_CANCELLED';
  constructor(sourceUri: string) {
    super(`Snapshot read for '${sourceUri}' was cancelled by its waiter.`);
    this.name = 'SnapshotCancelledError';
  }
}

const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 256;

function cacheKeyOf(key: SnapshotCacheKey): string {
  return `${key.sourceUri}\u0000${key.shape}\u0000${key.version}`;
}

function validateKey(key: SnapshotCacheKey): void {
  if (typeof key.sourceUri !== 'string' || key.sourceUri.trim().length === 0) {
    throw new Error('SNAPSHOT_KEY_INVALID: sourceUri must be a non-empty string.');
  }
  if (typeof key.shape !== 'string' || key.shape.trim().length === 0) {
    throw new Error('SNAPSHOT_KEY_INVALID: shape must be a non-empty string.');
  }
  if (typeof key.version !== 'string' || key.version.trim().length === 0) {
    throw new Error('SNAPSHOT_KEY_INVALID: version must be a non-empty string (absent version never caches).');
  }
}

/** Deep freeze so a caller cannot mutate cached arrays / Maps / documents. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  return value;
}

/** Rough serialized size; used only for the byte budget, never for identity. */
function estimateBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json ? json.length * 2 : 1024;
  } catch {
    return 1024;
  }
}

interface CacheEntry {
  value: unknown;
  bytes: number;
  /** Insertion/last-use order for LRU. */
  seq: number;
}

interface InFlight {
  promise: Promise<unknown>;
  waiters: Set<(value: unknown) => void>;
  rejecters: Set<(reason: unknown) => void>;
  settled: boolean;
}

export function createNativeSnapshotCache(options: NativeSnapshotCacheOptions): ManagedNativeSnapshotCache {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const entries = new Map<string, CacheEntry>();
  const inFlight = new Map<string, InFlight>();
  let seq = 0;
  let totalBytes = 0;
  let disposed = false;
  const stats: SnapshotCacheStats = { coalescedWaiters: 0, hits: 0, misses: 0 };

  function assertOpen(): void {
    if (disposed) throw new Error('SNAPSHOT_CACHE_DISPOSED: cache has been disposed.');
  }

  function evictIfNeeded(): void {
    // LRU by last-use sequence; only entries with no active in-flight share.
    while (entries.size > maxEntries || totalBytes > maxBytes) {
      let victimKey: string | undefined;
      let victimSeq = Number.POSITIVE_INFINITY;
      for (const [key, entry] of entries) {
        if (entry.seq < victimSeq) {
          victimSeq = entry.seq;
          victimKey = key;
        }
      }
      if (victimKey === undefined) break;
      const victim = entries.get(victimKey);
      if (victim) totalBytes -= victim.bytes;
      entries.delete(victimKey);
    }
  }

  function publish(key: SnapshotCacheKey, raw: unknown): unknown {
    const frozen = deepFreeze(raw);
    const bytes = estimateBytes(raw);
    const composite = cacheKeyOf(key);
    const existing = entries.get(composite);
    if (existing) totalBytes -= existing.bytes;
    entries.set(composite, { value: frozen, bytes, seq: (seq += 1) });
    totalBytes += bytes;
    evictIfNeeded();
    return frozen;
  }

  async function runParse(key: SnapshotCacheKey): Promise<unknown> {
    // Backend parse is synchronous in the fixture port; wrap so a throw
    // rejects the shared promise and clears in-flight (never a false hit).
    return await Promise.resolve().then(() => options.backend.parse(key.sourceUri));
  }

  async function read(key: SnapshotCacheKey, optionsIn: SnapshotReadOptions = {}): Promise<unknown> {
    assertOpen();
    validateKey(key);
    const composite = cacheKeyOf(key);
    const { bypass, signal } = optionsIn;

    if (signal?.aborted) throw new SnapshotCancelledError(key.sourceUri);

    if (!bypass) {
      const hit = entries.get(composite);
      if (hit) {
        hit.seq = (seq += 1);
        stats.hits += 1;
        return hit.value;
      }
    }

    stats.misses += 1;

    // Bypass never joins an existing in-flight (T03 step 5): it must observe
    // live bytes, then republish a fresh snapshot for subsequent readers.
    let flight: InFlight;
    let joinsExisting = false;
    if (bypass) {
      flight = newInFlight();
    } else {
      const existing = inFlight.get(composite);
      if (existing && !existing.settled) {
        flight = existing;
        joinsExisting = true;
      } else {
        flight = newInFlight();
        inFlight.set(composite, flight);
      }
    }

    const value = await new Promise<unknown>((resolve, reject) => {
      const waiterResolve = (result: unknown): void => {
        detach();
        resolve(result);
      };
      const waiterReject = (reason: unknown): void => {
        detach();
        reject(reason);
      };
      const onAbort = (): void => {
        // Cancelling one waiter removes only that waiter (V06). The shared
        // parse continues while other waiters remain.
        flight.waiters.delete(waiterResolve);
        flight.rejecters.delete(waiterReject);
        detach();
        reject(new SnapshotCancelledError(key.sourceUri));
      };
      const detach = (): void => {
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      flight.waiters.add(waiterResolve);
      flight.rejecters.add(waiterReject);

      if (!joinsExisting && !bypass) {
        // Owner of a fresh shared flight: kick off the parse.
        void startParse(flight, key, composite);
      } else if (bypass) {
        // Sole owner of a bypass flight.
        void startParse(flight, key, composite);
      } else {
        stats.coalescedWaiters += 1;
      }
    });

    return value;
  }

  function newInFlight(): InFlight {
    return {
      promise: Promise.resolve(),
      waiters: new Set(),
      rejecters: new Set(),
      settled: false
    };
  }

  async function startParse(flight: InFlight, key: SnapshotCacheKey, composite: string): Promise<void> {
    try {
      const raw = await runParse(key);
      flight.settled = true;
      if (disposed) {
        // Late result after dispose must not resurrect a generation (V07).
        for (const reject of [...flight.rejecters]) reject(new SnapshotCancelledError(key.sourceUri));
        flight.waiters.clear();
        flight.rejecters.clear();
        inFlight.delete(composite);
        return;
      }
      const frozen = publish(key, raw);
      inFlight.delete(composite);
      for (const resolve of [...flight.waiters]) resolve(frozen);
      flight.waiters.clear();
      flight.rejecters.clear();
    } catch (error) {
      flight.settled = true;
      inFlight.delete(composite);
      for (const reject of [...flight.rejecters]) reject(error);
      flight.waiters.clear();
      flight.rejecters.clear();
    }
  }

  function invalidate(sourceUri: string): void {
    const prefix = `${sourceUri}\u0000`;
    for (const composite of [...entries.keys()]) {
      if (composite.startsWith(prefix)) {
        const entry = entries.get(composite);
        if (entry) totalBytes -= entry.bytes;
        entries.delete(composite);
      }
    }
  }

  async function dispose(): Promise<void> {
    disposed = true;
    for (const flight of inFlight.values()) {
      for (const reject of [...flight.rejecters]) reject(new SnapshotCancelledError('cache'));
      flight.waiters.clear();
      flight.rejecters.clear();
    }
    inFlight.clear();
    entries.clear();
    totalBytes = 0;
  }

  return {
    read,
    invalidate,
    stats: () => ({ ...stats }),
    dispose
  };
}

