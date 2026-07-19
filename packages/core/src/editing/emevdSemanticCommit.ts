import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type {
  ConfirmationReceipt,
  Diagnostic,
  EmevdEventNodePayload,
  EmevdInstructionNodePayload,
  IndexedFile,
  PatchIrOperation,
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
import {
  readEmevdDocumentViaBridge,
  type EmevdBridgeDocument
} from './emevdBridgeCommit.js';
import {
  EMEVD_SEMANTIC_VALIDATOR_ID,
  EMEVD_SEMANTIC_WRITER_ID,
  buildEmevdEmptyEventNodePayload,
  buildEmevdEventNodePayloadFromSnapshot,
  buildEmevdInstructionNodePayloadFromSnapshot,
  emevdEventNodeUri,
  emevdEventOrderUris,
  emevdInstructionArgsFieldUri,
  emevdInstructionNodeUri,
  emevdInstructionOrderUris,
  emevdRestBehaviorFieldUri,
  hashEmevdEventOrder,
  hashEmevdInstructionOrder,
  isRestBehaviorValue,
  normalizeArgsBase64,
  reorderEmevdEventOrder,
  reorderEmevdInstructionOrder,
  snapshotEmevdEventOrder,
  snapshotEmevdInstructionOrder
} from './emevdSemanticContract.js';

export interface CommitEmevdRestBehaviorOptions {
  file: IndexedFile;
  expectedHash: string;
  eventId: number;
  eventIndex: number;
  restBehavior: number;
  confirmation?: ConfirmationReceipt;
  session?: WorkspaceSession;
  operationLog?: OperationLogStore;
  backupBaseDir?: string;
  recoveryDir?: string;
  title?: string;
}

/** Commit one EMEVD restBehavior edit through typed PatchIR and the native semantic writer. */
export async function commitEmevdRestBehaviorThroughPatchIr(
  options: CommitEmevdRestBehaviorOptions
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
        message: '原生 EMEVD 字段修改需要绑定当前资源 URI 的高风险确认凭据。',
        sourceUri: options.file.sourceUri
      }]
    };
  }
  if (!Number.isSafeInteger(options.eventId)
    || !Number.isSafeInteger(options.eventIndex)
    || options.eventIndex < 0
    || !isRestBehaviorValue(options.restBehavior)) {
    return fail(options.file.sourceUri, 'EMEVD_SEMANTIC_INPUT_INVALID', 'EMEVD event 身份或 restBehavior 值无效。');
  }

  const read = await readEmevdDocumentViaBridge({
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
    return fail(options.file.sourceUri, 'HASH_MISMATCH', 'expectedHash 与当前 EMEVD 文件不一致。', {
      expected: options.expectedHash,
      actual: read.data.sourceHash
    });
  }
  const event = read.data.events[options.eventIndex];
  if (!event || event.id !== options.eventId || event.eventIndex !== options.eventIndex) {
    return fail(
      options.file.sourceUri,
      'EMEVD_SEMANTIC_EVENT_IDENTITY_MISMATCH',
      'eventId/eventIndex 与当前原生 EMEVD 文档不一致。'
    );
  }
  if (event.restBehavior === options.restBehavior) {
    return fail(options.file.sourceUri, 'EMEVD_SEMANTIC_NOOP_BLOCKED', 'restBehavior 未发生变化，已阻止空提交。');
  }

  const fieldUri = emevdRestBehaviorFieldUri({
    documentUri: options.file.sourceUri,
    eventId: options.eventId,
    eventIndex: options.eventIndex
  });
  const operation: ResourceFieldEditOp = {
    id: randomUUID(),
    kind: 'resource_field_edit',
    targetUri: options.file.sourceUri,
    targetPath: options.file.absolutePath,
    resourceKind: 'event',
    documentUri: options.file.sourceUri,
    documentRevision: read.data.documentRevision,
    schemaId: read.data.schemaId,
    schemaVersion: read.data.schemaVersion,
    layoutFingerprint: read.data.layoutFingerprint,
    expectedHash: read.data.sourceHash,
    expectedDocumentHash: read.data.documentHash,
    writerId: EMEVD_SEMANTIC_WRITER_ID,
    fieldUri,
    previousValue: { valueType: 'integer', value: event.restBehavior },
    nextValue: { valueType: 'integer', value: options.restBehavior },
    inverse: {
      kind: 'resource_field_edit',
      fieldUri,
      value: { valueType: 'integer', value: event.restBehavior }
    },
    preconditions: [
      {
        type: 'content_hash',
        description: '提交前 EMEVD 外层文件必须保持 expectedHash',
        expectedHash: read.data.sourceHash,
        targetUri: options.file.sourceUri
      },
      {
        type: 'resource_exists',
        description: '目标 EMEVD event occurrence 必须存在',
        targetUri: fieldUri
      },
      {
        type: 'writer_capability',
        description: '必须由注册的 EMEVD semantic writer 处理',
        targetUri: options.file.sourceUri,
        details: { writerId: EMEVD_SEMANTIC_WRITER_ID }
      },
      {
        type: 'overlay_writable',
        description: '只允许写入当前 Mod 覆盖层',
        targetUri: options.file.sourceUri
      }
    ],
    validatorRequirements: [
      { validatorId: 'file_risk', scope: 'before_staging', required: true },
      { validatorId: EMEVD_SEMANTIC_VALIDATOR_ID, scope: 'before_staging', required: true },
      { validatorId: EMEVD_SEMANTIC_VALIDATOR_ID, scope: 'staged_output', required: true },
      { validatorId: EMEVD_SEMANTIC_VALIDATOR_ID, scope: 'after_commit', required: true }
    ],
    rollbackHint: {
      strategy: 'inverse_patch',
      notes: `EMEVD 字段 ${fieldUri} 的 typed inverse`
    },
    riskLevel: 'high',
    metadata: {
      nativeFormatAuthority: true,
      requiresConfirmation: true,
      confirmationReceiptId: confirmation.id,
      eventId: options.eventId,
      eventIndex: options.eventIndex
    }
  };
  const patch = createPatchIr({
    workspaceId: options.file.workspaceId,
    title: options.title ?? `EMEVD restBehavior ${options.file.relativePath}`,
    author: 'user',
    operations: [operation],
    notes: '原生 EMEVD restBehavior typed PatchIR transaction'
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

export interface CommitEmevdInstructionArgsOptions {
  file: IndexedFile;
  expectedHash: string;
  eventId: number;
  eventIndex: number;
  instructionIndex: number;
  expectedBank: number;
  expectedInstructionId: number;
  argsBase64: string;
  confirmation?: ConfirmationReceipt;
  session?: WorkspaceSession;
  operationLog?: OperationLogStore;
  backupBaseDir?: string;
  recoveryDir?: string;
  title?: string;
}

/** Commit one EMEVD instruction args edit through typed PatchIR and the native semantic writer. */
export async function commitEmevdInstructionArgsThroughPatchIr(
  options: CommitEmevdInstructionArgsOptions
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
        message: '原生 EMEVD 指令参数修改需要绑定当前资源 URI 的高风险确认凭据。',
        sourceUri: options.file.sourceUri
      }]
    };
  }
  if (!Number.isSafeInteger(options.eventId)
    || !Number.isSafeInteger(options.eventIndex)
    || options.eventIndex < 0
    || !Number.isSafeInteger(options.instructionIndex)
    || options.instructionIndex < 0
    || !Number.isSafeInteger(options.expectedBank)
    || !Number.isSafeInteger(options.expectedInstructionId)
    || typeof options.argsBase64 !== 'string') {
    return fail(options.file.sourceUri, 'EMEVD_SEMANTIC_INPUT_INVALID', 'EMEVD instruction 身份或 args 无效。');
  }

  let nextArgsBase64: string;
  try {
    nextArgsBase64 = normalizeArgsBase64(options.argsBase64);
  } catch {
    return fail(options.file.sourceUri, 'EMEVD_ARGS_BASE64_INVALID', 'argsBase64 非法。');
  }

  const read = await readEmevdDocumentViaBridge({
    sourcePath: options.file.absolutePath,
    allowedRoots: [dirname(options.file.absolutePath)],
    focusEventIndex: options.eventIndex,
    focusInstructionLocalIndex: options.instructionIndex
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
    return fail(options.file.sourceUri, 'HASH_MISMATCH', 'expectedHash 与当前 EMEVD 文件不一致。', {
      expected: options.expectedHash,
      actual: read.data.sourceHash
    });
  }
  const event = read.data.events[options.eventIndex];
  if (!event || event.id !== options.eventId || event.eventIndex !== options.eventIndex) {
    return fail(
      options.file.sourceUri,
      'EMEVD_SEMANTIC_EVENT_IDENTITY_MISMATCH',
      'eventId/eventIndex 与当前原生 EMEVD 文档不一致。'
    );
  }
  const focused = read.data.focusedInstruction;
  if (!focused
    || focused.eventId !== options.eventId
    || focused.eventIndex !== options.eventIndex
    || focused.instructionIndex !== options.instructionIndex
    || focused.bank !== options.expectedBank
    || focused.id !== options.expectedInstructionId) {
    return fail(
      options.file.sourceUri,
      'EMEVD_SEMANTIC_INSTRUCTION_IDENTITY_MISMATCH',
      'instruction 身份与当前原生 EMEVD 文档不一致。'
    );
  }
  let previousArgsBase64: string;
  try {
    previousArgsBase64 = normalizeArgsBase64(focused.argsBase64);
  } catch {
    return fail(options.file.sourceUri, 'EMEVD_ARGS_BASE64_INVALID', '当前 instruction argsBase64 非法。');
  }
  if (previousArgsBase64 === nextArgsBase64) {
    return fail(options.file.sourceUri, 'EMEVD_SEMANTIC_NOOP_BLOCKED', 'instruction args 未发生变化，已阻止空提交。');
  }

  const fieldUri = emevdInstructionArgsFieldUri({
    documentUri: options.file.sourceUri,
    eventId: options.eventId,
    eventIndex: options.eventIndex,
    instructionIndex: options.instructionIndex,
    bank: options.expectedBank,
    instructionId: options.expectedInstructionId
  });
  const operation: ResourceFieldEditOp = {
    id: randomUUID(),
    kind: 'resource_field_edit',
    targetUri: options.file.sourceUri,
    targetPath: options.file.absolutePath,
    resourceKind: 'event',
    documentUri: options.file.sourceUri,
    documentRevision: read.data.documentRevision,
    schemaId: read.data.schemaId,
    schemaVersion: read.data.schemaVersion,
    layoutFingerprint: read.data.layoutFingerprint,
    expectedHash: read.data.sourceHash,
    expectedDocumentHash: read.data.documentHash,
    writerId: EMEVD_SEMANTIC_WRITER_ID,
    fieldUri,
    previousValue: { valueType: 'bytes', base64: previousArgsBase64 },
    nextValue: { valueType: 'bytes', base64: nextArgsBase64 },
    inverse: {
      kind: 'resource_field_edit',
      fieldUri,
      value: { valueType: 'bytes', base64: previousArgsBase64 }
    },
    preconditions: [
      {
        type: 'content_hash',
        description: '提交前 EMEVD 外层文件必须保持 expectedHash',
        expectedHash: read.data.sourceHash,
        targetUri: options.file.sourceUri
      },
      {
        type: 'resource_exists',
        description: '目标 EMEVD instruction occurrence 必须存在',
        targetUri: fieldUri
      },
      {
        type: 'writer_capability',
        description: '必须由注册的 EMEVD semantic writer 处理',
        targetUri: options.file.sourceUri,
        details: { writerId: EMEVD_SEMANTIC_WRITER_ID }
      },
      {
        type: 'overlay_writable',
        description: '只允许写入当前 Mod 覆盖层',
        targetUri: options.file.sourceUri
      }
    ],
    validatorRequirements: [
      { validatorId: 'file_risk', scope: 'before_staging', required: true },
      { validatorId: EMEVD_SEMANTIC_VALIDATOR_ID, scope: 'before_staging', required: true },
      { validatorId: EMEVD_SEMANTIC_VALIDATOR_ID, scope: 'staged_output', required: true },
      { validatorId: EMEVD_SEMANTIC_VALIDATOR_ID, scope: 'after_commit', required: true }
    ],
    rollbackHint: {
      strategy: 'inverse_patch',
      notes: `EMEVD 字段 ${fieldUri} 的 typed inverse`
    },
    riskLevel: 'high',
    metadata: {
      nativeFormatAuthority: true,
      requiresConfirmation: true,
      confirmationReceiptId: confirmation.id,
      eventId: options.eventId,
      eventIndex: options.eventIndex,
      instructionIndex: options.instructionIndex,
      expectedBank: options.expectedBank,
      expectedInstructionId: options.expectedInstructionId
    }
  };
  const patch = createPatchIr({
    workspaceId: options.file.workspaceId,
    title: options.title ?? `EMEVD instruction args ${options.file.relativePath}`,
    author: 'user',
    operations: [operation],
    notes: '原生 EMEVD instruction args typed PatchIR transaction'
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

export interface CommitEmevdEventReorderOptions {
  file: IndexedFile;
  expectedHash: string;
  eventId: number;
  eventIndex: number;
  /** Current-revision move-before anchor. Omit to append the event. */
  beforeEventIndex?: number;
  confirmation?: ConfirmationReceipt;
  session?: WorkspaceSession;
  operationLog?: OperationLogStore;
  backupBaseDir?: string;
  recoveryDir?: string;
  title?: string;
}

/** Commit one complete-order-bound EMEVD event move through typed PatchIR. */
export async function commitEmevdEventReorderThroughPatchIr(
  options: CommitEmevdEventReorderOptions
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
        message: '原生 EMEVD 事件重排需要绑定当前资源 URI 的高风险确认凭据。',
        sourceUri: options.file.sourceUri
      }]
    };
  }
  if (!Number.isSafeInteger(options.eventId)
    || !Number.isSafeInteger(options.eventIndex)
    || options.eventIndex < 0
    || (options.beforeEventIndex !== undefined
      && (!Number.isSafeInteger(options.beforeEventIndex) || options.beforeEventIndex < 0))) {
    return fail(
      options.file.sourceUri,
      'EMEVD_SEMANTIC_INPUT_INVALID',
      'EMEVD 重排源事件或锚点事件索引无效。'
    );
  }

  const read = await readEmevdDocumentViaBridge({
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
    return fail(options.file.sourceUri, 'HASH_MISMATCH', 'expectedHash 与当前 EMEVD 文件不一致。', {
      expected: options.expectedHash,
      actual: read.data.sourceHash
    });
  }
  const event = read.data.events[options.eventIndex];
  if (!event || event.id !== options.eventId || event.eventIndex !== options.eventIndex) {
    return fail(
      options.file.sourceUri,
      'EMEVD_SEMANTIC_EVENT_IDENTITY_MISMATCH',
      'EMEVD reorder 的 eventId/eventIndex 与当前原生文档不一致。'
    );
  }
  const anchor = options.beforeEventIndex === undefined
    ? undefined
    : read.data.events[options.beforeEventIndex];
  if (options.beforeEventIndex !== undefined
    && (!anchor || anchor.eventIndex !== options.beforeEventIndex)) {
    return fail(
      options.file.sourceUri,
      'EMEVD_SEMANTIC_REORDER_ANCHOR_IDENTITY_MISMATCH',
      'EMEVD reorder 锚点事件与当前原生文档不一致。'
    );
  }

  const beforeEvents = snapshotEmevdEventOrder(read.data.events);
  const nodeId = emevdEventNodeUri({
    documentUri: options.file.sourceUri,
    eventId: event.id,
    eventIndex: event.eventIndex
  });
  const beforeNodeId = anchor
    ? emevdEventNodeUri({
        documentUri: options.file.sourceUri,
        eventId: anchor.id,
        eventIndex: anchor.eventIndex
      })
    : undefined;
  const reordered = reorderEmevdEventOrder({ beforeEvents, nodeId, beforeNodeId });
  if (!reordered.ok) {
    return fail(options.file.sourceUri, reordered.code, reordered.message);
  }
  const expectedOrder = emevdEventOrderUris(options.file.sourceUri, beforeEvents);
  const parentNodeId = `${options.file.sourceUri}#events`;
  const operation: ResourceNodeReorderOp = {
    id: randomUUID(),
    kind: 'resource_node_reorder',
    targetUri: options.file.sourceUri,
    targetPath: options.file.absolutePath,
    resourceKind: 'event',
    documentUri: options.file.sourceUri,
    documentRevision: read.data.documentRevision,
    expectedHash: read.data.sourceHash,
    expectedDocumentHash: read.data.documentHash,
    writerId: EMEVD_SEMANTIC_WRITER_ID,
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
        description: '提交前 EMEVD 外层文件必须保持 expectedHash',
        expectedHash: read.data.sourceHash,
        targetUri: options.file.sourceUri
      },
      {
        type: 'custom',
        description: 'EMEVD reorder 必须匹配当前 revision 的完整事件 semantic hash 顺序',
        targetUri: parentNodeId,
        details: {
          expectedOrderHash: hashEmevdEventOrder(beforeEvents),
          eventCount: beforeEvents.length
        }
      },
      {
        type: 'writer_capability',
        description: '必须由注册的 EMEVD semantic writer 处理',
        targetUri: options.file.sourceUri,
        details: { writerId: EMEVD_SEMANTIC_WRITER_ID }
      },
      {
        type: 'overlay_writable',
        description: '只允许写入当前 Mod 覆盖层',
        targetUri: options.file.sourceUri
      }
    ],
    validatorRequirements: [
      { validatorId: 'file_risk', scope: 'before_staging', required: true },
      { validatorId: EMEVD_SEMANTIC_VALIDATOR_ID, scope: 'before_staging', required: true },
      { validatorId: EMEVD_SEMANTIC_VALIDATOR_ID, scope: 'staged_output', required: true },
      { validatorId: EMEVD_SEMANTIC_VALIDATOR_ID, scope: 'after_commit', required: true }
    ],
    rollbackHint: {
      strategy: 'inverse_patch',
      notes: `EMEVD 事件 ${nodeId} 的完整顺序 typed inverse`
    },
    riskLevel: 'high',
    metadata: {
      nativeFormatAuthority: true,
      requiresConfirmation: true,
      confirmationReceiptId: confirmation.id,
      eventId: event.id,
      eventIndex: event.eventIndex,
      eventHash: event.eventHash,
      beforeEventId: anchor?.id,
      beforeEventIndex: anchor?.eventIndex,
      schemaId: read.data.schemaId,
      schemaVersion: read.data.schemaVersion,
      layoutFingerprint: read.data.layoutFingerprint,
      beforeEvents,
      reorderScope: 'event'
    }
  };
  const patch = createPatchIr({
    workspaceId: options.file.workspaceId,
    title: options.title ?? `EMEVD 重排事件 ${options.file.relativePath}`,
    author: 'user',
    operations: [operation],
    notes: '原生 EMEVD event reorder typed PatchIR transaction'
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

export interface CommitEmevdEventAddOptions {
  file: IndexedFile;
  expectedHash: string;
  newEventId: number;
  restBehavior?: number;
  confirmation?: ConfirmationReceipt;
  session?: WorkspaceSession;
  operationLog?: OperationLogStore;
  backupBaseDir?: string;
  recoveryDir?: string;
  title?: string;
}

/** Append one empty EMEVD event through typed PatchIR; inverse deletes the exact new occurrence. */
export async function commitEmevdEventAddThroughPatchIr(
  options: CommitEmevdEventAddOptions
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
        message: '原生 EMEVD 事件新增需要绑定当前资源 URI 的高风险确认凭据。',
        sourceUri: options.file.sourceUri
      }]
    };
  }
  const restBehavior = options.restBehavior ?? 0;
  if (!Number.isSafeInteger(options.newEventId) || !isRestBehaviorValue(restBehavior)) {
    return fail(
      options.file.sourceUri,
      'EMEVD_SEMANTIC_INPUT_INVALID',
      'EMEVD 新事件 ID 或 restBehavior 无效。'
    );
  }

  const read = await readEmevdDocumentViaBridge({
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
    return fail(options.file.sourceUri, 'HASH_MISMATCH', 'expectedHash 与当前 EMEVD 文件不一致。', {
      expected: options.expectedHash,
      actual: read.data.sourceHash
    });
  }
  if (read.data.events.some((event) => event.id === options.newEventId)) {
    return fail(
      options.file.sourceUri,
      'EMEVD_SEMANTIC_EVENT_ID_CONFLICT',
      `EMEVD 事件 ID ${options.newEventId} 已存在。`
    );
  }

  const eventIndex = read.data.events.length;
  const payload = buildEmevdEmptyEventNodePayload({
    eventId: options.newEventId,
    eventIndex,
    restartType: restBehavior
  });
  return commitEmevdEventAddPayload({
    options,
    document: read.data,
    confirmation,
    payload,
    eventAddMode: 'empty_append',
    title: options.title ?? `EMEVD 新增事件 ${options.file.relativePath}`,
    notes: '原生 EMEVD event add typed PatchIR transaction'
  });
}

