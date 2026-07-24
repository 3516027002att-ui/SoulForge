import type { RuntimeLaunchRecord } from './runtimeSessionStore.js';

export type RuntimeVerificationEvidenceKind = 'operator_attestation';
export type RuntimeOperatorVerdict =
  | 'expected_state_observed'
  | 'expected_state_not_observed'
  | 'game_failed'
  | 'inconclusive';

export type RuntimeVerificationExpectation =
  | 'workspace_mod_active'
  | 'committed_change_present'
  | 'original_state_restored';

export interface RuntimeVerificationEvidence {
  evidenceId: string;
  workspaceId: string;
  sessionId: string;
  evidenceKind: RuntimeVerificationEvidenceKind;
  verdict: RuntimeOperatorVerdict;
  note?: string;
  createdAt: string;
}

export interface RuntimeVerificationEvidenceStore {
  appendRuntimeVerificationEvidence(
    evidence: RuntimeVerificationEvidence
  ): void | Promise<void>;
  listRuntimeVerificationEvidence(
    sessionId: string
  ): RuntimeVerificationEvidence[] | Promise<RuntimeVerificationEvidence[]>;
}

export type RuntimeProcessEvidenceOutcome =
  | 'active'
  | 'launch_failed'
  | 'exited_zero'
  | 'exited_nonzero'
  | 'exited_by_signal'
  | 'exited_unknown'
  | 'terminated_by_editor'
  | 'control_lost';

export type RuntimeVerificationConclusion =
  | 'unverified'
  | 'operator_confirmed_expected_state'
  | 'operator_reported_expected_state_missing'
  | 'operator_reported_game_failed'
  | 'operator_inconclusive';

export type RuntimeVerificationAuthority = 'process_only' | 'operator_attested';

export interface RuntimeVerificationSummary {
  sessionId: string;
  workspaceId: string;
  verificationKind: RuntimeLaunchRecord['verificationKind'];
  expectation: RuntimeVerificationExpectation;
  operationId?: string;
  relatedOperationId?: string;
  processOutcome: RuntimeProcessEvidenceOutcome;
  authority: RuntimeVerificationAuthority;
  conclusion: RuntimeVerificationConclusion;
  evidenceCount: number;
  latestEvidence?: RuntimeVerificationEvidence;
  /** Always false until an independent game-aware probe earns stronger authority. */
  gameLoadAutomaticallyVerified: false;
}

export type RuntimeOperationVerificationState =
  | 'untested'
  | 'forward_active'
  | 'forward_process_failed'
  | 'forward_unverified'
  | 'forward_confirmed'
  | 'forward_failed'
  | 'forward_inconclusive'
  | 'rollback_active'
  | 'rollback_process_failed'
  | 'rollback_unverified'
  | 'rollback_confirmed_restored'
  | 'rollback_failed'
  | 'rollback_inconclusive';

export interface RuntimeOperationVerificationSummary {
  workspaceId: string;
  operationId: string;
  state: RuntimeOperationVerificationState;
  forwardSessions: RuntimeVerificationSummary[];
  rollbackSessions: RuntimeVerificationSummary[];
  latestForward?: RuntimeVerificationSummary;
  latestRollback?: RuntimeVerificationSummary;
  /** Operator evidence remains an attestation, not automatic native/game authority. */
  gameLoadAutomaticallyVerified: false;
}

export class MemoryRuntimeVerificationEvidenceStore
implements RuntimeVerificationEvidenceStore {
  private readonly evidence = new Map<string, RuntimeVerificationEvidence>();

  appendRuntimeVerificationEvidence(evidence: RuntimeVerificationEvidence): void {
    assertRuntimeVerificationEvidence(evidence);
    if (this.evidence.has(evidence.evidenceId)) {
      throw new Error(`Runtime verification evidence already exists: ${evidence.evidenceId}.`);
    }
    this.evidence.set(evidence.evidenceId, cloneEvidence(evidence));
  }

  listRuntimeVerificationEvidence(sessionId: string): RuntimeVerificationEvidence[] {
    return [...this.evidence.values()]
      .filter((item) => item.sessionId === sessionId)
      .sort(compareEvidence)
      .map(cloneEvidence);
  }
}

