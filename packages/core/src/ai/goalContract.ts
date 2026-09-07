export type GoalKind = 'read' | 'diagnose' | 'modify' | 'revert';
export type GoalState = 'unresolved' | 'candidate' | 'resolved' | 'planned' | 'staged' | 'committed' | 'verified'
  | 'blocked' | 'cancelled' | 'recovery_required' | 'already_satisfied';

export interface GoalContract {
  goalId: string;
  requestRef: string;
  kind: GoalKind;
  targetScope: string;
  expectedCondition: string;
  required: boolean;
  dependencies: string[];
  state: GoalState;
  evidenceRefs: string[];
  currentNativeProof?: boolean | undefined;
  transactionId?: string | undefined;
}

export interface TransactionOutcome {
  id: string;
  state: 'staged' | 'committed' | 'verified' | 'recovery_required' | 'failed';
  postconditions: string[];
}

export function validateGoalContract(goals: readonly GoalContract[]): void {
  const ids = new Set<string>();
  for (const goal of goals) {
    if (!goal.goalId || ids.has(goal.goalId) || !goal.targetScope || !goal.expectedCondition) throw new Error('GOAL_CONTRACT_INVALID');
    ids.add(goal.goalId);
    if (!goal.required && goal.state === 'verified' && goal.currentNativeProof !== true) throw new Error('GOAL_VERIFIED_WITHOUT_PROOF');
    for (const dependency of goal.dependencies) if (!ids.has(dependency) && !goals.some((candidate) => candidate.goalId === dependency)) throw new Error('GOAL_DEPENDENCY_UNKNOWN');
  }
}

export function evaluateGoalCompletion(goals: readonly GoalContract[], outcomes: readonly TransactionOutcome[]):
  'success' | 'partial' | 'blocked' | 'recovery_required' {
  validateGoalContract(goals);
  if (goals.some((goal) => goal.state === 'recovery_required') || outcomes.some((outcome) => outcome.state === 'recovery_required')) return 'recovery_required';
  const byTransaction = new Map(outcomes.map((outcome) => [outcome.id, outcome]));
  const complete = goals.filter((goal) => goal.required).every((goal) => {
    if (goal.state === 'already_satisfied') return goal.currentNativeProof === true;
    if (goal.state !== 'verified' || goal.currentNativeProof !== true) return false;
    if (goal.kind === 'read' || goal.kind === 'diagnose') return true;
    const transaction = goal.transactionId ? byTransaction.get(goal.transactionId) : undefined;
    return transaction?.state === 'verified' && transaction.postconditions.includes(goal.goalId);
  });
  if (complete) return 'success';
  return goals.some((goal) => goal.state === 'verified' || goal.state === 'already_satisfied') ? 'partial' : 'blocked';
}

export function goalStateAfterNativeRead(goal: GoalContract, proof: boolean): GoalContract {
  return proof ? { ...goal, currentNativeProof: true, state: goal.kind === 'read' ? 'already_satisfied' : goal.state } : { ...goal, currentNativeProof: false };
}
