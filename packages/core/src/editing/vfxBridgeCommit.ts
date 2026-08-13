/**
 * FXR Bridge stage helpers（VFX-54C）— writers only touch staging; callers commit via Patch Engine.
 *
 * 与 esdBridgeCommit / taeBridgeCommit 同一范式：调用方给出 typed field set
 * mutation（vfx-field-set），main 侧经 Patch Engine 的 outer stage 落到暂存区，
 * 由 write-fxr-document 重读验证后才进入 Patch。
 *
 * mutation 语义：
 *   · vfx-field-set —— 字节级外科替换某个「已知布局」容器里 Section11 的一个
 *     Int32（混合 int/float 位模式，无 schema，按不透明值）。容器用结构性路径
 *     定位：host 按 read 信封的收集序（fields.hosts[] 的顺序），property 按
 *     host 的 Properties1+Properties2 连续序，section8 按 property 的
 *     section8 下标；valueIndex 是容器 Section11 值数组下标。
 *
 * 已知布局门（硬约束「未知字段无法无损保留时不得开放 writer」）：C# 侧只在整份
 * 文件结构被完全理解时开放写入口——未识别 node type、layout warning、Section9
 * 非空、Section12-14 非空都会以 FXR_WRITE_BLOCKED_UNKNOWN_STRUCTURE fail-closed。
 * Section11 的 opacity 与 Section12-14 恒空是能力边界而非未知结构，不阻止写。
 *
 * 注意：FXR 在 Sekiro 中位于 ffxbnd.dcx 容器内子项。本层只处理 loose 子项
 * （sourcePath 指向已提取的裸 .fxr，或指向容器内已由 Patch 管线解包的工作副本）；
 * 容器外层重建由 Patch Engine 在 main 侧完成，不在这里发明第二套容器逻辑。
 */

import { BRIDGE_STAGING_WRITE_VERIFIED_CODES } from '@soulforge/shared';
import { runBridge } from '../bridge/runBridge.js';

/** vfx-field-set 的目标容器：host / property / section8（Section11 值数组所在）。 */
export type VfxFieldContainer = 'host' | 'property' | 'section8';

/** 结构性路径：与 read 信封的 fields.hosts[] / properties[] / section8[] 顺序一致。 */
export type VfxFieldAddress =
  | {
      container: 'host';
      /** host 在收集序中的下标（read 信封 fields.hosts[] 的顺序）。 */
      hostIndex: number;
      /** 该 host Section11 值数组（Section11Count1+Section11Count2）的下标。 */
      valueIndex: number;
    }
  | {
      container: 'property';
      hostIndex: number;
      /** property 在 Properties1+Properties2 连续序中的下标。 */
      propertyIndex: number;
      valueIndex: number;
    }
  | {
      container: 'section8';
      hostIndex: number;
      propertyIndex: number;
      /** property 的 section8 下标。 */
      section8Index: number;
      valueIndex: number;
    };

/** 一条 FXR 字段 mutation。Section11 值是不透明 int32（位模式），任意 int32 均可。 */
export interface VfxFieldSetMutation {
  mutation: 'vfx-field-set';
  address: VfxFieldAddress;
  /** 新值（int32，可以是负值/位模式）。 */
  value: number;
}

export interface VfxBridgeCommitRequest {
  sourcePath: string;
  outputPath: string;
  expectedDocumentHash: string;
  allowedRoots: string[];
  writableRoots: string[];
  mutations: VfxFieldSetMutation[];
  timeoutMs?: number;
}

export interface VfxBridgeCommitResult {
  ok: boolean;
  outputHash?: string;
  outputSize?: number;
  mutationCount?: number;
  diagnostics: Array<{ severity: string; code: string; message: string }>;
}

export async function commitVfxFieldSetViaBridge(
  request: VfxBridgeCommitRequest
): Promise<VfxBridgeCommitResult> {
  const result = await runBridge<{
    outputHash?: string;
    outputSize?: number;
    mutationCount?: number;
  }>({
    command: 'write-fxr-document',
    filePath: request.sourcePath,
    allowedRoots: request.allowedRoots,
    writableRoots: request.writableRoots,
    timeoutMs: request.timeoutMs ?? 60_000,
    commandOptions: {
      outputPath: request.outputPath,
      expectedDocumentHash: request.expectedDocumentHash,
      mutations: request.mutations
    }
  });
  const ok = result.diagnostics.some(
    (d) => d.code === BRIDGE_STAGING_WRITE_VERIFIED_CODES.fxr
  );
  return {
    ok,
    ...(result.data?.outputHash ? { outputHash: result.data.outputHash } : {}),
    ...(result.data?.outputSize !== undefined ? { outputSize: result.data.outputSize } : {}),
    ...(result.data?.mutationCount !== undefined ? { mutationCount: result.data.mutationCount } : {}),
    diagnostics: result.diagnostics.map((d) => ({
      severity: d.severity,
      code: d.code,
      message: d.message
    }))
  };
}
