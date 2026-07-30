/**
 * Convert a DSL-compiled EmevdMutationPlan into Bridge-native batch mutations,
 * stage via Bridge, and commit through PatchIR + WorkspaceTransaction.
 *
 * DSL plan → Bridge mutations → staged bytes → file_replace PatchIR → commit → re-read.
 * Unknown instructions, opaque tails and layer variants are never re-encoded
 * (the DSL compiler already rejects them as read-only).
 */

import type {
  EmevdEditorDocument,
  EmevdEditorMutation,
  EmevdMutationPlan,
  EmevdPlannedMutation
} from '@soulforge/shared';
import type { EmedfRegistry } from '../emevd/emedfSchema.js';
import { mutateInstructionArg } from '../emevd/emedfSchema.js';
import { decodeStrictBase64 } from '../util/base64.js';
import { formatEmevdAnchor } from '../emevd/stableIdentity.js';
import {
  commitEmevdMutationViaBridge,
  type EmevdBridgeCommitResult,
  type EmevdBridgeNativeMutation
} from './emevdBridgeCommit.js';
import { runBridge } from '../bridge/runBridge.js';

export interface EmevdPlanCommitRequest {
  plan: EmevdMutationPlan;
  document: EmevdEditorDocument;
  registry: EmedfRegistry;
  sourcePath: string;
  outputPath: string;
  expectedDocumentHash: string;
  allowedRoots: string[];
  writableRoots: string[];
  timeoutMs?: number;
}

export interface EmevdPlanCommitResult {
  ok: boolean;
  outputHash?: string;
  eventCount?: number;
  instructionCount?: number;
  mutationCount: number;
  diagnostics: Array<{ severity: string; code: string; message: string }>;
}

interface BridgeMutationWithOrder {
  mutation: EmevdBridgeNativeMutation;
  order: number;
}

/**
 * Convert an EmevdMutationPlan into an ordered array of Bridge-native mutations.
 *
 * Ordering guarantees:
 * 1. set_instruction_args (grouped per instruction, multiple args merged)
 * 2. set_rest_behavior
 * 3. update_id (last, because it changes the eventId that other mutations reference)
 */
export function planToBridgeMutations(
  plan: EmevdMutationPlan,
  document: EmevdEditorDocument,
  registry: EmedfRegistry
): { ok: true; mutations: EmevdBridgeNativeMutation[] }
  | { ok: false; code: string; message: string } {

  const eventByAnchor = new Map<string, (typeof document.events)[number]>();
  const instructionGlobalIndex = new Map<string, number>();
  let globalIndex = 0;
  for (const event of document.events) {
    if (event.anchor) {
      eventByAnchor.set(formatEmevdAnchor('event', event.anchor), event);
    }
    for (const instruction of event.instructions) {
      if (instruction.anchor) {
        instructionGlobalIndex.set(
          formatEmevdAnchor('instruction', instruction.anchor),
          globalIndex
        );
      }
      globalIndex++;
    }
  }

  const argGroups = new Map<string, {
    instructionAnchor: string;
    bank: number;
    id: number;
    argsBase64: string;
    changes: Array<{ argument: string; value: number | boolean }>;
  }>();

  const restBehaviorMutations: BridgeMutationWithOrder[] = [];
  const eventIdMutations: BridgeMutationWithOrder[] = [];

  for (const operation of plan.operations) {
    if (operation.kind === 'set_instruction_arg') {
      const existing = argGroups.get(operation.instructionAnchor);
      if (existing) {
        existing.changes.push({ argument: operation.argument, value: operation.after });
      } else {
        const bound = findInstructionByAnchor(document, operation.instructionAnchor);
        if (!bound) {
          return {
            ok: false,
            code: 'EMEVD_PLAN_ANCHOR_NOT_FOUND',
            message: `指令锚 ${operation.instructionAnchor} 在文档中未找到。`
          };
        }
        argGroups.set(operation.instructionAnchor, {
          instructionAnchor: operation.instructionAnchor,
          bank: bound.bank,
          id: bound.id,
          argsBase64: bound.argsBase64,
          changes: [{ argument: operation.argument, value: operation.after }]
        });
      }
    } else if (operation.kind === 'set_event_rest_behavior') {
      const event = eventByAnchor.get(operation.eventAnchor);
      if (!event) {
        return {
          ok: false,
          code: 'EMEVD_PLAN_ANCHOR_NOT_FOUND',
          message: `事件锚 ${operation.eventAnchor} 在文档中未找到。`
        };
      }
      restBehaviorMutations.push({
        mutation: {
          kind: 'set_rest_behavior',
          eventId: event.eventId,
          restBehavior: operation.after
        },
        order: 1
      });
    } else if (operation.kind === 'set_event_id') {
      const event = eventByAnchor.get(operation.eventAnchor);
      if (!event) {
        return {
          ok: false,
          code: 'EMEVD_PLAN_ANCHOR_NOT_FOUND',
          message: `事件锚 ${operation.eventAnchor} 在文档中未找到。`
        };
      }
      eventIdMutations.push({
        mutation: {
          kind: 'update_id',
          eventId: event.eventId,
          newEventId: operation.after
        },
        order: 2
      });
    }
  }

  const instructionMutations: BridgeMutationWithOrder[] = [];
  for (const group of argGroups.values()) {
    const globalIdx = instructionGlobalIndex.get(group.instructionAnchor);
    if (globalIdx === undefined) {
      return {
        ok: false,
        code: 'EMEVD_PLAN_ANCHOR_NOT_FOUND',
        message: `指令锚 ${group.instructionAnchor} 没有全局索引。`
      };
    }
    let currentArgs: Buffer;
    try {
      currentArgs = decodeStrictBase64(group.argsBase64, { allowEmpty: true });
    } catch {
      return {
        ok: false,
        code: 'EMEVD_PLAN_ARGS_DECODE_FAILED',
        message: `指令 ${group.instructionAnchor} 的 argsBase64 无效。`
      };
    }
    for (const change of group.changes) {
      const result = mutateInstructionArg(
        registry, group.bank, group.id, currentArgs, change.argument, change.value
      );
      if (!result.ok) {
        return {
          ok: false,
          code: result.code,
          message: result.message
        };
      }
      currentArgs = result.args;
    }
    instructionMutations.push({
      mutation: {
        kind: 'set_instruction_args',
        instructionIndex: globalIdx,
        argsBase64: currentArgs.toString('base64')
      },
      order: 0
    });
  }

  const all = [...instructionMutations, ...restBehaviorMutations, ...eventIdMutations]
    .sort((a, b) => a.order - b.order)
    .map((item) => item.mutation);

  return { ok: true, mutations: all };
}

