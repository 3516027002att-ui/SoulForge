import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateGoalCoverage,
  evaluateRollbackVerification,
  evaluateSupervisorNormalCompletion,
  decideScratchCleanup,
  isCancelledAgentLifecycle,
  isRunStopRequested,
  rollbackCommittedOperations,
  isSuccessfulAgentTerminal,
  makeSupervisorGeneration,
  planSemanticCorpus,
  safeHarnessFileLabel,
  sameOwnedProcessIdentity,
  semanticReadiness,
  waitForSemanticReadiness,
  resolveNativeSourceUri
} from './real-agent-harness-lib.mjs';
import { matchesAssertion, parseGoalContract, validateTaskContractGoals } from './real-agent-goal-contract.mjs';
import { FOUR_TASKS } from './testing/real-agent-four-task-manifest.mjs';

test('required unsupported behavior goals are terminal and cannot be masked by PARAM anchors', () => {
  const goals = [
    { goalId: 'bars', kind: 'param-field', required: true, verified: true },
    {
      goalId: 'runtime-behavior',
      kind: 'unsupported',
      required: true,
      verificationStatus: 'unsupported',
      unsupportedReason: '没有游戏运行时行为验证器。',
      verified: false,
      verificationEvidence: []
    }
  ];
  const verdict = evaluateGoalCoverage(goals, false);
  assert.equal(verdict.goalsOk, false);
  assert.equal(verdict.taskCoverageOk, false);
  assert.equal(verdict.status, 'unsupported');
  assert.ok(verdict.diagnostics.some((item) => item.code === 'REQUIRED_GOAL_UNSUPPORTED'));
  const forged = evaluateGoalCoverage([{
    goalId: 'forged-runtime', kind: 'unsupported', required: true,
    verificationStatus: 'unsupported', unsupportedReason: '仍然没有运行时验证器。',
    verified: true, verificationEvidence: [{ tool: 'fake', sourceHashes: ['fake'] }]
  }], false);
  assert.equal(forged.goalsOk, false);
  assert.equal(forged.taskCompletionVerified, false);
});

test('a selected task cannot claim completion from only one executable subset', () => {
  const verdict = evaluateGoalCoverage([
    {
      goalId: 'partial-native',
      kind: 'native-tool',
      required: true,
      verified: true,
      verificationEvidence: [{ sourceUris: ['file://param/gameparam/gameparam.parambnd.dcx'], sourceHashes: ['h'] }]
    },
    {
      goalId: 'unverified-runtime',
      kind: 'unsupported',
      required: true,
      verificationStatus: 'unsupported',
      unsupportedReason: '需要运行时。',
      verified: false,
      verificationEvidence: []
    }
  ], false, { corpusFingerprint: { requiredSources: ['param/gameparam/gameparam.parambnd.dcx'] } });
  assert.equal(verdict.taskCompletionVerified, false);
  assert.equal(verdict.status, 'unsupported');
});

test('missing source evidence is a corpus mismatch rather than an implicit pass', () => {
  const verdict = evaluateGoalCoverage([{
    goalId: 'native', kind: 'native-tool', required: true, verified: true,
    verificationEvidence: [{ tool: 'read_emevd_event', sourceHashes: ['h'], sourceUris: [] }]
  }], false, { corpusFingerprint: { requiredSources: ['event/common.emevd.dcx'] } });
  assert.equal(verdict.corpusMismatch, true);
  assert.equal(verdict.status, 'corpus_mismatch');
  assert.equal(verdict.taskCompletionVerified, false);
});

test('a required failed native goal has an explicit unverified terminal status', () => {
  const verdict = evaluateGoalCoverage([{
    goalId: 'native-failed', kind: 'native-tool', required: true,
    verified: false, verificationEvidence: [], diagnostics: [{ code: 'NATIVE_READ_FAILED' }]
  }], false);
  assert.equal(verdict.status, 'unverified');
  assert.equal(verdict.taskCompletionVerified, false);
  assert.ok(verdict.unverifiedGoalIds.includes('native-failed'));
  assert.ok(verdict.diagnostics.some((item) => item.code === 'REQUIRED_GOAL_UNVERIFIED'));
});

