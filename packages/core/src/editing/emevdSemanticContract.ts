import { createHash } from 'node:crypto';
import type {
  EmevdEventNodePayload,
  EmevdInstructionNodePayload,
  PatchIrOperation,
  ResourceFieldEditOp,
  ResourceNodeAddOp,
  ResourceNodeDeleteOp,
  ResourceNodeReorderOp
} from '@soulforge/shared';

type IntegerPatchValue = { valueType: 'integer'; value: number };
type BytesPatchValue = { valueType: 'bytes'; base64: string };

export type EmevdRestBehaviorFieldOperation = ResourceFieldEditOp & {
  previousValue: IntegerPatchValue;
  nextValue: IntegerPatchValue;
};

export type EmevdInstructionArgsFieldOperation = ResourceFieldEditOp & {
  previousValue: BytesPatchValue;
  nextValue: BytesPatchValue;
};

export type EmevdSemanticFieldOperation =
  | EmevdRestBehaviorFieldOperation
  | EmevdInstructionArgsFieldOperation;

export type EmevdEventNodeReorderOperation = ResourceNodeReorderOp & {
  metadata: Record<string, unknown> & { reorderScope: 'event' };
};
export type EmevdEventNodeAddOperation = ResourceNodeAddOp & {
  payload: EmevdEventNodePayload;
};
export type EmevdEventNodeDeleteOperation = ResourceNodeDeleteOp & {
  inverse: {
    kind: 'resource_node_add';
    nodeId: string;
    payload: EmevdEventNodePayload;
  };
};
export type EmevdInstructionNodeAddOperation = ResourceNodeAddOp & {
  payload: EmevdInstructionNodePayload;
};
export type EmevdInstructionNodeDeleteOperation = ResourceNodeDeleteOp & {
  inverse: {
    kind: 'resource_node_add';
    nodeId: string;
    payload: EmevdInstructionNodePayload;
  };
};
export type EmevdInstructionNodeReorderOperation = ResourceNodeReorderOp & {
  parentNodeId: string;
  inverse: ResourceNodeReorderOp['inverse'] & { parentNodeId: string };
  metadata: Record<string, unknown> & { reorderScope: 'instruction' };
};
export type EmevdSemanticOperation =
  | EmevdSemanticFieldOperation
  | EmevdEventNodeAddOperation
  | EmevdEventNodeDeleteOperation
  | EmevdEventNodeReorderOperation
  | EmevdInstructionNodeAddOperation
  | EmevdInstructionNodeDeleteOperation
  | EmevdInstructionNodeReorderOperation;

export const EMEVD_SEMANTIC_WRITER_ID = 'writer:emevd-semantic-v1';
export const EMEVD_SEMANTIC_VALIDATOR_ID = 'emevd_semantic';

export interface EmevdRestBehaviorFieldIdentity {
  eventId: number;
  eventIndex: number;
}

export interface EmevdInstructionArgsFieldIdentity {
  eventId: number;
  eventIndex: number;
  instructionIndex: number;
  bank: number;
  instructionId: number;
}

export function emevdRestBehaviorFieldUri(input: {
  documentUri: string;
  eventId: number;
  eventIndex: number;
}): string {
  return `${input.documentUri}#event/${input.eventId}/index/${input.eventIndex}/field/restBehavior`;
}

export function emevdInstructionArgsFieldUri(input: {
  documentUri: string;
  eventId: number;
  eventIndex: number;
  instructionIndex: number;
  bank: number;
  instructionId: number;
}): string {
  return `${input.documentUri}#event/${input.eventId}/index/${input.eventIndex}/instruction/${input.instructionIndex}/bank/${input.bank}/id/${input.instructionId}/field/args`;
}

export function parseEmevdRestBehaviorFieldUri(
  fieldUri: string
): EmevdRestBehaviorFieldIdentity | undefined {
  const match = /#event\/(-?\d+)\/index\/(\d+)\/field\/restBehavior$/.exec(fieldUri);
  if (!match) return undefined;
  const eventId = Number(match[1]);
  const eventIndex = Number(match[2]);
  if (!Number.isSafeInteger(eventId) || !Number.isSafeInteger(eventIndex) || eventIndex < 0) {
    return undefined;
  }
  return { eventId, eventIndex };
}

export function parseEmevdInstructionArgsFieldUri(
  fieldUri: string
): EmevdInstructionArgsFieldIdentity | undefined {
  const match = /#event\/(-?\d+)\/index\/(\d+)\/instruction\/(\d+)\/bank\/(-?\d+)\/id\/(-?\d+)\/field\/args$/.exec(fieldUri);
  if (!match) return undefined;
  const eventId = Number(match[1]);
  const eventIndex = Number(match[2]);
  const instructionIndex = Number(match[3]);
  const bank = Number(match[4]);
  const instructionId = Number(match[5]);
  if (!Number.isSafeInteger(eventId)
    || !Number.isSafeInteger(eventIndex)
    || eventIndex < 0
    || !Number.isSafeInteger(instructionIndex)
    || instructionIndex < 0
    || !Number.isSafeInteger(bank)
    || !Number.isSafeInteger(instructionId)) {
    return undefined;
  }
  return { eventId, eventIndex, instructionIndex, bank, instructionId };
}

