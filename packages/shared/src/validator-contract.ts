/**
 * Validator contract surface (architecture fork #109).
 */

import type { StructuredDiagnostic } from './diagnostics.js';
import type { PatchIR, PatchIrOperation } from './patch-ir.js';
import type { ResourceKind } from './types.js';

export type ValidationScope =
  | 'before_staging'
  | 'staged_output'
  | 'after_commit'
  | 'rollback'
  | 'any';

export interface ValidatorResult {
  ok: boolean;
  diagnostics: StructuredDiagnostic[];
  scope: ValidationScope;
  validatorId: string;
}

export interface ValidatorContract {
  readonly validatorId: string;
  readonly targetResourceKinds: readonly ResourceKind[] | readonly ['*'];
  readonly validationScope: readonly ValidationScope[];

  validateBeforeStaging?(input: {
    patch: PatchIR;
    operations: PatchIrOperation[];
  }): Promise<ValidatorResult> | ValidatorResult;

  validateStagedOutput?(input: {
    patch: PatchIR;
    operations: PatchIrOperation[];
    stagingRoot: string;
    stagedPaths: string[];
  }): Promise<ValidatorResult> | ValidatorResult;

  validateAfterCommit?(input: {
    patch: PatchIR;
    operations: PatchIrOperation[];
    committedPaths: string[];
  }): Promise<ValidatorResult> | ValidatorResult;

  validateRollback?(input: {
    patchId: string;
    restoredPaths: string[];
  }): Promise<ValidatorResult> | ValidatorResult;
}
