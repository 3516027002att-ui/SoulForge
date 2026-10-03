import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { runFiniteAgent } from './index.mjs';
const response = (content='', toolCalls=[], usage={outputTokens:1}) => ({message:{role:'assistant',content,...(toolCalls.length?{toolCalls}:{})},finishReason:toolCalls.length?'tool_use':'stop',diagnostics:[],usage});
const call = (id='call-1', name='read') => ({id,name,argumentsJson:'{}'});
const run = (overrides={}) => runFiniteAgent({sessionId:'session',runId:'run',requestId:'request',permissionMode:'normal',messages:[{role:'user',content:'check'}],tools:[{name:'read',permissionLevel:'read',description:'read',parametersJsonSchema:{}}],model:async()=>response('done'),executeTool:async()=>({ok:true,content:'{}'}),allowTool:()=>({ok:true}),...overrides});

test('terminal model output has independent unverified evaluation and monotonic protocol events', async()=>{
 const events=[]; const result=await run({onEvent:e=>events.push(e)});
 assert.equal(result.state,'completed'); assert.equal(result.evaluation,'unverified');
 assert.equal(events.filter(event=>event.event.type==='step-complete').length,1);
 assert.equal(events.find(event=>event.event.type==='step-complete').event.finishReason,'stop');
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

test('explicit full-mode approval requirements are honored and recorded before a write',async()=>{
 let turns=0,asked=0,writes=0;const result=await run({permissionMode:'full',approvalRequiredLevels:['commit'],tools:[{name:'rename',permissionLevel:'commit'}],
  model:async()=>++turns===1?response('',[call('first','rename')]):response('denied'),requestApproval:async request=>{asked++;assert.equal(request.toolName,'rename');assert.equal(request.argumentsJson,'{}');return {decision:'reject',note:'keep original'};},
  executeTool:async()=>{writes++;return {ok:true,content:'{}'};}});
 assert.equal(asked,1);assert.equal(writes,0);assert.equal(result.approvals[0].decision,'reject');assert.equal(result.approvals[0].note,'keep original');
});

for(const decision of ['always','never'])test(`approval ${decision} memory is per-run and records each distinct provider call`,async()=>{
 let turns=0,asked=0,writes=0;const events=[];
 const result=await run({tools:[{name:'rename',permissionLevel:'commit'}],onEvent:event=>events.push(event),model:async()=>++turns<=2?response('',[call(`call-${turns}`,'rename')]):response('reported'),
  requestApproval:async()=>{asked++;return {decision};},executeTool:async()=>{writes++;return {ok:true,content:'{}'};}});
 assert.equal(asked,1);assert.equal(writes,decision==='always'?2:0);assert.deepEqual(result.approvals.map(item=>item.fromMemory),[false,true]);
 assert.deepEqual(events.filter(event=>event.event.type==='approval-resolved').map(event=>event.event.fromMemory),[false,true]);
 let nextAsked=0;await run({tools:[{name:'rename',permissionLevel:'commit'}],limits:{maxSteps:1},model:async()=>response('',[call('next-run','rename')]),requestApproval:async()=>{nextAsked++;return {decision:'reject'};}});assert.equal(nextAsked,1);
});

test('write-level legacy declarations require approval while explicit empty requirements retain host authorization',async()=>{
 let writes=0;const tools=[{name:'rename',permissionLevel:'write'}];
 const waiting=await run({tools,model:async()=>response('',[call('pending','rename')]),executeTool:async()=>{writes++;return {ok:true,content:'{}'};}});
 assert.equal(waiting.state,'waiting');assert.equal(writes,0);
 const granted=await run({tools,approvalRequiredLevels:[],limits:{maxSteps:1},model:async()=>response('',[call('granted','rename')]),requestApproval:async()=>{throw new Error('must not ask');},executeTool:async()=>{writes++;return {ok:true,content:'{}'};}});
 assert.equal(writes,1);assert.equal(granted.approvals.length,0);
});

test('approval abort stops every remaining call in the turn and invalid/failed decisions execute none',async()=>{
 let writes=0;const tools=[{name:'rename',permissionLevel:'commit'}];
 const aborted=await run({tools,model:async()=>response('',[call('first','rename'),call('second','rename')]),requestApproval:async()=>({decision:'abort'}),executeTool:async()=>{writes++;return {ok:true,content:'{}'};}});
 assert.equal(aborted.state,'cancelled');assert.equal(writes,0);assert.equal(aborted.approvals.length,1);
 const invalid=await run({tools,model:async()=>response('',[call('invalid','rename')]),requestApproval:async()=>({decision:'unexpected'}),executeTool:async()=>{writes++;return {ok:true,content:'{}'};}});
 assert.equal(invalid.state,'error');assert.ok(invalid.diagnostics.some(item=>item.code==='AGENT_APPROVAL_RESPONSE_INVALID'));
 const failed=await run({tools,model:async()=>response('',[call('failed','rename')]),requestApproval:async()=>{throw new Error('fixture failure');},executeTool:async()=>{writes++;return {ok:true,content:'{}'};}});
 assert.equal(failed.state,'error');assert.ok(failed.diagnostics.some(item=>item.code==='AGENT_APPROVAL_REQUEST_FAILED'));assert.equal(writes,0);
});

test('an overflowing provider response cannot dispatch its proposed mutation',async()=>{
 let writes=0;const result=await run({limits:{maxOutputTokens:2},model:async()=>response('',[call()],{outputTokens:5}),executeTool:async()=>{writes++;return {ok:true,content:'{}'};}});
 assert.equal(writes,0);assert.equal(result.state,'partial');assert.equal(result.reason,'output_budget');assert.ok(result.diagnostics.some(item=>item.code==='MODEL_SERVICE_OUTPUT_BUDGET_EXCEEDED'));
});

test('tool_use without any calls stops partial after one provider request',async()=>{
 let models=0;const result=await run({model:async()=>{models++;return {message:{role:'assistant',content:''},finishReason:'tool_use',diagnostics:[]};}});
 assert.equal(models,1);assert.equal(result.state,'partial');assert.equal(result.reason,'tool_use_without_calls');assert.ok(result.diagnostics.some(item=>item.code==='AGENT_TOOL_USE_WITHOUT_CALLS'));
});
for(const level of ['read','commit'])test(`a truncated provider response cannot approve or dispatch a ${level} proposal`,async()=>{
 let turns=0,executed=0,approvals=0;const events=[];
 const result=await run({tools:[{name:'fixture',permissionLevel:level}],model:async()=>{turns++;return {message:{role:'assistant',content:'Partial provider report',toolCalls:[call('truncated','fixture')]},finishReason:'length',diagnostics:[],usage:{inputTokens:1,outputTokens:1}};},onEvent:event=>events.push(event),requestApproval:async()=>{approvals++;return {decision:'once'};},executeTool:async()=>{executed++;return {ok:true,content:'{}',transaction:{opId:'must-not-commit',state:'committed'}};}});
 assert.equal(result.state,'partial');assert.equal(result.reason,'provider_length');
 assert.equal(turns,1);assert.equal(executed,0);assert.equal(approvals,0);assert.equal(result.toolCalls.length,0);assert.equal(result.transactions.length,0);
 assert.equal(result.messages.at(-1).content,'Partial provider report');
 assert.deepEqual(events.filter(event=>event.event.type==='agent-message-delta').map(event=>event.event.text),['Partial provider report']);
});

test('declared parallel reads settle in emission order before an exclusive mutation',async()=>{
 let release;const wait=new Promise(resolve=>{release=resolve;});const starts=[],ends=[];let models=0;
 const result=await run({permissionMode:'full',approvalRequiredLevels:[],limits:{timeoutMs:150},tools:[{name:'first',permissionLevel:'read',supportsParallel:true},{name:'second',permissionLevel:'read',supportsParallel:true},{name:'mutate',permissionLevel:'commit',supportsParallel:true}],
  model:async()=>++models===1?response('',[call('one','first'),call('two','second'),call('write','mutate')]):response('reported'),
  onEvent:event=>{if(event.event.type==='tool-call-end')ends.push(event.event.name);},executeTool:async call=>{
   starts.push(call.name);if(call.name==='first')await wait;else if(call.name==='second')release();
   if(call.name==='mutate')assert.deepEqual(ends,['first','second']);return {ok:true,content:JSON.stringify({name:call.name})};}});
 assert.equal(result.state,'completed');assert.deepEqual(starts,['first','second','mutate']);assert.deepEqual(ends,['first','second','mutate']);
 assert.deepEqual(result.messages.filter(message=>message.role==='tool').map(message=>message.name),['first','second','mutate']);
});

test('a thrown read remains a redacted failure beside completed siblings; a thrown mutation remains unknown',async()=>{
 let models=0;const result=await run({tools:[{name:'first',permissionLevel:'read',supportsParallel:true},{name:'second',permissionLevel:'read',supportsParallel:true}],redact:text=>text.replaceAll('fixture-secret','[REDACTED]'),
  model:async()=>++models===1?response('',[call('one','first'),call('two','second')]):response('reported'),executeTool:async call=>{if(call.name==='second')throw new Error('fixture-secret');return {ok:true,content:'completed'};}});
 assert.deepEqual(result.toolCalls.map(call=>call.ok),[true,false]);assert.equal(result.unresolvedCalls.length,0);assert.doesNotMatch(JSON.stringify(result),/fixture-secret/);
 const unknown=await run({tools:[{name:'mutate',permissionLevel:'commit'}],approvalRequiredLevels:[],model:async()=>response('',[call('uncertain','mutate')]),executeTool:async()=>{throw new Error('transport lost');}});
 assert.equal(unknown.state,'error');assert.equal(unknown.unresolvedCalls[0].retryable,false);
});

const credentialFixture='provider-credential-fixture-only';
const redactArgumentFixture=text=>text.replaceAll(credentialFixture,'[REDACTED]').replace(/sk-[a-zA-Z0-9_-]{10,}/g,'[REDACTED]').replace(/api_key:\s*[A-Za-z0-9_-]+/g,'[REDACTED]');
const argumentFixture=token=>` {\r\n  "resourceUri": "resource://text/fixture",\r\n  "newText": ${JSON.stringify(`${token}\napi_key: document_placeholder\n世界 e\u0301 ${credentialFixture}`)},\r\n  "expectedVersion": "cas-fixture-v1"\r\n}\t`;
const proposalFixtureHash=call=>createHash('sha256').update(JSON.stringify([call.name,call.argumentsJson])).digest('hex');

test('executor and approval hashes retain original argument bytes while history and events redact copies',async()=>{
 const calls=['sk-'+'document_fixture_first','sk-'+'document_fixture_second'].map((token,index)=>({id:`patch-${index}`,name:'propose_text_patch',argumentsJson:argumentFixture(token)}));
 const original=structuredClone(calls),events=[],records=[],modelMessages=[],approved=[],diffs=[],executed=[],allowed=[];let turns=0;
 const result=await run({tools:[{name:'propose_text_patch',permissionLevel:'stage'}],limits:{maxSteps:3,timeoutMs:1000},redact:redactArgumentFixture,
  model:async request=>{modelMessages.push(structuredClone(request.messages));return ++turns===1?response(credentialFixture,calls):response('reported');},
  allowTool:call=>{allowed.push(structuredClone(call));return {ok:true};},
  resolveApprovalDiff:async request=>{diffs.push({...request});return {targetPath:'fixture.txt',unifiedDiff:`+${credentialFixture}\n+${JSON.parse(request.argumentsJson).newText}`,addedLines:1,removedLines:0,newFile:false};},
  requestApproval:async request=>{approved.push(structuredClone(request));return {decision:'once'};},
  executeTool:async call=>{executed.push(structuredClone(call));return {ok:true,content:JSON.stringify({text:JSON.parse(call.argumentsJson).newText})};},
  recordMessage:message=>records.push(structuredClone(message)),onEvent:event=>events.push(event)});
 assert.equal(result.state,'completed');assert.equal(executed.length,2);assert.equal(approved.length,2);
 for(let index=0;index<calls.length;index++) {
  assert.deepEqual(Buffer.from(executed[index].argumentsJson,'utf8'),Buffer.from(original[index].argumentsJson,'utf8'));
  assert.equal(allowed[index].argumentsJson,original[index].argumentsJson);assert.equal(diffs[index].argumentsJson,original[index].argumentsJson);
  assert.equal(approved[index].proposalHash,proposalFixtureHash(original[index]));
  assert.equal(approved[index].argumentsJson,redactArgumentFixture(original[index].argumentsJson));
 }
 assert.notEqual(approved[0].proposalHash,approved[1].proposalHash);
 assert.equal(result.messages.find(message=>message.role==='assistant').toolCalls[0].argumentsJson,result.messages.find(message=>message.role==='assistant').toolCalls[1].argumentsJson);
 assert.deepEqual(calls,original,'observability must not mutate the provider completion');
 const visible=JSON.stringify({messages:result.messages,diagnostics:result.diagnostics,approvals:result.approvals,records,events,modelMessages});
 assert.equal(visible.includes(credentialFixture),false);assert.doesNotMatch(visible,/sk-document_fixture|api_key: document_placeholder/);assert.match(visible,/\[REDACTED\]/);
 assert.deepEqual(events.filter(event=>event.event.type==='approval-requested').map(event=>event.event.proposalHash),original.map(proposalFixtureHash));
});

test('explicit full grant keeps raw argument order without adding approval prompts',async()=>{
 const calls=['sk-'+'document_fixture_first','sk-'+'document_fixture_second'].map((token,index)=>({id:`full-${index}`,name:'propose_text_patch',argumentsJson:argumentFixture(token)}));
 const executed=[];let turns=0,asked=0;
 const result=await run({permissionMode:'full',approvalRequiredLevels:[],tools:[{name:'propose_text_patch',permissionLevel:'stage'}],redact:redactArgumentFixture,
  model:async()=>++turns===1?response('',calls):response('reported'),requestApproval:async()=>{asked++;return {decision:'reject'};},
  executeTool:async call=>{executed.push(Buffer.from(call.argumentsJson,'utf8'));return {ok:true,content:'{}'};}});
 assert.equal(result.state,'completed');assert.equal(asked,0);assert.equal(result.approvals.length,0);
 assert.deepEqual(executed,calls.map(call=>Buffer.from(call.argumentsJson,'utf8')));
 assert.equal(JSON.stringify(result.messages).includes(credentialFixture),false);
});

test('parked approval exposes only a redacted display copy with a hash of the original proposal',async()=>{
 const proposed={id:'pending-raw',name:'propose_text_patch',argumentsJson:argumentFixture('sk-'+'document_fixture_pending')};let executed=0;
 const result=await run({tools:[{name:'propose_text_patch',permissionLevel:'stage'}],redact:redactArgumentFixture,
  model:async()=>response('',[proposed]),executeTool:async()=>{executed++;return {ok:true,content:'{}'};}});
 assert.equal(result.state,'waiting');assert.equal(executed,0);
 assert.equal(result.pendingApproval.proposalHash,proposalFixtureHash(proposed));
 assert.equal(result.pendingApproval.call.argumentsJson,redactArgumentFixture(proposed.argumentsJson));
 assert.equal(JSON.stringify(result).includes(credentialFixture),false);assert.doesNotMatch(JSON.stringify(result),/sk-document_fixture|api_key: document_placeholder/);
});
