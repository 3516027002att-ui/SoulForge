import { lstat, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RecoveryCleanupPlan } from '@soulforge/core';
import { pathsEqual, verifyPathInsideRoot } from '@soulforge/core';

export interface RecoveryCleanupStore {
  markRecoveryPointExpired(recoveryId: string): Promise<void>;
}

export interface RecoveryCleanupExecutionResult {
  deletedRecoveryIds: string[];
  missingRecoveryIds: string[];
  rejected: Array<{ recoveryId: string; code: string; message: string }>;
}

/** Deletes only preplanned restore points below canonical application-data roots. */
export async function executeRecoveryCleanup(input: {
  plan: RecoveryCleanupPlan;
  allowedRoots: string[];
  store: RecoveryCleanupStore;
}): Promise<RecoveryCleanupExecutionResult> {
  const allowedRoots = input.allowedRoots.map((root) => resolve(root));
  const result: RecoveryCleanupExecutionResult = {
    deletedRecoveryIds: [],
    missingRecoveryIds: [],
    rejected: []
  };
  for (const candidate of input.plan.candidates) {
    const candidatePath = resolve(candidate.rootPath);
    let accepted = false;
    for (const root of allowedRoots) {
      if (pathsEqual(root, candidatePath)) continue;
      const boundary = await verifyPathInsideRoot(root, candidatePath);
      if (boundary.ok) {
        accepted = true;
        break;
      }
    }
    if (!accepted) {
      result.rejected.push({
        recoveryId: candidate.recoveryId,
        code: 'RECOVERY_CLEANUP_PATH_REJECTED',
        message: '恢复点路径不在允许的应用数据根目录内，或经过了越界链接。'
      });
      continue;
    }

    let missing = false;
    try {
      await lstat(candidatePath);
    } catch (error) {
      if (isMissing(error)) missing = true;
      else {
        result.rejected.push({
          recoveryId: candidate.recoveryId,
          code: 'RECOVERY_CLEANUP_INSPECTION_FAILED',
          message: error instanceof Error ? error.message : String(error)
        });
        continue;
      }
    }
    try {
      if (!missing) await rm(candidatePath, { recursive: true, force: false });
      await input.store.markRecoveryPointExpired(candidate.recoveryId);
      if (missing) result.missingRecoveryIds.push(candidate.recoveryId);
      else result.deletedRecoveryIds.push(candidate.recoveryId);
    } catch (error) {
      result.rejected.push({
        recoveryId: candidate.recoveryId,
        code: 'RECOVERY_CLEANUP_DELETE_FAILED',
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return result;
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}
