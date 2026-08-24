/**
 * Convert a DSL-compiled EmevdMutationPlan into Bridge-native batch mutations,
 * stage via Bridge, and commit through PatchIR + WorkspaceTransaction.
 *
 * DSL plan → Bridge mutations → staged bytes → file_replace PatchIR → commit → re-read.
 * Unknown instructions, opaque tails and layer variants are never re-encoded
 * (the DSL compiler already rejects them as read-only).
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type {
  EmevdEditorDocument,
  EmevdMutationPlan,
  PatchIR,
  PatchIrOperation,
  StructuredDiagnostic,
  ValidatorContract,
  ValidatorResult
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
  /** SHA-256 of the decompressed EMEVD payload (Bridge write-emevd hash check). */
  expectedDocumentHash: string;
  /**
   * SHA-256 of the outer source resource file bytes (the .dcx wrapper). When
   * the source is a .dcx, the PatchIR file_replace content_hash precondition
   * must compare against the on-disk .dcx bytes — never the payload hash.
   */
  expectedOuterFileHash?: string;
  /** Native Oodle root required when sourcePath is a KRAK-wrapped DCX. */
  oodleRuntimeRoot?: string;
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
  /** "emevd" for raw payload output; "dcx" when the staged artifact is a rebuilt outer DCX. */
  sourceFormat?: 'emevd' | 'dcx';
  /** Outer container hash of the staged artifact (dcx only). */
  outerFileHash?: string;
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
  /** 同 order 内的稳定次序（事件内下标升/降序）。 */
  tiebreak?: number;
}

