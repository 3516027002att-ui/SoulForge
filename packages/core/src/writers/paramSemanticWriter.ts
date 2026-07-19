import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type {
  ParamDefDocument,
  PatchIR,
  PatchIrOperation,
  ResourceFieldEditOp,
  StructuredDiagnostic,
  WriterAdapterContract,
  WriterApplyResult,
  WriterInverseCaptureResult,
  WriterPostValidateResult,
  WriterResourceEntryChange,
  WriterRollbackMetadata,
  WriterWritePlan,
  WriterWrittenTarget
} from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';
import {
  commitParamMutationViaBridge,
  readParamDocumentViaBridge
} from '../editing/paramBridgeCommit.js';
import {
  PARAM_SEMANTIC_WRITER_ID,
  fromParamPatchValue,
  isParamFieldSemanticOperation,
  parseParamFieldUri,
  type ParamFieldSemanticOperation
} from '../editing/paramSemanticContract.js';
import { prepareParamFieldMutation } from '../param/paramFieldMutation.js';
import { hashPatchTypedValue } from '../patch/typedValueHash.js';

/** Production semantic writer for user-derived PARAM field mutations. */
export class ParamSemanticWriter implements WriterAdapterContract {
  readonly writerId = PARAM_SEMANTIC_WRITER_ID;
  readonly supportedResourceKinds = ['param'] as const;
  readonly supportedOperations = ['resource_field_edit'] as const;
  readonly inputSchemaVersion = 'soulforge.param.semantic-field.v1';
  readonly preconditions = [
    'source hash',
    'row hash',
    'user-derived paramdef',
    'exact previous typed value',
    'high-risk confirmation',
    'staging only'
  ] as const;

  canHandle(operation: PatchIrOperation): boolean {
    return isParamFieldSemanticOperation(operation);
  }

  writePlan(patch: PatchIR, operations: PatchIrOperation[]): WriterWritePlan {
    const handled = operations.filter((operation) => this.canHandle(operation));
    return {
      writerId: this.writerId,
      operations: handled,
      stagingRelativePaths: handled.map(stagingRelativeName),
      preconditions: handled.flatMap((operation) => operation.preconditions),
      estimatedRisk: 'high',
      notes: `PARAM semantic field plan for patch ${patch.patchId}`
    };
  }

