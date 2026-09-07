/** SF-13: rollback is an inverse transaction, idempotent and conflict-safe. */
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPatchIr } from '../patch-engine/patchIr.js';
import { executePatchIrThroughTransaction } from '../patch/durablePatchCommit.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { rollbackOperation, classifyRollbackState, rollbackIdempotencyKey } from '../patch/rollback.js';
import { createConfirmationReceipt } from '../patch/writerContract.js';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';

const layer = process.argv[process.argv.indexOf('--layer') + 1];
if (layer !== 'unit' && layer !== 'native') throw new Error('Must specify --layer unit|native');

await withSmokeWorkspace('audit-sf13-rollback', async (workspace) => {
  assert.equal(classifyRollbackState('b', 'a', 'b'), 'NOT_APPLIED');
  assert.equal(classifyRollbackState('b', 'a', 'a'), 'APPLIED');
  assert.equal(classifyRollbackState('b', 'a', 'c'), 'CONFLICT');
  assert.equal(rollbackIdempotencyKey('op-1', 'operation'), 'rollback:op-1:operation:*');

  const target = join(workspace.root, 'target.txt');
  await writeFile(target, 'before', 'utf8');
  const beforeHash = createHash('sha256').update('before').digest('hex');
  const store = new MemoryOperationLogStore();
  const patch = createPatchIr({
    workspaceId: 'sf13-workspace', title: 'rollback fixture', author: 'user',
    operations: [{ id: 'write', kind: 'file_replace', targetUri: 'file:///target.txt', targetPath: target,
      expectedHash: beforeHash, newContentBase64: Buffer.from('after').toString('base64'),
      preconditions: [], validatorRequirements: [], riskLevel: 'low' }]
  });
  const commit = await executePatchIrThroughTransaction(patch, {
    workspaceRoot: workspace.root, operationLog: store,
    backupBaseDir: join(workspace.root, 'backups'), recoveryDir: join(workspace.root, 'recovery')
  });
  assert.ok(commit.operation, JSON.stringify(commit.diagnostics));
  const receipt = createConfirmationReceipt({ subjects: [`ROLLBACK_OPERATION:${commit.opId}`], riskLevel: 'high' });
  const rolled = await rollbackOperation({ opId: commit.opId, store, workspaceRoot: workspace.root,
    backupBaseDir: join(workspace.root, 'backups'), recoveryDir: join(workspace.root, 'recovery'), confirmation: receipt });
  assert.equal(rolled.ok, true, JSON.stringify(rolled.diagnostics));
  assert.equal(await readFile(target, 'utf8'), 'before');
  const second = await rollbackOperation({ opId: commit.opId, store, workspaceRoot: workspace.root, confirmation: receipt });
  assert.equal(second.ok, false);
  assert.equal(second.diagnostics[0]?.code, 'OPERATION_ALREADY_ROLLED_BACK');

  const target2 = join(workspace.root, 'target2.txt');
  await writeFile(target2, 'before', 'utf8');
  const hash2 = createHash('sha256').update('before').digest('hex');
  const patch2 = createPatchIr({ workspaceId: 'sf13-workspace', title: 'conflict fixture', author: 'user', operations: [{
    id: 'write2', kind: 'file_replace', targetUri: 'file:///target2.txt', targetPath: target2,
    expectedHash: hash2, newContentBase64: Buffer.from('after').toString('base64'), preconditions: [], validatorRequirements: [], riskLevel: 'low'
  }] });
  const commit2 = await executePatchIrThroughTransaction(patch2, { workspaceRoot: workspace.root, operationLog: store,
    backupBaseDir: join(workspace.root, 'backups'), recoveryDir: join(workspace.root, 'recovery') });
  assert.ok(commit2.operation);
  await writeFile(target2, 'external', 'utf8');
  const receipt2 = createConfirmationReceipt({ subjects: [`ROLLBACK_OPERATION:${commit2.opId}`], riskLevel: 'high' });
  const conflict = await rollbackOperation({ opId: commit2.opId, store, workspaceRoot: workspace.root, confirmation: receipt2 });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.diagnostics[0]?.code, 'ROLLBACK_TARGET_CHANGED');
  assert.equal(await readFile(target2, 'utf8'), 'external');
});

console.log(JSON.stringify({ ok: true, taskId: 'SF-13', layer, executedCases: 9,
  production: ['rollbackOperation', 'classifyRollbackState', 'MemoryOperationLogStore'],
  message: '逆向 PatchIR、幂等拒绝、外部第三版本保护与恢复分类通过' }, null, 2));
