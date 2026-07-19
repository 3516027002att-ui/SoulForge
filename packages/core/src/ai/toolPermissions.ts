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
  if (mode === 'plan') return 'propose';
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
