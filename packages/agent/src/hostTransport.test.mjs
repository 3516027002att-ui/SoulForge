import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import test from 'node:test';
import { runAgentHostTransport } from './hostTransport.mjs';
class Child extends EventEmitter {frames=[];postMessage(frame){this.frames.push(frame);}kill(){this.emit('exit',9);}}
test('utility transport routes bounded domain calls and delivers terminal state without copying host domain objects',async()=>{
 const child=new Child();let calls=0;const outcome=runAgentHostTransport(child,{prompt:'read',apiKey:'private-host-credential'},{executeTool:async call=>{calls++;return {ok:true,content:call.name};}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(child.frames[0].type,'start');
 child.emit('message',{type:'rpc',id:1,method:'executeTool',args:[{id:'call',name:'read',argumentsJson:'{}'},{}]});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);assert.equal(child.frames.at(-1).type,'rpc-result');
 child.emit('message',{type:'result',result:{finishReason:'stop'}});
 assert.equal((await outcome).finishReason,'stop');
});
test('process death marks an in-flight mutation unknown and never replays it',async()=>{
 const child=new Child();let calls=0;const result=runAgentHostTransport(child,{}, {executeTool:async()=>{calls++;return new Promise(()=>{});}});
 await new Promise(resolve=>setImmediate(resolve));child.emit('message',{type:'rpc',id:1,method:'executeTool',args:[{id:'write',name:'any',argumentsJson:'{}'}]});child.emit('exit',8);
 await assert.rejects(result,error=>error.code==='AGENT_PROCESS_EXITED'&&error.unresolvedCalls[0].callId==='write'&&error.retryable===false);assert.equal(calls,1);
});
test('worker cannot request an undeclared host capability or fill an unbounded queue',async()=>{
 const child=new Child();const result=runAgentHostTransport(child,{},{});
 await new Promise(resolve=>setImmediate(resolve));child.emit('message',{type:'rpc',id:1,method:'filesystem',args:['/']});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(child.frames.at(-1).ok,false);assert.equal(child.frames.at(-1).error.code,'AGENT_HOST_METHOD_DENIED');child.emit('message',{type:'result',result:{}});await result;
});
test('worker cancellation reaches the actual host call without inventing its transaction outcome',async()=>{
 const child=new Child();let signal,release;const result=runAgentHostTransport(child,{}, {executeTool:async(_call,context)=>{signal=context.signal;return new Promise(resolve=>{release=resolve;});}});
 await new Promise(resolve=>setImmediate(resolve));child.emit('message',{type:'rpc',id:1,method:'executeTool',args:[{id:'write',name:'any',argumentsJson:'{}'},{}]});await new Promise(resolve=>setImmediate(resolve));
 try{assert.equal(signal instanceof AbortSignal,true);child.emit('message',{type:'rpc-cancel',id:1});assert.equal(signal.aborted,true);}
 finally{release({ok:true,content:'late authoritative result'});await new Promise(resolve=>setImmediate(resolve));child.emit('message',{type:'result',result:{}});await result;}
});
