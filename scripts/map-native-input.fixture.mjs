import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { withSmokeWorkspace } from '../packages/core/dist/testing/harness/smokeWorkspace.js';
import { resolveNativeFixture } from '../packages/core/dist/testing/nativeFixtureRegistry.js';
import { classifyOutcome } from './verify/runner.mjs';

const require = createRequire(import.meta.url);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const keys = ['SOULFORGE_SEKIRO_GAME_ROOT', 'SOULFORGE_GAME_ROOT', 'SOULFORGE_OODLE_RUNTIME_ROOT',
  'SOULFORGE_NATIVE_FIXTURE_REGISTRY', 'SOULFORGE_NATIVE_FIXTURE_ROOT'];
const sourceRef = process.env.MAP_SMOKE_FIXTURE_SOURCE_REF;
if (sourceRef && !/^[a-f0-9]{7,40}$/u.test(sourceRef)) throw new Error('Invalid fixture source revision');

async function inspectSmoke(name, { env = {}, args = [], inputRoot }) {
  const sourcePath = `packages/core/src/testing/run${name}Smoke.ts`;
  const source = sourceRef
    ? execFileSync('git', ['show', `${sourceRef}:${sourcePath}`], { cwd:repoRoot, encoding:'utf8' })
    : await fs.readFile(join(repoRoot, sourcePath), 'utf8');
  const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  // Invoke the exported function ourselves while retaining its actual body and
  // imports. The standalone URL guard is verified by the compiled entry run.
  const moduleSource = ast.statements.filter(node => !(ts.isIfStatement(node) && node.getText(ast).includes('import.meta.url')))
    .map(node => node.getFullText(ast)).join('\n');
  const built = ts.transpileModule(moduleSource, {fileName:sourcePath, reportDiagnostics:true,
    compilerOptions:{target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.CommonJS}});
  assert.deepEqual((built.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error), []);
  const logs = [], roots = [], opened = [], commits = [];
  let nativeCalls = 0;
  const allowed = path => {
    const rel = relative(inputRoot, path);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  const promises = {...fs,
    realpath: path => {assert.ok(allowed(path), 'smoke must not probe undeclared private inputs');return fs.realpath(path);},
    copyFile: (source, target) => {
      assert.ok(allowed(source), 'only the declared fixture may be copied');
      assert.ok(roots.some(root => {const rel = relative(root, target);return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);}),
        'the resource copy belongs to this invocation');
      return fs.copyFile(source, target);
    }
  };
  const native = {
    openWorkspaceSession: async input => {opened.push(input);return {meta:{workspaceId:'fixture'},layers:input};},
    MemoryOperationLogStore: class {},
    nativeEditSessionFromContext: input => ({...input,allowedRoots:()=>[input.session.layers.overlayRoot],
      commitPort:{commit:async request=>{commits.push(request);throw new Error('unexpected negative-fixture commit');}}}),
    loadMapDocument: async (_session, path) => {
      nativeCalls++;
      assert.equal(await fs.readFile(path, 'utf8'), 'explicit-native-input-boundary-fixture');
      throw new Error('fixture native read failed');
    },
    mintNativeEditReceipt: () => {throw new Error('unexpected receipt');}
  };
  const exports = {};
  vm.runInNewContext(built.outputText, {exports,module:{exports},Buffer,
    process:{argv:[process.execPath, sourcePath, ...args],env, pid:process.pid,cwd:()=>inputRoot},
    console:{log:value=>logs.push(String(value)),error:value=>logs.push(String(value))},
    require: specifier => {
      if (specifier === 'node:fs/promises') return promises;
      if (specifier.startsWith('node:')) return require(specifier);
      if (specifier.endsWith('/smokeWorkspace.js')) return {withSmokeWorkspace:(label, body)=>withSmokeWorkspace(label, workspace=>{roots.push(workspace.root);return body(workspace);})};
      if (specifier.endsWith('/nativeFixtureRegistry.js')) return {resolveNativeFixture};
      return native;
    }
  }, {filename:sourcePath});
  const before = Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  for (const key of keys) {if (env[key] === undefined) delete process.env[key];else process.env[key] = env[key];}
  let error;
  try {await exports[`run${name}Smoke`]();} catch (value) {error=value;}
  finally {for (const key of keys) {if (before[key] === undefined) delete process.env[key];else process.env[key]=before[key];}}
  return {logs, roots, opened, commits, nativeCalls, error};
}

