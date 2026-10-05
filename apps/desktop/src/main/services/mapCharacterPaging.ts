import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import type { CharacterPreviewBundle, Diagnostic, FlverPreviewModel, FlverPreviewMesh } from '@soulforge/shared';

export interface MapCharacterPageSession {
  token: string;
  sourceUri: string;
  modelPath: string;
  modelStem: string;
  chunks: Array<Record<string, unknown>>;
  diagnostics: Diagnostic[];
  cursors: Map<string, number>;
  lastAccessMs: number;
}

/** Bounded derived character geometry pages, not a native format parser. */
export function createMapCharacterPaging() {


/**
 * 地图里的 c* / o* 对象不是 mapbnd 静态几何，而是 chrbnd/objbnd。将其
 * 转成地图只读几何时保留每个 mesh 的材质分组和已由 Bridge 解码的 PNG，
 * 仅忽略动作所需的 skin attributes；地图实例本身不驱动角色动画。
 */
function characterBundleToMapChunks(bundle: CharacterPreviewBundle): Array<Record<string, unknown>> {
  const textureMaterialIndices = new Map<string, number>();
  const emittedTextureMaterials = new Set<number>();
  let nextTextureMaterialIndex = 1; // 0 保留给没有纹理的中性材质。
  const chunks: Array<Record<string, unknown>> = [];

  const textureFor = (model: FlverPreviewModel, mesh: FlverPreviewMesh) =>
    model.texturePreviews?.find((preview) => preview.materialIndex === mesh.materialIndex)
      ?? (model.texturePreviewToken
        ? {
            materialIndex: mesh.materialIndex ?? 0,
            textureName: `${model.entry.name}:default`,
            texturePreviewToken: model.texturePreviewToken,
            width: 1,
            height: 1,
            colorSpace: model.textureColorSpace ?? 'srgb'
          }
        : undefined);

  for (const model of bundle.models) {
    for (const mesh of model.meshes) {
      const positionBytes = Buffer.from(mesh.positionsBase64, 'base64');
      const expectedPositionBytes = mesh.vertexCount * 3 * Float32Array.BYTES_PER_ELEMENT;
      if (positionBytes.byteLength !== expectedPositionBytes) {
        throw new Error(`MAP_CHARACTER_GEOMETRY_INVALID: ${model.entry.name}:mesh[${mesh.meshIndex}] positions length mismatch`);
      }

      const chunk: Record<string, unknown> = {
        positionsBase64: mesh.positionsBase64,
        vertexCount: mesh.vertexCount
      };
      if (mesh.indicesBase64) {
        const indexElementBytes = mesh.indexSize / 8;
        const indexBytes = Buffer.from(mesh.indicesBase64, 'base64');
        if (indexBytes.byteLength % indexElementBytes !== 0) {
          throw new Error(`MAP_CHARACTER_GEOMETRY_INVALID: ${model.entry.name}:mesh[${mesh.meshIndex}] indices alignment`);
        }
        chunk.indicesBase64 = mesh.indicesBase64;
        chunk.indexElementBytes = indexElementBytes;
      }
      if (mesh.uvsBase64) {
        const uvBytes = Buffer.from(mesh.uvsBase64, 'base64');
        if (uvBytes.byteLength !== mesh.vertexCount * 2 * Float32Array.BYTES_PER_ELEMENT) {
          throw new Error(`MAP_CHARACTER_GEOMETRY_INVALID: ${model.entry.name}:mesh[${mesh.meshIndex}] UV length mismatch`);
        }
        chunk.uvsBase64 = mesh.uvsBase64;
      }
      if (mesh.normalsBase64) {
        const normalBytes = Buffer.from(mesh.normalsBase64, 'base64');
        if (normalBytes.byteLength !== mesh.vertexCount * 3 * Float32Array.BYTES_PER_ELEMENT) {
          throw new Error(`MAP_CHARACTER_GEOMETRY_INVALID: ${model.entry.name}:mesh[${mesh.meshIndex}] normal length mismatch`);
        }
        chunk.normalsBase64 = mesh.normalsBase64;
      }

      const preview = textureFor(model, mesh);
      if (preview?.texturePreviewToken) {
        const colorSpace = preview.colorSpace ?? 'srgb';
        const textureKey = `${preview.texturePreviewToken}\0${colorSpace}`;
        let materialIndex = textureMaterialIndices.get(textureKey);
        if (materialIndex === undefined) {
          materialIndex = nextTextureMaterialIndex++;
          textureMaterialIndices.set(textureKey, materialIndex);
        }
        chunk.materialIndex = materialIndex;
        // 纹理 data URI 可能很大，同一材质只在第一个 chunk 携带一次；
        // renderer 的 merge 阶段会把它复用到后续 draw group。
        if (!emittedTextureMaterials.has(materialIndex)) {
          emittedTextureMaterials.add(materialIndex);
          chunk.texturePreviewToken = preview.texturePreviewToken;
          chunk.textureColorSpace = colorSpace;
        }
      } else {
        chunk.materialIndex = 0;
      }
      chunks.push(chunk);
    }
  }
  return chunks;
}

function estimateMapStaticWireBytes(data: unknown): number {
  if (data === null || data === undefined) return 4;
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8') + 2;
  if (typeof data === 'number' || typeof data === 'boolean') return 16;
  if (typeof data !== 'object') return 32;

  const record = data as Record<string, unknown>;
  let total = 64;

  if (typeof record.sessionToken === 'string') total += record.sessionToken.length + 20;
  if (typeof record.nextCursor === 'string') total += record.nextCursor.length + 16;
  if (typeof record.texturePreviewToken === 'string') total += record.texturePreviewToken.length + 24;
  if (typeof record.textureColorSpace === 'string') total += record.textureColorSpace.length + 22;

  const chunks = record.chunks;
  if (Array.isArray(chunks)) {
    total += 16;
    for (const chunk of chunks) {
      if (!chunk || typeof chunk !== 'object') {
        total += 64;
        continue;
      }
      const c = chunk as Record<string, unknown>;
      total += 256;
      for (const key in c) {
        const val = c[key];
        if (typeof val === 'string') {
          total += key.length + val.length + 6;
        } else if (Array.isArray(val)) {
          total += key.length + val.length * 24 + 6;
        } else if (typeof val === 'number' || typeof val === 'boolean') {
          total += key.length + 20;
        } else if (val) {
          total += key.length + 64;
        }
      }
    }
    return total;
  }

  total += 256;
  for (const key in record) {
    const val = record[key];
    if (typeof val === 'string') {
      total += key.length + val.length + 6;
    } else if (Array.isArray(val)) {
      total += key.length + val.length * 24 + 6;
    } else if (typeof val === 'number' || typeof val === 'boolean') {
      total += key.length + 20;
    } else if (val) {
      total += key.length + 64;
    }
  }
  return total;
}

const MAP_CHARACTER_WIRE_BUDGET_BYTES = 8 * 1024 * 1024;
const MAP_CHARACTER_CHUNK_VERTEX_LIMIT = 24_000;
const MAP_CHARACTER_PAGE_TTL_MS = 10 * 60_000;
const MAP_CHARACTER_PAGE_CAPACITY = 32;

const mapCharacterPageSessions = new Map<string, MapCharacterPageSession>();

function encodeFloat32Values(values: readonly number[]): string {
  const bytes = Buffer.allocUnsafe(values.length * Float32Array.BYTES_PER_ELEMENT);
  for (let index = 0; index < values.length; index += 1) {
    bytes.writeFloatLE(values[index] ?? 0, index * Float32Array.BYTES_PER_ELEMENT);
  }
  return bytes.toString('base64');
}

function encodeIndices(values: readonly number[], elementBytes: 2 | 4): string {
  const bytes = Buffer.allocUnsafe(values.length * elementBytes);
  for (let index = 0; index < values.length; index += 1) {
    if (elementBytes === 4) bytes.writeUInt32LE(values[index] ?? 0, index * elementBytes);
    else bytes.writeUInt16LE(values[index] ?? 0, index * elementBytes);
  }
  return bytes.toString('base64');
}

function splitCharacterMapChunk(chunk: Record<string, unknown>): Array<Record<string, unknown>> {
  const positionsBase64 = typeof chunk.positionsBase64 === 'string' ? chunk.positionsBase64 : '';
  const vertexCount = typeof chunk.vertexCount === 'number' && Number.isSafeInteger(chunk.vertexCount)
    ? chunk.vertexCount
    : 0;
  if (!positionsBase64 || vertexCount <= MAP_CHARACTER_CHUNK_VERTEX_LIMIT) return [chunk];

  const positions = Buffer.from(positionsBase64, 'base64');
  if (positions.byteLength !== vertexCount * 3 * Float32Array.BYTES_PER_ELEMENT) return [chunk];
  const uvs = typeof chunk.uvsBase64 === 'string' ? Buffer.from(chunk.uvsBase64, 'base64') : null;
  const normals = typeof chunk.normalsBase64 === 'string' ? Buffer.from(chunk.normalsBase64, 'base64') : null;
  if (uvs && uvs.byteLength !== vertexCount * 2 * Float32Array.BYTES_PER_ELEMENT) return [chunk];
  if (normals && normals.byteLength !== vertexCount * 3 * Float32Array.BYTES_PER_ELEMENT) return [chunk];

  const makeChunk = (
    vertexIndices: readonly number[],
    localIndices?: readonly number[],
    includeTextureMetadata = true,
  ): Record<string, unknown> => {
    const positionValues: number[] = [];
    const uvValues: number[] = [];
    const normalValues: number[] = [];
    for (const sourceIndex of vertexIndices) {
      const positionOffset = sourceIndex * 3 * Float32Array.BYTES_PER_ELEMENT;
      positionValues.push(
        positions.readFloatLE(positionOffset),
        positions.readFloatLE(positionOffset + Float32Array.BYTES_PER_ELEMENT),
        positions.readFloatLE(positionOffset + 2 * Float32Array.BYTES_PER_ELEMENT)
      );
      if (uvs) {
        const uvOffset = sourceIndex * 2 * Float32Array.BYTES_PER_ELEMENT;
        uvValues.push(uvs.readFloatLE(uvOffset), uvs.readFloatLE(uvOffset + Float32Array.BYTES_PER_ELEMENT));
      }
      if (normals) {
        const normalOffset = sourceIndex * 3 * Float32Array.BYTES_PER_ELEMENT;
        normalValues.push(
          normals.readFloatLE(normalOffset),
          normals.readFloatLE(normalOffset + Float32Array.BYTES_PER_ELEMENT),
          normals.readFloatLE(normalOffset + 2 * Float32Array.BYTES_PER_ELEMENT)
        );
      }
    }
    const elementBytes: 2 | 4 = vertexIndices.length <= 0xffff ? 2 : 4;
    const result: Record<string, unknown> = {
      ...chunk,
      positionsBase64: encodeFloat32Values(positionValues),
      vertexCount: vertexIndices.length
    };
    if (localIndices) {
      result.indicesBase64 = encodeIndices(localIndices, elementBytes);
      result.indexElementBytes = elementBytes;
    } else {
      delete result.indicesBase64;
      delete result.indexElementBytes;
    }
    if (uvs) result.uvsBase64 = encodeFloat32Values(uvValues);
    if (normals) result.normalsBase64 = encodeFloat32Values(normalValues);
    if (!includeTextureMetadata) {
      // A material preview token is shared by all split chunks. Repeating the
      // PNG data URI on every chunk needlessly inflates the IPC response and
      // can push a large character back over the wire-size limit.
      delete result.texturePreviewToken;
      delete result.textureColorSpace;
    }
    return result;
  };

  const indicesBase64 = typeof chunk.indicesBase64 === 'string' ? chunk.indicesBase64 : '';
  const indexElementBytes = chunk.indexElementBytes === 4 ? 4 : chunk.indexElementBytes === 2 ? 2 : 0;
  if (!indicesBase64 || (indexElementBytes !== 2 && indexElementBytes !== 4)) {
    const contiguousLimit = MAP_CHARACTER_CHUNK_VERTEX_LIMIT - (MAP_CHARACTER_CHUNK_VERTEX_LIMIT % 3);
    const split: Array<Record<string, unknown>> = [];
    for (let start = 0; start < vertexCount; start += contiguousLimit) {
      const end = Math.min(vertexCount, start + contiguousLimit);
      split.push(makeChunk(
        Array.from({ length: end - start }, (_, index) => start + index),
        undefined,
        split.length === 0,
      ));
    }
    return split;
  }

  const indexBytes = Buffer.from(indicesBase64, 'base64');
  if (indexBytes.byteLength % indexElementBytes !== 0 || indexBytes.byteLength % (3 * indexElementBytes) !== 0) return [chunk];
  const sourceIndices: number[] = [];
  for (let offset = 0; offset < indexBytes.byteLength; offset += indexElementBytes) {
    sourceIndices.push(indexElementBytes === 4 ? indexBytes.readUInt32LE(offset) : indexBytes.readUInt16LE(offset));
  }
  if (sourceIndices.some((index) => index < 0 || index >= vertexCount)) return [chunk];

  const split: Array<Record<string, unknown>> = [];
  let localVertexIndices: number[] = [];
  let localIndexBySource = new Map<number, number>();
  let localIndices: number[] = [];
  const flush = (): void => {
    if (localVertexIndices.length === 0 || localIndices.length === 0) return;
    split.push(makeChunk(localVertexIndices, localIndices, split.length === 0));
    localVertexIndices = [];
    localIndexBySource = new Map<number, number>();
    localIndices = [];
  };
  for (let offset = 0; offset < sourceIndices.length; offset += 3) {
    const triangle = sourceIndices.slice(offset, offset + 3);
    const additionalVertices = triangle.filter((sourceIndex) => !localIndexBySource.has(sourceIndex)).length;
    if (localIndices.length > 0 && localVertexIndices.length + additionalVertices > MAP_CHARACTER_CHUNK_VERTEX_LIMIT) flush();
    for (const sourceIndex of triangle) {
      let localIndex = localIndexBySource.get(sourceIndex);
      if (localIndex === undefined) {
        localIndex = localVertexIndices.length;
        localIndexBySource.set(sourceIndex, localIndex);
        localVertexIndices.push(sourceIndex);
      }
      localIndices.push(localIndex);
    }
  }
  flush();
  return split.length > 0 ? split : [chunk];
}

function splitCharacterMapChunks(chunks: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return chunks.flatMap(splitCharacterMapChunk);
}

function evictMapCharacterPageSessions(now = Date.now()): void {
  for (const [token, session] of mapCharacterPageSessions) {
    if (now - session.lastAccessMs > MAP_CHARACTER_PAGE_TTL_MS) mapCharacterPageSessions.delete(token);
  }
  while (mapCharacterPageSessions.size > MAP_CHARACTER_PAGE_CAPACITY) {
    const oldest = [...mapCharacterPageSessions.entries()]
      .sort((left, right) => left[1].lastAccessMs - right[1].lastAccessMs)[0];
    if (!oldest) break;
    mapCharacterPageSessions.delete(oldest[0]);
  }
}

function characterPageFailure(sourceUri: string, code: string, message: string) {
  return {
    ok: false,
    sourceUri,
    diagnostics: [{ severity: 'error' as const, code, message, sourceUri }]
  };
}

function serveMapCharacterPage(session: MapCharacterPageSession, cursor: string | null) {
  const now = Date.now();
  evictMapCharacterPageSessions(now);
  session.lastAccessMs = now;
  let start = 0;
  if (cursor) {
    const resolved = session.cursors.get(cursor);
    if (resolved === undefined) {
      return characterPageFailure(session.sourceUri, 'MAP_CHARACTER_CURSOR_INVALID', '角色模型分页游标无效或已过期。');
    }
    start = resolved;
  }
  if (start >= session.chunks.length) {
    return {
      ok: true,
      sourceUri: session.sourceUri,
      data: { sessionToken: session.token, nextCursor: null, complete: true, chunks: [] },
      diagnostics: []
    };
  }

  let end = start;
  let accumulatedEstimated = 128;
  if (session.token) accumulatedEstimated += session.token.length + 20;
  accumulatedEstimated += 52;

  while (end < session.chunks.length) {
    const chunkEstimated = estimateMapStaticWireBytes(session.chunks[end]);
    if (accumulatedEstimated + chunkEstimated >= 7.5 * 1024 * 1024) {
      const hasMore = end + 1 < session.chunks.length;
      const data = {
        sessionToken: session.token,
        nextCursor: hasMore ? 'x'.repeat(36) : null,
        complete: !hasMore,
        chunks: session.chunks.slice(start, end + 1)
      };
      if (Buffer.byteLength(JSON.stringify(data), 'utf8') >= MAP_CHARACTER_WIRE_BUDGET_BYTES) break;
    }
    accumulatedEstimated += chunkEstimated;
    end += 1;
  }
  if (end === start) {
    return characterPageFailure(
      session.sourceUri,
      'MAP_CHARACTER_CHUNK_TOO_LARGE',
      `角色模型 ${session.modelStem} 的单个几何 chunk 仍超过 8 MiB，已失败关闭。`
    );
  }

  const hasMore = end < session.chunks.length;
  const nextCursor = hasMore ? randomUUID() : null;
  if (nextCursor) session.cursors.set(nextCursor, end);
  const diagnostics = cursor ? [] : [
    ...session.diagnostics,
    {
      severity: 'info' as const,
      code: 'MAP_CHARACTER_GEOMETRY_READY',
      message: `地图角色 ${session.modelStem} 已按 ${session.chunks.length} 个静态网格 chunk 分页传输。`,
      sourceUri: session.sourceUri
    }
  ];
  return {
    ok: true,
    sourceUri: session.sourceUri,
    data: {
      sessionToken: session.token,
      nextCursor,
      complete: !hasMore,
      chunks: session.chunks.slice(start, end)
    },
    diagnostics
  };
}
return { characterBundleToMapChunks, estimateMapStaticWireBytes, splitCharacterMapChunks, evictMapCharacterPageSessions,
 characterPageFailure, serveMapCharacterPage, mapCharacterPageSessions };
}
