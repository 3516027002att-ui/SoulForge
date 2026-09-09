/**
 * Map Service: High-level operations on MapDocument, SceneGraph, and MapEditTransactions.
 *
 * Exposes unified query, inspect, batch transform, and transaction execution
 * for Agent tools, Desktop IPC, and future Blender bridges.
 */

import { access } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import {
  buildCanonicalMapDocument,
  MapSceneGraph,
  validateMapTransaction,
  validateRegionShape,
  createMapSnapshotLease,
  isValidSnapshotLease,
  type MapSnapshotLease,
  type MapDocument,
  type MapEditTransaction,
  type MapEntity,
  type MapPartEntity,
  type MapRegionEntity,
  type MapRegionTransform
} from '@soulforge/shared';
import { readMsbDocumentViaBridge } from './msbBridgeRead.js';
import type { NativeEditSession } from './nativeEditSession.js';
import { applyNativeMutation } from './editorMutationService.js';
import { commitMsbMutationViaBridge, type MsbBridgeMutation } from './msbBridgeCommit.js';

export interface MapQueryResult {
  ok: boolean;
  mapId: string;
  totalEntities: number;
  matchedEntities: MapEntity[];
  /** Native snapshot identity; required before treating a query as write evidence. */
  sourceUri?: string;
  sourceHash?: string;
  error?: { code: string; message: string };
}

export interface MapInspectResult {
  ok: boolean;
  mapId: string;
  entity?: MapEntity;
  /** Native snapshot identity; required before treating an inspection as write evidence. */
  sourceUri?: string;
  sourceHash?: string;
  references?: {
    referencingEvents?: MapEntity[];
    partsUsingSameModel?: MapEntity[];
  };
  error?: { code: string; message: string };
}

export interface MapBatchTransformResult {
  ok: boolean;
  mapId: string;
  modifiedCount: number;
  requestedCount?: number;
  resolvedCount?: number;
  effectiveCount?: number;
  noop?: boolean;
  targets: string[];
  before: Array<{ name: string; posX: number; posY: number; posZ: number }>;
  after: Array<{ name: string; posX: number; posY: number; posZ: number }>;
  error?: { code: string; message: string };
}

export interface MapTransactionResult {
  ok: boolean;
  transactionId: string;
  appliedOperations: number;
  revision?: string;
  committed: boolean;
  verification?: 'passed' | 'failed' | 'not_run';
  error?: { code: string; message: string; details?: unknown };
  verifiedPostState?: {
    sourceVersion: string;
    touchedEntities: MapEntity[];
    sceneGraph?: MapSceneGraph;
    doc?: MapDocument;
  };
}

/**
 * Loads a full MapDocument from disk via Bridge without truncation.
 */
export async function loadMapDocument(
  edit: NativeEditSession,
  file: string
): Promise<{ ok: true; doc: MapDocument; sceneGraph: MapSceneGraph; filePath: string; lease: MapSnapshotLease } | { ok: false; error: { code: string; message: string } }> {
  const overlay = edit.session.layers.overlayRoot;
  const candidates = [...new Set([
    resolve(file),
    resolve(overlay, file),
    resolve(overlay, 'map', file)
  ])];
  let resolvedPath: string | undefined;
  for (const candidate of candidates) {
    try {
      await access(candidate);
      resolvedPath = candidate;
      break;
    } catch {
      // Try the next workspace/base/overlay candidate.
    }
  }
  if (!resolvedPath) {
    return {
      ok: false,
      error: { code: 'MAP_FILE_NOT_FOUND', message: `工作区内找不到地图文件：${file}` }
    };
  }
  const mapId = basename(resolvedPath).replace(/\.msb(\.dcx)?$/i, '');

  const readResult = await readMsbDocumentViaBridge({
    sourcePath: resolvedPath,
    allowedRoots: edit.allowedRoots(),
    ...(edit.oodleRuntimeRoot ? { oodleRuntimeRoot: edit.oodleRuntimeRoot } : {}),
    timeoutMs: 120_000
  });

  if (!readResult.ok || !readResult.data) {
    return {
      ok: false,
      error: { code: 'MAP_LOAD_FAILED', message: `无法读取 MSB 文件: ${file}` }
    };
  }

  let doc: MapDocument;
  try {
    doc = buildCanonicalMapDocument({
      sourceUri: `map://${mapId}/${basename(resolvedPath)}`,
      sourcePath: resolvedPath,
      game: 'sekiro',
      revision: readResult.data.sourceHash || '1',
      readerSchemaRevision: readResult.data.readerSchemaRevision ?? 1,
      entityIdVerified: (readResult.data.readerSchemaRevision ?? 0) >= 2,
      models: readResult.data.models,
      parts: readResult.data.parts,
      regions: readResult.data.regions,
      events: readResult.data.events,
      routes: readResult.data.routes
    });
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'MAP_NATIVE_OFFSET_REQUIRED',
        message: error instanceof Error ? error.message : 'MSB 实体缺少 nativeOffset，已失败关闭。'
      }
    };
  }

  const sceneGraph = new MapSceneGraph(doc);
  const epoch = (edit.session as any)?.epoch;
  const fileEntry = await edit.indexFile(resolvedPath, 'map').catch(() => undefined);
  const lease = createMapSnapshotLease(doc, sceneGraph, resolvedPath, doc.revision, epoch, fileEntry?.sha256);
  return { ok: true, doc, sceneGraph, filePath: resolvedPath, lease };
}

