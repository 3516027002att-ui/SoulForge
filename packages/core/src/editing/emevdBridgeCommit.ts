/**
 * Map EMEVD editor mutations → Bridge write-emevd staging commands.
 * Does not bypass Patch Engine: callers must commit staged bytes via PatchIR.
 */

import { createHash } from 'node:crypto';
import type { EmevdEditorMutation } from '@soulforge/shared';
import { runBridge } from '../bridge/runBridge.js';

export interface EmevdBridgeMutationRequest {
  sourcePath: string;
  outputPath: string;
  expectedSourceHash: string;
  allowedRoots: string[];
  writableRoots: string[];
  mutation: EmevdEditorMutation | EmevdBridgeNativeMutation;
  /** Optional global instruction index when applying args from Bridge sample indices. */
  instructionIndex?: number;
  timeoutMs?: number;
}

/** Native Bridge mutation shapes (beyond editor IR). */
export type EmevdBridgeNativeMutation =
  | { kind: 'set_rest_behavior'; eventId: number; eventIndex?: number; restBehavior: number }
  | { kind: 'update_id'; eventId: number; eventIndex?: number; newEventId: number }
  | { kind: 'add_event'; newEventId: number; restBehavior?: number }
  | {
      kind: 'insert_event_snapshot';
      eventId: number;
      insertEventIndex: number;
      expectedEventHash: string;
      snapshotFormatId: string;
      snapshotSchemaVersion: string;
      snapshotBase64: string;
      snapshotSha256: string;
    }
  | {
      kind: 'insert_instruction_snapshot';
      eventId: number;
      eventIndex: number;
      insertInstructionIndex: number;
      expectedInstructionHash: string;
      snapshotFormatId: string;
      snapshotSchemaVersion: string;
      snapshotBase64: string;
      snapshotSha256: string;
    }
  | { kind: 'delete_event'; eventId: number; eventIndex?: number }
  | { kind: 'duplicate_event'; eventId: number; eventIndex?: number; newEventId: number }
  | {
      kind: 'reorder_event';
      eventId: number;
      eventIndex: number;
      beforeEventId?: number;
      beforeEventIndex?: number;
    }
  | {
      kind: 'set_instruction_args';
      /** Global instruction index when event-local identity is not provided. */
      instructionIndex?: number;
      argsBase64: string;
      eventId?: number;
      eventIndex?: number;
      instructionLocalIndex?: number;
      expectedBank?: number;
      expectedInstructionId?: number;
    }
  | {
      kind: 'add_instruction';
      eventId: number;
      eventIndex: number;
      instructionIndex: number;
      bank: number;
      id: number;
      argsBase64: string;
    }
  | {
      kind: 'delete_instruction' | 'duplicate_instruction';
      eventId: number;
      eventIndex: number;
      instructionIndex: number;
      expectedBank: number;
      expectedInstructionId: number;
    }
  | {
      kind: 'reorder_instruction';
      eventId: number;
      eventIndex: number;
      instructionIndex: number;
      expectedBank: number;
      expectedInstructionId: number;
      beforeInstructionIndex?: number;
      beforeExpectedBank?: number;
      beforeExpectedInstructionId?: number;
    };

export interface EmevdBridgeCommitResult {
  ok: boolean;
  outputHash?: string;
  documentHash?: string;
  eventCount?: number;
  instructionCount?: number;
  diagnostics: Array<{ severity: string; code: string; message: string }>;
}

/**
 * Write a single EMEVD mutation into a staging path via Bridge (production authority).
 */
