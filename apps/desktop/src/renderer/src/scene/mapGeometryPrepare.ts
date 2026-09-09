import type { MeshGeometryWire } from './modelResourcePool.js';
import { decodeBase64ToUint8Array, uint8ArrayToBase64 } from '../utils/binary.js';

/**
 * The Bridge owns the shape and meaning of these fields.  This renderer-only
 * copy is deliberately limited to the already typed wire fields: preparation
 * may decode and cache them, but it does not invent another native format.
 */
export interface MapStaticGeometryChunk {
  positionsBase64?: string | null;
  indicesBase64?: string | null;
  indexElementBytes?: 2 | 4 | null;
  uvsBase64?: string | null;
  normalsBase64?: string | null;
  materialIndex?: number | null;
  materialName?: string | null;
  texturePreviewToken?: string | null;
  textureColorSpace?: string | null;
}

export type RendererGeometryBytes = Pick<
  MeshGeometryWire,
  'positionsBytes' | 'indicesBytes' | 'uvsBytes' | 'normalsBytes'
>;

export type MapMeshGeometryData = Omit<Partial<MeshGeometryWire>, 'positionsBase64'> & {
  positionsBase64?: string;
  positionsBytes?: Uint8Array;
  indicesBytes?: Uint8Array;
  uvsBytes?: Uint8Array;
  normalsBytes?: Uint8Array;
};

export interface PreparedTextureIdentity {
  materialIndex: number;
  texturePreviewToken: string;
  colorSpace?: string;
  /** Renderer-local cache identity; never part of the Bridge/native DTO. */
  textureKey: string | null;
}

export interface PreparedGeometryBounds {
  min: [number, number, number];
  max: [number, number, number];
  sphereCenter: [number, number, number];
  sphereRadius: number;
}

export interface PreparedMapGeometry extends MeshGeometryWire {
  textureIdentities: PreparedTextureIdentity[];
  bounds?: PreparedGeometryBounds;
  /** Per-request renderer identity; prevents stale normalized-key reuse. */
  cacheKey?: string;
}

function concatUint8Arrays(parts: readonly Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return merged;
}

/**
 * Three's legacy BufferGeometry.computeVertexNormals equivalent, kept in the
 * worker-side prepare phase so a missing native normal stream cannot move a
 * large model's normal calculation back onto the renderer event loop.
 */
function computeVertexNormalsBytes(
  positionsBytes: Uint8Array,
  vertexCount: number,
  indices: ArrayLike<number> | null
): Uint8Array {
  const positions = new Float32Array(
    positionsBytes.buffer,
    positionsBytes.byteOffset,
    positionsBytes.byteLength / Float32Array.BYTES_PER_ELEMENT
  );
  const normals = new Float32Array(vertexCount * 3);
  const triangleCount = indices ? Math.floor(indices.length / 3) : Math.floor(vertexCount / 3);
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const offset = triangle * 3;
    const a = indices ? indices[offset]! : offset;
    const b = indices ? indices[offset + 1]! : offset + 1;
    const c = indices ? indices[offset + 2]! : offset + 2;
    if (a < 0 || b < 0 || c < 0 || a >= vertexCount || b >= vertexCount || c >= vertexCount) {
      throw new Error('MAP_STATIC_GEOMETRY_INVALID: normal triangle index is outside positions');
    }
    const ax = positions[a * 3]!;
    const ay = positions[a * 3 + 1]!;
    const az = positions[a * 3 + 2]!;
    const bx = positions[b * 3]!;
    const by = positions[b * 3 + 1]!;
    const bz = positions[b * 3 + 2]!;
    const cx = positions[c * 3]!;
    const cy = positions[c * 3 + 1]!;
    const cz = positions[c * 3 + 2]!;
    // Match Three's cb.cross(ab): (C-B) x (A-B).
    const cbx = cx - bx;
    const cby = cy - by;
    const cbz = cz - bz;
    const abx = ax - bx;
    const aby = ay - by;
    const abz = az - bz;
    const nx = cby * abz - cbz * aby;
    const ny = cbz * abx - cbx * abz;
    const nz = cbx * aby - cby * abx;
    for (const index of [a, b, c]) {
      normals[index * 3] = normals[index * 3]! + nx;
      normals[index * 3 + 1] = normals[index * 3 + 1]! + ny;
      normals[index * 3 + 2] = normals[index * 3 + 2]! + nz;
    }
  }
  for (let index = 0; index < vertexCount; index += 1) {
    const offset = index * 3;
    const length = Math.hypot(normals[offset]!, normals[offset + 1]!, normals[offset + 2]!);
    if (length > 0) {
      normals[offset] = normals[offset]! / length;
      normals[offset + 1] = normals[offset + 1]! / length;
      normals[offset + 2] = normals[offset + 2]! / length;
    }
  }
  return new Uint8Array(normals.buffer);
}