export function isEmevdRestBehaviorFieldOperation(
  operation: PatchIrOperation
): operation is EmevdRestBehaviorFieldOperation {
  if (operation.kind !== 'resource_field_edit'
    || operation.resourceKind !== 'event'
    || operation.writerId !== EMEVD_SEMANTIC_WRITER_ID
    || operation.documentUri !== operation.targetUri
    || !operation.targetPath
    || operation.metadata?.nativeFormatAuthority !== true
    || operation.previousValue.valueType !== 'integer'
    || operation.nextValue.valueType !== 'integer'
    || !isRestBehaviorValue(operation.previousValue.value)
    || !isRestBehaviorValue(operation.nextValue.value)) {
    return false;
  }
  const identity = parseEmevdRestBehaviorFieldUri(operation.fieldUri);
  return Boolean(identity && operation.fieldUri.startsWith(`${operation.documentUri}#`));
}

export function isEmevdInstructionArgsFieldOperation(
  operation: PatchIrOperation
): operation is EmevdInstructionArgsFieldOperation {
  if (operation.kind !== 'resource_field_edit'
    || operation.resourceKind !== 'event'
    || operation.writerId !== EMEVD_SEMANTIC_WRITER_ID
    || operation.documentUri !== operation.targetUri
    || !operation.targetPath
    || operation.metadata?.nativeFormatAuthority !== true
    || operation.previousValue.valueType !== 'bytes'
    || operation.nextValue.valueType !== 'bytes'
    || typeof operation.previousValue.base64 !== 'string'
    || typeof operation.nextValue.base64 !== 'string') {
    return false;
  }
  const identity = parseEmevdInstructionArgsFieldUri(operation.fieldUri);
  return Boolean(identity && operation.fieldUri.startsWith(`${operation.documentUri}#`));
}

export function isEmevdSemanticFieldOperation(
  operation: PatchIrOperation
): operation is EmevdSemanticFieldOperation {
  return isEmevdRestBehaviorFieldOperation(operation)
    || isEmevdInstructionArgsFieldOperation(operation);
}

export interface EmevdEventNodeIdentity {
  eventId: number;
  eventIndex: number;
}

export type EmevdEventOrderSnapshot = { id: number; eventHash: string };
export const EMEVD_EVENT_SNAPSHOT_FORMAT_ID = 'soulforge.emevd.event-semantic-v1';
export const EMEVD_EVENT_SNAPSHOT_SCHEMA_VERSION = '1.0.0';
export const EMEVD_EVENT_SNAPSHOT_MAX_BYTES = 256 * 1024;

/** Canonical Bridge eventHash bytes for an empty event (id/rest + zero instruction/parameter counts). */
export function buildEmevdEmptyEventNodePayload(input: {
  eventId: number;
  eventIndex: number;
  restartType: number;
}): EmevdEventNodePayload {
  const bytes = Buffer.alloc(20);
  bytes.writeBigInt64LE(BigInt(input.eventId), 0);
  bytes.writeUInt32LE(input.restartType, 8);
  bytes.writeInt32LE(0, 12);
  bytes.writeInt32LE(0, 16);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    payloadVersion: 1,
    resourceKind: 'event',
    nodeType: 'emevd_event',
    eventId: input.eventId,
    eventIndex: input.eventIndex,
    restartType: input.restartType,
    eventHash: sha256,
    snapshot: {
      storage: 'inline',
      dataBase64: bytes.toString('base64'),
      sha256,
      size: bytes.length,
      formatId: EMEVD_EVENT_SNAPSHOT_FORMAT_ID,
      schemaVersion: EMEVD_EVENT_SNAPSHOT_SCHEMA_VERSION
    }
  };
}

export function buildEmevdEventNodePayloadFromSnapshot(input: {
  eventId: number;
  eventIndex: number;
  restartType: number;
  eventHash: string;
  snapshotBase64: string;
  snapshotSha256: string;
  snapshotSize: number;
  snapshotFormatId: string;
  snapshotSchemaVersion: string;
}): EmevdEventNodePayload | undefined {
  const payload: EmevdEventNodePayload = {
    payloadVersion: 1,
    resourceKind: 'event',
    nodeType: 'emevd_event',
    eventId: input.eventId,
    eventIndex: input.eventIndex,
    restartType: input.restartType,
    eventHash: input.eventHash,
    snapshot: {
      storage: 'inline',
      dataBase64: input.snapshotBase64,
      sha256: input.snapshotSha256,
      size: input.snapshotSize,
      formatId: input.snapshotFormatId,
      schemaVersion: input.snapshotSchemaVersion
    }
  };
  return isValidEmevdEventNodePayload(payload) ? payload : undefined;
}

export function isValidEmevdEventNodePayload(
  payload: EmevdEventNodePayload
): boolean {
  if (!Number.isSafeInteger(payload.eventId)
    || !Number.isSafeInteger(payload.eventIndex)
    || payload.eventIndex < 0
    || !isRestBehaviorValue(payload.restartType)
    || !/^[a-f0-9]{64}$/.test(payload.eventHash)
    || payload.snapshot.storage !== 'inline'
    || payload.snapshot.formatId !== EMEVD_EVENT_SNAPSHOT_FORMAT_ID
    || payload.snapshot.schemaVersion !== EMEVD_EVENT_SNAPSHOT_SCHEMA_VERSION
    || !/^[a-f0-9]{64}$/.test(payload.snapshot.sha256)
    || payload.snapshot.sha256 !== payload.eventHash
    || !Number.isSafeInteger(payload.snapshot.size)
    || payload.snapshot.size < 20
    || payload.snapshot.size > EMEVD_EVENT_SNAPSHOT_MAX_BYTES
    || /\s/.test(payload.snapshot.dataBase64)) {
    return false;
  }
  try {
    const bytes = Buffer.from(payload.snapshot.dataBase64, 'base64');
    return bytes.toString('base64') === payload.snapshot.dataBase64
      && bytes.length === payload.snapshot.size
      && createHash('sha256').update(bytes).digest('hex') === payload.snapshot.sha256;
  } catch {
    return false;
  }
}

