/**
 * Canonical MapDocument, SceneGraph, EditTransaction, and Blender Adapter boundaries.
 *
 * This module defines the renderer-independent, authoritative semantic representation
 * of Sekiro MSB maps, ensuring human UI, Agent tools, and external 3D tools (Blender)
 * share a single transaction and object identity model.
 */

import { formatMapAddress, parseMapAddress } from './soulAddress.js';

export type MapEntityKind = 'model' | 'part' | 'region' | 'event' | 'route';

export interface Transform3D {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

export interface BaseMapEntity {
  id: string;
  stableKey: string;
  address: string;
  mapId: string;
  name: string;
  kind: MapEntityKind;
  typeId: number;
  nativeOffset?: number | undefined;
  entityId?: number | undefined;
}

export interface MapModelEntity extends BaseMapEntity {
  kind: 'model';
  sibPath?: string | undefined;
  instanceCount?: number | undefined;
}

export interface MapPartEntity extends BaseMapEntity {
  kind: 'part';
  modelIndex: number;
  modelName: string;
  transform: Transform3D;
  drawGroups?: number[] | undefined;
  displayGroups?: number[] | undefined;
}

export interface MapRegionEntity extends BaseMapEntity {
  kind: 'region';
  transform: Transform3D;
  shape?: number | undefined;
}

export interface MapEventEntity extends BaseMapEntity {
  kind: 'event';
  eventId?: number | undefined;
  referencedPartName?: string | undefined;
  referencedRegionName?: string | undefined;
  referencedEntityId?: number | undefined;
}

export interface MapRouteEntity extends BaseMapEntity {
  kind: 'route';
  routeId?: number | undefined;
  unk08?: number | undefined;
  unk0C?: number | undefined;
}

export type MapEntity = MapModelEntity | MapPartEntity | MapRegionEntity | MapEventEntity | MapRouteEntity;

export interface MapDocument {
  sourceUri: string;
  sourcePath: string;
  mapId: string;
  game: string;
  revision: string;
  models: MapModelEntity[];
  parts: MapPartEntity[];
  regions: MapRegionEntity[];
  events: MapEventEntity[];
  routes: MapRouteEntity[];
  totalEntityCount: number;
}

/**
 * High-performance In-Memory Map SceneGraph for queries, navigation, and cross-references.
 */
export class MapSceneGraph {
  private readonly document: MapDocument;
  private readonly entityById = new Map<string, MapEntity>();
  private readonly entityByStableKey = new Map<string, MapEntity>();
  private readonly entityByAddress = new Map<string, MapEntity>();
  private readonly entityByName = new Map<string, MapEntity>();
  private readonly partsByName = new Map<string, MapPartEntity>();
  private readonly regionsByName = new Map<string, MapRegionEntity>();
  private readonly modelsByName = new Map<string, MapModelEntity>();
  private readonly eventsByName = new Map<string, MapEventEntity>();
  private readonly entityByEntityId = new Map<number, MapEntity[]>();
  private readonly partsByModelName = new Map<string, MapPartEntity[]>();
  private readonly eventsByReferencedRegion = new Map<string, MapEventEntity[]>();
  private readonly eventsByReferencedPart = new Map<string, MapEventEntity[]>();

  constructor(document: MapDocument) {
    this.document = document;
    this.buildIndices();
  }

