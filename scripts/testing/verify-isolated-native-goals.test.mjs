/**
 * The independent goal verifier must actually read native resources and bind the evidence to the declared
 * corpus path. Runs the real verifier process on a temporary copy of the configured Mod's param/ and msg/
 * directories, with read-only existence goals so the live corpus values do not matter. Needs the game root
 * and a built core; without SOULFORGE_SEKIRO_GAME_ROOT it is skipped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXED_SCENARIOS } from './real-agent-fixed-scenario-manifest.mjs';
import { evaluateGoalCoverage } from '../real-agent-harness-lib.mjs';

const gameRoot = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim() || process.env.SOULFORGE_SEKIRO_ROOT?.trim();
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const verifier = fileURLToPath(new URL('./verify-isolated-native-goals.mjs', import.meta.url));

function snapshot(root) {
  const entries = [];
  const visit = directory => {
    for (const child of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const absolute = join(directory, child.name);
      const path = relative(root, absolute).split(sep).join('/');
      if (child.isDirectory()) { entries.push({ type: 'directory', path }); visit(absolute); }
      else if (child.isFile()) {
        const bytes = readFileSync(absolute);
        entries.push({ type: 'file', path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      }
    }
  };
  visit(root);
  return { entries };
}

// The fixed scenario's own goal and contract, asserting only that the target value exists.
function existenceGoals(scenario) {
  return scenario.goals.map(({ requireMutation, changedPath, ...goal }) => ({ ...goal, assertion: { ...goal.assertion,
    some: { allOf: goal.assertion.some.allOf.map(clause => (clause.path === 'value' || clause.path === 'text')
      ? { path: clause.path, exists: true } : clause) } } }));
}

test('the independent verifier reads PARAM and FMG natively and binds them to the declared corpus', {
  skip: gameRoot ? false : 'SOULFORGE_SEKIRO_GAME_ROOT is not set'
}, () => {
  const overlay = mkdtempSync(join(tmpdir(), 'sf-goal-verifier-'));
  const storage = mkdtempSync(join(tmpdir(), 'sf-goal-verifier-storage-'));
  try {
    for (const kind of ['param', 'msg']) cpSync(join(gameRoot, 'mods', kind), join(overlay, kind), { recursive: true });
    const tree = snapshot(overlay);
    for (const id of ['fixed-1-gyoubu-ninsatu', 'fixed-6-goods-name-text']) {
      const scenario = FIXED_SCENARIOS.find(entry => entry.id === id);
      const goals = existenceGoals(scenario);
      // Same environment the runner gives the verifier (run-real-agent-gyoubu.mjs).
      const run = spawnSync(process.execPath, [verifier], { cwd: repoRoot, encoding: 'utf8', timeout: 600_000,
        maxBuffer: 64 * 1024 * 1024, env: { ...process.env, SF_E2E_WORKSPACE_STORAGE_ROOT: join(storage, id) },
        input: JSON.stringify({ overlayRoot: overlay, baseRoot: gameRoot, game: 'sekiro', goals,
          treeEvidence: { root: overlay, before: tree, after: tree }, taskContract: scenario.contract }) });
      assert.equal(run.status, 0, run.stderr);
      const { evaluations } = JSON.parse(run.stdout.trim().split('\n').at(-1));
      for (const evaluation of evaluations) {
        assert.equal(evaluation.nativeReadOk, true, `${id}: ${JSON.stringify(evaluation.diagnostics)}`);
        assert.equal(evaluation.sourceHashPresent, true, id);
        assert.equal(evaluation.status, 'verified', `${id}: ${JSON.stringify(evaluation.diagnostics)}`);
      }
      const coverage = evaluateGoalCoverage(evaluations, false, scenario.contract);
      assert.equal(coverage.corpusMismatch, false, `${id}: ${JSON.stringify(coverage.corpusMismatches)}`);
      assert.equal(coverage.status, 'verified', `${id}: ${JSON.stringify(coverage.diagnostics)}`);
    }
  } finally {
    rmSync(overlay, { recursive: true, force: true });
    rmSync(storage, { recursive: true, force: true });
  }
});
