import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  PatchIrOperation,
  WriterAdapterContract,
  WriterApplyResult,
  WriterPostValidateResult
} from '@soulforge/shared';
import { createPatchIr } from '../patch-engine/patchIr.js';
import { createWorkspaceTransaction } from '../transactions/workspaceTransaction.js';

const WRITER_ID = 'writer:post-validate-smoke';

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-writer-post-validate-'));
  await verifyMissingHookFailsBeforeApply(root);
  await verifyApplyFailuresAreStructured(root);
  await verifyPostValidateFailures(root);
  await verifyCompleteCoverageStages(root);
  console.log(JSON.stringify({
    ok: true,
    message: '原生结构化 writer postValidate 执行、身份与 operation 覆盖约束验证通过',
    checks: [
      'missing postValidate rejected before apply',
      'apply throw and silent failure converted to structured diagnostics',
      'postValidate throw/identity/malformed result/incomplete coverage rejected',
      'complete postValidate coverage staged successfully'
    ]
  }, null, 2));
}

async function verifyMissingHookFailsBeforeApply(root: string): Promise<void> {
  const operation = await createOperation(root, 'missing-hook');
  let applyCalled = false;
  const writer = createWriter({
    onApply: () => { applyCalled = true; }
  });
  const staged = await stage(root, operation, writer);
  assertDiagnostic(staged, 'WRITER_POST_VALIDATE_REQUIRED');
  assert(!applyCalled, '缺少 postValidate 时不应执行 applyToStaging');
}

async function verifyApplyFailuresAreStructured(root: string): Promise<void> {
  const thrownOperation = await createOperation(root, 'apply-throw');
  const thrownWriter = createWriter({
    throwOnApply: true,
    postValidate: () => validPostResult(thrownOperation.id)
  });
  const thrown = await stage(root, thrownOperation, thrownWriter);
  assertDiagnostic(thrown, 'WRITER_APPLY_EXECUTION_FAILED');
  assert(!JSON.stringify(thrown.diagnostics).includes('sensitive apply path'), 'apply 异常消息泄漏');

  const silentOperation = await createOperation(root, 'apply-silent');
  const silentWriter = createWriter({
    applyResult: {
      ok: false,
      writtenTargets: [],
      writtenPaths: [],
      diagnostics: [],
      rollback: rollbackMetadata()
    },
    postValidate: () => validPostResult(silentOperation.id)
  });
  assertDiagnostic(await stage(root, silentOperation, silentWriter), 'WRITER_APPLY_REPORTED_FAILURE');
}

async function verifyPostValidateFailures(root: string): Promise<void> {
  const thrownOperation = await createOperation(root, 'post-throw');
  const thrown = await stage(root, thrownOperation, createWriter({
    postValidate: () => { throw new Error('sensitive post path'); }
  }));
  assertDiagnostic(thrown, 'WRITER_POST_VALIDATE_EXECUTION_FAILED');
  assert(!JSON.stringify(thrown.diagnostics).includes('sensitive post path'), 'postValidate 异常消息泄漏');

  const identityOperation = await createOperation(root, 'post-identity');
  assertDiagnostic(await stage(root, identityOperation, createWriter({
    postValidate: () => ({
      ...validPostResult(identityOperation.id),
      writerId: 'writer:forged'
    })
  })), 'WRITER_POST_VALIDATE_IDENTITY_INVALID');

  const malformedOperation = await createOperation(root, 'post-malformed');
  assertDiagnostic(await stage(root, malformedOperation, createWriter({
    postValidate: () => ({
      ...validPostResult(malformedOperation.id),
      diagnostics: [null] as unknown as WriterPostValidateResult['diagnostics']
    })
  })), 'WRITER_POST_VALIDATE_RESULT_INVALID');

  const coverageOperation = await createOperation(root, 'post-coverage');
  assertDiagnostic(await stage(root, coverageOperation, createWriter({
    postValidate: () => ({ ...validPostResult(coverageOperation.id), validatedOperationIds: [] })
  })), 'WRITER_POST_VALIDATE_COVERAGE_INCOMPLETE');
}

async function verifyCompleteCoverageStages(root: string): Promise<void> {
  const operation = await createOperation(root, 'post-valid');
  const staged = await stage(root, operation, createWriter({
    postValidate: () => validPostResult(operation.id)
  }));
  assert(staged.ok, `完整 postValidate coverage 暂存失败：${JSON.stringify(staged.diagnostics)}`);
}

