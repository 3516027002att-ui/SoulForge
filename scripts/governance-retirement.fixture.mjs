import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { discoverChecks } from './verify/checkRegistry.mjs';
import { loadWorkspaces } from './verify/scriptGraph.mjs';

const retiredScripts = [
  'gov', 'gov:next', 'gov:status', 'gov:claim', 'gov:heartbeat', 'gov:release',
  'gov:complete', 'gov:seal', 'handoff:fingerprint', 'handoff:project',
  'test:governance', 'test:governance-data-fixtures', 'test:governance-equivalence',
  'test:handoff-integrity', 'test:handoff-integrity:fixtures', 'test:handoff-projection',
  'test:release-scope', 'test:release-scope-proposal', 'test:release-scope-fixtures',
  'test:v06-deferral-index', 'test:v06-deferral-index-fixtures', 'test:required-validation',
  'test:orphan-smoke-gate', 'test:mission1-acceptance'
];
const retiredFiles = [
  'scripts/gov.mjs', 'scripts/gov/lock.mjs', 'scripts/gov/seal.mjs',
  'scripts/verify-gov-cli-fixtures.mjs', 'scripts/verify-seal-cli-fixtures.mjs',
  'scripts/verify/tiers.mjs', 'scripts/handoff-integrity-lib.mjs',
  'scripts/generate-handoff-fingerprint.mjs', 'scripts/generate-handoff-projection.mjs',
  'scripts/verify-handoff-integrity.mjs', 'scripts/verify-handoff-integrity-fixtures.mjs',
  'scripts/verify-handoff-projection-fixtures.mjs', 'scripts/verify-governance.mjs',
  'scripts/verify-governance-data-fixtures.mjs', 'scripts/verify-governance-equivalence.mjs',
  'scripts/verify-release-scope.mjs', 'scripts/verify-release-scope-fixtures.mjs',
  'scripts/release-scope-proposal-lib.mjs', 'scripts/verify-v06-deferral-index.mjs',
  'scripts/verify-v06-deferral-index-fixtures.mjs', 'scripts/verify-required-validation-fixtures.mjs',
  'scripts/verify-orphan-smoke-gate.mjs', 'scripts/governance', 'docs/governance',
  'scripts/verify-mission1-acceptance.mjs', 'scripts/verify-mission1-a1.mjs',
  'scripts/hourly-mission1-check.mjs', 'testdata/mission1/runner-negative-fixtures.v1.json'
];

test('retired governance operations cannot run through aliases or convention discovery', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  for (const name of retiredScripts) assert.equal(Object.hasOwn(pkg.scripts, name), false, name);
  for (const file of retiredFiles) assert.equal(existsSync(file), false, file);
  const root = process.cwd();
  const registry = discoverChecks(root, loadWorkspaces(root));
  for (const entry of registry.values()) {
    assert.equal(retiredScripts.includes(entry.scriptName), false, entry.scriptName);
    for (const step of entry.steps) {
      for (const arg of step.args) {
        assert.equal(retiredFiles.some(file => resolve(step.cwd, arg) === resolve(root, file)), false,
          `${entry.scriptName}: ${arg}`);
      }
    }
  }
  for (const file of ['scripts/generate-mission1-corpus-v2.mjs',
    'scripts/verify-mission1-corpus-v2.mjs', 'docs/historical-governance-evidence.jsonl']) {
    assert.equal(existsSync(file), true, file);
  }
  for (const name of ['test:release-editor-acceptance', 'test:release-content',
    'test:portable-packaging-gate', 'test:installer-lifecycle', 'test:bridge-roots',
    'test:bridge-write-boundary', 'test:core-journal-wiring', 'test:writer-failure-matrix']) {
    assert.ok(registry.get(name)?.steps.length > 0, name);
  }
});

test('CI uses the independent check runner and stable engineering entry points', () => {
  const workflow = readFileSync('.github/workflows/windows-ci.yml', 'utf8');
  assert.doesNotMatch(workflow, /run: node scripts\/verify\.mjs --audit/);
  assert.match(workflow, /node scripts\/check\.mjs --tier/);
  for (const file of ['AGENTS.md', 'ARCHITECTURE.md', 'docs/DECISIONS.md']) {
    assert.equal(existsSync(file), true, file);
  }
});
