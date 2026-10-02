import assert from 'node:assert/strict';
import test from 'node:test';
import {createAgentRunAssembly} from '../packages/core/dist/model-services/agentRunAssembly.js';
import {CoreToolSession} from '../packages/core/dist/runtime/coreToolSession.js';
import {WorkspaceIndex} from '../packages/core/dist/indexing/workspaceIndex.js';
import {MemoryOperationLogStore} from '../packages/core/dist/patch/operationLog.js';
import {ToolRegistry} from '../packages/core/dist/ai/toolRegistry.js';
import {createAgentToolBridge} from '../packages/core/dist/ai/agentToolBridge.js';
import {finalizeCommittedToolResult} from '../packages/core/dist/ai/toolRegistrySupport.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
let composition;
try{composition=await import('../packages/core/dist/model-services/agentHostComposition.js');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;composition={};}
const requireHelper=name=>{assert.equal(typeof composition[name],'function',`${name} must be owned by the common core composition`);return composition[name];};

test('desktop run policy preserves trusted context defaults, exact overrides and resource clamps',async()=>{
 const compose=requireHelper('composeAgentSessionOptions');
 const params={permissionMode:'normal',prompt:'owned task'},retrieve=async()=>({ok:false,code:'RAG_UNAVAILABLE',message:'fixture'});
 const defaults=compose(params,{defaultTimeoutMs:180000,autoCompaction:true,contextWindowTokens:undefined,maxStepsCeiling:200,controls:{streaming:true,maxSteps:1000,retryMaxAttempts:99,useRagSearch:true,ragSearchMaxHits:99,useContextBroker:true,contextMaxBytes:12000},ragSearch:{retrieve}});
 assert.equal(defaults.timeoutMs,180000);assert.equal(defaults.maxSteps,200);assert.equal(defaults.streaming,true);assert.equal(defaults.compaction.autoCompactTokenLimit,400000);assert.equal(defaults.retryPolicy.maxAttempts,8);assert.equal(defaults.ragSearch.maxHits,8);assert.equal(defaults.ragSearch.retrieve,retrieve);assert.equal(defaults.contextBrokerOptions.maxBytes,12000);
 assert.equal((await defaults.contextBroker.assemble([])).ok,false);
 assert.equal(compose(params,{autoCompaction:true,contextWindowTokens:1000000}).compaction.autoCompactTokenLimit,800000);
 assert.equal(compose(params,{autoCompaction:true,contextWindowTokens:1000000,controls:{autoCompactTokenLimit:1234}}).compaction.autoCompactTokenLimit,1234);
});

test('headless and evaluator ports keep explicit configuration and never acquire automatic RAG by accident',()=>{
 const compose=requireHelper('composeAgentSessionOptions');const params={permissionMode:'plan',timeoutMs:1800000,maxSteps:500,maxTotalOutputTokens:8192,kernelLimits:{maxCost:1},pricing:{inputPerMillion:2,outputPerMillion:3},approvalRequiredLevels:[],prompt:'owned task'};
 const result=compose(params);assert.equal(result.timeoutMs,1800000);assert.equal(result.maxSteps,500);assert.equal(result.kernelLimits,params.kernelLimits);assert.equal(result.pricing,params.pricing);assert.equal(result.approvalRequiredLevels,params.approvalRequiredLevels);assert.equal(result.compaction,undefined);assert.equal(result.ragSearch,undefined);
 const retrieve=async()=>({ok:false,code:'RAG_UNAVAILABLE',message:'fixture'});assert.equal(compose(params,{ragSearch:{retrieve}}).ragSearch,undefined);
 const explicit={...params,ragSearch:{retrieve,maxHits:2},compaction:{autoCompactTokenLimit:3000}};assert.equal(compose(explicit).ragSearch,explicit.ragSearch);assert.equal(compose(explicit).compaction,explicit.compaction);
});

test('untrusted run controls cannot alter host permissions, approval grants or provider configuration',()=>{
 const compose=requireHelper('composeAgentSessionOptions');const config={id:'trusted'},params={permissionMode:'plan',config,approvalRequiredLevels:['commit'],prompt:'owned task'};
 const result=compose(params,{controls:{permissionMode:'full',approvalRequiredLevels:[],config:{id:'forged'},apiKey:'synthetic-secret',maxSteps:NaN,timeoutMs:Infinity},defaultTimeoutMs:180000});
 assert.equal(result.permissionMode,'plan');assert.equal(result.config,config);assert.deepEqual(result.approvalRequiredLevels,['commit']);assert.equal(result.apiKey,undefined);assert.equal(result.timeoutMs,180000);assert.equal(result.maxSteps,undefined);
});

