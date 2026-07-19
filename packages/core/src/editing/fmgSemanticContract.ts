import { createHash } from 'node:crypto';
import type {
  FmgEntryNodePayload,
  PatchIrOperation,
  ResourceFieldEditOp,
  ResourceNodeAddOp,
  ResourceNodeDeleteOp,
  ResourceNodeReorderOp
} from '@soulforge/shared';

type StringPatchValue = { valueType: 'string'; value: string };

export type FmgEntryTextFieldOperation = ResourceFieldEditOp & {
  previousValue: StringPatchValue;
  nextValue: StringPatchValue;
};

export type FmgEntryNodeDeleteOperation = ResourceNodeDeleteOp & {
  resourceKind: 'msg';
  inverse: {
    kind: 'resource_node_add';
    nodeId: string;
    payload: FmgEntryNodePayload;
  };
};

export type FmgEntryNodeAddOperation = ResourceNodeAddOp & {
  resourceKind: 'msg';
  payload: FmgEntryNodePayload;
  inverse: {
    kind: 'resource_node_delete';
    nodeId: string;
    expectedNodeHash: string;
  };
};

export type FmgEntryNodeReorderOperation = ResourceNodeReorderOp & {
  resourceKind: 'msg';
  inverse: {
    kind: 'resource_node_reorder';
    parentNodeId?: string;
    previousOrder: string[];
  };
};

export type FmgSemanticOperation =
  | FmgEntryTextFieldOperation
  | FmgEntryNodeDeleteOperation
  | FmgEntryNodeAddOperation
  | FmgEntryNodeReorderOperation;

export const FMG_SEMANTIC_WRITER_ID = 'writer:fmg-semantic-v1';
export const FMG_SEMANTIC_VALIDATOR_ID = 'fmg_semantic';
export const FMG_ENTRY_NODE_FORMAT_ID = 'soulforge.fmg.entry-text.v1';

export interface FmgEntryTextFieldIdentity {
  entryId: number;
  stringIndex: number;
}

export interface FmgEntryNodeIdentity {
  entryId: number;
  stringIndex: number;
}

export function fmgEntryTextFieldUri(input: {
  documentUri: string;
  entryId: number;
  stringIndex: number;
}): string {
  return `${input.documentUri}#entry/${input.entryId}/slot/${input.stringIndex}/field/text`;
}

export function fmgEntryNodeUri(input: {
  documentUri: string;
  entryId: number;
  stringIndex: number;
}): string {
  return `${input.documentUri}#entry/${input.entryId}/slot/${input.stringIndex}`;
}

export function parseFmgEntryTextFieldUri(
  fieldUri: string
): FmgEntryTextFieldIdentity | undefined {
  const match = /#entry\/(-?\d+)\/slot\/(\d+)\/field\/text$/.exec(fieldUri);
  if (!match) return undefined;
  const entryId = Number(match[1]);
  const stringIndex = Number(match[2]);
  if (!isInt32(entryId) || !Number.isSafeInteger(stringIndex) || stringIndex < 0) {
    return undefined;
  }
  return { entryId, stringIndex };
}

export function parseFmgEntryNodeUri(
  nodeUri: string
): FmgEntryNodeIdentity | undefined {
  const match = /#entry\/(-?\d+)\/slot\/(\d+)$/.exec(nodeUri);
  if (!match) return undefined;
  const entryId = Number(match[1]);
  const stringIndex = Number(match[2]);
  if (!isInt32(entryId) || !Number.isSafeInteger(stringIndex) || stringIndex < 0) {
    return undefined;
  }
  return { entryId, stringIndex };
}

export function parseFmgEntryNodeId(nodeId: string): FmgEntryNodeIdentity | undefined {
  const absolute = parseFmgEntryNodeUri(nodeId);
  if (absolute) return absolute;
  const match = /^entry\/(-?\d+)\/slot\/(\d+)$/.exec(nodeId);
  if (!match) return undefined;
  const entryId = Number(match[1]);
  const stringIndex = Number(match[2]);
  if (!isInt32(entryId) || !Number.isSafeInteger(stringIndex) || stringIndex < 0) {
    return undefined;
  }
  return { entryId, stringIndex };
}

