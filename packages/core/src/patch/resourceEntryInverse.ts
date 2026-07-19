import type {
  PatchIrOperation,
  ResourceFieldEditOp,
  ResourceNodeAddOp,
  ResourceNodeDeleteOp,
  ResourceNodeReorderOp
} from '@soulforge/shared';
import {
  fmgEntryOrderUris,
  hashFmgEntrySlots,
  readFmgBeforeEntriesFromMetadata,
  reorderFmgEntrySlots
} from '../editing/fmgSemanticContract.js';
import {
  emevdEventOrderUris,
  emevdInstructionOrderUris,
  hashEmevdEventOrder,
  hashEmevdInstructionOrder,
  isEmevdEventNodeAddOperation,
  isEmevdEventNodeDeleteOperation,
  isEmevdInstructionNodeAddOperation,
  isEmevdInstructionNodeDeleteOperation,
  isEmevdInstructionNodeReorderOperation,
  readEmevdBeforeEventsFromMetadata,
  readEmevdBeforeInstructionsFromMetadata,
  reorderEmevdEventOrder,
  reorderEmevdInstructionOrder
} from '../editing/emevdSemanticContract.js';
import type { ResourceEntryChangeRecord } from '../storage/durableWorkspaceRepository.js';
import { isValidContainerResourceEntryInverse } from './containerChildInverse.js';
import { hashPatchTypedValue } from './typedValueHash.js';

type InverseEvidenceResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

/** Validate persisted entry-level inverse evidence before creating a new rollback transaction. */
export function isValidResourceEntryInverse(
  change: ResourceEntryChangeRecord,
  fileAfterHash: string | undefined
): InverseEvidenceResult {
  if (change.inverse.kind.startsWith('container_child_')) {
    return isValidContainerResourceEntryInverse(change, fileAfterHash);
  }
  if (change.inverse.kind === 'resource_field_edit') {
    return validateResourceFieldInverse(change, change.inverse, fileAfterHash);
  }
  if (change.inverse.kind === 'resource_node_add') {
    return validateResourceNodeAddInverse(change, change.inverse, fileAfterHash);
  }
  if (change.inverse.kind === 'resource_node_delete') {
    return validateResourceNodeDeleteInverse(change, change.inverse, fileAfterHash);
  }
  if (change.inverse.kind === 'resource_node_reorder') {
    return validateResourceNodeReorderInverse(change, change.inverse, fileAfterHash);
  }
  return invalid('资源条目逆操作类型无效。');
}

function validateResourceFieldInverse(
  change: ResourceEntryChangeRecord,
  inverse: ResourceFieldEditOp,
  fileAfterHash: string | undefined
): InverseEvidenceResult {
  if (change.changeKind !== 'field_update'
    || !change.beforeHash
    || !change.afterHash
    || inverse.fieldUri !== change.entryUri
    || inverse.inverse.kind !== 'resource_field_edit'
    || inverse.inverse.fieldUri !== change.entryUri
    || inverse.metadata?.nativeFormatAuthority !== true
    || inverse.metadata?.inverseResourceEntry !== true) {
    return invalid('resource_field_edit 逆操作的条目身份或原生 authority 证据不完整。');
  }
  if (!fileAfterHash || inverse.expectedHash !== fileAfterHash) {
    return {
      ok: false,
      code: 'RESOURCE_ENTRY_CONTAINER_HASH_INVALID',
      message: '资源字段逆操作没有绑定原提交文件的 afterHash。'
    };
  }
  if (hashPatchTypedValue(inverse.previousValue) !== change.afterHash
    || hashPatchTypedValue(inverse.nextValue) !== change.beforeHash
    || hashPatchTypedValue(inverse.inverse.value) !== change.afterHash) {
    return invalid('resource_field_edit 逆操作的 typed value hash 与持久化变更记录不一致。');
  }
  if (!inverse.documentRevision
    || !inverse.schemaId
    || !inverse.schemaVersion
    || !inverse.layoutFingerprint
    || !inverse.expectedDocumentHash
    || !inverse.writerId
    || !hasBoundContentHash(inverse, fileAfterHash)) {
    return invalid('resource_field_edit 逆操作缺少 revision、schema、writer 或 hash 前置条件。');
  }
  return { ok: true };
}

