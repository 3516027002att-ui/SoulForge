import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('a later contract exception cannot become exit zero after observing the production main bundle', () => {
  const observer = new URL('./desktopSurface.mjs', import.meta.url).href;
  const source = `import { observeMainSurface } from ${JSON.stringify(observer)}; await observeMainSurface(); throw new Error('CONTRACT_SENTINEL_FAILURE');`;
  const run = spawnSync(process.execPath, ['--input-type=module', '--eval', source], { encoding: 'utf8' });
  assert.match(run.stderr, /CONTRACT_SENTINEL_FAILURE/, 'the child must reach the deliberate post-observation exception');
  assert.equal(run.status, 1, 'production main exception logging must not turn a failed test into success');
});
