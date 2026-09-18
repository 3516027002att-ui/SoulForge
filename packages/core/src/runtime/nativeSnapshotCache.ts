/**
 * Versioned immutable native snapshot cache with single-flight coalescing.
 *
 * Cache key = outer physical source + version + reader/schema + read shape.
 * Outline reads never satisfy full-document requirements.
 */
import {
  compareResourceVersion,
  resourceSourceKey,
  type ResourceVersion,
  type ResourceVersionSourceKeyInput
} from './resourceVersion.js';

export type NativeReadShape =
  | 'full-document'
  | 'outline'
  | 'fields'
  | 'window'
  | 'container-inventory'
  | 'child-extract';

export interface NativeSnapshotKeyParts extends ResourceVersionSourceKeyInput {
  readerSchema?: string;
  metadataSchema?: string;
  shape: NativeReadShape;
  /** Extra shape discriminator, e.g. field set hash or event id window. */
  shapeDetail?: string;
}

export interface NativeSnapshotEntry<T = unknown> {
  key: string;
  sourceKey: string;
  version: ResourceVersion;
  shape: NativeReadShape;
  shapeDetail?: string;
  readerSchema?: string;
  metadataSchema?: string;
  data: T;
  /** Approximate retained size for LRU budget. */
  bytes: number;
  createdAt: number;
  lastUsedAt: number;
  /** Immutable by contract: cache stores frozen references / copies. */
  complete: boolean;
  dispose?: () => void | Promise<void>;
}

export interface NativeSnapshotCacheOptions {
  maxBytes?: number;
  maxEntries?: number;
  defaultTtlMs?: number;
  /** Performance counters for smoke tests; not for model contexts. */
  counters?: NativeSnapshotCounters;
}

export interface NativeSnapshotCounters {
  nativeParseCount: number;
  childExtractionCount: number;
  containerInventoryCount: number;
  coalescedWaiterCount: number;
  cacheHitCount: number;
  cacheMissCount: number;
  freshVerificationReadCount: number;
}

export function createNativeSnapshotCounters(): NativeSnapshotCounters {
  return {
    nativeParseCount: 0,
    childExtractionCount: 0,
    containerInventoryCount: 0,
    coalescedWaiterCount: 0,
    cacheHitCount: 0,
    cacheMissCount: 0,
    freshVerificationReadCount: 0
  };
}

export function snapshotKey(parts: NativeSnapshotKeyParts): string {
  return JSON.stringify([
    resourceSourceKey(parts),
    parts.readerSchema ?? '',
    parts.metadataSchema ?? '',
    parts.shape,
    parts.shapeDetail ?? ''
  ]);
}

interface Inflight<T = unknown> {
  promise: Promise<T>;
  waiters: number;
  controller: AbortController;
  bypass: boolean;
}

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    const copy = value.map((item) => freezeDeep(item));
    return Object.freeze(copy) as T;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = freezeDeep(item);
  }
  return Object.freeze(out) as T;
}

export class NativeSnapshotCache {
  private readonly entries = new Map<string, NativeSnapshotEntry>();
  private readonly inflight = new Map<string, Inflight>();
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number;
  readonly counters: NativeSnapshotCounters;
  private usedBytes = 0;
  private disposed = false;

  constructor(options: NativeSnapshotCacheOptions = {}) {
    this.maxBytes = options.maxBytes ?? 128 * 1024 * 1024;
    this.maxEntries = options.maxEntries ?? 256;
    this.defaultTtlMs = options.defaultTtlMs ?? 5 * 60 * 1000;
    this.counters = options.counters ?? createNativeSnapshotCounters();
  }

  get<T>(key: string, version: ResourceVersion): NativeSnapshotEntry<T> | undefined {
    if (this.disposed) return undefined;
    const entry = this.entries.get(key);
    if (!entry) {
      this.counters.cacheMissCount += 1;
      return undefined;
    }
    const cmp = compareResourceVersion(entry.version, version);
    if (cmp.kind !== 'equal') {
      this.dropKey(key);
      this.counters.cacheMissCount += 1;
      return undefined;
    }
    if (Date.now() - entry.createdAt > this.defaultTtlMs) {
      this.dropKey(key);
      this.counters.cacheMissCount += 1;
      return undefined;
    }
    entry.lastUsedAt = Date.now();
    this.counters.cacheHitCount += 1;
    return entry as NativeSnapshotEntry<T>;
  }

  set<T>(input: {
    key: string;
    sourceKey: string;
    version: ResourceVersion;
    shape: NativeReadShape;
    shapeDetail?: string;
    readerSchema?: string;
    metadataSchema?: string;
    data: T;
    bytes?: number;
    complete?: boolean;
    dispose?: () => void | Promise<void>;
  }): NativeSnapshotEntry<T> {
    if (this.disposed) {
      void input.dispose?.();
      throw new Error('NATIVE_SNAPSHOT_CACHE_DISPOSED');
    }
    const bytes = input.bytes ?? approximateBytes(input.data);
    const entry: NativeSnapshotEntry<T> = {
      key: input.key,
      sourceKey: input.sourceKey,
      version: input.version,
      shape: input.shape,
      ...(input.shapeDetail ? { shapeDetail: input.shapeDetail } : {}),
      ...(input.readerSchema ? { readerSchema: input.readerSchema } : {}),
      ...(input.metadataSchema ? { metadataSchema: input.metadataSchema } : {}),
      data: freezeDeep(input.data),
      bytes,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      complete: input.complete ?? true,
      ...(input.dispose ? { dispose: input.dispose } : {})
    };
    this.dropKey(input.key);
    this.entries.set(input.key, entry as NativeSnapshotEntry);
    this.usedBytes += bytes;
    this.evictIfNeeded();
    return entry;
  }

