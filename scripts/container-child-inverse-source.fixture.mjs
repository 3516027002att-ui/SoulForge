import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Actual Core capture/commit functions with fake native transport. These fixtures
// prove consumer refusal and inverse construction, not native DCX/cache production.
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const physicalA = hash('owned physical DCX source A');
const physicalB = hash('owned physical DCX source B');
const childBytes = Buffer.from('unchanged owned child');
const childHash = hash(childBytes);
const fixtureParent = resolve('output/container-child-inverse-fixtures');
async function fixture() {
  await mkdir(fixtureParent, { recursive: true });
  const root = await mkdtemp(join(fixtureParent, 'inverse-'));
  const key = Symbol.for(`sf.inverse-source.${root}`);
  const state = { calls: [], snapshot: { sourceHash: physicalB, index: 0, id: 11, flags: 1, unknown: 0,
    name: 'NameB.param', contentHash: childHash, contentBase64: childBytes.toString('base64') } };
  globalThis[key] = state;
  const originalBridge = pathToFileURL(resolve('packages/core/dist/bridge/runBridge.js')).href;
  await build({ entryPoints: { capture: resolve('packages/core/src/patch/containerChildInverse.ts'),
      commit: resolve('packages/core/src/patch/durablePatchCommit.ts') }, outdir: root,
    outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    plugins: [{ name: 'fake-native-snapshot-transport', setup(builder) {
      builder.onResolve({ filter: /\/bridge\/runBridge\.js$/ }, () => ({ path: 'native-transport', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents:
        `export * from ${JSON.stringify(originalBridge)};
         export async function runBridge(input) {
           const state = globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(key))})];
           state.calls.push(input);
           if (input.command !== 'snapshot-bnd4-child') throw new Error('Unexpected native writer or read: '+input.command);
           return {parseStatus:'confirmed', diagnostics:[], data:state.snapshot};
         }` }));
    } }] });
  const { captureNativeBnd4ResourceEntryChanges: capture } = await import(pathToFileURL(join(root, 'capture.mjs')).href);
  const { executePatchIrThroughTransaction: commit } = await import(pathToFileURL(join(root, 'commit.mjs')).href);
  const { MemoryOperationLogStore } = await import(pathToFileURL(resolve('packages/core/dist/patch/operationLog.js')).href);
  const targetPath = join(root, 'owned.parambnd.dcx');
  await writeFile(targetPath, 'owned physical DCX source B');
  const op = { id: 'owned-child-change', kind: 'container_child_rename', targetUri: 'file://owned.parambnd.dcx',
    targetPath, containerUri: 'file://owned.parambnd.dcx', containerFormat: 'BND4_DFLT',
    childPath: 'NameB.param', newChildPath: 'Forward.param', expectedContainerHash: physicalB,
    expectedChildHash: childHash, metadata: { nativeFormatAuthority: true, nativeEntryIndex: 0 },
    preconditions: [], validatorRequirements: [], riskLevel: 'high' };
  return { root, state, op, capture: operations => capture(operations, root), commit, MemoryOperationLogStore,
    dispose: async () => { delete globalThis[key]; await rm(root, { recursive: true, force: true }); } };
}
function refused(result) {
  assert.deepEqual(result.changes, [], `must not persist a stale inverse: ${JSON.stringify(result.changes)}`);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].severity, 'error');
  assert.equal(result.diagnostics[0].code, 'CONTAINER_CHILD_INVERSE_CAPTURE_FAILED');
}

