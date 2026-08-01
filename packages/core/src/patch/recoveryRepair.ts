/**
 * Durable journal recovery repair (A-RECOVERY, W-A-RECOVERY-INTEGRATION-04).
 *
 * Consumes `listIncompleteTransactions()` — journal rows whose phase is not
 * terminal (`committed` / `rolled_back` / `failed`) — after a hard process
 * termination and reconciles the workspace back to a consistent, terminal
 * state:
 *
 * - When the journal row carries backup metadata (persisted by
 *   `durablePatchCommit` in the `backing_up -> replacing` transition, before any
 *   target is replaced), each target is first checked for whole-file integrity
 *   (its hash must equal either the before or the recorded after hash). Originals
 *   are then restored from the backup and the restored hashes re-verified.
 * - Leftover `.soulforge-<txid>-<name>.tmp` sibling files from an interrupted
 *   replace loop are removed.
 * - When no backup metadata exists (termination before the restore point was
 *   durable), files are untouched and the transaction is simply marked failed.
 * - Corruption or restore failure is fail-closed: the journal row is left
 *   non-terminal and a structured error diagnostic is returned so a caller can
 *   escalate instead of silently destroying evidence.
 *
 * This is an explicit recovery entry point for a caller (e.g. the main process
 * on session restart). It never auto-replays requests and never performs
 * roll-forward; the safe default is roll-back-to-before.
 */

import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Diagnostic } from '@soulforge/shared';
import type { RestorePoint } from '../backup/restorePoint.js';
import { restoreFromPoint } from '../backup/restorePoint.js';
import type {
  AuditEventRecord,
  TransactionJournalPhase,
  TransactionJournalRecord
} from '../storage/durableWorkspaceRepository.js';
import type { OperationLogStore } from './operationLog.js';

export type RecoveryAction =
  | 'rolled_back'
  | 'marked_failed'
  | 'corruption_blocked'
  | 'restore_failed';

export interface RecoveredTransaction {
  transactionId: string;
  opId: string;
  phase: TransactionJournalPhase;
  action: RecoveryAction;
  restoredFiles: string[];
  removedTempFiles: string[];
  corruptionDetected: boolean;
  journalState: Record<string, unknown>;
}

export interface RecoveryRepairResult {
  recovered: RecoveredTransaction[];
  diagnostics: Diagnostic[];
}

/**
 * The minimal durable-journal surface `recoverIncompleteTransactions` needs.
 *
 * `DurableWorkspaceRepository` (synchronous, one workspace.db connection)
 * satisfies it directly. The desktop main process's async database utility
 * client also satisfies it, so the same recovery entry can be driven from the
 * main process on restart without duplicating the repair logic.
 */
export interface RecoverableJournalRepository {
  listIncompleteTransactions(): TransactionJournalRecord[] | Promise<TransactionJournalRecord[]>;
  transitionTransaction(options: {
    transactionId: string;
    expectedPhase: TransactionJournalPhase | TransactionJournalPhase[];
    nextPhase: TransactionJournalPhase;
    state: unknown;
    updatedAt?: string;
  }): TransactionJournalRecord | Promise<TransactionJournalRecord>;
  appendAuditEvent(
    event: Omit<AuditEventRecord, 'workspaceId' | 'eventId'> & { eventId?: string }
  ): AuditEventRecord | Promise<AuditEventRecord>;
}

interface JournalBackupFile {
  sourcePath: string;
  backupPath: string;
  beforeHash: string;
  sizeBytes: number;
}

interface RepairOutcome {
  transaction: RecoveredTransaction;
  diagnostics: Diagnostic[];
}

/**
 * Reconcile every non-terminal journal row for a workspace back to a terminal
 * state. Idempotent: a second call finds nothing to repair.
 *
 * A corrupt journal row (unparseable `state_json` / invalid phase) makes the
 * whole non-terminal list unreadable; the pass then fails closed with a
 * structured `RECOVERY_JOURNAL_READ_FAILED` diagnostic and repairs nothing, so
 * the corruption is surfaced instead of being silently skipped.
 */