  private buildIndices(): void {
    for (const model of this.document.models) {
      this.entityById.set(model.id, model);
      this.entityByStableKey.set(model.stableKey, model);
      this.entityByAddress.set(model.address, model);
      if (!this.entityByName.has(model.name)) this.entityByName.set(model.name, model);
      this.modelsByName.set(model.name, model);
    }

    for (const part of this.document.parts) {
      this.entityById.set(part.id, part);
      this.entityByStableKey.set(part.stableKey, part);
      this.entityByAddress.set(part.address, part);
      if (!this.entityByName.has(part.name)) this.entityByName.set(part.name, part);
      this.partsByName.set(part.name, part);

      if (part.entityId !== undefined && part.entityId > 0) {
        const list = this.entityByEntityId.get(part.entityId) ?? [];
        list.push(part);
        this.entityByEntityId.set(part.entityId, list);
      }
      if (part.modelName) {
        const list = this.partsByModelName.get(part.modelName) ?? [];
        list.push(part);
        this.partsByModelName.set(part.modelName, list);
      }
    }

    for (const region of this.document.regions) {
      this.entityById.set(region.id, region);
      this.entityByStableKey.set(region.stableKey, region);
      this.entityByAddress.set(region.address, region);
      if (!this.entityByName.has(region.name)) this.entityByName.set(region.name, region);
      this.regionsByName.set(region.name, region);

      if (region.entityId !== undefined && region.entityId > 0) {
        const list = this.entityByEntityId.get(region.entityId) ?? [];
        list.push(region);
        this.entityByEntityId.set(region.entityId, list);
      }
    }

    for (const event of this.document.events) {
      this.entityById.set(event.id, event);
      this.entityByStableKey.set(event.stableKey, event);
      this.entityByAddress.set(event.address, event);
      if (!this.entityByName.has(event.name)) this.entityByName.set(event.name, event);
      this.eventsByName.set(event.name, event);

      if (event.referencedRegionName) {
        const list = this.eventsByReferencedRegion.get(event.referencedRegionName) ?? [];
        list.push(event);
        this.eventsByReferencedRegion.set(event.referencedRegionName, list);
      }
      if (event.referencedPartName) {
        const list = this.eventsByReferencedPart.get(event.referencedPartName) ?? [];
        list.push(event);
        this.eventsByReferencedPart.set(event.referencedPartName, list);
      }
    }

    for (const route of this.document.routes) {
      this.entityById.set(route.id, route);
      this.entityByStableKey.set(route.stableKey, route);
      this.entityByAddress.set(route.address, route);
      if (!this.entityByName.has(route.name)) this.entityByName.set(route.name, route);
    }
  }

  public getDocument(): MapDocument {
    return this.document;
  }

  public findEntity(identifier: string): MapEntity | undefined {
    return (
      this.entityById.get(identifier) ||
      this.entityByStableKey.get(identifier) ||
      this.entityByAddress.get(identifier) ||
      this.partsByName.get(identifier) ||
      this.regionsByName.get(identifier) ||
      this.modelsByName.get(identifier) ||
      this.eventsByName.get(identifier) ||
      this.entityByName.get(identifier)
    );
  }

  public findPart(identifier: string): MapPartEntity | undefined {
    const direct = this.partsByName.get(identifier);
    if (direct) return direct;
    const entity = this.findEntity(identifier);
    return entity && entity.kind === 'part' ? entity : undefined;
  }

  public findRegion(identifier: string): MapRegionEntity | undefined {
    const direct = this.regionsByName.get(identifier);
    if (direct) return direct;
    const entity = this.findEntity(identifier);
    return entity && entity.kind === 'region' ? entity : undefined;
  }

  public findModel(identifier: string): MapModelEntity | undefined {
    const direct = this.modelsByName.get(identifier);
    if (direct) return direct;
    const entity = this.findEntity(identifier);
    return entity && entity.kind === 'model' ? entity : undefined;
  }

  public findEvent(identifier: string): MapEventEntity | undefined {
    const direct = this.eventsByName.get(identifier);
    if (direct) return direct;
    const entity = this.findEntity(identifier);
    return entity && entity.kind === 'event' ? entity : undefined;
  }

  public queryPartsByModel(modelName: string): MapPartEntity[] {
    return this.partsByModelName.get(modelName) ?? [];
  }

  public queryByEntityId(entityId: number): MapEntity[] {
    return this.entityByEntityId.get(entityId) ?? [];
  }

  public queryEventsReferencingRegion(regionName: string): MapEventEntity[] {
    return this.eventsByReferencedRegion.get(regionName) ?? [];
  }

  public queryEventsReferencingPart(partName: string): MapEventEntity[] {
    return this.eventsByReferencedPart.get(partName) ?? [];
  }

  public queryParts(predicate?: (part: MapPartEntity) => boolean): MapPartEntity[] {
    if (!predicate) return this.document.parts;
    return this.document.parts.filter(predicate);
  }

  public queryRegions(predicate?: (region: MapRegionEntity) => boolean): MapRegionEntity[] {
    if (!predicate) return this.document.regions;
    return this.document.regions.filter(predicate);
  }

