import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createParamCacheFixture } from './param-ipc-cache-fixture.mjs';

test('the actual fixture plugin loads handler and cache-capturing service for either path separator', () => {
  const source = ts.createSourceFile('param-ipc-cache-fixture.mjs', readFileSync(resolve('scripts/param-ipc-cache-fixture.mjs'), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const setups = [];
  const visit = node => {
    if (ts.isMethodDeclaration(node) && node.name.getText(source) === 'setup') setups.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(setups.length, 1, 'Exactly one actual PARAM fixture plugin setup must exist');
  const setup = setups[0];
  const loads = [];
  const actualSetup = new Function('handlerSource', 'instrumentedService', 'coreUrl', 'sharedUrl', 'keySource', 'resolve',
    `return ({ ${setup.getText(source)} }).setup;`)('actual-handler', 'actual-service-with-cache-capture', 'file://core', 'file://shared', '"owned"', resolve);
  actualSetup({ onLoad: (options, callback) => loads.push({ ...options, callback }), onResolve: () => {} });
  const loaded = path => loads.filter(load => !load.namespace && load.filter.test(path)).map(load => load.callback({ path }));
  for (const [path, expected] of [
    ['/repo/apps/desktop/src/main/ipc/param.ts', 'actual-handler'],
    [String.raw`D:\repo\apps\desktop\src\main\ipc\param.ts`, 'actual-handler'],
    ['/repo/apps/desktop/src/main/services/paramService.ts', 'actual-service-with-cache-capture'],
    [String.raw`D:\repo\apps\desktop\src\main\services\paramService.ts`, 'actual-service-with-cache-capture']
  ]) {
    const result = loaded(path);
    assert.equal(result.length, 1, path);
    assert.equal(result[0].contents, expected);
    assert.equal(result[0].loader, 'ts');
  }
  for (const path of [String.raw`D:\repo\main\services\paramOther.ts`, '/repo/main/ipc/param.ts.bak']) {
    assert.deepEqual(loaded(path), []);
  }
});

// Controlled reproduction of the Windows CI build failure. This runs esbuild
// locally; it does not claim that a Windows drive URL can execute on this host.
test('virtual exports cannot resolve a Windows drive path through a POSIX-only absolute-path filter', async () => {
  const windowsCore = String.raw`D:\a\SoulForge\SoulForge\packages\core\dist\index.js`;
  await assert.rejects(build({ stdin: { contents: 'import * as core from "fixture-core"; console.log(core);', loader: 'js' },
    write: false, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    plugins: [{ name: 'legacy-fixture-resolution-reproduction', setup(builder) {
      builder.onResolve({ filter: /^\// }, args => args.path === windowsCore ? { path: windowsCore, external: true } : undefined);
      builder.onResolve({ filter: /^fixture-core$/ }, () => ({ path: 'fixture-core', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `export * from ${JSON.stringify(windowsCore)};` }));
    } }] }), error => error.errors?.some(item => item.text.includes(`Could not resolve "${windowsCore.replaceAll('\\', '\\\\')}"`)));
});

test('the actual PARAM fixture imports Core and Shared through file URLs and reaches its behavior assertions', async () => {
  const imports = [];
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/param.mjs')) imports.push(specifier);
    return next(specifier, context);
  } });
  let fixture;
  try {
    fixture = await createParamCacheFixture();
    assert.ok(imports.includes(pathToFileURL(resolve('packages/core/dist/index.js')).href), JSON.stringify(imports));
    assert.ok(imports.includes(pathToFileURL(resolve('packages/shared/dist/index.js')).href), JSON.stringify(imports));
    assert.equal((await fixture.readAll()).ok, true);
    assert.equal(fixture.state.caches.paramAllCache.size, 1);
    assert.equal((await fixture.write()).ok, true);
    assert.equal((await fixture.readAll()).sourceHash, 'hash-1');
  } finally {
    hooks.deregister();
    if (fixture) await fixture.dispose();
  }
});
