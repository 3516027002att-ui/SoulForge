import { Buffer } from 'node:buffer';

export interface MapMeshGeometryData extends Record<string, unknown> {
  meshIndex?: number;
  meshCount?: number;
  vertexCount?: number;
  positionsBase64?: string;
  indicesBase64?: string;
  uvsBase64?: string;
  normalsBase64?: string;
  indexSize?: 16 | 32;
}

function fail(message: string): never {
  throw new Error(`MAP_MESH_GEOMETRY_INVALID: ${message}`);
}

function decodeBase64Exact(value: unknown, expectedBytes: number, label: string): Buffer {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} is missing`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.byteLength !== expectedBytes) {
    fail(`${label} byteLength=${bytes.byteLength}, expected=${expectedBytes}`);
  }
  return bytes;
}

function assertFiniteFloat32(bytes: Buffer, label: string): void {
  if (bytes.byteLength % 4 !== 0) fail(`${label} byteLength is not Float32-aligned`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset < bytes.byteLength; offset += 4) {
    const value = view.getFloat32(offset, true);
    if (!Number.isFinite(value)) fail(`${label} contains non-finite Float32 at byte ${offset}`);
  }
}

function decodeIndices(mesh: MapMeshGeometryData, vertexCount: number, meshOrdinal: number): number[] {
  const indexSize = mesh.indexSize;
  if (indexSize !== 16 && indexSize !== 32) {
    fail(`mesh[${meshOrdinal}] indexSize must be 16 or 32`);
  }
  if (typeof mesh.indicesBase64 !== 'string' || mesh.indicesBase64.length === 0) {
    fail(`mesh[${meshOrdinal}] indices are missing`);
  }
  const bytes = Buffer.from(mesh.indicesBase64, 'base64');
  const stride = indexSize / 8;
  if (bytes.byteLength === 0 || bytes.byteLength % stride !== 0) {
    fail(`mesh[${meshOrdinal}] index byteLength=${bytes.byteLength} is not divisible by stride=${stride}`);
  }
  const count = bytes.byteLength / stride;
  if (count % 3 !== 0) {
    fail(`mesh[${meshOrdinal}] triangle-list index count=${count} is not divisible by 3`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const indices = new Array<number>(count);
  for (let i = 0; i < count; i += 1) {
    const value = indexSize === 32
      ? view.getUint32(i * stride, true)
      : view.getUint16(i * stride, true);
    if (value >= vertexCount) {
      fail(`mesh[${meshOrdinal}] index ${value} exceeds vertexCount ${vertexCount}`);
    }
    indices[i] = value;
  }
  return indices;
}

function encodeIndices(indices: readonly number[], indexSize: 16 | 32): string {
  const stride = indexSize / 8;
  const bytes = Buffer.allocUnsafe(indices.length * stride);
  for (let i = 0; i < indices.length; i += 1) {
    const value = indices[i]!;
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
      fail(`merged index ${value} is outside uint32 range`);
    }
    if (indexSize === 16) {
      if (value > 0xffff) fail(`merged index ${value} does not fit uint16`);
      bytes.writeUInt16LE(value, i * stride);
    } else {
      bytes.writeUInt32LE(value, i * stride);
    }
  }
  return bytes.toString('base64');
}

/**
 * Merge the per-FLVER-mesh payloads returned by read-map-part-flver-preview.
 * Source index width is authoritative metadata; it is never inferred from vertex count
 * or byte length. Every mesh is validated before its local indices are relocated.
 */
export function mergeMapMeshGeometry(meshes: readonly MapMeshGeometryData[]): MapMeshGeometryData {
  if (meshes.length === 0) fail('no meshes supplied');

  let baseVertex = 0;
  let outputIndexSize: 16 | 32 = 16;
  const positions: Buffer[] = [];
  const uvs: Buffer[] = [];
  const normals: Buffer[] = [];
  const mergedIndices: number[] = [];
  let allHaveUvs = true;
  let allHaveNormals = true;

  for (let meshOrdinal = 0; meshOrdinal < meshes.length; meshOrdinal += 1) {
    const mesh = meshes[meshOrdinal]!;
    const vertexCount = Number(mesh.vertexCount);
    if (!Number.isSafeInteger(vertexCount) || vertexCount <= 0) {
      fail(`mesh[${meshOrdinal}] vertexCount=${String(mesh.vertexCount)} is invalid`);
    }

    const positionBytes = decodeBase64Exact(
      mesh.positionsBase64,
      vertexCount * 3 * 4,
      `mesh[${meshOrdinal}] positions`
    );
    assertFiniteFloat32(positionBytes, `mesh[${meshOrdinal}] positions`);
    positions.push(positionBytes);

    const localIndices = decodeIndices(mesh, vertexCount, meshOrdinal);
    if (mesh.indexSize === 32) outputIndexSize = 32;
    for (const localIndex of localIndices) {
      const shifted = localIndex + baseVertex;
      if (!Number.isSafeInteger(shifted) || shifted > 0xffff_ffff) {
        fail(`mesh[${meshOrdinal}] relocated index ${shifted} is outside uint32 range`);
      }
      if (shifted > 0xffff) outputIndexSize = 32;
      mergedIndices.push(shifted);
    }

    if (mesh.uvsBase64 == null) {
      allHaveUvs = false;
    } else {
      const uvBytes = decodeBase64Exact(mesh.uvsBase64, vertexCount * 2 * 4, `mesh[${meshOrdinal}] uvs`);
      assertFiniteFloat32(uvBytes, `mesh[${meshOrdinal}] uvs`);
      uvs.push(uvBytes);
    }

    if (mesh.normalsBase64 == null) {
      allHaveNormals = false;
    } else {
      const normalBytes = decodeBase64Exact(
        mesh.normalsBase64,
        vertexCount * 3 * 4,
        `mesh[${meshOrdinal}] normals`
      );
      assertFiniteFloat32(normalBytes, `mesh[${meshOrdinal}] normals`);
      normals.push(normalBytes);
    }

    baseVertex += vertexCount;
    if (!Number.isSafeInteger(baseVertex) || baseVertex > 0xffff_ffff) {
      fail(`merged vertexCount ${baseVertex} exceeds uint32 addressable range`);
    }
  }

  const first = meshes[0]!;
  const merged: MapMeshGeometryData = {
    ...first,
    meshIndex: 0,
    meshCount: 1,
    vertexCount: baseVertex,
    positionsBase64: Buffer.concat(positions).toString('base64'),
    indicesBase64: encodeIndices(mergedIndices, outputIndexSize),
    indexSize: outputIndexSize
  };

  if (allHaveUvs && uvs.length === meshes.length) merged.uvsBase64 = Buffer.concat(uvs).toString('base64');
  else delete merged.uvsBase64;
  if (allHaveNormals && normals.length === meshes.length) merged.normalsBase64 = Buffer.concat(normals).toString('base64');
  else delete merged.normalsBase64;

  return merged;
}
