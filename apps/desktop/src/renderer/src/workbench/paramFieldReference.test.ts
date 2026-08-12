import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PARAM_FIELD_REF_MAX_TARGETS,
  parseParamFieldRefs,
  selectActiveParamFieldRefs
} from '@soulforge/shared';

test('parses the plain single-target form (437 of 475 real targets)', () => {
  const result = parseParamFieldRefs('SpEffectParam');
  assert.deepEqual(result, { targets: [{ param: 'SpEffectParam' }], rejected: [] });
});

test('parses the richest real conditional form verbatim', () => {
  // Real value from Smithbox SDT 2.2.4 Param Meta/BehaviorParam.xml, refId field.
  const result = parseParamFieldRefs(
    'Bullet(refType=1),AtkParam_Npc(refType=0),AtkParam_Pc(refType=0),SpEffectParam(refType=2)'
  );
  assert.equal(result.rejected.length, 0);
  assert.deepEqual(result.targets, [
    { param: 'Bullet', condition: { fieldId: 'refType', value: 1 } },
    { param: 'AtkParam_Npc', condition: { fieldId: 'refType', value: 0 } },
    { param: 'AtkParam_Pc', condition: { fieldId: 'refType', value: 0 } },
    { param: 'SpEffectParam', condition: { fieldId: 'refType', value: 2 } }
  ]);
});

test('conditional targets are gated on the sibling field value', () => {
  const { targets } = parseParamFieldRefs(
    'Bullet(refType=1),AtkParam_Npc(refType=0),AtkParam_Pc(refType=0),SpEffectParam(refType=2)'
  );
  const active = selectActiveParamFieldRefs(targets, new Map([['refType', 0]]));
  assert.deepEqual(active.map((t) => t.param), ['AtkParam_Npc', 'AtkParam_Pc']);

  const bullet = selectActiveParamFieldRefs(targets, new Map([['refType', 1]]));
  assert.deepEqual(bullet.map((t) => t.param), ['Bullet']);
});

test('an undecodable condition field yields no targets rather than all of them', () => {
  // "Don't know what refType is" must not imply "every target is correct" —
  // three of the four would send the user to the wrong param.
  const { targets } = parseParamFieldRefs('Bullet(refType=1),SpEffectParam(refType=2)');
  assert.deepEqual(selectActiveParamFieldRefs(targets, new Map()), []);
});

test('unconditional targets stay active with no field values at all', () => {
  const { targets } = parseParamFieldRefs('SpEffectParam,Bullet');
  assert.equal(selectActiveParamFieldRefs(targets, new Map()).length, 2);
});

test('mixed conditional and unconditional targets coexist', () => {
  const { targets } = parseParamFieldRefs('SpEffectParam,Bullet(refType=1)');
  const active = selectActiveParamFieldRefs(targets, new Map([['refType', 9]]));
  assert.deepEqual(active.map((t) => t.param), ['SpEffectParam']);
});

test('negative condition values parse (the grammar allows -?\\d+)', () => {
  const { targets, rejected } = parseParamFieldRefs('ItemLotParam(lotItemCategory01=-1)');
  assert.equal(rejected.length, 0);
  assert.deepEqual(targets[0]?.condition, { fieldId: 'lotItemCategory01', value: -1 });
});

test('whitespace around separators is tolerated', () => {
  const { targets } = parseParamFieldRefs('  SpEffectParam , Bullet(refType=1) ,, ');
  assert.deepEqual(targets.map((t) => t.param), ['SpEffectParam', 'Bullet']);
});

test('duplicate targets collapse so the UI does not show two identical jumps', () => {
  const { targets } = parseParamFieldRefs('SpEffectParam,SpEffectParam,spEFFECTparam');
  assert.equal(targets.length, 1);
});

test('the same param under different conditions is kept as distinct targets', () => {
  const { targets } = parseParamFieldRefs('AtkParam_Npc(refType=0),AtkParam_Npc(refType=3)');
  assert.equal(targets.length, 2);
});

test('unknown syntax is rejected, not guessed at', () => {
  for (const bad of [
    'SpEffectParam(refType)',        // condition without a value
    'SpEffectParam(refType=)',       // empty value
    'SpEffectParam(=1)',             // missing condition field
    'SpEffectParam(refType=abc)',    // non-integer value
    'SpEffectParam(refType=1',       // unbalanced
    'SpEffectParam[0]',              // array syntax
    '1SpEffectParam',                // identifier cannot start with a digit
    'Sp EffectParam',                // internal space
    'SpEffectParam(refType=1.5)'     // non-integer
  ]) {
    const result = parseParamFieldRefs(bad);
    assert.deepEqual(result.targets, [], `must not accept ${bad}`);
    assert.deepEqual(result.rejected, [bad], `must report ${bad}`);
  }
});

test('a malformed piece never discards its well-formed siblings', () => {
  const result = parseParamFieldRefs('SpEffectParam,Sp EffectParam,Bullet');
  assert.deepEqual(result.targets.map((t) => t.param), ['SpEffectParam', 'Bullet']);
  assert.deepEqual(result.rejected, ['Sp EffectParam']);
});

test('target count is capped and the overflow is reported', () => {
  const many = Array.from({ length: PARAM_FIELD_REF_MAX_TARGETS + 3 },
    (_, i) => `Param${i}`).join(',');
  const result = parseParamFieldRefs(many);
  assert.equal(result.targets.length, PARAM_FIELD_REF_MAX_TARGETS);
  assert.equal(result.rejected.length, 3);
});

test('non-string input is empty rather than throwing', () => {
  for (const value of [undefined, null, 42, {}, [], true]) {
    assert.deepEqual(parseParamFieldRefs(value), { targets: [], rejected: [] });
  }
});

test('unsafe integer condition values are rejected', () => {
  const result = parseParamFieldRefs('SpEffectParam(refType=99999999999999999999)');
  assert.deepEqual(result.targets, []);
  assert.equal(result.rejected.length, 1);
});