  public queryModels(predicate?: (model: MapModelEntity) => boolean): MapModelEntity[] {
    if (!predicate) return this.document.models;
    return this.document.models.filter(predicate);
  }
}

/**
 * Structured Map Edit Operations
 */
export type MapEditOperation =
  | {
      kind: 'set_transform';
      target: string;
      position?: [number, number, number] | undefined;
      rotation?: [number, number, number] | undefined;
      scale?: [number, number, number] | undefined;
    }
  | {
      kind: 'batch_transform';
      targets: string[];
      positionDelta?: [number, number, number] | undefined;
      rotationDelta?: [number, number, number] | undefined;
      scaleDelta?: [number, number, number] | undefined;
    }
  | {
      kind: 'set_property';
      target: string;
      property: 'entityId' | string;
      value: number | string | boolean;
    }
  | {
      kind: 'change_model';
      target: string;
      newModelName: string;
    }
  | {
      kind: 'delete';
      target: string;
    };

export interface MapEditTransaction {
  id: string;
  mapId: string;
  baseRevision: string;
  description: string;
  author: 'human' | 'agent' | 'blender';
  operations: MapEditOperation[];
  timestamp: number;
}

export interface MapTransactionValidationResult {
  valid: boolean;
  diagnostics: Array<{
    severity: 'error' | 'warning';
    code: string;
    message: string;
    target?: string | undefined;
  }>;
}

function assertNever(x: never): never {
  throw new Error(`未处理的 MapEditOperation: ${JSON.stringify(x)}`);
}

/**
 * Validates a MapEditTransaction against a target MapDocument.
 */
export function validateMapTransaction(
  doc: MapDocument,
  transaction: MapEditTransaction
): MapTransactionValidationResult {
  const diagnostics: MapTransactionValidationResult['diagnostics'] = [];

  // 1. Revision / mapId check
  if (transaction.mapId && transaction.mapId !== doc.mapId) {
    diagnostics.push({
      severity: 'error',
      code: 'MAP_ID_MISMATCH',
      message: `地图 ID 不匹配：事务为 ${transaction.mapId}，当前文档为 ${doc.mapId}`
    });
  }

  if (transaction.baseRevision && transaction.baseRevision !== doc.revision) {
    diagnostics.push({
      severity: 'error',
      code: 'MAP_TRANSACTION_STALE_REVISION',
      message: `事务 baseRevision [${transaction.baseRevision}] 与当前文档 revision [${doc.revision}] 不一致，已过时`
    });
  }

  const sceneGraph = new MapSceneGraph(doc);
  const deletedTargets = new Set<string>();

  for (const op of transaction.operations) {
    switch (op.kind) {
      case 'set_transform': {
        if (deletedTargets.has(op.target)) {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_ENTITY_NOT_FOUND',
            message: `目标实体已被前序操作删除: ${op.target}`,
            target: op.target
          });
          break;
        }
        const entity = sceneGraph.findEntity(op.target);
        if (!entity) {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_ENTITY_NOT_FOUND',
            message: `目标实体不存在: ${op.target}`,
            target: op.target
          });
        } else if (entity.kind !== 'part' && entity.kind !== 'region') {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_ENTITY_NOT_TRANSFORMABLE',
            message: `实体类型 ${entity.kind} 不支持变换修改: ${op.target}`,
            target: op.target
          });
        }
        break;
      }
      case 'batch_transform': {
        for (const target of op.targets) {
          if (deletedTargets.has(target)) {
            diagnostics.push({
              severity: 'error',
              code: 'MAP_ENTITY_NOT_FOUND',
              message: `批量变换目标已被前序操作删除: ${target}`,
              target
            });
            continue;
          }
          const entity = sceneGraph.findEntity(target);
          if (!entity) {
            diagnostics.push({
              severity: 'error',
              code: 'MAP_ENTITY_NOT_FOUND',
              message: `批量变换目标不存在: ${target}`,
              target
            });
          }
        }
        break;
      }
      case 'set_property': {
        if (deletedTargets.has(op.target)) {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_ENTITY_NOT_FOUND',
            message: `属性修改目标实体已被前序操作删除: ${op.target}`,
            target: op.target
          });
          break;
        }
        const entity = sceneGraph.findEntity(op.target);
        if (!entity) {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_ENTITY_NOT_FOUND',
            message: `属性修改目标实体不存在: ${op.target}`,
            target: op.target
          });
        } else {
          if (op.property !== 'entityId') {
            diagnostics.push({
              severity: 'error',
              code: 'MAP_PROPERTY_UNSUPPORTED',
              message: `不支持的属性修改: ${op.property}，当前仅支持权威字段 entityId`,
              target: op.target
            });
          } else if (typeof op.value !== 'number' || !Number.isInteger(op.value)) {
            diagnostics.push({
              severity: 'error',
              code: 'MAP_PROPERTY_VALUE_INVALID',
              message: `entityId 属性值必须是整数，收到: ${String(op.value)}`,
              target: op.target
            });
          }
        }
        break;
      }
      case 'change_model': {
        if (deletedTargets.has(op.target)) {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_PART_NOT_FOUND',
            message: `修改模型目标 Part 已被前序操作删除: ${op.target}`,
            target: op.target
          });
          break;
        }
        const part = sceneGraph.findPart(op.target);
        if (!part) {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_PART_NOT_FOUND',
            message: `修改模型目标 Part 不存在: ${op.target}`,
            target: op.target
          });
        } else {
          const modelExists = doc.models.some((m) => m.name === op.newModelName);
          if (!modelExists) {
            diagnostics.push({
              severity: 'error',
              code: 'MAP_MODEL_NOT_IN_MANIFEST',
              message: `模型 ${op.newModelName} 尚未在地图 Model 声明表中，当前不支持跨地图未声明模型引用`,
              target: op.target
            });
          }
        }
        break;
      }
      case 'delete': {
        if (deletedTargets.has(op.target)) {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_ENTITY_NOT_FOUND',
            message: `目标实体已被重复删除: ${op.target}`,
            target: op.target
          });
          break;
        }
        const entity = sceneGraph.findEntity(op.target);
        if (!entity) {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_ENTITY_NOT_FOUND',
            message: `删除目标实体不存在: ${op.target}`,
            target: op.target
          });
        } else {
          deletedTargets.add(op.target);
          if (entity.kind === 'region') {
            const referencingEvents = sceneGraph.queryEventsReferencingRegion(entity.name);
            if (referencingEvents.length > 0) {
              diagnostics.push({
                severity: 'warning',
                code: 'MAP_DANGLING_REGION_REFERENCE',
                message: `删除 Region [${entity.name}] 可能会使 ${referencingEvents.length} 个 Event 产生悬空引用`,
                target: op.target
              });
            }
          }
        }
        break;
      }
      default:
        assertNever(op);
    }
  }

  return {
    valid: !diagnostics.some((d) => d.severity === 'error'),
    diagnostics
  };
}

