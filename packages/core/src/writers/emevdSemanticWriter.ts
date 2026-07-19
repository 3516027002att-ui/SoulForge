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
  commitEmevdMutationViaBridge,
  readEmevdDocumentViaBridge,
  type EmevdBridgeDocument
} from '../editing/emevdBridgeCommit.js';
import {
  EMEVD_SEMANTIC_WRITER_ID,
  assertEmevdEventOrderEquals,
  assertEmevdInstructionOrderEquals,
  emevdEventNodeUri,
  emevdEventOrderUris,
  emevdInstructionNodeUri,
  emevdInstructionOrderUris,
  hashEmevdEventOrder,
  hashEmevdInstructionOrder,
  isEmevdEventNodeAddOperation,
  isEmevdEventNodeDeleteOperation,
  isEmevdEventNodeReorderOperation,
  isEmevdInstructionArgsFieldOperation,
  isEmevdInstructionNodeAddOperation,
  isEmevdInstructionNodeDeleteOperation,
  isEmevdInstructionNodeReorderOperation,
  isEmevdRestBehaviorFieldOperation,
  isEmevdSemanticFieldOperation,
  isEmevdSemanticOperation,
  normalizeArgsBase64,
  parseEmevdEventNodeUri,
  parseEmevdInstructionArgsFieldUri,
  parseEmevdInstructionNodeUri,
  parseEmevdRestBehaviorFieldUri,
  readEmevdBeforeEventsFromMetadata,
  readEmevdBeforeInstructionsFromMetadata,
  reorderEmevdEventOrder,
  reorderEmevdInstructionOrder,
  snapshotEmevdEventOrder,
  snapshotEmevdInstructionOrder,
  type EmevdEventNodeReorderOperation,
  type EmevdInstructionArgsFieldOperation,
  type EmevdRestBehaviorFieldOperation,
  type EmevdSemanticFieldOperation,
  type EmevdSemanticOperation
} from '../editing/emevdSemanticContract.js';
import { hashPatchTypedValue } from '../patch/typedValueHash.js';

/**
 * Production semantic PatchIR writer for EMEVD typed fields and event add/delete/reorder.
 * Delegates all native parsing/rebuild authority to the C# Bridge and only
 * writes inside WorkspaceTransaction staging.
 */
export class EmevdSemanticWriter implements WriterAdapterContract {
  readonly writerId = EMEVD_SEMANTIC_WRITER_ID;
  readonly supportedResourceKinds = ['event'] as const;
  readonly supportedOperations = [
    'resource_field_edit',
    'resource_node_add',
    'resource_node_delete',
    'resource_node_reorder'
  ] as const;
  readonly inputSchemaVersion = 'soulforge.emevd.semantic.v1';
  readonly preconditions = [
    'outer source hash',
    'inner document hash',
    'schema/layout fingerprint',
    'event/instruction occurrence identity',
    'exact previous typed value',
    'high-risk confirmation',
    'staging only'
  ] as const;

  canHandle(operation: PatchIrOperation): boolean {
    return isEmevdSemanticOperation(operation);
  }

  writePlan(patch: PatchIR, operations: PatchIrOperation[]): WriterWritePlan {
    const handled = operations.filter((operation) => this.canHandle(operation));
    return {
      writerId: this.writerId,
      operations: handled,
      stagingRelativePaths: handled.map(stagingRelativeName),
      preconditions: handled.flatMap((operation) => operation.preconditions),
      estimatedRisk: 'high',
      notes: `EMEVD semantic field plan for patch ${patch.patchId}`
    };
  }

