// Actual desktop utility-store lifecycle with owned in-memory host/native seams.
// No Electron process, SQLite/native binding, game bytes or real cleanup is used.
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import {fileURLToPath} from 'node:url';import test from 'node:test';import ts from 'typescript';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),ipc=path.join(root,'apps/desktop/src/main/ipc.ts'),servicePath=path.join(root,'apps/desktop/src/main/services/workspaceUtilityLifecycleService.ts');
const A={meta:{workspaceId:'owned-A',game:'sekiro'},layers:{overlayRoot:'/owned/A'}},B={meta:{workspaceId:'owned-B',game:'sekiro'},layers:{overlayRoot:'/owned/B'}};
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
const plain=value=>JSON.parse(JSON.stringify(value));
function execute(source,filename,scope={},imports={}){const built=ts.transpileModule(source,{fileName:filename,reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}});assert.deepEqual((built.diagnostics??[]).filter(d=>d.category===ts.DiagnosticCategory.Error),[]);const exports={};vm.runInNewContext(built.outputText,{exports,module:{exports},Error,Symbol,Promise,setTimeout,console,...scope,require(name){assert.ok(Object.hasOwn(imports,name),`Unexpected lifecycle import ${name}`);return imports[name];}},{filename});return exports;}
function harness(options={}){
 const calls=[];let active=A,now=0;const pathApi=options.pathApi??path;
 const utility={openWorkspace:async input=>{calls.push(['open',plain(input)]);if(options.open)return options.open(input);},planRecoveryCleanup:async()=>{calls.push(['plan']);return {owned:true};},loadKnowledgeSnapshot:async input=>{calls.push(['snapshot',plain(input)]);return options.snapshot?options.snapshot(input):{workspaceId:input.workspaceId,owned:true};},dispose:async()=>calls.push(['disposeUtility'])};
 const storage=workspaceId=>({root:`/owned/storage/${workspaceId}`,backupBaseDir:'/owned/backups',recoveryDir:'/owned/recovery',stagingRoot:'/owned/staging',migrationSourceDatabasePath:'/owned/legacy/workspace.db'});
 const core={executeRecoveryCleanup:async input=>{calls.push(['cleanup',input]);return options.cleanup?options.cleanup(input):{rejected:options.rejected??[]};},createReadOnlyKnowledgeStore:snapshot=>({snapshot}),resolveOperationLogStorePath:(root,id)=>pathApi.join(root,`${id}.sqlite`)};
 const gate=execute(fs.readFileSync(path.join(root,'apps/desktop/src/main/workspaceDatabaseOpenGate.ts'),'utf8'),'workspaceDatabaseOpenGate.ts').WorkspaceDatabaseOpenGate;
 const host={operationLogUtility:utility,getActiveSession:()=>active,workspaceStoragePaths:storage,getUserDataPath:()=>'/owned/userData',reportRecoveryCleanupRejections:items=>calls.push(['cleanupReport',plain(items)]),reportKnowledgeSnapshotUnavailable:message=>calls.push(['knowledgeReport',message])};
 let lifecycle;
 if(fs.existsSync(servicePath)){
  const service=execute(fs.readFileSync(servicePath,'utf8'),servicePath,{Date:{now:()=>now}},{'node:path':pathApi,'@soulforge/core':core,'../knowledgeStoreSnapshot.js':{createReadOnlyKnowledgeStore:core.createReadOnlyKnowledgeStore},'../recoveryCleanup.js':{executeRecoveryCleanup:core.executeRecoveryCleanup},'../workspaceDatabaseOpenGate.js':{WorkspaceDatabaseOpenGate:gate}});
  lifecycle=service.createWorkspaceUtilityLifecycleService(host);
 }else{
  const source=fs.readFileSync(ipc,'utf8'),ast=ts.createSourceFile(ipc,source,ts.ScriptTarget.Latest,true),names=['legacyOperationLogPathForWorkspace','ensureActiveOperationLog','ensureActiveKnowledgeStore','disposeActiveKnowledgeStore'];
  const fields=['activeOperationLog','activeOperationLogWorkspaceId','activeKnowledgeStore','activeKnowledgeWorkspaceId','activeKnowledgeStoreError','activeKnowledgeLoad','activeKnowledgeLoadWorkspaceId','activeKnowledgeLoadToken','activeKnowledgeFailureWorkspaceId','activeKnowledgeRetryAt','KNOWLEDGE_RETRY_COOLDOWN_MS','operationLogOpenGate'];
  const statements=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name?.text)||ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>fields.includes(d.name.getText(ast))));assert.equal(statements.length,names.length+fields.length);
  const body=statements.map(n=>n.getText(ast)).join('\n')+'\nexport function controls(){return {ensureActiveOperationLog,disposeActiveKnowledgeStore,dispose:async()=>{activeOperationLog=null;activeOperationLogWorkspaceId=null;await disposeActiveKnowledgeStore();await operationLogUtility.dispose();},get activeOperationLog(){return activeOperationLog;},get activeKnowledgeStore(){return activeKnowledgeStore;},get activeKnowledgeWorkspaceId(){return activeKnowledgeWorkspaceId;},get activeKnowledgeStoreError(){return activeKnowledgeStoreError;}};}';
  lifecycle=execute(body,ipc,{...core,join:pathApi.join,Date:{now:()=>now},WorkspaceDatabaseOpenGate:gate,getWorkspaceSession:()=>active,operationLogUtility:utility,workspaceStoragePaths:storage,app:{getPath:()=>'/owned/userData'},process:{stderr:{write:value=>calls.push(['cleanupReport',value])}},console:{warn:value=>calls.push(['knowledgeReport',value])}}).controls();
 }
 return {calls,utility,host,lifecycle,switchSession(value){active=value;},setNow(value){now=value;}};
}

