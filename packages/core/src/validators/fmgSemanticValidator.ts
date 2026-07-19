import { dirname } from 'node:path';
import type {
  PatchIR,
  PatchIrOperation,
  StructuredDiagnostic,
  ValidatorContract,
  ValidatorResult
} from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';
import { readFmgDocumentViaBridge } from '../editing/fmgBridgeCommit.js';
import {
  FMG_SEMANTIC_VALIDATOR_ID,
  assertFmgSlotOrderEquals,
  assertFmgSlotDeleteApplied,
  buildFmgEntryNodePayload,
  isFmgEntryNodeAddOperation,
  isFmgEntryNodeDeleteOperation,
  isFmgEntryNodeReorderOperation,
  isFmgEntryTextFieldOperation,
  isFmgSemanticOperation,
  parseFmgEntryNodeId,
  parseFmgEntryTextFieldUri,
  readFmgBeforeEntriesFromMetadata,
  reorderFmgEntrySlots,
  type FmgSemanticOperation
} from '../editing/fmgSemanticContract.js';

/** Bridge-backed validation for production FMG semantic field/node writers. */
export class FmgSemanticValidator implements ValidatorContract {
  readonly validatorId = FMG_SEMANTIC_VALIDATOR_ID;
  readonly targetResourceKinds = ['msg'] as const;
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
  const semanticOperations = operations.filter(isFmgSemanticOperation);
  const validatedOperationIds: string[] = [];
  for (const operation of semanticOperations) {
    const sourcePath = scope === 'staged_output'
      ? stagedPaths.find((path) => path.replaceAll('\\', '/').includes(`/${operation.id}/`))
      : operation.targetPath;
    if (!sourcePath) {
      diagnostics.push(errorFor(
        operation,
        'FMG_SEMANTIC_VALIDATION_TARGET_MISSING',
        `FMG ${scope} 校验缺少精确目标路径。`
      ));
      continue;
    }
    const operationDiagnostics = await validateDocument(operation, sourcePath, scope);
    diagnostics.push(...operationDiagnostics);
    if (!operationDiagnostics.some((item) => item.severity === 'error')) {
      validatedOperationIds.push(operation.id);
    }
  }
  return {
    ok: validatedOperationIds.length === semanticOperations.length
      && diagnostics.every((item) => item.severity !== 'error'),
    diagnostics,
    scope,
    validatorId: FMG_SEMANTIC_VALIDATOR_ID,
    validatedOperationIds
  };
}

