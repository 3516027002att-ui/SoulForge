import type { AiToolPermissionLevel, PatchMode } from '@soulforge/shared';

/**
 * Ordered v0.5 AI tool permission ladder.
 * Higher ranks include lower capabilities after mode policy checks.
 */
export const AI_TOOL_PERMISSION_ORDER: readonly AiToolPermissionLevel[] = [
  'read',
  'analyze',
  'propose',
  'stage',
  'validate',
  'commit',
  'rollback'
] as const;

const PERMISSION_RANK: Record<AiToolPermissionLevel, number> = {
  read: 0,
  analyze: 1,
  propose: 2,
  stage: 3,
  validate: 4,
  commit: 5,
  rollback: 6
};

/**
 * Map UI / session modes to the maximum tool permission allowed by default.
 * Full-permission still cannot bypass Patch Engine; it only raises the tool ceiling.
 *
 * ── 待用户裁定:plan 的上限是否该收到 analyze ──
 *
 * plan 当前返回 `validate`,即允许到 stage/validate 等级。实测
 * `validate_patch` 走 dryRunPatchProposal →
 * stageAndValidateProposalThroughTransaction,需要 workspaceRoot、会创建暂存
 * 目录并跑校验器 —— 那是**写暂存区**,与 plan 模式「只读」的字面承诺不符。
 *
 * 净效果目前是安全的:agentLoop 的 PLAN_MODE_EXTRA_DENY 在离执行更近的一层
 * 把 validate_patch 与 propose_text_patch 挡掉了(见该常量的注释),所以
 * plan 模式下这两个工具实际执行不到。
 *
 * 但「上限写得比实际允许的宽,靠另一层兜住」不是理想状态。收紧到 analyze 会
 * 打断两处已封存断言(runV05FoundationSmoke:132/135 与
 * runAiToolPermissionSmoke 的 MODE_CEILINGS),且本函数还服务
 * testing/harness 的 scaffoldPolicyGate —— 那是 architecture scaffold 的
 * policy gate 契约,不只服务 agent loop。
 *
 * 故此处不自行收紧,留待裁定。改动方需要同时:改这两处断言、复核 scaffold
 * policy gate 的语义、重新封存受影响的 Gate。
 */
export function maxPermissionForMode(mode: PatchMode | 'plan' | 'normal' | 'fullPermission'): AiToolPermissionLevel {
  if (mode === 'plan') return 'validate';
  if (mode === 'normal') return 'validate';
  return 'rollback';
}

export function isAiToolPermissionAllowed(
  required: AiToolPermissionLevel,
  mode: PatchMode | 'plan' | 'normal' | 'fullPermission'
): boolean {
  return PERMISSION_RANK[required] <= PERMISSION_RANK[maxPermissionForMode(mode)];
}

/**
 * Backward-compatible bridge from the earlier read/plan/write tool tags.
 */
export function legacyPermissionToLevel(permission: 'read' | 'plan' | 'write'): AiToolPermissionLevel {
  if (permission === 'read') return 'read';
  if (permission === 'plan') return 'propose';
  return 'commit';
}

export function describePermissionLevel(level: AiToolPermissionLevel): string {
  switch (level) {
    case 'read':
      return 'Read indexed evidence and workspace metadata.';
    case 'analyze':
      return 'Analyze references, diagnostics, and evidence packs.';
    case 'propose':
      return 'Create patch proposals and plans without writing files.';
    case 'stage':
      return 'Apply patches to staging copies only.';
    case 'validate':
      return 'Run validators against staged outputs.';
    case 'commit':
      return 'Commit validated staging through Patch Engine.';
    case 'rollback':
      return 'Rollback committed operations from backups.';
    default:
      return level;
  }
}