async function withInput(body) {
  const root = await fs.mkdtemp(join(tmpdir(), 'sf-map-input-fixture-'));
  try {await body(root);} finally {await fs.rm(root,{recursive:true,force:true});}
}

test('atomic commit observations delegate to the existing Patch Engine port and preserve its refusal', async()=>{
  const sourcePath='packages/core/src/testing/runMapTransactionAtomicSmoke.ts';
  const source=sourceRef?execFileSync('git',['show',`${sourceRef}:${sourcePath}`],{cwd:repoRoot,encoding:'utf8'})
    :await fs.readFile(join(repoRoot,sourcePath),'utf8');
  const ast=ts.createSourceFile(sourcePath,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  let declaration,assignment;
  function visit(node) {
    if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text==='patchCommit')declaration=node;
    if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken
      &&node.left.getText(ast)==='editSession.commitPort')assignment=node;
    ts.forEachChild(node,visit);
  }
  visit(ast);
  assert.ok(declaration&&assignment,'the actual smoke must observe the real host commit port');
  const observed=[],port={marker:'Patch Engine',commit:async function(request){
    assert.equal(this.marker,'Patch Engine');observed.push(request);
    if(request.refuse)throw Object.assign(new Error('Patch Engine refused'),{code:'PATCH_BOUNDARY_REFUSED'});
    return {ok:true,fixtureReceipt:'delegated'};
  }};
  const code=`let commitCount=0;const ${declaration.getText(ast)};${assignment.getText(ast)};({commit:editSession.commitPort.commit,count:()=>commitCount})`;
  const compiled=ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const actual=vm.runInNewContext(compiled,{editSession:{commitPort:port}});
  const accepted={newContentBase64:'Zml4dHVyZQ==',expectedHash:'fixed',file:{sourceUri:'file://map/owned.msb'}};
  assert.deepEqual(await actual.commit(accepted),{ok:true,fixtureReceipt:'delegated'});
  assert.equal(observed[0],accepted);assert.equal(actual.count(),1);
  await assert.rejects(actual.commit({refuse:true}),{code:'PATCH_BOUNDARY_REFUSED'});assert.equal(actual.count(),2);
});