test('discovery and static-analysis tools are observation-only and cannot be required semantic goals', () => {
  for (const tool of ['search_events', 'search_param_rows', 'analyze_luabnd_script', 'analyze_tae_structure']) {
    assert.throws(() => parseGoalContract(JSON.stringify([{
      goalId: `required-${tool}`, kind: 'native-tool', tool,
      input: { file: 'event/common.emevd.dcx', ...(tool.startsWith('search_') ? { query: 'x' } : { childPath: 'x.lua' }) },
      assertion: { path: 'data.record', exists: true }, required: true
    }])), /观察|optional/u);
    const optional = parseGoalContract(JSON.stringify([{
      goalId: `optional-${tool}`, kind: 'native-tool', tool,
      input: { file: 'event/common.emevd.dcx', ...(tool.startsWith('search_') ? { query: 'x' } : { childPath: 'x.lua' }) },
      assertion: { path: 'data.record', exists: true }, required: false
    }]))[0];
    assert.equal(optional.verificationClass, 'observation');
  }
  const verdict = evaluateGoalCoverage([{
    goalId: 'candidate', kind: 'native-tool', tool: 'search_events', verificationClass: 'observation',
    required: true, verified: true, verificationEvidence: [{ sourceHashes: ['fake'] }]
  }], false);
  assert.equal(verdict.taskCompletionVerified, false);
  assert.equal(verdict.status, 'observation_only');
  assert.ok(verdict.diagnostics.some((item) => item.code === 'REQUIRED_GOAL_OBSERVATION_ONLY'));
});

test('native PARAM containerPath becomes a workspace-bound logical source URI without guessing', () => {
  const bound = resolveNativeSourceUri({
    ok: true,
    data: { containerPath: 'param/gameparam/gameparam.parambnd.dcx' }
  }, {
    workspaceRoot: 'D:/overlay',
    entries: [{ type: 'file', path: 'param/gameparam/gameparam.parambnd.dcx' }]
  });
  assert.deepEqual(bound, {
    sourceUri: 'file://param/gameparam/gameparam.parambnd.dcx',
    relativePath: 'param/gameparam/gameparam.parambnd.dcx'
  });
  assert.equal(resolveNativeSourceUri({ ok: true, data: { containerPath: 'param/not-indexed.parambnd.dcx' } }, {
    workspaceRoot: 'D:/overlay', entries: [{ type: 'file', path: 'param/gameparam/gameparam.parambnd.dcx' }]
  }), null);
  assert.equal(resolveNativeSourceUri({ ok: true, data: { containerPath: 'D:/outside/gameparam.parambnd.dcx' } }, {
    workspaceRoot: 'D:/overlay', entries: [{ type: 'file', path: 'param/gameparam/gameparam.parambnd.dcx' }]
  }), null);
});

test('contract postconditions must map to required executable goals', () => {
  const task = FOUR_TASKS.find((item) => item.id === 'four-1-gyoubu-elite-indigo');
  assert.ok(task);
  const missing = validateTaskContractGoals(task.goals.filter((goal) => goal.goalId !== 'gyoubu-health-bars'), task.contract);
  assert.deepEqual(missing, { ok: false, missingGoalIds: ['gyoubu-health-bars'] });
  const optional = validateTaskContractGoals(task.goals.map((goal) => goal.goalId === 'gyoubu-health-bars'
    ? { ...goal, required: false } : goal), task.contract);
  assert.deepEqual(optional, { ok: false, missingGoalIds: ['gyoubu-health-bars'] });
});

test('task contracts requiring runtime evidence cannot be completed by native reads alone', () => {
  const verdict = evaluateGoalCoverage([{
    goalId: 'native-read', kind: 'native-tool', verificationClass: 'native', required: true,
    verified: true, verificationEvidence: [{ sourceUris: ['file://event/common.emevd.dcx'], sourceHashes: ['h'] }]
  }], false, {
    requiresRuntimeEvidence: true,
    corpusFingerprint: { requiredSources: ['event/common.emevd.dcx'] },
    postconditions: ['native-read']
  });
  assert.equal(verdict.taskCompletionVerified, false);
  assert.equal(verdict.status, 'unverified');
  assert.ok(verdict.diagnostics.some((item) => item.code === 'RUNTIME_EVIDENCE_REQUIRED'));
});