test('utility-store lifecycle is callable below Electron root composition',()=>{assert.equal(fs.existsSync(servicePath),true,'Workspace utility lifecycle service must exist');const source=fs.readFileSync(servicePath,'utf8');assert.doesNotMatch(source,/from ['"]electron|TrustedIpcHandle|IpcMainInvokeEvent|ipcMain|deps\.handle/);});
function assertOpenPathContract(h, pathApi) {
 const open=h.calls.find(([name])=>name==='open')[1];
 assert.equal(open.workspaceId,A.meta.workspaceId);assert.equal(open.rootPath,A.layers.overlayRoot);assert.equal(open.game,'sekiro');
 assert.equal(open.appDatabasePath,pathApi.join('/owned/userData','app.db'));
 assert.equal(open.databasePath,pathApi.join('/owned/storage/owned-A','workspace.db'));
 assert.equal(open.migrationSourceDatabasePath,'/owned/legacy/workspace.db');
 assert.equal(open.legacyOperationLogPath,pathApi.join('/owned/userData','operation-logs','owned-A.sqlite'));
 assert.equal(open.legacyBackupDirectory,pathApi.join('/owned/storage/owned-A','legacy-operation-logs'));
 assert.equal(open.legacySemanticSnapshotPath,pathApi.join(A.layers.overlayRoot,'semantic-snapshot.json'));
 assert.equal(open.legacySemanticBackupDirectory,pathApi.join('/owned/storage/owned-A','legacy-semantic-snapshots'));
 const cleanup=h.calls.find(([name])=>name==='cleanup')[1];
 assert.deepEqual(plain(cleanup.allowedRoots),['/owned/backups','/owned/recovery']);
 assert.equal(cleanup.store,h.utility);assert.equal(h.lifecycle.activeKnowledgeWorkspaceId,A.meta.workspaceId);
 assert.deepEqual(h.calls.find(([name])=>name==='snapshot')[1],{workspaceId:A.meta.workspaceId,rootPath:A.layers.overlayRoot,game:'sekiro'});
}
test('open retains durable database/legacy paths, session game and cleanup roots',async()=>{const h=harness(),out=await h.lifecycle.ensureActiveOperationLog(A);assert.equal(out,h.utility);assertOpenPathContract(h,path);});
test('same-workspace concurrent callers share one startup and one knowledge snapshot',async()=>{const start=deferred(),wait=deferred(),h=harness({open:async()=>{start.resolve();await wait.promise;}});const first=h.lifecycle.ensureActiveOperationLog(A);await start.promise;const second=h.lifecycle.ensureActiveOperationLog(A);wait.resolve();assert.equal(await first,h.utility);assert.equal(await second,h.utility);assert.equal(h.calls.filter(([n])=>n==='open').length,1);assert.equal(h.calls.filter(([n])=>n==='snapshot').length,1);});
test('stale session is rejected before any database work',async()=>{const h=harness();h.switchSession(B);await assert.rejects(h.lifecycle.ensureActiveOperationLog(A),error=>error.code==='DATABASE_UTILITY_SESSION_STALE');assert.deepEqual(h.calls,[]);});
test('replacement during utility open rejects old startup before recovery or snapshot',async()=>{const start=deferred(),wait=deferred(),h=harness({open:async()=>{start.resolve();await wait.promise;}});const pending=h.lifecycle.ensureActiveOperationLog(A);await start.promise;h.switchSession(B);wait.resolve();await assert.rejects(pending,error=>error.code==='DATABASE_UTILITY_SESSION_STALE');assert.equal(h.calls.filter(([n])=>n==='cleanup'||n==='snapshot').length,0);});
test('replacement during recovery rejects old publication',async()=>{const start=deferred(),wait=deferred(),h=harness({cleanup:async()=>{start.resolve();await wait.promise;return {rejected:[]};}});const pending=h.lifecycle.ensureActiveOperationLog(A);await start.promise;h.switchSession(B);wait.resolve();await assert.rejects(pending,error=>error.code==='DATABASE_UTILITY_SESSION_STALE');assert.equal(h.lifecycle.activeOperationLog,null);assert.equal(h.calls.filter(([n])=>n==='snapshot').length,0);});
test('different-workspace startup waits for old failure then independently opens its own context',async()=>{const start=deferred(),wait=deferred(),h=harness({open:async input=>{if(input.workspaceId===A.meta.workspaceId){start.resolve();await wait.promise;}}});const old=h.lifecycle.ensureActiveOperationLog(A);await start.promise;h.switchSession(B);const current=h.lifecycle.ensureActiveOperationLog(B);assert.equal(h.calls.filter(([n])=>n==='open').length,1);wait.resolve();await assert.rejects(old,error=>error.code==='DATABASE_UTILITY_SESSION_STALE');assert.equal(await current,h.utility);assert.deepEqual(h.calls.filter(([n])=>n==='open').map(([,v])=>v.workspaceId),[A.meta.workspaceId,B.meta.workspaceId]);assert.equal(h.lifecycle.activeKnowledgeWorkspaceId,B.meta.workspaceId);});
test('authoritative open failure reaches caller and next independent request can recover',async()=>{let fail=true;const error=new Error('owned open failure'),h=harness({open:async()=>{if(fail)throw error;}});await assert.rejects(h.lifecycle.ensureActiveOperationLog(A),value=>value===error);fail=false;assert.equal(await h.lifecycle.ensureActiveOperationLog(A),h.utility);assert.equal(h.calls.filter(([n])=>n==='open').length,2);});
test('rejected cleanup items are reported without substituting another database',async()=>{const h=harness({rejected:[{path:'/owned/rejected',reason:'owned'}]});assert.equal(await h.lifecycle.ensureActiveOperationLog(A),h.utility);assert.equal(h.calls.filter(([n])=>n==='cleanupReport').length,1);assert.equal(h.calls.filter(([n])=>n==='open').length,1);});
test('hot open reuses utility and loaded knowledge store without reopening',async()=>{const h=harness();await h.lifecycle.ensureActiveOperationLog(A);const store=h.lifecycle.activeKnowledgeStore;await h.lifecycle.ensureActiveOperationLog(A);assert.equal(h.lifecycle.activeKnowledgeStore,store);assert.equal(h.calls.filter(([n])=>n==='open'||n==='snapshot').length,2);});
test('pending lifecycle retains the original utility port when caller adapter fields are replaced',async()=>{
 const start=deferred(),wait=deferred(),h=harness({open:async()=>{start.resolve();await wait.promise;}});
 const pending=h.lifecycle.ensureActiveOperationLog(A);await start.promise;
 h.host.operationLogUtility={openWorkspace:()=>{throw new Error('replacement utility used');}};
 h.host.getActiveSession=()=>B;wait.resolve();assert.equal(await pending,h.utility);
 assert.equal(h.lifecycle.activeOperationLog,h.utility);assert.equal(h.lifecycle.activeKnowledgeWorkspaceId,A.meta.workspaceId);
});
test('snapshot failures retry twice and preserve utility with diagnostic/cooldown',async()=>{const h=harness({snapshot:async()=>{throw new Error('owned snapshot unavailable');}});assert.equal(await h.lifecycle.ensureActiveOperationLog(A),h.utility);assert.equal(h.calls.filter(([n])=>n==='snapshot').length,2);assert.equal(h.lifecycle.activeKnowledgeStore,null);assert.equal(h.lifecycle.activeKnowledgeStoreError,'owned snapshot unavailable');await h.lifecycle.ensureActiveOperationLog(A);assert.equal(h.calls.filter(([n])=>n==='snapshot').length,2);});
test('snapshot retry after cooldown is recoverable without reopening utility',async()=>{let fail=true;const h=harness({snapshot:async input=>{if(fail)throw new Error('owned snapshot unavailable');return input;}});await h.lifecycle.ensureActiveOperationLog(A);fail=false;h.setNow(1001);await h.lifecycle.ensureActiveOperationLog(A);assert.ok(h.lifecycle.activeKnowledgeStore);assert.equal(h.lifecycle.activeKnowledgeStoreError,null);assert.equal(h.calls.filter(([n])=>n==='snapshot').length,3);assert.equal(h.calls.filter(([n])=>n==='open').length,1);});
test('dispose invalidates pending knowledge token before waiting for its result',async()=>{const start=deferred(),wait=deferred(),h=harness({snapshot:async()=>{start.resolve();await wait.promise;return {owned:true};}});const pending=h.lifecycle.ensureActiveOperationLog(A);await start.promise;const disposed=h.lifecycle.dispose();assert.equal(h.lifecycle.activeOperationLog,null);assert.equal(h.lifecycle.activeKnowledgeStore,null);wait.resolve();await pending;await disposed;assert.equal(h.lifecycle.activeKnowledgeStore,null);assert.equal(h.lifecycle.activeKnowledgeWorkspaceId,null);assert.equal(h.calls.at(-1)[0],'disposeUtility');});

for (const [name,pathApi] of [['win32',path.win32],['posix',path.posix]]) {
 test(`actual utility service ${name} path contract preserves all durable/legacy/cleanup/native arguments`,async()=>{
  const h=harness({pathApi}),result=await h.lifecycle.ensureActiveOperationLog(A);
  assert.equal(result,h.utility);assertOpenPathContract(h,pathApi);
 });
}
