import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  executeMapTransaction as executeNativeMapTransaction,
  ingestBridgeResult,
  loadMapDocument,
  mapExportFromMsbDocument,
  nativeEditSessionFromContext,
  readMsbDocumentViaBridge,
  runBridge,
  BRIDGE_TRANSPORT_TIMING_CODE,
  type MsbBridgeMutation,
  type RunBridgeCancellationTerminalReceipt,
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
import { runCallerOwnedPostCommit } from '../knowledgeRefreshOwnership.js';
import { appendRendererPostCommitFailureDiagnostic } from '../rendererPostCommitDiagnostic.js';
import type { OperationLogUtilityClient } from '../operationLogUtilityClient.js';
import {
  MAP_NATIVE_TIMING_CODE,
  MAP_NATIVE_TIMING_SUMMARY_CODE,
  beginMapNativeTimingSession,
  bindNativeTimingSession,
  recordMapNativeTiming,
  timingKeyForNativeSession,
  clearMapNativeTimingSession
} from '../mapTimingTelemetry.js';
import {
  CHARACTER_NATIVE_TIMING_CODE,
  summarizeCharacterNativeTiming
} from '../characterTimingTelemetry.js';
import {
  createCharacterMainTimingCollector,
  type CharacterMainTimingCollector
} from '../characterMainTimingTelemetry.js';
import {
  decideMapStaticReadFailure,
  isMapStaticGeometryData
} from '../ipc/mapStaticReadDecision.js';
import { makeMapCacheIdentity } from '../ipc/mapCacheIdentity.js';
import { MAP_REQUEST_CANCELLED_CODE, type MapReadRequestContext, type MapCharacterSupportPorts } from './mapReadContext.js';
import { createMapCharacterPaging, type MapCharacterPageSession } from './mapCharacterPaging.js';

export interface MapServiceDeps extends MapCharacterSupportPorts {
  /** 活动索引文件表：事务成功后按条目原地替换（与拆分前语义一致）。 */
  readonly indexedFiles: IndexedFile[];
  readonly indexedFilesRevision: number;
  readonly indexedFilesIdentityDigest: string;
  readonly activeSession: WorkspaceSession | null;
  readonly activeIndex: WorkspaceIndex | null;
  readonly activeWorkspaceSessionId: string | null;
  readonly activeWorkspaceSessionGeneration: number;
  replaceIndexedFile(sourceUri: string, file: IndexedFile): boolean;
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
  refreshActiveIndexAfterNativeWrite(
    changedSources?: readonly string[],
    carrier?: { knowledgeRefresh?: unknown }
  ): Promise<unknown>;
}

/** MAP application operations. C# and core retain native and transaction
 * authority; this service owns derived model/root/page caches without sender
 * identity, channel registration or Electron event authority. */
export function createMapService(deps: MapServiceDeps) {
const refreshCommittedMapWrite = (sourceUri: string, response: RendererSaveResult): Promise<RendererSaveResult> =>
  runCallerOwnedPostCommit(response, {
    prepare: () => undefined,
    refresh: (result) => deps.refreshActiveIndexAfterNativeWrite([sourceUri], result),
    onRefreshError: (result, error) => appendRendererPostCommitFailureDiagnostic(
      result, 'POSTCOMMIT_REFRESH_FAILED', sourceUri, error
    )
  });
const { characterTexturePackagePaths, assembleC0000CompatibilityPreview } = deps;
const { characterBundleToMapChunks, estimateMapStaticWireBytes, splitCharacterMapChunks, evictMapCharacterPageSessions,
  characterPageFailure, serveMapCharacterPage, mapCharacterPageSessions } = createMapCharacterPaging();

// Forensics counters (V1, pure diagnostic — no business logic change).
const _forensicsMapCounters = new Map<string, number>();
function _forensicsMapInc(key: string, delta = 1): void { _forensicsMapCounters.set(key, (_forensicsMapCounters.get(key) ?? 0) + delta); }
function getMapForensicsCounters(): Record<string, number> { return Object.fromEntries(_forensicsMapCounters); }

// Native MAP timing is explicitly opt-in for the production probe. The main
// process consumes request-local Bridge diagnostics and forwards only one
// bounded summary on a model's final page; renderer responses never receive
// the per-page timing payload.
const MAP_NATIVE_TIMING_ENABLED = process.env.SF_MAP_NATIVE_TIMING === '1';
const CHARACTER_NATIVE_TIMING_ENABLED = process.env.SF_MAP_NATIVE_TIMING === '1';

function logicalMapModelName(raw: string): string {
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? raw;
  return base
    .replace(/\.(?:flver|chrbnd|objbnd|mapbnd)(?:\.dcx)?$/i, '')
    .replace(/\.dcx$/i, '');
}

interface IndexedFileIndex {
  byRel: Map<string, IndexedFile>;
  byBasename: Map<string, IndexedFile[]>;
  bySourceUri: Map<string, IndexedFile>;
}

const indexedFileIndexCache = new WeakMap<readonly IndexedFile[], { revision: number; index: IndexedFileIndex }>();

function getIndexedFileIndex(files: readonly IndexedFile[], revision: number): IndexedFileIndex {
  const cached = indexedFileIndexCache.get(files);
  if (cached?.revision === revision) return cached.index;
  {
    const byRel = new Map<string, IndexedFile>();
    const byBasename = new Map<string, IndexedFile[]>();
    const bySourceUri = new Map<string, IndexedFile>();
    for (const file of files) {
      const normalized = file.relativePath.replace(/\\/g, '/').toLowerCase();
      byRel.set(normalized, file);
      if (file.sourceUri) bySourceUri.set(file.sourceUri, file);
      const base = basename(normalized);
      let list = byBasename.get(base);
      if (!list) {
        list = [];
        byBasename.set(base, list);
      }
      list.push(file);
    }
    const index = { byRel, byBasename, bySourceUri };
    indexedFileIndexCache.set(files, { revision, index });
    return index;
  }
}

interface MapbndDirectoryScan {
  mapbnds: string[];
  complete: boolean;
}

const dirMapbndsCache = new Map<string, { mtimeMs: number; mapbnds: string[] }>();

function getDirMapbnds(dir: string, cacheIdentity = ''): MapbndDirectoryScan {
  try {
    const stat = statSync(dir);
    const cacheKey = `${cacheIdentity}|${dir}`;
    const cached = dirMapbndsCache.get(cacheKey);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return { mapbnds: cached.mapbnds, complete: true };
    }
    const entries = readdirSync(dir);
    const mapbnds = entries
      .filter((name) => /\.mapbnd\.dcx$/i.test(name))
      .map((name) => join(dir, name));
    if (dirMapbndsCache.size >= 100) {
      dirMapbndsCache.clear();
    }
    dirMapbndsCache.set(cacheKey, { mtimeMs: stat.mtimeMs, mapbnds });
    return { mapbnds, complete: true };
  } catch (error) {
    // A directory that does not exist is a complete negative observation;
    // permission/I/O failures are not.  Do not cache or translate the latter
    // into MAP_PART_MODEL_NOT_FOUND.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { mapbnds: [], complete: true };
    }
    return { mapbnds: [], complete: false };
  }
}