export function createRuntimeVerificationEvidence(input: {
  evidenceId: string;
  workspaceId: string;
  sessionId: string;
  verdict: RuntimeOperatorVerdict;
  note?: string;
  createdAt: string;
}): RuntimeVerificationEvidence {
  const note = normalizeRuntimeVerificationNote(input.note);
  const evidence: RuntimeVerificationEvidence = {
    evidenceId: input.evidenceId.trim(),
    workspaceId: input.workspaceId.trim(),
    sessionId: input.sessionId.trim(),
    evidenceKind: 'operator_attestation',
    verdict: input.verdict,
    ...(note ? { note } : {}),
    createdAt: input.createdAt
  };
  assertRuntimeVerificationEvidence(evidence);
  return evidence;
}

export function summarizeRuntimeVerification(
  record: RuntimeLaunchRecord,
  evidence: readonly RuntimeVerificationEvidence[]
): RuntimeVerificationSummary {
  const relevant = evidence
    .filter((item) => item.workspaceId === record.workspaceId && item.sessionId === record.sessionId)
    .map(cloneEvidence)
    .sort(compareEvidence);
  const latestEvidence = relevant.at(-1);
  return {
    sessionId: record.sessionId,
    workspaceId: record.workspaceId,
    verificationKind: record.verificationKind,
    expectation: expectationForVerificationKind(record.verificationKind),
    ...(record.operationId ? { operationId: record.operationId } : {}),
    ...(record.relatedOperationId ? { relatedOperationId: record.relatedOperationId } : {}),
    processOutcome: deriveRuntimeProcessEvidence(record),
    authority: latestEvidence ? 'operator_attested' : 'process_only',
    conclusion: latestEvidence ? conclusionFromVerdict(latestEvidence.verdict) : 'unverified',
    evidenceCount: relevant.length,
    ...(latestEvidence ? { latestEvidence } : {}),
    gameLoadAutomaticallyVerified: false
  };
}

export function summarizeOperationRuntimeVerification(
  operationId: string,
  sessions: readonly RuntimeLaunchRecord[],
  evidenceBySession: ReadonlyMap<string, readonly RuntimeVerificationEvidence[]>
): RuntimeOperationVerificationSummary {
  const forwardRecords = sessions
    .filter((record) => record.verificationKind === 'post_commit' && record.operationId === operationId)
    .sort(compareSessions);
  const rollbackRecords = sessions
    .filter((record) => record.verificationKind === 'post_rollback'
      && record.relatedOperationId === operationId)
    .sort(compareSessions);
  const forwardSessions = forwardRecords.map((record) => summarizeRuntimeVerification(
    record,
    evidenceBySession.get(record.sessionId) ?? []
  ));
  const rollbackSessions = rollbackRecords.map((record) => summarizeRuntimeVerification(
    record,
    evidenceBySession.get(record.sessionId) ?? []
  ));
  const latestForward = forwardSessions.at(-1);
  const latestRollback = rollbackSessions.at(-1);
  const workspaceId = latestRollback?.workspaceId
    ?? latestForward?.workspaceId
    ?? sessions.find((record) => record.operationId === operationId)?.workspaceId
    ?? '';
  return {
    workspaceId,
    operationId,
    state: deriveOperationVerificationState(latestForward, latestRollback),
    forwardSessions,
    rollbackSessions,
    ...(latestForward ? { latestForward } : {}),
    ...(latestRollback ? { latestRollback } : {}),
    gameLoadAutomaticallyVerified: false
  };
}

export function deriveRuntimeProcessEvidence(
  record: RuntimeLaunchRecord
): RuntimeProcessEvidenceOutcome {
  switch (record.state) {
    case 'starting':
    case 'running':
      return 'active';
    case 'failed':
      return 'launch_failed';
    case 'terminated':
      return 'terminated_by_editor';
    case 'orphaned':
      return 'control_lost';
    case 'exited':
      if (record.signal) return 'exited_by_signal';
      if (record.exitCode === 0) return 'exited_zero';
      if (record.exitCode !== undefined) return 'exited_nonzero';
      return 'exited_unknown';
  }
}

export function expectationForVerificationKind(
  kind: RuntimeLaunchRecord['verificationKind']
): RuntimeVerificationExpectation {
  switch (kind) {
    case 'manual':
      return 'workspace_mod_active';
    case 'post_commit':
      return 'committed_change_present';
    case 'post_rollback':
      return 'original_state_restored';
  }
}

