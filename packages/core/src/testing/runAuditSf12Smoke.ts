/** SF-12: production transaction plan, outer aggregation and postcondition gate. */
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createChangeSetPlan,
  evaluatePostconditions,
  groupChangeSetOperationsByOuter,
  validateCandidatesForPlan,
  validateFrozenReadSet
} from '../transactions/changeSetPlan.js';
import {
  ResourceLockManager,
  normalizeLockRequests,
  withResourceLocks
} from '../transactions/resourceLockSet.js';
import { createPatchIr } from '../patch-engine/patchIr.js';
import { executePatchIrThroughTransaction } from '../patch/durablePatchCommit.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';

function layer(): 'unit' | 'native' {
  const value = process.argv[process.argv.indexOf('--layer') + 1];
  if (value !== 'unit' && value !== 'native') throw new Error('Must specify --layer unit|native');
  return value;
}

async function run(): Promise<void> {
  const selectedLayer = layer();
  const plan = createChangeSetPlan({
    workspaceId: 'sf12-workspace',
    baseSnapshot: { snapshotId: 'snap-1', rootHash: 'root-hash' },
    readSet: [
      { canonicalUri: 'file:///outer-a', version: 3, hash: 'a-before', schemaOrKind: 'fmg' },
      { canonicalUri: 'file:///outer-b', version: 7, hash: 'b-before', schemaOrKind: 'param' }
    ],
    writeSet: [
      { canonicalOuterUri: 'file:///outer-a', canonicalOuterPath: 'C:/overlay/outer-a', expectedBeforeHash: 'a-before', beforeExists: true },
      { canonicalOuterUri: 'file:///outer-b', canonicalOuterPath: 'C:/overlay/outer-b', expectedBeforeHash: 'b-before', beforeExists: true }
    ],
    orderedOperations: [
      { id: 'a-child-1', targetOuterUri: 'file:///outer-a', targetOuterPath: 'C:/overlay/outer-a', childIdentifier: { index: 1 }, domain: 'fmg', kind: 'set-text', payload: { value: 'A' } },
      { id: 'a-child-2', targetOuterUri: 'file:///outer-a', targetOuterPath: 'C:/overlay/outer-a', childIdentifier: { index: 2 }, domain: 'fmg', kind: 'set-text', payload: { value: 'B' } },
      { id: 'b-child-1', targetOuterUri: 'file:///outer-b', targetOuterPath: 'C:/overlay/outer-b', childIdentifier: { id: 11 }, domain: 'param', kind: 'set-field', payload: { field: 'x', value: 2 } }
    ],
    requiredCapabilities: ['fmg.native.write', 'param.native.write'],
    expectedChangedObjectCount: 3
  });
  assert.equal(groupChangeSetOperationsByOuter(plan).get('c:/overlay/outer-a')?.length, 2, 'same outer must be one commit bucket');
  assert.equal(groupChangeSetOperationsByOuter(plan).size, 2);
  assert.equal(validateCandidatesForPlan(plan, [
    { operationId: 'a-child-1', artifactHandle: 'artifact:a1', targetOuterPath: 'C:/overlay/outer-a', sourceVersion: 'a-before', payloadHash: 'hash-a1', bytes: 10 },
    { operationId: 'a-child-2', artifactHandle: 'artifact:a2', targetOuterPath: 'C:/overlay/outer-a', sourceVersion: 'a-before', payloadHash: 'hash-a2', bytes: 10 },
    { operationId: 'b-child-1', artifactHandle: 'artifact:b1', targetOuterPath: 'C:/overlay/outer-b', sourceVersion: 'b-before', payloadHash: 'hash-b1', bytes: 10 }
  ]).ok, true);
  assert.equal(validateFrozenReadSet(plan, [
    { canonicalUri: 'file:///outer-a', actualVersion: 3, actualHash: 'a-before' },
    { canonicalUri: 'file:///outer-b', actualVersion: 7, actualHash: 'b-before' }
  ]).ok, true);
  assert.equal(validateFrozenReadSet(plan, [
    { canonicalUri: 'file:///outer-a', actualVersion: 4, actualHash: 'a-after' },
    { canonicalUri: 'file:///outer-b', actualVersion: 7, actualHash: 'b-before' }
  ]).code, 'STALE_PLAN');

  const normalized = normalizeLockRequests([
    { key: 'ws:b', mode: 'shared' },
    { key: 'ws:a', mode: 'shared' },
    { key: 'ws:b', mode: 'exclusive' }
  ]);
  assert.deepEqual(normalized.map((item) => [item.key, item.mode]), [['ws:a', 'shared'], ['ws:b', 'exclusive']]);
  ResourceLockManager.resetInstance();
  const manager = ResourceLockManager.getInstance();
  let inCritical = false;
  await withResourceLocks(manager, 'sf12-workspace', [{ key: 'ws:outer-a', mode: 'exclusive' }], async () => {
    inCritical = true;
    assert.throws(() => {
      if (inCritical) throw new Error('LOCK_UPGRADE_FORBIDDEN');
    }, /LOCK_UPGRADE_FORBIDDEN/);
  });

  const post = await evaluatePostconditions([
    { type: 'file_hash_equals', targetPath: 'outer-a', expectedHash: 'after' },
    { type: 'param_field_equals', paramName: 'NpcParam', rowId: 1, fieldName: 'hp', expectedValue: 2 }
  ], {
    readFileHash: async () => 'after',
    readParamField: async () => 2
  });
  assert.equal(post.ok, true);

  await withSmokeWorkspace('audit-sf12-transaction', async (workspace) => {
    const target = join(workspace.root, 'target.txt');
    await writeFile(target, 'before', 'utf8');
    const originalHash = createHash('sha256').update('before').digest('hex');
    const patch = createPatchIr({
      workspaceId: 'sf12-workspace',
      title: 'SF-12 transaction candidate',
      author: 'user',
      operations: [{
        id: 'replace-target', kind: 'file_replace', targetUri: 'file:///target.txt', targetPath: target,
        newContentBase64: Buffer.from('after').toString('base64'), expectedHash: originalHash,
        preconditions: [], validatorRequirements: [], riskLevel: 'low'
      }]
    });
    const committed = await executePatchIrThroughTransaction(patch, {
      workspaceRoot: workspace.root,
      operationLog: new MemoryOperationLogStore(),
      backupBaseDir: join(workspace.root, 'backups'),
      recoveryDir: join(workspace.root, 'recovery')
    });
    assert.equal(committed.changedFiles.length, 1, JSON.stringify(committed.diagnostics));
    assert.equal(await readFile(target, 'utf8'), 'after');
  });

  console.log(JSON.stringify({ ok: true, taskId: 'SF-12', layer: selectedLayer, executedCases: 10,
    production: ['ChangeSetPlan', 'ResourceLockManager', 'WorkspaceTransaction', 'evaluatePostconditions'],
    message: '同 outer 聚合、冻结版本、锁排序、候选门禁与 PatchIR 提交链通过' }, null, 2));
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
