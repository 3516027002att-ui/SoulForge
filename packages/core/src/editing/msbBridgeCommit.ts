/**
 * MSB Bridge stage helpers for part/region transform writes.
 */

import { runBridge } from '../bridge/runBridge.js';

export type MsbBridgeMutation =
  | {
      kind: 'set_part_position' | 'set_part_transform' | 'set_region_position';
      partName: string;
      posX?: number;
      posY?: number;
      posZ?: number;
      rotX?: number;
      scaleX?: number;
      scaleY?: number;
      scaleZ?: number;
    };

export interface MsbBridgeCommitRequest {
  sourcePath: string;
  outputPath: string;
  expectedDocumentHash: string;
  allowedRoots: string[];
  writableRoots: string[];
  mutation: MsbBridgeMutation;
  timeoutMs?: number;
}

export interface MsbBridgeCommitResult {
  ok: boolean;
  outputHash?: string;
  partCount?: number;
  regionCount?: number;
  diagnostics: Array<{ severity: string; code: string; message: string }>;
}

export async function commitMsbMutationViaBridge(
  request: MsbBridgeCommitRequest
): Promise<MsbBridgeCommitResult> {
  const m = request.mutation;
  const commandOptions: Record<string, unknown> = {
    outputPath: request.outputPath,
    expectedDocumentHash: request.expectedDocumentHash,
    mutation: m.kind,
    partName: m.partName
  };
  if (m.posX !== undefined) commandOptions.posX = m.posX;
  if (m.posY !== undefined) commandOptions.posY = m.posY;
  if (m.posZ !== undefined) commandOptions.posZ = m.posZ;
  if (m.rotX !== undefined) commandOptions.rotX = m.rotX;
  if (m.scaleX !== undefined) commandOptions.scaleX = m.scaleX;
  if (m.scaleY !== undefined) commandOptions.scaleY = m.scaleY;
  if (m.scaleZ !== undefined) commandOptions.scaleZ = m.scaleZ;

  const result = await runBridge<{
    outputHash?: string;
    partCount?: number;
    regionCount?: number;
  }>({
    command: 'write-msb',
    filePath: request.sourcePath,
    allowedRoots: request.allowedRoots,
    writableRoots: request.writableRoots,
    timeoutMs: request.timeoutMs ?? 120_000,
    commandOptions
  });
  const ok = result.diagnostics.some((d) => d.code === 'MSB_STAGING_WRITE_VERIFIED');
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
