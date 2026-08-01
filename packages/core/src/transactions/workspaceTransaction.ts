/**
 * WorkspaceTransaction scaffold:
 * create -> add PatchIR -> stage -> validate -> commit -> audit -> rollback
 *
 * Only operates on sandbox / temp workspace paths passed in by callers.
 * Never writes outside the provided workspace root.
 */

import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type {
  AuditActor,
  AuditLogStore,
  PatchIR,
  PatchIrOperation,
  StructuredDiagnostic,
  ValidatorContract,
  WriterAdapterContract
} from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';
import { createAuditEntry, MemoryAuditLogStore } from '../audit-log/memoryAuditLog.js';
import { createRestorePoint, restoreFromPoint, type RestorePoint } from '../backup/restorePoint.js';
import { validatePatchIr } from '../patch-engine/patchIr.js';
import {
  createContentAddressedStaging,
  stagingWorkRoot,
  type ContentAddressedStaging
} from '../staging/contentAddressedStaging.js';
import { createScaffoldValidators } from '../validators/index.js';
import { checkOriginalContentHash } from '../validators/textHash.js';
import { createScaffoldWriterAdapters, resolveWriterForOperation } from '../writers/index.js';
import { verifyPathInsideRoot } from '../workspace/pathBoundary.js';

export type TransactionStatus =
  | 'open'
  | 'staged'
  | 'validated'
  | 'committed'
  | 'rolled_back'
  | 'failed';

export interface WorkspaceTransactionOptions {
  workspaceId: string;
  /** Absolute sandbox workspace root. All commits must stay under this root. */
  workspaceRoot: string;
  actor?: AuditActor;
  auditLog?: AuditLogStore;
  writers?: WriterAdapterContract[];
  validators?: ValidatorContract[];
  stagingBaseDir?: string;
  backupBaseDir?: string;
  /**
   * Invoked immediately after the restore point is created and before any target
   * file is replaced. A durable caller (e.g. the SQLite journal driver) uses this
   * to persist the backup location ahead of the replace loop so that a process
   * termination mid-commit can still roll the transaction back on restart.
   */
  onRestorePointCreated?: (restorePoint: RestorePoint) => Promise<void> | void;
}

export interface TransactionCommitResult {
  ok: boolean;
  transactionId: string;
  committedPaths: string[];
  diagnostics: StructuredDiagnostic[];
  restorePoint?: RestorePoint;
  /** True when one or more target files may still contain committed bytes. */
  recoveryRequired?: boolean;
}

export interface TransactionRollbackResult {
  ok: boolean;
  transactionId: string;
  restoredPaths: string[];
  diagnostics: StructuredDiagnostic[];
}

export class WorkspaceTransaction {
  readonly transactionId: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  private status: TransactionStatus = 'open';
  private readonly patches: PatchIR[] = [];
  private readonly actor: AuditActor;
  private readonly auditLog: AuditLogStore;
  private readonly writers: WriterAdapterContract[];
  private readonly validators: ValidatorContract[];
  private readonly stagingBaseDir?: string;
  private readonly backupBaseDir?: string;
  private readonly onRestorePointCreated: ((restorePoint: RestorePoint) => Promise<void> | void) | undefined;
  private staging: ContentAddressedStaging | undefined;
  private stagedPaths: string[] = [];
  private stagedOpTargets: Array<{ op: PatchIrOperation; stagingPath: string }> = [];
  private restorePoint: RestorePoint | undefined;
  private committedPaths: string[] = [];
  private readonly diagnostics: StructuredDiagnostic[] = [];
  private failureRecovery: Record<string, unknown> | undefined;

