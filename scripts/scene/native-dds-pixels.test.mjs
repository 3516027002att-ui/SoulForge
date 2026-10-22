import assert from 'node:assert/strict';
import { test } from 'node:test';
const module = await import('../scene-independent-baselines.mjs');
test('independent BC pixel check catches decoder corruption and bounds rounding tolerance', () => {
  assert.equal(typeof module.compareIndependentRgba8, 'function');
  assert.equal(module.compareIndependentRgba8(Buffer.from([10,20,30,255]), Buffer.from([11,20,30,255]), 1).status, 'passed');
  assert.equal(module.compareIndependentRgba8(Buffer.from([10,20,30,255]), Buffer.from([20,20,30,255]), 1).status, 'failed');
  assert.equal(module.compareIndependentRgba8(Buffer.from([10,20,30,255]), Buffer.from([11,20,30,255]), 0).status, 'failed');
  assert.equal(module.compareIndependentRgba8(Buffer.alloc(4), Buffer.alloc(8), 1).status, 'failed');
  assert.equal(module.compareIndependentRgba8(Buffer.alloc(4), Buffer.alloc(4), 255).status, 'unverified');
});
