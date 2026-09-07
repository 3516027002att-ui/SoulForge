import test from 'node:test';
import assert from 'node:assert/strict';
import {checkVerifySummary}from './check-verify-summary.mjs';
const good=()=>({ok:true,mode:'run',requireExecuted:true,results:[{scriptName:'test:audit-msb',outcome:'passed',exitCode:0,treatedAsFailure:false,skippedLegs:[]}],executedAndPassed:['test:audit-msb'],skippedEntirely:[],partiallySkipped:[],failed:[],notAttemptedDueToBail:[],counts:{passed:1,failed:0,skipped:0,partial:0,'not-attempted':0}});
const required=['test:audit-msb'];
test('accepts complete selected execution',()=>assert.equal(checkVerifySummary(good(),required).ok,true));
for(const outcome of ['skipped','partial','not-attempted','failed','done',undefined])test(`rejects outcome ${outcome}`,()=>{const s=good();s.results[0].outcome=outcome;assert.equal(checkVerifySummary(s,required).ok,false);});
const attacks={
 'empty suites':s=>s.results=[],
 'list instead of run':s=>s.mode='list',
 'require flag omitted':s=>delete s.requireExecuted,
 'forged ok':s=>s.ok=false,
 'nonzero process':s=>s.results[0].exitCode=1,
 'missing exit code':s=>delete s.results[0].exitCode,
 'timed out':s=>s.results[0].timedOut=true,
 'spawn error':s=>s.results[0].spawnError='missing executable',
 'skipped subtest':s=>s.results[0].skippedLegs=['native'],
 'missing subtest accounting':s=>delete s.results[0].skippedLegs,
 'duplicate suite':s=>s.results.push({...s.results[0]}),
 'wrong suite':s=>s.results[0].scriptName='test:unrelated',
 'forged passed set':s=>s.executedAndPassed=['test:unrelated'],
 'duplicate passed set':s=>s.executedAndPassed.push(s.executedAndPassed[0]),
 'bail suppression':s=>s.notAttemptedDueToBail.push('test:important'),
 'partial summary':s=>s.partiallySkipped.push({scriptName:'test:audit-msb'}),
 'forged counts':s=>s.counts.passed=2,
 'unknown missing counts':s=>delete s.counts,
 'skipped count hidden':s=>s.counts.skipped=1,
 'unknown failed layer count':s=>s.counts.external=1,
 'null suite':s=>s.results[0]=null,
 'missing failure classification':s=>delete s.results[0].treatedAsFailure,
};
for(const [name,attack] of Object.entries(attacks))test(name,()=>{const s=good();attack(s);assert.equal(checkVerifySummary(s,required).ok,false);});
for(const bad of [[],undefined,['a','a'],['']])test(`invalid required ${JSON.stringify(bad)}`,()=>assert.equal(checkVerifySummary(good(),bad).ok,false));
test('null summary',()=>assert.equal(checkVerifySummary(null,required).ok,false));
