/**
 * MSB Bridge read helper for desktop scene / workbench (renderer-safe DTOs only).
 */

import { runBridge } from '../bridge/runBridge.js';

export interface MsbBridgePart {
  name: string;
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
  typeId: number;
  posX: number;
  posY: number;
  posZ: number;
}

export interface MsbBridgeDocument {
  sourceHash: string;
  version: number;
  modelCount: number;
  partCount: number;
  regionCount: number;
  eventCount: number;
  parts: MsbBridgePart[];
  regions: MsbBridgeRegion[];
  authority?: string;
  entityEdit?: string;
}

export async function readMsbDocumentViaBridge(input: {
  sourcePath: string;
  allowedRoots: string[];
  timeoutMs?: number;
  maxParts?: number;
  maxRegions?: number;
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
    parts?: Array<Record<string, unknown>>;
    regions?: Array<Record<string, unknown>>;
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
  const parts = (result.data.parts ?? []).slice(0, maxParts).map((p) => ({
    name: String(p.name ?? ''),
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
    typeId: Number(r.typeId ?? 0),
    posX: Number(r.posX ?? 0),
    posY: Number(r.posY ?? 0),
    posZ: Number(r.posZ ?? 0)
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
      parts,
      regions,
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