function validateResourceNodeAddInverse(
  change: ResourceEntryChangeRecord,
  inverse: ResourceNodeAddOp,
  fileAfterHash: string | undefined
): InverseEvidenceResult {
  if (change.changeKind !== 'node_delete'
    || !change.beforeHash
    || inverse.nodeId !== change.entryUri
    || inverse.inverse.kind !== 'resource_node_delete'
    || inverse.inverse.nodeId !== change.entryUri
    || inverse.metadata?.nativeFormatAuthority !== true
    || inverse.metadata?.inverseResourceEntry !== true) {
    return invalid('resource_node_add 逆操作的条目身份或原生 authority 证据不完整。');
  }
  if (!fileAfterHash || inverse.expectedHash !== fileAfterHash) {
    return {
      ok: false,
      code: 'RESOURCE_ENTRY_CONTAINER_HASH_INVALID',
      message: '资源节点逆操作没有绑定原提交文件的 afterHash。'
    };
  }
  const nodeEvidenceValid = inverse.resourceKind === 'msg'
    ? inverse.payload.nodeType === 'fmg_entry'
      && inverse.payload.snapshot.sha256.toLowerCase() === change.beforeHash.toLowerCase()
      && inverse.inverse.expectedNodeHash.toLowerCase() === change.beforeHash.toLowerCase()
    : inverse.resourceKind === 'event'
      && (isEmevdEventNodeAddOperation(inverse)
        || isEmevdInstructionNodeAddOperation(inverse))
      && inverse.payload.snapshot.sha256.toLowerCase() === change.beforeHash.toLowerCase()
      && inverse.inverse.expectedNodeHash.toLowerCase() === change.beforeHash.toLowerCase();
  if (!nodeEvidenceValid) {
    return invalid('resource_node_add 逆操作的 node hash 与持久化变更记录不一致。');
  }
  if (!inverse.documentRevision
    || !inverse.expectedDocumentHash
    || !inverse.writerId
    || !hasBoundContentHash(inverse, fileAfterHash)) {
    return invalid('resource_node_add 逆操作缺少 revision、writer 或 hash 前置条件。');
  }
  return { ok: true };
}

function validateResourceNodeDeleteInverse(
  change: ResourceEntryChangeRecord,
  inverse: ResourceNodeDeleteOp,
  fileAfterHash: string | undefined
): InverseEvidenceResult {
  if (change.changeKind !== 'node_add'
    || !change.afterHash
    || inverse.nodeId !== change.entryUri
    || inverse.inverse.kind !== 'resource_node_add'
    || inverse.inverse.nodeId !== change.entryUri
    || inverse.metadata?.nativeFormatAuthority !== true
    || inverse.metadata?.inverseResourceEntry !== true) {
    return invalid('resource_node_delete 逆操作的条目身份或原生 authority 证据不完整。');
  }
  if (!fileAfterHash || inverse.expectedHash !== fileAfterHash) {
    return {
      ok: false,
      code: 'RESOURCE_ENTRY_CONTAINER_HASH_INVALID',
      message: '资源节点逆操作没有绑定原提交文件的 afterHash。'
    };
  }
  const nodeEvidenceValid = inverse.resourceKind === 'msg'
    ? inverse.expectedNodeHash.toLowerCase() === change.afterHash.toLowerCase()
      && inverse.inverse.payload.nodeType === 'fmg_entry'
      && inverse.inverse.payload.snapshot.sha256.toLowerCase() === change.afterHash.toLowerCase()
    : inverse.resourceKind === 'event'
      && (isEmevdEventNodeDeleteOperation(inverse)
        || isEmevdInstructionNodeDeleteOperation(inverse))
      && inverse.expectedNodeHash.toLowerCase() === change.afterHash.toLowerCase()
      && inverse.inverse.payload.snapshot.sha256.toLowerCase() === change.afterHash.toLowerCase();
  if (!nodeEvidenceValid) {
    return invalid('resource_node_delete 逆操作的 node hash 与持久化变更记录不一致。');
  }
  if (!inverse.documentRevision
    || !inverse.expectedDocumentHash
    || !inverse.writerId
    || !hasBoundContentHash(inverse, fileAfterHash)) {
    return invalid('resource_node_delete 逆操作缺少 revision、writer 或 hash 前置条件。');
  }
  return { ok: true };
}