  constructor(options: WorkspaceTransactionOptions) {
    this.transactionId = randomUUID();
    this.workspaceId = options.workspaceId;
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.actor = options.actor ?? { kind: 'system', id: 'workspace-transaction' };
    this.auditLog = options.auditLog ?? new MemoryAuditLogStore();
    this.writers = options.writers ?? createScaffoldWriterAdapters();
    this.validators = options.validators ?? createScaffoldValidators();
    if (options.stagingBaseDir !== undefined) this.stagingBaseDir = options.stagingBaseDir;
    if (options.backupBaseDir !== undefined) this.backupBaseDir = options.backupBaseDir;
    this.onRestorePointCreated = options.onRestorePointCreated;

    this.auditLog.append(createAuditEntry({
      transactionId: this.transactionId,
      actor: this.actor,
      eventKind: 'transaction_created',
      details: { workspaceId: this.workspaceId, workspaceRoot: this.workspaceRoot }
    }));
  }

  getStatus(): TransactionStatus {
    return this.status;
  }

  getPatches(): readonly PatchIR[] {
    return this.patches;
  }

  getAuditLog(): AuditLogStore {
    return this.auditLog;
  }

  getDiagnostics(): readonly StructuredDiagnostic[] {
    return this.diagnostics;
  }

  getFailureRecoveryMetadata(): Record<string, unknown> | undefined {
    return this.failureRecovery;
  }

  /**
   * The planned commit targets (operation, resolved target path, staging path).
   * Exposed so a durable journal driver can persist per-target after-hashes
   * before the replace loop begins.
   */
  getCommitTargets(): Array<{ op: PatchIrOperation; targetPath: string; stagingPath: string }> {
    return this.collectCommitTargets();
  }

  addPatch(patch: PatchIR): { ok: boolean; diagnostics: StructuredDiagnostic[] } {
    if (this.status !== 'open') {
      const diagnostic = createDiagnostic({
        severity: 'error',
        code: 'TRANSACTION_FAILED',
        message: `Cannot add patch in status ${this.status}.`
      });
      this.diagnostics.push(diagnostic);
      return { ok: false, diagnostics: [diagnostic] };
    }

    const validation = validatePatchIr(patch);
    this.diagnostics.push(...validation.diagnostics);
    if (!validation.ok) {
      this.status = 'failed';
      this.failureRecovery = { phase: 'addPatch', patchId: patch.patchId };
      return { ok: false, diagnostics: validation.diagnostics };
    }

    this.patches.push(patch);
    this.auditLog.append(createAuditEntry({
      transactionId: this.transactionId,
      actor: this.actor,
      eventKind: 'patch_added',
      patchId: patch.patchId,
      affectedResources: patch.affectedResources,
      diagnostics: validation.diagnostics
    }));
    return { ok: true, diagnostics: validation.diagnostics };
  }

