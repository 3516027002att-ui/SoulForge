import { copyFile, mkdir, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Diagnostic, OperationLogRecord } from '@soulforge/shared';
import type { OperationLogStore } from './operationLog.js';
import type { WorkspaceSession } from '../workspace/workspaceSession.js';

export interface RollbackOperationOptions {
  opId: string;
  store: OperationLogStore;
  session?: WorkspaceSession;
}

export interface RollbackOperationResult {
  ok: boolean;
  opId: string;
  restoredFiles: string[];
  diagnostics: Diagnostic[];
  record?: OperationLogRecord;
}

/**
 * File-level rollback for a committed operation.
 * Restores each changed file from the operation backup, then marks the log entry rolled_back.
 * Resource-entry rollback is intentionally out of scope for this slice.
 */
export async function rollbackOperation(options: RollbackOperationOptions): Promise<RollbackOperationResult> {
  const record = options.store.get(options.opId);
  if (!record) {
    return {
      ok: false,
      opId: options.opId,
      restoredFiles: [],
      diagnostics: [{
        severity: 'error',
        code: 'OPERATION_NOT_FOUND',
        message: `No operation log entry exists for opId ${options.opId}.`
      }]
    };
  }

  if (record.status === 'rolled_back') {
    return {
      ok: false,
      opId: options.opId,
      restoredFiles: [],
      diagnostics: [{
        severity: 'error',
        code: 'OPERATION_ALREADY_ROLLED_BACK',
        message: 'This operation has already been rolled back.',
        details: { opId: options.opId }
      }],
      record
    };
  }

  if (record.status !== 'committed') {
    return {
      ok: false,
      opId: options.opId,
      restoredFiles: [],
      diagnostics: [{
        severity: 'error',
        code: 'OPERATION_NOT_COMMITTED',
        message: `Only committed operations can be rolled back. Current status: ${record.status}.`,
        details: { opId: options.opId, status: record.status }
      }],
      record
    };
  }

  if (!record.backupRoot || record.files.length === 0) {
    return {
      ok: false,
      opId: options.opId,
      restoredFiles: [],
      diagnostics: [{
        severity: 'error',
        code: 'OPERATION_BACKUP_MISSING',
        message: 'Committed operation has no backup files to restore.',
        details: { opId: options.opId }
      }],
      record
    };
  }

  const diagnostics: Diagnostic[] = [];
  const restoredFiles: string[] = [];

  for (const file of record.files) {
    if (options.session) {
      const writable = options.session.resolveWritablePath(file.targetPath);
      if (!writable.ok) {
        diagnostics.push(...writable.diagnostics);
        continue;
      }
    }

    try {
      await mkdir(dirname(file.targetPath), { recursive: true });
      const siblingTemp = join(
        dirname(file.targetPath),
        `.soulforge-rollback-${record.opId}-${basename(file.targetPath)}.tmp`
      );
      await copyFile(file.backupPath, siblingTemp);
      await rename(siblingTemp, file.targetPath);
      restoredFiles.push(file.targetPath);
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        code: 'ROLLBACK_FILE_FAILED',
        message: error instanceof Error ? error.message : 'Failed to restore file from backup.',
        sourceUri: file.targetUri,
        details: {
          targetPath: file.targetPath,
          backupPath: file.backupPath
        }
      });
    }
  }

  if (diagnostics.some((item) => item.severity === 'error')) {
    return {
      ok: false,
      opId: options.opId,
      restoredFiles,
      diagnostics,
      record
    };
  }

  const updated = options.store.updateStatus(options.opId, 'rolled_back', {
    rolledBackAt: new Date().toISOString(),
    diagnostics: [...record.diagnostics, ...diagnostics, {
      severity: 'info',
      code: 'OPERATION_ROLLED_BACK',
      message: `Rolled back ${restoredFiles.length} file(s) for operation ${options.opId}.`
    }]
  });

  return {
    ok: true,
    opId: options.opId,
    restoredFiles,
    diagnostics: updated?.diagnostics ?? diagnostics,
    ...(updated ? { record: updated } : {})
  };
}
