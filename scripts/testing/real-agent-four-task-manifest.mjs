/**
 * Four real-agent acceptance tasks from the local test set.
 *
 * The manifest contains only logical workspace identities and deterministic
 * native assertions.  It does not contain credentials, machine paths, or
 * instructions to bypass the normal approval gate.  A failed assertion is a
 * real partial result; the runner must never turn a candidate search into PASS.
 */

const GAMEPARAM = 'param/gameparam/gameparam.parambnd.dcx';

const readFields = (table, rowIds, fieldIds) => ({
  tool: 'read_param_fields',
  input: { table, rowIds, fieldIds },
  requireSourceHash: true
});

const fieldIs = (fieldId, assertion) => ({
  path: 'data.fields',
  some: { allOf: [{ path: 'fieldId', equals: fieldId }, assertion] }
});

const fieldValue = (fieldId, value) => fieldIs(fieldId, { path: 'value', equals: value });
const fieldAtLeast = (fieldId, value) => fieldIs(fieldId, { path: 'value', min: value });

export const FOUR_TASKS = Object.freeze([
  Object.freeze({
    id: 'four-1-gyoubu-elite-indigo',
    label: '鬼刑部精英、两条血、靛蓝星陨掉落',
    query: '把鬼刑部改为精英怪，血条改为2，死亡后掉落靛蓝星陨',
    goals: Object.freeze([
      Object.freeze({
        goalId: 'gyoubu-health-bars', kind: 'param-field', table: 'NpcParam', rowId: 50800000,
        fieldId: 'ninsatuNum', expectedValue: 2, required: true, changedPath: GAMEPARAM
      }),
      Object.freeze({
        goalId: 'gyoubu-indigo-lot-link', kind: 'param-field', table: 'NpcParam', rowId: 50800000,
        fieldId: 'itemLotId_1', expectedValue: 90017000, required: true, changedPath: GAMEPARAM
      }),
      Object.freeze({
        goalId: 'indigo-lot-native-identity',
        kind: 'native-tool',
        ...readFields('ItemLotParam', [90017000], ['lotItemId02', 'lotItemNum02']),
        assertion: {
          allOf: [fieldValue('lotItemId02', 9457), fieldAtLeast('lotItemNum02', 1)]
        },
        required: true
      })
    ])
  }),
  Object.freeze({
    id: 'four-2-gyoubu-lightning-genichiro',
    label: '鬼刑部开场落雷、非狼目标、义父铃铛与弦一郎改招',
    query: '鬼型部出场时地上随机落雷5秒，不攻击到狼，击杀后掉落义父的铃铛。修改弦一郎，删除其遇到玩家和葫芦就突刺的定式，改成飞天射箭和下段危随机',
    goals: Object.freeze([
      Object.freeze({
        goalId: 'gyoubu-kill-lot-configured',
        kind: 'native-tool',
        ...readFields('NpcParam', [50800000], ['itemLotId_1', 'itemLotId_2', 'itemLotId_3']),
        assertion: {
          path: 'data.fields',
          some: { allOf: [{ path: 'fieldId', equals: 'itemLotId_1' }, { path: 'value', notEquals: -1 }] }
        },
        required: true,
        changedPath: GAMEPARAM
      }),
      Object.freeze({
        goalId: 'gyoubu-lightning-script', kind: 'script',
        file: 'script/m11_00_00_00.luabnd.dcx', childPath: '508000_battle.lua',
        contains: 'SpawnMapSFX', required: true, changedPath: 'script/m11_00_00_00.luabnd.dcx'
      }),
      Object.freeze({
        goalId: 'genichiro-pattern-script', kind: 'script',
        file: 'script/m11_01_00_00.luabnd.dcx', childPath: '540000_battle.lua',
        assertion: { path: 'data.script.sourceText', contains: '540000' },
        required: true, changedPath: 'script/m11_01_00_00.luabnd.dcx'
      })
    ])
  }),
  Object.freeze({
    id: 'four-3-xiuwan-super-poison',
    label: '绣丸超猛毒一套连招作用于祟枭',
    query: '修改绣丸打超猛毒，通过计算数值使其能在一套连招内为祟枭挂到效果',
    goals: Object.freeze([
      Object.freeze({
        goalId: 'xiuwan-poison-threshold',
        kind: 'native-tool',
        ...readFields('SpEffectParam', [9003, 9009], ['poizonAttackPower', 'stateInfo', 'registPoizonChangeRate']),
        assertion: {
          allOf: [
            fieldAtLeast('poizonAttackPower', 167),
            fieldValue('stateInfo', 2),
            fieldValue('registPoizonChangeRate', 1)
          ]
        },
        required: true,
        changedPath: GAMEPARAM
      }),
      Object.freeze({
        goalId: 'owl-poison-native-baseline',
        kind: 'native-tool',
        ...readFields('NpcParam', [50608901], ['resist_poison', 'poisonGuardResist']),
        assertion: { allOf: [fieldValue('resist_poison', 999), fieldValue('poisonGuardResist', 0)] },
        required: true
      })
    ])
  }),
  Object.freeze({
    id: 'four-4-xiuwan-final-tracking',
    label: '绣丸最后一刀切换斩追斩追踪距离 80',
    query: '修改绣丸 最后一刀切换斩，使其拥有80的追斩追踪距离',
    goals: Object.freeze([
      Object.freeze({
        goalId: 'xiuwan-final-slash-target',
        kind: 'native-tool',
        ...readFields('AtkParam_Pc', [7500115], ['trackType', 'hit0_Radius', 'hit1_Radius']),
        assertion: fieldIs('trackType', { path: 'rowName', contains: '绣丸' }),
        required: true
      }),
      Object.freeze({
        goalId: 'xiuwan-final-tracking-distance',
        kind: 'native-tool',
        ...readFields('Bullet', [750302], ['homingBeginDist', 'hormingStopRange', 'dist', 'isEnableAutoHoming']),
        assertion: fieldValue('homingBeginDist', 80),
        required: true,
        changedPath: GAMEPARAM
      })
    ])
  })
]);

export function getFourTask(value) {
  const normalized = String(value ?? '').trim().toLocaleLowerCase();
  return FOUR_TASKS.find((task) => task.id === normalized || task.id.startsWith(`${normalized}-`)) ?? null;
}

