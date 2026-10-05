import assert from 'node:assert/strict';
import test from 'node:test';

const {mergeCheckReports}=await import('./merge-check-reports.mjs').catch(()=>({}));
const context=platform=>({sourceHead:'a'.repeat(40),sourceTree:'b'.repeat(40),sourceVerified:true,platform});
const evidence=(status,reasonCode='UNKNOWN')=>({schemaVersion:1,runner:'node',complete:true,total:1,passed:status==='passed'?1:0,failed:status==='failed'?1:0,skipped:status==='skipped'?1:0,cases:[{id:'scripts/actual.test.mjs:10:1:actual',type:'test',status,reasonCode,missingPrerequisites:reasonCode==='PRIVATE_CORPUS_MISSING'?[{kind:'private-game-input',logicalResource:'map/native.msb',status:'missing'}]:[]}]});
const report=(platform,status,reason='UNKNOWN')=>({mode:'run',ok:status==='passed',auditFindings:[],context:context(platform),counts:{passed:status==='passed'?1:0,failed:status==='failed'?1:0,unavailable:status==='unavailable'?1:0,not_run:0},requirements:{tiers:['unit'],suites:[],requireExecuted:false},results:[{scriptName:'file:scripts/actual.test.mjs',tier:'unit',status,exitCode:status==='failed'?1:0,steps:[{key:'op',validation:true,execution:'executed',outcome:status==='unavailable'?'partial':status,caseEvidence:evidence(status==='unavailable'?'skipped':status,reason)}]}]});

test('required cases must actually pass on a matching-source platform',()=>{
  assert.equal(typeof mergeCheckReports,'function');
  const windows=report('win32','unavailable');const linux=report('linux','passed');
  const result=mergeCheckReports([windows,linux]);
  assert.equal(result.ok,true);assert.equal(result.completionVerified,true);
  assert.equal(windows.results[0].status,'unavailable','source report stays honest');
  assert.equal(result.resolutions[0].reason,'executed-on-another-platform');
  assert.equal(mergeCheckReports([windows]).ok,false);
});

test('private missing inputs are explicit nonblocking limits and never verified passes',()=>{
  const input=report('win32','unavailable','PRIVATE_CORPUS_MISSING');
  assert.equal(mergeCheckReports([input]).ok,false);
  const result=mergeCheckReports([input],{allowMissingPrivateCorpus:true});
  assert.equal(result.ok,true);assert.equal(result.completionVerified,false);
  assert.equal(result.resolutions[0].reason,'missing-private-corpus');
  assert.equal(input.counts.passed,0);
  input.results[0].steps[0].caseEvidence.cases[0].missingPrerequisites=[{kind:'published-control',status:'missing'}];
  assert.equal(mergeCheckReports([input],{allowMissingPrivateCorpus:true}).ok,false);
});

test('actual failures, missing checks, mismatched source and incomplete case evidence block',()=>{
  const windows=report('win32','unavailable');const linux=report('linux','passed');
  assert.equal(mergeCheckReports([windows,report('linux','failed')]).ok,false);
  const mismatch=structuredClone(linux);mismatch.context.sourceHead='c'.repeat(40);
  assert.equal(mergeCheckReports([windows,mismatch]).ok,false);
  for(const change of [row=>row.steps[0].caseEvidence.complete=false,row=>row.steps[0].caseEvidence.total=2,row=>row.steps[0].caseEvidence.cases[0].id='unknown',row=>{row.status='not_run';row.reason='excluded';}]){
    const broken=structuredClone(windows);change(broken.results[0]);
    assert.equal(mergeCheckReports([broken,linux]).ok,false);
  }
});

test('private evidence cannot cover additional unknown or unexecuted steps',()=>{
  const input=report('win32','unavailable','PRIVATE_CORPUS_MISSING');
  input.results[0].steps.push({key:'missing',validation:true,execution:'not_run',outcome:'skipped'});
  assert.equal(mergeCheckReports([input],{allowMissingPrivateCorpus:true}).ok,false);
});

test('todo and empty suite declarations cannot substitute for real counterpart execution',()=>{
  const todo=report('win32','unavailable');todo.results[0].steps[0].caseEvidence.cases[0].reasonCode='TEST_TODO';
  assert.equal(mergeCheckReports([todo,report('linux','passed')]).ok,false);
  const windows=report('win32','unavailable'),linux=report('linux','passed');
  for(const input of [windows,linux]){
    const e=input.results[0].steps[0].caseEvidence;
    e.cases[0].type='suite';e.cases[0].titlePath=['empty suite'];
    e.total=0;e.passed=0;e.skipped=0;
  }
  assert.equal(mergeCheckReports([windows,linux]).ok,false);
});

test('empty, damaged, incomplete requirements and contradictory reports fail closed',()=>{
  for(const alter of [r=>{r.results=[];r.counts.passed=0;},r=>r.results[0].steps[0].caseEvidence.complete=false,
    r=>r.requirements.tiers.push('governance'),r=>r.requirements.suites.push('test:renderer-e2e'),
    r=>r.mode='list',r=>r.counts.passed=7,r=>r.ok=false,r=>r.context.sourceVerified=false]){
    const broken=report('linux','passed');alter(broken);assert.equal(mergeCheckReports([broken]).ok,false);
  }
});

test('damaged private diagnostics do not waive requirements and optional unknown skips remain unverified',()=>{
  const bad=report('win32','unavailable','PRIVATE_CORPUS_MISSING');
  bad.results[0].steps[0].caseEvidence.cases[0].missingPrerequisites=[{kind:'private-game-input',logicalResource:'',status:'missing'},{kind:'GPU',status:'broken'}];
  assert.equal(mergeCheckReports([bad],{allowMissingPrivateCorpus:true}).ok,false);
  const optional=report('linux','unavailable');optional.requirements.tiers=[];optional.ok=false;
  optional.results.push({...report('linux','passed').results[0],scriptName:'actual-pass'});optional.counts.passed=1;optional.ok=true;
  const result=mergeCheckReports([optional]);assert.equal(result.ok,true);assert.equal(result.completionVerified,false);
});
