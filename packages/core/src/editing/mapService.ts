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
 * Executes a full MapEditTransaction through validation, staging, and Patch Engine commit.
 */
export async function executeMapTransaction(
  edit: NativeEditSession,
  file: string,
  transaction: MapEditTransaction
): Promise<{ ok: boolean; transactionId: string; appliedOperations: number; error?: { code: string; message: string; details?: unknown } }> {
  const loaded = await loadMapDocument(edit, file);
  if (!loaded.ok) {
    return { ok: false, transactionId: transaction.id, appliedOperations: 0, error: loaded.error };
  }

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

  // Translate operations to Bridge mutations
  const mutations: MsbBridgeMutation[] = [];
  for (const op of transaction.operations) {
    if (op.kind === 'set_transform') {
      const entity = loaded.sceneGraph.findEntity(op.target);
      if (entity) {
        if (entity.kind === 'part') {
          mutations.push({
            kind: 'set_part_transform',
            partName: entity.name,
            ...(op.position ? { posX: op.position[0], posY: op.position[1], posZ: op.position[2] } : {}),
            ...(op.rotation ? { rotX: op.rotation[0], rotY: op.rotation[1], rotZ: op.rotation[2] } : {}),
            ...(op.scale ? { scaleX: op.scale[0], scaleY: op.scale[1], scaleZ: op.scale[2] } : {})
          });
        } else if (entity.kind === 'region') {
          mutations.push({
            kind: 'set_region_transform',
            partName: entity.name,
            ...(op.position ? { posX: op.position[0], posY: op.position[1], posZ: op.position[2] } : {}),
            ...(op.rotation ? { rotX: op.rotation[0], rotY: op.rotation[1], rotZ: op.rotation[2] } : {}),
            ...(op.scale ? { scaleX: op.scale[0], scaleY: op.scale[1], scaleZ: op.scale[2] } : {})
          });
        }
      }
    } else if (op.kind === 'batch_transform') {
      for (const target of op.targets) {
        const entity = loaded.sceneGraph.findEntity(target);
        if (entity && 'transform' in entity) {
          const t = (entity as MapPartEntity | MapRegionEntity).transform;
          const posX = op.positionDelta ? t.position[0] + op.positionDelta[0] : undefined;
          const posY = op.positionDelta ? t.position[1] + op.positionDelta[1] : undefined;
          const posZ = op.positionDelta ? t.position[2] + op.positionDelta[2] : undefined;
          const rotX = op.rotationDelta ? t.rotation[0] + op.rotationDelta[0] : undefined;
          const rotY = op.rotationDelta ? t.rotation[1] + op.rotationDelta[1] : undefined;
          const rotZ = op.rotationDelta ? t.rotation[2] + op.rotationDelta[2] : undefined;
          const scaleX = op.scaleDelta ? t.scale[0] + op.scaleDelta[0] : undefined;
          const scaleY = op.scaleDelta ? t.scale[1] + op.scaleDelta[1] : undefined;
          const scaleZ = op.scaleDelta ? t.scale[2] + op.scaleDelta[2] : undefined;
          mutations.push({
            kind: entity.kind === 'part' ? 'set_part_transform' : 'set_region_transform',
            partName: entity.name,
            ...(posX !== undefined ? { posX } : {}),
            ...(posY !== undefined ? { posY } : {}),
            ...(posZ !== undefined ? { posZ } : {}),
            ...(rotX !== undefined ? { rotX } : {}),
            ...(rotY !== undefined ? { rotY } : {}),
            ...(rotZ !== undefined ? { rotZ } : {}),
            ...(scaleX !== undefined ? { scaleX } : {}),
            ...(scaleY !== undefined ? { scaleY } : {}),
            ...(scaleZ !== undefined ? { scaleZ } : {})
          });
        }
      }
    } else if (op.kind === 'change_model') {
      const part = loaded.sceneGraph.findPart(op.target);
      if (part) {
        mutations.push({
          kind: 'change_model',
          partName: part.name,
          modelName: op.newModelName
        });
      }
    } else if (op.kind === 'delete') {
      const entity = loaded.sceneGraph.findEntity(op.target);
      if (entity) {
        if (entity.kind === 'part') {
          mutations.push({ kind: 'delete_part', partName: entity.name });
        } else if (entity.kind === 'region') {
          mutations.push({ kind: 'delete_region', partName: entity.name });
        } else if (entity.kind === 'event') {
          mutations.push({ kind: 'delete_event', partName: entity.name });
        }
      }
    }
  }

  if (mutations.length === 0) {
    return {
      ok: true,
      transactionId: transaction.id,
      appliedOperations: 0
    };
  }

  const fileEntry = await edit.indexFile(loaded.filePath, 'map');
  const expectedHash = fileEntry.sha256 || loaded.doc.revision;

  for (const mutation of mutations) {
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
        mutation,
        timeoutMs: 120_000
      }),
      title: `MSB transaction [${transaction.id}] ${mutation.kind} on ${mutation.partName}`,
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
  }

  return {
    ok: true,
    transactionId: transaction.id,
    appliedOperations: transaction.operations.length
  };
}
