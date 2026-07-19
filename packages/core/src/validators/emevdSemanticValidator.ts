import { dirname } from 'node:path';
import type {
  PatchIR,
  PatchIrOperation,
  StructuredDiagnostic,
  ValidatorContract,
  ValidatorResult
} from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';
import { readEmevdDocumentViaBridge } from '../editing/emevdBridgeCommit.js';
import {
  EMEVD_SEMANTIC_VALIDATOR_ID,
  assertEmevdEventOrderEquals,
  assertEmevdInstructionOrderEquals,
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
  snapshotEmevdInstructionOrder,
  type EmevdSemanticOperation
} from '../editing/emevdSemanticContract.js';

/** Bridge-backed semantic validation for production EMEVD typed mutations. */
export class EmevdSemanticValidator implements ValidatorContract {
  readonly validatorId = EMEVD_SEMANTIC_VALIDATOR_ID;
  readonly targetResourceKinds = ['event'] as const;
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
  const semanticOperations = operations.filter(isEmevdSemanticOperation);
  for (const operation of semanticOperations) {
    const sourcePath = scope === 'staged_output'
      ? stagedPaths.find((path) => path.replaceAll('\\', '/').includes(`/${operation.id}/`))
      : operation.targetPath;
    if (!sourcePath) {
      diagnostics.push(errorFor(
        operation,
        'EMEVD_SEMANTIC_VALIDATION_TARGET_MISSING',
        `EMEVD ${scope} 校验缺少精确目标路径。`
      ));
      continue;
    }
    diagnostics.push(...await validateDocument(operation, sourcePath, scope));
  }
  return {
    ok: diagnostics.every((item) => item.severity !== 'error'),
    diagnostics,
    scope,
    validatorId: EMEVD_SEMANTIC_VALIDATOR_ID,
    validatedOperationIds: semanticOperations.map((operation) => operation.id)
  };
}

