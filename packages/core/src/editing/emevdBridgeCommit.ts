/**
 * Map EMEVD editor mutations → Bridge write-emevd staging commands.
 * Does not bypass Patch Engine: callers must commit staged bytes via PatchIR.
 */

import type { EmevdEditorMutation } from '@soulforge/shared';
import { BRIDGE_STAGING_WRITE_VERIFIED_CODES } from '@soulforge/shared';
import { runBridge } from '../bridge/runBridge.js';

export interface EmevdBridgeMutationRequest {
  sourcePath: string;
  outputPath: string;
  expectedDocumentHash: string;
  allowedRoots: string[];
  writableRoots: string[];
  mutation: EmevdEditorMutation | EmevdBridgeNativeMutation;
  /** Optional global instruction index when applying args from Bridge sample indices. */
  instructionIndex?: number;
  /** Native Oodle root required when sourcePath is a KRAK-wrapped DCX. */
  oodleRuntimeRoot?: string;
  timeoutMs?: number;
}

/** Native Bridge mutation shapes (beyond editor IR). */
export type EmevdBridgeNativeMutation =
  | { kind: 'set_rest_behavior'; eventId: number; restBehavior: number }
  | { kind: 'update_id'; eventId: number; newEventId: number }
  | { kind: 'add_event'; newEventId: number; restBehavior?: number }
  | { kind: 'delete_event'; eventId: number }
  | { kind: 'duplicate_event'; eventId: number; newEventId: number }
  | {
      kind: 'set_instruction_args';
      instructionIndex: number;
      argsBase64: string;
      eventId?: number;
    }
  | {
      /** 事件内插入一条指令；instructionIndex 是该事件内的位置（删除已应用后）。 */
      kind: 'insert_instruction';
      eventId: number;
      instructionIndex: number;
      bank: number;
      id: number;
      argsBase64: string;
    }
  | {
      /** 删除事件内一条指令；instructionIndex 是原始文档中该事件内的下标。 */
      kind: 'delete_instruction';
      eventId: number;
      instructionIndex: number;
    }
  | {
      kind: 'set_event_parameters';
      eventId: number;
      parameters: Array<{
        instructionIndex: number;
        targetStartByte: number;
        sourceStartByte: number;
        byteCount: number;
        unkId?: number;
      }>;
    };

export interface EmevdBridgeCommitResult {
  ok: boolean;
  outputHash?: string;
  /** "emevd" for raw payload output; "dcx" when the staged artifact is a rebuilt outer DCX. */
  sourceFormat?: 'emevd' | 'dcx';
  /** SHA-256 of the outer container bytes (only for dcx output; the sealed file_replace expectation). */
  outerFileHash?: string;
  /** SHA-256 of the rebuilt EMEVD payload (for dcx output; reported as sourceHash by read-emevd-document). */
  payloadHash?: string;
  eventCount?: number;
  instructionCount?: number;
  mutationCount?: number;
  diagnostics: Array<{ severity: string; code: string; message: string }>;
}

/** Batch variant: multiple mutations applied atomically by the C# writer (mutations array). */
export interface EmevdBridgeBatchRequest {
  sourcePath: string;
  outputPath: string;
  expectedDocumentHash: string;
  allowedRoots: string[];
  writableRoots: string[];
  mutations: EmevdBridgeNativeMutation[];
  /** Native Oodle root required when sourcePath is a KRAK-wrapped DCX. */
  oodleRuntimeRoot?: string;
  timeoutMs?: number;
}

/**
 * Write a single EMEVD mutation into a staging path via Bridge (production authority).
 */
export async function commitEmevdMutationViaBridge(
  request: EmevdBridgeMutationRequest
): Promise<EmevdBridgeCommitResult> {
  const commandOptions = buildCommandOptions(request);
  return runEmevdWriteCommand({
    sourcePath: request.sourcePath,
    allowedRoots: request.allowedRoots,
    writableRoots: request.writableRoots,
    ...(request.oodleRuntimeRoot !== undefined ? { oodleRuntimeRoot: request.oodleRuntimeRoot } : {}),
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    commandOptions
  });
}

/**
 * Apply an ordered batch of EMEVD mutations via Bridge in one staging write.
 * The C# writer re-reads the staged output and verifies every mutation before
 * reporting EMEVD_STAGING_WRITE_VERIFIED.
 */
export async function commitEmevdBatchViaBridge(
  request: EmevdBridgeBatchRequest
): Promise<EmevdBridgeCommitResult> {
  const commandOptions: Record<string, unknown> = {
    outputPath: request.outputPath,
    expectedDocumentHash: request.expectedDocumentHash,
    mutations: request.mutations.map((m) => buildMutationPayload(m))
  };
  return runEmevdWriteCommand({
    sourcePath: request.sourcePath,
    allowedRoots: request.allowedRoots,
    writableRoots: request.writableRoots,
    ...(request.oodleRuntimeRoot !== undefined ? { oodleRuntimeRoot: request.oodleRuntimeRoot } : {}),
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    commandOptions
  });
}

