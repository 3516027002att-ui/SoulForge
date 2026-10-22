import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { ParamFieldDef } from '@soulforge/shared';
import { decodeFieldView } from './ParamDefPanel.js';

function decodeFloat(value: number, type: 'f32' | 'f64') {
  const bytes = new Uint8Array(type === 'f32' ? 4 : 8);
  const view = new DataView(bytes.buffer);
  if (type === 'f32') view.setFloat32(0, value, true);
  else view.setFloat64(0, value, true);
  const field: ParamFieldDef = { id: 'value', name: '值', type, offset: 0, size: bytes.length };
  return decodeFieldView(bytes, field);
}

it('载入浮点比较保留真实精度，正常编辑框仍使用原先四位投影', () => {
  const decoded = decodeFloat(1.23456789, 'f64');
  assert.equal(decoded.display, '1.2346');
  assert.equal(decoded.comparisonDisplay, '1.23456789');
});

it('载入 f32 比较来自同一次解码的实际数值', () => {
  const decoded = decodeFloat(1.23456789, 'f32');
  assert.equal(decoded.display, '1.2346');
  assert.equal(decoded.comparisonDisplay, String(Math.fround(1.23456789)));
});

it('载入比较保留 -0 与 NaN/Infinity，正常 -0 编辑显示不变', () => {
  for (const type of ['f32', 'f64'] as const) {
    assert.equal(decodeFloat(-0, type).display, '0');
    assert.equal(decodeFloat(-0, type).comparisonDisplay, '-0');
    assert.equal(decodeFloat(NaN, type).comparisonDisplay, 'NaN');
    assert.equal(decodeFloat(Infinity, type).comparisonDisplay, 'Infinity');
    assert.equal(decodeFloat(-Infinity, type).comparisonDisplay, '-Infinity');
  }
});