test('expected physical B refuses snapshot A despite identical child bytes and stale NameA metadata', async () => {
  const f = await fixture();
  try {
    f.state.snapshot.sourceHash = physicalA;
    f.state.snapshot.name = 'NameA.param';
    refused(await f.capture([f.op]));
  } finally { await f.dispose(); }
});
for (const value of [undefined, '']) test(`missing native source hash (${String(value)}) refuses an otherwise complete snapshot`, async () => {
  const f = await fixture();
  try {
    f.state.snapshot.sourceHash = value;
    refused(await f.capture([f.op]));
  } finally { await f.dispose(); }
});
test('missing expected physical container hash refuses snapshot-derived inverse proof', async () => {
  const f = await fixture();
  try {
    delete f.op.expectedContainerHash;
    refused(await f.capture([f.op]));
  } finally { await f.dispose(); }
});
for (const kind of ['replace', 'delete', 'rename', 'move']) test(`matched physical source retains the ${kind} inverse and child guard`, async () => {
  const f = await fixture();
  try {
    f.op.kind = `container_child_${kind}`;
    f.op.childContentBase64 = Buffer.from('replacement child').toString('base64');
    f.op.metadata.toIndex = 2;
    const result = await f.capture([f.op]);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.changes.length, 1);
    const change = result.changes[0];
    assert.equal(change.changeKind, kind);
    assert.equal(change.beforeHash, childHash);
    assert.equal(change.inverse.expectedContainerHash, physicalB);
    assert.equal(change.inverse.expectedHash, physicalB);
    if (kind === 'rename') assert.equal(change.inverse.newChildPath, 'NameB.param');
    if (kind === 'delete') assert.equal(change.inverse.childContentBase64, childBytes.toString('base64'));
    if (kind === 'move') assert.equal(change.inverse.metadata.toIndex, 0);
    f.state.snapshot.contentHash = hash('changed child');
    refused(await f.capture([f.op]));
  } finally { await f.dispose(); }
});
test('legacy expectedHash supplies physical source binding, while expectedContainerHash takes precedence', async () => {
  const f = await fixture();
  try {
    delete f.op.expectedContainerHash;
    f.op.expectedHash = physicalB;
    const matching = await f.capture([f.op]);
    assert.deepEqual(matching.diagnostics, []);
    assert.equal(matching.changes[0].inverse.expectedContainerHash, physicalB);
    f.op.expectedContainerHash = physicalA;
    refused(await f.capture([f.op]));
  } finally { await f.dispose(); }
});
test('add retains its postimage-bound delete inverse without an existing-child snapshot', async () => {
  const f = await fixture();
  try {
    f.op.kind = 'container_child_add';
    f.op.childContentBase64 = childBytes.toString('base64');
    const result = await f.capture([f.op]);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].changeKind, 'add');
    assert.equal(result.changes[0].inverse.kind, 'container_child_delete');
    assert.equal(result.changes[0].inverse.expectedChildHash, childHash);
    assert.equal(result.changes[0].inverse.expectedContainerHash, physicalB);
    assert.equal(f.state.calls.length, 0);
  } finally { await f.dispose(); }
});
test('durable commit marks inverse capture failed before writes and persists no resource-entry inverse', async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.op.targetPath);
    f.state.snapshot.sourceHash = physicalA;
    f.state.snapshot.name = 'NameA.param';
    const store = new f.MemoryOperationLogStore();
    const journalCreations = [];
    store.createTransaction = async record => { journalCreations.push(record); };
    store.transitionTransaction = async () => { throw new Error('Rejected inverse capture must not transition a transaction journal'); };
    const patch = { patchId: 'owned-refused-patch', workspaceId: 'owned', title: 'owned rename refusal',
      createdAt: new Date().toISOString(), operations: [f.op] };
    const result = await f.commit(patch, { workspaceRoot: f.root, operationLog: store,
      backupBaseDir: join(f.root, 'backups'), recoveryDir: join(f.root, 'recovery') });
    assert.deepEqual(result.changedFiles, []);
    assert.equal(result.backupRoot, '');
    assert.equal(result.diagnostics[0]?.code, 'CONTAINER_CHILD_INVERSE_CAPTURE_FAILED');
    const operation = await store.get(patch.patchId);
    assert.equal(operation.status, 'failed');
    assert.equal(operation.diagnostics[0]?.code, 'CONTAINER_CHILD_INVERSE_CAPTURE_FAILED');
    assert.deepEqual(journalCreations, [], 'refusal must precede the durable transaction journal');
    assert.equal(operation.transactionId, undefined);
    assert.deepEqual(await store.listResourceEntryChanges(patch.patchId), []);
    assert.deepEqual(await readFile(f.op.targetPath), before);
    assert.deepEqual(f.state.calls.map(call => call.command), ['snapshot-bnd4-child']);
  } finally { await f.dispose(); }
});
