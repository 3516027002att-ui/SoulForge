import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { resolveNativeFixture } from '../../packages/core/dist/testing/nativeFixtureRegistry.js';
import { withSmokeWorkspace } from '../../packages/core/dist/testing/harness/smokeWorkspace.js';
import { classifyOutcome } from '../verify/runner.mjs';

const require = createRequire(import.meta.url);
const sourcePath = join(dirname(fileURLToPath(import.meta.url)), 'verify-param-session-projection.mjs');
const envKeys = ['SOULFORGE_SEKIRO_GAME_ROOT', 'SOULFORGE_OODLE_RUNTIME_ROOT',
  'SOULFORGE_NATIVE_FIXTURE_REGISTRY', 'SOULFORGE_NATIVE_FIXTURE_ROOT'];
const hash = value => createHash('sha256').update(value).digest('hex');
const sourceBytes = Buffer.from('explicit-param-binder-input-fixture');
const leafBytes = Buffer.from('extracted-leaf-boundary-fixture');
const entry = {index:7, name:'N:\\param\\ActionGuideParam.param', contentHash:hash(leafBytes)};

async function inspect({inputRoot, env = {}, args = [], entries = [
  {index:1, name:'OtherParam.param', contentHash:hash('other')}, entry
], failExtract = false, unsafeCas = false, badReceipt = false}) {
  const source = await fs.readFile(sourcePath, 'utf8');
  const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const body = ast.statements.filter(node => !(
    (ts.isIfStatement(node) && node.getText(ast).includes('import.meta.url'))
    || (ts.isExpressionStatement(node) && node.getText(ast).startsWith('main().catch'))
  )).map(node=>node.getFullText(ast)).join('\n')
    + '\nmodule.exports.invoke = typeof verifyParamSessionProjection === "function" ? verifyParamSessionProjection : main;';
  const built = ts.transpileModule(body, {fileName:sourcePath.replace(/\.mjs$/u, '.ts'),
    compilerOptions:{allowJs:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}});
  const logs = [], calls = [], roots = [];
  let disposals = 0;
  const inside = (root,path) => {const rel=relative(root,path);return rel===''||(!rel.startsWith('..')&&!isAbsolute(rel));};
  const rows = Array.from({length:5}, (_,rowIndex)=>({rowIndex,id:rowIndex+100,
    // End in zero so the negative CAS check must change the hash rather than
    // accidentally asking for the original hash.
    dataHash:String(rowIndex+1).repeat(63)+'0',dataBase64:null}));
  const bridge = {
    disposeBridgeDaemonPool: async()=>{disposals++;},
    runBridge: async request=>{
      calls.push(request);
      assert.ok(roots.some(root=>inside(root,request.filePath)), 'Bridge only reads the owned copy/staging');
      if(request.command==='list-bnd4-entries') {
        assert.deepEqual(await fs.readFile(request.filePath),sourceBytes);
        return {parseStatus:'partial',diagnostics:[],data:{sourceHash:hash(sourceBytes),entries}};
      }
      if(request.command==='extract-bnd4-child') {
        if(failExtract) return {parseStatus:'failed',diagnostics:[{code:'FIXTURE_NATIVE_EXTRACT_REFUSED'}]};
        assert.equal(request.commandOptions.entryIndex,7, 'selection follows native name/index inventory, not index 1');
        assert.ok(request.writableRoots?.some(root=>inside(root,request.commandOptions.outputPath)), 'Bridge owns staging extraction');
        await fs.writeFile(request.commandOptions.outputPath,leafBytes);
        return {parseStatus:'partial',diagnostics:[],data:{...entry,sourceHash:hash(sourceBytes),
          ...(badReceipt?{contentHash:hash('wrong')}:{}),outputPath:request.commandOptions.outputPath}};
      }
      if(request.command==='snapshot-bnd4-child') {
        return {parseStatus:'partial',diagnostics:[],data:{contentBase64:leafBytes.toString('base64')}};
      }
      assert.equal(request.command,'read-param-document');
      const options=request.commandOptions;
      if(options.documentSession?.endsWith('dead'))return {parseStatus:'failed',diagnostics:[{code:'PARAM_DOCUMENT_SESSION_EXPIRED'}]};
      if(!options.documentSession)return {parseStatus:'partial',diagnostics:[],data:{sessionToken:'fixture-session',rowCount:5,rows}};
      const selected=options.rowSelections.map(selection=>rows[selection.rowIndex]);
      const mismatch=options.rowSelections.some((selection,i)=>!selected[i]
        ||selected[i].id!==selection.expectedId||selected[i].dataHash!==selection.expectedDataHash);
      if(mismatch&&!unsafeCas)return {parseStatus:'failed',diagnostics:[{code:'PARAM_ROW_IDENTITY_MISMATCH'}]};
      return {parseStatus:'partial',diagnostics:[],data:{rows:selected.filter(Boolean).map(row=>({...row,dataBase64:leafBytes.toString('base64')}))}};
    }
  };
  const exports = {};
  vm.runInNewContext(built.outputText,{exports,module:{exports},Buffer,
    process:{argv:[process.execPath,sourcePath,...args],env,cwd:()=>inputRoot},
    console:{log:value=>logs.push(String(value)),error:value=>logs.push(String(value))},
    require:specifier=>{
      if(specifier==='node:fs')return {existsSync:path=>{assert.ok(inside(inputRoot,path),'undeclared private resource probe');return false;}};
      if(specifier==='node:fs/promises')return {...fs,
        realpath:path=>{assert.ok(inside(inputRoot,path),'undeclared private resource probe');return fs.realpath(path);},
        copyFile:(source,target)=>{assert.ok(inside(inputRoot,source),'only explicit input may be copied');
          assert.ok(roots.some(root=>inside(root,target)),'copy target belongs to this invocation');return fs.copyFile(source,target);}};
      if(specifier.startsWith('node:'))return require(specifier);
      if(specifier.endsWith('/nativeFixtureRegistry.js'))return {resolveNativeFixture};
      if(specifier.endsWith('/smokeWorkspace.js'))return {withSmokeWorkspace:(label,fn)=>withSmokeWorkspace(label,workspace=>{roots.push(workspace.root);return fn(workspace);})};
      if(specifier.endsWith('/runBridge.js'))return bridge;
      throw new Error(`Unexpected fixture import ${specifier}`);
    }
  },{filename:sourcePath});
  const previous=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
  for(const key of envKeys){if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key];}
  let error;
  try{await exports.invoke();}catch(value){error=value;}
  finally{for(const key of envKeys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}}
  for(const root of roots)await assert.rejects(fs.access(root),{code:'ENOENT'});
  return {logs,calls,roots,error,disposals};
}

