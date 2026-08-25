/**
 * Canonical MapDocument, SceneGraph, EditTransaction, and Blender Adapter boundaries.
 *
 * This module defines the renderer-independent, authoritative semantic representation
 * of Sekiro MSB maps, ensuring human UI, Agent tools, and external 3D tools (Blender)
 * share a single transaction and object identity model.
 */

import { formatMapAddress, parseMapAddress } from './soulAddress.js';

export type MapEntityKind = 'model' | 'part' | 'region' | 'event' | 'route';
export type MapEntityFamily = MapEntityKind;

export interface MapNativeIdentity {
  family: MapEntityFamily;
  nativeOffset: number;
  expectedName?: string | undefined;
}

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
  family: MapEntityFamily;
  typeId: number;
  nativeOffset: number;
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

export type MapEntityResolution =
  | { ok: true; entity: MapEntity }
  | { ok: false; code: 'MAP_ENTITY_NOT_FOUND' | 'MAP_ENTITY_AMBIGUOUS'; candidates: MapEntity[] };

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
  private readonly entityById = new Map<string, MapEntity[]>();
  private readonly entityByStableKey = new Map<string, MapEntity[]>();
  private readonly entityByAddress = new Map<string, MapEntity[]>();
  private readonly entityByNativeIdentity = new Map<string, MapEntity[]>();
  private readonly entityByName = new Map<string, MapEntity[]>();
  private readonly partsByName = new Map<string, MapPartEntity[]>();
  private readonly regionsByName = new Map<string, MapRegionEntity[]>();
  private readonly modelsByName = new Map<string, MapModelEntity[]>();
  private readonly eventsByName = new Map<string, MapEventEntity[]>();
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
      this.addIndex(this.entityById, model.id, model);
      this.addIndex(this.entityByStableKey, model.stableKey, model);
      this.addIndex(this.entityByAddress, model.address, model);
      this.addIndex(this.entityByNativeIdentity, nativeIdentityKey(model.family, model.nativeOffset), model);
      this.addIndex(this.entityByName, model.name, model);
      this.addIndex(this.modelsByName, model.name, model);
    }

    for (const part of this.document.parts) {
      this.addIndex(this.entityById, part.id, part);
      this.addIndex(this.entityByStableKey, part.stableKey, part);
      this.addIndex(this.entityByAddress, part.address, part);
      this.addIndex(this.entityByNativeIdentity, nativeIdentityKey(part.family, part.nativeOffset), part);
      this.addIndex(this.entityByName, part.name, part);
      this.addIndex(this.partsByName, part.name, part);

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
      this.addIndex(this.entityById, region.id, region);
      this.addIndex(this.entityByStableKey, region.stableKey, region);
      this.addIndex(this.entityByAddress, region.address, region);
      this.addIndex(this.entityByNativeIdentity, nativeIdentityKey(region.family, region.nativeOffset), region);
      this.addIndex(this.entityByName, region.name, region);
      this.addIndex(this.regionsByName, region.name, region);

      if (region.entityId !== undefined && region.entityId > 0) {
        const list = this.entityByEntityId.get(region.entityId) ?? [];
        list.push(region);
        this.entityByEntityId.set(region.entityId, list);
      }
    }

    for (const event of this.document.events) {
      this.addIndex(this.entityById, event.id, event);
      this.addIndex(this.entityByStableKey, event.stableKey, event);
      this.addIndex(this.entityByAddress, event.address, event);
      this.addIndex(this.entityByNativeIdentity, nativeIdentityKey(event.family, event.nativeOffset), event);
      this.addIndex(this.entityByName, event.name, event);
      this.addIndex(this.eventsByName, event.name, event);

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
      this.addIndex(this.entityById, route.id, route);
      this.addIndex(this.entityByStableKey, route.stableKey, route);
      this.addIndex(this.entityByAddress, route.address, route);
      this.addIndex(this.entityByNativeIdentity, nativeIdentityKey(route.family, route.nativeOffset), route);
      this.addIndex(this.entityByName, route.name, route);
    }
  }

  private addIndex<T extends MapEntity>(index: Map<string, T[]>, key: string, value: T): void {
    const values = index.get(key) ?? [];
    values.push(value);
    index.set(key, values);
  }

  private resolveIndex<T extends MapEntity>(index: Map<string, T[]>, identifier: string): MapEntityResolution | undefined {
    const candidates = index.get(identifier);
    if (!candidates || candidates.length === 0) return undefined;
    return candidates.length === 1
      ? { ok: true, entity: candidates[0]! }
      : { ok: false, code: 'MAP_ENTITY_AMBIGUOUS', candidates: [...candidates] };
  }

  public getDocument(): MapDocument {
    return this.document;
  }

  /** Resolves exact identities first; a display-name alias is never silently overwritten. */
  public resolveEntity(identifier: string): MapEntityResolution {
    for (const index of [this.entityById, this.entityByStableKey, this.entityByAddress]) {
      const result = this.resolveIndex(index, identifier);
      if (result) return result;
    }
    return this.resolveIndex(this.entityByName, identifier)
      ?? { ok: false, code: 'MAP_ENTITY_NOT_FOUND', candidates: [] };
  }

  public resolveNativeIdentity(identity: MapNativeIdentity): MapEntityResolution {
    const result = this.resolveIndex(
      this.entityByNativeIdentity,
      nativeIdentityKey(identity.family, identity.nativeOffset)
    );
    if (!result) return { ok: false, code: 'MAP_ENTITY_NOT_FOUND', candidates: [] };
    if (result.ok && identity.expectedName !== undefined && result.entity.name !== identity.expectedName) {
      return { ok: false, code: 'MAP_ENTITY_NOT_FOUND', candidates: [result.entity] };
    }
    return result;
  }

  public findEntity(identifier: string): MapEntity | undefined {
    const result = this.resolveEntity(identifier);
    return result.ok ? result.entity : undefined;
  }

  public findPart(identifier: string): MapPartEntity | undefined {
    const direct = this.resolveIndex(this.partsByName, identifier);
    if (direct?.ok) return direct.entity as MapPartEntity;
    if (direct) return undefined;
    const entity = this.findEntity(identifier);
    return entity && entity.kind === 'part' ? entity : undefined;
  }

  public findRegion(identifier: string): MapRegionEntity | undefined {
    const direct = this.resolveIndex(this.regionsByName, identifier);
    if (direct?.ok) return direct.entity as MapRegionEntity;
    if (direct) return undefined;
    const entity = this.findEntity(identifier);
    return entity && entity.kind === 'region' ? entity : undefined;
  }

  public findModel(identifier: string): MapModelEntity | undefined {
    const direct = this.resolveIndex(this.modelsByName, identifier);
    if (direct?.ok) return direct.entity as MapModelEntity;
    if (direct) return undefined;
    const entity = this.findEntity(identifier);
    return entity && entity.kind === 'model' ? entity : undefined;
  }

  public findEvent(identifier: string): MapEventEntity | undefined {
    const direct = this.resolveIndex(this.eventsByName, identifier);
    if (direct?.ok) return direct.entity as MapEventEntity;
    if (direct) return undefined;
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
  const canonicalKey = (target: string): string => {
    const resolved = sceneGraph.resolveEntity(target);
    return resolved.ok ? resolved.entity.stableKey : target;
  };
  const resolveTarget = (target: string, label: string): MapEntity | undefined => {
    const key = canonicalKey(target);
    if (deletedTargets.has(key)) {
      diagnostics.push({
        severity: 'error',
        code: 'MAP_ENTITY_NOT_FOUND',
        message: `${label}目标已被前序操作删除: ${target}`,
        target
      });
      return undefined;
    }
    const result = sceneGraph.resolveEntity(target);
    if (!result.ok) {
      diagnostics.push({
        severity: 'error',
        code: result.code,
        message: result.code === 'MAP_ENTITY_AMBIGUOUS'
          ? `${label}目标不唯一，必须使用 stableKey 或 soulAddress: ${target}`
          : `${label}目标不存在: ${target}`,
        target
      });
      return undefined;
    }
    return result.entity;
  };
  const validateVector = (value: number[] | undefined, target: string, field: string): void => {
    if (value && (value.length !== 3 || value.some((item) => !Number.isFinite(item)))) {
      diagnostics.push({
        severity: 'error',
        code: 'MAP_TRANSFORM_VALUE_INVALID',
        message: `${field} 必须是三个有限数值: ${target}`,
        target
      });
    }
  };

  for (const op of transaction.operations) {
    switch (op.kind) {
      case 'set_transform': {
        const entity = resolveTarget(op.target, '变换');
        validateVector(op.position, op.target, 'position');
        validateVector(op.rotation, op.target, 'rotation');
        validateVector(op.scale, op.target, 'scale');
        if (entity && entity.kind !== 'part' && entity.kind !== 'region') {
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
          diagnostics.push({ severity: 'error', code: 'MAP_BATCH_TARGETS_EMPTY', message: '批量变换必须包含至少一个目标。' });
        }
        validateVector(op.positionDelta, 'batch_transform', 'positionDelta');
        validateVector(op.rotationDelta, 'batch_transform', 'rotationDelta');
        validateVector(op.scaleDelta, 'batch_transform', 'scaleDelta');
        for (const target of op.targets) {
          const entity = resolveTarget(target, '批量变换');
          if (entity && entity.kind !== 'part' && entity.kind !== 'region') {
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
        const entity = resolveTarget(op.target, '属性修改');
        if (op.property !== 'entityId') {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_PROPERTY_UNSUPPORTED',
            message: `不支持的属性修改: ${op.property}，当前仅支持权威字段 entityId`,
            target: op.target
          });
        } else if (entity && entity.kind !== 'part' && entity.kind !== 'region') {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_PROPERTY_KIND_UNSUPPORTED',
            message: `实体类型 ${entity.kind} 不允许写 entityId；仅 Part/Region 支持该字段。`,
            target: op.target
          });
        } else if (typeof op.value !== 'number' || !Number.isSafeInteger(op.value)) {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_PROPERTY_VALUE_INVALID',
            message: `entityId 属性值必须是安全整数，收到: ${String(op.value)}`,
            target: op.target
          });
        }
        break;
      }
      case 'change_model': {
        const entity = resolveTarget(op.target, '修改模型');
        if (entity && entity.kind !== 'part') {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_PART_NOT_FOUND',
            message: `修改模型目标必须是 Part: ${op.target}`,
            target: op.target
          });
        }
        const modelMatches = doc.models.filter((model) => model.name === op.newModelName);
        if (modelMatches.length === 0) {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_MODEL_NOT_IN_MANIFEST',
            message: `模型 ${op.newModelName} 尚未在地图 Model 声明表中，当前不支持跨地图未声明模型引用`,
            target: op.target
          });
        } else if (modelMatches.length > 1) {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_MODEL_AMBIGUOUS',
            message: `模型 ${op.newModelName} 在 Model 声明表中不唯一。`,
            target: op.target
          });
        }
        break;
      }
      case 'delete': {
        const entity = resolveTarget(op.target, '删除');
        if (!entity) break;
        if (deletedTargets.has(entity.stableKey)) {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_ENTITY_NOT_FOUND',
            message: `目标实体已被重复删除: ${op.target}`,
            target: op.target
          });
          break;
        }
        if (entity.kind === 'model' || entity.kind === 'route') {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_DELETE_UNSUPPORTED',
            message: `当前 native writer 不支持删除 ${entity.kind}。`,
            target: op.target
          });
          break;
        }
        deletedTargets.add(entity.stableKey);
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
  family: MapEntityFamily;
  nativeOffset: number;
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
  family?: MapEntityFamily | undefined;
  nativeOffset?: number | undefined;
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
      family: part.family,
      nativeOffset: part.nativeOffset,
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
      family: region.family,
      nativeOffset: region.nativeOffset,
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
        const target = resolveBlenderTarget(doc, mut);
        if (!target.ok) return target;
        const operationCountBefore = operations.length;
        if (mut.position || mut.rotation || mut.scale) {
          operations.push({
            kind: 'set_transform',
            target: target.entity.stableKey,
            ...(mut.position ? { position: mut.position } : {}),
            ...(mut.rotation ? { rotation: mut.rotation } : {}),
            ...(mut.scale ? { scale: mut.scale } : {})
          });
        }
        if (mut.modelName !== undefined) {
          operations.push({
            kind: 'change_model',
            target: target.entity.stableKey,
            newModelName: mut.modelName
          });
        }
        if (operations.length === operationCountBefore) {
          return {
            ok: false,
            conflict: false,
            error: `MAP_MODIFY_EMPTY: Blender modify 未提供 position、rotation、scale 或 modelName (${mut.stableKey})`
          };
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
        const target = resolveBlenderTarget(doc, mut);
        if (!target.ok) return target;
        operations.push({
          kind: 'delete',
          target: target.entity.stableKey
        });
        break;
      }
      case 'create': {
        return {
          ok: false,
          conflict: false,
          error: `MAP_CREATE_UNSUPPORTED: Blender create 不支持 native MSB 实体新增 (${mut.stableKey})`
        };
      }
      default:
        return assertNeverBlenderAction(mut.action);
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
    const nativeOffset = requireNativeOffset(m.nativeOffset, 'model', m.name);
    const address = formatMapAddress({ block: mapId, name: m.name });
    const stableKey = `model:${mapId}:offset-${nativeOffset.toString(16)}`;
    return {
      id: stableKey,
      stableKey,
      address,
      mapId,
      name: m.name,
      kind: 'model',
      family: 'model',
      typeId: m.typeId ?? 0,
      nativeOffset
    };
  });

  const parts: MapPartEntity[] = input.parts.map((p, idx) => {
    const nativeOffset = requireNativeOffset(p.nativeOffset, 'part', p.name);
    const address = formatMapAddress({ block: mapId, name: p.name });
    const stableKey = `part:${mapId}:offset-${nativeOffset.toString(16)}`;
    const modelIndex = p.modelIndex ?? 0;
    const modelName = models[modelIndex]?.name ?? (p.modelIndex !== undefined ? `model_${p.modelIndex}` : 'unknown');

    return {
      id: stableKey,
      stableKey,
      address,
      mapId,
      name: p.name,
      kind: 'part',
      family: 'part',
      typeId: p.typeId,
      modelIndex,
      modelName,
      transform: {
        position: [p.posX, p.posY, p.posZ],
        rotation: [p.rotX ?? 0, p.rotY ?? 0, p.rotZ ?? 0],
        scale: [p.scaleX ?? 1, p.scaleY ?? 1, p.scaleZ ?? 1]
      },
      nativeOffset,
      ...(p.entityId !== undefined ? { entityId: p.entityId } : {})
    };
  });

  const regions: MapRegionEntity[] = (input.regions ?? []).map((r, idx) => {
    const nativeOffset = requireNativeOffset(r.nativeOffset, 'region', r.name);
    const address = formatMapAddress({ block: mapId, name: r.name });
    const stableKey = `region:${mapId}:offset-${nativeOffset.toString(16)}`;

    return {
      id: stableKey,
      stableKey,
      address,
      mapId,
      name: r.name,
      kind: 'region',
      family: 'region',
      typeId: r.typeId,
      transform: {
        position: [r.posX, r.posY, r.posZ],
        rotation: [r.rotX ?? 0, r.rotY ?? 0, r.rotZ ?? 0],
        scale: [r.scaleX ?? 1, r.scaleY ?? 1, r.scaleZ ?? 1]
      },
      nativeOffset,
      ...(r.entityId !== undefined ? { entityId: r.entityId } : {})
    };
  });

  const events: MapEventEntity[] = (input.events ?? []).map((e, idx) => {
    const nativeOffset = requireNativeOffset(e.nativeOffset, 'event', e.name);
    const address = formatMapAddress({ block: mapId, name: e.name });
    const stableKey = `event:${mapId}:offset-${nativeOffset.toString(16)}`;

    return {
      id: stableKey,
      stableKey,
      address,
      mapId,
      name: e.name,
      kind: 'event',
      family: 'event',
      typeId: e.typeId,
      ...(e.eventId !== undefined ? { eventId: e.eventId } : {}),
      nativeOffset
    };
  });

  const routes: MapRouteEntity[] = (input.routes ?? []).map((rt, idx) => {
    const nativeOffset = requireNativeOffset(rt.nativeOffset, 'route', rt.name);
    const address = formatMapAddress({ block: mapId, name: rt.name });
    const stableKey = `route:${mapId}:offset-${nativeOffset.toString(16)}`;

    return {
      id: stableKey,
      stableKey,
      address,
      mapId,
      name: rt.name,
      kind: 'route',
      family: 'route',
      typeId: rt.typeId,
      ...(rt.id !== undefined ? { routeId: rt.id } : {}),
      nativeOffset
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

function nativeIdentityKey(family: MapEntityFamily, nativeOffset: number): string {
  return `${family}:${nativeOffset}`;
}

function requireNativeOffset(value: number | undefined, family: MapEntityFamily, name: string): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`MAP_NATIVE_OFFSET_REQUIRED: ${family} ${name} 缺少有效 nativeOffset，已失败关闭。`);
  }
  return value;
}