export async function commitEmevdMutationViaBridge(
  request: EmevdBridgeMutationRequest
): Promise<EmevdBridgeCommitResult> {
  const commandOptions = buildCommandOptions(request);
  const result = await runBridge<{
    outputHash?: string;
    documentHash?: string;
    eventCount?: number;
    instructionCount?: number;
  }>({
    command: 'write-emevd',
    filePath: request.sourcePath,
    allowedRoots: request.allowedRoots,
    writableRoots: request.writableRoots,
    timeoutMs: request.timeoutMs ?? 120_000,
    commandOptions
  });
  const ok = result.diagnostics.some((d) => d.code === 'EMEVD_STAGING_WRITE_VERIFIED');
  return {
    ok,
    ...(result.data?.outputHash ? { outputHash: result.data.outputHash } : {}),
    ...(result.data?.documentHash ? { documentHash: result.data.documentHash } : {}),
    ...(result.data?.eventCount !== undefined ? { eventCount: result.data.eventCount } : {}),
    ...(result.data?.instructionCount !== undefined
      ? { instructionCount: result.data.instructionCount }
      : {}),
    diagnostics: result.diagnostics.map((d) => ({
      severity: d.severity,
      code: d.code,
      message: d.message
    }))
  };
}

export interface EmevdFocusedInstruction {
  eventId: number;
  eventIndex: number;
  instructionIndex: number;
  globalInstructionIndex: number;
  bank: number;
  id: number;
  argsLength: number;
  argsBase64: string;
  layerOffset: number;
  parameterCount: number;
  instructionHash: string;
}

export interface EmevdFocusedInstructionSnapshot {
  eventId: number;
  eventIndex: number;
  eventHash: string;
  instructionIndex: number;
  bank: number;
  id: number;
  layerOffset: number;
  argsLength: number;
  argsBase64: string;
  parameterCount: number;
  instructionHash: string;
  snapshotFormatId: string;
  snapshotSchemaVersion: string;
  snapshotBase64: string;
  snapshotSha256: string;
  snapshotSize: number;
}

export interface EmevdFocusedEventSnapshot {
  eventId: number;
  eventIndex: number;
  eventHash: string;
  restBehavior: number;
  instructionCount: number;
  parameterCount: number;
  sourceEventId: number;
  sourceEventIndex: number;
  sourceEventHash: string;
  snapshotFormatId: string;
  snapshotSchemaVersion: string;
  snapshotBase64: string;
  snapshotSha256: string;
  snapshotSize: number;
}

export interface EmevdFocusedEventInstructionOrder {
  eventId: number;
  eventIndex: number;
  eventHash: string;
  instructionCount: number;
  parameterCount: number;
  instructions: Array<{
    instructionIndex: number;
    bank: number;
    id: number;
    instructionHash: string;
    parameterCount: number;
  }>;
}

export interface EmevdBridgeDocument {
  sourceHash: string;
  documentHash: string;
  documentRevision: string;
  schemaId: string;
  schemaVersion: string;
  layoutFingerprint: string;
  containerKind: 'raw' | 'dcx';
  compressionFormat?: string;
  layerCount: number;
  eventCount: number;
  instructionCount: number;
  authority?: string;
  events: Array<{
    id: number;
    eventIndex: number;
    eventHash: string;
    instructionCount: number;
    parameterCount: number;
    restBehavior: number;
  }>;
  focusedInstruction?: EmevdFocusedInstruction | null;
  focusedEventSnapshot?: EmevdFocusedEventSnapshot | null;
  focusedInstructionSnapshot?: EmevdFocusedInstructionSnapshot | null;
  focusedEventInstructionOrder?: EmevdFocusedEventInstructionOrder | null;
  authoredInstructionSnapshot?: EmevdFocusedInstructionSnapshot | null;
}

