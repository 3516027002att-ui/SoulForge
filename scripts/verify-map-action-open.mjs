#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { disposeBridgeDaemonPool, runBridge } from '../packages/core/dist/bridge/runBridge.js';
import { classifyNativeRead, summarizeNativeReads, verifyFileCoverage } from './native-read-acceptance.mjs';
// Real game data never ships with the repository; without both roots the check honestly skips.
const GAME_ROOT = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim().replaceAll('\\', '/') || '';
const MODS_ROOT = (process.env.SOULFORGE_SEKIRO_MOD_ROOT?.trim() || (GAME_ROOT ? join(GAME_ROOT, 'mods') : '')).replaceAll('\\', '/');
if (!GAME_ROOT || !existsSync(MODS_ROOT)) {
  console.log(JSON.stringify({ ok: null, status: 'skipped', skipped: true, gate: 'verify-map-action-open',
    reason: 'SOULFORGE_SEKIRO_GAME_ROOT (and an existing mods root) is required' }));
  process.exit(0);
}
function collectFiles(root){const out=[],stack=[root];while(stack.length){const dir=stack.pop();let e=[];try{e=readdirSync(dir,{withFileTypes:true});}catch(error){if(error.code==='ENOENT'&&dir===root)continue;throw error;}for(const x of e){const p=join(dir,x.name);if(x.isDirectory())stack.push(p);else if(x.isFile())out.push(p)}}return out;}
function pick(files,pats,n=2){return files.filter(f=>pats.some(p=>f.toLowerCase().includes(p.toLowerCase()))).slice(0,n);}
function relative(file){return file.replaceAll('\\','/').slice(MODS_ROOT.length+1);}
async function tryBridge(cmd,file,opts={}){
  const abs=resolve(file);
  if(!existsSync(abs)) return {file:relative(file),command:cmd,status:'failed',parseStatus:'failed',code:'FILE_NOT_FOUND'};
  try{const r=await runBridge({command:cmd,filePath:abs,allowedRoots:[MODS_ROOT,GAME_ROOT],oodleRuntimeRoot:GAME_ROOT,timeoutMs:90000,commandOptions:opts});
    const verdict=classifyNativeRead(r);
    return {file:relative(file),command:cmd,status:verdict.status,parseStatus:r.parseStatus,diag:verdict.code+':'+verdict.message.slice(0,140),hasData:r.data!=null, diagnostics:r.diagnostics.map(d=>d.code)};
  }catch(e){return {file:relative(file),command:cmd,status:'failed',parseStatus:'failed',error:String(e).slice(0,300)};}
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
  const plan=families.map(fam=>({...fam,samples:pick(files,fam.pats,fam.n)}));
  const rows=[],expected=plan.flatMap(fam=>fam.samples.map(file=>`${fam.label}|${fam.cmd}|${relative(file)}`)),processed=[];
  for(const fam of plan){
    const samples=fam.samples;
    if(!samples.length){rows.push({family:fam.label,file:'(no sample)',command:fam.cmd,status:'not_run',parseStatus:'no-sample'});continue;}
    for(const s of samples){
      const r=await tryBridge(fam.cmd,s);
      processed.push(`${fam.label}|${r.command}|${r.file}`);
      rows.push({family:fam.label, ...r});
      console.log(`[${fam.label}] ${r.file} :: ${r.command} -> ${r.parseStatus} ${r.diag||r.error||''}`);
    }
  }
  console.log('\n=== SUMMARY ===');
  for(const r of rows) console.log(`${r.family} | ${r.file} | ${r.command} | ${r.parseStatus} | ${r.diag||r.error||''}`);
  const failed=rows.filter(r=>r.status==='failed');
  console.log(`\nTotal: ${rows.length}, Failed: ${failed.length}`);
  if(failed.length){console.log('FAILED:');for(const f of failed) console.log(` - ${f.family} ${f.file} ${f.command} ${f.diag||f.error}`);}
  const coverage=verifyFileCoverage(expected,processed);
  const summary=summarizeNativeReads([...rows,...(!coverage.ok?[{family:'input-output coverage',status:'failed'}]:[])]);
  console.log(JSON.stringify({...summary,gate:'verify-map-action-open',scannedFiles:files.length,coverage,rows},null,2));
  process.exitCode = summary.status==='failed'?1:0;
}
main().finally(()=>disposeBridgeDaemonPool()).catch(e=>{console.error(JSON.stringify({ok:false,status:'failed',gate:'verify-map-action-open',error:String(e)},null,2));process.exitCode=1;});
