/**
 * Convert a DSL-compiled EmevdMutationPlan into Bridge-native batch mutations,
 * stage via Bridge, and commit through PatchIR + WorkspaceTransaction.
 *
 * DSL plan → Bridge mutations → staged bytes → file_replace PatchIR → commit → re-read.
 * Unknown instructions, opaque tails and layer variants are never re-encoded
 * (the DSL compiler already rejects them as read-only).
 */

import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type {
  EmevdEditorDocument,
  EmevdMutationPlan,
  PatchIR,
  PatchIrOperation
} from '@soulforge/shared';
import type { EmedfRegistry } from '../emevd/emedfSchema.js';
import { mutateInstructionArg } from '../emevd/emedfSchema.js';
import { decodeStrictBase64 } from '../util/base64.js';
import { formatEmevdAnchor } from '../emevd/stableIdentity.js';
import type { OperationLogStore } from '../patch/operationLog.js';
import type { WorkspaceSession } from '../workspace/workspaceSession.js';
import { runBridge } from '../bridge/runBridge.js';
import { stageBridgeOutput } from './bridgeStaging.js';
import type { EmevdBridgeCommitResult, EmevdBridgeNativeMutation } from './emevdBridgeCommit.js';
import { commitEmevdBatchViaBridge } from './emevdBridgeCommit.js';
import { createPatchIr } from '../patch-engine/patchIr.js';
import { executePatchIrThroughTransaction } from '../patch/durablePatchCommit.js';

export interface EmevdPlanCommitRequest {
  plan: EmevdMutationPlan;
  document: EmevdEditorDocument;
  registry: EmedfRegistry;
  sourcePath: string;
  expectedDocumentHash: string;
  allowedRoots: string[];
  timeoutMs?: number;
}

/** Production extensions: Patch Engine workspace + transaction wiring. */
export interface EmevdPlanPatchEngineCommitRequest extends EmevdPlanCommitRequest {
  workspaceId: string;
  /** Overlay root; the commit target must stay inside it. */
  workspaceRoot: string;
  /** Root where Bridge staging temp dirs are created (outside Mod/game dirs). */
  stagingRoot: string;
  targetUri?: string;
  title?: string;
  session?: WorkspaceSession;
  operationLog?: OperationLogStore;
  backupBaseDir?: string;
  recoveryDir?: string;
}

export interface EmevdReReadReport {
  ok: boolean;
  outputHash: string;
  eventCount: number;
  instructionCount: number;
  semanticIdentical: boolean;
  /** Committed file hash equals the Bridge-staged output hash. */
  byteConsistent: boolean;
}

export interface EmevdPlanCommitResult {
  ok: boolean;
  outputHash?: string;
  eventCount?: number;
  instructionCount?: number;
  mutationCount: number;
  opId?: string;
  committedPath?: string;
  reRead?: EmevdReReadReport;
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

export interface EmevdPlanStageResult {
  ok: boolean;
  bytes?: Buffer;
  result?: EmevdBridgeCommitResult;
  mutationCount: number;
  diagnostics: Array<{ severity: string; code: string; message: string }>;
}

/**
 * Stage an EmevdMutationPlan via Bridge as a single atomic batch write
 * (the C# writer applies the `mutations` array and re-reads the output).
 * Staging only: bytes are returned for the caller to commit via Patch Engine.
 */
export async function stageEmevdPlanViaBridge(
  request: EmevdPlanCommitRequest & { stagingRoot: string }
): Promise<EmevdPlanStageResult> {
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

  const staged = await stageBridgeOutput<EmevdBridgeCommitResult>({
    stagingRoot: request.stagingRoot,
    prefix: 'emevd-plan',
    fileName: 'plan-mutated.emevd',
    allowedRoots: (stagingRoot) => uniqueRoots([...request.allowedRoots, stagingRoot]),
    write: (context) => commitEmevdBatchViaBridge({
      sourcePath: request.sourcePath,
      outputPath: context.outputPath,
      expectedDocumentHash: request.expectedDocumentHash,
      allowedRoots: context.allowedRoots,
      writableRoots: context.writableRoots,
      mutations: converted.mutations,
      ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {})
    })
  });