export function emevdEventNodeUri(input: {
  documentUri: string;
  eventId: number;
  eventIndex: number;
}): string {
  return `${input.documentUri}#event/${input.eventId}/index/${input.eventIndex}`;
}

export function parseEmevdEventNodeUri(nodeUri: string): EmevdEventNodeIdentity | undefined {
  const match = /#event\/(-?\d+)\/index\/(\d+)$/.exec(nodeUri);
  if (!match) return undefined;
  const eventId = Number(match[1]);
  const eventIndex = Number(match[2]);
  if (!Number.isSafeInteger(eventId) || !Number.isSafeInteger(eventIndex) || eventIndex < 0) {
    return undefined;
  }
  return { eventId, eventIndex };
}

export function snapshotEmevdEventOrder(
  events: ReadonlyArray<{ id: number; eventHash: string }>
): EmevdEventOrderSnapshot[] {
  return events.map((event) => ({ id: event.id, eventHash: event.eventHash }));
}

export function emevdEventOrderUris(
  documentUri: string,
  events: ReadonlyArray<EmevdEventOrderSnapshot>
): string[] {
  return events.map((event, eventIndex) => emevdEventNodeUri({
    documentUri,
    eventId: event.id,
    eventIndex
  }));
}

export function hashEmevdEventOrder(
  events: ReadonlyArray<EmevdEventOrderSnapshot>
): string {
  return createHash('sha256')
    .update(JSON.stringify(events.map((event) => [event.id, event.eventHash])))
    .digest('hex');
}

export type EmevdEventReorderResult =
  | {
      ok: true;
      afterEvents: EmevdEventOrderSnapshot[];
      afterOriginalIndexes: number[];
      movedEventIndex: number;
    }
  | { ok: false; code: string; message: string };

export function reorderEmevdEventOrder(input: {
  beforeEvents: ReadonlyArray<EmevdEventOrderSnapshot>;
  nodeId: string;
  beforeNodeId: string | undefined;
}): EmevdEventReorderResult {
  const target = parseEmevdEventNodeUri(input.nodeId);
  if (!target
    || target.eventIndex >= input.beforeEvents.length
    || input.beforeEvents[target.eventIndex]?.id !== target.eventId) {
    return {
      ok: false,
      code: 'EMEVD_SEMANTIC_REORDER_SOURCE_IDENTITY_MISMATCH',
      message: 'EMEVD reorder 源事件与完整顺序基线不一致。'
    };
  }
  const anchor = input.beforeNodeId === undefined
    ? undefined
    : parseEmevdEventNodeUri(input.beforeNodeId);
  if (input.beforeNodeId !== undefined
    && (!anchor
      || anchor.eventIndex >= input.beforeEvents.length
      || input.beforeEvents[anchor.eventIndex]?.id !== anchor.eventId
      || anchor.eventIndex === target.eventIndex)) {
    return {
      ok: false,
      code: 'EMEVD_SEMANTIC_REORDER_ANCHOR_IDENTITY_MISMATCH',
      message: 'EMEVD reorder 锚点事件与完整顺序基线不一致。'
    };
  }

  const indexed = input.beforeEvents.map((event, originalIndex) => ({
    event: { id: event.id, eventHash: event.eventHash },
    originalIndex
  }));
  const [moved] = indexed.splice(target.eventIndex, 1);
  if (!moved) {
    return {
      ok: false,
      code: 'EMEVD_SEMANTIC_REORDER_SOURCE_IDENTITY_MISMATCH',
      message: 'EMEVD reorder 无法读取源事件。'
    };
  }
  const insertionIndex = anchor
    ? anchor.eventIndex - (target.eventIndex < anchor.eventIndex ? 1 : 0)
    : indexed.length;
  if (insertionIndex === target.eventIndex) {
    return {
      ok: false,
      code: 'EMEVD_SEMANTIC_REORDER_NOOP_BLOCKED',
      message: 'EMEVD reorder 不允许不改变完整事件顺序的空操作。'
    };
  }
  indexed.splice(insertionIndex, 0, moved);
  return {
    ok: true,
    afterEvents: indexed.map((item) => item.event),
    afterOriginalIndexes: indexed.map((item) => item.originalIndex),
    movedEventIndex: insertionIndex
  };
}

export function assertEmevdEventOrderEquals(input: {
  expectedEvents: ReadonlyArray<EmevdEventOrderSnapshot>;
  actualEvents: ReadonlyArray<{ id: number; eventHash: string }>;
}): { ok: true } | { ok: false; code: string; message: string } {
  if (input.actualEvents.length !== input.expectedEvents.length) {
    return {
      ok: false,
      code: 'EMEVD_SEMANTIC_REORDER_COUNT_MISMATCH',
      message: 'EMEVD reorder 后 eventCount 与完整预期顺序不一致。'
    };
  }
  for (let index = 0; index < input.expectedEvents.length; index += 1) {
    const expected = input.expectedEvents[index]!;
    const actual = input.actualEvents[index]!;
    if (actual.id !== expected.id || actual.eventHash !== expected.eventHash) {
      return {
        ok: false,
        code: 'EMEVD_SEMANTIC_REORDER_ORDER_MISMATCH',
        message: `EMEVD reorder 后事件 ${index} 的 ID/semantic hash 与完整预期顺序不一致。`
      };
    }
  }
  return { ok: true };
}

