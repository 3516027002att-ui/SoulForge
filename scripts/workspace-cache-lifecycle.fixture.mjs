import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';

test('actual workspace scan and remount release editor caches before publishing a new session',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-workspace-cache-lifecycle-'));
 const overlay=join(root,'overlay');await mkdir(overlay);const entry=join(root,'workspace.mjs');
 const key=Symbol.for('sf.workspace-cache-lifecycle');globalThis[key]={root,overlay};
 try{
  await build({entryPoints:[resolve('apps/desktop/src/main/ipc/workspace.ts')],outfile:entry,bundle:true,format:'esm',platform:'node',external:['node:*'],plugins:[{
   name:'fixture-host',setup(builder){
    builder.onResolve({filter:/^@soulforge\/(core|shared)$/},args=>({path:resolve(`packages/${args.path.split('/')[1]}/dist/index.js`),external:true}));
    builder.onResolve({filter:/^electron$/},()=>({path:'fixture-electron',namespace:'fixture-host'}));
    builder.onLoad({filter:/.*/,namespace:'fixture-host'},()=>({contents:`const value=globalThis[Symbol.for('sf.workspace-cache-lifecycle')];export const app={isPackaged:false,getPath:()=>value.root,getAppPath:()=>value.root};export const dialog={showOpenDialog:async()=>({canceled:false,filePaths:[value.overlay]})};export const utilityProcess={fork(){throw new Error('Unexpected process creation');}};`,loader:'js'}));
   }
  }]});
  const workspace=await import(pathToFileURL(entry).href);const handlers=new Map();const calls=[];let stopAtRelease=false;
  workspace.registerWorkspaceIpcHandlers({handle:(name,handler)=>handlers.set(name,handler),clearActiveOperationLog:async()=>{calls.push('database-settled');},
   releaseEditorCaches:()=>{assert.equal(workspace.getWorkspaceSession(),null,'old session must be detached before its views release');calls.push('views-released');if(stopAtRelease)throw new Error('RELEASE_FRONTIER');},
   ensureActiveOperationLog:async()=>{throw new Error('fixture database unavailable');},verifiedReadRoots:async()=>({allowedRoots:[root],diagnostics:[]})});
  const event={sender:{id:123}};const selection=await handlers.get('workspace.openDialog')(event);
  await handlers.get('workspace.scan')(event,{overlaySelectionId:selection.selectionId,clearBase:true});
  assert.deepEqual(calls.slice(0,2),['database-settled','views-released']);
  assert.ok(workspace.getWorkspaceSession());stopAtRelease=true;
  await assert.rejects(handlers.get('workspace.remountBase')(event),/RELEASE_FRONTIER/);
  assert.deepEqual(calls.slice(-2),['database-settled','views-released']);
 }finally{delete globalThis[key];await rm(root,{recursive:true,force:true});}
});
