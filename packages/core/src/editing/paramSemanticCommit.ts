import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type {
  ConfirmationReceipt,
  Diagnostic,
  IndexedFile,
  ParamDefDocument,
  ResourceFieldEditOp,
  SaveTextResourceResult
} from '@soulforge/shared';
import { createPatchIr } from '../patch-engine/patchIr.js';
import { executePatchIrThroughTransaction } from '../patch/durablePatchCommit.js';
import type { OperationLogStore } from '../patch/operationLog.js';
import type { WorkspaceSession } from '../workspace/workspaceSession.js';
import { prepareParamFieldMutation } from '../param/paramFieldMutation.js';
import { readParamDocumentViaBridge } from './paramBridgeCommit.js';
import {
  PARAM_SEMANTIC_VALIDATOR_ID,
  PARAM_SEMANTIC_WRITER_ID,
  paramFieldUri,
  toParamPatchValue
} from './paramSemanticContract.js';

export interface CommitParamFieldThroughPatchIrOptions {
  file: IndexedFile;
  expectedHash: string;
  rowId: number;
  expectedRowHash: string;
  definition: ParamDefDocument;
  fieldId: string;
  value: number | string | boolean;
  confirmation?: ConfirmationReceipt;
  session?: WorkspaceSession;
  operationLog?: OperationLogStore;
  backupBaseDir?: string;
  recoveryDir?: string;
  title?: string;
}