  async applyToStaging(input: {
    stagingRoot: string;
    operations: PatchIrOperation[];
    workspaceRoot?: string;
  }): Promise<WriterApplyResult> {
    const handled = input.operations.filter(isEmevdSemanticOperation);
    const writtenTargets: WriterWrittenTarget[] = [];
    const diagnostics: StructuredDiagnostic[] = [];

    for (const operation of handled) {
      const sourceState = await inspectOperationState({
        operation,
        sourcePath: operation.targetPath!,
        allowedRoots: [input.workspaceRoot ?? dirname(operation.targetPath!)],
        expectedPrevious: true,
        requireBoundHashes: true,
        phase: 'before_staging'
      });
      diagnostics.push(...sourceState.diagnostics);
      if (!sourceState.data || sourceState.diagnostics.some((item) => item.severity === 'error')) {
        continue;
      }
      if (isEmevdSemanticFieldOperation(operation)
        && typedValuesEqual(operation.previousValue, operation.nextValue)) {
        diagnostics.push(errorFor(
          operation,
          'EMEVD_SEMANTIC_NOOP_BLOCKED',
          'EMEVD semantic field mutation 必须改变目标值。'
        ));
        continue;
      }

      const stagingPath = join(input.stagingRoot, stagingRelativeName(operation));
      await mkdir(dirname(stagingPath), { recursive: true });
      const mutation = bridgeMutationFor(operation);
      const write = await commitEmevdMutationViaBridge({
        sourcePath: operation.targetPath!,
        outputPath: stagingPath,
        expectedSourceHash: sourceState.data.sourceHash,
        allowedRoots: [input.workspaceRoot ?? dirname(operation.targetPath!), input.stagingRoot],
        writableRoots: [input.stagingRoot],
        mutation
      });
      diagnostics.push(...write.diagnostics.map((diagnostic) => createDiagnostic({
        severity: diagnostic.severity as StructuredDiagnostic['severity'],
        code: diagnostic.code,
        message: diagnostic.message,
        targetUri: operation.targetUri
      })));
      if (!write.ok) continue;

      const stagedState = await inspectOperationState({
        operation,
        sourcePath: stagingPath,
        allowedRoots: [input.stagingRoot],
        expectedPrevious: false,
        requireBoundHashes: false,
        phase: 'staged_output'
      });
      diagnostics.push(...stagedState.diagnostics);
      if (!stagedState.data
        || stagedState.diagnostics.some((item) => item.severity === 'error')
        || write.outputHash !== stagedState.data.sourceHash
        || write.documentHash !== stagedState.data.documentHash) {
        if (stagedState.data
          && (write.outputHash !== stagedState.data.sourceHash
            || write.documentHash !== stagedState.data.documentHash)) {
          diagnostics.push(errorFor(
            operation,
            'EMEVD_SEMANTIC_STAGED_HASH_MISMATCH',
            'EMEVD writer 返回 hash 与暂存区重读结果不一致。'
          ));
        }
        continue;
      }
      diagnostics.push(createDiagnostic({
        severity: 'info',
        code: 'EMEVD_SEMANTIC_STAGING_VERIFIED',
        message: 'EMEVD typed mutation 已由原生 writer 写入暂存区并完成语义重读。',
        targetUri: 'fieldUri' in operation ? operation.fieldUri : operation.nodeId
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
    const operations = input.operations.filter(isEmevdSemanticOperation);
    const diagnostics: StructuredDiagnostic[] = [];
    const validatedOperationIds: string[] = [];
    for (const operation of operations) {
      const target = input.writtenTargets.find((item) => item.opId === operation.id);
      if (!target) {
        diagnostics.push(errorFor(
          operation,
          'EMEVD_SEMANTIC_POST_VALIDATE_TARGET_MISSING',
          'EMEVD semantic postValidate 缺少显式暂存映射。'
        ));
        continue;
      }
      const state = await inspectOperationState({
        operation,
        sourcePath: target.stagingPath,
        allowedRoots: [input.stagingRoot],
        expectedPrevious: false,
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
      if (!isEmevdSemanticOperation(operation)) continue;
      const target = input.stagedTargets.find((item) => item.opId === operation.id);
      if (!target) {
        diagnostics.push(errorFor(
          operation,
          'EMEVD_SEMANTIC_INVERSE_STAGING_MISSING',
          'EMEVD semantic inverse 捕获缺少对应暂存输出。'
        ));
        continue;
      }
      const before = await inspectOperationState({
        operation,
        sourcePath: operation.targetPath!,
        allowedRoots: [input.workspaceRoot],
        expectedPrevious: true,
        requireBoundHashes: true,
        phase: 'inverse_before'
      });
      const after = await inspectOperationState({
        operation,
        sourcePath: target.stagingPath,
        allowedRoots: [dirname(target.stagingPath)],
        expectedPrevious: false,
        requireBoundHashes: false,
        phase: 'inverse_after'
      });
      diagnostics.push(...before.diagnostics, ...after.diagnostics);
      if (!before.data || !after.data
        || before.diagnostics.some((item) => item.severity === 'error')
        || after.diagnostics.some((item) => item.severity === 'error')) {
        continue;
      }

      if (isEmevdEventNodeAddOperation(operation)) {
        const payload = structuredClone(operation.payload);
        const inverse: ResourceNodeDeleteOp = {
          ...operation,
          id: randomUUID(),
          kind: 'resource_node_delete',
          expectedHash: after.data.sourceHash,
          expectedDocumentHash: after.data.documentHash,
          documentRevision: after.data.documentRevision,
          expectedNodeHash: payload.eventHash,
          inverse: {
            kind: 'resource_node_add',
            nodeId: operation.nodeId,
            payload
          },
          preconditions: operation.preconditions.map((precondition) => (
            precondition.type === 'content_hash'
              ? { ...precondition, expectedHash: after.data!.sourceHash }
              : precondition.type === 'custom'
                ? {
                    ...precondition,
                    details: {
                      expectedOrderHash: hashEmevdEventOrder(snapshotEmevdEventOrder(after.data!.events)),
                      eventCount: after.data!.events.length
                    }
                  }
                : precondition
          )),
          rollbackHint: {
            strategy: 'inverse_patch',
            notes: `EMEVD 新事件 ${operation.nodeId} 的精确 typed delete inverse`
          },
          metadata: {
            ...operation.metadata,
            inverseResourceEntry: true,
            entryUri: operation.nodeId,
            forwardOperationId: operation.id,
            eventDeleteMode: 'snapshot_bound',
            instructionCount: after.data.events[payload.eventIndex]?.instructionCount,
            parameterCount: after.data.events[payload.eventIndex]?.parameterCount,
            beforeEvents: snapshotEmevdEventOrder(after.data.events)
          }
        };
        changes.push({
          id: randomUUID(),
          resourceUri: operation.targetUri,
          entryUri: operation.nodeId,
          changeKind: 'node_add',
          beforeHash: payload.eventHash,
          afterHash: payload.eventHash,
          inverse
        });
        capturedOperationIds.push(operation.id);
        continue;
      }

      if (isEmevdEventNodeDeleteOperation(operation)) {
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
            expectedNodeHash: payload.eventHash
          },
          preconditions: operation.preconditions.map((precondition) => (
            precondition.type === 'content_hash'
              ? { ...precondition, expectedHash: after.data!.sourceHash }
              : precondition.type === 'custom'
                ? {
                    ...precondition,
                    details: {
                      expectedOrderHash: hashEmevdEventOrder(snapshotEmevdEventOrder(after.data!.events)),
                      eventCount: after.data!.events.length
                    }
                  }
                : precondition
          )),
          rollbackHint: {
            strategy: 'inverse_patch',
            notes: `EMEVD 空事件 ${operation.nodeId} 的精确 typed append inverse`
          },
          metadata: {
            ...operation.metadata,
            inverseResourceEntry: true,
            entryUri: operation.nodeId,
            forwardOperationId: operation.id,
            eventAddMode: 'snapshot_insert',
            beforeEvents: snapshotEmevdEventOrder(after.data.events)
          }
        };
        changes.push({
          id: randomUUID(),
          resourceUri: operation.targetUri,
          entryUri: operation.nodeId,
          changeKind: 'node_delete',
          beforeHash: operation.expectedNodeHash,
          afterHash: payload.eventHash,
          inverse
        });
        capturedOperationIds.push(operation.id);
        continue;
      }

      if (isEmevdEventNodeReorderOperation(operation)) {
        const beforeEvents = snapshotEmevdEventOrder(before.data.events);
        const afterEvents = snapshotEmevdEventOrder(after.data.events);
        const planned = reorderEmevdEventOrder({
          beforeEvents,
          nodeId: operation.nodeId,
          beforeNodeId: operation.beforeNodeId
        });
        if (!planned.ok) {
          diagnostics.push(errorFor(operation, planned.code, planned.message));
          continue;
        }
        const targetIdentity = parseEmevdEventNodeUri(operation.nodeId)!;
        const originalFollowerIndex = targetIdentity.eventIndex + 1 < beforeEvents.length
          ? targetIdentity.eventIndex + 1
          : undefined;
        const inverseNodeId = emevdEventNodeUri({
          documentUri: operation.documentUri,
          eventId: targetIdentity.eventId,
          eventIndex: planned.movedEventIndex
        });
        const inverseBeforeNodeId = originalFollowerIndex === undefined
          ? undefined
          : (() => {
              const followerIndex = planned.afterOriginalIndexes.indexOf(originalFollowerIndex);
              const follower = beforeEvents[originalFollowerIndex];
              return followerIndex >= 0 && follower
                ? emevdEventNodeUri({
                    documentUri: operation.documentUri,
                    eventId: follower.id,
                    eventIndex: followerIndex
                  })
                : undefined;
            })();
        if (originalFollowerIndex !== undefined && !inverseBeforeNodeId) {
          diagnostics.push(errorFor(
            operation,
            'EMEVD_SEMANTIC_REORDER_INVERSE_ANCHOR_MISSING',
            'EMEVD reorder inverse 无法定位原始后继事件。'
          ));
          continue;
        }
        const inverseExpectedOrder = emevdEventOrderUris(operation.documentUri, afterEvents);
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
                      expectedOrderHash: hashEmevdEventOrder(afterEvents),
                      eventCount: afterEvents.length
                    }
                  }
                : precondition
          )),
          rollbackHint: {
            strategy: 'inverse_patch',
            notes: `EMEVD 事件 ${operation.nodeId} 的完整顺序 typed inverse`
          },
          metadata: {
            ...operation.metadata,
            inverseResourceEntry: true,
            entryUri: inverseNodeId,
            forwardOperationId: operation.id,
            eventId: targetIdentity.eventId,
            eventIndex: planned.movedEventIndex,
            eventHash: afterEvents[planned.movedEventIndex]?.eventHash,
            beforeEventId: inverseBeforeNodeId
              ? parseEmevdEventNodeUri(inverseBeforeNodeId)?.eventId
              : undefined,
            beforeEventIndex: inverseBeforeNodeId
              ? parseEmevdEventNodeUri(inverseBeforeNodeId)?.eventIndex
              : undefined,
            beforeEvents: afterEvents
          }
        };
        if (inverseBeforeNodeId) inverse.beforeNodeId = inverseBeforeNodeId;
        else delete inverse.beforeNodeId;
        changes.push({
          id: randomUUID(),
          resourceUri: operation.targetUri,
          entryUri: inverseNodeId,
          changeKind: 'node_reorder',
          beforeHash: hashEmevdEventOrder(beforeEvents),
          afterHash: hashEmevdEventOrder(afterEvents),
          inverse
        });
        capturedOperationIds.push(operation.id);
        continue;
      }

      if (isEmevdInstructionNodeAddOperation(operation)) {
        const payload = structuredClone(operation.payload);
        const afterOrder = after.data.focusedEventInstructionOrder;
        const afterEvent = after.data.events[payload.eventIndex];
        if (!afterOrder || !afterEvent) {
          diagnostics.push(errorFor(
            operation,
            'EMEVD_SEMANTIC_INSTRUCTION_INVERSE_BASELINE_MISSING',
            'EMEVD instruction add inverse 缺少提交后的完整父事件顺序。'
          ));
          continue;
        }
        const inverse: ResourceNodeDeleteOp = {
          ...operation,
          id: randomUUID(),
          kind: 'resource_node_delete',
          expectedHash: after.data.sourceHash,
          expectedDocumentHash: after.data.documentHash,
          documentRevision: after.data.documentRevision,
          expectedNodeHash: payload.instructionHash,
          inverse: {
            kind: 'resource_node_add',
            nodeId: operation.nodeId,
            payload
          },
          preconditions: updateInstructionInversePreconditions(
            operation.preconditions,
            after.data.sourceHash,
            afterOrder.instructions
          ),
          rollbackHint: {
            strategy: 'inverse_patch',
            notes: `EMEVD 新指令 ${operation.nodeId} 的精确 typed delete inverse`
          },
          metadata: {
            ...operation.metadata,
            inverseResourceEntry: true,
            entryUri: operation.nodeId,
            forwardOperationId: operation.id,
            instructionDeleteMode: 'snapshot_bound',
            beforeEvents: snapshotEmevdEventOrder(after.data.events),
            beforeInstructions: snapshotEmevdInstructionOrder(afterOrder.instructions),
            beforeInstructionEvent: instructionParentMetadata(afterEvent)
          }
        };
        changes.push({
          id: randomUUID(),
          resourceUri: operation.targetUri,
          entryUri: operation.nodeId,
          changeKind: 'node_add',
          beforeHash: payload.instructionHash,
          afterHash: payload.instructionHash,
          inverse
        });
        capturedOperationIds.push(operation.id);
        continue;
      }

      if (isEmevdInstructionNodeDeleteOperation(operation)) {
        const payload = structuredClone(operation.inverse.payload);
        const afterOrder = after.data.focusedEventInstructionOrder;
        const afterEvent = after.data.events[payload.eventIndex];
        if (!afterOrder || !afterEvent) {
          diagnostics.push(errorFor(
            operation,
            'EMEVD_SEMANTIC_INSTRUCTION_INVERSE_BASELINE_MISSING',
            'EMEVD instruction delete inverse 缺少提交后的完整父事件顺序。'
          ));
          continue;
        }
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
            expectedNodeHash: payload.instructionHash
          },
          preconditions: updateInstructionInversePreconditions(
            operation.preconditions,
            after.data.sourceHash,
            afterOrder.instructions
          ),
          rollbackHint: {
            strategy: 'inverse_patch',
            notes: `EMEVD 指令 ${operation.nodeId} 的精确 snapshot insert inverse`
          },
          metadata: {
            ...operation.metadata,
            inverseResourceEntry: true,
            entryUri: operation.nodeId,
            forwardOperationId: operation.id,
            instructionAddMode: 'snapshot_insert',
            beforeEvents: snapshotEmevdEventOrder(after.data.events),
            beforeInstructions: snapshotEmevdInstructionOrder(afterOrder.instructions),
            beforeInstructionEvent: instructionParentMetadata(afterEvent)
          }
        };
        changes.push({
          id: randomUUID(),
          resourceUri: operation.targetUri,
          entryUri: operation.nodeId,
          changeKind: 'node_delete',
          beforeHash: operation.expectedNodeHash,
          afterHash: payload.instructionHash,
          inverse
        });
        capturedOperationIds.push(operation.id);
        continue;
      }

      if (isEmevdInstructionNodeReorderOperation(operation)) {
        const beforeOrder = before.data.focusedEventInstructionOrder;
        const afterOrder = after.data.focusedEventInstructionOrder;
        const identity = parseEmevdInstructionNodeUri(operation.nodeId)!;
        const afterEvent = after.data.events[identity.eventIndex];
        if (!beforeOrder || !afterOrder || !afterEvent) {
          diagnostics.push(errorFor(
            operation,
            'EMEVD_SEMANTIC_INSTRUCTION_INVERSE_BASELINE_MISSING',
            'EMEVD instruction reorder inverse 缺少完整父事件顺序。'
          ));
          continue;
        }
        const beforeInstructions = snapshotEmevdInstructionOrder(beforeOrder.instructions);
        const afterInstructions = snapshotEmevdInstructionOrder(afterOrder.instructions);
        const planned = reorderEmevdInstructionOrder({
          documentUri: operation.documentUri,
          eventId: identity.eventId,
          eventIndex: identity.eventIndex,
          beforeInstructions,
          nodeId: operation.nodeId,
          beforeNodeId: operation.beforeNodeId
        });
        if (!planned.ok) {
          diagnostics.push(errorFor(operation, planned.code, planned.message));
          continue;
        }
        const targetInstruction = beforeInstructions[identity.instructionIndex]!;
        const inverseNodeId = emevdInstructionNodeUri({
          documentUri: operation.documentUri,
          eventId: identity.eventId,
          eventIndex: identity.eventIndex,
          instructionIndex: planned.movedInstructionIndex,
          bank: targetInstruction.bank,
          instructionId: targetInstruction.id
        });
        const originalFollowerIndex = identity.instructionIndex + 1 < beforeInstructions.length
          ? identity.instructionIndex + 1
          : undefined;
        const inverseBeforeNodeId = originalFollowerIndex === undefined
          ? undefined
          : (() => {
              const followerIndex = planned.afterOriginalIndexes.indexOf(originalFollowerIndex);
              const follower = beforeInstructions[originalFollowerIndex];
              return followerIndex >= 0 && follower
                ? emevdInstructionNodeUri({
                    documentUri: operation.documentUri,
                    eventId: identity.eventId,
                    eventIndex: identity.eventIndex,
                    instructionIndex: followerIndex,
                    bank: follower.bank,
                    instructionId: follower.id
                  })
                : undefined;
            })();
        if (originalFollowerIndex !== undefined && !inverseBeforeNodeId) {
          diagnostics.push(errorFor(
            operation,
            'EMEVD_SEMANTIC_INSTRUCTION_REORDER_INVERSE_ANCHOR_MISSING',
            'EMEVD instruction reorder inverse 无法定位原始后继指令。'
          ));
          continue;
        }
        const inverseExpectedOrder = emevdInstructionOrderUris({
          documentUri: operation.documentUri,
          eventId: identity.eventId,
          eventIndex: identity.eventIndex,
          instructions: afterInstructions
        });
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
          preconditions: updateInstructionInversePreconditions(
            operation.preconditions,
            after.data.sourceHash,
            afterInstructions
          ),
          rollbackHint: {
            strategy: 'inverse_patch',
            notes: `EMEVD 指令 ${operation.nodeId} 的完整顺序 typed inverse`
          },
          metadata: {
            ...operation.metadata,
            inverseResourceEntry: true,
            entryUri: inverseNodeId,
            forwardOperationId: operation.id,
            beforeEvents: snapshotEmevdEventOrder(after.data.events),
            beforeInstructions: afterInstructions,
            beforeInstructionEvent: instructionParentMetadata(afterEvent)
          }
        };
        if (inverseBeforeNodeId) inverse.beforeNodeId = inverseBeforeNodeId;
        else delete inverse.beforeNodeId;
        changes.push({
          id: randomUUID(),
          resourceUri: operation.targetUri,
          entryUri: inverseNodeId,
          changeKind: 'node_reorder',
          beforeHash: hashEmevdInstructionOrder(beforeInstructions),
          afterHash: hashEmevdInstructionOrder(afterInstructions),
          inverse
        });
        capturedOperationIds.push(operation.id);
        continue;
      }

      if (!isEmevdSemanticFieldOperation(operation)) {
        diagnostics.push(errorFor(
          operation,
          'EMEVD_SEMANTIC_INVERSE_OPERATION_UNREACHABLE',
          'EMEVD semantic inverse 未进入任何受支持分支。'
        ));
        continue;
      }
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
          notes: `EMEVD 字段 ${operation.fieldUri} 的精确 typed inverse`
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
        && capturedOperationIds.length === input.operations.filter(isEmevdSemanticOperation).length,
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
      notes: `EMEVD semantic writer rollback metadata for ${input.operations.length} operation(s)`
    };
  }
}