/**
 * Blender Adapter Contract / DTOs
 */
export interface BlenderObjectDto {
  stableKey: string;
  soulAddress: string;
  entityKind: MapEntityKind;
  name: string;
  modelName?: string | undefined;
  transform: Transform3D;
}

export interface BlenderSceneExport {
  schemaVersion: 1;
  mapId: string;
  revision: string;
  exportedAt: string;
  objects: BlenderObjectDto[];
}

export interface BlenderMutationDto {
  stableKey: string;
  action: 'modify' | 'duplicate' | 'delete' | 'create';
  name?: string | undefined;
  modelName?: string | undefined;
  position?: [number, number, number] | undefined;
  rotation?: [number, number, number] | undefined;
  scale?: [number, number, number] | undefined;
}

export interface BlenderDeltaImport {
  schemaVersion: 1;
  mapId: string;
  baseRevision: string;
  importedAt: string;
  mutations: BlenderMutationDto[];
}

/**
 * Exports canonical MapDocument into Blender-compatible Scene Descriptor.
 */
export function exportMapSceneForBlender(doc: MapDocument): BlenderSceneExport {
  const objects: BlenderObjectDto[] = [];

  for (const part of doc.parts) {
    objects.push({
      stableKey: part.stableKey,
      soulAddress: part.address,
      entityKind: 'part',
      name: part.name,
      modelName: part.modelName,
      transform: part.transform
    });
  }

  for (const region of doc.regions) {
    objects.push({
      stableKey: region.stableKey,
      soulAddress: region.address,
      entityKind: 'region',
      name: region.name,
      transform: region.transform
    });
  }

  return {
    schemaVersion: 1,
    mapId: doc.mapId,
    revision: doc.revision,
    exportedAt: new Date().toISOString(),
    objects
  };
}

