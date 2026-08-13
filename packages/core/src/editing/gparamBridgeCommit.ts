/**
 * GPARAM Bridge stage helpers（GPARAM-11C）— writers only touch staging; callers commit via Patch Engine.
 *
 * 与 paramBridgeCommit/fmgBridgeCommit 同一范式：渲染器/调用方给出 typed
 * field-set mutation（group→param→valueIndex），main 侧经 Patch Engine 的
 * outer stage 落到暂存区，由 write-gparam 重读验证后才进入 Patch。
 *
 * 不提供「通用 bytes replace fallback」：没有 typed 定位就没有写入口
 * （GPARAM-11C Done：只有通过 11C 的 storage profile 才显示字段编辑控件）。
 */

import { BRIDGE_STAGING_WRITE_VERIFIED_CODES } from '@soulforge/shared';
import { runBridge } from '../bridge/runBridge.js';

/** typed field-set：改一个 param 的第 valueIndex 个值。 */
export interface GparamFieldSetMutation {
  /** group 序号（与 read envelope 的 groupId 一致）。 */
  groupId: number;
  /** param 在 group 内的序号（与 read envelope 的 paramId 一致）。 */
  paramId: number;
  /** 值序号（展开后，如 float3 的第 0..2 分量）。 */
  valueIndex: number;
  value: number;
}

export interface GparamBridgeCommitRequest {
  sourcePath: string;
  outputPath: string;
  expectedDocumentHash: string;
  allowedRoots: string[];
  writableRoots: string[];
  mutations: GparamFieldSetMutation[];
  /** DCX 源的 Oodle 运行库根（KRAK 压缩需要；DFLT 不需要）。 */
  oodleRuntimeRoot?: string;
  timeoutMs?: number;
}

export interface GparamBridgeCommitResult {
  ok: boolean;
  outputHash?: string;
  mutationCount?: number;
  outputSize?: number;
  diagnostics: Array<{ severity: string; code: string; message: string }>;
}

export async function commitGparamMutationsViaBridge(
  request: GparamBridgeCommitRequest
): Promise<GparamBridgeCommitResult> {
  const result = await runBridge<{
    outputHash?: string;
    mutationCount?: number;
    outputSize?: number;
  }>({
    command: 'write-gparam',
    filePath: request.sourcePath,
    allowedRoots: request.allowedRoots,
    writableRoots: request.writableRoots,
    timeoutMs: request.timeoutMs ?? 60_000,
    ...(request.oodleRuntimeRoot ? { oodleRuntimeRoot: request.oodleRuntimeRoot } : {}),
    commandOptions: {
      outputPath: request.outputPath,
      expectedDocumentHash: request.expectedDocumentHash,
      mutations: request.mutations
    }
  });
  const ok = result.diagnostics.some(
    (d) => d.code === BRIDGE_STAGING_WRITE_VERIFIED_CODES.gparam
  );
  return {
    ok,
    ...(result.data?.outputHash ? { outputHash: result.data.outputHash } : {}),
    ...(result.data?.mutationCount !== undefined ? { mutationCount: result.data.mutationCount } : {}),
    ...(result.data?.outputSize !== undefined ? { outputSize: result.data.outputSize } : {}),
    diagnostics: result.diagnostics.map((d) => ({
      severity: d.severity,
      code: d.code,
      message: d.message
    }))
  };
}