test('the actual shared assembly composes both host defaults and explicitly supplied evaluator options',async()=>{
 requireHelper('composeAgentSessionOptions');const bridge={tools:[],executeTool:async()=>{throw new Error('No calls');}};const captured=[];
 const sessionRunner=async params=>{captured.push(params);return {sessionId:params.sessionId};};
 await createAgentRunAssembly(bridge,{sessionRunner,composition:{defaultTimeoutMs:180000,autoCompaction:true,controls:{maxSteps:99}}}).run({prompt:'owned task',permissionMode:'plan'});
 await createAgentRunAssembly(bridge,{sessionRunner}).run({prompt:'owned task',permissionMode:'plan',timeoutMs:1800000,maxSteps:8});
 assert.equal(captured[0].timeoutMs,180000);assert.equal(captured[0].compaction.autoCompactTokenLimit,400000);assert.equal(captured[0].maxSteps,99);assert.equal(captured[1].timeoutMs,1800000);assert.equal(captured[1].maxSteps,8);assert.equal(captured[1].compaction,undefined);assert.equal(captured[0].tools,bridge.tools);
});

test('common live context rebinds only the same workspace and refreshes after rejected callbacks',async()=>{
 const provider=requireHelper('createAgentToolContextProvider');const base=requireHelper('createAgentBridgeBaseContext');
 assert.deepEqual(base('normal'),{workspaceIndex:null,mode:'normal',modeCeiling:'normal',allowMemoryWrite:false});
 const owner={},other={},coreSession=new CoreToolSession({principal:'agent:owned',workspaceId:'owned',workspaceSession:owner});let currentSession=owner,index=coreSession.workspaceIndex,refreshes=0;
 const getContext=provider({coreSession,workspaceSession:owner,getWorkspaceSession:()=>currentSession,getWorkspaceIndex:()=>index,getToolContext:()=>({workspaceIndex:index,mode:'normal',onNativeWriteCommitted:async()=>{refreshes++;throw new Error('fixture refresh failure');}})});
 const refreshed=new WorkspaceIndex('owned');index=refreshed;const current=getContext();assert.equal(coreSession.workspaceIndex,refreshed);assert.equal(current.nativeReadProofs,coreSession.proofStore);assert.equal(current.proofPrincipal,'agent:owned');
 const after=new WorkspaceIndex('owned');await assert.rejects(async()=>{index=after;await current.onNativeWriteCommitted([]);},/fixture refresh failure/);assert.equal(coreSession.workspaceIndex,after);assert.equal(refreshes,1);
 currentSession=other;index=new WorkspaceIndex('owned');assert.throws(()=>getContext(),{code:'AGENT_WORKSPACE_REPLACED'});assert.equal(coreSession.workspaceIndex,after);coreSession.close();
});

test('the actual bridge and assembly refuse a delayed tool proposal after workspace replacement',async()=>{
 const provider=requireHelper('createAgentToolContextProvider'),base=requireHelper('createAgentBridgeBaseContext');
 const root=await mkdtemp(join(tmpdir(),'sf-agent-host-replaced-')),owner={layers:{overlayRoot:join(root,'overlay')},meta:{workspaceId:'owned'}},other={layers:{overlayRoot:join(root,'other')},meta:{workspaceId:'owned'}},coreSession=requireHelper('createAgentCoreToolSession')({principal:'agent:owned',workspaceId:'owned',workspaceSession:owner,operationLog:new MemoryOperationLogStore(),modeCeiling:'plan',storage:{backupBaseDir:join(root,'backups'),recoveryDir:join(root,'recovery'),stagingRoot:join(root,'staging')}});let live=owner,domainCalls=0,turn=0;
 const oldIndex=coreSession.workspaceIndex,proofs=coreSession.proofStore,registry=new ToolRegistry();
 registry.register({name:'inspect_owned',description:'owned read',permission:'read',permissionLevel:'read',inputSchema:{},run:async()=>{domainCalls++;return {ok:true,data:{}};}});
 const bridge=createAgentToolBridge({registry,context:base('plan'),contextProvider:provider({coreSession,workspaceSession:owner,getWorkspaceSession:()=>live,getWorkspaceIndex:()=>new WorkspaceIndex('owned'),getToolContext:()=>({workspaceIndex:oldIndex,session:live,mode:'plan'})})});
 const adapter={protocol:'openai-compatible',listModels:async()=>({ok:true,models:[]}),stream:async function*(){throw new Error('No stream');},complete:async()=>{if(turn++===0){live=other;return {message:{role:'assistant',content:'',toolCalls:[{id:'old-read',name:'inspect_owned',argumentsJson:'{}'}]},finishReason:'tool_use',diagnostics:[]};}return {message:{role:'assistant',content:'The old request was refused.'},finishReason:'stop',diagnostics:[]};}};
 try{
  const result=await createAgentRunAssembly(bridge,{coreSession}).run({sessionsDir:root,adapter,config:{id:'fixture',displayName:'fixture',protocol:'openai-compatible',baseUrl:'https://fixture.invalid',model:'fixture',hasCredential:false,createdAt:'',updatedAt:''},apiKey:'',prompt:'Read owned workspace.',permissionMode:'plan'});
  assert.equal(domainCalls,0);assert.equal(result.kernel.toolCalls[0].ok,false);assert.equal(coreSession.workspaceIndex,oldIndex);assert.equal(coreSession.proofStore,proofs);assert.equal(coreSession.workspaceSession,owner);assert.equal(coreSession.editSession.session,owner);assert.equal(coreSession.editSession.operationLog,coreSession.operationLog);
 }finally{coreSession.close();await rm(root,{recursive:true,force:true});}
});

