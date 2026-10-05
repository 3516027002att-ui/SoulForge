/** Process-local CLI host port. Approval never supplies domain or write authority. */
import {createHash,randomUUID} from 'node:crypto';
import {BoundedEventSender} from '../../packages/agent/src/eventSender.mjs';

export function createAgentStdioControl({input,emit,sessionId,runId,requestId,controller,approvalTimeoutMs=600000,maxFrameBytes=65536}) {
 const pending=new Map();let connected=true,parts=[],bufferBytes=0,disconnectReason;
 const scope={protocolVersion:1,sessionId,runId};
 const sender=new BoundedEventSender(async frame=>{try{await emit(frame);}catch(error){disconnect('AGENT_HOST_OUTPUT_FAILED');throw error;}});
 const settle=(id,response)=>{const entry=pending.get(id);if(!entry)return false;pending.delete(id);clearTimeout(entry.timer);entry.resolve(response);return true;};
 const abortPending=note=>{for(const id of [...pending.keys()])settle(id,{decision:'abort',note});};
 function disconnect(code='AGENT_HOST_DISCONNECTED') {
  if(!connected)return;connected=false;disconnectReason=code;parts=[];bufferBytes=0;
  send({type:'agent-control-closed',requestId,code});
  controller.abort(Object.assign(new Error('The CLI host control connection ended.'),{code}));abortPending(code);
 }
 const send=frame=>{try{sender.enqueue({...scope,...frame});}catch{disconnect('AGENT_HOST_OUTPUT_BUDGET_EXCEEDED');}};
 const outcome=(frame,matched,code)=>send({type:'agent-control-result',...(typeof frame?.requestId==='string'&&frame.requestId.length<=128?{requestId:frame.requestId}:{}),matched,...(code?{code}:{})});
 const accept=frame=>{
  if(!frame||frame.protocolVersion!==1||frame.sessionId!==sessionId||frame.runId!==runId){outcome(frame,false,'AGENT_CONTROL_SCOPE_MISMATCH');return;}
  if(frame.type==='agent-cancel') {
   if(frame.requestId!==requestId){outcome(frame,false,'AGENT_CONTROL_REQUEST_MISMATCH');return;}
   controller.abort(Object.assign(new Error('The CLI host cancelled this run.'),{code:'AGENT_HOST_CANCELLED'}));abortPending('AGENT_HOST_CANCELLED');outcome(frame,true);return;
  }
  if(frame.type!=='agent-approval-response'){outcome(frame,false,'AGENT_CONTROL_TYPE_INVALID');return;}
  const entry=pending.get(frame.requestId);
  if(!entry){outcome(frame,false,'AGENT_APPROVAL_REQUEST_NOT_FOUND');return;}
  if(frame.callId!==entry.callId||frame.proposalHash!==entry.proposalHash){outcome(frame,false,'AGENT_APPROVAL_PROPOSAL_MISMATCH');return;}
  const decision=new Map([['approve','once'],['deny','reject'],['cancel','abort']]).get(frame.decision);
  if(!decision){outcome(frame,false,'AGENT_APPROVAL_DECISION_INVALID');return;}
  const note=typeof frame.note==='string'?frame.note.slice(0,8192):undefined;
  outcome(frame,settle(frame.requestId,{decision,...(note?{note}:{})}));
 };
 const onData=chunk=>{
  if(!connected||controller.signal.aborted)return;
  const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);let start=0;
  while(start<bytes.length){
   const newline=bytes.indexOf(10,start),end=newline<0?bytes.length:newline;
   if(bufferBytes+end-start>maxFrameBytes){disconnect('AGENT_CONTROL_FRAME_TOO_LARGE');return;}
   if(end>start){parts.push(Buffer.from(bytes.subarray(start,end)));bufferBytes+=end-start;}
   if(newline<0)break;
   const text=Buffer.concat(parts,bufferBytes).toString('utf8').trim();parts=[];bufferBytes=0;
   if(text){let frame;try{frame=JSON.parse(text);}catch{send({type:'agent-control-result',matched:false,code:'AGENT_CONTROL_JSON_INVALID'});start=end+1;continue;}accept(frame);}
   start=end+1;
  }
 };
 const onEnd=()=>disconnect(),onError=()=>disconnect('AGENT_HOST_INPUT_FAILED');
 const onAbort=()=>abortPending('AGENT_HOST_CANCELLED');
 input.on('data',onData);input.once('end',onEnd);input.once('error',onError);
 controller.signal.addEventListener('abort',onAbort,{once:true});
 if(input.readableEnded||input.destroyed)disconnect();
 send({type:'agent-host-ready',requestId});
 return {
  get disconnectReason(){return disconnectReason;},
  requestApproval(request) {
   if(!connected||controller.signal.aborted)return Promise.resolve({decision:'abort',note:'AGENT_HOST_DISCONNECTED'});
   if(pending.size>=32)return Promise.reject(Object.assign(new Error('Too many pending approval requests.'),{code:'AGENT_APPROVAL_QUEUE_BUDGET_EXCEEDED'}));
   const id=randomUUID(),proposalHash=request.proposalHash??createHash('sha256').update(JSON.stringify([request.toolName,request.argumentsJson])).digest('hex');
   return new Promise(resolve=>{
    const timer=setTimeout(()=>settle(id,{decision:'timed_out',note:'CLI approval timed out without consent.'}),approvalTimeoutMs);
    pending.set(id,{resolve,timer,callId:request.callId,proposalHash});
    send({type:'agent-approval-request',requestId:id,callId:request.callId,proposalHash,request:{...request,proposalHash}});
   });
  },
  async close(){connected=false;input.off('data',onData);input.off('end',onEnd);input.off('error',onError);input.pause();input.unref?.();controller.signal.removeEventListener('abort',onAbort);abortPending('AGENT_HOST_CLOSED');parts=[];bufferBytes=0;await sender.flush();}
 };
}