export interface CommitEmevdEventDuplicateOptions {
  file: IndexedFile;
  expectedHash: string;
  sourceEventId: number;
  sourceEventIndex: number;
  newEventId: number;
  confirmation?: ConfirmationReceipt;
  session?: WorkspaceSession;
  operationLog?: OperationLogStore;
  backupBaseDir?: string;
  recoveryDir?: string;
  title?: string;
}

/** Clone one existing event through a Bridge-authored snapshot and append it with a new ID. */
export async function commitEmevdEventDuplicateThroughPatchIr(
  options: CommitEmevdEventDuplicateOptions
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
        message: '原生 EMEVD 事件复制需要绑定当前资源 URI 的高风险确认凭据。',
        sourceUri: options.file.sourceUri
      }]
    };
  }
  if (!Number.isSafeInteger(options.sourceEventId)
    || !Number.isSafeInteger(options.sourceEventIndex)
    || options.sourceEventIndex < 0
    || !Number.isSafeInteger(options.newEventId)) {
    return fail(
      options.file.sourceUri,
      'EMEVD_SEMANTIC_INPUT_INVALID',
      'EMEVD 事件复制的 source event 身份或新事件 ID 无效。'
    );
  }

  const read = await readEmevdDocumentViaBridge({
    sourcePath: options.file.absolutePath,
    allowedRoots: [dirname(options.file.absolutePath)],
    snapshotEventIndex: options.sourceEventIndex,
    snapshotEventIdOverride: options.newEventId
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
    return fail(options.file.sourceUri, 'HASH_MISMATCH', 'expectedHash 与当前 EMEVD 文件不一致。', {
      expected: options.expectedHash,
      actual: read.data.sourceHash
    });
  }
  const sourceEvent = read.data.events[options.sourceEventIndex];
  if (!sourceEvent
    || sourceEvent.id !== options.sourceEventId
    || sourceEvent.eventIndex !== options.sourceEventIndex) {
    return fail(
      options.file.sourceUri,
      'EMEVD_SEMANTIC_EVENT_IDENTITY_MISMATCH',
      'EMEVD duplicate 的源 eventId/eventIndex 与当前原生文档不一致。'
    );
  }
  if (read.data.events.some((event) => event.id === options.newEventId)) {
    return fail(
      options.file.sourceUri,
      'EMEVD_SEMANTIC_EVENT_ID_CONFLICT',
      `EMEVD 新事件 ID ${options.newEventId} 已存在。`
    );
  }
  const snapshot = read.data.focusedEventSnapshot;
  if (!snapshot
    || snapshot.eventId !== options.newEventId
    || snapshot.eventIndex !== read.data.events.length
    || snapshot.sourceEventId !== sourceEvent.id
    || snapshot.sourceEventIndex !== sourceEvent.eventIndex
    || snapshot.sourceEventHash !== sourceEvent.eventHash) {
    return fail(
      options.file.sourceUri,
      'EMEVD_SEMANTIC_EVENT_SNAPSHOT_INVALID',
      'Bridge 返回的 EMEVD duplicate snapshot 未绑定源事件与新事件身份。'
    );
  }
  const payload = buildEmevdEventNodePayloadFromSnapshot({
    eventId: snapshot.eventId,
    eventIndex: snapshot.eventIndex,
    restartType: snapshot.restBehavior,
    eventHash: snapshot.eventHash,
    snapshotBase64: snapshot.snapshotBase64,
    snapshotSha256: snapshot.snapshotSha256,
    snapshotSize: snapshot.snapshotSize,
    snapshotFormatId: snapshot.snapshotFormatId,
    snapshotSchemaVersion: snapshot.snapshotSchemaVersion
  });
  if (!payload) {
    return fail(
      options.file.sourceUri,
      'EMEVD_SEMANTIC_EVENT_SNAPSHOT_INVALID',
      'Bridge 返回的 EMEVD duplicate snapshot 未通过 typed payload 校验。'
    );
  }
  return commitEmevdEventAddPayload({
    options,
    document: read.data,
    confirmation,
    payload,
    eventAddMode: 'snapshot_clone_append',
    extraMetadata: {
      sourceEventId: sourceEvent.id,
      sourceEventIndex: sourceEvent.eventIndex,
      sourceEventHash: sourceEvent.eventHash,
      instructionCount: snapshot.instructionCount,
      parameterCount: snapshot.parameterCount
    },
    title: options.title ?? `EMEVD 复制事件 ${options.file.relativePath}`,
    notes: '原生 EMEVD event duplicate typed PatchIR transaction'
  });
}