function bridgeMutationFor(operation: EmevdSemanticOperation) {
  if (isEmevdEventNodeAddOperation(operation)) {
    if (operation.metadata?.eventAddMode === 'snapshot_insert'
      || operation.metadata?.eventAddMode === 'snapshot_clone_append') {
      if (operation.payload.snapshot.storage !== 'inline') {
        throw new Error('EMEVD snapshot insert 只接受已通过 PatchIR 校验的 inline snapshot。');
      }
      return {
        kind: 'insert_event_snapshot' as const,
        eventId: operation.payload.eventId,
        insertEventIndex: operation.payload.eventIndex,
        expectedEventHash: operation.payload.eventHash,
        snapshotFormatId: operation.payload.snapshot.formatId,
        snapshotSchemaVersion: operation.payload.snapshot.schemaVersion,
        snapshotBase64: operation.payload.snapshot.dataBase64,
        snapshotSha256: operation.payload.snapshot.sha256
      };
    }
    return {
      kind: 'add_event' as const,
      newEventId: operation.payload.eventId,
      restBehavior: operation.payload.restartType
    };
  }
  if (isEmevdEventNodeDeleteOperation(operation)) {
    const identity = parseEmevdEventNodeUri(operation.nodeId)!;
    return {
      kind: 'delete_event' as const,
      eventId: identity.eventId,
      eventIndex: identity.eventIndex
    };
  }
  if (isEmevdEventNodeReorderOperation(operation)) {
    const identity = parseEmevdEventNodeUri(operation.nodeId)!;
    const anchor = operation.beforeNodeId
      ? parseEmevdEventNodeUri(operation.beforeNodeId)
      : undefined;
    return {
      kind: 'reorder_event' as const,
      eventId: identity.eventId,
      eventIndex: identity.eventIndex,
      ...(anchor
        ? { beforeEventId: anchor.eventId, beforeEventIndex: anchor.eventIndex }
        : {})
    };
  }
  if (isEmevdInstructionNodeAddOperation(operation)) {
    if (operation.payload.snapshot.storage !== 'inline') {
      throw new Error('EMEVD instruction snapshot insert 只接受已通过 PatchIR 校验的 inline snapshot。');
    }
    return {
      kind: 'insert_instruction_snapshot' as const,
      eventId: operation.payload.eventId,
      eventIndex: operation.payload.eventIndex,
      insertInstructionIndex: operation.payload.instructionIndex,
      expectedInstructionHash: operation.payload.instructionHash,
      snapshotFormatId: operation.payload.snapshot.formatId,
      snapshotSchemaVersion: operation.payload.snapshot.schemaVersion,
      snapshotBase64: operation.payload.snapshot.dataBase64,
      snapshotSha256: operation.payload.snapshot.sha256
    };
  }
  if (isEmevdInstructionNodeDeleteOperation(operation)) {
    const identity = parseEmevdInstructionNodeUri(operation.nodeId)!;
    return {
      kind: 'delete_instruction' as const,
      eventId: identity.eventId,
      eventIndex: identity.eventIndex,
      instructionIndex: identity.instructionIndex,
      expectedBank: identity.bank,
      expectedInstructionId: identity.instructionId
    };
  }
  if (isEmevdInstructionNodeReorderOperation(operation)) {
    const identity = parseEmevdInstructionNodeUri(operation.nodeId)!;
    const anchor = operation.beforeNodeId
      ? parseEmevdInstructionNodeUri(operation.beforeNodeId)!
      : undefined;
    return {
      kind: 'reorder_instruction' as const,
      eventId: identity.eventId,
      eventIndex: identity.eventIndex,
      instructionIndex: identity.instructionIndex,
      expectedBank: identity.bank,
      expectedInstructionId: identity.instructionId,
      ...(anchor
        ? {
            beforeInstructionIndex: anchor.instructionIndex,
            beforeExpectedBank: anchor.bank,
            beforeExpectedInstructionId: anchor.instructionId
          }
        : {})
    };
  }
  if (isEmevdRestBehaviorFieldOperation(operation)) {
    const identity = parseEmevdRestBehaviorFieldUri(operation.fieldUri)!;
    return {
      kind: 'set_rest_behavior' as const,
      eventId: identity.eventId,
      eventIndex: identity.eventIndex,
      restBehavior: operation.nextValue.value
    };
  }
  const identity = parseEmevdInstructionArgsFieldUri(operation.fieldUri)!;
  return {
    kind: 'set_instruction_args' as const,
    eventId: identity.eventId,
    eventIndex: identity.eventIndex,
    instructionLocalIndex: identity.instructionIndex,
    expectedBank: identity.bank,
    expectedInstructionId: identity.instructionId,
    argsBase64: operation.nextValue.base64
  };
}

