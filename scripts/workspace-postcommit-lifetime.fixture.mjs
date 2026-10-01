import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';

test('actual EMEVD submit keeps a settled old commit while preserving the new workspace cache and index',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-late-emevd-commit-'));const core=resolve('packages/core/dist/index.js');
 const key=Symbol.for('sf.fixture.late-emevd-commit');let settle,entered;
 const state={wait:new Promise(resolve=>{settle=resolve;}),enter:()=>entered(),replacements:[],refreshes:0};globalThis[key]=state;
 const started=new Promise(resolve=>{entered=resolve;});
 try{
  const output=join(root,'event.mjs');
  await build({entryPoints:[resolve('apps/desktop/src/main/ipc/event.ts')],outfile:output,bundle:true,platform:'node',format:'esm',external:['node:*'],
   footer:{js:'globalThis[Symbol.for("sf.fixture.late-emevd-commit")].cache=emevdFullDocuments;'},plugins:[{name:'transaction-settlement-seam',setup(builder){
    builder.onResolve({filter:/^\//},args=>args.path===core?{path:core,external:true}:undefined);
    builder.onResolve({filter:/^@soulforge\/core$/},()=>({path:'fixture-core',namespace:'fixture'}));
    builder.onResolve({filter:/^@soulforge\/shared$/},()=>({path:resolve('packages/shared/dist/index.js'),external:true}));
    builder.onResolve({filter:/bridgeRoots\.js$/},()=>({path:'fixture-roots',namespace:'fixture'}));
    builder.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'js',contents:args.path==='fixture-roots'
     ?'export async function prepareBridgeRoots(){return {ok:true,allowedRoots:["/old"],writableRoots:["/old"]}}'
     :`export * from ${JSON.stringify(core)};
       export function resolveEmevdRegistry(){return {registry:{}}};export function fingerprintEmedfRegistry(){return 'fixture-schema'};
       export async function readFullEmevdDocumentViaBridge(){return {ok:true,document:{revision:1,documentInstanceId:'old',events:[],marker:'old'},sourceHash:'old',diagnostics:[]}};
       export async function submitEmevdDslPlanViaFourView(){const state=globalThis[Symbol.for('sf.fixture.late-emevd-commit')];state.enter();await state.wait;return {ok:true,diagnostics:[]}};
       export async function openResourcePreview({file}){return {file:{...file,marker:'old-preview'}}}` }));
   }}]});
  const module=await import(pathToFileURL(output).href);let session={meta:{workspaceId:'old'},layers:{overlayRoot:'/old'}};
  let files=[{sourceUri:'file://event/common.emevd',absolutePath:'/old/common.emevd'}];const handlers=new Map();
  module.registerEventIpcHandlers({handle:(name,handler)=>handlers.set(name,handler),get activeSession(){return session;},get indexedFiles(){return files;},
   rejectNonSekiroNativeWrite:()=>null,durableStoragePaths:()=>({root:'/old',stagingRoot:'/old'}),bridgeRootSession:()=>({}),ensureActiveOperationLog:async()=>({}),
   replaceIndexedFile:(_uri,file)=>state.replacements.push(file),refreshActiveIndexAfterNativeWrite:async()=>{state.refreshes++;}});
  state.cache.replace(files[0].sourceUri,{revision:1,events:[]},'old');
  const pending=handlers.get('resource.submitEmevdDslPlan')({sender:{id:123}},files[0].sourceUri,'text','patch');await started;
  session=null;module.clearEmevdIpcCaches();session={meta:{workspaceId:'new'},layers:{overlayRoot:'/new'}};
  files=[{sourceUri:'file://event/common.emevd',absolutePath:'/new/common.emevd'}];state.cache.replace(files[0].sourceUri,{revision:9,events:[],marker:'new'},'new');
  settle();assert.equal((await pending).ok,true);assert.equal(state.cache.get(files[0].sourceUri).marker,'new');
  assert.deepEqual(state.replacements,[]);assert.equal(state.refreshes,0);
 }finally{delete globalThis[key];await rm(root,{recursive:true,force:true});}
});
