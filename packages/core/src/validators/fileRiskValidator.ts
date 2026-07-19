import { readFile } from 'node:fs/promises';
import type {
  PatchIR,
  PatchIrOperation,
  StructuredDiagnostic,
  ValidatorContract,
  ValidatorResult
} from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';
import { isEmevdSemanticOperation } from '../editing/emevdSemanticContract.js';
import { isParamFieldSemanticOperation } from '../editing/paramSemanticContract.js';
import { isMsbPositionFieldOperation } from '../editing/msbSemanticContract.js';
import { isFmgSemanticOperation } from '../editing/fmgSemanticContract.js';
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
        || op.kind === 'resource_node_add'
        || op.kind === 'resource_node_delete'
        || op.kind === 'resource_node_reorder'
        || op.kind === 'container_child_add'
        || op.kind === 'container_child_delete'
        || op.kind === 'container_child_rename'
        || op.kind === 'container_child_move'
      ) {
        const registeredNativeSemantic = (
          (op.kind === 'resource_field_edit'
            && (isParamFieldSemanticOperation(op)
              || isMsbPositionFieldOperation(op)))
          || isEmevdSemanticOperation(op)
          || isFmgSemanticOperation(op)
        );
        if (registeredNativeSemantic) {
          if (op.riskLevel !== 'high'
            || op.metadata?.requiresConfirmation !== true
            || typeof op.metadata.confirmationReceiptId !== 'string'
            || op.metadata.confirmationReceiptId.length === 0) {
            diagnostics.push(createDiagnostic({
              severity: 'error',
              code: 'NATIVE_SEMANTIC_CONFIRMATION_REQUIRED',
              message: '原生语义字段/节点修改必须为高风险并绑定可信确认凭据。',
              targetUri: op.targetUri
            }));
          }
          continue;
        }
        const nativeBnd4 = op.kind.startsWith('container_child_')
          && 'containerFormat' in op
          && op.containerFormat === 'BND4_DFLT'
          && op.metadata?.nativeFormatAuthority === true;
        if (nativeBnd4) {
          if (op.riskLevel !== 'high' || op.metadata?.requiresConfirmation !== true
            || typeof op.metadata.confirmationReceiptId !== 'string') {
            diagnostics.push(createDiagnostic({
              severity: 'error',
              code: 'NATIVE_BND4_CONFIRMATION_REQUIRED',
              message: '原生 BND4 修改必须为高风险并绑定可信确认凭据。',
              targetUri: op.targetUri
            }));
          }
          continue;
        }
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
      validatorId: this.validatorId,
      validatedOperationIds: input.operations.map((op) => op.id)
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
      validatorId: this.validatorId,
      validatedOperationIds: input.operations.map((op) => op.id)
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
      validatorId: this.validatorId,
      validatedOperationIds: input.operations
        .filter((op) => op.kind === 'file_replace')
        .map((op) => op.id)
    };
  }

  async validateStagedOutput(input: {
    patch: PatchIR;
    operations: PatchIrOperation[];
    stagingRoot: string;
    stagedPaths: string[];
  }): Promise<ValidatorResult> {
    const diagnostics: StructuredDiagnostic[] = [];
    const operations = input.operations.filter((op) => op.kind === 'file_replace');
    for (const operation of operations) {
      const stagedPath = input.stagedPaths.find((path) =>
        path.replaceAll('\\', '/').includes(`/${operation.id.slice(0, 8)}/`));
      if (!stagedPath) {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'FILE_REPLACE_STAGED_PATH_MISSING',
          message: 'file_replace 缺少可绑定到 operation 的暂存输出。',
          targetUri: operation.targetUri,
          details: { operationId: operation.id }
        }));
        continue;
      }
      try {
        const actual = await readFile(stagedPath);
        const expected = typeof operation.newText === 'string'
          ? Buffer.from(operation.newText, 'utf8')
          : operation.newContentBase64 !== undefined
            ? Buffer.from(operation.newContentBase64, 'base64')
            : undefined;
        if (!expected || !actual.equals(expected)) {
          diagnostics.push(createDiagnostic({
            severity: 'error',
            code: 'FILE_REPLACE_STAGED_CONTENT_MISMATCH',
            message: 'file_replace 暂存输出与声明的替换内容不一致。',
            targetUri: operation.targetUri,
            details: { operationId: operation.id }
          }));
        }
      } catch {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'FILE_REPLACE_STAGED_READ_FAILED',
          message: 'file_replace 暂存输出无法读取。',
          targetUri: operation.targetUri,
          details: { operationId: operation.id }
        }));
      }
    }
    return {
      ok: diagnostics.every((item) => item.severity !== 'error'),
      diagnostics,
      scope: 'staged_output',
      validatorId: this.validatorId,
      validatedOperationIds: operations.map((op) => op.id)
    };
  }
}
