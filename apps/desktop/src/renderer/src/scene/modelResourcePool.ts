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
  Side,
} from 'three';
import { decodeBase64ToUint8Array } from '../utils/binary.js';
import type {
  MapGeometryPrepareDiagnostic,
  MapMaterialGroup,
  PreparedGeometryBounds,
  PreparedTextureIdentity
} from './mapGeometryPrepare.js';

type ThreeModule = typeof import('three');

/**
 * Native FaceSet culling is retained as a three-state renderer identity.
 * `unknown` is deliberate: incomplete provenance never inherits a top-level
 * compatibility flag. The WebGL2 map probe proves that native cull=true
 * winding needs BackSide; false and unknown remain DoubleSide. WebGPU has not
 * been independently exercised by the current evidence.
 */
export type MapCullBackfaceState = boolean | 'unknown';

function mapCullBackfaceStateKey(state: MapCullBackfaceState): string {
  return state === 'unknown' ? 'unknown' : state ? 'backfaces' : 'double-sided';
}

function mapCullBackfaceSide(three: ThreeModule, state: MapCullBackfaceState): Side {
  return state === true ? three.BackSide : three.DoubleSide;
}

function resolveMapCullBackfaceState(
  group: MapMaterialGroup | undefined,
  topLevelState: boolean | undefined
): MapCullBackfaceState {
  // Once a draw group exists, its missing cull flag is an explicit unknown.
  // Do not promote an ambiguous/multi-FaceSet group from a compatibility
  // top-level flag that belongs only to a single-surface payload.
  if (group) return typeof group.cullBackfaces === 'boolean' ? group.cullBackfaces : 'unknown';
  if (typeof topLevelState === 'boolean') return topLevelState;
  return 'unknown';
}

interface MapMaterialVariant {
  materialIndex: number;
  cullBackfaces: MapCullBackfaceState;
}

interface MapMaterialVariantGroup {
  start: number;
  count: number;
  materialSlot: number;
}

interface MapMaterialVariantLayout {
  /** Bounded numeric/state key used only for renderer-local geometry caching. */
  key: string;
  groups: MapMaterialVariantGroup[];
  variants: MapMaterialVariant[];
}

function getMapMaterialVariantLayout(data: MeshGeometryWire): MapMaterialVariantLayout {
  const groups: MapMaterialVariantGroup[] = [];
  const variants: MapMaterialVariant[] = [];
  const variantSlots = new Map<string, number>();
  const layoutParts: string[] = [];
  for (const group of data.materialGroups ?? []) {
    if (!Number.isInteger(group.start) || group.start < 0
      || !Number.isInteger(group.count) || group.count <= 0
      || !Number.isInteger(group.materialIndex) || group.materialIndex < 0) continue;
    const cullBackfaces = resolveMapCullBackfaceState(group, data.cullBackfaces);
    const variantKey = `${group.materialIndex}:${mapCullBackfaceStateKey(cullBackfaces)}`;
    let materialSlot = variantSlots.get(variantKey);
    if (materialSlot === undefined) {
      materialSlot = variants.length;
      variantSlots.set(variantKey, materialSlot);
      variants.push({ materialIndex: group.materialIndex, cullBackfaces });
    }
    groups.push({ start: group.start, count: group.count, materialSlot });
    // Include group bounds as well as native material/cull identity. This is
    // not a texture hash; it only prevents a model's group layout from being
    // reused when a later response has different draw ranges.
    layoutParts.push(`${group.start}:${group.count}:${variantKey}`);
  }
  return {
    key: layoutParts.join('|'),
    groups,
    variants
  };
}

export interface MeshGeometryWire {
  positionsBase64: string;
  /** Renderer-local decoded bytes. These never cross the IPC boundary. */
  positionsBytes?: Uint8Array | undefined;
  indicesBase64?: string | undefined;
  indicesBytes?: Uint8Array | undefined;
  indexSize?: 16 | 32 | undefined;
  uvsBase64?: string | undefined;
  uvsBytes?: Uint8Array | undefined;
  normalsBase64?: string | undefined;
  normalsBytes?: Uint8Array | undefined;
  vertexCount: number;
  texturePreviewToken?: string | undefined;
  textureColorSpace?: string | undefined;
  /** Top-level compatibility cull state for a single-surface payload. */
  cullBackfaces?: boolean | undefined;
  materialGroups?: MapMaterialGroup[] | undefined;
  texturePreviews?: Array<{ materialIndex: number; texturePreviewToken: string; colorSpace?: string }> | undefined;
  diagnostics?: MapGeometryPrepareDiagnostic[] | undefined;
  boundingBoxMin?: [number, number, number] | undefined;
  boundingBoxMax?: [number, number, number] | undefined;
}

