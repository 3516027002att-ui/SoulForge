/**
 * WorkspaceTransaction scaffold:
 * create -> add PatchIR -> stage -> validate -> commit -> audit -> rollback
 *
 * Only operates on sandbox / temp workspace paths passed in by callers.
 * Never writes outside the provided workspace root.
 */

import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type {
  AuditActor,
  AuditLogStore,
  PatchIR,
  PatchIrOperation,
  StructuredDiagnostic,
  ValidationScope,
  ValidatorContract,
  ValidatorResult,
  WriterAdapterContract,
  WriterApplyResult,
  WriterPostValidateResult,
  WriterWrittenTarget
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

  /** Writer instances used by this transaction; needed for pre-commit inverse capture. */
  getWriterAdapters(): readonly WriterAdapterContract[] {
    return this.writers;
  }

  /** Explicit op → staging mappings produced by writers. */
  getStagedOperationTargets(): readonly {
    op: PatchIrOperation;
    stagingPath: string;
  }[] {
    return this.stagedOpTargets;
  }

  addPatch(patch: PatchIR): { ok: boolean; diagnostics: StructuredDiagnostic[] } {
    if (this.status !== 'open' && this.status !== 'staged' && this.status !== 'validated') {
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

    const validatorDiagnostics = validateRequiredValidatorRegistry(patch, this.validators);
    this.diagnostics.push(...validatorDiagnostics);
    if (validatorDiagnostics.some((item) => item.severity === 'error')) {
      this.status = 'failed';
      this.failureRecovery = { phase: 'addPatch', patchId: patch.patchId, reason: 'validator_registry' };
      return {
        ok: false,
        diagnostics: [...validation.diagnostics, ...validatorDiagnostics]
      };
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
    // Adding a new patch invalidates prior staging.
    this.status = 'open';
    this.staging = undefined;
    this.stagedPaths = [];
    this.stagedOpTargets = [];
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
        beforeDiagnostics.push(...await invokeValidator({
          validator,
          patch,
          scope: 'before_staging',
          invoke: () => validator.validateBeforeStaging!({
            patch,
            operations: patch.operations
          })
        }));
      }
    }

    this.diagnostics.push(...beforeDiagnostics);
    if (beforeDiagnostics.some((item) => item.severity === 'error')) {
      this.status = 'failed';
      this.failureRecovery = { phase: 'validateBeforeStaging' };
      this.auditValidation(false, beforeDiagnostics);
      return { ok: false, diagnostics: beforeDiagnostics };
    }

    const writerContractDiagnostics = validateWriterPostValidationAvailability(ops, this.writers);
    this.diagnostics.push(...writerContractDiagnostics);
    if (writerContractDiagnostics.some((item) => item.severity === 'error')) {
      this.status = 'failed';
      this.failureRecovery = { phase: 'writerContract', reason: 'post_validate_unavailable' };
      return { ok: false, diagnostics: writerContractDiagnostics };
    }

    const staging = await createContentAddressedStaging(this.stagingBaseDir);
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
      let result: WriterApplyResult;
      try {
        result = await writer.applyToStaging({
          stagingRoot: workRoot,
          operations,
          workspaceRoot: this.workspaceRoot
        });
      } catch (error) {
        const diagnostic = createDiagnostic({
          severity: 'error',
          code: 'WRITER_APPLY_EXECUTION_FAILED',
          message: `writer ${writer.writerId} 执行 applyToStaging 失败。`,
          details: {
            writerId: writer.writerId,
            errorType: error instanceof Error ? error.name : 'unknown'
          }
        });
        applyDiagnostics.push(diagnostic);
        this.status = 'failed';
        this.failureRecovery = { phase: 'applyToStaging', writerId: writer.writerId };
        this.diagnostics.push(...applyDiagnostics);
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

      if (!result.ok && !result.diagnostics.some((item) => item.severity === 'error')) {
        applyDiagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'WRITER_APPLY_REPORTED_FAILURE',
          message: `writer ${writer.writerId} 报告 applyToStaging 失败但未提供错误诊断。`,
          details: { writerId: writer.writerId }
        }));
      }
      if (!result.ok || applyDiagnostics.some((item) => item.severity === 'error')) {
        this.status = 'failed';
        this.failureRecovery = { phase: 'applyToStaging', writerId: writer.writerId };
        this.diagnostics.push(...applyDiagnostics);
        return { ok: false, diagnostics: applyDiagnostics };
      }

      const requiredPostValidateOperations = operations.filter(requiresWriterPostValidation);
      if (requiredPostValidateOperations.length > 0) {
        const postDiagnostics = await invokeWriterPostValidate({
          writer,
          operations,
          requiredOperations: requiredPostValidateOperations,
          stagingRoot: workRoot,
          writtenTargets: targets
        });
        applyDiagnostics.push(...postDiagnostics);
        if (postDiagnostics.some((item) => item.severity === 'error')) {
          this.status = 'failed';
          this.failureRecovery = { phase: 'writerPostValidate', writerId: writer.writerId };
          this.diagnostics.push(...applyDiagnostics);
          return { ok: false, diagnostics: applyDiagnostics };
        }
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
      this.diagnostics.push(...applyDiagnostics);
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
        diagnostics.push(...await invokeValidator({
          validator,
          patch,
          scope: 'staged_output',
          invoke: () => validator.validateStagedOutput!({
            patch,
            operations: patch.operations,
            stagingRoot: this.staging ? stagingWorkRoot(this.staging) : '',
            stagedPaths: this.stagedPaths
          })
        }));
      }
    }

    this.diagnostics.push(...diagnostics);
    const ok = diagnostics.every((item) => item.severity !== 'error');
    this.status = ok ? 'validated' : 'failed';
    if (!ok) this.failureRecovery = { phase: 'validateStagedOutput', stagedPaths: this.stagedPaths };
    this.auditValidation(ok, diagnostics);
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
        this.diagnostics.push(...boundaryDiagnostics);
        this.status = 'failed';
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
      this.diagnostics.push(...preCommitHashDiagnostics);
      this.failureRecovery = { phase: 'before_commit_hash_check' };
      return {
        ok: false,
        transactionId: this.transactionId,
        committedPaths: [],
        diagnostics: preCommitHashDiagnostics
      };
    }

    const restorePoint = await createRestorePoint({
      sourcePaths: targets.map((item) => item.targetPath),
      ...(this.backupBaseDir !== undefined ? { baseDir: this.backupBaseDir } : {}),
      label: `tx-${this.transactionId}`
    });
    this.restorePoint = restorePoint;

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
      this.diagnostics.push(...diagnostics);
      this.status = 'failed';
      this.failureRecovery = {
        phase: 'commit',
        restorePointId: restorePoint.restorePointId,
        partialCommitted: committedPaths,
        restoreErrors: restored.errors
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
        committedPaths: restored.ok ? [] : committedPaths,
        diagnostics,
        restorePoint,
        ...(restored.ok ? {} : { recoveryRequired: true })
      };
    }

    // After-commit validators
    for (const validator of this.validators) {
      if (!validator.validateAfterCommit) continue;
      for (const patch of this.patches) {
        diagnostics.push(...await invokeValidator({
          validator,
          patch,
          scope: 'after_commit',
          invoke: () => validator.validateAfterCommit!({
            patch,
            operations: patch.operations,
            committedPaths
          })
        }));
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
      this.diagnostics.push(...failureDiagnostics);
      this.status = 'failed';
      this.failureRecovery = {
        phase: 'after_commit_validation',
        restorePointId: restorePoint.restorePointId,
        committedPaths,
        rollbackOk: rolledBack.ok,
        restoredPaths: rolledBack.restoredPaths
      };
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
      // Relative targetPath is workspace-relative (overlay root), not process-cwd.
      // Absolute paths still pass through resolve() for normalization.
      const absoluteTarget = isAbsolute(item.op.targetPath)
        ? resolve(item.op.targetPath)
        : resolve(this.workspaceRoot, item.op.targetPath);
      targets.push({
        op: item.op,
        targetPath: absoluteTarget,
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
}

class CommitBoundaryError extends Error {
  constructor(readonly diagnostics: StructuredDiagnostic[]) {
    super('Commit target escaped the workspace boundary.');
  }
}

type TransactionValidationScope = Extract<
  ValidationScope,
  'before_staging' | 'staged_output' | 'after_commit'
>;

function validateWriterPostValidationAvailability(
  operations: readonly PatchIrOperation[],
  writers: readonly WriterAdapterContract[]
): StructuredDiagnostic[] {
  const diagnostics: StructuredDiagnostic[] = [];
  for (const operation of operations.filter(requiresWriterPostValidation)) {
    const writer = resolveWriterForOperation(operation, writers);
    if (writer.writerId !== 'writer:unsupported' && typeof writer.postValidate === 'function') {
      continue;
    }
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'WRITER_POST_VALIDATE_REQUIRED',
      message: '原生结构化 operation 的 writer 必须实现 staged postValidate。',
      targetUri: operation.targetUri,
      details: { operationId: operation.id, kind: operation.kind, writerId: writer.writerId }
    }));
  }
  return diagnostics;
}