/**
 * Queries map entities by modelName, entityId, kind, or name substring.
 */
export async function queryMapEntities(
  edit: NativeEditSession,
  file: string,
  query: {
    modelName?: string;
    entityId?: number;
    kind?: 'model' | 'part' | 'region' | 'event' | 'route';
    nameContains?: string;
    regionName?: string;
  },
  snapshot?: MapSnapshotLease
): Promise<MapQueryResult> {
  let doc: MapDocument;
  let sceneGraph: MapSceneGraph;

  if (snapshot) {
    if (!isValidSnapshotLease(snapshot)) {
      return {
        ok: false,
        mapId: '',
        totalEntities: 0,
        matchedEntities: [],
        error: { code: 'MAP_SNAPSHOT_INVALID', message: '无效或已释放的 MapSnapshotLease' }
      };
    }
    doc = snapshot.doc;
    sceneGraph = snapshot.sceneGraph;
  } else {
    const loaded = await loadMapDocument(edit, file);
    if (!loaded.ok) {
      return { ok: false, mapId: '', totalEntities: 0, matchedEntities: [], error: loaded.error };
    }
    doc = loaded.doc;
    sceneGraph = loaded.sceneGraph;
  }

  let referencingEventKeys: Set<string> | undefined = undefined;

  if (query.regionName) {
    // 先用 native 身份解析 Region；名称歧义则返回候选；引用图 coverage 不完整时返回 MAP_REFERENCE_COVERAGE_INCOMPLETE
    const resolvedRegion = sceneGraph.resolveEntity(query.regionName);
    if (!resolvedRegion.ok) {
      if (resolvedRegion.code === 'MAP_ENTITY_AMBIGUOUS') {
        return {
          ok: false,
          mapId: doc.mapId,
          totalEntities: doc.totalEntityCount,
          matchedEntities: [],
          error: {
            code: 'MAP_ENTITY_AMBIGUOUS',
            message: `目标 Region 存在名称歧义: ${query.regionName}`
          }
        };
      }
      return {
        ok: false,
        mapId: doc.mapId,
        totalEntities: doc.totalEntityCount,
        matchedEntities: [],
        error: {
          code: 'MAP_ENTITY_NOT_FOUND',
          message: `目标 Region 未找到: ${query.regionName}`
        }
      };
    }
    if (resolvedRegion.entity.kind !== 'region') {
      return {
        ok: false,
        mapId: doc.mapId,
        totalEntities: doc.totalEntityCount,
        matchedEntities: [],
        error: {
          code: 'MAP_NOT_A_REGION',
          message: `指定实体不是 Region: ${query.regionName} (kind=${resolvedRegion.entity.kind})`
        }
      };
    }

    const coverageComplete = (doc as any).referenceCoverage?.complete === true;
    if (!coverageComplete) {
      return {
        ok: false,
        mapId: doc.mapId,
        totalEntities: doc.totalEntityCount,
        matchedEntities: [],
        error: {
          code: 'MAP_REFERENCE_COVERAGE_INCOMPLETE',
          message: '事件对 Region 的引用图 coverage 尚未完成 native 验证，无法确定引用全集。'
        }
      };
    }

    const referencingEvents = sceneGraph.queryEventsReferencingRegion(resolvedRegion.entity.name);
    referencingEventKeys = new Set(referencingEvents.map((e) => e.stableKey));
  }

  // 建立成本最小的候选集
  let candidates: MapEntity[];
  if (referencingEventKeys !== undefined) {
    candidates = doc.events.filter((e) => referencingEventKeys!.has(e.stableKey));
  } else if (query.modelName) {
    candidates = sceneGraph.queryPartsByModel(query.modelName);
  } else if (query.entityId !== undefined) {
    candidates = sceneGraph.queryByEntityId(query.entityId);
  } else if (query.kind === 'part') {
    candidates = doc.parts;
  } else if (query.kind === 'region') {
    candidates = doc.regions;
  } else if (query.kind === 'model') {
    candidates = doc.models;
  } else if (query.kind === 'event') {
    candidates = doc.events;
  } else if (query.kind === 'route') {
    candidates = doc.routes;
  } else {
    candidates = [
      ...doc.models,
      ...doc.parts,
      ...doc.regions,
      ...doc.events,
      ...doc.routes
    ];
  }

  // 执行全部给定谓词的交集（AND）
  const matched = candidates.filter((entity) => {
    if (query.kind !== undefined && entity.kind !== query.kind) {
      return false;
    }
    if (query.modelName !== undefined) {
      if (entity.kind === 'part') {
        if ((entity as MapPartEntity).modelName !== query.modelName) return false;
      } else if (entity.kind === 'model') {
        if (entity.name !== query.modelName) return false;
      } else {
        return false;
      }
    }
    if (query.entityId !== undefined) {
      if (!('entityId' in entity) || (entity as any).entityId !== query.entityId) {
        return false;
      }
    }
    if (referencingEventKeys !== undefined) {
      if (entity.kind !== 'event' || !referencingEventKeys.has(entity.stableKey)) {
        return false;
      }
    }
    if (query.nameContains !== undefined) {
      if (!entity.name.toLowerCase().includes(query.nameContains.toLowerCase())) {
        return false;
      }
    }
    return true;
  });

  return {
    ok: true,
    mapId: doc.mapId,
    totalEntities: doc.totalEntityCount,
    matchedEntities: matched,
    sourceUri: doc.sourceUri,
    sourceHash: doc.revision
  };
}

