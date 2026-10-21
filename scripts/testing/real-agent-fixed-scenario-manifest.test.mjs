/**
 * Fixed scenarios must be passable by definition and must fail when any one
 * postcondition is not proven. Runs the real contract parser, the real
 * evaluator and the real task-outcome judge against a synthetic native reader;
 * no Electron, Bridge, model or game data is involved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXED_SCENARIOS, getFixedScenario } from './real-agent-fixed-scenario-manifest.mjs';
import { parseGoalContract, validateTaskContractGoals } from '../real-agent-goal-contract.mjs';
import { verifyGoalsThroughNativeTool } from '../real-agent-evaluator.mjs';
import { evaluateGoalCoverage, evaluateTaskOutcome } from '../real-agent-harness-lib.mjs';

const ROOT = process.platform === 'win32' ? 'C:\\sf-fixed-scenario-overlay' : '/sf-fixed-scenario-overlay';

function expectedOf(goal) {
  const leaf = goal.assertion.some.allOf.at(-1);
  return Object.prototype.hasOwnProperty.call(leaf, 'equals') ? leaf.equals : 1;
}

// Synthetic native reader. Shape mirrors read_param_fields / read_fmg_entries
// results (data.fields / data.entries, containerPath, per-record sourceHash).
function fakeReader(goals, { wrongValueGoalId, missingHashGoalId } = {}) {
  return async (tool, input) => {
    const goal = goals.find((candidate) => candidate.tool === tool
      && JSON.stringify(candidate.input) === JSON.stringify(input));
    if (!goal) return { ok: false, error: { code: 'NATIVE_READ_FAILED', message: 'unexpected read' } };
    const expected = expectedOf(goal);
    const value = goal.goalId === wrongValueGoalId
      ? (typeof expected === 'number' ? expected + 1 : `${expected}-wrong`)
      : expected;
    const hash = goal.goalId === missingHashGoalId ? {} : { sourceHash: `sha256:${goal.goalId}` };
    if (tool === 'read_param_fields') {
      // An exists-only (read) goal cannot be falsified by a value; its negative
      // case is the target field being absent from the native read.
      const absent = goal.goalId === wrongValueGoalId && !Object.prototype.hasOwnProperty.call(goal.assertion.some.allOf.at(-1), 'equals');
      return { ok: true, data: { containerPath: input.containerPath,
        fields: absent ? [] : [{ rowId: input.rowIds[0], fieldId: input.fieldIds[0], value, ...hash }] } };
    }
    if (tool === 'read_fmg_entries') {
      return { ok: true, data: { containerPath: input.containerPath, ...hash,
        entries: [{ id: input.ids[0], text: value, ...hash }] } };
    }
    return { ok: false, error: { code: 'NATIVE_READ_FAILED', message: `no fake for ${tool}` } };
  };
}

function treeEvidence(scenario, { mutated }) {
  const paths = scenario.contract.corpusFingerprint.requiredSources;
  const entries = (tag) => paths.map((path) => ({ path, type: 'file', sha256: `${tag}-${path}` }));
  return { root: ROOT, before: { entries: entries('before') }, after: { entries: entries(mutated ? 'after' : 'before') } };
}

export async function judgeFixedScenario(scenario, {
  wrongValueGoalId, missingHashGoalId, mutated, writeObservedOverride
} = {}) {
  const intent = scenario.contract.intent;
  const observationOnly = intent === 'read';
  const goals = parseGoalContract(JSON.stringify(scenario.goals), { observationOnly, taskQuery: scenario.query, defaultTaskQuery: '' });
  const isModify = intent === 'modify';
  const tree = treeEvidence(scenario, { mutated: mutated ?? isModify });
  const { evaluations } = await verifyGoalsThroughNativeTool(
    fakeReader(goals, { wrongValueGoalId, missingHashGoalId }), goals, tree, scenario.contract);
  const goalCoverage = evaluateGoalCoverage(evaluations, observationOnly, scenario.contract);
  const writeObserved = writeObservedOverride ?? isModify;
  const outcome = evaluateTaskOutcome({
    taskContract: scenario.contract, goalCoverage, lifecycleOk: true, durableEvidenceOk: true, runtimeOk: true,
    writeMode: !observationOnly, executionMode: observationOnly ? 'observation-only' : 'write',
    committedOperationOk: writeObserved, writeObserved,
    rollbackStatus: writeObserved ? 'verified' : 'not_applicable', treeRestoredExactly: true
  });
  return { goalCoverage, outcome };
}

test('fixed scenario ids are unique and resolvable by prefix', () => {
  const ids = FIXED_SCENARIOS.map((scenario) => scenario.id);
  assert.equal(new Set(ids).size, ids.length);
  FIXED_SCENARIOS.forEach((scenario, index) => {
    assert.equal(getFixedScenario(`fixed-${index + 1}`)?.id, scenario.id);
  });
});

for (const scenario of FIXED_SCENARIOS) {
  test(`${scenario.id}: contract is complete and contains no unsupported/observation goal`, () => {
    const goals = parseGoalContract(JSON.stringify(scenario.goals), {
      observationOnly: scenario.contract.intent === 'read', taskQuery: scenario.query, defaultTaskQuery: '' });
    assert.deepEqual(validateTaskContractGoals(goals, scenario.contract), { ok: true, missingGoalIds: [] });
    assert.equal(scenario.contract.requiresRuntimeEvidence, false);
    assert.ok(scenario.contract.corpusFingerprint.requiredSources.length > 0);
    for (const goal of goals) {
      assert.equal(goal.required, true);
      assert.equal(goal.verificationClass, 'native');
      assert.notEqual(goal.kind, 'unsupported');
    }
  });

  test(`${scenario.id}: all postconditions verified with native evidence => passed`, async () => {
    const { goalCoverage, outcome } = await judgeFixedScenario(scenario);
    assert.equal(goalCoverage.status, 'verified', JSON.stringify(goalCoverage.diagnostics));
    assert.deepEqual(outcome, { passed: true, status: 'passed', reason: 'applicable-postconditions-verified' });
  });

  for (const goal of scenario.goals) {
    test(`${scenario.id}: wrong value on ${goal.goalId} => not passed`, async () => {
      const { goalCoverage, outcome } = await judgeFixedScenario(scenario, { wrongValueGoalId: goal.goalId });
      assert.equal(goalCoverage.status, 'failed');
      assert.equal(outcome.passed, false);
    });
    test(`${scenario.id}: missing native hash on ${goal.goalId} => not passed`, async () => {
      const { outcome } = await judgeFixedScenario(scenario, { missingHashGoalId: goal.goalId });
      assert.equal(outcome.passed, false);
    });
  }

  if (scenario.contract.intent === 'modify') {
    test(`${scenario.id}: target resource unchanged => not passed`, async () => {
      const { outcome } = await judgeFixedScenario(scenario, { mutated: false });
      assert.equal(outcome.passed, false);
    });
  } else {
    test(`${scenario.id}: read task that mutates => not passed`, async () => {
      const { outcome } = await judgeFixedScenario(scenario, { writeObservedOverride: true });
      assert.deepEqual(outcome, { passed: false, status: 'failed', reason: 'read-task-mutated' });
    });
  }
}
