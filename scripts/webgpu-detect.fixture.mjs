import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const scene = new URL('../apps/desktop/src/renderer/src/scene/', import.meta.url);
const detectionSource = await readFile(new URL('webgpuDetect.ts', scene), 'utf8');
const load = async (source) => {
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
};
const detection = await load(detectionSource);
const controllerSource = await readFile(new URL('threeSceneController.ts', scene), 'utf8');
const controllerAst = ts.createSourceFile('threeSceneController.ts', controllerSource, ts.ScriptTarget.Latest, true);
const resolverNode = controllerAst.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'resolveRendererBackend');
const resolver = resolverNode ? (await load(resolverNode.getText(controllerAst))).resolveRendererBackend : detection.resolveRendererBackend;
if (!resolverNode) {
  assert.ok(controllerAst.statements.some((node) => ts.isImportDeclaration(node)
    && node.moduleSpecifier.text === './webgpuDetect.js'
    && node.importClause?.namedBindings?.elements?.some((entry) => entry.name.text === 'resolveRendererBackend')));
}

async function withAdapter(requestAdapter, run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu: { requestAdapter } } });
  try { await run(); }
  finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else delete globalThis.navigator;
  }
}
const adapter = (info = { vendor: 'fixture', architecture: 'fixture', device: 'fixture', description: 'fixture' }) => ({ info, features: new Set(['timestamp-query']) });

test('current adapter.info is usable without removed requestAdapterInfo', () => withAdapter(async () => adapter(), async () => {
  const result = await detection.detectWebGpu();
  assert.equal(result.available, true);
  assert.equal(result.adapterInfo.vendor, 'fixture');
}));
test('empty adapter information does not make a present adapter unavailable', () => withAdapter(async () => adapter({ vendor: '', architecture: '', device: '', description: '' }), async () => {
  assert.equal((await detection.detectWebGpu()).available, true);
}));
test('adapter info getter failure is diagnostic and does not erase availability', () => withAdapter(async () => ({
  get info() { throw new Error('redacted info'); }, features: new Set()
}), async () => {
  const result = await detection.detectWebGpu();
  assert.equal(result.available, true);
  assert.ok(result.diagnostics.some((item) => item.code === 'WEBGPU_ADAPTER_INFO_FAILED' && item.severity === 'warning'));
}));
test('missing adapter and rejected request remain unavailable', async () => {
  await withAdapter(async () => null, async () => assert.equal((await detection.detectWebGpu()).available, false));
  await withAdapter(async () => { throw new Error('adapter unavailable'); }, async () => assert.equal((await detection.detectWebGpu()).available, false));
});
test('renderer defaults to WebGL2 even when capability becomes available', () => {
  assert.equal(resolver(undefined, true), 'webgl2');
  assert.equal(resolver(undefined, false), 'webgl2');
  assert.equal(resolver('webgpu', true), 'webgpu');
  assert.equal(resolver('webgl2', true), 'webgl2');
});
test('preferred backend remains WebGL2 while detection succeeds', () => withAdapter(async () => adapter(), async () => {
  assert.equal(await detection.preferredRendererBackend(), 'webgl2');
  assert.equal((await detection.detectWebGpu()).available, true);
}));