test('ordered instruction assertions prove a native event chain, not a substring coincidence', () => {
  const assertion = {
    path: 'data.record.instructions',
    sequence: [
      { allOf: [
        { path: 'name', equals: 'AwardItemLot' },
        { path: 'typedArgs', some: { allOf: [
          { path: 'name', equals: 'itemLotId' }, { path: 'value', equals: 90017000 }
        ] } }
      ] },
      { allOf: [
        { path: 'name', equals: 'GrantSkill' },
        { path: 'typedArgs', some: { allOf: [
          { path: 'name', equals: 'skillParamId' }, { path: 'value', equals: 786 }
        ] } }
      ] },
      { allOf: [
        { path: 'name', equals: 'RemoveItemFromPlayer' },
        { path: 'typedArgs', some: { allOf: [
          { path: 'name', equals: 'itemId' }, { path: 'value', equals: 9457 }
        ] } }
      ] }
    ]
  };
  const root = { data: { record: { instructions: [
    { name: 'AwardItemLot', typedArgs: [{ name: 'itemLotId', value: 90017000 }] },
    { name: 'GrantSkill', typedArgs: [{ name: 'skillParamId', value: 786 }] },
    { name: 'RemoveItemFromPlayer', typedArgs: [{ name: 'itemId', value: 9457 }] }
  ] } } };
  assert.equal(matchesAssertion(root, assertion), true);
  const wrongOrder = structuredClone(root);
  wrongOrder.data.record.instructions.reverse();
  assert.equal(matchesAssertion(wrongOrder, assertion), false);
});

test('four-task manifest keeps unsupported runtime obligations required and does not treat lot token 9457 as unlock proof', () => {
  for (const task of FOUR_TASKS) {
    const requiredUnsupported = task.goals.filter((goal) => goal.required && goal.kind === 'unsupported');
    assert.ok(requiredUnsupported.length > 0, `${task.id} must block when runtime behavior is unavailable`);
    assert.ok(requiredUnsupported.every((goal) => goal.verificationStatus === 'unsupported'));
    const goalIds = new Set(task.goals.map((goal) => goal.goalId));
    assert.ok(task.contract.postconditions.every((goalId) => goalIds.has(goalId)), `${task.id} contract metadata must refer to executable goals or explicit unsupported goals`);
    assert.ok(task.contract.postconditions.every((goalId) => task.goals.find((goal) => goal.goalId === goalId)?.required === true), `${task.id} postconditions must not promote optional probes to required outcomes`);
  }
  const four1 = FOUR_TASKS.find((task) => task.id === 'four-1-gyoubu-elite-indigo');
  assert.ok(four1);
  assert.ok(!four1.goals.some((goal) => goal.required && goal.expectedValue === 9457));
  const lotLink = four1.goals.find((goal) => goal.goalId === 'gyoubu-indigo-lot-link');
  const unlockBaseline = four1.goals.find((goal) => goal.goalId === 'indigo-unlock-event');
  assert.equal(lotLink?.required, false);
  assert.equal(lotLink?.changedPath, undefined);
  assert.equal(unlockBaseline?.required, false);
  assert.equal(unlockBaseline?.changedPath, undefined);
  const four2 = FOUR_TASKS.find((task) => task.id === 'four-2-gyoubu-lightning-genichiro');
  assert.ok(four2);
  for (const probe of four2.goals.filter((goal) => goal.goalId.endsWith('-script-structure'))) {
    assert.equal(probe.required, false);
    assert.equal(probe.changedPath, undefined);
    assert.ok(['calls', 'branches'].includes(probe.input.section));
    assert.ok(probe.input.limit <= 6);
  }
});

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