  async applyToStaging(input: {
    stagingRoot: string;
    operations: PatchIrOperation[];
    workspaceRoot?: string;
  }): Promise<WriterApplyResult> {
    const handled = input.operations.filter(isParamFieldSemanticOperation);
    const writtenTargets: WriterWrittenTarget[] = [];
    const diagnostics: StructuredDiagnostic[] = [];

    for (const operation of handled) {
      const identity = parseParamFieldUri(operation.fieldUri)!;
      const definition = readDefinition(operation);
      if (!definition) {
        diagnostics.push(errorFor(operation, 'PARAM_SEMANTIC_DEFINITION_MISSING', '缺少用户派生 ParamDefDocument。'));
        continue;
      }
      const nextDataBase64 = typeof operation.metadata?.nextDataBase64 === 'string'
        ? operation.metadata.nextDataBase64
        : undefined;
      const expectedRowHash = String(operation.metadata?.expectedRowHash ?? '');
      const source = await readParamDocumentViaBridge({
        sourcePath: operation.targetPath!,
        allowedRoots: [input.workspaceRoot ?? dirname(operation.targetPath!)],
        rowId: identity.rowId,
        rowLimit: 1,
        includePayloads: true
      });
      diagnostics.push(...mapDiagnostics(operation, source.diagnostics));
      if (!source.ok || !source.data) continue;
      if (source.data.sourceHash !== operation.expectedHash) {
        diagnostics.push(errorFor(operation, 'PARAM_SEMANTIC_REVISION_MISMATCH', 'PARAM source hash 已变化。'));
        continue;
      }
      const row = source.data.rows[0];
      if (!row?.dataBase64 || row.id !== identity.rowId || row.dataHash !== expectedRowHash) {
        diagnostics.push(errorFor(operation, 'PARAM_SEMANTIC_ROW_HASH_MISMATCH', 'PARAM row hash 与预期不一致。'));
        continue;
      }
      let dataBase64 = nextDataBase64;
      if (!dataBase64) {
        const prepared = prepareParamFieldMutation({
          documentTypeName: source.data.typeName,
          rowDataSize: source.data.rowDataSize,
          rowId: identity.rowId,
          rowDataBase64: row.dataBase64,
          rowDataHash: row.dataHash,
          expectedRowHash,
          definition,
          fieldId: identity.fieldId,
          value: fromParamPatchValue(operation.nextValue) as number | string | boolean
        });
        if (!prepared.ok) {
          diagnostics.push(errorFor(operation, prepared.code, prepared.message));
          continue;
        }
        dataBase64 = prepared.dataBase64;
      }

      const stagingPath = join(input.stagingRoot, stagingRelativeName(operation));
      await mkdir(dirname(stagingPath), { recursive: true });
      const write = await commitParamMutationViaBridge({
        sourcePath: operation.targetPath!,
        outputPath: stagingPath,
        expectedDocumentHash: source.data.sourceHash,
        allowedRoots: [input.workspaceRoot ?? dirname(operation.targetPath!), input.stagingRoot],
        writableRoots: [input.stagingRoot],
        mutation: { kind: 'upsert', id: identity.rowId, dataBase64 }
      });
      diagnostics.push(...mapDiagnostics(operation, write.diagnostics));
      if (!write.ok) continue;

      const staged = await readParamDocumentViaBridge({
        sourcePath: stagingPath,
        allowedRoots: [input.stagingRoot],
        rowId: identity.rowId,
        rowLimit: 1,
        includePayloads: true
      });
      diagnostics.push(...mapDiagnostics(operation, staged.diagnostics));
      if (!staged.ok || !staged.data?.rows[0]
        || write.outputHash !== staged.data.sourceHash) {
        diagnostics.push(errorFor(
          operation,
          'PARAM_SEMANTIC_STAGED_HASH_MISMATCH',
          'PARAM writer 返回 hash 与暂存区重读不一致。'
        ));
        continue;
      }
      diagnostics.push(createDiagnostic({
        severity: 'info',
        code: 'PARAM_SEMANTIC_STAGING_VERIFIED',
        message: 'PARAM typed field 已写入暂存区并完成重读。',
        targetUri: operation.fieldUri
      }));
      writtenTargets.push({
        opId: operation.id,
        targetUri: operation.targetUri,
        targetPath: operation.targetPath!,
        stagingPath
      });
    }

    return {
      ok: handled.length > 0
        && writtenTargets.length === handled.length
        && diagnostics.every((item) => item.severity !== 'error'),
      writtenTargets,
      writtenPaths: writtenTargets.map((target) => target.stagingPath),
      diagnostics,
      rollback: this.produceRollbackMetadata({ operations: handled, backupPaths: [] })
    };
  }

  async postValidate(input: {
    stagingRoot: string;
    operations: PatchIrOperation[];
    writtenTargets: WriterWrittenTarget[];
  }): Promise<WriterPostValidateResult> {
    const operations = input.operations.filter(isParamFieldSemanticOperation);
    const diagnostics: StructuredDiagnostic[] = [];
    const validatedOperationIds: string[] = [];
    for (const operation of operations) {
      const target = input.writtenTargets.find((item) => item.opId === operation.id);
      if (!target) {
        diagnostics.push(errorFor(
          operation,
          'PARAM_SEMANTIC_POST_VALIDATE_TARGET_MISSING',
          'PARAM postValidate 缺少暂存映射。'
        ));
        continue;
      }
      const identity = parseParamFieldUri(operation.fieldUri)!;
      const staged = await readParamDocumentViaBridge({
        sourcePath: target.stagingPath,
        allowedRoots: [input.stagingRoot],
        rowId: identity.rowId,
        rowLimit: 1,
        includePayloads: false
      });
      diagnostics.push(...mapDiagnostics(operation, staged.diagnostics));
      const nextRowHash = typeof operation.metadata?.nextRowHash === 'string'
        ? operation.metadata.nextRowHash
        : undefined;
      if (!staged.ok || !staged.data?.rows[0]
        || (nextRowHash && staged.data.rows[0].dataHash !== nextRowHash)) {
        diagnostics.push(errorFor(
          operation,
          'PARAM_SEMANTIC_POST_VALIDATE_ROW_MISMATCH',
          'PARAM postValidate row hash 与预期不一致。'
        ));
        continue;
      }
      validatedOperationIds.push(operation.id);
    }
    return {
      ok: validatedOperationIds.length === operations.length
        && diagnostics.every((item) => item.severity !== 'error'),
      writerId: this.writerId,
      validatedOperationIds,
      diagnostics
    };
  }