/**
 * Inspects a specific map entity and discovers its cross-references.
 */
export async function inspectMapEntity(
  edit: NativeEditSession,
  file: string,
  identifier: string
): Promise<MapInspectResult> {
  const loaded = await loadMapDocument(edit, file);
  if (!loaded.ok) {
    return { ok: false, mapId: '', error: loaded.error };
  }

  const { doc, sceneGraph } = loaded;
  const entity = sceneGraph.findEntity(identifier);

  if (!entity) {
    return {
      ok: false,
      mapId: doc.mapId,
      error: { code: 'MAP_ENTITY_NOT_FOUND', message: `未找到实体: ${identifier}` }
    };
  }

  const references: MapInspectResult['references'] = {};

  if (entity.kind === 'region') {
    references.referencingEvents = sceneGraph.queryEventsReferencingRegion(entity.name);
  } else if (entity.kind === 'part') {
    const part = entity as MapPartEntity;
    if (part.modelName) {
      references.partsUsingSameModel = sceneGraph.queryPartsByModel(part.modelName);
    }
  } else if (entity.kind === 'model') {
    references.partsUsingSameModel = sceneGraph.queryPartsByModel(entity.name);
  }

  return {
    ok: true,
    mapId: doc.mapId,
    entity,
    sourceUri: doc.sourceUri,
    sourceHash: doc.revision,
    references
  };
}

/**
 * Performs a batch transform on multiple map parts (e.g. move all m000320 parts by 3m on X).
 */
