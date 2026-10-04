// Desktop history controls over actual inverse PatchIR transactions in owned text fixtures.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { harness } from './testing/operationDomainHarness.mjs';

function historyEntry(h, patch = {}) {
  return { opId: 'owned-op', title: 'Owned', author: 'user', mode: 'normal', status: 'committed',
    createdAt: 'owned-time', fileCount: 2, changedPaths: [h.state.physical, join(h.root, 'second.lua')], ...patch };
}
test('a committed file inverse keeps the original actionable and projects only the restored file', () => harness(async h => {
  const original = historyEntry(h);
  h.state.history = [original, historyEntry(h, { opId: 'inverse-file', inverseOfOpId: original.opId,
    rollbackScope: 'file', fileCount: 1, changedPaths: [h.state.physical] })];
  const history = await h.invoke('operation.list', 1);
  assert.equal(history.length, 1);
  assert.equal(history[0].status, 'committed');
  assert.deepEqual(history[0].partialRollback, { rolledBackPaths: [h.state.sourceUri] });
  assert.equal(history[0].fileCount, 2, 'the original audit retains both changed files');
  assert.deepEqual(original.changedPaths, [h.state.physical, join(h.root, 'second.lua')]);
  assert.equal(JSON.stringify(history).includes(h.root), false);
}));
test('failed and planned file inverses do not remove any original rollback controls', () => harness(async h => {
  const original = historyEntry(h);
  h.state.history = [original, ...['failed', 'planned'].map((status, index) => historyEntry(h, {
    opId: `inverse-${index}`, inverseOfOpId: original.opId, rollbackScope: 'file', status,
    fileCount: 1, changedPaths: [h.state.physical]
  }))];
  const [entry] = await h.invoke('operation.list', 1);
  assert.equal(entry.status, 'committed');
  assert.equal(entry.partialRollback, undefined);
}));
test('complete file coverage marks the original rolled back using physical identities before masking', () => harness(async h => {
  const original = historyEntry(h);
  h.state.files = [];
  h.state.history = [original, ...original.changedPaths.map((path, index) => historyEntry(h, {
    opId: `inverse-${index}`, inverseOfOpId: original.opId, rollbackScope: 'file',
    fileCount: 1, changedPaths: [path]
  }))];
  assert.equal((await h.invoke('operation.list', 1))[0].status, 'rolled_back');
  h.state.history.pop();
  assert.equal((await h.invoke('operation.list', 1))[0].status, 'committed', 'masked labels cannot manufacture complete coverage');
}));
test('resource-entry inverses remain partial and never count as a complete file rollback', () => harness(async h => {
  const original = historyEntry(h, { fileCount: 1, changedPaths: [h.state.physical] });
  h.state.history = [original, historyEntry(h, { opId: 'inverse-entry', inverseOfOpId: original.opId,
    rollbackScope: 'resource_entry', fileCount: 1, changedPaths: [h.state.physical] })];
  const [entry] = await h.invoke('operation.list', 1);
  assert.equal(entry.status, 'committed');
  assert.deepEqual(entry.partialRollback, { rolledBackPaths: [] });
}));
for (const rollbackScope of ['operation', undefined]) {
  test(`whole-operation ${rollbackScope ?? 'legacy'} inverse marks the original fully rolled back`, () => harness(async h => {
    const original = historyEntry(h);
    h.state.history = [original, historyEntry(h, { opId: 'inverse-op', inverseOfOpId: original.opId, rollbackScope })];
    assert.equal((await h.invoke('operation.list', 1))[0].status, 'rolled_back');
  }));
}

