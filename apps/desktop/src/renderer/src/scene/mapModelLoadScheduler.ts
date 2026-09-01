import type { SceneDrawItem } from '@soulforge/shared';
import { normalizeModelResourceKey } from './modelResourcePool.js';

export type MapMeshGeometry = NonNullable<SceneDrawItem['mesh']>;

// --- 24.12 ResourceCacheKeyV1 (renderer view) ---
export interface ResourceCacheKeyV1 {
  schema: 'map-resource-cache-key-v1';
  workspacePersistentIdentityHash: string;
  overlayResolutionGeneration: number;
  resourceEdgeId: string;
  resolvedLogicalUri: string;
  sourceIdentityHash: string;
  pathSourceGeneration: number;
  containerEntryIdentitySha256: string;
  modelLocalTransformSha256: string;
  faceSetRuleRegistrySha256: string;
  mapCoordinateContractPayloadSha256: string;
}

export function canonicalResourceCacheKeySha256(key: ResourceCacheKeyV1): string {
  const canonical = JSON.stringify(key, Object.keys(key).sort());
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require('node:crypto') as typeof import('node:crypto');
    return crypto.createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex');
  } catch {
    let h = 0x811c9dc5;
    for (let i = 0; i < canonical.length; i++) {
      h ^= canonical.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h.toString(16).padStart(64, '0').slice(-64);
  }
}

export function normalizeMapModelKey(modelName: string): string {
  return normalizeModelResourceKey(modelName);
}

export interface ReadyResourceManifestV1 {
  schema: 'map-ready-resource-manifest-v1';
  cacheKey: ResourceCacheKeyV1;
  resourceCacheKeySha256: string;
  chunks: Array<{
    chunkId: string;
    meshOrdinal: number;
    materialIndex: number;
    sourceTriangleStart: number;
    triangleCount: number;
    modelLocalTransformSha256: string;
    faceSetSpansAndCullSha256: string;
    geometryKey: string;
    materialKeys: string[];
    rawContentSha256: string;
  }>;
  complete: true;
  createdAtFrame: number;
  lastUsedFrame: number;
}

interface InFlightEntry {
  controller: AbortController;
  promise: Promise<MapMeshGeometry | null>;
  resourceCacheKeySha256: string;
}

/**
 * MapModelLoadCache per 24.12:
 * - keys by ResourceCacheKeyV1 canonical SHA (full typed key, not short modelName)
 * - resolved cache holds small ReadyResourceManifest only: no base64 wire payload / ArrayBuffer retained
 * - inFlight coalesces by operationKeySha256 (resourceCacheKeySha256 + context)
 * - dispose aborts via AbortController and clears inFlight
 */
export class MapModelLoadCache {
  // For production keys: small manifest only, no wire retained.
  private readonly resolvedManifests = new Map<string, ReadyResourceManifestV1 | null>();
  // Legacy synthetic keys (tests): retain small mesh for backward compat.
  private readonly legacyResolved = new Map<string, MapMeshGeometry | null>();
  private readonly inFlight = new Map<string, InFlightEntry>();
  private readonly inFlightLegacy = new Map<string, Promise<MapMeshGeometry | null>>();
  private disposed = false;

  public constructor(
    private readonly loader: (modelName: string, signal: AbortSignal) => Promise<MapMeshGeometry | null>
  ) {}

  public load(modelName: string): Promise<MapMeshGeometry | null> {
    if (this.disposed) {
      return Promise.reject(new Error(`MAP_MESH_LOAD_CACHE_DISPOSED: cannot load ${modelName}`));
    }
    const legacySha = normalizeMapModelKey(modelName);
    // legacyResolved path (test compat) — still keyed via normalized short key but also via canonical SHA for spec
    const syntheticKey: ResourceCacheKeyV1 = {
      schema: 'map-resource-cache-key-v1',
      workspacePersistentIdentityHash: 'legacy',
      overlayResolutionGeneration: 0,
      resourceEdgeId: legacySha,
      resolvedLogicalUri: legacySha,
      sourceIdentityHash: 'legacy',
      pathSourceGeneration: 0,
      containerEntryIdentitySha256: legacySha,
      modelLocalTransformSha256: 'legacy',
      faceSetRuleRegistrySha256: 'legacy',
      mapCoordinateContractPayloadSha256: 'legacy',
    };
    const sha = canonicalResourceCacheKeySha256(syntheticKey);
    // coalesce legacy inFlight by sha
    if (this.legacyResolved.has(sha)) return Promise.resolve(this.legacyResolved.get(sha) ?? null);
    const pending = this.inFlightLegacy.get(sha);
    if (pending) return pending;
    const controller = new AbortController();
    const request = this.loader(modelName, controller.signal)
      .then((geometry) => {
        if (this.disposed || controller.signal.aborted) {
          throw new Error(`MAP_MESH_LOAD_CANCELLED: ${modelName}`);
        }
        this.legacyResolved.set(sha, geometry);
        return geometry;
      })
      .finally(() => {
        this.inFlightLegacy.delete(sha);
      });
    // store controller for abort
    this.inFlight.set(sha, { controller, promise: request as Promise<MapMeshGeometry | null>, resourceCacheKeySha256: sha });
    this.inFlightLegacy.set(sha, request);
    return request;
  }

