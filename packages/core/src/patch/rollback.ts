import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  ConfirmationReceipt,
  Diagnostic,
  OperationLogRecord,
  PatchIrOperation
} from '@soulforge/shared';
import { createPatchIr } from '../patch-engine/patchIr.js';
import type { WorkspaceSession } from '../workspace/workspaceSession.js';
import { executePatchIrThroughTransaction } from './durablePatchCommit.js';
import type { OperationLogStore } from './operationLog.js';
import { isValidResourceEntryInverse } from './resourceEntryInverse.js';

export interface RollbackOperationOptions {
  opId: string;
  store: OperationLogStore;
  session?: WorkspaceSession;
  backupBaseDir?: string;
  recoveryDir?: string;
  author?: 'user' | 'ai';
  confirmation?: ConfirmationReceipt;
}

export interface RollbackOperationResult {
  ok: boolean;
  /** Original operation requested by the caller. */
  opId: string;
  /** Newly committed inverse transaction, when successful. */
  inverseOpId?: string;
  restoredFiles: string[];
  diagnostics: Diagnostic[];
  record?: OperationLogRecord;
}

export interface RollbackFileOptions extends RollbackOperationOptions {
  targetUri: string;
}

export interface RollbackResourceEntryOptions extends RollbackOperationOptions {
  entryUri: string;
}

/**
 * Operation-level rollback implemented as a new inverse PatchIR transaction.
 *
 * The original operation record is immutable. The inverse transaction repeats
 * the normal staging, validation, backup, atomic replace, reread and durable log
 * path, and records `inverseOfOpId`. This also makes an inverse transaction
 * independently reversible without rewriting history.
 */
export async function rollbackOperation(options: RollbackOperationOptions): Promise<RollbackOperationResult> {
  return rollbackSelected(options, 'operation');
}

/** File-level rollback uses the same inverse PatchIR transaction as operation rollback. */
export async function rollbackFile(options: RollbackFileOptions): Promise<RollbackOperationResult> {
  return rollbackSelected(options, 'file', options.targetUri);
}

/** Roll back one recorded container/resource entry through its persisted inverse PatchIR op. */
export async function rollbackResourceEntry(
  options: RollbackResourceEntryOptions
): Promise<RollbackOperationResult> {
  const record = await options.store.get(options.opId);
  if (!record) return fail(options.opId, 'OPERATION_NOT_FOUND', `找不到操作 ${options.opId}。`);
  if (record.status !== 'committed') return fail(options.opId, 'OPERATION_NOT_COMMITTED', '只有已提交操作可以回滚。');
  if (!options.store.listResourceEntryChanges) {
    return fail(options.opId, 'RESOURCE_ENTRY_INVERSE_STORE_UNAVAILABLE', '当前操作日志不支持资源条目逆操作。');
  }
  const changes = (await options.store.listResourceEntryChanges(options.opId))
    .filter((item) => item.entryUri === options.entryUri);
  if (changes.length !== 1) {
    return fail(
      options.opId,
      changes.length === 0 ? 'RESOURCE_ENTRY_CHANGE_NOT_FOUND' : 'RESOURCE_ENTRY_CHANGE_AMBIGUOUS',
      changes.length === 0 ? '找不到该资源条目的逆操作。' : '该资源条目存在重复逆操作记录，已阻止回滚。'
    );
  }
  const confirmationSubject = `ROLLBACK_RESOURCE_ENTRY:${options.opId}:${options.entryUri}`;
  if (!options.confirmation?.id || !options.confirmation.subjects.includes(confirmationSubject)) {
    return fail(options.opId, 'EDIT_CONFIRMATION_REQUIRED', '资源条目回滚需要绑定原操作和条目 URI 的可信确认凭据。');
  }
  const existingInverse = (await options.store.list(record.workspaceId)).find((item) => (
    item.inverseOfOpId === record.opId
      && item.rollbackScope === 'resource_entry'
      && item.rollbackTargetUri === options.entryUri
      && item.status === 'committed'
  ));
  if (existingInverse) {
    return {
      ok: false, opId: options.opId, inverseOpId: existingInverse.opId, restoredFiles: [],
      diagnostics: [{ severity: 'error', code: 'RESOURCE_ENTRY_ALREADY_ROLLED_BACK', message: '该资源条目已经存在已提交的逆向事务。' }],
      record
    };
  }
  const change = changes[0]!;
  const containerFile = record.files.find((file) => file.targetUri === change.resourceUri);
  const inverseEvidence = isValidResourceEntryInverse(change, containerFile?.afterHash);
  if (!inverseEvidence.ok) {
    return fail(options.opId, inverseEvidence.code, inverseEvidence.message);
  }
  const inverseOperation: PatchIrOperation = {
    ...change.inverse,
    metadata: {
      ...change.inverse.metadata,
      requiresConfirmation: true,
      confirmationReceiptId: options.confirmation.id,
      inverseOfOpId: record.opId,
      rollbackScope: 'resource_entry',
      rollbackTargetUri: options.entryUri
    }
  };
  const inversePatch = createPatchIr({
    workspaceId: record.workspaceId,
    title: `回滚资源条目：${options.entryUri}`,
    author: options.author ?? 'user',
    operations: [inverseOperation],
    notes: `原操作 ${record.opId} 的 resource_entry 级逆向事务`
  });
  const committed = await executePatchIrThroughTransaction(inversePatch, {
    ...(options.session ? { session: options.session } : {}),
    ...(options.session?.layers.overlayRoot ? { workspaceRoot: options.session.layers.overlayRoot } : {}),
    operationLog: options.store,
    ...(options.backupBaseDir ? { backupBaseDir: options.backupBaseDir } : {}),
    ...(options.recoveryDir ? { recoveryDir: options.recoveryDir } : {}),
    author: options.author ?? 'user',
    mode: 'normal',
    inverseOfOpId: record.opId,
    rollbackScope: 'resource_entry',
    rollbackTargetUri: options.entryUri
  });
  const ok = Boolean(committed.operation)
    && committed.changedFiles.length === 1
    && committed.diagnostics.every((item) => item.severity !== 'error');
  return {
    ok, opId: options.opId, inverseOpId: committed.opId,
    restoredFiles: ok ? committed.changedFiles : [], diagnostics: committed.diagnostics,
    ...(committed.operation ? { record: committed.operation } : { record })
  };
}

