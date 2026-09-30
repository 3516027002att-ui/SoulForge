#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadWorkspaces } from './verify/scriptGraph.mjs';
import { discoverChecks, auditCheckRegistration } from './verify/checkRegistry.mjs';
import { runPlannedSuite, OUTCOME } from './verify/runner.mjs';
import { summarizePlan } from './verify/commandPlan.mjs';

const options = {tiers:['unit'],suites:[],exclude:[],requiredTiers:[],requiredSuites:[],filter:null,list:false,audit:false,timeoutMs:900000,jsonOut:null};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--list') options.list = true;
  else if (arg === '--audit') options.audit = true;
  else if (arg === '--require-executed') options.requireExecuted = true;
  else if (arg === '--no-bail') { /* Compatibility: independent checks always continue. */ }
  else if (['--tier','--suite','--exclude','--filter','--require-tier','--require-suite','--timeout-ms','--json-out'].includes(arg)) {
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    if (arg === '--tier') options.tiers = value === 'all' ? ['governance','unit','synthetic','native','release','e2e'] : value.split(',');
    if (arg === '--suite') options.suites.push(...value.split(','));
    if (arg === '--exclude') options.exclude.push(...value.split(','));
    if (arg === '--filter') options.filter = value;
    if (arg === '--require-tier') options.requiredTiers.push(...value.split(','));
    if (arg === '--require-suite') options.requiredSuites.push(...value.split(','));
    if (arg === '--timeout-ms') options.timeoutMs = Number(value);
    if (arg === '--json-out') options.jsonOut = value;
  } else throw new Error(`Unknown check option: ${arg}`);
}
if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error('Invalid timeout');
const repoRoot = process.cwd();
const workspaces = loadWorkspaces(repoRoot);
const registry = discoverChecks(repoRoot,workspaces);
const auditFindings = auditCheckRegistration(repoRoot,workspaces);
const names = options.suites.length ? options.suites : [...registry.keys()].filter(name => options.tiers.includes(registry.get(name).tier) && (!options.filter || name.includes(options.filter)));
const results = [];
const cache = new Map();
const plan = [];
for (const name of names) {
  const entry = registry.get(name);
  if (!entry) {results.push({scriptName:name,status:'not_run',reason:'unknown-check',steps:[]});continue;}
  if (options.exclude.includes(name)) {results.push({scriptName:name,tier:entry.tier,status:'not_run',reason:'excluded',steps:[]});continue;}
  plan.push(entry);
}
const modernStatus = outcome => outcome === OUTCOME.PASSED ? 'passed' : outcome === OUTCOME.FAILED ? 'failed'
  : outcome === OUTCOME.NOT_ATTEMPTED ? 'not_run' : 'unavailable';
if (!options.list && !options.audit) for (const entry of plan) {
  try {
    if (entry.buildInput && !entry.steps.some(step => step.kind === 'prepare')
      && entry.steps.some(step => !existsSync(resolve(step.cwd,step.args.at(-1))))) {
      results.push({scriptName:entry.scriptName,tier:entry.tier,status:'unavailable',reason:'required-build-output-missing',
        buildInput:entry.buildInput,steps:entry.steps.map(step => ({...step,execution:'not_run',status:'unavailable'}))});
      continue;
    }
    const result = await runPlannedSuite({repoRoot,entry,timeoutMs:options.timeoutMs,cache,
      injectEnv:workspaces.rootScripts['check'] !== undefined});
    results.push({...result,stdout:undefined,stderr:undefined,tier:entry.tier,status:modernStatus(result.outcome),
      ...(result.outcome !== OUTCOME.PASSED ? {tailStdout:result.stdout.slice(-8192),tailStderr:result.stderr.slice(-8192)}:{})});
  } catch (error) {results.push({scriptName:entry.scriptName,tier:entry.tier,status:'failed',reason:error.message,steps:[]});}
}
const counts = Object.fromEntries(['passed','failed','unavailable','not_run'].map(status => [status,results.filter(r => r.status === status).length]));
const blocking = results.filter(r => r.status === 'failed' || r.status === 'not_run'
  || (r.status === 'unavailable' && (options.requireExecuted || options.requiredTiers.includes(r.tier) || options.requiredSuites.includes(r.scriptName))));
const ok = auditFindings.every(f => f.severity !== 'error') && blocking.length === 0
  && (options.list || options.audit || results.some(r => r.status === 'passed'));
const report = {ok,completionVerified:ok && counts.unavailable === 0 && counts.not_run === 0,mode:options.list ? 'list':options.audit ? 'audit':'run',counts,auditFindings,
  scheduling:summarizePlan(plan),...(options.list ? {suites:plan}:{}),results};
if (options.jsonOut) {const path = resolve(repoRoot,options.jsonOut);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,`${JSON.stringify(report,null,2)}\n`);}
console.log(JSON.stringify(report,null,2));
process.exitCode = ok ? 0 : 1;