  if (!staged.ok) {
    const bridgeDiagnostics = staged.result?.diagnostics ?? [];
    const allDiagnostics: EmevdPlanStageResult['diagnostics'] = [
      ...bridgeDiagnostics.map((d) => ({ severity: d.severity, code: d.code, message: d.message })),
      ...staged.diagnostics.map((d) => ({ severity: d.severity, code: d.code, message: d.message }))
    ];
    if (allDiagnostics.length === 0) {
      allDiagnostics.push({
        severity: 'error',
        code: 'BRIDGE_STAGING_FAILED',
        message: 'EMEVD 计划经 Bridge 暂存失败，且未返回结构化诊断。'
      });
    }
    return { ok: false, mutationCount: converted.mutations.length, diagnostics: allDiagnostics };
  }

  return {
    ok: true,
    bytes: staged.bytes,
    result: staged.result,
    mutationCount: converted.mutations.length,
    diagnostics: staged.result.diagnostics.map((d) => ({
      severity: d.severity,
      code: d.code,
      message: d.message
    }))
  };
}

/**
 * Build the file_replace PatchIR for Bridge-staged EMEVD bytes.
 * expectedHash precondition prevents committing over a stale source.
 */
export function buildEmevdFileReplacePatch(input: {
  workspaceId: string;
  title: string;
  targetUri: string;
  targetPath: string;
  stagedBytes: Buffer;
  expectedHash: string;
}): PatchIR {
  const op: Extract<PatchIrOperation, { kind: 'file_replace' }> = {
    id: randomUUID(),
    kind: 'file_replace',
    targetUri: input.targetUri,
    targetPath: input.targetPath,
    resourceKind: 'event',
    newContentBase64: input.stagedBytes.toString('base64'),
    expectedHash: input.expectedHash,
    preconditions: [
      {
        type: 'overlay_writable',
        description: 'Target must be inside writable overlay',
        targetUri: input.targetUri
      },
      {
        type: 'content_hash',
        description: 'Expected content hash before replace',
        expectedHash: input.expectedHash,
        targetUri: input.targetUri
      }
    ],
    validatorRequirements: [
      { validatorId: 'whole_file_replace', scope: 'before_staging', required: true },
      { validatorId: 'file_risk', scope: 'before_staging', required: true },
      { validatorId: 'binary_roundtrip', scope: 'staged_output', required: false },
      { validatorId: 'binary_roundtrip', scope: 'after_commit', required: false }
    ],
    riskLevel: 'high',
    requiresConfirmation: true,
    metadata: {
      nativeFormatAuthority: true,
      requiresConfirmation: true,
      emevdPlanBatch: true
    }
  };
  return createPatchIr({
    workspaceId: input.workspaceId,
    title: input.title,
    author: 'user',
    operations: [op]
  });
}

/**
 * Production EMEVD DSL plan commit:
 * Bridge batch staging → file_replace PatchIR → WorkspaceTransaction
 * (stage/validate/commit/backup/re-read/rollback) → Bridge re-read of the
 * committed file for byte-level consistency.
 */