  /**
   * Single-flight read: identical exact keys share one loader promise.
   * bypass never merges with ordinary current-cache loads.
   */
  async load<T>(input: {
    key: string;
    version: ResourceVersion;
    bypass?: boolean;
    signal?: AbortSignal;
    loader: (signal: AbortSignal) => Promise<T>;
    store: (data: T) => Omit<NativeSnapshotEntry<T>, 'key' | 'version' | 'createdAt' | 'lastUsedAt' | 'bytes'> & { bytes?: number };
  }): Promise<T> {
    if (this.disposed) throw new Error('NATIVE_SNAPSHOT_CACHE_DISPOSED');

    if (!input.bypass) {
      const hit = this.get<T>(input.key, input.version);
      if (hit) return hit.data;
    } else {
      this.counters.freshVerificationReadCount += 1;
    }

    const flightKey = input.bypass ? `bypass:${input.key}:${Date.now()}` : input.key;
    const existing = this.inflight.get(flightKey);
    if (existing && !existing.bypass) {
      existing.waiters += 1;
      this.counters.coalescedWaiterCount += 1;
      if (input.signal) {
        const onAbort = (): void => {
          existing.waiters -= 1;
        };
        input.signal.addEventListener('abort', onAbort, { once: true });
      }
      return existing.promise as Promise<T>;
    }

    const controller = new AbortController();
    const parentAbort = (): void => controller.abort();
    input.signal?.addEventListener('abort', parentAbort, { once: true });

    const flight: Inflight<T> = {
      waiters: 1,
      controller,
      bypass: Boolean(input.bypass),
      promise: (async () => {
        try {
          const data = await input.loader(controller.signal);
          if (controller.signal.aborted) {
            throw Object.assign(new Error('NATIVE_SNAPSHOT_LOAD_ABORTED'), { code: 'NATIVE_SNAPSHOT_LOAD_ABORTED' });
          }
          const stored = input.store(data);
          this.set({
            key: input.key,
            sourceKey: stored.sourceKey,
            version: input.version,
            shape: stored.shape,
            ...(stored.shapeDetail ? { shapeDetail: stored.shapeDetail } : {}),
            ...(stored.readerSchema ? { readerSchema: stored.readerSchema } : {}),
            ...(stored.metadataSchema ? { metadataSchema: stored.metadataSchema } : {}),
            data,
            ...(stored.bytes !== undefined ? { bytes: stored.bytes } : {}),
            complete: stored.complete,
            ...(stored.dispose ? { dispose: stored.dispose } : {})
          });
          return data;
        } finally {
          this.inflight.delete(flightKey);
          input.signal?.removeEventListener('abort', parentAbort);
        }
      })()
    };

    this.inflight.set(flightKey, flight as Inflight);
    return flight.promise;
  }

  invalidateSource(sourceKey: string): void {
    for (const key of [...this.entries.keys()]) {
      const entry = this.entries.get(key);
      if (entry && entry.sourceKey === sourceKey) this.dropKey(key);
    }
  }

  invalidateWhere(predicate: (entry: NativeSnapshotEntry) => boolean): void {
    for (const [key, entry] of [...this.entries.entries()]) {
      if (predicate(entry)) this.dropKey(key);
    }
  }

  size(): number {
    return this.entries.size;
  }

  approxBytes(): number {
    return this.usedBytes;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const flight of this.inflight.values()) {
      flight.controller.abort();
    }
    this.inflight.clear();
    for (const key of [...this.entries.keys()]) {
      this.dropKey(key);
    }
  }

  private dropKey(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.usedBytes = Math.max(0, this.usedBytes - entry.bytes);
    if (entry.dispose) void entry.dispose();
  }

  private evictIfNeeded(): void {
    while (
      (this.entries.size > this.maxEntries || this.usedBytes > this.maxBytes)
      && this.entries.size > 0
    ) {
      let oldestKey: string | null = null;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.entries) {
        if (this.inflight.has(key)) continue;
        if (entry.lastUsedAt < oldest) {
          oldest = entry.lastUsedAt;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      this.dropKey(oldestKey);
    }
  }
}

function approximateBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return 1024;
  }
}

function storedCountableShape(shape: NativeReadShape): boolean {
  return shape === 'full-document' || shape === 'fields' || shape === 'child-extract';
}

export function createNativeSnapshotCache(options?: NativeSnapshotCacheOptions): NativeSnapshotCache {
  return new NativeSnapshotCache(options);
}