async function withInput(fn) {
  const root=await fs.mkdtemp(join(tmpdir(),'sf-param-input-fixture-'));
  const source=join(root,'mods/param/gameparam/gameparam.parambnd.dcx');
  try{await fs.mkdir(dirname(source),{recursive:true});await fs.writeFile(source,sourceBytes);await fn(root,source);}
  finally{await fs.rm(root,{recursive:true,force:true});}
}

test('omitted/missing PARAM binder input is unavailable without private probes or native calls',()=>withInput(async root=>{
  for(const input of [{},{args:[join(root,'missing.parambnd.dcx')]},{env:{SOULFORGE_SEKIRO_GAME_ROOT:join(root,'missing-game')}}]) {
    const run=await inspect({inputRoot:root,...input});assert.equal(run.error,undefined);
    const report=run.logs.map(line=>{try{return JSON.parse(line);}catch{return null;}}).find(value=>value?.code);
    assert.equal(report.ok,false);assert.equal(report.status,'skipped');assert.equal(report.executed,false);assert.equal(report.authority,'unverified');
    assert.match(report.code,/^NATIVE_PARAM_(INPUT_REQUIRED|SOURCE_UNAVAILABLE)$/u);
    assert.equal(classifyOutcome(0,run.logs.join('\n')).outcome,'skipped');assert.deepEqual(run.calls,[]);assert.deepEqual(run.roots,[]);
  }
}));

