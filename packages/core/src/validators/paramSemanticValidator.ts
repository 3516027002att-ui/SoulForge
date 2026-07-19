import { dirname } from 'node:path';
import type {
  PatchIR,
  PatchIrOperation,
  StructuredDiagnostic,
  ValidatorContract,
  ValidatorResult
} from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';
import { readParamDocumentViaBridge } from '../editing/paramBridgeCommit.js';
import {
  PARAM_SEMANTIC_VALIDATOR_ID,
  isParamFieldSemanticOperation,
  parseParamFieldUri,
  type ParamFieldSemanticOperation
} from '../editing/paramSemanticContract.js';

export class ParamSemanticValidator implements ValidatorContract {
  readonly validatorId = PARAM_SEMANTIC_VALIDATOR_ID;
  readonly targetResourceKinds = ['param'] as const;
  readonly validationScope = ['before_staging', 'staged_output', 'after_commit'] as const;

  async validateBeforeStaging(input: {
    patch: PatchIR;
    operations: PatchIrOperation[];
  }): Promise<ValidatorResult> {
    return validateOperations(input.operations, 'before_staging');
  }

  async validateStagedOutput(input: {
    patch: PatchIR;
    operations: PatchIrOperation[];
    stagingRoot: string;
    stagedPaths: string[];
  }): Promise<ValidatorResult> {
    return validateOperations(input.operations, 'staged_output', input.stagedPaths);
  }

  async validateAfterCommit(input: {
    patch: PatchIR;
    operations: PatchIrOperation[];
    committedPaths: string[];
  }): Promise<ValidatorResult> {
    return validateOperations(input.operations, 'after_commit');
  }
}

async function validateOperations(
  operations: PatchIrOperation[],
  scope: 'before_staging' | 'staged_output' | 'after_commit',
  stagedPaths: string[] = []
): Promise<ValidatorResult> {
  const diagnostics: StructuredDiagnostic[] = [];
  const semanticOperations = operations.filter(isParamFieldSemanticOperation);
  for (const operation of semanticOperations) {
    const sourcePath = scope === 'staged_output'
      ? stagedPaths.find((path) => path.replaceAll('\\', '/').includes(`/${operation.id}/`))
      : operation.targetPath;
    if (!sourcePath) {
      diagnostics.push(errorFor(
        operation,
        'PARAM_SEMANTIC_VALIDATION_TARGET_MISSING',
        `PARAM ${scope} 校验缺少精确目标路径。`
      ));
      continue;
    }
    diagnostics.push(...await validateDocument(operation, sourcePath, scope));
  }
  return {
    ok: diagnostics.every((item) => item.severity !== 'error'),
    diagnostics,
    scope,
    validatorId: PARAM_SEMANTIC_VALIDATOR_ID,
    validatedOperationIds: semanticOperations.map((operation) => operation.id)
  };
}

async function validateDocument(
  operation: ParamFieldSemanticOperation,
  sourcePath: string,
  scope: 'before_staging' | 'staged_output' | 'after_commit'
): Promise<StructuredDiagnostic[]> {
  const identity = parseParamFieldUri(operation.fieldUri)!;
  const result = await readParamDocumentViaBridge({
    sourcePath,
    allowedRoots: [dirname(sourcePath)],
    rowId: identity.rowId,
    rowLimit: 1,
    includePayloads: false
  });
  const diagnostics: StructuredDiagnostic[] = result.diagnostics.map((diagnostic) => createDiagnostic({
    severity: diagnostic.severity as StructuredDiagnostic['severity'],
    code: diagnostic.code,
    message: diagnostic.message,
    targetUri: operation.targetUri
  }));
  if (!result.ok || !result.data) {
    diagnostics.push(errorFor(
      operation,
      'PARAM_SEMANTIC_VALIDATION_READ_FAILED',
      `PARAM ${scope} 原生重读失败。`
    ));
    return diagnostics;
  }
  const row = result.data.rows[0];
  if (!row || row.id !== identity.rowId) {
    diagnostics.push(errorFor(
      operation,
      'PARAM_SEMANTIC_ROW_NOT_FOUND',
      `PARAM ${scope} 找不到 row ${identity.rowId}。`
    ));
  } else if (scope === 'before_staging') {
    const expectedRowHash = String(operation.metadata?.expectedRowHash ?? '');
    if (row.dataHash !== expectedRowHash) {
      diagnostics.push(errorFor(
        operation,
        'PARAM_SEMANTIC_ROW_HASH_MISMATCH',
        'PARAM 提交前 row hash 已变化。'
      ));
    }
  } else {
    const nextRowHash = typeof operation.metadata?.nextRowHash === 'string'
      ? operation.metadata.nextRowHash
      : undefined;
    if (nextRowHash && row.dataHash !== nextRowHash) {
      diagnostics.push(errorFor(
        operation,
        'PARAM_SEMANTIC_VALUE_MISMATCH',
        `PARAM ${scope} row hash 与 typed mutation 预期不一致。`
      ));
    }
  }
  if (scope === 'before_staging' && result.data.sourceHash !== operation.expectedHash) {
    diagnostics.push(errorFor(
      operation,
      'PARAM_SEMANTIC_REVISION_MISMATCH',
      'PARAM 提交前 source hash 已变化。'
    ));
  }
  return diagnostics;
}

function errorFor(
  operation: PatchIrOperation,
  code: string,
  message: string
): StructuredDiagnostic {
  return createDiagnostic({
    severity: 'error',
    code,
    message,
    targetUri: operation.targetUri,
    details: { operationId: operation.id }
  });
}
