import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';

const symbol=Symbol.for('sf.workspace-delayed-read');
const core=pathToFileURL(resolve('packages/core/dist/index.js')).href;
const shared=pathToFileURL(resolve('packages/shared/dist/index.js')).href;
const event={sender:{id:17}};
function gate(){let entered,release;return {entered:new Promise(resolve=>{entered=resolve;}),wait:new Promise(resolve=>{release=resolve;}),start:()=>entered(),release:()=>release()};}

async function bundle(domain,root){
 const file=join(root,`${domain}.mjs`);
 await build({entryPoints:[resolve(`apps/desktop/src/main/ipc/${domain}.ts`)],outfile:file,bundle:true,platform:'node',format:'esm',external:['node:*'],plugins:[{
  name:'native-read-seams',setup(builder){
   builder.onResolve({filter:/^@soulforge\/core$/},()=>({path:'native-read-seams',namespace:'fixture'}));
   builder.onResolve({filter:/^@soulforge\/shared$/},()=>({path:shared,external:true}));
   builder.onResolve({filter:/^electron$/},()=>({path:'electron-seam',namespace:'electron-fixture'}));
   builder.onLoad({filter:/.*/,namespace:'electron-fixture'},()=>({contents:'export const dialog={showSaveDialog:async()=>({canceled:true})};',loader:'js'}));
   builder.onResolve({filter:/^file:/},args=>args.path===core?{path:core,external:true}:undefined);
   builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`
    export * from ${JSON.stringify(core)};
    const state=()=>globalThis[Symbol.for('sf.workspace-delayed-read')];
    export const runBridge=input=>state().native(input);
    export const readFmgDocumentViaBridge=input=>state().fmg(input);
    export function buildNativeDocumentLocator({bridgeValue}){return {kind:'confirmed',locator:{marker:bridgeValue.sourceHash}};}
    export class EditorDocumentStore {async open(_owner,locator){state().opens.push(locator.marker);return {ok:false,code:'capability-blocked',retryable:false};}}
   `,loader:'js'}));
   if(domain==='documents'||domain==='event'){
    builder.onResolve({filter:/bridgeRoots\.js$/},()=>({path:'document-roots',namespace:'document-fixture'}));
    builder.onLoad({filter:/.*/,namespace:'document-fixture'},()=>({contents:`export async function prepareBridgeRoots(){const state=globalThis[Symbol.for('sf.workspace-delayed-read')];if(state.rootsGate){const gate=state.rootsGate;state.rootsGate=null;gate.start();await gate.wait;}return {ok:true,allowedRoots:['/old','/new'],writableRoots:[]};}`,loader:'js'}));
   }
  }
 }]});
 return import(pathToFileURL(file).href);
}

function fixtureState(extension){
 let session={meta:{workspaceId:'old'},layers:{overlayRoot:'/old'}};
 let files=[{sourceUri:'file://resource',absolutePath:`/old/common${extension}`,relativePath:`common${extension}`,compoundExtension:extension,resourceKind:'msg',sha256:'a'.repeat(64)}];
 const state={reads:[],opens:[],rootsGate:null,nativeGate:null};
 const label=path=>path.startsWith('/old/')?'OLD_VALUE':'NEW_VALUE';
 state.native=async input=>{
  state.reads.push(input.filePath);
  if(state.nativeGate&&input.filePath.startsWith('/old/')){state.nativeGate.start();await state.nativeGate.wait;}
  const value=label(input.filePath);
  return {parseStatus:'confirmed',diagnostics:[],sourceUri:'file://resource',data:{
   sourceHash:value,typeName:'FIXTURE_UNKNOWN_PARAM',rowCount:1,rowDataSize:4,
   sessionToken:`session-${value}`,pathSourceGeneration:1,payloadsIncluded:true,
   rows:[{rowIndex:0,id:1,name:value,dataHash:'b'.repeat(64),dataBase64:'AAAAAA=='}],
   languageId:'enus',containerKind:'common',containerId:'text:enus:common',outerHash:value,
   tableSourceHash:value,tables:[{stableId:'table:common',entryIndex:0,entryName:'common.fmg',entryCount:1}],
   entries:[{id:1,text:value}],format:'DCX',nested:{format:'BND4',entryCount:1,entries:[{index:0,name:`${value}.lua`,uncompressedSize:4}]}
  }};
 };
 state.fmg=async input=>{
  const result=await state.native({filePath:input.sourcePath});return {ok:true,diagnostics:[],data:{...result.data,entryCount:1}};
 };
 const deps={handle:(name,handler)=>state.handlers.set(name,handler),get activeSession(){return session;},get indexedFiles(){return files;},
  get activeWorkspaceSessionId(){return session?.meta.workspaceId??null;},
  durableStoragePaths:()=>({root:'/owned'}),bridgeRootSession:()=>({}),
  verifiedReadRoots:async()=>{if(state.rootsGate){const pending=state.rootsGate;state.rootsGate=null;pending.start();await pending.wait;}return {allowedRoots:['/old','/new'],diagnostics:[]};}};
 state.handlers=new Map();state.deps=deps;
 state.replace=(clear,reuse=false)=>{const previous=session;session=null;clear();session=reuse?previous:{meta:{workspaceId:'new'},layers:{overlayRoot:'/new'}};files=files.map(file=>({...file,absolutePath:`/new/common${extension}`}));};
 return state;
}

