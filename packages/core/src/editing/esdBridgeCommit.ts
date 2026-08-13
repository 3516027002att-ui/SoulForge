/**
 * ESD Bridge stage helpers（BEHAVIOR-55C）— writers only touch staging; callers commit via Patch Engine.
 *
 * 与 materialBridgeCommit / msbBridgeCommit 同一范式：调用方给出 typed transition
 * mutation（behavior-transition-upsert），main 侧经 Patch Engine 的 outer stage 落到
 * 暂存区，由 write-esd-document 重读验证后才进入 Patch。
 *
 * 三条 mutation kind：
 *   · set-transition-target —— 字节级外科替换某条件记录的 targetStateOffset，
 *     把它重指向另一条已解析 state 记录起点（或 -1 清空转移）。目标条件必须
 *     属于给定状态的条件偏移数组（唯一性守卫）。
 *   · insert-transition —— 在 entry 表内新增裸跳转条件（无 evaluator / 无命令）。
 *   · set-command-arg —— 恒 fail-closed：命令参数体是 RPN 字节码，SCOPE-BEHAVIOR-ESD
 *     把「未知表达式或命令不得重编码」列为永久禁令，C# 侧不解码也不重编码 →
 *     ESD_WRITE_BLOCKED_UNKNOWN_STRUCTURE，不落盘。
 *
 * 注意：ESD 在 Sekiro 中位于 talkesdbnd.dcx 容器内子项。本层只处理 loose 子项
 * （sourcePath 指向已提取的裸 .esd，或指向容器内已由 Patch 管线解包的工作副本）；
 * 容器外层重建由 Patch Engine 在 main 侧完成，不在这里发明第二套容器逻辑。
 */

import { BRIDGE_STAGING_WRITE_VERIFIED_CODES } from '@soulforge/shared';
import { runBridge } from '../bridge/runBridge.js';

/** 一条 ESD 状态转移 mutation。source 定位统一用 relOffset（读信封的 stable id）。 */
export type EsdTransitionMutation =
  | {
      mutation: 'set-transition-target';
      /** 源状态记录相对 DataStart 的偏移（读信封 conditionSamples[].sourceStateRelOffset）。 */
      stateRelOffset: number;
      /** 目标条件记录相对 DataStart 的偏移（读信封 conditionSamples[].conditionRelOffset）。 */
      conditionRelOffset: number;
      /** 新转移目标相对 DataStart 的偏移；-1 表示清空转移（edge 变 none）。 */
      targetStateRelOffset: number;
    }
  | {
      mutation: 'insert-transition';
      /** 要新增转移的源状态记录相对 DataStart 的偏移。 */
      stateRelOffset: number;
      /** 新条件的跳转目标（必须命中语义 state 记录起点，不能是 -1）。 */
      targetStateRelOffset: number;
    }
  | {
      mutation: 'set-command-arg';
      stateRelOffset?: number;
      conditionRelOffset?: number;
      /** RPN 字节码不解码（永久禁令）——本 kind 恒被 C# 侧 fail-closed 拒绝。 */
      [k: string]: unknown;
    };

export interface EsdBridgeCommitRequest {
  sourcePath: string;
  outputPath: string;
  expectedDocumentHash: string;
  allowedRoots: string[];
  writableRoots: string[];
  mutations: EsdTransitionMutation[];
  timeoutMs?: number;
}

export interface EsdBridgeCommitResult {
  ok: boolean;
  outputHash?: string;
  outputSize?: number;
  mutationCount?: number;
  diagnostics: Array<{ severity: string; code: string; message: string }>;
}

export async function commitEsdTransitionViaBridge(
  request: EsdBridgeCommitRequest
): Promise<EsdBridgeCommitResult> {
  const result = await runBridge<{
    outputHash?: string;
    outputSize?: number;
    mutationCount?: number;
  }>({
    command: 'write-esd-document',
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
    (d) => d.code === BRIDGE_STAGING_WRITE_VERIFIED_CODES.esd
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
