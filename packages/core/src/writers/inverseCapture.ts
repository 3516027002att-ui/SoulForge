import type {
  PatchIrOperation,
  StructuredDiagnostic,
  WriterAdapterContract,
  WriterResourceEntryChange,
  WriterWrittenTarget
} from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';
import { UnsupportedResourceWriter } from './unsupportedResourceWriter.js';

export interface WriterInverseCaptureSummary {
  changes: WriterResourceEntryChange[];
  diagnostics: StructuredDiagnostic[];
}

/**
 * Capture every required structured inverse through the same writer instances
 * that produced staging output. Missing hooks or incomplete coverage fail
 * closed before WorkspaceTransaction replaces a target file.
 */
export async function captureWriterResourceEntryChanges(input: {
  operations: PatchIrOperation[];
  writers: readonly WriterAdapterContract[];
  stagedTargets: WriterWrittenTarget[];
  workspaceRoot: string;
}): Promise<WriterInverseCaptureSummary> {
  const required = input.operations.filter(requiresPreciseEntryInverse);
  if (required.length === 0) return { changes: [], diagnostics: [] };

  const grouped = new Map<string, {
    writer: WriterAdapterContract;
    operations: PatchIrOperation[];
  }>();
  const diagnostics: StructuredDiagnostic[] = [];

  for (const operation of required) {
    const writer = resolveWriter(operation, input.writers);
    if (writer.writerId === 'writer:unsupported' || !writer.captureInverse) {
      diagnostics.push(createDiagnostic({
        severity: 'error',
        code: 'WRITER_INVERSE_CAPTURE_UNAVAILABLE',
        message: '原生结构化操作缺少 writer captureInverse，已在目标写入前阻止事务。',
        targetUri: operation.targetUri,
        details: { operationId: operation.id, kind: operation.kind, writerId: writer.writerId }
      }));
      continue;
    }
    const bucket = grouped.get(writer.writerId) ?? { writer, operations: [] };
    bucket.operations.push(operation);
    grouped.set(writer.writerId, bucket);
  }

  const changes: WriterResourceEntryChange[] = [];
  const covered = new Set<string>();
  for (const { writer, operations } of grouped.values()) {
    const result = await writer.captureInverse!({
      operations,
      stagedTargets: input.stagedTargets.filter((target) =>
        operations.some((operation) => operation.id === target.opId)),
      workspaceRoot: input.workspaceRoot
    });
    diagnostics.push(...result.diagnostics);
    changes.push(...result.resourceEntryChanges);
    for (const operationId of result.capturedOperationIds) {
      if (covered.has(operationId)) {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'WRITER_INVERSE_CAPTURE_DUPLICATE',
          message: '同一 forward operation 返回了重复 inverse coverage。',
          details: { operationId, writerId: writer.writerId }
        }));
      }
      covered.add(operationId);
    }
    if (!result.ok && !result.diagnostics.some((item) => item.severity === 'error')) {
      diagnostics.push(createDiagnostic({
        severity: 'error',
        code: 'WRITER_INVERSE_CAPTURE_FAILED',
        message: 'writer 未能生成完整、可验证的资源条目逆操作。',
        details: { writerId: writer.writerId }
      }));
    }
  }

  for (const operation of required) {
    if (covered.has(operation.id)) continue;
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'WRITER_INVERSE_CAPTURE_INCOMPLETE',
      message: '原生结构化操作没有对应的精确 inverse，已阻止事务。',
      targetUri: operation.targetUri,
      details: { operationId: operation.id, kind: operation.kind }
    }));
  }

  const ids = new Set<string>();
  for (const change of changes) {
    if (ids.has(change.id)) {
      diagnostics.push(createDiagnostic({
        severity: 'error',
        code: 'WRITER_INVERSE_CHANGE_ID_DUPLICATE',
        message: '资源条目逆操作记录 ID 重复。',
        details: { changeId: change.id }
      }));
    }
    ids.add(change.id);
  }
  return { changes, diagnostics };
}

function resolveWriter(
  operation: PatchIrOperation,
  writers: readonly WriterAdapterContract[]
): WriterAdapterContract {
  return writers.find((writer) =>
    writer.writerId !== 'writer:unsupported' && writer.canHandle(operation))
    ?? writers.find((writer) => writer.writerId === 'writer:unsupported')
    ?? new UnsupportedResourceWriter();
}

function requiresPreciseEntryInverse(operation: PatchIrOperation): boolean {
  if (operation.kind.startsWith('resource_') || operation.kind === 'asset_import_replace') {
    return true;
  }
  return operation.kind.startsWith('container_child_')
    && 'containerFormat' in operation
    && operation.containerFormat === 'BND4_DFLT'
    && operation.metadata?.nativeFormatAuthority === true;
}