const resolvedModelFileCache = new Map<string, { absolutePath: string; relativePath: string; kind: 'flver' | 'chrbnd' } | null>();

function resolveMapModelFile(
  indexedFiles: readonly IndexedFile[],
  indexedFilesRevision: number,
  indexedFilesIdentityDigest: string,
  activeSession: WorkspaceSession | null,
  activeWorkspaceSessionId: string | null,
  activeWorkspaceSessionGeneration: number,
  safeExists: (path: string) => boolean,
  mapRelativePath: string,
  modelName: string,
  sibPath?: string
): { absolutePath: string; relativePath: string; kind: 'flver' | 'chrbnd' } | null {
  const cacheKey = [
    activeWorkspaceSessionId ?? '',
    activeWorkspaceSessionGeneration,
    activeSession?.meta.workspaceId ?? '',
    indexedFilesRevision,
    indexedFilesIdentityDigest,
    activeSession?.layers.overlayRoot ?? '',
    activeSession?.layers.baseRoot ?? '',
    mapRelativePath,
    modelName,
    sibPath ?? ''
  ].join(':');
  const cached = resolvedModelFileCache.get(cacheKey);
  if (cached !== undefined) return cached;

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
      const mDigits = /^m?(\d+)$/i.exec(name)?.[1];
      if (mDigits) {
        const padded = mDigits.padStart(6, '0');
        const longName = `${mapId}_${padded}`;
        candidates.push({ rel: `map/${mapId}/${longName}.mapbnd.dcx`, kind: 'flver' });
        // mapbnd 容器内的 FLVER 名就是长名本身（条目名为 .../long.flver），
        // 但单文件 flver 路径也试一下（部分 map 可能有散文件）
        candidates.push({ rel: `map/${mapId}/${longName}.flver.dcx`, kind: 'flver' });
        candidates.push({ rel: `map/${mapId}/${longName}.flver`, kind: 'flver' });
      }
      const mapPrefixMatch = /^(m\d{2}_\d{2}_\d{2}_\d{2})_/i.exec(name);
      if (mapPrefixMatch) {
        const specificMapId = mapPrefixMatch[1]!;
        candidates.push({ rel: `map/${specificMapId}/${name}.mapbnd.dcx`, kind: 'flver' });
        candidates.push({ rel: `map/${specificMapId}/${name}.flver.dcx`, kind: 'flver' });
        candidates.push({ rel: `map/${specificMapId}/${name}.flver`, kind: 'flver' });
      }
      candidates.push({ rel: `map/${mapId}/${name}.mapbnd.dcx`, kind: 'flver' });
      candidates.push({ rel: `map/${mapId}/${name}.flver.dcx`, kind: 'flver' });
      candidates.push({ rel: `map/${mapId}/${name}.flver`, kind: 'flver' });
    }
    candidates.push({ rel: `map/${name}.mapbnd.dcx`, kind: 'flver' });
    candidates.push({ rel: `map/${name}.flver.dcx`, kind: 'flver' });
    candidates.push({ rel: `map/${name}.flver`, kind: 'flver' });
    if (/^c\d/i.test(name)) {
      candidates.push({ rel: `chr/${name}.chrbnd.dcx`, kind: 'chrbnd' });
      candidates.push({ rel: `chr/${name}.chrbnd`, kind: 'chrbnd' });
    }
    // objbnd 是静态 FLVER 容器，不是角色 chrbnd。误标成 chrbnd 会把
    // 原生对象送进骨骼预览分支，最终只能留下 MSB 的方块代理。
    if (/^o\d/i.test(name)) {
      candidates.push({ rel: `obj/${name}.objbnd.dcx`, kind: 'flver' });
      candidates.push({ rel: `obj/${name}.objbnd`, kind: 'flver' });
    }
  }

  const index = getIndexedFileIndex(indexedFiles, indexedFilesRevision);
  for (const candidate of candidates) {
    const rel = candidate.rel.replace(/\\/g, '/').toLowerCase();
    const directHit = index.byRel.get(rel);
    if (directHit) {
      const res = { absolutePath: directHit.absolutePath, relativePath: directHit.relativePath, kind: candidate.kind };
      resolvedModelFileCache.set(cacheKey, res);
      return res;
    }
    const base = basename(rel);
    const sameBase = index.byBasename.get(base);
    if (sameBase) {
      const matched = sameBase.find((item) => {
        const itemRel = item.relativePath.replace(/\\/g, '/').toLowerCase();
        return itemRel === rel || itemRel.endsWith(`/${rel}`);
      });
      if (matched) {
        const res = { absolutePath: matched.absolutePath, relativePath: matched.relativePath, kind: candidate.kind };
        resolvedModelFileCache.set(cacheKey, res);
        return res;
      }
    }
  }

  const overlay = activeSession?.layers.overlayRoot?.trim();
  const base = activeSession?.layers.baseRoot?.trim();
  for (const root of [overlay, base]) {
    if (!root) continue;
    for (const candidate of candidates) {
      const absolutePath = join(root, candidate.rel);
      if (safeExists(absolutePath)) {
        const res = { absolutePath, relativePath: candidate.rel, kind: candidate.kind };
        resolvedModelFileCache.set(cacheKey, res);
        return res;
      }
    }
  }

  if (resolvedModelFileCache.size < 20_000) {
    resolvedModelFileCache.set(cacheKey, null);
  }
  return null;
}