test('late committed refresh skips a replacement index without changing the committed result',async()=>{
 const provider=requireHelper('createAgentToolContextProvider');const owner={},other={},coreSession=new CoreToolSession({principal:'agent:owned',workspaceId:'owned',workspaceSession:owner});let live=owner,index=coreSession.workspaceIndex;
 const oldIndex=index,getContext=provider({coreSession,workspaceSession:owner,getWorkspaceSession:()=>live,getWorkspaceIndex:()=>index,getToolContext:()=>({workspaceIndex:index,session:live,mode:'normal',onNativeWriteCommitted:async()=>{live=other;index=new WorkspaceIndex('owned');return {status:'ready',committed:true};}})});
 const context=getContext(),result=await context.onNativeWriteCommitted(['owned-resource']);assert.equal(result.committed,true);assert.equal(coreSession.workspaceIndex,oldIndex);coreSession.close();
});

test('a late committed result refuses replacement host refresh while preserving transaction truth',async()=>{
 const provider=requireHelper('createAgentToolContextProvider'),owner={},other={},coreSession=new CoreToolSession({principal:'agent:owned',workspaceId:'owned',workspaceSession:owner});let live=owner,refreshCalls=0,semanticCalls=0;
 const oldIndex=coreSession.workspaceIndex,context=provider({coreSession,workspaceSession:owner,getWorkspaceSession:()=>live,getWorkspaceIndex:()=>oldIndex,getToolContext:()=>({workspaceIndex:oldIndex,session:owner,mode:'normal',onNativeWriteCommitted:async()=>{refreshCalls++;},onSemanticEvidenceUpdated:async()=>{semanticCalls++;}})})();
 live=other;const result=await finalizeCommittedToolResult({data:{committed:true,opId:'owned-committed'},changedSources:['resource://owned/source'],context});
 assert.equal(refreshCalls,0);assert.equal(result.ok,true);assert.equal(result.data.committed,true);assert.equal(result.data.opId,'owned-committed');assert.equal(result.data.lifecycle.transaction,'committed');assert.equal(result.data.lifecycle.knowledgeRefresh,'failed');assert.match(result.data.knowledgeRefresh.message,/WORKSPACE_REPLACED/);
 await assert.rejects(()=>context.onSemanticEvidenceUpdated([]),{code:'AGENT_WORKSPACE_REPLACED'});assert.equal(semanticCalls,0);assert.equal(coreSession.workspaceIndex,oldIndex);coreSession.close();
});

test('a mismatched host context is refused before rebinding the captured session index',()=>{
 const provider=requireHelper('createAgentToolContextProvider');const owner={},other={},coreSession=new CoreToolSession({principal:'agent:owned',workspaceId:'owned',workspaceSession:owner}),oldIndex=coreSession.workspaceIndex;
 const candidate=new WorkspaceIndex('owned'),getContext=provider({coreSession,workspaceSession:owner,getWorkspaceSession:()=>owner,getWorkspaceIndex:()=>candidate,getToolContext:()=>({workspaceIndex:candidate,session:other,mode:'normal'})});
 assert.throws(()=>getContext(),{code:'AGENT_WORKSPACE_REPLACED'});assert.equal(coreSession.workspaceIndex,oldIndex);coreSession.close();
});

test('shared automatic retrieval keeps the query/port and refuses replaced workspace data after awaited readiness',async()=>{
 const create=requireHelper('createAgentRagSearch');const owner={},other={},controller=new AbortController();let live=owner,lookups=0,waits=0;
 const expected={ok:true,hits:[]},queries=[];
 const ports={workspaceSession:owner,getWorkspaceSession:()=>live,signal:controller.signal,waitForIndexing:async()=>{waits++;},retrieve:async query=>{lookups++;queries.push(query);return expected;}};
 assert.equal(await create(ports).retrieve('fixed task query'),expected);assert.deepEqual(queries,['fixed task query']);assert.equal(waits,1);
 const stale=create({...ports,waitForIndexing:async()=>{live=other;}});const result=await stale.retrieve('fixed task query');assert.equal(result.ok,false);assert.equal(result.code,'RAG_UNAVAILABLE');assert.equal(lookups,1);
 live=owner;const delayed=create({...ports,retrieve:async()=>{live=other;return expected;}});assert.equal((await delayed.retrieve('fixed task query')).ok,false);
});

