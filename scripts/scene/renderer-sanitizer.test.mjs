import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ts = require(process.env.SOULFORGE_TEST_TYPESCRIPT_PATH ?? 'typescript');
const rendererPath = fileURLToPath(new URL('../../apps/desktop/src/main/rendererDto.ts', import.meta.url));
const maskPath = fileURLToPath(new URL('../../packages/shared/src/path-sanitizer.ts', import.meta.url));
const preloadPath = fileURLToPath(new URL('../../apps/desktop/src/preload/resultTransforms.ts', import.meta.url));

function compile(source, filename, shared = {}, observe = () => {}) {
  const result = ts.transpileModule(source, {
    fileName: filename, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  });
  assert.deepEqual((result.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error), []);
  const exports = {};
  vm.runInNewContext(result.outputText, {
    exports, module: { exports }, Uint8Array, ArrayBuffer, __observeVisit: observe,
    require(name) { assert.equal(name, '@soulforge/shared'); return shared; }
  }, { filename });
  return exports;
}

function load(observe) {
  const shared = compile(readFileSync(maskPath, 'utf8'), maskPath);
  let source = readFileSync(rendererPath, 'utf8');
  if (observe) {
    // This observer exists only in the source-bound test. The function/result
    // body stays intact, and the production module has no observation hook.
    const entry = 'export function sanitizeRendererValue(value: unknown): unknown {';
    assert.equal(source.split(entry).length, 2);
    source = source.replace(entry, `${entry}\n  __observeVisit(value);`);
  }
  return compile(source, rendererPath, shared, observe);
}

const api = load();
const preload = compile(readFileSync(preloadPath, 'utf8'), preloadPath,
  compile(readFileSync(maskPath, 'utf8'), maskPath));
const plain = value => JSON.parse(JSON.stringify(value));

test('main and preload mask network file authority without corrupting logical resource identity', () => {
  for (const uri of [
    'file://prod-server/share/mod/a.fmg', 'file://prod-server.fmg/share/mod/a.fmg',
    'file://192.168.0.23/share/mod/a.fmg', 'file://prod-server:445/share/mod/a.fmg',
    'file://%70rod-server/share/mod/a.fmg', 'file://%63hr/share/mod/a.fmg'
  ]) {
    const input = { sourceUri: uri, message: `Read failed: ${uri} (retry later)`, nested: [
      { sourceUri: 'file://chr/c0000.anibnd.dcx', relatedUri: uri },
      { sourceUri: 'file://map/mapstudio/m10_00_00_00.msb.dcx' },
      { sourceUri: 'file://param/gameparam/gameparam.parambnd.dcx' },
      { sourceUri: 'file://pack.bnd#bnd/child/item.fmg' }
    ] };
    const expected = { ...input, sourceUri: '[本机路径已隐藏]',
      message: 'Read failed: [本机路径已隐藏] (retry later)',
      nested: [{ ...input.nested[0], relatedUri: '[本机路径已隐藏]' }, ...input.nested.slice(1)] };
    assert.deepEqual(plain(api.sanitizeRendererValue(input)), expected);
    assert.deepEqual(plain(preload.stripPathFields(input)), expected);
  }
});

test('object primitive fields avoid recursive visits while array elements retain map behavior', () => {
  const visits = [];
  const observed = load(value => visits.push(value));
  const input = { number: 91, label: 'object label', nullValue: null,
    big: 17n, values: [77, 'array label'], child: { number: 31 } };
  const output = observed.sanitizeRendererValue(input);
  assert.equal(output.number, 91);
  assert.equal(output.label, 'object label');
  assert.equal(output.nullValue, null);
  assert.equal(output.big, 17n);
  for (const value of [91, 'object label', null, 17n, 31]) assert.equal(visits.includes(value), false);
  assert.equal(visits.includes(77), true);
  assert.equal(visits.includes('array label'), true);
});

test('sensitive fields are removed and source text remains distinct from diagnostic strings', () => {
  const text = 'const value = "C:\\private\\source";';
  const input = { message: text, sourceUri: 'file://map/logical.msb', nested: [] };
  for (const key of ['dslTemplate', 'sourcePrefix', 'sliceText', 'draft', 'nextDslTemplate', 'text']) input[key] = text;
  for (const key of ['absolutePath', 'sourcePath', 'targetPath', 'backupPath', 'workspaceRoot', 'overlayRoot',
    'baseRoot', 'stagingRoot', 'backupRoot', 'recoveryPath', 'metadataPath', 'storePath', 'apiKey', 'secret',
    'secretRef', 'password', 'token', 'workspaceId']) input[key] = '/private/authority';
  input.nested.push({ absolutePath: '/private/child', message: '来源 file:///D:/game/a.fmg 未索引' });
  const before = JSON.stringify(input), output = api.sanitizeRendererValue(input);
  assert.equal(output.message, 'const value = "[本机路径已隐藏]";');
  assert.equal(output.sourceUri, input.sourceUri);
  assert.deepEqual(plain(output.nested), [{ message: '来源 [本机路径已隐藏] 未索引' }]);
  for (const key of ['dslTemplate', 'sourcePrefix', 'sliceText', 'draft', 'nextDslTemplate', 'text']) assert.equal(output[key], text);
  for (const key of Object.keys(input).filter(key => input[key] === '/private/authority')) assert.equal(Object.hasOwn(output, key), false);
  assert.equal(JSON.stringify(input), before);
});

