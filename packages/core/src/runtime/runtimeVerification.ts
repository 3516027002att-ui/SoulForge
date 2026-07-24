import type { RuntimeLaunchRecord } from './runtimeSessionStore.js';

export type RuntimeVerificationEvidenceKind = 'operator_attestation';
export type RuntimeOperatorVerdict =
  | 'mod_loaded'
  | 'mod_not_loaded'
  | 'game_failed'
  | 'inconclusive';

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
  | 'operator_confirmed_mod_loaded'
  | 'operator_reported_mod_not_loaded'
  | 'operator_reported_game_failed'
  | 'operator_inconclusive';

export type RuntimeVerificationAuthority = 'process_only' | 'operator_attested';

export interface RuntimeVerificationSummary {
  sessionId: string;
  workspaceId: string;
  verificationKind: RuntimeLaunchRecord['verificationKind'];
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
  return value === 'mod_loaded'
    || value === 'mod_not_loaded'
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
    case 'mod_loaded':
      return 'operator_confirmed_mod_loaded';
    case 'mod_not_loaded':
      return 'operator_reported_mod_not_loaded';
    case 'game_failed':
      return 'operator_reported_game_failed';
    case 'inconclusive':
      return 'operator_inconclusive';
  }
}

function compareEvidence(
  left: RuntimeVerificationEvidence,
  right: RuntimeVerificationEvidence
): number {
  return left.createdAt.localeCompare(right.createdAt)
    || left.evidenceId.localeCompare(right.evidenceId);
}

function cloneEvidence(evidence: RuntimeVerificationEvidence): RuntimeVerificationEvidence {
  return { ...evidence };
}
