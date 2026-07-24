import assert from 'node:assert/strict';
import {
  MemoryRuntimeVerificationEvidenceStore,
  createRuntimeVerificationEvidence,
  deriveRuntimeProcessEvidence,
  summarizeRuntimeVerification
} from '../runtime/runtimeVerification.js';
import type { RuntimeLaunchRecord } from '../runtime/runtimeSessionStore.js';

async function main(): Promise<void> {
  const store = new MemoryRuntimeVerificationEvidenceStore();
  const record = makeRecord({ state: 'exited', exitCode: 0 });

  assert.equal(deriveRuntimeProcessEvidence(record), 'exited_zero');
  const processOnly = summarizeRuntimeVerification(record, []);
  assert.equal(processOnly.authority, 'process_only');
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
    verdict: 'mod_loaded',
    note: 'Changed FMG text was visible in the expected menu.',
    createdAt: '2026-07-24T08:01:00.000Z'
  });
  store.appendRuntimeVerificationEvidence(confirmed);

  const evidence = store.listRuntimeVerificationEvidence(record.sessionId);
  const summary = summarizeRuntimeVerification(record, evidence);
  assert.equal(summary.authority, 'operator_attested');
  assert.equal(summary.conclusion, 'operator_confirmed_mod_loaded');
  assert.equal(summary.evidenceCount, 2);
  assert.equal(summary.latestEvidence?.evidenceId, 'evidence-2');
  assert.equal(summary.gameLoadAutomaticallyVerified, false);

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
    verdict: 'mod_loaded',
    note: 'x'.repeat(2_001),
    createdAt: '2026-07-24T08:02:00.000Z'
  }), /2000 characters/);
  assert.throws(() => store.appendRuntimeVerificationEvidence(confirmed), /already exists/);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    processOutcome: summary.processOutcome,
    conclusion: summary.conclusion,
    evidenceCount: summary.evidenceCount,
    automaticGameVerification: summary.gameLoadAutomaticallyVerified
  }, null, 2)}\n`);
}

function makeRecord(
  patch: Pick<RuntimeLaunchRecord, 'state'> & Partial<RuntimeLaunchRecord>
): RuntimeLaunchRecord {
  return {
    sessionId: 'runtime-session-1',
    workspaceId: 'workspace-1',
    adapterId: 'me3',
    profileId: 'profile-1',
    profilePath: process.platform === 'win32'
      ? 'C:\\SoulForge\\runtime\\profile.me3'
      : '/tmp/SoulForge/runtime/profile.me3',
    operationId: 'operation-1',
    verificationKind: 'post_commit',
    state: patch.state,
    startedAt: '2026-07-24T07:59:00.000Z',
    stdout: '',
    stderr: '',
    outputTruncated: false,
    diagnostics: [],
    updatedAt: '2026-07-24T08:00:00.000Z',
    ...patch
  };
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