/** Renderer-local hints produced by the CPU prepare worker. */
export interface PreparedGeometryHints {
  textureIdentities?: readonly PreparedTextureIdentity[];
  bounds?: PreparedGeometryBounds;
  cacheKey?: string;
}

/**
 * MAP scene 与资源池共用的模型资源键：只保留 basename，去掉容器/网格复合扩展。
 * 这样 `m000010`、`map/.../M000010.FLVER` 与 `m000010.mapbnd.dcx` 会命中同一
 * geometry entry，也与 threeSceneController 的 instance batch key 对齐。
 */
export function normalizeModelResourceKey(modelName: string): string {
  const base = modelName.replace(/\\/g, '/').split('/').pop() ?? modelName;
  return base.toLowerCase().replace(/\.(flver|mapbnd|objbnd|chrbnd)(\.dcx)?$/i, '');
}

function normalizeTypedByteView(bytes: Uint8Array, alignment: 2 | 4, label: string): Uint8Array {
  if (bytes.byteLength % alignment !== 0) {
    throw new Error(`MAP_STATIC_GEOMETRY_INVALID: ${label} byteLength is not ${alignment}-byte aligned`);
  }
  // Native IPC payloads are copied into offset-zero arrays. Keep the renderer
  // seam safe for callers that provide a legal subview with a non-zero offset.
  return bytes.byteOffset % alignment === 0 ? bytes : new Uint8Array(bytes);
}

function decodeBase64F32(base64: string, expectedCount: number, decodedBytes?: Uint8Array, label = 'float32'): Float32Array {
  const bytes = decodedBytes
    ? normalizeTypedByteView(decodedBytes, 4, label)
    : decodeBase64ToUint8Array(base64);
  if (decodedBytes && bytes.byteLength !== expectedCount * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error(`MAP_STATIC_GEOMETRY_INVALID: ${label} byteLength does not match vertex count`);
  }
  const view = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 4));
  return view.length >= expectedCount ? view : new Float32Array(expectedCount);
}

