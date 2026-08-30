/**
 * Map Service: High-level operations on MapDocument, SceneGraph, and MapEditTransactions.
 *
 * Exposes unified query, inspect, batch transform, and transaction execution
 * for Agent tools, Desktop IPC, and future Blender bridges.
 */

import { basename } from 'node:path';
import {
  buildCanonicalMapDocument,
  MapSceneGraph,
  validateMapTransaction,
  type MapDocument,
  type MapEditTransaction,
  type MapEntity,
  type MapPartEntity,
  type MapRegionEntity
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
  error?: { code: string; message: string };
}

export interface MapInspectResult {
  ok: boolean;
  mapId: string;
  entity?: MapEntity;
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
  /** Whether Patch Engine accepted the staged payload. */
  committed?: boolean;
  /** Whether the post-commit native reread verified the requested state. */
  verification?: 'passed' | 'failed' | 'not_run';
  error?: { code: string; message: string; details?: unknown };
}

/**
 * Loads a full MapDocument from disk via Bridge without truncation.
 */
export async function loadMapDocument(
  edit: NativeEditSession,
  file: string
): Promise<{ ok: true; doc: MapDocument; sceneGraph: MapSceneGraph; filePath: string } | { ok: false; error: { code: string; message: string } }> {
  const overlay = edit.session.layers.overlayRoot;
  const candidates = [file, `${overlay}/${file}`, `${overlay}/map/${file}`];

  let resolvedPath = file;
  let mapId = basename(file).replace(/\.msb(\.dcx)?$/i, '');

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
      sourceUri: `map://${mapId}/${basename(file)}`,
      sourcePath: file,
      game: 'sekiro',
      revision: readResult.data.sourceHash || '1',
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
  return { ok: true, doc, sceneGraph, filePath: resolvedPath };
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
  }
): Promise<MapQueryResult> {
  const loaded = await loadMapDocument(edit, file);
  if (!loaded.ok) {
    return { ok: false, mapId: '', totalEntities: 0, matchedEntities: [], error: loaded.error };
  }

  const { doc, sceneGraph } = loaded;
  let matched: MapEntity[] = [];

  if (query.modelName) {
    matched = sceneGraph.queryPartsByModel(query.modelName);
  } else if (query.entityId !== undefined) {
    matched = sceneGraph.queryByEntityId(query.entityId);
  } else if (query.regionName) {
    matched = sceneGraph.queryEventsReferencingRegion(query.regionName);
  } else if (query.kind === 'part') {
    matched = doc.parts;
  } else if (query.kind === 'region') {
    matched = doc.regions;
  } else if (query.kind === 'model') {
    matched = doc.models;
  } else if (query.kind === 'event') {
    matched = doc.events;
  } else if (query.kind === 'route') {
    matched = doc.routes;
  } else {
    matched = [
      ...doc.models,
      ...doc.parts,
      ...doc.regions,
      ...doc.events,
      ...doc.routes
    ];
  }

  if (query.nameContains) {
    const filter = query.nameContains.toLowerCase();
    matched = matched.filter((e) => e.name.toLowerCase().includes(filter));
  }

  return {
    ok: true,
    mapId: doc.mapId,
    totalEntities: doc.totalEntityCount,
    matchedEntities: matched
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
  }
): Promise<MapBatchTransformResult> {
  const loaded = await loadMapDocument(edit, file);
  if (!loaded.ok) {
    return {
      ok: false,
      mapId: '',
      modifiedCount: 0,
      targets: input.targets,
      before: [],
      after: [],
      error: loaded.error
    };
  }

  const { doc, sceneGraph } = loaded;
  const beforeList: Array<{ name: string; posX: number; posY: number; posZ: number }> = [];
  const operations: MapEditTransaction['operations'] = [];

  for (const target of input.targets) {
    const part = sceneGraph.findPart(target);
    if (!part) continue;

    beforeList.push({
      name: part.name,
      posX: part.transform.position[0],
      posY: part.transform.position[1],
      posZ: part.transform.position[2]
    });

    const newPosX = part.transform.position[0] + (input.deltaX ?? 0);
    const newPosY = part.transform.position[1] + (input.deltaY ?? 0);
    const newPosZ = part.transform.position[2] + (input.deltaZ ?? 0);

    const newRotX = part.transform.rotation[0] + (input.rotDeltaX ?? 0);
    const newRotY = part.transform.rotation[1] + (input.rotDeltaY ?? 0);
    const newRotZ = part.transform.rotation[2] + (input.rotDeltaZ ?? 0);

    const mult = input.scaleMultiplier ?? 1;
    const newScaleX = part.transform.scale[0] * mult;
    const newScaleY = part.transform.scale[1] * mult;
    const newScaleZ = part.transform.scale[2] * mult;

    operations.push({
      kind: 'set_transform',
      target: part.stableKey,
      position: [
        Math.round(newPosX * 1e4) / 1e4,
        Math.round(newPosY * 1e4) / 1e4,
        Math.round(newPosZ * 1e4) / 1e4
      ],
      rotation: [
        Math.round(newRotX * 1e4) / 1e4,
        Math.round(newRotY * 1e4) / 1e4,
        Math.round(newRotZ * 1e4) / 1e4
      ],
      scale: [
        Math.round(newScaleX * 1e4) / 1e4,
        Math.round(newScaleY * 1e4) / 1e4,
        Math.round(newScaleZ * 1e4) / 1e4
      ]
    });
  }

  if (operations.length === 0) {
    return {
      ok: false,
      mapId: doc.mapId,
      modifiedCount: 0,
      targets: input.targets,
      before: [],
      after: [],
      error: { code: 'MAP_NO_VALID_TARGETS', message: '没有找到有效的 Part 目标进行变换' }
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
  const setResult = await executeMapTransaction(edit, file, transaction);
  if (!setResult.ok) {
    return {
      ok: false,
      mapId: doc.mapId,
      modifiedCount: 0,
      targets: input.targets,
      before: beforeList,
      after: [],
      error: setResult.error ?? { code: 'MAP_WRITE_FAILED', message: '地图事务写入失败。' }
    };
  }

  const reread = await loadMapDocument(edit, file);
  if (!reread.ok) {
    return {
      ok: false,
      mapId: doc.mapId,
      modifiedCount: operations.length,
      targets: input.targets,
      before: beforeList,
      after: [],
      error: reread.error
    };
  }
  const afterList = operations.flatMap((operation) => {
    if (operation.kind !== 'set_transform') return [];
    const part = reread.sceneGraph.findPart(operation.target);
    return part ? [{
      name: part.name,
      posX: part.transform.position[0],
      posY: part.transform.position[1],
      posZ: part.transform.position[2]
    }] : [];
  });

  return {
    ok: true,
    mapId: doc.mapId,
    modifiedCount: operations.length,
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
  transaction: MapEditTransaction
): Promise<MapTransactionResult> {
  const loaded = await loadMapDocument(edit, file);
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
      rotZ: entity.transform.rotation[2],
      scaleX: entity.transform.scale[0],
      scaleY: entity.transform.scale[1],
      scaleZ: entity.transform.scale[2]
    };
    mutations.push(entity.kind === 'part'
      ? { kind: 'set_part_transform', ...base }
      : { kind: 'set_region_transform', ...base });
  };

  const applyTransform = (
    entity: MapPartEntity | MapRegionEntity,
    operation: Extract<MapEditTransaction['operations'][number], { kind: 'set_transform' }>
  ): void => {
    if (operation.position) entity.transform.position = [...operation.position];
    if (operation.rotation) entity.transform.rotation = [...operation.rotation];
    if (operation.scale) entity.transform.scale = [...operation.scale];
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
    if (scaleDelta) {
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
        if (resolved.entity.kind === 'part') {
          workingParts.delete(resolved.key);
          mutations.push({
            kind: 'delete_part', family: 'part', nativeOffset: resolved.entity.nativeOffset,
            expectedName: resolved.entity.name
          });
        } else if (resolved.entity.kind === 'region') {
          workingRegions.delete(resolved.key);
          mutations.push({
            kind: 'delete_region', family: 'region', nativeOffset: resolved.entity.nativeOffset,
            expectedName: resolved.entity.name
          });
        } else {
          workingEvents.delete(resolved.key);
          mutations.push({
            kind: 'delete_event', family: 'event', nativeOffset: resolved.entity.nativeOffset,
            expectedName: resolved.entity.name
          });
        }
        expectedEntities.delete(resolved.key);
        deletedKeys.add(resolved.key);
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

  return {
    ok: true,
    transactionId: transaction.id,
    appliedOperations: transaction.operations.length,
    revision: reread.doc.revision,
    committed: true,
    verification: 'passed'
  };
}

function cloneMapEntity(entity: MapEntity): MapEntity {
  if (entity.kind === 'part' || entity.kind === 'region') {
    return {
      ...entity,
      transform: {
        position: [...entity.transform.position] as [number, number, number],
        rotation: [...entity.transform.rotation] as [number, number, number],
        scale: [...entity.transform.scale] as [number, number, number]
      }
    };
  }
  return { ...entity };
}

function sameTransform(
  left: MapPartEntity['transform'],
  right: MapPartEntity['transform']
): boolean {
  return [...left.position, ...left.rotation, ...left.scale]
    .every((value, index) => Math.abs(value - [...right.position, ...right.rotation, ...right.scale][index]!) <= 0.001);
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
