/**
 * Execute production editor callbacks/projections with synthetic UI/IPC ports.
 * No DOM, real CodeMirror mount, native writer or visual-acceptance claim.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { transformSync } from 'esbuild';

const loadCore = createRequire(import.meta.url)('./typescript-test-loader.cjs')();
const { applyParamFieldMutation } = loadCore(fileURLToPath(new URL('../packages/core/src/param/paramFieldMutation.ts', import.meta.url)));
const { FIRST_PARTY_PARAM_METADATA_PACKAGE } = loadCore(fileURLToPath(new URL('../packages/core/src/schema/sekiro/firstPartySchemaData.ts', import.meta.url)));

function productionFile(path) {
  const text = readFileSync(new URL(path, import.meta.url), 'utf8');
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
const script = productionFile('../apps/desktop/src/renderer/src/editors/ScriptContainerPanel.tsx');
const param = productionFile('../apps/desktop/src/renderer/src/workbench/ParamWorkbench.tsx');
const layout = productionFile('../apps/desktop/src/renderer/src/workbench/WorkbenchLayout.tsx');
function find(file, predicate) {
  let found;
  function visit(node) { if (!found && predicate(node)) found = node; if (!found) ts.forEachChild(node, visit); }
  visit(file);
  assert(found, `Missing production callback/projection in ${file.fileName}`);
  return found;
}
function callback(file, name) {
  return find(file, node => ts.isVariableDeclaration(node) && node.name.getText(file) === name).initializer.arguments[0];
}
function jsxAttribute(file, name, contains) {
  return find(file, node => ts.isJsxAttribute(node) && node.name.getText(file) === name
    && node.initializer?.getText(file).includes(contains)).initializer.expression;
}
function componentAttribute(file, component, name) {
  const node = find(file, node => (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node))
    && node.tagName.getText(file) === component);
  const attribute = node.attributes.properties.find(prop => ts.isJsxAttribute(prop) && prop.name.getText(file) === name);
  assert(attribute?.initializer && ts.isJsxExpression(attribute.initializer), `${component}.${name}`);
  return attribute.initializer.expression;
}
function evaluate(node, file, ports) {
  return vm.runInNewContext(transformSync(`(${node.getText(file)})`, { loader: 'ts' }).code, ports);
}

it('the real editor E2E container selection includes sibling PARAM save toasts', () => {
  // Evaluate the actual outer JSX and layout JSX with empty columns/toolbar.
  // This is a source-bound tree projection, not browser/native save execution.
  const outer = find(param, node => ts.isJsxElement(node)
    && node.openingElement.attributes.properties.some(attribute =>
      ts.isJsxAttribute(attribute) && attribute.name.getText(param) === 'className'
      && attribute.initializer?.getText(param) === '"param-workbench"'));
  const layoutRoot = find(layout, node => ts.isJsxElement(node)
    && node.openingElement.attributes.properties.some(attribute =>
      ts.isJsxAttribute(attribute) && attribute.name.getText(layout) === 'aria-label'
      && attribute.initializer?.getText(layout) === '{props.label}'));
  const projected = ts.transform(outer, [context => {
    const visit = node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(param) === 'WorkbenchLayout'
      ? ts.factory.updateJsxSelfClosingElement(node, node.tagName, node.typeArguments,
          ts.factory.createJsxAttributes(node.attributes.properties.filter(attribute =>
            ts.isJsxAttribute(attribute) && ['label', 'columns'].includes(attribute.name.getText(param)))))
      : ts.visitEachChild(node, visit, context);
    return root => ts.visitNode(root, visit);
  }]);
  const printer = ts.createPrinter();
  const jsx = (type, props, ...children) => typeof type === 'function'
    ? type(props)
    : { type, props: props ?? {}, children: children.flat().filter(child => child && typeof child === 'object') };
  const render = (node, file, ports) => vm.runInNewContext(transformSync(
    `(${printer.printNode(ts.EmitHint.Expression, node, file)})`,
    { loader: 'tsx', jsxFactory: 'jsx' }).code, { jsx, ...ports });
  const WorkbenchLayout = props => render(layoutRoot, layout, { props, columnsRef: null });
  const query = (node, match) => match(node) ? node : node.children.map(child => query(child, match)).find(Boolean);
  const hasClass = (node, value) => String(node.props.className ?? '').split(/\s+/).includes(value);
  const spec = productionFile('../apps/desktop/e2e/playwright/tests/editor-loaded-comparison.spec.mjs');
  const selection = find(spec, node => ts.isVariableDeclaration(node) && node.name.getText(spec) === 'workbench').initializer;
  try {
    for (const kind of ['ok', 'error']) {
      const tree = render(projected.transformed[0], param, { toast: { kind, text: kind }, columns: [], WorkbenchLayout });
      const page = {
        getByLabel: label => query(tree, node => node.props['aria-label'] === label),
        locator: selector => query(tree, node => hasClass(node, selector.slice(1)))
      };
      const selected = evaluate(selection, spec, { page });
      assert(selected, 'the test must select a real production container');
      assert(query(selected, node => hasClass(node, `wb-toast--${kind}`)),
        `${kind} toast is outside the selected container; PARAM native save status cannot be observed`);
    }
  } finally { projected.dispose(); }
});
function projection(file, component, names, ports) {
  return Object.fromEntries(names.map(name => [name, evaluate(componentAttribute(file, component, name), file, ports)]));
}

function scriptHarness(sourceText = 'loaded', expanded = true) {
  const renders = [];
  const saves = [];
  const reads = [];
  const statuses = [];
  let destroyCount = 0;
  let refreshes = 0;
  let dirtyWrites = 0;
  let loading = false;
  let sourceError = null;
  const ports = {
    Error,
    source: { ok: true, kind: 'plaintext', sourceText, logicalName: 'a.lua', entryName: 'a.lua', entryIndex: 7,
      childHash: 'child-1', containerHash: 'container-1', encoding: 'shift_jis', writeSupported: true },
    props: { resourceUri: 'fixture://scripts', onMutationCommitted: async () => {} },
    editorHostRef: { current: {} }, viewRef: { current: null }, draftRef: { current: sourceText },
    dirtyRef: { current: false }, comparisonOpenRef: { current: expanded },
    sourceReadGenerationRef: { current: 0 },
    submittingRef: { current: false }, submitRef: { current: () => {} },
    refreshComparison: update => { update(0); refreshes += 1; },
    setDirty: value => { dirtyWrites += 1; ports.dirtyRef.current = value; },
    setSubmitting: () => {}, setStatus: value => statuses.push(value), setSourceLoading: value => { loading = value; },
    setSourceError: value => { sourceError = value; }, setSource: value => { ports.source = value; },
    describeBridgeAbsence: () => 'unavailable',
    bridge: {
      saveScriptSource: async (...args) => { saves.push(args); return { ok: true }; },
      readScriptSource: async (...args) => { reads.push(args); return { ok: true, kind: 'plaintext', sourceText: 'reloaded', logicalName: 'a.lua', entryName: 'a.lua', entryIndex: 7, childHash: 'child-2', containerHash: 'container-1', encoding: 'shift_jis', writeSupported: true }; }
    }
  };
  const inert = () => null;
  Object.assign(ports, Object.fromEntries(['lineNumbers','highlightActiveLineGutter','highlightActiveLine','foldGutter',
    'bracketMatching','indentOnInput','drawSelection','dropCursor','history','closeBrackets','search'].map(name => [name, inert])));
  Object.assign(ports, { defaultKeymap: [], searchKeymap: [], historyKeymap: [], closeBracketsKeymap: [], indentWithTab: {},
    keymap: { of: mappings => ({ mappings }) } });
  ports.EditorView = class {
    static updateListener = { of: listener => ({ listener }) };
    static theme = inert;
    constructor(options) { this.options = options; renders.push(this); }
    destroy() { destroyCount += 1; }
  };
  ports.buildScriptEditorExtensions = evaluate(find(script, node => ts.isFunctionDeclaration(node)
    && node.name?.getText(script) === 'buildScriptEditorExtensions'), script, ports);
  const effect = find(script, node => ts.isCallExpression(node) && node.expression.getText(script) === 'useEffect'
    && node.arguments[0].getText(script).includes('new EditorView')).arguments[0];
  const dispose = evaluate(effect, script, ports)();
  const view = renders[0];
  const listener = view?.options.extensions.find(extension => extension?.listener)?.listener;
  const saveKey = view?.options.extensions.find(extension => extension?.mappings)?.mappings.find(key => key.key === 'Mod-s');
  ports.loadSource = evaluate(callback(script, 'loadSource'), script, ports);
  ports.submitSource = evaluate(callback(script, 'submitSource'), script, ports);
  ports.submitRef.current = () => ports.submitSource();
  return {
    ports, saves, reads, statuses, view, dispose,
    edit(text) { listener({ docChanged: true, state: { doc: { toString: () => text } } }); },
    unchangedUpdate() { listener({ docChanged: false }); },
    expand(value) { evaluate(jsxAttribute(script, 'onExpandedChange', 'comparisonOpenRef'), script, ports)(value); },
    compare() { return projection(script, 'LoadedScriptComparison', ['before', 'after'], ports); },
    saveKey: () => saveKey.run(), refreshes: () => refreshes, dirtyWrites: () => dirtyWrites,
    destroyCount: () => destroyCount, loading: () => loading, sourceError: () => sourceError
  };
}

describe('production Script editor comparison callbacks', () => {
  it('successive expanded edits refresh from current ref, and reversion uses the loaded source', () => {
    const h = scriptHarness(); h.edit('first'); h.edit('second');
    assert.deepEqual(h.compare(), { before: 'loaded', after: 'second' });
    assert.equal(h.refreshes(), 2); assert.equal(h.dirtyWrites(), 1);
    h.edit('loaded'); assert.deepEqual(h.compare(), { before: 'loaded', after: 'loaded' });
    h.unchangedUpdate(); assert.equal(h.refreshes(), 3);
  });
  it('collapsed typing keeps latest draft without comparison renders; opening reads it immediately', () => {
    const h = scriptHarness('loaded', false); h.edit('first'); h.edit('second');
    assert.equal(h.refreshes(), 0); h.expand(true);
    assert.equal(h.refreshes(), 1); assert.equal(h.compare().after, 'second');
    h.expand(false); h.edit('third'); assert.equal(h.refreshes(), 1);
  });
  it('empty loaded text mounts an editor and empty current draft is preserved', () => {
    const h = scriptHarness(''); assert.equal(h.view.options.doc, '');
    h.edit('text'); h.edit(''); assert.deepEqual(h.compare(), { before: '', after: '' });
  });
  it('the existing Mod-s callback saves latest draft, exact encoding/hash/index and reloads the baseline', async () => {
    const h = scriptHarness(); h.edit('first'); h.edit('latest');
    assert.equal(h.saveKey(), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.saves[0], ['fixture://scripts','a.lua','child-1','container-1','latest','shift_jis',7]);
    assert.deepEqual(h.reads[0], ['fixture://scripts','a.lua',7]);
    assert.deepEqual(h.compare(), { before: 'reloaded', after: 'reloaded' });
    assert.equal(h.ports.comparisonOpenRef.current, false);
    assert.equal(h.ports.source.childHash, 'child-2');
  });
  it('failed save retains the pending draft and loaded baseline; no automatic retry/reload', async () => {
    const h = scriptHarness(); h.ports.bridge.saveScriptSource = async (...args) => { h.saves.push(args); return { ok: false, diagnostics: [{ message: 'failed' }] }; };
    h.edit(''); await h.ports.submitSource();
    assert.deepEqual(h.compare(), { before: 'loaded', after: '' });
    assert.equal(h.reads.length, 0); assert.equal(h.saves.length, 1); assert.equal(h.statuses.at(-1), 'failed');
  });
  it('source read replaces the baseline/ref and collapses the view, including empty/failure results', async () => {
    const h = scriptHarness(); h.edit('old pending');
    h.ports.bridge.readScriptSource = async () => ({ ...h.ports.source, sourceText: '' });
    await h.ports.loadSource({ name: 'b.lua', index: 8 });
    assert.deepEqual(h.compare(), { before: '', after: '' });
    assert.equal(h.ports.comparisonOpenRef.current, false);
    h.ports.bridge.readScriptSource = async () => ({ ok: false, kind: 'failure', diagnostics: [{ message: 'cannot read' }] });
    await h.ports.loadSource(null); assert.equal(h.ports.draftRef.current, ''); assert.equal(h.ports.source.ok, false);
  });
  it('comparison refresh does not rebuild the editor; existing disposal still destroys it', () => {
    const h = scriptHarness(); h.edit('first'); h.expand(false); h.expand(true);
    assert.equal(h.ports.viewRef.current, h.view); assert.equal(h.destroyCount(), 0);
    h.dispose(); assert.equal(h.destroyCount(), 1); assert.equal(h.ports.viewRef.current, null);
  });
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

describe('production Script source read ownership', () => {
  function pendingReads() {
    const h = scriptHarness(); const a = deferred(); const b = deferred();
    h.ports.bridge.readScriptSource = async (_uri, _name, index) => index === 1 ? a.promise : b.promise;
    const readA = h.ports.loadSource({ name: 'old.lua', index: 1 });
    const readB = h.ports.loadSource({ name: 'new.lua', index: 2 });
    const result = (text, index) => ({ ok: true, kind: 'plaintext', sourceText: text, logicalName: `${index}.lua`, entryIndex: index, childHash: `child-${index}` });
    return { h, a, b, readA, readB, result };
  }
  it('older successful entry read cannot replace a newer baseline/draft/hash', async () => {
    const p = pendingReads(); p.b.resolve(p.result('current source', 2)); await p.readB;
    p.a.resolve(p.result('late old source', 1)); await p.readA;
    assert.equal(p.h.ports.source.entryIndex, 2); assert.equal(p.h.ports.source.childHash, 'child-2');
    assert.deepEqual(p.h.compare(), { before: 'current source', after: 'current source' });
  });
  it('opening during loading cannot leave the new collapsed source refreshing on each edit', async () => {
    const p = pendingReads(); p.h.expand(true); const refreshes = p.h.refreshes();
    p.b.resolve(p.result('current source', 2)); await p.readB;
    assert.equal(p.h.ports.comparisonOpenRef.current, false);
    p.h.edit('current edited'); assert.equal(p.h.refreshes(), refreshes);
    p.a.resolve(p.result('old source', 1)); await p.readA;
  });
  it('each source-read generation resets disclosure identity even when the returned hashes are identical', () => {
    const h = scriptHarness(); const key = componentAttribute(script, 'LoadedVersionComparison', 'key');
    const before = evaluate(key, script, h.ports); h.ports.sourceReadGenerationRef.current += 1;
    assert.notEqual(evaluate(key, script, h.ports), before);
  });
  it('older successful read cannot end the loading state of a newer pending read', async () => {
    const p = pendingReads(); p.a.resolve(p.result('old source', 1)); await p.readA;
    assert.equal(p.h.loading(), true); assert.equal(p.h.ports.source, null);
    p.b.resolve(p.result('current source', 2)); await p.readB;
    assert.equal(p.h.loading(), false); assert.equal(p.h.ports.source.entryIndex, 2);
  });
  for (const failure of ['structured', 'throw']) {
    it(`older ${failure} failure cannot clear newer source or report its error`, async () => {
      const p = pendingReads(); p.b.resolve(p.result('current source', 2)); await p.readB;
      if (failure === 'structured') p.a.resolve({ ok: false, kind: 'failure', diagnostics: [{ message: 'old failure' }] });
      else p.a.reject(new Error('old failure'));
      await p.readA;
      assert.equal(p.h.ports.source?.entryIndex, 2); assert.equal(p.h.sourceError(), null);
    });
  }
  it('latest failure still reports its own diagnostic and completes loading', async () => {
    const p = pendingReads(); p.b.reject(new Error('current failure')); await p.readB;
    assert.equal(p.h.ports.source, null); assert.equal(p.h.sourceError(), 'current failure'); assert.equal(p.h.loading(), false);
    p.a.resolve(p.result('old source', 1)); await p.readA;
    assert.equal(p.h.ports.source, null); assert.equal(p.h.sourceError(), 'current failure');
  });
  it('latest structured failure retains its diagnostic and is not replaced by an older success', async () => {
    const p = pendingReads();
    p.b.resolve({ ok: false, kind: 'failure', diagnostics: [{ message: 'current structured failure' }] }); await p.readB;
    assert.equal(p.h.sourceError(), 'current structured failure'); assert.equal(p.h.loading(), false);
    p.a.resolve(p.result('old source', 1)); await p.readA;
    assert.equal(p.h.ports.source.ok, false); assert.equal(p.h.sourceError(), 'current structured failure');
  });
  it('unmount invalidates the owning read so a late result cannot change the disposed view', async () => {
    const p = pendingReads();
    const effect = find(script, node => ts.isCallExpression(node) && node.expression.getText(script) === 'useEffect'
      && node.arguments[0].getText(script).includes('sourceReadGenerationRef.current += 1')).arguments[0];
    evaluate(effect, script, p.h.ports)()();
    p.b.resolve(p.result('disposed result', 2)); p.a.resolve(p.result('old result', 1));
    await Promise.all([p.readA, p.readB]);
    assert.equal(p.h.ports.source, null); assert.equal(p.h.ports.draftRef.current, 'loaded');
    assert.equal(p.h.ports.comparisonOpenRef.current, false);
  });
  it('a newer unavailable read clears loading and suppresses an older pending result', async () => {
    const p = pendingReads(); p.h.ports.bridge = null;
    await p.h.ports.loadSource(null); assert.equal(p.h.loading(), false);
    p.b.resolve(p.result('late result', 2)); p.a.resolve(p.result('old result', 1));
    await Promise.all([p.readA, p.readB]); assert.equal(p.h.ports.source, null);
    assert.equal(p.h.sourceError(), 'unavailable');
  });
});

function paramHarness(draft = '2') {
  const mutations = [];
  const pendingDraftUpdates = [];
  const toasts = [];
  let reloads = 0;
  const ports = {
    canCommitFields: true, definition: { fields: [] }, selectedEntry: 8, paramName: 'fixture',
    containerHash: 'container', childHash: 'child', rowDataSize: 4, payloadLoading: false,
    selectedRow: { rowIndex: 3, id: 10, dataHash: 'row', dataBase64: 'AAAAAA==' },
    documentSessionToken: 'session', drafts: { value: draft }, decodedValues: new Map([['value', { display: '1' }]]),
    field: { id: 'value', name: '值', type: 's32' }, editable: true,
    props: { containerUri: 'fixture://param', onApplyFieldMutation: async input => { mutations.push(input); return { ok: true }; } },
    setCommitting: () => {}, setDrafts: update => pendingDraftUpdates.push(update),
    showToast: (...args) => toasts.push(args), loadRows: () => { reloads += 1; }
  };
  ports.commitField = evaluate(find(param, node => ts.isFunctionDeclaration(node) && node.name?.getText(param) === 'commitField'), param, ports);
  return { ports, mutations, toasts, pendingDraftUpdates, reloads: () => reloads,
    compare: () => projection(param, 'LoadedFieldComparison', ['loaded','drafts'], ports),
    blur: () => evaluate(jsxAttribute(param, 'onBlur', 'drafts[field.id]'), param, ports)(),
    checkbox: checked => evaluate(jsxAttribute(param, 'onChange', 'const checked ='), param, ports)({ target: { checked } }),
    enum: value => { ports.option = { value }; return evaluate(jsxAttribute(param, 'onClick', 'String(option.value)'), param, ports)(); }
  };
}

describe('production PARAM comparison and existing commit callbacks', () => {
  it('actual Priority blur preserves invalid text and comparison when the real Core encoder rejects it', async () => {
    const h = paramHarness('not-a-number');
    h.ports.definition = FIRST_PARTY_PARAM_METADATA_PACKAGE.definitions.find(item => item.key.typeName === 'ACTION_GUIDE_PARAM_ST').document;
    h.ports.field = h.ports.definition.fields.find(item => item.id === 'priority');
    const row = Buffer.alloc(16, 0x5a); row.writeInt8(7, 4);
    h.ports.selectedRow.dataBase64 = row.toString('base64');
    h.ports.drafts = { priority: 'not-a-number' };
    h.ports.props.onApplyFieldMutation = async input => {
      h.mutations.push(input);
      const result = applyParamFieldMutation(input);
      return result.ok ? { ok: true } : { ok: false, message: result.message };
    };
    h.blur(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.mutations[0].value, 'not-a-number');
    assert.equal(h.toasts[0][1], 'error');
    assert.equal(h.reloads(), 0);
    assert.equal(h.pendingDraftUpdates.length, 0);
    assert.equal(h.compare().drafts.priority, 'not-a-number');
    assert.equal(row.readInt8(4), 7);
  });
  it('comparison gets the decoded baseline and exact pending draft, never a separate baseline cache', () => {
    const h = paramHarness(' \t invalid');
    assert.equal(h.compare().loaded, h.ports.decodedValues); assert.equal(h.compare().drafts.value, ' \t invalid');
    h.ports.payloadLoading = true; assert.equal(h.compare().loaded, null);
  });
  it('existing blur commits retain exact physical identity/hash/size and invalid draft strings', async () => {
    const h = paramHarness('invalid'); h.blur(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual({ ...h.mutations[0] }, { paramName: 'fixture', entryIndex: 8, expectedContainerHash: 'container',
      expectedChildHash: 'child', rowIndex: 3, rowId: 10, expectedDataHash: 'row', expectedRowDataSize: 4,
      fieldId: 'value', value: 'invalid', rowDataBase64: 'AAAAAA==', definition: h.ports.definition });
    assert.equal(h.reloads(), 1); const remaining = h.pendingDraftUpdates.at(-1)(h.ports.drafts); assert.equal(remaining.value, undefined);
  });
  it('empty draft still commits, untouched/readonly fields do not add a comparison write path', async () => {
    const h = paramHarness(''); h.blur(); await new Promise(resolve => setImmediate(resolve)); assert.equal(h.mutations[0].value, '');
    h.ports.drafts = {}; h.blur(); assert.equal(h.mutations.length, 1);
    h.ports.drafts = { value: '3' }; h.ports.editable = false; h.blur(); assert.equal(h.mutations.length, 1);
  });
  it('normal numeric submission still keeps -0 and float precision, without comparison coercion', async () => {
    const h = paramHarness('-0'); h.ports.field.type = 'f64'; h.blur();
    await new Promise(resolve => setImmediate(resolve)); assert.ok(Object.is(h.mutations[0].value, -0));
    h.ports.drafts = { value: '1.23456789' }; h.blur();
    await new Promise(resolve => setImmediate(resolve)); assert.equal(h.mutations[1].value, 1.23456789);
  });
  it('checkbox and enum still commit immediately from explicit value, before queued draft state', async () => {
    const h = paramHarness('stale'); h.ports.field.type = 'bool'; h.checkbox(false);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(h.mutations[0].value, false);
    h.ports.field.type = 's32'; h.ports.setEnumOpenFieldId = () => {}; h.ports.setEnumFilter = () => {};
    h.enum(42); await new Promise(resolve => setImmediate(resolve)); assert.equal(h.mutations[1].value, 42);
  });
  it('failed blur save retains exact draft and current loaded baseline without reload', async () => {
    const h = paramHarness('bad'); h.ports.props.onApplyFieldMutation = async input => { h.mutations.push(input); return { ok: false, message: 'failed' }; };
    h.blur(); await new Promise(resolve => setImmediate(resolve)); assert.equal(h.reloads(), 0);
    assert.equal(h.ports.drafts.value, 'bad'); assert.equal(h.compare().loaded, h.ports.decodedValues);
    assert.equal(h.pendingDraftUpdates.length, 0); assert.equal(h.toasts[0][0], 'failed');
  });
  it('disclosure identity distinguishes duplicate row IDs, sessions and payload hashes', () => {
    const h = paramHarness(); const key = componentAttribute(param, 'LoadedVersionComparison', 'key');
    const first = evaluate(key, param, h.ports); h.ports.selectedRow.rowIndex = 4;
    assert.notEqual(evaluate(key, param, h.ports), first); h.ports.selectedRow.rowIndex = 3;
    h.ports.selectedRow.dataHash = 'new row'; assert.notEqual(evaluate(key, param, h.ports), first);
    h.ports.selectedRow.dataHash = 'row'; h.ports.documentSessionToken = 'new session'; assert.notEqual(evaluate(key, param, h.ports), first);
  });
});