export interface EmevdInstructionNodeIdentity extends EmevdInstructionArgsFieldIdentity {}

export type EmevdInstructionOrderSnapshot = {
  bank: number;
  id: number;
  instructionHash: string;
  parameterCount: number;
};

export const EMEVD_INSTRUCTION_SNAPSHOT_FORMAT_ID =
  'soulforge.emevd.instruction-semantic-v1';
export const EMEVD_INSTRUCTION_SNAPSHOT_SCHEMA_VERSION = '1.0.0';
export const EMEVD_INSTRUCTION_SNAPSHOT_MAX_BYTES = 256 * 1024;

export function emevdInstructionNodeUri(input: {
  documentUri: string;
  eventId: number;
  eventIndex: number;
  instructionIndex: number;
  bank: number;
  instructionId: number;
}): string {
  return `${input.documentUri}#event/${input.eventId}/index/${input.eventIndex}/instruction/${input.instructionIndex}/bank/${input.bank}/id/${input.instructionId}`;
}

export function parseEmevdInstructionNodeUri(
  nodeUri: string
): EmevdInstructionNodeIdentity | undefined {
  const match = /#event\/(-?\d+)\/index\/(\d+)\/instruction\/(\d+)\/bank\/(-?\d+)\/id\/(-?\d+)$/.exec(nodeUri);
  if (!match) return undefined;
  const identity = {
    eventId: Number(match[1]),
    eventIndex: Number(match[2]),
    instructionIndex: Number(match[3]),
    bank: Number(match[4]),
    instructionId: Number(match[5])
  };
  if (!Number.isSafeInteger(identity.eventId)
    || !Number.isSafeInteger(identity.eventIndex)
    || identity.eventIndex < 0
    || !Number.isSafeInteger(identity.instructionIndex)
    || identity.instructionIndex < 0
    || !Number.isSafeInteger(identity.bank)
    || !Number.isSafeInteger(identity.instructionId)) {
    return undefined;
  }
  return identity;
}

export function buildEmevdInstructionNodePayloadFromSnapshot(input: {
  eventId: number;
  eventIndex: number;
  instructionIndex: number;
  bank: number;
  instructionId: number;
  layerOffset: number;
  argsBase64: string;
  parameterCount: number;
  instructionHash: string;
  snapshotBase64: string;
  snapshotSha256: string;
  snapshotSize: number;
  snapshotFormatId: string;
  snapshotSchemaVersion: string;
}): EmevdInstructionNodePayload | undefined {
  let argsBytes: Buffer;
  try {
    argsBytes = Buffer.from(input.argsBase64, 'base64');
  } catch {
    return undefined;
  }
  const payload: EmevdInstructionNodePayload = {
    payloadVersion: 1,
    resourceKind: 'event',
    nodeType: 'emevd_instruction',
    eventId: input.eventId,
    eventIndex: input.eventIndex,
    instructionIndex: input.instructionIndex,
    bank: input.bank,
    instructionId: input.instructionId,
    layerOffset: input.layerOffset,
    parameterCount: input.parameterCount,
    instructionHash: input.instructionHash,
    args: {
      storage: 'inline',
      dataBase64: input.argsBase64,
      sha256: createHash('sha256').update(argsBytes).digest('hex'),
      size: argsBytes.length
    },
    snapshot: {
      storage: 'inline',
      dataBase64: input.snapshotBase64,
      sha256: input.snapshotSha256,
      size: input.snapshotSize,
      formatId: input.snapshotFormatId,
      schemaVersion: input.snapshotSchemaVersion
    }
  };
  return isValidEmevdInstructionNodePayload(payload) ? payload : undefined;
}

export function isValidEmevdInstructionNodePayload(
  payload: EmevdInstructionNodePayload
): boolean {
  if (!Number.isSafeInteger(payload.eventId)
    || !Number.isSafeInteger(payload.eventIndex)
    || payload.eventIndex < 0
    || !Number.isSafeInteger(payload.instructionIndex)
    || payload.instructionIndex < 0
    || !Number.isSafeInteger(payload.bank)
    || !Number.isSafeInteger(payload.instructionId)
    || !Number.isSafeInteger(payload.layerOffset)
    || !Number.isSafeInteger(payload.parameterCount)
    || payload.parameterCount < 0
    || !/^[a-f0-9]{64}$/.test(payload.instructionHash)
    || payload.args.storage !== 'inline'
    || !/^[a-f0-9]{64}$/.test(payload.args.sha256)
    || !Number.isSafeInteger(payload.args.size)
    || payload.args.size < 0
    || payload.args.size > EMEVD_INSTRUCTION_SNAPSHOT_MAX_BYTES
    || /\s/.test(payload.args.dataBase64)
    || payload.snapshot.storage !== 'inline'
    || payload.snapshot.formatId !== EMEVD_INSTRUCTION_SNAPSHOT_FORMAT_ID
    || payload.snapshot.schemaVersion !== EMEVD_INSTRUCTION_SNAPSHOT_SCHEMA_VERSION
    || payload.snapshot.sha256 !== payload.instructionHash
    || !Number.isSafeInteger(payload.snapshot.size)
    || payload.snapshot.size < 24
    || payload.snapshot.size > EMEVD_INSTRUCTION_SNAPSHOT_MAX_BYTES
    || /\s/.test(payload.snapshot.dataBase64)) {
    return false;
  }
  try {
    const argsBytes = Buffer.from(payload.args.dataBase64, 'base64');
    const snapshotBytes = Buffer.from(payload.snapshot.dataBase64, 'base64');
    return argsBytes.toString('base64') === payload.args.dataBase64
      && argsBytes.length === payload.args.size
      && createHash('sha256').update(argsBytes).digest('hex') === payload.args.sha256
      && snapshotBytes.toString('base64') === payload.snapshot.dataBase64
      && snapshotBytes.length === payload.snapshot.size
      && createHash('sha256').update(snapshotBytes).digest('hex') === payload.snapshot.sha256;
  } catch {
    return false;
  }
}