export async function batchTransformMapParts(
  edit: NativeEditSession,
  file: string,
  input: {
    targets: string[]; // part names or addresses
    deltaX?: number;
    deltaY?: number;
    deltaZ?: number;
    rotDeltaX?: number;
    rotDeltaY?: number;
    rotDeltaZ?: number;
    scaleMultiplier?: number;
  },
  snapshot?: MapSnapshotLease
): Promise<MapBatchTransformResult> {
  let loaded: { ok: true; doc: MapDocument; sceneGraph: MapSceneGraph; filePath: string; lease: MapSnapshotLease }
    | { ok: false; error: { code: string; message: string } };

  if (snapshot) {
    if (!isValidSnapshotLease(snapshot)) {
      return {
        ok: false,
        mapId: '',
        modifiedCount: 0,
        requestedCount: input.targets?.length ?? 0,
        resolvedCount: 0,
        effectiveCount: 0,
        targets: input.targets,
        before: [],
        after: [],
        error: { code: 'MAP_SNAPSHOT_INVALID', message: '无效或已释放的 MapSnapshotLease' }
      };
    }
    loaded = {
      ok: true,
      doc: snapshot.doc,
      sceneGraph: snapshot.sceneGraph,
      filePath: snapshot.sourceIdentity,
      lease: snapshot
    };
  } else {
    loaded = await loadMapDocument(edit, file);
    if (!loaded.ok) {
      return {
        ok: false,
        mapId: '',
        modifiedCount: 0,
        requestedCount: input.targets?.length ?? 0,
        resolvedCount: 0,
        effectiveCount: 0,
        targets: input.targets,
        before: [],
        after: [],
        error: loaded.error
      };
    }
  }

  const { doc, sceneGraph, lease } = loaded;
  const requestedTargets = input.targets;

  if (!requestedTargets || requestedTargets.length === 0) {
    return {
      ok: false,
      mapId: doc.mapId,
      modifiedCount: 0,
      requestedCount: 0,
      resolvedCount: 0,
      effectiveCount: 0,
      targets: [],
      before: [],
      after: [],
      error: { code: 'MAP_TARGET_SET_EMPTY', message: '批量目标集合为空' }
    };
  }

  // 第一遍：解析全部 requested targets 到 canonical handles；任一缺失或歧义返回错误，staging 调用次数必须为零。
  const resolvedParts: MapPartEntity[] = [];
  const seenHandles = new Set<string>();

  for (const target of requestedTargets) {
    const res = sceneGraph.resolveEntity(target);
    if (!res.ok) {
      return {
        ok: false,
        mapId: doc.mapId,
        modifiedCount: 0,
        requestedCount: requestedTargets.length,
        resolvedCount: resolvedParts.length,
        effectiveCount: 0,
        targets: input.targets,
        before: [],
        after: [],
        error: {
          code: res.code,
          message: res.code === 'MAP_ENTITY_AMBIGUOUS'
            ? `目标存在名称歧义: ${target}`
            : `目标实体未找到: ${target}`
        }
      };
    }

    const entity = res.entity;
    if (entity.kind === 'region' && input.scaleMultiplier !== undefined) {
      return {
        ok: false,
        mapId: doc.mapId,
        modifiedCount: 0,
        requestedCount: requestedTargets.length,
        resolvedCount: resolvedParts.length,
        effectiveCount: 0,
        targets: input.targets,
        before: [],
        after: [],
        error: {
          code: 'MSB_REGION_SCALE_UNSUPPORTED',
          message: `MSB Region 不支持 scaleMultiplier 批量修改: ${target}`
        }
      };
    }
    if (entity.kind !== 'part') {
      return {
        ok: false,
        mapId: doc.mapId,
        modifiedCount: 0,
        requestedCount: requestedTargets.length,
        resolvedCount: resolvedParts.length,
        effectiveCount: 0,
        targets: input.targets,
        before: [],
        after: [],
        error: {
          code: 'MAP_NOT_A_PART',
          message: `目标实体不是 Part: ${target} (kind=${entity.kind})`
        }
      };
    }

    const part = entity as MapPartEntity;
    // 两个输入别名解析到同一个 handle 时返回 MAP_DUPLICATE_TARGET
    if (seenHandles.has(part.stableKey)) {
      return {
        ok: false,
        mapId: doc.mapId,
        modifiedCount: 0,
        requestedCount: requestedTargets.length,
        resolvedCount: resolvedParts.length,
        effectiveCount: 0,
        targets: input.targets,
        before: [],
        after: [],
        error: {
          code: 'MAP_DUPLICATE_TARGET',
          message: `两个输入别名解析到同一个 handle: ${target} (${part.stableKey})`
        }
      };
    }
    seenHandles.add(part.stableKey);
    resolvedParts.push(part);
  }

  // 浮点数合法性校验（非法 float 返回错误）
  const floats = [
    input.deltaX, input.deltaY, input.deltaZ,
    input.rotDeltaX, input.rotDeltaY, input.rotDeltaZ,
    input.scaleMultiplier
  ];
  for (const f of floats) {
    if (f !== undefined && !Number.isFinite(f)) {
      return {
        ok: false,
        mapId: doc.mapId,
        modifiedCount: 0,
        requestedCount: requestedTargets.length,
        resolvedCount: resolvedParts.length,
        effectiveCount: 0,
        targets: input.targets,
        before: [],
        after: [],
        error: {
          code: 'MAP_INVALID_TRANSFORM',
          message: `变换参数包含非法浮点数: ${f}`
        }
      };
    }
  }

  // 第二遍：计算目标值。positionDelta 与原 position 相加；scaleMultiplier 与原 Part scale 相乘；
  // 输入 rotation delta 的意义固定为当前接口原生 Euler 分量增量。
  const beforeList: Array<{ name: string; posX: number; posY: number; posZ: number }> = [];
  const operations: MapEditTransaction['operations'] = [];
  let effectiveCount = 0;

  for (const part of resolvedParts) {
    beforeList.push({
      name: part.name,
      posX: part.transform.position[0],
      posY: part.transform.position[1],
      posZ: part.transform.position[2]
    });

    const origPos = part.transform.position;
    const origRot = part.transform.rotation;
    const origScale = part.transform.scale;

    const newPosX = (input.deltaX !== undefined && input.deltaX !== 0)
      ? Math.round((origPos[0] + input.deltaX) * 1e4) / 1e4
      : origPos[0];
    const newPosY = (input.deltaY !== undefined && input.deltaY !== 0)
      ? Math.round((origPos[1] + input.deltaY) * 1e4) / 1e4
      : origPos[1];
    const newPosZ = (input.deltaZ !== undefined && input.deltaZ !== 0)
      ? Math.round((origPos[2] + input.deltaZ) * 1e4) / 1e4
      : origPos[2];

    const newRotX = (input.rotDeltaX !== undefined && input.rotDeltaX !== 0)
      ? Math.round((origRot[0] + input.rotDeltaX) * 1e4) / 1e4
      : origRot[0];
    const newRotY = (input.rotDeltaY !== undefined && input.rotDeltaY !== 0)
      ? Math.round((origRot[1] + input.rotDeltaY) * 1e4) / 1e4
      : origRot[1];
    const newRotZ = (input.rotDeltaZ !== undefined && input.rotDeltaZ !== 0)
      ? Math.round((origRot[2] + input.rotDeltaZ) * 1e4) / 1e4
      : origRot[2];

    const mult = input.scaleMultiplier ?? 1;
    const newScaleX = (mult !== 1)
      ? Math.round((origScale[0] * mult) * 1e4) / 1e4
      : origScale[0];
    const newScaleY = (mult !== 1)
      ? Math.round((origScale[1] * mult) * 1e4) / 1e4
      : origScale[1];
    const newScaleZ = (mult !== 1)
      ? Math.round((origScale[2] * mult) * 1e4) / 1e4
      : origScale[2];

    const hasPosChange = Math.abs(newPosX - origPos[0]) > 1e-5 || Math.abs(newPosY - origPos[1]) > 1e-5 || Math.abs(newPosZ - origPos[2]) > 1e-5;
    const hasRotChange = Math.abs(newRotX - origRot[0]) > 1e-5 || Math.abs(newRotY - origRot[1]) > 1e-5 || Math.abs(newRotZ - origRot[2]) > 1e-5;
    const hasScaleChange = Math.abs(newScaleX - origScale[0]) > 1e-5 || Math.abs(newScaleY - origScale[1]) > 1e-5 || Math.abs(newScaleZ - origScale[2]) > 1e-5;

    if (hasPosChange || hasRotChange || hasScaleChange) {
      effectiveCount++;
    }

    operations.push({
      kind: 'set_transform',
      target: part.stableKey,
      position: [newPosX, newPosY, newPosZ],
      rotation: [newRotX, newRotY, newRotZ],
      scale: [newScaleX, newScaleY, newScaleZ]
    });
  }

  // 零有效变化返回 no-op
  if (effectiveCount === 0) {
    return {
      ok: true,
      noop: true,
      mapId: doc.mapId,
      modifiedCount: 0,
      requestedCount: requestedTargets.length,
      resolvedCount: resolvedParts.length,
      effectiveCount: 0,
      targets: input.targets,
      before: beforeList,
      after: beforeList
    };
  }

  const transaction: MapEditTransaction = {
    id: `tx-batch-${Date.now()}`,
    mapId: doc.mapId,
    baseRevision: doc.revision,
    description: `批量变换 ${operations.length} 个地图 Part`,
    author: 'agent',
    operations,
    timestamp: Date.now()
  };

  // 传入刚读取的 lease 快照复用
  const setResult = await executeMapTransaction(edit, file, transaction, lease);
  if (!setResult.ok) {
    return {
      ok: false,
      mapId: doc.mapId,
      modifiedCount: 0,
      requestedCount: requestedTargets.length,
      resolvedCount: resolvedParts.length,
      effectiveCount,
      targets: input.targets,
      before: beforeList,
      after: [],
      error: setResult.error ?? { code: 'MAP_WRITE_FAILED', message: '地图事务写入失败。' }
    };
  }

  // 外层 afterList 从 verifiedPostState 生成，消除第四次 loadMapDocument
  const afterList: Array<{ name: string; posX: number; posY: number; posZ: number }> = [];
  const postSceneGraph = setResult.verifiedPostState?.sceneGraph;
  if (postSceneGraph) {
    for (const part of resolvedParts) {
      const actual = postSceneGraph.findPart(part.stableKey);
      if (actual) {
        afterList.push({
          name: actual.name,
          posX: actual.transform.position[0],
          posY: actual.transform.position[1],
          posZ: actual.transform.position[2]
        });
      }
    }
  }

  return {
    ok: true,
    mapId: doc.mapId,
    modifiedCount: effectiveCount,
    requestedCount: requestedTargets.length,
    resolvedCount: resolvedParts.length,
    effectiveCount,
    targets: input.targets,
    before: beforeList,
    after: afterList
  };
}

