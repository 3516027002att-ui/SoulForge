import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type {
  ConfirmationReceipt,
  Diagnostic,
  IndexedFile,
  ResourceFieldEditOp,
  ResourceNodeAddOp,
  ResourceNodeDeleteOp,
  ResourceNodeReorderOp,
  SaveTextResourceResult
} from '@soulforge/shared';
import { createPatchIr } from '../patch-engine/patchIr.js';
import { executePatchIrThroughTransaction } from '../patch/durablePatchCommit.js';
import type { OperationLogStore } from '../patch/operationLog.js';
import type { WorkspaceSession } from '../workspace/workspaceSession.js';
import { readFmgDocumentViaBridge } from './fmgBridgeCommit.js';
import {
  FMG_SEMANTIC_VALIDATOR_ID,
  FMG_SEMANTIC_WRITER_ID,
  buildFmgEntryNodePayload,
  fmgEntryOrderUris,
  fmgEntryNodeUri,
  fmgEntryTextFieldUri,
  hashFmgEntrySlots,
  isInt32,
  reorderFmgEntrySlots,
  snapshotFmgEntrySlots
} from './fmgSemanticContract.js';

export interface CommitFmgEntryTextOptions {
  file: IndexedFile;
  expectedHash: string;
  entryId: number;
  stringIndex: number;
  text: string;
  confirmation?: ConfirmationReceipt;
  session?: WorkspaceSession;
  operationLog?: OperationLogStore;
  backupBaseDir?: string;
  recoveryDir?: string;
  title?: string;
}