/**
 * Stage an EmevdMutationPlan via Bridge as a single batch write.
 * The Bridge C# writer supports a `mutations` array for atomic batch application.
 */
export async function commitEmevdPlanViaBridge(
  request: EmevdPlanCommitRequest
): Promise<EmevdPlanCommitResult> {
  const converted = planToBridgeMutations(request.plan, request.document, request.registry);
  if (!converted.ok) {
    return {
      ok: false,
      mutationCount: 0,
      diagnostics: [{ severity: 'error', code: converted.code, message: converted.message }]
    };
  }
  if (converted.mutations.length === 0) {
    return {
      ok: true,
      mutationCount: 0,
      diagnostics: [{
        severity: 'info',
        code: 'EMEVD_PLAN_EMPTY',
        message: '计划中没有需要执行的 mutation。'
      }]
    };
  }

  const commandOptions: Record<string, unknown> = {
    outputPath: request.outputPath,
    expectedDocumentHash: request.expectedDocumentHash,
    mutations: converted.mutations.map((m) => {
      if (m.kind === 'set_instruction_args') {
        return {
          kind: 'set_instruction_args',
          instructionIndex: m.instructionIndex,
          argsBase64: m.argsBase64,
          ...(m.eventId !== undefined ? { eventId: m.eventId } : {})
        };
      }
      if (m.kind === 'set_rest_behavior') {
        return { kind: 'set_rest_behavior', eventId: m.eventId, restBehavior: m.restBehavior };
      }
      if (m.kind === 'update_id') {
        return { kind: 'update_id', eventId: m.eventId, newEventId: m.newEventId };
      }
      if (m.kind === 'add_event') {
        return { kind: 'add_event', newEventId: m.newEventId, ...(m.restBehavior !== undefined ? { restBehavior: m.restBehavior } : {}) };
      }
      if (m.kind === 'delete_event') {
        return { kind: 'delete_event', eventId: m.eventId };
      }
      if (m.kind === 'duplicate_event') {
        return { kind: 'duplicate_event', eventId: m.eventId, newEventId: m.newEventId };
      }
      return m;
    })
  };

  const result = await runBridge<{
    outputHash?: string;
    eventCount?: number;
    instructionCount?: number;
    mutationCount?: number;
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
    ...(result.data?.instructionCount !== undefined ? { instructionCount: result.data.instructionCount } : {}),
    mutationCount: converted.mutations.length,
    diagnostics: result.diagnostics.map((d) => ({
      severity: d.severity,
      code: d.code,
      message: d.message
    }))
  };
}

function findInstructionByAnchor(
  document: EmevdEditorDocument,
  instructionAnchor: string
): { bank: number; id: number; argsBase64: string } | undefined {
  for (const event of document.events) {
    for (const instruction of event.instructions) {
      if (instruction.anchor && formatEmevdAnchor('instruction', instruction.anchor) === instructionAnchor) {
        return { bank: instruction.bank, id: instruction.id, argsBase64: instruction.argsBase64 };
      }
    }
  }
  return undefined;
}
