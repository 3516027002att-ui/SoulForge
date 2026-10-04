import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve('playwright/package.json')), 'cli.js');
const modulePath = require.resolve('@playwright/test');
const reporter = fileURLToPath(new URL('../apps/desktop/e2e/playwright/check-cases-reporter.mjs',import.meta.url));
const privateReason = JSON.stringify({code:'PRIVATE_CORPUS_MISSING',missingPrerequisites:[{kind:'private-game-input',logicalResource:'chr/native.anibnd.dcx',status:'missing'}]});
const oracleReason = JSON.stringify({code:'VERIFICATION_INPUT_MISSING',missingPrerequisites:[{kind:'independent-oracle',sourceEnv:'EXPECTED_COUNT',status:'not-configured'}]});
for (const scenario of [
  {name:'mixed',body:`test('executed',()=>{});test('private',()=>test.skip(true,${JSON.stringify(privateReason)}));`,exit:0,passed:1,failed:0,skipped:1,reason:'PRIVATE_CORPUS_MISSING'},
  {name:'oracle',body:`test('executed',()=>{});test('oracle',()=>test.skip(true,${JSON.stringify(oracleReason)}));`,exit:0,passed:1,failed:0,skipped:1,reason:'VERIFICATION_INPUT_MISSING'},
  {name:'failed',body:`test('failure',()=>expect(1).toBe(2));test('private',()=>test.skip(true,${JSON.stringify(privateReason)}));`,exit:1,passed:0,failed:1,skipped:1,reason:'PRIVATE_CORPUS_MISSING'},
  {name:'unknown',body:`test('unknown',()=>test.skip(true,'missing GPU'));`,exit:0,passed:0,failed:0,skipped:1,reason:'UNKNOWN'}
]) test(`actual browserless Playwright case evidence: ${scenario.name}`,()=>{
  const root = mkdtempSync(join(tmpdir(),'sf-playwright-case-proof-'));
  try {
    const reporters = [['list'],...(existsSync(reporter)?[[reporter,{repoRoot:root}]]:[])];
    writeFileSync(join(root,'playwright.config.mjs'),`export default ${JSON.stringify({testDir:'.',testMatch:'*.spec.cjs',workers:1,retries:0,reporter:reporters})};`);
    writeFileSync(join(root,'proof.spec.cjs'),`const {test,expect}=require(${JSON.stringify(modulePath)});${scenario.body}`);
    const env = {...process.env,FORCE_COLOR:'1'}; delete env.NODE_TEST_CONTEXT; delete env.NO_COLOR;
    const result = spawnSync(process.execPath,[cli,'test','-c',join(root,'playwright.config.mjs')],{cwd:root,env,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
    assert.equal(result.status,scenario.exit,result.stdout+'\n'+result.stderr);
    const proofs = result.stdout.split(/\r?\n/).filter(line=>line.startsWith('{"soulforgeCheckCases":')).map(JSON.parse);
    assert.equal(proofs.length,1,result.stdout);
    const proof = proofs[0].soulforgeCheckCases;
    assert.equal(proof.complete,true);
    assert.equal(proof.total,scenario.passed+scenario.failed+scenario.skipped);
    for (const key of ['passed','failed','skipped']) assert.equal(proof[key],scenario[key]);
    assert.equal(proof.cases.find(c=>c.status==='skipped').reasonCode,scenario.reason);
    assert.ok(proof.cases.every(c=>c.type==='test'&&c.id.startsWith('proof.spec.cjs:')&&!c.id.includes('\\')));
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('actual private E2E entry reasons distinguish missing game from only missing TAE count',()=>{
  const root = mkdtempSync(join(tmpdir(),'sf-private-entry-proof-'));
  const repoRoot = fileURLToPath(new URL('../',import.meta.url));
  try {
    const testDir = join(repoRoot,'apps/desktop/e2e/playwright/tests');
    const run = (matches,extraEnv) => {
      const config=join(root,'playwright.config.mjs');
      writeFileSync(config,`export default ${JSON.stringify({testDir,testMatch:matches,workers:1,retries:0,outputDir:join(root,'results'),reporter:[['list'],[reporter,{repoRoot}]]})};`);
      const env={...process.env,...extraEnv}; delete env.NODE_TEST_CONTEXT; delete env.NO_COLOR;
      const result=spawnSync(process.execPath,[cli,'test','-c',config],{cwd:repoRoot,env,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
      assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
      const proofs=result.stdout.split(/\r?\n/).filter(line=>line.startsWith('{"soulforgeCheckCases":')).map(JSON.parse);
      assert.equal(proofs.length,1,result.stdout);
      return proofs[0].soulforgeCheckCases;
    };
    const privateCases=run(['production-real-assets.spec.mjs','production-tae-count.spec.mjs'],{
      SF_REAL_GAME_ROOT:join(root,'absent-game'),SF_REAL_OVERLAY_ROOT:join(root,'absent-mods'),
      SF_REAL_TAE_SOURCE:'',SF_REAL_TAE_EXPECTED_ANIMATION_COUNT:''
    });
    assert.equal(privateCases.complete,true); assert.equal(privateCases.total,6); assert.equal(privateCases.skipped,6);
    assert.ok(privateCases.cases.every(c=>c.reasonCode==='PRIVATE_CORPUS_MISSING'&&c.missingPrerequisites.some(p=>p.kind==='private-game-input'&&p.status==='missing')));
    const source=join(root,'owned-native-container');writeFileSync(source,'not parsed because independent count is missing');
    const oracleCase=run(['production-tae-count.spec.mjs'],{SF_REAL_GAME_ROOT:root,SF_REAL_TAE_SOURCE:source,SF_REAL_TAE_EXPECTED_ANIMATION_COUNT:''});
    assert.equal(oracleCase.complete,true); assert.equal(oracleCase.total,1);
    assert.equal(oracleCase.cases[0].reasonCode,'VERIFICATION_INPUT_MISSING');
    assert.ok(oracleCase.cases[0].missingPrerequisites.every(p=>p.kind==='independent-oracle'));
  } finally { rmSync(root,{recursive:true,force:true}); }
});
