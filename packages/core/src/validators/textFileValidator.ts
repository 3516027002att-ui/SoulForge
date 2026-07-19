import { readFile } from 'node:fs/promises';
import type {
  PatchIR,
  PatchIrOperation,
  StructuredDiagnostic,
  ValidatorContract,
  ValidatorResult
} from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';
import { checkOriginalContentHash } from './textHash.js';

// TEXT_EDIT_HASH_REQUIRED is intentionally NOT forced here for low-level ops.
// Production saveTextResource always supplies beforeHash → expectedHash.

export class TextFileValidator implements ValidatorContract {
  readonly validatorId = 'text_file';
  readonly targetResourceKinds = ['*'] as const;
  readonly validationScope = ['before_staging', 'staged_output', 'after_commit'] as const;

  async validateBeforeStaging(input: {
    patch: PatchIR;
    operations: PatchIrOperation[];
  }): Promise<ValidatorResult> {
    const diagnostics: StructuredDiagnostic[] = [];
    const validatedOperationIds: string[] = [];
    for (const op of input.operations) {
      if (op.kind !== 'text_edit' && op.kind !== 'file_replace') continue;
      validatedOperationIds.push(op.id);
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
      diagnostics.push(...await checkOriginalContentHash(op, 'before_staging'));
    }
    return {
      ok: diagnostics.every((item) => item.severity !== 'error'),
      diagnostics,
      scope: 'before_staging',
      validatorId: this.validatorId,
      validatedOperationIds
    };
  }

  async validateStagedOutput(input: {
    patch: PatchIR;
    operations: PatchIrOperation[];
    stagingRoot: string;
    stagedPaths: string[];
  }): Promise<ValidatorResult> {
    const diagnostics: StructuredDiagnostic[] = [];
    const validatedOperationIds = input.operations
      .filter((op) => op.kind === 'text_edit' || op.kind === 'file_replace')
      .map((op) => op.id);

    // Concurrent edit protection: original must still match expectedHash.
    for (const op of input.operations) {
      if (op.kind !== 'text_edit' && op.kind !== 'file_replace') continue;
      diagnostics.push(...await checkOriginalContentHash(op, 'staged_output'));
    }

    const textOps = input.operations.filter(
      (op) => op.kind === 'text_edit'
        || (op.kind === 'file_replace' && typeof op.newText === 'string')
    );
    // Only enforce text NUL guard for text payloads (not binary base64 replaces).
    if (textOps.length === 0) {
      return {
        ok: diagnostics.every((item) => item.severity !== 'error'),
        diagnostics,
        scope: 'staged_output',
        validatorId: this.validatorId,
        validatedOperationIds
      };
    }

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
      validatorId: this.validatorId,
      validatedOperationIds
    };
  }

  async validateAfterCommit(input: {
    patch: PatchIR;
    operations: PatchIrOperation[];
    committedPaths: string[];
  }): Promise<ValidatorResult> {
    const diagnostics: StructuredDiagnostic[] = [];
    const validatedOperationIds = input.operations
      .filter((op) => op.kind === 'text_edit' || op.kind === 'file_replace')
      .map((op) => op.id);
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
      validatorId: this.validatorId,
      validatedOperationIds
    };
  }
}