test('physical Windows and POSIX paths are masked while logical and relative addresses survive', () => {
  for (const [value, expected] of [
    ['目标 D:\\游戏\\mods\\a.fmg。请重试', '目标 [本机路径已隐藏]。请重试'],
    ['占用（\\\\?\\UNC\\host\\share\\b.fmg）', '占用（[本机路径已隐藏]）'],
    ['\\\\.\\device\\volume\\x', '[本机路径已隐藏]'],
    ['FILE:///d:/game/a.fmg', '[本机路径已隐藏]'],
    ['file://map/logical.msb', 'file://map/logical.msb'],
    ['file:///workspace/a.fmg', 'file:///workspace/a.fmg'],
    ['/owned/example', '[本机路径已隐藏]'],
    ['file://localhost/home/user/a.fmg', '[本机路径已隐藏]'],
    ['file://D:/Users/user/a.fmg', '[本机路径已隐藏]'],
    ['relative/example', 'relative/example'],
    ['https://example.com/docs/a', 'https://example.com/docs/a'],
    ['ordinary', 'ordinary'], ['', '']
  ]) assert.equal(api.sanitizeRendererValue({ message: value }).message, expected);
});

test('every object projection is fresh and does not share mutable input or previous output', () => {
  const child = { position: { x: 1 }, label: 'plain' }, input = { left: child, right: child };
  const first = api.sanitizeRendererValue(input), second = api.sanitizeRendererValue(input);
  assert.notEqual(first, input);
  assert.notEqual(first.left, child);
  assert.notEqual(first.left, first.right);
  assert.notEqual(first.left, second.left);
  first.left.position.x = 2;
  assert.equal(child.position.x, 1);
  assert.equal(first.right.position.x, 1);
  assert.equal(second.left.position.x, 1);
});

test('Object.entries snapshots own getters before recursing, including filtered fields', () => {
  const events = [], input = Object.create({ inherited: 'private' });
  let number = 12;
  const child = { get value() { events.push('nested'); number = 99; return 1; } };
  Object.defineProperty(input, 'child', { enumerable: true, get() { events.push('child'); return child; } });
  Object.defineProperty(input, 'number', { enumerable: true, get() { events.push('number'); return number; } });
  Object.defineProperty(input, 'sourcePath', { enumerable: true, get() { events.push('filtered'); return 'C:/private'; } });
  Object.defineProperty(input, 'hidden', { value: 'private', enumerable: false });
  const output = api.sanitizeRendererValue(input);
  assert.deepEqual(events, ['child', 'number', 'filtered', 'nested']);
  assert.equal(output.number, 12);
  assert.deepEqual(Object.keys(output), ['child', 'number']);
  assert.equal(Object.hasOwn(output, 'inherited'), false);
});

test('getter errors keep identity even when their field would be filtered', () => {
  const failure = new Error('original getter failure');
  for (const key of ['message', 'sourcePath']) {
    const input = Object.defineProperty({}, key, { enumerable: true, get() { throw failure; } });
    assert.throws(() => api.sanitizeRendererValue(input), error => error === failure);
  }
});

test('root and field primitive identities, sparse arrays and binary identity are unchanged', () => {
  for (const value of [undefined, null, NaN, Infinity, -0, 42, false, 17n, Symbol('value'), () => {}]) {
    assert.equal(api.sanitizeRendererValue(value), value);
    assert.equal(api.sanitizeRendererValue({ field: value }).field, value);
  }
  const bytes = new Uint8Array([1, 2]), buffer = new ArrayBuffer(4);
  const output = api.sanitizeRendererValue({ bytes, buffer });
  assert.equal(output.bytes, bytes); assert.equal(output.buffer, buffer);
  const sparse = []; sparse[3] = { message: 'C:/private' };
  const projected = api.sanitizeRendererValue(sparse);
  assert.equal(projected.length, 4); assert.equal(0 in projected, false);
  assert.equal(projected[3].message, '[本机路径已隐藏]');
});

test('diagnostics retain their projection and cyclic object failure is not hidden', () => {
  const output = api.sanitizeDiagnostics([{ severity: 'error', code: 'X', message: '失败 C:/private',
    sourceUri: 'file://event/logical.emevd', details: { token: 'secret', text: 'C:/content', message: 'C:/private' } }]);
  assert.deepEqual(plain(output), [{ severity: 'error', code: 'X', message: '失败 [本机路径已隐藏]',
    sourceUri: 'file://event/logical.emevd', details: { text: 'C:/content', message: '[本机路径已隐藏]' } }]);
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => api.sanitizeRendererValue(cycle), error => error.name === 'RangeError');
});
