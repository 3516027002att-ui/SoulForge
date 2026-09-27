import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildParamTextReferenceEdges } from './paramTextReferences.js';

test('mutating returned PARAM-to-text edges cannot corrupt a later build', () => {
  const params = [{ rows: [{
    uri: 'param://gameparam/EquipParamGoods/1',
    sourceUri: 'file:///mod/param/gameparam/gameparam.parambnd.dcx',
    paramName: 'EquipParamGoods',
    rowId: 1,
    fields: []
  }] }];
  const msgExports = [{
    category: 'Title_Goods',
    entries: [{
      uri: 'fmg://title-goods/1',
      sourceUri: 'file:///mod/msg/item.msgbnd.dcx',
      category: 'Title_Goods',
      textId: 1,
      text: 'Healing Gourd'
    }]
  }];

  const first = buildParamTextReferenceEdges(params, msgExports);
  assert.equal(first.length, 1);
  first[0]!.reason = 'caller mutation';
  first.length = 0;

  const second = buildParamTextReferenceEdges(params, msgExports);
  assert.equal(second.length, 1);
  assert.notEqual(second[0]?.reason, 'caller mutation');
});
