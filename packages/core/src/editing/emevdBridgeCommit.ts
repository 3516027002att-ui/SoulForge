/**
 * Map EMEVD editor mutations → Bridge write-emevd staging commands.
 * Does not bypass Patch Engine: callers must commit staged bytes via PatchIR.
 */

import type { EmevdEditorMutation } from '@soulforge/shared';
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
    };

export interface EmevdBridgeCommitResult {
  ok: boolean;
  outputHash?: string;
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

function buildCommandOptions(
  request: EmevdBridgeMutationRequest
): Record<string, unknown> {
  const base = {
    outputPath: request.outputPath,
    expectedDocumentHash: request.expectedDocumentHash
  };
  const m = request.mutation;

  if ('kind' in m && m.kind === 'emevd_set_rest_behavior') {
    const eventId = parseEventIdFromUri(m.eventUri);
    return {
      ...base,
      mutation: 'set_rest_behavior',
      eventId,
      restBehavior: m.restBehavior
    };
  }
  if ('kind' in m && m.kind === 'emevd_update_id') {
    const eventId = parseEventIdFromUri(m.eventUri);
    return {
      ...base,
      mutation: 'update_id',
      eventId,
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
      restBehavior: m.restBehavior
    };
  }
  if ('kind' in m && m.kind === 'update_id' && 'eventId' in m && 'newEventId' in m) {
    return {
      ...base,
      mutation: 'update_id',
      eventId: m.eventId,
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
  if ('kind' in m && m.kind === 'delete_event') {
    return { ...base, mutation: 'delete_event', eventId: m.eventId };
  }
  if ('kind' in m && m.kind === 'duplicate_event') {
    return {
      ...base,
      mutation: 'duplicate_event',
      eventId: m.eventId,
      newEventId: m.newEventId
    };
  }
  if ('kind' in m && m.kind === 'set_instruction_args' && 'instructionIndex' in m) {
    return {
      ...base,
      mutation: 'set_instruction_args',
      instructionIndex: m.instructionIndex,
      argsBase64: m.argsBase64,
      ...(m.eventId !== undefined ? { eventId: m.eventId } : {})
    };
  }
  throw new Error(`EMEVD_BRIDGE_MUTATION_UNSUPPORTED: ${(m as { kind: string }).kind}`);
}

function parseEventIdFromUri(eventUri: string): number {
  const match = /#event\/(-?\d+)/.exec(eventUri);
  if (!match) throw new Error(`EMEVD_EVENT_URI_INVALID: ${eventUri}`);
  return Number(match[1]);
}
