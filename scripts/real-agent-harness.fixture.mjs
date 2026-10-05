import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  evaluateGoalCoverage,
  evaluateWriteAdmission,
  classifyInterruptedGoalCoverage,
  buildFailureSessionEvidence,
  createAgentElectronLaunchArgs,
  evaluateRollbackVerification,
  shouldRecoverUnverifiedWriteRollback,
  planRollbackRecoveryOperations,
  evaluateSupervisorNormalCompletion,
  decideScratchCleanup,
  isCancelledAgentLifecycle,
  isRunStopRequested,
  rollbackCommittedOperations,
  selectNewCommittedOperations,
  normalizeOperationHistoryForVerification,
  isSuccessfulAgentTerminal,
  makeSupervisorGeneration,
  planSemanticCorpus,
  enrichNativeSourceFacts,
  diagnoseNativeSourceUriResolution,
  safeHarnessFileLabel,
  sameOwnedProcessIdentity,
  semanticReadiness,
  waitForSemanticReadiness,
  resolveNativeSourceUri,
  classifyStopTelemetry
} from './real-agent-harness-lib.mjs';
import { matchesAssertion, parseGoalContract, validateTaskContractGoals } from './real-agent-goal-contract.mjs';
import { FOUR_TASKS } from './testing/real-agent-four-task-manifest.mjs';
import * as harness from './real-agent-harness-lib.mjs';

test('declared read-only task can complete in observation mode without resource mutation', () => {
  const coverage = evaluateGoalCoverage([{
    goalId: 'read-event', kind: 'native-tool', tool: 'read_emevd_event',
    required: true, verified: true, status: 'verified',
    verificationEvidence: [{ sourceUri: 'file://event/sample.emevd', sourceHashes: ['a'.repeat(64)] }]
  }], true, { intent: 'read', postconditions: ['read-event'] });
  assert.equal(coverage.taskCompletionVerified, true);
  assert.equal(coverage.status, 'verified');
});

test('actual failed native assertion remains failed instead of unverified', () => {
  const coverage = evaluateGoalCoverage([{
    goalId: 'wrong-event', kind: 'native-tool', tool: 'read_emevd_event',
    required: true, verified: false, status: 'failed'
  }], false);
  assert.equal(coverage.status, 'failed');
  assert.deepEqual(coverage.failedGoalIds, ['wrong-event']);
  assert.deepEqual(coverage.unverifiedGoalIds, []);
});

test('declared PARAM postcondition is complete without a mandatory semantic goal category', () => {
  const coverage = evaluateGoalCoverage([{
    goalId: 'hp', kind: 'param-field', required: true, verified: true
  }], false, { intent: 'ensure', postconditions: ['hp'] });
  assert.equal(coverage.taskCompletionVerified, true);
});

test('native postcondition separates unchanged success, wrong value and unavailable evidence', () => {
  assert.equal(typeof harness.evaluateNativeGoalOutcome, 'function');
  assert.equal(harness.evaluateNativeGoalOutcome({
    nativeReadOk: true, assertionOk: true, proofOk: true, resourceChanged: false
  }).status, 'verified');
  assert.equal(harness.evaluateNativeGoalOutcome({
    nativeReadOk: true, assertionOk: false, proofOk: true, resourceChanged: true
  }).status, 'failed');
  assert.equal(harness.evaluateNativeGoalOutcome({
    nativeReadOk: true, assertionOk: true, proofOk: false, resourceChanged: true
  }).status, 'unverified');
  assert.equal(harness.evaluateNativeGoalOutcome({
    nativeReadOk: false, assertionOk: false, proofOk: false, unavailable: true
  }).status, 'unverified');
  assert.equal(harness.evaluateNativeGoalOutcome({
    nativeReadOk: true, assertionOk: true, proofOk: true, resourceChanged: false, requireMutation: true
  }).status, 'failed');
});

test('unknown harness options are rejected instead of turning their values into task text', () => {
  const runnerPath = fileURLToPath(new URL('./run-real-agent-gyoubu.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [runnerPath, '--help', '--request-timeout-ms', '900000'], {
    cwd: process.cwd(),
    encoding: 'utf8'
  });

  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, 'an unsupported option must fail before any provider or workspace starts');
  assert.match(result.stderr, /--request-timeout-ms/u);
  assert.doesNotMatch(result.stdout, /真实生产 Agent 链路模拟/u,
    'the parser must not silently accept the invalid option and print help as if invocation were valid');
});

