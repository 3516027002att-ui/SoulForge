import type {
  PatchIR,
  PatchIrOperation,
  StructuredDiagnostic,
  ValidatorContract,
  ValidatorResult
} from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';
import { getFileCapabilities } from '../files/fileCapabilities.js';

/**
 * Ensures high-risk packed/native Files Mode writes carry confirmation metadata.
 * Does not implement native writers.
 */
export class FileRiskValidator implements ValidatorContract {
  readonly validatorId = 'file_risk';
  readonly targetResourceKinds = ['*'] as const;
  readonly validationScope = ['before_staging', 'any'] as const;

  validateBeforeStaging(input: {
    patch: PatchIR;
    operations: PatchIrOperation[];
  }): ValidatorResult {
    const diagnostics: StructuredDiagnostic[] = [];
    for (const op of input.operations) {
      if (!op.targetPath) continue;
      const relativePath = op.targetUri.replace(/^file:\/\//, '');
      const caps = getFileCapabilities({
        absolutePath: op.targetPath,
        relativePath
      });

      // v0.6: container_child_replace is handled by ContainerChildReplaceWriter +
      // ContainerRoundTripValidator for synthetic SFBN / DCX DFLT nested only.
      if (op.kind === 'container_child_replace') {
        if (op.metadata?.requiresConfirmation !== true && op.riskLevel !== 'high') {
          diagnostics.push(createDiagnostic({
            severity: 'warning',
            code: 'CONTAINER_REPLACE_CONFIRMATION_RECOMMENDED',
            message: 'container_child_replace should be high risk with confirmation metadata.',
            targetUri: op.targetUri
          }));
        }
        continue;
      }

      if (
        op.kind === 'resource_field_edit'
        || op.kind === 'container_child_add'
        || op.kind === 'container_child_delete'
        || op.kind === 'container_child_rename'
        || op.kind === 'container_child_move'
      ) {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'NATIVE_WRITER_REQUIRED',
          message: 'Structured/container mutations (except container_child_replace) require a native writer (not implemented).',
          targetUri: op.targetUri,
          details: { kind: op.kind, nativeFormatAuthority: false }
        }));
        continue;
      }

      if (
        caps.isPackedOrNative
        && (op.kind === 'file_replace' || op.kind === 'raw_byte_range_edit')
        && op.riskLevel !== 'high'
        && op.riskLevel !== 'blocked'
      ) {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'PACKED_WRITE_RISK_TOO_LOW',
          message: 'Packed/native-like Files Mode writes must be risk=high.',
          targetUri: op.targetUri
        }));
      }

      const requiresConfirmation = op.kind === 'file_replace'
        ? op.requiresConfirmation === true
        : op.metadata?.requiresConfirmation === true;
      if (
        caps.isPackedOrNative
        && (op.kind === 'file_replace' || op.kind === 'raw_byte_range_edit')
        && !requiresConfirmation
        && op.riskLevel === 'high'
      ) {
        diagnostics.push(createDiagnostic({
          severity: 'warning',
          code: 'PACKED_WRITE_CONFIRMATION_RECOMMENDED',
          message: 'Packed/native whole-file/raw write should carry requiresConfirmation metadata.',
          targetUri: op.targetUri
        }));
      }
    }
    return {
      ok: diagnostics.every((d) => d.severity !== 'error'),
      diagnostics,
      scope: 'before_staging',
      validatorId: this.validatorId
    };
  }
}

export class WorkspaceBoundaryValidator implements ValidatorContract {
  readonly validatorId = 'workspace_boundary';
  readonly targetResourceKinds = ['*'] as const;
  readonly validationScope = ['before_staging'] as const;

  validateBeforeStaging(input: {
    patch: PatchIR;
    operations: PatchIrOperation[];
  }): ValidatorResult {
    const diagnostics: StructuredDiagnostic[] = [];
    for (const op of input.operations) {
      if (!op.targetPath) {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'PATCH_OP_MISSING_TARGET',
          message: 'Operation missing targetPath.',
          targetUri: op.targetUri
        }));
      }
    }
    return {
      ok: diagnostics.every((d) => d.severity !== 'error'),
      diagnostics,
      scope: 'before_staging',
      validatorId: this.validatorId
    };
  }
}

export class WholeFileReplaceValidator implements ValidatorContract {
  readonly validatorId = 'whole_file_replace';
  readonly targetResourceKinds = ['*'] as const;
  readonly validationScope = ['before_staging', 'staged_output'] as const;

  validateBeforeStaging(input: {
    patch: PatchIR;
    operations: PatchIrOperation[];
  }): ValidatorResult {
    const diagnostics: StructuredDiagnostic[] = [];
    for (const op of input.operations) {
      if (op.kind !== 'file_replace') continue;
      if (op.newText === undefined && op.newContentBase64 === undefined) {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'FILE_REPLACE_EMPTY',
          message: 'file_replace requires newText or newContentBase64.',
          targetUri: op.targetUri
        }));
      }
      if (!op.expectedHash && !op.allowCreateNewFile) {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'FILE_REPLACE_HASH_REQUIRED',
          message: 'Existing file replace requires expectedHash (or allowCreateNewFile for new files).',
          targetUri: op.targetUri
        }));
      }
      if (
        typeof op.newText === 'string'
        && op.newText.length === 0
        && !op.allowEmpty
      ) {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'FILE_REPLACE_EMPTY_OUTPUT',
          message: 'Empty file replace blocked unless allowEmpty=true.',
          targetUri: op.targetUri
        }));
      }
    }
    return {
      ok: diagnostics.every((d) => d.severity !== 'error'),
      diagnostics,
      scope: 'before_staging',
      validatorId: this.validatorId
    };
  }
}
