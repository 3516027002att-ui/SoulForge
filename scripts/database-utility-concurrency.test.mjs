import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { openSqliteOperationLogStore } from '../packages/core/dist/patch/sqliteOperationLogStore.js';
const require = createRequire(import.meta.url);
const createLoader = require('./typescript-test-loader.cjs');
const workerEntry = `
const { parentPort, workerData } = require('node:worker_threads');
const D = require(workerData.sqlite);
const original = D.prototype.pragma;
D.prototype.pragma = function (...args) {
  const result = original.apply(this, args);
  this.function('test_block', () => {
    if (process.env.SOULFORGE_DATABASE_ROLE === 'reader') throw new Error('reader attempted a write');
    const state = new Int32Array(workerData.control);
    Atomics.store(state, 0, 1); Atomics.notify(state, 0);
    Atomics.wait(state, 1, 0, 10000);
    return 1;
  });
  return result;
};
process.parentPort = { on: (event, listener) => parentPort.on(event, value => listener({ data: value })), postMessage: value => parentPort.postMessage(value) };
require(workerData.loader)()(workerData.entry);
`;

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'sf-utility-reader-'));
  const workspaceId = 'concurrency-test';
  const databasePath = join(root, 'workspace.db');
  const store = openSqliteOperationLogStore({ databasePath, workspaceId, rootPath: root });
  store.database.exec(`CREATE TRIGGER slow_insert BEFORE INSERT ON patch_history WHEN NEW.op_id='slow-op' BEGIN SELECT test_block(); END;`);
  store.close();
  const control = new SharedArrayBuffer(8);
  const children = [];
  const electron = { utilityProcess: { fork: (_module, _args, options) => {
    const events = new EventEmitter();
    const worker = new Worker(workerEntry, { eval: true, env: options.env ?? process.env, workerData: {
      control, loader: resolve('scripts/typescript-test-loader.cjs'), entry: resolve('apps/desktop/src/main/databaseUtility.ts'), sqlite: require.resolve('better-sqlite3')
    } });
    events.postMessage = value => worker.postMessage(value);
    events.kill = () => { void worker.terminate(); };
    worker.on('message', value => events.emit('message', value));
    worker.on('exit', code => events.emit('exit', code));
    worker.on('error', error => { console.error(error); events.emit('error', 'error', error.message); });
    children.push(worker);
    return events;
  } } };
  const { OperationLogUtilityClient } = createLoader({ electron })(resolve('apps/desktop/src/main/operationLogUtilityClient.ts'));
  const client = new OperationLogUtilityClient('test-worker', 1000);
  await client.openWorkspace({ appDatabasePath: join(root, 'app.db'), databasePath, workspaceId, rootPath: root, game: 'sekiro', legacyOperationLogPath: join(root, 'absent.json'), legacyBackupDirectory: join(root, 'legacy'), legacySemanticSnapshotPath: join(root, 'absent-snapshot.json'), legacySemanticBackupDirectory: join(root, 'semantic') });
  t.after(async () => { Atomics.store(new Int32Array(control), 1, 1); Atomics.notify(new Int32Array(control), 1); await client.dispose(); await Promise.all(children.map(worker => worker.terminate())); await rm(root, { recursive: true, force: true }); });
  return { client, control, workspaceId, children };
}
function operation(workspaceId) { return { opId: 'slow-op', workspaceId, title: 'blocked write', author: 'user', mode: 'normal', status: 'committed', createdAt: new Date().toISOString(), committedAt: new Date().toISOString(), files: [], diagnostics: [] }; }
async function waitStarted(control) {
  const limit = Date.now() + 5000; const state = new Int32Array(control);
  while (Atomics.load(state, 0) !== 1) { assert.ok(Date.now() < limit, 'writer did not enter transaction'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function release(control) { const state = new Int32Array(control); Atomics.store(state, 1, 1); Atomics.notify(state, 1); }

test('a committed-snapshot read does not wait behind a synchronous long writer', async t => {
  const { client, control, workspaceId } = await setup(t);
  const now = new Date().toISOString();
  await client.createTransaction({ transactionId: 'correlated-tx', opId: 'slow-op', phase: 'pending', state: { request: { sessionName: 'session', id: 'known-request', payloadHash: 'hash' } }, createdAt: now, updatedAt: now });
  const write = client.record(operation(workspaceId)); await waitStarted(control);
  try {
    const result = await Promise.race([client.get('slow-op'), new Promise((_, reject) => setTimeout(() => reject(new Error('read blocked behind synchronous writer')), 500))]);
    assert.equal(result, undefined, 'reader must see the last committed snapshot');
    assert.equal((await client.findTransactionsForRequest('session', 'known-request'))[0]?.opId, 'slow-op');
  } finally { release(control); await write; }
  assert.equal((await client.get('slow-op')).status, 'committed');
});

test('a worker-side expired write reports confirmed nonexecution with its operation identity', async t => {
  const { client, workspaceId } = await setup(t);
  const post = client.process.postMessage;
  client.process.postMessage = request => post({ ...request, deadlineAt: Date.now() - 1 });
  await assert.rejects(client.record({ ...operation(workspaceId), opId: 'expired-at-worker' }), error => {
    assert.equal(error.code, 'DATABASE_UTILITY_REQUEST_NOT_EXECUTED');
    assert.equal(error.transaction?.state, 'not_committed');
    assert.equal(error.transaction?.opId, 'expired-at-worker');
    assert.equal(error.retryable, true);
    return true;
  });
  client.process.postMessage = post;
  assert.equal(await client.get('expired-at-worker'), undefined);
});

test('a dispatched write timeout is unknown and its final state remains queryable by opId', async t => {
  const { client, control, workspaceId } = await setup(t);
  // A timer adapter bounds this test without changing the real client timeout policy.
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, milliseconds, ...args) => nativeSetTimeout(callback, milliseconds === 120000 ? 80 : milliseconds, ...args);
  let timeout;
  try {
    const write = client.record(operation(workspaceId)).catch(error => { timeout = error; });
    await waitStarted(control); await write;
    assert.equal(timeout?.code, 'DATABASE_UTILITY_OUTCOME_UNKNOWN');
    assert.equal(timeout?.transaction?.state, 'unknown');
    assert.equal(timeout?.transaction?.opId, 'slow-op');
    assert.equal(timeout?.retryable, false);
  } finally { globalThis.setTimeout = nativeSetTimeout; release(control); }
  const until = Date.now() + 5000;
  while (!(await client.get('slow-op'))) { assert.ok(Date.now() < until); await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal((await client.get('slow-op')).status, 'committed');
});

test('an expired queued write never executes and is confirmed not committed', async t => {
  const { client, control, workspaceId } = await setup(t);
  const first = client.record(operation(workspaceId)); await waitStarted(control);
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, milliseconds, ...args) => nativeSetTimeout(callback, milliseconds === 120000 ? 80 : milliseconds, ...args);
  try {
    await assert.rejects(client.record({ ...operation(workspaceId), opId: 'queued-op' }), error =>
      error.code === 'DATABASE_UTILITY_REQUEST_NOT_EXECUTED' && error.transaction.state === 'not_committed' && error.retryable === true);
  } finally { globalThis.setTimeout = nativeSetTimeout; release(control); await first; }
  assert.equal(await client.get('queued-op'), undefined);
});

test('reader rejects mutation and restart reopens both connections after writer exit', async t => {
  const { client, control, workspaceId, children } = await setup(t);
  await assert.rejects(client.reader.record({ ...operation(workspaceId), opId: 'reader-write' }), error => error.code === 'DATABASE_UTILITY_READ_ONLY');
  assert.equal(await client.get('reader-write'), undefined);
  const write = client.record(operation(workspaceId)).catch(error => error); await waitStarted(control);
  await children[0].terminate();
  const failure = await write;
  assert.equal(failure.code, 'DATABASE_UTILITY_OUTCOME_UNKNOWN');
  assert.equal(failure.transaction.opId, 'slow-op');
  release(control);
  await client.restart();
  assert.equal(await client.get('slow-op'), undefined);
  await client.record({ ...operation(workspaceId), opId: 'restarted-op' });
  assert.equal((await client.get('restarted-op')).status, 'committed');
});

test('writer initializes generation zero before the read-only snapshot connection opens', async t => {
  const { client, workspaceId } = await setup(t);
  const snapshot = await client.loadKnowledgeSnapshot({ workspaceId, rootPath: client.activeWorkspace.rootPath, game: 'sekiro' });
  assert.ok(snapshot?.current, 'initial knowledge generation must be durably queryable');
  assert.equal(snapshot.generations.length, 1);
});
