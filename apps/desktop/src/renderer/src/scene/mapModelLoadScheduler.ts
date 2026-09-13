import type { SceneDrawItem } from '@soulforge/shared';
import { normalizeModelResourceKey } from './modelResourcePool.js';

export type MapMeshGeometry = NonNullable<SceneDrawItem['mesh']>;

/** Minimal geometry seam shared by the serialized mesh and worker-prepared mesh. */
export interface MapModelLoadGeometry {
  positionsBase64: string;
  vertexCount: number;
}

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

const HEX = '0123456789abcdef';

function canonicalResourceCacheKeyJson(key: ResourceCacheKeyV1): string {
  return JSON.stringify(key, Object.keys(key).sort());
}

/** Browser-safe SHA-256 over UTF-8 text; never substitutes a weaker digest. */
export async function sha256Utf8Hex(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('MAP_CACHE_SHA256_UNAVAILABLE: crypto.subtle is unavailable');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value));
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const byte of bytes) hex += HEX.charAt(byte >> 4) + HEX.charAt(byte & 0x0f);
  return hex;
}

export async function canonicalResourceCacheKeySha256(key: ResourceCacheKeyV1): Promise<string> {
  return sha256Utf8Hex(canonicalResourceCacheKeyJson(key));
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

export interface MapModelLoadRetentionStats {
  preparedEnvelopeCount: number;
  inFlightCount: number;
  legacyInFlightCount: number;
  uploadedCount: number;
}

interface InFlightEntry<TGeometry extends MapMeshGeometry> {
  controller: AbortController;
  promise: Promise<TGeometry | null>;
  operationKey: string;
}

/**
 * MapModelLoadCache per 24.12:
 * - loadByKey keys by ResourceCacheKeyV1 canonical SHA (full typed key, not short modelName)
 * - production panel currently uses load()'s collision-free legacy delivery seam
 * - resolved cache holds small ReadyResourceManifest only: no base64 wire payload / ArrayBuffer retained
 * - inFlight coalesces by operation key
 * - dispose aborts via AbortController and clears inFlight
 */
export class MapModelLoadCache<TGeometry extends MapModelLoadGeometry = MapMeshGeometry> {
  // For production keys: small manifest only, no wire retained.
  private readonly resolvedManifests = new Map<string, ReadyResourceManifestV1>();
  // Legacy `load()` path: transient prepared envelope, released after upload;
  // retained for the shared-load/test compatibility seam while loadByKey is
  // still the manifest-only production contract.
  private readonly legacyResolved = new Map<string, TGeometry | null>();
  private readonly inFlight = new Map<string, InFlightEntry<TGeometry>>();
  private readonly inFlightLegacy = new Map<string, Promise<TGeometry | null>>();
  /**
   * A successful upload keeps its Three resource alive, but no longer needs
   * the prepared CPU envelope in this scheduler.  This set is deliberately
   * only a small state marker so a selected-part retry cannot re-read and
   * re-upload a model that is already visible.
   */
  private readonly uploaded = new Set<string>();
  private disposed = false;

  public constructor(
    private readonly loader: (modelName: string, signal: AbortSignal) => Promise<TGeometry | null>
  ) {}

  public load(modelName: string): Promise<TGeometry | null> {
    if (this.disposed) {
      return Promise.reject(new Error(`MAP_MESH_LOAD_CACHE_DISPOSED: cannot load ${modelName}`));
    }
    // The production panel still uses this legacy delivery path. Keep its
    // identity collision-free without migrating it to the manifest-only path.
    const key = this.legacyCacheKey(modelName);
    if (this.uploaded.has(key)) return Promise.resolve(null);
    if (this.legacyResolved.has(key)) return Promise.resolve(this.legacyResolved.get(key) ?? null);
    const pending = this.inFlightLegacy.get(key);
    if (pending) return pending;
    const controller = new AbortController();
    let request: Promise<TGeometry | null>;
    request = this.loader(modelName, controller.signal)
      .then((geometry) => {
        if (this.disposed || controller.signal.aborted) {
          throw new Error(`MAP_MESH_LOAD_CANCELLED: ${modelName}`);
        }
        // Missing/diagnostic-only models must remain retryable.  Only a real
        // prepared geometry is eligible for the success/upload lifecycle.
        if (geometry) this.legacyResolved.set(key, geometry);
        return geometry;
      })
      .finally(() => {
        if (this.inFlightLegacy.get(key) === request) this.inFlightLegacy.delete(key);
        const current = this.inFlight.get(key);
        if (current?.promise === request) this.inFlight.delete(key);
      });
    // store controller for abort
    this.inFlight.set(key, { controller, promise: request, operationKey: key });
    this.inFlightLegacy.set(key, request);
    return request;
  }

  public loadByKey(key: ResourceCacheKeyV1, modelName: string): Promise<TGeometry | null> {
    if (this.disposed) {
      return Promise.reject(new Error(`MAP_MESH_LOAD_CACHE_DISPOSED: cannot load ${modelName}`));
    }
    // All fields are scalar; snapshot before the async digest so a caller
    // mutation cannot split the digest identity from the retained manifest.
    const keySnapshot = { ...key };
    const canonical = canonicalResourceCacheKeyJson(keySnapshot);
    // Reserve the exact typed operation before awaiting WebCrypto. Otherwise
    // two same-key calls whose digest promises settle in different turns can
    // both start a fast (including null) loader before either hashes.
    const operationKey = `typed:${canonical}`;
    const pending = this.inFlight.get(operationKey);
    if (pending) return pending.promise;
    const controller = new AbortController();
    let promise: Promise<TGeometry | null>;
    promise = (async () => {
      const sha = await sha256Utf8Hex(canonical);
      if (this.disposed || controller.signal.aborted) {
        throw new Error(`MAP_MESH_LOAD_CANCELLED: ${modelName}`);
      }
      if (this.resolvedManifests.has(sha)) {
        // ready hit: manifest exists, wire payload not retained — caller acquires from GPU pool.
        return null;
      }
      const geometry = await this.loader(modelName, controller.signal);
      if (this.disposed || controller.signal.aborted) {
        throw new Error(`MAP_MESH_LOAD_CANCELLED: ${modelName}`);
      }
      if (!geometry) {
        // Missing/diagnostic-only results remain retryable; do not create
        // a permanent negative manifest entry.
        return null;
      }
      const manifest: ReadyResourceManifestV1 = {
        schema: 'map-ready-resource-manifest-v1',
        cacheKey: keySnapshot,
        resourceCacheKeySha256: sha,
        chunks: [{
          chunkId: sha.slice(0, 16),
          meshOrdinal: 0,
          materialIndex: 0,
          sourceTriangleStart: 0,
          triangleCount: Math.floor(geometry.vertexCount / 3),
          modelLocalTransformSha256: keySnapshot.modelLocalTransformSha256,
          faceSetSpansAndCullSha256: keySnapshot.faceSetRuleRegistrySha256,
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
    })()
      .finally(() => {
        const current = this.inFlight.get(operationKey);
        if (current?.promise === promise) this.inFlight.delete(operationKey);
      });
    this.inFlight.set(operationKey, { controller, promise, operationKey });
    return promise;
  }

  /** True when the model has committed successfully to the visible scene. */
  public isUploaded(modelName: string): boolean {
    return this.uploaded.has(this.legacyCacheKey(modelName));
  }

  /**
   * Drop a prepared envelope after the corresponding upload succeeds.  The
   * identity check prevents an old generation from deleting a newer load that
   * has already replaced the cache entry.
   */
  public markUploaded(modelName: string, geometry: TGeometry): boolean {
    const key = this.legacyCacheKey(modelName);
    if (this.legacyResolved.get(key) !== geometry) return false;
    this.legacyResolved.delete(key);
    this.uploaded.add(key);
    return true;
  }

  /** Release a failed/cancelled prepared envelope while keeping retry enabled. */
  public release(modelName: string, geometry?: TGeometry): void {
    const key = this.legacyCacheKey(modelName);
    if (geometry === undefined || this.legacyResolved.get(key) === geometry) {
      this.legacyResolved.delete(key);
    }
  }

  /** Read-only lifecycle counts; payloads and model names never leave the cache. */
  public getRetentionStats(): MapModelLoadRetentionStats {
    return {
      preparedEnvelopeCount: this.legacyResolved.size,
      inFlightCount: this.inFlight.size,
      legacyInFlightCount: this.inFlightLegacy.size,
      uploadedCount: this.uploaded.size
    };
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
    this.uploaded.clear();
  }

  private legacyCacheKey(modelName: string): string {
    return `legacy:${normalizeMapModelKey(modelName)}`;
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
 * Each task uploads one prepared model geometry; the budget is a soft
 * inter-task yield and cannot preempt a running upload.
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
