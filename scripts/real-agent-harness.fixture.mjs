import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateGoalCoverage,
  evaluateSupervisorNormalCompletion,
  isCancelledAgentLifecycle,
  isRunStopRequested,
  isSuccessfulAgentTerminal,
  makeSupervisorGeneration,
  planSemanticCorpus,
  safeHarnessFileLabel,
  sameOwnedProcessIdentity,
  semanticReadiness,
  waitForSemanticReadiness
} from './real-agent-harness-lib.mjs';

test('selected corpus includes action/chr and reports all exclusions without claiming full corpus', () => {
  const plan = planSemanticCorpus(['param', 'msg', 'event', 'map', 'script', 'action', 'chr', 'sfx', '.soulforge']);
  assert.deepEqual(plan.copiedKinds, ['param', 'msg', 'event', 'map', 'script', 'action', 'chr']);
  assert.deepEqual(plan.missingKinds, []);
  assert.deepEqual(plan.omittedKinds, ['.soulforge', 'sfx']);
  assert.equal(plan.fullCorpus, false);
});

test('missing action/chr are explicit diagnostics and never reported as copied', () => {
  const plan = planSemanticCorpus(['param', 'msg', 'event', 'map', 'script']);
  assert.deepEqual(plan.missingKinds, ['action', 'chr']);
  assert.deepEqual(plan.diagnostics.map((item) => [item.code, item.kind]), [
    ['CORPUS_KIND_MISSING', 'action'], ['CORPUS_KIND_MISSING', 'chr']
  ]);
  assert.ok(!plan.copiedKinds.includes('action'));
  assert.ok(!plan.copiedKinds.includes('chr'));
});

test('original optional-only test 3/4 anchors cannot vacuously pass goals', () => {
  for (const goals of [[], [{ goalId: 'xiuwan-poison-anchor', required: false, verified: true }]]) {
    const verdict = evaluateGoalCoverage(goals, false);
    assert.equal(verdict.goalsOk, false);
    assert.equal(verdict.fieldChecksOk, false);
    assert.equal(verdict.taskCompletionVerified, false);
    assert.ok(verdict.diagnostics.some((item) => item.code === 'REQUIRED_GOALS_EMPTY'));
  }
});

test('matching a required PARAM proxy is a field result, not proof of the whole natural-language task', () => {
  const verdict = evaluateGoalCoverage([{ required: true, verified: true }], false);
  assert.equal(verdict.fieldChecksOk, true);
  assert.equal(verdict.goalsOk, true);
  assert.equal(verdict.taskCoverageOk, false);
  assert.equal(verdict.taskCompletionVerified, false);
  assert.equal(evaluateGoalCoverage([{ required: true, verified: false }], false).fieldChecksOk, false);
});

test('observation mode never passes even with all supplied native goals verified', () => {
  for (const goals of [[], [{ required: true, verified: true }]]) {
    const verdict = evaluateGoalCoverage(goals, true);
    assert.equal(verdict.mode, 'observation-only');
    assert.equal(verdict.goalsOk, false);
    assert.equal(verdict.taskCoverageOk, false);
    assert.equal(verdict.taskCompletionVerified, false);
  }
});

const sample = (byFamily, status = 'running') => ({
  stats: { ok: true, data: { semanticIndex: { rag: { byFamily } } } },
  analysis: { status }
});

test('file-only and only PARAM do not satisfy PARAM+MSG; first semantic batch does without waiting for MSB', () => {
  const required = ['param_row', 'text_entry'];
  assert.equal(semanticReadiness(sample({ file: 136 }), required).status, 'warming_up');
  assert.equal(semanticReadiness(sample({ file: 136, param_row: 5 }), required).status, 'warming_up');
  const ready = semanticReadiness(sample({ param_row: 5, text_entry: 10, map_entity: 0 }), required);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.analysisStatus, 'running');
  assert.equal(ready.counts.map_entity, 0);
});