export function isFmgEntryTextFieldOperation(
  operation: PatchIrOperation
): operation is FmgEntryTextFieldOperation {
  if (operation.kind !== 'resource_field_edit'
    || operation.resourceKind !== 'msg'
    || operation.writerId !== FMG_SEMANTIC_WRITER_ID
    || operation.documentUri !== operation.targetUri
    || !operation.targetPath
    || operation.metadata?.nativeFormatAuthority !== true
    || operation.previousValue.valueType !== 'string'
    || operation.nextValue.valueType !== 'string') {
    return false;
  }
  const identity = parseFmgEntryTextFieldUri(operation.fieldUri);
  return Boolean(identity && operation.fieldUri.startsWith(`${operation.documentUri}#`));
}

export function isFmgEntryNodeDeleteOperation(
  operation: PatchIrOperation
): operation is FmgEntryNodeDeleteOperation {
  if (operation.kind !== 'resource_node_delete'
    || operation.resourceKind !== 'msg'
    || operation.writerId !== FMG_SEMANTIC_WRITER_ID
    || operation.documentUri !== operation.targetUri
    || !operation.targetPath
    || operation.metadata?.nativeFormatAuthority !== true
    || operation.inverse.kind !== 'resource_node_add'
    || operation.inverse.payload.nodeType !== 'fmg_entry') {
    return false;
  }
  const identity = parseFmgEntryNodeId(operation.nodeId);
  const payload = operation.inverse.payload;
  return Boolean(
    identity
    && identity.entryId === payload.entryId
    && identity.stringIndex === payload.stringIndex
    && typeof payload.text === 'string'
    && payload.snapshot.sha256.toLowerCase() === operation.expectedNodeHash.toLowerCase()
  );
}

export function isFmgEntryNodeAddOperation(
  operation: PatchIrOperation
): operation is FmgEntryNodeAddOperation {
  if (operation.kind !== 'resource_node_add'
    || operation.resourceKind !== 'msg'
    || operation.writerId !== FMG_SEMANTIC_WRITER_ID
    || operation.documentUri !== operation.targetUri
    || !operation.targetPath
    || operation.metadata?.nativeFormatAuthority !== true
    || operation.payload.nodeType !== 'fmg_entry'
    || operation.inverse.kind !== 'resource_node_delete') {
    return false;
  }
  const identity = parseFmgEntryNodeId(operation.nodeId);
  return Boolean(
    identity
    && identity.entryId === operation.payload.entryId
    && identity.stringIndex === operation.payload.stringIndex
    && typeof operation.payload.text === 'string'
    && operation.payload.snapshot.sha256.toLowerCase() === operation.inverse.expectedNodeHash.toLowerCase()
  );
}

export function isFmgEntryNodeReorderOperation(
  operation: PatchIrOperation
): operation is FmgEntryNodeReorderOperation {
  if (operation.kind !== 'resource_node_reorder'
    || operation.resourceKind !== 'msg'
    || operation.writerId !== FMG_SEMANTIC_WRITER_ID
    || operation.documentUri !== operation.targetUri
    || !operation.targetPath
    || operation.metadata?.nativeFormatAuthority !== true
    || operation.inverse.kind !== 'resource_node_reorder') {
    return false;
  }
  const beforeEntries = readFmgBeforeEntriesFromMetadata(operation.metadata);
  if (!beforeEntries || beforeEntries.length < 2) return false;
  const expectedOrder = fmgEntryOrderUris(operation.documentUri, beforeEntries);
  if (operation.expectedOrder.length !== expectedOrder.length
    || operation.expectedOrder.some((nodeId, index) => nodeId !== expectedOrder[index])
    || !expectedOrder.includes(operation.nodeId)
    || (operation.beforeNodeId !== undefined && !expectedOrder.includes(operation.beforeNodeId))
    || operation.inverse.previousOrder.length !== expectedOrder.length
    || operation.inverse.previousOrder.some((nodeId, index) => nodeId !== expectedOrder[index])) {
    return false;
  }
  return reorderFmgEntrySlots({
    documentUri: operation.documentUri,
    beforeEntries,
    nodeId: operation.nodeId,
    beforeNodeId: operation.beforeNodeId
  }).ok;
}

export function isFmgSemanticOperation(
  operation: PatchIrOperation
): operation is FmgSemanticOperation {
  return isFmgEntryTextFieldOperation(operation)
    || isFmgEntryNodeDeleteOperation(operation)
    || isFmgEntryNodeAddOperation(operation)
    || isFmgEntryNodeReorderOperation(operation);
}