export async function recoverIncompleteTransactions(options: {
  store: OperationLogStore;
  repository: RecoverableJournalRepository;
}): Promise<RecoveryRepairResult> {
  const recovered: RecoveredTransaction[] = [];
  const diagnostics: Diagnostic[] = [];
  let incomplete: TransactionJournalRecord[];
  try {
    incomplete = await options.repository.listIncompleteTransactions();
  } catch (error) {
    diagnostics.push({
      severity: 'error',
      code: 'RECOVERY_JOURNAL_READ_FAILED',
      message: '非终态 journal 列表读取失败（journal 行损坏）；已停止自动恢复并保持数据库不变。',
      details: {
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : typeof error
      }
    });
    return { recovered, diagnostics };
  }
  for (const journal of incomplete) {
    const outcome = await repairJournalTransaction(
      options.store,
      options.repository,
      journal
    );
    recovered.push(outcome.transaction);
    diagnostics.push(...outcome.diagnostics);
  }
  return { recovered, diagnostics };
}

async function repairJournalTransaction(
  store: OperationLogStore,
  repository: RecoverableJournalRepository,
  journal: TransactionJournalRecord<unknown>
): Promise<RepairOutcome> {
  const state = asRecord(journal.state);
  const transactionId = journal.transactionId;
  const diagnostics: Diagnostic[] = [];
  const base: RecoveredTransaction = {
    transactionId,
    opId: journal.opId,
    phase: journal.phase,
    action: 'marked_failed',
    restoredFiles: [],
    removedTempFiles: [],
    corruptionDetected: false,
    journalState: state
  };

  const backupFiles = parseBackupFiles(state);
  if (backupFiles.length === 0) {
    // Termination before the restore point became durable (staging/validating/
    // backing_up without metadata). Files were never replaced; mark failed.
    await markTerminal(store, repository, journal, 'failed', [
      'terminated before the restore point was durable; no files were replaced.'
    ], diagnostics);
    return { transaction: base, diagnostics };
  }

  const afterHashes = asRecord(state.afterHashes);

  // Whole-file integrity check: every target must currently hold exactly the
  // before or the recorded after bytes. Anything else is corruption.
  let corruptionDetected = false;
  for (const file of backupFiles) {
    const currentHash = await hashFile(file.sourcePath);
    const expectedAfter = typeof afterHashes[file.sourcePath] === 'string'
      ? String(afterHashes[file.sourcePath])
      : undefined;
    if (currentHash !== file.beforeHash && currentHash !== expectedAfter) {
      corruptionDetected = true;
      diagnostics.push({
        severity: 'error',
        code: 'RECOVERY_CORRUPTION_DETECTED',
        message: '目标文件在断电恢复时不是完整的 before/after 内容，已拒绝自动还原。',
        details: {
          transactionId,
          path: file.sourcePath,
          beforeHash: file.beforeHash,
          ...(expectedAfter ? { afterHash: expectedAfter } : {}),
          actualHash: currentHash
        }
      });
    }
  }
  if (corruptionDetected) {
    // Fail closed: leave the journal non-terminal so a human/supervisor can
    // inspect. Do not overwrite possibly-recoverable evidence.
    return { transaction: { ...base, corruptionDetected, action: 'corruption_blocked' }, diagnostics };
  }

  const restorePoint = reconstructRestorePoint(journal, state, backupFiles);
  const restored = await restoreFromPoint(restorePoint);
  if (!restored.ok) {
    diagnostics.push({
      severity: 'error',
      code: 'RECOVERY_RESTORE_FAILED',
      message: '恢复点还原失败，已保持 journal 非终态以供人工处置。',
      details: { transactionId, errors: restored.errors }
    });
    return { transaction: { ...base, action: 'restore_failed' }, diagnostics };
  }

  // Re-verify the restored bytes equal the recorded before hashes.
  const restoreErrors: string[] = [];
  for (const file of backupFiles) {
    const restoredHash = await hashFile(file.sourcePath);
    if (restoredHash !== file.beforeHash) {
      restoreErrors.push(`${file.sourcePath} restored to ${restoredHash}, expected ${file.beforeHash}`);
    }
  }
  if (restoreErrors.length !== 0) {
    diagnostics.push({
      severity: 'error',
      code: 'RECOVERY_RESTORE_VERIFY_FAILED',
      message: '恢复后哈希校验失败，已保持 journal 非终态。',
      details: { transactionId, errors: restoreErrors }
    });
    return { transaction: { ...base, action: 'restore_failed' }, diagnostics };
  }

  // Clean up leftover sibling temp files from an interrupted replace loop.
  // A failed deletion is surfaced (the restored originals are verified, but the
  // operator must know an orphaned temp file remains) instead of being silently
  // treated as clean.
  const tempCleanup = await removeLeftoverTempFiles(transactionId, backupFiles);
  if (tempCleanup.failed.length > 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'RECOVERY_TEMP_CLEANUP_FAILED',
      message: '恢复已还原原文件，但残留临时文件无法删除；已保留并上报供人工处置。',
      details: { transactionId, failures: tempCleanup.failed }
    });
  }

  await markTerminal(store, repository, journal, 'rolled_back', [
    'recovered after process termination; originals restored from the journal backup.'
  ], diagnostics);

  return {
    transaction: {
      ...base,
      action: 'rolled_back',
      restoredFiles: restored.restoredPaths,
      removedTempFiles: tempCleanup.removed
    },
    diagnostics
  };
}

