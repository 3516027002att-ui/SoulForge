/**
 * Map Service: High-level operations on MapDocument, SceneGraph, and MapEditTransactions.
 *
 * Exposes unified query, inspect, batch transform, and transaction execution
 * for Agent tools, Desktop IPC, and future Blender bridges.
 */

import { basename } from 'node:path';
import {
  buildCanonicalMapDocument,
  exportMapSceneForBlender,
  importBlenderDeltaToTransaction,
  MapSceneGraph,
  validateMapTransaction,
  type BlenderDeltaImport,
  type BlenderSceneExport,
  type MapDocument,
  type MapEditTransaction,
  type MapEntity,
  type MapPartEntity,
  type MapRegionEntity
} from '@soulforge/shared';
import { readMsbDocumentViaBridge } from './msbBridgeRead.js';
import type { NativeEditSession } from './nativeEditSession.js';
import { setMsbPartTransform, type MsbPartTransformEdit } from './msbEdit.js';
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

  const doc = buildCanonicalMapDocument({
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
  const edits: MsbPartTransformEdit[] = [];
  const beforeList: Array<{ name: string; posX: number; posY: number; posZ: number }> = [];

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

    edits.push({
      address: part.address,
      posX: Math.round(newPosX * 1e4) / 1e4,
      posY: Math.round(newPosY * 1e4) / 1e4,
      posZ: Math.round(newPosZ * 1e4) / 1e4,
      rotX: Math.round(newRotX * 1e4) / 1e4,
      rotY: Math.round(newRotY * 1e4) / 1e4,
      rotZ: Math.round(newRotZ * 1e4) / 1e4,
      scaleX: Math.round(newScaleX * 1e4) / 1e4,
      scaleY: Math.round(newScaleY * 1e4) / 1e4,
      scaleZ: Math.round(newScaleZ * 1e4) / 1e4
    });
  }

  if (edits.length === 0) {
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

  const setResult = await setMsbPartTransform({
    edit,
    file,
    edits
  });

  if (!setResult.ok) {
    return {
      ok: false,
      mapId: doc.mapId,
      modifiedCount: 0,
      targets: input.targets,
      before: beforeList,
      after: [],
      error: setResult.error
    };
  }

  const afterList = setResult.after.map((p) => ({
    name: p.name,
    posX: p.posX,
    posY: p.posY,
    posZ: p.posZ
  }));

  return {
    ok: true,
    mapId: doc.mapId,
    modifiedCount: setResult.mutations,
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
): Promise<{
  ok: boolean;
  transactionId: string;
  appliedOperations: number;
  revision?: string;
  error?: { code: string; message: string; details?: unknown };
}> {
  const loaded = await loadMapDocument(edit, file);
  if (!loaded.ok) {
    return { ok: false, transactionId: transaction.id, appliedOperations: 0, error: loaded.error };
  }

  // Preflight validation
  const validation = validateMapTransaction(loaded.doc, transaction);
  if (!validation.valid) {
    return {
      ok: false,
      transactionId: transaction.id,
      appliedOperations: 0,
      error: {
        code: 'MAP_TRANSACTION_VALIDATION_FAILED',
        message: 'MapEditTransaction 校验未通过',
        details: validation.diagnostics
      }
    };
  }

  // Working simulation state
  const workingParts = new Map(loaded.doc.parts.map((p) => [p.name, {
    ...p,
    transform: {
      position: [...p.transform.position] as [number, number, number],
      rotation: [...p.transform.rotation] as [number, number, number],
      scale: [...p.transform.scale] as [number, number, number]
    }
  }]));
  const workingRegions = new Map(loaded.doc.regions.map((r) => [r.name, {
    ...r,
    transform: {
      position: [...r.transform.position] as [number, number, number],
      rotation: [...r.transform.rotation] as [number, number, number],
      scale: [...r.transform.scale] as [number, number, number]
    }
  }]));
  const workingEvents = new Map(loaded.doc.events.map((e) => [e.name, { ...e }]));

  const mutations: MsbBridgeMutation[] = [];

  for (const op of transaction.operations) {
    switch (op.kind) {
      case 'set_transform': {
        const part = workingParts.get(op.target);
        if (part) {
          if (op.position) part.transform.position = [...op.position];
          if (op.rotation) part.transform.rotation = [...op.rotation];
          if (op.scale) part.transform.scale = [...op.scale];
          mutations.push({
            kind: 'set_part_transform',
            partName: part.name,
            posX: part.transform.position[0],
            posY: part.transform.position[1],
            posZ: part.transform.position[2],
            rotX: part.transform.rotation[0],
            rotY: part.transform.rotation[1],
            rotZ: part.transform.rotation[2],
            scaleX: part.transform.scale[0],
            scaleY: part.transform.scale[1],
            scaleZ: part.transform.scale[2]
          });
          break;
        }
        const region = workingRegions.get(op.target);
        if (region) {
          if (op.position) region.transform.position = [...op.position];
          if (op.rotation) region.transform.rotation = [...op.rotation];
          if (op.scale) region.transform.scale = [...op.scale];
          mutations.push({
            kind: 'set_region_transform',
            partName: region.name,
            posX: region.transform.position[0],
            posY: region.transform.position[1],
            posZ: region.transform.position[2],
            rotX: region.transform.rotation[0],
            rotY: region.transform.rotation[1],
            rotZ: region.transform.rotation[2],
            scaleX: region.transform.scale[0],
            scaleY: region.transform.scale[1],
            scaleZ: region.transform.scale[2]
          });
          break;
        }
        return {
          ok: false,
          transactionId: transaction.id,
          appliedOperations: 0,
          error: { code: 'MAP_ENTITY_NOT_FOUND', message: `目标实体未找到或已被删除: ${op.target}` }
        };
      }
      case 'batch_transform': {
        for (const target of op.targets) {
          const part = workingParts.get(target);
          if (part) {
            if (op.positionDelta) {
              part.transform.position[0] += op.positionDelta[0];
              part.transform.position[1] += op.positionDelta[1];
              part.transform.position[2] += op.positionDelta[2];
            }
            if (op.rotationDelta) {
              part.transform.rotation[0] += op.rotationDelta[0];
              part.transform.rotation[1] += op.rotationDelta[1];
              part.transform.rotation[2] += op.rotationDelta[2];
            }
            if (op.scaleDelta) {
              part.transform.scale[0] += op.scaleDelta[0];
              part.transform.scale[1] += op.scaleDelta[1];
              part.transform.scale[2] += op.scaleDelta[2];
            }
            mutations.push({
              kind: 'set_part_transform',
              partName: part.name,
              posX: part.transform.position[0],
              posY: part.transform.position[1],
              posZ: part.transform.position[2],
              rotX: part.transform.rotation[0],
              rotY: part.transform.rotation[1],
              rotZ: part.transform.rotation[2],
              scaleX: part.transform.scale[0],
              scaleY: part.transform.scale[1],
              scaleZ: part.transform.scale[2]
            });
            continue;
          }
          const region = workingRegions.get(target);
          if (region) {
            if (op.positionDelta) {
              region.transform.position[0] += op.positionDelta[0];
              region.transform.position[1] += op.positionDelta[1];
              region.transform.position[2] += op.positionDelta[2];
            }
            if (op.rotationDelta) {
              region.transform.rotation[0] += op.rotationDelta[0];
              region.transform.rotation[1] += op.rotationDelta[1];
              region.transform.rotation[2] += op.rotationDelta[2];
            }
            if (op.scaleDelta) {
              region.transform.scale[0] += op.scaleDelta[0];
              region.transform.scale[1] += op.scaleDelta[1];
              region.transform.scale[2] += op.scaleDelta[2];
            }
            mutations.push({
              kind: 'set_region_transform',
              partName: region.name,
              posX: region.transform.position[0],
              posY: region.transform.position[1],
              posZ: region.transform.position[2],
              rotX: region.transform.rotation[0],
              rotY: region.transform.rotation[1],
              rotZ: region.transform.rotation[2],
              scaleX: region.transform.scale[0],
              scaleY: region.transform.scale[1],
              scaleZ: region.transform.scale[2]
            });
            continue;
          }
          return {
            ok: false,
            transactionId: transaction.id,
            appliedOperations: 0,
            error: { code: 'MAP_ENTITY_NOT_FOUND', message: `批量目标实体未找到或已被删除: ${target}` }
          };
        }
        break;
      }
      case 'set_property': {
        if (op.property === 'entityId' && typeof op.value === 'number') {
          const part = workingParts.get(op.target);
          if (part) {
            part.entityId = op.value;
            mutations.push({ kind: 'set_property', partName: part.name, entityId: op.value });
            break;
          }
          const region = workingRegions.get(op.target);
          if (region) {
            region.entityId = op.value;
            mutations.push({ kind: 'set_property', partName: region.name, entityId: op.value });
            break;
          }
          const event = workingEvents.get(op.target);
          if (event) {
            event.entityId = op.value;
            mutations.push({ kind: 'set_property', partName: event.name, entityId: op.value });
            break;
          }
          return {
            ok: false,
            transactionId: transaction.id,
            appliedOperations: 0,
            error: { code: 'MAP_ENTITY_NOT_FOUND', message: `属性修改目标实体未找到或已被删除: ${op.target}` }
          };
        }
        return {
          ok: false,
          transactionId: transaction.id,
          appliedOperations: 0,
          error: { code: 'MAP_PROPERTY_UNSUPPORTED', message: `不支持的属性修改: ${op.property}` }
        };
      }
      case 'change_model': {
        const part = workingParts.get(op.target);
        if (!part) {
          return {
            ok: false,
            transactionId: transaction.id,
            appliedOperations: 0,
            error: { code: 'MAP_PART_NOT_FOUND', message: `修改模型目标 Part 未找到或已被删除: ${op.target}` }
          };
        }
        part.modelName = op.newModelName;
        mutations.push({
          kind: 'change_model',
          partName: part.name,
          modelName: op.newModelName
        });
        break;
      }
      case 'delete': {
        if (workingParts.has(op.target)) {
          workingParts.delete(op.target);
          mutations.push({ kind: 'delete_part', partName: op.target });
          break;
        }
        if (workingRegions.has(op.target)) {
          workingRegions.delete(op.target);
          mutations.push({ kind: 'delete_region', partName: op.target });
          break;
        }
        if (workingEvents.has(op.target)) {
          workingEvents.delete(op.target);
          mutations.push({ kind: 'delete_event', partName: op.target });
          break;
        }
        return {
          ok: false,
          transactionId: transaction.id,
          appliedOperations: 0,
          error: { code: 'MAP_ENTITY_NOT_FOUND', message: `删除目标实体未找到或已被删除: ${op.target}` }
        };
      }
    }
  }

  if (mutations.length === 0) {
    return {
      ok: true,
      transactionId: transaction.id,
      appliedOperations: 0,
      revision: loaded.doc.revision
    };
  }

  const fileEntry = await edit.indexFile(loaded.filePath, 'map');
  const expectedHash = loaded.doc.revision;

  // Single batch staging & Patch commit
  const outcome = await applyNativeMutation({
    file: { ...fileEntry, sha256: expectedHash },
    sourceUri: fileEntry.sourceUri,
    expectedHash,
    stagingRoot: edit.stagingRoot,
    allowedRoots: () => [...edit.allowedRoots()],
    stagingPrefix: 'msb',
    stagingFileName: `${basename(loaded.filePath)}.mut.msb`,
    stageWrite: (context) => commitMsbMutationViaBridge({
      sourcePath: loaded.filePath,
      outputPath: context.outputPath,
      expectedDocumentHash: expectedHash,
      allowedRoots: context.allowedRoots,
      writableRoots: context.writableRoots,
      mutations,
      ...(edit.oodleRuntimeRoot ? { oodleRuntimeRoot: edit.oodleRuntimeRoot } : {}),
      timeoutMs: 120_000
    }),
    title: `MSB transaction [${transaction.id}] (${mutations.length} mutations)`,
    confirmActionLabel: '提交 MSB 地图事务'
  }, { commit: edit.commitPort });

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
      error: {
        code: 'MAP_REREAD_FAILED',
        message: 'MSB 提交后重读失败，无法确认写回状态'
      }
    };
  }

  // Verify all working entities match reread
  for (const [name, expectedPart] of workingParts) {
    const actual = reread.sceneGraph.findPart(name);
    if (!actual) {
      return {
        ok: false,
        transactionId: transaction.id,
        appliedOperations: transaction.operations.length,
        error: { code: 'MAP_POSTCONDITION_FAILED', message: `写回后缺少 Part: ${name}` }
      };
    }
    if (Math.abs(actual.transform.position[0] - expectedPart.transform.position[0]) > 0.001 ||
        Math.abs(actual.transform.position[1] - expectedPart.transform.position[1]) > 0.001 ||
        Math.abs(actual.transform.position[2] - expectedPart.transform.position[2]) > 0.001) {
      return {
        ok: false,
        transactionId: transaction.id,
        appliedOperations: transaction.operations.length,
        error: { code: 'MAP_POSTCONDITION_FAILED', message: `Part ${name} 坐标写回后与预期不符` }
      };
    }
    if (expectedPart.modelName && actual.modelName !== expectedPart.modelName) {
      return {
        ok: false,
        transactionId: transaction.id,
        appliedOperations: transaction.operations.length,
        error: { code: 'MAP_POSTCONDITION_FAILED', message: `Part ${name} 模型写回后与预期不符` }
      };
    }
    if (expectedPart.entityId !== undefined && actual.entityId !== expectedPart.entityId) {
      return {
        ok: false,
        transactionId: transaction.id,
        appliedOperations: transaction.operations.length,
        error: { code: 'MAP_POSTCONDITION_FAILED', message: `Part ${name} entityId 写回后与预期不符` }
      };
    }
  }

  return {
    ok: true,
    transactionId: transaction.id,
    appliedOperations: transaction.operations.length,
    revision: reread.doc.revision
  };
}