export async function readEmevdDocumentViaBridge(input: {
  sourcePath: string;
  allowedRoots: string[];
  timeoutMs?: number;
  focusEventIndex?: number;
  focusInstructionLocalIndex?: number;
  snapshotEventIndex?: number;
  snapshotEventIdOverride?: number;
  snapshotInstructionEventIndex?: number;
  snapshotInstructionLocalIndex?: number;
  instructionOrderEventIndex?: number;
  authorInstruction?: {
    eventIndex: number;
    instructionIndex: number;
    bank: number;
    id: number;
    argsBase64: string;
  };
}): Promise<{
  ok: boolean;
  data?: EmevdBridgeDocument;
  diagnostics: Array<{ severity: string; code: string; message: string }>;
}> {
  const commandOptions: Record<string, unknown> = {};
  if (Number.isSafeInteger(input.focusEventIndex)
    && Number.isSafeInteger(input.focusInstructionLocalIndex)) {
    commandOptions.focusEventIndex = input.focusEventIndex;
    commandOptions.focusInstructionLocalIndex = input.focusInstructionLocalIndex;
  }
  if (Number.isSafeInteger(input.snapshotEventIndex)) {
    commandOptions.snapshotEventIndex = input.snapshotEventIndex;
  }
  if (Number.isSafeInteger(input.snapshotEventIdOverride)) {
    commandOptions.snapshotEventIdOverride = input.snapshotEventIdOverride;
  }
  if (Number.isSafeInteger(input.snapshotInstructionEventIndex)
    && Number.isSafeInteger(input.snapshotInstructionLocalIndex)) {
    commandOptions.snapshotInstructionEventIndex = input.snapshotInstructionEventIndex;
    commandOptions.snapshotInstructionLocalIndex = input.snapshotInstructionLocalIndex;
  }
  if (Number.isSafeInteger(input.instructionOrderEventIndex)) {
    commandOptions.instructionOrderEventIndex = input.instructionOrderEventIndex;
  }
  if (input.authorInstruction) {
    commandOptions.authorInstructionEventIndex = input.authorInstruction.eventIndex;
    commandOptions.authorInstructionIndex = input.authorInstruction.instructionIndex;
    commandOptions.authorInstructionBank = input.authorInstruction.bank;
    commandOptions.authorInstructionId = input.authorInstruction.id;
    commandOptions.authorInstructionArgsBase64 = input.authorInstruction.argsBase64;
  }
  const result = await runBridge<EmevdBridgeDocument>({
    command: 'read-emevd-document',
    filePath: input.sourcePath,
    allowedRoots: input.allowedRoots,
    timeoutMs: input.timeoutMs ?? 120_000,
    ...(Object.keys(commandOptions).length > 0 ? { commandOptions } : {})
  });
  const data = result.data;
  const snapshot = data?.focusedEventSnapshot;
  const snapshotBytes = snapshot ? decodeCanonicalBase64(snapshot.snapshotBase64) : undefined;
  const snapshotSource = input.snapshotEventIndex === undefined
    ? undefined
    : data?.events[input.snapshotEventIndex];
  const snapshotTargetIndex = input.snapshotEventIdOverride === undefined
    ? input.snapshotEventIndex
    : data?.events.length;
  const snapshotRequestShapeInvalid = input.snapshotEventIdOverride !== undefined
    && (input.snapshotEventIndex === undefined
      || !Number.isSafeInteger(input.snapshotEventIdOverride));
  const requestedSnapshotInvalid = input.snapshotEventIndex !== undefined
    && (!snapshot
      || snapshot.eventIndex !== snapshotTargetIndex
      || snapshot.eventId !== (input.snapshotEventIdOverride ?? snapshotSource?.id)
      || !Number.isSafeInteger(snapshot.eventId)
      || !/^[a-f0-9]{64}$/.test(snapshot.eventHash)
      || !Number.isSafeInteger(snapshot.restBehavior)
      || snapshot.restBehavior < 0
      || !Number.isSafeInteger(snapshot.instructionCount)
      || snapshot.instructionCount < 0
      || !Number.isSafeInteger(snapshot.parameterCount)
      || snapshot.parameterCount < 0
      || snapshot.snapshotFormatId !== 'soulforge.emevd.event-semantic-v1'
      || snapshot.snapshotSchemaVersion !== '1.0.0'
      || !/^[a-f0-9]{64}$/.test(snapshot.snapshotSha256)
      || !Number.isSafeInteger(snapshot.snapshotSize)
      || snapshot.snapshotSize < 20
      || snapshot.snapshotSize > 256 * 1024
      || !snapshotBytes
      || snapshotBytes.length !== snapshot.snapshotSize
      || createHash('sha256').update(snapshotBytes).digest('hex') !== snapshot.snapshotSha256
      || snapshot.snapshotSha256 !== snapshot.eventHash
      || !snapshotSource
      || snapshot.sourceEventId !== snapshotSource.id
      || snapshot.sourceEventIndex !== input.snapshotEventIndex
      || snapshot.sourceEventHash !== snapshotSource.eventHash
      || snapshotSource.restBehavior !== snapshot.restBehavior
      || snapshotSource.instructionCount !== snapshot.instructionCount
      || snapshotSource.parameterCount !== snapshot.parameterCount
      || (input.snapshotEventIdOverride === undefined
        && snapshot.eventHash !== snapshotSource.eventHash));
  const instructionSnapshot = data?.focusedInstructionSnapshot;
  const instructionSnapshotBytes = instructionSnapshot
    ? decodeCanonicalBase64(instructionSnapshot.snapshotBase64)
    : undefined;
  const instructionArgsBytes = instructionSnapshot
    ? decodeCanonicalBase64(instructionSnapshot.argsBase64, true)
    : undefined;
  const instructionSnapshotRequestShapeInvalid =
    (input.snapshotInstructionEventIndex === undefined)
      !== (input.snapshotInstructionLocalIndex === undefined);
  const requestedInstructionSnapshotInvalid = input.snapshotInstructionEventIndex !== undefined
    && input.snapshotInstructionLocalIndex !== undefined
    && (!instructionSnapshot
      || instructionSnapshot.eventIndex !== input.snapshotInstructionEventIndex
      || instructionSnapshot.instructionIndex !== input.snapshotInstructionLocalIndex
      || data?.events[instructionSnapshot.eventIndex]?.id !== instructionSnapshot.eventId
      || data.events[instructionSnapshot.eventIndex]?.eventHash !== instructionSnapshot.eventHash
      || !Number.isSafeInteger(instructionSnapshot.bank)
      || !Number.isSafeInteger(instructionSnapshot.id)
      || !Number.isSafeInteger(instructionSnapshot.layerOffset)
      || !Number.isSafeInteger(instructionSnapshot.argsLength)
      || instructionSnapshot.argsLength < 0
      || !instructionArgsBytes
      || instructionArgsBytes.length !== instructionSnapshot.argsLength
      || !Number.isSafeInteger(instructionSnapshot.parameterCount)
      || instructionSnapshot.parameterCount < 0
      || !/^[a-f0-9]{64}$/.test(instructionSnapshot.instructionHash)
      || instructionSnapshot.snapshotFormatId !== 'soulforge.emevd.instruction-semantic-v1'
      || instructionSnapshot.snapshotSchemaVersion !== '1.0.0'
      || instructionSnapshot.snapshotSha256 !== instructionSnapshot.instructionHash
      || !Number.isSafeInteger(instructionSnapshot.snapshotSize)
      || instructionSnapshot.snapshotSize < 24
      || instructionSnapshot.snapshotSize > 256 * 1024
      || !instructionSnapshotBytes
      || instructionSnapshotBytes.length !== instructionSnapshot.snapshotSize
      || createHash('sha256').update(instructionSnapshotBytes).digest('hex')
        !== instructionSnapshot.snapshotSha256);
  const instructionOrder = data?.focusedEventInstructionOrder;
  const requestedInstructionOrderInvalid = input.instructionOrderEventIndex !== undefined
    && (!instructionOrder
      || instructionOrder.eventIndex !== input.instructionOrderEventIndex
      || data?.events[instructionOrder.eventIndex]?.id !== instructionOrder.eventId
      || data.events[instructionOrder.eventIndex]?.eventHash !== instructionOrder.eventHash
      || data.events[instructionOrder.eventIndex]?.instructionCount
        !== instructionOrder.instructionCount
      || data.events[instructionOrder.eventIndex]?.parameterCount !== instructionOrder.parameterCount
      || !Array.isArray(instructionOrder.instructions)
      || instructionOrder.instructions.length !== instructionOrder.instructionCount
      || instructionOrder.instructions.some((instruction, instructionIndex) =>
        instruction.instructionIndex !== instructionIndex
        || !Number.isSafeInteger(instruction.bank)
        || !Number.isSafeInteger(instruction.id)
        || !/^[a-f0-9]{64}$/.test(instruction.instructionHash)
        || !Number.isSafeInteger(instruction.parameterCount)
        || instruction.parameterCount < 0)
      || instructionOrder.instructions.reduce(
        (count, instruction) => count + instruction.parameterCount,
        0
      ) !== instructionOrder.parameterCount);
  const authoredInstruction = data?.authoredInstructionSnapshot;
  const authoredInstructionBytes = authoredInstruction
    ? decodeCanonicalBase64(authoredInstruction.snapshotBase64)
    : undefined;
  const authoredInstructionArgsBytes = authoredInstruction
    ? decodeCanonicalBase64(authoredInstruction.argsBase64, true)
    : undefined;
  const requestedAuthorArgsBytes = input.authorInstruction
    ? decodeCanonicalBase64(input.authorInstruction.argsBase64, true)
    : undefined;
  const requestedAuthoredInstructionInvalid = input.authorInstruction !== undefined
    && (!authoredInstruction
      || authoredInstruction.eventIndex !== input.authorInstruction.eventIndex
      || authoredInstruction.instructionIndex !== input.authorInstruction.instructionIndex
      || authoredInstruction.bank !== input.authorInstruction.bank
      || authoredInstruction.id !== input.authorInstruction.id
      || authoredInstruction.layerOffset !== -1
      || authoredInstruction.parameterCount !== 0
      || data?.events[authoredInstruction.eventIndex]?.id !== authoredInstruction.eventId
      || data.events[authoredInstruction.eventIndex]?.eventHash !== authoredInstruction.eventHash
      || authoredInstruction.instructionIndex < 0
      || authoredInstruction.instructionIndex
        > data.events[authoredInstruction.eventIndex]!.instructionCount
      || !requestedAuthorArgsBytes
      || !authoredInstructionArgsBytes
      || !authoredInstructionArgsBytes.equals(requestedAuthorArgsBytes)
      || authoredInstruction.argsLength !== authoredInstructionArgsBytes.length
      || !/^[a-f0-9]{64}$/.test(authoredInstruction.instructionHash)
      || authoredInstruction.snapshotFormatId !== 'soulforge.emevd.instruction-semantic-v1'
      || authoredInstruction.snapshotSchemaVersion !== '1.0.0'
      || authoredInstruction.snapshotSha256 !== authoredInstruction.instructionHash
      || !Number.isSafeInteger(authoredInstruction.snapshotSize)
      || authoredInstruction.snapshotSize < 24
      || authoredInstruction.snapshotSize > 256 * 1024
      || !authoredInstructionBytes
      || authoredInstructionBytes.length !== authoredInstruction.snapshotSize
      || createHash('sha256').update(authoredInstructionBytes).digest('hex')
        !== authoredInstruction.snapshotSha256);
  if (result.parseStatus === 'failed'
    || !data?.sourceHash
    || !data.documentHash
    || !data.documentRevision
    || !data.schemaId
    || !data.schemaVersion
    || !data.layoutFingerprint
    || !Array.isArray(data.events)
    || data.events.length !== data.eventCount
    || data.events.some((event, eventIndex) =>
      !Number.isSafeInteger(event.id)
      || event.eventIndex !== eventIndex
      || !/^[a-f0-9]{64}$/.test(event.eventHash)
      || !Number.isSafeInteger(event.instructionCount)
      || event.instructionCount < 0
      || !Number.isSafeInteger(event.parameterCount)
      || event.parameterCount < 0
      || !Number.isSafeInteger(event.restBehavior)
      || event.restBehavior < 0)
    || snapshotRequestShapeInvalid
    || requestedSnapshotInvalid
    || instructionSnapshotRequestShapeInvalid
    || requestedInstructionSnapshotInvalid
    || requestedInstructionOrderInvalid
    || requestedAuthoredInstructionInvalid) {
    return {
      ok: false,
      diagnostics: result.diagnostics.map((diagnostic) => ({
        severity: diagnostic.severity,
        code: diagnostic.code,
        message: diagnostic.message
      }))
    };
  }
  return {
    ok: true,
    data,
    diagnostics: result.diagnostics.map((diagnostic) => ({
      severity: diagnostic.severity,
      code: diagnostic.code,
      message: diagnostic.message
    }))
  };
}

