import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

async function buildEnvironment(platform, initial, options = {}) {
  const source = await readFile(new URL('./prepare-electron-sqlite-binding.mjs', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('prepare-electron-sqlite-binding.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const environments = [];
  const flagFunctions = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'buildEnv' && node.initializer) environments.push(node.initializer);
    if (ts.isFunctionDeclaration(node) && ['appendFlag', 'createWindowsRebuildEnvironment'].includes(node.name?.text)) flagFunctions.push(node);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(environments.length, 1, 'the actual rebuild must declare one build environment');
  assert.ok(flagFunctions.some(node => node.name.text === 'appendFlag'), 'the actual linker flag helper must be present');
  const buildRoot = resolve('task/native/electron-rebuild');
  const nodeExecutable = resolve('owned-runtime/node.exe');
  const pythonExecutable = Object.hasOwn(options, 'pythonExecutable') ? options.pythonExecutable : resolve('owned-toolchain/python.exe');
  const env = vm.runInNewContext(flagFunctions.map(node=>node.getText(ast)).join('\n') + '\n(' + environments[0].getText(ast) + ')', {
    process: { env: initial, platform, execPath:nodeExecutable }, buildRoot, resolve, dirname, join, pythonExecutable
  });
  return { env, buildRoot, nodeExecutable, pythonExecutable };
}

test('Electron rebuild directs per-task native caches into its isolated build home', async () => {
  const initial = { HOME: '/unwritable-user-home', PATH: 'preserved-path' };
  const { env, buildRoot } = await buildEnvironment('linux', initial);
  assert.equal(env.HOME, resolve(buildRoot, 'home'));
  assert.equal(env.npm_config_cache, resolve(buildRoot, 'cache/npm'));
  assert.equal(env.electron_config_cache, resolve(buildRoot, 'cache/electron'));
  assert.equal(env.LINK, undefined, 'Windows linker flags must not replace the Linux linker command');
  assert.equal(env.CL, undefined);
  assert.equal(env.PATH, initial.PATH);
  assert.equal(initial.HOME, '/unwritable-user-home');
});

test('Windows rebuild isolates its user profile and preserves existing deterministic compiler flags', async () => {
  const initial = { SystemRoot:resolve('owned-system/Windows'), USERPROFILE: 'unwritable-profile', HOME: 'preserved-home', PATH: 'preserved-path', CL: '/O1 /bRePrO', LINK: '/debug' };
  const before = { ...initial };
  const { env, buildRoot, nodeExecutable, pythonExecutable } = await buildEnvironment('win32', initial);
  assert.equal(env.USERPROFILE, resolve(buildRoot, 'home'));
  assert.equal(env.HOME, initial.HOME);
  assert.equal(env.npm_config_cache, resolve(buildRoot, 'cache/npm'));
  assert.equal(env.electron_config_cache, resolve(buildRoot, 'cache/electron'));
  assert.equal(env.CL, '/O1 /bRePrO');
  assert.equal(env.LINK, '/debug /Brepro');
  assert.ok(env.PATH.split(';').includes(dirname(nodeExecutable)), 'MSBuild copy_builtin_sqlite3 must resolve the actual Node runtime');
  assert.equal(env.NODE_GYP_FORCE_PYTHON, pythonExecutable, 'node-gyp must use the Python resolved before the owned PATH is bounded');
  assert.deepEqual(initial, before);
});

test('owned Windows rebuild bounds duplicate/oversized PATH without changing caller or selected toolchain', async () => {
  const initial = Object.freeze({ systemroot:resolve('owned-system/Windows'),
    PATH:'npm-bin;'.repeat(1_000),Path:'other-npm-bin;'.repeat(1_000),
    __vscmd_preinit_path:'previous-shell;'.repeat(1_000),
    CL:'/O2',LINK:'/debug',INCLUDE:'selected-include',LIB:'selected-lib',
    VCToolsVersion:'selected-msvc',WindowsSDKVersion:'selected-sdk',
    npm_config_python:'operator-selected-python',SOULFORGE_OWNED_TEMP_TEST_MARKER:'owned-output' });
  const before={...initial};
  const {env,nodeExecutable}=await buildEnvironment('win32',initial);
  const paths=Object.keys(env).filter(key=>key.toUpperCase()==='PATH');
  assert.equal(paths.length,1,'Windows must receive one case-insensitive PATH');
  assert.ok(env[paths[0]].length<1_000,'leave room for MSBuild/cmd toolchain expansions');
  assert.ok(env[paths[0]].split(';').includes(dirname(nodeExecutable)));
  assert.ok(env[paths[0]].split(';').includes(join(initial.systemroot,'System32/WindowsPowerShell/v1.0')),
    'owned process job supervision must remain available');
  assert.ok(!Object.keys(env).some(key=>key.toUpperCase()==='__VSCMD_PREINIT_PATH'));
  for(const key of ['INCLUDE','LIB','VCToolsVersion','WindowsSDKVersion','npm_config_python','SOULFORGE_OWNED_TEMP_TEST_MARKER'])assert.equal(env[key],initial[key]);
  assert.deepEqual(initial,before);
});

test('missing Windows system root fails closed before launching a native rebuild', async () => {
  await assert.rejects(buildEnvironment('win32',{PATH:'caller-path'}),/ELECTRON_SQLITE_REBUILD_WINDOWS_ENV_MISSING/);
});

test('missing resolved Python cannot silently become a ready native build environment', async () => {
  await assert.rejects(buildEnvironment('win32',{SystemRoot:resolve('owned-system/Windows')},{pythonExecutable:undefined}),/ELECTRON_SQLITE_REBUILD_PYTHON_MISSING/);
});

test('Windows Python resolution uses node-gyp authority and preserves interpreter selection failures', async () => {
  const source=await readFile(new URL('./prepare-electron-sqlite-binding.mjs',import.meta.url),'utf8');
  const ast=ts.createSourceFile('prepare.mjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const resolver=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='resolveWindowsRebuildPython');
  assert.ok(resolver,'resolve the actual interpreter before bounding the compiler PATH');
  const code=ts.transpileModule(resolver.getText(ast),{fileName:'resolver.ts',compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const initial=Object.freeze({npm_config_python:'operator-selected-python',PATH:'caller-search-path'});
  const resolved=resolve('selected-python/python.exe');
  for(const refuse of [false,true]) {
    const observed=[];
    const result=vm.runInNewContext(code+'\nresolveWindowsRebuildPython()',{
      process:{env:initial},require:specifier=>{
        assert.equal(specifier,'node-gyp/lib/find-python.js');
        return {default:{findPython:configuration=>{observed.push(configuration);
          if(refuse)throw new Error('operator-selected Python rejected');return Promise.resolve(resolved);}}};
      }
    });
    if(refuse)await assert.rejects(result,/operator-selected Python rejected/);else assert.equal(await result,resolved);
    assert.deepEqual(observed,[initial.npm_config_python]);assert.equal(initial.PATH,'caller-search-path');
  }
});