test('failed harness report preserves a durable terminal when the Electron terminal event is missing', () => {
  const durableRollout = {
    terminal: { type: 'turn-complete', finishReason: 'stop', taskStatus: 'completed', steps: 19 },
    terminalCount: 1,
    parseErrors: 0
  };
  const evidence = buildFailureSessionEvidence({ durableRollout });
  assert.equal(evidence.terminal, null, 'do not forge a renderer IPC session-done event');
  assert.equal(evidence.terminalObserved, false);
  assert.equal(evidence.durableRollout.terminal.finishReason, 'stop');
  assert.equal(evidence.evidenceHasEntries, false);
  assert.equal(buildFailureSessionEvidence(), null);
});

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

test('required unsupported effect metadata does not prevent a run; final coverage remains unsupported', () => {
  const task = FOUR_TASKS.find((item) => item.id === 'four-3-xiuwan-super-poison');
  assert.ok(task);
  const ordinary = evaluateWriteAdmission(task.goals, { observationOnly: false, candidateWrite: false });
  assert.equal(ordinary.allowed, true);
  assert.equal(ordinary.executionMode, 'write');
  assert.deepEqual(ordinary.unsupportedGoalIds, ['xiuwan-combo-poison-accumulation', 'xiuwan-super-poison-effect']);

  const observation = evaluateWriteAdmission(task.goals, { observationOnly: true, candidateWrite: false });
  assert.equal(observation.allowed, true);
  assert.equal(observation.executionMode, 'observation-only');

  const candidate = evaluateWriteAdmission(task.goals, { observationOnly: false, candidateWrite: true });
  assert.equal(candidate.allowed, true);
  assert.equal(candidate.executionMode, 'candidate-experiment');
  const coverage = evaluateGoalCoverage(task.goals.map((goal) => ({ ...goal, verified: true })), false, task.contract);
  assert.equal(coverage.status, 'unsupported');
  assert.equal(coverage.taskCompletionVerified, false);
});

test('read contracts force observation-only admission and contradictory candidate mode remains invalid', () => {
  const contract = { intent: 'read' };
  assert.equal(evaluateWriteAdmission([], { taskContract: contract }).executionMode, 'observation-only');
  assert.equal(evaluateWriteAdmission([], { taskContract: contract, candidateWrite: true }).code, 'REAL_AGENT_MODE_INVALID');
  assert.equal(evaluateWriteAdmission([], { observationOnly: true, candidateWrite: true }).allowed, false);
  for (const task of FOUR_TASKS) assert.equal(evaluateWriteAdmission(task.goals).allowed, true);
});

test('interrupted reports retain unsupported goal classification instead of falling back to PARAM-only mode', () => {
  const task = FOUR_TASKS.find((item) => item.id === 'four-3-xiuwan-super-poison');
  assert.ok(task);
  const interrupted = classifyInterruptedGoalCoverage(task.goals, false, task.contract);
  assert.equal(interrupted.verificationMode, 'native-semantic');
  assert.equal(interrupted.status, 'unsupported');
  assert.deepEqual(interrupted.unsupportedGoalIds, ['xiuwan-combo-poison-accumulation', 'xiuwan-super-poison-effect']);
  assert.equal(interrupted.taskCompletionVerified, false);
});