async function stage(
  root: string,
  operation: PatchIrOperation,
  writer: WriterAdapterContract
) {
  const tx = createWorkspaceTransaction({
    workspaceId: 'writer-post-validate-smoke',
    workspaceRoot: root,
    writers: [writer],
    validators: []
  });
  const patch = createPatchIr({
    workspaceId: 'writer-post-validate-smoke',
    title: `writer postValidate ${operation.id}`,
    author: 'system',
    operations: [operation]
  });
  const added = tx.addPatch(patch);
  assert(added.ok, `writer postValidate 测试 PatchIR 无法加入事务：${JSON.stringify(added.diagnostics)}`);
  return tx.stage();
}

function createWriter(options: {
  onApply?: () => void;
  throwOnApply?: boolean;
  applyResult?: WriterApplyResult;
  postValidate?: NonNullable<WriterAdapterContract['postValidate']>;
}): WriterAdapterContract {
  return {
    writerId: WRITER_ID,
    supportedResourceKinds: ['other'],
    supportedOperations: ['container_child_replace'],
    inputSchemaVersion: 'soulforge.writerPostValidateSmoke.v1',
    preconditions: ['staging only'],
    canHandle: (operation) => operation.kind === 'container_child_replace',
    writePlan: (patch, operations) => ({
      writerId: WRITER_ID,
      operations,
      stagingRelativePaths: operations.map((operation) => operation.id),
      preconditions: operations.flatMap((operation) => operation.preconditions),
      estimatedRisk: 'high',
      notes: patch.patchId
    }),
    applyToStaging: async (input) => {
      options.onApply?.();
      if (options.throwOnApply) throw new Error('sensitive apply path');
      if (options.applyResult) return options.applyResult;
      const writtenTargets: WriterApplyResult['writtenTargets'] = [];
      for (const operation of input.operations) {
        const stagingPath = join(input.stagingRoot, operation.id, 'container.dcx');
        await mkdir(join(input.stagingRoot, operation.id), { recursive: true });
        await writeFile(stagingPath, 'staged');
        writtenTargets.push({
          opId: operation.id,
          targetUri: operation.targetUri,
          ...(operation.targetPath ? { targetPath: operation.targetPath } : {}),
          stagingPath
        });
      }
      return {
        ok: true,
        writtenTargets,
        writtenPaths: writtenTargets.map((target) => target.stagingPath),
        diagnostics: [],
        rollback: rollbackMetadata()
      };
    },
    produceRollbackMetadata: rollbackMetadata,
    ...(options.postValidate ? { postValidate: options.postValidate } : {})
  };
}

async function createOperation(root: string, id: string): Promise<PatchIrOperation> {
  const targetPath = join(root, `${id}.dcx`);
  const source = Buffer.from(`source-${id}`);
  await writeFile(targetPath, source);
  return {
    id,
    kind: 'container_child_replace',
    targetUri: `file://${targetPath.replaceAll('\\', '/')}`,
    targetPath,
    containerUri: `file://${targetPath.replaceAll('\\', '/')}`,
    containerFormat: 'BND4_DFLT',
    childPath: 'entry.bin',
    expectedContainerHash: sha256(source),
    expectedChildHash: sha256(Buffer.from('before-child')),
    childContentBase64: Buffer.from('after-child').toString('base64'),
    preconditions: [],
    validatorRequirements: [],
    riskLevel: 'high',
    metadata: { nativeFormatAuthority: true }
  };
}

function validPostResult(operationId: string): WriterPostValidateResult {
  return {
    ok: true,
    writerId: WRITER_ID,
    validatedOperationIds: [operationId],
    diagnostics: []
  };
}

function rollbackMetadata() {
  return {
    writerId: WRITER_ID,
    strategy: 'restore_backup' as const,
    backupPaths: []
  };
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertDiagnostic(
  result: { ok: boolean; diagnostics: Array<{ code: string }> },
  code: string
): void {
  assert(!result.ok, `${code} 测试意外成功`);
  assert(result.diagnostics.some((diagnostic) => diagnostic.code === code), `缺少诊断 ${code}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