/**
 * Convert an EmevdMutationPlan into an ordered array of Bridge-native mutations.
 *
 * Ordering guarantees（C# writer 顺序应用，全局指令下标会随结构变化漂移）:
 * 0. set_instruction_args — 全局下标，必须在任何结构改动之前（按原始文档计算）
 * 1. delete_instruction — 事件内下标，同一事件内按下标降序
 * 2. insert_event（add_event 空事件，供后续 insert 引用）
 * 3. insert_instruction — 事件内下标（删除已应用后的列表），同一事件内升序
 * 4. delete_event — 放在指令级改动之后（其指令已随事件一起消失）
 * 5. set_rest_behavior
 * 6. update_id — 最后（改的是其他 mutation 引用的 eventId）
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

  const deleteInstructionMutations: BridgeMutationWithOrder[] = [];
  const insertEventIds = new Set<number>();
  const insertEventMutations: BridgeMutationWithOrder[] = [];
  const insertInstructionMutations: BridgeMutationWithOrder[] = [];
  const deleteEventMutations: BridgeMutationWithOrder[] = [];
  const restBehaviorMutations: BridgeMutationWithOrder[] = [];
  const setEventParametersMutations: BridgeMutationWithOrder[] = [];
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
        order: 5
      });
    } else if (operation.kind === 'set_event_parameters') {
      let eventId: number;
      if (operation.eventAnchor === '' && insertEventIds.has(operation.eventId)) {
        eventId = operation.eventId;
      } else {
        const event = eventByAnchor.get(operation.eventAnchor);
        if (!event) {
          return {
            ok: false,
            code: 'EMEVD_PLAN_ANCHOR_NOT_FOUND',
            message: `事件锚 ${operation.eventAnchor} 在文档中未找到。`
          };
        }
        eventId = event.eventId;
      }
      setEventParametersMutations.push({
        mutation: {
          kind: 'set_event_parameters',
          eventId,
          parameters: operation.parameters
        },
        order: 5.5
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
        order: 6
      });
    } else if (operation.kind === 'delete_instruction') {
      const event = eventByAnchor.get(operation.eventAnchor);
      if (!event) {
        return {
          ok: false,
          code: 'EMEVD_PLAN_ANCHOR_NOT_FOUND',
          message: `事件锚 ${operation.eventAnchor} 在文档中未找到。`
        };
      }
      deleteInstructionMutations.push({
        mutation: {
          kind: 'delete_instruction',
          eventId: operation.eventId,
          instructionIndex: operation.index
        },
        order: 1,
        // 同一事件内按下标降序，前面的删除不会移动后面的下标。
        tiebreak: operation.eventId * 1_000_000 - operation.index
      });
    } else if (operation.kind === 'insert_event') {
      if (eventIdExists(document, operation.eventId) || insertEventIds.has(operation.eventId)) {
        return {
          ok: false,
          code: 'EMEVD_PLAN_EVENT_ID_DUPLICATE',
          message: `新增事件 ID ${operation.eventId} 已存在。`
        };
      }
      insertEventIds.add(operation.eventId);
      insertEventMutations.push({
        mutation: {
          kind: 'add_event',
          newEventId: operation.eventId,
          restBehavior: operation.restBehavior
        },
        order: 2
      });
    } else if (operation.kind === 'insert_instruction') {
      if (operation.eventAnchor !== '' && !eventByAnchor.has(operation.eventAnchor)) {
        return {
          ok: false,
          code: 'EMEVD_PLAN_ANCHOR_NOT_FOUND',
          message: `事件锚 ${operation.eventAnchor} 在文档中未找到。`
        };
      }
      if (operation.eventAnchor === '' && !insertEventIds.has(operation.eventId)) {
        return {
          ok: false,
          code: 'EMEVD_PLAN_EVENT_NOT_PLANNED',
          message: `insert_instruction 引用的事件 ${operation.eventId} 不在计划的新增事件里。`
        };
      }
      insertInstructionMutations.push({
        mutation: {
          kind: 'insert_instruction',
          eventId: operation.eventId,
          instructionIndex: operation.index,
          bank: operation.bank,
          id: operation.id,
          argsBase64: operation.argsBase64
        },
        order: 3,
        // 同一事件内按下标升序，依序插入。
        tiebreak: operation.eventId * 1_000_000 + operation.index
      });
    } else if (operation.kind === 'delete_event') {
      const event = eventByAnchor.get(operation.eventAnchor);
      if (!event) {
        return {
          ok: false,
          code: 'EMEVD_PLAN_ANCHOR_NOT_FOUND',
          message: `事件锚 ${operation.eventAnchor} 在文档中未找到。`
        };
      }
      deleteEventMutations.push({
        mutation: { kind: 'delete_event', eventId: operation.eventId },
        order: 4
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

  const all = [
    ...instructionMutations,
    ...deleteInstructionMutations,
    ...insertEventMutations,
    ...insertInstructionMutations,
    ...deleteEventMutations,
    ...restBehaviorMutations,
    ...setEventParametersMutations,
    ...eventIdMutations
  ]
    .sort((a, b) => a.order - b.order || (a.tiebreak ?? 0) - (b.tiebreak ?? 0))
    .map((item) => item.mutation);

  return { ok: true, mutations: all };
}

function eventIdExists(document: EmevdEditorDocument, eventId: number): boolean {
  return document.events.some((event) => event.eventId === eventId);
}

export interface EmevdPlanStageResult {
  ok: boolean;
  bytes?: Buffer;
  result?: EmevdBridgeCommitResult;
  /** "emevd" for raw payload output; "dcx" when the staged artifact is a rebuilt outer DCX. */
  sourceFormat?: 'emevd' | 'dcx';
  /** Outer container hash of the staged artifact (dcx only); the file_replace sealed expectation. */
  outerFileHash?: string;
  /** Rebuilt payload hash (dcx only). */
  payloadHash?: string;
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
      ...(request.oodleRuntimeRoot !== undefined ? { oodleRuntimeRoot: request.oodleRuntimeRoot } : {}),
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
    ...(staged.result.sourceFormat === 'dcx' || staged.result.sourceFormat === 'emevd'
      ? { sourceFormat: staged.result.sourceFormat }
      : {}),
    ...(staged.result.outerFileHash ? { outerFileHash: staged.result.outerFileHash } : {}),
    ...(staged.result.payloadHash ? { payloadHash: staged.result.payloadHash } : {}),
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