/**
 * Executes a full MapEditTransaction through validation, simulation, staging, Patch Engine commit, and authoritative reread verification.
 */
export async function executeMapTransaction(
  edit: NativeEditSession,
  file: string,
  transaction: MapEditTransaction,
  snapshot?: MapSnapshotLease
): Promise<MapTransactionResult> {
  let loaded: { ok: true; doc: MapDocument; sceneGraph: MapSceneGraph; filePath: string; lease?: MapSnapshotLease }
    | { ok: false; error: { code: string; message: string } };

  if (snapshot) {
    if (!isValidSnapshotLease(snapshot)) {
      return mapTransactionFailure(transaction.id, 'MAP_SNAPSHOT_INVALID', '无效或已释放的 MapSnapshotLease');
    }
    const resolvedInput = resolve(file);
    const resolvedSource = resolve(snapshot.sourceIdentity);
    if (resolvedInput !== resolvedSource && !resolvedSource.endsWith(file) && !resolvedInput.endsWith(snapshot.sourceIdentity)) {
      return mapTransactionFailure(transaction.id, 'MAP_SNAPSHOT_MISMATCH', `Snapshot 文件路径不匹配: ${file} vs ${snapshot.sourceIdentity}`);
    }
    if (snapshot.workspaceEpoch !== undefined && (edit.session as any)?.epoch !== undefined && snapshot.workspaceEpoch !== (edit.session as any).epoch) {
      return mapTransactionFailure(transaction.id, 'MAP_SNAPSHOT_STALE', '工作区版本已演进，当前 Snapshot 已过期');
    }
    loaded = {
      ok: true,
      doc: snapshot.doc,
      sceneGraph: snapshot.sceneGraph,
      filePath: resolvedSource,
      lease: snapshot
    };
  } else {
    loaded = await loadMapDocument(edit, file);
    if (!loaded.ok) {
      return {
        ok: false,
        transactionId: transaction.id,
        appliedOperations: 0,
        committed: false,
        verification: 'not_run',
        error: loaded.error
      };
    }
  }

  // Preflight validation
  const validation = validateMapTransaction(loaded.doc, transaction);
  if (!validation.valid) {
    return {
      ok: false,
      transactionId: transaction.id,
      appliedOperations: 0,
      committed: false,
      verification: 'not_run',
      error: {
        code: 'MAP_TRANSACTION_VALIDATION_FAILED',
        message: 'MapEditTransaction 校验未通过',
        details: validation.diagnostics
      }
    };
  }

  // All mutable state is keyed by canonical stableKey. Display names are only
  // aliases and may collide across MSB families.
  const workingParts = new Map<string, MapPartEntity>(
    loaded.doc.parts.map((part) => [part.stableKey, cloneMapEntity(part) as MapPartEntity])
  );
  const workingRegions = new Map<string, MapRegionEntity>(
    loaded.doc.regions.map((region) => [region.stableKey, cloneMapEntity(region) as MapRegionEntity])
  );
  const workingEvents = new Map<string, Extract<MapEntity, { kind: 'event' }>>(
    loaded.doc.events.map((event) => [event.stableKey, cloneMapEntity(event) as Extract<MapEntity, { kind: 'event' }>])
  );
  const expectedEntities = new Map<string, MapEntity>();
  const deletedKeys = new Set<string>();

  const mutations: MsbBridgeMutation[] = [];

  const resolveWorking = (target: string): { key: string; entity: MapEntity } | undefined => {
    const resolved = loaded.sceneGraph.resolveEntity(target);
    if (!resolved.ok) return undefined;
    const key = resolved.entity.stableKey;
    const entity = resolved.entity.kind === 'part'
      ? workingParts.get(key)
      : resolved.entity.kind === 'region'
        ? workingRegions.get(key)
        : resolved.entity.kind === 'event'
          ? workingEvents.get(key)
          : undefined;
    return entity ? { key, entity } : undefined;
  };

  const pushTransformMutation = (entity: MapPartEntity | MapRegionEntity): void => {
    const base = {
      family: entity.kind,
      nativeOffset: entity.nativeOffset,
      expectedName: entity.name,
      posX: entity.transform.position[0],
      posY: entity.transform.position[1],
      posZ: entity.transform.position[2],
      rotX: entity.transform.rotation[0],
      rotY: entity.transform.rotation[1],
      rotZ: entity.transform.rotation[2]
    };
    if (entity.kind === 'part') {
      mutations.push({
        kind: 'set_part_transform',
        ...base,
        scaleX: entity.transform.scale[0],
        scaleY: entity.transform.scale[1],
        scaleZ: entity.transform.scale[2]
      });
    } else {
      mutations.push({
        kind: 'set_region_transform',
        ...base
      });
    }
  };

  const applyTransform = (
    entity: MapPartEntity | MapRegionEntity,
    operation: Extract<MapEditTransaction['operations'][number], { kind: 'set_transform' }>
  ): void => {
    if (operation.position) entity.transform.position = [...operation.position];
    if (operation.rotation) entity.transform.rotation = [...operation.rotation];
    if (operation.scale && entity.kind !== 'region') entity.transform.scale = [...operation.scale];
  };

  const applyDelta = (
    entity: MapPartEntity | MapRegionEntity,
    operation: Extract<MapEditTransaction['operations'][number], { kind: 'batch_transform' }>
  ): void => {
    const positionDelta = operation.positionDelta;
    const rotationDelta = operation.rotationDelta;
    const scaleDelta = operation.scaleDelta;
    if (positionDelta) {
      entity.transform.position = entity.transform.position.map((value, index) => value + positionDelta[index]!) as [number, number, number];
    }
    if (rotationDelta) {
      entity.transform.rotation = entity.transform.rotation.map((value, index) => value + rotationDelta[index]!) as [number, number, number];
    }
    if (scaleDelta && entity.kind !== 'region') {
      entity.transform.scale = entity.transform.scale.map((value, index) => value + scaleDelta[index]!) as [number, number, number];
    }
  };

  for (const op of transaction.operations) {
    switch (op.kind) {
      case 'set_transform': {
        const resolved = resolveWorking(op.target);
        if (!resolved || (resolved.entity.kind !== 'part' && resolved.entity.kind !== 'region')) {
          return mapTransactionFailure(transaction.id, 'MAP_ENTITY_NOT_FOUND', `目标实体未找到或已被删除: ${op.target}`);
        }
        applyTransform(resolved.entity, op);
        pushTransformMutation(resolved.entity);
        expectedEntities.set(resolved.key, cloneMapEntity(resolved.entity));
        break;
      }
      case 'batch_transform': {
        for (const target of op.targets) {
          const resolved = resolveWorking(target);
          if (!resolved || (resolved.entity.kind !== 'part' && resolved.entity.kind !== 'region')) {
            return mapTransactionFailure(transaction.id, 'MAP_ENTITY_NOT_FOUND', `批量目标实体未找到或已被删除: ${target}`);
          }
          applyDelta(resolved.entity, op);
          pushTransformMutation(resolved.entity);
          expectedEntities.set(resolved.key, cloneMapEntity(resolved.entity));
        }
        break;
      }
      case 'set_property': {
        const resolved = resolveWorking(op.target);
        if (!resolved || (resolved.entity.kind !== 'part' && resolved.entity.kind !== 'region')) {
          return mapTransactionFailure(transaction.id, 'MAP_ENTITY_NOT_FOUND', `属性修改目标实体未找到或已被删除: ${op.target}`);
        }
        if (op.property !== 'entityId' || typeof op.value !== 'number') {
          return mapTransactionFailure(transaction.id, 'MAP_PROPERTY_UNSUPPORTED', `不支持的属性修改: ${op.property}`);
        }
        resolved.entity.entityId = op.value;
        mutations.push({
          kind: 'set_property',
          family: resolved.entity.kind,
          nativeOffset: resolved.entity.nativeOffset,
          expectedName: resolved.entity.name,
          entityId: op.value
        });
        expectedEntities.set(resolved.key, cloneMapEntity(resolved.entity));
        break;
      }
      case 'change_model': {
        const resolved = resolveWorking(op.target);
        if (!resolved || resolved.entity.kind !== 'part') {
          return mapTransactionFailure(transaction.id, 'MAP_PART_NOT_FOUND', `修改模型目标 Part 未找到或已被删除: ${op.target}`);
        }
        resolved.entity.modelName = op.newModelName;
        mutations.push({
          kind: 'change_model',
          family: 'part',
          nativeOffset: resolved.entity.nativeOffset,
          expectedName: resolved.entity.name,
          modelName: op.newModelName
        });
        expectedEntities.set(resolved.key, cloneMapEntity(resolved.entity));
        break;
      }
      case 'delete': {
        const resolved = resolveWorking(op.target);
        if (!resolved || (resolved.entity.kind !== 'part'
          && resolved.entity.kind !== 'region'
          && resolved.entity.kind !== 'event')) {
          return mapTransactionFailure(transaction.id, 'MAP_ENTITY_NOT_FOUND', `删除目标实体未找到或已被删除: ${op.target}`);
        }
        if (!op.certificate || !op.certificate.complete) {
          return mapTransactionFailure(transaction.id, 'MSB_REFERENCE_COVERAGE_INCOMPLETE', `MSB 结构删除引用闭包尚未完成，删除已被安全门禁拦截: ${op.target}`);
        }
        if (resolved.entity.kind === 'part') {
          workingParts.delete(resolved.key);
          mutations.push({
            kind: 'delete_part', family: 'part', nativeOffset: resolved.entity.nativeOffset,
            expectedName: resolved.entity.name,
            certificate: op.certificate
          } as any);
        } else if (resolved.entity.kind === 'region') {
          workingRegions.delete(resolved.key);
          mutations.push({
            kind: 'delete_region', family: 'region', nativeOffset: resolved.entity.nativeOffset,
            expectedName: resolved.entity.name,
            certificate: op.certificate
          } as any);
        } else {
          workingEvents.delete(resolved.key);
          mutations.push({
            kind: 'delete_event', family: 'event', nativeOffset: resolved.entity.nativeOffset,
            expectedName: resolved.entity.name,
            certificate: op.certificate
          } as any);
        }
        expectedEntities.delete(resolved.key);
        deletedKeys.add(resolved.key);
        break;
      }
      case 'set_region_shape': {
        const resolved = resolveWorking(op.target);
        if (!resolved || resolved.entity.kind !== 'region') {
          return mapTransactionFailure(transaction.id, 'MAP_REGION_NOT_FOUND', `目标 Region 未找到或已被删除: ${op.target}`);
        }
        const val = validateRegionShape(op.shape);
        if (!val.valid) {
          return mapTransactionFailure(transaction.id, 'SHAPE_OPERATION_UNSUPPORTED', val.error ?? '不支持的 Region Shape 尺寸操作');
        }
        resolved.entity.shapeData = op.shape;
        mutations.push({
          kind: 'set_region_shape' as any,
          family: 'region',
          nativeOffset: resolved.entity.nativeOffset,
          expectedName: resolved.entity.name,
          shape: op.shape
        } as any);
        expectedEntities.set(resolved.key, cloneMapEntity(resolved.entity));
        break;
      }
    }
  }

  if (mutations.length === 0) {
    return {
      ok: true,
      transactionId: transaction.id,
      appliedOperations: 0,
      revision: loaded.doc.revision,
      committed: false,
      verification: 'not_run'
    };
  }

  const fileEntry = await edit.indexFile(loaded.filePath, 'map');
  // MapDocument.revision is the native MSB payload hash. Patch Engine's
  // file_replace precondition must instead bind the actual target bytes, which
  // are the outer DCX bytes for `.msb.dcx`. Keep both identities explicit so a
  // valid native writer result is not rejected (or, worse, checked against the
  // wrong layer) before commit.
  const expectedDocumentHash = loaded.doc.revision;
  const expectedFileHash = fileEntry.sha256;
  if (!expectedFileHash) {
    return mapTransactionFailure(
      transaction.id,
      'MAP_FILE_HASH_REQUIRED',
      'MSB 写回需要当前外层文件哈希；索引未提供哈希，已失败关闭。'
    );
  }

  if (snapshot?.sourceFileHash && fileEntry.sha256 && snapshot.sourceFileHash !== fileEntry.sha256) {
    return mapTransactionFailure(
      transaction.id,
      'MAP_SOURCE_MODIFIED',
      `源文件哈希已改变 (快照: ${snapshot.sourceFileHash}, 当前: ${fileEntry.sha256})，拒绝写入。`
    );
  }

  // Single batch staging & Patch commit
  const outcome = await applyNativeMutation({
    file: { ...fileEntry, sha256: expectedFileHash },
    sourceUri: fileEntry.sourceUri,
    expectedHash: expectedFileHash,
    stagingRoot: edit.stagingRoot,
    allowedRoots: () => [...edit.allowedRoots()],
    stagingPrefix: 'msb',
    stagingFileName: `${basename(loaded.filePath)}.mut.msb`,
    stageWrite: (context) => commitMsbMutationViaBridge({
      sourcePath: loaded.filePath,
      outputPath: context.outputPath,
      expectedDocumentHash,
      allowedRoots: context.allowedRoots,
      writableRoots: context.writableRoots,
      mutations,
      ...(edit.oodleRuntimeRoot ? { oodleRuntimeRoot: edit.oodleRuntimeRoot } : {}),
      timeoutMs: 120_000
    }),
    title: `MSB transaction [${transaction.id}] (${mutations.length} mutations)`,
    confirmActionLabel: '提交 MSB 地图事务'
  }, {
    ...(edit.confirmationPort ? { confirm: edit.confirmationPort } : {}),
    commit: edit.commitPort
  });

  if (outcome.status !== 'committed' || !outcome.result.ok) {
    const diagnostics = outcome.status === 'failed'
      ? outcome.diagnostics
      : outcome.status === 'committed'
        ? outcome.result.diagnostics
        : [{ severity: 'error' as const, code: 'MSB_WRITE_CANCELLED', message: '写入被取消。', sourceUri: fileEntry.sourceUri }];
    return {
      ok: false,
      transactionId: transaction.id,
      appliedOperations: 0,
      committed: false,
      verification: 'not_run',
      error: {
        code: diagnostics[0]?.code ?? 'MSB_WRITE_FAILED',
        message: diagnostics[0]?.message ?? 'MSB 写入失败。',
        details: diagnostics
      }
    };
  }

  // Authoritative reread postcondition verification
  const reread = await loadMapDocument(edit, file);
  if (!reread.ok) {
    return {
      ok: false,
      transactionId: transaction.id,
      appliedOperations: transaction.operations.length,
      committed: true,
      verification: 'failed',
      error: {
        code: 'MAP_REREAD_FAILED',
        message: 'MSB 提交后重读失败，无法确认写回状态'
      }
    };
  }

  // Verify only touched entities, using stableKey identity rather than a
  // potentially duplicated display name.
  for (const key of deletedKeys) {
    if (reread.sceneGraph.findEntity(key)) {
      return mapTransactionFailure(
        transaction.id,
        'MAP_POSTCONDITION_FAILED',
        `删除后实体仍存在: ${key}`,
        transaction.operations.length,
        true
      );
    }
  }
  for (const [key, expected] of expectedEntities) {
    const actual = reread.sceneGraph.findEntity(key);
    if (!actual) {
      return mapTransactionFailure(
        transaction.id,
        'MAP_POSTCONDITION_FAILED',
        `写回后缺少实体: ${key}`,
        transaction.operations.length,
        true
      );
    }
    if ('transform' in expected && 'transform' in actual
      && !sameTransform(expected.transform, actual.transform)) {
      return mapTransactionFailure(
        transaction.id,
        'MAP_POSTCONDITION_FAILED',
        `实体 ${key} 变换写回后与预期不符`,
        transaction.operations.length,
        true
      );
    }
    if (expected.kind === 'part' && actual.kind === 'part') {
      if (expected.modelName !== actual.modelName) {
        return mapTransactionFailure(transaction.id, 'MAP_POSTCONDITION_FAILED', `Part ${key} 模型写回后与预期不符`, transaction.operations.length, true);
      }
      if (expected.entityId !== undefined && actual.entityId !== expected.entityId) {
        return mapTransactionFailure(transaction.id, 'MAP_POSTCONDITION_FAILED', `Part ${key} entityId 写回后与预期不符`, transaction.operations.length, true);
      }
    }
    if (expected.kind === 'region' && actual.kind === 'region'
      && expected.entityId !== undefined && actual.entityId !== expected.entityId) {
      return mapTransactionFailure(transaction.id, 'MAP_POSTCONDITION_FAILED', `Region ${key} entityId 写回后与预期不符`, transaction.operations.length, true);
    }
  }

  const touchedEntities = Array.from(expectedEntities.keys())
    .map(key => reread.sceneGraph.findEntity(key)!)
    .filter(Boolean);

  return {
    ok: true,
    transactionId: transaction.id,
    appliedOperations: transaction.operations.length,
    revision: reread.doc.revision,
    committed: true,
    verification: 'passed',
    verifiedPostState: {
      sourceVersion: reread.doc.revision,
      touchedEntities,
      sceneGraph: reread.sceneGraph,
      doc: reread.doc
    }
  };
}

