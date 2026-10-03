import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { mkdirSync } from 'node:fs';
import { discoverChecks } from './verify/checkRegistry.mjs';
import { loadWorkspaces } from './verify/scriptGraph.mjs';
import { planScript } from './verify/commandPlan.mjs';

const runner = fileURLToPath(new URL('./check.mjs', import.meta.url));
const compatibilityRunner = fileURLToPath(new URL('./verify.mjs', import.meta.url));
test('unknown tiers reject direct and compatibility entries before any check executes', () => {
  const root = mkdtempSync(join(tmpdir(), 'sf-check-unknown-tier-'));
  try {
    mkdirSync(join(root, 'scripts'), {recursive:true});
    writeFileSync(join(root, 'package.json'), JSON.stringify({scripts:{}}));
    writeFileSync(join(root, 'scripts/proof.test.mjs'),
      'import test from "node:test";import {writeFileSync} from "node:fs";test("actual check",()=>writeFileSync("executed.txt","executed"));');
    for (const entry of [runner, compatibilityRunner]) for (const selection of [
      ['--tier', 'unti', '--list'],
      ['--tier', 'unti', '--audit'],
      ['--tier', 'unit,unti'],
      ['--tier', 'unti', '--suite', 'file:scripts/proof.test.mjs'],
      ['--tier', 'unit', '--require-tier', 'unti'],
      ['--tier', 'unit', '--require-tier', 'unit,unti'],
      ['--tier', 'unit,'],
      ['--require-tier', ',unit']
    ]) {
      const result = spawnSync(process.execPath,
        [entry, ...selection, '--json-out', 'report.json'], {cwd:root, encoding:'utf8'});
      assert.notEqual(result.status, 0, `${entry} ${selection.join(' ')} must reject unknown/empty tiers`);
      assert.match(result.stderr, /Invalid check tier.*(?:unti|empty)/);
      assert.equal(result.stdout.trim(), '', 'invalid selection cannot report successful checks');
      assert.equal(existsSync(join(root, 'executed.txt')), false, 'invalid selection cannot execute a valid prefix');
      assert.equal(existsSync(join(root, 'report.json')), false, 'invalid selection cannot write a success report');
    }
  } finally { rmSync(root, {recursive:true, force:true}); }
});

test('all documented tiers remain selectable and required tiers retain strict unavailable handling', () => {
  const root = mkdtempSync(join(tmpdir(), 'sf-check-known-tiers-'));
  try {
    mkdirSync(join(root, 'scripts'), {recursive:true});
    writeFileSync(join(root, 'package.json'), JSON.stringify({scripts:{}}));
    writeFileSync(join(root, 'scripts/proof.test.mjs'), 'import test from "node:test";test("actual assertion",()=>{});');
    writeFileSync(join(root, 'scripts/missing.test.mjs'), 'import test from "node:test";test("missing fixture",{skip:"native corpus missing"},()=>{});');
    const tiers = ['governance', 'unit', 'synthetic', 'native', 'release', 'e2e'];
    for (const value of [...tiers, tiers.join(','), 'all']) {
      const result = spawnSync(process.execPath, [runner, '--tier', value, '--list'], {cwd:root, encoding:'utf8'});
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.completionVerified, false);
      assert.ok(report.suites.every(row => value === 'all' || value.split(',').includes(row.tier)), value);
    }
    for (const requirement of [
      ['--require-tier', 'unit'],
      ['--require-tier', 'governance,unit'],
      ['--require-executed'],
      ['--require-suite', 'file:scripts/missing.test.mjs']
    ]) {
      const result = spawnSync(process.execPath, [runner, '--tier', 'unit', ...requirement], {cwd:root, encoding:'utf8'});
      const report = JSON.parse(result.stdout);
      assert.equal(result.status, 1, JSON.stringify(report));
      assert.equal(report.results.find(row => row.scriptName === 'file:scripts/missing.test.mjs')?.status, 'unavailable');
      assert.equal(report.ok, false);
      assert.equal(report.completionVerified, false);
    }
  } finally { rmSync(root, {recursive:true, force:true}); }
});

