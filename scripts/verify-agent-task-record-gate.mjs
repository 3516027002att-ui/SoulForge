/**
 * Regression smoke for the production Agent task-record row boundary.
 *
 * A visible FMG/text id must never become a PARAM row id by inference. The
 * real desktop gateway is imported directly so this check exercises the same
 * implementation used by the production Agent host.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDefaultToolRegistry } from '../packages/core/dist/index.js';
import { createAgentTaskRecordGateway } from '../apps/desktop/src/main/agentTaskRecord.ts';

const root = await mkdtemp(join(tmpdir(), 'soulforge-agent-record-gate-'));

try {
  const gateway = createAgentTaskRecordGateway(root, 'gate-smoke');
  await gateway.read();
  await gateway.update({
    objectName: '义父的铃铛',
    propertyKey: 'target',
    value: '待定位',
    kind: 'target'
  });

  const ticket = await gateway.recordSearch({
    toolName: 'search_param_rows',
    query: '义父的铃铛',
    result: { items: [{ item: { paramName: 'EquipParamGoods', rowId: 3080 } }] }
  });

  assert.equal(
    (await gateway.assertParamReadTarget({ table: 'EquipParamGoods', rowIds: [3080] })).ok,
    true,
    '搜索返回的精确 PARAM 行应允许后续原生读取'
  );
  const textIdAsRow = await gateway.assertParamReadTarget({ table: 'EquipParamGoods', rowIds: [3504] });
  assert.equal(textIdAsRow.ok, false, 'FMG/text id 不得被当作 EquipParamGoods 行号');
  assert.equal(textIdAsRow.code, 'TASK_RECORD_PARAM_ROW_UNRESOLVED');

  await gateway.update({
    objectName: '义父的铃铛',
    propertyKey: 'EquipParamGoods',
    value: 'rowId=3080',
    evidence: ['EquipParamGoods#3080 fieldId=nameId'],
    searchId: ticket.searchId,
    mutationBudget: 1
  });
  assert.equal(
    (await gateway.assertMutationTarget('mutate_param_fields', {
      edits: [{ table: 'EquipParamGoods', rowId: 3080, fieldId: 'nameId', value: 1 }]
    })).ok,
    true,
    '已登记的 PARAM 行应允许进入写入门禁'
  );
  const wrongWrite = await gateway.assertMutationTarget('mutate_param_fields', {
    edits: [{ table: 'EquipParamGoods', rowId: 3504, fieldId: 'nameId', value: 1 }]
  });
  assert.equal(wrongWrite.ok, false, '未登记的 PARAM 行不得进入写入门禁');
  assert.equal(wrongWrite.code, 'TASK_RECORD_PARAM_ROW_UNRESOLVED');

  // Registry integration: the gateway contract must be on the production
  // execution path, not merely tested as a standalone file helper.
  const registry = createDefaultToolRegistry();
  const searchCalls = [];
  const integrationGateway = {
    beforeSearch: async (input) => { searchCalls.push(['beforeSearch', input]); return { ok: true }; },
    recordSearch: async (input) => {
      searchCalls.push(['recordSearch', input]);
      return { searchId: 'search-integration', toolName: input.toolName, query: input.query };
    },
    assertParamReadTarget: async () => ({ ok: true }),
    assertMutationTarget: async () => ({ ok: false, code: 'TEST_GATE', message: 'test gate' }),
    finalizeMutation: async () => undefined,
    releaseMutationReservation: async () => undefined,
    releaseMutationCount: async () => ({ ok: true, released: 0, snapshot: { path: '', entries: [], updatedAt: null } }),
    read: async () => ({ path: '', entries: [], updatedAt: null }),
    update: async () => ({ path: '', entries: [], updatedAt: null })
  };
  const fakeIndex = {
    searchParamRows: () => [{ table: 'EquipParamGoods', rowId: 9011, rowName: '义父的守护铃' }]
  };
  const integrationContext = {
    workspaceIndex: fakeIndex,
    mode: 'fullPermission',
    taskRecord: integrationGateway,
    requireTaskRecord: true
  };
  const searchResult = await registry.run('search_param_rows', { query: '义父的守护铃', paramNames: ['EquipParamGoods'] }, integrationContext);
  assert.equal(searchResult.ok, true, '生产注册表应在成功搜索后返回任务记录 searchId');
  assert.equal(searchResult.data.searchId, 'search-integration');
  assert.deepEqual(searchCalls.map(([name]) => name), ['beforeSearch', 'recordSearch']);

  const omittedFieldIds = await registry.run('read_param_fields', {
    table: 'EquipParamGoods',
    rowIds: [9011]
  }, integrationContext);
  assert.equal(omittedFieldIds.ok, false);
  assert.equal(omittedFieldIds.error.code, 'INVALID_INPUT', '缺少 fieldIds 必须在注册表输入门禁处拒绝');
  const emptyFieldIds = await registry.run('read_param_fields', {
    table: 'EquipParamGoods',
    rowIds: [9011],
    fieldIds: []
  }, integrationContext);
  assert.equal(emptyFieldIds.ok, false);
  assert.equal(emptyFieldIds.error.code, 'PARAM_FIELD_IDS_REQUIRED', '空 fieldIds 必须拒绝');

  // read() is the gateway's flush boundary; make the batched write durable
  // before the temporary test workspace is removed.
  await gateway.read();

  console.log('agent task-record gate smoke passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
