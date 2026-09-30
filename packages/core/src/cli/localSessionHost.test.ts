import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSessionHost } from './localSessionHost.js';
import { CoreToolSession } from '../runtime/coreToolSession.js';
import { openSqliteOperationLogStore } from '../patch/sqliteOperationLogStore.js';
import type { OperationLogRecord } from '@soulforge/shared';

const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

for (const cancellation of ['host', 'caller', 'close'] as const) {
  test(`preserves the durable receipt after ${cancellation} cancellation`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-host-commit-'));
    const workspaceId = 'host-receipt-test';
    const store = openSqliteOperationLogStore({ databasePath: join(root, 'workspace.db'), workspaceId, rootPath: root });
    const core = new CoreToolSession({ principal: 'test', workspaceId, operationLog: store });
    const host = new LocalSessionHost('test', workspaceId, 'test', core);
    const committed = gate();
    const release = gate();
    const caller = new AbortController();
    let calls = 0;
    const request = { id: 'relative-change', tool: 'batch_transform_map_objects', args: { dx: 1 } };
    const operation: OperationLogRecord = {
      opId: 'actual-operation', workspaceId, title: 'receipt', author: 'user', mode: 'normal',
      status: 'committed', createdAt: new Date().toISOString(), committedAt: new Date().toISOString(), files: [], diagnostics: []
    };
    const receipt = { ok: true, data: { operation, opId: operation.opId, nativeVerification: { status: 'verified' } } };
    const execute = async () => {
      calls += 1;
      await store.record(operation);
      committed.resolve();
      await release.promise;
      return receipt;
    };
    try {
      const pending = host.dispatch(request, execute, caller.signal);
      await committed.promise;
      if (cancellation === 'host') host.requestCancel(request.id);
      else if (cancellation === 'caller') caller.abort();
      else host.close();
      assert.equal(host.requestStatus(request.id)?.state, 'cancel_requested');
      release.resolve();
      const outcome = await pending;
      assert.deepEqual(outcome.result, receipt, 'cancellation must not erase a real receipt');
      assert.equal(outcome.error?.retryable, false);
      assert.equal((outcome as unknown as { transaction: { state: string; opId: string } }).transaction.state, 'committed');
      assert.equal((outcome as unknown as { transaction: { opId: string } }).transaction.opId, operation.opId);
      assert.equal(host.requestStatus(request.id)?.state, 'cancelled');
      assert.equal((await store.get(operation.opId))?.status, 'committed');
      if (cancellation !== 'close') {
        assert.deepEqual(await host.dispatch(request, execute), outcome);
        assert.equal(calls, 1);
      }
    } finally { host.close(); store.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test('queued cancellation is confirmed not committed and never calls the executor', async () => {
  const host = new LocalSessionHost('queued', 'workspace', 'test');
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  try {
    const result = await host.dispatch({ id: 'queued', tool: 'arbitrary', args: {} }, async () => { calls += 1; }, controller.signal);
    assert.equal(calls, 0);
    assert.equal(result.error?.retryable, true);
    assert.equal((result as unknown as { transaction: { state: string } }).transaction.state, 'not_committed');
  } finally { host.close(); }
});

test('an executor failure after it starts has unknown outcome, independent of tool prefix', async () => {
  for (const tool of ['read_like_name', 'commit_like_name', 'batch_transform_map_objects']) {
    const host = new LocalSessionHost(tool, 'workspace', 'test');
    try {
      const result = await host.dispatch({ id: tool, tool, args: {} }, async () => {
        host.requestCancel(tool);
        throw new Error('transport lost after dispatch');
      });
      assert.equal(result.error?.retryable, false);
      assert.equal((result as unknown as { transaction: { state: string } }).transaction.state, 'unknown');
    } finally { host.close(); }
  }
});

test('Patch Engine correlation preserves opId when transport fails before it returns a receipt', async () => {
  const { writeFile, readFile } = await import('node:fs/promises');
  const { executePatchIrThroughTransaction } = await import('../patch/durablePatchCommit.js');
  const { createPatchIr } = await import('../patch-engine/patchIr.js');
  const { createHash } = await import('node:crypto');
  const root = await mkdtemp(join(tmpdir(), 'sf-host-patch-'));
  const workspaceId = 'correlated-patch';
  const target = join(root, 'scratch.txt'); await writeFile(target, 'before');
  const store = openSqliteOperationLogStore({ databasePath: join(root, '.soulforge', 'workspace.db'), workspaceId, rootPath: root });
  const host = new LocalSessionHost('test', workspaceId, 'test', new CoreToolSession({ principal: 'test', workspaceId, operationLog: store }));
  const patch = createPatchIr({ workspaceId, title: 'actual patch', author: 'user', operations: [{
    id: 'text', kind: 'text_edit', targetUri: 'file://scratch.txt', targetPath: target, newText: 'after',
    expectedHash: createHash('sha256').update('before').digest('hex'), preconditions: [], validatorRequirements: [], riskLevel: 'low'
  }] });
  try {
    const outcome = await host.dispatch({ id: 'lost-response', tool: 'opaque-name', args: {} }, async () => {
      const committed = await executePatchIrThroughTransaction(patch, { operationLog: store, workspaceRoot: root, backupBaseDir: join(root, '.soulforge', 'backups') });
      assert.equal(committed.operation?.status, 'committed');
      assert.deepEqual(host.requestStatus('lost-response')?.opIds, [patch.patchId]);
      host.requestCancel('lost-response');
      throw new Error('response transport lost');
    });
    assert.equal(await readFile(target, 'utf8'), 'after');
    assert.equal(outcome.transaction?.opId, patch.patchId);
    assert.equal(outcome.transaction?.state, 'committed');
    assert.equal(outcome.error?.retryable, false);
    assert.equal((await host.operationStatus(patch.patchId)).state, 'committed');
    assert.equal((await store.getTransactionForOperation(patch.patchId))?.phase, 'committed');
  } finally { host.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test('serialized executor envelopes keep the authoritative rolled-back operation outcome', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-host-envelope-'));
  const workspaceId = 'serialized-receipt';
  const store = openSqliteOperationLogStore({ databasePath: join(root, 'workspace.db'), workspaceId, rootPath: root });
  const host = new LocalSessionHost('test', workspaceId, 'test', new CoreToolSession({ principal: 'test', workspaceId, operationLog: store }));
  try {
    await store.record({ opId: 'rollback-op', workspaceId, title: 'rolled back', author: 'user', mode: 'normal', status: 'rolled_back', createdAt: 'now', files: [], diagnostics: [] });
    const receipt = { ok: true, content: JSON.stringify({ ok: true, data: { opId: 'rollback-op' } }) };
    const outcome = await host.dispatch({ id: 'rollback', tool: 'opaque', args: {} }, async () => {
      host.requestCancel('rollback');
      return receipt;
    });
    assert.deepEqual(outcome.result, receipt);
    assert.equal(outcome.transaction?.opId, 'rollback-op');
    assert.equal(outcome.transaction?.state, 'rolled_back');
    assert.equal(outcome.error?.retryable, false);
  } finally { host.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test('a reopened host recovers the operation from request identity and refuses to replay it', async () => {
  const { writeFile } = await import('node:fs/promises');
  const { executePatchIrThroughTransaction } = await import('../patch/durablePatchCommit.js');
  const { createPatchIr } = await import('../patch-engine/patchIr.js');
  const { createHash } = await import('node:crypto');
  const root = await mkdtemp(join(tmpdir(), 'sf-host-reopen-'));
  const workspaceId = 'reopened-host', databasePath = join(root, 'workspace.db');
  const target = join(root, 'scratch.txt'); await writeFile(target, 'before');
  let store = openSqliteOperationLogStore({ databasePath, workspaceId, rootPath: root });
  let host = new LocalSessionHost('stable-session', workspaceId, 'test', new CoreToolSession({ principal: 'test', workspaceId, operationLog: store }));
  const request = { id: 'known-request', tool: 'opaque', args: { amount: 1 } };
  const patch = createPatchIr({ workspaceId, title: 'lost response', author: 'user', operations: [{ id: 'text', kind: 'text_edit', targetUri: 'file://scratch.txt', targetPath: target, newText: 'after', expectedHash: createHash('sha256').update('before').digest('hex'), preconditions: [], validatorRequirements: [], riskLevel: 'low' }] });
  try {
    // Deliberately ignore the response, as a disconnected caller would.
    await host.dispatch(request, async () => {
      await executePatchIrThroughTransaction(patch, { operationLog: store, workspaceRoot: root, backupBaseDir: join(root, 'backups') });
      throw new Error('response lost');
    });
    host.close(); store.close();
    store = openSqliteOperationLogStore({ databasePath, workspaceId, rootPath: root });
    host = new LocalSessionHost('stable-session', workspaceId, 'test', new CoreToolSession({ principal: 'test', workspaceId, operationLog: store }));
    const status = await host.resolveRequestStatus(request.id);
    assert.deepEqual(status?.opIds, [patch.patchId], 'the caller needs only the original request identity');
    assert.equal(status?.state, 'unknown', 'a durable commit does not prove that the executor response was delivered');
    assert.equal(status?.outcome?.transaction?.state, 'committed');
    let calls = 0;
    const started = gate(), release = gate();
    const blocker = host.dispatch({ id: 'blocker', tool: 'opaque', args: {} }, async () => { started.resolve(); await release.promise; });
    await started.promise;
    const queuedReplay = host.dispatch(request, async () => { calls += 1; });
    host.close(); release.resolve(); await blocker;
    const recovered = await queuedReplay;
    assert.equal(calls, 0, 'a restarted host must not reapply a request with an existing durable operation');
    assert.equal(recovered.transaction?.opId, patch.patchId);
    assert.equal(recovered.transaction?.state, 'committed');
    assert.equal(recovered.error?.retryable, false);
    assert.equal(recovered.error?.code, 'CLI_REQUEST_REPLAY_BLOCKED');
  } finally { host.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test('durable request lookup failure refuses execution and stays unknown', async () => {
  const core = new CoreToolSession({ principal: 'test', workspaceId: 'lookup-failure' });
  core.operationLog.findTransactionsForRequest = async () => { throw new Error('database unavailable'); };
  const host = new LocalSessionHost('stable', 'lookup-failure', 'test', core);
  let calls = 0;
  try {
    const outcome = await host.dispatch({ id: 'previous-request', tool: 'opaque', args: {} }, async () => { calls += 1; });
    assert.equal(calls, 0);
    assert.equal(outcome.error?.code, 'CLI_REQUEST_OUTCOME_UNKNOWN');
    assert.equal(outcome.error?.retryable, false);
    assert.equal(outcome.transaction?.state, 'unknown');
  } finally { host.close(); }
});
