import type {ToolContext} from '../ai/toolRegistry.js';
import {CoreToolSession} from '../runtime/coreToolSession.js';
import type {OperationLogStore} from '../patch/operationLog.js';
import {nativeEditSessionFromContext} from '../editing/nativeEditSession.js';
import type {WorkspaceSession} from '../workspace/workspaceSession.js';
import type {WorkspaceIndex} from '../indexing/workspaceIndex.js';
import type {AgentSessionRunParams} from './agentSessionHost.js';
import {createContextBroker} from './contextBroker.js';

export interface AgentRunControls {
  streaming?: boolean;
  timeoutMs?: number;
  maxSteps?: number;
  maxTotalOutputTokens?: number;
  autoCompactTokenLimit?: number;
  retryMaxAttempts?: number;
  useRagSearch?: boolean;
  ragSearchMaxHits?: number;
  useContextBroker?: boolean;
  contextMaxBytes?: number;
}
export interface AgentHostComposition {
  controls?: AgentRunControls;
  defaultTimeoutMs?: number;
  maxStepsCeiling?: number;
  autoCompaction?: boolean;
  contextWindowTokens?: number;
  sampling?: AgentSessionRunParams['sampling'];
  ragSearch?: AgentSessionRunParams['ragSearch'];
}
type RunParams=Omit<AgentSessionRunParams,'tools'|'executeTool'>;
const positiveInteger=(value:unknown):number|undefined=>typeof value==='number'&&Number.isFinite(value)&&value>0?Math.trunc(value):undefined;
const workspaceReplaced=()=>Object.assign(new Error('CLI_AGENT_WORKSPACE_REPLACED: The run workspace changed; its old tool request was refused.'),{code:'AGENT_WORKSPACE_REPLACED'});

/** Shared execution configuration; permission, credentials and prompts remain trusted host inputs. */
export function composeAgentSessionOptions(params:RunParams,host:AgentHostComposition={}):RunParams {
  const result={...params},controls=host.controls??{};
  const timeout=positiveInteger(params.timeoutMs??controls.timeoutMs)??positiveInteger(host.defaultTimeoutMs);
  if(timeout!==undefined)result.timeoutMs=timeout;
  else delete result.timeoutMs;
  const steps=positiveInteger(params.maxSteps??controls.maxSteps),ceiling=positiveInteger(host.maxStepsCeiling);
  if(steps!==undefined)result.maxSteps=ceiling===undefined?steps:Math.min(ceiling,steps);
  else delete result.maxSteps;
  const output=positiveInteger(params.maxTotalOutputTokens??controls.maxTotalOutputTokens);
  if(output!==undefined)result.maxTotalOutputTokens=output;
  else delete result.maxTotalOutputTokens;
  if(params.streaming===undefined&&controls.streaming===true)result.streaming=true;
  if(params.sampling===undefined&&host.sampling&&Object.keys(host.sampling).length)result.sampling=host.sampling;
  if(params.compaction===undefined&&host.autoCompaction){
    result.compaction={autoCompactTokenLimit:positiveInteger(controls.autoCompactTokenLimit)
      ??Math.max(1,Math.trunc((positiveInteger(host.contextWindowTokens)??500_000)*0.8))};
  }
  const retries=positiveInteger(controls.retryMaxAttempts);
  if(params.retryPolicy===undefined&&retries!==undefined)result.retryPolicy={maxAttempts:Math.min(8,retries)};
  if(params.ragSearch===undefined&&controls.useRagSearch===true&&host.ragSearch){
    const hits=positiveInteger(controls.ragSearchMaxHits);
    result.ragSearch={...host.ragSearch,...(hits!==undefined?{maxHits:Math.min(8,hits)}:{})};
  }
  if(params.contextBroker===undefined&&controls.useContextBroker===true){
    result.contextBroker=createContextBroker();
    const maxBytes=positiveInteger(controls.contextMaxBytes);
    if(params.contextBrokerOptions===undefined&&maxBytes!==undefined)result.contextBrokerOptions={maxBytes};
  }
  return result;
}

