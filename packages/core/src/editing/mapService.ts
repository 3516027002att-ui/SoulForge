/**
 * Map Service: High-level operations on MapDocument, SceneGraph, and MapEditTransactions.
 *
 * Exposes unified query, inspect, batch transform, and transaction execution
 * for Agent tools, Desktop IPC, and future Blender bridges.
 */

import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
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
  type MapEditOperation,
  type MapPartEntity,
  type MapRegionEntity
} from '@soulforge/shared';
import type { Diagnostic } from '@soulforge/shared';
import { readMsbDocumentViaBridge } from './msbBridgeRead.js';
import type { NativeEditSession } from './nativeEditSession.js';
import { applyNativeMutation } from './editorMutationService.js';
import { commitMsbMutationViaBridge, type MsbBridgeMutation } from './msbBridgeCommit.js';
import { createSemanticChangeSet, validateSemanticChangeSet } from '../semantic/changeSet.js';

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
): Promise<{
  ok: true;
  doc: MapDocument;
  sceneGraph: MapSceneGraph;
  filePath: string;
  /** Hash of the parsed MSB payload used by the Bridge native writer. */
  nativeDocumentHash: string;
} | { ok: false; error: { code: string; message: string } }> {
  const overlay = edit.session.layers.overlayRoot;
  const candidates = [file, join(overlay, file), join(overlay, 'map', file)]
    .map((candidate) => resolve(candidate));

  const resolvedPath = candidates.find((candidate) => existsSync(candidate)) ?? resolve(file);
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

  let fileRevision: string;
  try {
    fileRevision = createHash('sha256').update(await readFile(resolvedPath)).digest('hex');
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'MAP_FILE_HASH_FAILED',
        message: `无法读取 MSB 文件 revision: ${error instanceof Error ? error.message : String(error)}`
      }
    };
  }

  const doc = buildCanonicalMapDocument({
    sourceUri: `map://${mapId}/${basename(file)}`,
    sourcePath: resolvedPath,
    game: 'sekiro',
    // MapEditTransaction and Patch Engine must compare the actual file bytes.
    // The Bridge sourceHash is the decompressed MSB payload hash and is kept
    // separately for the native writer's expectedDocumentHash precondition.
    revision: fileRevision,
    models: readResult.data.models,
    parts: readResult.data.parts,
    regions: readResult.data.regions,
    events: readResult.data.events,
    routes: readResult.data.routes
  });

  const sceneGraph = new MapSceneGraph(doc);
  return {
    ok: true,
    doc,
    sceneGraph,
    filePath: resolvedPath,
    nativeDocumentHash: readResult.data.sourceHash || '1'
  };
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
  const edits: Array<{
    address: string;
    position: [number, number, number];
    rotation: [number, number, number];
    scale: [number, number, number];
  }> = [];
  const beforeList: Array<{ name: string; posX: number; posY: number; posZ: number }> = [];

  for (const target of input.targets) {
    const part = sceneGraph.findPart(target);
    if (!part) {
      return {
        ok: false,
        mapId: doc.mapId,
        modifiedCount: 0,
        targets: input.targets,
        before: beforeList,
        after: [],
        error: { code: 'MAP_PART_NOT_FOUND', message: `批量目标 Part 不存在：${target}` }
      };
    }

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

  const transaction: MapEditTransaction = {
    id: `tx-human-msb-batch-${Date.now()}`,
    mapId: doc.mapId,
    baseRevision: doc.revision,
    description: 'Human batch MSB part transform transaction',
    author: 'human',
    operations: edits.map((item) => ({
      kind: 'set_transform' as const,
      target: item.address,
      position: item.position,
      rotation: item.rotation,
      scale: item.scale
    })),
    timestamp: Date.now()
  };

  const committed = await executeMapTransaction(edit, file, transaction);
  if (!committed.ok) {
    return {
      ok: false,
      mapId: doc.mapId,
      modifiedCount: 0,
      targets: input.targets,
      before: beforeList,
      after: [],
      error: {
        code: committed.error?.code ?? 'MAP_TRANSACTION_FAILED',
        message: committed.error?.message ?? '地图事务提交失败。'
      }
    };
  }

  const reread = await loadMapDocument(edit, file);
  if (!reread.ok) {
    return {
      ok: false,
      mapId: doc.mapId,
      modifiedCount: committed.appliedOperations,
      targets: input.targets,
      before: beforeList,
      after: [],
      error: { code: 'MAP_REREAD_FAILED', message: '地图事务已提交但重读失败，拒绝伪造 after 状态。' }
    };
  }
  const afterList: Array<{ name: string; posX: number; posY: number; posZ: number }> = [];
  for (const editItem of edits) {
    const part = reread.sceneGraph.findPart(editItem.address);
    if (!part) {
      return {
        ok: false,
        mapId: doc.mapId,
        modifiedCount: committed.appliedOperations,
        targets: input.targets,
        before: beforeList,
        after: afterList,
        error: { code: 'MAP_POSTCONDITION_FAILED', message: `事务提交后缺少 Part: ${editItem.address}` }
      };
    }
    afterList.push({
      name: part.name,
      posX: part.transform.position[0],
      posY: part.transform.position[1],
      posZ: part.transform.position[2]
    });
  }

  return {
    ok: true,
    mapId: doc.mapId,
    modifiedCount: committed.appliedOperations,
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
  operationId?: string;
  revision?: string;
  createdEntities?: Array<{ name: string; stableKey: string; address: string; kind: 'part' }>;
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

  // Resolve addresses/stable keys to the reread document's canonical names
  // once. The working maps then compose operations in order instead of
  // accidentally treating an address as a second, unrelated entity.
  const operations = transaction.operations.map((operation) => canonicalizeMapOperation(loaded.sceneGraph, operation));

  // Every domain transaction also enters the semantic ChangeSet boundary.  The
  // map writer remains the native authority, but no writer is allowed to stage
  // a plan whose canonical targets/revision/dependency graph was not validated.
  const semanticChangeSet = createSemanticChangeSet({
    changeSetId: `map:${transaction.id}`,
    baseRevision: loaded.doc.revision,
    operations: operations.map((operation, index) => ({
      operationId: `${transaction.id}:op:${index}`,
      domain: 'map' as const,
      targetIdentity: `${loaded.doc.sourceUri}#${operationTargets(operation).join(',')}`,
      kind: operation.kind,
      beforeRevision: loaded.doc.revision,
      dependencies: [],
      payload: { ...operation } as Record<string, unknown>
    })),
    postconditions: ['committed map reread matches the ordered working state']
  });
  const semanticValidation = validateSemanticChangeSet(
    semanticChangeSet,
    new Map(semanticChangeSet.targetIdentities.map((target) => [target, loaded.doc.revision]))
  );
  if (!semanticValidation.ok) {
    return {
      ok: false,
      transactionId: transaction.id,
      appliedOperations: 0,
      error: {
        code: 'MAP_SEMANTIC_CHANGESET_INVALID',
        message: '地图事务的 Semantic ChangeSet 校验失败。',
        details: semanticValidation.diagnostics
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
  type PendingPartMutation = Extract<MsbBridgeMutation, { kind: 'duplicate_part' | 'create_part' }>;
  const pendingPartMutations = new Map<string, PendingPartMutation>();
  let appliedOperations = 0;

  for (const op of operations) {
    switch (op.kind) {
      case 'set_transform': {
        const part = workingParts.get(op.target);
        if (part) {
          if (op.position) part.transform.position = [...op.position];
          if (op.rotation) part.transform.rotation = [...op.rotation];
          if (op.scale) part.transform.scale = [...op.scale];
          const pending = pendingPartMutations.get(part.name);
          if (pending) {
            applyPartTransformToPendingMutation(pending, part);
          } else {
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
          }
          appliedOperations += 1;
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
          appliedOperations += 1;
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
            const pending = pendingPartMutations.get(part.name);
            if (pending) {
              applyPartTransformToPendingMutation(pending, part);
            } else {
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
            }
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
        appliedOperations += 1;
        break;
      }
      case 'set_property': {
        if (op.property === 'entityId' && typeof op.value === 'number') {
          const part = workingParts.get(op.target);
          if (part) {
            part.entityId = op.value;
            const pending = pendingPartMutations.get(part.name);
            if (pending) pending.entityId = op.value;
            else mutations.push({ kind: 'set_property', partName: part.name, entityId: op.value });
            appliedOperations += 1;
            break;
          }
          const region = workingRegions.get(op.target);
          if (region) {
            region.entityId = op.value;
            mutations.push({ kind: 'set_property', partName: region.name, entityId: op.value });
            appliedOperations += 1;
            break;
          }
          const event = workingEvents.get(op.target);
          if (event) {
            event.eventId = op.value;
            mutations.push({ kind: 'set_property', partName: event.name, entityId: op.value });
            appliedOperations += 1;
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
        const pending = pendingPartMutations.get(part.name);
        if (pending) pending.modelName = op.newModelName;
        else {
          mutations.push({
            kind: 'change_model',
            partName: part.name,
            modelName: op.newModelName
          });
        }
        appliedOperations += 1;
        break;
      }
      case 'duplicate':
      case 'create': {
        const templateName = op.kind === 'duplicate' ? op.target : op.template;
        const template = workingParts.get(templateName);
        if (!template) {
          return {
            ok: false,
            transactionId: transaction.id,
            appliedOperations: 0,
            error: { code: 'MAP_ENTITY_NOT_FOUND', message: `Part 模板未找到或已被删除: ${templateName}` }
          };
        }
        if (workingParts.has(op.newName) || workingRegions.has(op.newName)
          || workingEvents.has(op.newName) || loaded.doc.models.some((model) => model.name === op.newName)) {
          return {
            ok: false,
            transactionId: transaction.id,
            appliedOperations: 0,
            error: { code: 'MAP_NEW_NAME_CONFLICT', message: `新 Part 名称已存在: ${op.newName}` }
          };
        }
        const modelName = op.modelName ?? template.modelName;
        const modelIndex = loaded.doc.models.findIndex((model) => model.name === modelName);
        if (modelIndex < 0) {
          return {
            ok: false,
            transactionId: transaction.id,
            appliedOperations: 0,
            error: { code: 'MAP_MODEL_NOT_IN_MANIFEST', message: `模板模型不在 Model 声明表中: ${modelName}` }
          };
        }
        const transform = {
          position: [...(op.position ?? template.transform.position)] as [number, number, number],
          rotation: [...(op.rotation ?? template.transform.rotation)] as [number, number, number],
          scale: [...(op.scale ?? template.transform.scale)] as [number, number, number]
        };
        const clone = {
          ...template,
          id: `pending:${transaction.id}:${op.newName}`,
          stableKey: `pending:${transaction.id}:${op.newName}`,
          address: `${loaded.doc.mapId}#${op.newName}`,
          name: op.newName,
          modelIndex,
          modelName,
          transform,
          ...(op.entityId === undefined ? {} : { entityId: op.entityId })
        };
        workingParts.set(op.newName, clone);
        const pending: PendingPartMutation = {
          kind: op.kind === 'duplicate' ? 'duplicate_part' : 'create_part',
          partName: template.name,
          newName: op.newName,
          posX: transform.position[0],
          posY: transform.position[1],
          posZ: transform.position[2],
          rotX: transform.rotation[0],
          rotY: transform.rotation[1],
          rotZ: transform.rotation[2],
          scaleX: transform.scale[0],
          scaleY: transform.scale[1],
          scaleZ: transform.scale[2],
          modelName,
          ...(op.entityId === undefined ? {} : { entityId: op.entityId })
        };
        pendingPartMutations.set(op.newName, pending);
        mutations.push(pending);
        appliedOperations += 1;
        break;
      }
      case 'delete': {
        if (workingParts.has(op.target)) {
          workingParts.delete(op.target);
          mutations.push({ kind: 'delete_part', partName: op.target });
          appliedOperations += 1;
          break;
        }
        if (workingRegions.has(op.target)) {
          workingRegions.delete(op.target);
          mutations.push({ kind: 'delete_region', partName: op.target });
          appliedOperations += 1;
          break;
        }
        if (workingEvents.has(op.target)) {
          workingEvents.delete(op.target);
          mutations.push({ kind: 'delete_event', partName: op.target });
          appliedOperations += 1;
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
      ok: false,
      transactionId: transaction.id,
      appliedOperations: 0,
      error: { code: 'MAP_NO_EFFECT', message: '事务没有产生任何可写入的地图变更。' }
    };
  }

  const fileEntry = await edit.indexFile(loaded.filePath, 'map');
  const expectedHash = loaded.doc.revision;

  // Single batch staging & Patch commit
  const mutationPorts: {
    commit: NativeEditSession['commitPort'];
    confirm?: NonNullable<NativeEditSession['confirmationPort']>;
  } = { commit: edit.commitPort };
  if (edit.confirmationPort) mutationPorts.confirm = edit.confirmationPort;
  let postCommitDocument: MapDocument | undefined;
  let createdEntities: Array<{ name: string; stableKey: string; address: string; kind: 'part' }> = [];
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
      expectedDocumentHash: loaded.nativeDocumentHash,
      allowedRoots: context.allowedRoots,
      writableRoots: context.writableRoots,
      mutations,
      ...(edit.oodleRuntimeRoot ? { oodleRuntimeRoot: edit.oodleRuntimeRoot } : {}),
      timeoutMs: 120_000
    }),
    semanticChecks: {
      afterCommit: async () => {
        const checked = await verifyMapPostCommit(
          edit,
          file,
          loaded.doc,
          workingParts,
          workingRegions,
          workingEvents
        );
        postCommitDocument = checked.document;
        createdEntities = checked.createdEntities;
        return checked.diagnostics;
      }
    },
    title: `MSB transaction [${transaction.id}] (${mutations.length} mutations)`,
    confirmActionLabel: '提交 MSB 地图事务'
  }, mutationPorts);

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

  // The committed transaction's afterCommit check already performed the
  // authoritative reread and exact working-state comparison. Reuse that
  // document instead of doing an unprotected second read after commit.
  const reread = postCommitDocument;
  if (!reread) {
    return {
      ok: false,
      transactionId: transaction.id,
      appliedOperations,
      error: {
        code: 'MAP_POSTCOMMIT_CONTEXT_MISSING',
        message: 'MSB 提交后缺少同一事务的权威重读上下文。'
      }
    };
  }

  return {
    ok: true,
    transactionId: transaction.id,
    appliedOperations,
    ...(outcome.result.opId ? { operationId: outcome.result.opId } : {}),
    revision: reread.revision,
    ...(createdEntities.length > 0 ? { createdEntities } : {})
  };
}

type MapPostCommitVerification = {
  diagnostics: Diagnostic[];
  document?: MapDocument;
  createdEntities: Array<{ name: string; stableKey: string; address: string; kind: 'part' }>;
};

async function verifyMapPostCommit(
  edit: NativeEditSession,
  file: string,
  original: MapDocument,
  workingParts: ReadonlyMap<string, MapPartEntity>,
  workingRegions: ReadonlyMap<string, MapRegionEntity>,
  workingEvents: ReadonlyMap<string, MapDocument['events'][number]>
): Promise<MapPostCommitVerification> {
  const reread = await loadMapDocument(edit, file);
  if (!reread.ok) {
    return {
      diagnostics: [{
        severity: 'error',
        code: 'MAP_REREAD_FAILED',
        message: 'MSB 提交后重读失败，无法确认写回状态。',
        sourceUri: original.sourceUri
      }],
      createdEntities: []
    };
  }

  const diagnostics: Diagnostic[] = [];
  const fail = (message: string, details?: unknown): void => {
    diagnostics.push({
      severity: 'error',
      code: 'MAP_POSTCONDITION_FAILED',
      message,
      sourceUri: original.sourceUri,
      ...(details === undefined ? {} : { details })
    });
  };

  for (const [name, expectedPart] of workingParts) {
    const actual = reread.sceneGraph.findPart(name);
    if (!actual) {
      fail(`写回后缺少 Part: ${name}`);
      continue;
    }
    if (Math.abs(actual.transform.position[0] - expectedPart.transform.position[0]) > 0.001 ||
        Math.abs(actual.transform.position[1] - expectedPart.transform.position[1]) > 0.001 ||
        Math.abs(actual.transform.position[2] - expectedPart.transform.position[2]) > 0.001) {
      fail(`Part ${name} 坐标写回后与预期不符`);
    }
    if (expectedPart.modelName && actual.modelName !== expectedPart.modelName) {
      fail(`Part ${name} 模型写回后与预期不符`);
    }
    if (expectedPart.entityId !== undefined && actual.entityId !== expectedPart.entityId) {
      fail(`Part ${name} entityId 写回后与预期不符`);
    }
    if (transformMismatch(actual, expectedPart)) {
      fail(`Part ${name} 变换写回后与预期不符`);
    }
  }

  for (const [name, expectedRegion] of workingRegions) {
    const actual = reread.sceneGraph.findRegion(name);
    if (!actual || transformMismatch(actual, expectedRegion)
      || (expectedRegion.entityId !== undefined && actual.entityId !== expectedRegion.entityId)) {
      fail(`Region ${name} 写回后与预期不符`);
    }
  }

  for (const [name, expectedEvent] of workingEvents) {
    const actual = reread.sceneGraph.findEvent(name);
    if (!actual || (expectedEvent.eventId !== undefined && actual.eventId !== expectedEvent.eventId)) {
      fail(`Event ${name} 写回后与预期不符`);
    }
  }

  for (const part of original.parts) {
    if (!workingParts.has(part.name) && reread.sceneGraph.findPart(part.name)) {
      fail(`删除 Part ${part.name} 后仍存在`);
    }
  }
  for (const region of original.regions) {
    if (!workingRegions.has(region.name) && reread.sceneGraph.findRegion(region.name)) {
      fail(`删除 Region ${region.name} 后仍存在`);
    }
  }
  for (const event of original.events) {
    if (!workingEvents.has(event.name) && reread.sceneGraph.findEvent(event.name)) {
      fail(`删除 Event ${event.name} 后仍存在`);
    }
  }

  const originalPartNames = new Set(original.parts.map((part) => part.name));
  const createdEntities = reread.doc.parts
    .filter((part) => !originalPartNames.has(part.name))
    .map((part) => ({
      name: part.name,
      stableKey: part.stableKey,
      address: part.address,
      kind: 'part' as const
    }));
  return { diagnostics, document: reread.doc, createdEntities };
}

function canonicalizeMapOperation(sceneGraph: MapSceneGraph, operation: MapEditOperation): MapEditOperation {
  const canonicalName = (target: string): string => sceneGraph.findEntity(target)?.name ?? target;
  switch (operation.kind) {
    case 'set_transform': return { ...operation, target: canonicalName(operation.target) };
    case 'batch_transform': return { ...operation, targets: operation.targets.map(canonicalName) };
    case 'set_property': return { ...operation, target: canonicalName(operation.target) };
    case 'change_model': return { ...operation, target: canonicalName(operation.target) };
    case 'duplicate': return { ...operation, target: canonicalName(operation.target) };
    case 'create': return { ...operation, template: canonicalName(operation.template) };
    case 'delete': return { ...operation, target: canonicalName(operation.target) };
  }
}

function operationTargets(operation: MapEditOperation): string[] {
  if (operation.kind === 'batch_transform') return operation.targets;
  if (operation.kind === 'create') return [operation.template, operation.newName];
  if (operation.kind === 'duplicate') return [operation.target, operation.newName];
  return [operation.target];
}

function applyPartTransformToPendingMutation(
  mutation: Extract<MsbBridgeMutation, { kind: 'duplicate_part' | 'create_part' }>,
  part: MapPartEntity
): void {
  mutation.posX = part.transform.position[0];
  mutation.posY = part.transform.position[1];
  mutation.posZ = part.transform.position[2];
  mutation.rotX = part.transform.rotation[0];
  mutation.rotY = part.transform.rotation[1];
  mutation.rotZ = part.transform.rotation[2];
  mutation.scaleX = part.transform.scale[0];
  mutation.scaleY = part.transform.scale[1];
  mutation.scaleZ = part.transform.scale[2];
}

function transformMismatch(
  actual: { transform: { position: readonly number[]; rotation: readonly number[]; scale: readonly number[] } },
  expected: { transform: { position: readonly number[]; rotation: readonly number[]; scale: readonly number[] } }
): boolean {
  return [...actual.transform.position, ...actual.transform.rotation, ...actual.transform.scale]
    .some((value, index) => Math.abs(value - [...expected.transform.position, ...expected.transform.rotation, ...expected.transform.scale][index]!) > 0.001);
}
