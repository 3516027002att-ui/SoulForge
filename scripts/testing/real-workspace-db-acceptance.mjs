/** Explicit one-off acceptance on an owned snapshot. Never migrates the source. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream,writeFileSync} from 'node:fs';
import {mkdir,readdir,readFile,stat,writeFile,lstat,realpath} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute,dirname,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import Database from 'better-sqlite3';
import {backupWorkspaceDatabase,openWorkspaceDatabase} from '../../packages/core/dist/storage/sqliteDatabase.js';
import {SqliteOperationLogStore} from '../../packages/core/dist/patch/sqliteOperationLogStore.js';
const digest=async path=>{const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');};
const retired=['event_symbols','event_instructions','event_text_fts','map_entities','map_regions','param_rows','param_fields','param_rows_fts','text_entries','text_entries_fts','operation_logs','workspace_layers','agent_runs','resource_nodes','resource_edges','resource_graph_snapshots'];
const preservedTables=['workspaces','patch_history','transaction_journal','semantic_file_cache','rag_chunks'];
const quoteIdentifier=value=>`"${value.replaceAll('"','""')}"`;

function digestField(hash,type,bytes){
 hash.update(`${type}:${bytes.length}:`,'ascii');hash.update(bytes);
}

/** One SQLite row at a time. Storage classes and framing prevent text/blob/numeric collisions. */
export function streamTableDigest(db,table,{columns:preservedColumns}={}){
 const quoted=quoteIdentifier(table);
 const columns=db.pragma(`table_xinfo(${quoted})`).filter(column=>column.hidden!==1).sort((a,b)=>a.cid-b.cid);
 assert.ok(columns.length,'ACCEPTANCE_TABLE_COLUMNS_UNAVAILABLE');
 const allNames=columns.map(column=>column.name),names=preservedColumns??allNames;
 assert.ok(Array.isArray(names)&&names.length&&new Set(names).size===names.length&&names.every(name=>allNames.includes(name)),'ACCEPTANCE_PRESERVED_COLUMNS_MISSING');
 const known=new Set(allNames.map(name=>name.toLowerCase()));
 const primary=columns.filter(column=>column.pk>0).sort((a,b)=>a.pk-b.pk).map(column=>column.name);
 let rowid;
 for(const alias of ['rowid','_rowid_','oid']){
  if(known.has(alias))continue;
  try{db.prepare(`SELECT ${alias} FROM ${quoted} LIMIT 0`);rowid=alias;break;}catch(error){
   if(error.code!=='SQLITE_ERROR'||!/no such column/u.test(error.message))throw error;
  }
 }
 assert.ok(primary.length||rowid,'ACCEPTANCE_TABLE_ORDER_UNAVAILABLE');
 if(!rowid){
  // WITHOUT ROWID has a non-null PK. A shadowed rowid table needs the same
  // guarantee: nullable UNIQUE/PK tuples are not a reliable ordering key.
  assert.equal(db.prepare(`SELECT 1 FROM ${quoted} WHERE ${primary.map(name=>`${quoteIdentifier(name)} IS NULL`).join(' OR ')} LIMIT 1`).get(),undefined,'ACCEPTANCE_TABLE_ORDER_UNAVAILABLE');
 }
 const orderBy=[...primary,...(rowid?[rowid]:[])];
 const orderSql=[...primary.map(quoteIdentifier),...(rowid?[rowid]:[])].join(',');
 const fields=names.flatMap(name=>{
  const column=quoteIdentifier(name);
  // Read text as bytes too: malformed UTF-8 must not collapse through JS's replacement character.
  return [`typeof(${column})`,`CASE WHEN typeof(${column}) IN ('text','blob') THEN CAST(${column} AS BLOB) ELSE ${column} END`];
 });
 const statement=db.prepare(`SELECT ${fields.join(',')} FROM ${quoted} ORDER BY ${orderSql}`).raw(true).safeIntegers(true);
 const hash=createHash('sha256');digestField(hash,'schema',Buffer.from(JSON.stringify({table,columns:names}),'utf8'));
 let rowCount=0;
 for(const row of statement.iterate()){
  hash.update('row:');
  for(let index=0;index<row.length;index+=2){
   const type=row[index],value=row[index+1];let bytes;
   if(type==='null'){assert.equal(value,null);bytes=Buffer.alloc(0);}
   else if(type==='integer'){assert.equal(typeof value,'bigint');bytes=Buffer.allocUnsafe(8);bytes.writeBigInt64BE(value);}
   else if(type==='real'){assert.equal(typeof value,'number');bytes=Buffer.allocUnsafe(8);bytes.writeDoubleBE(value);}
   else if(type==='text'||type==='blob'){assert.ok(Buffer.isBuffer(value));bytes=value;}
   else throw new Error(`ACCEPTANCE_SQLITE_STORAGE_CLASS_UNSUPPORTED: ${type}`);
   digestField(hash,type,bytes);
  }
  rowCount++;
 }
 return {algorithm:'sqlite-typed-row-sha256-v1',columns:names,orderBy,rowCount,sha256:hash.digest('hex')};
}