  async stage(): Promise<{ ok: boolean; stagingRoot?: string; diagnostics: StructuredDiagnostic[] }> {
    if (this.patches.length === 0) {
      const diagnostic = createDiagnostic({
        severity: 'error',
        code: 'TRANSACTION_FAILED',
        message: 'No patches to stage.'
      });
      this.diagnostics.push(diagnostic);
      this.status = 'failed';
      return { ok: false, diagnostics: [diagnostic] };
    }

    const ops = this.patches.flatMap((patch) => patch.operations);
    const beforeDiagnostics: StructuredDiagnostic[] = [];

    for (const validator of this.validators) {
      if (!validator.validateBeforeStaging) continue;
      for (const patch of this.patches) {
        try {
          const result = await validator.validateBeforeStaging({
            patch,
            operations: patch.operations
          });
          beforeDiagnostics.push(...result.diagnostics);
        } catch (error) {
          beforeDiagnostics.push(phaseFailureDiagnostic(
            'VALIDATOR_BEFORE_STAGING_FAILED',
            'before_staging',
            error,
            { validatorId: validator.validatorId, patchId: patch.patchId }
          ));
        }
      }
    }

    this.diagnostics.push(...beforeDiagnostics);
    if (beforeDiagnostics.some((item) => item.severity === 'error')) {
      this.status = 'failed';
      this.failureRecovery = { phase: 'validateBeforeStaging' };
      this.auditValidation(false, beforeDiagnostics);
      return { ok: false, diagnostics: beforeDiagnostics };
    }

    let staging: ContentAddressedStaging;
    try {
      staging = await createContentAddressedStaging(this.stagingBaseDir);
    } catch (error) {
      const diagnostic = phaseFailureDiagnostic(
        'STAGING_CREATE_FAILED',
        'stage',
        error,
        { transactionId: this.transactionId }
      );
      this.status = 'failed';
      this.failureRecovery = { phase: 'createStaging' };
      this.diagnostics.push(diagnostic);
      this.auditFailure([diagnostic]);
      return { ok: false, diagnostics: [diagnostic] };
    }
    this.staging = staging;
    const workRoot = stagingWorkRoot(staging);
    const stagedPaths: string[] = [];
    const stagedOpTargets: Array<{ op: PatchIrOperation; stagingPath: string }> = [];
    const applyDiagnostics: StructuredDiagnostic[] = [];

    this.auditLog.append(createAuditEntry({
      transactionId: this.transactionId,
      actor: this.actor,
      eventKind: 'staging_created',
      details: { stagingId: staging.stagingId, root: staging.root }
    }));

    // Group operations by writer.
    const byWriter = new Map<string, { writer: WriterAdapterContract; operations: PatchIrOperation[] }>();
    for (const op of ops) {
      const writer = resolveWriterForOperation(op, this.writers);
      const bucket = byWriter.get(writer.writerId) ?? { writer, operations: [] };
      bucket.operations.push(op);
      byWriter.set(writer.writerId, bucket);
    }

    for (const { writer, operations } of byWriter.values()) {
      let result;
      try {
        result = await writer.applyToStaging({
          stagingRoot: workRoot,
          operations,
          workspaceRoot: this.workspaceRoot
        });
      } catch (error) {
        applyDiagnostics.push(phaseFailureDiagnostic(
          'WRITER_STAGING_FAILED',
          'stage',
          error,
          { writerId: writer.writerId, operationIds: operations.map((op) => op.id) }
        ));
        this.status = 'failed';
        this.failureRecovery = { phase: 'applyToStaging', writerId: writer.writerId };
        applyDiagnostics.push(...await this.discardStaging());
        this.diagnostics.push(...applyDiagnostics);
        this.auditFailure(applyDiagnostics);
        return { ok: false, diagnostics: applyDiagnostics };
      }
      applyDiagnostics.push(...result.diagnostics);

      // Prefer explicit writtenTargets; never guess via string includes.
      const targets = result.writtenTargets ?? [];
      const byOpId = new Map(targets.map((item) => [item.opId, item]));

      for (const op of operations) {
        const mapped = byOpId.get(op.id);
        if (!mapped) {
          if (result.ok) {
            applyDiagnostics.push(createDiagnostic({
              severity: 'error',
              code: 'WRITER_TARGET_MAPPING_MISSING',
              message: `Writer ${writer.writerId} did not return an explicit staging mapping for op ${op.id}.`,
              targetUri: op.targetUri,
              details: { writerId: writer.writerId, opId: op.id }
            }));
          }
          continue;
        }
        if (!mapped.stagingPath) {
          applyDiagnostics.push(createDiagnostic({
            severity: 'error',
            code: 'WRITER_STAGING_OUTPUT_MISSING',
            message: `Writer ${writer.writerId} returned empty stagingPath for op ${op.id}.`,
            targetUri: op.targetUri,
            details: { writerId: writer.writerId, opId: op.id }
          }));
          continue;
        }
        stagedPaths.push(mapped.stagingPath);
        stagedOpTargets.push({ op, stagingPath: mapped.stagingPath });
      }

      if (!result.ok || applyDiagnostics.some((item) => item.severity === 'error')) {
        this.status = 'failed';
        this.failureRecovery = { phase: 'applyToStaging', writerId: writer.writerId };
        applyDiagnostics.push(...await this.discardStaging());
        this.diagnostics.push(...applyDiagnostics);
        this.auditFailure(applyDiagnostics);
        return { ok: false, diagnostics: applyDiagnostics };
      }
    }

    // Every successful op must have an explicit staging target.
    for (const op of ops) {
      if (stagedOpTargets.some((item) => item.op.id === op.id)) continue;
      applyDiagnostics.push(createDiagnostic({
        severity: 'error',
        code: 'WRITER_TARGET_MAPPING_MISSING',
        message: `No explicit staging mapping for operation ${op.id}.`,
        targetUri: op.targetUri,
        details: { opId: op.id, kind: op.kind }
      }));
    }
    if (applyDiagnostics.some((item) => item.severity === 'error')) {
      this.status = 'failed';
      this.failureRecovery = { phase: 'applyToStaging', reason: 'missing_mapping' };
      applyDiagnostics.push(...await this.discardStaging());
      this.diagnostics.push(...applyDiagnostics);
      this.auditFailure(applyDiagnostics);
      return { ok: false, diagnostics: applyDiagnostics };
    }

    this.stagedPaths = stagedPaths;
    this.stagedOpTargets = stagedOpTargets;
    this.diagnostics.push(...applyDiagnostics);
    this.status = 'staged';

    this.auditLog.append(createAuditEntry({
      transactionId: this.transactionId,
      actor: this.actor,
      eventKind: 'patch_applied_to_staging',
      affectedResources: this.patches.flatMap((patch) => patch.affectedResources),
      diagnostics: applyDiagnostics,
      details: { stagedPathCount: stagedPaths.length }
    }));

    return { ok: true, stagingRoot: staging.root, diagnostics: applyDiagnostics };
  }

