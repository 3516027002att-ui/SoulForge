import type {
  CompletionContract,
  CompletionEvidence,
  CompletionEvaluation,
  CompletionPredicate,
  TaskKind
} from './types.js';

/** Stable key used by typed read tools to prove source-backed inspect facts. */
export const READ_FACTS_POSTCONDITION_KEY = 'read-facts';

/** Apply only structured tool evidence to a contract; never infer from text. */
export function applyCompletionEvidence(
  contract: CompletionContract,
  evidence: readonly CompletionEvidence[]
): CompletionContract {
  return evidence.reduce(
    (current, item) => markPredicate(
      current,
      item.kind,
      true,
      item.evidenceIds,
      item.diagnostic,
      item.key
    ),
    contract
  );
}

export function createCompletionContract(input: {
  taskId: string;
  taskKind: TaskKind;
  targetCount: number;
  operationKeys?: readonly string[];
  postconditionKeys?: readonly string[];
}): CompletionContract {
  const targetRequired = input.targetCount > 0 || input.taskKind === 'modify' || input.taskKind === 'create';
  const predicates: CompletionPredicate[] = [
    {
      kind: 'target_resolved',
      required: targetRequired,
      satisfied: false,
      evidenceIds: [],
      diagnostic: '尚未得到 canonical target 的权威解析结果。'
    }
  ];

  if (input.taskKind === 'modify' || input.taskKind === 'create') {
    const operationKeys = input.operationKeys?.length ? input.operationKeys : ['requested-mutations'];
    predicates.push(...operationKeys.map((key) => ({
      kind: 'mutations_planned' as const,
      key,
      required: true,
      satisfied: false,
      evidenceIds: [],
      diagnostic: `修改操作 ${key} 尚未完成计划。`
    })));
    predicates.push(
      requiredPredicate('staged', '尚未完成全部领域 staging。'),
      requiredPredicate('validators_passed', '尚未通过全部 writer/semantic validators。'),
      requiredPredicate('committed', '尚未完成 Patch Engine 原子提交。'),
      requiredPredicate('reread_verified', '尚未完成 committed native reread。')
    );
    const postconditionKeys = input.postconditionKeys?.length
      ? input.postconditionKeys
      : ['requested-postconditions'];
    predicates.push(...postconditionKeys.map((key) => ({
      kind: 'postconditions_verified' as const,
      key,
      required: true,
      satisfied: false,
      evidenceIds: [],
      diagnostic: `后置条件 ${key} 尚未得到 authoritative reread 证据。`
    })));
    predicates.push(
      requiredPredicate('index_refreshed', 'WorkspaceIndex 尚未刷新。'),
      requiredPredicate('rag_refreshed', 'RAG/reference/embedding freshness 尚未刷新。')
    );
  } else {
    predicates.push(requiredPredicate(
      'postconditions_verified',
      input.taskKind === 'diagnose'
        ? '诊断结论尚未完成带 provenance 的 epistemic 验证。'
        : '读取结果尚未完成来源与覆盖率验证。',
      input.taskKind === 'diagnose' ? 'diagnosis-verified' : READ_FACTS_POSTCONDITION_KEY
    ));
  }

  return { taskId: input.taskId, predicates };
}

export function evaluateCompletionContract(contract: CompletionContract): CompletionEvaluation {
  const missing = contract.predicates.filter((predicate) => predicate.required && !predicate.satisfied);
  if (missing.length === 0) return { status: 'succeeded', missing: [], diagnostics: [] };
  const blocked = missing.some((predicate) => predicate.diagnostic?.toLowerCase().includes('blocked'));
  return {
    status: blocked ? 'blocked' : 'incomplete',
    missing,
    diagnostics: missing.map((predicate) => predicate.diagnostic ?? `缺少完成证据：${predicate.kind}`)
  };
}

export function markPredicate(
  contract: CompletionContract,
  kind: CompletionPredicate['kind'],
  satisfied: boolean,
  evidenceIds: readonly string[],
  diagnostic?: string,
  key?: string
): CompletionContract {
  return {
    ...contract,
    predicates: contract.predicates.map((predicate) => predicate.kind === kind
      && (key === undefined ? predicate.key === undefined : predicate.key === key)
      ? {
        ...predicate,
        satisfied,
        evidenceIds: [...evidenceIds],
        ...(diagnostic ? { diagnostic } : {})
      }
      : predicate)
  };
}

function requiredPredicate(
  kind: CompletionPredicate['kind'],
  diagnostic: string,
  key?: string
): CompletionPredicate {
  return { kind, required: true, satisfied: false, evidenceIds: [], diagnostic, ...(key ? { key } : {}) };
}
