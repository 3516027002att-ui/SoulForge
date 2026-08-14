/**
 * MSB Bridge read helper for desktop scene / workbench (renderer-safe DTOs only).
 *
 * 三层截断移除后，默认返回 Bridge 完整实体表（models/parts/regions/events/routes）。
 * maxParts/maxRegions/maxModels/maxEvents 仅在调用方显式传入时作为有界窗口
 * （scaleAccess=bounded-window），默认不截断。
 */

import { runBridge } from '../bridge/runBridge.js';

export interface MsbBridgePart {
  name: string;
  nativeOffset?: number;
  typeId: number;
  modelIndex?: number;
  posX: number;
  posY: number;
  posZ: number;
  rotX?: number;
  scaleX?: number;
  scaleY?: number;
  scaleZ?: number;
}

export interface MsbBridgeRegion {
  name: string;
  nativeOffset?: number;
  typeId: number;
  posX: number;
  posY: number;
  posZ: number;
}

export interface MsbBridgeModel {
  name: string;
  nativeOffset?: number;
  typeId: number;
}

export interface MsbBridgeEvent {
  name: string;
  nativeOffset?: number;
  typeId: number;
  eventId?: number;
}

export interface MsbBridgeRoute {
  name: string;
  nativeOffset?: number;
  typeId: number;
  id?: number;
}

export interface MsbBridgeDocument {
  sourceHash: string;
  version: number;
  modelCount: number;
  partCount: number;
  regionCount: number;
  eventCount: number;
  routeCount: number;
  models: MsbBridgeModel[];
  parts: MsbBridgePart[];
  regions: MsbBridgeRegion[];
  events: MsbBridgeEvent[];
  routes: MsbBridgeRoute[];
  authority?: string;
  entityEdit?: string;
}

export async function readMsbDocumentViaBridge(input: {
  sourcePath: string;
  allowedRoots: string[];
  timeoutMs?: number;
  maxParts?: number;
  maxRegions?: number;
  maxModels?: number;
  maxEvents?: number;
  /** P5 裁定：真实游戏 .msb.dcx 是 KRAK 压缩，缺 Oodle 运行时解不出实体表。 */
  oodleRuntimeRoot?: string;
}): Promise<{
  ok: boolean;
  data?: MsbBridgeDocument;
  diagnostics: Array<{ severity: string; code: string; message: string }>;
}> {
  const result = await runBridge<{
    sourceHash?: string;
    version?: number;
    modelCount?: number;
    partCount?: number;
    regionCount?: number;
    eventCount?: number;
    routeCount?: number;
    models?: Array<Record<string, unknown>>;
    parts?: Array<Record<string, unknown>>;
    regions?: Array<Record<string, unknown>>;
    events?: Array<Record<string, unknown>>;
    routes?: Array<Record<string, unknown>>;
    authority?: string;
    entityEdit?: string;
  }>({
    command: 'read-msb-document',
    filePath: input.sourcePath,
    allowedRoots: input.allowedRoots,
    timeoutMs: input.timeoutMs ?? 120_000,
    ...(input.oodleRuntimeRoot ? { oodleRuntimeRoot: input.oodleRuntimeRoot } : {})
  });
  if (result.parseStatus === 'failed' || !result.data?.sourceHash) {
    return {
      ok: false,
      diagnostics: result.diagnostics.map((d) => ({
        severity: d.severity,
        code: d.code,
        message: d.message
      }))
    };
  }
  const bounded = (count: number | undefined, defaultValue: number): number | undefined =>
    count === undefined ? defaultValue : count;
  const maxParts = bounded(input.maxParts, Number.MAX_SAFE_INTEGER);
  const maxRegions = bounded(input.maxRegions, Number.MAX_SAFE_INTEGER);
  const maxModels = bounded(input.maxModels, Number.MAX_SAFE_INTEGER);
  const maxEvents = bounded(input.maxEvents, Number.MAX_SAFE_INTEGER);
  const models = (result.data.models ?? []).slice(0, maxModels).map((model) => ({
    name: String(model.name ?? ''),
    ...(model.offset === undefined ? {} : { nativeOffset: Number(model.offset) }),
    typeId: Number(model.typeId ?? 0)
  }));
  const parts = (result.data.parts ?? []).slice(0, maxParts).map((p) => ({
    name: String(p.name ?? ''),
    ...(p.offset === undefined ? {} : { nativeOffset: Number(p.offset) }),
    typeId: Number(p.typeId ?? 0),
    ...(p.modelIndex === undefined ? {} : { modelIndex: Number(p.modelIndex) }),
    posX: Number(p.posX ?? 0),
    posY: Number(p.posY ?? 0),
    posZ: Number(p.posZ ?? 0),
    ...(p.rotX !== undefined ? { rotX: Number(p.rotX) } : {}),
    ...(p.scaleX !== undefined ? { scaleX: Number(p.scaleX) } : {}),
    ...(p.scaleY !== undefined ? { scaleY: Number(p.scaleY) } : {}),
    ...(p.scaleZ !== undefined ? { scaleZ: Number(p.scaleZ) } : {})
  }));
  const regions = (result.data.regions ?? []).slice(0, maxRegions).map((r) => ({
    name: String(r.name ?? ''),
    ...(r.offset === undefined ? {} : { nativeOffset: Number(r.offset) }),
    typeId: Number(r.typeId ?? 0),
    posX: Number(r.posX ?? 0),
    posY: Number(r.posY ?? 0),
    posZ: Number(r.posZ ?? 0)
  }));
  const events = (result.data.events ?? []).slice(0, maxEvents).map((event) => ({
    name: String(event.name ?? ''),
    ...(event.offset === undefined ? {} : { nativeOffset: Number(event.offset) }),
    typeId: Number(event.typeId ?? 0),
    ...(event.eventId === undefined ? {} : { eventId: Number(event.eventId) })
  }));
  const routes = (result.data.routes ?? []).map((route) => ({
    name: String(route.name ?? ''),
    ...(route.offset === undefined ? {} : { nativeOffset: Number(route.offset) }),
    typeId: Number(route.typeId ?? 0),
    ...(route.id === undefined ? {} : { id: Number(route.id) })
  }));
  return {
    ok: true,
    data: {
      sourceHash: result.data.sourceHash,
      version: result.data.version ?? 0,
      modelCount: result.data.modelCount ?? 0,
      partCount: result.data.partCount ?? 0,
      regionCount: result.data.regionCount ?? 0,
      eventCount: result.data.eventCount ?? 0,
      routeCount: result.data.routeCount ?? 0,
      models,
      parts,
      regions,
      events,
      routes,
      ...(result.data.authority ? { authority: result.data.authority } : {}),
      ...(result.data.entityEdit ? { entityEdit: result.data.entityEdit } : {})
    },
    diagnostics: result.diagnostics.map((d) => ({
      severity: d.severity,
      code: d.code,
      message: d.message
    }))
  };
}
