import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
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
