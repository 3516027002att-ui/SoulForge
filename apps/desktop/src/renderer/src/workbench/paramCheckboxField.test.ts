import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isParamCheckboxChecked, isParamCheckboxField } from './paramCheckboxField.js';

test('bool 与 1bit 是勾选框，其它类型不是', () => {
  assert.equal(isParamCheckboxField({ type: 'bool' }), true);
  assert.equal(isParamCheckboxField({ type: 'u8', bitfield: { bitOffset: 0, bitWidth: 1 } }), true);
  assert.equal(isParamCheckboxField({ type: 'u8', bitfield: { bitOffset: 2, bitWidth: 1 } }), true);
  assert.equal(isParamCheckboxField({ type: 'u8', bitfield: { bitOffset: 0, bitWidth: 4 } }), false);
  assert.equal(isParamCheckboxField({ type: 's32' }), false);
  assert.equal(isParamCheckboxField({ type: 'f32' }), false);
  assert.equal(isParamCheckboxField({ type: 'u16' }), false);
});

test('display 的 1/true 算勾上，0/false 不算', () => {
  assert.equal(isParamCheckboxChecked('1'), true);
  assert.equal(isParamCheckboxChecked('true'), true);
  assert.equal(isParamCheckboxChecked('TRUE'), true);
  assert.equal(isParamCheckboxChecked('0'), false);
  assert.equal(isParamCheckboxChecked('false'), false);
  assert.equal(isParamCheckboxChecked(''), false);
});
