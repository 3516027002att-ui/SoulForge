import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type {
  PatchIR,
  PatchIrOperation,
  ResourceFieldEditOp,
  ResourceNodeAddOp,
  ResourceNodeDeleteOp,
  ResourceNodeReorderOp,
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
  commitFmgMutationViaBridge,
  readFmgDocumentViaBridge,
  type FmgBridgeDocument
} from '../editing/fmgBridgeCommit.js';
import {
  FMG_SEMANTIC_WRITER_ID,
  assertFmgSlotOrderEquals,
  assertFmgSlotDeleteApplied,
  buildFmgEntryNodePayload,
  fmgEntryOrderUris,
  fmgEntryNodeUri,
  hashFmgEntrySlots,
  isFmgEntryNodeAddOperation,
  isFmgEntryNodeDeleteOperation,
  isFmgEntryNodeReorderOperation,
  isFmgEntryTextFieldOperation,
  isFmgSemanticOperation,
  parseFmgEntryNodeId,
  parseFmgEntryTextFieldUri,
  readFmgBeforeEntriesFromMetadata,
  reorderFmgEntrySlots,
  snapshotFmgEntrySlots,
  type FmgEntryNodeAddOperation,
  type FmgEntryNodeDeleteOperation,
  type FmgEntryNodeReorderOperation,
  type FmgEntryTextFieldOperation,
  type FmgSemanticOperation
} from '../editing/fmgSemanticContract.js';
import { hashPatchTypedValue } from '../patch/typedValueHash.js';

/** Production semantic writer for FMG slot text, delete, add, and complete-order reorder. */
export class FmgSemanticWriter implements WriterAdapterContract {
  readonly writerId = FMG_SEMANTIC_WRITER_ID;
  readonly supportedResourceKinds = ['msg'] as const;
  readonly supportedOperations = [
    'resource_field_edit',
    'resource_node_delete',
    'resource_node_add',
    'resource_node_reorder'
  ] as const;
  readonly inputSchemaVersion = 'soulforge.fmg.semantic.v1';
  readonly preconditions = [
    'source and document hash',
    'schema/layout fingerprint',
    'entry id and string slot occurrence',
    'exact previous typed value or node payload',
    'high-risk confirmation',
    'staging only'
  ] as const;

  canHandle(operation: PatchIrOperation): boolean {
    return isFmgSemanticOperation(operation);
  }

  writePlan(patch: PatchIR, operations: PatchIrOperation[]): WriterWritePlan {
    const handled = operations.filter((operation) => this.canHandle(operation));
    return {
      writerId: this.writerId,
      operations: handled,
      stagingRelativePaths: handled.map(stagingRelativeName),
      preconditions: handled.flatMap((operation) => operation.preconditions),
      estimatedRisk: 'high',
      notes: `FMG semantic plan for patch ${patch.patchId}`
    };
  }

