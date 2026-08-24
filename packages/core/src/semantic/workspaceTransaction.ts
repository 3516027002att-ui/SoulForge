import type { PatchIR, StructuredDiagnostic } from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';
import type { WorkspaceTransaction } from '../transactions/workspaceTransaction.js';
import { validateSemanticChangeSet } from './changeSet.js';
import type { SemanticChangeOperation, SemanticChangeSet } from './types.js';

/**
 * 一个域在 Workspace Atomic Transaction 中的声明。
 *
 * 域 writer 仍然只负责生成自己的 PatchIR；它不能自行 commit。协调器把
 * 所有 PatchIR 加到同一个 WorkspaceTransaction，保证跨域计划在 staging、
 * 校验和 Patch Engine commit 之前都不会留下单域副作用。
 */
export interface SemanticWorkspaceDomainPlan {
  domain: SemanticChangeOperation['domain'];
  operationIds: readonly string[];
  patch: PatchIR;
  /** native writer 写入 staging 后的域级重读与结构校验。 */
  rereadStaged?: () => Promise<SemanticWorkspaceVerification>;
  /** commit 后的 native reread；必须读取已提交文件而不是内存 working copy。 */
  rereadCommitted?: () => Promise<SemanticWorkspaceVerification>;
  /** 对该域的 Semantic ChangeSet postconditions 做最终判断。 */
  verifyPostconditions?: () => Promise<SemanticWorkspaceVerification>;
}

export interface SemanticWorkspaceVerification {
  ok: boolean;
  diagnostics?: readonly StructuredDiagnostic[];
}

export interface ExecuteSemanticWorkspaceTransactionOptions {
  changeSet: SemanticChangeSet;
  currentRevisions?: ReadonlyMap<string, string>;
  transaction: WorkspaceTransaction;
  domains: readonly SemanticWorkspaceDomainPlan[];
  /** 在所有 committed reread/postcondition 通过后，原子刷新 canonical/index/reference/RAG 状态。 */
  finalizeKnowledge?: () => Promise<SemanticWorkspaceVerification>;
  /** finalizeKnowledge 或后续验证失败时，使知识投影丢弃未完成的 working state。 */
  rollbackKnowledge?: () => Promise<SemanticWorkspaceVerification>;
}

export type SemanticWorkspaceTransactionPhase =
  | 'planning'
  | 'staging'
  | 'staged_validation'
  | 'staged_reread'
  | 'committing'
  | 'committed_reread'
  | 'postconditions'
  | 'knowledge_finalize'
  | 'rolled_back'
  | 'committed';

export interface SemanticWorkspaceTransactionResult {
  ok: boolean;
  transactionId: string;
  phase: SemanticWorkspaceTransactionPhase;
  diagnostics: StructuredDiagnostic[];
  committed: boolean;
  recoveryRequired?: boolean;
}

/**
 * Execute one cross-domain semantic plan through one WorkspaceTransaction.
 *
 * This is orchestration, not a second Patch Engine: staging, backup, atomic
 * replacement and byte rollback remain owned by WorkspaceTransaction. A domain
 * callback can only validate a boundary; it cannot commit independently.
 */
export async function executeSemanticWorkspaceTransaction(
  options: ExecuteSemanticWorkspaceTransactionOptions
): Promise<SemanticWorkspaceTransactionResult> {
  const diagnostics: StructuredDiagnostic[] = [];
  const transactionId = options.transaction.transactionId;
  const planValidation = validatePlan(options.changeSet, options.domains);
  diagnostics.push(...planValidation.diagnostics);
  if (!planValidation.ok) {
    return result(transactionId, 'planning', diagnostics, false);
  }

  const semanticValidation = validateSemanticChangeSet(options.changeSet, options.currentRevisions);
  diagnostics.push(...semanticValidation.diagnostics.map((message) => diagnostic(
    'SEMANTIC_CHANGESET_INVALID',
    message
  )));
  if (!semanticValidation.ok) {
    return result(transactionId, 'planning', diagnostics, false);
  }

  for (const domain of options.domains) {
    const added = options.transaction.addPatch(domain.patch);
    diagnostics.push(...added.diagnostics);
    if (!added.ok) {
      return result(transactionId, 'planning', diagnostics, false);
    }
  }

  const staged = await options.transaction.stage();
  diagnostics.push(...staged.diagnostics);
  if (!staged.ok) {
    return result(transactionId, 'staging', diagnostics, false);
  }

  const validated = await options.transaction.validate();
  diagnostics.push(...validated.diagnostics);
  if (!validated.ok) {
    return result(transactionId, 'staged_validation', diagnostics, false);
  }

  const stagedReread = await runDomainChecks(options.domains, (domain) => domain.rereadStaged);
  diagnostics.push(...stagedReread.diagnostics);
  if (!stagedReread.ok) {
    diagnostics.push(...await options.transaction.discardStaging());
    return result(transactionId, 'staged_reread', diagnostics, false);
  }

  const committed = await options.transaction.commit();
  diagnostics.push(...committed.diagnostics);
  if (!committed.ok) {
    return {
      ...result(transactionId, 'committing', diagnostics, false),
      ...(committed.recoveryRequired ? { recoveryRequired: true } : {})
    };
  }

  const committedReread = await runDomainChecks(options.domains, (domain) => domain.rereadCommitted);
  diagnostics.push(...committedReread.diagnostics);
  if (!committedReread.ok) {
    return await rollbackAfterCommit(options, diagnostics, 'committed_reread');
  }

  const postconditions = await runDomainChecks(options.domains, (domain) => domain.verifyPostconditions);
  diagnostics.push(...postconditions.diagnostics);
  if (!postconditions.ok) {
    return await rollbackAfterCommit(options, diagnostics, 'postconditions');
  }

  if (options.finalizeKnowledge) {
    const finalized = await invokeCheck(options.finalizeKnowledge, 'WORKSPACE_KNOWLEDGE_FINALIZE_FAILED');
    diagnostics.push(...finalized.diagnostics);
    if (!finalized.ok) {
      return await rollbackAfterCommit(options, diagnostics, 'knowledge_finalize');
    }
  }

  return result(transactionId, 'committed', diagnostics, true);
}