function mapCacheIdentity(deps: Pick<MapServiceDeps, 'activeWorkspaceSessionId' | 'activeWorkspaceSessionGeneration' | 'indexedFilesRevision' | 'indexedFilesIdentityDigest' | 'activeSession'>): string {
  return makeMapCacheIdentity({
    workspaceSessionId: deps.activeWorkspaceSessionId,
    workspaceSessionGeneration: deps.activeWorkspaceSessionGeneration,
    workspaceId: deps.activeSession?.meta.workspaceId ?? null,
    indexedFilesRevision: deps.indexedFilesRevision,
    indexedFilesIdentityDigest: deps.indexedFilesIdentityDigest,
    overlayRoot: deps.activeSession?.layers.overlayRoot ?? null,
    baseRoot: deps.activeSession?.layers.baseRoot ?? null
  });
}

const verifiedReadRootsCache = new Map<string, { allowedRoots: string[]; diagnostics: Diagnostic[] }>();

async function getVerifiedReadRoots(
  deps: Pick<MapServiceDeps, 'verifiedReadRoots' | 'activeSession' | 'activeWorkspaceSessionId' | 'activeWorkspaceSessionGeneration' | 'indexedFilesRevision' | 'indexedFilesIdentityDigest'>,
  filePath: string
): Promise<{ allowedRoots: string[]; diagnostics: Diagnostic[] }> {
  const dir = dirname(filePath);
  const cacheKey = [
    deps.activeWorkspaceSessionId ?? '',
    deps.activeWorkspaceSessionGeneration,
    deps.activeSession?.meta.workspaceId ?? '',
    deps.indexedFilesRevision,
    deps.indexedFilesIdentityDigest,
    deps.activeSession?.layers.overlayRoot ?? '',
    deps.activeSession?.layers.baseRoot ?? '',
    dir
  ].join(':');
  const cached = verifiedReadRootsCache.get(cacheKey);
  if (cached) {
    return { allowedRoots: [...cached.allowedRoots], diagnostics: [...cached.diagnostics] };
  }
  const result = await deps.verifiedReadRoots(deps.activeSession, dir);
  if (result.diagnostics.length === 0) {
    if (verifiedReadRootsCache.size >= 500) {
      verifiedReadRootsCache.clear();
    }
    verifiedReadRootsCache.set(cacheKey, {
      allowedRoots: [...result.allowedRoots],
      diagnostics: [...result.diagnostics]
    });
  }
  return { allowedRoots: [...result.allowedRoots], diagnostics: [...result.diagnostics] };
}
const readMsbDocument = async (sourceUri: string) => {
    const readSession = deps.activeSession;
    const readGeneration = deps.activeWorkspaceSessionGeneration;
    const readIndex = deps.activeIndex;
    const oodleRuntimeRoot = readSession?.layers.baseRoot;
    const isCurrentRead = () => deps.activeSession === readSession
      && deps.activeWorkspaceSessionGeneration === readGeneration;
    const supersededRead = () => ({
      ok: false,
      cancelled: true,
      diagnostics: [{
        severity: 'info' as const,
        code: 'WORKSPACE_READ_SUPERSEDED',
        message: '工作区已更换，旧读取结果已丢弃。',
        sourceUri
      }]
    });
    const indexedFile = getIndexedFileIndex(deps.indexedFiles, deps.indexedFilesRevision).bySourceUri.get(sourceUri)
      ?? deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!indexedFile) {
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
    // Index records can be reused during refresh. Keep this read's physical
    // source and logical labels stable without copying parsed index contents.
    const file = { absolutePath: indexedFile.absolutePath, relativePath: indexedFile.relativePath, game: indexedFile.game };
    const roots = await getVerifiedReadRoots({
      activeSession: readSession,
      activeWorkspaceSessionId: deps.activeWorkspaceSessionId,
      activeWorkspaceSessionGeneration: readGeneration,
      indexedFilesRevision: deps.indexedFilesRevision,
      indexedFilesIdentityDigest: deps.indexedFilesIdentityDigest,
      verifiedReadRoots: (session, fallback) => deps.verifiedReadRoots(session, fallback)
    }, file.absolutePath);
    if (!isCurrentRead()) return supersededRead();
    if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
    const result = await readMsbDocumentViaBridge({
      sourcePath: file.absolutePath,
      allowedRoots: roots.allowedRoots,
      // 问题 4-A / 6-B：不再传 maxParts/maxRegions/maxModels/maxEvents —— 走
      // msbBridgeRead 默认完整表（调用方不传就是无窗口），索引与完整图都不截断
      // （缺口4：显示上限渗进索引=假装完整）。
      // P5 裁定：真实游戏 .msb.dcx 是 KRAK 压缩，缺 Oodle 运行时读不出实体表
      // （表现为 3D 代理场景 0 节点 / 0 实体）。
      ...(oodleRuntimeRoot
        ? { oodleRuntimeRoot }
        : {})
    });
    if (!isCurrentRead()) return supersededRead();
    // 问题 6-B：生产 analyze 的 export-map 未实现，桌面打开 MSB 时用
    // read-msb-document 的 parts[] 喂 MapExport（最小 hunk，不实现 C# export-map）。
    if (result.ok && result.data && readIndex) {
      const mapId = basename(file.relativePath).replace(/\.msb(\.dcx)?$/i, '');
      if (mapId) {
        ingestBridgeResult(readIndex, {
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
  };

const readMapModelSource = async (mapSourceUri: string, modelName: string, sibPath?: string): Promise<{
      ok: boolean;
      data?: Record<string, unknown>;
      diagnostics: Array<{ severity: string; code: string; message: string; sourceUri?: string }>;
    }> => {
      const file = getIndexedFileIndex(deps.indexedFiles, deps.indexedFilesRevision).bySourceUri.get(mapSourceUri)
        ?? deps.indexedFiles.find((item) => item.sourceUri === mapSourceUri);
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
      const resolved = resolveMapModelFile(
        deps.indexedFiles,
        deps.indexedFilesRevision,
        deps.indexedFilesIdentityDigest,
        deps.activeSession,
        deps.activeWorkspaceSessionId,
        deps.activeWorkspaceSessionGeneration,
        deps.safeExists,
        file.relativePath,
        modelName,
        sibPath
      );
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
      const roots = await getVerifiedReadRoots(deps, resolved.absolutePath);
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
    };

const readMapPartMesh = async (msbSourceUri: string, modelName: string): Promise<{
      ok: boolean;
      sourceUri?: string;
      data?: Record<string, unknown>;
      status?: 'partial';
      diagnostics: Array<{ severity: string; code: string; message: string; sourceUri?: string }>;
    }> => {
      _forensicsMapInc('map:main:readMapPartMesh:count');
      const file = getIndexedFileIndex(deps.indexedFiles, deps.indexedFilesRevision).bySourceUri.get(msbSourceUri)
        ?? deps.indexedFiles.find((item) => item.sourceUri === msbSourceUri);
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
      const cacheIdentity = mapCacheIdentity(deps);
      let directoryScanPartial = false;
      if (candidateDirs.length === 0) {
        const baseHint = effectiveBase
          ? `map/${mapId}/ 目录下没有模型文件。`
          : `overlay 的 map/${mapId}/ 下没有模型文件，且尚未挂载原版目录——到「开始」页选择含 sekiro.exe 的原版目录后可尝试读取原版模型。`;
        return {
          ok: false,
          diagnostics: [{ severity: 'error' as const, code: 'MAP_PART_NO_MODEL_DIR', message: `没有找到 ${modelName} 的模型（mapbnd）：${baseHint}`, sourceUri: msbSourceUri }]
        };
      }
      const roots = await getVerifiedReadRoots(deps, file.absolutePath);
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
            const scan = getDirMapbnds(dir, cacheIdentity);
            directoryScanPartial ||= !scan.complete;
            mapbnds = scan.mapbnds
              .filter((path) => basename(path).startsWith(prefix))
              .sort();
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
          const scan = getDirMapbnds(dir, cacheIdentity);
          directoryScanPartial ||= !scan.complete;
          mapbnds = scan.mapbnds.slice().sort();
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
      if (directoryScanPartial) {
        return {
          ok: false,
          status: 'partial',
          diagnostics: [{
            severity: 'warning' as const,
            code: 'MAP_PART_MODEL_SCAN_PARTIAL',
            message: `模型目录扫描未完成，暂不判定 ${modelName} 不存在。`,
            sourceUri: msbSourceUri
          }]
        };
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
    };

const readMapStaticGeometry = async (context: MapReadRequestContext, msbSourceUri: string, modelName: string, cursor?: string | null, sessionToken?: string | null) => {
const { signal: requestSignal, onCancellationTerminal } = context;
      _forensicsMapInc('map:main:readMapStaticGeometry:count');
      const throwIfMapRequestCancelled = (): void => {
        if (requestSignal?.aborted) throw new Error(MAP_REQUEST_CANCELLED_CODE);
      };
      const file = getIndexedFileIndex(deps.indexedFiles, deps.indexedFilesRevision).bySourceUri.get(msbSourceUri)
        ?? deps.indexedFiles.find((item) => item.sourceUri === msbSourceUri);
      if (!file || !deps.activeSession) return { ok: false, diagnostics: [{ severity: 'error', code: 'MAP_PART_MSB_NOT_INDEXED', message: 'MSB not indexed', sourceUri: msbSourceUri }] };
      const baseName = basename(file.relativePath);
      const mapId = baseName.replace(/\.msb(\.dcx)?$/i, '');
      const overlayParent = dirname(deps.activeSession.layers.overlayRoot);
      const effectiveBase = deps.activeSession.layers.baseRoot ?? (existsSync(join(overlayParent, 'sekiro.exe')) || existsSync(join(overlayParent, 'map')) ? overlayParent : null);
      const overlayDir = join(deps.activeSession.layers.overlayRoot, 'map', mapId);
      const baseDir = effectiveBase ? join(effectiveBase, 'map', mapId) : null;
      const candidateDirs = [...(deps.safeExists(overlayDir) ? [{ dir: overlayDir, fromBase: false }] : []), ...(baseDir && deps.safeExists(baseDir) ? [{ dir: baseDir, fromBase: true }] : [])];
      const cacheIdentity = mapCacheIdentity(deps);
      let directoryScanPartial = false;
      throwIfMapRequestCancelled();
      const roots = await getVerifiedReadRoots(deps, file.absolutePath);
      throwIfMapRequestCancelled();
      if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
      if (effectiveBase && !roots.allowedRoots.includes(effectiveBase)) roots.allowedRoots.push(effectiveBase);

      const readCharacterPath = async (
        modelPath: string,
        requestedCursor: string | null = cursor ?? null,
        requestedSessionToken: string | null = sessionToken ?? null
      ) => {
        throwIfMapRequestCancelled();
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
          throwIfMapRequestCancelled();
          return serveMapCharacterPage(session, requestedCursor);
        }
        if (requestedCursor) {
          return characterPageFailure(
            msbSourceUri,
            'MAP_CHARACTER_CURSOR_INVALID',
            '角色模型分页缺少所属会话，已失败关闭。请刷新模型/纹理后重试。'
          );
        }

        // Character timing is deliberately request-local.  A session/cursor
        // replay is a page-cache read and must not create another timing
        // sample or attach a duplicate summary.
        const mainTiming: CharacterMainTimingCollector | null = CHARACTER_NATIVE_TIMING_ENABLED
          ? createCharacterMainTimingCollector()
          : null;
        let bridgeTransportTiming: Record<string, unknown> | null = null;
        const withMainTiming = <T extends { diagnostics?: Diagnostic[] }>(
          response: T,
          outcome: 'ok' | 'failed' | 'empty'
        ): T => {
          if (!mainTiming) return response;
          const summary = mainTiming.finish(outcome, bridgeTransportTiming) as unknown as Diagnostic;
          return {
            ...response,
            diagnostics: [...(response.diagnostics ?? []), summary]
          };
        };
        const failureDiagnostic = (error: unknown): Diagnostic => ({
          severity: 'error',
          code: 'MAP_CHARACTER_READ_FAILED',
          message: error instanceof Error ? error.message : String(error),
          sourceUri: msbSourceUri
        });

        const optionsScope = mainTiming?.begin('optionsPrepareMs') ?? null;
        let commandOptions: Record<string, unknown>;
        try {
          commandOptions = {
            maxVertices: 1_000_000,
            maxIndices: 3_000_000,
            texturePackagePaths: characterTexturePackagePaths(modelPath, [
              join(deps.activeSession!.layers.overlayRoot, 'parts'),
              ...(effectiveBase ? [join(effectiveBase, 'parts')] : [])
            ]),
            ...(CHARACTER_NATIVE_TIMING_ENABLED ? { diagnosticTimings: true } : {})
          };
        } catch (error) {
          return withMainTiming({
            ok: false,
            sourceUri: msbSourceUri,
            diagnostics: [failureDiagnostic(error)]
          }, 'failed');
        } finally {
          mainTiming?.end(optionsScope);
        }

        const bridgeScope = mainTiming?.begin('bridgeAwaitMs') ?? null;
        let result;
        try {
          result = await runBridge<unknown>({
            command: 'read-chrbnd-flver-preview',
            filePath: modelPath,
            allowedRoots: roots.allowedRoots,
            timeoutMs: 120_000,
            ...(effectiveBase ? { oodleRuntimeRoot: effectiveBase } : {}),
            commandOptions,
            ...(requestSignal ? { signal: requestSignal } : {}),
            ...(onCancellationTerminal ? { onCancellationTerminal } : {})
          });
          throwIfMapRequestCancelled();
        } catch (error) {
          return withMainTiming({
            ok: false,
            sourceUri: msbSourceUri,
            diagnostics: [failureDiagnostic(error)]
          }, 'failed');
        } finally {
          mainTiming?.end(bridgeScope);
        }
        const transportDiagnostic = result.diagnostics.find(
          (item) => item.code === BRIDGE_TRANSPORT_TIMING_CODE
        );
        if (transportDiagnostic?.details
          && typeof transportDiagnostic.details === 'object'
          && !Array.isArray(transportDiagnostic.details)) {
          bridgeTransportTiming = transportDiagnostic.details as Record<string, unknown>;
        }
        const characterTimingSummary: Diagnostic | null = CHARACTER_NATIVE_TIMING_ENABLED
          ? summarizeCharacterNativeTiming(result.diagnostics) as unknown as Diagnostic | null
          : null;
        const responseDiagnostics = result.diagnostics.filter(
          (item) => item.code !== CHARACTER_NATIVE_TIMING_CODE
            && item.code !== BRIDGE_TRANSPORT_TIMING_CODE
        );
        const bundleValidateScope = mainTiming?.begin('bundleValidateMs') ?? null;
        let bundle = result.parseStatus !== 'failed' && isCharacterPreviewBundle(result.data)
          ? result.data
          : null;
        mainTiming?.end(bundleValidateScope);
        if (!bundle) {
          return withMainTiming({
            ok: false,
            sourceUri: msbSourceUri,
            diagnostics: characterTimingSummary
              ? [...responseDiagnostics, characterTimingSummary]
              : responseDiagnostics
          }, 'failed');
        }

        const modelStem = basename(modelPath).replace(/\.chrbnd(?:\.dcx)?$/i, '').toLowerCase();
        let compatibilityDiagnostics: Diagnostic[] = [];
        if (modelStem !== 'c0000') {
          // Compatibility is a c0000-only path.  Preserve that fact in the
          // summary instead of treating the known non-c0000 path as missing.
          mainTiming?.skip('compatibilityMs');
        } else if (bundle.meshCount === 0 && bundle.boneCount > 0) {
          const compatibilityScope = mainTiming?.begin('compatibilityMs') ?? null;
          try {
            const compatibility = await assembleC0000CompatibilityPreview({
              leaderBundle: bundle,
              overlayPartsDirectory: join(deps.activeSession!.layers.overlayRoot, 'parts'),
              basePartsDirectory: effectiveBase ? join(effectiveBase, 'parts') : null,
              allowedRoots: roots.allowedRoots,
              oodleRuntimeRoot: effectiveBase,
              ...(requestSignal ? { signal: requestSignal } : {}),
              ...(onCancellationTerminal ? { onCancellationTerminal } : {})
            });
            throwIfMapRequestCancelled();
            compatibilityDiagnostics = compatibility.diagnostics;
            if (compatibility.bundle) bundle = compatibility.bundle;
          } catch (error) {
            return withMainTiming({
              ok: false,
              sourceUri: msbSourceUri,
              diagnostics: [
                ...responseDiagnostics,
                ...(characterTimingSummary ? [characterTimingSummary] : []),
                failureDiagnostic(error)
              ]
            }, 'failed');
          } finally {
            mainTiming?.end(compatibilityScope);
          }
        } else {
          // A c0000 bundle that already contains renderable geometry does not
          // need the compatibility assembly; this is a known skip, not a
          // missing observation.
          mainTiming?.skip('compatibilityMs');
        }

        let chunks: Array<Record<string, unknown>>;
        const chunkBuildScope = mainTiming?.begin('chunkBuildMs') ?? null;
        try {
          chunks = splitCharacterMapChunks(characterBundleToMapChunks(bundle));
        } catch (error) {
          mainTiming?.end(chunkBuildScope);
          return withMainTiming({
            ok: false,
            sourceUri: msbSourceUri,
            diagnostics: [
              ...responseDiagnostics,
              ...compatibilityDiagnostics,
              ...(characterTimingSummary ? [characterTimingSummary] : []),
              {
                severity: 'error' as const,
                code: 'MAP_CHARACTER_GEOMETRY_INVALID',
                message: error instanceof Error ? error.message : String(error),
                sourceUri: msbSourceUri
              }
            ]
          }, 'failed');
        }
        mainTiming?.end(chunkBuildScope);
        throwIfMapRequestCancelled();
        if (chunks.length === 0) {
          return withMainTiming({
            ok: false,
            sourceUri: msbSourceUri,
            diagnostics: [
              ...responseDiagnostics,
              ...compatibilityDiagnostics,
              ...(characterTimingSummary ? [characterTimingSummary] : []),
              {
                severity: 'warning' as const,
                code: 'MAP_CHARACTER_GEOMETRY_UNAVAILABLE',
                message: `角色模型 ${modelStem} 只有骨骼或没有可显示网格，地图保留线框占位。`,
                sourceUri: msbSourceUri
              }
            ]
          }, 'empty');
        }
        const pageSession: MapCharacterPageSession = {
          token: randomUUID(),
          sourceUri: msbSourceUri,
          modelPath,
          modelStem,
          chunks,
          diagnostics: [...responseDiagnostics, ...compatibilityDiagnostics],
          cursors: new Map<string, number>(),
          lastAccessMs: Date.now()
        };
        throwIfMapRequestCancelled();
        mapCharacterPageSessions.set(pageSession.token, pageSession);
        evictMapCharacterPageSessions();
        const pageFirstScope = mainTiming?.begin('pageFirstMs') ?? null;
        let firstPage;
        try {
          firstPage = serveMapCharacterPage(pageSession, null);
        } catch (error) {
          mapCharacterPageSessions.delete(pageSession.token);
          return withMainTiming({
            ok: false,
            sourceUri: msbSourceUri,
            diagnostics: [
              ...responseDiagnostics,
              ...compatibilityDiagnostics,
              ...(characterTimingSummary ? [characterTimingSummary] : []),
              failureDiagnostic(error)
            ]
          }, 'failed');
        } finally {
          mainTiming?.end(pageFirstScope);
        }
        if (!firstPage.ok) mapCharacterPageSessions.delete(pageSession.token);
        throwIfMapRequestCancelled();
        const firstPageWithNativeTiming = characterTimingSummary
          ? { ...firstPage, diagnostics: [...firstPage.diagnostics, characterTimingSummary] }
          : firstPage;
        return withMainTiming(firstPageWithNativeTiming, firstPage.ok ? 'ok' : 'failed');
      };

      const readStaticPath = async (modelPath: string, modelKind: 'flver' | 'chrbnd' = 'flver') => {
        if (modelKind === 'chrbnd') return readCharacterPath(modelPath);
        throwIfMapRequestCancelled();
        const timingKey = MAP_NATIVE_TIMING_ENABLED
          ? sessionToken
            ? (timingKeyForNativeSession(sessionToken) ?? `native:${sessionToken}`)
            : `pending:${randomUUID()}`
          : '';
        if (MAP_NATIVE_TIMING_ENABLED && !sessionToken && !cursor) beginMapNativeTimingSession(timingKey);
        const bridgeStartedAtUnixMs = performance.timeOrigin + performance.now();
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
            resourceCacheKey: JSON.stringify({ modelName, mapId }),
            ...(MAP_NATIVE_TIMING_ENABLED ? { diagnosticTimings: true } : {})
          },
          ...(requestSignal ? { signal: requestSignal } : {}),
          ...(onCancellationTerminal ? { onCancellationTerminal } : {})
        });
        const bridgeReturnedAtUnixMs = performance.timeOrigin + performance.now();
        throwIfMapRequestCancelled();
        const nativeTimingSummary = MAP_NATIVE_TIMING_ENABLED
          ? recordMapNativeTiming(timingKey, result.diagnostics)
          : null;
        const nativeSessionToken = (result.data as { sessionToken?: unknown } | null)?.sessionToken;
        if (MAP_NATIVE_TIMING_ENABLED && typeof nativeSessionToken === 'string') {
          bindNativeTimingSession(nativeSessionToken, timingKey);
        }
        if (result.parseStatus === 'failed' || !isMapStaticGeometryData(result.data)) {
          const failure = decideMapStaticReadFailure({
            sourceUri: msbSourceUri,
            parseStatus: result.parseStatus,
            data: result.data,
            diagnostics: result.diagnostics
          });
          if (failure.action === 'fallback') return null;
          return failure.result;
        }
        const responseDiagnostics = result.diagnostics.filter((item) => item.code !== MAP_NATIVE_TIMING_CODE);
        const nativeTiming = result.diagnostics.find((item) => item.code === MAP_NATIVE_TIMING_CODE)?.details;
        if (MAP_NATIVE_TIMING_ENABLED && nativeTiming && typeof nativeTiming === 'object') {
          const timing = nativeTiming as Record<string, unknown>;
          responseDiagnostics.push({ severity: 'info', code: 'MAP_REQUEST_TIMELINE', message: 'Correlated native request timeline, not cumulative overlapping request cost.', sourceUri: result.sourceUri,
            details: { schemaVersion: 1, unit: 'ms', bridgeStartedAtUnixMs, bridgeReturnedAtUnixMs,
              nativeEnqueuedAtUnixMs: timing.nativeEnqueuedAtUnixMs,
              nativeStartedAtUnixMs: timing.nativeStartedAtUnixMs,
              nativeCompletedAtUnixMs: timing.nativeCompletedAtUnixMs,
              clockAlignmentToleranceMs: timing.clockAlignmentToleranceMs } });
        }
        const complete = Boolean((result.data as { complete?: unknown } | null)?.complete);
        if (nativeTimingSummary && complete) {
          responseDiagnostics.push({
            severity: 'info',
            code: nativeTimingSummary.code,
            message: nativeTimingSummary.message,
            sourceUri: result.sourceUri,
            details: nativeTimingSummary.details
          });
          clearMapNativeTimingSession(timingKey);
        }
        const estimatedWire = estimateMapStaticWireBytes(result.data);
        const wireBytes = estimatedWire >= 7.5 * 1024 * 1024
          ? Buffer.byteLength(JSON.stringify(result.data), 'utf8')
          : estimatedWire;
        if (wireBytes >= 8 * 1024 * 1024) {
          return { ok: false, diagnostics: [{ severity: 'error', code: 'MAP_STATIC_WIRE_BUDGET_EXCEEDED', message: 'wire bytes exceed 8 MiB', sourceUri: msbSourceUri }] };
        }
        return { ok: true, sourceUri: msbSourceUri, data: result.data, diagnostics: responseDiagnostics };
      };

      // The legacy route already knows the exact short-name -> mapbnd/chrbnd/objbnd
      // resolution. Reuse it before directory scanning so each page opens one
      // container instead of probing every mapbnd again (O(models * files * pages)).
      const directModel = resolveMapModelFile(
        deps.indexedFiles,
        deps.indexedFilesRevision,
        deps.indexedFilesIdentityDigest,
        deps.activeSession,
        deps.activeWorkspaceSessionId,
        deps.activeWorkspaceSessionGeneration,
        deps.safeExists,
        file.relativePath,
        modelName
      );
      if (directModel) {
        throwIfMapRequestCancelled();
        const directResult = await readStaticPath(directModel.absolutePath, directModel.kind);
        throwIfMapRequestCancelled();
        if (directResult) return directResult;
      }

      const triedPaths = new Set(directModel ? [directModel.absolutePath.toLowerCase()] : []);
      for (const { dir } of candidateDirs) {
        const scan = getDirMapbnds(dir, cacheIdentity);
        directoryScanPartial ||= !scan.complete;
        const mapbnds = scan.mapbnds;
        const modelDigits = modelName.replace(/\D/g, '');
        const prioritizedMapbnds: string[] = [];
        const otherMapbnds: string[] = [];
        const lowerModel = modelName.toLowerCase();
        for (const mapbnd of mapbnds) {
          const lowerBase = basename(mapbnd).toLowerCase();
          if (
            lowerBase.includes(lowerModel) ||
            (modelDigits.length >= 2 && lowerBase.includes(modelDigits)) ||
            (modelDigits.length > 0 && lowerBase.includes(modelDigits.padStart(6, '0')))
          ) {
            prioritizedMapbnds.push(mapbnd);
          } else {
            otherMapbnds.push(mapbnd);
          }
        }
      const candidateMapbnds = [
        ...prioritizedMapbnds,
        ...otherMapbnds
      ];
        for (const mapbndPath of candidateMapbnds) {
          throwIfMapRequestCancelled();
          const key = mapbndPath.toLowerCase();
          if (triedPaths.has(key)) continue;
          triedPaths.add(key);
          const result = await readStaticPath(mapbndPath);
          throwIfMapRequestCancelled();
          if (result) return result;
        }
      }
      if (directoryScanPartial) {
        return {
          ok: false,
          status: 'partial',
          diagnostics: [{ severity: 'warning', code: 'MAP_PART_MODEL_SCAN_PARTIAL', message: `模型目录扫描未完成，暂不判定 ${modelName} 不存在。`, sourceUri: msbSourceUri }]
        };
      }
      return { ok: false, diagnostics: [{ severity: 'error', code: 'MAP_PART_MODEL_NOT_FOUND', message: 'not found ' + modelName, sourceUri: msbSourceUri }] };
    };

const applyMsbMutation = async (confirmation: () => WriteConfirmationPort, sourceUri: string, expectedHash: string, mutation: MsbBridgeMutation): Promise<RendererSaveResult> => {
      const file = getIndexedFileIndex(deps.indexedFiles, deps.indexedFilesRevision).bySourceUri.get(sourceUri)
        ?? deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
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
        confirmationPort: confirmation()
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
      const result = await executeNativeMapTransaction(nativeEdit, file.absolutePath, transaction);
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
      if (result.committed) await refreshCommittedMapWrite(sourceUri, response);
      return response;
    };

const executeMapTransaction = async (confirmation: () => WriteConfirmationPort, sourceUri: string, expectedHash: string, transaction: MapEditTransaction): Promise<RendererSaveResult> => {
      const file = getIndexedFileIndex(deps.indexedFiles, deps.indexedFilesRevision).bySourceUri.get(sourceUri)
        ?? deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
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
        confirmationPort: confirmation()
      });
      const effectiveTransaction = transaction.baseRevision
        ? transaction
        : { ...transaction, baseRevision: expectedHash };
      const result = await executeNativeMapTransaction(nativeEdit, file.absolutePath, effectiveTransaction);
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
      deps.replaceIndexedFile(sourceUri, refreshed);
      const response: RendererSaveResult = {
        ok: true,
        changedFiles: result.committed ? [sourceUri] : [],
        diagnostics: [],
        ...(refreshed.sha256 ? { sourceHash: refreshed.sha256 } : {}),
        sourceRevision: refreshed.mtimeMs
      };
      if (result.committed) await refreshCommittedMapWrite(sourceUri, response);
      return response;
    };
return Object.freeze({ readMsbDocument, readMapModelSource, readMapPartMesh, readMapStaticGeometry, applyMsbMutation, executeMapTransaction, getMapForensicsCounters });
}
export type MapService = ReturnType<typeof createMapService>;
