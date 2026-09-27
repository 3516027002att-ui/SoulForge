/**
 * Four real-agent acceptance tasks from the local test set.
 *
 * The manifest contains only logical workspace identities and deterministic
 * native assertions.  It does not contain credentials, machine paths, or
 * instructions to bypass the normal approval gate.  A failed assertion is a
 * real partial result; the runner must never turn a candidate search into PASS.
 */

const GAMEPARAM = 'param/gameparam/gameparam.parambnd.dcx';
const COMMON_EVENT = 'event/common.emevd.dcx';

const contract = (input) => Object.freeze({
  schema: 'soulforge-real-task-contract-v2',
  requiresRuntimeEvidence: true,
  corpusFingerprint: Object.freeze({
    version: 1,
    requiredSources: Object.freeze(input.requiredSources ?? []),
    requireNativeSourceHash: true,
    note: '运行时按实际 native sourceUri/sourceHash 对账；清单路径或版本不匹配必须报告 corpus_mismatch。'
  }),
  targetIdentity: Object.freeze(input.targetIdentity ?? {}),
  preconditions: Object.freeze(input.preconditions ?? []),
  postconditions: Object.freeze(input.postconditions ?? []),
  protection: Object.freeze({
    modDataMustBeWrittenOnlyThroughPatchEngine: true,
    unrelatedResourcesMustRemainUnchanged: true,
    preserveExpectedValues: true,
    ...(input.protection ?? {})
  })
});

const readFields = (table, rowIds, fieldIds) => ({
  tool: 'read_param_fields',
  // Bind verification probes to the same declared PARAM corpus as the task
  // contract; default table discovery can return a native hash without a
  // workspace-logical source identity for corpus provenance checks.
  input: { containerPath: GAMEPARAM, table, rowIds, fieldIds },
  requireSourceHash: true
});

const fieldIs = (fieldId, assertion, rowId) => ({
  path: 'data.fields',
  some: { allOf: [{ path: 'fieldId', equals: fieldId }, ...(rowId === undefined ? [] : [{ path: 'rowId', equals: rowId }]), assertion] }
});

const fieldValue = (fieldId, value, rowId) => fieldIs(fieldId, { path: 'value', equals: value }, rowId);
const fieldAtLeast = (fieldId, value, rowId) => fieldIs(fieldId, { path: 'value', min: value }, rowId);
const rowFields = (rowId, checks) => ({
  allOf: checks.map(([fieldId, assertion]) => fieldIs(fieldId, assertion, rowId))
});

const unsupported = (goalId, unsupportedReason) => Object.freeze({
  goalId,
  kind: 'unsupported',
  required: true,
  verificationStatus: 'unsupported',
  unsupportedReason
});

const typedArg = (name, value) => ({
  path: 'typedArgs',
  some: { allOf: [{ path: 'name', equals: name }, { path: 'value', equals: value }] }
});

const instruction = (name, ...args) => ({
  allOf: [{ path: 'name', equals: name }, ...args]
});

const orderedInstructions = (sequence) => ({
  path: 'data.record.instructions',
  sequence
});