export function databaseAcceptanceInventory(db,{baseline}={}){
 const read=()=>{
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row=>row.name);
  const unverifiedAddedColumns={};
  const preservedTableDigests=Object.fromEntries(preservedTables.filter(name=>tables.includes(name)).map(name=>{
   const original=baseline?.preservedTableDigests?.[name]?.columns;
   const result=streamTableDigest(db,name,{columns:original});
   if(original){
    const added=db.pragma(`table_xinfo(${quoteIdentifier(name)})`).filter(column=>column.hidden!==1&&!original.includes(column.name)).map(column=>column.name);
    if(added.length)unverifiedAddedColumns[name]=added;
   }
   return [name,result];
  }));
  const counts=Object.fromEntries(Object.entries(preservedTableDigests).map(([name,value])=>[name,value.rowCount]));
  return {version:db.pragma('user_version',{simple:true}),tables,counts,preservedTableDigests,unverifiedAddedColumns,quickCheck:db.pragma('quick_check',{simple:true})};
 };
 // All five table scans share one read snapshot, including on a live writer connection.
 return db.inTransaction?read():db.transaction(read).deferred();
}
export function assertPreservedTables(before,after){
 assert.deepEqual(after.counts,before.counts,'preserved table row counts differ');
 assert.ok(before.preservedTableDigests&&after.preservedTableDigests,'preserved table content evidence is missing');
 assert.deepEqual(after.preservedTableDigests,before.preservedTableDigests,'preserved table content differs');
}
function inspect(path,baseline){const db=new Database(path,{readonly:true,fileMustExist:true});try{return databaseAcceptanceInventory(db,{baseline});}finally{db.close();}}

const samePath=(left,right)=>process.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right;
function inside(root,path){const part=relative(root,path);return part!==''&&part!=='..'&&!part.startsWith(`..${sep}`)&&!isAbsolute(part);}
function ownedPathError(message){return Object.assign(new Error(`ACCEPTANCE_OWNED_PATH_INVALID: ${message}`),{code:'ACCEPTANCE_OWNED_PATH_INVALID'});}

/** Reject link traversal before any output creation or writable database open. */
export async function assertOwnedAcceptancePath(path,{source,repositoryRoot=process.cwd(),mustExist=false}={}){
 const root=resolve(repositoryRoot),base=join(root,'.local-validation'),absolute=resolve(path);
 if(!inside(base,absolute))throw ownedPathError('output must be below this checkout .local-validation');
 if(source&&samePath(absolute,resolve(source)))throw new Error('ACCEPTANCE_SOURCE_ALIAS: output equals source');
 const rootPhysical=await realpath(root),physicalBase=join(rootPhysical,'.local-validation');
 const sourcePhysical=source?await realpath(source):undefined,sourceInfo=source?await stat(source,{bigint:true}):undefined;
 const parts=['.local-validation',...relative(base,absolute).split(sep)];
 let cursor=root,physical=rootPhysical;
 for(let index=0;index<parts.length;index++){
  cursor=join(cursor,parts[index]);physical=join(physical,parts[index]);
  let info;
  try{info=await lstat(cursor,{bigint:true});}catch(error){
   if(error.code==='ENOENT'&&!mustExist&&index===parts.length-1)return physical;
   throw ownedPathError('an output ancestor is missing or unreadable');
  }
  if(info.isSymbolicLink())throw ownedPathError('junctions and symbolic links are not owned output directories');
  if(index<parts.length-1&&!info.isDirectory())throw ownedPathError('output ancestor is not a directory');
  const actual=await realpath(cursor);
  if(!samePath(actual,physical)||(index>0&&!inside(physicalBase,actual)))throw ownedPathError('resolved output escaped the owned root');
  if(sourceInfo&&(samePath(actual,sourcePhysical)||(info.dev===sourceInfo.dev&&info.ino===sourceInfo.ino)))throw new Error('ACCEPTANCE_SOURCE_ALIAS: output identifies the source database');
  if(info.isFile()&&info.nlink!==1n)throw ownedPathError('an output file has another hardlink owner');
  physical=actual;
 }
 return physical;
}

