import assert from 'node:assert/strict';
import fs from 'node:fs';
import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const adapterPath = resolve('apps/desktop/src/main/ipc/operations.ts'), servicePath = resolve('apps/desktop/src/main/services/operationService.ts'), symbol = Symbol.for('sf.operation-domain');
const gate = () => { let entered, release; return { entered: new Promise(done => { entered = done; }), promise: new Promise(done => { release = done; }), start: () => entered(), release: () => release() }; };
async function harness(run) {
    const root = await mkdtemp(join(tmpdir(), 'sf-operation-domain-')), physical = join(root, 'owned.lua'), sourceUri = 'file://owned/scripts/owned.lua';
    const operation = { opId: 'owned-op', title: 'Owned operation', status: 'committed', files: [{ targetUri: sourceUri, absolutePath: physical }] };
    const state = { root, physical, sourceUri, operation, session: { meta: { workspaceId: 'owned-a' }, layers: { overlayRoot: root } }, files: [{ absolutePath: physical, relativePath: 'scripts/owned.lua', sourceUri, sourcePath: physical }], handlers: new Map(), confirmations: [], native: [], refresh: [], confirmation: { receiptId: 'owned-confirmation' }, confirmGate: null, nativeGate: null, nativeThrows: false, nativeOk: true, restored: true, history: [], generation: 1 };
    globalThis[symbol] = state;
    try {
        const output = join(root, 'operations.mjs'), entry = join(root, 'entry.ts'), sharedUrl = pathToFileURL(resolve('packages/shared/dist/index.js')).href;
        await writeFile(entry, `export * from ${JSON.stringify(adapterPath)};${fs.existsSync(servicePath) ? `export {createOperationService} from ${JSON.stringify(servicePath)};` : ''}`);
        await build({ entryPoints: [entry], outfile: output, bundle: true, format: 'esm', platform: 'node', external: ['node:*'], plugins: [{ name: 'owned-rollback-ports', setup(b) {
                        b.onResolve({ filter: /^@soulforge\/core$/ }, () => ({ path: 'operation-core', namespace: 'fixture' }));
                        b.onLoad({ filter: /operation-core/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `const s=()=>globalThis[Symbol.for('sf.operation-domain')];async function rollback(kind,input){const state=s();state.native.push([kind,input]);if(state.nativeGate){const pending=state.nativeGate;state.nativeGate=null;pending.start();await pending.promise;}if(state.nativeThrows)throw new Error('OWNED_NATIVE_FAILURE');return {ok:state.nativeOk,opId:input.opId,inverseOpId:state.nativeOk?'owned-inverse':undefined,restoredFiles:state.nativeOk&&state.restored?[state.physical]:[],diagnostics:[]};}export const rollbackOperation=input=>rollback('operation',input);export const rollbackFile=input=>rollback('file',input);` }));
                        b.onResolve({ filter: /^@soulforge\/shared$/ }, () => ({ path: sharedUrl, external: true }));
                    } }] });
        const module = await import(pathToFileURL(output).href), store = { get: async () => state.operation, history: async () => state.history };
        state.store = store;
        const deps = { handle: (name, callback) => state.handlers.set(name, callback), get activeSession() { return state.session; }, get activeOperationLog() { return state.store; }, get activeWorkspaceSessionGeneration() { return state.generation; }, get indexedFiles() { return state.files; }, durableStoragePaths: workspaceId => ({ root, backupBaseDir: join(root, 'backup'), recoveryDir: join(root, 'recovery'), stagingRoot: join(root, 'stage') }), requestWriteConfirmation: async (input) => {
                state.confirmations.push(input);
                if (state.confirmGate) {
                    const pending = state.confirmGate;
                    state.confirmGate = null;
                    pending.start();
                    await pending.promise;
                }
                return state.confirmation;
            }, refreshActiveIndexAfterNativeWrite: async (paths, carrier) => { state.refresh.push([paths, carrier]); carrier.knowledgeRefresh = { status: 'refreshed', marker: 'owned' }; } };
        module.registerOperationIpcHandlers(deps);
        const event = id => ({ sender: { id } });
        await run({ root, state, module, deps, store, event, invoke: (channel, id, ...args) => state.handlers.get(channel)(event(id), ...args) });
    }
    finally {
        delete globalThis[symbol];
        await rm(root, { recursive: true, force: true });
    }
}
const applicationPorts = h => ({ getActiveSession: () => h.state.session, getActiveOperationLog: () => h.state.store, getIndexedFiles: () => h.state.files, getActiveWorkspaceSessionGeneration: () => h.state.generation, durableStoragePaths: h.deps.durableStoragePaths, refreshActiveIndexAfterNativeWrite: h.deps.refreshActiveIndexAfterNativeWrite });
export { harness, applicationPorts, gate };
