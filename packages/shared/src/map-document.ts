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
  private readonly entitiesByName = new Map<string, MapEntity[]>();
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
      this.indexName(model);
    }

    for (const part of this.document.parts) {
      this.entityById.set(part.id, part);
      this.entityByStableKey.set(part.stableKey, part);
      this.entityByAddress.set(part.address, part);
      this.indexName(part);

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
      this.indexName(region);

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
      this.indexName(event);

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
      this.indexName(route);
    }
  }

  private indexName(entity: MapEntity): void {
    const list = this.entitiesByName.get(entity.name) ?? [];
    list.push(entity);
    this.entitiesByName.set(entity.name, list);
  }

  public getDocument(): MapDocument {
    return this.document;
  }

  /**
   * Returns exact identity matches first; a name is usable only when it is
   * unique across the complete MSB entity graph.
   */
  public findEntityCandidates(identifier: string): MapEntity[] {
    const exact = this.entityById.get(identifier)
      ?? this.entityByStableKey.get(identifier)
      ?? this.entityByAddress.get(identifier);
    return exact ? [exact] : [...(this.entitiesByName.get(identifier) ?? [])];
  }

  public isNameAmbiguous(name: string): boolean {
    return (this.entitiesByName.get(name)?.length ?? 0) > 1;
  }

  public findEntity(identifier: string): MapEntity | undefined {
    const candidates = this.findEntityCandidates(identifier);
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  public findPart(identifier: string): MapPartEntity | undefined {
    const entity = this.findEntity(identifier);
    return entity && entity.kind === 'part' ? entity : undefined;
  }

  public findRegion(identifier: string): MapRegionEntity | undefined {
    const entity = this.findEntity(identifier);
    return entity && entity.kind === 'region' ? entity : undefined;
  }

  public findModel(identifier: string): MapModelEntity | undefined {
    const entity = this.findEntity(identifier);
    return entity && entity.kind === 'model' ? entity : undefined;
  }

  public findEvent(identifier: string): MapEventEntity | undefined {
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
      kind: 'duplicate';
      target: string;
      newName: string;
      position?: [number, number, number] | undefined;
      rotation?: [number, number, number] | undefined;
      scale?: [number, number, number] | undefined;
      modelName?: string | undefined;
      entityId?: number | undefined;
    }
  | {
      kind: 'create';
      template: string;
      newName: string;
      entityKind: 'part';
      position?: [number, number, number] | undefined;
      rotation?: [number, number, number] | undefined;
      scale?: [number, number, number] | undefined;
      modelName?: string | undefined;
      entityId?: number | undefined;
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
  const reservedNewNames = new Set<string>();
  const workingKinds = new Map<string, MapEntityKind>([
    ...doc.models.map((entity) => [entity.name, entity.kind] as const),
    ...doc.parts.map((entity) => [entity.name, entity.kind] as const),
    ...doc.regions.map((entity) => [entity.name, entity.kind] as const),
    ...doc.events.map((entity) => [entity.name, entity.kind] as const),
    ...doc.routes.map((entity) => [entity.name, entity.kind] as const)
  ]);
  const pendingNames = new Set<string>();
  const canonicalTarget = (target: string): string => sceneGraph.findEntity(target)?.name ?? target;
  const wasDeleted = (target: string): boolean => deletedTargets.has(target) || deletedTargets.has(canonicalTarget(target));
  const isAmbiguousTarget = (target: string): boolean => {
    // Exact id/stableKey/address resolution is authoritative even when the
    // resolved entity shares its display name with another entity. Only the
    // bare name alias is ambiguous in that case.
    return sceneGraph.isNameAmbiguous(target);
  };
  const resolveWorkingEntity = (target: string): { name: string; kind: MapEntityKind; pending: boolean } | undefined => {
    if (isAmbiguousTarget(target)) return undefined;
    const initial = sceneGraph.findEntity(target);
    const name = initial?.name ?? target;
    const kind = workingKinds.get(name);
    return kind ? { name, kind, pending: pendingNames.has(name) } : undefined;
  };

  for (const op of transaction.operations) {
    const targets = op.kind === 'batch_transform'
      ? op.targets
      : op.kind === 'create'
        ? [op.template]
        : op.kind === 'duplicate'
          ? [op.target]
          : [op.target];
    for (const target of targets) {
      if (isAmbiguousTarget(target)) {
        diagnostics.push({
          severity: 'error',
          code: 'MAP_ENTITY_AMBIGUOUS',
          message: `目标实体标识不唯一；请使用唯一 stableKey/id，且该 native writer 当前不接受重名实体: ${target}`,
          target
        });
      }
    }
  }

  for (const op of transaction.operations) {
    switch (op.kind) {
      case 'set_transform': {
        if (wasDeleted(op.target)) {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_ENTITY_NOT_FOUND',
            message: `目标实体已被前序操作删除: ${op.target}`,
            target: op.target
          });
          break;
        }
        const entity = resolveWorkingEntity(op.target);
        if (!op.position && !op.rotation && !op.scale) {
          diagnostics.push({ severity: 'error', code: 'MAP_TRANSFORM_EMPTY', message: `变换操作没有任何字段: ${op.target}`, target: op.target });
          break;
        }
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
        if (op.targets.length === 0) {
          diagnostics.push({ severity: 'error', code: 'MAP_BATCH_EMPTY', message: '批量变换至少需要一个目标。' });
          break;
        }
        if (!op.positionDelta && !op.rotationDelta && !op.scaleDelta) {
          diagnostics.push({ severity: 'error', code: 'MAP_BATCH_DELTA_EMPTY', message: '批量变换没有任何变化量。' });
          break;
        }
        for (const target of op.targets) {
          if (wasDeleted(target)) {
            diagnostics.push({
              severity: 'error',
              code: 'MAP_ENTITY_NOT_FOUND',
              message: `批量变换目标已被前序操作删除: ${target}`,
              target
            });
            continue;
          }
          const entity = resolveWorkingEntity(target);
          if (!entity) {
            diagnostics.push({
              severity: 'error',
              code: 'MAP_ENTITY_NOT_FOUND',
              message: `批量变换目标不存在: ${target}`,
              target
            });
          } else if (entity.kind !== 'part' && entity.kind !== 'region') {
            diagnostics.push({
              severity: 'error',
              code: 'MAP_ENTITY_NOT_TRANSFORMABLE',
              message: `实体类型 ${entity.kind} 不支持批量变换: ${target}`,
              target
            });
          }
        }
        break;
      }
      case 'set_property': {
        if (wasDeleted(op.target)) {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_ENTITY_NOT_FOUND',
            message: `属性修改目标实体已被前序操作删除: ${op.target}`,
            target: op.target
          });
          break;
        }
        const entity = resolveWorkingEntity(op.target);
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
          } else if (entity.kind !== 'part' && entity.kind !== 'region') {
            diagnostics.push({
              severity: 'error',
              code: 'MAP_PROPERTY_UNSUPPORTED',
              message: `实体类型 ${entity.kind} 不支持 entityId 写入；Event 的 +0x08 是 eventId，不是通用 entityId`,
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
        if (wasDeleted(op.target)) {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_PART_NOT_FOUND',
            message: `修改模型目标 Part 已被前序操作删除: ${op.target}`,
            target: op.target
          });
          break;
        }
        const part = resolveWorkingEntity(op.target);
        if (!part || part.kind !== 'part') {
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
      case 'duplicate': {
        const source = resolveWorkingEntity(op.target);
        validateNewEntityName(doc, op.newName, diagnostics, op.target, workingKinds.keys());
        reserveNewEntityName(op.newName, reservedNewNames, diagnostics, op.target);
        if (!source) {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_ENTITY_NOT_FOUND',
            message: `复制模板实体不存在: ${op.target}`,
            target: op.target
          });
        } else if (source.pending) {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_DUPLICATE_UNSUPPORTED',
            message: '当前 native template contract 不允许在同一批次复制刚创建的 pending Part',
            target: op.target
          });
        } else if (source.kind !== 'part') {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_DUPLICATE_UNSUPPORTED',
            message: `当前 native template contract 只允许复制 Part，收到: ${source.kind}`,
            target: op.target
          });
        }
        if (op.modelName !== undefined && !doc.models.some((model) => model.name === op.modelName)) {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_MODEL_NOT_IN_MANIFEST',
            message: `复制后的模型 ${op.modelName} 不在当前地图 Model 声明表中`,
            target: op.target
          });
        }
        if (op.entityId !== undefined && !Number.isInteger(op.entityId)) {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_PROPERTY_VALUE_INVALID',
            message: '复制后的 entityId 必须是整数',
            target: op.target
          });
        }
        if (source?.kind === 'part' && !source.pending && !workingKinds.has(op.newName)) {
          workingKinds.set(op.newName, 'part');
          pendingNames.add(op.newName);
        }
        break;
      }
      case 'create': {
        const template = resolveWorkingEntity(op.template);
        validateNewEntityName(doc, op.newName, diagnostics, op.template, workingKinds.keys());
        reserveNewEntityName(op.newName, reservedNewNames, diagnostics, op.template);
        if (op.entityKind !== 'part') {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_CREATE_UNSUPPORTED',
            message: `当前 native template contract 只允许创建 Part，收到: ${op.entityKind}`,
            target: op.template
          });
        } else if (!template) {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_ENTITY_NOT_FOUND',
            message: `创建模板实体不存在: ${op.template}`,
            target: op.template
          });
        } else if (template.pending) {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_CREATE_UNSUPPORTED',
            message: '当前 native template contract 不允许从同一批次刚创建的 pending Part 再创建',
            target: op.template
          });
        } else if (template.kind !== 'part') {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_CREATE_UNSUPPORTED',
            message: `创建模板必须是 Part，收到: ${template.kind}`,
            target: op.template
          });
        }
        if (op.modelName !== undefined && !doc.models.some((model) => model.name === op.modelName)) {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_MODEL_NOT_IN_MANIFEST',
            message: `创建后的模型 ${op.modelName} 不在当前地图 Model 声明表中`,
            target: op.template
          });
        }
        if (op.entityId !== undefined && !Number.isInteger(op.entityId)) {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_PROPERTY_VALUE_INVALID',
            message: '创建后的 entityId 必须是整数',
            target: op.template
          });
        }
        if (template?.kind === 'part' && !template.pending && !workingKinds.has(op.newName)) {
          workingKinds.set(op.newName, 'part');
          pendingNames.add(op.newName);
        }
        break;
      }
      case 'delete': {
        if (wasDeleted(op.target)) {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_ENTITY_NOT_FOUND',
            message: `目标实体已被重复删除: ${op.target}`,
            target: op.target
          });
          break;
        }
        const entity = resolveWorkingEntity(op.target);
        if (!entity) {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_ENTITY_NOT_FOUND',
            message: `删除目标实体不存在: ${op.target}`,
            target: op.target
          });
        } else {
          if (entity.pending) {
            diagnostics.push({
              severity: 'error',
              code: 'MAP_OPERATION_UNSUPPORTED',
              message: '同一事务中创建的 pending Part 不能再被 delete；请提交单一净变更事务',
              target: op.target
            });
            break;
          }
          deletedTargets.add(entity.name);
          workingKinds.delete(entity.name);
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
  entityKind?: 'part' | 'region' | undefined;
  templateStableKey?: string | undefined;
  name?: string | undefined;
  modelName?: string | undefined;
  entityId?: number | undefined;
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
        if (mut.name !== undefined) {
          return {
            ok: false,
            conflict: false,
            error: `MAP_NAME_UNSUPPORTED: Blender 名称修改尚未接入原生 MSB 字段 (${mut.stableKey})`
          };
        }
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
        if (!mut.position && !mut.rotation && !mut.scale && !mut.modelName) {
          return {
            ok: false,
            conflict: false,
            error: `MAP_MODIFY_EMPTY: Blender modify 没有可写字段 (${mut.stableKey})`
          };
        }
        break;
      }
      case 'duplicate': {
        if (!mut.name) {
          return { ok: false, conflict: false, error: `MAP_DUPLICATE_NAME_REQUIRED: duplicate 必须提供新名称 (${mut.stableKey})` };
        }
        const source = new MapSceneGraph(doc).findEntity(mut.stableKey);
        if (!source || source.kind !== 'part' || (mut.entityKind !== undefined && mut.entityKind !== 'part')) {
          return {
            ok: false,
            conflict: false,
            error: `MAP_DUPLICATE_UNSUPPORTED: 当前 native template contract 只允许复制 Part (${mut.stableKey})`
          };
        }
        operations.push({
          kind: 'duplicate',
          target: mut.stableKey,
          newName: mut.name,
          ...(mut.position ? { position: mut.position } : {}),
          ...(mut.rotation ? { rotation: mut.rotation } : {}),
          ...(mut.scale ? { scale: mut.scale } : {}),
          ...(mut.modelName ? { modelName: mut.modelName } : {}),
          ...(mut.entityId !== undefined ? { entityId: mut.entityId } : {})
        });
        break;
      }
      case 'delete': {
        operations.push({
          kind: 'delete',
          target: mut.stableKey
        });
        break;
      }
      case 'create': {
        const templateKey = mut.templateStableKey ?? mut.stableKey;
        if (!mut.name) {
          return { ok: false, conflict: false, error: `MAP_CREATE_NAME_REQUIRED: create 必须提供新名称 (${templateKey})` };
        }
        const template = new MapSceneGraph(doc).findEntity(templateKey);
        if (!template || template.kind !== 'part' || (mut.entityKind !== undefined && mut.entityKind !== 'part')) {
          return {
            ok: false,
            conflict: false,
            error: `MAP_CREATE_UNSUPPORTED: 当前 native template contract 只允许从 Part 模板创建 (${templateKey})`
          };
        }
        operations.push({
          kind: 'create',
          template: templateKey,
          newName: mut.name,
          entityKind: 'part',
          ...(mut.position ? { position: mut.position } : {}),
          ...(mut.rotation ? { rotation: mut.rotation } : {}),
          ...(mut.scale ? { scale: mut.scale } : {}),
          ...(mut.modelName ? { modelName: mut.modelName } : {}),
          ...(mut.entityId !== undefined ? { entityId: mut.entityId } : {})
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

function validateNewEntityName(
  doc: MapDocument,
  newName: string,
  diagnostics: MapTransactionValidationResult['diagnostics'],
  target: string,
  workingNames?: Iterable<string>
): void {
  if (!newName.trim() || newName !== newName.trim() || newName.includes('\0')) {
    diagnostics.push({
      severity: 'error',
      code: 'MAP_NEW_NAME_INVALID',
      message: '新实体名称不能为空且不能包含 NUL',
      target
    });
    return;
  }
  const occupied = [
    ...doc.models,
    ...doc.parts,
    ...doc.regions,
    ...doc.events,
    ...doc.routes
  ].some((entity) => entity.name === newName);
  const occupiedInWorkingState = workingNames !== undefined
    && [...workingNames].some((name) => name === newName);
  if (occupied || occupiedInWorkingState) {
    diagnostics.push({
      severity: 'error',
      code: 'MAP_NEW_NAME_CONFLICT',
      message: `新实体名称已存在: ${newName}`,
      target
    });
  }
}

function reserveNewEntityName(
  name: string,
  reserved: Set<string>,
  diagnostics: MapTransactionValidationResult['diagnostics'],
  target: string
): void {
  if (reserved.has(name)) {
    diagnostics.push({
      severity: 'error',
      code: 'MAP_NEW_NAME_CONFLICT',
      message: `同一事务中重复声明新实体名称: ${name}`,
      target
    });
  }
  reserved.add(name);
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
