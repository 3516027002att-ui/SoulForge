#!/usr/bin/env node
/** Structure check of THIS manual, not a test of the SoulForge repository. */
import {readFileSync,existsSync,writeFileSync,readdirSync}from 'node:fs';
import {resolve,dirname}from 'node:path';
import {fileURLToPath}from 'node:url';
import {createHash}from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>JSON.parse(readFileSync(resolve(root,p),'utf8'));
const findings=[],assert=(ok,message)=>{if(!ok)findings.push(message);};
const config=read('tasks.json'),tasks=config.tasks,byId=new Map(tasks.map(t=>[t.id,t]));
assert(tasks.length===30&&byId.size===30,'Expected 30 unique task IDs');
const expected=Array.from({length:30},(_,i)=>`SF-${String(i).padStart(2,'0')}`);
for(const id of expected)assert(byId.has(id),`Missing ${id}`);
const done=new Set(),active=new Set();
function visit(id){
 if(active.has(id)){findings.push(`Dependency cycle ${id}`);return;}
 if(done.has(id))return;
 const t=byId.get(id);if(!t){findings.push(`Unknown task ${id}`);return;}
 active.add(id);for(const dep of t.dependsOn)visit(dep);active.delete(id);done.add(id);
}
for(const t of tasks){
 visit(t.id);
 assert(existsSync(resolve(root,`tasks/${t.id}.md`)),`Missing card ${t.id}`);
 assert(existsSync(resolve(root,t.chapter)),`Missing chapter ${t.chapter}`);
 for(const ref of t.referenceAlgorithms)assert(existsSync(resolve(root,ref)),`Missing algorithm ${ref}`);
 assert(t.initialStatus.implementation==='not_started',`Product status fabricated ${t.id}`);
 assert(t.initialStatus.native==='not_run'&&t.initialStatus.product==='not_run',`Product result fabricated ${t.id}`);
 const required=read(`tasks/${t.id}.required-suites.json`);
 assert(JSON.stringify(required)===JSON.stringify(t.requiredSuites),`Suite manifest drift ${t.id}`);
 assert(required.length>0&&new Set(required).size===required.length,`Empty/duplicate suites ${t.id}`);
 assert(t.forbiddenPaths.includes('apps/desktop/src/renderer/**'),`Renderer restriction missing ${t.id}`);
 assert(![...t.allowedExistingFiles,...t.allowedNewFiles].some(p=>p.startsWith('apps/desktop/src/renderer/')),`Renderer assignment ${t.id}`);
 assert(new Set(t.allowedNewFiles).size===t.allowedNewFiles.length,`Duplicate new path ${t.id}`);
}
const accepted=read('acceptance-map.json');
assert(accepted.length===60&&new Set(accepted.map(t=>t.id)).size===60,'Expected 60 acceptance cases');
for(const t of accepted){
 assert(t.tasks.some(id=>id!=='SF-29'),`No implementation task for ${t.id}`);
 for(const id of t.tasks)assert(byId.get(id)?.reportTests.includes(t.id),`Mapping mismatch ${id}/${t.id}`);
}
const fs=read('basis/findings.json').findings;assert(fs.length===22,'Expected 22 source findings');
for(const f of fs)assert(tasks.some(t=>t.reportFindings.includes(f.id)),`Finding unmapped ${f.id}`);
const sourceIds=new Set(read('basis/source_manifest.json').map(s=>s.id));
for(const name of readdirSync(resolve(root,'chapters')).filter(x=>x.endsWith('.md'))){
 const text=readFileSync(resolve(root,'chapters',name),'utf8');
 assert((text.match(/^```/gm)??[]).length%2===0,`Unclosed fenced block ${name}`);
 for(const m of text.matchAll(/\b[FSXT]\d{2}\b/g)){
   if(m[0][0]==='F')assert(fs.some(f=>f.id===m[0]),`Unknown finding ${m[0]} in ${name}`);
   if(m[0][0]==='T')assert(accepted.some(t=>t.id===m[0]),`Unknown test ${m[0]} in ${name}`);
   if(m[0][0]==='S'||m[0][0]==='X')assert(sourceIds.has(m[0]),`Unknown source ${m[0]} in ${name}`);
 }
}
for(const name of ['ADVERSARIAL_REVIEW.md','START_HERE.md','prompt/flash-executor.md','SoulForge_Flash_Execution_Plan.md','SoulForge_Flash_Execution_Plan.html'])
 assert(existsSync(resolve(root,name)),`Missing deliverable ${name}`);
const log=readFileSync(resolve(root,'evidence/reference-tests.tap'),'utf8');
const num=key=>Number(log.match(new RegExp(`^# ${key} (\\d+)$`,'m'))?.[1]??NaN);
assert(Number.isInteger(num('tests'))&&num('tests')>0,'No observed reference tests');
assert(num('fail')===0&&num('cancelled')===0&&num('skipped')===0&&num('pass')===num('tests'),'Reference tests not all passed');
const summary={ok:findings.length===0,scope:'delivery structure + reference tests only; no SoulForge product execution',taskCount:tasks.length,findingCount:fs.length,acceptanceCaseCount:accepted.length,referenceTestCount:num('tests'),referenceTestsPassed:num('pass'),referenceTestsFailed:num('fail'),referenceTestsSkipped:num('skipped'),referenceTapSha256:createHash('sha256').update(log).digest('hex'),findings};
writeFileSync(resolve(root,'evidence/delivery-check.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary,null,2));process.exitCode=summary.ok?0:1;