async function validateDocument(
  operation: EmevdSemanticOperation,
  sourcePath: string,
  scope: 'before_staging' | 'staged_output' | 'after_commit'
): Promise<StructuredDiagnostic[]> {
  const focus = isEmevdInstructionArgsFieldOperation(operation)
    ? parseEmevdInstructionArgsFieldUri(operation.fieldUri)!
    : undefined;
  const instructionNodeIdentity = isEmevdInstructionNodeAddOperation(operation)
    || isEmevdInstructionNodeDeleteOperation(operation)
    || isEmevdInstructionNodeReorderOperation(operation)
    ? parseEmevdInstructionNodeUri(operation.nodeId)!
    : undefined;
  const result = await readEmevdDocumentViaBridge({
    sourcePath,
    allowedRoots: [dirname(sourcePath)],
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
    targetUri: operation.targetUri
  }));
  if (!result.ok || !result.data) {
    diagnostics.push(errorFor(
      operation,
      'EMEVD_SEMANTIC_VALIDATION_READ_FAILED',
      `EMEVD ${scope} 原生重读失败。`
    ));
    return diagnostics;
  }

  if (isEmevdEventNodeAddOperation(operation)) {
    const beforeEvents = readEmevdBeforeEventsFromMetadata(operation.metadata);
    if (!beforeEvents) {
      diagnostics.push(errorFor(
        operation,
        'EMEVD_SEMANTIC_ADD_BASELINE_INVALID',
        `EMEVD ${scope} event add 缺少完整合法的事件 semantic hash 顺序。`
      ));
    } else {
      const expectedEvents = [...beforeEvents];
      if (scope !== 'before_staging') {
        expectedEvents.splice(operation.payload.eventIndex, 0, {
          id: operation.payload.eventId,
          eventHash: operation.payload.eventHash
        });
      }
      const matched = assertEmevdEventOrderEquals({
        expectedEvents,
        actualEvents: result.data.events
      });
      if (!matched.ok) diagnostics.push(errorFor(operation, matched.code, matched.message));
      if (scope !== 'before_staging') {
        const added = result.data.events[operation.payload.eventIndex];
        if (!added
          || added.id !== operation.payload.eventId
          || added.eventIndex !== operation.payload.eventIndex
          || added.eventHash !== operation.payload.eventHash
          || added.restBehavior !== operation.payload.restartType
          || (operation.metadata?.eventAddMode === 'empty_append'
            && (added.instructionCount !== 0 || added.parameterCount !== 0))
          || metadataCountMismatch(operation.metadata, 'instructionCount', added.instructionCount)
          || metadataCountMismatch(operation.metadata, 'parameterCount', added.parameterCount)) {
          diagnostics.push(errorFor(
            operation,
            'EMEVD_SEMANTIC_ADD_PAYLOAD_MISMATCH',
            `EMEVD ${scope} 新事件与 typed payload 不一致。`
          ));
        }
      }
    }
  } else if (isEmevdEventNodeDeleteOperation(operation)) {
    const beforeEvents = readEmevdBeforeEventsFromMetadata(operation.metadata);
    const identity = parseEmevdEventNodeUri(operation.nodeId)!;
    if (!beforeEvents) {
      diagnostics.push(errorFor(
        operation,
        'EMEVD_SEMANTIC_DELETE_BASELINE_INVALID',
        `EMEVD ${scope} event delete 缺少完整合法的事件 semantic hash 顺序。`
      ));
    } else {
      const expectedEvents = scope === 'before_staging'
        ? beforeEvents
        : beforeEvents.filter((_, index) => index !== identity.eventIndex);
      const matched = assertEmevdEventOrderEquals({
        expectedEvents,
        actualEvents: result.data.events
      });
      if (!matched.ok) diagnostics.push(errorFor(operation, matched.code, matched.message));
      if (scope === 'before_staging') {
        const payload = operation.inverse.payload;
        const target = result.data.events[identity.eventIndex];
        if (!target
          || target.id !== identity.eventId
          || target.eventIndex !== identity.eventIndex
          || target.eventHash !== operation.expectedNodeHash
          || target.restBehavior !== payload.restartType
          || metadataCountMismatch(operation.metadata, 'instructionCount', target.instructionCount)
          || metadataCountMismatch(operation.metadata, 'parameterCount', target.parameterCount)) {
          diagnostics.push(errorFor(
            operation,
            'EMEVD_SEMANTIC_DELETE_PAYLOAD_MISMATCH',
            'EMEVD 删除前目标 occurrence 与空事件 snapshot 不一致。'
          ));
        }
      }
    }
  } else if (isEmevdEventNodeReorderOperation(operation)) {
    const beforeEvents = readEmevdBeforeEventsFromMetadata(operation.metadata);
    if (!beforeEvents || beforeEvents.length !== result.data.events.length) {
      diagnostics.push(errorFor(
        operation,
        'EMEVD_SEMANTIC_REORDER_BASELINE_INVALID',
        `EMEVD ${scope} 缺少完整合法的事件 semantic hash 顺序。`
      ));
    } else if (scope === 'before_staging') {
      const matched = assertEmevdEventOrderEquals({
        expectedEvents: beforeEvents,
        actualEvents: result.data.events
      });
      if (!matched.ok) diagnostics.push(errorFor(operation, matched.code, matched.message));
    } else {
      const planned = reorderEmevdEventOrder({
        beforeEvents,
        nodeId: operation.nodeId,
        beforeNodeId: operation.beforeNodeId
      });
      if (!planned.ok) {
        diagnostics.push(errorFor(operation, planned.code, planned.message));
      } else {
        const matched = assertEmevdEventOrderEquals({
          expectedEvents: planned.afterEvents,
          actualEvents: result.data.events
        });
        if (!matched.ok) diagnostics.push(errorFor(operation, matched.code, matched.message));
      }
    }
  } else if (isEmevdInstructionNodeAddOperation(operation)
    || isEmevdInstructionNodeDeleteOperation(operation)
    || isEmevdInstructionNodeReorderOperation(operation)) {
    const identity = parseEmevdInstructionNodeUri(operation.nodeId)!;
    const beforeInstructions = readEmevdBeforeInstructionsFromMetadata(operation.metadata);
    const beforeEvents = readEmevdBeforeEventsFromMetadata(operation.metadata);
    const parent = operation.metadata?.beforeInstructionEvent as {
      eventId?: unknown;
      eventIndex?: unknown;
      eventHash?: unknown;
      parameterCount?: unknown;
    } | undefined;
    const order = result.data.focusedEventInstructionOrder;
    const expectedPrevious = scope === 'before_staging';
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
        operation,
        'EMEVD_SEMANTIC_INSTRUCTION_BASELINE_INVALID',
        `EMEVD ${scope} instruction mutation 缺少完整的父事件和指令顺序证据。`
      ));
    } else {
      let expectedInstructions = snapshotEmevdInstructionOrder(beforeInstructions);
      if (!expectedPrevious) {
        if (isEmevdInstructionNodeAddOperation(operation)) {
          expectedInstructions.splice(identity.instructionIndex, 0, {
            bank: operation.payload.bank,
            id: operation.payload.instructionId,
            instructionHash: operation.payload.instructionHash,
            parameterCount: operation.payload.parameterCount
          });
        } else if (isEmevdInstructionNodeDeleteOperation(operation)) {
          expectedInstructions.splice(identity.instructionIndex, 1);
        } else {
          const planned = reorderEmevdInstructionOrder({
            documentUri: operation.documentUri,
            eventId: identity.eventId,
            eventIndex: identity.eventIndex,
            beforeInstructions,
            nodeId: operation.nodeId,
            beforeNodeId: operation.beforeNodeId
          });
          if (!planned.ok) diagnostics.push(errorFor(operation, planned.code, planned.message));
          else expectedInstructions = planned.afterInstructions;
        }
      }
      const matched = assertEmevdInstructionOrderEquals({
        expectedInstructions,
        actualInstructions: order.instructions
      });
      if (!matched.ok) diagnostics.push(errorFor(operation, matched.code, matched.message));
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
        || (expectedPrevious
          ? targetEvent.eventHash !== parent.eventHash
          : targetEvent.eventHash === parent.eventHash)) {
        diagnostics.push(errorFor(
          operation,
          'EMEVD_SEMANTIC_INSTRUCTION_PARENT_MISMATCH',
          `EMEVD ${scope} instruction mutation的父事件与完整预期不一致。`
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
          operation,
          'EMEVD_SEMANTIC_INSTRUCTION_ISOLATION_MISMATCH',
          `EMEVD ${scope} instruction mutation改变了目标父事件以外的事件或事件顺序。`
        ));
      }
    }
  } else if (isEmevdRestBehaviorFieldOperation(operation)) {
    const identity = parseEmevdRestBehaviorFieldUri(operation.fieldUri)!;
    const event = result.data.events[identity.eventIndex];
    const expectedValue = scope === 'before_staging'
      ? operation.previousValue.value
      : operation.nextValue.value;
    if (!event || event.id !== identity.eventId || event.eventIndex !== identity.eventIndex) {
      diagnostics.push(errorFor(
        operation,
        'EMEVD_SEMANTIC_EVENT_IDENTITY_MISMATCH',
        `EMEVD ${scope} 的 event ID/index 与 PatchIR 不一致。`
      ));
    } else if (event.restBehavior !== expectedValue) {
      diagnostics.push(errorFor(
        operation,
        'EMEVD_SEMANTIC_VALUE_MISMATCH',
        `EMEVD ${scope} 的 restBehavior 与 PatchIR typed value 不一致。`
      ));
    }
  } else if (isEmevdInstructionArgsFieldOperation(operation)) {
    const identity = parseEmevdInstructionArgsFieldUri(operation.fieldUri)!;
    const event = result.data.events[identity.eventIndex];
    const expectedBase64 = scope === 'before_staging'
      ? operation.previousValue.base64
      : operation.nextValue.base64;
    if (!event || event.id !== identity.eventId || event.eventIndex !== identity.eventIndex) {
      diagnostics.push(errorFor(
        operation,
        'EMEVD_SEMANTIC_EVENT_IDENTITY_MISMATCH',
        `EMEVD ${scope} 的 event ID/index 与 PatchIR 不一致。`
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
        operation,
        'EMEVD_SEMANTIC_INSTRUCTION_IDENTITY_MISMATCH',
        `EMEVD ${scope} 的 instruction 身份与 PatchIR 不一致。`
      ));
    } else {
      try {
        if (normalizeArgsBase64(focused.argsBase64) !== normalizeArgsBase64(expectedBase64)) {
          diagnostics.push(errorFor(
            operation,
            'EMEVD_SEMANTIC_VALUE_MISMATCH',
            `EMEVD ${scope} 的 instruction args 与 PatchIR typed value 不一致。`
          ));
        }
      } catch {
        diagnostics.push(errorFor(
          operation,
          'EMEVD_ARGS_BASE64_INVALID',
          `EMEVD ${scope} 的 instruction argsBase64 非法。`
        ));
      }
    }
  } else {
    diagnostics.push(errorFor(
      operation,
      'EMEVD_SEMANTIC_OPERATION_UNREACHABLE',
      `EMEVD ${scope} semantic operation 未进入任何受支持的验证分支。`
    ));
  }

  const expectedSchemaId = isEmevdSemanticFieldOperation(operation)
    ? operation.schemaId
    : operation.metadata?.schemaId;
  const expectedSchemaVersion = isEmevdSemanticFieldOperation(operation)
    ? operation.schemaVersion
    : operation.metadata?.schemaVersion;
  const expectedLayoutFingerprint = isEmevdSemanticFieldOperation(operation)
    ? operation.layoutFingerprint
    : operation.metadata?.layoutFingerprint;
  if (result.data.schemaId !== expectedSchemaId
    || result.data.schemaVersion !== expectedSchemaVersion
    || result.data.layoutFingerprint !== expectedLayoutFingerprint) {
    diagnostics.push(errorFor(
      operation,
      'EMEVD_SEMANTIC_SCHEMA_BINDING_MISMATCH',
      `EMEVD ${scope} 的 schema/layout binding 已变化。`
    ));
  }
  if (scope === 'before_staging'
    && (result.data.sourceHash !== operation.expectedHash
      || result.data.documentHash !== operation.expectedDocumentHash
      || result.data.documentRevision !== operation.documentRevision)) {
    diagnostics.push(errorFor(
      operation,
      'EMEVD_SEMANTIC_REVISION_MISMATCH',
      'EMEVD 提交前的 source/document hash 或 revision 已变化。'
    ));
  }
  return diagnostics;
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