test('semantic goals require their own native evidence and can use only data assertions', () => {
  const parsed = parseGoalContract(JSON.stringify([{
    goalId: 'tae-time',
    kind: 'native-tool',
    tool: 'read_tae_events',
    input: { file: 'chr/c5080.anibnd.dcx', addresses: ['c5080#A0200.e3'] },
    assertion: { path: 'data.events', some: { path: 'fields', some: { path: 'name', equals: 'duration' } } }
  }]));
  assert.equal(parsed[0].kind, 'native-tool');
  assert.equal(matchesAssertion({ data: { events: [{ fields: [{ name: 'duration', value: 80 }] }] } }, parsed[0].assertion), true);
  const verified = evaluateGoalCoverage([{
    ...parsed[0], verified: true, verificationEvidence: [{ tool: 'read_tae_events', sourceHashes: ['sha'] }]
  }], false);
  assert.equal(verified.mode, 'native-semantic');
  assert.equal(verified.taskCoverageOk, true);
  assert.equal(verified.taskCompletionVerified, true);
});

test('semantic goal without proof or assertion cannot pass the task gate', () => {
  assert.throws(() => parseGoalContract(JSON.stringify([{
    kind: 'native-tool', tool: 'read_emevd_event', input: { file: 'event/x.emevd.dcx', eventId: 1 }
  }])), /assertion/u);
  const verdict = evaluateGoalCoverage([{
    kind: 'native-tool', required: true, verified: true, verificationEvidence: []
  }], false);
  assert.equal(verdict.goalsOk, true);
  assert.equal(verdict.taskCoverageOk, false);
  assert.ok(verdict.diagnostics.some((item) => item.code === 'TASK_SEMANTIC_GOAL_FAILED'));
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

test('rollback preserves production newest-first order and strict hash guards restore chained writes', async () => {
  const initial = new Map([
    ['event.emevd', 'base-event'],
    ['param.param', 'base-param']
  ]);
  const current = new Map([
    ['event.emevd', 'event-C'],
    ['param.param', 'param-P']
  ]);
  const hash = (value) => `hash:${value}`;
  const productionOrder = [
    { opId: 'param-P', file: 'param.param', before: 'base-param', after: 'param-P' },
    { opId: 'event-C', file: 'event.emevd', before: 'event-B', after: 'event-C' },
    { opId: 'event-B', file: 'event.emevd', before: 'event-A', after: 'event-B' },
    { opId: 'event-A', file: 'event.emevd', before: 'base-event', after: 'event-A' }
  ];
  const originalIds = productionOrder.map((operation) => operation.opId);
  const rollback = async (opId) => {
    const operation = productionOrder.find((candidate) => candidate.opId === opId);
    assert.ok(operation, `unknown operation ${opId}`);
    const actualHash = hash(current.get(operation.file));
    if (actualHash !== hash(operation.after)) {
      return { ok: false, diagnostics: [{ code: 'ROLLBACK_TARGET_CHANGED', actualHash }] };
    }
    current.set(operation.file, operation.before);
    return { ok: true, beforeHash: hash(operation.before), afterHash: hash(operation.after) };
  };

  const wrongOrderCurrent = new Map([
    ['event.emevd', 'event-C'],
    ['param.param', 'param-P']
  ]);
  const wrongOrderResults = await rollbackCommittedOperations(
    [...productionOrder].reverse(),
    async (opId) => {
      const operation = productionOrder.find((candidate) => candidate.opId === opId);
      const actualHash = hash(wrongOrderCurrent.get(operation.file));
      if (actualHash !== hash(operation.after)) {
        return { ok: false, diagnostics: [{ code: 'ROLLBACK_TARGET_CHANGED', actualHash }] };
      }
      wrongOrderCurrent.set(operation.file, operation.before);
      return { ok: true };
    }
  );
  assert.equal(wrongOrderResults.find((entry) => entry.opId === 'event-A').result.ok, false);
  assert.equal(wrongOrderResults.find((entry) => entry.opId === 'event-A').result.diagnostics[0].code, 'ROLLBACK_TARGET_CHANGED');
  assert.equal(wrongOrderCurrent.get('event.emevd'), 'event-B');

  const results = await rollbackCommittedOperations(productionOrder, rollback);
  assert.deepEqual(productionOrder.map((operation) => operation.opId), originalIds);
  assert.deepEqual(results.map((entry) => entry.opId), ['param-P', 'event-C', 'event-B', 'event-A']);
  assert.deepEqual(results.slice(1).map((entry) => entry.result.ok), [true, true, true]);
  assert.ok(results.every((entry) => entry.result.ok === true));
  assert.deepEqual([...current.entries()], [...initial.entries()]);
});

test('rollback records a first-operation throw and never reaches later operations', async () => {
  const calls = [];
  const results = await rollbackCommittedOperations(
    [{ opId: 'first' }, { opId: 'second' }],
    async (opId) => {
      calls.push(opId);
      throw Object.assign(new Error('database request timed out'), { code: 'DB_TIMEOUT' });
    }
  );
  assert.deepEqual(calls, ['first']);
  assert.equal(results.length, 1);
  assert.equal(results[0].opId, 'first');
  assert.equal(results[0].attempted, true);
  assert.equal(results[0].result.ok, false);
  assert.equal(results[0].error.code, 'DB_TIMEOUT');
  assert.equal(results[0].result.diagnostics[0].message, 'database request timed out');
});

test('rollback keeps the successful prefix and records the middle throw without retrying', async () => {
  const calls = [];
  const results = await rollbackCommittedOperations(
    [{ opId: 'newest' }, { opId: 'middle' }, { opId: 'oldest' }],
    async (opId) => {
      calls.push(opId);
      if (opId === 'middle') throw Object.assign(new Error('indeterminate inverse'), { code: 'ROLLBACK_UNKNOWN' });
      return { ok: true, opId };
    }
  );
  assert.deepEqual(calls, ['newest', 'middle']);
  assert.deepEqual(results.map((entry) => entry.opId), ['newest', 'middle']);
  assert.equal(results[0].attempted, true);
  assert.deepEqual(results[0].result, { ok: true, opId: 'newest' });
  assert.equal(results[1].attempted, true);
  assert.equal(results[1].result.ok, false);
  assert.equal(results[1].error.code, 'ROLLBACK_UNKNOWN');
});

test('scratch cleanup is allowed only for verified rollback and an exited electron tree', () => {
  assert.deepEqual(decideScratchCleanup({ electronStatus: 'not-started', rollbackStatus: 'unverified' }), {
    remove: false, status: 'preserved', reason: 'ROLLBACK_NOT_VERIFIED'
  });
  assert.deepEqual(decideScratchCleanup({ electronStatus: 'succeeded', rollbackStatus: 'not_applicable' }), {
    remove: true, status: 'remove', reason: null
  });
  assert.deepEqual(decideScratchCleanup({ electronStatus: 'succeeded', rollbackStatus: 'verified' }), {
    remove: true, status: 'remove', reason: null
  });
  assert.deepEqual(decideScratchCleanup({ electronStatus: 'not-started', rollbackStatus: 'verified' }), {
    remove: true, status: 'remove', reason: null
  });
  assert.deepEqual(decideScratchCleanup({ electronStatus: 'skipped', rollbackStatus: 'verified' }), {
    remove: false, status: 'preserved', reason: 'ELECTRON_TREE_NOT_CONFIRMED_EXITED'
  });
  assert.deepEqual(decideScratchCleanup({ electronStatus: 'skipped', rollbackStatus: 'not_applicable' }), {
    remove: false, status: 'preserved', reason: 'ELECTRON_TREE_NOT_CONFIRMED_EXITED'
  });
});

test('rollback receipt and status cannot verify cleanup when the tree still differs', () => {
  const verification = evaluateRollbackVerification({
    operations: [{ opId: 'write-1' }],
    results: [{ opId: 'write-1', result: { ok: true } }],
    statuses: new Map([['write-1', 'rolled_back']]),
    treeRestoredExactly: false
  });
  assert.equal(verification.receiptOk, true);
  assert.equal(verification.operationStatusOk, true);
  assert.equal(verification.verified, false);
  assert.deepEqual(decideScratchCleanup({ electronStatus: 'succeeded', rollbackStatus: 'unverified' }), {
    remove: false, status: 'preserved', reason: 'ROLLBACK_NOT_VERIFIED'
  });
});
