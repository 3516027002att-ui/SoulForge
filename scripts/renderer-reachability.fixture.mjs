import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

test('reachability checks split production views and rejects empty branches, stale rulings and test-only evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'sf-reachability-fixture-'));
  const script = join(root, 'scripts', 'verify-renderer-reachability-gate.mjs');
  const app = join(root, 'apps', 'desktop', 'src', 'renderer', 'src', 'App.tsx');
  const view = join(dirname(app), 'app', 'View.tsx');
  const input = (extra = '', jobs = '[]', constants = 'const EMPTY_PARAM_ROWS = [];') =>
    `${constants}\nexport function View(){return <Panel\n jobs={${jobs}}\n patchImpact={null}\n ${extra}\n/>;}`;
  const run = () => {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    return { status: result.status, report: JSON.parse(result.stdout || result.stderr) };
  };
  try {
    mkdirSync(dirname(script), { recursive: true });
    mkdirSync(dirname(view), { recursive: true });
    copyFileSync(new URL('./verify-renderer-reachability-gate.mjs', import.meta.url), script);
    writeFileSync(app, 'export function App(){return <span/>;}');
    writeFileSync(view, input());
    assert.equal(run().report.ok, true, 'real split views must supply the current placeholders and known breakpoints');

    writeFileSync(view, input('definition={live ? null : EMPTY_PARAM_ROWS}'));
    const emptyBranches = run();
    assert.equal(emptyBranches.status, 1);
    const finding = emptyBranches.report.findings.find(item => item.code === 'RENDERER_PROP_UNREACHABLE_BOTH_BRANCHES');
    assert.equal(finding?.prop, 'definition');
    assert.ok(finding.file.endsWith('View.tsx'), 'diagnostic must locate the split source file');

    writeFileSync(view, input('', 'jobs'));
    const stale = run();
    assert.equal(stale.status, 1);
    assert.ok(stale.report.findings.some(item => item.code === 'RENDERER_RULING_STALE' && item.prop === 'jobs'));

    writeFileSync(view, input());
    writeFileSync(join(dirname(view), 'View.test.tsx'), input('definition={live ? null : EMPTY_PARAM_ROWS}'));
    assert.equal(run().report.ok, true, 'test JSX must not be interpreted as real UI wiring');
    writeFileSync(view, input('', '[]', ''));
    const testOnly = run();
    assert.equal(testOnly.status, 1);
    assert.equal(testOnly.report.code, 'EMPTY_CONST_UNEXTRACTABLE', 'test constants cannot substitute for missing production evidence');
  } finally {
    const expectedParent = tmpdir();
    assert.equal(dirname(root), expectedParent, 'cleanup must stay inside the explicit temporary parent');
    rmSync(root, { recursive: true, force: true });
  }
});