/** Hold stable policy only; current resource/index state comes from the host provider. */
export function createAgentBridgeBaseContext(mode:ToolContext['mode']):ToolContext {
  return {workspaceIndex:null,mode,modeCeiling:mode,allowMemoryWrite:false};
}
export function createAgentCoreToolSession(input:{
  principal:string;workspaceId:string;workspaceSession:WorkspaceSession;workspaceIndex?:WorkspaceIndex;
  operationLog:OperationLogStore;modeCeiling:ToolContext['mode'];
  storage:{backupBaseDir:string;recoveryDir:string;stagingRoot?:string};
}):CoreToolSession {
  const editSession=nativeEditSessionFromContext({session:input.workspaceSession,operationLog:input.operationLog,
    backupBaseDir:input.storage.backupBaseDir,recoveryDir:input.storage.recoveryDir,
    ...(input.storage.stagingRoot!==undefined?{stagingRoot:input.storage.stagingRoot}:{})});
  return new CoreToolSession({principal:input.principal,workspaceId:input.workspaceId,workspaceSession:input.workspaceSession,
    ...(input.workspaceIndex?{workspaceIndex:input.workspaceIndex}:{}),editSession,operationLog:input.operationLog,modeCeiling:input.modeCeiling});
}
/** The asynchronous storage port cannot attach a replacement workspace to the run. */
export async function openAgentCoreToolSession(input:{
  principal:string;workspaceSession:WorkspaceSession;workspaceIndex?:WorkspaceIndex;
  modeCeiling:ToolContext['mode'];
  storage:{backupBaseDir:string;recoveryDir:string;stagingRoot?:string};
  getWorkspaceSession():WorkspaceSession|null|undefined;
  getOperationLog(session:WorkspaceSession):Promise<OperationLogStore>;
}):Promise<CoreToolSession> {
  if(input.getWorkspaceSession()!==input.workspaceSession)throw workspaceReplaced();
  const operationLog=await input.getOperationLog(input.workspaceSession);
  if(input.getWorkspaceSession()!==input.workspaceSession)throw workspaceReplaced();
  return createAgentCoreToolSession({principal:input.principal,workspaceId:input.workspaceSession.meta.workspaceId,
    workspaceSession:input.workspaceSession,...(input.workspaceIndex?{workspaceIndex:input.workspaceIndex}:{}),
    operationLog,modeCeiling:input.modeCeiling,storage:input.storage});
}
export function wrapAgentToolContextRefreshCallbacks(context:ToolContext,onRefreshComplete:()=>void,isOwnerCurrent:()=>boolean=()=>true):ToolContext {
  const wrapped={...context};
  const committed=context.onNativeWriteCommitted;
  if(committed)wrapped.onNativeWriteCommitted=async sources=>{
    if(!isOwnerCurrent())throw workspaceReplaced();
    try{return await committed(sources);}finally{onRefreshComplete();}
  };
  const semantic=context.onSemanticEvidenceUpdated;
  if(semantic)wrapped.onSemanticEvidenceUpdated=async sources=>{
    if(!isOwnerCurrent())throw workspaceReplaced();
    try{return await semantic(sources);}finally{onRefreshComplete();}
  };
  return wrapped;
}
export function createAgentToolContextProvider(ports:{
  coreSession?:CoreToolSession;
  workspaceSession?:WorkspaceSession;
  getWorkspaceSession():WorkspaceSession|null|undefined;
  getWorkspaceIndex():WorkspaceIndex|null|undefined;
  getToolContext():ToolContext;
}):()=>ToolContext {
  if(ports.coreSession&&ports.workspaceSession&&ports.coreSession.workspaceSession!==ports.workspaceSession)throw workspaceReplaced();
  const isOwnerCurrent=()=>!ports.workspaceSession||ports.getWorkspaceSession()===ports.workspaceSession;
  const refresh=()=>{
    if(ports.coreSession&&ports.workspaceSession&&ports.getWorkspaceSession()===ports.workspaceSession){
      const index=ports.getWorkspaceIndex();
      if(index)ports.coreSession.updateWorkspaceIndex(index,ports.workspaceSession);
    }
  };
  return ()=>{
    if(ports.coreSession&&ports.workspaceSession&&ports.getWorkspaceSession()!==ports.workspaceSession)throw workspaceReplaced();
    const current=ports.getToolContext();
    if(!ports.coreSession)return current;
    if(ports.workspaceSession&&ports.getWorkspaceSession()!==ports.workspaceSession)throw workspaceReplaced();
    if(ports.workspaceSession&&current.session&&current.session!==ports.workspaceSession)throw workspaceReplaced();
    if(current.workspaceIndex&&current.workspaceIndex.workspaceId!==ports.coreSession.workspaceId)throw workspaceReplaced();
    refresh();
    const {coreSession:_core,nativeReadProofs:_proofs,proofPrincipal:_principal,editSession:_edit,...domain}=current;
    return {...wrapAgentToolContextRefreshCallbacks(domain,refresh,isOwnerCurrent),coreSession:ports.coreSession,
      nativeReadProofs:ports.coreSession.proofStore,proofPrincipal:ports.coreSession.principal,
      ...(ports.coreSession.editSession?{editSession:ports.coreSession.editSession}:{})};
  };
}

/** Existing bounded automatic lookup, with the run's workspace identity held across awaits. */
export function createAgentRagSearch(ports:{
  workspaceSession:WorkspaceSession;
  getWorkspaceSession():WorkspaceSession|null|undefined;
  signal:AbortSignal;
  waitForIndexing(signal:AbortSignal):Promise<unknown>;
  retrieve(query:string,signal:AbortSignal):ReturnType<NonNullable<AgentSessionRunParams['ragSearch']>['retrieve']>;
}):NonNullable<AgentSessionRunParams['ragSearch']> {
  const current=()=>ports.getWorkspaceSession()===ports.workspaceSession;
  const unavailable=()=>({ok:false as const,code:'RAG_UNAVAILABLE' as const,message:'任务的工作区已替换或已取消，未采用该次检索证据。'});
  return {retrieve:async query=>{
    if(ports.signal.aborted||!current())return unavailable();
    const controller=new AbortController();
    const abort=()=>controller.abort();ports.signal.addEventListener('abort',abort,{once:true});
    let rejectWait:(error:Error)=>void=()=>{};
    const interrupted=new Promise<never>((_resolve,reject)=>{rejectWait=reject;});
    const onAbort=()=>rejectWait(new Error('Index readiness wait interrupted.'));
    controller.signal.addEventListener('abort',onAbort,{once:true});
    const timer=setTimeout(()=>controller.abort(),3000);
    try{await Promise.race([ports.waitForIndexing(controller.signal),interrupted]);}
    catch{if(ports.signal.aborted)return unavailable();}
    finally{clearTimeout(timer);ports.signal.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',onAbort);}
    if(ports.signal.aborted||!current())return unavailable();
    const result=await ports.retrieve(query,ports.signal);
    return ports.signal.aborted||!current()?unavailable():result;
  }};
}