  async validate(): Promise<{ ok: boolean; diagnostics: StructuredDiagnostic[] }> {
    if (this.status !== 'staged' && this.status !== 'validated') {
      const diagnostic = createDiagnostic({
        severity: 'error',
        code: 'TRANSACTION_FAILED',
        message: `Cannot validate in status ${this.status}. Stage first.`
      });
      this.diagnostics.push(diagnostic);
      return { ok: false, diagnostics: [diagnostic] };
    }

    const diagnostics: StructuredDiagnostic[] = [];
    for (const validator of this.validators) {
      if (!validator.validateStagedOutput) continue;
      for (const patch of this.patches) {
        try {
          const result = await validator.validateStagedOutput({
            patch,
            operations: patch.operations,
            stagingRoot: this.staging ? stagingWorkRoot(this.staging) : '',
            stagedPaths: this.stagedPaths
          });
          diagnostics.push(...result.diagnostics);
        } catch (error) {
          diagnostics.push(phaseFailureDiagnostic(
            'VALIDATOR_STAGED_OUTPUT_FAILED',
            'validate',
            error,
            { validatorId: validator.validatorId, patchId: patch.patchId }
          ));
        }
      }
    }

    const ok = diagnostics.every((item) => item.severity !== 'error');
    this.status = ok ? 'validated' : 'failed';
    if (!ok) {
      this.failureRecovery = { phase: 'validateStagedOutput', stagedPaths: this.stagedPaths };
      diagnostics.push(...await this.discardStaging());
    }
    this.diagnostics.push(...diagnostics);
    this.auditValidation(ok, diagnostics);
    if (!ok) this.auditFailure(diagnostics);
    return { ok, diagnostics };
  }

