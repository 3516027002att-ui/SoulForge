/** Explicit comparison fixture only. Never loaded by production Agent entries. */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,join,relative,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const exec=promisify(execFile);
export const LEGACY_AGENT_BASELINE='217234bb97ee20e3a83048042c4a1e67e9a16d33';
export async function materializeLegacyAgentBaseline(repoRoot,outputRoot,revision=LEGACY_AGENT_BASELINE,options={}){
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
   const sourceTarget=resolve(repoRoot,dirname(path),specifier),targetPath=relative(repoRoot,sourceTarget).replace(/\.js$/,'.ts');
   const target=targetPath.startsWith('packages/core/src/model-services/')&&targetPath.endsWith('.ts')?await materialize(targetPath):sourceTarget.replace('/packages/core/src/','/packages/core/dist/');
   js=js.replaceAll(`'${specifier}'`,JSON.stringify(pathToFileURL(target).href)).replaceAll(`"${specifier}"`,JSON.stringify(pathToFileURL(target).href));
  }
  await mkdir(dirname(output),{recursive:true});await writeFile(output,js);return output;
 }
 const entry=await materialize('packages/core/src/model-services/agentSessionHost.ts');
 const manifest={revision,entry,transpilerVersion:ts.version,files:[...files.values()]};
 await mkdir(outputRoot,{recursive:true});await writeFile(join(outputRoot,'baseline-manifest.json'),JSON.stringify(manifest,null,2));
 return {manifest,...await import(pathToFileURL(entry).href)};
}
