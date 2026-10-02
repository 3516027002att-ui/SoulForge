import { build } from 'esbuild';
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

/** The actual PARAM adapter/service; only native transport/settled commit/Electron are seams.
 * Cache references are exposed solely inside this owned test bundle, at their
 * actual factory scope. Production services have no test exports.
 */
export async function createParamCacheFixture({ fileCount = 1, rows = 1, bytesPerRow = 4, container = false } = {}) {
  const runRoot = resolve(process.env.SF_PARAM_CACHE_RUN_ROOT ?? 'output/param-cache-fixtures');
  await mkdir(runRoot, { recursive: true });
  const root = await mkdtemp(join(runRoot, 'sf-param-cache-'));
  const key = Symbol.for(`sf.param-cache.${root}`);
  const coreUrl = pathToFileURL(resolve('packages/core/dist/index.js')).href;
  const sharedUrl = pathToFileURL(resolve('packages/shared/dist/index.js')).href;
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
  const servicePath = 'apps/desktop/src/main/services/paramService.ts';
  const serviceSource = handlerSource.includes('createParamService')
    ? (process.env.SF_PARAM_CACHE_SOURCE_REF
      ? execFileSync('git', ['show', `${process.env.SF_PARAM_CACHE_SOURCE_REF}:${servicePath}`], { encoding: 'utf8' })
      : await readFile(servicePath, 'utf8'))
    : null;
  const captureCaches = `globalThis[Symbol.for(${keySource})].caches={paramAllCache,paramPageCache,sessionBindings,containerParamAllCache,containerParamSessionCache,paramEntryTableCache,unpackedParamCache};`;
  let instrumentedService = serviceSource;
  if (serviceSource !== null) {
    const parsed = ts.createSourceFile(servicePath, serviceSource, ts.ScriptTarget.Latest, true);
    const factory = parsed.statements.find(statement => ts.isFunctionDeclaration(statement)
      && statement.name?.text === 'createParamService');
    const returned = factory?.body?.statements.findLast(ts.isReturnStatement);
    if (!returned) throw new Error('PARAM_CACHE_FIXTURE_SERVICE_RETURN_MISSING');
    const offset = returned.getStart(parsed);
    instrumentedService = serviceSource.slice(0, offset) + captureCaches + '\n' + serviceSource.slice(offset);
  }
  state.sourceBinding = { sourceRef: process.env.SF_PARAM_CACHE_SOURCE_REF ?? null,
    handlerSha256: createHash('sha256').update(handlerSource).digest('hex'),
    serviceSha256: serviceSource === null ? null : createHash('sha256').update(serviceSource).digest('hex') };
  await build({ entryPoints: [resolve('apps/desktop/src/main/ipc/param.ts')], outfile: output,
    bundle: true, platform: 'node', format: 'esm', external: ['node:*'],
    footer: { js: serviceSource === null ? captureCaches : '' },
    plugins: [{ name: 'param-cache-seams', setup(builder) {
      builder.onLoad({ filter: /\/ipc\/param\.ts$/ }, () => ({ contents: handlerSource, loader: 'ts', resolveDir: resolve('apps/desktop/src/main/ipc') }));
      if (instrumentedService !== null) builder.onLoad({ filter: /\/services\/paramService\.ts$/ }, () => ({ contents: instrumentedService,
        loader: 'ts', resolveDir: resolve('apps/desktop/src/main/services') }));
      builder.onResolve({ filter: /^file:/ }, (args) => args.path === coreUrl ? { path: coreUrl, external: true } : undefined);
      builder.onResolve({ filter: /^@soulforge\/core$/ }, () => ({ path: 'fixture-core', namespace: 'fixture' }));
      builder.onResolve({ filter: /^@soulforge\/shared$/ }, () => ({ path: sharedUrl, external: true }));
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'fixture-electron', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ loader: 'js', contents: path === 'fixture-electron'
        ? 'export const dialog={showSaveDialog:async()=>({canceled:true})};'
        : `export * from ${JSON.stringify(coreUrl)};
           const state=()=>globalThis[Symbol.for(${keySource})];
           export const runBridge=input=>state().native(input);
           export async function applyNativeMutation(){const s=state();if(!s.committed)return {status:'failed',result:{ok:false,diagnostics:[]}};s.revision++;return {status:'committed',result:{ok:true,operationId:'owned-op',diagnostics:[]}};}` }));
    } }] });
  state.sourceBinding.bundleSha256 = createHash('sha256').update(await readFile(output)).digest('hex');
  const module = await import(pathToFileURL(output).href);
  const ownedRoot = container ? root : '/owned';
  const session = { meta: { workspaceId: 'owned' }, layers: { overlayRoot: ownedRoot } };
  if (container) files[0].absolutePath = join(root, 'owned.parambnd.dcx');
  module.registerParamIpcHandlers({
    handle: (name, handler) => state.handlers.set(name, handler), activeSession: session,
    indexedFiles: files, activeWorkspaceSessionId: 'owned',
    durableStoragePaths: () => ({ root: ownedRoot, stagingRoot: join(ownedRoot, 'staging') }),
    bridgeRootSession: () => ({ overlayRoot: ownedRoot, baseRoot: null, storageRoot: ownedRoot }),
    bridgeRootsDiagnostic: (code, result) => ({ severity: 'error', code, message: result.message }),
    sha256FileNow: async () => { throw new Error('unexpected full source hash'); },
    verifiedReadRoots: async () => ({ allowedRoots: [ownedRoot], diagnostics: [] }),
    verifiedStageRoots: async () => ({ allowedRoots: [ownedRoot], writableRoots: [join(ownedRoot, 'staging')], diagnostics: [] }),
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
  const { loadFirstPartyParamMetadata } = await import(coreUrl);
  const definition = loadFirstPartyParamMetadata().package.definitions.find(({ document }) => document.typeName === 'ACTION_GUIDE_PARAM_ST').document;
  return { state, files, module, root, definition,
    invoke: (name, ...args) => state.handlers.get(name)(event, ...args),
    readAll: (file = files[0]) => state.handlers.get('resource.readParamPage')(event, file.sourceUri, 0, 100, undefined, true),
    write: (file = files[0]) => state.handlers.get('resource.applyParamMutation')(event, file.sourceUri, file.sha256,
      { kind: 'upsert', id: 0, dataBase64: 'AAAAAA==' }),
    writeField: (file = files[0]) => state.handlers.get('resource.applyParamFieldMutation')(event, file.sourceUri, file.sha256,
      { rowId: 0, fieldId: definition.fields[0].id, value: 1,
        rowDataBase64: Buffer.alloc(definition.rowDataSize).toString('base64'), definition }),
    dispose: async () => { delete globalThis[key]; await rm(root, { recursive: true, force: true }); }
  };
}