test('cancelled shared retrieval never calls readiness or the workspace search port',async()=>{
 const create=requireHelper('createAgentRagSearch'),controller=new AbortController(),owner={};controller.abort();let calls=0;
 const result=await create({workspaceSession:owner,getWorkspaceSession:()=>owner,signal:controller.signal,waitForIndexing:async()=>{calls++;},retrieve:async()=>{calls++;return {ok:true,hits:[]};}}).retrieve('fixed task query');
 assert.equal(result.ok,false);assert.equal(calls,0);
});

test('one common workspace constructor binds native handles, proof principal, durable ports and mode ceiling',()=>{
 const create=requireHelper('createAgentCoreToolSession');const workspace={layers:{overlayRoot:'/owned/overlay'},meta:{workspaceId:'owned'}},operationLog=new MemoryOperationLogStore();
 const coreSession=create({principal:'agent:owned',workspaceId:'owned',workspaceSession:workspace,operationLog,modeCeiling:'plan',storage:{backupBaseDir:'/owned/backups',recoveryDir:'/owned/recovery',stagingRoot:'/owned/staging'}});
 assert.equal(coreSession.principal,'agent:owned');assert.equal(coreSession.workspaceSession,workspace);assert.equal(coreSession.operationLog,operationLog);assert.equal(coreSession.modeCeiling,'plan');assert.equal(coreSession.requireEditSession().session,workspace);assert.equal(coreSession.requireEditSession().stagingRoot,'/owned/staging');coreSession.close();
});

test('async desktop session opening refuses replacement before constructing native authority',async()=>{
 const open=requireHelper('openAgentCoreToolSession'),owner={layers:{overlayRoot:'/owned/a'},meta:{workspaceId:'owned'}},other={layers:{overlayRoot:'/owned/b'},meta:{workspaceId:'owned'}},index=new WorkspaceIndex('owned'),operationLog=new MemoryOperationLogStore();
 let live=owner,release,calls=0;
 const ports={principal:'agent:owned',workspaceSession:owner,workspaceIndex:index,modeCeiling:'plan',storage:{backupBaseDir:'/owned/backups',recoveryDir:'/owned/recovery'},getWorkspaceSession:()=>live,getOperationLog:async session=>{assert.equal(session,owner);calls++;await new Promise(resolve=>{release=resolve;});return operationLog;}};
 const pending=open(ports);live=other;release();await assert.rejects(()=>pending,{code:'AGENT_WORKSPACE_REPLACED'});assert.equal(calls,1);
 await assert.rejects(()=>open(ports),{code:'AGENT_WORKSPACE_REPLACED'});assert.equal(calls,1);
 live=owner;const session=await open({...ports,getOperationLog:async()=>operationLog});assert.equal(session.workspaceIndex,index);assert.equal(session.editSession.session,owner);assert.equal(session.operationLog,operationLog);session.close();
});

test('workspace construction and live context cannot borrow another session through extra host fields',()=>{
 const create=requireHelper('createAgentCoreToolSession'),provider=requireHelper('createAgentToolContextProvider'),owner={layers:{overlayRoot:'/owned/a'},meta:{workspaceId:'owned'}},other={layers:{overlayRoot:'/owned/b'},meta:{workspaceId:'other'}},operationLog=new MemoryOperationLogStore();
 const session=create({principal:'agent:owned',workspaceId:'owned',workspaceSession:owner,operationLog,modeCeiling:'plan',storage:{backupBaseDir:'/owned/backups',recoveryDir:'/owned/recovery',session:other,operationLog:new MemoryOperationLogStore()}});
 assert.equal(session.requireEditSession().session,owner);assert.equal(session.requireEditSession().operationLog,operationLog);session.close();
 const readOnly=new CoreToolSession({principal:'agent:read-only',workspaceId:'owned',workspaceSession:owner}),foreign={session:other};
 const context=provider({coreSession:readOnly,workspaceSession:owner,getWorkspaceSession:()=>owner,getWorkspaceIndex:()=>readOnly.workspaceIndex,getToolContext:()=>({workspaceIndex:readOnly.workspaceIndex,session:owner,mode:'plan',editSession:foreign})})();
 assert.equal(context.editSession,undefined);assert.equal(context.proofPrincipal,'agent:read-only');readOnly.close();
});