async function withTransactionFixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'sf-partial-rollback-'));
  try {
    const entry = join(root, 'entry.ts'), outfile = join(root, 'fixture.mjs');
    const sources = {
      'apps/desktop/src/main/services/operationService.ts': ['createOperationService'],
      'packages/core/src/patch-engine/patchIr.ts': ['createPatchIr'],
      'packages/core/src/patch/durablePatchCommit.ts': ['executePatchIrThroughTransaction'],
      'packages/core/src/patch/operationLog.ts': ['MemoryOperationLogStore'],
      'packages/core/src/patch/writerContract.ts': ['createConfirmationReceipt'],
      'packages/core/src/workspace/workspaceSession.ts': ['openWorkspaceSession']
    };
    await writeFile(entry, Object.entries(sources).map(([path, exports]) =>
      `export {${exports.join(',')}} from ${JSON.stringify(resolve(path))};`).join('\n'));
    await build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node', target: 'node22',
      external: ['node:*', 'better-sqlite3', 'bindings'], plugins: [{ name: 'source-core-rollback', setup(b) {
        b.onResolve({ filter: /^@soulforge\/core$/ }, () => ({ path: resolve('packages/core/src/patch/rollback.ts') }));
        b.onResolve({ filter: /^@soulforge\/shared$/ }, () => ({ path: pathToFileURL(resolve('packages/shared/dist/index.js')).href, external: true }));
      } }] });
    const core = await import(pathToFileURL(outfile).href), overlayRoot = join(root, 'mod');
    await mkdir(overlayRoot);
    const files = ['first', 'second'].map(name => ({ name, absolutePath: join(overlayRoot, `${name}.txt`),
      sourcePath: join(overlayRoot, `${name}.txt`), sourceUri: `file://${name}.txt` }));
    for (const file of files) await writeFile(file.absolutePath, `${file.name}-before\n`);
    const session = await core.openWorkspaceSession({ overlayRoot, game: 'sekiro' });
    const store = new core.MemoryOperationLogStore(), storage = { root, backupBaseDir: join(root, 'backups'), recoveryDir: join(root, 'recovery'), stagingRoot: join(root, 'stage') };
    const patch = core.createPatchIr({ workspaceId: session.meta.workspaceId, title: 'Two-file fixture', author: 'user',
      operations: files.map(file => ({ id: file.name, kind: 'text_edit', targetUri: file.sourceUri,
        targetPath: file.absolutePath, newText: `${file.name}-after\n`,
        expectedHash: createHash('sha256').update(`${file.name}-before\n`).digest('hex'),
        preconditions: [{ type: 'content_hash', description: 'Exact fixture before image' }],
        validatorRequirements: [{ validatorId: 'text_non_empty', scope: 'staged_output', required: true }], riskLevel: 'low' })) });
    const committed = await core.executePatchIrThroughTransaction(patch, { session, operationLog: store, ...storage });
    assert.ok(committed.operation, JSON.stringify(committed.diagnostics));
    const service = core.createOperationService({ getActiveSession: () => session,
      getActiveWorkspaceSessionGeneration: () => 1, getActiveOperationLog: () => store, getIndexedFiles: () => files,
      durableStoragePaths: () => storage, refreshActiveIndexAfterNativeWrite: async () => {} });
    const confirm = async input => core.createConfirmationReceipt({ subjects: input.extraSubjects, riskLevel: 'high', note: 'Owned unit fixture' });
    await run({ root, files, store, service, confirm, committed });
  } finally { await rm(root, { recursive: true, force: true }); }
}
test('actual file rollback preserves the remaining file, backup evidence, CAS refusal and immutable audit', () => withTransactionFixture(async h => {
  const original = await h.store.get(h.committed.opId), [first, second] = h.files;
  const restored = await h.service.rollbackFile(h.confirm, original.opId, first.sourceUri);
  assert.equal(restored.ok, true, JSON.stringify(restored.diagnostics));
  assert.equal(await readFile(first.absolutePath, 'utf8'), 'first-before\n');
  assert.equal(await readFile(second.absolutePath, 'utf8'), 'second-after\n');
  const [partial] = await h.service.list();
  assert.equal(partial.status, 'committed');
  assert.deepEqual(partial.partialRollback, { rolledBackPaths: [first.sourceUri] });
  assert.deepEqual(await h.store.get(original.opId), original);
  const inverse = await h.store.get(restored.inverseOpId);
  assert.equal(inverse.rollbackScope, 'file');
  assert.equal(inverse.rollbackTargetUri, first.sourceUri);
  assert.equal(await readFile(inverse.files[0].backupPath, 'utf8'), 'first-after\n');
  const duplicate = await h.service.rollbackFile(h.confirm, original.opId, first.sourceUri);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.diagnostics[0].code, 'OPERATION_ALREADY_ROLLED_BACK');
  const whole = await h.service.rollback(h.confirm, original.opId);
  assert.equal(whole.ok, false);
  assert.ok(whole.diagnostics.some(d => d.code === 'ROLLBACK_TARGET_CHANGED'));
  assert.equal(await readFile(second.absolutePath, 'utf8'), 'second-after\n', 'failed whole rollback remains atomic');
  const remaining = await h.service.rollbackFile(h.confirm, original.opId, second.sourceUri);
  assert.equal(remaining.ok, true, JSON.stringify(remaining.diagnostics));
  assert.equal(await readFile(second.absolutePath, 'utf8'), 'second-before\n');
  assert.equal((await h.service.list())[0].status, 'rolled_back');
  assert.deepEqual(await h.store.get(original.opId), original);
  assert.equal((await h.store.list()).length, 3, 'only the original and two committed file inverses persist');
}));
test('a remaining-file CAS conflict after partial rollback cannot overwrite external edits', () => withTransactionFixture(async h => {
  const [first, second] = h.files;
  assert.equal((await h.service.rollbackFile(h.confirm, h.committed.opId, first.sourceUri)).ok, true);
  await writeFile(second.absolutePath, 'external-edit\n');
  const result = await h.service.rollbackFile(h.confirm, h.committed.opId, second.sourceUri);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some(d => d.code === 'ROLLBACK_TARGET_CHANGED'));
  assert.equal(await readFile(second.absolutePath, 'utf8'), 'external-edit\n');
  assert.equal((await h.store.list()).length, 2);
}));
