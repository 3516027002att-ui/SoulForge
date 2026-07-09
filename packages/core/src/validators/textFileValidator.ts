import { readFile } from 'node:fs/promises';
import type {
  PatchIR,
  PatchIrOperation,
  ValidatorContract,
  ValidatorResult
} from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';

export class TextFileValidator implements ValidatorContract {
  readonly validatorId = 'text_file';
  readonly targetResourceKinds = ['*'] as const;
  readonly validationScope = ['before_staging', 'staged_output', 'after_commit'] as const;

  validateBeforeStaging(input: {
    patch: PatchIR;
    operations: PatchIrOperation[];
  }): ValidatorResult {
    const diagnostics = [];
    for (const op of input.operations) {
      if (op.kind !== 'text_edit' && op.kind !== 'file_replace') continue;
      if (op.kind === 'text_edit' && typeof op.newText !== 'string') {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'VALIDATOR_FAILED',
          message: 'text_edit newText must be a string.',
          targetUri: op.targetUri
        }));
      }
      if (op.kind === 'text_edit' && op.newText.length === 0 && !op.allowEmpty) {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'STAGING_INVALID',
          message: 'Empty text output is not allowed unless allowEmpty=true.',
          targetUri: op.targetUri
        }));
      }
    }
    return {
      ok: diagnostics.every((item) => item.severity !== 'error'),
      diagnostics,
      scope: 'before_staging',
      validatorId: this.validatorId
    };
  }

  async validateStagedOutput(input: {
    patch: PatchIR;
    operations: PatchIrOperation[];
    stagingRoot: string;
    stagedPaths: string[];
  }): Promise<ValidatorResult> {
    const diagnostics = [];
    for (const path of input.stagedPaths) {
      try {
        const content = await readFile(path);
        // Reject NULs as a cheap binary guard for text staging.
        if (content.includes(0)) {
          diagnostics.push(createDiagnostic({
            severity: 'error',
            code: 'VALIDATOR_FAILED',
            message: 'Staged text output contains NUL bytes.',
            details: { path }
          }));
        }
      } catch (error) {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'STAGED_FILE_MISSING',
          message: error instanceof Error ? error.message : 'Staged path unreadable.',
          details: { path }
        }));
      }
    }
    return {
      ok: diagnostics.every((item) => item.severity !== 'error'),
      diagnostics,
      scope: 'staged_output',
      validatorId: this.validatorId
    };
  }

  async validateAfterCommit(input: {
    patch: PatchIR;
    operations: PatchIrOperation[];
    committedPaths: string[];
  }): Promise<ValidatorResult> {
    const diagnostics = [];
    for (const path of input.committedPaths) {
      try {
        await readFile(path);
      } catch (error) {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'VALIDATOR_FAILED',
          message: error instanceof Error ? error.message : 'Committed path unreadable.',
          details: { path }
        }));
      }
    }
    return {
      ok: diagnostics.every((item) => item.severity !== 'error'),
      diagnostics,
      scope: 'after_commit',
      validatorId: this.validatorId
    };
  }
}