function hashTextureToken(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
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
  private static readonly maxTextureTokenHashes = 2048;
  // Data-URI keys are often large PNG payloads. Bound total retained key text
  // as well as entry count; a single over-budget token is hashed but not cached.
  private static readonly maxTextureTokenHashChars = 4 * 1024 * 1024;
  // outer by rendererContextGeneration, inner by content key (no zero-padding)
  private readonly contextPools = new Map<number, ContextPools>();
  // legacy single-context compat for existing Proxy path
  private legacyGeometries = new Map<string, BufferGeometry>();
  private legacyMaterials = new Map<string, Material>();
  private legacyTextures = new Map<string, import('three').Texture>();
  /** Bounded validation/hash cache; values are null for rejected tokens. */
  private readonly textureTokenKeys = new Map<string, string | null>();
  private textureTokenKeyChars = 0;
  private primitiveBox: BufferGeometry | null = null;
  private primitiveSphere: BufferGeometry | null = null;
  private wireframeMaterial: Material | null = null;
  private readonly defaultRealMaterials = new Map<MapCullBackfaceState, Material>();

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
    data: MeshGeometryWire,
    preparedHints?: PreparedGeometryHints
  ): BufferGeometry {
    const variantLayout = getMapMaterialVariantLayout(data);
    const resourceKey = [
      key,
      ...(preparedHints?.cacheKey ? [`prepare:${preparedHints.cacheKey}`] : []),
      ...(variantLayout.key ? [`layout:${variantLayout.key}`] : [])
    ].join(':');
    const existing = this.legacyGeometries.get(resourceKey);
    if (existing) return existing;

    const geometry = track(new three.BufferGeometry());
    geometry.setAttribute(
      'position',
      new three.BufferAttribute(
        decodeBase64F32(data.positionsBase64, data.vertexCount * 3, data.positionsBytes, 'positions'),
        3
      )
    );

    if (data.indicesBase64 || data.indicesBytes) {
      const is32 = data.indexSize === 32;
      const indexBytes = data.indicesBytes
        ? normalizeTypedByteView(data.indicesBytes, is32 ? 4 : 2, 'indices')
        : decodeBase64ToUint8Array(data.indicesBase64 ?? '');
      if (is32) {
        const view = new Uint32Array(indexBytes.buffer, indexBytes.byteOffset, Math.floor(indexBytes.length / 4));
        geometry.setIndex(preparedHints
          ? new three.BufferAttribute(view, 1)
          : new three.Uint32BufferAttribute(view, 1));
      } else {
        const view = new Uint16Array(indexBytes.buffer, indexBytes.byteOffset, Math.floor(indexBytes.length / 2));
        geometry.setIndex(preparedHints
          ? new three.BufferAttribute(view, 1)
          : new three.Uint16BufferAttribute(view, 1));
      }
    }

    if (data.uvsBase64) {
      geometry.setAttribute(
        'uv',
        new three.BufferAttribute(
          decodeBase64F32(data.uvsBase64, data.vertexCount * 2, data.uvsBytes, 'uvs'),
          2
        )
      );
    } else if (data.uvsBytes) {
      geometry.setAttribute(
        'uv',
        new three.BufferAttribute(decodeBase64F32('', data.vertexCount * 2, data.uvsBytes, 'uvs'), 2)
      );
    }

    if (data.normalsBase64 || data.normalsBytes) {
      geometry.setAttribute(
        'normal',
        new three.BufferAttribute(
          decodeBase64F32(data.normalsBase64 ?? '', data.vertexCount * 3, data.normalsBytes, 'normals'),
          3
        )
      );
    } else {
      geometry.computeVertexNormals();
    }

    if (variantLayout.groups.length > 0) {
      geometry.clearGroups();
      for (const group of variantLayout.groups) {
        geometry.addGroup(group.start, group.count, group.materialSlot);
      }
    }

    if (preparedHints?.bounds) {
      const bounds = preparedHints.bounds;
      geometry.boundingBox = new three.Box3(
        new three.Vector3(...bounds.min),
        new three.Vector3(...bounds.max)
      );
      geometry.boundingSphere = new three.Sphere(
        new three.Vector3(...bounds.sphereCenter),
        bounds.sphereRadius
      );
    }

    this.legacyGeometries.set(resourceKey, geometry);
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
    track: TrackFunction,
    cullBackfaces: MapCullBackfaceState = 'unknown'
  ): Material {
    const existing = this.defaultRealMaterials.get(cullBackfaces);
    if (existing) return existing;
    // Native o114670 map chunks were rendered through the real WebGL2 path:
    // cull=true is opposite to the native normal winding and is visible with
    // BackSide; false/unknown remain DoubleSide. WebGPU parity is unverified.
    const material = track(
      new three.MeshStandardMaterial({
        color: new three.Color(0x8e97a3),
        roughness: 0.55,
        metalness: 0.12,
        side: mapCullBackfaceSide(three, cullBackfaces),
        wireframe: false
      })
    );
    this.defaultRealMaterials.set(cullBackfaces, material);
    return material;
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

  /**
   * 地图 texture slot 在 Sekiro FLVER 中常为空路径；Bridge 已将真正的 albedo
   * 投影为 data URI。材质按模型 + 纹理 token 分开，避免把一个模型的纹理泄漏到
   * 另一个模型的共享材质上。加载完成前保留同色默认材质，失败时也安全回退。
   */
  private getTexturedRealMaterial(
    three: ThreeModule,
    track: TrackFunction,
    texturePreviewToken: string,
    colorSpace = 'srgb',
    preparedTextureKey?: string | null,
    cullBackfaces: MapCullBackfaceState = 'unknown'
  ): Material {
    let tokenKey: string | null | undefined = preparedTextureKey;
    if (preparedTextureKey === undefined) {
      tokenKey = this.textureTokenKeys.get(texturePreviewToken);
      if (tokenKey === undefined && !this.textureTokenKeys.has(texturePreviewToken)) {
        tokenKey = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(texturePreviewToken)
          ? hashTextureToken(texturePreviewToken)
          : null;
        if (texturePreviewToken.length <= ModelResourcePool.maxTextureTokenHashChars) {
          while (
            this.textureTokenKeys.size >= ModelResourcePool.maxTextureTokenHashes
            || this.textureTokenKeyChars + texturePreviewToken.length > ModelResourcePool.maxTextureTokenHashChars
          ) {
            const oldest = this.textureTokenKeys.keys().next().value;
            if (typeof oldest !== 'string') break;
            this.textureTokenKeys.delete(oldest);
            this.textureTokenKeyChars -= oldest.length;
          }
          this.textureTokenKeys.set(texturePreviewToken, tokenKey);
          this.textureTokenKeyChars += texturePreviewToken.length;
        }
      }
    }
    if (!tokenKey) {
      return this.getDefaultRealMaterial(three, track, cullBackfaces);
    }
    const normalizedColorSpace = colorSpace.toLowerCase() === 'linear' ? 'linear' : 'srgb';
    // The material state is fully described by the preview identity and color
    // space. Do not include the model name: the same map texture is commonly
    // used by hundreds of placements/models, and Smithbox's texture/material
    // pool keeps those resources shared instead of allocating one material per
    // model. Geometry remains keyed by model, so this cannot mix vertex data.
    const key = `real:texture:${tokenKey}:${normalizedColorSpace}:${mapCullBackfaceStateKey(cullBackfaces)}`;
    const existing = this.legacyMaterials.get(key);
    if (existing) return existing;

    const material = track(new three.MeshStandardMaterial({
      color: new three.Color(0xffffff),
      roughness: 0.78,
      metalness: 0.04,
      side: mapCullBackfaceSide(three, cullBackfaces),
      wireframe: false,
      // Map foliage, banners and several decal-like materials use cut-out
      // alpha. Without an alpha test Chromium draws the transparent texels as
      // dark opaque fragments, producing the black shard field visible in the
      // map viewport. Keep depth writes so cut-outs still occlude correctly.
      alphaTest: 0.1,
      depthWrite: true
    }));
    this.legacyMaterials.set(key, material);

    // One preview token can be referenced by hundreds of placements and by
    // several models. Reuse the decoded Texture by token/color-space, matching
    // Smithbox's texture pool and avoiding one browser decode per material.
    const textureKey = `preview:${tokenKey}:${normalizedColorSpace}`;
    let texture = this.legacyTextures.get(textureKey);
    if (!texture) {
      const loader = new three.TextureLoader();
      texture = loader.load(
        texturePreviewToken,
        undefined,
        undefined,
        () => {
          // Keep the neutral material when a browser decoder rejects the
          // preview; the Bridge diagnostic remains the source of truth.
        }
      );
      texture.flipY = false;
      texture.colorSpace = normalizedColorSpace === 'linear' ? three.LinearSRGBColorSpace : three.SRGBColorSpace;
      texture.wrapS = three.RepeatWrapping;
      texture.wrapT = three.RepeatWrapping;
      texture.needsUpdate = true;
      this.legacyTextures.set(textureKey, texture);
    }
    material.map = texture;
    material.needsUpdate = true;
    return material;
  }

  public updateModelGeometry(
    three: ThreeModule,
    track: TrackFunction,
    modelName: string,
    geometryData: MeshGeometryWire,
    preparedHints?: PreparedGeometryHints
  ): { geometry: BufferGeometry; material: Material | Material[] } {
    const key = normalizeModelResourceKey(modelName);
    const geometry = this.getOrCreateGeometry(three, track, key, geometryData, preparedHints);
    const variantLayout = getMapMaterialVariantLayout(geometryData);
    const previews = new Map(
      (geometryData.texturePreviews ?? [])
        .filter((preview) => Number.isInteger(preview.materialIndex) && preview.materialIndex >= 0)
        .map((preview) => [preview.materialIndex, preview])
    );
    const groupIndices = (geometryData.materialGroups ?? [])
      .map((group) => group.materialIndex)
      .filter((index) => Number.isInteger(index) && index >= 0);
    const preparedTextureKeys = new Map(
      (preparedHints?.textureIdentities ?? []).map((identity) => [identity.materialIndex, identity.textureKey])
    );
    if (variantLayout.variants.length > 0) {
      const materials = variantLayout.variants.map(({ materialIndex, cullBackfaces }) => {
        const preview = previews.get(materialIndex);
        return preview
          ? this.getTexturedRealMaterial(
            three,
            track,
            preview.texturePreviewToken,
            preview.colorSpace,
            preparedTextureKeys.get(materialIndex),
            cullBackfaces
          )
          : this.getDefaultRealMaterial(three, track, cullBackfaces);
      });
      return {
        geometry,
        material: materials.length === 1 ? materials[0]! : materials
      };
    }
    if (previews.size > 0 || groupIndices.length > 0) {
      const previewIndices = [...previews.keys()];
      const maxMaterialIndex = Math.max(-1, ...previewIndices, ...groupIndices);
      const cullBackfaces = resolveMapCullBackfaceState(undefined, geometryData.cullBackfaces);
      const materials = Array.from({ length: maxMaterialIndex + 1 }, (_, materialIndex) => {
        const preview = previews.get(materialIndex);
        return preview
          ? this.getTexturedRealMaterial(
            three,
            track,
            preview.texturePreviewToken,
            preview.colorSpace,
            preparedTextureKeys.get(materialIndex),
            cullBackfaces
          )
          : this.getDefaultRealMaterial(three, track, cullBackfaces);
      });
      return {
        geometry,
        material: materials.length === 1 ? materials[0]! : materials
      };
    }
    const material = geometryData.texturePreviewToken
      ? this.getTexturedRealMaterial(
        three,
        track,
        geometryData.texturePreviewToken,
        geometryData.textureColorSpace,
        preparedTextureKeys.get(0),
        resolveMapCullBackfaceState(undefined, geometryData.cullBackfaces)
      )
      : this.getDefaultRealMaterial(
        three,
        track,
        resolveMapCullBackfaceState(undefined, geometryData.cullBackfaces)
      );
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
    for (const texture of this.legacyTextures.values()) texture.dispose();
    this.legacyTextures.clear();
    this.textureTokenKeys.clear();
    this.textureTokenKeyChars = 0;
    this.primitiveBox = null;
    this.primitiveSphere = null;
    this.wireframeMaterial = null;
    this.defaultRealMaterials.clear();
  }
}
