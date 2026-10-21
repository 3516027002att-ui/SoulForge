/**
 * Fixed real-agent acceptance scenarios.
 *
 * Every modify target must differ from the corpus value it replaces: an agent
 * that finds the value already set writes nothing, and requireMutation then
 * fails a scenario the agent handled correctly.
 *
 * Unlike the four-task capability-gap set, every scenario here is phrased as a
 * change or query whose complete meaning is a native read-back: each
 * postcondition is exactly the field/entry the task names, with no substitute
 * field and no runtime behaviour claim. requiresRuntimeEvidence is therefore
 * false by design; a scenario whose wording needs game-runtime proof does not
 * belong in this set.
 */

const GAMEPARAM = 'param/gameparam/gameparam.parambnd.dcx';
// FMG table names are the confirmed native names (Japanese), not English aliases.
const ITEM_MSG = 'msg/zhocn/item.msgbnd.dcx';

const contract = (input) => Object.freeze({
  schema: 'soulforge-real-task-contract-v2',
  intent: input.intent ?? 'modify',
  // Postconditions are native data facts; no runtime verifier is involved.
  requiresRuntimeEvidence: false,
  corpusFingerprint: Object.freeze({
    version: 1,
    requiredSources: Object.freeze(input.requiredSources),
    requireNativeSourceHash: true,
    note: '运行时按实际 native sourceUri/sourceHash 对账；来源不匹配报告 corpus_mismatch。'
  }),
  targetIdentity: Object.freeze(input.targetIdentity ?? {}),
  preconditions: Object.freeze(input.preconditions ?? [{ kind: 'native-read-before-write', required: true }]),
  postconditions: Object.freeze(input.postconditions),
  protection: Object.freeze({
    modDataMustBeWrittenOnlyThroughPatchEngine: true,
    unrelatedResourcesMustRemainUnchanged: true,
    preserveExpectedValues: true,
    ...(input.protection ?? {})
  })
});

const paramEquals = (goalId, table, rowId, fieldId, value, { mutation = true } = {}) => Object.freeze({
  goalId,
  kind: 'native-tool',
  tool: 'read_param_fields',
  // Explicit containerPath binds the read to the declared corpus source.
  input: { containerPath: GAMEPARAM, table, rowIds: [rowId], fieldIds: [fieldId] },
  assertion: {
    path: 'data.fields',
    some: { allOf: [
      { path: 'rowId', equals: rowId },
      { path: 'fieldId', equals: fieldId },
      { path: 'value', equals: value }
    ] }
  },
  required: true,
  requireSourceHash: true,
  ...(mutation ? { requireMutation: true, changedPath: GAMEPARAM } : {})
});

const paramExists = (goalId, table, rowId, fieldId) => Object.freeze({
  goalId,
  kind: 'native-tool',
  tool: 'read_param_fields',
  input: { containerPath: GAMEPARAM, table, rowIds: [rowId], fieldIds: [fieldId] },
  assertion: {
    path: 'data.fields',
    some: { allOf: [
      { path: 'rowId', equals: rowId },
      { path: 'fieldId', equals: fieldId },
      { path: 'value', exists: true }
    ] }
  },
  required: true,
  requireSourceHash: true
});

const fmgEquals = (goalId, table, id, text) => Object.freeze({
  goalId,
  kind: 'native-tool',
  tool: 'read_fmg_entries',
  input: { containerPath: ITEM_MSG, table, ids: [id] },
  assertion: {
    path: 'data.entries',
    some: { allOf: [{ path: 'id', equals: id }, { path: 'text', equals: text }] }
  },
  required: true,
  requireSourceHash: true,
  requireMutation: true,
  changedPath: ITEM_MSG
});

const scenario = ({ id, label, query, corpusKinds, goals, intent, requiredSources, targetIdentity, protection }) => Object.freeze({
  id,
  label,
  corpusKinds: Object.freeze(corpusKinds),
  query,
  contract: contract({
    intent,
    requiredSources,
    targetIdentity,
    postconditions: goals.map((goal) => goal.goalId),
    protection,
    ...(intent === 'read' ? { preconditions: [] } : {})
  }),
  goals: Object.freeze(goals)
});