/**
 * Translates Blender delta modifications back into a canonical MapEditTransaction.
 */
export function importBlenderDeltaToTransaction(
  doc: MapDocument,
  delta: BlenderDeltaImport
): { ok: true; transaction: MapEditTransaction } | { ok: false; error: string; conflict?: boolean } {
  if (delta.schemaVersion !== 1) {
    return { ok: false, error: `不支持的 Blender Delta schemaVersion: ${delta.schemaVersion}` };
  }

  if (delta.mapId !== doc.mapId) {
    return {
      ok: false,
      error: `地图 ID 不匹配: 导入为 ${delta.mapId}，当前为 ${doc.mapId}`,
      conflict: true
    };
  }

  if (delta.baseRevision !== doc.revision) {
    return {
      ok: false,
      error: `Revision 冲突: Blender 基于 revision [${delta.baseRevision}]，当前地图已演进为 [${doc.revision}]`,
      conflict: true
    };
  }

  const operations: MapEditOperation[] = [];

  for (const mut of delta.mutations) {
    switch (mut.action) {
      case 'modify': {
        if (mut.position || mut.rotation || mut.scale) {
          operations.push({
            kind: 'set_transform',
            target: mut.stableKey,
            ...(mut.position ? { position: mut.position } : {}),
            ...(mut.rotation ? { rotation: mut.rotation } : {}),
            ...(mut.scale ? { scale: mut.scale } : {})
          });
        }
        if (mut.modelName) {
          operations.push({
            kind: 'change_model',
            target: mut.stableKey,
            newModelName: mut.modelName
          });
        }
        break;
      }
      case 'duplicate': {
        return {
          ok: false,
          conflict: false,
          error: `MAP_DUPLICATE_UNSUPPORTED: 不支持复制实体操作 (${mut.stableKey})`
        };
      }
      case 'delete': {
        operations.push({
          kind: 'delete',
          target: mut.stableKey
        });
        break;
      }
    }
  }

  const transaction: MapEditTransaction = {
    id: `tx-blender-${Date.now()}`,
    mapId: doc.mapId,
    baseRevision: doc.revision,
    description: `Blender 空间编辑往返 (${operations.length} 项修改)`,
    author: 'blender',
    operations,
    timestamp: Date.now()
  };

  return { ok: true, transaction };
}

/**
 * Builds a canonical MapDocument from raw Bridge parse data without any truncation cap.
 */
