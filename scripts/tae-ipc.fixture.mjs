import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { registerHooks } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

test('production TAE IPC defaults to a bounded animation page while retaining the native total and explicit page controls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-tae-ipc-'));
  const output = join(root, 'action-ipc.mjs'); const moduleUrl = pathToFileURL(output).href;
  const calls = [];
  globalThis[Symbol.for('sf.tae.ipc.fixture')] = async input => {
    calls.push(input);
    return { parseStatus: 'partial', diagnostics: [], data: { format: 'TAE', authority: 'first-party', sourceHash: 'native', animationCount: 2219, animationsTruncated: true, animations: [], eventTypes: [] } };
  };
  await build({ entryPoints: [resolve('apps/desktop/src/main/ipc/action.ts')], outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external', external: ['@soulforge/core', '@soulforge/shared'] });
  const coreUrl = pathToFileURL(resolve('packages/core/dist/index.js')).href;
  const hooks = registerHooks({
    resolve(specifier, context, next) { if (specifier === '@soulforge/core' && context.parentURL === moduleUrl) return { url: 'sf:tae-ipc-core', shortCircuit: true };
      return next(specifier, context.parentURL === moduleUrl && !specifier.startsWith('.') && !specifier.includes(':') ? { ...context, parentURL: import.meta.url } : context); },
    load(url, context, next) { return url === 'sf:tae-ipc-core' ? { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(coreUrl)}; export async function runBridge(input) { return globalThis[Symbol.for('sf.tae.ipc.fixture')](input); }` } : next(url, context); }
  });
  try {
    const { registerActionIpcHandlers } = await import(moduleUrl);
    const handlers = new Map(); const sourceUri = 'file://chr/c0000.anibnd.dcx';
    registerActionIpcHandlers({ handle: (name, fn) => handlers.set(name, fn), indexedFiles: [{ sourceUri, absolutePath: join(root, 'c0000.anibnd.dcx'), relativePath: 'chr/c0000.anibnd.dcx' }], activeSession: null, activeIndex: null, verifiedReadRoots: async () => ({ allowedRoots: [root], diagnostics: [] }) });
    const handler = handlers.get('resource.readTaeDocument');
    const initial = await handler({}, sourceUri);
    assert.ok(calls[0], JSON.stringify(initial));
    assert.deepEqual(calls[0].commandOptions, { animationPage: 0, animationPageSize: 64 });
    assert.equal(initial.data.animationCount, 2219, 'bounded output retains the independent native total');
    await handler({}, sourceUri, { animationPage: 3, animationPageSize: 20 });
    assert.deepEqual(calls[1].commandOptions, { animationPage: 3, animationPageSize: 20 });
  } finally { hooks.deregister(); delete globalThis[Symbol.for('sf.tae.ipc.fixture')]; await rm(root, { recursive: true, force: true }); }
});