export interface CommitEmevdEventDeleteOptions {
  file: IndexedFile;
  expectedHash: string;
  eventId: number;
  eventIndex: number;
  confirmation?: ConfirmationReceipt;
  session?: WorkspaceSession;
  operationLog?: OperationLogStore;
  backupBaseDir?: string;
  recoveryDir?: string;
  title?: string;
}

/** Delete one existing event through a Bridge-authored full snapshot and exact insert inverse. */
export async function commitEmevdEventDeleteThroughPatchIr(
  options: CommitEmevdEventDeleteOptions
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
        message: '原生 EMEVD 事件删除需要绑定当前资源 URI 的高风险确认凭据。',
        sourceUri: options.file.sourceUri
      }]
    };
  }
  if (!Number.isSafeInteger(options.eventId)
    || !Number.isSafeInteger(options.eventIndex)
    || options.eventIndex < 0) {
    return fail(
      options.file.sourceUri,
      'EMEVD_SEMANTIC_INPUT_INVALID',
      'EMEVD 删除目标的 eventId/eventIndex 无效。'
    );
  }

  const read = await readEmevdDocumentViaBridge({
    sourcePath: options.file.absolutePath,
    allowedRoots: [dirname(options.file.absolutePath)],
    snapshotEventIndex: options.eventIndex
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
    return fail(options.file.sourceUri, 'HASH_MISMATCH', 'expectedHash 与当前 EMEVD 文件不一致。', {
      expected: options.expectedHash,
      actual: read.data.sourceHash
    });
  }
  if (read.data.events.length <= 1) {
    return fail(options.file.sourceUri, 'EMEVD_SEMANTIC_LAST_EVENT_DELETE_BLOCKED', '不能删除最后一个事件。');
  }
  const event = read.data.events[options.eventIndex];
  const snapshot = read.data.focusedEventSnapshot;
  if (!event
    || event.id !== options.eventId
    || event.eventIndex !== options.eventIndex
    || !snapshot
    || snapshot.eventId !== event.id
    || snapshot.eventIndex !== event.eventIndex
    || snapshot.eventHash !== event.eventHash) {
    return fail(
      options.file.sourceUri,
      'EMEVD_SEMANTIC_EVENT_IDENTITY_MISMATCH',
      'EMEVD delete 的 eventId/eventIndex/snapshot 与当前原生文档不一致。'
    );
  }
  const payload = buildEmevdEventNodePayloadFromSnapshot({
    eventId: snapshot.eventId,
    eventIndex: snapshot.eventIndex,
    restartType: snapshot.restBehavior,
    eventHash: snapshot.eventHash,
    snapshotBase64: snapshot.snapshotBase64,
    snapshotSha256: snapshot.snapshotSha256,
    snapshotSize: snapshot.snapshotSize,
    snapshotFormatId: snapshot.snapshotFormatId,
    snapshotSchemaVersion: snapshot.snapshotSchemaVersion
  });
  if (!payload) {
    return fail(
      options.file.sourceUri,
      'EMEVD_SEMANTIC_EVENT_SNAPSHOT_INVALID',
      'Bridge 返回的 EMEVD event snapshot 未通过 typed payload 校验。'
    );
  }

  const beforeEvents = snapshotEmevdEventOrder(read.data.events);
  const nodeId = emevdEventNodeUri({
    documentUri: options.file.sourceUri,
    eventId: event.id,
    eventIndex: event.eventIndex
  });
  const operation: ResourceNodeDeleteOp = {
    id: randomUUID(),
    kind: 'resource_node_delete',
    targetUri: options.file.sourceUri,
    targetPath: options.file.absolutePath,
    resourceKind: 'event',
    documentUri: options.file.sourceUri,
    documentRevision: read.data.documentRevision,
    expectedHash: read.data.sourceHash,
    expectedDocumentHash: read.data.documentHash,
    writerId: EMEVD_SEMANTIC_WRITER_ID,
    nodeId,
    expectedNodeHash: payload.eventHash,
    inverse: {
      kind: 'resource_node_add',
      nodeId,
      payload
    },
    preconditions: [
      {
        type: 'content_hash',
        description: '提交前 EMEVD 外层文件必须保持 expectedHash',
        expectedHash: read.data.sourceHash,
        targetUri: options.file.sourceUri
      },
      {
        type: 'custom',
        description: 'EMEVD delete 必须匹配当前 revision 的完整事件 semantic hash 顺序',
        targetUri: `${options.file.sourceUri}#events`,
        details: {
          expectedOrderHash: hashEmevdEventOrder(beforeEvents),
          eventCount: beforeEvents.length,
          snapshotSha256: payload.snapshot.sha256,
          snapshotSize: payload.snapshot.size
        }
      },
      {
        type: 'writer_capability',
        description: '必须由注册的 EMEVD semantic writer 处理',
        targetUri: options.file.sourceUri,
        details: { writerId: EMEVD_SEMANTIC_WRITER_ID }
      },
      {
        type: 'overlay_writable',
        description: '只允许写入当前 Mod 覆盖层',
        targetUri: options.file.sourceUri
      }
    ],
    validatorRequirements: [
      { validatorId: 'file_risk', scope: 'before_staging', required: true },
      { validatorId: EMEVD_SEMANTIC_VALIDATOR_ID, scope: 'before_staging', required: true },
      { validatorId: EMEVD_SEMANTIC_VALIDATOR_ID, scope: 'staged_output', required: true },
      { validatorId: EMEVD_SEMANTIC_VALIDATOR_ID, scope: 'after_commit', required: true }
    ],
    rollbackHint: {
      strategy: 'inverse_patch',
      notes: `EMEVD 事件 ${nodeId} 的完整 snapshot insert inverse`
    },
    riskLevel: 'high',
    metadata: {
      nativeFormatAuthority: true,
      requiresConfirmation: true,
      confirmationReceiptId: confirmation.id,
      eventId: event.id,
      eventIndex: event.eventIndex,
      eventHash: event.eventHash,
      instructionCount: snapshot.instructionCount,
      parameterCount: snapshot.parameterCount,
      eventDeleteMode: 'snapshot_bound',
      schemaId: read.data.schemaId,
      schemaVersion: read.data.schemaVersion,
      layoutFingerprint: read.data.layoutFingerprint,
      beforeEvents
    }
  };
  const patch = createPatchIr({
    workspaceId: options.file.workspaceId,
    title: options.title ?? `EMEVD 删除事件 ${options.file.relativePath}`,
    author: 'user',
    operations: [operation],
    notes: '原生 EMEVD event delete typed PatchIR transaction with Bridge snapshot'
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

export interface CommitEmevdInstructionAddOptions {
  file: IndexedFile;
  expectedHash: string;
  eventId: number;
  eventIndex: number;
  instructionIndex: number;
  bank: number;
  instructionId: number;
  /** Opaque canonical instruction args until an EMEDF schema is bound. */
  argsBase64: string;
  confirmation?: ConfirmationReceipt;
  session?: WorkspaceSession;
  operationLog?: OperationLogStore;
  backupBaseDir?: string;
  recoveryDir?: string;
  title?: string;
}

/** Add one zero-parameter instruction from a Bridge-authored native snapshot. */
export async function commitEmevdInstructionAddThroughPatchIr(
  options: CommitEmevdInstructionAddOptions
): Promise<SaveTextResourceResult> {
  const confirmationError = validateInstructionConfirmation(options, '新增');
  if (confirmationError) return confirmationError;
  if (!Number.isSafeInteger(options.eventId)
    || !Number.isSafeInteger(options.eventIndex)
    || options.eventIndex < 0
    || !Number.isSafeInteger(options.instructionIndex)
    || options.instructionIndex < 0
    || !isInt32(options.bank)
    || !isInt32(options.instructionId)
    || typeof options.argsBase64 !== 'string') {
    return fail(options.file.sourceUri, 'EMEVD_SEMANTIC_INPUT_INVALID', 'EMEVD instruction add 输入无效。');
  }
  let argsBase64: string;
  try {
    argsBase64 = normalizeArgsBase64(options.argsBase64);
  } catch {
    return fail(options.file.sourceUri, 'EMEVD_ARGS_BASE64_INVALID', 'instruction add argsBase64 非法。');
  }
  const read = await readEmevdDocumentViaBridge({
    sourcePath: options.file.absolutePath,
    allowedRoots: [dirname(options.file.absolutePath)],
    instructionOrderEventIndex: options.eventIndex,
    authorInstruction: {
      eventIndex: options.eventIndex,
      instructionIndex: options.instructionIndex,
      bank: options.bank,
      id: options.instructionId,
      argsBase64
    }
  });
  const checked = checkInstructionRead(options, read);
  if ('failure' in checked) return checked.failure;
  const { document, event, order } = checked;
  const snapshot = document.authoredInstructionSnapshot;
  if (!snapshot
    || options.instructionIndex > order.instructions.length
    || snapshot.eventId !== event.id
    || snapshot.eventIndex !== event.eventIndex
    || snapshot.eventHash !== event.eventHash
    || snapshot.instructionIndex !== options.instructionIndex
    || snapshot.bank !== options.bank
    || snapshot.id !== options.instructionId
    || snapshot.layerOffset !== -1
    || snapshot.argsBase64 !== argsBase64
    || snapshot.parameterCount !== 0) {
    return fail(
      options.file.sourceUri,
      'EMEVD_SEMANTIC_AUTHORED_INSTRUCTION_SNAPSHOT_INVALID',
      'Bridge authored instruction snapshot 未与父事件、插入位置或零参数约束绑定。'
    );
  }
  const payload = instructionPayloadFromSnapshot(snapshot, options.instructionIndex);
  if (!payload) {
    return fail(
      options.file.sourceUri,
      'EMEVD_SEMANTIC_AUTHORED_INSTRUCTION_SNAPSHOT_INVALID',
      'Bridge authored instruction snapshot 未通过 typed payload 校验。'
    );
  }
  const beforeInstructions = snapshotEmevdInstructionOrder(order.instructions);
  const nodeId = emevdInstructionNodeUri({
    documentUri: options.file.sourceUri,
    eventId: event.id,
    eventIndex: event.eventIndex,
    instructionIndex: options.instructionIndex,
    bank: payload.bank,
    instructionId: payload.instructionId
  });
  const operation: ResourceNodeAddOp = {
    ...instructionOperationBase(options, document, nodeId),
    kind: 'resource_node_add',
    payload,
    inverse: {
      kind: 'resource_node_delete',
      nodeId,
      expectedNodeHash: payload.instructionHash
    },
    preconditions: instructionNodePreconditions({
      options,
      document,
      event,
      beforeInstructions,
      description: 'add'
    }),
    rollbackHint: {
      strategy: 'inverse_patch',
      notes: `EMEVD 新增指令 ${nodeId} 的精确 typed delete inverse`
    },
    metadata: instructionNodeMetadata({
      options,
      document,
      event,
      beforeInstructions,
      extra: {
        instructionAddMode: 'bridge_authored_zero_parameter_insert',
        authoredInstructionHash: payload.instructionHash
      }
    })
  };
  return executeEmevdInstructionOperation({
    options,
    operation,
    title: options.title ?? `EMEVD 新增指令 ${options.file.relativePath}`,
    notes: '原生 EMEVD instruction add typed PatchIR transaction with Bridge-authored snapshot'
  });
}

export interface CommitEmevdInstructionDuplicateOptions {
  file: IndexedFile;
  expectedHash: string;
  eventId: number;
  eventIndex: number;
  sourceInstructionIndex: number;
  confirmation?: ConfirmationReceipt;
  session?: WorkspaceSession;
  operationLog?: OperationLogStore;
  backupBaseDir?: string;
  recoveryDir?: string;
  title?: string;
}

/** Clone one instruction and all attached parameter substitutions after the source occurrence. */
export async function commitEmevdInstructionDuplicateThroughPatchIr(
  options: CommitEmevdInstructionDuplicateOptions
): Promise<SaveTextResourceResult> {
  const confirmationError = validateInstructionConfirmation(options, '复制');
  if (confirmationError) return confirmationError;
  if (!Number.isSafeInteger(options.eventId)
    || !Number.isSafeInteger(options.eventIndex)
    || options.eventIndex < 0
    || !Number.isSafeInteger(options.sourceInstructionIndex)
    || options.sourceInstructionIndex < 0) {
    return fail(options.file.sourceUri, 'EMEVD_SEMANTIC_INPUT_INVALID', 'EMEVD instruction duplicate 身份无效。');
  }
  const read = await readEmevdDocumentViaBridge({
    sourcePath: options.file.absolutePath,
    allowedRoots: [dirname(options.file.absolutePath)],
    snapshotInstructionEventIndex: options.eventIndex,
    snapshotInstructionLocalIndex: options.sourceInstructionIndex,
    instructionOrderEventIndex: options.eventIndex
  });
  const checked = checkInstructionRead(options, read);
  if ('failure' in checked) return checked.failure;
  const { document, event, order } = checked;
  const snapshot = document.focusedInstructionSnapshot;
  const sourceInstruction = order.instructions[options.sourceInstructionIndex];
  if (!snapshot
    || !sourceInstruction
    || snapshot.eventId !== event.id
    || snapshot.eventIndex !== event.eventIndex
    || snapshot.eventHash !== event.eventHash
    || snapshot.instructionIndex !== options.sourceInstructionIndex
    || snapshot.bank !== sourceInstruction.bank
    || snapshot.id !== sourceInstruction.id
    || snapshot.instructionHash !== sourceInstruction.instructionHash
    || snapshot.parameterCount !== sourceInstruction.parameterCount) {
    return fail(options.file.sourceUri, 'EMEVD_SEMANTIC_INSTRUCTION_SNAPSHOT_INVALID', 'Bridge instruction snapshot 未与完整指令顺序绑定。');
  }
  const insertInstructionIndex = options.sourceInstructionIndex + 1;
  const payload = instructionPayloadFromSnapshot(snapshot, insertInstructionIndex);
  if (!payload) {
    return fail(options.file.sourceUri, 'EMEVD_SEMANTIC_INSTRUCTION_SNAPSHOT_INVALID', 'Bridge instruction snapshot 未通过 typed payload 校验。');
  }
  const beforeInstructions = snapshotEmevdInstructionOrder(order.instructions);
  const nodeId = emevdInstructionNodeUri({
    documentUri: options.file.sourceUri,
    eventId: event.id,
    eventIndex: event.eventIndex,
    instructionIndex: insertInstructionIndex,
    bank: payload.bank,
    instructionId: payload.instructionId
  });
  const operation: ResourceNodeAddOp = {
    ...instructionOperationBase(options, document, nodeId),
    kind: 'resource_node_add',
    payload,
    inverse: {
      kind: 'resource_node_delete',
      nodeId,
      expectedNodeHash: payload.instructionHash
    },
    preconditions: instructionNodePreconditions({
      options,
      document,
      event,
      beforeInstructions,
      description: 'duplicate'
    }),
    rollbackHint: {
      strategy: 'inverse_patch',
      notes: `EMEVD 新指令 ${nodeId} 的精确 typed delete inverse`
    },
    metadata: instructionNodeMetadata({
      options,
      document,
      event,
      beforeInstructions,
      extra: {
        instructionAddMode: 'snapshot_clone_insert',
        sourceInstructionIndex: options.sourceInstructionIndex,
        sourceInstructionHash: sourceInstruction.instructionHash
      }
    })
  };
  return executeEmevdInstructionOperation({
    options,
    operation,
    title: options.title ?? `EMEVD 复制指令 ${options.file.relativePath}`,
    notes: '原生 EMEVD instruction duplicate typed PatchIR transaction'
  });
}

export interface CommitEmevdInstructionDeleteOptions {
  file: IndexedFile;
  expectedHash: string;
  eventId: number;
  eventIndex: number;
  instructionIndex: number;
  confirmation?: ConfirmationReceipt;
  session?: WorkspaceSession;
  operationLog?: OperationLogStore;
  backupBaseDir?: string;
  recoveryDir?: string;
  title?: string;
}

/** Delete one instruction with a Bridge-authored exact snapshot inverse. */
export async function commitEmevdInstructionDeleteThroughPatchIr(
  options: CommitEmevdInstructionDeleteOptions
): Promise<SaveTextResourceResult> {
  const confirmationError = validateInstructionConfirmation(options, '删除');
  if (confirmationError) return confirmationError;
  if (!Number.isSafeInteger(options.eventId)
    || !Number.isSafeInteger(options.eventIndex)
    || options.eventIndex < 0
    || !Number.isSafeInteger(options.instructionIndex)
    || options.instructionIndex < 0) {
    return fail(options.file.sourceUri, 'EMEVD_SEMANTIC_INPUT_INVALID', 'EMEVD instruction delete 身份无效。');
  }
  const read = await readEmevdDocumentViaBridge({
    sourcePath: options.file.absolutePath,
    allowedRoots: [dirname(options.file.absolutePath)],
    snapshotInstructionEventIndex: options.eventIndex,
    snapshotInstructionLocalIndex: options.instructionIndex,
    instructionOrderEventIndex: options.eventIndex
  });
  const checked = checkInstructionRead(options, read);
  if ('failure' in checked) return checked.failure;
  const { document, event, order } = checked;
  if (order.instructions.length <= 1) {
    return fail(options.file.sourceUri, 'EMEVD_SEMANTIC_LAST_INSTRUCTION_DELETE_BLOCKED', '不能删除父事件中的最后一条指令。');
  }
  const snapshot = document.focusedInstructionSnapshot;
  const target = order.instructions[options.instructionIndex];
  if (!snapshot
    || !target
    || snapshot.eventId !== event.id
    || snapshot.eventIndex !== event.eventIndex
    || snapshot.eventHash !== event.eventHash
    || snapshot.instructionIndex !== options.instructionIndex
    || snapshot.bank !== target.bank
    || snapshot.id !== target.id
    || snapshot.instructionHash !== target.instructionHash
    || snapshot.parameterCount !== target.parameterCount) {
    return fail(options.file.sourceUri, 'EMEVD_SEMANTIC_INSTRUCTION_SNAPSHOT_INVALID', 'Bridge instruction delete snapshot 未与完整指令顺序绑定。');
  }
  const payload = instructionPayloadFromSnapshot(snapshot, options.instructionIndex);
  if (!payload) {
    return fail(options.file.sourceUri, 'EMEVD_SEMANTIC_INSTRUCTION_SNAPSHOT_INVALID', 'Bridge instruction snapshot 未通过 typed payload 校验。');
  }
  const beforeInstructions = snapshotEmevdInstructionOrder(order.instructions);
  const nodeId = emevdInstructionNodeUri({
    documentUri: options.file.sourceUri,
    eventId: event.id,
    eventIndex: event.eventIndex,
    instructionIndex: options.instructionIndex,
    bank: payload.bank,
    instructionId: payload.instructionId
  });
  const operation: ResourceNodeDeleteOp = {
    ...instructionOperationBase(options, document, nodeId),
    kind: 'resource_node_delete',
    expectedNodeHash: payload.instructionHash,
    inverse: { kind: 'resource_node_add', nodeId, payload },
    preconditions: instructionNodePreconditions({
      options,
      document,
      event,
      beforeInstructions,
      description: 'delete'
    }),
    rollbackHint: {
      strategy: 'inverse_patch',
      notes: `EMEVD 指令 ${nodeId} 的完整 snapshot insert inverse`
    },
    metadata: instructionNodeMetadata({
      options,
      document,
      event,
      beforeInstructions,
      extra: { instructionDeleteMode: 'snapshot_bound' }
    })
  };
  return executeEmevdInstructionOperation({
    options,
    operation,
    title: options.title ?? `EMEVD 删除指令 ${options.file.relativePath}`,
    notes: '原生 EMEVD instruction delete typed PatchIR transaction'
  });
}

export interface CommitEmevdInstructionReorderOptions {
  file: IndexedFile;
  expectedHash: string;
  eventId: number;
  eventIndex: number;
  instructionIndex: number;
  /** Current-revision move-before anchor. Omit to append. */
  beforeInstructionIndex?: number;
  confirmation?: ConfirmationReceipt;
  session?: WorkspaceSession;
  operationLog?: OperationLogStore;
  backupBaseDir?: string;
  recoveryDir?: string;
  title?: string;
}

/** Move one instruction within its parent event using a complete-order guard. */
export async function commitEmevdInstructionReorderThroughPatchIr(
  options: CommitEmevdInstructionReorderOptions
): Promise<SaveTextResourceResult> {
  const confirmationError = validateInstructionConfirmation(options, '重排');
  if (confirmationError) return confirmationError;
  if (!Number.isSafeInteger(options.eventId)
    || !Number.isSafeInteger(options.eventIndex)
    || options.eventIndex < 0
    || !Number.isSafeInteger(options.instructionIndex)
    || options.instructionIndex < 0
    || (options.beforeInstructionIndex !== undefined
      && (!Number.isSafeInteger(options.beforeInstructionIndex)
        || options.beforeInstructionIndex < 0))) {
    return fail(options.file.sourceUri, 'EMEVD_SEMANTIC_INPUT_INVALID', 'EMEVD instruction reorder 源或锚点身份无效。');
  }
  const read = await readEmevdDocumentViaBridge({
    sourcePath: options.file.absolutePath,
    allowedRoots: [dirname(options.file.absolutePath)],
    instructionOrderEventIndex: options.eventIndex
  });
  const checked = checkInstructionRead(options, read);
  if ('failure' in checked) return checked.failure;
  const { document, event, order } = checked;
  const beforeInstructions = snapshotEmevdInstructionOrder(order.instructions);
  const source = beforeInstructions[options.instructionIndex];
  const anchor = options.beforeInstructionIndex === undefined
    ? undefined
    : beforeInstructions[options.beforeInstructionIndex];
  if (!source || (options.beforeInstructionIndex !== undefined && !anchor)) {
    return fail(options.file.sourceUri, 'EMEVD_SEMANTIC_INSTRUCTION_IDENTITY_MISMATCH', 'EMEVD instruction reorder 源或锚点不在当前完整顺序中。');
  }
  const nodeId = emevdInstructionNodeUri({
    documentUri: options.file.sourceUri,
    eventId: event.id,
    eventIndex: event.eventIndex,
    instructionIndex: options.instructionIndex,
    bank: source.bank,
    instructionId: source.id
  });
  const beforeNodeId = anchor
    ? emevdInstructionNodeUri({
        documentUri: options.file.sourceUri,
        eventId: event.id,
        eventIndex: event.eventIndex,
        instructionIndex: options.beforeInstructionIndex!,
        bank: anchor.bank,
        instructionId: anchor.id
      })
    : undefined;
  const reordered = reorderEmevdInstructionOrder({
    documentUri: options.file.sourceUri,
    eventId: event.id,
    eventIndex: event.eventIndex,
    beforeInstructions,
    nodeId,
    beforeNodeId
  });
  if (!reordered.ok) return fail(options.file.sourceUri, reordered.code, reordered.message);
  const parentNodeId = emevdEventNodeUri({
    documentUri: options.file.sourceUri,
    eventId: event.id,
    eventIndex: event.eventIndex
  });
  const expectedOrder = emevdInstructionOrderUris({
    documentUri: options.file.sourceUri,
    eventId: event.id,
    eventIndex: event.eventIndex,
    instructions: beforeInstructions
  });
  const operation: ResourceNodeReorderOp = {
    ...instructionOperationBase(options, document, nodeId),
    kind: 'resource_node_reorder',
    parentNodeId,
    ...(beforeNodeId ? { beforeNodeId } : {}),
    expectedOrder,
    inverse: { kind: 'resource_node_reorder', parentNodeId, previousOrder: [...expectedOrder] },
    preconditions: instructionNodePreconditions({
      options,
      document,
      event,
      beforeInstructions,
      description: 'reorder'
    }),
    rollbackHint: {
      strategy: 'inverse_patch',
      notes: `EMEVD 指令 ${nodeId} 的完整顺序 typed inverse`
    },
    metadata: instructionNodeMetadata({
      options,
      document,
      event,
      beforeInstructions,
      extra: { reorderScope: 'instruction' }
    })
  };
  return executeEmevdInstructionOperation({
    options,
    operation,
    title: options.title ?? `EMEVD 重排指令 ${options.file.relativePath}`,
    notes: '原生 EMEVD instruction reorder typed PatchIR transaction'
  });
}

async function commitEmevdEventAddPayload(input: {
  options: {
    file: IndexedFile;
    session?: WorkspaceSession;
    operationLog?: OperationLogStore;
    backupBaseDir?: string;
    recoveryDir?: string;
  };
  document: EmevdBridgeDocument;
  confirmation: ConfirmationReceipt;
  payload: EmevdEventNodePayload;
  eventAddMode: 'empty_append' | 'snapshot_clone_append';
  extraMetadata?: Record<string, unknown>;
  title: string;
  notes: string;
}): Promise<SaveTextResourceResult> {
  const { options, document, payload } = input;
  const beforeEvents = snapshotEmevdEventOrder(document.events);
  const nodeId = emevdEventNodeUri({
    documentUri: options.file.sourceUri,
    eventId: payload.eventId,
    eventIndex: payload.eventIndex
  });
  const operation: ResourceNodeAddOp = {
    id: randomUUID(),
    kind: 'resource_node_add',
    targetUri: options.file.sourceUri,
    targetPath: options.file.absolutePath,
    resourceKind: 'event',
    documentUri: options.file.sourceUri,
    documentRevision: document.documentRevision,
    expectedHash: document.sourceHash,
    expectedDocumentHash: document.documentHash,
    writerId: EMEVD_SEMANTIC_WRITER_ID,
    nodeId,
    payload,
    inverse: {
      kind: 'resource_node_delete',
      nodeId,
      expectedNodeHash: payload.eventHash
    },
    preconditions: [
      {
        type: 'content_hash',
        description: '提交前 EMEVD 外层文件必须保持 expectedHash',
        expectedHash: document.sourceHash,
        targetUri: options.file.sourceUri
      },
      {
        type: 'custom',
        description: 'EMEVD event add 必须匹配当前 revision 的完整事件 semantic hash 顺序',
        targetUri: `${options.file.sourceUri}#events`,
        details: {
          expectedOrderHash: hashEmevdEventOrder(beforeEvents),
          eventCount: beforeEvents.length,
          eventAddMode: input.eventAddMode
        }
      },
      {
        type: 'writer_capability',
        description: '必须由注册的 EMEVD semantic writer 处理',
        targetUri: options.file.sourceUri,
        details: { writerId: EMEVD_SEMANTIC_WRITER_ID }
      },
      {
        type: 'overlay_writable',
        description: '只允许写入当前 Mod 覆盖层',
        targetUri: options.file.sourceUri
      }
    ],
    validatorRequirements: [
      { validatorId: 'file_risk', scope: 'before_staging', required: true },
      { validatorId: EMEVD_SEMANTIC_VALIDATOR_ID, scope: 'before_staging', required: true },
      { validatorId: EMEVD_SEMANTIC_VALIDATOR_ID, scope: 'staged_output', required: true },
      { validatorId: EMEVD_SEMANTIC_VALIDATOR_ID, scope: 'after_commit', required: true }
    ],
    rollbackHint: {
      strategy: 'inverse_patch',
      notes: `EMEVD 新事件 ${nodeId} 的精确 typed delete inverse`
    },
    riskLevel: 'high',
    metadata: {
      nativeFormatAuthority: true,
      requiresConfirmation: true,
      confirmationReceiptId: input.confirmation.id,
      eventId: payload.eventId,
      eventIndex: payload.eventIndex,
      eventHash: payload.eventHash,
      eventAddMode: input.eventAddMode,
      schemaId: document.schemaId,
      schemaVersion: document.schemaVersion,
      layoutFingerprint: document.layoutFingerprint,
      beforeEvents,
      ...input.extraMetadata
    }
  };
  const patch = createPatchIr({
    workspaceId: options.file.workspaceId,
    title: input.title,
    author: 'user',
    operations: [operation],
    notes: input.notes
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

type InstructionCommitOptions = {
  file: IndexedFile;
  expectedHash: string;
  eventId: number;
  eventIndex: number;
  confirmation?: ConfirmationReceipt;
  session?: WorkspaceSession;
  operationLog?: OperationLogStore;
  backupBaseDir?: string;
  recoveryDir?: string;
};

function validateInstructionConfirmation(
  options: InstructionCommitOptions,
  action: string
): SaveTextResourceResult | undefined {
  const confirmation = options.confirmation;
  if (confirmation
    && confirmation.riskLevel === 'high'
    && confirmation.sourceUri === options.file.sourceUri
    && confirmation.subjects.includes(options.file.sourceUri)) {
    return undefined;
  }
  return {
    ok: false,
    changedFiles: [],
    requiresConfirmation: true,
    diagnostics: [{
      severity: 'error',
      code: 'EDIT_CONFIRMATION_REQUIRED',
      message: `原生 EMEVD 指令${action}需要绑定当前资源 URI 的高风险确认凭据。`,
      sourceUri: options.file.sourceUri
    }]
  };
}

function checkInstructionRead(
  options: InstructionCommitOptions,
  read: Awaited<ReturnType<typeof readEmevdDocumentViaBridge>>
):
  | {
      document: EmevdBridgeDocument;
      event: EmevdBridgeDocument['events'][number];
      order: NonNullable<EmevdBridgeDocument['focusedEventInstructionOrder']>;
    }
  | { failure: SaveTextResourceResult } {
  if (!read.ok || !read.data) {
    return {
      failure: {
        ok: false,
        changedFiles: [],
        diagnostics: read.diagnostics.map((diagnostic) => ({
          severity: diagnostic.severity as Diagnostic['severity'],
          code: diagnostic.code,
          message: diagnostic.message,
          sourceUri: options.file.sourceUri
        }))
      }
    };
  }
  if (read.data.sourceHash !== options.expectedHash) {
    return {
      failure: fail(options.file.sourceUri, 'HASH_MISMATCH', 'expectedHash 与当前 EMEVD 文件不一致。', {
        expected: options.expectedHash,
        actual: read.data.sourceHash
      })
    };
  }
  const event = read.data.events[options.eventIndex];
  const order = read.data.focusedEventInstructionOrder;
  if (!event
    || event.id !== options.eventId
    || event.eventIndex !== options.eventIndex
    || !order
    || order.eventId !== event.id
    || order.eventIndex !== event.eventIndex
    || order.eventHash !== event.eventHash
    || order.instructionCount !== event.instructionCount
    || order.parameterCount !== event.parameterCount) {
    return {
      failure: fail(
        options.file.sourceUri,
        'EMEVD_SEMANTIC_INSTRUCTION_EVENT_IDENTITY_MISMATCH',
        'EMEVD instruction 的父事件或完整指令顺序与当前原生文档不一致。'
      )
    };
  }
  return { document: read.data, event, order };
}

function instructionPayloadFromSnapshot(
  snapshot: NonNullable<EmevdBridgeDocument['focusedInstructionSnapshot']>,
  instructionIndex: number
): EmevdInstructionNodePayload | undefined {
  return buildEmevdInstructionNodePayloadFromSnapshot({
    eventId: snapshot.eventId,
    eventIndex: snapshot.eventIndex,
    instructionIndex,
    bank: snapshot.bank,
    instructionId: snapshot.id,
    layerOffset: snapshot.layerOffset,
    argsBase64: snapshot.argsBase64,
    parameterCount: snapshot.parameterCount,
    instructionHash: snapshot.instructionHash,
    snapshotBase64: snapshot.snapshotBase64,
    snapshotSha256: snapshot.snapshotSha256,
    snapshotSize: snapshot.snapshotSize,
    snapshotFormatId: snapshot.snapshotFormatId,
    snapshotSchemaVersion: snapshot.snapshotSchemaVersion
  });
}

function isInt32(value: number): boolean {
  return Number.isInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647;
}

function instructionOperationBase(
  options: InstructionCommitOptions,
  document: EmevdBridgeDocument,
  nodeId: string
) {
  return {
    id: randomUUID(),
    targetUri: options.file.sourceUri,
    targetPath: options.file.absolutePath,
    resourceKind: 'event' as const,
    documentUri: options.file.sourceUri,
    documentRevision: document.documentRevision,
    expectedHash: document.sourceHash,
    expectedDocumentHash: document.documentHash,
    writerId: EMEVD_SEMANTIC_WRITER_ID,
    nodeId,
    validatorRequirements: [
      { validatorId: 'file_risk', scope: 'before_staging' as const, required: true },
      { validatorId: EMEVD_SEMANTIC_VALIDATOR_ID, scope: 'before_staging' as const, required: true },
      { validatorId: EMEVD_SEMANTIC_VALIDATOR_ID, scope: 'staged_output' as const, required: true },
      { validatorId: EMEVD_SEMANTIC_VALIDATOR_ID, scope: 'after_commit' as const, required: true }
    ],
    riskLevel: 'high' as const
  };
}

function instructionNodePreconditions(input: {
  options: InstructionCommitOptions;
  document: EmevdBridgeDocument;
  event: EmevdBridgeDocument['events'][number];
  beforeInstructions: Parameters<typeof snapshotEmevdInstructionOrder>[0];
  description: string;
}): PatchIrOperation['preconditions'] {
  const parentNodeId = emevdEventNodeUri({
    documentUri: input.options.file.sourceUri,
    eventId: input.event.id,
    eventIndex: input.event.eventIndex
  });
  return [
    {
      type: 'content_hash',
      description: '提交前 EMEVD 外层文件必须保持 expectedHash',
      expectedHash: input.document.sourceHash,
      targetUri: input.options.file.sourceUri
    },
    {
      type: 'custom',
      description: `EMEVD instruction ${input.description} 必须匹配父事件的完整 semantic hash 顺序`,
      targetUri: parentNodeId,
      details: {
        expectedInstructionOrderHash: hashEmevdInstructionOrder(input.beforeInstructions),
        instructionCount: input.beforeInstructions.length,
        parentEventHash: input.event.eventHash
      }
    },
    {
      type: 'writer_capability',
      description: '必须由注册的 EMEVD semantic writer 处理',
      targetUri: input.options.file.sourceUri,
      details: { writerId: EMEVD_SEMANTIC_WRITER_ID }
    },
    {
      type: 'overlay_writable',
      description: '只允许写入当前 Mod 覆盖层',
      targetUri: input.options.file.sourceUri
    }
  ];
}

function instructionNodeMetadata(input: {
  options: InstructionCommitOptions;
  document: EmevdBridgeDocument;
  event: EmevdBridgeDocument['events'][number];
  beforeInstructions: Parameters<typeof snapshotEmevdInstructionOrder>[0];
  extra: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    nativeFormatAuthority: true,
    requiresConfirmation: true,
    confirmationReceiptId: input.options.confirmation!.id,
    schemaId: input.document.schemaId,
    schemaVersion: input.document.schemaVersion,
    layoutFingerprint: input.document.layoutFingerprint,
    beforeEvents: snapshotEmevdEventOrder(input.document.events),
    beforeInstructions: snapshotEmevdInstructionOrder(input.beforeInstructions),
    beforeInstructionEvent: {
      eventId: input.event.id,
      eventIndex: input.event.eventIndex,
      eventHash: input.event.eventHash,
      parameterCount: input.event.parameterCount
    },
    ...input.extra
  };
}

async function executeEmevdInstructionOperation(input: {
  options: InstructionCommitOptions;
  operation: ResourceNodeAddOp | ResourceNodeDeleteOp | ResourceNodeReorderOp;
  title: string;
  notes: string;
}): Promise<SaveTextResourceResult> {
  const patch = createPatchIr({
    workspaceId: input.options.file.workspaceId,
    title: input.title,
    author: 'user',
    operations: [input.operation],
    notes: input.notes
  });
  const committed = await executePatchIrThroughTransaction(patch, {
    ...(input.options.session ? { session: input.options.session } : {}),
    ...(input.options.session?.layers.overlayRoot
      ? { workspaceRoot: input.options.session.layers.overlayRoot }
      : {}),
    ...(input.options.operationLog ? { operationLog: input.options.operationLog } : {}),
    ...(input.options.backupBaseDir ? { backupBaseDir: input.options.backupBaseDir } : {}),
    ...(input.options.recoveryDir ? { recoveryDir: input.options.recoveryDir } : {}),
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