export function snapshotEmevdInstructionOrder(
  instructions: ReadonlyArray<EmevdInstructionOrderSnapshot>
): EmevdInstructionOrderSnapshot[] {
  return instructions.map((instruction) => ({ ...instruction }));
}

export function emevdInstructionOrderUris(input: {
  documentUri: string;
  eventId: number;
  eventIndex: number;
  instructions: ReadonlyArray<EmevdInstructionOrderSnapshot>;
}): string[] {
  return input.instructions.map((instruction, instructionIndex) => emevdInstructionNodeUri({
    documentUri: input.documentUri,
    eventId: input.eventId,
    eventIndex: input.eventIndex,
    instructionIndex,
    bank: instruction.bank,
    instructionId: instruction.id
  }));
}

export function hashEmevdInstructionOrder(
  instructions: ReadonlyArray<EmevdInstructionOrderSnapshot>
): string {
  return createHash('sha256')
    .update(JSON.stringify(instructions.map((instruction) => [
      instruction.bank,
      instruction.id,
      instruction.instructionHash,
      instruction.parameterCount
    ])))
    .digest('hex');
}

export type EmevdInstructionReorderResult =
  | {
      ok: true;
      afterInstructions: EmevdInstructionOrderSnapshot[];
      afterOriginalIndexes: number[];
      movedInstructionIndex: number;
    }
  | { ok: false; code: string; message: string };

export function reorderEmevdInstructionOrder(input: {
  documentUri: string;
  eventId: number;
  eventIndex: number;
  beforeInstructions: ReadonlyArray<EmevdInstructionOrderSnapshot>;
  nodeId: string;
  beforeNodeId: string | undefined;
}): EmevdInstructionReorderResult {
  const target = parseEmevdInstructionNodeUri(input.nodeId);
  const anchor = input.beforeNodeId === undefined
    ? undefined
    : parseEmevdInstructionNodeUri(input.beforeNodeId);
  const identityMatches = (identity: EmevdInstructionNodeIdentity | undefined) =>
    identity
    && identity.eventId === input.eventId
    && identity.eventIndex === input.eventIndex
    && identity.instructionIndex < input.beforeInstructions.length
    && input.beforeInstructions[identity.instructionIndex]?.bank === identity.bank
    && input.beforeInstructions[identity.instructionIndex]?.id === identity.instructionId;
  if (!identityMatches(target)) {
    return { ok: false, code: 'EMEVD_SEMANTIC_INSTRUCTION_REORDER_SOURCE_MISMATCH', message: 'EMEVD instruction reorder 源身份不匹配。' };
  }
  if (input.beforeNodeId !== undefined
    && (!identityMatches(anchor) || anchor!.instructionIndex === target!.instructionIndex)) {
    return { ok: false, code: 'EMEVD_SEMANTIC_INSTRUCTION_REORDER_ANCHOR_MISMATCH', message: 'EMEVD instruction reorder 锚点身份不匹配。' };
  }
  const indexed = snapshotEmevdInstructionOrder(input.beforeInstructions)
    .map((instruction, originalIndex) => ({ instruction, originalIndex }));
  const [moved] = indexed.splice(target!.instructionIndex, 1);
  if (!moved) {
    return { ok: false, code: 'EMEVD_SEMANTIC_INSTRUCTION_REORDER_SOURCE_MISMATCH', message: 'EMEVD instruction reorder 无法读取源指令。' };
  }
  const insertionIndex = anchor
    ? anchor.instructionIndex - (target!.instructionIndex < anchor.instructionIndex ? 1 : 0)
    : indexed.length;
  if (insertionIndex === target!.instructionIndex) {
    return { ok: false, code: 'EMEVD_SEMANTIC_INSTRUCTION_REORDER_NOOP_BLOCKED', message: 'EMEVD instruction reorder 不允许空操作。' };
  }
  indexed.splice(insertionIndex, 0, moved);
  return {
    ok: true,
    afterInstructions: indexed.map((item) => item.instruction),
    afterOriginalIndexes: indexed.map((item) => item.originalIndex),
    movedInstructionIndex: insertionIndex
  };
}

export function assertEmevdInstructionOrderEquals(input: {
  expectedInstructions: ReadonlyArray<EmevdInstructionOrderSnapshot>;
  actualInstructions: ReadonlyArray<EmevdInstructionOrderSnapshot>;
}): { ok: true } | { ok: false; code: string; message: string } {
  if (input.expectedInstructions.length !== input.actualInstructions.length) {
    return { ok: false, code: 'EMEVD_SEMANTIC_INSTRUCTION_COUNT_MISMATCH', message: 'EMEVD instructionCount 与完整预期顺序不一致。' };
  }
  for (let index = 0; index < input.expectedInstructions.length; index += 1) {
    const expected = input.expectedInstructions[index]!;
    const actual = input.actualInstructions[index]!;
    if (expected.bank !== actual.bank
      || expected.id !== actual.id
      || expected.instructionHash !== actual.instructionHash
      || expected.parameterCount !== actual.parameterCount) {
      return { ok: false, code: 'EMEVD_SEMANTIC_INSTRUCTION_ORDER_MISMATCH', message: `EMEVD instruction ${index} 的身份或 semantic hash 与完整预期顺序不一致。` };
    }
  }
  return { ok: true };
}

