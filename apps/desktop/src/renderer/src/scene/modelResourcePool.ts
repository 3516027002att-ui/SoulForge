/**
 * Model and Scene Resource Pool aligned with Smithbox + 24.12 GPU pool.
 *
 * Invariants per 24.12:
 * - geometry/material are different resources, different keys, different refcounts (not same entry)
 * - each pool entry is scoped by rendererContextGeneration; outer map is per-context, no cross-context sharing
 * - pool owner granularity is GpuOwnerId = canonicalSha(workspaceSessionId, workspaceSessionGeneration, sceneId, sceneGeneration, rendererContextGeneration, resourceCacheKeySha256)
 * - owners is Set<GpuOwnerId>, refCount === owners.size, never zero-padded
 * - acquire is idempotent per owner, release at last lease disposes
 */

import type {
  BufferGeometry,
  Material,
} from 'three';
import { decodeBase64ToUint8Array } from '../utils/binary.js';

type ThreeModule = typeof import('three');

export interface MeshGeometryWire {
  positionsBase64: string;
  indicesBase64?: string | undefined;
  indexSize?: 16 | 32 | undefined;
  uvsBase64?: string | undefined;
  normalsBase64?: string | undefined;
  vertexCount: number;
  boundingBoxMin?: [number, number, number] | undefined;
  boundingBoxMax?: [number, number, number] | undefined;
}

function decodeBase64F32(base64: string, expectedCount: number): Float32Array {
  const bytes = decodeBase64ToUint8Array(base64);
  const view = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 4));
  return view.length >= expectedCount ? view : new Float32Array(expectedCount);
}

export type TrackFunction = <T extends { dispose(): void }>(resource: T) => T;

export interface GpuGeometryEntry {
  key: string; // geometry content + layout + mesh/chunk identity; not material. No zero-padding.
  rendererContextGeneration: number;
  geometry: BufferGeometry;
  owners: Set<string>; // GpuOwnerId
  refCount: number; // invariant: refCount === owners.size
  gpuBytes: number;
  lastUsedFrame: number;
}

export interface GpuMaterialEntry {
  key: string; // shader/material params + texture identities; no zero-padding
  rendererContextGeneration: number;
  material: Material;
  textureLeaseKeys: string[];
  owners: Set<string>;
  refCount: number; // invariant: refCount === owners.size
  gpuBytesEstimate: number;
  lastUsedFrame: number;
}

type ContextPools = {
  geometries: Map<string, GpuGeometryEntry>;
  materials: Map<string, GpuMaterialEntry>;
};

function assertOwnerInvariant(entry: { owners: Set<string>; refCount: number }, label: string): void {
  if (entry.refCount !== entry.owners.size) {
    throw new Error(`${label} invariant broken: refCount ${entry.refCount} !== owners.size ${entry.owners.size}`);
  }
}

export class ModelResourcePool {
  // outer by rendererContextGeneration, inner by content key (no zero-padding)
  private readonly contextPools = new Map<number, ContextPools>();
  // legacy single-context compat for existing Proxy path
  private legacyGeometries = new Map<string, BufferGeometry>();
  private legacyMaterials = new Map<string, Material>();
  private primitiveBox: BufferGeometry | null = null;
  private primitiveSphere: BufferGeometry | null = null;
  private wireframeMaterial: Material | null = null;
  private defaultRealMaterial: Material | null = null;

  private getOrCreateContextPool(rendererContextGeneration: number): ContextPools {
    let pool = this.contextPools.get(rendererContextGeneration);
    if (!pool) {
      pool = { geometries: new Map(), materials: new Map() };
      this.contextPools.set(rendererContextGeneration, pool);
    }
    return pool;
  }

  // --- New pool API: acquire/release with owner ---