/** Commit one user-derived PARAM field edit through typed PatchIR + native writer. */
export async function commitParamFieldThroughPatchIr(
  options: CommitParamFieldThroughPatchIrOptions
): Promise<SaveTextResourceResult> {
  const confirmation = options.confirmation;
  if (!confirmation
    || confirmation.riskLevel !== 'high'
    || confirmation.sourceUri !== options.file.sourceUri
    || !confirmation.subjects.includes(options.file.sourceUri)) {
    return {
      ok: false,
      changedFiles: [],
      requiresConfirmation: true,
      diagnostics: [{
        severity: 'error',
        code: 'EDIT_CONFIRMATION_REQUIRED',
        message: '原生 PARAM 字段修改需要绑定当前资源 URI 的高风险确认凭据。',
        sourceUri: options.file.sourceUri
      }]
    };
  }
  if (!Number.isSafeInteger(options.rowId) || !options.fieldId) {
    return fail(options.file.sourceUri, 'PARAM_SEMANTIC_INPUT_INVALID', 'PARAM rowId 或 fieldId 无效。');
  }

  const read = await readParamDocumentViaBridge({
    sourcePath: options.file.absolutePath,
    allowedRoots: [dirname(options.file.absolutePath)],
    rowId: options.rowId,
    rowLimit: 1,
    includePayloads: true
  });
  if (!read.ok || !read.data) {
    return {
      ok: false,
      changedFiles: [],
      diagnostics: read.diagnostics.map((diagnostic) => ({
        severity: diagnostic.severity as Diagnostic['severity'],
        code: diagnostic.code,
        message: diagnostic.message,
        sourceUri: options.file.sourceUri
      }))
    };
  }
  if (read.data.sourceHash !== options.expectedHash) {
    return fail(options.file.sourceUri, 'HASH_MISMATCH', 'expectedHash 与当前 PARAM 文件不一致。', {
      expected: options.expectedHash,
      actual: read.data.sourceHash
    });
  }
  const row = read.data.rows[0];
  if (!row || row.id !== options.rowId || !row.dataBase64) {
    return fail(options.file.sourceUri, 'PARAM_SEMANTIC_ROW_UNAVAILABLE', '目标 PARAM 行或 payload 不可用。');
  }
  const prepared = prepareParamFieldMutation({
    documentTypeName: read.data.typeName,
    rowDataSize: read.data.rowDataSize,
    rowId: options.rowId,
    rowDataBase64: row.dataBase64,
    rowDataHash: row.dataHash,
    expectedRowHash: options.expectedRowHash,
    definition: options.definition,
    fieldId: options.fieldId,
    value: options.value
  });
  if (!prepared.ok) {
    return fail(options.file.sourceUri, prepared.code, prepared.message);
  }

  const fieldUri = paramFieldUri({
    documentUri: options.file.sourceUri,
    rowId: options.rowId,
    fieldId: options.fieldId
  });
  const previousValue = toParamPatchValue(prepared.beforeValue);
  const nextValue = toParamPatchValue(prepared.afterValue);
  const operation: ResourceFieldEditOp = {
    id: randomUUID(),
    kind: 'resource_field_edit',
    targetUri: options.file.sourceUri,
    targetPath: options.file.absolutePath,
    resourceKind: 'param',
    documentUri: options.file.sourceUri,
    documentRevision: read.data.sourceHash,
    schemaId: `param:${read.data.typeName}`,
    schemaVersion: 'user-derived-paramdef-v1',
    layoutFingerprint: `${read.data.typeName}:${read.data.rowDataSize}`,
    expectedHash: read.data.sourceHash,
    expectedDocumentHash: read.data.sourceHash,
    writerId: PARAM_SEMANTIC_WRITER_ID,
    fieldUri,
    previousValue,
    nextValue,
    inverse: {
      kind: 'resource_field_edit',
      fieldUri,
      value: previousValue
    },
    preconditions: [
      {
        type: 'content_hash',
        description: '提交前 PARAM 文件必须保持 expectedHash',
        expectedHash: read.data.sourceHash,
        targetUri: options.file.sourceUri
      },
      {
        type: 'resource_exists',
        description: '目标 PARAM 字段必须存在',
        targetUri: fieldUri
      },
      {
        type: 'writer_capability',
        description: '必须由注册的 PARAM semantic writer 处理',
        targetUri: options.file.sourceUri,
        details: { writerId: PARAM_SEMANTIC_WRITER_ID }
      },
      {
        type: 'overlay_writable',
        description: '只允许写入当前 Mod 覆盖层',
        targetUri: options.file.sourceUri
      }
    ],
    validatorRequirements: [
      { validatorId: 'file_risk', scope: 'before_staging', required: true },
      { validatorId: PARAM_SEMANTIC_VALIDATOR_ID, scope: 'before_staging', required: true },
      { validatorId: PARAM_SEMANTIC_VALIDATOR_ID, scope: 'staged_output', required: true },
      { validatorId: PARAM_SEMANTIC_VALIDATOR_ID, scope: 'after_commit', required: true }
    ],
    rollbackHint: {
      strategy: 'inverse_patch',
      notes: `PARAM 字段 ${fieldUri} 的 typed inverse`
    },
    riskLevel: 'high',
    metadata: {
      nativeFormatAuthority: true,
      requiresConfirmation: true,
      confirmationReceiptId: confirmation.id,
      rowId: options.rowId,
      fieldId: options.fieldId,
      expectedRowHash: options.expectedRowHash,
      definitionTypeName: options.definition.typeName,
      definition: options.definition,
      nextDataBase64: prepared.dataBase64,
      nextRowHash: prepared.dataHash,
      changedByteOffsets: prepared.changedByteOffsets
    }
  };
  const patch = createPatchIr({
    workspaceId: options.file.workspaceId,
    title: options.title ?? `PARAM field ${options.fieldId} ${options.file.relativePath}`,
    author: 'user',
    operations: [operation],
    notes: '用户派生 PARAM 字段 typed PatchIR transaction'
  });
  const committed = await executePatchIrThroughTransaction(patch, {
    ...(options.session ? { session: options.session } : {}),
    ...(options.session?.layers.overlayRoot
      ? { workspaceRoot: options.session.layers.overlayRoot }
      : {}),
    ...(options.operationLog ? { operationLog: options.operationLog } : {}),
    ...(options.backupBaseDir ? { backupBaseDir: options.backupBaseDir } : {}),
    ...(options.recoveryDir ? { recoveryDir: options.recoveryDir } : {}),
    author: 'user'
  });
  return {
    ok: Boolean(committed.operation)
      && committed.changedFiles.length === 1
      && committed.diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
    opId: committed.opId,
    backupRoot: committed.backupRoot,
    changedFiles: committed.changedFiles,
    diagnostics: committed.diagnostics
  };
}

function fail(
  sourceUri: string,
  code: string,
  message: string,
  details?: Record<string, unknown>
): SaveTextResourceResult {
  return {
    ok: false,
    changedFiles: [],
    diagnostics: [{ severity: 'error', code, message, sourceUri, ...(details ? { details } : {}) }]
  };
}
