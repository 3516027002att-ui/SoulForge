import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { withSmokeWorkspace } from '../testing/harness/smokeWorkspace.js';
import { executePatchIrThroughTransaction } from '../patch/durablePatchCommit.js';
import { createPatchIr } from '../patch-engine/patchIr.js';
import { cliWorkspaceRoot, openLocalCliSession } from './localCliSession.js';

await withSmokeWorkspace('cli-rollback-authorization', async ({ root }) => withIsolatedStorage(join(root, 'storage'), async () => {
  const overlayRoot = join(root, 'mod');
  await mkdir(overlayRoot, { recursive: true });
  const targetPath = join(overlayRoot, 'rollback.txt');
  await writeFile(targetPath, 'before\n');

  const producer = await openLocalCliSession({
    overlayRoot,
    game: 'sekiro',
    mode: 'fullPermission',
    analyze: false,
    requireDurableLog: true
  });
  const patch = createPatchIr({
    workspaceId: producer.coreSession.workspaceId,
    title: 'CLI rollback authorization integration',
    author: 'user',
    operations: [{
      id: 'rollback-edit',
      kind: 'text_edit',
      targetUri: 'file://rollback.txt',
      targetPath,
      newText: 'after\n',
      expectedHash: sha256('before\n'),
      preconditions: [{ type: 'content_hash', description: 'source hash must match' }],
      validatorRequirements: [{ validatorId: 'text_non_empty', scope: 'staged_output', required: true }],
      riskLevel: 'low'
    }]
  });
  const committed = await executePatchIrThroughTransaction(patch, {
    session: producer.editSession.session,
    operationLog: producer.editSession.operationLog,
    backupBaseDir: producer.editSession.backupBaseDir,
    recoveryDir: producer.editSession.recoveryDir
  });
  const operationId = committed.operation?.opId;
  assert.ok(operationId);
  assert.equal(await readFile(targetPath, 'utf8'), 'after\n');
  await producer.dispose();

  const noAuth = await openLocalCliSession({
    overlayRoot,
    game: 'sekiro',
    mode: 'fullPermission',
    analyze: false,
    requireDurableLog: true
  });
  const unauthorized = await noAuth.executeTool(rollbackCall('unauthorized'));
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.code, 'EDIT_CONFIRMATION_REQUIRED');
  assert.equal(await readFile(targetPath, 'utf8'), 'after\n');
  await noAuth.dispose();

  const authorized = await openLocalCliSession({
    overlayRoot,
    game: 'sekiro',
    mode: 'fullPermission',
    analyze: false,
    requireDurableLog: true,
    confirmRollbackOpId: operationId
  });
  const wrongOperation = await authorized.executeTool(rollbackCall('wrong-op'));
  assert.equal(wrongOperation.ok, false);
  assert.equal(wrongOperation.code, 'CLI_ROLLBACK_CONFIRMATION_MISMATCH');
  assert.equal(await readFile(targetPath, 'utf8'), 'after\n');

  const accepted = await authorized.executeTool(rollbackCall(operationId));
  assert.equal(accepted.ok, true, accepted.content);
  assert.equal(await readFile(targetPath, 'utf8'), 'before\n');

  const replay = await authorized.executeTool(rollbackCall(operationId));
  assert.equal(replay.ok, false);
  assert.equal(replay.code, 'CLI_ROLLBACK_CONFIRMATION_REPLAYED');
  assert.equal(await readFile(targetPath, 'utf8'), 'before\n');
  await authorized.dispose();
}));

await withSmokeWorkspace('cli-storage-fail-closed', async ({ root }) => {
  const overlayRoot = join(root, 'mod'); await mkdir(overlayRoot);
  const blocked = join(root, 'blocked-storage'); await writeFile(blocked, 'unchanged');
  await withIsolatedStorage(blocked, async () => {
    await assert.rejects(openLocalCliSession({ overlayRoot, game: 'sekiro', analyze: false, requireDurableLog: true }), error => (error as NodeJS.ErrnoException).code === 'ENOTDIR');
    assert.equal(await readFile(blocked, 'utf8'), 'unchanged');
  });
});

console.log(JSON.stringify({ ok: true, checks: 15, storage: 'fixture-owned; explicit failure never falls back' }));

async function withIsolatedStorage<T>(storageRoot: string, execute: () => Promise<T>): Promise<T> {
  const previous = process.env.SF_E2E_WORKSPACE_STORAGE_ROOT;
  process.env.SF_E2E_WORKSPACE_STORAGE_ROOT = storageRoot;
  try {
    assert.ok(!relative(storageRoot, cliWorkspaceRoot('storage-scope-check')).startsWith('..'));
    return await execute();
  } finally {
    if (previous === undefined) delete process.env.SF_E2E_WORKSPACE_STORAGE_ROOT;
    else process.env.SF_E2E_WORKSPACE_STORAGE_ROOT = previous;
  }
}

function rollbackCall(opId: string) {
  return {
    id: `rollback-${opId}`,
    name: 'rollback_operation',
    argumentsJson: JSON.stringify({ opId })
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