async function markTerminal(
  store: OperationLogStore,
  repository: RecoverableJournalRepository,
  journal: TransactionJournalRecord<unknown>,
  nextPhase: TransactionJournalPhase,
  notes: string[],
  diagnostics: Diagnostic[]
): Promise<void> {
  const now = new Date().toISOString();
  try {
    await repository.transitionTransaction({
      transactionId: journal.transactionId,
      expectedPhase: journal.phase,
      nextPhase,
      state: {
        ...asRecord(journal.state),
        recovery: { notes, repairedAt: now }
      },
      updatedAt: now
    });
  } catch (error) {
    diagnostics.push({
      severity: 'error',
      code: 'RECOVERY_JOURNAL_TRANSITION_FAILED',
      message: error instanceof Error ? error.message : '事务 journal 终态化失败。',
      details: { transactionId: journal.transactionId, nextPhase }
    });
    return;
  }
  try {
    await repository.appendAuditEvent({
      eventKind: 'recovery.repaired',
      opId: journal.opId,
      transactionId: journal.transactionId,
      payload: { nextPhase, notes },
      createdAt: now
    });
  } catch (error) {
    diagnostics.push({
      severity: 'warning',
      code: 'RECOVERY_AUDIT_FAILED',
      message: error instanceof Error ? error.message : '恢复审计写入失败。',
      details: { transactionId: journal.transactionId }
    });
  }
  if (store.updateStatus) {
    try {
      await store.updateStatus(journal.opId, 'failed', {
        diagnostics: [{
          severity: 'error',
          code: 'TRANSACTION_RECOVERED_AFTER_CRASH',
          message: nextPhase === 'rolled_back'
            ? '进程终止后已从 journal 恢复并还原原文件。'
            : '进程终止后事务已标记失败；未替换任何目标文件。',
          details: { transactionId: journal.transactionId, notes }
        }]
      });
    } catch (error) {
      diagnostics.push({
        severity: 'warning',
        code: 'RECOVERY_OP_STATUS_FAILED',
        message: error instanceof Error ? error.message : '操作日志状态更新失败。',
        details: { opId: journal.opId, transactionId: journal.transactionId }
      });
    }
  }
}

function reconstructRestorePoint(
  journal: TransactionJournalRecord<unknown>,
  state: Record<string, unknown>,
  files: JournalBackupFile[]
): RestorePoint {
  const root = typeof state.backupRoot === 'string' ? state.backupRoot : '';
  return {
    restorePointId: journal.transactionId,
    root,
    createdAt: journal.createdAt,
    files: files.map((file) => ({
      sourcePath: file.sourcePath,
      backupPath: file.backupPath,
      beforeHash: file.beforeHash,
      sizeBytes: file.sizeBytes
    })),
    sizeBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
    metadataPath: root ? join(root, 'restore-point.json') : ''
  };
}

function parseBackupFiles(state: Record<string, unknown>): JournalBackupFile[] {
  if (!Array.isArray(state.restorePointFiles)) return [];
  return state.restorePointFiles.filter(isJournalBackupFile);
}

function isJournalBackupFile(value: unknown): value is JournalBackupFile {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.sourcePath === 'string'
    && typeof record.backupPath === 'string'
    && typeof record.beforeHash === 'string'
    && typeof record.sizeBytes === 'number';
}

async function removeLeftoverTempFiles(
  transactionId: string,
  files: JournalBackupFile[]
): Promise<{ removed: string[]; failed: Array<{ path: string; message: string }> }> {
  const removed: string[] = [];
  const failed: Array<{ path: string; message: string }> = [];
  for (const file of files) {
    const siblingTemp = join(
      dirname(file.sourcePath),
      `.soulforge-${transactionId}-${basename(file.sourcePath)}.tmp`
    );
    try {
      await rm(siblingTemp, { force: true });
      removed.push(siblingTemp);
    } catch (error) {
      // Surface the failure rather than silently reporting a clean sweep.
      failed.push({
        path: siblingTemp,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return { removed, failed };
}

async function hashFile(path: string): Promise<string | undefined> {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex');
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
}
