/**
 * Durable PatchIR commit: pending op log → WorkspaceTransaction → committed/recovery.
 * Ensures ok=true implies a findable recoverable operation record (or recovery metadata).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type {
  Diagnostic,
  FileOperationRecord,
  GraphPatch,
  OperationLogRecord,
  PatchIR,
  PatchIrOperation,
  ContainerChildOp,
  PatchMode,
  ValidatorContract
} from '@soulforge/shared';
import { toLegacyDiagnostic } from '@soulforge/shared';
import {
  createWorkspaceTransaction,
  type WorkspaceTransaction
} from '../transactions/workspaceTransaction.js';
import { createScaffoldValidators } from '../validators/index.js';
import type { WorkspaceSession } from '../workspace/workspaceSession.js';
import {
  createCommittedOperationRecord,
  getDefaultOperationLogStore,
  type OperationLogStore
} from './operationLog.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { captureNativeBnd4ResourceEntryChanges } from './containerChildInverse.js';

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
  inverseOfOpId?: string;
  rollbackScope?: OperationLogRecord['rollbackScope'];
  rollbackTargetUri?: string;
  /**
   * Validators appended after the scaffold list. after_commit validators here
   * run inside the transaction's commit boundary: a failure rolls the files
   * back and the operation log records the recovery (e.g. EMEVD Bridge reopen).
   */
  appendValidators?: ValidatorContract[];
  resourceEntryChanges?: Array<{
    id: string;
    resourceUri: string;
    entryUri: string;
    changeKind: string;
    beforeHash?: string;
    afterHash?: string;
    inverse: PatchIrOperation;
  }>;
  /**
   * Additional domain patches that must share this exact WorkspaceTransaction.
   * The primary patch remains the operation-log identity; all operations are
   * staged, validated and committed together.
   */
  additionalPatches?: readonly PatchIR[];
  /**
   * Optional semantic boundary checks. They run before the restore point is
   * created and after the bytes have been committed, while the same durable
   * transaction remains available for rollback.
   */
  semanticChecks?: {
    beforeCommit?: (transaction: WorkspaceTransaction) => Promise<Diagnostic[]>;
    afterCommit?: () => Promise<Diagnostic[]>;
  };
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
  const additionalPatches = options.additionalPatches ?? [];
  const transactionPatch: PatchIR = additionalPatches.length === 0
    ? patch
    : {
        ...patch,
        operations: [
          ...patch.operations,
          ...additionalPatches.flatMap((candidate) => candidate.operations)
        ],
        affectedResources: [
          ...new Set([
            ...patch.affectedResources,
            ...additionalPatches.flatMap((candidate) => candidate.affectedResources)
          ])
        ]
      };
  const store: OperationLogStore = options.operationLog ?? getDefaultOperationLogStore();
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
    for (const op of transactionPatch.operations) {
      if (!op.targetPath) continue;
      const writable = await options.session.resolveWritablePathSecure(op.targetPath, 'overlay');
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
    await store.record(pending);
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

  // Capture precise resource-entry inverses for native BND4 mutations before any write.
  // Caller-provided changes (e.g. synthetic replace) take precedence.
  let capturedResourceEntryChanges = options.resourceEntryChanges ?? [];
  if (capturedResourceEntryChanges.length === 0) {
    const inverseCapture = await captureNativeBnd4ResourceEntryChanges(transactionPatch.operations, workspaceRoot);
    if (inverseCapture.diagnostics.some((item) => item.severity === 'error')) {
      await tryUpdateStatus(store, opId, 'failed', {
        diagnostics: inverseCapture.diagnostics
      }, 'inverse_capture');
      return {
        opId,
        backupRoot: '',
        changedFiles: [],
        diagnostics: inverseCapture.diagnostics
      };
    }
    capturedResourceEntryChanges = inverseCapture.changes;
  }

  const tx = createWorkspaceTransaction({
    workspaceId: patch.workspaceId,
    workspaceRoot: resolve(workspaceRoot),
    actor: {
      kind: author === 'ai' ? 'agent' : 'user',
      id: options.actorId ?? `files-mode:${author}`
    },
    validators: [
      ...createScaffoldValidators(),
      ...(options.appendValidators ?? [])
    ],
    ...(options.backupBaseDir !== undefined ? { backupBaseDir: options.backupBaseDir } : {}),
    // Persist the restore point into the durable journal before any target is
    // replaced. A hard process termination mid-commit then leaves enough state
    // in the journal (backup root + per-file before/after hashes) to roll back.
    onRestorePointCreated: async (restorePoint) => {
      const afterHashes: Record<string, string> = {};
      for (const target of tx.getCommitTargets()) {
        try {
          afterHashes[target.targetPath] = createHash('sha256')
            .update(await readFile(target.stagingPath))
            .digest('hex');
        } catch {
          // After-hash unresolvable (staged file already gone); recovery then
          // relies on the before-hash invariant alone for this target.
        }
      }
      const journalError = await transitionJournal(
        store,
        tx.transactionId,
        'backing_up',
        'replacing',
        {
          backupRoot: restorePoint.root,
          sizeBytes: restorePoint.sizeBytes,
          restorePointFiles: restorePoint.files.map((file) => ({
            sourcePath: file.sourcePath,
            backupPath: file.backupPath,
            beforeHash: file.beforeHash,
            sizeBytes: file.sizeBytes
          })),
          afterHashes
        }
      );
      if (journalError) throw new Error(journalError.message);
    }
  });

  if (store.createTransaction && store.transitionTransaction) {
    const now = new Date().toISOString();
    try {
      await store.createTransaction({
        transactionId: tx.transactionId,
        opId,
        phase: 'pending',
        state: { operationCount: transactionPatch.operations.length },
        createdAt: now,
        updatedAt: now
      });
      const updated = await store.updateStatus(opId, 'pending', { transactionId: tx.transactionId });
      if (!updated) throw new Error('Pending operation disappeared while attaching transaction id.');
    } catch (error) {
      await tryUpdateStatus(store, opId, 'failed', {
        diagnostics: [journalDiagnostic('TRANSACTION_JOURNAL_CREATE_FAILED', error, tx.transactionId)]
      }, 'journal_create');
      return {
        opId,
        backupRoot: '',
        changedFiles: [],
        diagnostics: [journalDiagnostic('TRANSACTION_JOURNAL_CREATE_FAILED', error, tx.transactionId)]
      };
    }
  }

  const added = tx.addPatch({ ...transactionPatch, patchId: opId });
  if (!added.ok) {
    const phaseDiagnostics = added.diagnostics.map(toLegacyDiagnostic);
    const logDiagnostic = await tryUpdateStatus(store, opId, 'failed', {
      diagnostics: phaseDiagnostics
    }, 'add_patch');
    return {
      opId,
      backupRoot: '',
      changedFiles: [],
      diagnostics: logDiagnostic ? [...phaseDiagnostics, logDiagnostic] : phaseDiagnostics
    };
  }


  const stagingJournalError = await transitionJournal(
    store, tx.transactionId, 'pending', 'staging', { operationCount: transactionPatch.operations.length }
  );
  if (stagingJournalError) {
    await tryUpdateStatus(store, opId, 'failed', { diagnostics: [stagingJournalError] }, 'journal_staging');
    return { opId, backupRoot: '', changedFiles: [], diagnostics: [stagingJournalError] };
  }

  let staged: Awaited<ReturnType<typeof tx.stage>>;
  try {
    staged = await tx.stage();
  } catch (error) {
    const phaseDiagnostics = [
      transactionPhaseDiagnostic('TRANSACTION_STAGE_FAILED', 'stage', error),
      ...(await tx.discardStaging()).map(toLegacyDiagnostic)
    ];
    const logDiagnostic = await tryUpdateStatus(store, opId, 'failed', {
      diagnostics: phaseDiagnostics
    }, 'stage_exception');
    await transitionJournal(store, tx.transactionId, 'staging', 'failed', { phase: 'stage', diagnostics: phaseDiagnostics });
    return {
      opId,
      backupRoot: '',
      changedFiles: [],
      diagnostics: logDiagnostic ? [...phaseDiagnostics, logDiagnostic] : phaseDiagnostics
    };
  }
  if (!staged.ok) {
    const phaseDiagnostics = staged.diagnostics.map(toLegacyDiagnostic);
    const logDiagnostic = await tryUpdateStatus(store, opId, 'failed', {
      diagnostics: phaseDiagnostics
    }, 'stage');
    await transitionJournal(store, tx.transactionId, 'staging', 'failed', { phase: 'stage', diagnostics: phaseDiagnostics });
    return {
      opId,
      backupRoot: '',
      changedFiles: [],
      diagnostics: logDiagnostic ? [...phaseDiagnostics, logDiagnostic] : phaseDiagnostics
    };
  }


  const validatingJournalError = await transitionJournal(
    store, tx.transactionId, 'staging', 'validating', { staged: true }
  );
  if (validatingJournalError) {
    const diagnostics = [
      validatingJournalError,
      ...(await tx.discardStaging()).map(toLegacyDiagnostic)
    ];
    await tryUpdateStatus(store, opId, 'failed', { diagnostics }, 'journal_validating');
    return { opId, backupRoot: '', changedFiles: [], diagnostics };
  }

  let validated: Awaited<ReturnType<typeof tx.validate>>;
  try {
    validated = await tx.validate();
  } catch (error) {
    const phaseDiagnostics = [
      transactionPhaseDiagnostic('TRANSACTION_VALIDATE_FAILED', 'validate', error),
      ...(await tx.discardStaging()).map(toLegacyDiagnostic)
    ];
    const logDiagnostic = await tryUpdateStatus(store, opId, 'failed', {
      diagnostics: phaseDiagnostics
    }, 'validate_exception');
    await transitionJournal(store, tx.transactionId, 'validating', 'failed', { phase: 'validate', diagnostics: phaseDiagnostics });
    return {
      opId,
      backupRoot: '',
      changedFiles: [],
      diagnostics: logDiagnostic ? [...phaseDiagnostics, logDiagnostic] : phaseDiagnostics
    };
  }
  if (!validated.ok) {
    const phaseDiagnostics = validated.diagnostics.map(toLegacyDiagnostic);
    const logDiagnostic = await tryUpdateStatus(store, opId, 'failed', {
      diagnostics: phaseDiagnostics
    }, 'validate');
    await transitionJournal(store, tx.transactionId, 'validating', 'failed', { phase: 'validate', diagnostics: phaseDiagnostics });
    return {
      opId,
      backupRoot: '',
      changedFiles: [],
      diagnostics: logDiagnostic ? [...phaseDiagnostics, logDiagnostic] : phaseDiagnostics
    };
  }

  if (options.semanticChecks?.beforeCommit) {
    const semanticDiagnostics = await runSemanticCheck(
      () => options.semanticChecks!.beforeCommit!(tx),
      'SEMANTIC_PRECOMMIT_CHECK_FAILED'
    );
    if (semanticDiagnostics.some((item) => item.severity === 'error')) {
      const diagnostics = [
        ...semanticDiagnostics,
        ...(await tx.discardStaging()).map(toLegacyDiagnostic)
      ];
      const logDiagnostic = await tryUpdateStatus(store, opId, 'failed', {
        diagnostics
      }, 'semantic_precommit');
      await transitionJournal(store, tx.transactionId, 'validating', 'failed', {
        phase: 'semantic_precommit',
        diagnostics
      });
      return {
        opId,
        backupRoot: '',
        changedFiles: [],
        diagnostics: logDiagnostic ? [...diagnostics, logDiagnostic] : diagnostics
      };
    }
  }


  const backingUpJournalError = await transitionJournal(
    store, tx.transactionId, 'validating', 'backing_up', { validated: true }
  );
  if (backingUpJournalError) {
    const diagnostics = [
      backingUpJournalError,
      ...(await tx.discardStaging()).map(toLegacyDiagnostic)
    ];
    await tryUpdateStatus(store, opId, 'failed', { diagnostics }, 'journal_backing_up');
    return { opId, backupRoot: '', changedFiles: [], diagnostics };
  }

  let committed: Awaited<ReturnType<typeof tx.commit>>;
  try {
    committed = await tx.commit();
  } catch (error) {
    const diagnostics = [
      transactionPhaseDiagnostic('TRANSACTION_COMMIT_FAILED', 'commit', error),
      ...(await tx.discardStaging()).map(toLegacyDiagnostic)
    ];
    await transitionJournal(store, tx.transactionId, ['backing_up', 'replacing'], 'failed', { phase: 'commit', diagnostics });
    const logDiagnostic = await tryUpdateStatus(store, opId, 'failed', {
      diagnostics
    }, 'commit_exception');
    return {
      opId,
      backupRoot: '',
      changedFiles: [],
      diagnostics: logDiagnostic ? [...diagnostics, logDiagnostic] : diagnostics
    };
  }
  const diagnostics: Diagnostic[] = committed.diagnostics.map(toLegacyDiagnostic);

  if (!committed.ok && committed.recoveryRequired && committed.restorePoint) {
    await transitionJournal(store, tx.transactionId, ['backing_up', 'replacing'], 'recovery_required', {
      committedPaths: committed.committedPaths,
      recoveryRequired: true
    });
    const recoveryDir = options.recoveryDir ?? defaultRecoveryDirectory();
    await mkdir(recoveryDir, { recursive: true });
    const recoveryPath = join(recoveryDir, `${opId}.recovery.json`);
    const recoveryPayload = {
      status: 'recovery_required',
      opId,
      transactionId: committed.transactionId,
      backupRoot: committed.restorePoint.root,
      committedPaths: committed.committedPaths,
      restorePointFiles: committed.restorePoint.files,
      failureRecovery: tx.getFailureRecoveryMetadata(),
      diagnostics,
      createdAt: new Date().toISOString()
    };
    await writeFile(recoveryPath, `${JSON.stringify(recoveryPayload, null, 2)}\n`, 'utf8');
    const fileRecords = await buildFileRecords(transactionPatch, committed.restorePoint.files);
    const logDiagnostic = await tryUpdateStatus(store, opId, 'recovery_required', {
      recoveryPath,
      recoveryReason: 'Transaction commit or automatic rollback did not restore every target.',
      backupRoot: committed.restorePoint.root,
      files: fileRecords,
      transactionId: committed.transactionId,
      diagnostics
    }, 'mark_recovery_required');
    return {
      opId,
      backupRoot: committed.restorePoint.root,
      changedFiles: committed.committedPaths,
      diagnostics: logDiagnostic ? [...diagnostics, logDiagnostic] : diagnostics,
      recoveryPath
    };
  }

  if (!committed.ok || !committed.restorePoint) {
    await transitionJournal(store, tx.transactionId, ['backing_up', 'replacing'], 'failed', { phase: 'commit', diagnostics });
    const logDiagnostic = await tryUpdateStatus(
      store,
      opId,
      'failed',
      { diagnostics },
      'commit_failed'
    );
    return {
      opId,
      backupRoot: committed.restorePoint?.root ?? '',
      changedFiles: [],
      diagnostics: logDiagnostic ? [...diagnostics, logDiagnostic] : diagnostics
    };
  }

  if (options.semanticChecks?.afterCommit) {
    const semanticDiagnostics = await runSemanticCheck(
      options.semanticChecks.afterCommit,
      'SEMANTIC_POSTCOMMIT_CHECK_FAILED'
    );
    if (semanticDiagnostics.some((item) => item.severity === 'error')) {
      return rollbackAfterSemanticCheck({
        store,
        opId,
        transaction: tx,
        committed: {
          transactionId: committed.transactionId,
          committedPaths: committed.committedPaths,
          restorePoint: committed.restorePoint
        },
        transactionPatch,
        diagnostics: [...diagnostics, ...semanticDiagnostics],
        ...(options.recoveryDir ? { recoveryDir: options.recoveryDir } : {})
      });
    }
    diagnostics.push(...semanticDiagnostics);
  }

  const fileRecords = await buildFileRecords(transactionPatch, committed.restorePoint.files);
  const operation = createCommittedOperationRecord({
    proposal: {
      opId,
      workspaceId: patch.workspaceId,
      title: patch.title,
      author,
      mode,
      changes: transactionPatch.operations.map((op) => ({
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
  if (options.inverseOfOpId) operation.inverseOfOpId = options.inverseOfOpId;
  if (options.rollbackScope) operation.rollbackScope = options.rollbackScope;
  if (options.rollbackTargetUri) operation.rollbackTargetUri = options.rollbackTargetUri;

  try {
    const markingError = await transitionJournal(
      store, tx.transactionId, 'replacing', 'marking_committed',
      { committedPaths: committed.committedPaths }
    );
    if (markingError) throw new Error(markingError.message);
    const resourceEntryChanges = capturedResourceEntryChanges.map((change) => {
      const file = operation.files.find((item) => item.targetUri === change.resourceUri);
      return { ...change, opId, inverse: withCommittedContainerHash(change.inverse, file?.afterHash) };
    });
    const recoveryPoint = {
      recoveryId: tx.transactionId,
      opId,
      rootPath: committed.restorePoint.root,
      sizeBytes: committed.restorePoint.sizeBytes,
      state: 'active' as const,
      createdAt: new Date().toISOString(),
      metadata: { fileCount: committed.restorePoint.files.length }
    };
    const auditEvent = {
      eventId: randomUUID(),
      eventKind: 'transaction.committed',
      opId,
      transactionId: tx.transactionId,
      payload: { changedFileCount: committed.committedPaths.length },
      createdAt: new Date().toISOString()
    };
    const finalState = { changedFileCount: committed.committedPaths.length };
    if (store.finalizeCommit) {
      await store.finalizeCommit({
        operation,
        resourceEntryChanges,
        recoveryPoint,
        auditEvent,
        transactionId: tx.transactionId,
        expectedPhase: 'marking_committed',
        finalState
      });
    } else {
      await store.record(operation);
      if (resourceEntryChanges.length) {
        if (!store.recordResourceEntryChange) {
          throw new Error('Operation log store cannot persist resource entry inverse operations.');
        }
        for (const change of resourceEntryChanges) await store.recordResourceEntryChange(change);
      }
      if (store.recordRecoveryPoint) await store.recordRecoveryPoint(recoveryPoint);
      if (store.appendAuditEvent) await store.appendAuditEvent(auditEvent);
      const committedJournalError = await transitionJournal(
        store, tx.transactionId, 'marking_committed', 'committed', finalState
      );
      if (committedJournalError) throw new Error(committedJournalError.message);
    }
  } catch (error) {
    // Attempt rollback of already-written files.
    const rolled = await tx.rollback();
    if (rolled.ok) {
      await transitionJournal(
        store, tx.transactionId,
        ['marking_committed', 'committed'], 'rolled_back',
        { reason: 'post_commit_persistence_failed' }
      );
      const recordDiagnostic: Diagnostic = {
        severity: 'error',
        code: 'OPERATION_LOG_RECORD_FAILED',
        message: error instanceof Error
          ? `Post-commit operation log failed; files were rolled back: ${error.message}`
          : 'Post-commit operation log failed; files were rolled back.',
        details: { phase: 'mark_committed', transactionId: committed.transactionId }
      };
      const statusDiagnostic = await tryUpdateStatus(store, opId, 'rolled_back', {
        diagnostics: [recordDiagnostic]
      }, 'mark_rolled_back');
      if (statusDiagnostic) {
        const recoveryDir = options.recoveryDir ?? defaultRecoveryDirectory();
        await mkdir(recoveryDir, { recursive: true });
        const recoveryPath = join(recoveryDir, `${opId}.recovery.json`);
        const recoveryPayload = {
          status: 'operation_log_reconciliation_required',
          finalFileState: 'rolled_back',
          opId,
          transactionId: committed.transactionId,
          backupRoot: committed.restorePoint.root,
          restorePointFiles: committed.restorePoint.files,
          committedPaths: committed.committedPaths,
          recordError: error instanceof Error ? error.message : String(error),
          statusUpdateError: statusDiagnostic.message,
          createdAt: new Date().toISOString()
        };
        await writeFile(recoveryPath, `${JSON.stringify(recoveryPayload, null, 2)}\n`, 'utf8');
        return {
          opId,
          backupRoot: committed.restorePoint.root,
          changedFiles: [],
          diagnostics: [recordDiagnostic, statusDiagnostic, {
            severity: 'error',
            code: 'OPERATION_LOG_RECONCILIATION_REQUIRED',
            message: '文件已自动恢复，但操作日志最终状态无法落库；已写入恢复元数据供重启后对账。',
            details: recoveryPayload
          }],
          recoveryPath
        };
      }
      return {
        opId,
        backupRoot: committed.restorePoint.root,
        changedFiles: [],
        diagnostics: [recordDiagnostic]
      };
    }

    // Rollback failed — durable recovery metadata required.
    const recoveryDir = options.recoveryDir ?? defaultRecoveryDirectory();
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
      await store.updateStatus(opId, 'recovery_required', {
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

export function defaultRecoveryDirectory(): string {
  const applicationDataRoot = process.env.LOCALAPPDATA?.trim() || tmpdir();
  return join(applicationDataRoot, 'SoulForge', 'recovery');
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

async function runSemanticCheck(
  check: () => Promise<Diagnostic[]>,
  code: string
): Promise<Diagnostic[]> {
  try {
    return await check();
  } catch (error) {
    return [{
      severity: 'error',
      code,
      message: error instanceof Error ? error.message : '语义事务检查失败。'
    }];
  }
}

type CommittedWorkspaceTransaction = {
  transactionId: string;
  committedPaths: string[];
  restorePoint: NonNullable<Awaited<ReturnType<WorkspaceTransaction['commit']>>['restorePoint']>;
};

async function rollbackAfterSemanticCheck(input: {
  store: OperationLogStore;
  opId: string;
  transaction: WorkspaceTransaction;
  committed: CommittedWorkspaceTransaction;
  transactionPatch: PatchIR;
  diagnostics: Diagnostic[];
  recoveryDir?: string;
}): Promise<TransactionCommitCompatResult> {
  const rolledBack = await input.transaction.rollback();
  const diagnostics = [
    ...input.diagnostics,
    ...rolledBack.diagnostics.map(toLegacyDiagnostic)
  ];
  if (rolledBack.ok) {
    await transitionJournal(
      input.store,
      input.committed.transactionId,
      ['backing_up', 'replacing'],
      'rolled_back',
      { reason: 'semantic_postcommit_check_failed' }
    );
    const logDiagnostic = await tryUpdateStatus(input.store, input.opId, 'rolled_back', {
      diagnostics
    }, 'semantic_postcommit_rollback');
    return {
      opId: input.opId,
      backupRoot: input.committed.restorePoint.root,
      changedFiles: [],
      diagnostics: logDiagnostic ? [...diagnostics, logDiagnostic] : diagnostics
    };
  }

  const recoveryDir = input.recoveryDir ?? defaultRecoveryDirectory();
  await mkdir(recoveryDir, { recursive: true });
  const recoveryPath = join(recoveryDir, `${input.opId}.recovery.json`);
  const recoveryPayload = {
    status: 'recovery_required',
    opId: input.opId,
    transactionId: input.committed.transactionId,
    backupRoot: input.committed.restorePoint.root,
    committedPaths: input.committed.committedPaths,
    restorePointFiles: input.committed.restorePoint.files,
    files: await buildFileRecords(input.transactionPatch, input.committed.restorePoint.files),
    diagnostics,
    createdAt: new Date().toISOString()
  };
  await writeFile(recoveryPath, `${JSON.stringify(recoveryPayload, null, 2)}\n`, 'utf8');
  await transitionJournal(
    input.store,
    input.committed.transactionId,
    ['backing_up', 'replacing'],
    'recovery_required',
    { recoveryPath, reason: 'semantic_postcommit_check_failed' }
  );
  const logDiagnostic = await tryUpdateStatus(input.store, input.opId, 'recovery_required', {
    recoveryPath,
    recoveryReason: '语义提交后检查失败且自动回滚未完整成功。',
    backupRoot: input.committed.restorePoint.root,
    files: recoveryPayload.files,
    transactionId: input.committed.transactionId,
    diagnostics
  }, 'semantic_postcommit_recovery');
  return {
    opId: input.opId,
    backupRoot: input.committed.restorePoint.root,
    changedFiles: input.committed.committedPaths,
    diagnostics: logDiagnostic ? [...diagnostics, logDiagnostic] : diagnostics,
    recoveryPath
  };
}

async function tryUpdateStatus(
  store: OperationLogStore,
  opId: string,
  status: OperationLogRecord['status'],
  patch: Partial<OperationLogRecord>,
  phase: string
): Promise<Diagnostic | null> {
  try {
    await store.updateStatus(opId, status, patch);
    return null;
  } catch (error) {
    return {
      severity: 'error',
      code: 'OPERATION_LOG_UPDATE_FAILED',
      message: error instanceof Error
        ? `操作日志状态更新失败：${error.message}`
        : '操作日志状态更新失败。',
      details: { phase, opId, status }
    };
  }
}

async function transitionJournal(
  store: OperationLogStore,
  transactionId: string,
  expectedPhase: import('../storage/durableWorkspaceRepository.js').TransactionJournalPhase
    | import('../storage/durableWorkspaceRepository.js').TransactionJournalPhase[],
  nextPhase: import('../storage/durableWorkspaceRepository.js').TransactionJournalPhase,
  state: unknown
): Promise<Diagnostic | null> {
  if (!store.transitionTransaction) return null;
  try {
    await store.transitionTransaction({ transactionId, expectedPhase, nextPhase, state });
    return null;
  } catch (error) {
    return journalDiagnostic('TRANSACTION_JOURNAL_TRANSITION_FAILED', error, transactionId, {
      expectedPhase,
      nextPhase
    });
  }
}

function transactionPhaseDiagnostic(
  code: string,
  phase: string,
  error: unknown
): Diagnostic {
  return {
    severity: 'error',
    code,
    message: `${phase} 阶段失败。`,
    details: {
      phase,
      errorName: error instanceof Error ? error.name : typeof error,
      ...('code' in Object(error) && typeof Object(error).code === 'string'
        ? { systemCode: Object(error).code }
        : {})
    }
  };
}

function journalDiagnostic(
  code: string,
  error: unknown,
  transactionId: string,
  details: Record<string, unknown> = {}
): Diagnostic {
  return {
    severity: 'error',
    code,
    message: error instanceof Error ? error.message : '事务日志持久化失败。',
    details: { transactionId, ...details }
  };
}

function withCommittedContainerHash(
  operation: PatchIrOperation,
  afterHash: string | undefined
): PatchIrOperation {
  if (!afterHash || !operation.kind.startsWith('container_child_')) return operation;
  const containerOperation = operation as ContainerChildOp;
  return {
    ...containerOperation,
    expectedHash: afterHash,
    expectedContainerHash: afterHash,
    preconditions: containerOperation.preconditions.map((precondition) => (
      precondition.type === 'content_hash'
        ? { ...precondition, expectedHash: afterHash }
        : precondition
    ))
  };
}