export const FIXED_SCENARIOS = Object.freeze([
  scenario({
    id: 'fixed-1-gyoubu-ninsatu',
    label: '鬼刑部忍杀次数改为 2',
    query: '把鬼刑部（NpcParam 50800000）的忍杀次数 ninsatuNum 改为 2',
    corpusKinds: ['param'],
    requiredSources: [GAMEPARAM],
    targetIdentity: { paramRows: [{ table: 'NpcParam', rowId: 50800000 }] },
    goals: [paramEquals('gyoubu-ninsatu-2', 'NpcParam', 50800000, 'ninsatuNum', 2)]
  }),
  scenario({
    id: 'fixed-2-owl-poison-resist',
    label: '祟枭毒抗性改为 100',
    query: '祟枭的毒抗性太高了，帮我把 NpcParam 50608901 的 resist_poison 改成 100',
    corpusKinds: ['param'],
    requiredSources: [GAMEPARAM],
    targetIdentity: { paramRows: [{ table: 'NpcParam', rowId: 50608901 }] },
    goals: [paramEquals('owl-resist-poison-100', 'NpcParam', 50608901, 'resist_poison', 100)]
  }),
  scenario({
    id: 'fixed-3-speffect-poison-power',
    label: 'SpEffectParam 9003 毒积累改为 60',
    query: '把 SpEffectParam 9003 的毒积累值 poizonAttackPower 改为 60，别的字段不要动',
    corpusKinds: ['param'],
    requiredSources: [GAMEPARAM],
    targetIdentity: { paramRows: [{ table: 'SpEffectParam', rowId: 9003 }] },
    goals: [paramEquals('speffect-9003-poison-60', 'SpEffectParam', 9003, 'poizonAttackPower', 60)]
  }),
  scenario({
    id: 'fixed-4-bullet-homing-dist',
    label: 'Bullet 750302 追踪起始距离改为 80',
    query: '把 Bullet 750302 的追踪开始距离 homingBeginDist 设成 80',
    corpusKinds: ['param'],
    requiredSources: [GAMEPARAM],
    targetIdentity: { paramRows: [{ table: 'Bullet', rowId: 750302 }] },
    goals: [paramEquals('bullet-750302-homing-80', 'Bullet', 750302, 'homingBeginDist', 80)]
  }),
  scenario({
    id: 'fixed-5-gyoubu-two-fields',
    label: '鬼刑部忍杀次数与掉落表同时修改',
    query: '鬼刑部（NpcParam 50800000）改两处：忍杀次数 ninsatuNum 改为 2，掉落 itemLotId_1 改为 90017000',
    corpusKinds: ['param'],
    requiredSources: [GAMEPARAM],
    targetIdentity: { paramRows: [{ table: 'NpcParam', rowId: 50800000 }] },
    goals: [
      paramEquals('gyoubu-two-ninsatu-2', 'NpcParam', 50800000, 'ninsatuNum', 2),
      paramEquals('gyoubu-two-itemlot-90017000', 'NpcParam', 50800000, 'itemLotId_1', 90017000)
    ]
  }),
  scenario({
    id: 'fixed-6-goods-name-text',
    label: '伤药葫芦改名',
    query: '把道具「伤药葫芦」（道具名表 アイテム名，ID 3000）的名字改成「测试伤药葫芦」',
    corpusKinds: ['msg'],
    requiredSources: [ITEM_MSG],
    targetIdentity: { fmgEntries: [{ table: 'アイテム名', id: 3000 }] },
    goals: [fmgEquals('goods-3000-name', 'アイテム名', 3000, '测试伤药葫芦')]
  }),
  scenario({
    id: 'fixed-7-gyoubu-ninsatu-read',
    label: '查询鬼刑部忍杀次数（只读）',
    intent: 'read',
    query: '鬼刑部（NpcParam 50800000）的忍杀次数 ninsatuNum 现在是多少？只看不改',
    corpusKinds: ['param'],
    requiredSources: [GAMEPARAM],
    targetIdentity: { paramRows: [{ table: 'NpcParam', rowId: 50800000 }] },
    protection: { forbidAnyMutation: true },
    goals: [paramExists('gyoubu-ninsatu-read', 'NpcParam', 50800000, 'ninsatuNum')]
  })
]);

export function getFixedScenario(value) {
  const normalized = String(value ?? '').trim().toLocaleLowerCase();
  return FIXED_SCENARIOS.find((task) => task.id === normalized || task.id.startsWith(`${normalized}-`)) ?? null;
}
