import assert from 'node:assert/strict';
import test from 'node:test';
import { rendererIdentifiers } from './rendererSourceAnalysis.mjs';

test('renderer wiring after a quote-bearing regex remains visible', () => {
  const names = rendererIdentifiers('const matcher = /["\']/g;\nbridge.readRawMetadata();\nbridge.setWindowThemeMode(mode);');
  assert.ok(names.has('readRawMetadata'));
  assert.ok(names.has('setWindowThemeMode'));
});

test('comments and literal text cannot invent renderer calls', () => {
  const names = rendererIdentifiers('// bridge.runAiAgent();\nconst label = "readRawMetadata";\n/* bridge.applyMsbMutation(); */');
  assert.ok(!names.has('runAiAgent'));
  assert.ok(!names.has('readRawMetadata'));
  assert.ok(!names.has('applyMsbMutation'));
});

test('template expressions count as code while template text does not', () => {
  const names = rendererIdentifiers('const label = `runAiAgent ${bridge.readRawMetadata()}`;');
  assert.ok(names.has('readRawMetadata'));
  assert.ok(!names.has('runAiAgent'));
});

test('invalid renderer syntax fails closed', () => {
  assert.throws(() => rendererIdentifiers('const broken = ;'), /RENDERER_SOURCE_UNPARSEABLE/);
});

test('real typed bridge lookups and bracket access count while decorative text does not', () => {
  const names = rendererIdentifiers("const setMode = getBridgeMethod('setWindowThemeMode'); bridge['readRawMetadata'](); const label = 'getMutterStatus'; // getBridgeMethod('runAiAgent')");
  assert.ok(names.has('setWindowThemeMode'));
  assert.ok(names.has('readRawMetadata'));
  assert.ok(!names.has('getMutterStatus'));
  assert.ok(!names.has('runAiAgent'));
});
