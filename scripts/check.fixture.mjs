import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { mkdirSync } from 'node:fs';
import { discoverChecks, workspaceScriptReachability } from './verify/checkRegistry.mjs';
import { loadWorkspaces } from './verify/scriptGraph.mjs';
import { planScript } from './verify/commandPlan.mjs';

const runner = fileURLToPath(new URL('./check.mjs', import.meta.url));
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
    assert.ok(report.auditFindings.some(f => f.code === 'SUITE_UNREGISTERED'));
    assert.ok(report.results.every(r => r.steps.length > 0));
  } finally {rmSync(root,{recursive:true,force:true});}
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

test('node --test uses parsed independent operations, and covered aliases are reachable', () => {
  const root = mkdtempSync(join(tmpdir(),'sf-check-node-test-'));
  try {
    mkdirSync(join(root,'packages/a/src'),{recursive:true});
    writeFileSync(join(root,'package.json'),JSON.stringify({workspaces:['packages/*'],scripts:{test:'npm run test -w @test/a'}}));
    writeFileSync(join(root,'packages/a/package.json'),JSON.stringify({name:'@test/a',scripts:{test:'node --test src/known.test.mjs', 'test:alias':'node --test src/known.test.mjs'}}));
    writeFileSync(join(root,'packages/a/src/known.test.mjs'),'import "node:test";');
    const workspaces = loadWorkspaces(root);
    assert.equal(planScript(root,workspaces,'test')[0].command,'node');
    assert.equal(workspaceScriptReachability(root,workspaces,workspaces.byName.get('@test/a'),'test:alias'),'reachable');
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