export interface EmevdReopenValidatorInput {
  allowedRoots: string[];
  /** Native Oodle root required when reopening a KRAK-wrapped DCX. */
  oodleRuntimeRoot?: string;
  timeoutMs?: number;
}

/**
 * After-commit Bridge reopen validator for EMEVD file_replace commits
 * (EVENT-30C). Reopens the committed resource natively and fails — which makes
 * the WorkspaceTransaction roll the file back to its before-image — when the
 * committed bytes cannot be re-parsed, the semantic roundtrip is not identical,
 * or the committed file bytes diverge from the staged artifact. This is the
 * "Bridge reopen → event/instruction semantic verify → rollback" boundary of
 * the outer-chain write flow.
 */
export function createEmevdReopenValidator(
  input: EmevdReopenValidatorInput
): ValidatorContract {
  return {
    validatorId: 'emevd_reopen_verify',
    targetResourceKinds: ['event'],
    validationScope: ['after_commit'],
    async validateAfterCommit(commit): Promise<ValidatorResult> {
      const diagnostics: StructuredDiagnostic[] = [];
      for (const committedPath of commit.committedPaths) {
        const op = commit.operations.find((operation) => operation.targetPath === committedPath);
        const envelope = await runBridge<EmevdReadEnvelope>({
          command: 'read-emevd-document',
          filePath: committedPath,
          allowedRoots: input.allowedRoots,
          ...(input.oodleRuntimeRoot !== undefined ? { oodleRuntimeRoot: input.oodleRuntimeRoot } : {}),
          timeoutMs: input.timeoutMs ?? 120_000
        });
        if (envelope.parseStatus === 'failed') {
          diagnostics.push({
            severity: 'error',
            code: 'EMEVD_REOPEN_FAILED',
            message: '提交后 Bridge 无法重开已提交的 EMEVD 资源。',
            ...(op?.targetUri !== undefined ? { targetUri: op.targetUri } : {}),
            details: { targetPath: committedPath, bridgeDiagnostics: envelope.diagnostics }
          });
          continue;
        }
        if (envelope.data?.roundTrip?.semanticIdentical !== true) {
          diagnostics.push({
            severity: 'error',
            code: 'EMEVD_REOPEN_SEMANTIC_FAILED',
            message: '提交后重开语义往返不一致。',
            ...(op?.targetUri !== undefined ? { targetUri: op.targetUri } : {}),
            details: { targetPath: committedPath }
          });
        }
        if (op?.kind === 'file_replace' && op.newContentBase64) {
          let committedBytes: Buffer;
          try {
            committedBytes = await readFile(committedPath);
          } catch (error) {
            diagnostics.push({
              severity: 'error',
              code: 'EMEVD_REOPEN_READ_FAILED',
              message: error instanceof Error ? error.message : '提交后无法读取文件。',
              targetUri: op.targetUri,
              details: { targetPath: committedPath }
            });
            continue;
          }
          const expected = createHash('sha256')
            .update(Buffer.from(op.newContentBase64, 'base64'))
            .digest('hex');
          const actual = createHash('sha256').update(committedBytes).digest('hex');
          if (actual !== expected) {
            diagnostics.push({
              severity: 'error',
              code: 'EMEVD_REOPEN_BYTE_MISMATCH',
              message: '提交后文件字节与暂存产物不一致。',
              targetUri: op.targetUri,
              details: { targetPath: committedPath, expected, actual }
            });
          }
        }
      }
      return {
        ok: diagnostics.length === 0,
        diagnostics,
        scope: 'after_commit',
        validatorId: 'emevd_reopen_verify'
      };
    }
  };
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
    // 修改目标始终是 outer source resource：磁盘上是 .dcx 时，file_replace 的
    // content_hash 前置必须按 outer 文件字节（outerFileHash）比对，而不是 payload 哈希。
    expectedHash: request.expectedOuterFileHash ?? request.expectedDocumentHash
  });

  const committed = await executePatchIrThroughTransaction(patch, {
    workspaceRoot: request.workspaceRoot,
    ...(request.session !== undefined ? { session: request.session } : {}),
    ...(request.operationLog !== undefined ? { operationLog: request.operationLog } : {}),
    ...(request.backupBaseDir !== undefined ? { backupBaseDir: request.backupBaseDir } : {}),
    ...(request.recoveryDir !== undefined ? { recoveryDir: request.recoveryDir } : {}),
    // Bridge reopen 验证挂在事务的 after_commit 上：重开失败即自动回滚到 before-image。
    appendValidators: [createEmevdReopenValidator({
      allowedRoots: request.allowedRoots,
      ...(request.oodleRuntimeRoot !== undefined ? { oodleRuntimeRoot: request.oodleRuntimeRoot } : {}),
      ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {})
    })]
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
  // DCX 场景下 Bridge 重开报告的是 payload sourceHash + outerFileHash；字节一致
  // 必须按 outer 容器哈希比对（与 C# writer 的 outputHash 口径一致）。
  const reRead = await runBridge<EmevdReadEnvelope>({
    command: 'read-emevd-document',
    filePath: request.sourcePath,
    allowedRoots: request.allowedRoots,
    ...(request.oodleRuntimeRoot !== undefined ? { oodleRuntimeRoot: request.oodleRuntimeRoot } : {}),
    timeoutMs: request.timeoutMs ?? 120_000
  });
  const sourceFormat = staged.result.sourceFormat ?? 'emevd';
  const reReadSourceHash = reRead.data?.sourceHash ?? '';
  const reReadOuterHash = reRead.data?.outerFileHash ?? '';
  const expectedOutputHash = (staged.result.outputHash ?? '').toLowerCase();
  const actualOutputHash = (sourceFormat === 'dcx' ? reReadOuterHash : reReadSourceHash).toLowerCase();
  const byteConsistent = reRead.parseStatus !== 'failed'
    && actualOutputHash === expectedOutputHash
    && (sourceFormat !== 'dcx'
      || !reReadSourceHash
      || reReadSourceHash.toLowerCase() === (staged.result.payloadHash ?? '').toLowerCase());
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
            : `提交后重读不一致：字节或语义往返未通过（期望 ${staged.result.outputHash}，实际 ${reReadOuterHash || reReadSourceHash}）。`
        }])
  ];

  return {
    ok: reReadOk,
    ...(staged.result.outputHash ? { outputHash: staged.result.outputHash } : {}),
    ...(staged.result.sourceFormat === 'dcx' ? { sourceFormat: staged.result.sourceFormat } : {}),
    ...(staged.result.outerFileHash ? { outerFileHash: staged.result.outerFileHash } : {}),
    ...(staged.result.eventCount !== undefined ? { eventCount: staged.result.eventCount } : {}),
    ...(staged.result.instructionCount !== undefined
      ? { instructionCount: staged.result.instructionCount }
      : {}),
    mutationCount: staged.mutationCount,
    opId: committed.opId,
    ...(committed.changedFiles[0] !== undefined ? { committedPath: committed.changedFiles[0] } : {}),
    reRead: {
      ok: reReadOk,
      outputHash: sourceFormat === 'dcx' ? reReadOuterHash : reReadSourceHash,
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
  /** "emevd" for raw payload; "dcx" when Bridge unwrapped a .dcx wrapper. */
  sourceFormat?: string;
  /** SHA-256 of the outer container bytes when opened from a .dcx. */
  outerFileHash?: string;
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