export function isEmevdEventNodeAddOperation(
  operation: PatchIrOperation
): operation is EmevdEventNodeAddOperation {
  if (operation.kind !== 'resource_node_add'
    || operation.resourceKind !== 'event'
    || operation.writerId !== EMEVD_SEMANTIC_WRITER_ID
    || operation.documentUri !== operation.targetUri
    || !operation.targetPath
    || operation.metadata?.nativeFormatAuthority !== true
    || operation.inverse.kind !== 'resource_node_delete'
    || operation.inverse.nodeId !== operation.nodeId
    || operation.payload.resourceKind !== 'event'
    || operation.payload.nodeType !== 'emevd_event') {
    return false;
  }
  const identity = parseEmevdEventNodeUri(operation.nodeId);
  const payload = operation.payload;
  const beforeEvents = readEmevdBeforeEventsFromMetadata(operation.metadata);
  if (!identity
    || !beforeEvents
    || identity.eventId !== payload.eventId
    || identity.eventIndex !== payload.eventIndex
    || !isValidEmevdEventNodePayload(payload)
    || operation.inverse.expectedNodeHash !== payload.eventHash) {
    return false;
  }
  if (operation.metadata?.eventAddMode === 'empty_append') {
    const canonical = buildEmevdEmptyEventNodePayload({
      eventId: payload.eventId,
      eventIndex: payload.eventIndex,
      restartType: payload.restartType
    });
    return payload.eventIndex === beforeEvents.length
      && !beforeEvents.some((event) => event.id === payload.eventId)
      && payload.eventHash === canonical.eventHash
      && payload.snapshot.storage === 'inline'
      && canonical.snapshot.storage === 'inline'
      && payload.snapshot.dataBase64 === canonical.snapshot.dataBase64;
  }
  if (operation.metadata?.eventAddMode === 'snapshot_clone_append') {
    const sourceEventId = operation.metadata.sourceEventId;
    const sourceEventIndex = operation.metadata.sourceEventIndex;
    const sourceEventHash = operation.metadata.sourceEventHash;
    return Number.isSafeInteger(sourceEventId)
      && Number.isSafeInteger(sourceEventIndex)
      && (sourceEventIndex as number) >= 0
      && typeof sourceEventHash === 'string'
      && /^[a-f0-9]{64}$/.test(sourceEventHash)
      && payload.eventIndex === beforeEvents.length
      && !beforeEvents.some((event) => event.id === payload.eventId)
      && beforeEvents[sourceEventIndex as number]?.id === sourceEventId
      && beforeEvents[sourceEventIndex as number]?.eventHash === sourceEventHash;
  }
  return operation.metadata?.eventAddMode === 'snapshot_insert'
    && operation.metadata?.inverseResourceEntry === true
    && payload.eventIndex <= beforeEvents.length;
}

export function isEmevdEventNodeDeleteOperation(
  operation: PatchIrOperation
): operation is EmevdEventNodeDeleteOperation {
  if (operation.kind !== 'resource_node_delete'
    || operation.resourceKind !== 'event'
    || operation.writerId !== EMEVD_SEMANTIC_WRITER_ID
    || operation.documentUri !== operation.targetUri
    || !operation.targetPath
    || operation.metadata?.nativeFormatAuthority !== true
    || operation.inverse.kind !== 'resource_node_add'
    || operation.inverse.nodeId !== operation.nodeId
    || operation.inverse.payload.resourceKind !== 'event'
    || operation.inverse.payload.nodeType !== 'emevd_event') {
    return false;
  }
  const identity = parseEmevdEventNodeUri(operation.nodeId);
  const payload = operation.inverse.payload;
  const beforeEvents = readEmevdBeforeEventsFromMetadata(operation.metadata);
  if (!identity
    || !beforeEvents
    || beforeEvents.length <= 1
    || identity.eventId !== payload.eventId
    || identity.eventIndex !== payload.eventIndex
    || identity.eventIndex >= beforeEvents.length
    || beforeEvents[identity.eventIndex]?.id !== identity.eventId
    || beforeEvents[identity.eventIndex]?.eventHash !== payload.eventHash
    || operation.expectedNodeHash !== payload.eventHash
    || operation.metadata?.eventDeleteMode !== 'snapshot_bound'
    || !isValidEmevdEventNodePayload(payload)) {
    return false;
  }
  return true;
}

export function isEmevdEventNodeReorderOperation(
  operation: PatchIrOperation
): operation is EmevdEventNodeReorderOperation {
  if (operation.kind !== 'resource_node_reorder'
    || operation.resourceKind !== 'event'
    || operation.writerId !== EMEVD_SEMANTIC_WRITER_ID
    || operation.documentUri !== operation.targetUri
    || !operation.targetPath
    || operation.metadata?.nativeFormatAuthority !== true
    || operation.metadata.reorderScope !== 'event'
    || operation.inverse.kind !== 'resource_node_reorder') {
    return false;
  }
  const beforeEvents = readEmevdBeforeEventsFromMetadata(operation.metadata);
  if (!beforeEvents || beforeEvents.length < 2) return false;
  const expectedOrder = emevdEventOrderUris(operation.documentUri, beforeEvents);
  if (operation.expectedOrder.length !== expectedOrder.length
    || operation.expectedOrder.some((nodeId, index) => nodeId !== expectedOrder[index])
    || !expectedOrder.includes(operation.nodeId)
    || (operation.beforeNodeId !== undefined && !expectedOrder.includes(operation.beforeNodeId))
    || operation.inverse.previousOrder.length !== expectedOrder.length
    || operation.inverse.previousOrder.some((nodeId, index) => nodeId !== expectedOrder[index])) {
    return false;
  }
  return reorderEmevdEventOrder({
    beforeEvents,
    nodeId: operation.nodeId,
    beforeNodeId: operation.beforeNodeId
  }).ok;
}

