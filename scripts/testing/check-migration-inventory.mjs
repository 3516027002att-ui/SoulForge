/** One-time migration inventory, never a required registration file or gate. */
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadWorkspaces,resolveScriptEntries} from '../verify/scriptGraph.mjs';
import {discoverChecks} from '../verify/checkRegistry.mjs';
const [baselinePath,outputPath]=process.argv.slice(2);
if(!baselinePath||!outputPath)throw new Error('Usage: node scripts/testing/check-migration-inventory.mjs BASELINE_CHECKOUT OUTPUT_JSON');
const root=process.cwd(),baseline=resolve(baselinePath),oldWorkspaces=loadWorkspaces(baseline),current=loadWorkspaces(root);
const {TIER_BY_SCRIPT}=await import(pathToFileURL(resolve(baseline,'scripts/verify/tiers.mjs')).href);
const discovered=discoverChecks(root,current);
const retiredEntrypoints={
 'test:required-validation':'Retired registration completeness gate; check discovers files and independently records required checks/tail execution (check.fixture.mjs).',
 'verify:audit':'Retired manual tiers registration audit; check --audit reports discovered plans without treating registration as product behavior.',
 'test:gov-cli':'Retired governance CLI; owner decision #49 replaces claim/seal workflow with direct issue, architecture and actual checks.',
 'test:orphan-smoke-gate':'Retired manual smoke registration gate; conventional smoke discovery has positive and missing-output negative fixtures.',
 'test:smoke-temp-cleanup':'Old repository-wide residue gate replaced by owned temporary lifecycle/cancellation/dead-owner recovery tests.',
 'test:probe-residual-gate':'Old residual-file gate replaced by ownership at producers; unknown historic files are preserved.',
 'test:stale-tfm-gate':'Old stale-output gate replaced by build output ownership, target framework selection and actual builds.',
 'test:audit-sf-29-unit':'Deleted aggregate wrapper over earlier audit unit suites; each earlier entry is discovered independently. Actual execution still requires runner evidence.',
 'test:audit-sf-29-native':'Deleted aggregate wrapper over earlier audit native suites; each earlier entry is discovered independently. Missing corpus is not a pass.'
};
const sources=entry=>entry.steps.filter(step=>step.kind==='test').map(step=>({command:step.command,args:step.args,cwd:relative(root,step.cwd)}));
const sourcePath=path=>relative(root,path).replaceAll('\\','/').replace(/^(packages\/[^/]+)\/dist\/(.*)\.js$/,'$1/src/$2.ts');
const entrySources=new Map([...discovered.values()].map(entry=>[entry.scriptName,[...new Set([
 ...(entry.source?[entry.source]:[]),
 ...entry.steps.flatMap(step=>step.args.filter(arg=>typeof arg==='string'&&/\.(?:mjs|cjs|js|tsx?)$/.test(arg)&&!arg.startsWith('-')).map(arg=>sourcePath(resolve(step.cwd,arg))))
])]]));
const rows=Object.keys(TIER_BY_SCRIPT).map(name=>{
 const old=resolveScriptEntries(baseline,oldWorkspaces,name);
 const oldSources=old.entryFiles.map(file=>relative(baseline,file).replaceAll('\\','/'));
 const equivalents=[...discovered.values()].filter(entry=>entry.scriptName===name||oldSources.some(source=>entrySources.get(entry.scriptName).includes(source)));
 const matchedSources=oldSources.filter(source=>equivalents.some(entry=>entrySources.get(entry.scriptName).includes(source)));
 const retired=/governance|handoff|scope|deferral|freeze|seal|freshness|artifact.*claim|verify-summary|entrypoint-audit|temp.*residue|script.*delegation|mission1-(?:a0|a1|hourly)/.test(name);
 const retainedEntry=current.rootScripts[name]!==undefined;
 return {oldName:name,oldTier:TIER_BY_SCRIPT[name],oldSources,matchedSources,unmatchedSources:oldSources.filter(source=>!matchedSources.includes(source)),unresolved:old.unresolved,
  disposition:equivalents.length?'retained-or-discovered':retainedEntry?'retained-entry-not-discovered-check':retiredEntrypoints[name]?'retired-with-explicit-replacement':retired?'retired-governance-review':'requires-semantic-mapping',
  ...(retainedEntry?{currentEntry:current.rootScripts[name]}:{}),
  ...(retiredEntrypoints[name]?{reason:retiredEntrypoints[name]}:{}),
  candidates:equivalents.map(entry=>({name:entry.scriptName,tier:entry.tier,origin:entry.origin,operations:sources(entry)})),
  executionEvidence:'Static mapping only. Bind separate actual runner reports; reachability does not prove execution.'};
});
const report={schema:'one-time-check-migration-inventory-v1',baseline,root,
 oldRootScripts:Object.keys(oldWorkspaces.rootScripts).length,currentRootScripts:Object.keys(current.rootScripts).length,
 oldRegistered:rows.length,currentDiscovered:discovered.size,rows,
 current:[...discovered.values()].map(entry=>({name:entry.scriptName,tier:entry.tier,origin:entry.origin,operations:sources(entry)})),
 limitation:'The old full actual execution list is unavailable. No equivalence or complete acceptance is inferred from this static map.'};
await writeFile(resolve(outputPath),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({oldRegistered:rows.length,currentDiscovered:discovered.size,dispositions:rows.reduce((out,row)=>(out[row.disposition]=(out[row.disposition]??0)+1,out),{}),output:resolve(outputPath)}));
