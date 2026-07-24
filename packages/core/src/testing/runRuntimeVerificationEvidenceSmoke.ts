import assert from 'node:assert/strict';
import {
  MemoryRuntimeVerificationEvidenceStore,
  createRuntimeVerificationEvidence,
  deriveRuntimeProcessEvidence,
  summarizeOperationRuntimeVerification,
  summarizeRuntimeVerification
} from '../runtime/runtimeVerification.js';
import type {
  PersistedRuntimeLaunchState,
  RuntimeLaunchRecord,
  RuntimeVerificationKind
} from '../runtime/runtimeSessionStore.js';

interface RuntimeRecordPatch {
  sessionId?: string;
  verificationKind?: RuntimeVerificationKind;
  operationId?: string;
  relatedOperationId?: string;
  state: PersistedRuntimeLaunchState;
  exitCode?: number;
  signal?: NodeJS.Signals;
  startedAt?: string;
}

async function main(): Promise<void> {
  const store = new MemoryRuntimeVerificationEvidenceStore();
  const record = makeRecord({ state: 'exited', exitCode: 0 });

  assert.equal(deriveRuntimeProcessEvidence(record), 'exited_zero');
  const processOnly = summarizeRuntimeVerification(record, []);
  assert.equal(processOnly.authority, 'process_only');
  assert.equal(processOnly.expectation, 'committed_change_present');
  assert.equal(processOnly.conclusion, 'unverified');
  assert.equal(processOnly.gameLoadAutomaticallyVerified, false);

  const inconclusive = createRuntimeVerificationEvidence({
    evidenceId: 'evidence-1',
    workspaceId: record.workspaceId,
    sessionId: record.sessionId,
    verdict: 'inconclusive',
    note: '  Sekiro opened, but the changed resource was not inspected.\r\n ',
    createdAt: '2026-07-24T08:00:00.000Z'
  });
  store.appendRuntimeVerificationEvidence(inconclusive);
  assert.equal(inconclusive.note, 'Sekiro opened, but the changed resource was not inspected.');

  const confirmed = createRuntimeVerificationEvidence({
    evidenceId: 'evidence-2',
    workspaceId: record.workspaceId,
    sessionId: record.sessionId,
    verdict: 'expected_state_observed',
    note: 'Changed FMG text was visible in the expected menu.',
    createdAt: '2026-07-24T08:01:00.000Z'
  });
  store.appendRuntimeVerificationEvidence(confirmed);

  const evidence = store.listRuntimeVerificationEvidence(record.sessionId);
  const summary = summarizeRuntimeVerification(record, evidence);
  assert.equal(summary.authority, 'operator_attested');
  assert.equal(summary.conclusion, 'operator_confirmed_expected_state');
  assert.equal(summary.evidenceCount, 2);
  assert.equal(summary.latestEvidence?.evidenceId, 'evidence-2');
  assert.equal(summary.gameLoadAutomaticallyVerified, false);

  const forwardFailed = makeRecord({
    sessionId: 'forward-failed',
    state: 'exited',
    exitCode: 0,
    startedAt: '2026-07-24T08:02:00.000Z'
  });
  const rollback = makeRecord({
    sessionId: 'rollback-1',
    verificationKind: 'post_rollback',
    operationId: 'inverse-operation-1',
    relatedOperationId: 'operation-1',
    state: 'exited',
    exitCode: 0,
    startedAt: '2026-07-24T08:03:00.000Z'
  });
  const evidenceBySession = new Map([
    [forwardFailed.sessionId, [createRuntimeVerificationEvidence({
      evidenceId: 'forward-missing',
      workspaceId: forwardFailed.workspaceId,
      sessionId: forwardFailed.sessionId,
      verdict: 'expected_state_not_observed',
      createdAt: '2026-07-24T08:02:30.000Z'
    })]],
    [rollback.sessionId, [createRuntimeVerificationEvidence({
      evidenceId: 'rollback-restored',
      workspaceId: rollback.workspaceId,
      sessionId: rollback.sessionId,
      verdict: 'expected_state_observed',
      note: 'Original text was visible again.',
      createdAt: '2026-07-24T08:03:30.000Z'
    })]]
  ]);
  const operationSummary = summarizeOperationRuntimeVerification(
    record.workspaceId,
    'operation-1',
    [record, forwardFailed, rollback],
    evidenceBySession
  );
  assert.equal(operationSummary.workspaceId, record.workspaceId);
  assert.equal(operationSummary.forwardSessions.length, 2);
  assert.equal(operationSummary.rollbackSessions.length, 1);
  assert.equal(operationSummary.latestRollback?.expectation, 'original_state_restored');
  assert.equal(operationSummary.state, 'rollback_confirmed_restored');
  assert.equal(operationSummary.gameLoadAutomaticallyVerified, false);

  const launchFailure = makeRecord({
    sessionId: 'forward-launch-failed',
    state: 'failed',
    startedAt: '2026-07-24T08:04:00.000Z'
  });
  assert.equal(
    summarizeOperationRuntimeVerification(
      launchFailure.workspaceId,
      'operation-1',
      [launchFailure],
      new Map()
    ).state,
    'forward_process_failed'
  );

  const impossibleAttestation = createRuntimeVerificationEvidence({
    evidenceId: 'impossible-observation',
    workspaceId: launchFailure.workspaceId,
    sessionId: launchFailure.sessionId,
    verdict: 'expected_state_observed',
    createdAt: '2026-07-24T08:04:30.000Z'
  });
  assert.equal(
    summarizeRuntimeVerification(launchFailure, [impossibleAttestation]).conclusion,
    'conflicting_operator_attestation'
  );
  assert.equal(
    summarizeOperationRuntimeVerification(
      launchFailure.workspaceId,
      'operation-1',
      [launchFailure],
      new Map([[launchFailure.sessionId, [impossibleAttestation]]])
    ).state,
    'forward_evidence_conflict'
  );

  const emptySummary = summarizeOperationRuntimeVerification(
    record.workspaceId,
    'operation-without-sessions',
    [],
    new Map()
  );
  assert.equal(emptySummary.workspaceId, record.workspaceId);
  assert.equal(emptySummary.state, 'untested');

  assert.equal(
    deriveRuntimeProcessEvidence(makeRecord({ state: 'exited', exitCode: 5 })),
    'exited_nonzero'
  );
  assert.equal(
    deriveRuntimeProcessEvidence(makeRecord({ state: 'exited', signal: 'SIGTERM' })),
    'exited_by_signal'
  );
  assert.equal(deriveRuntimeProcessEvidence(makeRecord({ state: 'failed' })), 'launch_failed');
  assert.equal(deriveRuntimeProcessEvidence(makeRecord({ state: 'terminated' })), 'terminated_by_editor');
  assert.equal(deriveRuntimeProcessEvidence(makeRecord({ state: 'orphaned' })), 'control_lost');

  assert.throws(() => createRuntimeVerificationEvidence({
    evidenceId: 'bad-evidence',
    workspaceId: record.workspaceId,
    sessionId: record.sessionId,
    verdict: 'expected_state_observed',
    note: 'x'.repeat(2_001),
    createdAt: '2026-07-24T08:05:00.000Z'
  }), /2000 characters/);
  assert.throws(() => store.appendRuntimeVerificationEvidence(confirmed), /already exists/);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    processOutcome: summary.processOutcome,
    conclusion: summary.conclusion,
    evidenceCount: summary.evidenceCount,
    operationState: operationSummary.state,
    conflictState: 'forward_evidence_conflict',
    automaticGameVerification: summary.gameLoadAutomaticallyVerified
  }, null, 2)}\n`);
}

function makeRecord(patch: RuntimeRecordPatch): RuntimeLaunchRecord {
  const verificationKind = patch.verificationKind ?? 'post_commit';
  return {
    sessionId: patch.sessionId ?? 'runtime-session-1',
    workspaceId: 'workspace-1',
    adapterId: 'me3',
    profileId: 'profile-1',
    profilePath: process.platform === 'win32'
      ? 'C:\\SoulForge\\runtime\\profile.me3'
      : '/tmp/SoulForge/runtime/profile.me3',
    ...(verificationKind === 'manual'
      ? {}
      : { operationId: patch.operationId ?? 'operation-1' }),
    ...(verificationKind === 'post_rollback'
      ? { relatedOperationId: patch.relatedOperationId ?? 'operation-1' }
      : {}),
    verificationKind,
    state: patch.state,
    ...(patch.exitCode === undefined ? {} : { exitCode: patch.exitCode }),
    ...(patch.signal === undefined ? {} : { signal: patch.signal }),
    startedAt: patch.startedAt ?? '2026-07-24T07:59:00.000Z',
    stdout: '',
    stderr: '',
    outputTruncated: false,
    diagnostics: [],
    updatedAt: patch.startedAt ?? '2026-07-24T08:00:00.000Z'
  };
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
