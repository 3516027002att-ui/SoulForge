import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

async function buildEnvironment(platform, initial) {
  const source = await readFile(new URL('./prepare-electron-sqlite-binding.mjs', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('prepare-electron-sqlite-binding.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const environments = [];
  const flagFunctions = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'buildEnv' && node.initializer) environments.push(node.initializer);
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'appendFlag') flagFunctions.push(node);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(environments.length, 1, 'the actual rebuild must declare one build environment');
  assert.equal(flagFunctions.length, 1, 'the actual linker flag helper must be present');
  const buildRoot = resolve('task/native/electron-rebuild');
  const env = vm.runInNewContext(flagFunctions[0].getText(ast) + '\n(' + environments[0].getText(ast) + ')', {
    process: { env: initial, platform }, buildRoot, resolve
  });
  return { env, buildRoot };
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
  const initial = { USERPROFILE: 'unwritable-profile', HOME: 'preserved-home', PATH: 'preserved-path', CL: '/O1 /bRePrO', LINK: '/debug' };
  const before = { ...initial };
  const { env, buildRoot } = await buildEnvironment('win32', initial);
  assert.equal(env.USERPROFILE, resolve(buildRoot, 'home'));
  assert.equal(env.HOME, initial.HOME);
  assert.equal(env.npm_config_cache, resolve(buildRoot, 'cache/npm'));
  assert.equal(env.electron_config_cache, resolve(buildRoot, 'cache/electron'));
  assert.equal(env.CL, '/O1 /bRePrO');
  assert.equal(env.LINK, '/debug /Brepro');
  assert.equal(env.PATH, initial.PATH);
  assert.deepEqual(initial, before);
});
