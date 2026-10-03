import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { runAgentHostTransport } from '../packages/agent/src/hostTransport.mjs';

test('production utility entry runs the provider loop off-host and makes bounded domain RPC calls',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-agent-utility-'));let requests=0,tools=0;const workerPids=[];
 const server=createServer(async(req,res)=>{for await(const _ of req){};requests++;res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:requests===1?{role:'assistant',content:'',tool_calls:[{id:'call-1',type:'function',function:{name:'inspect_fixture',arguments:'{}'}}]}:{role:'assistant',content:'bounded fixture complete'},finish_reason:requests===1?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:10}}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();
 try{
  const worker=pathToFileURL(join(process.cwd(),'apps/desktop/src/main/agentUtility.ts')).href;
  await writeFile(join(root,'bootstrap.mjs'),`process.parentPort={on:(name,callback)=>process.on(name,data=>callback({data})),postMessage:value=>process.send(value)};await import(${JSON.stringify(worker)});`);
  const child=fork(join(root,'bootstrap.mjs'),[],{cwd:process.cwd(),execArgv:['--experimental-strip-types'],stdio:['ignore','pipe','pipe','ipc']});let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk});child.postMessage=frame=>child.send(frame);workerPids.push(child.pid);
  const result=await runAgentHostTransport(child,{sessionsDir:root,sessionId:'utility-fixture',config:{id:'fixture',displayName:'fixture',protocol:'openai-compatible',baseUrl:`http://127.0.0.1:${address.port}`,model:'fixture',hasCredential:true,createdAt:'',updatedAt:''},apiKey:'fixture-only',prompt:'inspect fixture',permissionMode:'plan',kernel:'finite',tools:[{name:'inspect_fixture',description:'fixture',permissionLevel:'read',parametersJsonSchema:{type:'object',properties:{}}}],kernelLimits:{timeoutMs:5000}},{executeTool:async(call)=>{assert.equal(call.name,'inspect_fixture');tools++;return {ok:true,content:'{"ok":true,"data":{"sourceHash":"fixture"}}'};}},{timeoutMs:10000});
  assert.equal(result.run.finishReason,'stop',stderr);assert.equal(result.kernel.state,'completed');assert.equal(result.kernel.evaluation,'unverified');assert.equal(tools,1);assert.equal(requests,2);assert.notEqual(workerPids[0],process.pid);
 }finally{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
});

test('the production utility delivers a large accepted context through its bounded result DTO and starts a fresh next session',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-agent-utility-history-'));let requests=0;
 const server=createServer(async(req,res)=>{for await(const _ of req){};requests++;res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'The native task result is ready.'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();
 try{
  const worker=pathToFileURL(join(process.cwd(),'apps/desktop/src/main/agentUtility.ts')).href;
  await writeFile(join(root,'bootstrap.mjs'),`process.parentPort={on:(name,callback)=>process.on(name,data=>callback({data})),postMessage:value=>process.send(value)};await import(${JSON.stringify(worker)});`);
  for(const [index,prompt] of ['x'.repeat(1_100_000),'next task'].entries()){
   const child=fork(join(root,'bootstrap.mjs'),[],{cwd:process.cwd(),execArgv:['--experimental-strip-types'],stdio:['ignore','pipe','pipe','ipc']});let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk});child.postMessage=frame=>child.send(frame);
   const events=[];
   const result=await runAgentHostTransport(child,{sessionsDir:root,sessionId:`utility-history-${index}`,config:{id:'fixture',displayName:'fixture',protocol:'openai-compatible',baseUrl:`http://127.0.0.1:${address.port}`,model:'fixture',hasCredential:true,createdAt:'',updatedAt:''},apiKey:'fixture-only',prompt,permissionMode:'plan',tools:[]},{},{timeoutMs:10000,onEvent:event=>events.push(event)});
   assert.equal(result.run.finishReason,'stop',stderr);assert.equal(result.kernel.state,'completed');assert.equal(result.historyDelivery.source,'rollout');assert.equal(result.historyDelivery.messageCount,2);
   assert.deepEqual(result.run.messages,[]);assert.deepEqual(result.kernel.messages,[]);assert.ok(Buffer.byteLength(JSON.stringify(result))<2_097_152);
   assert.deepEqual(events.filter(event=>event.type==='agent-message-delta').map(event=>event.text),['The native task result is ready.']);
  }
  assert.equal(requests,2);
 }finally{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
});