async function inspectOperationState(input: {
  operation: EmevdSemanticOperation;
  sourcePath: string;
  allowedRoots: string[];
  expectedPrevious: boolean;
  requireBoundHashes: boolean;
  phase: string;
}): Promise<{ data?: EmevdBridgeDocument; diagnostics: StructuredDiagnostic[] }> {
  const focus = isEmevdInstructionArgsFieldOperation(input.operation)
    ? parseEmevdInstructionArgsFieldUri(input.operation.fieldUri)!
    : undefined;
  const instructionNodeIdentity = isEmevdInstructionNodeAddOperation(input.operation)
    || isEmevdInstructionNodeDeleteOperation(input.operation)
    || isEmevdInstructionNodeReorderOperation(input.operation)
    ? parseEmevdInstructionNodeUri(input.operation.nodeId)!
    : undefined;
  const result = await readEmevdDocumentViaBridge({
    sourcePath: input.sourcePath,
    allowedRoots: input.allowedRoots,
    ...(focus
      ? {
          focusEventIndex: focus.eventIndex,
          focusInstructionLocalIndex: focus.instructionIndex
        }
      : {}),
    ...(instructionNodeIdentity
      ? { instructionOrderEventIndex: instructionNodeIdentity.eventIndex }
      : {})
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
      'EMEVD_SEMANTIC_DOCUMENT_READ_FAILED',
      `EMEVD semantic ${input.phase} 重读失败。`
    ));
    return { diagnostics };
  }

  if (isEmevdEventNodeAddOperation(input.operation)) {
    const beforeEvents = readEmevdBeforeEventsFromMetadata(input.operation.metadata);
    if (!beforeEvents) {
      diagnostics.push(errorFor(
        input.operation,
        'EMEVD_SEMANTIC_ADD_BASELINE_INVALID',
        'EMEVD event add metadata 缺少完整合法的事件 semantic hash 顺序。'
      ));
    } else {
      const expectedEvents = [...beforeEvents];
      if (!input.expectedPrevious) {
        expectedEvents.splice(input.operation.payload.eventIndex, 0, {
          id: input.operation.payload.eventId,
          eventHash: input.operation.payload.eventHash
        });
      }
      const matched = assertEmevdEventOrderEquals({
        expectedEvents,
        actualEvents: result.data.events
      });
      if (!matched.ok) diagnostics.push(errorFor(input.operation, matched.code, matched.message));
      if (!input.expectedPrevious) {
        const added = result.data.events[input.operation.payload.eventIndex];
        if (!added
          || added.id !== input.operation.payload.eventId
          || added.eventIndex !== input.operation.payload.eventIndex
          || added.eventHash !== input.operation.payload.eventHash
          || added.restBehavior !== input.operation.payload.restartType
          || (input.operation.metadata?.eventAddMode === 'empty_append'
            && (added.instructionCount !== 0 || added.parameterCount !== 0))
          || metadataCountMismatch(input.operation.metadata, 'instructionCount', added.instructionCount)
          || metadataCountMismatch(input.operation.metadata, 'parameterCount', added.parameterCount)) {
          diagnostics.push(errorFor(
            input.operation,
            'EMEVD_SEMANTIC_ADD_PAYLOAD_MISMATCH',
            'EMEVD event add 后的 restBehavior 或空指令约束与 typed payload 不一致。'
          ));
        }
      }
    }
  } else if (isEmevdEventNodeDeleteOperation(input.operation)) {
    const beforeEvents = readEmevdBeforeEventsFromMetadata(input.operation.metadata);
    const identity = parseEmevdEventNodeUri(input.operation.nodeId)!;
    if (!beforeEvents) {
      diagnostics.push(errorFor(
        input.operation,
        'EMEVD_SEMANTIC_DELETE_BASELINE_INVALID',
        'EMEVD event delete metadata 缺少完整合法的事件 semantic hash 顺序。'
      ));
    } else {
      const expectedEvents = input.expectedPrevious
        ? beforeEvents
        : beforeEvents.filter((_, index) => index !== identity.eventIndex);
      const matched = assertEmevdEventOrderEquals({
        expectedEvents,
        actualEvents: result.data.events
      });
      if (!matched.ok) diagnostics.push(errorFor(input.operation, matched.code, matched.message));
      if (input.expectedPrevious) {
        const target = result.data.events[identity.eventIndex];
        const payload = input.operation.inverse.payload;
        if (!target
          || target.id !== identity.eventId
          || target.eventIndex !== identity.eventIndex
          || target.eventHash !== input.operation.expectedNodeHash
          || target.restBehavior !== payload.restartType
          || metadataCountMismatch(input.operation.metadata, 'instructionCount', target.instructionCount)
          || metadataCountMismatch(input.operation.metadata, 'parameterCount', target.parameterCount)) {
          diagnostics.push(errorFor(
            input.operation,
            'EMEVD_SEMANTIC_DELETE_PAYLOAD_MISMATCH',
            'EMEVD event delete 前目标 occurrence 与空事件 snapshot 不一致。'
          ));
        }
      }
    }
  } else if (isEmevdEventNodeReorderOperation(input.operation)) {
    const beforeEvents = readEmevdBeforeEventsFromMetadata(input.operation.metadata);
    if (!beforeEvents || beforeEvents.length !== result.data.events.length) {
      diagnostics.push(errorFor(
        input.operation,
        'EMEVD_SEMANTIC_REORDER_BASELINE_INVALID',
        'EMEVD reorder metadata 缺少完整合法的事件 semantic hash 顺序。'
      ));
    } else if (input.expectedPrevious) {
      const matched = assertEmevdEventOrderEquals({
        expectedEvents: beforeEvents,
        actualEvents: result.data.events
      });
      if (!matched.ok) diagnostics.push(errorFor(input.operation, matched.code, matched.message));
    } else {
      const planned = reorderEmevdEventOrder({
        beforeEvents,
        nodeId: input.operation.nodeId,
        beforeNodeId: input.operation.beforeNodeId
      });
      if (!planned.ok) {
        diagnostics.push(errorFor(input.operation, planned.code, planned.message));
      } else {
        const matched = assertEmevdEventOrderEquals({
          expectedEvents: planned.afterEvents,
          actualEvents: result.data.events
        });
        if (!matched.ok) diagnostics.push(errorFor(input.operation, matched.code, matched.message));
      }
    }
  } else if (isEmevdInstructionNodeAddOperation(input.operation)
    || isEmevdInstructionNodeDeleteOperation(input.operation)
    || isEmevdInstructionNodeReorderOperation(input.operation)) {
    const identity = parseEmevdInstructionNodeUri(input.operation.nodeId)!;
    const beforeInstructions = readEmevdBeforeInstructionsFromMetadata(input.operation.metadata);
    const beforeEvents = readEmevdBeforeEventsFromMetadata(input.operation.metadata);
    const parent = input.operation.metadata?.beforeInstructionEvent as {
      eventId?: unknown;
      eventIndex?: unknown;
      eventHash?: unknown;
      parameterCount?: unknown;
    } | undefined;
    const order = result.data.focusedEventInstructionOrder;
    if (!beforeInstructions
      || !beforeEvents
      || !parent
      || parent.eventId !== identity.eventId
      || parent.eventIndex !== identity.eventIndex
      || typeof parent.eventHash !== 'string'
      || !Number.isSafeInteger(parent.parameterCount)
      || !order
      || order.eventId !== identity.eventId
      || order.eventIndex !== identity.eventIndex) {
      diagnostics.push(errorFor(
        input.operation,
        'EMEVD_SEMANTIC_INSTRUCTION_BASELINE_INVALID',
        'EMEVD instruction mutation 缺少完整的父事件和指令顺序证据。'
      ));
    } else {
      let expectedInstructions = snapshotEmevdInstructionOrder(beforeInstructions);
      if (!input.expectedPrevious) {
        if (isEmevdInstructionNodeAddOperation(input.operation)) {
          expectedInstructions.splice(identity.instructionIndex, 0, {
            bank: input.operation.payload.bank,
            id: input.operation.payload.instructionId,
            instructionHash: input.operation.payload.instructionHash,
            parameterCount: input.operation.payload.parameterCount
          });
        } else if (isEmevdInstructionNodeDeleteOperation(input.operation)) {
          expectedInstructions.splice(identity.instructionIndex, 1);
        } else {
          const planned = reorderEmevdInstructionOrder({
            documentUri: input.operation.documentUri,
            eventId: identity.eventId,
            eventIndex: identity.eventIndex,
            beforeInstructions,
            nodeId: input.operation.nodeId,
            beforeNodeId: input.operation.beforeNodeId!
          });
          if (!planned.ok) {
            diagnostics.push(errorFor(input.operation, planned.code, planned.message));
          } else {
            expectedInstructions = planned.afterInstructions;
          }
        }
      }
      const matched = assertEmevdInstructionOrderEquals({
        expectedInstructions,
        actualInstructions: order.instructions
      });
      if (!matched.ok) diagnostics.push(errorFor(input.operation, matched.code, matched.message));
      const expectedParameterCount = expectedInstructions.reduce(
        (count, instruction) => count + instruction.parameterCount,
        0
      );
      const targetEvent = result.data.events[identity.eventIndex];
      if (!targetEvent
        || targetEvent.id !== identity.eventId
        || order.eventHash !== targetEvent.eventHash
        || order.instructionCount !== expectedInstructions.length
        || order.parameterCount !== expectedParameterCount
        || (input.expectedPrevious
          ? targetEvent.eventHash !== parent.eventHash
          : targetEvent.eventHash === parent.eventHash)) {
        diagnostics.push(errorFor(
          input.operation,
          'EMEVD_SEMANTIC_INSTRUCTION_PARENT_MISMATCH',
          `EMEVD instruction mutation的父事件与 ${input.phase} 完整预期不一致。`
        ));
      }
      if (result.data.events.length !== beforeEvents.length
        || result.data.events.some((event, eventIndex) => {
          const beforeEvent = beforeEvents[eventIndex];
          return !beforeEvent
            || event.id !== beforeEvent.id
            || (eventIndex !== identity.eventIndex && event.eventHash !== beforeEvent.eventHash);
        })) {
        diagnostics.push(errorFor(
          input.operation,
          'EMEVD_SEMANTIC_INSTRUCTION_ISOLATION_MISMATCH',
          'EMEVD instruction mutation改变了目标父事件以外的事件或事件顺序。'
        ));
      }
    }
  } else if (isEmevdRestBehaviorFieldOperation(input.operation)) {
    const identity = parseEmevdRestBehaviorFieldUri(input.operation.fieldUri)!;
    const event = result.data.events[identity.eventIndex];
    const expected = input.expectedPrevious
      ? input.operation.previousValue.value
      : input.operation.nextValue.value;
    if (!event || event.id !== identity.eventId || event.eventIndex !== identity.eventIndex) {
      diagnostics.push(errorFor(
        input.operation,
        'EMEVD_SEMANTIC_EVENT_IDENTITY_MISMATCH',
        'EMEVD event occurrence 与预期 ID/index 不一致。'
      ));
    } else if (event.restBehavior !== expected) {
      diagnostics.push(errorFor(
        input.operation,
        'EMEVD_SEMANTIC_PREVIOUS_VALUE_MISMATCH',
        `EMEVD restBehavior 与 ${input.phase} 预期 typed value 不一致。`
      ));
    }
  } else if (isEmevdInstructionArgsFieldOperation(input.operation)) {
    const identity = parseEmevdInstructionArgsFieldUri(input.operation.fieldUri)!;
    const event = result.data.events[identity.eventIndex];
    const expectedBase64 = input.expectedPrevious
      ? input.operation.previousValue.base64
      : input.operation.nextValue.base64;
    if (!event || event.id !== identity.eventId || event.eventIndex !== identity.eventIndex) {
      diagnostics.push(errorFor(
        input.operation,
        'EMEVD_SEMANTIC_EVENT_IDENTITY_MISMATCH',
        'EMEVD event occurrence 与预期 ID/index 不一致。'
      ));
    }
    const focused = result.data.focusedInstruction;
    if (!focused
      || focused.eventId !== identity.eventId
      || focused.eventIndex !== identity.eventIndex
      || focused.instructionIndex !== identity.instructionIndex
      || focused.bank !== identity.bank
      || focused.id !== identity.instructionId) {
      diagnostics.push(errorFor(
        input.operation,
        'EMEVD_SEMANTIC_INSTRUCTION_IDENTITY_MISMATCH',
        'EMEVD instruction occurrence 与预期身份不一致。'
      ));
    } else {
      try {
        const actual = normalizeArgsBase64(focused.argsBase64);
        const expected = normalizeArgsBase64(expectedBase64);
        if (actual !== expected) {
          diagnostics.push(errorFor(
            input.operation,
            'EMEVD_SEMANTIC_PREVIOUS_VALUE_MISMATCH',
            `EMEVD instruction args 与 ${input.phase} 预期 typed value 不一致。`
          ));
        }
      } catch {
        diagnostics.push(errorFor(
          input.operation,
          'EMEVD_ARGS_BASE64_INVALID',
          'EMEVD instruction argsBase64 非法。'
        ));
      }
    }
  } else {
    diagnostics.push(errorFor(
      input.operation,
      'EMEVD_SEMANTIC_OPERATION_UNREACHABLE',
      'EMEVD semantic operation 未进入任何受支持的验证分支。'
    ));
  }

  const expectedSchemaId = isEmevdSemanticFieldOperation(input.operation)
    ? input.operation.schemaId
    : input.operation.metadata?.schemaId;
  const expectedSchemaVersion = isEmevdSemanticFieldOperation(input.operation)
    ? input.operation.schemaVersion
    : input.operation.metadata?.schemaVersion;
  const expectedLayoutFingerprint = isEmevdSemanticFieldOperation(input.operation)
    ? input.operation.layoutFingerprint
    : input.operation.metadata?.layoutFingerprint;
  if (result.data.schemaId !== expectedSchemaId
    || result.data.schemaVersion !== expectedSchemaVersion
    || result.data.layoutFingerprint !== expectedLayoutFingerprint) {
    diagnostics.push(errorFor(
      input.operation,
      'EMEVD_SEMANTIC_SCHEMA_BINDING_MISMATCH',
      'EMEVD schema/layout binding 与当前文档不一致。'
    ));
  }
  if (input.requireBoundHashes
    && (result.data.sourceHash !== input.operation.expectedHash
      || result.data.documentHash !== input.operation.expectedDocumentHash
      || result.data.documentRevision !== input.operation.documentRevision)) {
    diagnostics.push(errorFor(
      input.operation,
      'EMEVD_SEMANTIC_REVISION_MISMATCH',
      'EMEVD source/document hash 或 revision 已变化。'
    ));
  }
  return { data: result.data, diagnostics };
}

