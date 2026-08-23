#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runBridge } from '../packages/core/dist/bridge/runBridge.js';
const MODS_ROOT = 'D:/mystream/Sekiro Shadows Die Twice/Sekiro/mods';
const GAME_ROOT = 'D:/mystream/Sekiro Shadows Die Twice/Sekiro';
function collectFiles(root){const out=[],stack=[root];while(stack.length){const dir=stack.pop();let e=[];try{e=readdirSync(dir,{withFileTypes:true});}catch{continue}for(const x of e){const p=join(dir,x.name);if(x.isDirectory())stack.push(p);else if(x.isFile())out.push(p)}}return out;}
function pick(files,pats,n=2){return files.filter(f=>pats.some(p=>f.toLowerCase().includes(p.toLowerCase()))).slice(0,n);}
async function tryBridge(cmd,file,opts={}){
  const abs=resolve(file);
  if(!existsSync(abs)) return {file,command:cmd,parseStatus:'failed',code:'FILE_NOT_FOUND'};
  try{const r=await runBridge({command:cmd,filePath:abs,allowedRoots:[MODS_ROOT,GAME_ROOT],oodleRuntimeRoot:GAME_ROOT,timeoutMs:90000,commandOptions:opts});
    return {file:file.replaceAll('\\','/').slice(MODS_ROOT.length+1),command:cmd,parseStatus:r.parseStatus,diag:(r.diagnostics[0]?.code||'')+':'+(r.diagnostics[0]?.message||'').slice(0,140),hasData:!!r.data, diagnostics:r.diagnostics.map(d=>d.code)};
  }catch(e){return {file,command:cmd,parseStatus:'failed',error:String(e).slice(0,300)};}
}
async function main(){
  const files=collectFiles(MODS_ROOT);
  console.log(`Mods files: ${files.length}`);
  const families=[
    {label:'MAP msb.dcx',pats:['.msb.dcx'],cmd:'read-msb-document',n:3},
    {label:'MAP mapbnd.dcx',pats:['.mapbnd.dcx'],cmd:'read-dcx-document',n:1},
    {label:'MAP btl.dcx',pats:['.btl.dcx'],cmd:'read-dcx-document',n:1},
    {label:'MAP gparam.dcx',pats:['.gparam.dcx'],cmd:'read-gparam-document',n:3},
    {label:'ACTION anibnd',pats:['.anibnd.dcx'],cmd:'read-tae-document',n:3},
    {label:'ACTION chrbnd (FLVER preview)',pats:['.chrbnd.dcx'],cmd:'read-chrbnd-flver-preview',n:3},
    {label:'ACTION behbnd',pats:['.behbnd.dcx'],cmd:'read-dcx-document',n:2},
    {label:'ACTION hks',pats:['.hks'],cmd:'inspect',n:2},
    {label:'ACTION luabnd',pats:['.luabnd.dcx'],cmd:'inspect',n:2},
    {label:'DCX chain',pats:['.dcx'],cmd:'read-dcx-document',n:2},
    {label:'MSG msgbnd',pats:['.msgbnd.dcx'],cmd:'read-text-catalog',n:2},
    {label:'SFX ffxbnd read-fxr',pats:['.ffxbnd.dcx'],cmd:'read-fxr-document',n:1},
    {label:'SFX ffxbnd list',pats:['.ffxbnd.dcx'],cmd:'list-ffxbnd-entries',n:1},
    {label:'ESD talkesdbnd',pats:['.talkesdbnd.dcx'],cmd:'read-esd-document',n:1},
  ];
  const rows=[];
  for(const fam of families){
    const samples=pick(files,fam.pats,fam.n);
    if(!samples.length){rows.push({family:fam.label,file:'(no sample)',command:fam.cmd,parseStatus:'no-sample'});continue;}
    for(const s of samples){
      const r=await tryBridge(fam.cmd,s);
      rows.push({family:fam.label, ...r});
      console.log(`[${fam.label}] ${r.file} :: ${r.command} -> ${r.parseStatus} ${r.diag||r.error||''}`);
    }
  }
  console.log('\n=== SUMMARY ===');
  for(const r of rows) console.log(`${r.family} | ${r.file} | ${r.command} | ${r.parseStatus} | ${r.diag||r.error||''}`);
  const failed=rows.filter(r=>r.parseStatus==='failed');
  console.log(`\nTotal: ${rows.length}, Failed: ${failed.length}`);
  if(failed.length){console.log('FAILED:');for(const f of failed) console.log(` - ${f.family} ${f.file} ${f.command} ${f.diag||f.error}`);}
  // success iff no failed (empty flver is now partial OK)
  process.exitCode = failed.length?1:0;
}
main().catch(e=>{console.error(e);process.exit(1);});
