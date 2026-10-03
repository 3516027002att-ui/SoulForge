/**
 * Execute the real layout callbacks with synthetic hook/ref inputs.
 * This checks stored-width contracts, not React layout, CSS bounds or pixels.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import { transformSync } from 'esbuild';

const source = readFileSync(new URL('../apps/desktop/src/renderer/src/workbench/WorkbenchLayout.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert(from >= 0 && to > from, `Missing layout callback boundary: ${start}`);
  return source.slice(from, to);
}
const callbackSource = transformSync([
  section('  function maxWidthFor(', '  const onPointerMove'),
  section('  const onPointerMove', '  const onPointerUp'),
  section('  function onSeparatorKeyDown(', '\n  return (\n    <div'),
  'globalThis.callbacks = { onPointerMove, onSeparatorKeyDown };'
].join('\n'), { loader: 'ts', sourcefile: fileURLToPath(import.meta.url) }).code;

function harness(containerWidth, activeDrag = true) {
  const widths = { objects: 200 };
  const column = { id: 'objects', minWidth: 200 };
  let writes = 0;
  const context = vm.createContext({
    DEFAULT_MIN_WIDTH: 120,
    RESIZER_WIDTH: 4,
    columnsRef: { current: containerWidth === null ? null : { clientWidth: containerWidth } },
    columnsForDragRef: { current: [column, { id: 'viewport', minWidth: 120 }, { id: 'properties', minWidth: 240 }] },
    dragState: { current: activeDrag ? { columnId: column.id, startX: 0, startWidth: 200, minWidth: 200 } : null },
    useCallback: callback => callback,
    widths,
    setWidths: update => { writes += 1; Object.assign(widths, update(widths)); }
  });
  vm.runInContext(callbackSource, context);
  return {
    pointer(clientX) { context.callbacks.onPointerMove({ clientX }); return widths.objects; },
    key(key) { context.callbacks.onSeparatorKeyDown(column, { key, preventDefault() {} }); return widths.objects; },
    writes: () => writes
  };
}

describe('Workbench stored column-width contract', () => {
  for (const delta of [-500, 16, 500]) {
    it(`pointer keeps the declared minimum when a 520px container cannot fit all columns (${delta}px)`, () => {
      assert.equal(harness(520).pointer(delta), 200);
    });
  }
  it('pointer and keyboard agree on the narrow-container minimum', () => {
    assert.equal(harness(520).pointer(16), harness(520).key('ArrowRight'));
  });
  it('a 600px container preserves normal movement and both boundaries', () => {
    assert.equal(harness(600).pointer(16), 216);
    assert.equal(harness(600).pointer(-500), 200);
    assert.equal(harness(600).pointer(500), 232);
    assert.equal(harness(600).key('ArrowRight'), 216);
    assert.equal(harness(600).key('ArrowLeft'), 200);
  });
  for (const width of [null, 0, -1]) {
    it(`an unavailable container measurement (${width}) does not collapse a column`, () => {
      assert.equal(harness(width).pointer(16), 216);
    });
  }
  it('a pointer move without an active drag does not write widths', () => {
    const state = harness(520, false);
    assert.equal(state.pointer(16), 200);
    assert.equal(state.writes(), 0);
  });
  it('an unsupported separator key does not write widths', () => {
    const state = harness(520);
    assert.equal(state.key('Tab'), 200);
    assert.equal(state.writes(), 0);
  });
});