/** Same bounded identity algorithm used by the legacy renderer pool. */
export function prepareTextureKey(value: string): string | null {
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value)) return null;
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Pure merge used by the worker and by legacy unit fixtures. Production MAP
 * loading calls it only inside the worker; the renderer wrapper remains for
 * old tests and non-MAP callers.
 */
export function mergeMapStaticGeometryChunks(
  chunks: readonly MapStaticGeometryChunk[],
  options: { encodeBase64?: boolean } = {}
): MapMeshGeometryData {
  const encodeBase64 = options.encodeBase64 ?? true;
  const geometryChunks = chunks.filter((chunk) => Boolean(chunk.positionsBase64));
  if (geometryChunks.length === 0) return {};

  const positions: Uint8Array[] = [];
  const chunkVertexCounts: number[] = [];
  const uvs: Uint8Array[] = [];
  const normals: Uint8Array[] = [];
  const allHaveIndices = geometryChunks.every((chunk) => Boolean(chunk.indicesBase64));
  // Keep the existing renderer contract: if any surface has UVs, zero-fill
  // missing UVs so material groups remain aligned with their source vertices.
  const anyHaveUvs = geometryChunks.some((chunk) => Boolean(chunk.uvsBase64));
  const allHaveNormals = geometryChunks.every((chunk) => Boolean(chunk.normalsBase64));
  const materialGroups: Array<{ start: number; count: number; materialIndex: number }> = [];
  const texturePreviews = new Map<number, { materialIndex: number; texturePreviewToken: string; colorSpace?: string }>();
  let vertexCount = 0;
  let indexSize: 16 | 32 = 16;
  let indexCount = 0;

  // First pass decodes each index stream only long enough to validate it,
  // count its elements, and choose the smallest exact output width.  Keeping
  // no JS number[] here avoids a boxed/indexed-array copy proportional to the
  // entire model; the second pass writes directly into the final typed array.
  for (const chunk of geometryChunks) {
    const positionBytes = decodeBase64ToUint8Array(chunk.positionsBase64!);
    if (positionBytes.byteLength % (3 * Float32Array.BYTES_PER_ELEMENT) !== 0) {
      throw new Error('MAP_STATIC_GEOMETRY_INVALID: positions are not Float32 xyz aligned');
    }
    const chunkVertexCount = positionBytes.byteLength / (3 * Float32Array.BYTES_PER_ELEMENT);
    positions.push(positionBytes);
    chunkVertexCounts.push(chunkVertexCount);

    if (anyHaveUvs) {
      if (chunk.uvsBase64) {
        const uvBytes = decodeBase64ToUint8Array(chunk.uvsBase64);
        const expectedUvBytes = chunkVertexCount * 2 * Float32Array.BYTES_PER_ELEMENT;
        if (uvBytes.byteLength !== expectedUvBytes) {
          throw new Error('MAP_STATIC_GEOMETRY_INVALID: UV count does not match positions');
        }
        uvs.push(uvBytes);
      } else {
        uvs.push(new Uint8Array(chunkVertexCount * 2 * Float32Array.BYTES_PER_ELEMENT));
      }
    }
    if (allHaveNormals) normals.push(decodeBase64ToUint8Array(chunk.normalsBase64!));

    const materialIndex = Number.isInteger(chunk.materialIndex) && (chunk.materialIndex ?? -1) >= 0
      ? chunk.materialIndex!
      : 0;
    let groupStart = vertexCount;
    let groupCount = chunkVertexCount;
    if (allHaveIndices) {
      const indexElementBytes = chunk.indexElementBytes;
      if (indexElementBytes !== 2 && indexElementBytes !== 4) {
        throw new Error('MAP_STATIC_GEOMETRY_INVALID: indexElementBytes must be 2 or 4');
      }
      const indexBytes = decodeBase64ToUint8Array(chunk.indicesBase64!);
      if (indexBytes.byteLength % indexElementBytes !== 0) {
        throw new Error('MAP_STATIC_GEOMETRY_INVALID: indices are not aligned');
      }
      const indexView = new DataView(indexBytes.buffer, indexBytes.byteOffset, indexBytes.byteLength);
      groupStart = indexCount;
      groupCount = indexBytes.byteLength / indexElementBytes;
      for (let offset = 0; offset < indexBytes.byteLength; offset += indexElementBytes) {
        const localIndex = indexElementBytes === 4
          ? indexView.getUint32(offset, true)
          : indexView.getUint16(offset, true);
        const mergedIndex = localIndex + vertexCount;
        if (mergedIndex > 0xffff_ffff) {
          throw new Error('MAP_STATIC_GEOMETRY_INVALID: merged index exceeds uint32');
        }
        if (indexElementBytes === 4 || mergedIndex > 0xffff) indexSize = 32;
      }
      indexCount += groupCount;
    }

    if (groupCount > 0) materialGroups.push({ start: groupStart, count: groupCount, materialIndex });
    if (chunk.texturePreviewToken) {
      texturePreviews.set(materialIndex, {
        materialIndex,
        texturePreviewToken: chunk.texturePreviewToken,
        ...(chunk.textureColorSpace ? { colorSpace: chunk.textureColorSpace } : {})
      });
    }
    vertexCount += chunkVertexCount;
  }

  const positionsBytes = concatUint8Arrays(positions);
  const merged: MapMeshGeometryData = {
    ...(encodeBase64 ? { positionsBase64: uint8ArrayToBase64(positionsBytes) } : {}),
    positionsBytes,
    vertexCount
  };
  if (allHaveIndices) {
    const indexBytes = new Uint8Array(indexCount * (indexSize / 8));
    const indexView = new DataView(indexBytes.buffer);
    let outputIndex = 0;
    let vertexOffset = 0;
    for (let chunkIndex = 0; chunkIndex < geometryChunks.length; chunkIndex += 1) {
      const chunk = geometryChunks[chunkIndex]!;
      const chunkVertexCount = chunkVertexCounts[chunkIndex]!;
      const indexElementBytes = chunk.indexElementBytes;
      const sourceBytes = decodeBase64ToUint8Array(chunk.indicesBase64!);
      if (indexElementBytes !== 2 && indexElementBytes !== 4) {
        throw new Error('MAP_STATIC_GEOMETRY_INVALID: indexElementBytes must be 2 or 4');
      }
      if (sourceBytes.byteLength % indexElementBytes !== 0) {
        throw new Error('MAP_STATIC_GEOMETRY_INVALID: indices are not aligned');
      }
      const sourceView = new DataView(sourceBytes.buffer, sourceBytes.byteOffset, sourceBytes.byteLength);
      for (let offset = 0; offset < sourceBytes.byteLength; offset += indexElementBytes) {
        const localIndex = indexElementBytes === 4
          ? sourceView.getUint32(offset, true)
          : sourceView.getUint16(offset, true);
        const mergedIndex = localIndex + vertexOffset;
        if (mergedIndex > 0xffff_ffff) {
          throw new Error('MAP_STATIC_GEOMETRY_INVALID: merged index exceeds uint32');
        }
        if (indexSize === 32) indexView.setUint32(outputIndex * 4, mergedIndex, true);
        else {
          if (mergedIndex > 0xffff) {
            throw new Error('MAP_STATIC_GEOMETRY_INVALID: merged index exceeds uint16');
          }
          indexView.setUint16(outputIndex * 2, mergedIndex, true);
        }
        outputIndex += 1;
      }
      vertexOffset += chunkVertexCount;
    }
    merged.indicesBytes = indexBytes;
    if (encodeBase64) merged.indicesBase64 = uint8ArrayToBase64(indexBytes);
    merged.indexSize = indexSize;
    const indexArray = indexSize === 32
      ? new Uint32Array(indexBytes.buffer, indexBytes.byteOffset, indexCount)
      : new Uint16Array(indexBytes.buffer, indexBytes.byteOffset, indexCount);
    merged.normalsBytes = allHaveNormals
      ? concatUint8Arrays(normals)
      : computeVertexNormalsBytes(positionsBytes, vertexCount, indexArray);
  } else {
    merged.normalsBytes = allHaveNormals
      ? concatUint8Arrays(normals)
      : computeVertexNormalsBytes(positionsBytes, vertexCount, null);
  }
  if (anyHaveUvs) {
    const uvsBytes = concatUint8Arrays(uvs);
    merged.uvsBytes = uvsBytes;
    if (encodeBase64) merged.uvsBase64 = uint8ArrayToBase64(uvsBytes);
  }
  const normalsBytes = merged.normalsBytes!;
  if (encodeBase64) merged.normalsBase64 = uint8ArrayToBase64(normalsBytes);
  if (materialGroups.length > 0) merged.materialGroups = materialGroups;
  if (texturePreviews.size > 0) merged.texturePreviews = [...texturePreviews.values()];
  return merged;
}