function buildCommandOptions(
  request: EmevdBridgeMutationRequest
): Record<string, unknown> {
  const base = {
    outputPath: request.outputPath,
    expectedSourceHash: request.expectedSourceHash
  };
  const m = request.mutation;

  if ('kind' in m && m.kind === 'emevd_set_rest_behavior') {
    const eventId = parseEventIdFromUri(m.eventUri);
    const eventIndex = parseEventIndexFromUri(m.eventUri);
    return {
      ...base,
      mutation: 'set_rest_behavior',
      eventId,
      ...(eventIndex !== undefined ? { eventIndex } : {}),
      restBehavior: m.restBehavior
    };
  }
  if ('kind' in m && m.kind === 'emevd_update_id') {
    const eventId = parseEventIdFromUri(m.eventUri);
    const eventIndex = parseEventIndexFromUri(m.eventUri);
    return {
      ...base,
      mutation: 'update_id',
      eventId,
      ...(eventIndex !== undefined ? { eventIndex } : {}),
      newEventId: m.newEventId
    };
  }
  if ('kind' in m && m.kind === 'emevd_set_instruction_args') {
    if (request.instructionIndex === undefined) {
      throw new Error('EMEVD_INSTRUCTION_INDEX_REQUIRED');
    }
    return {
      ...base,
      mutation: 'set_instruction_args',
      instructionIndex: request.instructionIndex,
      argsBase64: m.argsBase64
    };
  }
  if ('kind' in m && m.kind === 'set_rest_behavior' && 'eventId' in m) {
    return {
      ...base,
      mutation: 'set_rest_behavior',
      eventId: m.eventId,
      ...(m.eventIndex !== undefined ? { eventIndex: m.eventIndex } : {}),
      restBehavior: m.restBehavior
    };
  }
  if ('kind' in m && m.kind === 'update_id' && 'eventId' in m && 'newEventId' in m) {
    return {
      ...base,
      mutation: 'update_id',
      eventId: m.eventId,
      ...(m.eventIndex !== undefined ? { eventIndex: m.eventIndex } : {}),
      newEventId: m.newEventId
    };
  }
  if ('kind' in m && m.kind === 'add_event') {
    return {
      ...base,
      mutation: 'add_event',
      newEventId: m.newEventId,
      ...(m.restBehavior !== undefined ? { restBehavior: m.restBehavior } : {})
    };
  }
  if ('kind' in m && m.kind === 'insert_event_snapshot') {
    return {
      ...base,
      mutation: 'insert_event_snapshot',
      eventId: m.eventId,
      insertEventIndex: m.insertEventIndex,
      expectedEventHash: m.expectedEventHash,
      snapshotFormatId: m.snapshotFormatId,
      snapshotSchemaVersion: m.snapshotSchemaVersion,
      snapshotBase64: m.snapshotBase64,
      snapshotSha256: m.snapshotSha256
    };
  }
  if ('kind' in m && m.kind === 'insert_instruction_snapshot') {
    return {
      ...base,
      mutation: 'insert_instruction_snapshot',
      eventId: m.eventId,
      eventIndex: m.eventIndex,
      insertInstructionIndex: m.insertInstructionIndex,
      expectedInstructionHash: m.expectedInstructionHash,
      snapshotFormatId: m.snapshotFormatId,
      snapshotSchemaVersion: m.snapshotSchemaVersion,
      snapshotBase64: m.snapshotBase64,
      snapshotSha256: m.snapshotSha256
    };
  }
  if ('kind' in m && m.kind === 'delete_event') {
    return {
      ...base,
      mutation: 'delete_event',
      eventId: m.eventId,
      ...(m.eventIndex !== undefined ? { eventIndex: m.eventIndex } : {})
    };
  }
  if ('kind' in m && m.kind === 'duplicate_event') {
    return {
      ...base,
      mutation: 'duplicate_event',
      eventId: m.eventId,
      ...(m.eventIndex !== undefined ? { eventIndex: m.eventIndex } : {}),
      newEventId: m.newEventId
    };
  }
  if ('kind' in m && m.kind === 'reorder_event') {
    return {
      ...base,
      mutation: 'reorder_event',
      eventId: m.eventId,
      eventIndex: m.eventIndex,
      ...(m.beforeEventId !== undefined ? { beforeEventId: m.beforeEventId } : {}),
      ...(m.beforeEventIndex !== undefined ? { beforeEventIndex: m.beforeEventIndex } : {})
    };
  }
  if ('kind' in m && m.kind === 'set_instruction_args') {
    return {
      ...base,
      mutation: 'set_instruction_args',
      argsBase64: m.argsBase64,
      ...(m.instructionIndex !== undefined ? { instructionIndex: m.instructionIndex } : {}),
      ...(m.eventId !== undefined ? { eventId: m.eventId } : {}),
      ...(m.eventIndex !== undefined ? { eventIndex: m.eventIndex } : {}),
      ...(m.instructionLocalIndex !== undefined
        ? { instructionLocalIndex: m.instructionLocalIndex }
        : {}),
      ...(m.expectedBank !== undefined ? { expectedBank: m.expectedBank } : {}),
      ...(m.expectedInstructionId !== undefined
        ? { expectedInstructionId: m.expectedInstructionId }
        : {})
    };
  }
  if ('kind' in m && m.kind === 'add_instruction') {
    return {
      ...base,
      mutation: 'add_instruction',
      eventId: m.eventId,
      eventIndex: m.eventIndex,
      instructionIndex: m.instructionIndex,
      bank: m.bank,
      id: m.id,
      argsBase64: m.argsBase64
    };
  }
  if ('kind' in m && (m.kind === 'delete_instruction' || m.kind === 'duplicate_instruction')) {
    return {
      ...base,
      mutation: m.kind,
      eventId: m.eventId,
      eventIndex: m.eventIndex,
      instructionIndex: m.instructionIndex,
      expectedBank: m.expectedBank,
      expectedInstructionId: m.expectedInstructionId
    };
  }
  if ('kind' in m && m.kind === 'reorder_instruction') {
    return {
      ...base,
      mutation: 'reorder_instruction',
      eventId: m.eventId,
      eventIndex: m.eventIndex,
      instructionIndex: m.instructionIndex,
      expectedBank: m.expectedBank,
      expectedInstructionId: m.expectedInstructionId,
      ...(m.beforeInstructionIndex !== undefined
        ? { beforeInstructionIndex: m.beforeInstructionIndex }
        : {}),
      ...(m.beforeExpectedBank !== undefined ? { beforeExpectedBank: m.beforeExpectedBank } : {}),
      ...(m.beforeExpectedInstructionId !== undefined
        ? { beforeExpectedInstructionId: m.beforeExpectedInstructionId }
        : {})
    };
  }
  throw new Error(`EMEVD_BRIDGE_MUTATION_UNSUPPORTED: ${(m as { kind: string }).kind}`);
}

function parseEventIdFromUri(eventUri: string): number {
  const match = /#event\/(-?\d+)/.exec(eventUri);
  if (!match) throw new Error(`EMEVD_EVENT_URI_INVALID: ${eventUri}`);
  return Number(match[1]);
}

function parseEventIndexFromUri(eventUri: string): number | undefined {
  const match = /#event\/-?\d+\/index\/(\d+)/.exec(eventUri);
  return match ? Number(match[1]) : undefined;
}

function decodeCanonicalBase64(value: string, allowEmpty = false): Buffer | undefined {
  if (typeof value !== 'string'
    || (!allowEmpty && value.length === 0)
    || /\s/.test(value)) return undefined;
  try {
    const bytes = Buffer.from(value, 'base64');
    return bytes.toString('base64') === value ? bytes : undefined;
  } catch {
    return undefined;
  }
}