function readEmevdInstructionParentFromMetadata(
  metadata: Record<string, unknown> | undefined
): { eventId: number; eventIndex: number; eventHash: string; parameterCount: number } | undefined {
  const value = metadata?.beforeInstructionEvent;
  if (!value || typeof value !== 'object') return undefined;
  const eventId = (value as { eventId?: unknown }).eventId;
  const eventIndex = (value as { eventIndex?: unknown }).eventIndex;
  const eventHash = (value as { eventHash?: unknown }).eventHash;
  const parameterCount = (value as { parameterCount?: unknown }).parameterCount;
  if (!Number.isSafeInteger(eventId)
    || !Number.isSafeInteger(eventIndex)
    || (eventIndex as number) < 0
    || typeof eventHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(eventHash)
    || !Number.isSafeInteger(parameterCount)
    || (parameterCount as number) < 0) {
    return undefined;
  }
  return {
    eventId: eventId as number,
    eventIndex: eventIndex as number,
    eventHash,
    parameterCount: parameterCount as number
  };
}

export function readEmevdBeforeInstructionsFromMetadata(
  metadata: Record<string, unknown> | undefined
): EmevdInstructionOrderSnapshot[] | undefined {
  const value = metadata?.beforeInstructions;
  if (!Array.isArray(value)) return undefined;
  const instructions: EmevdInstructionOrderSnapshot[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return undefined;
    const bank = (item as { bank?: unknown }).bank;
    const id = (item as { id?: unknown }).id;
    const instructionHash = (item as { instructionHash?: unknown }).instructionHash;
    const parameterCount = (item as { parameterCount?: unknown }).parameterCount;
    if (!Number.isSafeInteger(bank)
      || !Number.isSafeInteger(id)
      || typeof instructionHash !== 'string'
      || !/^[a-f0-9]{64}$/.test(instructionHash)
      || !Number.isSafeInteger(parameterCount)
      || (parameterCount as number) < 0) {
      return undefined;
    }
    instructions.push({
      bank: bank as number,
      id: id as number,
      instructionHash,
      parameterCount: parameterCount as number
    });
  }
  return instructions;
}

function instructionOperationBase(input: {
  operation: ResourceNodeAddOp | ResourceNodeDeleteOp | ResourceNodeReorderOp;
  identity: EmevdInstructionNodeIdentity | undefined;
}): {
  parent: { eventId: number; eventIndex: number; eventHash: string; parameterCount: number };
  beforeInstructions: EmevdInstructionOrderSnapshot[];
  beforeEvents: EmevdEventOrderSnapshot[];
} | undefined {
  const { operation, identity } = input;
  if (operation.resourceKind !== 'event'
    || operation.writerId !== EMEVD_SEMANTIC_WRITER_ID
    || operation.documentUri !== operation.targetUri
    || !operation.targetPath
    || operation.metadata?.nativeFormatAuthority !== true
    || !identity) {
    return undefined;
  }
  const parent = readEmevdInstructionParentFromMetadata(operation.metadata);
  const beforeInstructions = readEmevdBeforeInstructionsFromMetadata(operation.metadata);
  const beforeEvents = readEmevdBeforeEventsFromMetadata(operation.metadata);
  if (!parent
    || !beforeInstructions
    || !beforeEvents
    || identity.eventId !== parent.eventId
    || identity.eventIndex !== parent.eventIndex
    || beforeEvents[parent.eventIndex]?.id !== parent.eventId
    || beforeEvents[parent.eventIndex]?.eventHash !== parent.eventHash
    || beforeInstructions.reduce((count, instruction) => count + instruction.parameterCount, 0)
      !== parent.parameterCount) {
    return undefined;
  }
  return { parent, beforeInstructions, beforeEvents };
}

export function isEmevdInstructionNodeAddOperation(
  operation: PatchIrOperation
): operation is EmevdInstructionNodeAddOperation {
  if (operation.kind !== 'resource_node_add'
    || operation.inverse.kind !== 'resource_node_delete'
    || operation.inverse.nodeId !== operation.nodeId
    || operation.payload.resourceKind !== 'event'
    || operation.payload.nodeType !== 'emevd_instruction') {
    return false;
  }
  const identity = parseEmevdInstructionNodeUri(operation.nodeId);
  const base = instructionOperationBase({ operation, identity });
  const payload = operation.payload;
  if (!base
    || !identity
    || identity.instructionIndex > base.beforeInstructions.length
    || identity.eventId !== payload.eventId
    || identity.eventIndex !== payload.eventIndex
    || identity.instructionIndex !== payload.instructionIndex
    || identity.bank !== payload.bank
    || identity.instructionId !== payload.instructionId
    || operation.inverse.expectedNodeHash !== payload.instructionHash
    || !isValidEmevdInstructionNodePayload(payload)) {
    return false;
  }
  if (operation.metadata?.instructionAddMode === 'snapshot_clone_insert') {
    const sourceInstructionIndex = operation.metadata.sourceInstructionIndex;
    const sourceInstructionHash = operation.metadata.sourceInstructionHash;
    return Number.isSafeInteger(sourceInstructionIndex)
      && (sourceInstructionIndex as number) >= 0
      && typeof sourceInstructionHash === 'string'
      && /^[a-f0-9]{64}$/.test(sourceInstructionHash)
      && base.beforeInstructions[sourceInstructionIndex as number]?.instructionHash
        === sourceInstructionHash
      && payload.instructionHash === sourceInstructionHash;
  }
  if (operation.metadata?.instructionAddMode === 'bridge_authored_zero_parameter_insert') {
    return payload.layerOffset === -1
      && payload.parameterCount === 0
      && operation.metadata.authoredInstructionHash === payload.instructionHash;
  }
  return operation.metadata?.instructionAddMode === 'snapshot_insert'
    && operation.metadata?.inverseResourceEntry === true;
}

