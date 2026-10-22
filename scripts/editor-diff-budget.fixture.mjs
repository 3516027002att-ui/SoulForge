/** Actual bundled comparison helper; allocation/producer counters are test-only. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { build } from 'esbuild';

const helper = fileURLToPath(new URL('../apps/desktop/src/renderer/src/editors/loadedVersionDiff.ts', import.meta.url));
const bundled = (await build({ entryPoints: [helper], write: false, bundle: true, format: 'iife', globalName: 'Comparison',
  plugins: [{ name: 'observe-existing-diff-producer', setup(build) {
    build.onLoad({ filter: /packages[/\\]core[/\\]src[/\\]patch[/\\]textDiff\.ts$/ }, args => ({ loader: 'ts',
      contents: readFileSync(args.path, 'utf8').replace(
        'export function createUnifiedDiff(before: string, after: string, options: UnifiedDiffOptions = {}): string {',
        'export function createUnifiedDiff(before: string, after: string, options: UnifiedDiffOptions = {}): string { globalThis.producerCalls += 1; globalThis.producerChars = Math.max(globalThis.producerChars, before.length + after.length);'
      ) }));
  }}]
})).outputFiles[0].text;

function run(before, after) {
  const context = vm.createContext({ producerCalls: 0, producerChars: 0, encodes: 0,
    JSON: { parse: JSON.parse, stringify(value) { context.encodes += 1; return JSON.stringify(value); } } });
  vm.runInContext('globalThis.rowVisits = 0; const originalMap = Array.prototype.map; Array.prototype.map = function(callback, thisArg) { return originalMap.call(this, (...args) => { if (typeof args[0] === "string") globalThis.rowVisits += 1; return callback.apply(thisArg, args); }); };', context);
  vm.runInContext(bundled, context);
  return { view: context.Comparison.compareLoadedSource(before, after), context };
}

it('large changed window constructs at most the displayed preview rows and skips LCS/encoding', () => {
  const before = Array.from({ length: 20000 }, (_, i) => `old ${i}`).join('\n');
  const after = Array.from({ length: 20000 }, (_, i) => `new ${i}`).join('\n');
  const { view, context } = run(before, after);
  assert.equal(view.coarse, true); assert.equal(view.lines.length, 400); assert.equal(view.omittedLines, 39600);
  assert.equal(view.lines[0].text, 'old 0'); assert.equal(view.lines.at(-1).text, 'new 19999');
  assert.equal(context.producerCalls, 0); assert.equal(context.encodes, 0);
  assert.ok(context.rowVisits <= 400, `Visited ${context.rowVisits} discarded preview rows`);
});

it('a few long lines enter the coarse path before JSON encoding or the quadratic producer', () => {
  const before = 'a'.repeat(100000); const after = 'b'.repeat(100000);
  const { view, context } = run(before, after);
  assert.equal(view.coarse, true); assert.equal(view.lines.length, 2);
  assert.equal(view.lines[0].text, before); assert.equal(view.lines[1].text, after);
  assert.equal(context.encodes, 0); assert.equal(context.producerCalls, 0);
});

it('genuine small replacement still uses the existing producer with a bounded encoded window', () => {
  const { view, context } = run('one\ntwo\nthree', 'one\nchanged\nthree');
  assert.equal(view.coarse, false); assert.equal(context.producerCalls, 1);
  assert.ok(context.producerChars < 200000);
  assert.ok(view.lines.some(line => line.kind === 'remove' && line.text === 'two'));
  assert.ok(view.lines.some(line => line.kind === 'add' && line.text === 'changed'));
});