test('a fatal V8 OOM is not misclassified as an unexplained window close', () => {
  const stop = classifyStopTelemetry({
    diagnostics: {
      events: [{ type: 'page-close', at: '2026-09-27T01:24:33.533Z' }],
      stderrTail: '[175552] OOM error in V8: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory'
    }
  });
  assert.equal(stop.classification, 'internal');
  assert.equal(stop.reason, 'v8-oom');
  assert.equal(stop.pageClose.at, '2026-09-27T01:24:33.533Z');
  assert.equal(stop.v8Oom, true);
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

test('real-agent Electron launch accepts an increased heap budget and preserves the app entry', () => {
  assert.deepEqual(createAgentElectronLaunchArgs({
    runtime: 'unpacked', productionMain: '/snapshot/production-main.mjs', userDataDir: '/tmp/agent-user-data', maxOldSpaceMb: 6144
  }), [
    '--js-flags=--max-old-space-size=6144', '/snapshot/production-main.mjs', '--user-data-dir=/tmp/agent-user-data'
  ]);
  assert.deepEqual(createAgentElectronLaunchArgs({
    runtime: 'installed', productionMain: '/ignored/production-main.mjs', userDataDir: '/tmp/agent-user-data', maxOldSpaceMb: 4096
  }), [
    '--js-flags=--max-old-space-size=4096', '--user-data-dir=/tmp/agent-user-data'
  ]);
  assert.deepEqual(createAgentElectronLaunchArgs({
    runtime: 'unpacked', productionMain: '/snapshot/production-main.mjs', userDataDir: '/tmp/agent-user-data', maxOldSpaceMb: 16384
  }), [
    '--js-flags=--max-old-space-size=16384', '/snapshot/production-main.mjs', '--user-data-dir=/tmp/agent-user-data'
  ]);
  assert.throws(() => createAgentElectronLaunchArgs({
    runtime: 'unpacked', productionMain: '/snapshot/production-main.mjs', userDataDir: '/tmp/agent-user-data', maxOldSpaceMb: 16385
  }), /2048 to 16384/u);
});

test('required corpus sources require exact logical identity and native hash evidence', () => {
  const evaluate = (sourceUri, sourceHashes) => evaluateGoalCoverage([{
    goalId: 'native', kind: 'native-tool', required: true, verified: true,
    verificationEvidence: [{ tool: 'read_emevd_event', sourceUris: [sourceUri], sourceHashes }]
  }], false, { corpusFingerprint: {
    requiredSources: ['event/common.emevd.dcx'], requireNativeSourceHash: true
  } });
  assert.equal(evaluate('file://backup/event/common.emevd.dcx.old', ['sha']).corpusMismatch, true);
  assert.equal(evaluate('file://event/common.emevd.dcx', []).corpusMismatch, true);
  assert.equal(evaluate('file://event/common.emevd.dcx', ['sha']).corpusMismatch, false);
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

test('native-tool evidence binds relative containerPath to its indexed logical source before corpus checking', () => {
  const facts = enrichNativeSourceFacts({
    ok: true,
    data: { record: { containerPath: 'param/gameparam/gameparam.parambnd.dcx' } }
  }, { hashes: ['native-hash'], revisions: [7], uris: [] }, {
    workspaceRoot: 'D:/overlay',
    entries: [{ type: 'file', path: 'param/gameparam/gameparam.parambnd.dcx' }]
  });
  assert.deepEqual(facts.uris, ['file://param/gameparam/gameparam.parambnd.dcx']);
  const verdict = evaluateGoalCoverage([{
    goalId: 'anchor', kind: 'native-tool', required: true, verified: true,
    verificationEvidence: [{ tool: 'read_param_fields', sourceHashes: facts.hashes, sourceUris: facts.uris }]
  }], false, { corpusFingerprint: {
    requiredSources: ['param/gameparam/gameparam.parambnd.dcx'], requireNativeSourceHash: true
  } });
  assert.equal(verdict.corpusMismatch, false);
});

test('native tool basename-only readback binds only through a unique explicit indexed source hint', () => {
  const result = { ok: true, data: { record: { containerPath: 'gameparam.parambnd.dcx' } } };
  const entries = [
    { type: 'file', path: 'param/gameparam/gameparam.parambnd.dcx' },
    { type: 'file', path: 'param/drawparam/drawparam.parambnd.dcx' }
  ];
  assert.deepEqual(resolveNativeSourceUri(result, {
    workspaceRoot: 'D:/overlay', entries, sourceHint: 'param/gameparam/gameparam.parambnd.dcx'
  }), {
    sourceUri: 'file://param/gameparam/gameparam.parambnd.dcx',
    relativePath: 'param/gameparam/gameparam.parambnd.dcx'
  });
  const facts = enrichNativeSourceFacts(result, { hashes: ['native-hash'], revisions: [], uris: [] }, {
    workspaceRoot: 'D:/overlay', entries, sourceHint: 'param/gameparam/gameparam.parambnd.dcx'
  });
  assert.deepEqual(facts.uris, ['file://param/gameparam/gameparam.parambnd.dcx']);
  assert.equal(diagnoseNativeSourceUriResolution(result, {
    workspaceRoot: 'D:/overlay', entries,
    requiredSources: ['param/gameparam/gameparam.parambnd.dcx'],
    sourceHint: 'param/gameparam/gameparam.parambnd.dcx'
  }).bound, true);
  assert.equal(resolveNativeSourceUri(result, {
    workspaceRoot: 'D:/overlay',
    entries: [
      ...entries,
      { type: 'file', path: 'backup/gameparam.parambnd.dcx' }
    ],
    sourceHint: 'param/gameparam/gameparam.parambnd.dcx'
  }), null, 'a non-unique basename must not become a suffix guess');
});

test('source binding diagnostics explain unindexed native paths without exposing local paths', () => {
  const diagnostic = diagnoseNativeSourceUriResolution({
    ok: true,
    data: { record: { containerPath: 'D:/outside/gameparam.parambnd.dcx' } }
  }, {
    workspaceRoot: 'D:/overlay',
    entries: [{ type: 'file', path: 'param/gameparam/gameparam.parambnd.dcx' }],
    requiredSources: ['param/gameparam/gameparam.parambnd.dcx']
  });
  assert.deepEqual(diagnostic, {
    bound: false,
    rootProvided: true,
    indexedFileCount: 1,
    candidateCount: 1,
    candidateStatuses: ['absolute-outside-workspace'],
    relativeCandidates: [],
    candidateMatchesRequiredSource: [],
    candidateComparisons: [],
    requiredSourcesIndexed: [true]
  });
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
  assert.deepEqual(four1.contract.corpusFingerprint.requiredSources, ['param/gameparam/gameparam.parambnd.dcx']);
  assert.equal(four1.contract.targetIdentity.event, undefined,
    'optional common#965104 unlock evidence must not stand in for Gyoubu death causality');
  assert.ok(!four1.goals.some((goal) => goal.required && goal.expectedValue === 9457));
  const lotLink = four1.goals.find((goal) => goal.goalId === 'gyoubu-indigo-lot-link');
  const unlockBaseline = four1.goals.find((goal) => goal.goalId === 'indigo-unlock-event');
  assert.equal(lotLink?.required, false);
  assert.equal(lotLink?.changedPath, undefined);
  assert.equal(unlockBaseline?.required, false);
  assert.equal(unlockBaseline?.changedPath, undefined);
  const four2 = FOUR_TASKS.find((task) => task.id === 'four-2-gyoubu-lightning-genichiro');
  assert.ok(four2);
  const four3 = FOUR_TASKS.find((task) => task.id === 'four-3-xiuwan-super-poison');
  const four4 = FOUR_TASKS.find((task) => task.id === 'four-4-xiuwan-final-tracking');
  assert.deepEqual(four3?.corpusKinds, ['param'], 'PARAM-only poison experiments should not index unrelated MSG/MAP/EVENT families');
  assert.deepEqual(four4?.corpusKinds, ['param'], 'PARAM-only tracking experiments should not index unrelated MSG/MAP/EVENT families');
  for (const task of [four3, four4]) {
    for (const goal of task.goals.filter((item) => item.tool === 'read_param_fields')) {
      assert.equal(goal.input.containerPath, task.contract.corpusFingerprint.requiredSources[0],
        `${goal.goalId} must read from the exact declared corpus source`);
    }
  }
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

test('a task-specific semantic corpus copies only requested resource kinds and reports excluded kinds', () => {
  const plan = planSemanticCorpus(
    ['param', 'msg', 'event', 'map', 'script', 'action', 'chr', 'sfx'],
    ['param', 'msg', 'action']
  );
  assert.deepEqual(plan.requestedKinds, ['param', 'msg', 'action']);
  assert.deepEqual(plan.copiedKinds, ['param', 'msg', 'action']);
  assert.deepEqual(plan.missingKinds, []);
  assert.deepEqual(plan.excludedKinds, ['chr', 'event', 'map', 'script']);
  assert.deepEqual(plan.omittedKinds, ['sfx']);
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

test('full-corpus harness waits for completed analysis before starting a broad Agent workflow', async () => {
  const snapshots = [
    sample({ param_row: 50_302, text_entry: 54_930 }, 'running'),
    sample({ param_row: 50_302, text_entry: 54_930, event: 14_051 }, 'completed')
  ];
  let elapsed = 0;
  const result = await waitForSemanticReadiness({
    readSnapshot: async () => snapshots.shift(),
    requiredFamilies: ['param_row', 'text_entry'],
    requireAnalysisComplete: true,
    now: () => elapsed,
    delay: async (ms) => { elapsed += ms; },
    intervalMs: 10,
    timeoutMs: 100
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.attempts, 2, 'first-family readiness must not race the remaining corpus analysis');
  assert.equal(result.analysisStatus, 'completed');
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

test('interrupted-run recovery selects only newly committed operations, never historical commits', () => {
  const before = [{ opId: 'old-commit', status: 'committed' }];
  const after = [
    { opId: 'old-commit', status: 'committed' },
    { opId: 'new-commit', status: 'committed' },
    { opId: 'new-inverse', status: 'rolled_back' },
    { opId: 'in-flight', status: 'preparing' }
  ];
  assert.deepEqual(selectNewCommittedOperations(after, before).map((operation) => operation.opId), ['new-commit']);
});

test('CLI inverse commit normalizes the original operation to rolled_back for recovery verification', () => {
  const normalized = normalizeOperationHistoryForVerification([
    { opId: 'original', status: 'committed' },
    { opId: 'inverse', status: 'committed', inverseOfOpId: 'original', rollbackScope: 'operation' }
  ]);
  assert.deepEqual(normalized, [{ opId: 'original', status: 'rolled_back' }]);
});

test('unverified UI rollback retries recovery through CLI after Electron exits', () => {
  const base = {
    phase: 'rollback',
    writeMode: true,
    rollbackStatus: 'unverified',
    electronStatus: 'succeeded',
    treeBefore: { sha256: 'before' },
    treeAfterRun: { sha256: 'changed' },
    operationsAfterRun: [{ opId: 'write-1', status: 'committed' }],
    newCommittedOperations: [{ opId: 'write-1', status: 'committed' }],
    rollbackResults: [{ opId: 'write-1', attempted: true, error: { code: 'WINDOW_CLOSED' } }]
  };
  assert.equal(shouldRecoverUnverifiedWriteRollback(base), true);
  assert.equal(shouldRecoverUnverifiedWriteRollback({ ...base, electronStatus: 'running' }), false,
    'recovery must wait until the owned Electron process tree has exited');
  assert.equal(shouldRecoverUnverifiedWriteRollback({
    ...base, treeAfterRun: { sha256: 'before' }, newCommittedOperations: [], rollbackResults: []
  }), false, 'a verified no-mutation path does not need another CLI query');
});

test('CLI rollback recovery recognizes durable inverse commits and never retries them', () => {
  const plan = planRollbackRecoveryOperations([
    { opId: 'already-reversed', status: 'rolled_back' },
    { opId: 'still-committed', status: 'committed' },
    { opId: 'historical', status: 'committed' }
  ], [{ opId: 'historical', status: 'committed' }]);
  assert.deepEqual(plan.newOperations.map((operation) => operation.opId), ['already-reversed', 'still-committed']);
  assert.deepEqual(plan.alreadyRolledBackOperations.map((operation) => operation.opId), ['already-reversed']);
  assert.deepEqual(plan.pendingRollbackOperations.map((operation) => operation.opId), ['still-committed']);
  assert.deepEqual(plan.unresolvedOperations, []);
  const alreadyReversed = planRollbackRecoveryOperations([
    { opId: 'already-reversed', status: 'rolled_back' }
  ], []);
  const durableInverseReceipt = [{
    opId: 'already-reversed',
    attempted: false,
    result: { ok: true, source: 'durable-inverse-already-committed' }
  }];
  const verified = evaluateRollbackVerification({
    operations: alreadyReversed.newOperations,
    results: durableInverseReceipt,
    statuses: new Map([['already-reversed', 'rolled_back']]),
    treeRestoredExactly: true
  });
  assert.equal(verified.verified, true, 'a lost UI reply is verified from the durable inverse and exact overlay tree');
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