for(const [domain,register,clear,channel,extension,args,field] of [
 ['text','registerTextIpcHandlers','clearTextIpcCaches','resource.readFmgPage','.fmg',[0,100],'entries'],
 ['param','registerParamIpcHandlers','clearParamIpcCaches','resource.readParamPage','.param',[0,100,undefined,true],'rows'],
 ['param','registerParamIpcHandlers','clearParamIpcCaches','resource.readParamPage','.param',[0,100],'rows'],
 ['param','registerParamIpcHandlers','clearParamIpcCaches','resource.openParamSession','.param',null,'sourceHash'],
 ['raw','registerRawIpcHandlers','clearRawIpcCaches','resource.listScriptContainerEntriesPage','.luabnd.dcx',[0,100],'scripts'],
 ['event','registerEventIpcHandlers','clearEmevdIpcCaches','resource.readEmevdDocument','.emevd',[],'dataHash'],
])for(const phase of ['roots','native'])test(`${domain} ${channel}${channel==='resource.readParamPage'?(args[3]===true?' with payloads':' without payloads'):''} cannot publish a delayed ${phase} read into a replacement workspace`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-delayed-read-'));const state=fixtureState(extension);globalThis[symbol]=state;
 try{
  const module=await bundle(domain,root);module[register](state.deps);const read=state.handlers.get(channel);
  const input=args?[event,'file://resource',...args]:[event,{sourceUri:'file://resource'}];
  const pending=gate();state[`${phase}Gate`]=pending;const old=read(...input);await pending.entered;
  state.replace(module[clear]);const current=await read(...input);assert.equal(current.ok,true);
  pending.release();const oldResult=await old;assert.equal(oldResult.ok,false);assert.equal(oldResult.diagnostics[0].code,'WORKSPACE_READ_SUPERSEDED');
  const later=await read(...input);assert.equal(later.ok,true);
  const value=field==='sourceHash'?later.sourceHash:field==='dataHash'?later.data.sourceHash:field==='scripts'?later.entries[0].name:later[field][0][field==='rows'?'name':'text'];
  assert.equal(value,field==='scripts'?'NEW_VALUE.lua':'NEW_VALUE');
  if(phase==='roots')assert.ok(state.reads.every(path=>path.startsWith('/new/')),'stale roots must stop old native dispatch');
 }finally{delete globalThis[symbol];await rm(root,{recursive:true,force:true});}
});

for(const phase of ['roots','native'])test(`document.open drops delayed ${phase} reads before populating the replacement store`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-delayed-document-'));const state=fixtureState('.fmg');globalThis[symbol]=state;
 try{
  const module=await bundle('documents',root);module.registerDocumentIpcHandlers(state.deps);
  const read=state.handlers.get('document.open');const request={document:{resourceId:'file://resource',domain:'text',libraryId:'game-text',bankId:null,documentId:'common',sourceVariant:'overlay'}};
  const pending=gate();state[`${phase}Gate`]=pending;const old=read(event,request);await pending.entered;
  state.replace(module.resetEditorDocumentStore);const current=await read(event,request);assert.equal(current.code,'capability-blocked');
  pending.release();const stale=await old;assert.equal(stale.ok,false);assert.equal(stale.diagnostics[0].code,'WORKSPACE_READ_SUPERSEDED');
  assert.deepEqual(state.opens,['NEW_VALUE']);
  if(phase==='roots')assert.ok(state.reads.every(path=>path.startsWith('/new/')));
 }finally{delete globalThis[symbol];await rm(root,{recursive:true,force:true});}
});

test('text catalog/table references survive a late old catalog and same-session reset',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-delayed-catalog-'));const state=fixtureState('.msgbnd.dcx');globalThis[symbol]=state;
 try{
  const module=await bundle('text',root);module.registerTextIpcHandlers(state.deps);
  const catalog=state.handlers.get('resource.readTextCatalog');const table=state.handlers.get('resource.readFmgTablePage');
  const pending=gate();state.nativeGate=pending;const old=catalog(event);await pending.entered;
  state.replace(module.clearTextIpcCaches,true);const current=await catalog(event);assert.equal(current.ok,true);
  pending.release();assert.equal((await old).ok,false);
  const page=await table(event,'table:common',0,100);assert.equal(page.ok,true);assert.equal(page.entries[0].text,'NEW_VALUE');
 }finally{delete globalThis[symbol];await rm(root,{recursive:true,force:true});}
});

test('PARAM session identity independently rejects a late result before an explicit cache reset',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-param-identity-read-'));const state=fixtureState('.param');globalThis[symbol]=state;
 try{
  const module=await bundle('param',root);module.registerParamIpcHandlers(state.deps);
  const read=state.handlers.get('resource.readParamPage');const pending=gate();state.nativeGate=pending;
  const old=read(event,'file://resource',0,100,undefined,true);await pending.entered;
  state.replace(()=>{});const current=await read(event,'file://resource',0,100,undefined,true);assert.equal(current.rows[0].name,'NEW_VALUE');
  pending.release();const stale=await old;assert.equal(stale.ok,false);assert.equal(stale.diagnostics[0].code,'WORKSPACE_READ_SUPERSEDED');
  assert.equal((await read(event,'file://resource',0,100,undefined,true)).rows[0].name,'NEW_VALUE');
 }finally{delete globalThis[symbol];await rm(root,{recursive:true,force:true});}
});
