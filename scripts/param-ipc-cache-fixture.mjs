import { build } from 'esbuild';
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

/** The actual PARAM handlers; only native transport/settled commit/Electron are seams.
 * Footer exposes the real cache reference solely inside this owned test bundle.
 */
export async function createParamCacheFixture({ fileCount = 1, rows = 1, bytesPerRow = 4 } = {}) {
  const runRoot = resolve(process.env.SF_PARAM_CACHE_RUN_ROOT ?? 'output/param-cache-fixtures');
  await mkdir(runRoot, { recursive: true });
  const root = await mkdtemp(join(runRoot, 'sf-param-cache-'));
  const key = Symbol.for(`sf.param-cache.${root}`);
  const core = resolve('packages/core/dist/index.js');
  const shared = resolve('packages/shared/dist/index.js');
  const state = { handlers: new Map(), refreshObservations: [], committed: true, reads: 0, revision: 0 };
  globalThis[key] = state;
  const keySource = JSON.stringify(Symbol.keyFor(key));
  const files = Array.from({ length: fileCount }, (_, index) => ({
    sourceUri: `file://param/cache-${index}.param`, absolutePath: `/owned/cache-${index}.param`,
    relativePath: `cache-${index}.param`, resourceKind: 'param', sha256: 'a'.repeat(64)
  }));
  state.native = async (input) => {
    state.reads += 1;
    const values = Array.from({ length: rows }, (_, rowIndex) => {
      const seed = createHash('sha256').update(`${input.filePath}:${state.revision}:${rowIndex}`).digest();
      const bytes = Buffer.alloc(bytesPerRow);
      for (let offset = 0; offset < bytes.length; offset += seed.length) seed.copy(bytes, offset);
      return { rowIndex, id: rowIndex, name: `revision-${state.revision}`, dataHash: seed.toString('hex'),
        dataBase64: bytes.toString('base64') };
    });
    return { parseStatus: 'confirmed', diagnostics: [], data: { sourceHash: `hash-${state.revision}`,
      typeName: 'FIXTURE_UNKNOWN_PARAM', rowCount: values.length, rowDataSize: bytesPerRow, rows: values } };
  };
  const output = join(root, 'param.mjs');
  const handlerPath = 'apps/desktop/src/main/ipc/param.ts';
  const handlerSource = process.env.SF_PARAM_CACHE_SOURCE_REF
    ? execFileSync('git', ['show', `${process.env.SF_PARAM_CACHE_SOURCE_REF}:${handlerPath}`], { encoding: 'utf8' })
    : await readFile(handlerPath, 'utf8');
  state.sourceBinding = { sourceRef: process.env.SF_PARAM_CACHE_SOURCE_REF ?? null,
    handlerSha256: createHash('sha256').update(handlerSource).digest('hex') };
  await build({ entryPoints: [resolve('apps/desktop/src/main/ipc/param.ts')], outfile: output,
    bundle: true, platform: 'node', format: 'esm', external: ['node:*'],
    footer: { js: `globalThis[Symbol.for(${keySource})].caches={paramAllCache,paramPageCache,sessionBindings,containerParamAllCache,containerParamSessionCache};` },
    plugins: [{ name: 'param-cache-seams', setup(builder) {
      builder.onLoad({ filter: /\/ipc\/param\.ts$/ }, () => ({ contents: handlerSource, loader: 'ts', resolveDir: resolve('apps/desktop/src/main/ipc') }));
      builder.onResolve({ filter: /^\// }, (args) => args.path === core ? { path: core, external: true } : undefined);
      builder.onResolve({ filter: /^@soulforge\/core$/ }, () => ({ path: 'fixture-core', namespace: 'fixture' }));
      builder.onResolve({ filter: /^@soulforge\/shared$/ }, () => ({ path: shared, external: true }));
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'fixture-electron', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ loader: 'js', contents: path === 'fixture-electron'
        ? 'export const dialog={showSaveDialog:async()=>({canceled:true})};'
        : `export * from ${JSON.stringify(core)};
           const state=()=>globalThis[Symbol.for(${keySource})];
           export const runBridge=input=>state().native(input);
           export async function applyNativeMutation(){const s=state();if(!s.committed)return {status:'failed',result:{ok:false,diagnostics:[]}};s.revision++;return {status:'committed',result:{ok:true,operationId:'owned-op',diagnostics:[]}};}` }));
    } }] });
  state.sourceBinding.bundleSha256 = createHash('sha256').update(await readFile(output)).digest('hex');
  const module = await import(pathToFileURL(output).href);
  const session = { meta: { workspaceId: 'owned' }, layers: { overlayRoot: '/owned' } };
  module.registerParamIpcHandlers({
    handle: (name, handler) => state.handlers.set(name, handler), activeSession: session,
    indexedFiles: files, activeWorkspaceSessionId: 'owned',
    durableStoragePaths: () => ({ root: '/owned', stagingRoot: '/owned/staging' }),
    verifiedReadRoots: async () => ({ allowedRoots: ['/owned'], diagnostics: [] }),
    verifiedStageRoots: async () => ({ allowedRoots: ['/owned'], writableRoots: ['/owned/staging'], diagnostics: [] }),
    rejectNonSekiroNativeWrite: () => null, ensureActiveOperationLog: async () => ({}),
    electronConfirmationPort: () => ({}), sessionCommitPort: () => ({}),
    toSaveResultFromOutcome: (outcome) => outcome.result,
    refreshActiveIndexAfterNativeWrite: async () => {
      state.refreshObservations.push({
        allDocuments: state.caches.paramAllCache.size, pageDocuments: state.caches.paramPageCache.size,
        retainedRows: [...state.caches.paramAllCache.values()].reduce((sum, doc) => sum + doc.rows.length, 0)
      });
      if (state.refreshFailure) throw new Error('controlled refresh failure');
    }
  });
  const event = { sender: { id: 17 } };
  const { loadFirstPartyParamMetadata } = await import(pathToFileURL(core).href);
  const definition = loadFirstPartyParamMetadata().package.definitions.find(({ document }) => document.typeName === 'ACTION_GUIDE_PARAM_ST').document;
  return { state, files, module,
    readAll: (file = files[0]) => state.handlers.get('resource.readParamPage')(event, file.sourceUri, 0, 100, undefined, true),
    write: (file = files[0]) => state.handlers.get('resource.applyParamMutation')(event, file.sourceUri, file.sha256,
      { kind: 'upsert', id: 0, dataBase64: 'AAAAAA==' }),
    writeField: (file = files[0]) => state.handlers.get('resource.applyParamFieldMutation')(event, file.sourceUri, file.sha256,
      { rowId: 0, fieldId: definition.fields[0].id, value: 1,
        rowDataBase64: Buffer.alloc(definition.rowDataSize).toString('base64'), definition }),
    dispose: async () => { delete globalThis[key]; await rm(root, { recursive: true, force: true }); }
  };
}