export function buildFmgEntryNodePayload(input: {
  entryId: number;
  stringIndex: number;
  text: string;
  schemaVersion: string;
}): FmgEntryNodePayload {
  const textBytes = Buffer.from(input.text, 'utf16le');
  const sha256 = createHash('sha256').update(textBytes).digest('hex');
  return {
    payloadVersion: 1,
    resourceKind: 'msg',
    nodeType: 'fmg_entry',
    entryId: input.entryId,
    stringIndex: input.stringIndex,
    text: input.text,
    snapshot: {
      storage: 'inline',
      formatId: FMG_ENTRY_NODE_FORMAT_ID,
      schemaVersion: input.schemaVersion,
      dataBase64: textBytes.toString('base64'),
      sha256,
      size: textBytes.length
    }
  };
}

/** Compact ordered FMG string-table baseline used to prove a slot delete/shift. */
export type FmgEntrySlotSnapshot = { id: number; text: string };

export function snapshotFmgEntrySlots(
  entries: ReadonlyArray<{ id: number; text: string }>
): FmgEntrySlotSnapshot[] {
  return entries.map((entry) => ({ id: entry.id, text: entry.text }));
}

export function fmgEntryOrderUris(
  documentUri: string,
  entries: ReadonlyArray<FmgEntrySlotSnapshot>
): string[] {
  return entries.map((entry, stringIndex) => fmgEntryNodeUri({
    documentUri,
    entryId: entry.id,
    stringIndex
  }));
}

export function hashFmgEntrySlots(entries: ReadonlyArray<FmgEntrySlotSnapshot>): string {
  return createHash('sha256')
    .update(JSON.stringify(entries.map((entry) => [entry.id, entry.text])))
    .digest('hex');
}

export type FmgSlotReorderResult =
  | {
      ok: true;
      afterEntries: FmgEntrySlotSnapshot[];
      afterOriginalIndexes: number[];
      movedStringIndex: number;
    }
  | { ok: false; code: string; message: string };

/** Apply a revision-bound move-before/append operation to a complete FMG slot order. */
export function reorderFmgEntrySlots(input: {
  documentUri: string;
  beforeEntries: ReadonlyArray<FmgEntrySlotSnapshot>;
  nodeId: string;
  beforeNodeId: string | undefined;
}): FmgSlotReorderResult {
  const target = parseFmgEntryNodeId(input.nodeId);
  if (!target
    || target.stringIndex >= input.beforeEntries.length
    || input.beforeEntries[target.stringIndex]?.id !== target.entryId) {
    return {
      ok: false,
      code: 'FMG_SEMANTIC_REORDER_SOURCE_IDENTITY_MISMATCH',
      message: 'FMG reorder 源节点与完整槽位基线不一致。'
    };
  }
  const anchor = input.beforeNodeId === undefined
    ? undefined
    : parseFmgEntryNodeId(input.beforeNodeId);
  if (input.beforeNodeId !== undefined
    && (!anchor
      || anchor.stringIndex >= input.beforeEntries.length
      || input.beforeEntries[anchor.stringIndex]?.id !== anchor.entryId
      || anchor.stringIndex === target.stringIndex)) {
    return {
      ok: false,
      code: 'FMG_SEMANTIC_REORDER_ANCHOR_IDENTITY_MISMATCH',
      message: 'FMG reorder 锚点节点与完整槽位基线不一致。'
    };
  }

  const indexed = input.beforeEntries.map((entry, originalIndex) => ({
    entry: { id: entry.id, text: entry.text },
    originalIndex
  }));
  const [moved] = indexed.splice(target.stringIndex, 1);
  if (!moved) {
    return {
      ok: false,
      code: 'FMG_SEMANTIC_REORDER_SOURCE_IDENTITY_MISMATCH',
      message: 'FMG reorder 无法读取源槽位。'
    };
  }
  const insertionIndex = anchor
    ? anchor.stringIndex - (target.stringIndex < anchor.stringIndex ? 1 : 0)
    : indexed.length;
  if (insertionIndex === target.stringIndex) {
    return {
      ok: false,
      code: 'FMG_SEMANTIC_REORDER_NOOP_BLOCKED',
      message: 'FMG reorder 不允许不改变完整槽位顺序的空操作。'
    };
  }
  indexed.splice(insertionIndex, 0, moved);
  return {
    ok: true,
    afterEntries: indexed.map((item) => item.entry),
    afterOriginalIndexes: indexed.map((item) => item.originalIndex),
    movedStringIndex: insertionIndex
  };
}

