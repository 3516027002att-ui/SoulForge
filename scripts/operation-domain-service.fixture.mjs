// Actual operation application/transport controls; native authority is not claimed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, resolve, join, relative, sep } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { harness, applicationPorts, gate } from './testing/operationDomainHarness.mjs';
const adapterPath = resolve('apps/desktop/src/main/ipc/operations.ts'), servicePath = resolve('apps/desktop/src/main/services/operationService.ts');
test('operation history/rollback orchestration lives below trusted confirmation transport', () => { assert.equal(fs.existsSync(servicePath), true, 'operation application service must exist'); assert.doesNotMatch(fs.readFileSync(servicePath, 'utf8'), /IpcMainInvokeEvent|TrustedIpcHandle|from ['"]electron|event:|_event/); assert.doesNotMatch(fs.readFileSync(adapterPath, 'utf8'), /await rollbackOperation\(|await rollbackFile\(|activeRollbackRequests =|\.filter\(\(entry\)/); });
test('three existing operation channels retain registration order', () => harness(async (h) => assert.deepEqual([...h.state.handlers.keys()], ['operation.list', 'operation.rollback', 'operation.rollbackFile'])));
test('absent session/log refuses rollback before confirmation/native work', () => harness(async (h) => {
    h.state.session = null;
    assert.deepEqual(await h.invoke('operation.list', 1), []);
    for (const [channel, args] of [['operation.rollback', ['owned-op']], ['operation.rollbackFile', ['owned-op', h.state.sourceUri]]]) {
        const result = await h.invoke(channel, 1, ...args);
        assert.equal(result.diagnostics[0].code, 'WORKSPACE_NOT_OPEN');
    }
    assert.deepEqual(h.state.native, []);
    assert.deepEqual(h.state.confirmations, []);
}));
test('history hides inverse implementation records and marks reversed logical operations', () => harness(async (h) => { const logical = { opId: 'owned-op', title: 'Owned', author: 'owned', mode: 'manual', status: 'committed', createdAt: 'owned-date', fileCount: 1, changedPaths: [h.state.physical] }; h.state.history = [logical, { ...logical, opId: 'inverse', inverseOfOpId: 'owned-op' }, { ...logical, opId: 'scoped', rollbackScope: 'file' }]; const history = await h.invoke('operation.list', 1); assert.equal(history.length, 1); assert.equal(history[0].opId, 'owned-op'); assert.equal(history[0].status, 'rolled_back'); assert.equal(JSON.stringify(history).includes(h.root), false); }));
test('partial file rollback remains committed and identifies only restored indexes despite duplicate hidden labels', () => harness(async (h) => {
    const firstPath = join(h.root, 'first-private.lua'), secondPath = join(h.root, 'second-private.lua');
    h.state.files = [];
    const logical = { opId: 'owned-op', title: 'Owned', author: 'user', mode: 'normal', status: 'committed', createdAt: 'owned-date', fileCount: 2, changedPaths: [firstPath, secondPath] };
    h.state.history = [logical, { ...logical, opId: 'inverse-first', fileCount: 1, changedPaths: [firstPath], inverseOfOpId: 'owned-op', rollbackScope: 'file' }];
    const [entry] = await h.invoke('operation.list', 1);
    assert.equal(entry.opId, 'owned-op', 'the original transaction identity remains authoritative');
    assert.equal(entry.status, 'committed', 'one file inverse must not claim the whole operation was rolled back');
    assert.deepEqual(entry.changedPaths, ['[本机路径已隐藏]', '[本机路径已隐藏]']);
    assert.deepEqual(entry.partialRollback, { rolledBackFileIndexes: [0] });
}));
test('resource-entry inverses do not claim whole-file rollback while legacy unscoped inverses stay compatible', () => harness(async (h) => {
    const logical = { opId: 'owned-op', title: 'Owned', author: 'user', mode: 'normal', status: 'committed', createdAt: 'owned-date', fileCount: 2, changedPaths: [h.state.physical, join(h.root, 'second.lua')] };
    h.state.history = [logical, { ...logical, opId: 'entry-inverse', inverseOfOpId: 'owned-op', rollbackScope: 'resource_entry', fileCount: 1, changedPaths: [h.state.physical] }];
    let [entry] = await h.invoke('operation.list', 1);
    assert.equal(entry.status, 'committed');
    assert.equal(entry.partialRollback, undefined, 'resource-entry restoration is not a file restoration');
    h.state.history = [logical, { ...logical, opId: 'legacy-inverse', inverseOfOpId: 'owned-op' }];
    [entry] = await h.invoke('operation.list', 1);
    assert.equal(entry.status, 'rolled_back', 'unscoped legacy inverse retains whole-operation compatibility');
    h.state.history = [logical,
        { ...logical, opId: 'inverse-first', inverseOfOpId: 'owned-op', rollbackScope: 'file', fileCount: 1, changedPaths: [h.state.physical] },
        { ...logical, opId: 'inverse-second', inverseOfOpId: 'owned-op', rollbackScope: 'file', fileCount: 1, changedPaths: [join(h.root, 'second.lua')] }];
    [entry] = await h.invoke('operation.list', 1);
    assert.equal(entry.status, 'rolled_back', 'only file inverses for every original changed path complete the rollback');
    assert.equal(entry.partialRollback, undefined);
}));
for (const channel of ['operation.rollback', 'operation.rollbackFile'])
    test(`${channel} rejects missing and inverse source operations`, () => harness(async (h) => { const args = channel.endsWith('File') ? ['owned-op', h.state.sourceUri] : ['owned-op']; h.state.operation = null; assert.equal((await h.invoke(channel, 1, ...args)).diagnostics[0].code, 'OPERATION_NOT_FOUND'); h.state.operation = { opId: 'inverse', inverseOfOpId: 'old', files: [] }; assert.equal((await h.invoke(channel, 1, ...args)).diagnostics[0].code, 'ROLLBACK_OF_ROLLBACK_FORBIDDEN'); assert.deepEqual(h.state.confirmations, []); assert.deepEqual(h.state.native, []); }));
test('file rollback rejects an unrelated logical target before admission', () => harness(async (h) => { assert.equal((await h.invoke('operation.rollbackFile', 1, 'owned-op', 'file://owned/missing')).diagnostics[0].code, 'ROLLBACK_FILE_NOT_FOUND'); assert.deepEqual(h.state.confirmations, []); }));
for (const [channel, args, kind] of [['operation.rollback', ['owned-op'], 'operation'], ['operation.rollbackFile', ['owned-op', 'file://owned/scripts/owned.lua'], 'file']]) {
    test(`${channel} keeps lazy event-bound cancellation with no native replay`, () => harness(async (h) => { h.state.confirmation = null; const result = await h.invoke(channel, 7, ...args); assert.equal(result.diagnostics[0].code, 'WRITE_CONFIRMATION_CANCELLED'); assert.equal(h.state.confirmations[0].event.sender.id, 7); assert.deepEqual(h.state.native, []); assert.equal(h.module.hasActiveRollbackRequests(), false); }));
    test(`${channel} preserves exact transaction inputs and one carrier refresh`, () => harness(async (h) => { const out = await h.invoke(channel, 7, ...args), [nativeKind, input] = h.state.native[0]; assert.equal(nativeKind, kind); assert.equal(input.session, h.state.session); assert.equal(input.store, h.store); assert.equal(input.confirmation, h.state.confirmation); assert.equal(input.stagingRoot, join(h.root, 'stage')); assert.equal(h.state.refresh.length, 1); assert.equal(h.state.refresh[0][1], out); assert.equal(out.opId, 'owned-op'); assert.equal(out.inverseOpId, 'owned-inverse'); assert.deepEqual(out.restoredFiles, [h.state.sourceUri]); assert.equal(out.knowledgeRefresh.marker, 'owned'); assert.equal(h.module.hasActiveRollbackRequests(), false); }));
    test(`${channel} deduplicates pending confirmation and cleans up the exact request`, () => harness(async (h) => { const pending = gate(); h.state.confirmGate = pending; const first = h.invoke(channel, 1, ...args); await pending.entered; assert.equal(h.module.hasActiveRollbackRequests(), true); assert.equal((await h.invoke(channel, 1, ...args)).diagnostics[0].code, 'ROLLBACK_IN_PROGRESS'); pending.release(); await first; assert.equal(h.state.native.length, 1); assert.equal(h.module.hasActiveRollbackRequests(), false); }));
}
test('failed/no-change rollback does not refresh and unknown physical paths stay hidden', () => harness(async (h) => { h.state.nativeOk = false; assert.equal((await h.invoke('operation.rollback', 1, 'owned-op')).ok, false); assert.deepEqual(h.state.refresh, []); h.state.nativeOk = true; h.state.restored = false; await h.invoke('operation.rollback', 1, 'owned-op'); assert.deepEqual(h.state.refresh, []); h.state.restored = true; h.state.files = []; assert.deepEqual((await h.invoke('operation.rollback', 1, 'owned-op')).restoredFiles, ['[本机路径已隐藏]']); }));
test('native rejection releases dedupe lease and only a new explicit request can retry', () => harness(async (h) => { h.state.nativeThrows = true; await assert.rejects(h.invoke('operation.rollback', 1, 'owned-op'), /OWNED_NATIVE_FAILURE/); assert.equal(h.module.hasActiveRollbackRequests(), false); assert.equal(h.state.native.length, 1); h.state.nativeThrows = false; assert.equal((await h.invoke('operation.rollback', 1, 'owned-op')).ok, true); assert.equal(h.state.native.length, 2); assert.equal(h.state.confirmations.length, 2); }));
test('direct operation service is finite and requires only admitted confirmation plus host ports', () => harness(async (h) => { const service = h.module.createOperationService(applicationPorts(h)); assert.equal(Object.isFrozen(service), true); assert.deepEqual(Object.keys(service), ['list', 'rollback', 'rollbackFile']); const inputs = [], confirm = async (input) => { inputs.push(input); return h.state.confirmation; }; const out = await service.rollback(confirm, 'owned-op'); assert.equal(out.ok, true); assert.equal('event' in inputs[0], false); assert.deepEqual(inputs[0].extraSubjects, ['ROLLBACK_OPERATION:owned-op']); assert.equal(h.state.native[0][1].confirmation, h.state.confirmation); }));
test('rejected direct rollback does not request confirmation or construct a transaction', () => harness(async (h) => { const service = h.module.createOperationService(applicationPorts(h)); h.state.operation = null; let confirmed = 0; const out = await service.rollbackFile(async () => { confirmed++; return h.state.confirmation; }, 'owned-op', h.state.sourceUri); assert.equal(out.diagnostics[0].code, 'OPERATION_NOT_FOUND'); assert.equal(confirmed, 0); assert.deepEqual(h.state.native, []); }));
test('immutable operation host functions survive a confirmation await', () => harness(async (h) => { const ports = applicationPorts(h), service = h.module.createOperationService(ports), pending = gate(); const request = service.rollback(async () => { pending.start(); await pending.promise; return h.state.confirmation; }, 'owned-op'); await pending.entered; ports.getActiveSession = () => null; ports.getActiveOperationLog = () => null; ports.getIndexedFiles = () => []; ports.durableStoragePaths = () => { throw new Error('REPLACED_ROLLBACK_STORAGE'); }; ports.refreshActiveIndexAfterNativeWrite = () => { throw new Error('REPLACED_ROLLBACK_REFRESH'); }; pending.release(); assert.equal((await request).ok, true); assert.equal(h.state.native[0][1].session, h.state.session); assert.equal(h.state.refresh.length, 1); }));

async function withActualPatchIrTransaction(run) {
    const root = await mkdtemp(join(tmpdir(), 'sf-partial-rollback-owned-'));
    try {
        const entry = join(root, 'entry.ts'), outfile = join(root, 'transaction-fixture.mjs');
        const sourceExports = {
            'apps/desktop/src/main/services/operationService.ts': ['createOperationService'],
            'packages/core/src/patch-engine/patchIr.ts': ['createPatchIr'],
            'packages/core/src/patch/durablePatchCommit.ts': ['executePatchIrThroughTransaction'],
            'packages/core/src/patch/operationLog.ts': ['MemoryOperationLogStore'],
            'packages/core/src/patch/writerContract.ts': ['createConfirmationReceipt'],
            'packages/core/src/workspace/workspaceSession.ts': ['openWorkspaceSession']
        };
        await writeFile(entry, Object.entries(sourceExports).map(([filename, names]) =>
            `export {${names.join(',')}} from ${JSON.stringify(resolve(filename))};`).join('\n'));
        await build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node', target: 'node22',
            external: ['node:*', 'better-sqlite3', 'bindings'], plugins: [{ name: 'owned-patch-rollback-source', setup(bundler) {
                bundler.onResolve({ filter: /^@soulforge\/core$/ }, () => ({ path: resolve('packages/core/src/patch/rollback.ts') }));
                bundler.onResolve({ filter: /^@soulforge\/shared$/ }, () => ({
                    path: pathToFileURL(resolve('packages/shared/dist/index.js')).href, external: true
                }));
            } }] });
        const core = await import(pathToFileURL(outfile).href), overlayRoot = join(root, 'mod');
        await mkdir(overlayRoot);
        const files = ['first', 'second'].map((name) => ({ name,
            absolutePath: join(overlayRoot, `${name}.txt`), sourcePath: join(overlayRoot, `${name}.txt`), sourceUri: `file://${name}.txt` }));
        for (const file of files) await writeFile(file.absolutePath, `${file.name}-before\n`);
        const session = await core.openWorkspaceSession({ overlayRoot, game: 'owned-text-fixture' });
        const store = new core.MemoryOperationLogStore();
        const storage = { root, backupBaseDir: join(root, 'backups'), recoveryDir: join(root, 'recovery'), stagingRoot: join(root, 'stage') };
        const patch = core.createPatchIr({ workspaceId: session.meta.workspaceId, title: 'Owned two-file PatchIR', author: 'user',
            operations: files.map((file) => ({ id: file.name, kind: 'text_edit', targetUri: file.sourceUri,
                targetPath: file.absolutePath, newText: `${file.name}-after\n`,
                expectedHash: createHash('sha256').update(`${file.name}-before\n`).digest('hex'),
                preconditions: [{ type: 'content_hash', description: 'Exact owned fixture before image' }],
                validatorRequirements: [{ validatorId: 'text_non_empty', scope: 'staged_output', required: true }], riskLevel: 'low' })) });
        const committed = await core.executePatchIrThroughTransaction(patch, { session, operationLog: store, ...storage });
        assert.ok(committed.operation, JSON.stringify(committed.diagnostics));
        assert.equal(committed.changedFiles.length, 2);
        const service = core.createOperationService({ getActiveSession: () => session,
            getActiveWorkspaceSessionGeneration: () => 1, getActiveOperationLog: () => store, getIndexedFiles: () => files,
            durableStoragePaths: () => storage, refreshActiveIndexAfterNativeWrite: async () => {} });
        const confirm = async (input) => core.createConfirmationReceipt({
            subjects: input.extraSubjects, riskLevel: 'high', note: 'Owned text PatchIR rollback fixture'
        });
        await run({ root, files, store, service, confirm, committed });
    } finally { await rm(root, { recursive: true, force: true }); }
}

function assertOwnedBackup(root, filename) {
    const fromRoot = relative(root, filename);
    assert.ok(fromRoot !== '' && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot),
        'transaction backup must stay under the test-owned temporary root');
}

test('actual two-file PatchIR rollback preserves audit, backups, duplicate refusal and remaining-file CAS', () => withActualPatchIrTransaction(async (h) => {
    const original = await h.store.get(h.committed.opId), [first, second] = h.files;
    assert.equal(original.status, 'committed');
    assert.equal(original.files.length, 2);
    assert.equal(await readFile(original.files[0].backupPath, 'utf8'), 'first-before\n');
    assert.equal(await readFile(original.files[1].backupPath, 'utf8'), 'second-before\n');

    const restored = await h.service.rollbackFile(h.confirm, original.opId, first.sourceUri);
    assert.equal(restored.ok, true, JSON.stringify(restored.diagnostics));
    assert.equal(restored.opId, original.opId, 'the response keeps the original operation identity');
    assert.equal(await readFile(first.absolutePath, 'utf8'), 'first-before\n');
    assert.equal(await readFile(second.absolutePath, 'utf8'), 'second-after\n');
    const [partial] = await h.service.list();
    assert.equal(partial.opId, original.opId);
    assert.equal(partial.status, 'committed');
    assert.deepEqual(partial.partialRollback, { rolledBackFileIndexes: [0] });
    assert.deepEqual(await h.store.get(original.opId), original, 'partial rollback cannot rewrite the committed original record');

    const firstInverse = await h.store.get(restored.inverseOpId);
    assert.equal(firstInverse.status, 'committed');
    assert.equal(firstInverse.inverseOfOpId, original.opId);
    assert.equal(firstInverse.rollbackScope, 'file');
    assert.equal(firstInverse.rollbackTargetUri, first.sourceUri);
    assertOwnedBackup(h.root, firstInverse.files[0].backupPath);
    assert.equal(await readFile(firstInverse.files[0].backupPath, 'utf8'), 'first-after\n');

    const duplicate = await h.service.rollbackFile(h.confirm, original.opId, first.sourceUri);
    assert.equal(duplicate.ok, false);
    assert.ok(duplicate.diagnostics.some((diagnostic) => diagnostic.code === 'OPERATION_ALREADY_ROLLED_BACK'));
    assert.equal((await h.store.list()).length, 2, 'duplicate refusal must not append another inverse');

    const whole = await h.service.rollback(h.confirm, original.opId);
    assert.equal(whole.ok, false);
    assert.ok(whole.diagnostics.some((diagnostic) => diagnostic.code === 'ROLLBACK_TARGET_CHANGED'));
    assert.equal(await readFile(first.absolutePath, 'utf8'), 'first-before\n');
    assert.equal(await readFile(second.absolutePath, 'utf8'), 'second-after\n', 'whole rollback conflict is atomic');

    const remaining = await h.service.rollbackFile(h.confirm, original.opId, second.sourceUri);
    assert.equal(remaining.ok, true, JSON.stringify(remaining.diagnostics));
    assert.equal(remaining.opId, original.opId);
    assert.equal(await readFile(second.absolutePath, 'utf8'), 'second-before\n');
    const [fullyRolledBack] = await h.service.list();
    assert.equal(fullyRolledBack.status, 'rolled_back');
    assert.equal(fullyRolledBack.partialRollback, undefined);
    const secondInverse = await h.store.get(remaining.inverseOpId);
    assert.equal(secondInverse.rollbackScope, 'file');
    assert.equal(secondInverse.rollbackTargetUri, second.sourceUri);
    assertOwnedBackup(h.root, secondInverse.files[0].backupPath);
    assert.equal(await readFile(secondInverse.files[0].backupPath, 'utf8'), 'second-after\n');
    assert.deepEqual(await h.store.get(original.opId), original);
    assert.equal((await h.store.list()).length, 3, 'only the original and two file inverses persist');
}));

test('actual remaining-file CAS conflict after a partial PatchIR rollback cannot overwrite outside edits', () => withActualPatchIrTransaction(async (h) => {
    const [first, second] = h.files;
    assert.equal((await h.service.rollbackFile(h.confirm, h.committed.opId, first.sourceUri)).ok, true);
    await writeFile(second.absolutePath, 'external-edit\n');
    const conflict = await h.service.rollbackFile(h.confirm, h.committed.opId, second.sourceUri);
    assert.equal(conflict.ok, false);
    assert.ok(conflict.diagnostics.some((diagnostic) => diagnostic.code === 'ROLLBACK_TARGET_CHANGED'));
    assert.equal(await readFile(second.absolutePath, 'utf8'), 'external-edit\n');
    assert.equal((await h.store.list()).length, 2, 'CAS refusal leaves no second inverse record');
    const [partial] = await h.service.list();
    assert.equal(partial.status, 'committed');
    assert.deepEqual(partial.partialRollback, { rolledBackFileIndexes: [0] });
}));