/** Commit one existing FMG string slot through typed PatchIR and the native writer. */
export async function commitFmgEntryTextThroughPatchIr(
  options: CommitFmgEntryTextOptions
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
        message: '原生 FMG 条目文本修改需要绑定当前资源 URI 的高风险确认凭据。',
        sourceUri: options.file.sourceUri
      }]
    };
  }
  if (!isInt32(options.entryId)
    || !Number.isSafeInteger(options.stringIndex)
    || options.stringIndex < 0
    || typeof options.text !== 'string') {
    return fail(options.file.sourceUri, 'FMG_SEMANTIC_INPUT_INVALID', 'FMG 条目 ID、槽位或文本无效。');
  }

  const read = await readFmgDocumentViaBridge({
    sourcePath: options.file.absolutePath,
    allowedRoots: [dirname(options.file.absolutePath)]
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
    return fail(options.file.sourceUri, 'HASH_MISMATCH', 'expectedHash 与当前 FMG 文件不一致。', {
      expected: options.expectedHash,
      actual: read.data.sourceHash
    });
  }
  const entry = read.data.entries[options.stringIndex];
  if (!entry || entry.id !== options.entryId || entry.stringIndex !== options.stringIndex) {
    return fail(
      options.file.sourceUri,
      'FMG_SEMANTIC_ENTRY_IDENTITY_MISMATCH',
      'entryId/stringIndex 与当前原生 FMG 文档不一致。'
    );
  }
  if (entry.text === options.text) {
    return fail(options.file.sourceUri, 'FMG_SEMANTIC_NOOP_BLOCKED', 'FMG 文本未发生变化，已阻止空提交。');
  }

  const fieldUri = fmgEntryTextFieldUri({
    documentUri: options.file.sourceUri,
    entryId: options.entryId,
    stringIndex: options.stringIndex
  });
  const operation: ResourceFieldEditOp = {
    id: randomUUID(),
    kind: 'resource_field_edit',
    targetUri: options.file.sourceUri,
    targetPath: options.file.absolutePath,
    resourceKind: 'msg',
    documentUri: options.file.sourceUri,
    documentRevision: read.data.documentRevision,
    schemaId: read.data.schemaId,
    schemaVersion: read.data.schemaVersion,
    layoutFingerprint: read.data.layoutFingerprint,
    expectedHash: read.data.sourceHash,
    expectedDocumentHash: read.data.documentHash,
    writerId: FMG_SEMANTIC_WRITER_ID,
    fieldUri,
    previousValue: { valueType: 'string', value: entry.text },
    nextValue: { valueType: 'string', value: options.text },
    inverse: {
      kind: 'resource_field_edit',
      fieldUri,
      value: { valueType: 'string', value: entry.text }
    },
    preconditions: [
      {
        type: 'content_hash',
        description: '提交前 FMG 文件必须保持 expectedHash',
        expectedHash: read.data.sourceHash,
        targetUri: options.file.sourceUri
      },
      {
        type: 'resource_exists',
        description: '目标 FMG string slot 必须存在',
        targetUri: fieldUri
      },
      {
        type: 'writer_capability',
        description: '必须由注册的 FMG semantic writer 处理',
        targetUri: options.file.sourceUri,
        details: { writerId: FMG_SEMANTIC_WRITER_ID }
      },
      {
        type: 'overlay_writable',
        description: '只允许写入当前 Mod 覆盖层',
        targetUri: options.file.sourceUri
      }
    ],
    validatorRequirements: [
      { validatorId: 'file_risk', scope: 'before_staging', required: true },
      { validatorId: FMG_SEMANTIC_VALIDATOR_ID, scope: 'before_staging', required: true },
      { validatorId: FMG_SEMANTIC_VALIDATOR_ID, scope: 'staged_output', required: true },
      { validatorId: FMG_SEMANTIC_VALIDATOR_ID, scope: 'after_commit', required: true }
    ],
    rollbackHint: {
      strategy: 'inverse_patch',
      notes: `FMG 文本字段 ${fieldUri} 的精确 typed inverse`
    },
    riskLevel: 'high',
    metadata: {
      nativeFormatAuthority: true,
      requiresConfirmation: true,
      confirmationReceiptId: confirmation.id,
      entryId: options.entryId,
      stringIndex: options.stringIndex
    }
  };
  const patch = createPatchIr({
    workspaceId: options.file.workspaceId,
    title: options.title ?? `FMG 文本 ${options.file.relativePath}`,
    author: 'user',
    operations: [operation],
    notes: '原生 FMG existing-entry text typed PatchIR transaction'
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

export interface CommitFmgEntryDeleteOptions {
  file: IndexedFile;
  expectedHash: string;
  entryId: number;
  stringIndex: number;
  confirmation?: ConfirmationReceipt;
  session?: WorkspaceSession;
  operationLog?: OperationLogStore;
  backupBaseDir?: string;
  recoveryDir?: string;
  title?: string;
}

/** Commit one existing FMG string-slot delete through typed PatchIR and the native writer. */
export async function commitFmgEntryDeleteThroughPatchIr(
  options: CommitFmgEntryDeleteOptions
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
        message: '原生 FMG 槽位删除需要绑定当前资源 URI 的高风险确认凭据。',
        sourceUri: options.file.sourceUri
      }]
    };
  }
  if (!isInt32(options.entryId)
    || !Number.isSafeInteger(options.stringIndex)
    || options.stringIndex < 0) {
    return fail(options.file.sourceUri, 'FMG_SEMANTIC_INPUT_INVALID', 'FMG 条目 ID 或槽位无效。');
  }

  const read = await readFmgDocumentViaBridge({
    sourcePath: options.file.absolutePath,
    allowedRoots: [dirname(options.file.absolutePath)]
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
    return fail(options.file.sourceUri, 'HASH_MISMATCH', 'expectedHash 与当前 FMG 文件不一致。', {
      expected: options.expectedHash,
      actual: read.data.sourceHash
    });
  }
  const entry = read.data.entries[options.stringIndex];
  if (!entry || entry.id !== options.entryId || entry.stringIndex !== options.stringIndex) {
    return fail(
      options.file.sourceUri,
      'FMG_SEMANTIC_ENTRY_IDENTITY_MISMATCH',
      'entryId/stringIndex 与当前原生 FMG 文档不一致。'
    );
  }

  const nodeUri = fmgEntryNodeUri({
    documentUri: options.file.sourceUri,
    entryId: options.entryId,
    stringIndex: options.stringIndex
  });
  const payload = buildFmgEntryNodePayload({
    entryId: options.entryId,
    stringIndex: options.stringIndex,
    text: entry.text,
    schemaVersion: read.data.schemaVersion
  });
  const operation: ResourceNodeDeleteOp = {
    id: randomUUID(),
    kind: 'resource_node_delete',
    targetUri: options.file.sourceUri,
    targetPath: options.file.absolutePath,
    resourceKind: 'msg',
    documentUri: options.file.sourceUri,
    documentRevision: read.data.documentRevision,
    expectedHash: read.data.sourceHash,
    expectedDocumentHash: read.data.documentHash,
    writerId: FMG_SEMANTIC_WRITER_ID,
    nodeId: nodeUri,
    expectedNodeHash: payload.snapshot.sha256,
    inverse: {
      kind: 'resource_node_add',
      nodeId: nodeUri,
      payload
    },
    preconditions: [
      {
        type: 'content_hash',
        description: '提交前 FMG 文件必须保持 expectedHash',
        expectedHash: read.data.sourceHash,
        targetUri: options.file.sourceUri
      },
      {
        type: 'resource_exists',
        description: '目标 FMG string slot 必须存在',
        targetUri: nodeUri
      },
      {
        type: 'writer_capability',
        description: '必须由注册的 FMG semantic writer 处理',
        targetUri: options.file.sourceUri,
        details: { writerId: FMG_SEMANTIC_WRITER_ID }
      },
      {
        type: 'overlay_writable',
        description: '只允许写入当前 Mod 覆盖层',
        targetUri: options.file.sourceUri
      }
    ],
    validatorRequirements: [
      { validatorId: 'file_risk', scope: 'before_staging', required: true },
      { validatorId: FMG_SEMANTIC_VALIDATOR_ID, scope: 'before_staging', required: true },
      { validatorId: FMG_SEMANTIC_VALIDATOR_ID, scope: 'staged_output', required: true },
      { validatorId: FMG_SEMANTIC_VALIDATOR_ID, scope: 'after_commit', required: true }
    ],
    rollbackHint: {
      strategy: 'inverse_patch',
      notes: `FMG 槽位 ${nodeUri} 的精确 typed insert inverse`
    },
    riskLevel: 'high',
    metadata: {
      nativeFormatAuthority: true,
      requiresConfirmation: true,
      confirmationReceiptId: confirmation.id,
      entryId: options.entryId,
      stringIndex: options.stringIndex,
      schemaId: read.data.schemaId,
      schemaVersion: read.data.schemaVersion,
      layoutFingerprint: read.data.layoutFingerprint,
      // Strong after-delete postValidate/after_commit proof for duplicate ID/text slots.
      beforeEntries: snapshotFmgEntrySlots(read.data.entries)
    }
  };
  const patch = createPatchIr({
    workspaceId: options.file.workspaceId,
    title: options.title ?? `FMG 删除槽位 ${options.file.relativePath}`,
    author: 'user',
    operations: [operation],
    notes: '原生 FMG slot delete typed PatchIR transaction'
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

export interface CommitFmgEntryAddOptions {
  file: IndexedFile;
  expectedHash: string;
  entryId: number;
  /** Insert index in [0, entryCount]; entryCount means append. */
  stringIndex: number;
  text: string;
  confirmation?: ConfirmationReceipt;
  session?: WorkspaceSession;
  operationLog?: OperationLogStore;
  backupBaseDir?: string;
  recoveryDir?: string;
  title?: string;
}

/** Commit one FMG string-slot insert through typed PatchIR and the native writer. */
export async function commitFmgEntryAddThroughPatchIr(
  options: CommitFmgEntryAddOptions
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
        message: '原生 FMG 槽位新增需要绑定当前资源 URI 的高风险确认凭据。',
        sourceUri: options.file.sourceUri
      }]
    };
  }
  if (!isInt32(options.entryId)
    || !Number.isSafeInteger(options.stringIndex)
    || options.stringIndex < 0
    || typeof options.text !== 'string') {
    return fail(options.file.sourceUri, 'FMG_SEMANTIC_INPUT_INVALID', 'FMG 条目 ID、槽位或文本无效。');
  }

  const read = await readFmgDocumentViaBridge({
    sourcePath: options.file.absolutePath,
    allowedRoots: [dirname(options.file.absolutePath)]
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
    return fail(options.file.sourceUri, 'HASH_MISMATCH', 'expectedHash 与当前 FMG 文件不一致。', {
      expected: options.expectedHash,
      actual: read.data.sourceHash
    });
  }
  if (options.stringIndex > read.data.entries.length) {
    return fail(
      options.file.sourceUri,
      'FMG_SEMANTIC_INSERT_INDEX_OUT_OF_RANGE',
      `stringIndex ${options.stringIndex} 超出可插入范围 [0, ${read.data.entries.length}]。`
    );
  }

  const nodeUri = fmgEntryNodeUri({
    documentUri: options.file.sourceUri,
    entryId: options.entryId,
    stringIndex: options.stringIndex
  });
  const payload = buildFmgEntryNodePayload({
    entryId: options.entryId,
    stringIndex: options.stringIndex,
    text: options.text,
    schemaVersion: read.data.schemaVersion
  });
  const operation: ResourceNodeAddOp = {
    id: randomUUID(),
    kind: 'resource_node_add',
    targetUri: options.file.sourceUri,
    targetPath: options.file.absolutePath,
    resourceKind: 'msg',
    documentUri: options.file.sourceUri,
    documentRevision: read.data.documentRevision,
    expectedHash: read.data.sourceHash,
    expectedDocumentHash: read.data.documentHash,
    writerId: FMG_SEMANTIC_WRITER_ID,
    nodeId: nodeUri,
    payload,
    inverse: {
      kind: 'resource_node_delete',
      nodeId: nodeUri,
      expectedNodeHash: payload.snapshot.sha256
    },
    preconditions: [
      {
        type: 'content_hash',
        description: '提交前 FMG 文件必须保持 expectedHash',
        expectedHash: read.data.sourceHash,
        targetUri: options.file.sourceUri
      },
      {
        type: 'custom',
        description: '目标 FMG string slot 将由原生 insert 在指定索引创建',
        targetUri: nodeUri,
        details: { kind: 'fmg_slot_insert', stringIndex: options.stringIndex }
      },
      {
        type: 'writer_capability',
        description: '必须由注册的 FMG semantic writer 处理',
        targetUri: options.file.sourceUri,
        details: { writerId: FMG_SEMANTIC_WRITER_ID }
      },
      {
        type: 'overlay_writable',
        description: '只允许写入当前 Mod 覆盖层',
        targetUri: options.file.sourceUri
      }
    ],
    validatorRequirements: [
      { validatorId: 'file_risk', scope: 'before_staging', required: true },
      { validatorId: FMG_SEMANTIC_VALIDATOR_ID, scope: 'before_staging', required: true },
      { validatorId: FMG_SEMANTIC_VALIDATOR_ID, scope: 'staged_output', required: true },
      { validatorId: FMG_SEMANTIC_VALIDATOR_ID, scope: 'after_commit', required: true }
    ],
    rollbackHint: {
      strategy: 'inverse_patch',
      notes: `FMG 槽位 ${nodeUri} 的精确 typed delete inverse`
    },
    riskLevel: 'high',
    metadata: {
      nativeFormatAuthority: true,
      requiresConfirmation: true,
      confirmationReceiptId: confirmation.id,
      entryId: options.entryId,
      stringIndex: options.stringIndex,
      schemaId: read.data.schemaId,
      schemaVersion: read.data.schemaVersion,
      layoutFingerprint: read.data.layoutFingerprint,
      beforeEntries: snapshotFmgEntrySlots(read.data.entries)
    }
  };
  const patch = createPatchIr({
    workspaceId: options.file.workspaceId,
    title: options.title ?? `FMG 新增槽位 ${options.file.relativePath}`,
    author: 'user',
    operations: [operation],
    notes: '原生 FMG slot insert typed PatchIR transaction'
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

export interface CommitFmgEntryReorderOptions {
  file: IndexedFile;
  expectedHash: string;
  entryId: number;
  stringIndex: number;
  /** Current-revision anchor slot. Omit to move the entry to the end. */
  beforeStringIndex?: number;
  confirmation?: ConfirmationReceipt;
  session?: WorkspaceSession;
  operationLog?: OperationLogStore;
  backupBaseDir?: string;
  recoveryDir?: string;
  title?: string;
}

/** Commit one complete-order-bound FMG string-slot move through typed PatchIR. */
export async function commitFmgEntryReorderThroughPatchIr(
  options: CommitFmgEntryReorderOptions
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
        message: '原生 FMG 槽位重排需要绑定当前资源 URI 的高风险确认凭据。',
        sourceUri: options.file.sourceUri
      }]
    };
  }
  if (!isInt32(options.entryId)
    || !Number.isSafeInteger(options.stringIndex)
    || options.stringIndex < 0
    || (options.beforeStringIndex !== undefined
      && (!Number.isSafeInteger(options.beforeStringIndex) || options.beforeStringIndex < 0))) {
    return fail(options.file.sourceUri, 'FMG_SEMANTIC_INPUT_INVALID', 'FMG 重排源槽位或锚点槽位无效。');
  }

  const read = await readFmgDocumentViaBridge({
    sourcePath: options.file.absolutePath,
    allowedRoots: [dirname(options.file.absolutePath)]
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
    return fail(options.file.sourceUri, 'HASH_MISMATCH', 'expectedHash 与当前 FMG 文件不一致。', {
      expected: options.expectedHash,
      actual: read.data.sourceHash
    });
  }
  const entry = read.data.entries[options.stringIndex];
  if (!entry || entry.id !== options.entryId || entry.stringIndex !== options.stringIndex) {
    return fail(
      options.file.sourceUri,
      'FMG_SEMANTIC_ENTRY_IDENTITY_MISMATCH',
      'FMG reorder 的 entryId/stringIndex 与当前原生文档不一致。'
    );
  }
  const anchor = options.beforeStringIndex === undefined
    ? undefined
    : read.data.entries[options.beforeStringIndex];
  if (options.beforeStringIndex !== undefined
    && (!anchor || anchor.stringIndex !== options.beforeStringIndex)) {
    return fail(
      options.file.sourceUri,
      'FMG_SEMANTIC_REORDER_ANCHOR_IDENTITY_MISMATCH',
      'FMG reorder 锚点槽位与当前原生文档不一致。'
    );
  }

  const beforeEntries = snapshotFmgEntrySlots(read.data.entries);
  const nodeId = fmgEntryNodeUri({
    documentUri: options.file.sourceUri,
    entryId: entry.id,
    stringIndex: entry.stringIndex
  });
  const beforeNodeId = anchor
    ? fmgEntryNodeUri({
        documentUri: options.file.sourceUri,
        entryId: anchor.id,
        stringIndex: anchor.stringIndex
      })
    : undefined;
  const reordered = reorderFmgEntrySlots({
    documentUri: options.file.sourceUri,
    beforeEntries,
    nodeId,
    beforeNodeId
  });
  if (!reordered.ok) {
    return fail(options.file.sourceUri, reordered.code, reordered.message);
  }
  const expectedOrder = fmgEntryOrderUris(options.file.sourceUri, beforeEntries);
  const parentNodeId = `${options.file.sourceUri}#entries`;
  const operation: ResourceNodeReorderOp = {
    id: randomUUID(),
    kind: 'resource_node_reorder',
    targetUri: options.file.sourceUri,
    targetPath: options.file.absolutePath,
    resourceKind: 'msg',
    documentUri: options.file.sourceUri,
    documentRevision: read.data.documentRevision,
    expectedHash: read.data.sourceHash,
    expectedDocumentHash: read.data.documentHash,
    writerId: FMG_SEMANTIC_WRITER_ID,
    nodeId,
    parentNodeId,
    ...(beforeNodeId ? { beforeNodeId } : {}),
    expectedOrder,
    inverse: {
      kind: 'resource_node_reorder',
      parentNodeId,
      previousOrder: [...expectedOrder]
    },
    preconditions: [
      {
        type: 'content_hash',
        description: '提交前 FMG 文件必须保持 expectedHash',
        expectedHash: read.data.sourceHash,
        targetUri: options.file.sourceUri
      },
      {
        type: 'custom',
        description: 'FMG reorder 必须匹配当前 revision 的完整槽位顺序',
        targetUri: parentNodeId,
        details: {
          expectedOrderHash: hashFmgEntrySlots(beforeEntries),
          entryCount: beforeEntries.length
        }
      },
      {
        type: 'writer_capability',
        description: '必须由注册的 FMG semantic writer 处理',
        targetUri: options.file.sourceUri,
        details: { writerId: FMG_SEMANTIC_WRITER_ID }
      },
      {
        type: 'overlay_writable',
        description: '只允许写入当前 Mod 覆盖层',
        targetUri: options.file.sourceUri
      }
    ],
    validatorRequirements: [
      { validatorId: 'file_risk', scope: 'before_staging', required: true },
      { validatorId: FMG_SEMANTIC_VALIDATOR_ID, scope: 'before_staging', required: true },
      { validatorId: FMG_SEMANTIC_VALIDATOR_ID, scope: 'staged_output', required: true },
      { validatorId: FMG_SEMANTIC_VALIDATOR_ID, scope: 'after_commit', required: true }
    ],
    rollbackHint: {
      strategy: 'inverse_patch',
      notes: `FMG 槽位 ${nodeId} 的完整顺序 typed inverse`
    },
    riskLevel: 'high',
    metadata: {
      nativeFormatAuthority: true,
      requiresConfirmation: true,
      confirmationReceiptId: confirmation.id,
      entryId: entry.id,
      stringIndex: entry.stringIndex,
      beforeStringIndex: anchor?.stringIndex,
      beforeId: anchor?.id,
      schemaId: read.data.schemaId,
      schemaVersion: read.data.schemaVersion,
      layoutFingerprint: read.data.layoutFingerprint,
      beforeEntries
    }
  };
  const patch = createPatchIr({
    workspaceId: options.file.workspaceId,
    title: options.title ?? `FMG 重排槽位 ${options.file.relativePath}`,
    author: 'user',
    operations: [operation],
    notes: '原生 FMG slot reorder typed PatchIR transaction'
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