  public loadByKey(key: ResourceCacheKeyV1, modelName: string): Promise<MapMeshGeometry | null> {
    if (this.disposed) {
      return Promise.reject(new Error(`MAP_MESH_LOAD_CACHE_DISPOSED: cannot load ${modelName}`));
    }
    const sha = canonicalResourceCacheKeySha256(key);
    if (this.resolvedManifests.has(sha)) {
      // ready hit: manifest exists, wire payload not retained — caller acquires from GPU pool.
      return Promise.resolve(null);
    }
    const pending = this.inFlight.get(sha);
    if (pending) return pending.promise;
    const controller = new AbortController();
    const promise = this.loader(modelName, controller.signal)
      .then((geometry) => {
        if (this.disposed || controller.signal.aborted) {
          throw new Error(`MAP_MESH_LOAD_CANCELLED: ${modelName}`);
        }
        if (!geometry) {
          this.resolvedManifests.set(sha, null);
          return null;
        }
        const manifest: ReadyResourceManifestV1 = {
          schema: 'map-ready-resource-manifest-v1',
          cacheKey: key,
          resourceCacheKeySha256: sha,
          chunks: [{
            chunkId: sha.slice(0, 16),
            meshOrdinal: 0,
            materialIndex: 0,
            sourceTriangleStart: 0,
            triangleCount: Math.floor(geometry.vertexCount / 3),
            modelLocalTransformSha256: key.modelLocalTransformSha256,
            faceSetSpansAndCullSha256: key.faceSetRuleRegistrySha256,
            geometryKey: `${sha}:g0`,
            materialKeys: [`${sha}:m0`],
            rawContentSha256: sha,
          }],
          complete: true,
          createdAtFrame: 0,
          lastUsedFrame: 0,
        };
        // do not retain wire payload: drop base64 refs immediately
        void geometry.positionsBase64;
        this.resolvedManifests.set(sha, manifest);
        return null;
      })
      .finally(() => {
        this.inFlight.delete(sha);
      });
    this.inFlight.set(sha, { controller, promise, resourceCacheKeySha256: sha });
    return promise;
  }

  public dispose(): void {
    this.disposed = true;
    for (const [, entry] of this.inFlight) {
      try { entry.controller.abort(); } catch {}
    }
    this.inFlight.clear();
    this.inFlightLegacy.clear();
    this.legacyResolved.clear();
    this.resolvedManifests.clear();
  }
}

type FrameScheduler = (callback: FrameRequestCallback) => number;
type FrameCanceller = (handle: number) => void;

interface QueuedFrameTask {
  /** `undefined` keeps the legacy "task ran" meaning; boolean carries a real upload result. */
  run: () => boolean | void;
  resolve: (ran: boolean) => void;
  reject: (error: unknown) => void;
}

/**
 * Drains synchronous GPU upload work inside a small per-frame budget.
 * Each task uploads exactly one bounded decoded chunk.
 */
export class FrameTaskQueue {
  private readonly tasks: QueuedFrameTask[] = [];
  private frameHandle: number | null = null;
  private disposed = false;

  public constructor(
    // Chromium 的 requestAnimationFrame/cancelAnimationFrame 需要 Window receiver；
    // 直接把原生方法作为参数保存后再以 this.scheduleFrame(...) 调用会触发
    // `Illegal invocation`，导致所有 MAP mesh 上传任务永远不执行。
    private readonly scheduleFrame: FrameScheduler = (callback) => requestAnimationFrame(callback),
    private readonly cancelFrame: FrameCanceller = (handle) => cancelAnimationFrame(handle),
    private readonly now: () => number = () => performance.now(),
    private readonly frameBudgetMs = 6
  ) {}

  public enqueue(run: () => boolean | void): Promise<boolean> {
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
        const result = task.run();
        task.resolve(result === undefined ? true : result);
      } catch (error) {
        task.reject(error);
      }
    } while (this.tasks.length > 0 && this.now() - startedAt < this.frameBudgetMs);
    this.ensureFrame();
  }
}
