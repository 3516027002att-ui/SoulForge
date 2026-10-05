import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

test('the actual Node reporter preserves executed, private, unknown and suite cases',()=>{
  const root=mkdtempSync(join(tmpdir(),'sf-case-report-'));
  try{
    const reason=JSON.stringify({code:'PRIVATE_CORPUS_MISSING',missingPrerequisites:[{kind:'private-game-input',logicalResource:'chr/c0000.anibnd.dcx',status:'missing'}]});
    writeFileSync(join(root,'proof.test.mjs'),`import {test,describe} from 'node:test';\ndescribe('suite',()=>{test('actual pass',()=>{});test('private',{skip:${JSON.stringify(reason)}},()=>{});test('unknown',{skip:true},()=>{});});\ndescribe('platform suite',{skip:true},()=>{test('not executed',()=>{});});\n`);
    const reporter=new URL('./check-case-reporter.mjs',import.meta.url).href;
    const env={...process.env,SOULFORGE_CHECK_ROOT:root};delete env.NODE_TEST_CONTEXT;
    const result=spawnSync(process.execPath,['--test',`--test-reporter=${reporter}`,'proof.test.mjs'],{cwd:root,encoding:'utf8',env});
    assert.equal(result.status,0,result.stderr);
    const evidence=JSON.parse(result.stdout).soulforgeCheckCases;
    assert.equal(evidence.complete,true);
    assert.deepEqual([evidence.total,evidence.passed,evidence.failed,evidence.skipped],[3,1,0,2]);
    assert.equal(evidence.cases.find(row=>row.titlePath.at(-1)==='private').reasonCode,'PRIVATE_CORPUS_MISSING');
    assert.equal(evidence.cases.find(row=>row.titlePath.at(-1)==='unknown').reasonCode,'UNKNOWN');
    assert.equal(evidence.cases.find(row=>row.id.endsWith(':platform suite')).type,'suite');
    assert.equal(evidence.cases.find(row=>row.id.endsWith(':platform suite')).status,'skipped');
    assert.ok(evidence.cases.every(row=>row.id.startsWith('proof.test.mjs:')));
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('same helper-line child names retain their actual parent identity',()=>{
  const root=mkdtempSync(join(tmpdir(),'sf-case-parent-'));
  try{
    writeFileSync(join(root,'proof.test.mjs'),`import {test,describe} from 'node:test';\nconst child=()=>test('same child',()=>{});\ndescribe('first parent',child);describe('second parent',child);`);
    const env={...process.env,SOULFORGE_CHECK_ROOT:root};delete env.NODE_TEST_CONTEXT;
    const result=spawnSync(process.execPath,['--test',`--test-reporter=${new URL('./check-case-reporter.mjs',import.meta.url).href}`,'proof.test.mjs'],{cwd:root,encoding:'utf8',env});
    assert.equal(result.status,0,result.stderr);
    const evidence=JSON.parse(result.stdout).soulforgeCheckCases;
    assert.equal(evidence.complete,true);
    const children=evidence.cases.filter(row=>row.type==='test');
    assert.equal(new Set(children.map(row=>row.id)).size,2);
    assert.deepEqual(children.map(row=>row.titlePath),[['first parent','same child'],['second parent','same child']]);
  }finally{rmSync(root,{recursive:true,force:true});}
});
