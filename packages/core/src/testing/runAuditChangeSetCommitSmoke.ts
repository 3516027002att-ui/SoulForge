/** SF-12 focused mutation suite: after-commit failure must not be reported as success. */
import { strict as assert } from 'node:assert';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createPatchIr } from '../patch-engine/patchIr.js';
import { executePatchIrThroughTransaction } from '../patch/durablePatchCommit.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';

const layer = process.argv[process.argv.indexOf('--layer') + 1];
if (layer !== 'unit' && layer !== 'native') throw new Error('Must specify --layer unit|native');

await withSmokeWorkspace('audit-change-set-commit', async (workspace) => {
  const target = join(workspace.root, 'target.txt');
  await writeFile(target, 'before', 'utf8');
  const beforeHash = createHash('sha256').update('before').digest('hex');
  const patch = createPatchIr({
    workspaceId: 'sf12-change-set', title: 'after-commit mutant', author: 'user',
    operations: [{ id: 'mutant-target', kind: 'file_replace', targetUri: 'file:///target.txt', targetPath: target,
      expectedHash: beforeHash, newContentBase64: Buffer.from('after').toString('base64'),
      preconditions: [], validatorRequirements: [], riskLevel: 'low' }]
  });
  const result = await executePatchIrThroughTransaction(patch, {
    workspaceRoot: workspace.root,
    operationLog: new MemoryOperationLogStore(),
    backupBaseDir: join(workspace.root, 'backups'), recoveryDir: join(workspace.root, 'recovery'),
    appendValidators: [{
      validatorId: 'sf12-mutant-after-commit',
      validateAfterCommit: async () => ({ diagnostics: [{ severity: 'error', code: 'MUTANT_AFTER_COMMIT_REJECTED', message: 'injected validator failure' }] })
    }]
  } as any);
  assert.equal(result.operation, undefined, 'failed final validation must not create a committed operation');
  assert.equal((await readFile(target, 'utf8')), 'before', 'failed final validation must restore bytes');
  assert.ok(result.diagnostics.some((item) => item.code === 'AFTER_COMMIT_VALIDATION_FAILED_ROLLED_BACK' || item.code === 'TRANSACTION_RECOVERY_REQUIRED'));
});

console.log(JSON.stringify({ ok: true, taskId: 'SF-12', layer, executedCases: 1,
  message: 'validateAfterCommit 失败被生产事务捕获，磁盘与提交结果均回滚' }, null, 2));
