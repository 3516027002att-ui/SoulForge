/**
 * TAE Bridge stage helpers（ANIMATION-56C）— writers only touch staging; callers commit via Patch Engine.
 *
 * 与 esdBridgeCommit / materialBridgeCommit 同一范式：调用方给出 typed event
 * upsert mutation（tae-event-upsert），main 侧经 Patch Engine 的 outer stage 落到
 * 暂存区，由 write-tae-document 重读验证后才进入 Patch。
 *
 * 两条 mutation kind：
 *   · update-event-times —— 字节级外科替换某动画某个事件的 startTime/endTime
 *     float32。动画按 animId 定位（读信封的 stable id），事件按事件表下标
 *     eventIndex 定位。时间槽被兄弟事件共享时 C# 侧 fail-closed（sibling
 *     verify：共享槽改写会非预期地改动兄弟事件）。
 *   · insert-event —— 追加一个新事件到动画事件表末尾。事件参数体（paramData）
 *     按 eventTypeId 分派、本版刻意未解码，新事件参数体必须逐字节拷贝自模板
 *     事件（templateEventIndex 定位）；布局不连续时 C# 侧以
 *     TAE_WRITE_BLOCKED_UNKNOWN_STRUCTURE fail-closed，不落盘。
 *
 * 注意：TAE 在 Sekiro 中位于 anibnd.dcx 容器内子项。本层只处理 loose 子项
 * （sourcePath 指向已提取的裸 .tae，或指向容器内已由 Patch 管线解包的工作副本）；
 * 容器外层重建由 Patch Engine 在 main 侧完成，不在这里发明第二套容器逻辑。
 */

import { BRIDGE_STAGING_WRITE_VERIFIED_CODES } from '@soulforge/shared';
import { runBridge } from '../bridge/runBridge.js';

/** 一条 TAE 事件 upsert mutation。source 定位用 animId + 事件表下标。 */
export type TaeEventUpsertMutation =
  | {
      mutation: 'update-event-times';
      /** 目标动画 id（读信封 animations[].animId）。 */
      animId: number;
      /** 目标事件在事件表内的下标（读信封 animations[].events[] 的顺序）。 */
      eventIndex: number;
      /** 新起始时间（有限且 ≤ endTime，否则 C# 侧 fail-closed）。 */
      startTime: number;
      /** 新结束时间（有限且 ≥ startTime，否则 C# 侧 fail-closed）。 */
      endTime: number;
    }
  | {
      mutation: 'insert-event';
      /** 目标动画 id。 */
      animId: number;
      /** 模板事件下标：新事件的参数体逐字节拷贝自该事件（类型必须一致）。 */
      templateEventIndex: number;
      /** 新事件类型；缺省用模板事件类型。若提供且与模板不一致 → C# 侧 fail-closed。 */
      eventTypeId?: number;
      startTime: number;
      endTime: number;
    };

export interface TaeBridgeCommitRequest {
  sourcePath: string;
  outputPath: string;
  expectedDocumentHash: string;
  allowedRoots: string[];
  writableRoots: string[];
  mutations: TaeEventUpsertMutation[];
  timeoutMs?: number;
}

export interface TaeBridgeCommitResult {
  ok: boolean;
  outputHash?: string;
  outputSize?: number;
  mutationCount?: number;
  diagnostics: Array<{ severity: string; code: string; message: string }>;
}

export async function commitTaeEventViaBridge(
  request: TaeBridgeCommitRequest
): Promise<TaeBridgeCommitResult> {
  const result = await runBridge<{
    outputHash?: string;
    outputSize?: number;
    mutationCount?: number;
  }>({
    command: 'write-tae-document',
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
    (d) => d.code === BRIDGE_STAGING_WRITE_VERIFIED_CODES.tae
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
