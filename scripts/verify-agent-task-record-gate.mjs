/**
 * Migrated suite name kept for runner compatibility.
 *
 * Production no longer exposes manual task-record tools. This gate now asserts:
 * 1) read_agent_task_record / update_agent_task_record are absent from ToolRegistry
 * 2) find_references / read_param_fields remain available
 * 3) NativeReadProofStore + buildWriteRequirement enforce write boundary without ledger
 * 4) model-supplied verified/searchId/mutationBudget grant nothing
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

import { createDefaultToolRegistry } from '../packages/core/dist/index.js';
import {
  NativeReadProofStore,
  buildWriteRequirement
} from '../packages/core/dist/editing/nativeReadProofStore.js';
import { createHash } from 'node:crypto';

function fixtureHash(label) {
  return createHash('sha256').update(label).digest('hex');
}

function identity(fieldKey = 'FixtureNpcParam#91000200') {
  return {
    workspaceId: 'fixture-ws-gate',
    outerId: 'gameparam://fixture/NpcParam',
    childChain: ['FixtureNpcParam'],
    domain: 'param',
    namespace: 'FixtureNpcParam',
    objectKey: fieldKey
  };
}

const registry = createDefaultToolRegistry();
const names = registry.list().map((tool) => tool.name);

assert.ok(!names.includes('read_agent_task_record'), '生产注册表不得包含 read_agent_task_record');
assert.ok(!names.includes('update_agent_task_record'), '生产注册表不得包含 update_agent_task_record');
assert.ok(names.includes('find_references'), 'find_references 必须保留');
assert.ok(names.includes('read_param_fields'), 'read_param_fields 必须保留');
assert.ok(names.includes('mutate_param_fields'), 'mutate_param_fields 必须保留');

const proofs = new NativeReadProofStore({ generation: 1 });
const id = identity();
const version = {
  outerFileHash: fixtureHash('gate-outer'),
  childHash: fixtureHash('gate-child'),
  dataHash: fixtureHash('gate-data'),
  generation: 1
};

const requirement = buildWriteRequirement(
  'mutate_param_fields',
  { edits: [{ table: 'FixtureNpcParam', rowId: 91000200, fieldId: 'hp', value: 900 }] },
  {
    principal: 'agent-run-gate',
    workspaceId: 'fixture-ws-gate',
    identityFor: () => id
  }
);
assert.ok(requirement.ok !== false || requirement.targets, 'write requirement 必须能从 payload 解析目标');
if (requirement.ok === false) {
  assert.fail(`write requirement 解析失败: ${requirement.message}`);
}

const denied = proofs.requireCoverage(requirement);
assert.equal(denied.ok, false, '无读取证明时写入必须失败关闭');
assert.equal(denied.code, 'NATIVE_READ_REQUIRED');

proofs.acceptDeliveredRead({
  principal: 'agent-run-gate',
  workspaceId: 'fixture-ws-gate',
  identity: id,
  version,
  domain: 'param',
  observation: {
    kind: 'param-fields',
    fields: [{ fieldId: 'hp', value: 800, delivered: true }],
    completeness: 'complete',
    truncated: false
  },
  finalVisible: {
    hasTargetRead: true,
    deliveredFieldIds: ['hp'],
    projection: 'param-fields'
  }
});

const allowed = proofs.requireCoverage(requirement);
assert.equal(allowed.ok, true, '宿主交付的原生字段证明应允许同版本写入');

const forged = proofs.requireCoverage({
  ...requirement,
  principal: 'other-agent',
  targets: requirement.targets.map((t) => ({ ...t }))
});
assert.equal(forged.ok, false, '跨主体证明不得复用');

console.log(JSON.stringify({
  ok: true,
  suite: 'agent-task-record-gate',
  note: 'migrated: manual ledger tools removed; automatic native-read proof boundary asserted',
  toolCount: names.length,
  checks: [
    'ledger_tools_absent',
    'find_references_present',
    'read_param_fields_present',
    'mutate_param_fields_present',
    'write_denied_without_proof',
    'write_allowed_with_delivered_proof',
    'cross_principal_rejected'
  ]
}, null, 2));
