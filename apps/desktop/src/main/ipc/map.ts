import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import {
  executeMapTransaction,
  ingestBridgeResult,
  loadMapDocument,
  mapExportFromMsbDocument,
  nativeEditSessionFromContext,
  readMsbDocumentViaBridge,
  runBridge,
  type MsbBridgeMutation,
  type WorkspaceIndex,
  type WorkspaceSession,
  type WriteConfirmationPort
} from '@soulforge/core';
import {
  isCharacterPreviewBundle,
  type CharacterPreviewBundle,
  type Diagnostic,
  type FlverPreviewModel,
  type FlverPreviewMesh,
  type IndexedFile,
  type MapEditTransaction
} from '@soulforge/shared';
import { sanitizeRendererValue, type RendererSaveResult } from '../rendererDto.js';
import type { OperationLogUtilityClient } from '../operationLogUtilityClient.js';
// Forensics counters (V1, pure diagnostic — no business logic change).
const _forensicsMapCounters = new Map<string, number>();
function _forensicsMapInc(key: string, delta = 1): void { _forensicsMapCounters.set(key, (_forensicsMapCounters.get(key) ?? 0) + delta); }
export function getMapForensicsCounters(): Record<string, number> { return Object.fromEntries(_forensicsMapCounters); }
import type { TrustedIpcHandle } from './registration.js';
import {
  assembleC0000CompatibilityPreview,
  characterTexturePackagePaths
} from './action.js';

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

const MAP_CHARACTER_WIRE_BUDGET_BYTES = 8 * 1024 * 1024;
const MAP_CHARACTER_CHUNK_VERTEX_LIMIT = 24_000;
const MAP_CHARACTER_PAGE_TTL_MS = 10 * 60_000;
const MAP_CHARACTER_PAGE_CAPACITY = 32;

