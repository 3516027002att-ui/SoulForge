import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  PatchIR,
  PatchIrOperation,
  ValidatorContract,
  ValidatorResult
} from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';

export class RawFileValidator implements ValidatorContract {
  readonly validatorId = 'raw_file';
  readonly targetResourceKinds = ['*'] as const;
  readonly validationScope = ['before_staging', 'staged_output'] as const;

  async validateBeforeStaging(input: {
    patch: PatchIR;
    operations: PatchIrOperation[];
  }): Promise<ValidatorResult> {
    const diagnostics = [];
    for (const op of input.operations) {
      if (op.kind !== 'raw_byte_range_edit') continue;
      if (!op.expectedHash) {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'HASH_MISMATCH',
          message: 'raw_byte_range_edit requires expectedHash.',
          targetUri: op.targetUri
        }));
        continue;
      }
      if (!op.targetPath) {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'PRECONDITION_FAILED',
          message: 'raw_byte_range_edit requires targetPath.',
          targetUri: op.targetUri
        }));
        continue;
      }
      try {
        const bytes = await readFile(op.targetPath);
        const hash = createHash('sha256').update(bytes).digest('hex');
        if (hash !== op.expectedHash) {
          diagnostics.push(createDiagnostic({
            severity: 'error',
            code: 'HASH_MISMATCH',
            message: 'Content hash precondition failed before staging.',
            targetUri: op.targetUri,
            details: { expected: op.expectedHash, actual: hash }
          }));
        }
      } catch (error) {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'PRECONDITION_FAILED',
          message: error instanceof Error ? error.message : 'Failed to read target for hash check.',
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
        const bytes = await readFile(path);
        if (bytes.length === 0) {
          diagnostics.push(createDiagnostic({
            severity: 'warning',
            code: 'STAGING_INVALID',
            message: 'Staged raw output is empty.',
            details: { path }
          }));
        }
      } catch (error) {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'STAGED_FILE_MISSING',
          message: error instanceof Error ? error.message : 'Staged raw path unreadable.',
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
}