export function isEmevdInstructionNodeDeleteOperation(
  operation: PatchIrOperation
): operation is EmevdInstructionNodeDeleteOperation {
  if (operation.kind !== 'resource_node_delete'
    || operation.inverse.kind !== 'resource_node_add'
    || operation.inverse.nodeId !== operation.nodeId
    || operation.inverse.payload.resourceKind !== 'event'
    || operation.inverse.payload.nodeType !== 'emevd_instruction') {
    return false;
  }
  const identity = parseEmevdInstructionNodeUri(operation.nodeId);
  const base = instructionOperationBase({ operation, identity });
  const payload = operation.inverse.payload;
  const before = identity ? base?.beforeInstructions[identity.instructionIndex] : undefined;
  return Boolean(base
    && identity
    && base.beforeInstructions.length > 1
    && before
    && before.bank === identity.bank
    && before.id === identity.instructionId
    && before.instructionHash === payload.instructionHash
    && identity.eventId === payload.eventId
    && identity.eventIndex === payload.eventIndex
    && identity.instructionIndex === payload.instructionIndex
    && identity.bank === payload.bank
    && identity.instructionId === payload.instructionId
    && operation.expectedNodeHash === payload.instructionHash
    && operation.metadata?.instructionDeleteMode === 'snapshot_bound'
    && isValidEmevdInstructionNodePayload(payload));
}

export function isEmevdInstructionNodeReorderOperation(
  operation: PatchIrOperation
): operation is EmevdInstructionNodeReorderOperation {
  if (operation.kind !== 'resource_node_reorder'
    || operation.inverse.kind !== 'resource_node_reorder'
    || typeof operation.parentNodeId !== 'string'
    || operation.inverse.parentNodeId !== operation.parentNodeId
    || operation.metadata?.reorderScope !== 'instruction') {
    return false;
  }
  const identity = parseEmevdInstructionNodeUri(operation.nodeId);
  const base = instructionOperationBase({ operation, identity });
  if (!base || !identity || base.beforeInstructions.length < 2) return false;
  const parentNodeId = emevdEventNodeUri({
    documentUri: operation.documentUri,
    eventId: base.parent.eventId,
    eventIndex: base.parent.eventIndex
  });
  const expectedOrder = emevdInstructionOrderUris({
    documentUri: operation.documentUri,
    eventId: base.parent.eventId,
    eventIndex: base.parent.eventIndex,
    instructions: base.beforeInstructions
  });
  if (operation.parentNodeId !== parentNodeId
    || operation.inverse.parentNodeId !== parentNodeId
    || operation.expectedOrder.length !== expectedOrder.length
    || operation.expectedOrder.some((nodeId, index) => nodeId !== expectedOrder[index])
    || operation.inverse.previousOrder.length !== expectedOrder.length
    || operation.inverse.previousOrder.some((nodeId, index) => nodeId !== expectedOrder[index])) {
    return false;
  }
  return reorderEmevdInstructionOrder({
    documentUri: operation.documentUri,
    eventId: base.parent.eventId,
    eventIndex: base.parent.eventIndex,
    beforeInstructions: base.beforeInstructions,
    nodeId: operation.nodeId,
    beforeNodeId: operation.beforeNodeId
  }).ok;
}

export function isEmevdSemanticOperation(
  operation: PatchIrOperation
): operation is EmevdSemanticOperation {
  return isEmevdSemanticFieldOperation(operation)
    || isEmevdEventNodeAddOperation(operation)
    || isEmevdEventNodeDeleteOperation(operation)
    || isEmevdEventNodeReorderOperation(operation)
    || isEmevdInstructionNodeAddOperation(operation)
    || isEmevdInstructionNodeDeleteOperation(operation)
    || isEmevdInstructionNodeReorderOperation(operation);
}

export function readEmevdBeforeEventsFromMetadata(
  metadata: Record<string, unknown> | undefined
): EmevdEventOrderSnapshot[] | undefined {
  const value = metadata?.beforeEvents;
  if (!Array.isArray(value) || value.length < 1) return undefined;
  const events: EmevdEventOrderSnapshot[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return undefined;
    const id = (item as { id?: unknown }).id;
    const eventHash = (item as { eventHash?: unknown }).eventHash;
    if (!Number.isSafeInteger(id)
      || typeof eventHash !== 'string'
      || !/^[a-f0-9]{64}$/.test(eventHash)) {
      return undefined;
    }
    events.push({ id: id as number, eventHash });
  }
  return events;
}

export function isRestBehaviorValue(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0x7fff_ffff;
}

export function normalizeArgsBase64(base64: string): string {
  if (/\s/.test(base64)) throw new Error('argsBase64 must not contain whitespace');
  const bytes = Buffer.from(base64, 'base64');
  const canonical = bytes.toString('base64');
  if (canonical !== base64) throw new Error('argsBase64 must use canonical standard Base64');
  return canonical;
}
