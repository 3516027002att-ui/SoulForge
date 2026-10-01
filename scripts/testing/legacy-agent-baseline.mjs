/** Explicit comparison fixture only. Never loaded by production Agent entries. */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import paths from 'node:path';
import {pathToFileURL} from 'node:url';
const {dirname,join}=paths;
const exec=promisify(execFile);
export const LEGACY_AGENT_BASELINE='217234bb97ee20e3a83048042c4a1e67e9a16d33';
export const LEGACY_AGENT_CONTROLS=Object.freeze({
 'historical-217':Object.freeze({id:'historical-217',revision:LEGACY_AGENT_BASELINE,loopSha256:'064fb0b01a017c55ba58a9081dd9cfbbab1d0685bf4bad21626bc77aff12515d',lineage:'Original selected local pre-cutover control; exact source currently unavailable after filesystem replacement.'}),
 'public-main-c4':Object.freeze({id:'public-main-c4',revision:'c4a8b158f935c35624f132850b068a8e02921f68',loopSha256:'1475f0faeefc6eb8b67972691e3182fb7f0eed954dd7965c868688ed8f9fc4a4',modelServicesTree:'fe0b4d1cf8e81807c3a5a788f5c90315e4da2ecf',lineage:'Explicit alternative public pre-refactor main control; distinct from the lost historical-217 control.'})
});
const sha=value=>createHash('sha256').update(value).digest('hex');
export function selectLegacyAgentControl(id='historical-217'){
 const control=Object.hasOwn(LEGACY_AGENT_CONTROLS,id)?LEGACY_AGENT_CONTROLS[id]:undefined;
 if(!control)throw Object.assign(new Error('Select a declared exact Agent experiment control.'),{code:'AGENT_EXPERIMENT_CONTROL_INVALID'});
 return control;
}
export async function inspectLegacyAgentControl(repoRoot,id){
 const control=selectLegacyAgentControl(id);
 const [{stdout:source},{stdout:tree}]=await Promise.all([
  exec('git',['show',`${control.revision}:packages/core/src/model-services/agentLoop.ts`],{cwd:repoRoot,maxBuffer:8388608}),
  exec('git',['rev-parse',`${control.revision}:packages/core/src/model-services`],{cwd:repoRoot})
 ]);
 if(sha(source)!==control.loopSha256||control.modelServicesTree&&tree.trim()!==control.modelServicesTree)throw Object.assign(new Error('Selected control source does not match its exact revision/hash contract.'),{code:'AGENT_EXPERIMENT_BASELINE_DRIFT'});
 return {control:{...control,modelServicesTree:tree.trim()},source};
}
/** Git identifiers use slashes; filesystem locators use the caller's platform. */
export function resolveLegacySnapshotImport(repoRoot,sourcePath,specifier,pathOps=paths){
 const sourceTarget=pathOps.resolve(repoRoot,pathOps.dirname(sourcePath),specifier);
 const gitTarget=pathOps.relative(repoRoot,sourceTarget).split(pathOps.sep).join('/').replace(/\.js$/,'.ts');
 if(gitTarget.startsWith('packages/core/src/model-services/')&&gitTarget.endsWith('.ts'))return {snapshotPath:gitTarget};
 const coreRelative=pathOps.relative(pathOps.join(repoRoot,'packages','core','src'),sourceTarget);
 const inCore=coreRelative!=='..'&&!coreRelative.startsWith(`..${pathOps.sep}`)&&!pathOps.isAbsolute(coreRelative);
 return {runtimePath:inCore?pathOps.resolve(repoRoot,'packages','core','dist',coreRelative):sourceTarget};
}
export async function materializeLegacyAgentBaseline(repoRoot,outputRoot,revision=LEGACY_AGENT_BASELINE,options={}){
 const selected=selectLegacyAgentControl(options.control??Object.values(LEGACY_AGENT_CONTROLS).find(control=>control.revision===revision)?.id);
 if(revision!==selected.revision)throw Object.assign(new Error('Snapshot revision and selected control must agree.'),{code:'AGENT_EXPERIMENT_CONTROL_REVISION_MISMATCH'});
 let control;
 try{({control}=await inspectLegacyAgentControl(repoRoot,selected.id));}
 catch(cause){if(typeof cause?.code==='string'&&cause.code.startsWith('AGENT_EXPERIMENT_'))throw cause;throw Object.assign(new Error(`Explicit legacy comparison baseline unavailable: ${revision}`,{cause}),{code:'AGENT_COMPARISON_BASELINE_UNAVAILABLE'});}
 const require=createRequire(join(repoRoot,'package.json'));
 const ts=require('typescript'),files=new Map();
 const sha=value=>createHash('sha256').update(value).digest('hex');
 async function materialize(path){
  if(files.has(path))return files.get(path).output;
  let stdout;
  try{({stdout}=await exec('git',['show',`${revision}:${path}`],{cwd:repoRoot,maxBuffer:8388608}));}
  catch(cause){throw Object.assign(new Error(`Explicit legacy comparison baseline unavailable: ${revision}`,{cause}),{code:'AGENT_COMPARISON_BASELINE_UNAVAILABLE'});}
  const output=join(outputRoot,path.replace(/\.ts$/,'.mjs'));
  const originalSha256=sha(stdout);
  const transformed=options.sourceTransform?.(path,stdout);
  if(transformed)stdout=transformed.source;
  files.set(path,{path,sha256:originalSha256,materializedSha256:sha(stdout),...(transformed?.treatment?{treatment:transformed.treatment}:{}),output});
  let js=ts.transpileModule(stdout,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext},fileName:path}).outputText;
  for(const specifier of new Set([...js.matchAll(/\bfrom\s+(['"])([^'"]+)\1/g)].map(match=>match[2]))){
   if(!specifier.startsWith('.')){
    if(!specifier.startsWith('node:'))js=js.replaceAll(`'${specifier}'`,JSON.stringify(pathToFileURL(require.resolve(specifier)).href)).replaceAll(`"${specifier}"`,JSON.stringify(pathToFileURL(require.resolve(specifier)).href));
    continue;
   }
   const imported=resolveLegacySnapshotImport(repoRoot,path,specifier);
   const target=imported.snapshotPath?await materialize(imported.snapshotPath):imported.runtimePath;
   js=js.replaceAll(`'${specifier}'`,JSON.stringify(pathToFileURL(target).href)).replaceAll(`"${specifier}"`,JSON.stringify(pathToFileURL(target).href));
  }
  await mkdir(dirname(output),{recursive:true});await writeFile(output,js);return output;
 }
 const entry=await materialize('packages/core/src/model-services/agentSessionHost.ts');
 const manifest={revision,control,entry,transpilerVersion:ts.version,files:[...files.values()]};
 await mkdir(outputRoot,{recursive:true});await writeFile(join(outputRoot,'baseline-manifest.json'),JSON.stringify(manifest,null,2));
 return {manifest,...await import(pathToFileURL(entry).href)};
}
