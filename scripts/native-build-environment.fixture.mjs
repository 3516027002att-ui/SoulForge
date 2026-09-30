import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

test('Electron rebuild directs per-task native caches into its isolated build home', async () => {
  const source = await readFile(new URL('./prepare-electron-sqlite-binding.mjs', import.meta.url), 'utf8');
  const envBlock = source.match(/const buildEnv = \{([\s\S]*?)\n  \};/)[1];
  const buildRoot = resolve('task/native/electron-rebuild');
  const initial = { HOME: '/unwritable-user-home', PATH: 'preserved-path' };
  const env = vm.runInNewContext(`({${envBlock}})`, {
    process: { env: initial, platform: 'linux' },
    buildRoot, resolve, appendFlag: (value, flag) => [value, flag].filter(Boolean).join(' ')
  });
  assert.equal(env.HOME, resolve(buildRoot, 'home'));
  assert.equal(env.npm_config_cache, resolve(buildRoot, 'cache/npm'));
  assert.equal(env.electron_config_cache, resolve(buildRoot, 'cache/electron'));
  assert.equal(env.LINK, undefined, 'Windows linker flags must not replace the Linux linker command');
  assert.equal(env.CL, undefined);
  assert.equal(env.PATH, initial.PATH);
  assert.equal(initial.HOME, '/unwritable-user-home');
});
