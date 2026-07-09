/**
 * AI tool policy gate — commit/rollback cannot bypass this layer.
 */

import type {
  PolicyDecision,
  PolicyGateContext,
  ToolPermission
} from '@soulforge/shared';
import { AI_TOOL_PERMISSION_LEVELS } from '@soulforge/shared';
import { maxPermissionForMode } from '../ai/toolPermissions.js';

const RANK: Record<ToolPermission, number> = {
  read: 0,
  analyze: 1,
  propose: 2,
  stage: 3,
  validate: 4,
  commit: 5,
  rollback: 6
};

export function evaluatePolicyGate(context: PolicyGateContext): PolicyDecision {
  const granted = context.maxPermission;
  const required = context.requiredPermission;

  if (RANK[required] > RANK[granted]) {
    return {
      kind: 'deny',
      reason: `Required permission ${required} exceeds granted max ${granted} for mode.`,
      code: 'POLICY_DENIED',
      requiredPermission: required,
      grantedPermission: granted
    };
  }

  // commit / rollback always need explicit confirmation tags in non-fullPermission modes,
  // or a confirmation receipt id when policy requires it.
  if (required === 'commit' || required === 'rollback') {
    const hasReceipt = (context.confirmationReceiptIds?.length ?? 0) > 0;
    const full = granted === 'rollback' && context.mode === 'fullPermission';
    if (!hasReceipt && !full) {
      return {
        kind: 'require_confirmation',
        reason: `${required} requires explicit confirmation receipt or fullPermission mode.`,
        code: 'POLICY_CONFIRMATION_REQUIRED',
        requiredPermission: required,
        grantedPermission: granted,
        confirmationRequired: true
      };
    }
    if (!hasReceipt && full) {
      // fullPermission still records a synthetic system confirmation path via allow,
      // but real product should still audit — scaffold allows with tag.
      return {
        kind: 'allow',
        reason: 'fullPermission mode grants commit/rollback without user receipt (still audited).',
        code: 'POLICY_ALLOW_FULL_PERMISSION',
        requiredPermission: required,
        grantedPermission: granted
      };
    }
  }

  return {
    kind: 'allow',
    reason: 'Policy gate allowed tool execution.',
    code: 'POLICY_ALLOW',
    requiredPermission: required,
    grantedPermission: granted
  };
}

export function maxPermissionFromMode(
  mode: PolicyGateContext['mode']
): ToolPermission {
  return maxPermissionForMode(mode);
}

export function isPermissionAtLeast(actual: ToolPermission, required: ToolPermission): boolean {
  return RANK[actual] >= RANK[required];
}

export function listPermissionLadder(): readonly ToolPermission[] {
  return AI_TOOL_PERMISSION_LEVELS;
}