for (const name of ['MapTransactionAtomic', 'NativeMapRollback']) {
  test(`${name}: omitted and missing explicit inputs are unavailable, with zero native calls or workspace allocations`, ()=>withInput(async root=>{
    for (const input of [{}, {args:[join(root,'missing.msb.dcx')]}, {env:{SOULFORGE_SEKIRO_GAME_ROOT:join(root,'missing-game')}}]) {
      const run=await inspectSmoke(name,{...input,inputRoot:root});
      assert.equal(run.error,undefined);
      const report=JSON.parse(run.logs.join('\n'));
      assert.equal(report.ok,false);assert.equal(report.status,'skipped');assert.equal(report.executed,false);
      assert.equal(report.authority,'unverified');assert.match(report.code,/^NATIVE_MAP_(INPUT_REQUIRED|SOURCE_UNAVAILABLE)$/u);
      assert.equal(classifyOutcome(0,run.logs.join('\n')).outcome,'skipped');
      assert.equal(run.nativeCalls,0);assert.deepEqual(run.roots,[]);assert.deepEqual(run.commits,[]);
    }
  }));

  test(`${name}: explicit environment input is copied to a unique owned overlay and cleanup survives native failure`, ()=>withInput(async root=>{
    const source=join(root,'mods/map/mapstudio/m10_00_00_00.msb.dcx');
    await fs.mkdir(dirname(source),{recursive:true});await fs.writeFile(source,'explicit-native-input-boundary-fixture');
    const predecessor=join(root,`.tmp-mission4-map-rollback-${process.pid}`);
    await fs.mkdir(predecessor);await fs.writeFile(join(predecessor,'unowned'),'preserve');
    const runs=[];
    for (let i=0;i<2;i++) {
      const run=await inspectSmoke(name,{inputRoot:root,env:{SOULFORGE_SEKIRO_GAME_ROOT:root}});runs.push(run);
      assert.match(run.error?.message??'',/fixture native read failed/);
      assert.equal(run.nativeCalls,1);assert.equal(run.roots.length,1);assert.equal(run.opened.length,1);
      assert.equal(run.opened[0].overlayRoot,run.roots[0]);assert.deepEqual(run.commits,[]);
      assert.equal(await fs.readFile(source,'utf8'),'explicit-native-input-boundary-fixture');
      assert.equal(await fs.readFile(join(predecessor,'unowned'),'utf8'),'preserve');
      await assert.rejects(fs.access(run.roots[0]),{code:'ENOENT'});
    }
    assert.notEqual(runs[0].roots[0],runs[1].roots[0]);
  }));

  test(`${name}: registry hash and ownership boundaries fail closed before a resource is copied`, ()=>withInput(async root=>{
    const source=join(root,'source.msb.dcx'),outside=join(root,'outside.msb.dcx'),corpus=join(root,'corpus');
    await fs.writeFile(source,'explicit-native-input-boundary-fixture');await fs.copyFile(source,outside);await fs.mkdir(corpus);
    const inside=join(corpus,'source.msb.dcx');await fs.copyFile(source,inside);
    const hash=createHash('sha256').update(await fs.readFile(inside)).digest('hex');
    const registry=join(root,'registry.json');
    const env={SOULFORGE_NATIVE_FIXTURE_REGISTRY:registry,SOULFORGE_NATIVE_FIXTURE_ROOT:corpus};
    for (const [entry,expected] of [
      [{localPath:'source.msb.dcx',sha256:'0'.repeat(64)},/NATIVE_FIXTURE_HASH_MISMATCH/],
      [{localPath:'../outside.msb.dcx',sha256:hash},/NATIVE_FIXTURE_OUTSIDE_ROOT/]
    ]) {
      await fs.writeFile(registry,JSON.stringify({schemaVersion:'1.0.0',fixtures:[{fixtureId:'fixture',testRole:'msb-primary',...entry}]}));
      const run=await inspectSmoke(name,{inputRoot:root,env});
      assert.match(run.error?.message??'',expected);assert.equal(run.nativeCalls,0);assert.deepEqual(run.roots,[]);
    }
    await fs.writeFile(registry,JSON.stringify({schemaVersion:'1.0.0',fixtures:[{fixtureId:'fixture',testRole:'msb-primary',localPath:'source.msb.dcx',sha256:hash}]}));
    const available=await inspectSmoke(name,{inputRoot:root,env});
    assert.match(available.error?.message??'',/fixture native read failed/);assert.equal(available.nativeCalls,1);
    await assert.rejects(fs.access(available.roots[0]),{code:'ENOENT'});
    for (const invalidEnv of [{SOULFORGE_NATIVE_FIXTURE_ROOT:corpus},{SOULFORGE_NATIVE_FIXTURE_REGISTRY:registry}]) {
      const run=await inspectSmoke(name,{inputRoot:root,env:invalidEnv});
      assert.match(run.error?.message??'',/NATIVE_FIXTURE_CONFIG_INCOMPLETE/);assert.deepEqual(run.roots,[]);assert.equal(run.nativeCalls,0);
    }
  }));
}
