#!/usr/bin/env node
/** Validate an actual SoulForge verify.mjs --json-out artifact, not stdout prose. */
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
export function checkVerifySummary(summary, requiredSuites) {
  const errors=[];
  const require=(condition,code)=>{if(!condition)errors.push(code);};
  require(summary!==null&&typeof summary==='object'&&!Array.isArray(summary),'SUMMARY_OBJECT_REQUIRED');
  if(errors.length)return {ok:false,errors};
  require(Array.isArray(requiredSuites)&&requiredSuites.length>0&&requiredSuites.every(s=>typeof s==='string'&&s.length>0),'REQUIRED_SUITES_MISSING');
  if(errors.length)return {ok:false,errors};
  require(new Set(requiredSuites).size===requiredSuites.length,'REQUIRED_SUITES_DUPLICATE');
  require(summary.mode==='run','NOT_EXECUTION_RESULT');
  require(summary.ok===true,'RUNNER_NOT_PASSED');
  require(summary.requireExecuted===true,'REQUIRE_EXECUTED_NOT_ENABLED');
  require(Array.isArray(summary.results)&&summary.results.length>0,'EMPTY_RESULT_SET');
  if(!Array.isArray(summary.results))return{ok:false,errors};
  const seen=new Set(),passed=new Set();
  for(const r of summary.results){
    if(r===null||typeof r!=='object'){errors.push('INVALID_SUITE_RECORD');continue;}
    require(typeof r.scriptName==='string'&&r.scriptName.length>0,'SUITE_NAME_MISSING');
    require(!seen.has(r.scriptName),'DUPLICATE_SUITE_RESULT');seen.add(r.scriptName);
    // A task-specific invocation must have every selected suite actually pass.
    require(r.outcome==='passed',`SUITE_NOT_PASSED:${r.scriptName}`);
    require(r.exitCode===0,`SUITE_EXIT_NONZERO_OR_MISSING:${r.scriptName}`);
    require(r.treatedAsFailure===false,`SUITE_TREATED_AS_FAILURE:${r.scriptName}`);
    require(r.timedOut!==true&&!r.spawnError,`SUITE_EXECUTION_ERROR:${r.scriptName}`);
    require(Array.isArray(r.skippedLegs)&&r.skippedLegs.length===0,`SUITE_HAS_SKIPPED_OR_UNKNOWN_LEGS:${r.scriptName}`);
    if(r.outcome==='passed')passed.add(r.scriptName);
  }
  for(const s of requiredSuites)require(seen.has(s),`REQUIRED_SUITE_NOT_EXECUTED:${s}`);
  require(Array.isArray(summary.executedAndPassed),'PASSED_SET_MISSING');
  if(Array.isArray(summary.executedAndPassed)){
    const declared=new Set(summary.executedAndPassed);
    require(declared.size===summary.executedAndPassed.length,'PASSED_SET_DUPLICATE');
    require(declared.size===passed.size&&[...passed].every(s=>declared.has(s)),'PASSED_SET_MISMATCH');
  }
  for(const key of ['skippedEntirely','partiallySkipped','failed','notAttemptedDueToBail'])
    require(Array.isArray(summary[key])&&summary[key].length===0,`UNEXECUTED_OR_FAILED:${key}`);
  require(summary.counts!==null&&typeof summary.counts==='object'&&!Array.isArray(summary.counts),'COUNTS_MISSING');
  if(summary.counts&&typeof summary.counts==='object'){
    require(summary.counts.passed===passed.size,'PASSED_COUNT_MISMATCH');
    for(const [key,value]of Object.entries(summary.counts))
      require(Number.isInteger(value)&&value>=0&&(key==='passed'||value===0),`COUNTS_INVALID_OR_NOT_PASSED:${key}`);
  }
  return {ok:errors.length===0,errors,requiredSuites,validatedSuites:[...seen]};
}
function cli(){
  try{
    const [summaryPath,requiredPath,...extra]=process.argv.slice(2);
    if(!summaryPath||!requiredPath||extra.length)throw new Error('Usage: node check-verify-summary.mjs <summary.json> <required-suites.json>');
    const summary=JSON.parse(readFileSync(summaryPath,'utf8'));
    const required=JSON.parse(readFileSync(requiredPath,'utf8'));
    const result=checkVerifySummary(summary,required);
    console.log(JSON.stringify(result,null,2));process.exitCode=result.ok?0:1;
  }catch(error){console.error(JSON.stringify({ok:false,error:String(error.message??error)}));process.exitCode=2;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)cli();