export async function runRealWorkspaceDatabaseAcceptance({source,output}){
 source=resolve(source);output=await assertOwnedAcceptancePath(resolve(output),{source});
 await mkdir(output,{recursive:false});
 output=await assertOwnedAcceptancePath(output,{source,mustExist:true});
 const snapshot=join(output,'source-snapshot.db'),target=join(output,'migration-copy.db'),cancelled=join(output,'cancelled.db');
 const report={schema:'real-workspace-db-acceptance-v1',startedAt:new Date().toISOString(),source:{path:source,byteLength:(await stat(source)).size,sha256:await digest(source)},
  preservationScope:{tables:preservedTables,comparison:'sqlite-typed-row-sha256-v1',baseline:'consistent source snapshot; original columns only; added-column contents are not covered',knowledge:'semantic conversion readback only; not included in these table fingerprints'},status:'running',phases:[]};
 const save=()=>writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
 await save();
 try{
  // This is the only original-db access: a readonly connection and consistent
  // backup API. All fault injection/migrations below operate on owned copies.
  await backupWorkspaceDatabase(source,snapshot);
  await assertOwnedAcceptancePath(snapshot,{source,mustExist:true});
  report.before=inspect(snapshot);assert.equal(report.before.quickCheck,'ok');
  report.phases.push({name:'consistent-snapshot',status:'passed',snapshotSha256:await digest(snapshot)});await save();
  const abort=new AbortController();let progressObserved=false;
  await assert.rejects(backupWorkspaceDatabase(snapshot,cancelled,{signal:abort.signal,progress:()=>{progressObserved=true;abort.abort();return 1;}}));
  assert.equal(progressObserved,true);assert.deepEqual((await readdir(output)).filter(name=>name.startsWith('cancelled.db')),[]);
  report.phases.push({name:'cancelled-backup-no-publication',status:'passed'});await save();
  await backupWorkspaceDatabase(snapshot,target);
  await assertOwnedAcceptancePath(target,{source,mustExist:true});
  const version=report.before.version;
  if(version<16){
   const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--crash-child',target,source],{stdio:['ignore','pipe','pipe'],windowsHide:true});
   let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
   const code=await new Promise((accept,reject)=>{child.on('error',reject);child.on('exit',accept);});
   assert.equal(code,73,stderr);const marker=JSON.parse(await readFile(join(output,'crash-marker.json'),'utf8'));assert.equal(marker.phase,'retirement-sql-before-commit');
   // Earlier migrations commit individually. v15 may legitimately have completed
   // before the injected crash in v16; only the interrupted transaction rolls back.
   const interrupted=inspect(target,report.before);assert.equal(interrupted.version,marker.version);assert.ok(interrupted.version<16);assertPreservedTables(report.before,interrupted);
   for(const table of retired.filter(name=>report.before.tables.includes(name)))assert.ok(interrupted.tables.includes(table));
   report.phases.push({name:'crash-before-commit-rolls-back',status:'passed'});await save();
  }else report.phases.push({name:'crash-before-commit-rolls-back',status:'not_run',reason:'real source is already at or after retirement migration'});
  await assertOwnedAcceptancePath(target,{source,mustExist:true});
  const db=openWorkspaceDatabase(target);
  try{
   const after=databaseAcceptanceInventory(db,{baseline:report.before});for(const table of retired)assert.equal(after.tables.includes(table),false,table);
   assertPreservedTables(report.before,after);report.after=after;
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
   await assertOwnedAcceptancePath(join(output,name),{source,mustExist:true});
   const recovery=inspect(join(output,name),report.before);assert.equal(recovery.quickCheck,'ok');assertPreservedTables(report.before,recovery);
   report.snapshots.push({name,sha256:await digest(join(output,name)),version:recovery.version,preservedTableDigests:recovery.preservedTableDigests,unverifiedAddedColumns:recovery.unverifiedAddedColumns});
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
  assert.ok(second,'crash child requires the original source identity guard');
  const target=await assertOwnedAcceptancePath(resolve(first),{source:resolve(second),mustExist:true});assert.equal(target.endsWith('migration-copy.db'),true);
  const original=Database.prototype.exec;
  Database.prototype.exec=function(sql){const result=original.call(this,sql);if(sql.includes('DROP TABLE IF EXISTS event_instructions')){writeFileSync(join(dirname(target),'crash-marker.json'),JSON.stringify({phase:'retirement-sql-before-commit',version:this.pragma('user_version',{simple:true})}));process.exit(73);}return result;};
  openWorkspaceDatabase(target).close();throw new Error('Expected retirement transaction was not exercised');
 }else{
  assert.equal(mode,'--execute','Usage: --execute SOURCE_DB OWNED_OUTPUT_DIRECTORY');
  const report=await runRealWorkspaceDatabaseAcceptance({source:first,output:second});console.log(JSON.stringify({status:report.status,phases:report.phases,originalPreserved:report.originalPreserved}));process.exitCode=report.status==='passed'?0:1;
 }
}