  async applyToStaging(input: {
    stagingRoot: string;
    operations: PatchIrOperation[];
    workspaceRoot?: string;
  }): Promise<WriterApplyResult> {
    const handled = input.operations.filter(isFmgSemanticOperation);
    const writtenTargets: WriterWrittenTarget[] = [];
    const diagnostics: StructuredDiagnostic[] = [];

    for (const operation of handled) {
      const result = operation.kind === 'resource_field_edit'
        ? await applyTextField(operation, input)
        : operation.kind === 'resource_node_delete'
          ? await applyNodeDelete(operation, input)
          : operation.kind === 'resource_node_add'
            ? await applyNodeAdd(operation, input)
            : await applyNodeReorder(operation, input);
      diagnostics.push(...result.diagnostics);
      if (result.writtenTarget) writtenTargets.push(result.writtenTarget);
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
    const operations = input.operations.filter(isFmgSemanticOperation);
    const diagnostics: StructuredDiagnostic[] = [];
    const validatedOperationIds: string[] = [];
    for (const operation of operations) {
      const target = input.writtenTargets.find((item) => item.opId === operation.id);
      if (!target) {
        diagnostics.push(errorFor(
          operation,
          'FMG_SEMANTIC_POST_VALIDATE_TARGET_MISSING',
          'FMG semantic postValidate 缺少显式暂存映射。'
        ));
        continue;
      }
      const state = await inspectOperationState({
        operation,
        sourcePath: target.stagingPath,
        allowedRoots: [input.stagingRoot],
        requireBoundHashes: false,
        phase: 'writer_post_validate'
      });
      diagnostics.push(...state.diagnostics);
      if (!state.data || state.diagnostics.some((item) => item.severity === 'error')) continue;
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
      if (!isFmgSemanticOperation(operation)) continue;
      const target = input.stagedTargets.find((item) => item.opId === operation.id);
      if (!target) {
        diagnostics.push(errorFor(
          operation,
          'FMG_SEMANTIC_INVERSE_STAGING_MISSING',
          'FMG semantic inverse 捕获缺少对应暂存输出。'
        ));
        continue;
      }
      const before = await inspectOperationState({
        operation,
        sourcePath: operation.targetPath!,
        allowedRoots: [input.workspaceRoot],
        requireBoundHashes: true,
        phase: 'inverse_before',
        expectBeforeState: true
      });
      const after = await inspectOperationState({
        operation,
        sourcePath: target.stagingPath,
        allowedRoots: [dirname(target.stagingPath)],
        requireBoundHashes: false,
        phase: 'inverse_after'
      });
      diagnostics.push(...before.diagnostics, ...after.diagnostics);
      if (!before.data || !after.data
        || before.diagnostics.some((item) => item.severity === 'error')
        || after.diagnostics.some((item) => item.severity === 'error')) {
        continue;
      }

      if (isFmgEntryTextFieldOperation(operation)) {
        const inverse: ResourceFieldEditOp = {
          ...operation,
          id: randomUUID(),
          expectedHash: after.data.sourceHash,
          expectedDocumentHash: after.data.documentHash,
          documentRevision: after.data.documentRevision,
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
            notes: `FMG 文本字段 ${operation.fieldUri} 的精确 typed inverse`
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
        continue;
      }

      if (isFmgEntryNodeDeleteOperation(operation)) {
        const payload = structuredClone(operation.inverse.payload);
        const inverse: ResourceNodeAddOp = {
          ...operation,
          id: randomUUID(),
          kind: 'resource_node_add',
          expectedHash: after.data.sourceHash,
          expectedDocumentHash: after.data.documentHash,
          documentRevision: after.data.documentRevision,
          payload,
          inverse: {
            kind: 'resource_node_delete',
            nodeId: operation.nodeId,
            expectedNodeHash: payload.snapshot.sha256
          },
          preconditions: operation.preconditions.map((precondition) => (
            precondition.type === 'content_hash'
              ? { ...precondition, expectedHash: after.data!.sourceHash }
              : precondition
          )),
          rollbackHint: {
            strategy: 'inverse_patch',
            notes: `FMG 槽位 ${operation.nodeId} 的精确 typed insert inverse`
          },
          metadata: {
            ...operation.metadata,
            inverseResourceEntry: true,
            entryUri: operation.nodeId,
            forwardOperationId: operation.id
          }
        };
        changes.push({
          id: randomUUID(),
          resourceUri: operation.targetUri,
          entryUri: operation.nodeId,
          changeKind: 'node_delete',
          beforeHash: operation.expectedNodeHash,
          afterHash: payload.snapshot.sha256,
          inverse
        });
        capturedOperationIds.push(operation.id);
        continue;
      }

      if (isFmgEntryNodeAddOperation(operation)) {
        const payload = structuredClone(operation.payload);
        const inverse: ResourceNodeDeleteOp = {
          ...operation,
          id: randomUUID(),
          kind: 'resource_node_delete',
          expectedHash: after.data.sourceHash,
          expectedDocumentHash: after.data.documentHash,
          documentRevision: after.data.documentRevision,
          expectedNodeHash: payload.snapshot.sha256,
          inverse: {
            kind: 'resource_node_add',
            nodeId: operation.nodeId,
            payload
          },
          preconditions: operation.preconditions.map((precondition) => (
            precondition.type === 'content_hash'
              ? { ...precondition, expectedHash: after.data!.sourceHash }
              : precondition
          )),
          rollbackHint: {
            strategy: 'inverse_patch',
            notes: `FMG 槽位 ${operation.nodeId} 的精确 typed delete inverse`
          },
          metadata: {
            ...operation.metadata,
            inverseResourceEntry: true,
            entryUri: operation.nodeId,
            forwardOperationId: operation.id,
            // After-add document is the before-delete baseline for this inverse.
            beforeEntries: snapshotFmgEntrySlots(after.data.entries)
          }
        };
        changes.push({
          id: randomUUID(),
          resourceUri: operation.targetUri,
          entryUri: operation.nodeId,
          changeKind: 'node_add',
          beforeHash: payload.snapshot.sha256,
          afterHash: payload.snapshot.sha256,
          inverse
        });
        capturedOperationIds.push(operation.id);
        continue;
      }

      if (isFmgEntryNodeReorderOperation(operation)) {
        const beforeEntries = snapshotFmgEntrySlots(before.data.entries);
        const afterEntries = snapshotFmgEntrySlots(after.data.entries);
        const planned = reorderFmgEntrySlots({
          documentUri: operation.documentUri,
          beforeEntries,
          nodeId: operation.nodeId,
          beforeNodeId: operation.beforeNodeId
        });
        if (!planned.ok) {
          diagnostics.push(errorFor(operation, planned.code, planned.message));
          continue;
        }
        const targetIdentity = parseFmgEntryNodeId(operation.nodeId)!;
        const originalFollowerIndex = targetIdentity.stringIndex + 1 < beforeEntries.length
          ? targetIdentity.stringIndex + 1
          : undefined;
        const inverseNodeId = fmgEntryNodeUri({
          documentUri: operation.documentUri,
          entryId: targetIdentity.entryId,
          stringIndex: planned.movedStringIndex
        });
        const inverseBeforeNodeId = originalFollowerIndex === undefined
          ? undefined
          : (() => {
              const followerIndex = planned.afterOriginalIndexes.indexOf(originalFollowerIndex);
              const follower = beforeEntries[originalFollowerIndex];
              return followerIndex >= 0 && follower
                ? fmgEntryNodeUri({
                    documentUri: operation.documentUri,
                    entryId: follower.id,
                    stringIndex: followerIndex
                  })
                : undefined;
            })();
        if (originalFollowerIndex !== undefined && !inverseBeforeNodeId) {
          diagnostics.push(errorFor(
            operation,
            'FMG_SEMANTIC_REORDER_INVERSE_ANCHOR_MISSING',
            'FMG reorder inverse 无法定位原始后继槽位。'
          ));
          continue;
        }
        const inverseExpectedOrder = fmgEntryOrderUris(operation.documentUri, afterEntries);
        const inverse: ResourceNodeReorderOp = {
          ...operation,
          id: randomUUID(),
          expectedHash: after.data.sourceHash,
          expectedDocumentHash: after.data.documentHash,
          documentRevision: after.data.documentRevision,
          nodeId: inverseNodeId,
          expectedOrder: inverseExpectedOrder,
          inverse: {
            kind: 'resource_node_reorder',
            ...(operation.parentNodeId ? { parentNodeId: operation.parentNodeId } : {}),
            previousOrder: [...inverseExpectedOrder]
          },
          preconditions: operation.preconditions.map((precondition) => (
            precondition.type === 'content_hash'
              ? { ...precondition, expectedHash: after.data!.sourceHash }
              : precondition.type === 'custom'
                ? {
                    ...precondition,
                    details: {
                      ...(precondition.details ?? {}),
                      expectedOrderHash: hashFmgEntrySlots(afterEntries),
                      entryCount: afterEntries.length
                    }
                  }
                : precondition
          )),
          rollbackHint: {
            strategy: 'inverse_patch',
            notes: `FMG 槽位 ${inverseNodeId} 的完整顺序 typed inverse`
          },
          metadata: {
            ...operation.metadata,
            inverseResourceEntry: true,
            entryUri: inverseNodeId,
            forwardEntryUri: operation.nodeId,
            forwardOperationId: operation.id,
            entryId: targetIdentity.entryId,
            stringIndex: planned.movedStringIndex,
            beforeStringIndex: inverseBeforeNodeId
              ? parseFmgEntryNodeId(inverseBeforeNodeId)?.stringIndex
              : undefined,
            beforeId: inverseBeforeNodeId
              ? parseFmgEntryNodeId(inverseBeforeNodeId)?.entryId
              : undefined,
            beforeEntries: afterEntries
          }
        };
        if (inverseBeforeNodeId) inverse.beforeNodeId = inverseBeforeNodeId;
        else delete inverse.beforeNodeId;
        changes.push({
          id: randomUUID(),
          resourceUri: operation.targetUri,
          entryUri: inverseNodeId,
          changeKind: 'node_reorder',
          beforeHash: hashFmgEntrySlots(beforeEntries),
          afterHash: hashFmgEntrySlots(afterEntries),
          inverse
        });
        capturedOperationIds.push(operation.id);
      }
    }

    return {
      ok: diagnostics.every((item) => item.severity !== 'error')
        && capturedOperationIds.length === input.operations.filter(isFmgSemanticOperation).length,
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
      notes: `FMG semantic writer rollback metadata for ${input.operations.length} operation(s)`
    };
  }
}

async function applyTextField(
  operation: FmgEntryTextFieldOperation,
  input: { stagingRoot: string; workspaceRoot?: string }
): Promise<{ writtenTarget?: WriterWrittenTarget; diagnostics: StructuredDiagnostic[] }> {
  const identity = parseFmgEntryTextFieldUri(operation.fieldUri)!;
  const diagnostics: StructuredDiagnostic[] = [];
  const sourceState = await inspectOperationState({
    operation,
    sourcePath: operation.targetPath!,
    allowedRoots: [input.workspaceRoot ?? dirname(operation.targetPath!)],
    requireBoundHashes: true,
    phase: 'before_staging',
    expectBeforeState: true
  });
  diagnostics.push(...sourceState.diagnostics);
  if (!sourceState.data || sourceState.diagnostics.some((item) => item.severity === 'error')) {
    return { diagnostics };
  }
  if (operation.previousValue.value === operation.nextValue.value) {
    diagnostics.push(errorFor(operation, 'FMG_SEMANTIC_NOOP_BLOCKED', 'FMG semantic 文本修改必须改变目标值。'));
    return { diagnostics };
  }

  const stagingPath = join(input.stagingRoot, stagingRelativeName(operation));
  await mkdir(dirname(stagingPath), { recursive: true });
  const write = await commitFmgMutationViaBridge({
    sourcePath: operation.targetPath!,
    outputPath: stagingPath,
    expectedDocumentHash: sourceState.data.sourceHash,
    allowedRoots: [input.workspaceRoot ?? dirname(operation.targetPath!), input.stagingRoot],
    writableRoots: [input.stagingRoot],
    mutation: {
      kind: 'set_text',
      id: identity.entryId,
      stringIndex: identity.stringIndex,
      text: operation.nextValue.value
    }
  });
  diagnostics.push(...write.diagnostics.map((diagnostic) => createDiagnostic({
    severity: diagnostic.severity as StructuredDiagnostic['severity'],
    code: diagnostic.code,
    message: diagnostic.message,
    targetUri: operation.targetUri
  })));
  if (!write.ok) return { diagnostics };

  const stagedState = await inspectOperationState({
    operation,
    sourcePath: stagingPath,
    allowedRoots: [input.stagingRoot],
    requireBoundHashes: false,
    phase: 'staged_output'
  });
  diagnostics.push(...stagedState.diagnostics);
  if (!stagedState.data
    || stagedState.diagnostics.some((item) => item.severity === 'error')
    || write.outputHash !== stagedState.data.sourceHash) {
    if (stagedState.data && write.outputHash !== stagedState.data.sourceHash) {
      diagnostics.push(errorFor(
        operation,
        'FMG_SEMANTIC_STAGED_HASH_MISMATCH',
        'FMG writer 返回 hash 与暂存区重读结果不一致。'
      ));
    }
    return { diagnostics };
  }
  diagnostics.push(createDiagnostic({
    severity: 'info',
    code: 'FMG_SEMANTIC_STAGING_VERIFIED',
    message: 'FMG typed text field 已由原生 writer 写入暂存区并完成语义重读。',
    targetUri: operation.fieldUri
  }));
  return {
    writtenTarget: {
      opId: operation.id,
      targetUri: operation.targetUri,
      targetPath: operation.targetPath!,
      stagingPath
    },
    diagnostics
  };
}

async function applyNodeDelete(
  operation: FmgEntryNodeDeleteOperation,
  input: { stagingRoot: string; workspaceRoot?: string }
): Promise<{ writtenTarget?: WriterWrittenTarget; diagnostics: StructuredDiagnostic[] }> {
  const identity = parseFmgEntryNodeId(operation.nodeId)!;
  const diagnostics: StructuredDiagnostic[] = [];
  const sourceState = await inspectOperationState({
    operation,
    sourcePath: operation.targetPath!,
    allowedRoots: [input.workspaceRoot ?? dirname(operation.targetPath!)],
    requireBoundHashes: true,
    phase: 'before_staging',
    expectBeforeState: true
  });
  diagnostics.push(...sourceState.diagnostics);
  if (!sourceState.data || sourceState.diagnostics.some((item) => item.severity === 'error')) {
    return { diagnostics };
  }

  const stagingPath = join(input.stagingRoot, stagingRelativeName(operation));
  await mkdir(dirname(stagingPath), { recursive: true });
  const write = await commitFmgMutationViaBridge({
    sourcePath: operation.targetPath!,
    outputPath: stagingPath,
    expectedDocumentHash: sourceState.data.sourceHash,
    allowedRoots: [input.workspaceRoot ?? dirname(operation.targetPath!), input.stagingRoot],
    writableRoots: [input.stagingRoot],
    mutation: {
      kind: 'delete',
      id: identity.entryId,
      stringIndex: identity.stringIndex
    }
  });
  diagnostics.push(...write.diagnostics.map((diagnostic) => createDiagnostic({
    severity: diagnostic.severity as StructuredDiagnostic['severity'],
    code: diagnostic.code,
    message: diagnostic.message,
    targetUri: operation.targetUri
  })));
  if (!write.ok) return { diagnostics };

  const stagedState = await inspectOperationState({
    operation,
    sourcePath: stagingPath,
    allowedRoots: [input.stagingRoot],
    requireBoundHashes: false,
    phase: 'staged_output'
  });
  diagnostics.push(...stagedState.diagnostics);
  if (!stagedState.data
    || stagedState.diagnostics.some((item) => item.severity === 'error')
    || write.outputHash !== stagedState.data.sourceHash) {
    if (stagedState.data && write.outputHash !== stagedState.data.sourceHash) {
      diagnostics.push(errorFor(
        operation,
        'FMG_SEMANTIC_STAGED_HASH_MISMATCH',
        'FMG writer 返回 hash 与暂存区重读结果不一致。'
      ));
    }
    return { diagnostics };
  }
  diagnostics.push(createDiagnostic({
    severity: 'info',
    code: 'FMG_SEMANTIC_STAGING_VERIFIED',
    message: 'FMG typed slot delete 已由原生 writer 写入暂存区并完成语义重读。',
    targetUri: operation.nodeId
  }));
  return {
    writtenTarget: {
      opId: operation.id,
      targetUri: operation.targetUri,
      targetPath: operation.targetPath!,
      stagingPath
    },
    diagnostics
  };
}

async function applyNodeAdd(
  operation: FmgEntryNodeAddOperation,
  input: { stagingRoot: string; workspaceRoot?: string }
): Promise<{ writtenTarget?: WriterWrittenTarget; diagnostics: StructuredDiagnostic[] }> {
  const identity = parseFmgEntryNodeId(operation.nodeId)!;
  const diagnostics: StructuredDiagnostic[] = [];
  const sourceState = await inspectOperationState({
    operation,
    sourcePath: operation.targetPath!,
    allowedRoots: [input.workspaceRoot ?? dirname(operation.targetPath!)],
    requireBoundHashes: true,
    phase: 'before_staging',
    expectBeforeState: true
  });
  diagnostics.push(...sourceState.diagnostics);
  if (!sourceState.data || sourceState.diagnostics.some((item) => item.severity === 'error')) {
    return { diagnostics };
  }

  const stagingPath = join(input.stagingRoot, stagingRelativeName(operation));
  await mkdir(dirname(stagingPath), { recursive: true });
  const write = await commitFmgMutationViaBridge({
    sourcePath: operation.targetPath!,
    outputPath: stagingPath,
    expectedDocumentHash: sourceState.data.sourceHash,
    allowedRoots: [input.workspaceRoot ?? dirname(operation.targetPath!), input.stagingRoot],
    writableRoots: [input.stagingRoot],
    mutation: {
      kind: 'insert',
      id: identity.entryId,
      stringIndex: identity.stringIndex,
      text: operation.payload.text
    }
  });
  diagnostics.push(...write.diagnostics.map((diagnostic) => createDiagnostic({
    severity: diagnostic.severity as StructuredDiagnostic['severity'],
    code: diagnostic.code,
    message: diagnostic.message,
    targetUri: operation.targetUri
  })));
  if (!write.ok) return { diagnostics };

  const stagedState = await inspectOperationState({
    operation,
    sourcePath: stagingPath,
    allowedRoots: [input.stagingRoot],
    requireBoundHashes: false,
    phase: 'staged_output'
  });
  diagnostics.push(...stagedState.diagnostics);
  if (!stagedState.data
    || stagedState.diagnostics.some((item) => item.severity === 'error')
    || write.outputHash !== stagedState.data.sourceHash) {
    if (stagedState.data && write.outputHash !== stagedState.data.sourceHash) {
      diagnostics.push(errorFor(
        operation,
        'FMG_SEMANTIC_STAGED_HASH_MISMATCH',
        'FMG writer 返回 hash 与暂存区重读结果不一致。'
      ));
    }
    return { diagnostics };
  }
  diagnostics.push(createDiagnostic({
    severity: 'info',
    code: 'FMG_SEMANTIC_STAGING_VERIFIED',
    message: 'FMG typed slot insert 已由原生 writer 写入暂存区并完成语义重读。',
    targetUri: operation.nodeId
  }));
  return {
    writtenTarget: {
      opId: operation.id,
      targetUri: operation.targetUri,
      targetPath: operation.targetPath!,
      stagingPath
    },
    diagnostics
  };
}

async function applyNodeReorder(
  operation: FmgEntryNodeReorderOperation,
  input: { stagingRoot: string; workspaceRoot?: string }
): Promise<{ writtenTarget?: WriterWrittenTarget; diagnostics: StructuredDiagnostic[] }> {
  const identity = parseFmgEntryNodeId(operation.nodeId)!;
  const anchor = operation.beforeNodeId
    ? parseFmgEntryNodeId(operation.beforeNodeId)
    : undefined;
  const diagnostics: StructuredDiagnostic[] = [];
  const sourceState = await inspectOperationState({
    operation,
    sourcePath: operation.targetPath!,
    allowedRoots: [input.workspaceRoot ?? dirname(operation.targetPath!)],
    requireBoundHashes: true,
    phase: 'before_staging',
    expectBeforeState: true
  });
  diagnostics.push(...sourceState.diagnostics);
  if (!sourceState.data || sourceState.diagnostics.some((item) => item.severity === 'error')) {
    return { diagnostics };
  }

  const stagingPath = join(input.stagingRoot, stagingRelativeName(operation));
  await mkdir(dirname(stagingPath), { recursive: true });
  const write = await commitFmgMutationViaBridge({
    sourcePath: operation.targetPath!,
    outputPath: stagingPath,
    expectedDocumentHash: sourceState.data.sourceHash,
    allowedRoots: [input.workspaceRoot ?? dirname(operation.targetPath!), input.stagingRoot],
    writableRoots: [input.stagingRoot],
    mutation: {
      kind: 'reorder',
      id: identity.entryId,
      stringIndex: identity.stringIndex,
      ...(anchor
        ? { beforeId: anchor.entryId, beforeStringIndex: anchor.stringIndex }
        : {})
    }
  });
  diagnostics.push(...write.diagnostics.map((diagnostic) => createDiagnostic({
    severity: diagnostic.severity as StructuredDiagnostic['severity'],
    code: diagnostic.code,
    message: diagnostic.message,
    targetUri: operation.targetUri
  })));
  if (!write.ok) return { diagnostics };

  const stagedState = await inspectOperationState({
    operation,
    sourcePath: stagingPath,
    allowedRoots: [input.stagingRoot],
    requireBoundHashes: false,
    phase: 'staged_output'
  });
  diagnostics.push(...stagedState.diagnostics);
  if (!stagedState.data
    || stagedState.diagnostics.some((item) => item.severity === 'error')
    || write.outputHash !== stagedState.data.sourceHash) {
    if (stagedState.data && write.outputHash !== stagedState.data.sourceHash) {
      diagnostics.push(errorFor(
        operation,
        'FMG_SEMANTIC_STAGED_HASH_MISMATCH',
        'FMG writer 返回 hash 与暂存区重读结果不一致。'
      ));
    }
    return { diagnostics };
  }
  diagnostics.push(createDiagnostic({
    severity: 'info',
    code: 'FMG_SEMANTIC_STAGING_VERIFIED',
    message: 'FMG typed slot reorder 已由原生 writer 写入暂存区并完成完整顺序重读。',
    targetUri: operation.nodeId
  }));
  return {
    writtenTarget: {
      opId: operation.id,
      targetUri: operation.targetUri,
      targetPath: operation.targetPath!,
      stagingPath
    },
    diagnostics
  };
}

async function inspectOperationState(input: {
  operation: FmgSemanticOperation;
  sourcePath: string;
  allowedRoots: string[];
  requireBoundHashes: boolean;
  phase: string;
  expectBeforeState?: boolean;
}): Promise<{ data?: FmgBridgeDocument; diagnostics: StructuredDiagnostic[] }> {
  const result = await readFmgDocumentViaBridge({
    sourcePath: input.sourcePath,
    allowedRoots: input.allowedRoots
  });
  const diagnostics: StructuredDiagnostic[] = result.diagnostics.map((diagnostic) => createDiagnostic({
    severity: diagnostic.severity as StructuredDiagnostic['severity'],
    code: diagnostic.code,
    message: diagnostic.message,
    targetUri: input.operation.targetUri
  }));
  if (!result.ok || !result.data) {
    diagnostics.push(errorFor(
      input.operation,
      'FMG_SEMANTIC_DOCUMENT_READ_FAILED',
      `FMG semantic ${input.phase} 重读失败。`
    ));
    return { diagnostics };
  }

  if (isFmgEntryTextFieldOperation(input.operation)) {
    const identity = parseFmgEntryTextFieldUri(input.operation.fieldUri)!;
    const entry = result.data.entries[identity.stringIndex];
    const expectedValue = input.expectBeforeState || input.phase === 'before_staging' || input.phase === 'inverse_before'
      ? input.operation.previousValue.value
      : input.operation.nextValue.value;
    if (!entry || entry.id !== identity.entryId || entry.stringIndex !== identity.stringIndex) {
      diagnostics.push(errorFor(
        input.operation,
        'FMG_SEMANTIC_ENTRY_IDENTITY_MISMATCH',
        'FMG entry occurrence 与预期 ID/stringIndex 不一致。'
      ));
    } else if (entry.text !== expectedValue) {
      diagnostics.push(errorFor(
        input.operation,
        'FMG_SEMANTIC_VALUE_MISMATCH',
        `FMG text 与 ${input.phase} 预期 typed value 不一致。`
      ));
    }
    assertSchemaBinding(input.operation, result.data, diagnostics, input.requireBoundHashes);
    return { data: result.data, diagnostics };
  }

  if (isFmgEntryNodeDeleteOperation(input.operation)) {
    const identity = parseFmgEntryNodeId(input.operation.nodeId)!;
    const payload = input.operation.inverse.payload;
    const beforePhase = input.expectBeforeState
      || input.phase === 'before_staging'
      || input.phase === 'inverse_before';
    if (beforePhase) {
      const entry = result.data.entries[identity.stringIndex];
      if (!entry || entry.id !== identity.entryId || entry.stringIndex !== identity.stringIndex) {
        diagnostics.push(errorFor(
          input.operation,
          'FMG_SEMANTIC_ENTRY_IDENTITY_MISMATCH',
          'FMG delete 目标 occurrence 与预期 ID/stringIndex 不一致。'
        ));
      } else if (entry.text !== payload.text) {
        diagnostics.push(errorFor(
          input.operation,
          'FMG_SEMANTIC_VALUE_MISMATCH',
          `FMG delete 目标 text 与 ${input.phase} 预期 payload 不一致。`
        ));
      } else {
        const actual = buildFmgEntryNodePayload({
          entryId: entry.id,
          stringIndex: entry.stringIndex,
          text: entry.text,
          schemaVersion: result.data.schemaVersion
        });
        if (actual.snapshot.sha256.toLowerCase() !== input.operation.expectedNodeHash.toLowerCase()) {
          diagnostics.push(errorFor(
            input.operation,
            'FMG_SEMANTIC_NODE_HASH_MISMATCH',
            'FMG delete 目标 node hash 与 expectedNodeHash 不一致。'
          ));
        }
      }
    } else {
      // After delete: require entryCount-1 + preceding/shifted equality (Bridge contract).
      // Same-id/same-text neighbors must not false-fail via still-at-index heuristics.
      const beforeEntries = readFmgBeforeEntriesFromMetadata(input.operation.metadata);
      if (!beforeEntries) {
        diagnostics.push(errorFor(
          input.operation,
          'FMG_SEMANTIC_DELETE_BASELINE_MISSING',
          'FMG slot delete 后校验缺少 beforeEntries 基线。'
        ));
      } else {
        const applied = assertFmgSlotDeleteApplied({
          beforeEntries,
          afterEntries: result.data.entries,
          stringIndex: identity.stringIndex,
          entryId: identity.entryId,
          text: payload.text
        });
        if (!applied.ok) {
          diagnostics.push(errorFor(input.operation, applied.code, applied.message));
        }
      }
    }
    assertSchemaBinding(input.operation, result.data, diagnostics, input.requireBoundHashes);
    return { data: result.data, diagnostics };
  }

  if (isFmgEntryNodeReorderOperation(input.operation)) {
    const beforeEntries = readFmgBeforeEntriesFromMetadata(input.operation.metadata);
    if (!beforeEntries) {
      diagnostics.push(errorFor(
        input.operation,
        'FMG_SEMANTIC_REORDER_BASELINE_MISSING',
        'FMG slot reorder 校验缺少完整 beforeEntries 基线。'
      ));
    } else {
      const beforePhase = input.expectBeforeState
        || input.phase === 'before_staging'
        || input.phase === 'inverse_before';
      if (beforePhase) {
        const matched = assertFmgSlotOrderEquals({
          expectedEntries: beforeEntries,
          actualEntries: result.data.entries
        });
        if (!matched.ok) diagnostics.push(errorFor(input.operation, matched.code, matched.message));
      } else {
        const planned = reorderFmgEntrySlots({
          documentUri: input.operation.documentUri,
          beforeEntries,
          nodeId: input.operation.nodeId,
          beforeNodeId: input.operation.beforeNodeId
        });
        if (!planned.ok) {
          diagnostics.push(errorFor(input.operation, planned.code, planned.message));
        } else {
          const matched = assertFmgSlotOrderEquals({
            expectedEntries: planned.afterEntries,
            actualEntries: result.data.entries
          });
          if (!matched.ok) diagnostics.push(errorFor(input.operation, matched.code, matched.message));
        }
      }
    }
    assertSchemaBinding(input.operation, result.data, diagnostics, input.requireBoundHashes);
    return { data: result.data, diagnostics };
  }

  // resource_node_add
  const identity = parseFmgEntryNodeId(input.operation.nodeId)!;
  const payload = input.operation.payload;
  const beforePhase = input.expectBeforeState
    || input.phase === 'before_staging'
    || input.phase === 'inverse_before';
  if (beforePhase) {
    // Before insert, the slot must not already hold this exact restored identity at that index
    // when we are restoring a delete (insert into the hole). Adjacent content may exist.
    if (identity.stringIndex > result.data.entries.length) {
      diagnostics.push(errorFor(
        input.operation,
        'FMG_SEMANTIC_INSERT_INDEX_OUT_OF_RANGE',
        'FMG insert stringIndex 超出当前文档可插入范围。'
      ));
    }
  } else {
    const entry = result.data.entries[identity.stringIndex];
    if (!entry || entry.id !== identity.entryId || entry.stringIndex !== identity.stringIndex) {
      diagnostics.push(errorFor(
        input.operation,
        'FMG_SEMANTIC_ENTRY_IDENTITY_MISMATCH',
        'FMG insert 后 occurrence 与预期 ID/stringIndex 不一致。'
      ));
    } else if (entry.text !== payload.text) {
      diagnostics.push(errorFor(
        input.operation,
        'FMG_SEMANTIC_VALUE_MISMATCH',
        `FMG insert 后 text 与 ${input.phase} 预期 payload 不一致。`
      ));
    }
  }
  assertSchemaBinding(input.operation, result.data, diagnostics, input.requireBoundHashes);
  return { data: result.data, diagnostics };
}

function assertSchemaBinding(
  operation: FmgSemanticOperation,
  data: FmgBridgeDocument,
  diagnostics: StructuredDiagnostic[],
  requireBoundHashes: boolean
): void {
  const schemaId = typeof operation.metadata?.schemaId === 'string'
    ? operation.metadata.schemaId
    : undefined;
  const schemaVersion = typeof operation.metadata?.schemaVersion === 'string'
    ? operation.metadata.schemaVersion
    : isFmgEntryTextFieldOperation(operation)
      ? operation.schemaVersion
      : undefined;
  const layoutFingerprint = typeof operation.metadata?.layoutFingerprint === 'string'
    ? operation.metadata.layoutFingerprint
    : isFmgEntryTextFieldOperation(operation)
      ? operation.layoutFingerprint
      : undefined;
  if (isFmgEntryTextFieldOperation(operation)) {
    if (data.schemaId !== operation.schemaId
      || data.schemaVersion !== operation.schemaVersion
      || data.layoutFingerprint !== operation.layoutFingerprint) {
      diagnostics.push(errorFor(
        operation,
        'FMG_SEMANTIC_SCHEMA_BINDING_MISMATCH',
        'FMG schema/layout binding 与当前文档不一致。'
      ));
    }
  } else if (schemaId && schemaVersion && layoutFingerprint
    && (data.schemaId !== schemaId
      || data.schemaVersion !== schemaVersion
      || data.layoutFingerprint !== layoutFingerprint)) {
    diagnostics.push(errorFor(
      operation,
      'FMG_SEMANTIC_SCHEMA_BINDING_MISMATCH',
      'FMG schema/layout binding 与当前文档不一致。'
    ));
  }
  if (requireBoundHashes
    && (data.sourceHash !== operation.expectedHash
      || data.documentHash !== operation.expectedDocumentHash
      || data.documentRevision !== operation.documentRevision)) {
    diagnostics.push(errorFor(
      operation,
      'FMG_SEMANTIC_REVISION_MISMATCH',
      'FMG source/document hash 或 revision 已变化。'
    ));
  }
}

function stagingRelativeName(operation: PatchIrOperation): string {
  const base = basename(operation.targetPath ?? 'document.fmg');
  return join('fmg-semantic', operation.id, base);
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
    details: {
      operationId: operation.id,
      fieldUri: 'fieldUri' in operation ? operation.fieldUri : undefined,
      nodeId: 'nodeId' in operation ? operation.nodeId : undefined
    }
  });
}
