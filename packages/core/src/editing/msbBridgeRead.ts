/**
 * MSB Bridge read helper for desktop scene / workbench (renderer-safe DTOs only).
 */

import { runBridge } from '../bridge/runBridge.js';

export interface MsbBridgePart {
  name: string;
  nativeOffset?: number;
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
}

export interface MsbBridgeDocument {
  sourceHash: string;
  version: number;
  modelCount: number;
  partCount: number;
  regionCount: number;
  eventCount: number;
  models: MsbBridgeModel[];
  parts: MsbBridgePart[];
  regions: MsbBridgeRegion[];
  events: MsbBridgeEvent[];
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
    models?: Array<Record<string, unknown>>;
    parts?: Array<Record<string, unknown>>;
    regions?: Array<Record<string, unknown>>;
    events?: Array<Record<string, unknown>>;
    authority?: string;
    entityEdit?: string;
  }>({
    command: 'read-msb-document',
    filePath: input.sourcePath,
    allowedRoots: input.allowedRoots,
    timeoutMs: input.timeoutMs ?? 120_000
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
  const maxParts = input.maxParts ?? 256;
  const maxRegions = input.maxRegions ?? 128;
  const maxModels = input.maxModels ?? 128;
  const maxEvents = input.maxEvents ?? 128;
  const models = (result.data.models ?? []).slice(0, maxModels).map((model) => ({
    name: String(model.name ?? ''),
    ...(model.offset === undefined ? {} : { nativeOffset: Number(model.offset) }),
    typeId: Number(model.typeId ?? 0)
  }));
  const parts = (result.data.parts ?? []).slice(0, maxParts).map((p) => ({
    name: String(p.name ?? ''),
    ...(p.offset === undefined ? {} : { nativeOffset: Number(p.offset) }),
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
    typeId: Number(event.typeId ?? 0)
  }));
  return {
    ok: true,
    data: {
      sourceHash: result.data.sourceHash,
      version: result.data.version ?? 0,
      modelCount: result.data.modelCount ?? 0,
      partCount: result.data.partCount ?? parts.length,
      regionCount: result.data.regionCount ?? regions.length,
      eventCount: result.data.eventCount ?? 0,
      models,
      parts,
      regions,
      events,
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
