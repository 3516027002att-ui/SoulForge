/**
 * Durable PatchIR commit: pending op log → WorkspaceTransaction → committed/recovery.
 * Ensures ok=true implies a findable recoverable operation record (or recovery metadata).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  Diagnostic,
  FileOperationRecord,
  GraphPatch,
  OperationLogRecord,
  PatchIR,
  PatchMode
} from '@soulforge/shared';
import { toLegacyDiagnostic } from '@soulforge/shared';
import {
  createWorkspaceTransaction
} from '../transactions/workspaceTransaction.js';
import type { WorkspaceSession } from '../workspace/workspaceSession.js';
import {
  createCommittedOperationRecord,
  getDefaultOperationLogStore,
  type OperationLogStore
} from './operationLog.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface ExecutePatchIrOptions {
  workspaceRoot?: string;
  session?: WorkspaceSession;
  operationLog?: OperationLogStore;
  backupBaseDir?: string;
  actorId?: string;
  recoveryDir?: string;
  mode?: PatchMode;
  author?: 'user' | 'ai';
  graph?: GraphPatch;
}

export interface TransactionCommitCompatResult {
  opId: string;
  backupRoot: string;
  changedFiles: string[];
  diagnostics: Diagnostic[];
  operation?: OperationLogRecord;
  recoveryPath?: string;
}

export async function executePatchIrThroughTransaction(
  patch: PatchIR,
  options: ExecutePatchIrOptions = {}
): Promise<TransactionCommitCompatResult> {
  const opId = patch.patchId || randomUUID();
  const store = options.operationLog ?? getDefaultOperationLogStore();
  const workspaceRoot = options.workspaceRoot
    ?? options.session?.layers.overlayRoot;
  if (!workspaceRoot) {
    return {
      opId,
      backupRoot: '',
      changedFiles: [],
      diagnostics: [{
        severity: 'error',
        code: 'WORKSPACE_ROOT_REQUIRED',
        message: 'workspaceRoot or session.overlayRoot is required.'
      }]
    };
  }

  // Session boundary checks.
  const preDiagnostics: Diagnostic[] = [];
  if (options.session) {
    for (const op of patch.operations) {
      if (!op.targetPath) continue;
      const writable = options.session.resolveWritablePath(op.targetPath, 'overlay');
      if (!writable.ok) preDiagnostics.push(...writable.diagnostics);
    }
  }
  if (preDiagnostics.some((d) => d.severity === 'error')) {
    return { opId, backupRoot: '', changedFiles: [], diagnostics: preDiagnostics };
  }

  const author = options.author ?? 'user';
  const mode = options.mode ?? 'normal';
  const pending: OperationLogRecord = {
    opId,
    workspaceId: patch.workspaceId,
    title: patch.title,
    author,
    mode,
    status: 'pending',
    createdAt: patch.createdAt,
    files: [],
    diagnostics: []
  };

  try {
    store.record(pending);
  } catch (error) {
    return {
      opId,
      backupRoot: '',
      changedFiles: [],
      diagnostics: [{
        severity: 'error',
        code: 'OPERATION_LOG_RECORD_FAILED',
        message: error instanceof Error
          ? `Pending operation log failed; refusing to write files: ${error.message}`
          : 'Pending operation log failed; refusing to write files.',
        details: { phase: 'pending' }
      }]
    };
  }

  const tx = createWorkspaceTransaction({
    workspaceId: patch.workspaceId,
    workspaceRoot: resolve(workspaceRoot),
    actor: {
      kind: author === 'ai' ? 'agent' : 'user',
      id: options.actorId ?? `files-mode:${author}`
    },
    ...(options.backupBaseDir !== undefined ? { backupBaseDir: options.backupBaseDir } : {})
  });

  const added = tx.addPatch({ ...patch, patchId: opId });
  if (!added.ok) {
    store.updateStatus(opId, 'failed', {
      diagnostics: added.diagnostics.map(toLegacyDiagnostic)
    });
    return {
      opId,
      backupRoot: '',
      changedFiles: [],
      diagnostics: added.diagnostics.map(toLegacyDiagnostic)
    };
  }

  const staged = await tx.stage();
  if (!staged.ok) {
    store.updateStatus(opId, 'failed', {
      diagnostics: staged.diagnostics.map(toLegacyDiagnostic)
    });
    return {
      opId,
      backupRoot: '',
      changedFiles: [],
      diagnostics: staged.diagnostics.map(toLegacyDiagnostic)
    };
  }

  const validated = await tx.validate();
  if (!validated.ok) {
    store.updateStatus(opId, 'failed', {
      diagnostics: validated.diagnostics.map(toLegacyDiagnostic)
    });
    return {
      opId,
      backupRoot: '',
      changedFiles: [],
      diagnostics: validated.diagnostics.map(toLegacyDiagnostic)
    };
  }

  const committed = await tx.commit();
  const diagnostics: Diagnostic[] = committed.diagnostics.map(toLegacyDiagnostic);

  if (!committed.ok || !committed.restorePoint) {
    store.updateStatus(opId, 'failed', { diagnostics });
    return {
      opId,
      backupRoot: committed.restorePoint?.root ?? '',
      changedFiles: [],
      diagnostics
    };
  }

  const fileRecords = await buildFileRecords(patch, committed.restorePoint.files);
  const operation = createCommittedOperationRecord({
    proposal: {
      opId,
      workspaceId: patch.workspaceId,
      title: patch.title,
      author,
      mode,
      changes: patch.operations.map((op) => ({
        targetUri: op.targetUri,
        targetPath: op.targetPath ?? '',
        kind: op.kind === 'text_edit' || op.kind === 'file_replace' ? 'text' : 'binary',
        ...(op.resourceKind ? { resourceKind: op.resourceKind } : {})
      })),
      createdAt: patch.createdAt,
      ...(options.graph ? { graph: options.graph } : {})
    },
    backupRoot: committed.restorePoint.root,
    files: fileRecords,
    diagnostics,
    ...(options.graph ? { graph: options.graph } : {})
  });
  operation.opId = opId;
  operation.transactionId = committed.transactionId;
  operation.status = 'committed';

  try {
    store.record(operation);
  } catch (error) {
    // Attempt rollback of already-written files.
    const rolled = await tx.rollback();
    if (rolled.ok) {
      store.updateStatus(opId, 'rolled_back', {
        diagnostics: [{
          severity: 'error',
          code: 'OPERATION_LOG_RECORD_FAILED',
          message: error instanceof Error
            ? `Post-commit operation log failed; files were rolled back: ${error.message}`
            : 'Post-commit operation log failed; files were rolled back.',
          details: { phase: 'mark_committed', transactionId: committed.transactionId }
        }]
      });
      return {
        opId,
        backupRoot: committed.restorePoint.root,
        changedFiles: [],
        diagnostics: [{
          severity: 'error',
          code: 'OPERATION_LOG_RECORD_FAILED',
          message: error instanceof Error
            ? `Post-commit operation log failed; files were rolled back: ${error.message}`
            : 'Post-commit operation log failed; files were rolled back.',
          details: { phase: 'mark_committed' }
        }]
      };
    }

    // Rollback failed — durable recovery metadata required.
    const recoveryDir = options.recoveryDir
      ?? join(resolve(workspaceRoot), '.soulforge', 'recovery');
    await mkdir(recoveryDir, { recursive: true });
    const recoveryPath = join(recoveryDir, `${opId}.recovery.json`);
    const recoveryPayload = {
      status: 'recovery_required',
      opId,
      transactionId: committed.transactionId,
      backupRoot: committed.restorePoint.root,
      committedPaths: committed.committedPaths,
      restorePointFiles: committed.restorePoint.files,
      logError: error instanceof Error ? error.message : String(error),
      createdAt: new Date().toISOString()
    };
    await writeFile(recoveryPath, `${JSON.stringify(recoveryPayload, null, 2)}\n`, 'utf8');

    try {
      store.updateStatus(opId, 'recovery_required', {
        recoveryPath,
        recoveryReason: recoveryPayload.logError,
        backupRoot: committed.restorePoint.root,
        files: fileRecords,
        transactionId: committed.transactionId,
        diagnostics: [{
          severity: 'error',
          code: 'TRANSACTION_RECOVERY_REQUIRED',
          message: 'Files committed but operation log mark failed and auto-rollback failed. Recovery metadata written.',
          details: recoveryPayload
        }]
      });
    } catch {
      // store may be completely broken; recovery file is the source of truth
    }

    return {
      opId,
      backupRoot: committed.restorePoint.root,
      changedFiles: [],
      diagnostics: [{
        severity: 'error',
        code: 'TRANSACTION_RECOVERY_REQUIRED',
        message: 'Files committed but operation log mark failed and auto-rollback failed. Recovery metadata written.',
        details: recoveryPayload
      }],
      recoveryPath
    };
  }

  return {
    opId,
    backupRoot: committed.restorePoint.root,
    changedFiles: committed.committedPaths,
    diagnostics,
    operation
  };
}

async function buildFileRecords(
  patch: PatchIR,
  backupFiles: Array<{ sourcePath: string; backupPath: string; beforeHash: string }>
): Promise<FileOperationRecord[]> {
  const byPath = new Map(
    patch.operations
      .filter((op) => op.targetPath)
      .map((op) => [resolve(op.targetPath!), op])
  );
  const records: FileOperationRecord[] = [];
  for (const file of backupFiles) {
    const op = byPath.get(resolve(file.sourcePath));
    let afterHash = file.beforeHash;
    try {
      afterHash = createHash('sha256').update(await readFile(file.sourcePath)).digest('hex');
    } catch {
      // keep before
    }
    records.push({
      targetUri: op?.targetUri ?? `file://${file.sourcePath}`,
      targetPath: file.sourcePath,
      beforeHash: file.beforeHash,
      afterHash,
      backupPath: file.backupPath,
      kind: op?.kind === 'raw_byte_range_edit' ? 'binary' : 'text',
      ...(op?.resourceKind ? { resourceKind: op.resourceKind } : {})
    });
  }
  return records;
}