async function validateDocument(
  operation: FmgSemanticOperation,
  sourcePath: string,
  scope: 'before_staging' | 'staged_output' | 'after_commit'
): Promise<StructuredDiagnostic[]> {
  const result = await readFmgDocumentViaBridge({
    sourcePath,
    allowedRoots: [dirname(sourcePath)]
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
      'FMG_SEMANTIC_VALIDATION_READ_FAILED',
      `FMG ${scope} 原生重读失败。`
    ));
    return diagnostics;
  }

  if (isFmgEntryTextFieldOperation(operation)) {
    const identity = parseFmgEntryTextFieldUri(operation.fieldUri)!;
    const entry = result.data.entries[identity.stringIndex];
    const expectedValue = scope === 'before_staging'
      ? operation.previousValue.value
      : operation.nextValue.value;
    if (!entry || entry.id !== identity.entryId || entry.stringIndex !== identity.stringIndex) {
      diagnostics.push(errorFor(
        operation,
        'FMG_SEMANTIC_ENTRY_IDENTITY_MISMATCH',
        `FMG ${scope} 的 entry ID/stringIndex 与 PatchIR 不一致。`
      ));
    } else if (entry.text !== expectedValue) {
      diagnostics.push(errorFor(
        operation,
        'FMG_SEMANTIC_VALUE_MISMATCH',
        `FMG ${scope} 的 text 与 PatchIR typed value 不一致。`
      ));
    }
    if (result.data.schemaId !== operation.schemaId
      || result.data.schemaVersion !== operation.schemaVersion
      || result.data.layoutFingerprint !== operation.layoutFingerprint) {
      diagnostics.push(errorFor(
        operation,
        'FMG_SEMANTIC_SCHEMA_BINDING_MISMATCH',
        `FMG ${scope} 的 schema/layout binding 已变化。`
      ));
    }
  } else if (isFmgEntryNodeDeleteOperation(operation)) {
    const identity = parseFmgEntryNodeId(operation.nodeId)!;
    const payload = operation.inverse.payload;
    if (scope === 'before_staging') {
      const entry = result.data.entries[identity.stringIndex];
      if (!entry || entry.id !== identity.entryId || entry.text !== payload.text) {
        diagnostics.push(errorFor(
          operation,
          'FMG_SEMANTIC_ENTRY_IDENTITY_MISMATCH',
          `FMG ${scope} 的 delete 目标槽位与 PatchIR 不一致。`
        ));
      } else {
        const actual = buildFmgEntryNodePayload({
          entryId: entry.id,
          stringIndex: entry.stringIndex,
          text: entry.text,
          schemaVersion: result.data.schemaVersion
        });
        if (actual.snapshot.sha256.toLowerCase() !== operation.expectedNodeHash.toLowerCase()) {
          diagnostics.push(errorFor(
            operation,
            'FMG_SEMANTIC_NODE_HASH_MISMATCH',
            `FMG ${scope} 的 node hash 与 expectedNodeHash 不一致。`
          ));
        }
      }
    } else {
      const beforeEntries = readFmgBeforeEntriesFromMetadata(operation.metadata);
      if (!beforeEntries) {
        diagnostics.push(errorFor(
          operation,
          'FMG_SEMANTIC_DELETE_BASELINE_MISSING',
          `FMG ${scope} 槽位删除校验缺少 beforeEntries 基线。`
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
          diagnostics.push(errorFor(operation, applied.code, applied.message));
        }
      }
    }
    assertNodeSchema(operation, result.data, diagnostics, scope);
  } else if (isFmgEntryNodeAddOperation(operation)) {
    const identity = parseFmgEntryNodeId(operation.nodeId)!;
    if (scope === 'before_staging') {
      if (identity.stringIndex > result.data.entries.length) {
        diagnostics.push(errorFor(
          operation,
          'FMG_SEMANTIC_INSERT_INDEX_OUT_OF_RANGE',
          `FMG ${scope} 的 insert stringIndex 超出范围。`
        ));
      }
    } else {
      const entry = result.data.entries[identity.stringIndex];
      if (!entry
        || entry.id !== identity.entryId
        || entry.text !== operation.payload.text) {
        diagnostics.push(errorFor(
          operation,
          'FMG_SEMANTIC_ENTRY_IDENTITY_MISMATCH',
          `FMG ${scope} 的 insert 结果与 PatchIR payload 不一致。`
        ));
      }
    }
    assertNodeSchema(operation, result.data, diagnostics, scope);
  } else if (isFmgEntryNodeReorderOperation(operation)) {
    const beforeEntries = readFmgBeforeEntriesFromMetadata(operation.metadata);
    if (!beforeEntries) {
      diagnostics.push(errorFor(
        operation,
        'FMG_SEMANTIC_REORDER_BASELINE_MISSING',
        `FMG ${scope} 槽位重排校验缺少完整 beforeEntries 基线。`
      ));
    } else if (scope === 'before_staging') {
      const matched = assertFmgSlotOrderEquals({
        expectedEntries: beforeEntries,
        actualEntries: result.data.entries
      });
      if (!matched.ok) diagnostics.push(errorFor(operation, matched.code, matched.message));
    } else {
      const planned = reorderFmgEntrySlots({
        documentUri: operation.documentUri,
        beforeEntries,
        nodeId: operation.nodeId,
        beforeNodeId: operation.beforeNodeId
      });
      if (!planned.ok) {
        diagnostics.push(errorFor(operation, planned.code, planned.message));
      } else {
        const matched = assertFmgSlotOrderEquals({
          expectedEntries: planned.afterEntries,
          actualEntries: result.data.entries
        });
        if (!matched.ok) diagnostics.push(errorFor(operation, matched.code, matched.message));
      }
    }
    assertNodeSchema(operation, result.data, diagnostics, scope);
  }

  if (scope === 'before_staging'
    && (result.data.sourceHash !== operation.expectedHash
      || result.data.documentHash !== operation.expectedDocumentHash
      || result.data.documentRevision !== operation.documentRevision)) {
    diagnostics.push(errorFor(
      operation,
      'FMG_SEMANTIC_REVISION_MISMATCH',
      'FMG 提交前的 source/document hash 或 revision 已变化。'
    ));
  }
  return diagnostics;
}

function assertNodeSchema(
  operation: FmgSemanticOperation,
  data: { schemaId: string; schemaVersion: string; layoutFingerprint: string },
  diagnostics: StructuredDiagnostic[],
  scope: string
): void {
  const schemaId = typeof operation.metadata?.schemaId === 'string' ? operation.metadata.schemaId : undefined;
  const schemaVersion = typeof operation.metadata?.schemaVersion === 'string'
    ? operation.metadata.schemaVersion
    : undefined;
  const layoutFingerprint = typeof operation.metadata?.layoutFingerprint === 'string'
    ? operation.metadata.layoutFingerprint
    : undefined;
  if (schemaId && schemaVersion && layoutFingerprint
    && (data.schemaId !== schemaId
      || data.schemaVersion !== schemaVersion
      || data.layoutFingerprint !== layoutFingerprint)) {
    diagnostics.push(errorFor(
      operation,
      'FMG_SEMANTIC_SCHEMA_BINDING_MISMATCH',
      `FMG ${scope} 的 schema/layout binding 已变化。`
    ));
  }
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
