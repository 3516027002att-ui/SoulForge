import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ValidatorContract } from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';
import { createWorkspaceTransaction } from '../transactions/workspaceTransaction.js';
import { createScaffoldValidators } from '../validators/index.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { compilePatchProposalToPatchIr } from '../patch/patchProposalAdapter.js';
import { createPatchProposal, createStagingArea, commitValidatedStagingArea } from '../patch/patchEngine.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { rollbackOperation } from '../patch/rollback.js';
import { createConfirmationReceipt } from '../patch/writerContract.js';

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-security-'));
  const overlayRoot = join(root, 'mod');
  const outsideRoot = join(root, 'outside');
  const backupRoot = join(root, 'backups');
  await mkdir(overlayRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  await mkdir(backupRoot, { recursive: true });

  const session = await openWorkspaceSession({ overlayRoot, game: 'unknown' });
  await verifyReparsePointEscape(session, overlayRoot, outsideRoot, backupRoot);
  await verifyAfterCommitValidationRollback(session, overlayRoot, backupRoot);
  await verifyRollbackConflict(session, overlayRoot);

  console.log(JSON.stringify({
    ok: true,
    message: 'V0.5 安全边界冒烟验证通过',
    checks: [
      'junction/symlink escape rejected',
      'after-commit validation failure restored original bytes',
      'rollback afterHash conflict rejected without mutation'
    ]
  }, null, 2));
}