interface MapCharacterPageSession {
  token: string;
  sourceUri: string;
  modelPath: string;
  modelStem: string;
  chunks: Array<Record<string, unknown>>;
  diagnostics: Diagnostic[];
  cursors: Map<string, number>;
  lastAccessMs: number;
}

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
  while (end < session.chunks.length) {
    const hasMore = end + 1 < session.chunks.length;
    const data = {
      sessionToken: session.token,
      nextCursor: hasMore ? 'x'.repeat(36) : null,
      complete: !hasMore,
      chunks: session.chunks.slice(start, end + 1)
    };
    if (Buffer.byteLength(JSON.stringify(data), 'utf8') >= MAP_CHARACTER_WIRE_BUDGET_BYTES) break;
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

function logicalMapModelName(raw: string): string {
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? raw;
  return base
    .replace(/\.(?:flver|chrbnd|objbnd|mapbnd)(?:\.dcx)?$/i, '')
    .replace(/\.dcx$/i, '');
}

function resolveMapModelFile(
  indexedFiles: readonly IndexedFile[],
  activeSession: WorkspaceSession | null,
  safeExists: (path: string) => boolean,
  mapRelativePath: string,
  modelName: string,
  sibPath?: string
): { absolutePath: string; relativePath: string; kind: 'flver' | 'chrbnd' } | null {
  const names = [...new Set(
    [modelName, sibPath ?? '']
      .map((value) => logicalMapModelName(value))
      .filter((value) => value.length > 0)
  )];
  const mapStem = basename(mapRelativePath).replace(/\.msb(\.dcx)?$/i, '');
  const mapId = /^m\d{2}_\d{2}_\d{2}_\d{2}$/i.test(mapStem) ? mapStem : null;
  const candidates: Array<{ rel: string; kind: 'flver' | 'chrbnd' }> = [];
  for (const name of names) {
    if (mapId) {
      // m000010 → m10_00_00_00_000010：MSB 侧短名需展开为 mapbnd 侧长名
      const mShort = /^m(\d{6})$/i.exec(name)?.[1];
      if (mShort) {
        const longName = `${mapId}_${mShort}`;
        candidates.push({ rel: `map/${mapId}/${longName}.mapbnd.dcx`, kind: 'flver' });
        // mapbnd 容器内的 FLVER 名就是长名本身（条目名为 .../long.flver），
        // 但单文件 flver 路径也试一下（部分 map 可能有散文件）
        candidates.push({ rel: `map/${mapId}/${longName}.flver.dcx`, kind: 'flver' });
        candidates.push({ rel: `map/${mapId}/${longName}.flver`, kind: 'flver' });
      }
      candidates.push({ rel: `map/${mapId}/${name}.flver.dcx`, kind: 'flver' });
      candidates.push({ rel: `map/${mapId}/${name}.flver`, kind: 'flver' });
    }
    candidates.push({ rel: `map/${name}.flver.dcx`, kind: 'flver' });
    if (/^c\d/i.test(name)) candidates.push({ rel: `chr/${name}.chrbnd.dcx`, kind: 'chrbnd' });
    // objbnd 是静态 FLVER 容器，不是角色 chrbnd。误标成 chrbnd 会把
    // 原生对象送进骨骼预览分支，最终只能留下 MSB 的方块代理。
    if (/^o\d/i.test(name)) candidates.push({ rel: `obj/${name}.objbnd.dcx`, kind: 'flver' });
  }
  const normalize = (value: string): string => value.replace(/\\/g, '/').toLowerCase();
  for (const candidate of candidates) {
    const indexed = indexedFiles.find((item) => {
      const rel = normalize(item.relativePath);
      return rel === normalize(candidate.rel) || rel.endsWith(`/${normalize(candidate.rel)}`);
    });
    if (indexed) {
      return { absolutePath: indexed.absolutePath, relativePath: indexed.relativePath, kind: candidate.kind };
    }
  }
  const overlay = activeSession?.layers.overlayRoot?.trim();
  const base = activeSession?.layers.baseRoot?.trim();
  for (const root of [overlay, base]) {
    if (!root) continue;
    for (const candidate of candidates) {
      const absolutePath = join(root, candidate.rel);
      if (safeExists(absolutePath)) {
        return { absolutePath, relativePath: candidate.rel, kind: candidate.kind };
      }
    }
  }
  return null;
}

export interface MapIpcDeps {
  handle: TrustedIpcHandle;
  /** 活动索引文件表：事务成功后按条目原地替换（与拆分前语义一致）。 */
  readonly indexedFiles: IndexedFile[];
  readonly activeSession: WorkspaceSession | null;
  readonly activeIndex: WorkspaceIndex | null;
  readonly activeWorkspaceSessionId: string | null;
  safeExists(path: string): boolean;
  asBasicDiagnostics(
    items: Array<{ severity: string; code: string; message: string; sourceUri?: string }>
  ): Array<{ severity: 'error' | 'warning' | 'info'; code: string; message: string; sourceUri?: string }>;
  durableStoragePaths(workspaceId: string): {
    root: string;
    backupBaseDir: string;
    recoveryDir: string;
    stagingRoot: string;
  };
  verifiedReadRoots(
    session: WorkspaceSession | null,
    fallback: string
  ): Promise<{ allowedRoots: string[]; diagnostics: Diagnostic[] }>;
  rejectNonSekiroNativeWrite(sourceUri: string, file?: IndexedFile): RendererSaveResult | null;
  ensureActiveOperationLog(session: WorkspaceSession): Promise<OperationLogUtilityClient>;
  electronConfirmationPort(event: IpcMainInvokeEvent): WriteConfirmationPort;
  refreshActiveIndexAfterNativeWrite(
    changedSources?: readonly string[],
    carrier?: { knowledgeRefresh?: unknown }
  ): Promise<unknown>;
}

export function registerMapIpcHandlers(deps: MapIpcDeps): void {
  deps.handle('resource.readMsbDocument', async (_event, sourceUri: string) => {
    const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return {
        ok: false,
        diagnostics: [{
          severity: 'error' as const,
          code: 'RESOURCE_NOT_INDEXED',
          message: '资源未索引，无法读取 MSB。',
          sourceUri
        }]
      };
    }
    const roots = await deps.verifiedReadRoots(deps.activeSession, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
    const result = await readMsbDocumentViaBridge({
      sourcePath: file.absolutePath,
      allowedRoots: roots.allowedRoots,
      // 问题 4-A / 6-B：不再传 maxParts/maxRegions/maxModels/maxEvents —— 走
      // msbBridgeRead 默认完整表（调用方不传就是无窗口），索引与完整图都不截断
      // （缺口4：显示上限渗进索引=假装完整）。
      // P5 裁定：真实游戏 .msb.dcx 是 KRAK 压缩，缺 Oodle 运行时读不出实体表
      // （表现为 3D 代理场景 0 节点 / 0 实体）。
      ...(deps.activeSession?.layers.baseRoot
        ? { oodleRuntimeRoot: deps.activeSession.layers.baseRoot }
        : {})
    });
    // 问题 6-B：生产 analyze 的 export-map 未实现，桌面打开 MSB 时用
    // read-msb-document 的 parts[] 喂 MapExport（最小 hunk，不实现 C# export-map）。
    if (result.ok && result.data && deps.activeIndex) {
      const mapId = basename(file.relativePath).replace(/\.msb(\.dcx)?$/i, '');
      if (mapId) {
        ingestBridgeResult(deps.activeIndex, {
          sourceUri,
          sourcePath: file.relativePath,
          game: file.game,
          resourceKind: 'map',
          parseStatus: 'parsed',
          diagnostics: deps.asBasicDiagnostics(result.diagnostics),
          data: mapExportFromMsbDocument({
            mapId,
            sourceUri,
            parts: result.data.parts,
            regions: result.data.regions
          })
        });
      }
    }
    return sanitizeRendererValue({
      ok: result.ok,
      sourceUri,
      relativePath: file.relativePath,
      data: result.data
        ? {
            sourceHash: result.data.sourceHash,
            version: result.data.version,
            modelCount: result.data.modelCount,
            partCount: result.data.partCount,
            regionCount: result.data.regionCount,
            eventCount: result.data.eventCount,
            routeCount: result.data.routeCount,
            models: result.data.models,
            parts: result.data.parts,
            regions: result.data.regions,
            events: result.data.events,
            routes: result.data.routes,
            authority: result.data.authority,
            entityEdit: result.data.entityEdit
          }
        : null,
      diagnostics: result.diagnostics
    });
  });

  deps.handle(
    'resource.readMapPartFlverPreview',
    async (
      _event,
      mapSourceUri: string,
      modelName: string,
      sibPath?: string
    ): Promise<{
      ok: boolean;
      data?: Record<string, unknown>;
      diagnostics: Array<{ severity: string; code: string; message: string; sourceUri?: string }>;
    }> => {
      const file = deps.indexedFiles.find((item) => item.sourceUri === mapSourceUri);
      if (!file) {
        return {
          ok: false,
          diagnostics: [{
            severity: 'error',
            code: 'RESOURCE_NOT_INDEXED',
            message: '资源未索引，无法定位地图模型。',
            sourceUri: mapSourceUri
          }]
        };
      }
      const resolved = resolveMapModelFile(deps.indexedFiles, deps.activeSession, deps.safeExists, file.relativePath, modelName, sibPath);
      const baseRoot = deps.activeSession?.layers.baseRoot?.trim();
      if (!resolved) {
        return {
          ok: false,
          diagnostics: [{
            severity: 'error',
            code: 'MAP_FLVER_NOT_FOUND',
            message: baseRoot
              ? `没有找到该 part 的模型（${logicalMapModelName(modelName)}）。`
              : `没有找到该 part 的模型（${logicalMapModelName(modelName)}）。overlay 没有这份 FLVER，到「开始」页挂原版后再试。`
          }]
        };
      }
      const roots = await deps.verifiedReadRoots(deps.activeSession, dirname(resolved.absolutePath));
      if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
      const command = resolved.kind === 'chrbnd' ? 'read-chrbnd-flver-preview' : 'read-flver-mesh';
      const result = await runBridge<Record<string, unknown>>({
        command,
        filePath: resolved.absolutePath,
        allowedRoots: roots.allowedRoots,
        timeoutMs: 120_000,
        ...(baseRoot ? { oodleRuntimeRoot: baseRoot } : {}),
        // 问题4-A：预览不再留 1 万顶点门禁——拉到能装下地图构件的量
        // （对照 flverToGlb 已在用 1_000_000 / 3_000_000）。meshIndex=0 返回
        // meshCount，调用方按需循环读齐全部网格。
        commandOptions: { meshIndex: 0, maxVertices: 1_000_000, maxIndices: 3_000_000 }
      });
      return {
        ok: result.parseStatus !== 'failed',
        ...(result.data !== undefined ? { data: result.data } : {}),
        diagnostics: result.diagnostics
      };
    }
  );

  /**
   * S23：地图 viewport 读 part 模型——按 modelName 在 mapbnd 容器里取 FLVER 网格。
   *
   * 候选顺序：overlay `map/<mapId>/<mapId>_*.mapbnd.dcx` → 原版同相对路径
   * （KRAK 由 Bridge 用 oodleRuntimeRoot 解）。全部失败给可行动诊断：
   * 「没有找到该 part 的模型」/「未挂原版且 overlay 无 mapbnd → 去开始页挂原版」。
   */
  deps.handle(
    'resource.readMapPartMesh',
    async (_event, msbSourceUri: string, modelName: string): Promise<{
      ok: boolean;
      sourceUri?: string;
      data?: Record<string, unknown>;
      diagnostics: Array<{ severity: string; code: string; message: string; sourceUri?: string }>;
    }> => {
      _forensicsMapInc('map:main:readMapPartMesh:count');
      const file = deps.indexedFiles.find((item) => item.sourceUri === msbSourceUri);
      if (!file || !deps.activeSession) {
        return {
          ok: false,
          diagnostics: [{ severity: 'error' as const, code: 'MAP_PART_MSB_NOT_INDEXED', message: 'MSB 资源未索引，无法定位地图模型目录。', sourceUri: msbSourceUri }]
        };
      }
      const baseName = basename(file.relativePath);
      const mapId = baseName.replace(/\.msb(\.dcx)?$/i, '');
      if (!mapId) {
        return {
          ok: false,
          diagnostics: [{ severity: 'error' as const, code: 'MAP_PART_MAP_ID_UNKNOWN', message: '无法从 MSB 文件名推断地图 id。', sourceUri: msbSourceUri }]
        };
      }
      const overlayParent = dirname(deps.activeSession.layers.overlayRoot);
      const effectiveBase = deps.activeSession.layers.baseRoot
        ?? (existsSync(join(overlayParent, 'sekiro.exe')) || existsSync(join(overlayParent, 'map')) ? overlayParent : null);
      const overlayDir = join(deps.activeSession.layers.overlayRoot, 'map', mapId);
      const baseDir = effectiveBase ? join(effectiveBase, 'map', mapId) : null;
      const candidateDirs = [
        ...(deps.safeExists(overlayDir) ? [{ dir: overlayDir, fromBase: false }] : []),
        ...(baseDir && deps.safeExists(baseDir) ? [{ dir: baseDir, fromBase: true }] : [])
      ];
      if (candidateDirs.length === 0) {
        const baseHint = effectiveBase
          ? `map/${mapId}/ 目录下没有模型文件。`
          : `overlay 的 map/${mapId}/ 下没有模型文件，且尚未挂载原版目录——到「开始」页选择含 sekiro.exe 的原版目录后可尝试读取原版模型。`;
        return {
          ok: false,
          diagnostics: [{ severity: 'error' as const, code: 'MAP_PART_NO_MODEL_DIR', message: `没有找到 ${modelName} 的模型（mapbnd）：${baseHint}`, sourceUri: msbSourceUri }]
        };
      }
      const roots = await deps.verifiedReadRoots(deps.activeSession, dirname(file.absolutePath));
      if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
      if (effectiveBase && !roots.allowedRoots.includes(effectiveBase)) roots.allowedRoots.push(effectiveBase);

      /**
       * 问题4-A：每个 map part 把该 FLVER 的**全部网格**读齐。
       * Bridge 一次一网格（返回 meshCount），main 循环 meshIndex=0..meshCount-1，
       * 再按顶点偏移把各网格合并成单一静态网格返回（地图 part 无骨骼动画、
       * 各网格共享同一模型变换，合并后视觉与分别画一致）。索引按项目渲染管线
       * 的 Uint16 假设偏移拼接；总顶点超 65534（Uint16 索引上限）或索引非 16 位
       * 时退回 mesh0 单网格（那种超大 part 地形多为单网格，属边缘而不是碎片）。
       */
      const readAllPartMeshes = async (
        mapbndPath: string,
        fromBase: boolean
      ): Promise<Record<string, unknown> | null> => {
        const runForMesh = async (meshIndex: number): Promise<{ ok: boolean; data?: Record<string, unknown> }> => {
          const raw = await runBridge<Record<string, unknown>>({
            command: 'read-map-part-flver-preview',
            filePath: mapbndPath,
            allowedRoots: roots.allowedRoots,
            timeoutMs: 120_000,
            ...(fromBase && effectiveBase
              ? { oodleRuntimeRoot: effectiveBase }
              : {}),
            commandOptions: { modelName, meshIndex, maxVertices: 1_000_000, maxIndices: 3_000_000 }
          });
          return { ok: raw.parseStatus !== 'failed', ...(raw.data ? { data: raw.data } : {}) };
        };
        const first = await runForMesh(0);
        if (!first.ok || !first.data) return null;
        const meshCount = Number(first.data.meshCount ?? 1);
        if (meshCount <= 1) return first.data;
        const meshes: Array<Record<string, unknown>> = [first.data];
        for (let meshIndex = 1; meshIndex < meshCount; meshIndex += 1) {
          const next = await runForMesh(meshIndex);
          if (next.ok && next.data) meshes.push(next.data);
        }
        try {
          let totalVertexCount = 0;
          const positionBuffers: Buffer[] = [];
          const uvBuffers: Buffer[] = [];
          const normalBuffers: Buffer[] = [];
          const indexChunks: Uint16Array[] = [];
          for (const mesh of meshes) {
            const vertexCount = Number(mesh.vertexCount ?? 0);
            const pos = typeof mesh.positionsBase64 === 'string' ? Buffer.from(mesh.positionsBase64, 'base64') : null;
            if (!pos || vertexCount <= 0) continue;
            // 索引按 Uint16 偏移拼接（项目渲染管线的既有假设）。
            const idx = typeof mesh.indicesBase64 === 'string' ? Buffer.from(mesh.indicesBase64, 'base64') : null;
            if (idx) {
              if (idx.length % 2 !== 0) return null; // 非 16/32 位的压缩索引不支持
              // 总顶点超 Uint16 索引上限时退回 mesh0（超大 part 地形多为单网格）。
              if (totalVertexCount + vertexCount > 65535) return null;
              const u16 = new Uint16Array(idx.buffer, idx.byteOffset, idx.length / 2);
              const shifted = new Uint16Array(u16.length);
              for (let i = 0; i < u16.length; i += 1) shifted[i] = u16[i]! + totalVertexCount;
              indexChunks.push(shifted);
            }
            positionBuffers.push(pos);
            if (typeof mesh.uvsBase64 === 'string') uvBuffers.push(Buffer.from(mesh.uvsBase64, 'base64'));
            if (typeof mesh.normalsBase64 === 'string') normalBuffers.push(Buffer.from(mesh.normalsBase64, 'base64'));
            totalVertexCount += vertexCount;
          }
          if (positionBuffers.length === 0) return null;
          const mergedPositions = Buffer.concat(positionBuffers).toString('base64');
          const mergedUvs = uvBuffers.length > 0 ? Buffer.concat(uvBuffers).toString('base64') : undefined;
          const mergedNormals = normalBuffers.length > 0 ? Buffer.concat(normalBuffers).toString('base64') : undefined;
          const indices = indexChunks.length > 0 ? indexChunks.flatMap((chunk) => Array.from(chunk)) : undefined;
          const indicesBase64 = indices && indices.length > 0
            ? Buffer.from(new Uint16Array(indices).buffer).toString('base64')
            : undefined;
          return {
            vertexCount: totalVertexCount,
            ...(mergedPositions ? { positionsBase64: mergedPositions } : {}),
            ...(indicesBase64 ? { indicesBase64 } : {}),
            ...(mergedUvs ? { uvsBase64: mergedUvs } : {}),
            ...(mergedNormals ? { normalsBase64: mergedNormals } : {}),
            meshCount: 1
          };
        } catch {
          return null; // 合并失败退 mesh0（见上注释）
        }
      };

      /**
       * m10_00_00_00 这类地图的地形 FLVER 用短名（MSB 侧 m000010），而 mapbnd 侧
       * 条目与文件都用长名（m10_00_00_00_000010.flver / ...mapbnd.dcx）。直接用短名
       * 在 mapbnd 容器里 EndsWith 匹配永远 miss，导致 100% 方块。
       *
       * 映射规则（实测 m10 vanilla：844 个模型里 499 个 type0 m*，484 个后缀与
       * mapbnd 文件尾段一一对应）：m + 6位 → mapId + '_' + 6位（如 m000010 →
       * m10_00_00_00_000010）。短名先按精确文件名试 probes，命中即直接读该容器，
       * 避免顺序扫描 549 个 mapbnd 的开销；失败再回退全量扫描（Bridge 侧已支持
       * 短名后缀包含匹配作为第二道兜底）。
       */
      const shortSuffix = /^m(\d{6})$/i.exec(modelName)?.[1] ?? null;
      const longProbeNames = shortSuffix ? [`${mapId}_${shortSuffix}`] : [];
      const probeFiles = new Set<string>();
      for (const probeName of longProbeNames) {
        for (const { dir, fromBase } of candidateDirs) {
          const candidate = join(dir, `${probeName}.mapbnd.dcx`);
          if (deps.safeExists(candidate)) probeFiles.add(`${fromBase ? 'base:' : 'overlay:'}${candidate}`);
        }
      }
      // 精确文件命中优先，保证 m000010 这类高频地形一击命中。
      for (const key of probeFiles) {
        const fromBase = key.startsWith('base:');
        const mapbndPath = key.slice(key.indexOf(':') + 1);
        const first = await runBridge<Record<string, unknown>>({
          command: 'read-map-part-flver-preview',
          filePath: mapbndPath,
          allowedRoots: roots.allowedRoots,
          timeoutMs: 120_000,
          ...(fromBase && effectiveBase
            ? { oodleRuntimeRoot: effectiveBase }
            : {}),
          commandOptions: { modelName, maxVertices: 1_000_000, maxIndices: 3_000_000 }
        });
        if (first.parseStatus === 'failed' || !first.data) continue;
        const data = await readAllPartMeshes(mapbndPath, fromBase);
        return { ok: true, sourceUri: msbSourceUri, data: data ?? first.data, diagnostics: first.diagnostics };
      }
      // 轻短期回落：若短名的 longProbe 精确文件不在（如 15 个缺 mapbnd 的模型或
      // 非地形类型），再用 mapId 前缀在 mapbnd 内模糊匹配首个 FLVER，
      // 保证至少一种 terrain 真模型可见以证伪“全方块”（task 2）。
      const tryPrefixFallbackForTerrain = async (): Promise<Record<string, unknown> | null> => {
        if (!shortSuffix) return null;
        const prefix = `${mapId}_`;
        for (const { dir, fromBase } of candidateDirs) {
          let mapbnds: string[];
          try {
            mapbnds = readdirSync(dir)
              .filter((name) => /\.mapbnd\.dcx$/i.test(name) && name.startsWith(prefix))
              .sort()
              .map((name) => join(dir, name));
          } catch { mapbnds = []; }
          if (mapbnds.length === 0) continue;
          const fallbackPath = mapbnds[0]!;
          const fallback = await runBridge<Record<string, unknown>>({
            command: 'read-map-part-flver-preview',
            filePath: fallbackPath,
            allowedRoots: roots.allowedRoots,
            timeoutMs: 120_000,
            ...(fromBase && effectiveBase ? { oodleRuntimeRoot: effectiveBase } : {}),
            commandOptions: { modelName: basename(fallbackPath).replace(/\.mapbnd\.dcx$/i, ''), maxVertices: 1_000_000, maxIndices: 3_000_000 }
          });
          if (fallback.parseStatus !== 'failed' && fallback.data) return fallback.data;
        }
        return null;
      };

      for (const { dir, fromBase } of candidateDirs) {
        let mapbnds: string[];
        try {
          mapbnds = readdirSync(dir)
            // mapbnd 命名 `<mapId>_<6位编号>.mapbnd.dcx`，mapId 本身含下划线，
            // 只按后缀过滤。
            .filter((name) => /\.mapbnd\.dcx$/i.test(name))
            .sort()
            .map((name) => join(dir, name));
        } catch {
          mapbnds = [];
        }
        for (const mapbndPath of mapbnds) {
          // 已被探针命中过的 skip（避免重复 Bridge）
          const overlayKey = `overlay:${mapbndPath}`;
          const baseKey = `base:${mapbndPath}`;
          if (probeFiles.has(overlayKey) || probeFiles.has(baseKey)) continue;
          const first = await runBridge<Record<string, unknown>>({
            command: 'read-map-part-flver-preview',
            filePath: mapbndPath,
            allowedRoots: roots.allowedRoots,
            timeoutMs: 120_000,
            ...(fromBase && effectiveBase
              ? { oodleRuntimeRoot: effectiveBase }
              : {}),
            commandOptions: { modelName, maxVertices: 1_000_000, maxIndices: 3_000_000 }
          });
          if (first.parseStatus === 'failed' || !first.data) continue;
          const data = await readAllPartMeshes(mapbndPath, fromBase);
          return {
            ok: true,
            sourceUri: msbSourceUri,
            data: data ?? first.data,
            diagnostics: first.diagnostics
          };
        }
      }
      // 仍未命中且是地形短名：用前缀回落任意 FLVER 兜底，避免 100% 方块。
      if (shortSuffix) {
        const fallbackData = await tryPrefixFallbackForTerrain();
        if (fallbackData) return { ok: true, sourceUri: msbSourceUri, data: fallbackData, diagnostics: [] };
      }
      return {
        ok: false,
        diagnostics: [{
          severity: 'error' as const,
          code: 'MAP_PART_MODEL_NOT_FOUND',
          message: `没有找到 ${modelName} 的模型（map/${mapId}/ 下的 mapbnd 容器）；该 part 用线框占位显示。`,
          sourceUri: msbSourceUri
        }]
      };
    }
  );

  // 24.10 D-2: streaming static geometry (chunked, cursor opaque with daemon/owner/sourceHash/resourceCacheKey, wire bytes budget <8MiB)
  // Deprecated: resource.readMapPartMesh is legacy non-streaming; new path is resource.readMapStaticGeometry
  deps.handle(
    'resource.readMapStaticGeometry',
    async (
      _event,
      msbSourceUri: string,
      modelName: string,
      cursor?: string | null,
      sessionToken?: string | null
    ) => {
      _forensicsMapInc('map:main:readMapStaticGeometry:count');
      const file = deps.indexedFiles.find((item) => item.sourceUri === msbSourceUri);
      if (!file || !deps.activeSession) return { ok: false, diagnostics: [{ severity: 'error', code: 'MAP_PART_MSB_NOT_INDEXED', message: 'MSB not indexed', sourceUri: msbSourceUri }] };
      const baseName = basename(file.relativePath);
      const mapId = baseName.replace(/\.msb(\.dcx)?$/i, '');
      const overlayParent = dirname(deps.activeSession.layers.overlayRoot);
      const effectiveBase = deps.activeSession.layers.baseRoot ?? (existsSync(join(overlayParent, 'sekiro.exe')) || existsSync(join(overlayParent, 'map')) ? overlayParent : null);
      const overlayDir = join(deps.activeSession.layers.overlayRoot, 'map', mapId);
      const baseDir = effectiveBase ? join(effectiveBase, 'map', mapId) : null;
      const candidateDirs = [...(deps.safeExists(overlayDir) ? [{ dir: overlayDir, fromBase: false }] : []), ...(baseDir && deps.safeExists(baseDir) ? [{ dir: baseDir, fromBase: true }] : [])];
      const roots = await deps.verifiedReadRoots(deps.activeSession, dirname(file.absolutePath));
      if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
      if (effectiveBase && !roots.allowedRoots.includes(effectiveBase)) roots.allowedRoots.push(effectiveBase);

      const readCharacterPath = async (
        modelPath: string,
        requestedCursor: string | null = cursor ?? null,
        requestedSessionToken: string | null = sessionToken ?? null
      ) => {
        evictMapCharacterPageSessions();
        if (requestedSessionToken) {
          const session = mapCharacterPageSessions.get(requestedSessionToken);
          if (!session
            || session.sourceUri !== msbSourceUri
            || session.modelPath.toLowerCase() !== modelPath.toLowerCase()) {
            return characterPageFailure(
              msbSourceUri,
              'MAP_CHARACTER_SESSION_EXPIRED',
              '角色模型分页会话已过期、来源已变化或不属于当前地图。请刷新模型/纹理后重试。'
            );
          }
          return serveMapCharacterPage(session, requestedCursor);
        }
        if (requestedCursor) {
          return characterPageFailure(
            msbSourceUri,
            'MAP_CHARACTER_CURSOR_INVALID',
            '角色模型分页缺少所属会话，已失败关闭。请刷新模型/纹理后重试。'
          );
        }

        const result = await runBridge<unknown>({
          command: 'read-chrbnd-flver-preview',
          filePath: modelPath,
          allowedRoots: roots.allowedRoots,
          timeoutMs: 120_000,
          ...(effectiveBase ? { oodleRuntimeRoot: effectiveBase } : {}),
          commandOptions: {
            maxVertices: 1_000_000,
            maxIndices: 3_000_000,
            texturePackagePaths: characterTexturePackagePaths(modelPath, [
              join(deps.activeSession!.layers.overlayRoot, 'parts'),
              ...(effectiveBase ? [join(effectiveBase, 'parts')] : [])
            ])
          }
        });
        if (result.parseStatus === 'failed' || !isCharacterPreviewBundle(result.data)) {
          return {
            ok: false,
            sourceUri: msbSourceUri,
            diagnostics: result.diagnostics
          };
        }

        let bundle = result.data;
        const modelStem = basename(modelPath).replace(/\.chrbnd(?:\.dcx)?$/i, '').toLowerCase();
        let compatibilityDiagnostics: Diagnostic[] = [];
        if (modelStem === 'c0000' && bundle.meshCount === 0 && bundle.boneCount > 0) {
          const compatibility = await assembleC0000CompatibilityPreview({
            leaderBundle: bundle,
            overlayPartsDirectory: join(deps.activeSession!.layers.overlayRoot, 'parts'),
            basePartsDirectory: effectiveBase ? join(effectiveBase, 'parts') : null,
            allowedRoots: roots.allowedRoots,
            oodleRuntimeRoot: effectiveBase
          });
          compatibilityDiagnostics = compatibility.diagnostics;
          if (compatibility.bundle) bundle = compatibility.bundle;
        }

        let chunks: Array<Record<string, unknown>>;
        try {
          chunks = splitCharacterMapChunks(characterBundleToMapChunks(bundle));
        } catch (error) {
          return {
            ok: false,
            sourceUri: msbSourceUri,
            diagnostics: [
              ...result.diagnostics,
              ...compatibilityDiagnostics,
              {
                severity: 'error' as const,
                code: 'MAP_CHARACTER_GEOMETRY_INVALID',
                message: error instanceof Error ? error.message : String(error),
                sourceUri: msbSourceUri
              }
            ]
          };
        }
        if (chunks.length === 0) {
          return {
            ok: false,
            sourceUri: msbSourceUri,
            diagnostics: [
              ...result.diagnostics,
              ...compatibilityDiagnostics,
              {
                severity: 'warning' as const,
                code: 'MAP_CHARACTER_GEOMETRY_UNAVAILABLE',
                message: `角色模型 ${modelStem} 只有骨骼或没有可显示网格，地图保留线框占位。`,
                sourceUri: msbSourceUri
              }
            ]
          };
        }
        const pageSession: MapCharacterPageSession = {
          token: randomUUID(),
          sourceUri: msbSourceUri,
          modelPath,
          modelStem,
          chunks,
          diagnostics: [...result.diagnostics, ...compatibilityDiagnostics],
          cursors: new Map<string, number>(),
          lastAccessMs: Date.now()
        };
        mapCharacterPageSessions.set(pageSession.token, pageSession);
        evictMapCharacterPageSessions();
        return serveMapCharacterPage(pageSession, null);
      };

      const readStaticPath = async (modelPath: string, modelKind: 'flver' | 'chrbnd' = 'flver') => {
        if (modelKind === 'chrbnd') return readCharacterPath(modelPath);
        const result = await runBridge({
          command: 'read-map-static-geometry',
          filePath: modelPath,
          allowedRoots: roots.allowedRoots,
          timeoutMs: 120_000,
          // MAP 静态几何是只读、按模型去重的批量链路；Bridge native session
          // 已按模型隔离，允许受控并发 8，避免数百个低频模型长期停在占位。
          maxConcurrency: 8,
          ...(deps.activeWorkspaceSessionId
            ? { workspaceSessionId: deps.activeWorkspaceSessionId }
            : {}),
          ...(effectiveBase ? { oodleRuntimeRoot: effectiveBase } : {}),
          commandOptions: {
            modelName,
            ...(mapId ? { mapGroupName: mapId.slice(0, 3) } : {}),
            sessionToken: sessionToken ?? undefined,
            cursor: cursor ?? undefined,
            ownerLeaseId: deps.activeWorkspaceSessionId ?? '',
            resourceCacheKey: JSON.stringify({ modelName, mapId })
          }
        });
        if (result.parseStatus === 'failed' || !result.data) return null;
        const wireBytes = Buffer.byteLength(JSON.stringify(result.data), 'utf8');
        if (wireBytes >= 8 * 1024 * 1024) {
          return { ok: false, diagnostics: [{ severity: 'error', code: 'MAP_STATIC_WIRE_BUDGET_EXCEEDED', message: 'wire bytes exceed 8 MiB', sourceUri: msbSourceUri }] };
        }
        return { ok: true, sourceUri: msbSourceUri, data: result.data, diagnostics: result.diagnostics };
      };

      // The legacy route already knows the exact short-name -> mapbnd/chrbnd/objbnd
      // resolution. Reuse it before directory scanning so each page opens one
      // container instead of probing every mapbnd again (O(models * files * pages)).
      const directModel = resolveMapModelFile(
        deps.indexedFiles,
        deps.activeSession,
        deps.safeExists,
        file.relativePath,
        modelName
      );
      if (directModel) {
        const directResult = await readStaticPath(directModel.absolutePath, directModel.kind);
        if (directResult) return directResult;
      }

      const triedPaths = new Set(directModel ? [directModel.absolutePath.toLowerCase()] : []);
      for (const { dir } of candidateDirs) {
        let mapbnds: string[] = [];
        try { mapbnds = readdirSync(dir).filter((name) => /\.mapbnd\.dcx$/i.test(name)).map((name) => join(dir, name)); } catch {}
        for (const mapbndPath of mapbnds) {
          const key = mapbndPath.toLowerCase();
          if (triedPaths.has(key)) continue;
          triedPaths.add(key);
          const result = await readStaticPath(mapbndPath);
          if (result) return result;
        }
      }
      return { ok: false, diagnostics: [{ severity: 'error', code: 'MAP_PART_MODEL_NOT_FOUND', message: 'not found ' + modelName, sourceUri: msbSourceUri }] };
    }
  );

  deps.handle(
    'resource.applyMsbMutation',
    async (
      event,
      sourceUri: string,
      expectedHash: string,
      mutation: MsbBridgeMutation
    ): Promise<RendererSaveResult> => {
      const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !deps.activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'MSB_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能写入 MSB。',
            sourceUri
          }]
        };
      }
      const gameBlocked = deps.rejectNonSekiroNativeWrite(sourceUri, file);
      if (gameBlocked) return gameBlocked;
      if ('partName' in mutation || !Number.isSafeInteger(mutation.nativeOffset) || mutation.nativeOffset < 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'MSB_NATIVE_OFFSET_REQUIRED',
            message: 'MSB legacy name-only mutation 已拒绝；必须携带 family + nativeOffset。',
            sourceUri
          }]
        };
      }
      const storage = deps.durableStoragePaths(deps.activeSession.meta.workspaceId);
      const operationLog = await deps.ensureActiveOperationLog(deps.activeSession);
      const nativeEdit = nativeEditSessionFromContext({
        session: deps.activeSession,
        operationLog,
        backupBaseDir: storage.backupBaseDir,
        recoveryDir: storage.recoveryDir,
        confirmationPort: deps.electronConfirmationPort(event)
      });
      const loaded = await loadMapDocument(nativeEdit, file.absolutePath);
      if (!loaded.ok) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{ severity: 'error', code: loaded.error.code, message: loaded.error.message, sourceUri }]
        };
      }
      const target = `${mutation.family}:${loaded.doc.mapId}:offset-${mutation.nativeOffset.toString(16)}`;
      let operation: MapEditTransaction['operations'][number] | null;
      if (mutation.kind === 'delete_part' || mutation.kind === 'delete_region' || mutation.kind === 'delete_event') {
        operation = { kind: 'delete', target };
      } else if (mutation.kind === 'change_model' || mutation.kind === 'set_part_model') {
        operation = mutation.modelName ? { kind: 'change_model', target, newModelName: mutation.modelName } : null;
      } else if (mutation.kind === 'set_property' || mutation.kind === 'set_entity_id') {
        operation = { kind: 'set_property', target, property: 'entityId', value: mutation.entityId };
      } else if ('posX' in mutation) {
        operation = {
          kind: 'set_transform',
          target,
          ...(mutation.posX !== undefined || mutation.posY !== undefined || mutation.posZ !== undefined
            ? { position: [mutation.posX ?? 0, mutation.posY ?? 0, mutation.posZ ?? 0] as [number, number, number] }
            : {}),
          ...(mutation.rotX !== undefined || mutation.rotY !== undefined || mutation.rotZ !== undefined
            ? { rotation: [mutation.rotX ?? 0, mutation.rotY ?? 0, mutation.rotZ ?? 0] as [number, number, number] }
            : {}),
          ...(mutation.scaleX !== undefined || mutation.scaleY !== undefined || mutation.scaleZ !== undefined
            ? { scale: [mutation.scaleX ?? 1, mutation.scaleY ?? 1, mutation.scaleZ ?? 1] as [number, number, number] }
            : {})
        };
      } else {
        operation = null;
      }
      if (!operation) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{ severity: 'error', code: 'MAP_MODEL_REQUIRED', message: 'change_model 必须携带 modelName。', sourceUri }]
        };
      }
      const transaction: MapEditTransaction = {
        id: `tx-legacy-msb-${Date.now()}`,
        mapId: loaded.doc.mapId,
        baseRevision: expectedHash || loaded.doc.revision,
        description: `Legacy MSB mutation ${mutation.kind}`,
        author: 'human',
        operations: [operation],
        timestamp: Date.now()
      };
      const result = await executeMapTransaction(nativeEdit, file.absolutePath, transaction);
      if (!result.ok) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: result.verification === 'failed' ? 'error' : 'warning',
            code: result.error?.code ?? 'MSB_TRANSACTION_FAILED',
            message: result.error?.message ?? 'MSB 事务失败。',
            sourceUri
          }]
        };
      }
      const response: RendererSaveResult = {
        ok: true,
        changedFiles: result.committed ? [sourceUri] : [],
        diagnostics: []
      };
      if (result.committed) await deps.refreshActiveIndexAfterNativeWrite([sourceUri], response);
      return response;
    }
  );

  deps.handle(
    'resource.executeMapTransaction',
    async (
      event,
      sourceUri: string,
      expectedHash: string,
      transaction: MapEditTransaction
    ): Promise<RendererSaveResult> => {
      const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !deps.activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'MSB_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能写入 MSB。',
            sourceUri
          }]
        };
      }
      const gameBlocked = deps.rejectNonSekiroNativeWrite(sourceUri, file);
      if (gameBlocked) return gameBlocked;
      const storage = deps.durableStoragePaths(deps.activeSession.meta.workspaceId);
      const operationLog = await deps.ensureActiveOperationLog(deps.activeSession);
      const nativeEdit = nativeEditSessionFromContext({
        session: deps.activeSession,
        operationLog,
        backupBaseDir: storage.backupBaseDir,
        recoveryDir: storage.recoveryDir,
        confirmationPort: deps.electronConfirmationPort(event)
      });
      const effectiveTransaction = transaction.baseRevision
        ? transaction
        : { ...transaction, baseRevision: expectedHash };
      const result = await executeMapTransaction(nativeEdit, file.absolutePath, effectiveTransaction);
      if (!result.ok) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: result.verification === 'failed' ? 'error' : 'warning',
            code: result.error?.code ?? 'MSB_TRANSACTION_FAILED',
            message: result.error?.message ?? 'MSB 地图事务失败。',
            sourceUri,
            ...(result.error?.details !== undefined ? { details: result.error.details } : {})
          }]
        };
      }
      const refreshed = await nativeEdit.indexFile(file.absolutePath, 'map');
      const index = deps.indexedFiles.findIndex((item) => item.sourceUri === sourceUri);
      if (index >= 0) deps.indexedFiles[index] = refreshed;
      const response: RendererSaveResult = {
        ok: true,
        changedFiles: result.committed ? [sourceUri] : [],
        diagnostics: [],
        ...(refreshed.sha256 ? { sourceHash: refreshed.sha256 } : {}),
        sourceRevision: refreshed.mtimeMs
      };
      if (result.committed) await deps.refreshActiveIndexAfterNativeWrite([sourceUri], response);
      return response;
    }
  );
}
