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
 */
export function maxPermissionForMode(mode: PatchMode | 'plan' | 'normal' | 'fullPermission'): AiToolPermissionLevel {
  // plan may inspect, analyze, and formulate a proposal, but it must not
  // create staging output or run validation against staged files.
  if (mode === 'plan') return 'propose';
  // Edit / normal：可经 Patch Engine 提交，不可回滚。回滚仍只给 fullPermission。
  if (mode === 'normal') return 'commit';
  return 'rollback';
}

export interface AiToolPermissionDecision {
  allowed: boolean;
  required: AiToolPermissionLevel;
  mode: PatchMode | 'plan' | 'normal' | 'fullPermission';
  ceiling: AiToolPermissionLevel;
}

/**
 * Single runtime permission predicate shared by ToolRegistry and AgentLoop.
 * Callers should use the returned ceiling when explaining a denial so the
 * model receives the same policy facts that decided execution.
 */
export function decideAiToolPermission(
  required: AiToolPermissionLevel,
  mode: PatchMode | 'plan' | 'normal' | 'fullPermission'
): AiToolPermissionDecision {
  const ceiling = maxPermissionForMode(mode);
  return {
    allowed: PERMISSION_RANK[required] <= PERMISSION_RANK[ceiling],
    required,
    mode,
    ceiling
  };
}

export function isAiToolPermissionAllowed(
  required: AiToolPermissionLevel,
  mode: PatchMode | 'plan' | 'normal' | 'fullPermission'
): boolean {
  return decideAiToolPermission(required, mode).allowed;
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
