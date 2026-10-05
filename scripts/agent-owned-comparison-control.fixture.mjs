/** Exercise the real comparison entry with source-only ports, never native/provider execution. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const exec=promisify(execFile),entry=resolve('scripts/agent-owned-corpus-comparison.fixture.mjs');

async function withPorts(run){
 const root=await mkdtemp(join(tmpdir(),'sf-owned-control-entry-'));
 const loader=join(root,'ports # loader.mjs'),runtime=pathToFileURL(resolve('scripts/testing/owned-native-agent-comparison.mjs')).href;
 const identity=pathToFileURL(resolve('scripts/testing/legacy-agent-baseline.mjs')).href;
 const source=`import {selectLegacyAgentControl} from ${JSON.stringify(identity)};
 import {writeFile} from 'node:fs/promises';
 export function createOwnedNativeComparisonRuntime(options){const control=selectLegacyAgentControl(options.control);return {OUT:${JSON.stringify(root)},LEGACY:control.revision,TARGET:{},worker:async(kernel,scenario)=>console.log(JSON.stringify({controlId:control.id,revision:control.revision,kernel,scenario})),prepare:async()=>({status:'unavailable',code:'NATIVE_FIXTURE_MISSING',controlId:control.id,baselineRevision:control.revision}),save:async(path,value)=>writeFile(path,JSON.stringify(value))};}`;
 await writeFile(loader,`import {registerHooks} from 'node:module';globalThis.fetch=()=>{throw new Error('No network in comparison selection test');};registerHooks({load(url,context,next){return url===${JSON.stringify(runtime)}?{format:'module',shortCircuit:true,source:${JSON.stringify(source)}}:next(url,context);}});`);
 try{await run({root,invoke:args=>exec(process.execPath,['--import',pathToFileURL(loader).href,entry,...args],{cwd:process.cwd(),timeout:5000})});}
 finally{await rm(root,{recursive:true,force:true});}
}

test('owned comparison entry explicitly selects public control and preserves the historical default',async()=>{
 await withPorts(async({invoke})=>{
  const selected=JSON.parse((await invoke(['--control','public-main-c4','--owned-worker','legacy','read-only'])).stdout);
  assert.equal(selected.controlId,'public-main-c4');assert.equal(selected.revision,'c4a8b158f935c35624f132850b068a8e02921f68');assert.equal(selected.kernel,'legacy');
  const defaults=JSON.parse((await invoke(['--owned-worker','finite','read-only'])).stdout);
  assert.equal(defaults.controlId,'historical-217');assert.equal(defaults.revision,'217234bb97ee20e3a83048042c4a1e67e9a16d33');
 });
});

test('owned comparison preparation keeps missing native inputs distinct from the selected control',async()=>{
 await withPorts(async({root,invoke})=>{
  await invoke(['--control','public-main-c4','--prepare-only']);
  const prepared=JSON.parse(await readFile(join(root,'preparation.json'),'utf8'));
  assert.equal(prepared.status,'unavailable');assert.equal(prepared.code,'NATIVE_FIXTURE_MISSING');assert.equal(prepared.controlId,'public-main-c4');
 });
});

test('documented direct comparison command reports an unavailable native leg without pretending it passed',async()=>{
 await withPorts(async({root,invoke})=>{
  const result=await invoke(['--control','public-main-c4']);
  const report=JSON.parse(await readFile(join(root,'comparison-report.json'),'utf8'));
  assert.equal(report.status,'unavailable');assert.equal(report.controlId,'public-main-c4');
  assert.match(result.stdout,/Native corpus\/oracle\/runtime unavailable/);
 });
});

test('owned comparison rejects unknown, missing and conflicting explicit control selectors before worker dispatch',async()=>{
 await withPorts(async({invoke})=>{
  for(const args of [['--control','HEAD'],['--control'],['--control=public-main-c4'],['--control','public-main-c4','--control','historical-217']]){
   await assert.rejects(()=>invoke([...args,'--owned-worker','legacy','read-only']),error=>error.code!==0&&error.stderr.includes('AGENT_EXPERIMENT_CONTROL_INVALID')&&!error.stdout.includes('controlId'));
  }
 });
});

test('child control flags roundtrip the exact catalog identity instead of falling back to missing history',async()=>{
 const {legacyAgentControlArguments,selectLegacyAgentControlFromArguments}=await import('./testing/legacy-agent-baseline.mjs');
 assert.equal(typeof legacyAgentControlArguments,'function');assert.equal(typeof selectLegacyAgentControlFromArguments,'function');
 for(const id of ['public-main-c4','historical-217']){
  const argv=['--import','owned-loader','owned-entry',...legacyAgentControlArguments(id),'--owned-worker','finite','read-only'];
  assert.equal(selectLegacyAgentControlFromArguments(argv).id,id);
 }
});