async function rollbackSelected(
  options: RollbackOperationOptions,
  scope: 'operation' | 'file',
  targetUri?: string
): Promise<RollbackOperationResult> {
  const record = await options.store.get(options.opId);
  if (!record) return fail(options.opId, 'OPERATION_NOT_FOUND', `找不到操作 ${options.opId}。`);

  const selectedFiles = scope === 'operation'
    ? record.files
    : record.files.filter((file) => file.targetUri === targetUri);
  if (scope === 'file' && selectedFiles.length === 0) {
    return fail(options.opId, 'ROLLBACK_FILE_NOT_FOUND', `操作 ${options.opId} 中不存在资源 ${targetUri ?? ''}。`);
  }
  if (scope === 'file' && selectedFiles.length > 1) {
    return fail(options.opId, 'ROLLBACK_FILE_AMBIGUOUS', `操作 ${options.opId} 中资源 ${targetUri ?? ''} 存在重复记录。`);
  }

  const confirmationSubject = scope === 'operation'
    ? `ROLLBACK_OPERATION:${options.opId}`
    : `ROLLBACK_FILE:${options.opId}:${targetUri}`;
  if (!options.confirmation?.id
    || !options.confirmation.subjects.includes(confirmationSubject)) {
    return {
      ok: false,
      opId: options.opId,
      restoredFiles: [],
      diagnostics: [{
        severity: 'error',
        code: 'EDIT_CONFIRMATION_REQUIRED',
        message: '回滚操作需要由可信调用方签发、且绑定原操作 ID 的确认凭据。'
      }],
      record
    };
  }

  const existingInverse = (await options.store.list(record.workspaceId)).find((item) => {
    if (item.inverseOfOpId !== record.opId || item.status !== 'committed' || item.rollbackScope !== scope) {
      return false;
    }
    return scope === 'operation' || item.rollbackTargetUri === targetUri;
  });
  if (existingInverse) {
    return {
      ok: false,
      opId: options.opId,
      inverseOpId: existingInverse.opId,
      restoredFiles: [],
      diagnostics: [{
        severity: 'error',
        code: 'OPERATION_ALREADY_ROLLED_BACK',
        message: '该操作已经存在已提交的逆向回滚事务。',
        details: { inverseOpId: existingInverse.opId }
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
        message: `只有已提交操作可以回滚；当前状态为 ${record.status}。`
      }],
      record
    };
  }

  if (!record.backupRoot || selectedFiles.length === 0) {
    return {
      ok: false,
      opId: options.opId,
      restoredFiles: [],
      diagnostics: [{
        severity: 'error',
        code: 'OPERATION_BACKUP_MISSING',
        message: '该已提交操作没有可用于回滚的备份文件。'
      }],
      record
    };
  }

  const diagnostics: Diagnostic[] = [];
  const operations: PatchIrOperation[] = [];

  // Preflight every target and backup before constructing the inverse patch.
  // No filesystem mutation occurs when any target changed after the operation.
  for (const file of selectedFiles) {
    if (options.session) {
      const writable = await options.session.resolveWritablePathSecure(file.targetPath);
      if (!writable.ok) {
        diagnostics.push(...writable.diagnostics);
        continue;
      }
    }

    try {
      const [currentBytes, backupBytes] = await Promise.all([
        readFile(file.targetPath),
        readFile(file.backupPath)
      ]);
      const currentHash = sha256(currentBytes);
      if (currentHash !== file.afterHash) {
        diagnostics.push({
          severity: 'error',
          code: 'ROLLBACK_TARGET_CHANGED',
          message: '目标文件在原操作完成后又发生了变化，已停止回滚。',
          sourceUri: file.targetUri,
          details: { expectedAfterHash: file.afterHash, actualHash: currentHash }
        });
        continue;
      }

      const backupHash = sha256(backupBytes);
      if (backupHash !== file.beforeHash) {
        diagnostics.push({
          severity: 'error',
          code: 'ROLLBACK_BACKUP_CHANGED',
          message: '回滚备份的哈希与原操作记录不一致，已停止回滚。',
          sourceUri: file.targetUri,
          details: { expectedBeforeHash: file.beforeHash, actualBackupHash: backupHash }
        });
        continue;
      }

      operations.push({
        id: randomUUID(),
        kind: 'file_replace',
        targetUri: file.targetUri,
        targetPath: file.targetPath,
        ...(file.resourceKind ? { resourceKind: file.resourceKind } : {}),
        newContentBase64: backupBytes.toString('base64'),
        allowEmpty: backupBytes.length === 0,
        expectedHash: file.afterHash,
        requiresConfirmation: true,
        preconditions: [
          {
            type: 'content_hash',
            description: '回滚目标必须仍等于原操作 afterHash',
            expectedHash: file.afterHash,
            targetUri: file.targetUri
          },
          {
            type: 'overlay_writable',
            description: '回滚只能写入当前 Mod 覆盖层',
            targetUri: file.targetUri
          }
        ],
        validatorRequirements: [
          { validatorId: 'whole_file_replace', scope: 'before_staging', required: true },
          { validatorId: 'whole_file_replace', scope: 'staged_output', required: true },
          { validatorId: 'file_risk', scope: 'before_staging', required: true }
        ],
        rollbackHint: {
          strategy: 'inverse_patch',
          backupRef: file.backupPath,
          notes: `逆向事务，来源操作 ${record.opId}`
        },
        riskLevel: 'high',
        metadata: {
          requiresConfirmation: true,
          confirmationReceiptId: options.confirmation.id,
          inverseOfOpId: record.opId,
          rollbackScope: scope
        }
      });
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        code: 'ROLLBACK_PREFLIGHT_FAILED',
        message: error instanceof Error ? error.message : '回滚前检查失败。',
        sourceUri: file.targetUri
      });
    }
  }

  if (diagnostics.some((item) => item.severity === 'error') || operations.length !== selectedFiles.length) {
    return {
      ok: false,
      opId: options.opId,
      restoredFiles: [],
      diagnostics,
      record
    };
  }

  const inversePatch = createPatchIr({
    workspaceId: record.workspaceId,
    title: `回滚：${record.title}`,
    author: options.author ?? 'user',
    operations,
    notes: `原操作 ${record.opId} 的 operation 级逆向事务`
  });

  const committed = await executePatchIrThroughTransaction(inversePatch, {
    ...(options.session ? { session: options.session } : {}),
    ...(options.session?.layers.overlayRoot
      ? { workspaceRoot: options.session.layers.overlayRoot }
      : {}),
    operationLog: options.store,
    ...(options.backupBaseDir ? { backupBaseDir: options.backupBaseDir } : {}),
    ...(options.recoveryDir ? { recoveryDir: options.recoveryDir } : {}),
    author: options.author ?? 'user',
    mode: 'normal',
    inverseOfOpId: record.opId,
    rollbackScope: scope,
    ...(scope === 'file' && targetUri ? { rollbackTargetUri: targetUri } : {})
  });

  const ok = Boolean(committed.operation)
    && committed.changedFiles.length === selectedFiles.length
    && committed.diagnostics.every((item) => item.severity !== 'error');
  return {
    ok,
    opId: options.opId,
    inverseOpId: committed.opId,
    restoredFiles: ok ? committed.changedFiles : [],
    diagnostics: committed.diagnostics,
    ...(committed.operation ? { record: committed.operation } : { record })
  };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(opId: string, code: string, message: string): RollbackOperationResult {
  return {
    ok: false,
    opId,
    restoredFiles: [],
    diagnostics: [{ severity: 'error', code, message }]
  };
}
