import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type {
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
import { commitMsbMutationViaBridge } from '../editing/msbBridgeCommit.js';
import { readMsbDocumentViaBridge } from '../editing/msbBridgeRead.js';
import {
  MSB_SEMANTIC_WRITER_ID,
  isMsbPositionFieldOperation,
  parseMsbPositionFieldUri,
  readPositionObject,
  type MsbPositionFieldOperation
} from '../editing/msbSemanticContract.js';
import { hashPatchTypedValue } from '../patch/typedValueHash.js';

export class MsbSemanticWriter implements WriterAdapterContract {
  readonly writerId = MSB_SEMANTIC_WRITER_ID;
  readonly supportedResourceKinds = ['map'] as const;
  readonly supportedOperations = ['resource_field_edit'] as const;
  readonly inputSchemaVersion = 'soulforge.msb.semantic-field.v1';
  readonly preconditions = [
    'source hash',
    'part/region identity',
    'exact previous position',
    'high-risk confirmation',
    'staging only'
  ] as const;

  canHandle(operation: PatchIrOperation): boolean {
    return isMsbPositionFieldOperation(operation);
  }

  writePlan(patch: PatchIR, operations: PatchIrOperation[]): WriterWritePlan {
    const handled = operations.filter((operation) => this.canHandle(operation));
    return {
      writerId: this.writerId,
      operations: handled,
      stagingRelativePaths: handled.map(stagingRelativeName),
      preconditions: handled.flatMap((operation) => operation.preconditions),
      estimatedRisk: 'high',
      notes: `MSB semantic field plan for patch ${patch.patchId}`
    };
  }

  async applyToStaging(input: {
    stagingRoot: string;
    operations: PatchIrOperation[];
    workspaceRoot?: string;
  }): Promise<WriterApplyResult> {
    const handled = input.operations.filter(isMsbPositionFieldOperation);
    const writtenTargets: WriterWrittenTarget[] = [];
    const diagnostics: StructuredDiagnostic[] = [];

    for (const operation of handled) {
      const identity = parseMsbPositionFieldUri(operation.fieldUri)!;
      const beforePos = readPositionObject(operation.previousValue);
      const nextPos = readPositionObject(operation.nextValue);
      const source = await readMsbDocumentViaBridge({
        sourcePath: operation.targetPath!,
        allowedRoots: [input.workspaceRoot ?? dirname(operation.targetPath!)],
        maxParts: 10_000,
        maxRegions: 10_000
      });
      diagnostics.push(...mapDiagnostics(operation, source.diagnostics));
      if (!source.ok || !source.data) continue;
      if (source.data.sourceHash !== operation.expectedHash) {
        diagnostics.push(errorFor(operation, 'MSB_SEMANTIC_REVISION_MISMATCH', 'MSB source hash 已变化。'));
        continue;
      }
      const entity = identity.entityKind === 'part'
        ? source.data.parts.find((item) => item.name === identity.entityName)
        : source.data.regions.find((item) => item.name === identity.entityName);
      if (!entity
        || !near(entity.posX, beforePos.x)
        || !near(entity.posY, beforePos.y)
        || !near(entity.posZ, beforePos.z)) {
        diagnostics.push(errorFor(
          operation,
          'MSB_SEMANTIC_PREVIOUS_VALUE_MISMATCH',
          'MSB entity 当前位置与 previous typed value 不一致。'
        ));
        continue;
      }

      const stagingPath = join(input.stagingRoot, stagingRelativeName(operation));
      await mkdir(dirname(stagingPath), { recursive: true });
      const write = await commitMsbMutationViaBridge({
        sourcePath: operation.targetPath!,
        outputPath: stagingPath,
        expectedDocumentHash: source.data.sourceHash,
        allowedRoots: [input.workspaceRoot ?? dirname(operation.targetPath!), input.stagingRoot],
        writableRoots: [input.stagingRoot],
        mutation: {
          kind: identity.entityKind === 'part' ? 'set_part_position' : 'set_region_position',
          partName: identity.entityName,
          posX: nextPos.x,
          posY: nextPos.y,
          posZ: nextPos.z
        }
      });
      diagnostics.push(...mapDiagnostics(operation, write.diagnostics));
      if (!write.ok) continue;

      const staged = await readMsbDocumentViaBridge({
        sourcePath: stagingPath,
        allowedRoots: [input.stagingRoot],
        maxParts: 10_000,
        maxRegions: 10_000
      });
      diagnostics.push(...mapDiagnostics(operation, staged.diagnostics));
      const stagedEntity = identity.entityKind === 'part'
        ? staged.data?.parts.find((item) => item.name === identity.entityName)
        : staged.data?.regions.find((item) => item.name === identity.entityName);
      if (!staged.ok || !stagedEntity
        || write.outputHash !== staged.data?.sourceHash
        || !near(stagedEntity.posX, nextPos.x)
        || !near(stagedEntity.posY, nextPos.y)
        || !near(stagedEntity.posZ, nextPos.z)) {
        diagnostics.push(errorFor(
          operation,
          'MSB_SEMANTIC_STAGED_VALUE_MISMATCH',
          'MSB staged entity 位置与 next typed value 不一致。'
        ));
        continue;
      }
      diagnostics.push(createDiagnostic({
        severity: 'info',
        code: 'MSB_SEMANTIC_STAGING_VERIFIED',
        message: 'MSB typed part position 已写入暂存区并完成重读。',
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
    const operations = input.operations.filter(isMsbPositionFieldOperation);
    const diagnostics: StructuredDiagnostic[] = [];
    const validatedOperationIds: string[] = [];
    for (const operation of operations) {
      const target = input.writtenTargets.find((item) => item.opId === operation.id);
      if (!target) {
        diagnostics.push(errorFor(
          operation,
          'MSB_SEMANTIC_POST_VALIDATE_TARGET_MISSING',
          'MSB postValidate 缺少暂存映射。'
        ));
        continue;
      }
      const identity = parseMsbPositionFieldUri(operation.fieldUri)!;
      const nextPos = readPositionObject(operation.nextValue);
      const staged = await readMsbDocumentViaBridge({
        sourcePath: target.stagingPath,
        allowedRoots: [input.stagingRoot],
        maxParts: 10_000,
        maxRegions: 10_000
      });
      diagnostics.push(...mapDiagnostics(operation, staged.diagnostics));
      const entity = identity.entityKind === 'part'
        ? staged.data?.parts.find((item) => item.name === identity.entityName)
        : staged.data?.regions.find((item) => item.name === identity.entityName);
      if (!staged.ok || !entity
        || !near(entity.posX, nextPos.x)
        || !near(entity.posY, nextPos.y)
        || !near(entity.posZ, nextPos.z)) {
        diagnostics.push(errorFor(
          operation,
          'MSB_SEMANTIC_POST_VALIDATE_VALUE_MISMATCH',
          'MSB postValidate entity 位置不一致。'
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
      if (!isMsbPositionFieldOperation(operation)) continue;
      const target = input.stagedTargets.find((item) => item.opId === operation.id);
      if (!target) {
        diagnostics.push(errorFor(
          operation,
          'MSB_SEMANTIC_INVERSE_STAGING_MISSING',
          'MSB inverse 捕获缺少暂存输出。'
        ));
        continue;
      }
      const after = await readMsbDocumentViaBridge({
        sourcePath: target.stagingPath,
        allowedRoots: [dirname(target.stagingPath)],
        maxParts: 10_000,
        maxRegions: 10_000
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
          notes: `MSB 字段 ${operation.fieldUri} 的精确 typed inverse`
        },
        metadata: {
          ...operation.metadata,
          inverseResourceEntry: true,
          entryUri: operation.fieldUri,
          forwardOperationId: operation.id
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
        && capturedOperationIds.length === input.operations.filter(isMsbPositionFieldOperation).length,
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
      notes: `MSB semantic writer rollback metadata for ${input.operations.length} operation(s)`
    };
  }
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-4;
}

function stagingRelativeName(operation: PatchIrOperation): string {
  const base = basename(operation.targetPath ?? 'document.msb');
  return join('msb-semantic', operation.id, base);
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