async function rollbackAfterCommit(
  options: ExecuteSemanticWorkspaceTransactionOptions,
  diagnostics: StructuredDiagnostic[],
  phase: 'committed_reread' | 'postconditions' | 'knowledge_finalize'
): Promise<SemanticWorkspaceTransactionResult> {
  const rolledBackKnowledge = options.rollbackKnowledge
    ? await invokeCheck(options.rollbackKnowledge, 'WORKSPACE_KNOWLEDGE_ROLLBACK_FAILED')
    : { ok: true, diagnostics: [] as StructuredDiagnostic[] };
  diagnostics.push(...rolledBackKnowledge.diagnostics);

  const rolledBack = await options.transaction.rollback();
  diagnostics.push(...rolledBack.diagnostics);
  const ok = rolledBack.ok && rolledBackKnowledge.ok;
  if (!ok) {
    diagnostics.push(diagnostic(
      'WORKSPACE_TRANSACTION_RECOVERY_REQUIRED',
      '跨域提交后的验证或知识刷新失败，自动回滚未完整成功，必须进入恢复流程。'
    ));
  }
  return {
    ...result(options.transaction.transactionId, ok ? 'rolled_back' : phase, diagnostics, false),
    ...(ok ? {} : { recoveryRequired: true })
  };
}

function validatePlan(
  changeSet: SemanticChangeSet,
  domains: readonly SemanticWorkspaceDomainPlan[]
): { ok: boolean; diagnostics: StructuredDiagnostic[] } {
  const diagnostics: StructuredDiagnostic[] = [];
  const operationIds = new Set(changeSet.operations.map((operation) => operation.operationId));
  const mapped = new Map<string, number>();
  for (const domain of domains) {
    for (const operationId of domain.operationIds) {
      if (!operationIds.has(operationId)) {
        diagnostics.push(diagnostic(
          'WORKSPACE_OPERATION_MAPPING_UNKNOWN',
          `域 ${domain.domain} 映射了不存在的语义操作 ${operationId}。`
        ));
        continue;
      }
      mapped.set(operationId, (mapped.get(operationId) ?? 0) + 1);
      const operation = changeSet.operations.find((candidate) => candidate.operationId === operationId);
      if (operation?.domain !== domain.domain) {
        diagnostics.push(diagnostic(
          'WORKSPACE_OPERATION_DOMAIN_MISMATCH',
          `语义操作 ${operationId} 的域与 Patch 计划不一致。`
        ));
      }
    }
  }
  for (const operation of changeSet.operations) {
    const count = mapped.get(operation.operationId) ?? 0;
    if (count !== 1) {
      diagnostics.push(diagnostic(
        'WORKSPACE_OPERATION_MAPPING_INCOMPLETE',
        `语义操作 ${operation.operationId} 必须恰好映射到一个域计划，实际为 ${count}。`
      ));
    }
  }
  if (domains.length === 0) diagnostics.push(diagnostic('WORKSPACE_DOMAIN_PLAN_EMPTY', '跨域事务没有域计划。'));
  return { ok: diagnostics.length === 0, diagnostics };
}

async function runDomainChecks(
  domains: readonly SemanticWorkspaceDomainPlan[],
  select: (domain: SemanticWorkspaceDomainPlan) => (() => Promise<SemanticWorkspaceVerification>) | undefined
): Promise<{ ok: boolean; diagnostics: StructuredDiagnostic[] }> {
  const diagnostics: StructuredDiagnostic[] = [];
  for (const domain of domains) {
    const check = select(domain);
    if (!check) continue;
    const outcome = await invokeCheck(check, `WORKSPACE_${domain.domain.toUpperCase()}_VERIFY_FAILED`);
    diagnostics.push(...outcome.diagnostics);
    if (!outcome.ok) {
      return { ok: false, diagnostics };
    }
  }
  return { ok: true, diagnostics };
}

async function invokeCheck(
  check: () => Promise<SemanticWorkspaceVerification>,
  failureCode: string
): Promise<{ ok: boolean; diagnostics: StructuredDiagnostic[] }> {
  try {
    const outcome = await check();
    const diagnostics = [...(outcome.diagnostics ?? [])];
    if (!outcome.ok && diagnostics.length === 0) {
      diagnostics.push(diagnostic(failureCode, '语义事务边界校验未通过。'));
    }
    return { ok: outcome.ok, diagnostics };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [diagnostic(failureCode, '语义事务边界校验抛出异常。', {
        errorName: error instanceof Error ? error.name : typeof error
      })]
    };
  }
}

function result(
  transactionId: string,
  phase: SemanticWorkspaceTransactionPhase,
  diagnostics: StructuredDiagnostic[],
  committed: boolean
): SemanticWorkspaceTransactionResult {
  return { ok: committed, transactionId, phase, diagnostics, committed };
}

function diagnostic(code: string, message: string, details?: Record<string, unknown>): StructuredDiagnostic {
  return createDiagnostic({
    severity: 'error',
    code,
    message,
    ...(details ? { details } : {})
  });
}
