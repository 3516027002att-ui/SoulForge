import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
const filename = new URL('../../apps/desktop/src/renderer/src/editors/MsbScenePanel.tsx', import.meta.url);
const source = ts.createSourceFile(filename.pathname, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
function visit(node) {
  if (ts.isVariableStatement(node)) for (const item of node.declarationList.declarations) {
    if (ts.isIdentifier(item.name) && ['diagnosticFromDetail', 'reportMeshDiagnostic'].includes(item.name.text)) declarations.set(item.name.text, node);
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(declarations.size, 2);
const printer = ts.createPrinter();
const body = [...declarations.values()].map(node => printer.printNode(ts.EmitHint.Unspecified, node, source)).join('\n');
const compiled = ts.transpileModule(body + '\nexports.report = reportMeshDiagnostic;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;
function mountDiagnostics() {
  const logs = [];
  const context = { exports: {}, cancelled: false, firstMeshDiagnostic: null, sceneErrorCount: 0,
    meshPartTotalRef: { current: 2 },
    setMeshStatus(update) { context.status = update(context.status); },
    console: Object.fromEntries(['debug', 'warn', 'error'].map(level => [level, (...args) => logs.push({ level, args })])) };
  vm.runInNewContext(compiled, context);
  return { context, logs, report: context.exports.report };
}
test('a first texture warning cannot suppress a later model or scene failure', () => {
  const d = mountDiagnostics();
  d.report('m1', 'native-read', { diagnostics: [{ severity: 'warning', code: 'TEXTURE_MISSING', message: '贴图缺失' }] });
  const firstMessage = d.context.status.firstDiagnostic;
  d.report('m2', 'loader', 'MAP_MESH_LOAD_FAILED: later model failed');
  d.report('__scene__', 'renderer', 'MAP_RENDERER_FAILED: scene failed');
  assert.deepEqual(d.logs.map(entry => entry.level), ['warn', 'error', 'error']);
  assert.deepEqual(d.logs.map(entry => entry.args[1].modelName), ['m1', 'm2', '__scene__']);
  assert.equal(d.logs[1].args[1].code, 'MAP_MESH_LOAD_FAILED');
  assert.equal(d.context.status.firstDiagnostic, firstMessage);
  assert.equal(d.context.status.sceneErrors, 1);
});
test('cancelled scene does not emit diagnostics or change status', () => {
  const d = mountDiagnostics(); d.context.cancelled = true;
  d.report('m1', 'loader', 'MAP_MESH_LOAD_FAILED: cancelled');
  assert.equal(d.logs.length, 0); assert.equal(d.context.status, undefined);
});
