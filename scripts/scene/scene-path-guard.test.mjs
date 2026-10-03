import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ts = require(process.env.SOULFORGE_TEST_TYPESCRIPT_PATH ?? 'typescript');
const sourcePath = fileURLToPath(new URL('../../packages/shared/src/scene-ir.ts', import.meta.url));
const source = readFileSync(sourcePath, 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;

function harness() {
  const exports = {};
  const context = vm.createContext({ exports, module: { exports } });
  vm.runInContext(js + '\nexports.observePathGuard = assertNoAbsolutePathLeak;', context, { filename: sourcePath });
  return { api: exports, context };
}

const legacyMatches = text => /(?:^|["'\s])(?:[A-Za-z]:[\\/]|\\\\)/.test(text)
  || /file:\/\/{1,3}[A-Za-z]:/i.test(text)
  || /\/(?:Users|home)\//i.test(text);

function rejectsPath(api, value) {
  try { api.observePathGuard(value); return false; }
  catch (error) {
    assert.equal(error.diagnostic?.code, 'SCENE_ABSOLUTE_PATH_LEAK');
    return true;
  }
}

test('actual path guard scans a safe serialized projection once', () => {
  const { api, context } = harness();
  vm.runInContext('globalThis.testCalls = 0; const originalTest = RegExp.prototype.test; RegExp.prototype.test = function(value) { testCalls++; return originalTest.call(this, value); };', context);
  api.observePathGuard({ sourceUri: 'resource://owned/map', values: Array.from({ length: 128 }, (_, id) => ({ id, name: `owned-${id}` })) });
  assert.equal(vm.runInContext('testCalls', context), 1, 'one scan retains the complete predicate');
});

test('actual path predicate preserves Windows, UNC, URI, POSIX and Unicode matching', () => {
  const { api } = harness();
  const values = ['C:/owned', 'c:\\owned', '\\\\host\\owned', 'FILE:///c:/owned', 'file://map/owned',
    '/Users/owned', '/users/owned', '/HOME/owned', '/workspace/owned', 'resource://owned/map',
    '', '\\', '\\\\', '\nC:/owned', 'safe C:/owned', 'xC:/owned', '\u212a:/owned', '\u017f:/owned'];
  for (const value of values) {
    assert.equal(rejectsPath(api, value), legacyMatches(value), value);
    assert.equal(rejectsPath(api, { value }), legacyMatches(JSON.stringify({ value })), value);
    assert.equal(rejectsPath(api, { [value]: 'safe' }), legacyMatches(JSON.stringify({ [value]: 'safe' })), value);
  }
  // /i must not expand the original ASCII drive-letter branch. Check every
  // UTF16 code unit, including lone surrogates and special Unicode folds.
  for (let code = 0; code <= 0xffff; code++) {
    const value = `${String.fromCharCode(code)}:/owned`;
    assert.equal(rejectsPath(api, value), legacyMatches(value));
    assert.equal(rejectsPath(api, { value }), legacyMatches(JSON.stringify({ value })));
  }
});

test('public scene builders preserve source identity, property order and input values', () => {
  const { api } = harness();
  const model = { name: 'owned-model', nativeOffset: 16, typeId: 0 };
  const part = { name: 'owned-part', nativeOffset: 32, modelIndex: 0, posX: 1, posY: 2, posZ: 3, rotX: 0, rotY: 0, rotZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 };
  const input = { sourceUri: 'resource://owned/map', sourcePath: 'map/owned.msb', game: 'owned', resourceKind: 'map', revision: 'revision', models: [model], parts: [part], regions: [], events: [], routes: [], chunkSize: 512 };
  const before = JSON.stringify(input);
  const manifest = api.buildMsbSceneManifest(input);
  const draw = api.buildSceneDrawList(manifest);
  assert.equal(manifest.nodeCount, 1); assert.equal(manifest.entityCount, 2); assert.equal(draw.itemCount, 1);
  assert.equal(draw.items[0].modelName, model.name);
  assert.equal(draw.items[0].sourceResourceUri, 'resource://owned/map#entity/msb-part%3Aoffset-20');
  assert.deepEqual(Array.from(draw.items[0].position), [1, 2, 3]);
  assert.deepEqual(Object.keys(draw.items[0]), ['id', 'label', 'entityKind', 'primitive', 'position', 'rotation', 'scale', 'sourceResourceUri', 'colorRgb', 'modelName']);
  assert.equal(JSON.stringify(input), before);
  assert.equal(manifest.models, input.models, 'preserve existing public model-reference semantics');
  assert.throws(() => api.buildMsbSceneManifest({ ...input, parts: [{ ...part, name: 'C:/owned' }] }), error => error.diagnostic?.code === 'SCENE_ABSOLUTE_PATH_LEAK');
});

test('JSON getter order and original getter error identity remain observable', () => {
  const { api } = harness();
  const calls = [], failure = new Error('owned getter failure');
  const value = { get first() { calls.push('first'); return 'safe'; }, get second() { calls.push('second'); throw failure; }, get third() { calls.push('third'); return 'safe'; } };
  assert.throws(() => api.observePathGuard(value), error => error === failure);
  assert.deepEqual(calls, ['first', 'second']);
});

test('inherited toJSON behavior and original toJSON errors remain unchanged', () => {
  const { api } = harness();
  const calls = [], prototype = { toJSON(key) { calls.push(key); return { inherited: 'C:/owned' }; } };
  assert.equal(rejectsPath(api, Object.assign(Object.create(prototype), { name: 'safe' })), true);
  assert.deepEqual(calls, ['']);
  const failure = new Error('owned toJSON failure');
  assert.throws(() => api.observePathGuard({ toJSON() { throw failure; } }), error => error === failure);
  assert.doesNotThrow(() => api.observePathGuard({ toJSON() { return undefined; } }));
});

test('cycles, BigInt, sparse arrays and nonfinite values retain JSON behavior', () => {
  const { api } = harness();
  const circular = {}; circular.self = circular;
  assert.throws(() => api.observePathGuard(circular), error => error.name === 'TypeError' && /circular/i.test(error.message));
  assert.throws(() => api.observePathGuard({ value: 1n }), error => error.name === 'TypeError' && /BigInt/.test(error.message));
  for (const value of [undefined, () => 'safe', Symbol('owned'), { values: [, undefined, NaN, Infinity, -Infinity] }]) assert.doesNotThrow(() => api.observePathGuard(value));
});