function validateResourceNodeReorderInverse(
  change: ResourceEntryChangeRecord,
  inverse: ResourceNodeReorderOp,
  fileAfterHash: string | undefined
): InverseEvidenceResult {
  if (change.changeKind !== 'node_reorder'
    || !change.beforeHash
    || !change.afterHash
    || inverse.nodeId !== change.entryUri
    || inverse.inverse.kind !== 'resource_node_reorder'
    || inverse.metadata?.nativeFormatAuthority !== true
    || inverse.metadata?.inverseResourceEntry !== true) {
    return invalid('resource_node_reorder 逆操作的条目身份或原生 authority 证据不完整。');
  }
  if (!fileAfterHash || inverse.expectedHash !== fileAfterHash) {
    return {
      ok: false,
      code: 'RESOURCE_ENTRY_CONTAINER_HASH_INVALID',
      message: '资源节点重排逆操作没有绑定原提交文件的 afterHash。'
    };
  }
  if (inverse.resourceKind === 'event') {
    return isEmevdInstructionNodeReorderOperation(inverse)
      ? validateEmevdInstructionReorderInverseEvidence(change, inverse, fileAfterHash)
      : validateEmevdReorderInverseEvidence(change, inverse, fileAfterHash);
  }
  if (inverse.resourceKind !== 'msg') {
    return invalid('resource_node_reorder 逆操作的资源类型不受支持。');
  }
  const beforeEntries = readFmgBeforeEntriesFromMetadata(inverse.metadata);
  if (!beforeEntries || hashFmgEntrySlots(beforeEntries) !== change.afterHash.toLowerCase()) {
    return invalid('resource_node_reorder 逆操作的提交后完整顺序 hash 与持久化记录不一致。');
  }
  const expectedOrder = fmgEntryOrderUris(inverse.documentUri, beforeEntries);
  if (inverse.expectedOrder.length !== expectedOrder.length
    || inverse.expectedOrder.some((nodeId, index) => nodeId !== expectedOrder[index])
    || inverse.inverse.previousOrder.length !== expectedOrder.length
    || inverse.inverse.previousOrder.some((nodeId, index) => nodeId !== expectedOrder[index])) {
    return invalid('resource_node_reorder 逆操作的完整 expectedOrder 证据不一致。');
  }
  const planned = reorderFmgEntrySlots({
    documentUri: inverse.documentUri,
    beforeEntries,
    nodeId: inverse.nodeId,
    beforeNodeId: inverse.beforeNodeId
  });
  if (!planned.ok || hashFmgEntrySlots(planned.afterEntries) !== change.beforeHash.toLowerCase()) {
    return invalid('resource_node_reorder 逆操作不能精确恢复持久化的原完整顺序。');
  }
  if (!inverse.documentRevision
    || !inverse.expectedDocumentHash
    || !inverse.writerId
    || !hasBoundContentHash(inverse, fileAfterHash)) {
    return invalid('resource_node_reorder 逆操作缺少 revision、writer 或 hash 前置条件。');
  }
  return { ok: true };
}

