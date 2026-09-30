import assert from 'node:assert/strict';
import test from 'node:test';
const path = './flverValidationReport.js';
const module = await import(path).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

test('a failed native mesh report never claims successful validation', () => {
  assert.equal(typeof module.summarizeFlverValidation, 'function');
  const result = module.summarizeFlverValidation([{ id: 'broken', meshCount: 1, meshesChecked: 1, meshesOk: 0, decodeFailures: ['mesh[0] FLVER_MESH_NOT_FOUND'] }]);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.ok(!result.message.includes('验证通过'));
  assert.equal(result.counts.failed, 1);
});

test('valid empty models are separate from passed and failed samples', () => {
  assert.equal(typeof module.summarizeFlverValidation, 'function');
  const empty = { id: 'empty', meshCount: 0, meshesChecked: 0, meshesOk: 0, decodeFailures: [] };
  const passed = { id: 'renderable', meshCount: 2, meshesChecked: 2, meshesOk: 2, decodeFailures: [] };
  const result = module.summarizeFlverValidation([empty, passed]);
  assert.deepEqual(result.counts, { passed: 1, failed: 0, empty: 1, unverified: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.samples[0].validationStatus, 'empty');
  assert.equal(module.summarizeFlverValidation([empty]).status, 'unverified');
  assert.equal(module.summarizeFlverValidation([empty]).ok, false);
});