export function assertFmgSlotOrderEquals(input: {
  expectedEntries: ReadonlyArray<FmgEntrySlotSnapshot>;
  actualEntries: ReadonlyArray<{ id: number; text: string }>;
}): { ok: true } | { ok: false; code: string; message: string } {
  if (input.actualEntries.length !== input.expectedEntries.length) {
    return {
      ok: false,
      code: 'FMG_SEMANTIC_REORDER_COUNT_MISMATCH',
      message: 'FMG reorder 后 entryCount 与完整预期顺序不一致。'
    };
  }
  for (let i = 0; i < input.expectedEntries.length; i += 1) {
    const expected = input.expectedEntries[i]!;
    const actual = input.actualEntries[i]!;
    if (actual.id !== expected.id || actual.text !== expected.text) {
      return {
        ok: false,
        code: 'FMG_SEMANTIC_REORDER_ORDER_MISMATCH',
        message: `FMG reorder 后槽位 ${i} 与完整预期顺序不一致。`
      };
    }
  }
  return { ok: true };
}

export function readFmgBeforeEntriesFromMetadata(
  metadata: Record<string, unknown> | undefined
): FmgEntrySlotSnapshot[] | undefined {
  const raw = metadata?.beforeEntries;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const slots: FmgEntrySlotSnapshot[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return undefined;
    const record = item as Record<string, unknown>;
    if (!isInt32(Number(record.id)) || typeof record.text !== 'string') return undefined;
    slots.push({ id: Number(record.id), text: record.text });
  }
  return slots;
}

/**
 * Strong delete contract (mirrors Bridge FmgNativeWriter):
 * entryCount decreases by 1, preceding slots equal, later slots equal before[i+1].
 * Avoids false FMG_SEMANTIC_DELETE_NOT_APPLIED when a same-id/same-text neighbor shifts in.
 */
export function assertFmgSlotDeleteApplied(input: {
  beforeEntries: ReadonlyArray<FmgEntrySlotSnapshot>;
  afterEntries: ReadonlyArray<{ id: number; text: string }>;
  stringIndex: number;
  entryId: number;
  text: string;
}): { ok: true } | { ok: false; code: string; message: string } {
  const { beforeEntries, afterEntries, stringIndex, entryId, text } = input;
  if (!Number.isSafeInteger(stringIndex) || stringIndex < 0 || stringIndex >= beforeEntries.length) {
    return {
      ok: false,
      code: 'FMG_SEMANTIC_DELETE_INDEX_INVALID',
      message: 'FMG slot delete 校验的 stringIndex 超出 beforeEntries 范围。'
    };
  }
  const target = beforeEntries[stringIndex]!;
  if (target.id !== entryId || target.text !== text) {
    return {
      ok: false,
      code: 'FMG_SEMANTIC_ENTRY_IDENTITY_MISMATCH',
      message: 'FMG slot delete 的 beforeEntries 目标与 entryId/text 不一致。'
    };
  }
  if (afterEntries.length !== beforeEntries.length - 1) {
    return {
      ok: false,
      code: 'FMG_SEMANTIC_DELETE_NOT_APPLIED',
      message: `FMG slot delete 后 entryCount 应为 ${beforeEntries.length - 1}，实际为 ${afterEntries.length}。`
    };
  }
  for (let i = 0; i < stringIndex; i += 1) {
    const expected = beforeEntries[i]!;
    const actual = afterEntries[i]!;
    if (actual.id !== expected.id || actual.text !== expected.text) {
      return {
        ok: false,
        code: 'FMG_SEMANTIC_DELETE_SLOT_SHIFT_MISMATCH',
        message: `FMG slot delete 破坏了前置槽位 ${i}。`
      };
    }
  }
  for (let i = stringIndex; i < afterEntries.length; i += 1) {
    const expected = beforeEntries[i + 1]!;
    const actual = afterEntries[i]!;
    if (actual.id !== expected.id || actual.text !== expected.text) {
      return {
        ok: false,
        code: 'FMG_SEMANTIC_DELETE_SLOT_SHIFT_MISMATCH',
        message: `FMG slot delete 后槽位 ${i} 与 beforeEntries[${i + 1}] 不一致。`
      };
    }
  }
  return { ok: true };
}

export function isInt32(value: number): boolean {
  return Number.isSafeInteger(value) && value >= -0x8000_0000 && value <= 0x7fff_ffff;
}
