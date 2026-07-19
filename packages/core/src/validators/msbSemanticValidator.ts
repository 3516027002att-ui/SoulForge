import { dirname } from 'node:path';
import type {
  PatchIR,
  PatchIrOperation,
  StructuredDiagnostic,
  ValidatorContract,
  ValidatorResult
} from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';
import { readMsbDocumentViaBridge } from '../editing/msbBridgeRead.js';
import {
  MSB_SEMANTIC_VALIDATOR_ID,
  isMsbPositionFieldOperation,
  parseMsbPositionFieldUri,
  readPositionObject,
  type MsbPositionFieldOperation
} from '../editing/msbSemanticContract.js';

export class MsbSemanticValidator implements ValidatorContract {
  readonly validatorId = MSB_SEMANTIC_VALIDATOR_ID;
  readonly targetResourceKinds = ['map'] as const;
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
  const semanticOperations = operations.filter(isMsbPositionFieldOperation);
  const validatedOperationIds: string[] = [];
  for (const operation of semanticOperations) {
    const sourcePath = scope === 'staged_output'
      ? stagedPaths.find((path) => path.replaceAll('\\', '/').includes(`/${operation.id}/`))
      : operation.targetPath;
    if (!sourcePath) {
      diagnostics.push(errorFor(
        operation,
        'MSB_SEMANTIC_VALIDATION_TARGET_MISSING',
        `MSB ${scope} 校验缺少精确目标路径。`
      ));
      continue;
    }
    const operationDiagnostics = await validateDocument(operation, sourcePath, scope);
    diagnostics.push(...operationDiagnostics);
    if (operationDiagnostics.every((item) => item.severity !== 'error')) {
      validatedOperationIds.push(operation.id);
    }
  }
  return {
    ok: validatedOperationIds.length === semanticOperations.length
      && diagnostics.every((item) => item.severity !== 'error'),
    diagnostics,
    scope,
    validatorId: MSB_SEMANTIC_VALIDATOR_ID,
    validatedOperationIds
  };
}

async function validateDocument(
  operation: MsbPositionFieldOperation,
  sourcePath: string,
  scope: 'before_staging' | 'staged_output' | 'after_commit'
): Promise<StructuredDiagnostic[]> {
  const identity = parseMsbPositionFieldUri(operation.fieldUri)!;
  const expected = scope === 'before_staging'
    ? readPositionObject(operation.previousValue)
    : readPositionObject(operation.nextValue);
  const result = await readMsbDocumentViaBridge({
    sourcePath,
    allowedRoots: [dirname(sourcePath)],
    maxParts: 10_000,
    maxRegions: 10_000
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
      'MSB_SEMANTIC_VALIDATION_READ_FAILED',
      `MSB ${scope} 原生重读失败。`
    ));
    return diagnostics;
  }
  const entity = identity.entityKind === 'part'
    ? result.data.parts.find((item) => item.name === identity.entityName)
    : result.data.regions.find((item) => item.name === identity.entityName);
  if (!entity) {
    diagnostics.push(errorFor(
      operation,
      identity.entityKind === 'part' ? 'MSB_SEMANTIC_PART_NOT_FOUND' : 'MSB_SEMANTIC_REGION_NOT_FOUND',
      `MSB ${scope} 找不到 ${identity.entityKind} ${identity.entityName}。`
    ));
  } else if (
    Math.abs(entity.posX - expected.x) >= 1e-4
    || Math.abs(entity.posY - expected.y) >= 1e-4
    || Math.abs(entity.posZ - expected.z) >= 1e-4
  ) {
    diagnostics.push(errorFor(
      operation,
      'MSB_SEMANTIC_VALUE_MISMATCH',
      `MSB ${scope} ${identity.entityKind} 位置与 PatchIR typed value 不一致。`
    ));
  }
  if (scope === 'before_staging' && result.data.sourceHash !== operation.expectedHash) {
    diagnostics.push(errorFor(
      operation,
      'MSB_SEMANTIC_REVISION_MISMATCH',
      'MSB 提交前 source hash 已变化。'
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
