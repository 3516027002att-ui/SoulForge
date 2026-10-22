import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const script=fileURLToPath(new URL('./verify-ai-tool-write-path-gate.mjs',import.meta.url));
const productRoot=dirname(dirname(script));
const gateSource=readFileSync(script,'utf8');
const controlled=[...gateSource.match(/const CONTROLLED_ENTRIES = Object.freeze\(\[([\s\S]*?)\]\)/)[1].matchAll(/^\s*'([^']+)'/gm)].map(match=>match[1]);
function fixture(body,facade=readFileSync(join(productRoot,'packages/core/src/editing/taeEdit.ts'),'utf8')){
 const root=mkdtempSync(join(tmpdir(),'sf-ai-write-boundary-'));
 try{
  const base=join(root,'packages/core/src');mkdirSync(join(base,'ai/tools'),{recursive:true});mkdirSync(join(base,'editing'),{recursive:true});
  writeFileSync(join(base,'ai/toolRegistry.ts'),'export const composition=true;');
  writeFileSync(join(base,'ai/tools/insert_tae_events.ts'),body);
  writeFileSync(join(base,'editing/taeEdit.ts'),facade);
  writeFileSync(join(base,'editing/other.ts'),controlled.filter(name=>name!=='insertTaeEvents').map(name=>`export function ${name}(){}`).join('\n'));
  const result=spawnSync(process.execPath,[script,'--root',root],{encoding:'utf8'});
  return {status:result.status,report:JSON.parse((result.status===0?result.stdout:result.stderr).trim())};
 }finally{rmSync(root,{recursive:true,force:true});}
}
test('actual insertion declaration remains recognized at its real native transaction facade',()=>{
 const result=fixture(readFileSync(join(productRoot,'packages/core/src/ai/tools/insert_tae_events.ts'),'utf8'));
 assert.equal(result.status,0,JSON.stringify(result.report));
});
test('a write tool and an insertion facade cannot hide direct disk writes behind controlled names',()=>{
 const badTool=fixture("export const tool={name:'unsafe',permission:'commit',run:()=>{writeFile('mod','bad');insertTaeEvents({});}};");
 assert.equal(badTool.status,1);assert.ok(badTool.report.findings.some(f=>f.code==='AI_TOOL_DIRECT_DISK_WRITE'));
 const badFacade=fixture(readFileSync(join(productRoot,'packages/core/src/ai/tools/insert_tae_events.ts'),'utf8'),'export function insertTaeEvents(){writeFile("mod","bad");}');
 assert.equal(badFacade.status,1);assert.ok(badFacade.report.findings.some(f=>f.code==='CONTROLLED_INSERTION_PATH_INVALID'));
});
