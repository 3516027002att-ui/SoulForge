/**
 * FLVER Bridge stage helpers — writers only touch staging; callers commit via Patch Engine.
 *
 * MODEL-51C：flver-material-slot-set typed mutation 的写链提交入口。
 * 写命令是 write-flver，成功判据与 fmg/param/emevd/msb 一样：诊断里出现
 * BRIDGE_STAGING_WRITE_VERIFIED_CODES.flver（FLVER_STAGING_WRITE_VERIFIED）。
 * 调用方是 editorMutationService 的 applyNativeMutation（stageWrite），
 * 资源最终落盘仍走 Patch Engine 事务，writer 只写暂存区。
 */

import { BRIDGE_STAGING_WRITE_VERIFIED_CODES } from '@soulforge/shared';
import { runBridge } from '../bridge/runBridge.js';

/** 单个 FLVER 材质槽写回 mutation。stable ID 形态与 renderer 侧一致：mesh:N / material:N。 */
export interface FlverMaterialSlotSetMutation {
  kind: 'material-slot-set';
  meshStableId: string;
  /** FLVER mesh 只有一个材质槽；渲染端恒为 0，C# 侧对非 0 值 fail-closed。 */
  slotIndex: number;
  materialStableId: string;
}

export interface FlverBridgeCommitRequest {
  sourcePath: string;
  outputPath: string;
  expectedDocumentHash: string;
  allowedRoots: string[];
  writableRoots: string[];
  mutation: FlverMaterialSlotSetMutation;
  /** chrbnd/DCX 容器写：FLVER 在 BND4 里的 child 下标。缺省 = loose profile。 */
  entryIndex?: number;
  timeoutMs?: number;
}

export interface FlverBridgeCommitResult {
  ok: boolean;
  outputHash?: string;
  meshCount?: number;
  storageProfile?: 'loose' | 'chrbnd';
  diagnostics: Array<{ severity: string; code: string; message: string }>;
}

export async function commitFlverMutationViaBridge(
  request: FlverBridgeCommitRequest
): Promise<FlverBridgeCommitResult> {
  const commandOptions: Record<string, unknown> = {
    outputPath: request.outputPath,
    expectedDocumentHash: request.expectedDocumentHash,
    mutations: [
      {
        kind: request.mutation.kind,
        meshStableId: request.mutation.meshStableId,
        slotIndex: request.mutation.slotIndex,
        materialStableId: request.mutation.materialStableId
      }
    ]
  };
  if (request.entryIndex !== undefined) {
    commandOptions.entryIndex = request.entryIndex;
  }
  const result = await runBridge<{
    outputHash?: string;
    meshCount?: number;
    storageProfile?: 'loose' | 'chrbnd';
  }>({
    command: 'write-flver',
    filePath: request.sourcePath,
    allowedRoots: request.allowedRoots,
    writableRoots: request.writableRoots,
    timeoutMs: request.timeoutMs ?? 60_000,
    commandOptions
  });
  const ok = result.diagnostics.some(
    (d) => d.code === BRIDGE_STAGING_WRITE_VERIFIED_CODES.flver
  );
  return {
    ok,
    ...(result.data?.outputHash ? { outputHash: result.data.outputHash } : {}),
    ...(result.data?.meshCount !== undefined ? { meshCount: result.data.meshCount } : {}),
    ...(result.data?.storageProfile ? { storageProfile: result.data.storageProfile } : {}),
    diagnostics: result.diagnostics.map((d) => ({
      severity: d.severity,
      code: d.code,
      message: d.message
    }))
  };
}