export const FOUR_TASKS = Object.freeze([
  Object.freeze({
    id: 'four-1-gyoubu-elite-indigo',
    label: '鬼刑部精英、两条血、靛蓝星陨掉落',
    corpusKinds: Object.freeze(['param', 'msg', 'event']),
    query: '把鬼刑部改为精英怪，血条改为2，死亡后掉落靛蓝星陨',
    contract: contract({
      requiredSources: [GAMEPARAM],
      targetIdentity: {
        paramRows: [{ table: 'NpcParam', rowId: 50800000 }, { table: 'ItemLotParam', rowId: 90017000 }]
      },
      preconditions: [{ table: 'NpcParam', rowId: 50800000, fieldId: 'ninsatuNum', expectedValue: 3, required: false }],
      postconditions: [
        'gyoubu-elite-identity', 'gyoubu-health-bars', 'gyoubu-healthbar-ui',
        'gyoubu-death-lot-causality', 'indigo-unlock-runtime'
      ]
    }),
    goals: Object.freeze([
      Object.freeze({
        goalId: 'gyoubu-health-bars', kind: 'param-field', table: 'NpcParam', rowId: 50800000,
        fieldId: 'ninsatuNum', expectedValue: 2, required: true, changedPath: GAMEPARAM
      }),
      Object.freeze({
        goalId: 'gyoubu-indigo-lot-link', kind: 'param-field', table: 'NpcParam', rowId: 50800000,
        fieldId: 'itemLotId_1', expectedValue: 90017000, required: false
      }),
      Object.freeze({
        goalId: 'indigo-unlock-event',
        kind: 'native-tool',
        tool: 'read_emevd_event',
        input: { file: COMMON_EVENT, eventId: 965104, format: 'json' },
        assertion: orderedInstructions([
          instruction('AwardItemLot', typedArg('itemLotId', 90017000)),
          instruction('GrantSkill', typedArg('skillParamId', 786)),
          instruction('RemoveItemFromPlayer', typedArg('itemId', 9457))
        ]),
        // common#965104 is an existing native unlock example. Keep it as
        // optional baseline evidence; it is not the Gyoubu death-causality
        // proof and must not force a write to a shared event.
        required: false,
        requireSourceHash: true
      }),
      unsupported('gyoubu-elite-identity', '当前 native 工具没有可执行的精英敌人身份验证器；PARAM 行名或候选字段不能代替身份。'),
      unsupported('gyoubu-healthbar-ui', '当前没有游戏运行时/精英血条 UI 验证器；不能用 ninsatuNum 或 DisplayBossHealthBar 字符串代替。'),
      unsupported('gyoubu-death-lot-causality', '当前没有可执行的死亡事件因果验证器，不能证明鬼刑部死亡触发该掉落事件。'),
      unsupported('indigo-unlock-runtime', '当前没有游戏运行时库存/技能闭环验证器；AwardItemLot 或 9457 参数不能证明靛蓝星陨已解锁。')
    ])
  }),
  Object.freeze({
    id: 'four-2-gyoubu-lightning-genichiro',
    label: '鬼刑部开场落雷、非狼目标、义父铃铛与弦一郎改招',
    corpusKinds: Object.freeze(['param', 'msg', 'event', 'map', 'script', 'action', 'chr']),
    query: '鬼型部出场时地上随机落雷5秒，不攻击到狼，击杀后掉落义父的铃铛。修改弦一郎，删除其遇到玩家和葫芦就突刺的定式，改成飞天射箭和下段危随机',
    contract: contract({
      requiredSources: [GAMEPARAM, 'script/m11_00_00_00.luabnd.dcx', 'script/m11_01_00_00.luabnd.dcx'],
      targetIdentity: { npcParamRows: [{ rowId: 50800000 }, { rowId: 54000000 }], scriptChildren: ['508000_battle.lua', '540000_battle.lua'] },
      preconditions: [{ kind: 'native-read-before-write', required: true }],
      postconditions: [
        'gyoubu-lightning-runtime', 'gyoubu-lightning-target', 'gyoubu-bell-drop',
        'genichiro-pattern-runtime', 'genichiro-trigger-removal'
      ]
    }),
    goals: Object.freeze([
      Object.freeze({
        goalId: 'gyoubu-lightning-script-structure',
        kind: 'native-tool',
        tool: 'analyze_luabnd_script',
        input: { file: 'script/m11_00_00_00.luabnd.dcx', childPath: '508000_battle.lua', section: 'calls', limit: 6 },
        assertion: {
          allOf: [
            { anyOf: [
              { path: 'data.record.structureStatus', equals: 'complete' },
              { path: 'data.structureStatus', equals: 'complete' }
            ] },
            { anyOf: [
              { path: 'data.record.items', some: { path: 'callee', equals: 'SpawnMapSFX' } },
              { path: 'data.items', some: { path: 'callee', equals: 'SpawnMapSFX' } }
            ] }
          ]
        },
        // Static structure is only an optional probe. A SpawnMapSFX call is
        // not evidence that the Lua API has the required target/timing
        // semantics and must not force a script write or pass the task.
        required: false
      }),
      Object.freeze({
        goalId: 'genichiro-pattern-script-structure',
        kind: 'native-tool',
        tool: 'analyze_luabnd_script',
        input: { file: 'script/m11_01_00_00.luabnd.dcx', childPath: '540000_battle.lua', section: 'branches', limit: 6 },
        assertion: {
          anyOf: [
            { path: 'data.record.items', some: { path: 'kind', equals: 'if' } },
            { path: 'data.items', some: { path: 'kind', equals: 'if' } }
          ]
        },
        required: false
      }),
      unsupported('gyoubu-lightning-runtime', '静态 Lua 结构不能验证开场随机落雷持续恰好 5 秒。当前没有游戏运行时计时/生成验证器。'),
      unsupported('gyoubu-lightning-target', '静态 Lua 结构不能验证落雷永不命中狼；当前没有敌我目标运行时验证器。'),
      unsupported('gyoubu-bell-drop', '当前没有准确的义父铃铛 native 身份与死亡掉落验证器；文本候选或任意 itemLot 不能代替。'),
      unsupported('genichiro-pattern-runtime', '当前没有动作 ID 到飞天射箭/下段危的可执行运行时验证器；脚本字符串不能代替动作语义。'),
      unsupported('genichiro-trigger-removal', '当前没有可执行的触发条件因果验证器，不能证明遇到玩家/葫芦突刺定式已删除。')
    ])
  }),
  Object.freeze({
    id: 'four-3-xiuwan-super-poison',
    label: '绣丸超猛毒一套连招作用于祟枭',
    corpusKinds: Object.freeze(['param']),
    query: '修改绣丸打超猛毒，通过计算数值使其能在一套连招内为祟枭挂到效果',
    contract: contract({
      requiredSources: [GAMEPARAM],
      targetIdentity: { paramRows: [{ table: 'SpEffectParam', rowIds: [9003, 9009] }, { table: 'NpcParam', rowId: 50608901 }] },
      preconditions: [{ kind: 'native-read-before-write', required: true }],
      postconditions: [
        'owl-poison-native-baseline',
        'xiuwan-combo-poison-accumulation', 'xiuwan-super-poison-effect'
      ],
      protection: { forbidMixingPhysicalRowsInOneAssertion: true }
    }),
    goals: Object.freeze([
      Object.freeze({
        goalId: 'xiuwan-poison-parameter-anchor',
        kind: 'native-tool',
        ...readFields('SpEffectParam', [9003, 9009], ['poizonAttackPower', 'stateInfo', 'registPoizonChangeRate']),
        assertion: {
          anyOf: [
            { path: 'data.fields', some: { allOf: [
              { path: 'rowId', equals: 9003 }, { path: 'fieldId', equals: 'poizonAttackPower' }
            ] } },
            { path: 'data.fields', some: { allOf: [
              { path: 'rowId', equals: 9009 }, { path: 'fieldId', equals: 'poizonAttackPower' }
            ] } }
          ]
        },
        required: false
      }),
      Object.freeze({
        goalId: 'owl-poison-native-baseline',
        kind: 'native-tool',
        ...readFields('NpcParam', [50608901], ['resist_poison', 'poisonGuardResist']),
        assertion: { allOf: [fieldValue('resist_poison', 999), fieldValue('poisonGuardResist', 0)] },
        required: true
      }),
      unsupported('xiuwan-combo-poison-accumulation', '当前没有可执行的绣丸动作链/命中次数/毒积累计算器；单个 poizonAttackPower 字段不能证明一套连招。'),
      unsupported('xiuwan-super-poison-effect', '当前没有游戏运行时或效果状态验证器，不能证明超猛毒能对祟枭挂上效果。')
    ])
  }),
  Object.freeze({
    id: 'four-4-xiuwan-final-tracking',
    label: '绣丸最后一刀切换斩追斩追踪距离 80',
    corpusKinds: Object.freeze(['param']),
    query: '修改绣丸 最后一刀切换斩，使其拥有80的追斩追踪距离',
    contract: contract({
      requiredSources: [GAMEPARAM],
      targetIdentity: { paramRows: [{ table: 'AtkParam_Pc', rowId: 7500115 }, { table: 'Bullet', rowId: 750302 }] },
      preconditions: [{ kind: 'native-read-before-write', required: true }],
      postconditions: [
        'xiuwan-final-action-identity', 'xiuwan-final-tracking-distance'
      ],
      protection: { requireActionChainEvidence: true }
    }),
    goals: Object.freeze([
      Object.freeze({
        goalId: 'xiuwan-final-action-anchor',
        kind: 'native-tool',
        ...readFields('AtkParam_Pc', [7500115], ['trackType', 'hit0_Radius', 'hit1_Radius']),
        assertion: { path: 'data.fields', some: { path: 'fieldId', equals: 'trackType' } },
        required: false
      }),
      Object.freeze({
        goalId: 'xiuwan-bullet-homing-candidate',
        kind: 'native-tool',
        ...readFields('Bullet', [750302], ['homingBeginDist', 'hormingStopRange', 'dist', 'isEnableAutoHoming']),
        assertion: { path: 'data.fields', some: { path: 'fieldId', equals: 'homingBeginDist' } },
        required: false
      }),
      unsupported('xiuwan-final-action-identity', '当前没有可执行的 TAE→AtkParam→Bullet 身份链验证器；相似行名或最大行号不能确认最后一刀。'),
      unsupported('xiuwan-final-tracking-distance', '当前没有准确动作追踪/游戏运行时验证器，不能用 Bullet homingBeginDist 相似字段代替最后一刀的追斩距离 80。')
    ])
  })
]);

export function getFourTask(value) {
  const normalized = String(value ?? '').trim().toLocaleLowerCase();
  return FOUR_TASKS.find((task) => task.id === normalized || task.id.startsWith(`${normalized}-`)) ?? null;
}

