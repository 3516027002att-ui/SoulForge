import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  Diagnostic,
  PatchProposal
} from '@soulforge/shared';
import { compilePatchProposalToPatchIr } from '../patch/patchProposalAdapter.js';
import {
  executePatchIrThroughTransaction,
  type ExecutePatchIrOptions,
  type TransactionCommitCompatResult
} from '../patch/durablePatchCommit.js';
import type { SemanticChangeSet } from './types.js';
import { validateSemanticChangeSet } from './changeSet.js';
import type { WorkspaceSession } from '../workspace/workspaceSession.js';
import type { OperationLogStore } from '../patch/operationLog.js';
import type { WorkspaceTransaction } from '../transactions/workspaceTransaction.js';

/** One semantic operation group projected into a PatchProposal. */
export interface SemanticPatchProposalInput {
  proposal: PatchProposal;
  operationIds: readonly string[];
}

export interface ExecuteSemanticPatchProposalOptions {
  changeSet: SemanticChangeSet;
  proposals: readonly SemanticPatchProposalInput[];
  workspaceRoot: string;
  session?: WorkspaceSession;
  operationLog?: OperationLogStore;
  backupBaseDir?: string;
  recoveryDir?: string;
  actorId?: string;
  /** Runs before the operation log is marked committed; failure rolls back. */
  onCommitted?: (targetPaths: readonly string[]) => Promise<void>;
}

/**
 * Project a complete semantic ChangeSet into one durable Patch Engine commit.
 *
 * This boundary deliberately accepts only PatchProposal projections whose
 * targetUri is already a canonical target identity and whose beforeHash is the
 * current source revision. Domain writers still own the native serialization;
 * this function only coordinates their PatchIR outputs and never writes files
 * itself.
 */
export async function executeSemanticPatchProposalTransaction(
  options: ExecuteSemanticPatchProposalOptions
): Promise<TransactionCommitCompatResult> {
  const planning = await planSemanticPatchProposals(options);
  if (!planning.ok) {
    return {
      opId: options.proposals[0]?.proposal.opId ?? options.changeSet.changeSetId,
      backupRoot: '',
      changedFiles: [],
      diagnostics: planning.diagnostics
    };
  }

  let transaction: WorkspaceTransaction | undefined;
  const stagedHashes = new Map<string, string>();
  const semanticChecks: NonNullable<ExecutePatchIrOptions['semanticChecks']> = {
    beforeCommit: async (candidate) => {
      transaction = candidate;
      const diagnostics: Diagnostic[] = [];
      for (const target of candidate.getCommitTargets()) {
        try {
          const hash = await sha256File(target.stagingPath);
          stagedHashes.set(target.targetPath, hash);
          const expected = planning.afterHashes.get(target.targetPath);
          if (expected !== undefined && expected !== hash) {
            diagnostics.push({
              severity: 'error',
              code: 'SEMANTIC_STAGED_POSTCONDITION_FAILED',
              message: `语义事务 staging 输出与计划 afterHash 不一致：${target.op.targetUri}。`,
              details: { expectedAfterHash: expected, actualHash: hash }
            });
          }
        } catch (error) {
          diagnostics.push({
            severity: 'error',
            code: 'SEMANTIC_STAGED_REREAD_FAILED',
            message: error instanceof Error ? error.message : '语义事务 staging 重读失败。',
              details: { targetUri: target.op.targetUri }
          });
        }
      }
      for (const targetPath of planning.targetPaths) {
        if (!stagedHashes.has(targetPath)) {
          diagnostics.push({
            severity: 'error',
            code: 'SEMANTIC_STAGED_TARGET_MISSING',
            message: '语义事务未找到目标文件的 staging 输出。',
            details: { targetPath }
          });
        }
      }
      return diagnostics;
    },
    afterCommit: async () => {
      const diagnostics: Diagnostic[] = [];
      const candidate = transaction;
      if (!candidate) {
        return [{
          severity: 'error',
          code: 'SEMANTIC_TRANSACTION_CONTEXT_MISSING',
          message: '语义事务缺少同一 WorkspaceTransaction 上下文。'
        }];
      }
      const committedPaths: string[] = [];
      for (const target of candidate.getCommitTargets()) {
        committedPaths.push(target.targetPath);
        try {
          const actualHash = await sha256File(target.targetPath);
          const stagedHash = stagedHashes.get(target.targetPath);
          if (!stagedHash || stagedHash !== actualHash) {
            diagnostics.push({
              severity: 'error',
              code: 'SEMANTIC_COMMITTED_REREAD_FAILED',
              message: `语义事务提交后重读与 staging 不一致：${target.op.targetUri}。`,
              details: { expectedAfterHash: stagedHash, actualHash }
            });
          }
        } catch (error) {
          diagnostics.push({
            severity: 'error',
            code: 'SEMANTIC_COMMITTED_REREAD_FAILED',
            message: error instanceof Error ? error.message : '语义事务提交后重读失败。',
            details: { targetUri: target.op.targetUri }
          });
        }
      }
      if (diagnostics.some((item) => item.severity === 'error')) return diagnostics;
      try {
        await options.onCommitted?.([...new Set(committedPaths)]);
      } catch (error) {
        diagnostics.push({
          severity: 'error',
          code: 'SEMANTIC_KNOWLEDGE_FINALIZE_FAILED',
          message: error instanceof Error ? error.message : '提交后的 canonical/index/RAG 刷新失败。'
        });
      }
      return diagnostics;
    }
  };

  const [primary, ...additional] = planning.compiled;
  if (!primary) {
    return {
      opId: options.proposals[0]?.proposal.opId ?? options.changeSet.changeSetId,
      backupRoot: '',
      changedFiles: [],
      diagnostics: [{
        severity: 'error',
        code: 'SEMANTIC_PATCH_COMPILE_EMPTY',
        message: 'SemanticChangeSet 没有可提交的 PatchIR。'
      }]
    };
  }
  return executePatchIrThroughTransaction(primary.patch, {
    workspaceRoot: options.workspaceRoot,
    ...(options.session ? { session: options.session } : {}),
    ...(options.operationLog ? { operationLog: options.operationLog } : {}),
    ...(options.backupBaseDir !== undefined ? { backupBaseDir: options.backupBaseDir } : {}),
    ...(options.recoveryDir !== undefined ? { recoveryDir: options.recoveryDir } : {}),
    ...(options.actorId !== undefined ? { actorId: options.actorId } : {}),
    author: primary.patch.author === 'ai' ? 'ai' : 'user',
    mode: primary.proposal.mode,
    additionalPatches: additional.map((item) => item.patch),
    semanticChecks
  });
}