async function runEmevdWriteCommand(input: {
  sourcePath: string;
  allowedRoots: string[];
  writableRoots: string[];
  oodleRuntimeRoot?: string;
  timeoutMs?: number;
  commandOptions: Record<string, unknown>;
}): Promise<EmevdBridgeCommitResult> {
  const result = await runBridge<{
    outputHash?: string;
    sourceFormat?: 'emevd' | 'dcx';
    outerFileHash?: string;
    payloadHash?: string;
    eventCount?: number;
    instructionCount?: number;
    mutationCount?: number;
  }>({
    command: 'write-emevd',
    filePath: input.sourcePath,
    allowedRoots: input.allowedRoots,
    writableRoots: input.writableRoots,
    ...(input.oodleRuntimeRoot !== undefined ? { oodleRuntimeRoot: input.oodleRuntimeRoot } : {}),
    timeoutMs: input.timeoutMs ?? 120_000,
    commandOptions: input.commandOptions
  });
  const ok = result.diagnostics.some(
    (d) => d.code === BRIDGE_STAGING_WRITE_VERIFIED_CODES.emevd
  );
  return {
    ok,
    ...(result.data?.outputHash ? { outputHash: result.data.outputHash } : {}),
    ...(result.data?.sourceFormat === 'dcx' || result.data?.sourceFormat === 'emevd'
      ? { sourceFormat: result.data.sourceFormat }
      : {}),
    ...(result.data?.outerFileHash ? { outerFileHash: result.data.outerFileHash } : {}),
    ...(result.data?.payloadHash ? { payloadHash: result.data.payloadHash } : {}),
    ...(result.data?.eventCount !== undefined ? { eventCount: result.data.eventCount } : {}),
    ...(result.data?.instructionCount !== undefined
      ? { instructionCount: result.data.instructionCount }
      : {}),
    ...(result.data?.mutationCount !== undefined ? { mutationCount: result.data.mutationCount } : {}),
    diagnostics: result.diagnostics.map((d) => ({
      severity: d.severity,
      code: d.code,
      message: d.message
    }))
  };
}

function buildCommandOptions(
  request: EmevdBridgeMutationRequest
): Record<string, unknown> {
  return {
    outputPath: request.outputPath,
    expectedDocumentHash: request.expectedDocumentHash,
    ...buildMutationPayload(request.mutation, request.instructionIndex)
  };
}

/** Map an editor/native mutation shape to Bridge write-emevd options. */
function buildMutationPayload(
  m: EmevdEditorMutation | EmevdBridgeNativeMutation,
  instructionIndex?: number
): Record<string, unknown> {
  if ('kind' in m && m.kind === 'emevd_set_rest_behavior') {
    const eventId = parseEventIdFromUri(m.eventUri);
    return {
      mutation: 'set_rest_behavior',
      eventId,
      restBehavior: m.restBehavior
    };
  }
  if ('kind' in m && m.kind === 'emevd_update_id') {
    const eventId = parseEventIdFromUri(m.eventUri);
    return {
      mutation: 'update_id',
      eventId,
      newEventId: m.newEventId
    };
  }
  if ('kind' in m && m.kind === 'emevd_set_instruction_args') {
    if (instructionIndex === undefined) {
      throw new Error('EMEVD_INSTRUCTION_INDEX_REQUIRED');
    }
    return {
      mutation: 'set_instruction_args',
      instructionIndex,
      argsBase64: m.argsBase64
    };
  }
  if ('kind' in m && m.kind === 'set_rest_behavior' && 'eventId' in m) {
    return {
      mutation: 'set_rest_behavior',
      eventId: m.eventId,
      restBehavior: m.restBehavior
    };
  }
  if ('kind' in m && m.kind === 'update_id' && 'eventId' in m && 'newEventId' in m) {
    return {
      mutation: 'update_id',
      eventId: m.eventId,
      newEventId: m.newEventId
    };
  }
  if ('kind' in m && m.kind === 'add_event') {
    return {
      mutation: 'add_event',
      newEventId: m.newEventId,
      ...(m.restBehavior !== undefined ? { restBehavior: m.restBehavior } : {})
    };
  }
  if ('kind' in m && m.kind === 'delete_event') {
    return { mutation: 'delete_event', eventId: m.eventId };
  }
  if ('kind' in m && m.kind === 'duplicate_event') {
    return {
      mutation: 'duplicate_event',
      eventId: m.eventId,
      newEventId: m.newEventId
    };
  }
  if ('kind' in m && m.kind === 'set_instruction_args' && 'instructionIndex' in m) {
    return {
      mutation: 'set_instruction_args',
      instructionIndex: m.instructionIndex,
      argsBase64: m.argsBase64,
      ...(m.eventId !== undefined ? { eventId: m.eventId } : {})
    };
  }
  if ('kind' in m && m.kind === 'insert_instruction') {
    return {
      mutation: 'insert_instruction',
      eventId: m.eventId,
      instructionIndex: m.instructionIndex,
      bank: m.bank,
      id: m.id,
      argsBase64: m.argsBase64
    };
  }
  if ('kind' in m && m.kind === 'delete_instruction') {
    return {
      mutation: 'delete_instruction',
      eventId: m.eventId,
      instructionIndex: m.instructionIndex
    };
  }
  throw new Error(`EMEVD_BRIDGE_MUTATION_UNSUPPORTED: ${(m as { kind: string }).kind}`);
}

function parseEventIdFromUri(eventUri: string): number {
  const match = /#event\/(-?\d+)/.exec(eventUri);
  if (!match) throw new Error(`EMEVD_EVENT_URI_INVALID: ${eventUri}`);
  return Number(match[1]);
}