  async commit(): Promise<TransactionCommitResult> {
    if (this.status === 'staged') {
      const validation = await this.validate();
      if (!validation.ok) {
        return {
          ok: false,
          transactionId: this.transactionId,
          committedPaths: [],
          diagnostics: validation.diagnostics
        };
      }
    }

    if (this.status !== 'validated') {
      const diagnostic = createDiagnostic({
        severity: 'error',
        code: 'COMMIT_BLOCKED',
        message: `Cannot commit in status ${this.status}.`
      });
      this.diagnostics.push(diagnostic);
      return {
        ok: false,
        transactionId: this.transactionId,
        committedPaths: [],
        diagnostics: [diagnostic]
      };
    }

    const targets = this.collectCommitTargets();
    for (const target of targets) {
      const boundary = await verifyPathInsideRoot(this.workspaceRoot, target.targetPath);
      if (!boundary.ok) {
        const boundaryDiagnostics = boundary.diagnostics.map((item) => createDiagnostic({
          severity: item.severity,
          code: item.code,
          message: item.message,
          targetUri: target.op.targetUri,
          details: item.details
        }));
        this.status = 'failed';
        this.failureRecovery = { phase: 'commitBoundary' };
        boundaryDiagnostics.push(...await this.discardStaging());
        this.diagnostics.push(...boundaryDiagnostics);
        this.auditFailure(boundaryDiagnostics);
        return {
          ok: false,
          transactionId: this.transactionId,
          committedPaths: [],
          diagnostics: boundaryDiagnostics
        };
      }
    }

    // Final stale-original guard immediately before backup/replace.
    const preCommitHashDiagnostics: StructuredDiagnostic[] = [];
    for (const target of targets) {
      preCommitHashDiagnostics.push(
        ...await checkOriginalContentHash(target.op, 'before_commit')
      );
    }
    if (preCommitHashDiagnostics.some((item) => item.severity === 'error')) {
      this.status = 'failed';
      this.failureRecovery = { phase: 'before_commit_hash_check' };
      preCommitHashDiagnostics.push(...await this.discardStaging());
      this.diagnostics.push(...preCommitHashDiagnostics);
      this.auditFailure(preCommitHashDiagnostics);
      return {
        ok: false,
        transactionId: this.transactionId,
        committedPaths: [],
        diagnostics: preCommitHashDiagnostics
      };
    }

    let restorePoint: RestorePoint;
    try {
      restorePoint = await createRestorePoint({
        sourcePaths: targets.map((item) => item.targetPath),
        ...(this.backupBaseDir !== undefined ? { baseDir: this.backupBaseDir } : {}),
        label: `tx-${this.transactionId}`
      });
    } catch (error) {
      const diagnostic = phaseFailureDiagnostic(
        'BACKUP_CREATE_FAILED',
        'commit',
        error,
        { transactionId: this.transactionId }
      );
      this.status = 'failed';
      this.failureRecovery = { phase: 'backup' };
      const failureDiagnostics = [diagnostic, ...await this.discardStaging()];
      this.diagnostics.push(...failureDiagnostics);
      this.auditFailure(failureDiagnostics);
      return {
        ok: false,
        transactionId: this.transactionId,
        committedPaths: [],
        diagnostics: failureDiagnostics
      };
    }
    this.restorePoint = restorePoint;

    if (this.onRestorePointCreated) {
      try {
        await this.onRestorePointCreated(restorePoint);
      } catch (error) {
        // Nothing has been replaced yet. Restore to the pre-commit state so the
        // workspace is exactly as it was, then fail closed with a durable record.
        const restored = await restoreFromPoint(restorePoint);
        const failureDiagnostics = [
          phaseFailureDiagnostic(
            'RESTORE_POINT_PERSIST_FAILED',
            'commit',
            error,
            { restorePointId: restorePoint.restorePointId }
          )
        ];
        if (!restored.ok) {
          failureDiagnostics.push(createDiagnostic({
            severity: 'error',
            code: 'TRANSACTION_RECOVERY_REQUIRED',
            message: '恢复点持久化失败，且自动还原未能完成。',
            details: { errors: restored.errors }
          }));
        }
        this.status = 'failed';
        this.failureRecovery = {
          phase: 'restorePointPersist',
          restorePointId: restorePoint.restorePointId,
          restoreErrors: restored.errors
        };
        failureDiagnostics.push(...await this.discardStaging());
        this.diagnostics.push(...failureDiagnostics);
        this.auditLog.append(createAuditEntry({
          transactionId: this.transactionId,
          actor: this.actor,
          eventKind: 'failure_recovery',
          diagnostics: failureDiagnostics,
          details: this.failureRecovery
        }));
        return {
          ok: false,
          transactionId: this.transactionId,
          committedPaths: [],
          diagnostics: failureDiagnostics,
          restorePoint,
          ...(restored.ok ? {} : { recoveryRequired: true })
        };
      }
    }

    const committedPaths: string[] = [];
    const diagnostics: StructuredDiagnostic[] = [];

    try {
      for (const target of targets) {
        const boundary = await verifyPathInsideRoot(this.workspaceRoot, target.targetPath);
        if (!boundary.ok) {
          throw new CommitBoundaryError(boundary.diagnostics);
        }
        await mkdir(dirname(target.targetPath), { recursive: true });
        const boundaryAfterMkdir = await verifyPathInsideRoot(this.workspaceRoot, target.targetPath);
        if (!boundaryAfterMkdir.ok) {
          throw new CommitBoundaryError(boundaryAfterMkdir.diagnostics);
        }
        const siblingTemp = join(
          dirname(target.targetPath),
          `.soulforge-${this.transactionId}-${basename(target.targetPath)}.tmp`
        );
        try {
          await copyFile(target.stagingPath, siblingTemp);
          await rename(siblingTemp, target.targetPath);
        } finally {
          await rm(siblingTemp, { force: true }).catch(() => undefined);
        }
        committedPaths.push(target.targetPath);
      }
    } catch (error) {
      // Attempt restore on partial failure.
      const restored = await restoreFromPoint(restorePoint);
      const failureDiagnostics = error instanceof CommitBoundaryError
        ? error.diagnostics
        : [createDiagnostic({
            severity: 'error',
            code: 'TRANSACTION_FAILED',
            message: error instanceof Error ? error.message : 'Commit failed.',
            details: { transactionId: this.transactionId }
          })];
      diagnostics.push(...failureDiagnostics);
      if (!restored.ok) {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'TRANSACTION_RECOVERY_REQUIRED',
          message: '提交中途失败，且自动恢复未能还原所有文件。',
          details: { errors: restored.errors, partialCommitted: committedPaths }
        }));
      }
      this.status = 'failed';
      this.failureRecovery = {
        phase: 'commit',
        restorePointId: restorePoint.restorePointId,
        partialCommitted: committedPaths,
        restoreErrors: restored.errors
      };
      diagnostics.push(...await this.discardStaging());
      this.diagnostics.push(...diagnostics);
      this.auditLog.append(createAuditEntry({
        transactionId: this.transactionId,
        actor: this.actor,
        eventKind: 'failure_recovery',
        diagnostics,
        details: this.failureRecovery
      }));
      return {
        ok: false,
        transactionId: this.transactionId,
        committedPaths: restored.ok ? [] : committedPaths,
        diagnostics,
        restorePoint,
        ...(restored.ok ? {} : { recoveryRequired: true })
      };
    }

    // After-commit validators are the required re-read/re-parse boundary.
    for (const validator of this.validators) {
      if (!validator.validateAfterCommit) continue;
      for (const patch of this.patches) {
        try {
          const result = await validator.validateAfterCommit({
            patch,
            operations: patch.operations,
            committedPaths
          });
          diagnostics.push(...result.diagnostics);
        } catch (error) {
          diagnostics.push(phaseFailureDiagnostic(
            'VALIDATOR_AFTER_COMMIT_FAILED',
            're-read',
            error,
            { validatorId: validator.validatorId, patchId: patch.patchId }
          ));
        }
      }
    }

    if (diagnostics.some((item) => item.severity === 'error')) {
      this.committedPaths = committedPaths;
      this.status = 'committed';
      const rolledBack = await this.rollback();
      const failureDiagnostics = [
        ...diagnostics,
        ...rolledBack.diagnostics,
        createDiagnostic({
          severity: 'error',
          code: rolledBack.ok
            ? 'AFTER_COMMIT_VALIDATION_FAILED_ROLLED_BACK'
            : 'TRANSACTION_RECOVERY_REQUIRED',
          message: rolledBack.ok
            ? '提交后验证失败，已自动还原提交前内容。'
            : '提交后验证失败，且自动还原失败，需要恢复处理。',
          details: {
            transactionId: this.transactionId,
            committedPaths,
            restoredPaths: rolledBack.restoredPaths
          }
        })
      ];
      this.status = 'failed';
      this.failureRecovery = {
        phase: 'after_commit_validation',
        restorePointId: restorePoint.restorePointId,
        committedPaths,
        rollbackOk: rolledBack.ok,
        restoredPaths: rolledBack.restoredPaths
      };
      failureDiagnostics.push(...await this.discardStaging());
      this.diagnostics.push(...failureDiagnostics);
      this.auditFailure(failureDiagnostics);
      return {
        ok: false,
        transactionId: this.transactionId,
        committedPaths: rolledBack.ok ? [] : committedPaths,
        diagnostics: failureDiagnostics,
        restorePoint,
        ...(rolledBack.ok ? {} : { recoveryRequired: true })
      };
    }

    this.committedPaths = committedPaths;
    this.status = 'committed';
    diagnostics.push(...await this.discardStaging());
    this.diagnostics.push(...diagnostics);

    this.auditLog.append(createAuditEntry({
      transactionId: this.transactionId,
      operationId: this.transactionId,
      actor: this.actor,
      eventKind: 'commit',
      ...(this.patches[0]?.patchId ? { patchId: this.patches[0].patchId } : {}),
      affectedResources: this.patches.flatMap((patch) => patch.affectedResources),
      commitResult: { ok: true, committedPaths },
      diagnostics,
      details: { restorePointId: restorePoint.restorePointId }
    }));

    return {
      ok: true,
      transactionId: this.transactionId,
      committedPaths,
      diagnostics,
      restorePoint
    };
  }

  async discardStaging(): Promise<StructuredDiagnostic[]> {
    if (!this.staging) return [];
    try {
      await rm(this.staging.root, { recursive: true, force: true });
      this.staging = undefined;
      this.stagedPaths = [];
      this.stagedOpTargets = [];
      return [];
    } catch (error) {
      return [createDiagnostic({
        severity: 'warning',
        code: 'STAGING_CLEANUP_FAILED',
        message: '暂存目录清理失败。',
        details: {
          transactionId: this.transactionId,
          ...safeErrorDetails(error)
        }
      })];
    }
  }

  async rollback(): Promise<TransactionRollbackResult> {
    if (!this.restorePoint && this.status !== 'committed') {
      const diagnostic = createDiagnostic({
        severity: 'error',
        code: 'ROLLBACK_FAILED',
        message: 'No restore point available to rollback.'
      });
      this.diagnostics.push(diagnostic);
      return {
        ok: false,
        transactionId: this.transactionId,
        restoredPaths: [],
        diagnostics: [diagnostic]
      };
    }

    if (!this.restorePoint) {
      const diagnostic = createDiagnostic({
        severity: 'error',
        code: 'ROLLBACK_FAILED',
        message: 'Missing restore point metadata.'
      });
      return {
        ok: false,
        transactionId: this.transactionId,
        restoredPaths: [],
        diagnostics: [diagnostic]
      };
    }

    // Snapshot pre-rollback state for rollback validation recovery.
    const preRollbackSnapshots: Array<{ path: string; hash: string; bytes: Buffer }> = [];
    for (const file of this.restorePoint.files) {
      try {
        const bytes = await readFile(file.sourcePath);
        preRollbackSnapshots.push({
          path: file.sourcePath,
          hash: createHash('sha256').update(bytes).digest('hex'),
          bytes
        });
      } catch {
        // file may not exist
      }
    }

    const restored = await restoreFromPoint(this.restorePoint);
    const diagnostics: StructuredDiagnostic[] = [];

    if (!restored.ok) {
      // Try to put back pre-rollback bytes.
      for (const snap of preRollbackSnapshots) {
        try {
          await writeFile(snap.path, snap.bytes);
        } catch {
          // ignore
        }
      }
      diagnostics.push(createDiagnostic({
        severity: 'error',
        code: 'ROLLBACK_FAILED',
        message: `Rollback failed: ${restored.errors.join('; ')}`
      }));
      this.status = 'failed';
      this.failureRecovery = {
        phase: 'rollback',
        errors: restored.errors,
        preRollbackHashes: preRollbackSnapshots.map((item) => ({ path: item.path, hash: item.hash }))
      };
      this.auditLog.append(createAuditEntry({
        transactionId: this.transactionId,
        actor: this.actor,
        eventKind: 'failure_recovery',
        diagnostics,
        details: this.failureRecovery
      }));
      return {
        ok: false,
        transactionId: this.transactionId,
        restoredPaths: restored.restoredPaths,
        diagnostics
      };
    }

    // Rollback validation: hashes should match backup beforeHash.
    for (const file of this.restorePoint.files) {
      try {
        const bytes = await readFile(file.sourcePath);
        const hash = createHash('sha256').update(bytes).digest('hex');
        if (hash !== file.beforeHash) {
          diagnostics.push(createDiagnostic({
            severity: 'error',
            code: 'ROLLBACK_FAILED',
            message: 'Rollback validation hash mismatch.',
            details: { path: file.sourcePath, expected: file.beforeHash, actual: hash }
          }));
        }
      } catch (error) {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'ROLLBACK_FAILED',
          message: error instanceof Error ? error.message : 'Rollback validation read failed.',
          details: { path: file.sourcePath }
        }));
      }
    }

    const ok = diagnostics.every((item) => item.severity !== 'error');
    this.status = ok ? 'rolled_back' : 'failed';
    this.diagnostics.push(...diagnostics);

    this.auditLog.append(createAuditEntry({
      transactionId: this.transactionId,
      operationId: this.transactionId,
      actor: this.actor,
      eventKind: 'rollback',
      ...(this.patches[0]?.patchId ? { patchId: this.patches[0].patchId } : {}),
      affectedResources: this.patches.flatMap((patch) => patch.affectedResources),
      rollbackResult: { ok, restoredPaths: restored.restoredPaths },
      diagnostics
    }));

    return {
      ok,
      transactionId: this.transactionId,
      restoredPaths: restored.restoredPaths,
      diagnostics
    };
  }

  private collectCommitTargets(): Array<{ op: PatchIrOperation; targetPath: string; stagingPath: string }> {
    const targets: Array<{ op: PatchIrOperation; targetPath: string; stagingPath: string }> = [];
    for (const item of this.stagedOpTargets) {
      if (!item.op.targetPath) continue;
      targets.push({
        op: item.op,
        targetPath: resolve(item.op.targetPath),
        stagingPath: item.stagingPath
      });
    }
    return targets;
  }

  private auditValidation(ok: boolean, diagnostics: StructuredDiagnostic[]): void {
    this.auditLog.append(createAuditEntry({
      transactionId: this.transactionId,
      actor: this.actor,
      eventKind: 'validation',
      ...(this.patches[0]?.patchId ? { patchId: this.patches[0].patchId } : {}),
      affectedResources: this.patches.flatMap((patch) => patch.affectedResources),
      validationResult: {
        ok,
        retryable: !ok,
        diagnosticCodes: diagnostics.map((item) => String(item.code))
      },
      diagnostics
    }));
  }

  private auditFailure(diagnostics: StructuredDiagnostic[]): void {
    this.auditLog.append(createAuditEntry({
      transactionId: this.transactionId,
      actor: this.actor,
      eventKind: 'failure_recovery',
      affectedResources: this.patches.flatMap((patch) => patch.affectedResources),
      diagnostics,
      ...(this.failureRecovery ? { details: this.failureRecovery } : {})
    }));
  }
}

function phaseFailureDiagnostic(
  code: string,
  phase: string,
  error: unknown,
  details: Record<string, unknown> = {}
): StructuredDiagnostic {
  return createDiagnostic({
    severity: 'error',
    code,
    message: `${phase} 阶段失败。`,
    details: { phase, ...details, ...safeErrorDetails(error) }
  });
}

function safeErrorDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { errorType: typeof error };
  const systemCode = 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
  return {
    errorName: error.name,
    ...(systemCode ? { systemCode } : {})
  };
}

class CommitBoundaryError extends Error {
  constructor(readonly diagnostics: StructuredDiagnostic[]) {
    super('Commit target escaped the workspace boundary.');
  }
}

export function createWorkspaceTransaction(options: WorkspaceTransactionOptions): WorkspaceTransaction {
  return new WorkspaceTransaction(options);
}