  async captureInverse(input: {
    operations: PatchIrOperation[];
    stagedTargets: WriterWrittenTarget[];
    workspaceRoot: string;
  }): Promise<WriterInverseCaptureResult> {
    const changes: WriterResourceEntryChange[] = [];
    const diagnostics: StructuredDiagnostic[] = [];
    const capturedOperationIds: string[] = [];

    for (const operation of input.operations) {
      if (!isParamFieldSemanticOperation(operation)) continue;
      const target = input.stagedTargets.find((item) => item.opId === operation.id);
      if (!target) {
        diagnostics.push(errorFor(
          operation,
          'PARAM_SEMANTIC_INVERSE_STAGING_MISSING',
          'PARAM inverse 捕获缺少暂存输出。'
        ));
        continue;
      }
      const after = await readParamDocumentViaBridge({
        sourcePath: target.stagingPath,
        allowedRoots: [dirname(target.stagingPath)],
        rowId: Number(operation.metadata?.rowId),
        rowLimit: 1,
        includePayloads: false
      });
      diagnostics.push(...mapDiagnostics(operation, after.diagnostics));
      if (!after.ok || !after.data) continue;

      const inverse: ResourceFieldEditOp = {
        ...operation,
        id: randomUUID(),
        expectedHash: after.data.sourceHash,
        expectedDocumentHash: after.data.sourceHash,
        documentRevision: after.data.sourceHash,
        previousValue: structuredClone(operation.nextValue),
        nextValue: structuredClone(operation.previousValue),
        inverse: {
          kind: 'resource_field_edit',
          fieldUri: operation.fieldUri,
          value: structuredClone(operation.nextValue)
        },
        preconditions: operation.preconditions.map((precondition) => (
          precondition.type === 'content_hash'
            ? { ...precondition, expectedHash: after.data!.sourceHash }
            : precondition
        )),
        rollbackHint: {
          strategy: 'inverse_patch',
          notes: `PARAM 字段 ${operation.fieldUri} 的精确 typed inverse`
        },
        metadata: {
          ...operation.metadata,
          inverseResourceEntry: true,
          entryUri: operation.fieldUri,
          forwardOperationId: operation.id,
          // Inverse must re-prepare payload from previous value.
          expectedRowHash: typeof operation.metadata?.nextRowHash === 'string'
            ? operation.metadata.nextRowHash
            : operation.metadata?.expectedRowHash,
          nextDataBase64: undefined,
          nextRowHash: typeof operation.metadata?.expectedRowHash === 'string'
            ? operation.metadata.expectedRowHash
            : undefined
        }
      };
      changes.push({
        id: randomUUID(),
        resourceUri: operation.targetUri,
        entryUri: operation.fieldUri,
        changeKind: 'field_update',
        beforeHash: hashPatchTypedValue(operation.previousValue),
        afterHash: hashPatchTypedValue(operation.nextValue),
        inverse
      });
      capturedOperationIds.push(operation.id);
    }

    return {
      ok: diagnostics.every((item) => item.severity !== 'error')
        && capturedOperationIds.length === input.operations.filter(isParamFieldSemanticOperation).length,
      resourceEntryChanges: changes,
      capturedOperationIds,
      diagnostics
    };
  }

  produceRollbackMetadata(input: {
    operations: PatchIrOperation[];
    backupPaths: string[];
  }): WriterRollbackMetadata {
    return {
      writerId: this.writerId,
      strategy: 'restore_backup',
      backupPaths: input.backupPaths,
      notes: `PARAM semantic writer rollback metadata for ${input.operations.length} operation(s)`
    };
  }
}

function readDefinition(operation: ParamFieldSemanticOperation): ParamDefDocument | undefined {
  const definition = operation.metadata?.definition;
  if (!definition || typeof definition !== 'object') return undefined;
  return definition as ParamDefDocument;
}

function stagingRelativeName(operation: PatchIrOperation): string {
  const base = basename(operation.targetPath ?? 'document.param');
  return join('param-semantic', operation.id, base);
}

function mapDiagnostics(
  operation: PatchIrOperation,
  items: Array<{ severity: string; code: string; message: string }>
): StructuredDiagnostic[] {
  return items.map((diagnostic) => createDiagnostic({
    severity: diagnostic.severity as StructuredDiagnostic['severity'],
    code: diagnostic.code,
    message: diagnostic.message,
    targetUri: operation.targetUri
  }));
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
    details: { operationId: operation.id, fieldUri: 'fieldUri' in operation ? operation.fieldUri : undefined }
  });
}
