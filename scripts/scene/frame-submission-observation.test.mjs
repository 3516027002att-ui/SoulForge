import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ts = require(process.env.SOULFORGE_TEST_TYPESCRIPT_PATH ?? 'typescript');
const controllerPath = fileURLToPath(new URL('../../apps/desktop/src/renderer/src/scene/threeSceneController.ts', import.meta.url));
const loopPath = fileURLToPath(new URL('../../apps/desktop/src/renderer/src/scene/sceneRenderLoop.ts', import.meta.url));
const controller = readFileSync(controllerPath, 'utf8');
const ast = ts.createSourceFile(controllerPath, controller, ts.ScriptTarget.Latest, true);
const factories = [];
function visit(node) {
  if (ts.isNewExpression(node) && node.expression.getText(ast) === 'SceneRenderLoop') factories.push(node);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(factories.length, 1, 'Observe the actual controller frame callback');
const renderSource = factories[0].arguments[0].properties.find(property => property.name?.getText(ast) === 'render').initializer.getText(ast);
const loopJs = ts.transpileModule(readFileSync(loopPath, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;

// Actual callback and cadence helper, controlled renderer/event/clock ports.
// These are observation-contract regressions, not GPU/first-frame measurements.
function harness(options = {}) {
  const { clockError, eventError, constructorError, renderError, noWindow = false } = options;
  const timeOrigin = Object.hasOwn(options, 'timeOrigin') ? options.timeOrigin : 1000;
  const at = Object.hasOwn(options, 'at') ? options.at : 20;
  const exports = {}, canvas = {}, events = [], frames = [], cancelled = [];
  let renderCalls = 0;
  const window = { dispatchEvent(event) { if (eventError) throw eventError; events.push(event); return true; } };
  const context = vm.createContext({
    exports, module: { exports }, canvas, scene: {}, camera: {},
    renderer: { render() { renderCalls += 1; if (renderError) throw renderError; } },
    performance: { get timeOrigin() { if (clockError) throw clockError; return timeOrigin; }, now: () => at },
    ...(noWindow ? {} : { window }),
    CustomEvent: class { constructor(type, options) { if (constructorError) throw constructorError; this.type = type; this.detail = options.detail; } }
  });
  vm.runInContext(loopJs, context);
  const render = vm.runInContext(`(${renderSource})`, context);
  // Cadence has its existing independent clock. Only the submitted-frame
  // observation clock is faulted; cadence/update/render faults stay errors.
  const loop = new exports.SceneRenderLoop({
    render, update() {}, now: () => 0,
    schedule(callback) { frames.push(callback); return frames.length; },
    cancel(id) { cancelled.push(id); }
  });
  return { loop, canvas, events, frames, cancelled, renders: () => renderCalls };
}

test('successful submission records the same canvas/clock point and preserves RAF/disposal', () => {
  const h = harness(); h.loop.start();
  assert.equal(h.renders(), 1); assert.equal(h.frames.length, 1);
  assert.equal(h.events[0].type, 'sf-scene-frame-submitted');
  assert.equal(h.events[0].detail.canvas, h.canvas);
  assert.equal(h.events[0].detail.submittedAtUnixMs, 1020);
  h.loop.requestRender(); h.frames[0](34);
  assert.equal(h.renders(), 2); assert.equal(h.events.length, 2); assert.equal(h.frames.length, 2);
  h.loop.dispose(); assert.deepEqual(h.cancelled, [2]);
  h.frames[1](68); assert.equal(h.renders(), 2);
});

test('an observation clock already failing before frame entry cannot block rendering/cadence', () => {
  const h = harness({ clockError: new Error('observation clock unavailable') });
  assert.doesNotThrow(() => h.loop.start());
  assert.equal(h.renders(), 1); assert.equal(h.events.length, 0); assert.equal(h.frames.length, 1);
  h.loop.requestRender(); assert.doesNotThrow(() => h.frames[0](34));
  assert.equal(h.renders(), 2); assert.equal(h.frames.length, 2);
  h.loop.dispose();
});

test('post-render event or event construction failure preserves a successful render and next RAF', () => {
  for (const option of ['eventError', 'constructorError']) {
    const h = harness({ [option]: new Error('observation sink unavailable') });
    assert.doesNotThrow(() => h.loop.start());
    assert.equal(h.renders(), 1); assert.equal(h.frames.length, 1);
    h.loop.requestRender(); assert.doesNotThrow(() => h.frames[0](34));
    assert.equal(h.renders(), 2); assert.equal(h.frames.length, 2);
    h.loop.dispose();
  }
});

test('missing/nonfinite observation clock does not invent a submitted-frame timestamp', () => {
  for (const options of [{ timeOrigin: NaN }, { timeOrigin: Infinity }, { timeOrigin: undefined }, { at: undefined }, { at: NaN }, { noWindow: true }]) {
    const h = harness(options);
    assert.doesNotThrow(() => h.loop.start());
    assert.equal(h.renders(), 1); assert.equal(h.events.length, 0); assert.equal(h.frames.length, 1);
    h.loop.dispose();
  }
});

test('actual render failures retain their exact error and produce no successful submission', () => {
  const failure = new Error('actual renderer failure');
  const h = harness({ renderError: failure, eventError: new Error('sink'), clockError: new Error('clock') });
  assert.throws(() => h.loop.start(), error => error === failure);
  assert.equal(h.renders(), 1); assert.equal(h.events.length, 0); assert.equal(h.frames.length, 0);
  h.loop.dispose();
});
