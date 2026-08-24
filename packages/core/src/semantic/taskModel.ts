import { createHash } from 'node:crypto';
import { createCompletionContract } from './completion.js';
import type {
  CanonicalEntityKind,
  SubgoalState,
  TaskKind,
  TaskModel,
  TaskTargetDescription
} from './types.js';

const EXACT_ADDRESS_PATTERNS: ReadonlyArray<{ pattern: RegExp; kind: CanonicalEntityKind }> = [
  { pattern: /\bc\d{4}(?:[/#]|\s*)a\d{4}(?:\.e\d+)?\b/i, kind: 'action' },
  { pattern: /\bm\d{2}(?:[_-]\d{2}){2,3}(?:#[\w.-]+)?\b/i, kind: 'map_entity' },
  { pattern: /\b(?:event|事件)\s*[:#]?\s*\d{3,}\b/i, kind: 'event' },
  { pattern: /\b(?:textid|文本|fmg)\s*[:#]?\s*\d{2,}\b/i, kind: 'text_entry' },
  { pattern: /\b(?:param|参数)\s*[/:#]?\s*[\w.-]+(?:\s+row\s*[:#]?\s*\d+)?\b/i, kind: 'param_row' }
];

export function createTaskModel(originalGoal: string): TaskModel {
  const goal = originalGoal.trim();
  const explicitCreate = /(?:创建|新建|新增)|\b(?:create|new)\b/i.test(goal);
  const kind: TaskKind = explicitCreate
    ? 'create'
    : /(?:修改|写入|替换|删除|移动|设置|更新)|\b(?:edit|write|change|delete|move|set|update)\b/i.test(goal)
      ? 'modify'
      : /(?:诊断|排查|错误|失败|为什么|diagnos|debug|fail|error)/i.test(goal)
        ? 'diagnose'
        : 'inspect';

  const targets: TaskTargetDescription[] = [];
  for (const entry of EXACT_ADDRESS_PATTERNS) {
    const match = goal.match(entry.pattern);
    if (!match) continue;
    const text = match[0];
    if (!targets.some((target) => target.text.toLowerCase() === text.toLowerCase())) {
      targets.push({ text, kind: entry.kind, address: text, exact: true });
    }
  }

  const desiredChanges = kind === 'modify' || kind === 'create' ? [goal] : [];
  const postconditions = kind === 'inspect' || kind === 'diagnose'
    ? ['返回带来源、修订号与覆盖率的事实']
    : ['写入后重新读取并验证目标与后置条件', '提交后刷新索引、引用图与 RAG'];
  const constraints = [
    '不得根据模型猜测生成原生 ID',
    '覆盖不完整时不得把零命中解释为不存在',
    '写入必须经过领域事务、Workspace Atomic Transaction 与 Patch Engine'
  ];
  const taskId = `task:${createHash('sha256').update(goal).digest('hex').slice(0, 24)}`;
  const subgoalGoal = targets.length > 0
    ? `解析 canonical target：${targets.map((target) => target.text).join('、')}`
    : '解析用户目标涉及的 canonical entity 与 authoritative evidence';
  const resolveCandidateTools = targets.some(isExactTarget)
    ? ['resolve_canonical_entities', 'read_param_fields', 'read_msb_parts', 'read_emevd_outline']
    : ['retrieve_evidence', 'search_text_entries', 'resolve_canonical_entities', 'search_param_rows', 'search_map_entities', 'search_events'];
  const unresolvedTargets = targets.length > 0 ? targets.map((target) => target.text) : [goal];
  const stageSpecs: Array<{
    suffix: string;
    goal: string;
    candidateTools: string[];
    unresolvedQuestions: string[];
  }> = [{
    suffix: 'resolve',
    goal: subgoalGoal,
    candidateTools: resolveCandidateTools,
    unresolvedQuestions: unresolvedTargets
  }];
  if (kind === 'modify' || kind === 'create') {
    stageSpecs.push(
      {
        suffix: 'plan',
        goal: '根据已解析 canonical facts 构造 Semantic ChangeSet 与全部后置条件',
        candidateTools: ['resolve_canonical_entities', 'propose_text_patch', 'build_patch_graph', 'commit_semantic_change_set'],
        unresolvedQuestions: ['所有请求变更是否都已映射到 canonical operation']
      },
      {
        suffix: 'validate',
        goal: '验证 ChangeSet、domain writer、依赖顺序与 staging 结果',
        candidateTools: ['validate_patch', 'validate_emevd_dsl', 'validate_writer_contract'],
        unresolvedQuestions: ['所有 writer/semantic validator 是否通过']
      },
      {
        suffix: 'commit',
        goal: '通过 Workspace Atomic Transaction 与 Patch Engine 完成一次原子提交',
        candidateTools: ['commit_semantic_change_set', 'commit_patch'],
        unresolvedQuestions: ['Patch Engine 是否已提交且没有 recoveryRequired']
      },
      {
        suffix: 'verify',
        goal: '提交后 authoritative reread、索引/reference graph/RAG 刷新并验证后置条件',
        candidateTools: ['read_param_fields', 'read_fmg_entries', 'read_emevd_outline', 'read_msb_parts', 'retrieve_evidence'],
        unresolvedQuestions: ['提交后的 canonical revision 与所有后置条件是否一致']
      }
    );
  } else {
    stageSpecs.push({
      suffix: 'verify',
      goal: kind === 'diagnose'
        ? '验证诊断事实的 provenance、coverage 与 epistemic state'
        : '验证读取事实的 sourceUri、revision、coverage 与完成后置条件',
      candidateTools: ['retrieve_evidence', 'resolve_canonical_entities'],
      unresolvedQuestions: ['是否已有足够的 authoritative evidence']
    });
  }
  const subgoals: SubgoalState[] = stageSpecs.map((spec, index) => {
    const subgoalId = `${taskId}:${spec.suffix}`;
    const next = stageSpecs[index + 1];
    return {
      subgoalId,
      goal: spec.goal,
      status: index === 0 ? 'active' : 'pending',
      queryPlan: {
        planId: `${subgoalId}:query-plan`,
        subgoalId,
        purpose: spec.goal,
        candidateTools: [...spec.candidateTools],
        attemptedQueries: [],
        results: [],
        unresolvedQuestions: [...spec.unresolvedQuestions]
      },
      evidenceIds: [],
      resolvedFactKeys: [],
      remainingUnknowns: [...spec.unresolvedQuestions],
      ...(next ? { nextSubgoalId: `${taskId}:${next.suffix}` } : {})
    };
  });

  return {
    taskId,
    originalGoal: goal,
    kind,
    targets,
    desiredChanges,
    postconditions,
    constraints,
    unresolvedEntities: targets.length === 0 ? [goal] : [],
    resolvedEntities: [],
    externalTaskGoal: goal,
    explicitCreate,
    ...(subgoals[0] ? { currentSubgoal: subgoals[0].goal } : {}),
    subgoals,
    completionContract: createCompletionContract({
      taskId,
      taskKind: kind,
      targetCount: targets.length
    })
  };
}

/** RAG 只能接收用户的外部目标或当前明确子目标，不接收重试/压缩提示。 */
export function resolveExternalTaskGoal(input: {
  externalTaskGoal?: string;
  currentSubgoal?: string;
  fallbackMessages?: readonly { role: string; content: string }[];
}): string {
  const candidate = input.currentSubgoal?.trim() || input.externalTaskGoal?.trim();
  if (candidate) return candidate;
  const firstUser = input.fallbackMessages?.find((message) => message.role === 'user')?.content.trim();
  return firstUser ?? '';
}

export function isExactTarget(target: TaskTargetDescription): boolean {
  return target.exact && typeof target.address === 'string' && target.address.length > 0;
}

export function normalizeTaskText(value: string): string {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ' ').trim();
}