function resolveBlenderTarget(
  doc: MapDocument,
  mutation: BlenderMutationDto
): { ok: true; entity: MapEntity } | { ok: false; error: string; conflict?: boolean } {
  if (mutation.family === undefined || mutation.nativeOffset === undefined) {
    return {
      ok: false,
      conflict: true,
      error: `MAP_NATIVE_OFFSET_REQUIRED: Blender ${mutation.action} 必须携带 family + nativeOffset (${mutation.stableKey})`
    };
  }
  const sceneGraph = new MapSceneGraph(doc);
  const resolved = sceneGraph.resolveNativeIdentity({
    family: mutation.family,
    nativeOffset: mutation.nativeOffset
  });
  if (!resolved.ok) {
    return {
      ok: false,
      conflict: true,
      error: `MAP_NATIVE_IDENTITY_NOT_FOUND: ${mutation.family}@${mutation.nativeOffset}`
    };
  }
  if (resolved.entity.stableKey !== mutation.stableKey) {
    return {
      ok: false,
      conflict: true,
      error: `MAP_NATIVE_IDENTITY_MISMATCH: stableKey 与 family/nativeOffset 不一致 (${mutation.stableKey})`
    };
  }
  return { ok: true, entity: resolved.entity };
}

function assertNeverBlenderAction(value: never): never {
  throw new Error(`未处理的 Blender action: ${String(value)}`);
}
