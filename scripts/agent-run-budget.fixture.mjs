import assert from 'node:assert/strict';
import test from 'node:test';
import {composeAgentSessionOptions} from '../packages/core/dist/model-services/agentHostComposition.js';
import {runFiniteAgentAdapter} from '../packages/core/dist/model-services/finiteAgentAdapter.js';
import {createAgentRunAssembly} from '../packages/core/dist/model-services/agentRunAssembly.js';

const params = {permissionMode:'plan', prompt:'read only'};
const desktop = {defaultTimeoutMs:180_000, defaultTotalTimeoutMs:1_800_000, maxStepsCeiling:200};

test('assembly rejects invalid budgets and synchronous runners through its Promise contract', async () => {
  let calls = 0;
  for (const controls of [{maxCost:0}, {totalTimeoutMs:2 ** 32}]) {
    const assembly = createAgentRunAssembly({tools:[], executeTool:async()=>{throw new Error('no tools');}}, {
      composition:{...desktop, controls}, sessionRunner:()=>{calls++; throw new Error('must not launch');}
    });
    let pending;
    assert.doesNotThrow(() => {pending = assembly.run(params);});
    await assert.rejects(pending, {code:'AGENT_BUDGET_INVALID'});
    await assembly.waitForHostOperations();
  }
  assert.equal(calls, 0);
  const error = new Error('owned synchronous runner failure');
  const assembly = createAgentRunAssembly({tools:[], executeTool:async()=>{throw new Error('no tools');}}, {
    sessionRunner:()=>{throw error;}
  });
  let pending;
  assert.doesNotThrow(() => {pending = assembly.run(params);});
  await assert.rejects(pending, value => value === error);
});

test('desktop normalizes request and total deadlines separately, with optional money limits', () => {
  const result = composeAgentSessionOptions(params, desktop);
  assert.equal(result.timeoutMs, 180_000);
  assert.equal(result.kernelLimits.timeoutMs, 1_800_000);
  assert.equal(result.maxSteps, 200);
  assert.equal(result.kernelLimits.maxCost, undefined);
  assert.equal(result.pricing, undefined);
  const bounded = composeAgentSessionOptions({...params, kernelLimits:{timeoutMs:400, maxSteps:5}},
    {...desktop, controls:{totalTimeoutMs:900, maxSteps:100}});
  assert.equal(bounded.kernelLimits.timeoutMs, 400, 'an existing smaller run deadline wins');
  assert.equal(bounded.maxSteps, 5, 'an existing smaller step ceiling wins');
  const money = composeAgentSessionOptions(params, {...desktop, controls:{maxCost:2, pricing:{inputPerMillion:1, outputPerMillion:3}}});
  assert.equal(money.kernelLimits.maxCost, 2);
  assert.deepEqual(money.pricing, {inputPerMillion:1, outputPerMillion:3});
  assert.throws(() => composeAgentSessionOptions(params, {...desktop, controls:{maxCost:1}}), {code:'AGENT_BUDGET_INVALID'});
  assert.throws(() => composeAgentSessionOptions(params, {...desktop, controls:{totalTimeoutMs:2 ** 32}}), {code:'AGENT_BUDGET_INVALID'});
});

test('per-request timeout never becomes the finite run deadline; UI and report share effective limits', async () => {
  const events = [], calls = [];
  const adapter = {protocol:'openai-compatible', complete:async request => {
    calls.push(request.timeoutMs);
    await new Promise(resolve => setTimeout(resolve, 30));
    return {message:{role:'assistant', content:'done'}, finishReason:'stop', diagnostics:[]};
  }};
  const result = await runFiniteAgentAdapter(adapter, {
    config:{id:'fixture', protocol:'openai-compatible'}, apiKey:'', messages:[{role:'user',content:'read'}],
    tools:[], permissionMode:'plan', timeoutMs:5, executeTool:async()=>{throw new Error('no tools');}, onEvent:event=>events.push(event)
  }, {runId:'run', requestId:'request', limits:{timeoutMs:500, maxSteps:2}});
  assert.deepEqual(calls, [5]);
  assert.equal(result.kernel.state, 'completed', 'the adapter must leave per-call enforcement to the provider transport');
  assert.equal(result.kernel.budget.totalTimeoutMs, 500);
  assert.equal(result.kernel.budget.mode, 'steps-time');
  assert.deepEqual(events.find(event=>event.type==='run-budget')?.budget, result.kernel.budget);
});

test('explicit total deadline still interrupts a stalled provider independently of its request timeout', async () => {
  const safety = new AbortController();
  const timer = setTimeout(()=>safety.abort(), 1000);
  const started=Date.now();
  try {
  const result = await runFiniteAgentAdapter({protocol:'openai-compatible',complete:()=>new Promise(()=>{})}, {
    config:{id:'fixture',protocol:'openai-compatible'}, apiKey:'',messages:[],tools:[],permissionMode:'plan',
    timeoutMs:180_000, signal:safety.signal, executeTool:async()=>{throw new Error('no tools');}
  }, {runId:'run',requestId:'request',limits:{timeoutMs:15}});
  assert.equal(result.kernel.reason, 'time_budget');
  assert.ok(Date.now()-started<900);
  } finally {clearTimeout(timer);}
});