async function verifyReparsePointEscape(
  session: Awaited<ReturnType<typeof openWorkspaceSession>>,
  overlayRoot: string,
  outsideRoot: string,
  backupRoot: string
): Promise<void> {
  const outsideFile = join(outsideRoot, 'outside.txt');
  await writeFile(outsideFile, 'outside-original\n', 'utf8');
  const linkPath = join(overlayRoot, 'escape-link');
  await symlink(outsideRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  const escapedTarget = join(linkPath, 'outside.txt');

  const lexical = session.resolveWritablePath(escapedTarget);
  if (!lexical.ok) throw new Error('测试前提失败：纯字符串检查应把联接点目标视为目录内路径。');
  const secure = await session.resolveWritablePathSecure(escapedTarget);
  if (secure.ok || !secure.diagnostics.some((item) => item.code === 'WRITE_REPARSE_POINT_ESCAPE')) {
    throw new Error(`联接点越界没有被拒绝：${JSON.stringify(secure.diagnostics)}`);
  }

  const patch = await compileTextPatch(session.meta.workspaceId, escapedTarget, 'outside-mutated\n');
  const tx = createWorkspaceTransaction({
    workspaceId: session.meta.workspaceId,
    workspaceRoot: overlayRoot,
    backupBaseDir: backupRoot
  });
  if (!tx.addPatch(patch).ok) throw new Error('联接点测试补丁未能加入事务。');
  if (!(await tx.stage()).ok) throw new Error('联接点测试补丁未能进入暂存区。');
  if (!(await tx.validate()).ok) throw new Error('联接点测试补丁暂存验证失败。');
  const committed = await tx.commit();
  if (committed.ok || !committed.diagnostics.some((item) => item.code === 'WRITE_REPARSE_POINT_ESCAPE')) {
    throw new Error(`事务没有阻止联接点越界提交：${JSON.stringify(committed.diagnostics)}`);
  }
  if ((await readFile(outsideFile, 'utf8')) !== 'outside-original\n') {
    throw new Error('联接点越界测试修改了工作区外文件。');
  }
}

async function verifyAfterCommitValidationRollback(
  session: Awaited<ReturnType<typeof openWorkspaceSession>>,
  overlayRoot: string,
  backupRoot: string
): Promise<void> {
  const target = join(overlayRoot, 'after-commit.txt');
  await writeFile(target, 'before\n', 'utf8');
  const failingValidator: ValidatorContract = {
    validatorId: 'security_smoke_after_commit_failure',
    targetResourceKinds: ['*'],
    validationScope: ['after_commit'],
    validateAfterCommit: () => ({
      ok: false,
      scope: 'after_commit',
      validatorId: 'security_smoke_after_commit_failure',
      diagnostics: [createDiagnostic({
        severity: 'error',
        code: 'SECURITY_SMOKE_AFTER_COMMIT_FAILURE',
        message: '故障注入：提交后验证失败。'
      })]
    })
  };
  const tx = createWorkspaceTransaction({
    workspaceId: session.meta.workspaceId,
    workspaceRoot: overlayRoot,
    backupBaseDir: backupRoot,
    validators: [...createScaffoldValidators(), failingValidator]
  });
  const patch = await compileTextPatch(session.meta.workspaceId, target, 'after\n');
  if (!tx.addPatch(patch).ok) throw new Error('提交后验证测试补丁未能加入事务。');
  if (!(await tx.stage()).ok) throw new Error('提交后验证测试暂存失败。');
  if (!(await tx.validate()).ok) throw new Error('提交后验证测试的提交前验证失败。');
  const committed = await tx.commit();
  if (committed.ok) throw new Error('提交后验证故障注入不应返回成功。');
  if (!committed.diagnostics.some((item) => item.code === 'AFTER_COMMIT_VALIDATION_FAILED_ROLLED_BACK')) {
    throw new Error(`缺少提交后自动还原诊断：${JSON.stringify(committed.diagnostics)}`);
  }
  if ((await readFile(target, 'utf8')) !== 'before\n') {
    throw new Error('提交后验证失败没有恢复原内容。');
  }
}

async function verifyRollbackConflict(
  session: Awaited<ReturnType<typeof openWorkspaceSession>>,
  overlayRoot: string
): Promise<void> {
  const target = join(overlayRoot, 'rollback-conflict.txt');
  await writeFile(target, 'v1\n', 'utf8');
  const proposal = createPatchProposal({
    workspaceId: session.meta.workspaceId,
    title: 'rollback conflict smoke',
    author: 'user',
    mode: 'normal',
    changes: [{
      targetUri: 'file://rollback-conflict.txt',
      targetPath: target,
      kind: 'text',
      structuredEdit: { newText: 'v2\n' }
    }]
  });
  const store = new MemoryOperationLogStore();
  const staged = await createStagingArea(proposal);
  const committed = await commitValidatedStagingArea(staged, { session, operationLog: store });
  if (!committed.operation) throw new Error('回滚冲突测试提交失败。');

  await writeFile(target, 'v3-user-change\n', 'utf8');
  const rolled = await rollbackOperation({
    opId: committed.opId,
    store,
    session,
    confirmation: rollbackConfirmation(committed.opId)
  });
  if (rolled.ok || !rolled.diagnostics.some((item) => item.code === 'ROLLBACK_TARGET_CHANGED')) {
    throw new Error(`回滚没有阻止 afterHash 冲突：${JSON.stringify(rolled.diagnostics)}`);
  }
  if ((await readFile(target, 'utf8')) !== 'v3-user-change\n') {
    throw new Error('冲突回滚覆盖了提交后的用户修改。');
  }
  if ((await store.get(committed.opId))?.status !== 'committed') {
    throw new Error('冲突回滚不应改变原操作状态。');
  }
}

async function compileTextPatch(workspaceId: string, targetPath: string, newText: string) {
  const beforeHash = createHash('sha256').update(await readFile(targetPath)).digest('hex');
  const proposal = createPatchProposal({
    workspaceId,
    title: 'security boundary smoke',
    author: 'user',
    mode: 'normal',
    changes: [{
      targetUri: `file://${targetPath.replaceAll('\\', '/')}`,
      targetPath,
      kind: 'text',
      beforeHash,
      structuredEdit: { newText }
    }]
  });
  const compiled = compilePatchProposalToPatchIr(proposal);
  if (!compiled.ok || !compiled.patch) {
    throw new Error(`无法编译安全测试补丁：${JSON.stringify(compiled.diagnostics)}`);
  }
  return compiled.patch;
}

function rollbackConfirmation(opId: string) {
  return createConfirmationReceipt({
    subjects: [`ROLLBACK_OPERATION:${opId}`],
    riskLevel: 'high',
    note: 'security smoke'
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
