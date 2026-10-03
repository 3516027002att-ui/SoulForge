import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { buildPublicCiReport, PUBLIC_CI_CHECKS } from './ci-public-report.mjs';

const workflow = await readFile(new URL('../.github/workflows/desktop-platform-ci.yml', import.meta.url), 'utf8');
function admits(id, outcomes, cancelled = false) {
  const block = workflow.split(/(?=^      - )/m).find(value => new RegExp(`^        id: ${id}$`, 'm').test(value));
  const condition = block?.match(/^        if: (.+)$/m)?.[1];
  assert.ok(condition, `${id} must explicitly model its prerequisites after a failed runtime step`);
  const expression = condition.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  assert.match(expression, /^[\w\s.()!&=\-'"|]+$/);
  const steps = Object.fromEntries(Object.entries(outcomes).map(([name, outcome]) => [name, { outcome }]));
  return runInNewContext(expression, { steps, cancelled: () => cancelled }, { timeout: 100 });
}

test('an observed runtime failure preserves independent package construction and a failed public verdict', () => {
  const outcomes = Object.fromEntries(PUBLIC_CI_CHECKS.map(({ id }) => [id, 'success']));
  outcomes.database = 'failure';
  assert.equal(admits('package', outcomes), true);
  assert.equal(admits('archive', outcomes), true);
  const steps = Object.fromEntries(Object.entries(outcomes).map(([id, outcome]) => [id, { outcome }]));
  const report = buildPublicCiReport({ runtime: 'linux-x64', steps });
  assert.equal(report.publicStatus, 'failed');
  assert.equal(report.publicChecks.find(x => x.id === 'database').status, 'failed');
  assert.equal(report.publicChecks.find(x => x.id === 'package').status, 'passed');
  assert.equal(report.acceptanceComplete, false);
});

test('failed build inputs, missing Bridge output and cancellation never create a package or an archive', () => {
  const outcomes = Object.fromEntries(PUBLIC_CI_CHECKS.map(({ id }) => [id, 'success']));
  for (const id of ['commands', 'typecheck', 'build', 'publish']) {
    assert.equal(admits('package', { ...outcomes, [id]: 'failure' }), false, id);
    assert.equal(admits('package', { ...outcomes, [id]: 'skipped' }), false, id);
  }
  assert.equal(admits('package', outcomes, true), false);
  assert.equal(admits('archive', { ...outcomes, package: 'failure' }), false);
  assert.equal(admits('archive', outcomes, true), false);
});