test('near-cap accumulated outputs preserve audits, outcomes and full durable history across the utility result boundary',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-agent-utility-output-window-'));let requests=0,calls=0;const wireBytes=[];
 const server=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));wireBytes.push(Buffer.byteLength(JSON.stringify(body.messages)));requests++;
  res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:requests<=18?{role:'assistant',content:'',tool_calls:[{id:`read-${requests}`,type:'function',function:{name:'inspect_fixture',arguments:'{}'}}]}:{role:'assistant',content:'Accumulated read results are ready.'},finish_reason:requests<=18?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1}}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();
 try{
  const worker=pathToFileURL(join(process.cwd(),'apps/desktop/src/main/agentUtility.ts')).href;
  await writeFile(join(root,'bootstrap.mjs'),`process.parentPort={on:(name,callback)=>process.on(name,data=>callback({data})),postMessage:value=>process.send(value)};await import(${JSON.stringify(worker)});`);
  const child=fork(join(root,'bootstrap.mjs'),[],{cwd:process.cwd(),execArgv:['--experimental-strip-types'],stdio:['ignore','pipe','pipe','ipc']});let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk});child.postMessage=frame=>child.send(frame);
  const result=await runAgentHostTransport(child,{sessionsDir:root,sessionId:'utility-output-window',config:{id:'fixture',displayName:'fixture',protocol:'openai-compatible',baseUrl:`http://127.0.0.1:${address.port}`,model:'fixture',hasCredential:true,createdAt:'',updatedAt:''},apiKey:'fixture-only',prompt:'x'.repeat(950_000),permissionMode:'plan',tools:[{name:'inspect_fixture',description:'controlled read',permissionLevel:'read',parametersJsonSchema:{}}]},{executeTool:async()=>{calls++;return {ok:true,content:JSON.stringify({ok:true,payload:'x'.repeat(60_000),transaction:{opId:`read-observation-${calls}`,state:'not_committed'}})};}},{timeoutMs:20000});
  assert.equal(result.kernel.state,'completed',stderr);assert.equal(result.kernel.evaluation,'unverified');assert.equal(requests,19);assert.equal(calls,18);
  assert.ok(wireBytes.at(-1)>2_000_000);assert.ok(wireBytes.every(bytes=>bytes<2_097_152));
  assert.equal(result.run.audit.toolCalls.length,18);assert.deepEqual(result.run.audit.toolCalls,result.kernel.toolCalls);assert.ok(result.kernel.toolCalls.every(call=>call.ok));
  assert.deepEqual(result.kernel.transactions.map(transaction=>[transaction.opId,transaction.state]),Array.from({length:18},(_,index)=>[`read-observation-${index+1}`,'not_committed']));
  assert.deepEqual(result.run.diagnostics,[]);assert.deepEqual(result.kernel.diagnostics,[]);assert.equal(result.providerBudget.requests,19);assert.equal(result.providerBudget.outputUsed,19);
  assert.deepEqual(result.run.messages,[]);assert.deepEqual(result.kernel.messages,[]);assert.ok(Buffer.byteLength(JSON.stringify({type:'result',result}))<2_097_152);
  const history=(await readFile(result.rolloutPath,'utf8')).trim().split('\n').map(JSON.parse).filter(record=>record.type==='message').map(record=>record.message);
  assert.equal(history.filter(message=>message.role==='tool').length,18);assert.equal(history.filter(message=>message.role==='tool'&&JSON.parse(message.content).payload.length===60_000).length,18);
  assert.equal(result.historyDelivery.messageCount,history.length);
 }finally{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
});
