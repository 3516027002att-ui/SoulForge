import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createParamCacheFixture } from './param-ipc-cache-fixture.mjs';

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