test('invalid, hash-mismatched, outside-root and incomplete registry configurations fail closed',()=>withInput(async(root,source)=>{
  const registry=join(root,'registry.json'),corpus=join(root,'corpus');await fs.mkdir(corpus);await fs.copyFile(source,join(corpus,'game.parambnd.dcx'));
  const env={SOULFORGE_NATIVE_FIXTURE_REGISTRY:registry,SOULFORGE_NATIVE_FIXTURE_ROOT:corpus};
  for(const [body,code] of [
    ['broken JSON',/NATIVE_FIXTURE_REGISTRY_INVALID/],
    [JSON.stringify({schemaVersion:'1.0.0',fixtures:[{fixtureId:'param',testRole:'param-primary',localPath:'game.parambnd.dcx',sha256:'0'.repeat(64)}]}),/NATIVE_FIXTURE_HASH_MISMATCH/],
    [JSON.stringify({schemaVersion:'1.0.0',fixtures:[{fixtureId:'param',testRole:'param-primary',localPath:source,sha256:hash(sourceBytes)}]}),/NATIVE_FIXTURE_OUTSIDE_ROOT/]
  ]) {
    await fs.writeFile(registry,body);const run=await inspect({inputRoot:root,env});
    assert.match(run.error?.message??'',code);assert.deepEqual(run.calls,[]);assert.deepEqual(run.roots,[]);
  }
  for(const env of [{SOULFORGE_NATIVE_FIXTURE_REGISTRY:registry},{SOULFORGE_NATIVE_FIXTURE_ROOT:corpus}]) {
    const run=await inspect({inputRoot:root,env});assert.match(run.error?.message??'',/NATIVE_FIXTURE_CONFIG_INCOMPLETE/);assert.deepEqual(run.roots,[]);
  }
}));

test('PARAM leaf input is rejected before native binder inventory',()=>withInput(async(root,source)=>{
  const leaf=join(root,'ActionGuideParam.param');await fs.copyFile(source,leaf);
  const run=await inspect({inputRoot:root,args:[leaf]});assert.match(run.error?.message??'',/PARAM_BINDER_INPUT_REQUIRED/);assert.deepEqual(run.calls,[]);
}));

test('missing or ambiguous native child identity cannot silently select entry index 1',()=>withInput(async(root,source)=>{
  for(const entries of [[{index:1,name:'OtherParam.param',contentHash:hash('other')}],[entry,{...entry,index:9,name:'Other\\ActionGuideParam.param'}]]) {
    const run=await inspect({inputRoot:root,args:[source],entries});assert.match(run.error?.message??'',/PARAM_CHILD_IDENTITY_NOT_UNIQUE/);
    assert.equal(run.calls.length,1);assert.equal(run.calls[0].command,'list-bnd4-entries');assert.equal(run.disposals,1);
  }
}));

test('declared env/registry/argv inputs use unique owned copies and preserve the original on extraction failure',()=>withInput(async(root,source)=>{
  const registry=join(root,'registry.json');await fs.writeFile(registry,JSON.stringify({schemaVersion:'1.0.0',fixtures:[
    {fixtureId:'param',testRole:'param-primary',localPath:relative(root,source),sha256:hash(sourceBytes)}]}));
  const runs=[];
  for(const input of [{args:[source]},{env:{SOULFORGE_SEKIRO_GAME_ROOT:root}},
    {env:{SOULFORGE_NATIVE_FIXTURE_REGISTRY:registry,SOULFORGE_NATIVE_FIXTURE_ROOT:root}}]) {
    const run=await inspect({inputRoot:root,...input,failExtract:true});runs.push(run);
    assert.match(run.error?.message??'',/FIXTURE_NATIVE_EXTRACT_REFUSED/);assert.equal(run.roots.length,1);assert.equal(run.disposals,1);
    assert.equal(run.calls[1].commandOptions.entryIndex,7);assert.deepEqual(await fs.readFile(source),sourceBytes);
  }
  assert.equal(new Set(runs.map(run=>run.roots[0])).size,3);
}));

test('the actual verifier retains seven projection/session/CAS checks and rejects unsafe native results',()=>withInput(async(root,source)=>{
  const good=await inspect({inputRoot:root,args:[source]});assert.equal(good.error,undefined);
  const report=good.logs.map(line=>{try{return JSON.parse(line);}catch{return null;}}).find(value=>value?.checks);
  assert.equal(report.checks,7);assert.equal(report.ok,true);assert.equal(report.executed,true);assert.equal(report.status,'passed');
  const unsafe=await inspect({inputRoot:root,args:[source],unsafeCas:true});assert.match(unsafe.error?.message??'',/Test4 FAIL/);
  const changed=await inspect({inputRoot:root,args:[source],badReceipt:true});assert.match(changed.error?.message??'',/PARAM_CHILD_IDENTITY_MISMATCH/);
}));