export function assertRuntimeVerificationEvidence(
  evidence: RuntimeVerificationEvidence
): void {
  if (!evidence.evidenceId || !evidence.workspaceId || !evidence.sessionId) {
    throw new Error('Runtime verification evidence identity fields must not be empty.');
  }
  if (evidence.evidenceKind !== 'operator_attestation') {
    throw new Error(`Unsupported runtime verification evidence kind: ${evidence.evidenceKind}.`);
  }
  if (!isRuntimeOperatorVerdict(evidence.verdict)) {
    throw new Error(`Invalid runtime operator verdict: ${String(evidence.verdict)}.`);
  }
  if (evidence.note !== undefined && evidence.note !== normalizeRuntimeVerificationNote(evidence.note)) {
    throw new Error('Runtime verification note must already be normalized.');
  }
  if (!evidence.createdAt || Number.isNaN(Date.parse(evidence.createdAt))) {
    throw new Error(`Invalid runtime verification evidence createdAt: ${evidence.createdAt}.`);
  }
}

export function isRuntimeOperatorVerdict(value: unknown): value is RuntimeOperatorVerdict {
  return value === 'expected_state_observed'
    || value === 'expected_state_not_observed'
    || value === 'game_failed'
    || value === 'inconclusive';
}

export function normalizeRuntimeVerificationNote(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.includes('\0')) throw new Error('Runtime verification note must not contain NUL bytes.');
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return undefined;
  if (normalized.length > 2_000) {
    throw new Error('Runtime verification note must not exceed 2000 characters.');
  }
  return normalized;
}

function conclusionFromVerdict(verdict: RuntimeOperatorVerdict): RuntimeVerificationConclusion {
  switch (verdict) {
    case 'expected_state_observed':
      return 'operator_confirmed_expected_state';
    case 'expected_state_not_observed':
      return 'operator_reported_expected_state_missing';
    case 'game_failed':
      return 'operator_reported_game_failed';
    case 'inconclusive':
      return 'operator_inconclusive';
  }
}

function deriveOperationVerificationState(
  latestForward: RuntimeVerificationSummary | undefined,
  latestRollback: RuntimeVerificationSummary | undefined
): RuntimeOperationVerificationState {
  if (latestRollback) return stateForSummary(latestRollback, 'rollback');
  if (latestForward) return stateForSummary(latestForward, 'forward');
  return 'untested';
}

function stateForSummary(
  summary: RuntimeVerificationSummary,
  phase: 'forward' | 'rollback'
): RuntimeOperationVerificationState {
  if (summary.processOutcome === 'active') {
    return phase === 'forward' ? 'forward_active' : 'rollback_active';
  }
  if (isProcessFailure(summary.processOutcome) && summary.conclusion === 'unverified') {
    return phase === 'forward' ? 'forward_process_failed' : 'rollback_process_failed';
  }
  switch (summary.conclusion) {
    case 'operator_confirmed_expected_state':
      return phase === 'forward' ? 'forward_confirmed' : 'rollback_confirmed_restored';
    case 'operator_reported_expected_state_missing':
    case 'operator_reported_game_failed':
      return phase === 'forward' ? 'forward_failed' : 'rollback_failed';
    case 'operator_inconclusive':
      return phase === 'forward' ? 'forward_inconclusive' : 'rollback_inconclusive';
    case 'unverified':
      return phase === 'forward' ? 'forward_unverified' : 'rollback_unverified';
  }
}

function isProcessFailure(outcome: RuntimeProcessEvidenceOutcome): boolean {
  return outcome === 'launch_failed'
    || outcome === 'exited_nonzero'
    || outcome === 'exited_by_signal';
}

function compareEvidence(
  left: RuntimeVerificationEvidence,
  right: RuntimeVerificationEvidence
): number {
  return left.createdAt.localeCompare(right.createdAt)
    || left.evidenceId.localeCompare(right.evidenceId);
}

function compareSessions(left: RuntimeLaunchRecord, right: RuntimeLaunchRecord): number {
  return left.startedAt.localeCompare(right.startedAt)
    || left.sessionId.localeCompare(right.sessionId);
}

function cloneEvidence(evidence: RuntimeVerificationEvidence): RuntimeVerificationEvidence {
  return { ...evidence };
}