export function buildCanonicalMapDocument(input: {
  sourceUri: string;
  sourcePath: string;
  game: string;
  revision: string;
  models?: Array<{ name: string; nativeOffset?: number | undefined; typeId?: number | undefined }> | undefined;
  parts: Array<{
    name: string;
    nativeOffset?: number | undefined;
    typeId: number;
    modelIndex?: number | undefined;
    posX: number;
    posY: number;
    posZ: number;
    rotX?: number | undefined;
    rotY?: number | undefined;
    rotZ?: number | undefined;
    scaleX?: number | undefined;
    scaleY?: number | undefined;
    scaleZ?: number | undefined;
    entityId?: number | undefined;
  }>;
  regions?: Array<{
    name: string;
    nativeOffset?: number | undefined;
    typeId: number;
    posX: number;
    posY: number;
    posZ: number;
    rotX?: number | undefined;
    rotY?: number | undefined;
    rotZ?: number | undefined;
    scaleX?: number | undefined;
    scaleY?: number | undefined;
    scaleZ?: number | undefined;
    entityId?: number | undefined;
  }> | undefined;
  events?: Array<{
    name: string;
    nativeOffset?: number | undefined;
    typeId: number;
    eventId?: number | undefined;
  }> | undefined;
  routes?: Array<{
    name: string;
    nativeOffset?: number | undefined;
    typeId: number;
    id?: number | undefined;
  }> | undefined;
}): MapDocument {
  const mapId = input.sourcePath.split(/[/\\]/).pop()?.replace(/\.msb(\.dcx)?$/i, '') ?? 'map';

  const models: MapModelEntity[] = (input.models ?? []).map((m, idx) => {
    const address = formatMapAddress({ block: mapId, name: m.name });
    const stableKey = m.nativeOffset !== undefined
      ? `model:${mapId}:offset-${m.nativeOffset.toString(16)}`
      : `model:${mapId}:${m.name}:${idx}`;
    return {
      id: stableKey,
      stableKey,
      address,
      mapId,
      name: m.name,
      kind: 'model',
      typeId: m.typeId ?? 0,
      ...(m.nativeOffset !== undefined ? { nativeOffset: m.nativeOffset } : {})
    };
  });

  const parts: MapPartEntity[] = input.parts.map((p, idx) => {
    const address = formatMapAddress({ block: mapId, name: p.name });
    const stableKey = p.nativeOffset !== undefined
      ? `part:${mapId}:offset-${p.nativeOffset.toString(16)}`
      : `part:${mapId}:${p.name}:${idx}`;
    const modelIndex = p.modelIndex ?? 0;
    const modelName = models[modelIndex]?.name ?? (p.modelIndex !== undefined ? `model_${p.modelIndex}` : 'unknown');

    return {
      id: stableKey,
      stableKey,
      address,
      mapId,
      name: p.name,
      kind: 'part',
      typeId: p.typeId,
      modelIndex,
      modelName,
      transform: {
        position: [p.posX, p.posY, p.posZ],
        rotation: [p.rotX ?? 0, p.rotY ?? 0, p.rotZ ?? 0],
        scale: [p.scaleX ?? 1, p.scaleY ?? 1, p.scaleZ ?? 1]
      },
      ...(p.nativeOffset !== undefined ? { nativeOffset: p.nativeOffset } : {}),
      ...(p.entityId !== undefined ? { entityId: p.entityId } : {})
    };
  });

  const regions: MapRegionEntity[] = (input.regions ?? []).map((r, idx) => {
    const address = formatMapAddress({ block: mapId, name: r.name });
    const stableKey = r.nativeOffset !== undefined
      ? `region:${mapId}:offset-${r.nativeOffset.toString(16)}`
      : `region:${mapId}:${r.name}:${idx}`;

    return {
      id: stableKey,
      stableKey,
      address,
      mapId,
      name: r.name,
      kind: 'region',
      typeId: r.typeId,
      transform: {
        position: [r.posX, r.posY, r.posZ],
        rotation: [r.rotX ?? 0, r.rotY ?? 0, r.rotZ ?? 0],
        scale: [r.scaleX ?? 1, r.scaleY ?? 1, r.scaleZ ?? 1]
      },
      ...(r.nativeOffset !== undefined ? { nativeOffset: r.nativeOffset } : {}),
      ...(r.entityId !== undefined ? { entityId: r.entityId } : {})
    };
  });

  const events: MapEventEntity[] = (input.events ?? []).map((e, idx) => {
    const address = formatMapAddress({ block: mapId, name: e.name });
    const stableKey = e.nativeOffset !== undefined
      ? `event:${mapId}:offset-${e.nativeOffset.toString(16)}`
      : `event:${mapId}:${e.name}:${idx}`;

    return {
      id: stableKey,
      stableKey,
      address,
      mapId,
      name: e.name,
      kind: 'event',
      typeId: e.typeId,
      ...(e.eventId !== undefined ? { eventId: e.eventId } : {}),
      ...(e.nativeOffset !== undefined ? { nativeOffset: e.nativeOffset } : {})
    };
  });

  const routes: MapRouteEntity[] = (input.routes ?? []).map((rt, idx) => {
    const address = formatMapAddress({ block: mapId, name: rt.name });
    const stableKey = rt.nativeOffset !== undefined
      ? `route:${mapId}:offset-${rt.nativeOffset.toString(16)}`
      : `route:${mapId}:${rt.name}:${idx}`;

    return {
      id: stableKey,
      stableKey,
      address,
      mapId,
      name: rt.name,
      kind: 'route',
      typeId: rt.typeId,
      ...(rt.id !== undefined ? { routeId: rt.id } : {}),
      ...(rt.nativeOffset !== undefined ? { nativeOffset: rt.nativeOffset } : {})
    };
  });

  const totalEntityCount = models.length + parts.length + regions.length + events.length + routes.length;

  return {
    sourceUri: input.sourceUri,
    sourcePath: input.sourcePath,
    mapId,
    game: input.game,
    revision: input.revision,
    models,
    parts,
    regions,
    events,
    routes,
    totalEntityCount
  };
}
