import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import {
  consumeCliRollbackAuthorization,
  createCliRollbackAuthorization,
  cliWorkspaceRoot
} from './localCliSession.js';

const workspaceId = 'file:///workspace/rollback-test';
const operationId = 'op-rollback-bound';

const unauthorized = consumeCliRollbackAuthorization(undefined, operationId, workspaceId);
assert.equal(unauthorized.ok, false);
assert.equal(unauthorized.code, 'EDIT_CONFIRMATION_REQUIRED');

const authorization = createCliRollbackAuthorization({ operationId, workspaceId });
assert.ok(authorization.receipt.id.length > 0);
assert.ok(authorization.receipt.subjects.includes(`ROLLBACK_OPERATION:${operationId}`));
assert.ok(authorization.receipt.subjects.includes(`ROLLBACK_WORKSPACE:${workspaceId}`));

const wrongOperation = consumeCliRollbackAuthorization(authorization, 'op-other', workspaceId);
assert.equal(wrongOperation.ok, false);
assert.equal(wrongOperation.code, 'CLI_ROLLBACK_CONFIRMATION_MISMATCH');

const wrongWorkspace = consumeCliRollbackAuthorization(authorization, operationId, 'file:///workspace/other');
assert.equal(wrongWorkspace.ok, false);
assert.equal(wrongWorkspace.code, 'CLI_ROLLBACK_CONFIRMATION_MISMATCH');

const accepted = consumeCliRollbackAuthorization(authorization, operationId, workspaceId);
assert.equal(accepted.ok, true);
if (accepted.ok) {
  assert.equal(accepted.confirmation, authorization.receipt);
}

const replay = consumeCliRollbackAuthorization(authorization, operationId, workspaceId);
assert.equal(replay.ok, false);
assert.equal(replay.code, 'CLI_ROLLBACK_CONFIRMATION_REPLAYED');

const previousIsolatedRoot = process.env.SF_E2E_WORKSPACE_STORAGE_ROOT;
try {
  const isolatedRoot = join(process.cwd(), 'output', 'cli-workspace-root-fixture');
  process.env.SF_E2E_WORKSPACE_STORAGE_ROOT = isolatedRoot;
  const workspaceKey = createHash('sha256').update(workspaceId).digest('hex').slice(0, 24);
  assert.equal(
    cliWorkspaceRoot(workspaceId),
    join(resolve(isolatedRoot), workspaceKey),
    'CLI must reopen the same isolated workspace database root used by production E2E runs'
  );
} finally {
  if (previousIsolatedRoot === undefined) delete process.env.SF_E2E_WORKSPACE_STORAGE_ROOT;
  else process.env.SF_E2E_WORKSPACE_STORAGE_ROOT = previousIsolatedRoot;
}

console.log(JSON.stringify({ ok: true, checks: 14 }));
