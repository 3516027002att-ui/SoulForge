/** Explicit one-off acceptance on an owned snapshot. Never migrates the source. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream,writeFileSync} from 'node:fs';
import {mkdir,readdir,readFile,stat,writeFile} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import Database from 'better-sqlite3';
import {backupWorkspaceDatabase,openWorkspaceDatabase} from '../../packages/core/dist/storage/sqliteDatabase.js';
import {SqliteOperationLogStore} from '../../packages/core/dist/patch/sqliteOperationLogStore.js';
const digest=async path=>{const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');};
const retired=['event_symbols','event_instructions','event_text_fts','map_entities','map_regions','param_rows','param_fields','param_rows_fts','text_entries','text_entries_fts','operation_logs','workspace_layers','agent_runs','resource_nodes','resource_edges','resource_graph_snapshots'];
function inventory(db){
 const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row=>row.name);
 const counts=Object.fromEntries(['workspaces','patch_history','transaction_journal','semantic_file_cache','rag_chunks'].filter(name=>tables.includes(name)).map(name=>[name,db.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n]));
 return {version:db.pragma('user_version',{simple:true}),tables,counts,quickCheck:db.pragma('quick_check',{simple:true})};
}
function inspect(path){const db=new Database(path,{readonly:true,fileMustExist:true});try{return inventory(db);}finally{db.close();}}
function assertOwned(path){const base=resolve('.local-validation'),part=relative(base,path);assert.ok(part&&!part.startsWith('..')&&!isAbsolute(part),'experiment output must be inside this checkout .local-validation');}

export async function runRealWorkspaceDatabaseAcceptance({source,output}){
 source=resolve(source);output=resolve(output);assertOwned(output);
 await mkdir(output,{recursive:false});
 const snapshot=join(output,'source-snapshot.db'),target=join(output,'migration-copy.db'),cancelled=join(output,'cancelled.db');
 const report={schema:'real-workspace-db-acceptance-v1',startedAt:new Date().toISOString(),source:{path:source,byteLength:(await stat(source)).size,sha256:await digest(source)},status:'running',phases:[]};
 const save=()=>writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
 await save();
 try{
  // This is the only original-db access: a readonly connection and consistent
  // backup API. All fault injection/migrations below operate on owned copies.
  await backupWorkspaceDatabase(source,snapshot);
  report.before=inspect(snapshot);assert.equal(report.before.quickCheck,'ok');
  report.phases.push({name:'consistent-snapshot',status:'passed',snapshotSha256:await digest(snapshot)});await save();
  const abort=new AbortController();let progressObserved=false;
  await assert.rejects(backupWorkspaceDatabase(snapshot,cancelled,{signal:abort.signal,progress:()=>{progressObserved=true;abort.abort();return 1;}}));
  assert.equal(progressObserved,true);assert.deepEqual((await readdir(output)).filter(name=>name.startsWith('cancelled.db')),[]);
  report.phases.push({name:'cancelled-backup-no-publication',status:'passed'});await save();
  await backupWorkspaceDatabase(snapshot,target);
  const version=report.before.version;
  if(version<16){
   const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--crash-child',target],{stdio:['ignore','pipe','pipe'],windowsHide:true});
   let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
   const code=await new Promise((accept,reject)=>{child.on('error',reject);child.on('exit',accept);});
   assert.equal(code,73,stderr);const marker=JSON.parse(await readFile(join(output,'crash-marker.json'),'utf8'));assert.equal(marker.phase,'retirement-sql-before-commit');
   // Earlier migrations commit individually. v15 may legitimately have completed
   // before the injected crash in v16; only the interrupted transaction rolls back.
   const interrupted=inspect(target);assert.equal(interrupted.version,marker.version);assert.ok(interrupted.version<16);assert.deepEqual(interrupted.counts,report.before.counts);
   for(const table of retired.filter(name=>report.before.tables.includes(name)))assert.ok(interrupted.tables.includes(table));
   report.phases.push({name:'crash-before-commit-rolls-back',status:'passed'});await save();
  }else report.phases.push({name:'crash-before-commit-rolls-back',status:'not_run',reason:'real source is already at or after retirement migration'});
  const db=openWorkspaceDatabase(target);
  try{
   const after=inventory(db);for(const table of retired)assert.equal(after.tables.includes(table),false,table);
   assert.deepEqual(after.counts,report.before.counts);report.after=after;
   const workspaceId=db.prepare('SELECT workspace_id FROM workspaces LIMIT 1').get()?.workspace_id;
   if(workspaceId){
    const reader=new Database(target,{readonly:true,fileMustExist:true,timeout:2000}),writer=new SqliteOperationLogStore(db,workspaceId),readStore=new SqliteOperationLogStore(reader,workspaceId);
    try{
     const opId='acceptance-owned-transaction-query';
     await writer.record({opId,workspaceId,title:'owned acceptance only',author:'user',mode:'normal',status:'committed',createdAt:new Date().toISOString(),files:[],diagnostics:[]});
     assert.equal((await readStore.get(opId))?.status,'committed');
     db.exec('BEGIN IMMEDIATE');try{assert.equal((await readStore.get(opId))?.status,'committed');}finally{db.exec('ROLLBACK');}
     report.phases.push({name:'independent-read-during-writer-transaction-and-commit-query',status:'passed'});
    }finally{reader.close();}
   }else report.phases.push({name:'independent-read-during-writer-transaction-and-commit-query',status:'unavailable',reason:'source snapshot contains no workspace identity'});
  }finally{db.close();}
  report.snapshots=[];
  for(const name of (await readdir(output)).filter(name=>name.includes('.pre-schema-')&&name.endsWith('.db'))){
   const recovery=inspect(join(output,name));assert.equal(recovery.quickCheck,'ok');assert.deepEqual(recovery.counts,report.before.counts);
   report.snapshots.push({name,sha256:await digest(join(output,name)),version:recovery.version});
  }
  if(version<16)assert.ok(report.snapshots.length>0);
  report.phases.push({name:'retirement-recovery-and-preserved-snapshot',status:'passed'});
  report.status=report.phases.every(phase=>phase.status==='passed')?'passed':'unavailable';
 }catch(error){report.status='failed';report.error={code:error.code??'ACCEPTANCE_FAILED',message:error.message};}
 finally{report.sourceAfterSha256=await digest(source);report.originalPreserved=report.source.sha256===report.sourceAfterSha256;if(!report.originalPreserved)report.status='failed';report.finishedAt=new Date().toISOString();await save();}
 return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [mode,first,second]=process.argv.slice(2);
 if(mode==='--crash-child'){
  const target=resolve(first);assertOwned(target);assert.equal(target.endsWith('migration-copy.db'),true);
  const original=Database.prototype.exec;
  Database.prototype.exec=function(sql){const result=original.call(this,sql);if(sql.includes('DROP TABLE IF EXISTS event_instructions')){writeFileSync(join(dirname(target),'crash-marker.json'),JSON.stringify({phase:'retirement-sql-before-commit',version:this.pragma('user_version',{simple:true})}));process.exit(73);}return result;};
  openWorkspaceDatabase(target).close();throw new Error('Expected retirement transaction was not exercised');
 }else{
  assert.equal(mode,'--execute','Usage: --execute SOURCE_DB OWNED_OUTPUT_DIRECTORY');
  const report=await runRealWorkspaceDatabaseAcceptance({source:first,output:second});console.log(JSON.stringify({status:report.status,phases:report.phases,originalPreserved:report.originalPreserved}));process.exitCode=report.status==='passed'?0:1;
 }
}