test('semantic preflight observes live transitions and returns at the first required batch', async () => {
  const snapshots = [sample({ file: 136 }), sample({ param_row: 2 }), sample({ param_row: 2, text_entry: 1 })];
  let elapsed = 0;
  const result = await waitForSemanticReadiness({
    readSnapshot: async () => snapshots.shift(), requiredFamilies: ['param_row', 'text_entry'],
    now: () => elapsed, delay: async (ms) => { elapsed += ms; }, intervalMs: 10, timeoutMs: 100
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.attempts, 3);
  assert.equal(result.elapsedMs, 20);
});

test('preflight timeout preserves missing families and explicit diagnostic', async () => {
  let elapsed = 0;
  const result = await waitForSemanticReadiness({
    readSnapshot: async () => sample({ file: 136 }), requiredFamilies: ['param_row', 'text_entry'],
    now: () => elapsed, delay: async (ms) => { elapsed += ms; }, intervalMs: 10, timeoutMs: 25
  });
  assert.equal(result.status, 'timeout');
  assert.equal(result.elapsedMs, 25);
  assert.deepEqual(result.missingFamilies, ['param_row', 'text_entry']);
  assert.ok(result.diagnostics.some((item) => item.code === 'SEMANTIC_PREFLIGHT_TIMEOUT'));
});

test('preflight analysis rejection is terminal and preserves original diagnostics', async () => {
  const result = await waitForSemanticReadiness({ readSnapshot: async () => ({
    ...sample({ file: 136 }), analysis: { status: 'failed', error: { code: 'BRIDGE_FAILED', message: 'native failure' } }
  }) });
  assert.equal(result.status, 'failed');
  assert.equal(result.attempts, 1);
  assert.equal(result.diagnostics[0].code, 'BRIDGE_FAILED');
});

test('even a hung public workspace_stats call is bounded', async () => {
  const result = await waitForSemanticReadiness({
    readSnapshot: () => new Promise(() => {}), timeoutMs: 15, intervalMs: 1
  });
  assert.equal(result.status, 'timeout');
  assert.ok(result.diagnostics.some((item) => item.code === 'SEMANTIC_PREFLIGHT_READ_TIMEOUT'));
});

test('supervisor cancellation follows live turn-complete schema without taskStatus', () => {
  assert.equal(isCancelledAgentLifecycle([
    { event: { type: 'turn-complete', finishReason: 'cancelled', steps: 6 } }
  ]), true);
  assert.equal(isCancelledAgentLifecycle([
    { event: { type: 'turn-complete', finishReason: 'cancelled', taskStatus: 'cancelled', steps: 6 } }
  ]), true);
});

test('failed Agent report with safe cleanup cannot be accepted as normal success', () => {
  const terminal = { type: 'session-done', finishReason: 'stop', steps: 4 };
  const durableTerminal = { type: 'turn-complete', finishReason: 'stop', taskStatus: 'completed', steps: 4 };
  assert.equal(isSuccessfulAgentTerminal(terminal, durableTerminal), true);
  assert.equal(evaluateSupervisorNormalCompletion({
    report: { ok: false }, terminal, durableTerminal, exitCode: 0, signal: null,
    identityOk: true, cleanupOk: true, durableEvidenceOk: true, rollbackEvidenceOk: true, afterRollback: []
  }), false);
  assert.equal(evaluateSupervisorNormalCompletion({
    report: { ok: true }, terminal, durableTerminal, exitCode: 1, signal: null,
    identityOk: true, cleanupOk: true, durableEvidenceOk: true, rollbackEvidenceOk: true, afterRollback: []
  }), false);
});

test('owned process fallback requires unchanged pid, creation time, and executable', () => {
  const expected = { pid: 1234, creationTime: '2026-09-08T10:40:03.052Z', executablePath: 'C:\\Program Files\\nodejs\\node.exe' };
  assert.equal(sameOwnedProcessIdentity({ ...expected }, expected), true);
  assert.equal(sameOwnedProcessIdentity({ ...expected, creationTime: '2026-09-08T10:40:04.052Z' }, expected), false);
  assert.equal(sameOwnedProcessIdentity({ ...expected, executablePath: 'C:\\Windows\\System32\\svchost.exe' }, expected), false);
});

test('supervisor generation is deterministic for a supplied startup identity and differs by suffix', () => {
  const startedAt = '2026-09-08T10:40:03.052Z';
  const first = makeSupervisorGeneration({ startedAt, pid: 21228, suffix: 'aaa111' });
  const second = makeSupervisorGeneration({ startedAt, pid: 21228, suffix: 'bbb222' });
  assert.notEqual(first, second);
  assert.match(first, /^20260908T104003052Z-pid21228-aaa111$/u);
});

test('generation-bearing labels are not truncated and a run-specific stop requests stop mode', () => {
  const generation = makeSupervisorGeneration({
    startedAt: '2026-09-08T10:40:03.052Z', pid: 21228, suffix: 'aaa111'
  });
  const label = `agent-supervisor-${generation}-r001-q03-latestclosure-e748`;
  assert.equal(safeHarnessFileLabel(label, 128), label);
  assert.equal(isRunStopRequested({ stopping: false, globalStop: false, runStop: true }), true);
  assert.equal(isRunStopRequested({ stopping: false, globalStop: false, runStop: false }), false);
});