async function invokeWriterPostValidate(input: {
  writer: WriterAdapterContract;
  operations: PatchIrOperation[];
  requiredOperations: PatchIrOperation[];
  stagingRoot: string;
  writtenTargets: WriterWrittenTarget[];
}): Promise<StructuredDiagnostic[]> {
  let rawResult: WriterPostValidateResult;
  try {
    rawResult = await input.writer.postValidate!({
      stagingRoot: input.stagingRoot,
      operations: input.operations,
      writtenTargets: input.writtenTargets
    });
  } catch (error) {
    return [createDiagnostic({
      severity: 'error',
      code: 'WRITER_POST_VALIDATE_EXECUTION_FAILED',
      message: `writer ${input.writer.writerId} 执行 postValidate 失败。`,
      details: {
        writerId: input.writer.writerId,
        errorType: error instanceof Error ? error.name : 'unknown'
      }
    })];
  }

  const result = rawResult as Partial<WriterPostValidateResult> | null | undefined;
  if (!result || typeof result !== 'object') {
    return [createDiagnostic({
      severity: 'error',
      code: 'WRITER_POST_VALIDATE_RESULT_INVALID',
      message: `writer ${input.writer.writerId} 返回了无效 postValidate 结果。`,
      details: { writerId: input.writer.writerId }
    })];
  }
  const diagnosticsValid = Array.isArray(result.diagnostics)
    && result.diagnostics.every(isStructuredDiagnostic);
  const suppliedDiagnostics = diagnosticsValid ? result.diagnostics! : [];
  const diagnostics: StructuredDiagnostic[] = [...suppliedDiagnostics];
  if (!diagnosticsValid || typeof result.ok !== 'boolean') {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'WRITER_POST_VALIDATE_RESULT_INVALID',
      message: `writer ${input.writer.writerId} 的 postValidate ok/diagnostics 结构无效。`,
      details: { writerId: input.writer.writerId }
    }));
  }
  if (result.writerId !== input.writer.writerId) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'WRITER_POST_VALIDATE_IDENTITY_INVALID',
      message: `writer ${input.writer.writerId} 返回的 postValidate 身份与实际实例不一致。`,
      details: {
        expectedWriterId: input.writer.writerId,
        actualWriterId: result.writerId ?? null
      }
    }));
  }
  if (result.ok === false && !suppliedDiagnostics.some((item) => item.severity === 'error')) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'WRITER_POST_VALIDATE_REPORTED_FAILURE',
      message: `writer ${input.writer.writerId} 报告 postValidate 失败但未提供错误诊断。`,
      details: { writerId: input.writer.writerId }
    }));
  }

  const coverage = result.validatedOperationIds;
  const coverageValid = Array.isArray(coverage)
    && coverage.every((operationId) => typeof operationId === 'string' && operationId.length > 0);
  if (!coverageValid) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'WRITER_POST_VALIDATE_COVERAGE_INVALID',
      message: `writer ${input.writer.writerId} 未返回有效的 postValidate operation coverage。`,
      details: { writerId: input.writer.writerId }
    }));
  } else {
    const operationIds = new Set(input.operations.map((operation) => operation.id));
    const duplicateIds = coverage.filter((operationId, index) => coverage.indexOf(operationId) !== index);
    const unknownIds = coverage.filter((operationId) => !operationIds.has(operationId));
    if (duplicateIds.length > 0 || unknownIds.length > 0) {
      diagnostics.push(createDiagnostic({
        severity: 'error',
        code: 'WRITER_POST_VALIDATE_COVERAGE_INVALID',
        message: `writer ${input.writer.writerId} 返回了重复或未知的 postValidate operation ID。`,
        details: {
          writerId: input.writer.writerId,
          duplicateOperationIds: [...new Set(duplicateIds)],
          unknownOperationIds: [...new Set(unknownIds)]
        }
      }));
    }
  }
  const covered = coverageValid ? new Set(coverage) : new Set<string>();
  const missingOperationIds = input.requiredOperations
    .map((operation) => operation.id)
    .filter((operationId) => !covered.has(operationId));
  if (missingOperationIds.length > 0) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'WRITER_POST_VALIDATE_COVERAGE_INCOMPLETE',
      message: `writer ${input.writer.writerId} 未证明覆盖全部原生结构化 operation。`,
      details: { writerId: input.writer.writerId, missingOperationIds }
    }));
  }
  return diagnostics;
}

