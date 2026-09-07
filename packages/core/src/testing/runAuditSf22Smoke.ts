import { strict as assert } from 'node:assert';
import { evaluateGoalCompletion, goalStateAfterNativeRead, type GoalContract } from '../ai/goalContract.js';
import { capabilityManifestHash, canRequestOperation, createCapabilityManifest } from '../ai/capabilityManifest.js';

function goal(overrides: Partial<GoalContract> = {}): GoalContract {
  return { goalId: 'g1', requestRef: 'u1', kind: 'modify', targetScope: 'param:row', expectedCondition: 'hp=2', required: true, dependencies: [], state: 'verified', evidenceRefs: ['native'], currentNativeProof: true, transactionId: 'tx', ...overrides };
}

function main(): void {
  assert.equal(evaluateGoalCompletion([goal()], [{ id: 'tx', state: 'verified', postconditions: ['g1'] }]), 'success');
  assert.equal(evaluateGoalCompletion([goal(), goal({ goalId: 'g2', state: 'staged', currentNativeProof: false })], [{ id: 'tx', state: 'verified', postconditions: ['g1'] }]), 'partial');
  assert.equal(evaluateGoalCompletion([goal({ state: 'recovery_required' })], []), 'recovery_required');
  assert.equal(evaluateGoalCompletion([goal({ kind: 'read', state: 'already_satisfied', transactionId: undefined })], []), 'success');
  assert.equal(evaluateGoalCompletion([goal({ state: 'planned', currentNativeProof: false })], []), 'blocked');
  assert.equal(goalStateAfterNativeRead(goal({ kind: 'read', state: 'planned' }), true).state, 'already_satisfied');
  const manifest = createCapabilityManifest({ workspaceId: 'ws', mode: 'normal', tools: ['read_param_fields'], memoryAvailable: false, coverage: { param: 'partial' }, nativeWriterProfiles: { read_param_fields: 'native-verified', mutate_param_fields: 'unsupported' }, oodleAvailable: false, confirmationRequired: true, toolSchema: { revision: 1 } });
  assert.equal(manifest.tools[0], 'read_param_fields');
  assert.equal(canRequestOperation(manifest, 'read_param_fields'), true);
  assert.equal(canRequestOperation({ ...manifest, mode: 'plan' }, 'mutate_param_fields'), false);
  assert.equal(capabilityManifestHash(manifest).length, 64);
  console.log(JSON.stringify({ ok: true, taskId: 'SF-22', layer: process.argv.includes('--layer') ? process.argv[process.argv.indexOf('--layer') + 1] : 'unit', executedCases: 9, production: ['evaluateGoalCompletion', 'createCapabilityManifest', 'canRequestOperation'], message: 'Goal最终状态、already_satisfied、recovery与Capability Manifest通过' }));
}

main();
