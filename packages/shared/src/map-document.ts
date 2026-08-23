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
  private readonly entityByEntityId = new Map<number, MapEntity[]>();
  private readonly partsByModelName = new Map<string, MapPartEntity[]>();
  private readonly eventsByReferencedRegion = new Map<string, MapEventEntity[]>();
  private readonly eventsByReferencedPart = new Map<string, MapEventEntity[]>();

  constructor(document: MapDocument) {
    this.document = document;
    this.buildIndices();
  }

  private buildIndices(): void {
    const allEntities: MapEntity[] = [
      ...this.document.models,
      ...this.document.parts,
      ...this.document.regions,
      ...this.document.events,
      ...this.document.routes
    ];

    for (const entity of allEntities) {
      this.entityById.set(entity.id, entity);
      this.entityByStableKey.set(entity.stableKey, entity);
      this.entityByAddress.set(entity.address, entity);
      if (!this.entityByName.has(entity.name)) {
        this.entityByName.set(entity.name, entity);
      }
      if (entity.entityId !== undefined && entity.entityId > 0) {
        const list = this.entityByEntityId.get(entity.entityId) ?? [];
        list.push(entity);
        this.entityByEntityId.set(entity.entityId, list);
      }
    }

    for (const part of this.document.parts) {
      if (part.modelName) {
        const list = this.partsByModelName.get(part.modelName) ?? [];
        list.push(part);
        this.partsByModelName.set(part.modelName, list);
      }
    }

    for (const event of this.document.events) {
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
  }

  public getDocument(): MapDocument {
    return this.document;
  }

  public findEntity(identifier: string): MapEntity | undefined {
    return (
      this.entityById.get(identifier) ||
      this.entityByStableKey.get(identifier) ||
      this.entityByAddress.get(identifier) ||
      this.entityByName.get(identifier)
    );
  }

  public findPart(identifier: string): MapPartEntity | undefined {
    const entity = this.findEntity(identifier);
    return entity && entity.kind === 'part' ? entity : undefined;
  }

  public findRegion(identifier: string): MapRegionEntity | undefined {
    const entity = this.findEntity(identifier);
    return entity && entity.kind === 'region' ? entity : undefined;
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
      property: string;
      value: unknown;
    }
  | {
      kind: 'change_model';
      target: string;
      newModelName: string;
    }
  | {
      kind: 'duplicate';
      sourceTarget: string;
      newName?: string | undefined;
      transformOffset?: [number, number, number] | undefined;
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

/**
 * Validates a MapEditTransaction against a target MapDocument.
 */
export function validateMapTransaction(
  doc: MapDocument,
  transaction: MapEditTransaction
): MapTransactionValidationResult {
  const diagnostics: MapTransactionValidationResult['diagnostics'] = [];
  const sceneGraph = new MapSceneGraph(doc);

  for (const op of transaction.operations) {
    switch (op.kind) {
      case 'set_transform': {
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
      case 'change_model': {
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
              severity: 'warning',
              code: 'MAP_MODEL_NOT_IN_MANIFEST',
              message: `模型 ${op.newModelName} 尚未在地图 Model 声明表中，将在写入时建立引用`,
              target: op.target
            });
          }
        }
        break;
      }
      case 'duplicate': {
        const source = sceneGraph.findEntity(op.sourceTarget);
        if (!source) {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_SOURCE_NOT_FOUND',
            message: `复制源实体不存在: ${op.sourceTarget}`,
            target: op.sourceTarget
          });
        }
        break;
      }
      case 'delete': {
        const entity = sceneGraph.findEntity(op.target);
        if (!entity) {
          diagnostics.push({
            severity: 'error',
            code: 'MAP_ENTITY_NOT_FOUND',
            message: `删除目标实体不存在: ${op.target}`,
            target: op.target
          });
        } else {
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
  typeId: number;
  modelName?: string | undefined;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  entityId?: number | undefined;
  sourceRevision: string;
}

export interface BlenderSceneExport {
  schemaVersion: 1;
  mapId: string;
  sourceUri: string;
  revision: string;
  exportedAt: string;
  objects: BlenderObjectDto[];
}

export interface BlenderObjectMutation {
  stableKey: string;
  action: 'modify' | 'duplicate' | 'delete' | 'create';
  name?: string | undefined;
  typeId?: number | undefined;
  modelName?: string | undefined;
  position?: [number, number, number] | undefined;
  rotation?: [number, number, number] | undefined;
  scale?: [number, number, number] | undefined;
  entityId?: number | undefined;
}

export interface BlenderDeltaImport {
  schemaVersion: 1;
  mapId: string;
  baseRevision: string;
  importedAt: string;
  mutations: BlenderObjectMutation[];
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
      typeId: part.typeId,
      modelName: part.modelName,
      position: [...part.transform.position],
      rotation: [...part.transform.rotation],
      scale: [...part.transform.scale],
      ...(part.entityId !== undefined ? { entityId: part.entityId } : {}),
      sourceRevision: doc.revision
    });
  }

  for (const region of doc.regions) {
    objects.push({
      stableKey: region.stableKey,
      soulAddress: region.address,
      entityKind: 'region',
      name: region.name,
      typeId: region.typeId,
      position: [...region.transform.position],
      rotation: [...region.transform.rotation],
      scale: [...region.transform.scale],
      ...(region.entityId !== undefined ? { entityId: region.entityId } : {}),
      sourceRevision: doc.revision
    });
  }

  return {
    schemaVersion: 1,
    mapId: doc.mapId,
    sourceUri: doc.sourceUri,
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
): { ok: true; transaction: MapEditTransaction } | { ok: false; error: string; conflict: boolean } {
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
        operations.push({
          kind: 'duplicate',
          sourceTarget: mut.stableKey,
          ...(mut.name ? { newName: mut.name } : {}),
          ...(mut.position ? { transformOffset: mut.position } : {})
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