function requiresWriterPostValidation(operation: PatchIrOperation): boolean {
  if (operation.kind.startsWith('resource_') || operation.kind === 'asset_import_replace') {
    return true;
  }
  return operation.kind.startsWith('container_child_')
    && 'containerFormat' in operation
    && operation.containerFormat === 'BND4_DFLT'
    && operation.metadata?.nativeFormatAuthority === true;
}

function validateRequiredValidatorRegistry(
  patch: PatchIR,
  validators: readonly ValidatorContract[]
): StructuredDiagnostic[] {
  const diagnostics: StructuredDiagnostic[] = [];
  const registry = new Map<string, ValidatorContract[]>();
  for (const validator of validators) {
    const bucket = registry.get(validator.validatorId) ?? [];
    bucket.push(validator);
    registry.set(validator.validatorId, bucket);
  }

  for (const [validatorId, matches] of registry) {
    if (matches.length <= 1) continue;
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'VALIDATOR_REGISTRY_ID_DUPLICATE',
      message: `validatorId ${validatorId} 在事务注册表中不唯一。`,
      details: { validatorId, registeredCount: matches.length }
    }));
  }

  for (const operation of patch.operations) {
    for (const requirement of operation.validatorRequirements) {
      if (!requirement.required || requirement.scope === 'any') continue;
      const scope = requirement.scope as TransactionValidationScope;
      const matches = registry.get(requirement.validatorId) ?? [];
      if (matches.length === 0) {
        diagnostics.push(requiredValidatorDiagnostic(
          operation,
          requirement.validatorId,
          scope,
          'REQUIRED_VALIDATOR_NOT_REGISTERED',
          `必需 validator ${requirement.validatorId} 未注册。`
        ));
        continue;
      }
      if (matches.length > 1) continue;
      const validator = matches[0]!;
      if (!validator.validationScope.includes(scope)
        && !validator.validationScope.includes('any')) {
        diagnostics.push(requiredValidatorDiagnostic(
          operation,
          requirement.validatorId,
          scope,
          'REQUIRED_VALIDATOR_SCOPE_UNSUPPORTED',
          `必需 validator ${requirement.validatorId} 未声明支持阶段 ${scope}。`
        ));
      }
      if (!hasValidatorMethod(validator, scope)) {
        diagnostics.push(requiredValidatorDiagnostic(
          operation,
          requirement.validatorId,
          scope,
          'REQUIRED_VALIDATOR_METHOD_MISSING',
          `必需 validator ${requirement.validatorId} 未实现阶段 ${scope} 的执行方法。`
        ));
      }
    }
  }
  return diagnostics;
}

