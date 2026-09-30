import assert from 'node:assert/strict';
import test from 'node:test';
import { runFiniteAgent } from './index.mjs';
const response = (content='', toolCalls=[], usage={outputTokens:1}) => ({message:{role:'assistant',content,...(toolCalls.length?{toolCalls}:{})},finishReason:toolCalls.length?'tool_use':'stop',diagnostics:[],usage});
const call = (id='call-1', name='read') => ({id,name,argumentsJson:'{}'});
const run = (overrides={}) => runFiniteAgent({sessionId:'session',runId:'run',requestId:'request',permissionMode:'normal',messages:[{role:'user',content:'check'}],tools:[{name:'read',permissionLevel:'read',description:'read',parametersJsonSchema:{}}],model:async()=>response('done'),executeTool:async()=>({ok:true,content:'{}'}),allowTool:()=>({ok:true}),...overrides});

test('terminal model output has independent unverified evaluation and monotonic protocol events', async()=>{
 const events=[]; const result=await run({onEvent:e=>events.push(e)});
 assert.equal(result.state,'completed'); assert.equal(result.evaluation,'unverified');
 assert.deepEqual(events.map(e=>e.eventSeq),events.map((_,i)=>i+1));
 assert.ok(events.every(e=>e.protocolVersion===1 && e.runId==='run' && e.requestId==='request'));
});
test('noninteractive approvals park a concrete proposal without executing or requesting another model turn', async()=>{
 let models=0, writes=0;const result=await run({tools:[{name:'rename',permissionLevel:'commit'}],model:async()=>{models++;return response('',[call('write','rename')]);},executeTool:async()=>{writes++;return {ok:true,content:'{}'};}});
 assert.equal(result.state,'waiting'); assert.equal(writes,0);assert.equal(models,1);
 assert.equal(result.pendingApproval.call.name,'rename'); assert.match(result.pendingApproval.proposalHash,/^[a-f0-9]{64}$/);
});
test('denied declaration never enters a domain handler even when its name looks read-only', async()=>{
 let executed=0, turns=0;const result=await run({tools:[{name:'read_trick',permissionLevel:'commit'}],permissionMode:'plan',model:async()=>++turns===1?response('',[call('bad','read_trick')]):response('denied'),allowTool:()=>({ok:false,code:'DENIED',message:'plan'}),executeTool:async()=>{executed++;return {ok:true,content:'{}'};}});
 assert.equal(executed,0);assert.equal(result.toolCalls[0].code,'DENIED');
});
test('bounded tool result keeps committed transaction when cancellation arrives after the write', async()=>{
 const controller=new AbortController();const events=[];const result=await run({signal:controller.signal,onEvent:e=>events.push(e),limits:{maxResultBytes:128},model:async()=>response('',[call()]),executeTool:async()=>{controller.abort();return {ok:true,content:'x'.repeat(1000),transaction:{opId:'op-1',state:'committed',retryable:false}};}});
 assert.equal(result.state,'cancelled');assert.deepEqual(result.transactions,[{opId:'op-1',state:'committed',retryable:false}]);
 assert.ok(events.some(e=>e.event.type==='transaction-observed'&&e.event.transaction.opId==='op-1'));
 assert.ok(Buffer.byteLength(JSON.stringify(result.messages))<1000);
});
test('repeated bounded research has no invented discovery turn limit', async()=>{
 let turns=0;const result=await run({limits:{maxSteps:9},model:async()=>{turns++;return response('',[call(`c-${turns}`)]);}});
 assert.equal(turns,9);assert.equal(result.state,'partial');assert.equal(result.reason,'step_budget');
});
test('missing configured prices blocks a money-budgeted provider before any cost occurs', async()=>{
 let calls=0;const result=await run({limits:{maxCost:1},model:async()=>{calls++;return response('done');}});
 assert.equal(calls,0);assert.equal(result.reason,'cost_configuration_required');
});
test('token reservation never requests more output than the remaining budget', async()=>{
 const seen=[];let calls=0;const result=await run({limits:{maxOutputTokens:3,maxSteps:5},model:async request=>{seen.push(request.maxTokens);calls++;return response('',[call(`c-${calls}`)],{outputTokens:2});}});
 assert.deepEqual(seen,[3,1]);assert.equal(result.reason,'output_budget');
});
test('context and provider response budgets fail closed without silently discarding task history', async()=>{
 let calls=0;const result=await run({messages:[{role:'user',content:'x'.repeat(500)}],limits:{maxContextBytes:128},model:async()=>{calls++;return response('done');}});
 assert.equal(calls,0);assert.equal(result.reason,'context_budget');
});
test('provider failures cannot become completed tasks or replay domain mutations', async()=>{
 const result=await run({model:async()=>{throw new Error('network disconnected');}});
 assert.equal(result.state,'error');assert.equal(result.evaluation,'unverified');assert.equal(result.toolCalls.length,0);
});
test('unregistered tools are denied regardless of host policy callback', async()=>{
 let executed=0, turns=0;const result=await run({model:async()=>++turns===1?response('',[call('unknown','missing')]):response('finished'),executeTool:async()=>{executed++;return {ok:true,content:'{}'};}});
 assert.equal(executed,0);assert.equal(result.toolCalls[0].code,'AGENT_TOOL_NOT_REGISTERED');
});
test('unresponsive provider terminates at the actual elapsed time budget', async()=>{
 const started=Date.now();const result=await run({limits:{timeoutMs:15},model:()=>new Promise(()=>{})});
 assert.equal(result.state,'cancelled');assert.equal(result.reason,'time_budget');assert.ok(Date.now()-started<1000);
});
test('bounded provider retries retain failure telemetry and never replay a successful domain call',async()=>{
 let models=0;const result=await run({model:async()=>++models===1?{message:{role:'assistant',content:''},finishReason:'error',diagnostics:[{severity:'error',code:'MODEL_SERVICE_SERVER_ERROR',message:'fixture'}]}:response('done'),retryDecision:(_diagnostics,attempt)=>({retry:attempt<2,delayMs:0,code:'MODEL_SERVICE_SERVER_ERROR',maxAttempts:2})});
 assert.equal(result.state,'completed');assert.equal(models,2);assert.ok(result.diagnostics.some(d=>d.code==='MODEL_SERVICE_SERVER_ERROR'));
});
test('replayed provider call identities never execute a domain mutation twice',async()=>{
 let writes=0;const result=await run({model:async()=>response('',[call('same-write')]),executeTool:async()=>{writes++;return {ok:true,content:'{}'};}});
 assert.equal(writes,1);assert.equal(result.state,'error');assert.equal(result.reason,'tool_call_identity_invalid');
});
test('a completion containing duplicate identities is rejected before any domain call',async()=>{
 let writes=0;const result=await run({model:async()=>response('',[call('duplicate'),call('duplicate')]),executeTool:async()=>{writes++;return {ok:true,content:'{}'};}});
 assert.equal(writes,0);assert.equal(result.reason,'tool_call_identity_invalid');
});
