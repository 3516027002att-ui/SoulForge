/**
 * Regression smoke for the production Agent task-record row boundary.
 *
 * A visible FMG/text id must never become a PARAM row id by inference. The
 * real desktop gateway is imported directly so this check exercises the same
 * implementation used by the production Agent host.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDefaultToolRegistry, toolInputShapeToJsonSchema } from '../packages/core/dist/index.js';
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

  // A native result may expose a broad PARAM type and the physical BND4
  // entry at the same time.  Both identities are real receipts; the physical
  // entry must not be widened to a sibling entry merely because the native
  // type is shared.
  const atkTicket = await gateway.recordSearch({
    toolName: 'search_param_rows',
    query: 'attack',
    result: {
      items: [{
        item: {
          paramName: 'ATK_PARAM_ST',
          entryName: 'AtkParam_Npc.param',
          rowId: 71000100,
          sourceUri: 'file:///fixture/gameparam.parambnd.dcx',
          sourceHash: 'atk-native-hash'
        }
      }]
    }
  });
  assert.equal(
    (await gateway.assertParamReadTarget({ table: 'ATK_PARAM_ST', rowIds: [71000100] })).ok,
    true,
    '搜索返回的 native PARAM type 身份应允许同 row 读取'
  );
  assert.equal(
    (await gateway.assertParamReadTarget({ table: 'AtkParam_Npc', rowIds: [71000100] })).ok,
    true,
    '搜索结果明确返回的物理 entryName 应允许同 row 读取'
  );
  const atkPc = await gateway.assertParamReadTarget({ table: 'AtkParam_Pc', rowIds: [71000100] });
  assert.equal(atkPc.ok, false, '共享 ATK_PARAM_ST type 不得猜测授权 AtkParam_Pc');
  assert.equal(atkPc.code, 'TASK_RECORD_PARAM_ROW_UNRESOLVED');
  assert.ok(atkTicket.searchId);

  // An outer result/container identity must not leak into a nested row that
  // explicitly names a different physical entry.  This catches accidental
  // parent-scope union when walking nested search envelopes.
  const nestedGateway = createAgentTaskRecordGateway(root, 'nested-entry-scope-smoke');
  await nestedGateway.recordSearch({
    toolName: 'search_param_rows',
    query: 'nested attack',
    result: {
      table: 'AtkParam_Pc',
      results: [{
        paramName: 'ATK_PARAM_ST',
        entryName: 'AtkParam_Npc.param',
        rowId: 71000100
      }]
    }
  });
  assert.equal(
    (await nestedGateway.assertParamReadTarget({ table: 'AtkParam_Npc', rowIds: [71000100] })).ok,
    true,
    'nested row 的明确 entryName 应保留为真实身份'
  );
  const nestedPc = await nestedGateway.assertParamReadTarget({ table: 'AtkParam_Pc', rowIds: [71000100] });
  assert.equal(nestedPc.ok, false, '父级 AtkParam_Pc 不能污染子 row 的物理 entry 身份');
  assert.equal(nestedPc.code, 'TASK_RECORD_PARAM_ROW_UNRESOLVED');

  const textIdAsRow = await gateway.assertParamReadTarget({ table: 'EquipParamGoods', rowIds: [3504] });
  assert.equal(textIdAsRow.ok, false, 'FMG/text id 不得被当作 EquipParamGoods 行号');
  assert.equal(textIdAsRow.code, 'TASK_RECORD_PARAM_ROW_UNRESOLVED');

  await assert.rejects(
    () => gateway.update({
      objectName: '义父的铃铛',
      propertyKey: 'EquipParamGoods',
      value: 'rowId=3080',
      evidence: ['EquipParamGoods#3080 fieldId=nameId'],
      searchId: ticket.searchId,
      mutationBudget: 2
    }),
    (error) => error?.code === 'TASK_RECORD_MUTATION_BUDGET_INVALID',
    '模型不能自行扩大 Evidence 写入预算'
  );

  await gateway.update({
    objectName: '义父的铃铛',
    propertyKey: 'EquipParamGoods',
    value: 'rowId=3080',
    evidence: ['EquipParamGoods#3080 fieldId=nameId'],
    searchId: ticket.searchId,
    mutationBudget: 1
  });
  const candidateWrite = await gateway.assertMutationTarget('mutate_param_fields', {
    edits: [{ table: 'EquipParamGoods', rowId: 3080, fieldId: 'nameId', value: 1 }]
  });
  assert.equal(candidateWrite.ok, false, 'candidate Evidence 不得直接授权写入');
  assert.equal(candidateWrite.code, 'TASK_RECORD_NATIVE_PROOF_REQUIRED');
  assert.deepEqual(candidateWrite.details.target, {
    resourceKind: 'param',
    table: 'EquipParamGoods',
    rowId: 3080,
    fieldId: 'nameId'
  });
  assert.deepEqual(candidateWrite.details.requiredRead, {
    table: 'EquipParamGoods',
    rowIds: [3080],
    fieldIds: ['nameId']
  });
  assert.equal(candidateWrite.details.nativeProofState, 'candidate');
  assert.match(candidateWrite.message, /EquipParamGoods#3080\.nameId/u);
  await gateway.recordNativeParamRead(
    { table: 'EquipParamGoods', rowIds: [3080], fieldIds: ['nameId'] },
    { fields: [{ table: 'EquipParamGoods', rowId: 3080, fieldId: 'nameId', value: 3504, sourceHash: 'native-hash', sourceRevision: 1 }] }
  );
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
  const fieldDiscoveryContext = { workspaceIndex: null, mode: 'fullPermission', taskRecord: gateway, requireTaskRecord: true };
  const guessedFieldRow = await registry.run('search_param_fields', {
    table: 'EquipParamGoods', rowIds: [3504], query: 'name'
  }, fieldDiscoveryContext);
  assert.equal(guessedFieldRow.ok, false);
  assert.equal(guessedFieldRow.error.code, 'TASK_RECORD_PARAM_ROW_UNRESOLVED', '字段查询也必须拒绝未经搜索确认的猜测行号');
  const resolvedFieldRow = await registry.run('search_param_fields', {
    table: 'EquipParamGoods', rowIds: [3080], query: 'name'
  }, fieldDiscoveryContext);
  assert.equal(resolvedFieldRow.error.code, 'WORKSPACE_REQUIRED', '已观测行应通过身份校验并到达原生读取层（此fixture不打开工作区）');
  const taskRecordTool = registry.list().find((tool) => tool.name === 'update_agent_task_record');
  assert.ok(taskRecordTool, '生产注册表必须暴露任务台账更新工具');
  assert.match(taskRecordTool.description, /propertyKey 必须精确为 target/u);
  assert.match(taskRecordTool.description, /propertyKey 使用真实表名/u);
  assert.match(taskRecordTool.description, /SpEffectParam/u);
  assert.match(taskRecordTool.description, /只读对照对象/u);
  const evidenceSchema = toolInputShapeToJsonSchema(taskRecordTool.inputSchema).properties.evidence;
  assert.equal(evidenceSchema.type, 'array');
  assert.equal(evidenceSchema.items.type, 'string', '模型必须看到 evidence 元素为字符串，不能再猜对象数组');
  const evidenceUpdates = [];
  const evidenceInputContext = {
    mode: 'fullPermission',
    requireTaskRecord: true,
    taskRecord: {
      update: async (input) => {
        evidenceUpdates.push(input);
        return { path: '', entries: [], updatedAt: null };
      }
    }
  };
  // Exact shape emitted repeatedly by testset 1-3: the useful diagnostic is
  // the element path, not a misleading missing searchId/mutationBudget error.
  const evidenceInput = {
    objectName: '鬼刑部',
    propertyKey: 'npcparam',
    value: 'NpcParam 50800000 ninsatuNum to 2',
    kind: 'evidence',
    status: 'candidate',
    mutationBudget: 1,
    searchId: 'search-schema-fixture',
    evidence: [{ fieldId: 'ninsatuNum', rowId: 50800000, table: 'NpcParam' }]
  };
  for (const [evidence, badIndex] of [
    [evidenceInput.evidence, 0],
    [['NpcParam#50800000 fieldId=ninsatuNum', evidenceInput.evidence[0]], 1],
    [['   '], 0]
  ]) {
    const invalidEvidence = await registry.run('update_agent_task_record', {
      ...evidenceInput,
      evidence
    }, evidenceInputContext);
    assert.equal(invalidEvidence.ok, false);
    assert.equal(invalidEvidence.error.code, 'INVALID_INPUT');
    assert.ok(invalidEvidence.error.message.includes(`evidence[${badIndex}]`),
      '错误必须指出实际不合规的数组元素，使模型能修复参数');
  }
  assert.equal(evidenceUpdates.length, 0, '元素类型或内容不合法时不得进入 gateway，不能静默过滤');
  const validEvidence = await registry.run('update_agent_task_record', {
    ...evidenceInput,
    evidence: ['NpcParam#50800000 fieldId=ninsatuNum']
  }, evidenceInputContext);
  assert.equal(validEvidence.ok, true);
  assert.equal(evidenceUpdates.length, 1);
  assert.deepEqual(evidenceUpdates[0].evidence, ['NpcParam#50800000 fieldId=ninsatuNum']);
  assert.equal(evidenceUpdates[0].searchId, evidenceInput.searchId);
  assert.equal(evidenceUpdates[0].mutationBudget, 1);
  assert.equal(
    registry.list().some((tool) => tool.name === 'rollback_agent_task_record_mutation'),
    false,
    '模型可见工具不得允许自行退回台账写预算'
  );
  const searchCalls = [];
  const integrationGateway = {
    beforeSearch: async (input) => { searchCalls.push(['beforeSearch', input]); return { ok: true }; },
    recordSearch: async (input) => {
      searchCalls.push(['recordSearch', input]);
      return { searchId: 'search-integration', toolName: input.toolName, query: input.query };
    },
    recordNativeParamRead: async () => ({ path: '', entries: [], updatedAt: null }),
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

  // Exercise target -> real search ticket -> derived target through the
  // registry. Calling gateway.update directly would miss searchId stripping.
  const derivedGateway = createAgentTaskRecordGateway(root, 'derived-registry-smoke', {
    frozenRequest: '把义父的铃铛设置为奖励'
  });
  const derivedContext = { ...integrationContext, taskRecord: derivedGateway };
  const declaredTarget = await registry.run('update_agent_task_record', {
    objectName: '义父的铃铛', propertyKey: 'target', value: '用户指定奖励', kind: 'target'
  }, derivedContext);
  assert.equal(declaredTarget.ok, true);
  const derivedSearch = await registry.run('search_param_rows', {
    query: '义父的铃铛', paramNames: ['EquipParamGoods']
  }, derivedContext);
  assert.equal(derivedSearch.ok, true);
  const derivedTargetInput = {
    objectName: '义父的守护铃', propertyKey: 'target', value: '搜索返回的规范奖励名称', kind: 'target'
  };
  const missingDerivedTicket = await registry.run('update_agent_task_record', derivedTargetInput, derivedContext);
  assert.equal(missingDerivedTicket.ok, false);
  assert.equal(missingDerivedTicket.error.code, 'TASK_RECORD_TARGET_OUTSIDE_FROZEN_REQUEST');
  const derivedTarget = await registry.run('update_agent_task_record', {
    ...derivedTargetInput, searchId: derivedSearch.data.searchId
  }, derivedContext);
  assert.equal(derivedTarget.ok, true, '规范 target 的真实 searchId 必须经过 registry 到达真实 gateway');
  const derivedSnapshot = await derivedGateway.read();
  const derivedEntry = derivedSnapshot.entries.find((entry) => entry.objectName === derivedTargetInput.objectName);
  assert.ok(derivedEntry);
  assert.equal(derivedEntry.searchId, derivedSearch.data.searchId);
  assert.equal(derivedEntry.mutationBudget, 0, '派生 target 的搜索凭据不授予写入预算');
  const forgedDerivedTarget = await registry.run('update_agent_task_record', {
    objectName: '蝴蝶夫人', propertyKey: 'target', value: '未命中的新对象', kind: 'target',
    searchId: derivedSearch.data.searchId
  }, derivedContext);
  assert.equal(forgedDerivedTarget.ok, false, '透传 searchId 不得跳过票据与对象关系验证');
  assert.equal(forgedDerivedTarget.error.code, 'TASK_RECORD_TARGET_OUTSIDE_FROZEN_REQUEST');
  await derivedGateway.read();

  // A search_events ticket carries a structured sourceUri+eventId receipt in
  // parallel with the bounded resultText projection.  Keep the event target
  // after the 4,000-character projection boundary so this exercises the
  // actual registry -> gateway path rather than a direct helper call.
  const eventSourceUri = 'file://event/m11_00_00_00.emevd.dcx';
  const emevdGateway = createAgentTaskRecordGateway(root, 'derived-emevd-registry-smoke', {
    frozenRequest: '把鬼刑部改为精英怪并设置靛蓝星陨掉落'
  });
  const emevdIndex = {
    searchEvents: () => [
      {
        eventId: 11105800,
        sourceUri: eventSourceUri,
        padding: 'x'.repeat(3_900)
      },
      { eventId: 11105810, sourceUri: eventSourceUri },
      { eventId: 11105811, sourceUri: eventSourceUri }
    ]
  };
  const emevdContext = {
    workspaceIndex: emevdIndex,
    mode: 'fullPermission',
    taskRecord: emevdGateway,
    requireTaskRecord: true
  };
  const emevdUserTarget = await registry.run('update_agent_task_record', {
    objectName: '鬼刑部', propertyKey: 'target', value: '用户指定对象', kind: 'target'
  }, emevdContext);
  assert.equal(emevdUserTarget.ok, true);
  const emevdSearch = await registry.run('search_events', { query: '111058' }, emevdContext);
  assert.equal(emevdSearch.ok, true);
  assert.ok(emevdSearch.data.searchId);
  await emevdGateway.read();
  const emevdLedger = await readFile(join(root, 'derived-emevd-registry-smoke.md'), 'utf8');
  const emevdTicketLine = emevdLedger.split(/\r?\n/u).find((line) => line.startsWith('<!-- soulforge-search-ticket '));
  assert.ok(emevdTicketLine, 'actual gateway 应持久化 search_events ticket');
  const emevdTicket = JSON.parse(emevdTicketLine.slice('<!-- soulforge-search-ticket '.length, -4));
  assert.equal(emevdTicket.resultText.length, 4_000, '截断复现必须保留 4,000 字符上限');
  assert.equal(emevdTicket.resultText.includes('11105810'), false, '11105810 必须位于 resultText 截断边界之后');
  assert.ok(
    emevdTicket.emevdTargets.some((target) => (
      target.sourceUri === eventSourceUri && target.eventId === 11105810
    )),
    '结构化 emevdTargets 必须保留截断文本之外的精确 event 身份'
  );
  const structuredEmevdTarget = await registry.run('update_agent_task_record', {
    objectName: '11105810',
    propertyKey: 'target',
    value: 'search_events 返回的精确 eventId 候选',
    kind: 'target',
    searchId: emevdSearch.data.searchId
  }, emevdContext);
  assert.equal(
    structuredEmevdTarget.ok,
    true,
    'resultText 截断后，search_events 的结构化 sourceUri+eventId 仍应允许精确候选登记'
  );
  const conflictingEventHint = await registry.run('update_agent_task_record', {
    objectName: '11105811',
    propertyKey: 'target',
    value: 'eventId=11105810 与 objectName 冲突',
    kind: 'target',
    searchId: emevdSearch.data.searchId
  }, emevdContext);
  assert.equal(conflictingEventHint.ok, false);
  assert.equal(conflictingEventHint.error.code, 'TASK_RECORD_TARGET_OUTSIDE_FROZEN_REQUEST');
  const conflictingSourceHint = await registry.run('update_agent_task_record', {
    objectName: '11105811',
    propertyKey: 'target',
    value: `sourceUri=${eventSourceUri} sourceUri=file://event/other.emevd.dcx`,
    kind: 'target',
    searchId: emevdSearch.data.searchId
  }, emevdContext);
  assert.equal(conflictingSourceHint.ok, false);
  assert.equal(conflictingSourceHint.error.code, 'TASK_RECORD_TARGET_OUTSIDE_FROZEN_REQUEST');
  const nonExistingEmevdTarget = await registry.run('update_agent_task_record', {
    objectName: '11105812',
    propertyKey: 'target',
    value: '不存在于结构化搜索结果的 eventId',
    kind: 'target',
    searchId: emevdSearch.data.searchId
  }, emevdContext);
  assert.equal(nonExistingEmevdTarget.ok, false);
  assert.equal(nonExistingEmevdTarget.error.code, 'TASK_RECORD_TARGET_OUTSIDE_FROZEN_REQUEST');
  const multiIdObjectName = await registry.run('update_agent_task_record', {
    objectName: '11105810,11105811',
    propertyKey: 'target',
    value: '不得把多个 eventId 合并成一个候选对象',
    kind: 'target',
    searchId: emevdSearch.data.searchId
  }, emevdContext);
  assert.equal(multiIdObjectName.ok, false);
  assert.equal(multiIdObjectName.error.code, 'TASK_RECORD_TARGET_OUTSIDE_FROZEN_REQUEST');

  const ambiguousEmevdGateway = createAgentTaskRecordGateway(root, 'ambiguous-emevd-registry-smoke', {
    frozenRequest: '把鬼刑部改为精英怪并设置靛蓝星陨掉落'
  });
  const ambiguousEmevdContext = {
    workspaceIndex: {
      searchEvents: () => [
        { eventId: 11105820, sourceUri: 'file://event/m11_00_00_00.emevd.dcx' },
        { eventId: 11105820, sourceUri: 'file://event/m12_00_00_00.emevd.dcx' }
      ]
    },
    mode: 'fullPermission',
    taskRecord: ambiguousEmevdGateway,
    requireTaskRecord: true
  };
  const ambiguousUserTarget = await registry.run('update_agent_task_record', {
    objectName: '鬼刑部', propertyKey: 'target', value: '用户指定对象', kind: 'target'
  }, ambiguousEmevdContext);
  assert.equal(ambiguousUserTarget.ok, true);
  const ambiguousSearch = await registry.run('search_events', { query: '11105820' }, ambiguousEmevdContext);
  assert.equal(ambiguousSearch.ok, true);
  const ambiguousTarget = await registry.run('update_agent_task_record', {
    objectName: '11105820',
    propertyKey: 'target',
    value: '同 eventId 多 sourceUri 时不得猜文件',
    kind: 'target',
    searchId: ambiguousSearch.data.searchId
  }, ambiguousEmevdContext);
  assert.equal(ambiguousTarget.ok, false);
  assert.equal(ambiguousTarget.error.code, 'TASK_RECORD_TARGET_OUTSIDE_FROZEN_REQUEST');
  const explicitSourceTarget = await registry.run('update_agent_task_record', {
    objectName: '11105820',
    propertyKey: 'target',
    value: 'sourceUri=file://event/m12_00_00_00.emevd.dcx',
    kind: 'target',
    searchId: ambiguousSearch.data.searchId
  }, ambiguousEmevdContext);
  assert.equal(
    explicitSourceTarget.ok,
    true,
    '同 eventId 多 sourceUri 时，明确 sourceUri 才能登记精确候选'
  );

  const emevdEvidence = await registry.run('update_agent_task_record', {
    objectName: '11105810',
    propertyKey: 'emevd',
    value: `eventId=11105810 sourceUri=${eventSourceUri}`,
    kind: 'evidence',
    status: 'candidate',
    evidence: [`eventId=11105810 sourceUri=${eventSourceUri}`],
    searchId: emevdSearch.data.searchId,
    mutationBudget: 1
  }, emevdContext);
  assert.equal(emevdEvidence.ok, true, '结构化 event 候选登记后应允许登记 candidate Evidence');
  const emevdWriteWithoutProof = await emevdGateway.assertMutationTarget(
    'apply_emevd_dsl',
    { file: 'm11_00_00_00.emevd.dcx', scope: 'event' },
    {
      sourceUri: eventSourceUri,
      sourcePath: 'D:/fixture/m11_00_00_00.emevd.dcx',
      eventId: 11105810
    }
  );
  assert.equal(emevdWriteWithoutProof.ok, false);
  assert.equal(emevdWriteWithoutProof.code, 'TASK_RECORD_NATIVE_PROOF_REQUIRED');

  const freeTextEmevdGateway = createAgentTaskRecordGateway(root, 'free-text-emevd-registry-smoke', {
    frozenRequest: '把鬼刑部改为精英怪并设置靛蓝星陨掉落'
  });
  const freeTextEmevdContext = {
    workspaceIndex: {
      searchEvents: () => [{ description: '文本提到了 eventId=11105830，但没有结构化 eventId/sourceUri' }]
    },
    mode: 'fullPermission',
    taskRecord: freeTextEmevdGateway,
    requireTaskRecord: true
  };
  const freeTextUserTarget = await registry.run('update_agent_task_record', {
    objectName: '鬼刑部', propertyKey: 'target', value: '用户指定对象', kind: 'target'
  }, freeTextEmevdContext);
  assert.equal(freeTextUserTarget.ok, true);
  const freeTextSearch = await registry.run('search_events', { query: '11105830' }, freeTextEmevdContext);
  assert.equal(freeTextSearch.ok, true);
  const freeTextTarget = await registry.run('update_agent_task_record', {
    objectName: '11105830',
    propertyKey: 'target',
    value: '自由文本不能授权 eventId 候选',
    kind: 'target',
    searchId: freeTextSearch.data.searchId
  }, freeTextEmevdContext);
  assert.equal(freeTextTarget.ok, false);
  assert.equal(freeTextTarget.error.code, 'TASK_RECORD_TARGET_OUTSIDE_FROZEN_REQUEST');

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

  const frozenGateway = createAgentTaskRecordGateway(root, 'frozen-smoke', {
    frozenRequest: '把鬼刑部改为精英怪并设置靛蓝星陨掉落'
  });
  const searchBeforeTarget = await frozenGateway.beforeSearch({ toolName: 'search_param_rows', query: '鬼刑部' });
  assert.equal(searchBeforeTarget.ok, false, '冻结请求下不能在无 target 时任意搜索');
  assert.equal(searchBeforeTarget.code, 'TASK_RECORD_TARGET_REQUIRED');
  await assert.rejects(
    () => frozenGateway.update({ objectName: '蝴蝶夫人', propertyKey: 'target', value: '越界对象', kind: 'target' }),
    (error) => error?.code === 'TASK_RECORD_TARGET_OUTSIDE_FROZEN_REQUEST',
    '模型不能创建用户请求之外的初始 target'
  );
  await frozenGateway.update({ objectName: '鬼刑部', propertyKey: 'target', value: '用户目标', kind: 'target' });
  assert.equal(
    (await frozenGateway.beforeSearch({ toolName: 'search_param_rows', query: '鬼刑部' })).ok,
    true,
    '逐字来自冻结请求的 target 应开放后续搜索'
  );
  const gyoubuAliasTicket = await frozenGateway.recordSearch({
    toolName: 'search_param_rows',
    query: '鬼刑部',
    result: {
      results: [{
        item: {
          paramName: 'NPC_PARAM_ST',
          rowId: 50800000,
          rowName: '【鬼形部',
          sourceHash: 'alias-native-search-hash'
        }
      }]
    }
  });
  await frozenGateway.update({
    objectName: '鬼刑部',
    propertyKey: 'npcparam',
    value: 'NPC_PARAM_ST rowId=50800000 fieldId=ninsatuNum',
    kind: 'evidence',
    status: 'candidate',
    evidence: ['原生 rowName=【鬼形部；仅对象名比较允许已知异体字'],
    searchId: gyoubuAliasTicket.searchId,
    mutationBudget: 1
  });
  assert.equal(
    (await frozenGateway.assertParamReadTarget({ table: 'NpcParam', rowIds: [50800000] })).ok,
    true,
    '用户称呼鬼刑部应只在对象名比较层匹配原生 rowName 鬼形部'
  );
  await assert.rejects(
    () => frozenGateway.update({
      objectName: '鬼刑部',
      propertyKey: 'NpcParam',
      value: 'rowId=50800000',
      kind: 'evidence',
      status: 'verified',
      evidence: ['NpcParam#50800000 fieldId=ninsatuNum'],
      searchId: 'forged-search',
      mutationBudget: 1
    }),
    (error) => error?.code === 'TASK_RECORD_VERIFIED_HOST_ONLY',
    '模型不能自行把 Evidence 标成 verified'
  );

  // 承接测试：验证多轮对话跨轮时，子会话通过 inheritFromSessionId 继承父会话的 ticket 与 evidence
  const childGateway = createAgentTaskRecordGateway(root, 'child-smoke', { inheritFromSessionId: 'gate-smoke' });
  await childGateway.read();

  // 子会话能够使用父会话搜索票据直接登记新的 Evidence
  await childGateway.update({
    objectName: '义父的铃铛',
    propertyKey: 'EquipParamGoods',
    value: 'rowId=3080 child-round',
    evidence: ['EquipParamGoods#3080 fieldId=nameId child'],
    searchId: ticket.searchId,
    mutationBudget: 1
  });
  await childGateway.recordNativeParamRead(
    { table: 'EquipParamGoods', rowIds: [3080], fieldIds: ['nameId'] },
    { fields: [{ table: 'EquipParamGoods', rowId: 3080, fieldId: 'nameId', value: 3504, sourceHash: 'child-native-hash', sourceRevision: 2 }] }
  );

  const childWriteAssert = await childGateway.assertMutationTarget('mutate_param_fields', {
    edits: [{ table: 'EquipParamGoods', rowId: 3080, fieldId: 'nameId', value: 1 }]
  });
  assert.equal(childWriteAssert.ok, true, '子会话继承父会话 SearchTicket 后仍须完成本轮原生读取，才能开放写入门禁');
  await childGateway.releaseMutationReservation(childWriteAssert.reservationId);
  await childGateway.read();

  // A verified entry is a grouping label, not permission for every field in
  // its text. Reproduce the prior hp -> unread itemLotId_1 authorization bug.
  const proofGateway = createAgentTaskRecordGateway(root, 'field-proof-smoke');
  await proofGateway.update({
    objectName: 'proof-target', propertyKey: 'target', value: '测试修改目标', kind: 'target'
  });
  const proofTicket = await proofGateway.recordSearch({
    toolName: 'search_param_rows', query: 'proof-target',
    result: { items: [{ table: 'NpcParam', rowId: 50800000, rowName: 'proof-target' }] }
  });
  const registerProofEvidence = async (fieldIds) => proofGateway.update({
    objectName: 'proof-target', propertyKey: 'NpcParam', value: 'NpcParam#50800000',
    kind: 'evidence', evidence: [`NpcParam#50800000 fieldIds=${fieldIds.join(',')}`],
    searchId: proofTicket.searchId, mutationBudget: 1
  });
  const proofQuery = (fieldIds) => ({ table: 'NpcParam', rowIds: [50800000], fieldIds });
  const proofResult = (fieldIds, sourceHash = 'proof-hash-a', sourceRevision = 1) => ({
    fields: fieldIds.map((fieldId) => ({
      table: 'NpcParam', rowId: 50800000, fieldId, value: 100, sourceHash, sourceRevision
    }))
  });
  const checkProofWrite = (targetGateway, fieldId) => targetGateway.assertMutationTarget('mutate_param_fields', {
    edits: [{ table: 'NpcParam', rowId: 50800000, fieldId, value: 200 }]
  });
  const assertProofWriteAllowed = async (targetGateway, fieldId, message) => {
    const decision = await checkProofWrite(targetGateway, fieldId);
    assert.equal(decision.ok, true, message);
    await targetGateway.releaseMutationReservation(decision.reservationId);
  };
  const assertProofWriteDenied = async (targetGateway, fieldId, message) => {
    const decision = await checkProofWrite(targetGateway, fieldId);
    assert.equal(decision.ok, false, message);
    assert.equal(decision.code, 'TASK_RECORD_NATIVE_PROOF_REQUIRED', message);
    return decision;
  };
  await registerProofEvidence(['hp', 'itemLotId_1']);
  const noRevisionResult = proofResult(['hp']);
  delete noRevisionResult.fields[0].sourceRevision;
  for (const invalidProof of [noRevisionResult, proofResult(['hp'], 'proof-hash-a', Number.NaN)]) {
    await assert.rejects(
      () => proofGateway.recordNativeParamRead(proofQuery(['hp']), invalidProof),
      (error) => error?.code === 'TASK_RECORD_NATIVE_PROOF_TARGET_MISSING',
      '缺失或非有限 sourceRevision 的字段不得成为原生写入证明'
    );
  }
  assert.equal((await proofGateway.read()).entries.find((entry) => entry.kind === 'evidence').status, 'candidate');
  await assertProofWriteDenied(proofGateway, 'hp', '来源身份不完整时必须保持无写入权限');
  await assert.rejects(
    () => proofGateway.recordNativeParamRead(proofQuery(['hp']), proofResult(['itemLotId_1'])),
    (error) => error?.code === 'TASK_RECORD_NATIVE_PROOF_TARGET_MISSING',
    '返回值混入本次未请求的字段时不得为其登记证明'
  );
  await proofGateway.recordNativeParamRead(proofQuery(['hp']), proofResult(['hp']));
  await assertProofWriteDenied(proofGateway, 'itemLotId_1', '仅读 hp 不能授权同一 verified entry 内未读的掉落字段');
  await assertProofWriteAllowed(proofGateway, 'hp', '精确原生读取的字段应允许进入写入门禁');
  await proofGateway.recordNativeParamRead(proofQuery(['itemLotId_1']), proofResult(['itemLotId_1']));
  await assertProofWriteAllowed(proofGateway, 'itemLotId_1', '同一来源补读掉落字段后应允许该字段写入');
  await proofGateway.read();

  const inheritedProofGateway = createAgentTaskRecordGateway(root, 'inherited-field-proof-smoke', {
    inheritFromSessionId: 'field-proof-smoke'
  });
  const inheritedProofSnapshot = await inheritedProofGateway.read();
  assert.ok(inheritedProofSnapshot.entries.some((entry) => entry.kind === 'evidence' && entry.status === 'verified'));
  await assertProofWriteDenied(inheritedProofGateway, 'hp', '继承的 verified 文本不能替代当前 session 原生证明');
  await inheritedProofGateway.recordNativeParamRead(proofQuery(['hp']), proofResult(['hp']));
  await assertProofWriteAllowed(inheritedProofGateway, 'hp', '继承会话完成当前原生读取后才能写入');
  await inheritedProofGateway.read();

  await proofGateway.recordNativeParamRead(proofQuery(['itemLotId_1']), proofResult(['itemLotId_1'], 'proof-hash-b', 1));
  await assertProofWriteDenied(proofGateway, 'hp', '表 sourceHash 变化必须失效旧 hp 证明');
  await assertProofWriteAllowed(proofGateway, 'itemLotId_1', '新 sourceHash 下刚读取的字段仍可写入');
  await proofGateway.recordNativeParamRead(proofQuery(['hp']), proofResult(['hp'], 'proof-hash-b', 2));
  await assertProofWriteDenied(proofGateway, 'itemLotId_1', 'sourceRevision 变化即使 hash 不变也必须失效旧证明');
  await assertProofWriteAllowed(proofGateway, 'hp', '新 revision 下刚读取的字段仍可写入');

  // Keep the second entry unused so a rejection after finalize proves receipt
  // invalidation, rather than merely exhausting the first entry's budget.
  await registerProofEvidence(['itemLotId_1']);
  await proofGateway.recordNativeParamRead(proofQuery(['hp', 'itemLotId_1']), proofResult(['hp', 'itemLotId_1'], 'proof-hash-b', 2));
  const committedProofWrite = await checkProofWrite(proofGateway, 'hp');
  assert.equal(committedProofWrite.ok, true);
  await proofGateway.finalizeMutation(committedProofWrite.reservationId);
  const finalizedLedger = await proofGateway.read();
  assert.equal(
    finalizedLedger.entries.find((entry) => entry.propertyKey === 'NpcParam')?.status,
    'verified',
    'finalize 清掉 host proof 时不能把持久化 ledger 的 verified 标签降回 candidate'
  );
  const missingAfterFinalize = await assertProofWriteDenied(
    proofGateway,
    'itemLotId_1',
    '一次写入完成后，其他未耗尽 entry 的旧原生证明也必须重读'
  );
  assert.deepEqual(missingAfterFinalize.details.target, {
    resourceKind: 'param',
    table: 'NpcParam',
    rowId: 50800000,
    fieldId: 'itemLotId_1'
  });
  assert.deepEqual(missingAfterFinalize.details.requiredRead, {
    table: 'NpcParam',
    rowIds: [50800000],
    fieldIds: ['itemLotId_1']
  });
  assert.equal(missingAfterFinalize.details.nativeProofState, 'verified_missing_native_proof');
  assert.match(missingAfterFinalize.message, /NpcParam#50800000\.itemLotId_1/u);
  await proofGateway.recordNativeParamRead(proofQuery(['itemLotId_1']), proofResult(['itemLotId_1'], 'proof-hash-c', 3));
  await assertProofWriteAllowed(proofGateway, 'itemLotId_1', '提交后使用新来源重读可以恢复未耗尽 entry 的精确字段权限');
  await proofGateway.read();
  await frozenGateway.read();

  // A persisted verified label does not preserve a host proof after a commit.
  // Reproduce the three-row Bullet case: all rows are first read at the old
  // identity, the commit clears receipts, only 750300/750302 are reread, and
  // a batch must identify 750301 without consuming any mutation budget.
  const bulletGateway = createAgentTaskRecordGateway(root, 'bullet-proof-diagnostic-smoke');
  await bulletGateway.update({
    objectName: '绣丸', propertyKey: 'target', value: '绣丸连招子弹', kind: 'target'
  });
  const bulletSearch = await bulletGateway.recordSearch({
    toolName: 'search_param_rows',
    query: '绣丸 Bullet',
    result: {
      items: [
        { item: { table: 'Bullet', rowId: 750300, rowName: '绣丸1' } },
        { item: { table: 'Bullet', rowId: 750301, rowName: '绣丸2' } },
        { item: { table: 'Bullet', rowId: 750302, rowName: '绣丸3' } },
        { item: { table: 'SpEffectParam', rowId: 9027, rowName: '超猛毒' } }
      ]
    }
  });
  const registerBulletEvidence = async (propertyKey, value, evidence) => bulletGateway.update({
    objectName: '绣丸', propertyKey, value, kind: 'evidence', evidence,
    searchId: bulletSearch.searchId, mutationBudget: 1
  });
  await registerBulletEvidence('Bullet_750300', 'Bullet#750300', ['Bullet#750300 fieldId=spEffectId0']);
  await registerBulletEvidence('Bullet_750301', 'Bullet#750301', ['Bullet#750301 fieldId=spEffectId0']);
  await registerBulletEvidence('Bullet_750302', 'Bullet#750302', ['Bullet#750302 fieldId=spEffectId0']);
  await registerBulletEvidence('SpEffectParam', 'SpEffectParam#9027', ['SpEffectParam#9027 fieldId=poizonAttackPower']);
  const bulletQuery = { table: 'Bullet', rowIds: [750300, 750301, 750302], fieldIds: ['spEffectId0'] };
  const bulletFields = (rowIds, sourceRevision) => ({
    fields: rowIds.map((rowId) => ({
      table: 'Bullet', rowId, fieldId: 'spEffectId0', value: 9039,
      sourceHash: 'bullet-source-hash', sourceRevision
    }))
  });
  await bulletGateway.recordNativeParamRead(bulletQuery, bulletFields([750300, 750301, 750302], 1));
  await bulletGateway.recordNativeParamRead(
    { table: 'SpEffectParam', rowIds: [9027], fieldIds: ['poizonAttackPower'] },
    { fields: [{ table: 'SpEffectParam', rowId: 9027, fieldId: 'poizonAttackPower', value: 162, sourceHash: 'effect-source-hash', sourceRevision: 1 }] }
  );
  const controlReservation = await bulletGateway.assertMutationTarget('mutate_param_fields', {
    edits: [{ table: 'SpEffectParam', rowId: 9027, fieldId: 'poizonAttackPower', value: 200 }]
  });
  assert.equal(controlReservation.ok, true);
  await bulletGateway.finalizeMutation(controlReservation.reservationId);
  await bulletGateway.recordNativeParamRead(
    { table: 'Bullet', rowIds: [750300, 750302], fieldIds: ['spEffectId0'] },
    bulletFields([750300, 750302], 2)
  );
  await registerBulletEvidence('Bullet_750301', 'Bullet#750301 refreshed candidate', ['Bullet#750301 fieldId=spEffectId0 refreshed candidate']);
  const mixedBulletEntries = (await bulletGateway.read()).entries
    .filter((entry) => entry.propertyKey === 'Bullet_750301');
  assert.deepEqual(
    mixedBulletEntries.map((entry) => entry.status),
    ['verified', 'candidate'],
    '同一目标应同时保留旧 verified entry 与新 candidate entry'
  );
  const bulletBatchInput = {
    edits: [
      { table: 'Bullet', rowId: 750300, fieldId: 'spEffectId0', value: 9027 },
      { table: 'Bullet', rowId: 750301, fieldId: 'spEffectId0', value: 9027 },
      { table: 'Bullet', rowId: 750302, fieldId: 'spEffectId0', value: 9027 }
    ]
  };
  const bulletBatchDenied = await bulletGateway.assertMutationTarget('mutate_param_fields', bulletBatchInput);
  assert.equal(bulletBatchDenied.ok, false);
  assert.equal(bulletBatchDenied.code, 'TASK_RECORD_NATIVE_PROOF_REQUIRED');
  assert.deepEqual(bulletBatchDenied.details.target, {
    resourceKind: 'param',
    table: 'Bullet',
    rowId: 750301,
    fieldId: 'spEffectId0'
  });
  assert.deepEqual(bulletBatchDenied.details.requiredRead, {
    table: 'Bullet',
    rowIds: [750301],
    fieldIds: ['spEffectId0']
  });
  assert.equal(bulletBatchDenied.details.nativeProofState, 'verified_missing_native_proof');
  assert.match(bulletBatchDenied.message, /Bullet#750301\.spEffectId0/u);
  const bulletAfterDenied = await bulletGateway.read();
  assert.deepEqual(
    bulletAfterDenied.entries
      .filter((entry) => /^Bullet_75030[012]$/u.test(entry.propertyKey))
      .map((entry) => entry.mutationUsed),
    [0, 0, 0, 0],
    '批量拒绝时不得消耗已通过行的 mutationBudget'
  );
  await bulletGateway.recordNativeParamRead(
    { table: 'Bullet', rowIds: [750301], fieldIds: ['spEffectId0'] },
    bulletFields([750301], 2)
  );
  const bulletBatchAllowed = await bulletGateway.assertMutationTarget('mutate_param_fields', bulletBatchInput);
  assert.equal(bulletBatchAllowed.ok, true, '补读精确 750301 后三行批量门禁应通过');
  await bulletGateway.releaseMutationReservation(bulletBatchAllowed.reservationId);

  // 事件（emevd）与脚本（script/luabnd）为无限修改：verified 后同条 Evidence 可反复预留。
  const unlimitedGateway = createAgentTaskRecordGateway(root, 'unlimited-emevd-script', {
    frozenRequest: '修改目标敌人事件并更新 AI 脚本'
  });
  await unlimitedGateway.update({
    objectName: '目标敌人',
    propertyKey: 'target',
    value: '用户要求修改事件与脚本',
    kind: 'target'
  });
  const unlimitedTicket = await unlimitedGateway.recordSearch({
    toolName: 'search_events',
    query: '目标敌人',
    result: {
      items: [{
        item: {
          eventId: 11105810,
          sourceUri: 'file://event/m11_00_00_00.emevd.dcx',
          name: '目标敌人'
        }
      }]
    }
  });
  await unlimitedGateway.update({
    objectName: '目标敌人',
    propertyKey: 'emevd',
    value: 'sourceUri=file://event/m11_00_00_00.emevd.dcx eventId=11105810',
    kind: 'evidence',
    evidence: ['sourceUri=file://event/m11_00_00_00.emevd.dcx eventId=11105810'],
    searchId: unlimitedTicket.searchId,
    mutationBudget: 1
  });
  const scriptTicket = await unlimitedGateway.recordSearch({
    toolName: 'list_luabnd_scripts',
    query: '目标敌人',
    result: { items: [{ item: { name: '目标敌人', script: 'script' } }] }
  });
  await unlimitedGateway.update({
    objectName: '目标敌人',
    propertyKey: 'script',
    value: 'luabnd script target',
    kind: 'evidence',
    evidence: ['script container entry for 目标敌人'],
    searchId: scriptTicket.searchId,
    mutationBudget: 1
  });
  await unlimitedGateway.update({
    objectName: '目标敌人',
    propertyKey: 'luabnd',
    value: 'luabnd container target',
    kind: 'evidence',
    evidence: ['luabnd container for 目标敌人'],
    searchId: scriptTicket.searchId,
    mutationBudget: 1
  });
  const unlimitedEntries = (await unlimitedGateway.read()).entries.filter((entry) => entry.kind === 'evidence');
  assert.ok(unlimitedEntries.length >= 3);
  for (const entry of unlimitedEntries) {
    assert.equal(
      entry.mutationBudget,
      -1,
      `${entry.propertyKey} 应记为无限预算 (unlimited=-1)`
    );
  }
  // 脚本 Evidence 登记后可反复预留，不因次数耗尽被拒。
  const scriptFirst = await unlimitedGateway.assertMutationTarget('mutate_luabnd_script', {
    file: 'script.luabnd.dcx',
    script: 'print("hi")'
  });
  assert.equal(scriptFirst.ok, true, '脚本 Evidence 首次预留应通过');
  await unlimitedGateway.finalizeMutation(scriptFirst.reservationId);
  const scriptSecond = await unlimitedGateway.assertMutationTarget('mutate_luabnd_script', {
    file: 'script.luabnd.dcx',
    script: 'print("hi again")'
  });
  assert.equal(scriptSecond.ok, true, '脚本 Evidence 第二次预留仍应通过（无限修改）');
  await unlimitedGateway.finalizeMutation(scriptSecond.reservationId);
  const scriptThird = await unlimitedGateway.assertMutationTarget('mutate_luabnd_script', {
    file: 'script.luabnd.dcx',
    script: 'print("hi thrice")'
  });
  assert.equal(scriptThird.ok, true, '脚本 Evidence 第三次预留仍应通过（无限修改）');
  await unlimitedGateway.finalizeMutation(scriptThird.reservationId);

  // PARAM 对照：仍为恰好 1 次，用尽后拒绝。
  const paramGateway = createAgentTaskRecordGateway(root, 'param-still-once', {
    frozenRequest: '修改义父的铃铛'
  });
  await paramGateway.update({
    objectName: '义父的铃铛',
    propertyKey: 'target',
    value: '待定位',
    kind: 'target'
  });
  const paramTicket = await paramGateway.recordSearch({
    toolName: 'search_param_rows',
    query: '义父的铃铛',
    result: { items: [{ item: { paramName: 'EquipParamGoods', rowId: 3080 } }] }
  });
  await paramGateway.update({
    objectName: '义父的铃铛',
    propertyKey: 'EquipParamGoods',
    value: 'rowId=3080',
    kind: 'evidence',
    evidence: ['EquipParamGoods#3080 fieldId=nameId'],
    searchId: paramTicket.searchId,
    mutationBudget: 1
  });
  await paramGateway.recordNativeParamRead(
    { table: 'EquipParamGoods', rowIds: [3080], fieldIds: ['nameId'] },
    { fields: [{ table: 'EquipParamGoods', rowId: 3080, fieldId: 'nameId', value: 3504, sourceHash: 'h', sourceRevision: 1 }] }
  );
  const paramFirst = await paramGateway.assertMutationTarget('mutate_param_fields', {
    edits: [{ table: 'EquipParamGoods', rowId: 3080, fieldId: 'nameId', value: 1 }]
  });
  assert.equal(paramFirst.ok, true);
  await paramGateway.finalizeMutation(paramFirst.reservationId);
  const paramEntryAfterWrite = (await paramGateway.read()).entries
    .find((entry) => entry.propertyKey === 'EquipParamGoods' && entry.kind === 'evidence');
  assert.equal(paramEntryAfterWrite.mutationBudget, 1, 'PARAM 预算仍为 1');
  assert.equal(paramEntryAfterWrite.mutationUsed, 1, 'PARAM 成功写入后消耗 1 次');
  const paramSecond = await paramGateway.assertMutationTarget('mutate_param_fields', {
    edits: [{ table: 'EquipParamGoods', rowId: 3080, fieldId: 'nameId', value: 2 }]
  });
  assert.equal(paramSecond.ok, false, 'PARAM Evidence 用尽后不得继续写入');
  assert.ok(
    ['TASK_RECORD_MUTATION_BUDGET_EXHAUSTED', 'TASK_RECORD_NATIVE_PROOF_REQUIRED', 'TASK_RECORD_PARAM_ROW_UNRESOLVED']
      .includes(paramSecond.code),
    `PARAM 二次写入应被预算/证明门禁拒绝，实际 ${paramSecond.code}`
  );

  console.log('agent task-record gate smoke passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