function validateEmevdInstructionReorderInverseEvidence(
  change: ResourceEntryChangeRecord,
  inverse: ResourceNodeReorderOp,
  fileAfterHash: string
): InverseEvidenceResult {
  if (!isEmevdInstructionNodeReorderOperation(inverse)) {
    return invalid('EMEVD instruction reorder 逆操作的类型证据无效。');
  }
  const beforeInstructions = readEmevdBeforeInstructionsFromMetadata(inverse.metadata);
  if (!beforeInstructions
    || hashEmevdInstructionOrder(beforeInstructions) !== change.afterHash?.toLowerCase()) {
    return invalid('EMEVD instruction reorder 逆操作的提交后完整顺序 hash 与持久化记录不一致。');
  }
  const parent = inverse.metadata?.beforeInstructionEvent as {
    eventId?: unknown;
    eventIndex?: unknown;
  } | undefined;
  if (!parent
    || !Number.isSafeInteger(parent.eventId)
    || !Number.isSafeInteger(parent.eventIndex)) {
    return invalid('EMEVD instruction reorder 逆操作缺少父事件身份。');
  }
  const expectedOrder = emevdInstructionOrderUris({
    documentUri: inverse.documentUri,
    eventId: parent.eventId as number,
    eventIndex: parent.eventIndex as number,
    instructions: beforeInstructions
  });
  if (inverse.expectedOrder.length !== expectedOrder.length
    || inverse.expectedOrder.some((nodeId, index) => nodeId !== expectedOrder[index])
    || inverse.inverse.previousOrder.length !== expectedOrder.length
    || inverse.inverse.previousOrder.some((nodeId, index) => nodeId !== expectedOrder[index])) {
    return invalid('EMEVD instruction reorder 逆操作的完整 expectedOrder 证据不一致。');
  }
  const planned = reorderEmevdInstructionOrder({
    documentUri: inverse.documentUri,
    eventId: parent.eventId as number,
    eventIndex: parent.eventIndex as number,
    beforeInstructions,
    nodeId: inverse.nodeId,
    beforeNodeId: inverse.beforeNodeId
  });
  if (!planned.ok
    || hashEmevdInstructionOrder(planned.afterInstructions) !== change.beforeHash?.toLowerCase()) {
    return invalid('EMEVD instruction reorder 逆操作不能精确恢复持久化的原完整顺序。');
  }
  if (!inverse.documentRevision
    || !inverse.expectedDocumentHash
    || !inverse.writerId
    || !hasBoundContentHash(inverse, fileAfterHash)) {
    return invalid('EMEVD instruction reorder 逆操作缺少 revision、writer 或 hash 前置条件。');
  }
  return { ok: true };
}

function validateEmevdReorderInverseEvidence(
  change: ResourceEntryChangeRecord,
  inverse: ResourceNodeReorderOp,
  fileAfterHash: string
): InverseEvidenceResult {
  const beforeEvents = readEmevdBeforeEventsFromMetadata(inverse.metadata);
  if (!beforeEvents || hashEmevdEventOrder(beforeEvents) !== change.afterHash?.toLowerCase()) {
    return invalid('EMEVD resource_node_reorder 逆操作的提交后完整顺序 hash 与持久化记录不一致。');
  }
  const expectedOrder = emevdEventOrderUris(inverse.documentUri, beforeEvents);
  if (inverse.expectedOrder.length !== expectedOrder.length
    || inverse.expectedOrder.some((nodeId, index) => nodeId !== expectedOrder[index])
    || inverse.inverse.previousOrder.length !== expectedOrder.length
    || inverse.inverse.previousOrder.some((nodeId, index) => nodeId !== expectedOrder[index])) {
    return invalid('EMEVD resource_node_reorder 逆操作的完整 expectedOrder 证据不一致。');
  }
  const planned = reorderEmevdEventOrder({
    beforeEvents,
    nodeId: inverse.nodeId,
    beforeNodeId: inverse.beforeNodeId
  });
  if (!planned.ok || hashEmevdEventOrder(planned.afterEvents) !== change.beforeHash?.toLowerCase()) {
    return invalid('EMEVD resource_node_reorder 逆操作不能精确恢复持久化的原完整顺序。');
  }
  if (!inverse.documentRevision
    || !inverse.expectedDocumentHash
    || !inverse.writerId
    || !hasBoundContentHash(inverse, fileAfterHash)) {
    return invalid('EMEVD resource_node_reorder 逆操作缺少 revision、writer 或 hash 前置条件。');
  }
  return { ok: true };
}

function hasBoundContentHash(operation: PatchIrOperation, expectedHash: string): boolean {
  return operation.preconditions.some((precondition) => (
    precondition.type === 'content_hash'
      && precondition.targetUri === operation.targetUri
      && precondition.expectedHash === expectedHash
  ));
}

function invalid(message: string): InverseEvidenceResult {
  return { ok: false, code: 'RESOURCE_ENTRY_INVERSE_EVIDENCE_INVALID', message };
}