  public acquireGeometry(
    ownerId: string,
    rendererContextGeneration: number,
    contentKey: string,
    create: () => BufferGeometry,
    gpuBytes: number
  ): GpuGeometryEntry {
    const pool = this.getOrCreateContextPool(rendererContextGeneration);
    let entry = pool.geometries.get(contentKey);
    if (!entry) {
      const geometry = create();
      entry = {
        key: contentKey,
        rendererContextGeneration,
        geometry,
        owners: new Set([ownerId]),
        refCount: 1,
        gpuBytes,
        lastUsedFrame: 0,
      };
      pool.geometries.set(contentKey, entry);
      assertOwnerInvariant(entry, 'acquireGeometry');
      return entry;
    }
    if (entry.rendererContextGeneration !== rendererContextGeneration) {
      throw new Error('MAP_GPU_CONTEXT_MISMATCH');
    }
    if (!entry.owners.has(ownerId)) {
      entry.owners.add(ownerId);
      entry.refCount = entry.owners.size;
    }
    entry.lastUsedFrame = 0;
    assertOwnerInvariant(entry, 'acquireGeometry');
    return entry;
  }

  public releaseGeometry(ownerId: string, rendererContextGeneration: number, contentKey: string): void {
    const pool = this.contextPools.get(rendererContextGeneration);
    if (!pool) return;
    const entry = pool.geometries.get(contentKey);
    if (!entry) return;
    if (!entry.owners.has(ownerId)) {
      throw new Error('MAP_GPU_DOUBLE_RELEASE');
    }
    entry.owners.delete(ownerId);
    entry.refCount = entry.owners.size;
    assertOwnerInvariant(entry, 'releaseGeometry');
    if (entry.refCount === 0) {
      entry.geometry.dispose();
      pool.geometries.delete(contentKey);
    }
  }

  public acquireMaterial(
    ownerId: string,
    rendererContextGeneration: number,
    contentKey: string,
    create: () => Material,
    gpuBytesEstimate: number,
    textureLeaseKeys: string[] = []
  ): GpuMaterialEntry {
    const pool = this.getOrCreateContextPool(rendererContextGeneration);
    let entry = pool.materials.get(contentKey);
    if (!entry) {
      const material = create();
      entry = {
        key: contentKey,
        rendererContextGeneration,
        material,
        textureLeaseKeys: [...textureLeaseKeys],
        owners: new Set([ownerId]),
        refCount: 1,
        gpuBytesEstimate,
        lastUsedFrame: 0,
      };
      pool.materials.set(contentKey, entry);
      assertOwnerInvariant(entry, 'acquireMaterial');
      return entry;
    }
    if (entry.rendererContextGeneration !== rendererContextGeneration) {
      throw new Error('MAP_GPU_CONTEXT_MISMATCH');
    }
    if (!entry.owners.has(ownerId)) {
      entry.owners.add(ownerId);
      entry.refCount = entry.owners.size;
    }
    assertOwnerInvariant(entry, 'acquireMaterial');
    return entry;
  }

  public releaseMaterial(ownerId: string, rendererContextGeneration: number, contentKey: string): void {
    const pool = this.contextPools.get(rendererContextGeneration);
    if (!pool) return;
    const entry = pool.materials.get(contentKey);
    if (!entry) return;
    if (!entry.owners.has(ownerId)) throw new Error('MAP_GPU_DOUBLE_RELEASE');
    entry.owners.delete(ownerId);
    entry.refCount = entry.owners.size;
    assertOwnerInvariant(entry, 'releaseMaterial');
    if (entry.refCount === 0) {
      entry.material.dispose();
      // texture leases are released independently via their own pool keys
      pool.materials.delete(contentKey);
    }
  }