function cloneMapEntity(entity: MapEntity): MapEntity {
  if (entity.kind === 'part') {
    return {
      ...entity,
      transform: {
        position: [...entity.transform.position] as [number, number, number],
        rotation: [...entity.transform.rotation] as [number, number, number],
        scale: [...entity.transform.scale] as [number, number, number]
      }
    };
  }
  if (entity.kind === 'region') {
    return {
      ...entity,
      transform: {
        position: [...entity.transform.position] as [number, number, number],
        rotation: [...entity.transform.rotation] as [number, number, number]
      }
    };
  }
  return { ...entity };
}

function sameTransform(
  left: MapPartEntity['transform'] | MapRegionTransform,
  right: MapPartEntity['transform'] | MapRegionTransform
): boolean {
  if (
    Math.abs(left.position[0] - right.position[0]) > 0.001 ||
    Math.abs(left.position[1] - right.position[1]) > 0.001 ||
    Math.abs(left.position[2] - right.position[2]) > 0.001 ||
    Math.abs(left.rotation[0] - right.rotation[0]) > 0.001 ||
    Math.abs(left.rotation[1] - right.rotation[1]) > 0.001 ||
    Math.abs(left.rotation[2] - right.rotation[2]) > 0.001
  ) {
    return false;
  }
  const leftScale = 'scale' in left ? left.scale : undefined;
  const rightScale = 'scale' in right ? right.scale : undefined;
  if (leftScale && rightScale) {
    return (
      Math.abs(leftScale[0] - rightScale[0]) <= 0.001 &&
      Math.abs(leftScale[1] - rightScale[1]) <= 0.001 &&
      Math.abs(leftScale[2] - rightScale[2]) <= 0.001
    );
  }
  return leftScale === undefined && rightScale === undefined;
}

function mapTransactionFailure(
  transactionId: string,
  code: string,
  message: string,
  appliedOperations = 0,
  committed = false
): MapTransactionResult {
  return {
    ok: false,
    transactionId,
    appliedOperations,
    committed,
    verification: committed ? 'failed' : 'not_run',
    error: { code, message }
  };
}