function hasValidatorMethod(
  validator: ValidatorContract,
  scope: TransactionValidationScope
): boolean {
  if (scope === 'before_staging') return typeof validator.validateBeforeStaging === 'function';
  if (scope === 'staged_output') return typeof validator.validateStagedOutput === 'function';
  return typeof validator.validateAfterCommit === 'function';
}

async function invokeValidator(input: {
  validator: ValidatorContract;
  patch: PatchIR;
  scope: TransactionValidationScope;
  invoke: () => Promise<ValidatorResult> | ValidatorResult;
}): Promise<StructuredDiagnostic[]> {
  let result: ValidatorResult;
  try {
    result = await input.invoke();
  } catch (error) {
    return [createDiagnostic({
      severity: 'error',
      code: 'VALIDATOR_EXECUTION_FAILED',
      message: `validator ${input.validator.validatorId} 在阶段 ${input.scope} 执行失败。`,
      details: {
        validatorId: input.validator.validatorId,
        scope: input.scope,
        errorType: error instanceof Error ? error.name : 'unknown'
      }
    })];
  }
  return validateValidatorResult({
    validator: input.validator,
    patch: input.patch,
    scope: input.scope,
    result
  });
}

function validateValidatorResult(input: {
  validator: ValidatorContract;
  patch: PatchIR;
  scope: TransactionValidationScope;
  result: ValidatorResult;
}): StructuredDiagnostic[] {
  const result = input.result as Partial<ValidatorResult> | null | undefined;
  if (!result || typeof result !== 'object') {
    return [createDiagnostic({
      severity: 'error',
      code: 'VALIDATOR_RESULT_INVALID',
      message: `validator ${input.validator.validatorId} 返回了无效结果。`,
      details: { validatorId: input.validator.validatorId, scope: input.scope }
    })];
  }

  const diagnosticsValid = Array.isArray(result.diagnostics)
    && result.diagnostics.every(isStructuredDiagnostic);
  const suppliedDiagnostics = diagnosticsValid ? result.diagnostics! : [];
  const diagnostics: StructuredDiagnostic[] = [...suppliedDiagnostics];
  if (!diagnosticsValid || typeof result.ok !== 'boolean') {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'VALIDATOR_RESULT_INVALID',
      message: `validator ${input.validator.validatorId} 的 ok/diagnostics 结果结构无效。`,
      details: { validatorId: input.validator.validatorId, scope: input.scope }
    }));
  }
  if (result.validatorId !== input.validator.validatorId || result.scope !== input.scope) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'VALIDATOR_RESULT_IDENTITY_INVALID',
      message: `validator ${input.validator.validatorId} 返回的身份或阶段与实际调用不一致。`,
      details: {
        expectedValidatorId: input.validator.validatorId,
        actualValidatorId: result.validatorId ?? null,
        expectedScope: input.scope,
        actualScope: result.scope ?? null
      }
    }));
  }
  if (result.ok === false
    && !suppliedDiagnostics.some((item) => item.severity === 'error')) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'VALIDATOR_REPORTED_FAILURE',
      message: `validator ${input.validator.validatorId} 报告失败但未提供错误诊断。`,
      details: { validatorId: input.validator.validatorId, scope: input.scope }
    }));
  }

  const requiredOperationIds = input.patch.operations
    .filter((operation) => operation.validatorRequirements.some((requirement) =>
      requirement.required
      && requirement.validatorId === input.validator.validatorId
      && requirement.scope === input.scope))
    .map((operation) => operation.id);
  const coverage = result.validatedOperationIds;
  const coverageValid = coverage === undefined || (
    Array.isArray(coverage)
    && coverage.every((operationId) => typeof operationId === 'string' && operationId.length > 0)
  );
  if (!coverageValid) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'VALIDATOR_COVERAGE_INVALID',
      message: `validator ${input.validator.validatorId} 返回的 operation 覆盖证据结构无效。`,
      details: { validatorId: input.validator.validatorId, scope: input.scope }
    }));
  } else if (coverage !== undefined) {
    const patchOperationIds = new Set(input.patch.operations.map((operation) => operation.id));
    const duplicateIds = coverage.filter((operationId, index) => coverage.indexOf(operationId) !== index);
    const unknownIds = coverage.filter((operationId) => !patchOperationIds.has(operationId));
    if (duplicateIds.length > 0 || unknownIds.length > 0) {
      diagnostics.push(createDiagnostic({
        severity: 'error',
        code: 'VALIDATOR_COVERAGE_INVALID',
        message: `validator ${input.validator.validatorId} 返回了重复或不属于当前 PatchIR 的 operation ID。`,
        details: {
          validatorId: input.validator.validatorId,
          scope: input.scope,
          duplicateOperationIds: [...new Set(duplicateIds)],
          unknownOperationIds: [...new Set(unknownIds)]
        }
      }));
    }
  }

  const covered = coverageValid && coverage !== undefined ? new Set(coverage) : new Set<string>();
  const missingOperationIds = requiredOperationIds.filter((operationId) => !covered.has(operationId));
  if (missingOperationIds.length > 0) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'REQUIRED_VALIDATOR_COVERAGE_INCOMPLETE',
      message: `必需 validator ${input.validator.validatorId} 未证明覆盖全部声明的 operation。`,
      details: {
        validatorId: input.validator.validatorId,
        scope: input.scope,
        missingOperationIds
      }
    }));
  }
  return diagnostics;
}

function isStructuredDiagnostic(value: unknown): value is StructuredDiagnostic {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StructuredDiagnostic>;
  return ['info', 'warning', 'error'].includes(String(candidate.severity))
    && typeof candidate.code === 'string'
    && candidate.code.length > 0
    && typeof candidate.message === 'string'
    && candidate.message.length > 0;
}

function requiredValidatorDiagnostic(
  operation: PatchIrOperation,
  validatorId: string,
  scope: TransactionValidationScope,
  code: string,
  message: string
): StructuredDiagnostic {
  return createDiagnostic({
    severity: 'error',
    code,
    message,
    targetUri: operation.targetUri,
    details: { operationId: operation.id, validatorId, scope }
  });
}

export function createWorkspaceTransaction(options: WorkspaceTransactionOptions): WorkspaceTransaction {
  return new WorkspaceTransaction(options);
}