export async function commitEmevdPlanViaPatchEngine(
  request: EmevdPlanPatchEngineCommitRequest
): Promise<EmevdPlanCommitResult> {
  const staged = await stageEmevdPlanViaBridge(request);
  if (!staged.ok) {
    return { ok: false, mutationCount: staged.mutationCount, diagnostics: staged.diagnostics };
  }
  if (!staged.bytes || !staged.result) {
    if (staged.mutationCount === 0) {
      // No-op plan: nothing to stage or commit.
      return { ok: true, mutationCount: 0, diagnostics: staged.diagnostics };
    }
    return {
      ok: false,
      mutationCount: staged.mutationCount,
      diagnostics: [{
        severity: 'error',
        code: 'EMEVD_PLAN_STAGE_BYTES_MISSING',
        message: 'Bridge 暂存成功但未返回输出字节，拒绝提交。'
      }]
    };
  }

  const patch = buildEmevdFileReplacePatch({
    workspaceId: request.workspaceId,
    title: request.title ?? `EMEVD DSL plan ${request.plan.planFingerprint.slice(0, 8)}`,
    targetUri: request.targetUri ?? pathToFileURL(request.sourcePath).toString(),
    targetPath: request.sourcePath,
    stagedBytes: staged.bytes,
    expectedHash: request.expectedDocumentHash
  });

  const committed = await executePatchIrThroughTransaction(patch, {
    workspaceRoot: request.workspaceRoot,
    ...(request.session !== undefined ? { session: request.session } : {}),
    ...(request.operationLog !== undefined ? { operationLog: request.operationLog } : {}),
    ...(request.backupBaseDir !== undefined ? { backupBaseDir: request.backupBaseDir } : {}),
    ...(request.recoveryDir !== undefined ? { recoveryDir: request.recoveryDir } : {})
  });
  const commitDiagnostics: Array<{ severity: string; code: string; message: string }> =
    committed.diagnostics.map((d) => ({ severity: d.severity, code: d.code, message: d.message }));

  if (committed.changedFiles.length === 0) {
    return {
      ok: false,
      mutationCount: staged.mutationCount,
      opId: committed.opId,
      diagnostics: commitDiagnostics
    };
  }

  // Re-read the committed file via Bridge (production re-read boundary).
  const reRead = await runBridge<EmevdReadEnvelope>({
    command: 'read-emevd-document',
    filePath: request.sourcePath,
    allowedRoots: request.allowedRoots,
    timeoutMs: request.timeoutMs ?? 120_000
  });
  const reReadHash = reRead.data?.sourceHash ?? '';
  const byteConsistent = reRead.parseStatus !== 'failed'
    && reReadHash.toLowerCase() === (staged.result.outputHash ?? '').toLowerCase();
  const semanticIdentical = reRead.data?.roundTrip?.semanticIdentical === true;
  const reReadOk = byteConsistent && semanticIdentical;

  const diagnostics: EmevdPlanCommitResult['diagnostics'] = [
    ...commitDiagnostics,
    ...(reReadOk
      ? [{
          severity: 'info' as const,
          code: 'EMEVD_REREAD_VERIFIED',
          message: '提交后重读通过：字节一致且语义往返一致。'
        }]
      : [{
          severity: 'error' as const,
          code: 'EMEVD_REREAD_FAILED',
          message: reRead.parseStatus === 'failed'
            ? '提交后重读失败：Bridge 无法解析已提交文件。'
            : `提交后重读不一致：字节或语义往返未通过（期望 ${staged.result.outputHash}，实际 ${reReadHash}）。`
        }])
  ];

  return {
    ok: reReadOk,
    ...(staged.result.outputHash ? { outputHash: staged.result.outputHash } : {}),
    ...(staged.result.eventCount !== undefined ? { eventCount: staged.result.eventCount } : {}),
    ...(staged.result.instructionCount !== undefined
      ? { instructionCount: staged.result.instructionCount }
      : {}),
    mutationCount: staged.mutationCount,
    opId: committed.opId,
    ...(committed.changedFiles[0] !== undefined ? { committedPath: committed.changedFiles[0] } : {}),
    reRead: {
      ok: reReadOk,
      outputHash: reReadHash,
      eventCount: reRead.data?.eventCount ?? 0,
      instructionCount: reRead.data?.instructionCount ?? 0,
      semanticIdentical,
      byteConsistent
    },
    diagnostics
  };
}

interface EmevdReadEnvelope {
  sourceHash?: string;
  eventCount?: number;
  instructionCount?: number;
  roundTrip?: { semanticIdentical?: boolean; byteIdentical?: boolean };
}

function uniqueRoots(roots: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const root of roots) {
    const key = process.platform === 'win32' ? root.toLowerCase() : root;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(root);
  }
  return result;
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