test('public MAP fixtures stay selectable while real resource probes require a native environment', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const registry = discoverChecks(root, loadWorkspaces(root));
  for (const name of ['test:map-streaming-native', 'test:workspace-readiness-native']) {
    assert.equal(registry.get(name)?.tier, 'native', name);
    assert.ok(registry.get(name)?.requirements.includes('native-env'), name);
  }
  assert.equal(registry.get('test:map-streaming-contract')?.tier, 'unit');
  assert.equal(registry.get('test:map-streaming-contract')?.requirements.includes('native-env'), false);
  assert.ok(registry.get('test:map-streaming-contract')?.steps.some(step => step.args.some(arg => arg.endsWith('verify-map-streaming-fixtures.mjs'))));
});
test('public MAP fixture forwarding preserves help and unknown-argument refusal', () => {
  const entry = fileURLToPath(new URL('./verify-map-streaming-fixtures.mjs', import.meta.url));
  const invalid = spawnSync(process.execPath, [entry, '--bogus'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(invalid.status, 2, invalid.stderr);
  assert.match(invalid.stderr, /SF_MAP_ARGS.*unknown argument/);
  const help = spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage:.*--fixture/);
  assert.doesNotMatch(help.stdout, /"pass":\s*true/);
});
test('list and audit inspect checks without claiming actual completion', () => {
  const root = mkdtempSync(join(tmpdir(), 'sf-check-static-completion-'));
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: {} }));
    writeFileSync(join(root, 'scripts/proof.test.mjs'),
      'import test from "node:test";import {writeFileSync} from "node:fs";test("actual check",()=>writeFileSync("executed.txt","executed"));');
    for (const mode of ['--list', '--audit']) {
      const result = spawnSync(process.execPath,
        [runner, '--suite', 'file:scripts/proof.test.mjs', mode], { cwd: root, encoding: 'utf8' });
      const report = JSON.parse(result.stdout);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(report.ok, true, mode);
      assert.equal(report.completionVerified, false, mode);
      assert.deepEqual(report.results, [], mode);
      assert.equal(report.counts.passed, 0, mode);
      assert.equal(existsSync(join(root, 'executed.txt')), false, mode);
    }
    const run = spawnSync(process.execPath,
      [runner, '--suite', 'file:scripts/proof.test.mjs', '--require-executed'], { cwd: root, encoding: 'utf8' });
    const report = JSON.parse(run.stdout);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(report.results[0].status, 'passed');
    assert.equal(report.completionVerified, true);
    assert.equal(existsSync(join(root, 'executed.txt')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('requested missing checks stay not_run without historical required-suite files', () => {
  const root = mkdtempSync(join(tmpdir(), 'sf-current-report-status-'));
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: {} }));
    writeFileSync(join(root, 'scripts/current.test.mjs'), 'console.log("ACTUAL_CURRENT_ASSERTION_EXECUTED")');
    const result = spawnSync(process.execPath,
      [runner, '--suite', 'file:scripts/current.test.mjs,missing-check', '--require-executed'],
      { cwd: root, encoding: 'utf8' });
    const report = JSON.parse(result.stdout);
    assert.equal(report.results.find(row => row.scriptName === 'file:scripts/current.test.mjs')?.status, 'passed');
    assert.equal(report.results.find(row => row.scriptName === 'missing-check')?.status, 'not_run');
    assert.equal(report.ok, false);
    assert.equal(report.completionVerified, false);
    assert.equal(result.status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('the verify compatibility entry discovers current checks without a tier table or legacy governance data',()=>{
 const root=mkdtempSync(join(tmpdir(),'sf-verify-current-entry-'));
 try{
  mkdirSync(join(root,'scripts'),{recursive:true});mkdirSync(join(root,'docs/governance'),{recursive:true});
  writeFileSync(join(root,'package.json'),JSON.stringify({scripts:{}}));
  writeFileSync(join(root,'docs/governance/slices.json'),'retired metadata must never be read');
  writeFileSync(join(root,'scripts/new.test.mjs'),'console.log("NEW_ASSERTION_EXECUTED")');
  const result=spawnSync(process.execPath,[compatibilityRunner,'--suite','file:scripts/new.test.mjs','--require-executed'],{cwd:root,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);const report=JSON.parse(result.stdout);
  assert.equal(report.results[0].status,'passed');assert.equal(report.completionVerified,true);
  const retired=spawnSync(process.execPath,[compatibilityRunner,'--slice','old-slice'],{cwd:root,encoding:'utf8'});
  assert.equal(retired.status,2);assert.equal(JSON.parse(retired.stderr).code,'VERIFY_SLICE_PLAN_RETIRED');
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('registry drift never bans independently parsed checks, failures do not stop unrelated suites', () => {
  const root = mkdtempSync(join(tmpdir(),'sf-check-fixture-'));
  try {
    writeFileSync(join(root,'package.json'),JSON.stringify({scripts:{
      'test:real-agent-harness':'node fail.mjs',
      'test:real-agent-four-tasks':'node pass.mjs',
      'test:unregistered':'node missing-env.mjs'}}));
    writeFileSync(join(root,'fail.mjs'),'console.log("ASSERTION_EXECUTED");process.exit(7)');
    writeFileSync(join(root,'pass.mjs'),'console.log("INDEPENDENT_ASSERTION_PASSED")');
    writeFileSync(join(root,'missing-env.mjs'),'console.log(JSON.stringify({status:"skipped",reason:"fixture missing"}))');
    const result = spawnSync(process.execPath,[runner,'--suite','test:real-agent-harness,test:real-agent-four-tasks,test:unregistered'],
      {cwd:root,encoding:'utf8'});
    assert.equal(result.error,undefined);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.results.map(r => r.status),['failed','passed','unavailable']);
    assert.equal(report.ok,false);
    assert.equal(result.status,1);
    assert.ok(!report.auditFindings.some(f => f.code === 'SUITE_UNREGISTERED'));
    assert.ok(report.results.every(r => r.steps.length > 0));
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('unrelated operational scripts need no registration before discovered tests execute', () => {
  const root = mkdtempSync(join(tmpdir(),'sf-check-no-registration-'));
  try {
    mkdirSync(join(root,'scripts'),{recursive:true});
    writeFileSync(join(root,'package.json'),JSON.stringify({scripts:{'prepare:custom':'node never.mjs','test:custom':'node scripts/custom.test.mjs'}}));
    writeFileSync(join(root,'scripts/custom.test.mjs'),'console.log("CUSTOM_ASSERTION_EXECUTED")');
    const result=spawnSync(process.execPath,[runner,'--tier','unit'],{cwd:root,encoding:'utf8'});
    const report=JSON.parse(result.stdout);
    assert.equal(result.status,0,JSON.stringify(report.auditFindings));
    assert.equal(report.results[0].status,'passed');
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('semantic check selection discovers e2e and release sources without a manual tier row', () => {
  const root = mkdtempSync(join(tmpdir(),'sf-check-semantic-tier-'));
  try {
    mkdirSync(join(root,'apps/desktop/e2e'),{recursive:true});mkdirSync(join(root,'scripts'),{recursive:true});
    writeFileSync(join(root,'package.json'),JSON.stringify({scripts:{'test:arbitrary-ui':'node apps/desktop/e2e/new.test.mjs','test:release-new':'node scripts/release.fixture.mjs'}}));
    writeFileSync(join(root,'apps/desktop/e2e/new.test.mjs'),'console.log("ui")');writeFileSync(join(root,'scripts/release.fixture.mjs'),'console.log("release")');
    const registry=discoverChecks(root,loadWorkspaces(root));
    assert.equal(registry.get('test:arbitrary-ui').tier,'e2e');assert.equal(registry.get('test:release-new').tier,'release');
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('public CI required e2e is executed even when outside its selected tiers',()=>{
 const root=mkdtempSync(join(tmpdir(),'sf-check-ci-required-'));
 try{
  mkdirSync(join(root,'apps/desktop/e2e'),{recursive:true});
  writeFileSync(join(root,'package.json'),JSON.stringify({scripts:{'test:unit':'node unit.mjs','test:renderer-e2e':'node apps/desktop/e2e/ui.test.mjs'}}));
  writeFileSync(join(root,'unit.mjs'),'console.log("UNIT_EXECUTED")');writeFileSync(join(root,'apps/desktop/e2e/ui.test.mjs'),'console.log("E2E_EXECUTED")');
  const result=spawnSync(process.execPath,[runner,'--tier','governance,unit,synthetic','--require-suite','test:renderer-e2e'],{cwd:root,encoding:'utf8'});
  const report=JSON.parse(result.stdout);assert.equal(report.results.find(row=>row.scriptName==='test:renderer-e2e')?.status,'passed');
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('release CI phase retains the packaging gate and installer check despite native dependencies',()=>{
 const root=mkdtempSync(join(tmpdir(),'sf-check-ci-release-'));
 try{
  mkdirSync(join(root,'scripts'),{recursive:true});
  writeFileSync(join(root,'package.json'),JSON.stringify({scripts:{'test:portable-packaging-config-fixtures':'node scripts/config.fixture.mjs','test:portable-packaging-gate':'node scripts/packaging.mjs','test:installer-lifecycle':'node scripts/install.mjs'}}));
  writeFileSync(join(root,'scripts/config.fixture.mjs'),'console.log("CONFIG_EXECUTED")');
  writeFileSync(join(root,'scripts/packaging.mjs'),'console.log(process.env.SOULFORGE_NATIVE_FIXTURE_ROOT);process.exit(7)');
  writeFileSync(join(root,'scripts/install.mjs'),'console.log(JSON.stringify({ok:true,source:process.env.SOULFORGE_NATIVE_FIXTURE_ROOT}))');
  const packaging=spawnSync(process.execPath,[runner,'--tier','release','--filter','portable-packaging'],{cwd:root,encoding:'utf8'});
  assert.equal(packaging.status,1,'actual packaging failure must not be hidden by a passing configuration fixture');
  assert.equal(JSON.parse(packaging.stdout).results.find(row=>row.scriptName==='test:portable-packaging-gate')?.status,'failed');
  const installer=spawnSync(process.execPath,[runner,'--tier','release','--filter','installer-lifecycle','--require-executed'],{cwd:root,encoding:'utf8'});
  assert.equal(JSON.parse(installer.stdout).results[0]?.status,'passed');
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('Node test all-skipped mixed-skipped and zero-test runs never become complete execution proof',()=>{
 const root=mkdtempSync(join(tmpdir(),'sf-check-node-skips-'));
 try{
  mkdirSync(join(root,'scripts'),{recursive:true});mkdirSync(join(root,'packages/empty'),{recursive:true});
  writeFileSync(join(root,'package.json'),JSON.stringify({workspaces:['packages/*'],scripts:{'test:zero':'npm run test -w @test/empty'}}));
  writeFileSync(join(root,'packages/empty/package.json'),JSON.stringify({name:'@test/empty',scripts:{test:'node --test'}}));
  writeFileSync(join(root,'scripts/all-skipped.test.mjs'),"import test from 'node:test';test('native unavailable',{skip:'fixture missing'},()=>{});");
  writeFileSync(join(root,'scripts/mixed.test.mjs'),"import test from 'node:test';test('executed',()=>{});test('native unavailable',{skip:'fixture missing'},()=>{});");
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  for(const name of ['all-skipped','mixed','empty']){
   const suite=name==='empty'?'test:zero':`file:scripts/${name}.test.mjs`;
   const result=spawnSync(process.execPath,[runner,'--suite',suite,'--require-executed'],{cwd:root,encoding:'utf8',env});
   const report=JSON.parse(result.stdout);assert.equal(report.results[0].status,'unavailable',name);assert.equal(report.completionVerified,false);assert.equal(result.status,1);
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('explicit exclusion is not_run and never passed', () => {
  const root = mkdtempSync(join(tmpdir(),'sf-check-exclusion-'));
  try {
    writeFileSync(join(root,'package.json'),JSON.stringify({scripts:{'test:real-agent-harness':'node pass.mjs'}}));
    writeFileSync(join(root,'pass.mjs'),'console.log("passed")');
    const result = spawnSync(process.execPath,[runner,'--tier','unit','--exclude','test:real-agent-harness'],{cwd:root,encoding:'utf8'});
    const report = JSON.parse(result.stdout);
    assert.equal(report.results.find(r => r.scriptName === 'test:real-agent-harness').status,'not_run');
    assert.equal(report.counts.passed,0);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('node --test uses parsed independent operations without requiring a root forwarding alias', () => {
  const root = mkdtempSync(join(tmpdir(),'sf-check-node-test-'));
  try {
    mkdirSync(join(root,'packages/a/src'),{recursive:true});
    writeFileSync(join(root,'package.json'),JSON.stringify({workspaces:['packages/*'],scripts:{test:'npm run test -w @test/a'}}));
    writeFileSync(join(root,'packages/a/package.json'),JSON.stringify({name:'@test/a',scripts:{test:'node --test src/known.test.mjs', 'test:alias':'node --test src/known.test.mjs'}}));
    writeFileSync(join(root,'packages/a/src/known.test.mjs'),'import "node:test";');
    const workspaces = loadWorkspaces(root);
    assert.equal(planScript(root,workspaces,'test')[0].command,'node');
    workspaces.rootScripts = {};
    const registry = discoverChecks(root, workspaces);
    assert.equal(registry.get('workspace:@test/a:test:alias').steps[0].command, 'node');
    writeFileSync(join(root,'package.json'),JSON.stringify({workspaces:['packages/*'],scripts:{}}));
    const result = spawnSync(process.execPath,[runner,'--suite','workspace:@test/a:test:alias'],{cwd:root,encoding:'utf8'});
    const report = JSON.parse(result.stdout);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.results[0].status, 'passed');
    assert.deepEqual(report.auditFindings, []);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('workspace discovery preserves removed forwarding operations while a root-only check remains distinct', () => {
  const root = mkdtempSync(join(tmpdir(), 'sf-check-forwarder-retirement-'));
  try {
    mkdirSync(join(root, 'packages/a/src'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({workspaces:['packages/*'],scripts:{
      'test:forwarded':'npm run test:owned -w @test/a', 'test:root-only':'node root-check.mjs'}}));
    writeFileSync(join(root, 'packages/a/package.json'), JSON.stringify({name:'@test/a',scripts:{'test:owned':'node --test src/guard.test.mjs'}}));
    writeFileSync(join(root, 'packages/a/src/guard.test.mjs'), 'import test from "node:test";test("actual guard",()=>{});');
    writeFileSync(join(root, 'root-check.mjs'), 'console.log("ROOT_ONLY_GUARD")');
    const workspaces = loadWorkspaces(root);
    const keys = () => [...new Set([...discoverChecks(root, workspaces).values()].flatMap(entry => entry.steps.map(step => step.key)))].sort();
    const before = keys();
    delete workspaces.rootScripts['test:forwarded'];
    assert.deepEqual(keys(), before);
    assert.ok(discoverChecks(root, workspaces).get('workspace:@test/a:test:owned'));
    const rootOnlyKey = discoverChecks(root, workspaces).get('test:root-only').steps[0].key;
    delete workspaces.rootScripts['test:root-only'];
    assert.equal(keys().includes(rootOnlyKey), false, 'a root-only assertion cannot be discarded as a forwarder');
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('new unregistered convention test is discovered without duplicated known entries', () => {
  const root = mkdtempSync(join(tmpdir(),'sf-check-discovery-'));
  try {
    mkdirSync(join(root,'scripts'),{recursive:true});
    writeFileSync(join(root,'package.json'),JSON.stringify({scripts:{'test:real-agent-harness':'node --test scripts/known.fixture.mjs'}}));
    writeFileSync(join(root,'scripts/known.fixture.mjs'),'import "node:test";');
    writeFileSync(join(root,'scripts/new.fixture.mjs'),'import "node:test";');
    const registry = discoverChecks(root,loadWorkspaces(root));
    assert.ok(registry.has('file:scripts/new.fixture.mjs'));
    assert.ok(!registry.has('file:scripts/known.fixture.mjs'));
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('unbuilt discovered workspace test is unavailable rather than an assertion failure', () => {
  const root = mkdtempSync(join(tmpdir(),'sf-check-unbuilt-'));
  try {
    mkdirSync(join(root,'packages/a/src'),{recursive:true});
    writeFileSync(join(root,'package.json'),JSON.stringify({workspaces:['packages/*'],scripts:{}}));
    writeFileSync(join(root,'packages/a/package.json'),JSON.stringify({name:'@test/a'}));
    writeFileSync(join(root,'packages/a/src/new.test.ts'),'import "node:test";');
    const result = spawnSync(process.execPath,[runner,'--suite','file:packages/a/src/new.test.ts'],{cwd:root,encoding:'utf8'});
    const report = JSON.parse(result.stdout);
    assert.equal(report.results[0].status,'unavailable');
    assert.equal(report.results[0].steps[0].execution,'not_run');
    assert.equal(report.completionVerified,false);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('failed aggregate does not hide reachable workspace-tail tests from independent execution', () => {
  const root=mkdtempSync(join(tmpdir(),'sf-check-tail-'));
  try{
    mkdirSync(join(root,'packages/a/src'),{recursive:true});
    writeFileSync(join(root,'package.json'),JSON.stringify({workspaces:['packages/*'],scripts:{test:'npm run test -w @test/a'}}));
    writeFileSync(join(root,'packages/a/package.json'),JSON.stringify({name:'@test/a',scripts:{test:'node src/fail.test.mjs && node src/tail.test.mjs','test:tail':'node src/tail.test.mjs'}}));
    writeFileSync(join(root,'packages/a/src/fail.test.mjs'),'process.exit(7)');
    writeFileSync(join(root,'packages/a/src/tail.test.mjs'),'console.log("TAIL_ASSERTION_EXECUTED")');
    const registry=discoverChecks(root,loadWorkspaces(root));
    const tail=[...registry.values()].find(entry=>entry.scriptName!== 'test' && entry.steps.some(step=>step.args.some(arg=>arg.endsWith('tail.test.mjs'))));
    assert.ok(tail,'tail check needs an independent runnable suite');
    const result=spawnSync(process.execPath,[runner,'--tier','unit'],{cwd:root,encoding:'utf8'});
    const report=JSON.parse(result.stdout);
    assert.ok(report.results.some(r=>r.scriptName === 'workspace:@test/a:test:tail' && r.status==='passed'),JSON.stringify(report.results));
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('desktop noEmit tests retain independently selectable entries routed through the actual source runner', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const registry = discoverChecks(root, loadWorkspaces(root));
  const renderer = registry.get('test:renderer-unit');
  assert.ok(renderer);
  for (const source of [
    'apps/desktop/src/main/pathSanitizerConsistency.test.ts',
    'apps/desktop/src/renderer/src/theme/editorWelcome.test.ts',
    'apps/desktop/src/renderer/src/editors/TaeWorkbenchPanel.test.tsx'
  ]) {
    const entry = registry.get(`file:${source}`);
    assert.ok(entry, source);
    assert.equal(entry.buildInput, undefined, source);
    assert.deepEqual(entry.steps.map(step => step.key), renderer.steps.map(step => step.key), source);
    assert.ok(entry.steps.some(step => step.args.includes('scripts/run-renderer-unit-tests.mjs')), source);
  }
});

test('a silent successful build cannot make executed assertion steps unavailable', () => {
  const root = mkdtempSync(join(tmpdir(), 'sf-check-silent-build-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: {
      build: 'node build.mjs', 'test:assertion': 'npm run build && node assertion.mjs'
    } }));
    writeFileSync(join(root, 'build.mjs'), 'process.exitCode = 0;');
    writeFileSync(join(root, 'assertion.mjs'), 'console.log(JSON.stringify({ok:true, assertions:1}));');
    const result = spawnSync(process.execPath, [runner, '--suite', 'test:assertion', '--require-executed'], {cwd:root, encoding:'utf8'});
    const report = JSON.parse(result.stdout);
    assert.equal(result.status, 0, JSON.stringify(report));
    assert.equal(report.results[0].status, 'passed');
    assert.deepEqual(report.results[0].skippedLegs, []);
    assert.equal(report.completionVerified, true);
    writeFileSync(join(root, 'build.mjs'), 'process.exitCode = 9;');
    const failed = spawnSync(process.execPath, [runner, '--suite', 'test:assertion'], {cwd:root, encoding:'utf8'});
    const failedReport = JSON.parse(failed.stdout);
    assert.equal(failed.status, 1);
    assert.equal(failedReport.results[0].status, 'failed');
    assert.equal(failedReport.results[0].steps.length, 1, 'a failed preparation keeps the assertion tail unexecuted');
  } finally { rmSync(root, {recursive:true, force:true}); }
});

test('opaque test commands keep strict skip and empty-output semantics despite being cache barriers', () => {
  const root = mkdtempSync(join(tmpdir(), 'sf-check-opaque-assertions-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: {
      'pretest:opaque': 'node before.mjs', 'test:opaque': 'node assertion.mjs',
      'prebridge:verify:opaque': 'node before.mjs', 'bridge:verify:opaque': 'node assertion.mjs'
    } }));
    writeFileSync(join(root, 'before.mjs'), 'process.exitCode = 0;');
    for (const body of ['', 'console.log(JSON.stringify({status:"skipped",reason:"missing native fixture"}));']) {
      writeFileSync(join(root, 'assertion.mjs'), body);
      for (const suite of ['test:opaque', 'bridge:verify:opaque']) {
        const result = spawnSync(process.execPath, [runner, '--suite', suite, '--require-executed'], {cwd:root, encoding:'utf8'});
        const report = JSON.parse(result.stdout);
        assert.equal(result.status, 1, suite);
        assert.equal(report.results[0].status, 'unavailable', suite);
        assert.equal(report.completionVerified, false, suite);
      }
    }
  } finally { rmSync(root, {recursive:true, force:true}); }
});

test('native oracle inputs and packaged payload reads determine their tiers without named check rows', () => {
  const root = mkdtempSync(join(tmpdir(), 'sf-check-input-tiers-'));
  try {
    mkdirSync(join(root, 'scripts'), {recursive:true});
    writeFileSync(join(root, 'package.json'), JSON.stringify({scripts:{
      'test:any-capture': 'node scripts/capture.test.mjs',
      'test:any-native-source': 'node scripts/action.test.mjs',
      'test:any-product-oracle': 'node scripts/product.test.mjs',
      'test:any-payload': 'node scripts/payload.test.mjs'
    }}));
    writeFileSync(join(root, 'scripts/capture.test.mjs'), 'console.log(process.env.SOULFORGE_MSB_FIELDS);');
    writeFileSync(join(root, 'scripts/action.test.mjs'), 'console.log(process.env.SF_REAL_TAE_SOURCE);');
    writeFileSync(join(root, 'scripts/product.test.mjs'), 'import {readFileSync} from "node:fs"; readFileSync(`${process.env.SOULFORGE_TPF_PRODUCT_ROOT}/apps/desktop/out/main/index.js`);');
    writeFileSync(join(root, 'scripts/payload.test.mjs'), 'import {readFileSync} from "node:fs"; readFileSync("apps/desktop/release/win-unpacked/resources/app.asar");');
    const registry = discoverChecks(root, loadWorkspaces(root));
    for (const name of ['test:any-capture', 'test:any-native-source', 'test:any-product-oracle']) {
      assert.equal(registry.get(name).tier, 'native', name);
      assert.ok(registry.get(name).requirements.includes('native-env'), name);
    }
    assert.equal(registry.get('test:any-payload').tier, 'release');
    assert.ok(registry.get('test:any-payload').requirements.includes('packaged-app'));
  } finally { rmSync(root, {recursive:true, force:true}); }
});
