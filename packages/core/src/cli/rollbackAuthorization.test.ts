import assert from 'node:assert/strict';
import {
  consumeCliRollbackAuthorization,
  createCliRollbackAuthorization
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

console.log(JSON.stringify({ ok: true, checks: 13 }));
