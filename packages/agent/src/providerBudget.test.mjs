import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderBudget } from './providerBudget.mjs';
test('every low-level request including compaction reserves only the remaining output and settles actual usage',async()=>{
 const seen=[];const adapter={complete:async request=>{seen.push(request.maxTokens);return {message:{role:'assistant',content:'x'},usage:{inputTokens:2,outputTokens:Math.min(2,request.maxTokens)}};}};
 const budget=createProviderBudget(adapter,{maxOutputTokens:3});await budget.adapter.complete({messages:[],maxTokens:4096});await budget.adapter.complete({messages:[],maxTokens:4096});
 assert.deepEqual(seen,[3,1]);await assert.rejects(()=>budget.adapter.complete({messages:[]}),error=>error.code==='AGENT_PROVIDER_OUTPUT_BUDGET_EXCEEDED');
});
test('unknown usage retains its full reservation and cannot become a free retry',async()=>{
 let calls=0;const budget=createProviderBudget({complete:async()=>{calls++;throw new Error('request outcome unknown');}},{maxOutputTokens:4});
 await assert.rejects(()=>budget.adapter.complete({messages:[],maxTokens:4}),/unknown/);await assert.rejects(()=>budget.adapter.complete({messages:[],maxTokens:4}),error=>error.code==='AGENT_PROVIDER_OUTPUT_BUDGET_EXCEEDED');assert.equal(calls,1);
});
test('configured money budget reserves full serialized input instead of optimistic token estimates',async()=>{
 let calls=0;const budget=createProviderBudget({complete:async()=>{calls++;return {}; }},{maxOutputTokens:10,maxCost:0.00001,pricing:{inputPerMillion:1,outputPerMillion:1}});
 await assert.rejects(()=>budget.adapter.complete({messages:[{role:'user',content:'x'.repeat(100)}],maxTokens:1}),error=>error.code==='AGENT_PROVIDER_COST_BUDGET_EXCEEDED');assert.equal(calls,0);
});