function instructionParentMetadata(event: EmevdBridgeDocument['events'][number]) {
  return {
    eventId: event.id,
    eventIndex: event.eventIndex,
    eventHash: event.eventHash,
    parameterCount: event.parameterCount
  };
}

function updateInstructionInversePreconditions(
  preconditions: PatchIrOperation['preconditions'],
  expectedHash: string,
  instructions: Parameters<typeof snapshotEmevdInstructionOrder>[0]
): PatchIrOperation['preconditions'] {
  return preconditions.map((precondition) => (
    precondition.type === 'content_hash'
      ? { ...precondition, expectedHash }
      : precondition.type === 'custom'
        ? {
            ...precondition,
            details: {
              expectedInstructionOrderHash: hashEmevdInstructionOrder(instructions),
              instructionCount: instructions.length
            }
          }
        : precondition
  ));
}

function metadataCountMismatch(
  metadata: Record<string, unknown> | undefined,
  key: 'instructionCount' | 'parameterCount',
  actual: number
): boolean {
  const expected = metadata?.[key];
  return expected !== undefined
    && (!Number.isSafeInteger(expected) || expected !== actual);
}

function typedValuesEqual(
  left: EmevdSemanticFieldOperation['previousValue'],
  right: EmevdSemanticFieldOperation['nextValue']
): boolean {
  if (left.valueType === 'integer' && right.valueType === 'integer') {
    return left.value === right.value;
  }
  if (left.valueType === 'bytes' && right.valueType === 'bytes') {
    try {
      return normalizeArgsBase64(left.base64) === normalizeArgsBase64(right.base64);
    } catch {
      return false;
    }
  }
  return false;
}

function stagingRelativeName(operation: PatchIrOperation): string {
  const base = basename(operation.targetPath ?? 'document.emevd');
  return join('emevd-semantic', operation.id, base);
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