  // --- Legacy compat: single-context non-owner path (kept for Proxy preview, allocates without owner) ---
  public getOrCreateGeometry(
    three: ThreeModule,
    track: TrackFunction,
    key: string,
    data: MeshGeometryWire
  ): BufferGeometry {
    const existing = this.legacyGeometries.get(key);
    if (existing) return existing;

    const geometry = track(new three.BufferGeometry());
    geometry.setAttribute(
      'position',
      new three.BufferAttribute(decodeBase64F32(data.positionsBase64, data.vertexCount * 3), 3)
    );

    if (data.indicesBase64) {
      const indexBytes = decodeBase64ToUint8Array(data.indicesBase64);
      const is32 = data.indexSize === 32;
      if (is32) {
        const view = new Uint32Array(indexBytes.buffer, indexBytes.byteOffset, Math.floor(indexBytes.length / 4));
        geometry.setIndex(new three.Uint32BufferAttribute(view, 1));
      } else {
        const view = new Uint16Array(indexBytes.buffer, indexBytes.byteOffset, Math.floor(indexBytes.length / 2));
        geometry.setIndex(new three.Uint16BufferAttribute(view, 1));
      }
    }

    if (data.uvsBase64) {
      geometry.setAttribute(
        'uv',
        new three.BufferAttribute(decodeBase64F32(data.uvsBase64, data.vertexCount * 2), 2)
      );
    }

    if (data.normalsBase64) {
      geometry.setAttribute(
        'normal',
        new three.BufferAttribute(decodeBase64F32(data.normalsBase64, data.vertexCount * 3), 3)
      );
    } else {
      geometry.computeVertexNormals();
    }

    this.legacyGeometries.set(key, geometry);
    return geometry;
  }

  public getPrimitiveGeometry(
    three: ThreeModule,
    track: TrackFunction,
    primitive: 'box' | 'sphere'
  ): BufferGeometry {
    if (primitive === 'sphere') {
      if (!this.primitiveSphere) {
        this.primitiveSphere = track(new three.SphereGeometry(0.5, 12, 10));
      }
      return this.primitiveSphere;
    }
    if (!this.primitiveBox) {
      this.primitiveBox = track(new three.BoxGeometry(1, 1, 1));
    }
    return this.primitiveBox;
  }

  public getDefaultRealMaterial(
    three: ThreeModule,
    track: TrackFunction
  ): Material {
    if (!this.defaultRealMaterial) {
      this.defaultRealMaterial = track(
        new three.MeshStandardMaterial({
          color: new three.Color(0x8e97a3),
          roughness: 0.55,
          metalness: 0.12,
          side: three.DoubleSide,
          wireframe: false
        })
      );
    }
    return this.defaultRealMaterial;
  }

  public getProxyMaterial(
    three: ThreeModule,
    track: TrackFunction,
    _colorRgb: [number, number, number]
  ): Material {
    const key = 'proxy:shared';
    const existing = this.legacyMaterials.get(key);
    if (existing) return existing;
    const material = track(new three.MeshStandardMaterial({
      color: new three.Color(1, 1, 1),
      roughness: 0.65,
      metalness: 0.05,
      side: three.FrontSide,
      wireframe: true,
      transparent: true,
      opacity: 0.35
    }));
    this.legacyMaterials.set(key, material);
    return material;
  }

  public updateModelGeometry(
    three: ThreeModule,
    track: TrackFunction,
    modelName: string,
    geometryData: MeshGeometryWire
  ): { geometry: BufferGeometry; material: Material } {
    // Use raw id without zero-padding: modelName lowercased, no padStart.
    const key = modelName.toLowerCase().replace(/\.mapbnd(\.dcx)?$/i, '');
    const geometry = this.getOrCreateGeometry(three, track, key, geometryData);
    const material = this.getDefaultRealMaterial(three, track);
    return { geometry, material };
  }

  public clear(): void {
    // Dispose per owner/entry via same dispose path (no Map.clear shortcut)
    for (const [, pool] of this.contextPools) {
      for (const [, entry] of pool.geometries) entry.geometry.dispose();
      for (const [, entry] of pool.materials) entry.material.dispose();
      pool.geometries.clear();
      pool.materials.clear();
    }
    this.contextPools.clear();
    this.legacyGeometries.clear();
    this.legacyMaterials.clear();
    this.primitiveBox = null;
    this.primitiveSphere = null;
    this.wireframeMaterial = null;
    this.defaultRealMaterial = null;
  }
}
