/**
 * 语义编排的共享类型。
 *
 * 这一层只描述事实、覆盖率和宿主可验证的完成条件；它不保存模型猜出的
 * 原生 ID，也不替代 Bridge/Patch Engine 的 authority。
 */

export type TaskKind = 'inspect' | 'diagnose' | 'modify' | 'create';

export type CanonicalEntityKind =
  | 'character'
  | 'item'
  | 'map'
  | 'map_entity'
  | 'map_region'
  | 'action'
  | 'event'
  | 'param'
  | 'param_row'
  | 'text_entry'
  | 'resource';

export type ResolverStatus =
  | 'RESOLVED'
  | 'AMBIGUOUS'
  | 'NOT_FOUND_COMPLETE'
  | 'COVERAGE_INCOMPLETE'
  | 'SOURCE_UNAVAILABLE'
  | 'PARSE_FAILED'
  | 'STALE';

export type CoverageStatus =
  | 'FOUND'
  | 'NOT_FOUND_WITH_COMPLETE_COVERAGE'
  | 'NOT_INDEXED'
  | 'PARTIALLY_INDEXED'
  | 'PARSE_FAILED'
  | 'STALE'
  | 'SOURCE_UNAVAILABLE';

export type EpistemicState = 'observed' | 'derived' | 'hypothesized' | 'unverified';

export interface CoverageSnapshot {
  status: CoverageStatus;
  scope: string;
  indexed: number;
  expected: number;
  successful: number;
  failed: number;
  /** Parsed with a deliberately partial/native-limited authority; not complete coverage. */
  partial?: number;
  sourceRevision?: string;
  completenessRatio: number;
  resultCount: number;
  diagnostics: string[];
}

export interface CanonicalEntity {
  identity: string;
  sourceUri: string;
  revision: string;
  address?: string;
  kind: CanonicalEntityKind;
  displayName: string;
  sourceSymbolUri?: string;
  epistemic: EpistemicState;
}

export interface CanonicalEntityEdge {
  from: string;
  to: string;
  relation: string;
  provenance: string;
  confidence: 'high' | 'medium' | 'low';
  evidenceIds: string[];
  revision: string;
  epistemic: EpistemicState;
}

export interface CanonicalEntityGraph {
  nodes: CanonicalEntity[];
  edges: CanonicalEntityEdge[];
  facts: ResolvedFact[];
  revision: string;
}

export interface ResolverCandidate<T = CanonicalEntity> {
  value: T;
  score: number;
  reasons: string[];
}

export interface ResolverResult<T = CanonicalEntity> {
  status: ResolverStatus;
  value?: T;
  candidates: ResolverCandidate[];
  facts: ResolvedFact[];
  coverage: CoverageSnapshot;
  diagnostics: string[];
}

export interface TaskTargetDescription {
  text: string;
  kind?: CanonicalEntityKind;
  address?: string;
  exact: boolean;
}

export type SubgoalStatus = 'pending' | 'active' | 'resolved' | 'blocked' | 'unresolved';

export interface QueryPlanResult {
  tool: string;
  query: string;
  resultFingerprint: string;
  ok: boolean;
  informationGain: {
    newResolvedFacts: number;
    eliminatedCandidates: number;
    coverageChanged: boolean;
    unknownsReduced: number;
    newAuthoritativeEvidence: number;
    stateChanged: boolean;
  };
}

export interface QueryPlan {
  planId: string;
  subgoalId: string;
  purpose: string;
  candidateTools: string[];
  attemptedQueries: string[];
  results: QueryPlanResult[];
  coverage?: CoverageSnapshot;
  unresolvedQuestions: string[];
}

export interface SubgoalState {
  subgoalId: string;
  goal: string;
  status: SubgoalStatus;
  queryPlan: QueryPlan;
  evidenceIds: string[];
  resolvedFactKeys: string[];
  remainingUnknowns: string[];
  nextSubgoalId?: string;
}

export interface TaskModel {
  taskId: string;
  originalGoal: string;
  kind: TaskKind;
  targets: TaskTargetDescription[];
  desiredChanges: string[];
  postconditions: string[];
  constraints: string[];
  unresolvedEntities: string[];
  resolvedEntities: CanonicalEntity[];
  currentSubgoal?: string;
  externalTaskGoal: string;
  explicitCreate: boolean;
  subgoals: SubgoalState[];
  completionContract: CompletionContract;
}

export interface ResolvedFact<T = unknown> {
  key: string;
  value: T;
  subject: string;
  provenance: string;
  evidenceIds: string[];
  revision: string;
  epistemic: Exclude<EpistemicState, 'hypothesized'>;
  confidence: 'high' | 'medium' | 'low';
}

export type CompletionPredicateKind =
  | 'target_resolved'
  | 'mutations_planned'
  | 'staged'
  | 'validators_passed'
  | 'committed'
  | 'reread_verified'
  | 'postconditions_verified'
  | 'index_refreshed'
  | 'rag_refreshed';

/**
 * Structured evidence emitted by a real tool boundary.  Model prose never
 * satisfies a predicate; only this typed evidence can advance a contract.
 */
export interface CompletionEvidence {
  kind: CompletionPredicateKind;
  /** Optional discriminator for one operation/postcondition in a multi-step task. */
  key?: string;
  evidenceIds: string[];
  diagnostic?: string;
}

export interface CompletionPredicate {
  kind: CompletionPredicateKind;
  /** Optional operation/postcondition discriminator for multi-domain tasks. */
  key?: string;
  required: boolean;
  satisfied: boolean;
  evidenceIds: string[];
  diagnostic?: string;
}

export interface CompletionContract {
  taskId: string;
  predicates: CompletionPredicate[];
}

export interface CompletionEvaluation {
  status: 'succeeded' | 'incomplete' | 'blocked';
  missing: CompletionPredicate[];
  diagnostics: string[];
}

export interface SemanticChangeOperation {
  operationId: string;
  domain: 'param' | 'fmg' | 'event' | 'map' | 'action' | 'resource';
  targetIdentity: string;
  kind: string;
  beforeRevision: string;
  dependencies: string[];
  payload: Record<string, unknown>;
}

export interface SemanticChangeSet {
  changeSetId: string;
  baseRevision: string;
  /** Canonical targets resolved before any domain writer is invoked. */
  targetIdentities: string[];
  /** Target identity -> revision observed during planning. */
  expectedBaseRevisions: Record<string, string>;
  operations: SemanticChangeOperation[];
  dependencyOrder: string[];
  postconditions: string[];
  conflictPolicy: 'fail_closed' | 'manual_review';
  diagnostics: string[];
}

export interface IdReservation {
  value: number;
  namespace: string;
  source: 'existing' | 'reserved';
}

export interface ProgressObservation {
  subgoalId: string;
  resultFingerprint: string;
  candidateIds: string[];
  coverageStatus?: CoverageStatus;
}

export interface ProgressDecision {
  action: 'CONTINUE' | 'REPLAN';
  repeated: number;
  newCandidateCount: number;
  newFactCount?: number;
  newEvidenceCount?: number;
  reason?: string;
}
