/**
 * MSB Bridge stage helpers for part/region transform writes.
 */

import { BRIDGE_STAGING_WRITE_VERIFIED_CODES } from '@soulforge/shared';
import { runBridge } from '../bridge/runBridge.js';

export type MsbBridgeMutation =
  | {
      kind: 'set_part_position' | 'set_part_transform' | 'set_region_position' | 'set_region_transform';
      partName: string;
      posX?: number;
      posY?: number;
      posZ?: number;
      rotX?: number;
      rotY?: number;
      rotZ?: number;
      scaleX?: number;
      scaleY?: number;
      scaleZ?: number;
    }
  | {
      kind: 'change_model' | 'set_part_model';
      partName: string;
      modelName?: string;
      modelIndex?: number;
    }
  | {
      kind: 'duplicate_part' | 'create_part';
      partName: string;
      newName: string;
      posX?: number;
      posY?: number;
      posZ?: number;
      rotX?: number;
      rotY?: number;
      rotZ?: number;
      scaleX?: number;
      scaleY?: number;
      scaleZ?: number;
      modelName?: string;
      modelIndex?: number;
      entityId?: number;
    }
  | {
      kind: 'set_property' | 'set_entity_id';
      partName: string;
      entityId: number;
    }
  | {
      kind: 'delete_part' | 'delete_region' | 'delete_event' | 'delete_route';
      partName: string;
    };

export interface MsbBridgeCommitRequest {
  sourcePath: string;
  outputPath: string;
  expectedDocumentHash: string;
  allowedRoots: string[];
  writableRoots: string[];
  mutation?: MsbBridgeMutation | undefined;
  mutations?: MsbBridgeMutation[] | undefined;
  oodleRuntimeRoot?: string | undefined;
  timeoutMs?: number | undefined;
}

export interface MsbBridgeCommitResult {
  ok: boolean;
  outputHash?: string;
  partCount?: number;
  regionCount?: number;
  diagnostics: Array<{ severity: string; code: string; message: string }>;
}

function serializeMsbMutation(m: MsbBridgeMutation): Record<string, unknown> {
  const item: Record<string, unknown> = {
    mutation: m.kind,
    partName: m.partName
  };
  // kind 是联合字面量判别，!== 链不能把 delete 变体从联合中整体剔除；
  // 'posX' in m 才是对「该成员带 transform 字段」的结构收窄。
  if ('posX' in m) {
    if (m.posX !== undefined) item.posX = m.posX;
    if (m.posY !== undefined) item.posY = m.posY;
    if (m.posZ !== undefined) item.posZ = m.posZ;
    if (m.rotX !== undefined) item.rotX = m.rotX;
    if (m.rotY !== undefined) item.rotY = m.rotY;
    if (m.rotZ !== undefined) item.rotZ = m.rotZ;
    if (m.scaleX !== undefined) item.scaleX = m.scaleX;
    if (m.scaleY !== undefined) item.scaleY = m.scaleY;
    if (m.scaleZ !== undefined) item.scaleZ = m.scaleZ;
  }
  if ('modelName' in m && m.modelName !== undefined) item.modelName = m.modelName;
  if ('modelIndex' in m && m.modelIndex !== undefined) item.modelIndex = m.modelIndex;
  if ('entityId' in m && m.entityId !== undefined) item.entityId = m.entityId;
  if ('newName' in m && m.newName !== undefined) item.newName = m.newName;
  return item;
}

export async function commitMsbMutationViaBridge(
  request: MsbBridgeCommitRequest
): Promise<MsbBridgeCommitResult> {
  const commandOptions: Record<string, unknown> = {
    outputPath: request.outputPath,
    expectedDocumentHash: request.expectedDocumentHash
  };

  if (request.mutations && request.mutations.length > 0) {
    commandOptions.mutations = request.mutations.map(serializeMsbMutation);
  } else if (request.mutation) {
    Object.assign(commandOptions, serializeMsbMutation(request.mutation));
  } else {
    throw new Error('commitMsbMutationViaBridge requires mutation or mutations');
  }

  const result = await runBridge<{
    outputHash?: string;
    partCount?: number;
    regionCount?: number;
  }>({
    command: 'write-msb',
    filePath: request.sourcePath,
    allowedRoots: request.allowedRoots,
    writableRoots: request.writableRoots,
    ...(request.oodleRuntimeRoot ? { oodleRuntimeRoot: request.oodleRuntimeRoot } : {}),
    timeoutMs: request.timeoutMs ?? 120_000,
    commandOptions
  });
  const ok = result.diagnostics.some(
    (d) => d.code === BRIDGE_STAGING_WRITE_VERIFIED_CODES.msb
  );
  return {
    ok,
    ...(result.data?.outputHash ? { outputHash: result.data.outputHash } : {}),
    ...(result.data?.partCount !== undefined ? { partCount: result.data.partCount } : {}),
    ...(result.data?.regionCount !== undefined ? { regionCount: result.data.regionCount } : {}),
    diagnostics: result.diagnostics.map((d) => ({
      severity: d.severity,
      code: d.code,
      message: d.message
    }))
  };
}