interface CompiledSemanticPatch {
  proposal: PatchProposal;
  operationIds: readonly string[];
  patch: NonNullable<ReturnType<typeof compilePatchProposalToPatchIr>['patch']>;
}

interface SemanticPlanningResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  compiled: CompiledSemanticPatch[];
  targetPaths: string[];
  afterHashes: Map<string, string>;
}

async function planSemanticPatchProposals(
  options: ExecuteSemanticPatchProposalOptions
): Promise<SemanticPlanningResult> {
  const diagnostics: Diagnostic[] = [];
  const compiled: CompiledSemanticPatch[] = [];
  const targetPaths = new Map<string, string>();
  const afterHashes = new Map<string, string>();
  const operationIds = new Set(options.changeSet.operations.map((operation) => operation.operationId));
  const mappedOperationIds = new Set<string>();
  const currentRevisions = new Map<string, string>();
  const proposalIds = new Set<string>();

  if (options.proposals.length === 0) {
    diagnostics.push(error('SEMANTIC_CHANGESET_NO_PROPOSALS', 'SemanticChangeSet 没有对应的 PatchProposal。'));
  }
  if (options.changeSet.postconditions.length === 0) {
    diagnostics.push(error('SEMANTIC_POSTCONDITION_REQUIRED', 'SemanticChangeSet 必须声明可验证的 postcondition。'));
  }
  for (const postcondition of options.changeSet.postconditions) {
    if (postcondition !== 'committed_bytes_match_staged') {
      diagnostics.push({
        ...error('SEMANTIC_POSTCONDITION_UNSUPPORTED', '当前生产边界只验证 committed_bytes_match_staged。'),
        details: { postcondition }
      });
    }
  }

  for (const item of options.proposals) {
    if (proposalIds.has(item.proposal.opId)) {
      diagnostics.push(error('SEMANTIC_PROPOSAL_DUPLICATE', `PatchProposal 重复：${item.proposal.opId}。`));
    }
    proposalIds.add(item.proposal.opId);
    const localTargets = new Set(item.proposal.changes.map((change) => change.targetUri));
    for (const operationId of item.operationIds) {
      if (!operationIds.has(operationId)) {
        diagnostics.push(error('SEMANTIC_OPERATION_MAPPING_UNKNOWN', `PatchProposal 映射了未知语义操作：${operationId}。`));
        continue;
      }
      if (mappedOperationIds.has(operationId)) {
        diagnostics.push(error('SEMANTIC_OPERATION_MAPPING_DUPLICATE', `语义操作被多个 proposal 映射：${operationId}。`));
      }
      mappedOperationIds.add(operationId);
      const operation = options.changeSet.operations.find((candidate) => candidate.operationId === operationId);
      if (operation && !localTargets.has(operation.targetIdentity)) {
        diagnostics.push(error(
          'SEMANTIC_OPERATION_TARGET_MISMATCH',
          `语义操作 ${operationId} 的 canonical target 没有对应 PatchChange。`
        ));
      }
    }

    const compiledResult = compilePatchProposalToPatchIr(item.proposal);
    diagnostics.push(...compiledResult.legacyDiagnostics);
    if (!compiledResult.ok || !compiledResult.patch) continue;
    compiled.push({ proposal: item.proposal, operationIds: item.operationIds, patch: compiledResult.patch });

    for (const change of item.proposal.changes) {
      if (!options.changeSet.targetIdentities.includes(change.targetUri)) {
        diagnostics.push(error(
          'SEMANTIC_TARGET_NOT_CANONICAL',
          `PatchChange targetUri 未出现在 SemanticChangeSet canonical targets：${change.targetUri}。`
        ));
        continue;
      }
      if (!change.targetPath || !change.beforeHash) {
        diagnostics.push(error(
          'SEMANTIC_BASE_HASH_REQUIRED',
          `语义事务要求每个目标提供 targetPath 和 beforeHash：${change.targetUri}。`
        ));
        continue;
      }
      const existingPath = targetPaths.get(change.targetUri);
      if (existingPath !== undefined && existingPath !== change.targetPath) {
        diagnostics.push(error(
          'SEMANTIC_TARGET_PATH_CONFLICT',
          `同一 canonical target 映射到多个文件路径：${change.targetUri}。`
        ));
        continue;
      }
      targetPaths.set(change.targetUri, change.targetPath);
      if (change.afterHash) afterHashes.set(change.targetPath, change.afterHash);
      try {
        const currentHash = await sha256File(change.targetPath);
        currentRevisions.set(change.targetUri, currentHash);
        if (currentHash !== change.beforeHash) {
          diagnostics.push({
            ...error('SEMANTIC_BASE_REVISION_CONFLICT', `语义事务目标已变化：${change.targetUri}。`),
            details: { expectedBeforeHash: change.beforeHash, actualHash: currentHash }
          });
        }
      } catch (errorValue) {
        diagnostics.push({
          ...error('SEMANTIC_TARGET_READ_FAILED', `无法读取语义事务目标：${change.targetUri}。`),
          details: { reason: errorValue instanceof Error ? errorValue.message : 'read failed' }
        });
      }
    }
  }

  for (const operation of options.changeSet.operations) {
    if (!mappedOperationIds.has(operation.operationId)) {
      diagnostics.push(error('SEMANTIC_OPERATION_MAPPING_MISSING', `语义操作没有 PatchProposal：${operation.operationId}。`));
    }
  }
  for (const target of options.changeSet.targetIdentities) {
    if (!targetPaths.has(target)) {
      diagnostics.push(error('SEMANTIC_TARGET_MAPPING_MISSING', `canonical target 没有 PatchChange：${target}。`));
    }
  }
  const semanticValidation = validateSemanticChangeSet(options.changeSet, currentRevisions);
  diagnostics.push(...semanticValidation.diagnostics.map((message) => error('SEMANTIC_CHANGESET_INVALID', message)));

  return {
    ok: diagnostics.every((item) => item.severity !== 'error') && compiled.length > 0,
    diagnostics,
    compiled,
    targetPaths: [...targetPaths.values()],
    afterHashes
  };
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function error(code: string, message: string): Diagnostic {
  return { severity: 'error', code, message };
}