export function prepareMapStaticGeometryChunks(
  chunks: readonly MapStaticGeometryChunk[],
  options: { texturePreviewToken?: string; textureColorSpace?: string } = {}
): PreparedMapGeometry {
  const merged = mergeMapStaticGeometryChunks(chunks, { encodeBase64: false });
  if (!merged.positionsBytes || !merged.vertexCount || merged.vertexCount <= 0) {
    throw new Error('MAP_STATIC_GEOMETRY_NO_POSITIONS: prepared response contained no positions');
  }
  const geometry: MeshGeometryWire = {
    positionsBase64: '',
    positionsBytes: merged.positionsBytes,
    ...(merged.indicesBytes ? { indicesBytes: merged.indicesBytes } : {}),
    ...(merged.indexSize === 16 || merged.indexSize === 32 ? { indexSize: merged.indexSize } : {}),
    ...(merged.uvsBytes ? { uvsBytes: merged.uvsBytes } : {}),
    ...(merged.normalsBytes ? { normalsBytes: merged.normalsBytes } : {}),
    ...(merged.materialGroups ? { materialGroups: merged.materialGroups } : {}),
    ...(merged.texturePreviews ? { texturePreviews: merged.texturePreviews } : {}),
    ...(options.texturePreviewToken ? { texturePreviewToken: options.texturePreviewToken } : {}),
    ...(options.textureColorSpace ? { textureColorSpace: options.textureColorSpace } : {}),
    vertexCount: merged.vertexCount
  };
  const textureIdentities = (geometry.texturePreviews ?? []).map((preview) => ({
    materialIndex: preview.materialIndex,
    texturePreviewToken: preview.texturePreviewToken,
    ...(preview.colorSpace ? { colorSpace: preview.colorSpace } : {}),
    textureKey: prepareTextureKey(preview.texturePreviewToken)
  }));
  // Bridge may provide one top-level preview token instead of a material
  // table. Give the pool the same worker-computed identity so its fallback
  // path never re-runs the expensive validation/hash on the renderer thread.
  if (geometry.texturePreviewToken && !textureIdentities.some((identity) => identity.materialIndex === 0)) {
    textureIdentities.push({
      materialIndex: 0,
      texturePreviewToken: geometry.texturePreviewToken,
      ...(geometry.textureColorSpace ? { colorSpace: geometry.textureColorSpace } : {}),
      textureKey: prepareTextureKey(geometry.texturePreviewToken)
    });
  }
  const positionsBytes = geometry.positionsBytes!;
  const positions = new Float32Array(
    positionsBytes.buffer,
    positionsBytes.byteOffset,
    positionsBytes.byteLength / Float32Array.BYTES_PER_ELEMENT
  );
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < positions.length; index += 3) {
    const x = positions[index]!;
    const y = positions[index + 1]!;
    const z = positions[index + 2]!;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new Error('MAP_STATIC_GEOMETRY_INVALID: positions contain non-finite values');
    }
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const centerZ = (minZ + maxZ) / 2;
  let radiusSquared = 0;
  for (let index = 0; index < positions.length; index += 3) {
    const dx = positions[index]! - centerX;
    const dy = positions[index + 1]! - centerY;
    const dz = positions[index + 2]! - centerZ;
    radiusSquared = Math.max(radiusSquared, dx * dx + dy * dy + dz * dz);
  }
  return {
    ...{
      ...geometry,
      boundingBoxMin: [minX, minY, minZ],
      boundingBoxMax: [maxX, maxY, maxZ]
    },
    textureIdentities,
    bounds: {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
      sphereCenter: [centerX, centerY, centerZ],
      sphereRadius: Math.sqrt(radiusSquared)
    }
  };
}

export interface MapGeometryPrepareWorkerRequest {
  kind: 'prepare';
  jobId: string;
  chunks: MapStaticGeometryChunk[];
  texturePreviewToken?: string;
  textureColorSpace?: string;
}

export interface MapGeometryPrepareWorkerResponse {
  kind: 'result' | 'error';
  jobId: string;
  prepared?: PreparedMapGeometry;
  error?: { code: string; message: string };
  /** Pure prepare duration measured inside the worker, excluding queue wait. */
  prepareDurationMs?: number;
}

export function preparedGeometryTransferables(prepared: PreparedMapGeometry): ArrayBuffer[] {
  const buffers = [
    prepared.positionsBytes?.buffer,
    prepared.indicesBytes?.buffer,
    prepared.uvsBytes?.buffer,
    prepared.normalsBytes?.buffer
  ];
  return [...new Set(buffers.filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer))];
}
