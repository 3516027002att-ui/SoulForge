/**
 * AI `rollback_operation` 工具接通验证（生产 ToolRegistry + 真实 Patch 提交）。
 *
 * 之前该工具是半成品：run 只带内存 store 且无 confirmation / session /
 * 备份目录，恒以 EDIT_CONFIRMATION_REQUIRED 失败。本次接通后必须验证：
 *
 * 1. 缺主进程注入的生产上下文 → ROLLBACK_CONTEXT_REQUIRED（干净失败，绝不
 *    用内存 store 冒充生产通道）；
 * 2. 无工作区 → WORKSPACE_REQUIRED；
 * 3. 完整上下文（session / store / backupBaseDir / recoveryDir / confirmation）
 *    → 走真实逆向 PatchIR 事务，文件恢复、逆操作落库；
 * 4. 有上下文但缺 confirmation → EDIT_CONFIRMATION_REQUIRED（rollbackSelected
 *    自己的凭据校验仍然生效——确认凭据只能由 main 原生对话框签发）；
 * 5. list_operations 优先用注入的生产 store，缺省才回退内存 store。
 *
 * Authority: unit —— 纯 core 逻辑，无 Bridge / 无真机语料。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';
import { createPatchIr } from '../patch-engine/patchIr.js';
import { executePatchIrThroughTransaction } from '../patch/durablePatchCommit.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { createConfirmationReceipt } from '../patch/writerContract.js';
import { createDefaultToolRegistry } from '../ai/toolRegistry.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import type { WorkspaceIndex } from '../indexing/workspaceIndex.js';

const failures: string[] = [];
let checks = 0;

function check(condition: unknown, message: string): void {
  checks += 1;
  if (!condition) failures.push(message);
}

function main(): Promise<void> {
  return withSmokeWorkspace('ai-rollback-tool', (workspace) => mainInWorkspace(workspace.root));
}

async function mainInWorkspace(root: string): Promise<void> {
  const overlayRoot = join(root, 'mod');
  await mkdir(overlayRoot, { recursive: true });
  const firstPath = join(overlayRoot, 'first.txt');
  const secondPath = join(overlayRoot, 'second.txt');
  await writeFile(firstPath, 'first-before\n');
  await writeFile(secondPath, 'second-before\n');
  const session = await openWorkspaceSession({ overlayRoot, game: 'sekiro' });
  const store = new MemoryOperationLogStore();
  const patch = createPatchIr({
    workspaceId: session.meta.workspaceId,
    title: 'AI 回滚工具验证',
    author: 'user',
    operations: [
      textEdit('file://first.txt', firstPath, 'first-before\n', 'first-after\n'),
      textEdit('file://second.txt', secondPath, 'second-before\n', 'second-after\n')
    ]
  });
  const committed = await executePatchIrThroughTransaction(patch, {
    session,
    operationLog: store,
    backupBaseDir: join(root, 'backups')
  });
  if (!committed.operation || committed.changedFiles.length !== 2) {
    throw new Error('AI rollback smoke: two-file commit failed.');
  }
  const opId = committed.opId;

  const registry = createDefaultToolRegistry();
  // 工具只判 workspaceIndex 是否为空，不访问字段；smoke 无索引装置，用最小假体。
  const fakeIndex = {} as WorkspaceIndex;

  // 1. 缺生产上下文：干净失败，且不产生任何写。
  const noContext = await registry.run(
    'rollback_operation',
    { opId },
    { workspaceIndex: fakeIndex, mode: 'fullPermission' }
  );
  check(!noContext.ok, '缺生产上下文必须失败');
  check(noContext.error?.code === 'ROLLBACK_CONTEXT_REQUIRED', '缺上下文错误码应为 ROLLBACK_CONTEXT_REQUIRED');
  check(await readFile(firstPath, 'utf8') === 'first-after\n', '缺上下文时不得改动文件');

  // 2. 无工作区：WORKSPACE_REQUIRED。
  const noWorkspace = await registry.run(
    'rollback_operation',
    { opId },
    { workspaceIndex: null, mode: 'fullPermission' }
  );
  check(!noWorkspace.ok && noWorkspace.error?.code === 'WORKSPACE_REQUIRED', '无工作区应 WORKSPACE_REQUIRED');

  // 3. 缺 opId：INVALID_INPUT。
  const noOpId = await registry.run(
    'rollback_operation',
    {},
    { workspaceIndex: fakeIndex, mode: 'fullPermission' }
  );
  check(!noOpId.ok && noOpId.error?.code === 'INVALID_INPUT', '缺 opId 应 INVALID_INPUT');

  // 4. 有上下文但缺 confirmation：EDIT_CONFIRMATION_REQUIRED（凭据校验仍生效）。
  const noConfirmation = await registry.run(
    'rollback_operation',
    { opId },
    {
      workspaceIndex: fakeIndex,
      mode: 'fullPermission',
      session,
      operationLogStore: store,
      backupBaseDir: join(root, 'backups'),
      recoveryDir: join(root, 'recovery')
    }
  );
  check(!noConfirmation.ok, '缺 confirmation 必须失败');
  check(
    noConfirmation.error?.code === 'EDIT_CONFIRMATION_REQUIRED',
    '缺 confirmation 错误码应为 EDIT_CONFIRMATION_REQUIRED'
  );
  check(await readFile(firstPath, 'utf8') === 'first-after\n', '缺 confirmation 时不得改动文件');

  // 5. 完整上下文：真实逆向事务，两个文件都恢复，逆操作落库（author=ai）。
  const full = await registry.run(
    'rollback_operation',
    { opId },
    {
      workspaceIndex: fakeIndex,
      mode: 'fullPermission',
      session,
      operationLogStore: store,
      backupBaseDir: join(root, 'backups'),
      recoveryDir: join(root, 'recovery'),
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_OPERATION:${opId}`],
        riskLevel: 'high',
        note: 'ai rollback tool smoke'
      })
    }
  );
  check(full.ok, `完整上下文应回滚成功：${JSON.stringify(full.error ?? full.data)}`);
  const data = full.ok ? full.data as { inverseOpId?: string; restoredFiles: string[] } : null;
  check(data?.restoredFiles.length === 2, '应恢复两个文件');
  check(await readFile(firstPath, 'utf8') === 'first-before\n', '第一个文件应恢复');
  check(await readFile(secondPath, 'utf8') === 'second-before\n', '第二个文件应恢复');
  const inverse = data?.inverseOpId ? await store.get(data.inverseOpId) : null;
  check(inverse?.author === 'ai', '逆操作 author 应为 ai');
  check(inverse?.rollbackScope === 'operation', '逆操作 scope 应为 operation');

  // 6. list_operations 优先用注入的 store（含上面的逆操作），缺省回退内存 store。
  const listed = await registry.run(
    'list_operations',
    {},
    { workspaceIndex: fakeIndex, mode: 'fullPermission', operationLogStore: store }
  );
  check(listed.ok, 'list_operations 应成功');
  const listedData = listed.ok ? listed.data as { history: Array<{ opId: string }> } : null;
  check(listedData?.history.length === 2, `注入 store 应列出 2 条（原操作+逆操作），实际 ${listedData?.history.length}`);

  if (failures.length > 0) {
    throw new Error(`AI rollback tool smoke 失败 ${failures.length} 项：\n- ${failures.join('\n- ')}`);
  }
  console.log(JSON.stringify({
    ok: true,
    message: 'AI rollback_operation 工具接通验证通过（生产上下文注入 / 凭据防线 / 真实逆向事务）',
    checks,
    inverseOpId: data?.inverseOpId
  }, null, 2));
}

function textEdit(targetUri: string, targetPath: string, before: string, after: string) {
  return {
    id: targetUri.endsWith('first.txt') ? 'edit-first' : 'edit-second',
    kind: 'text_edit' as const,
    targetUri,
    targetPath,
    newText: after,
    expectedHash: createHash('sha256').update(before).digest('hex'),
    preconditions: [{ type: 'content_hash' as const, description: '源文件哈希必须匹配' }],
    validatorRequirements: [{ validatorId: 'text_non_empty', scope: 'staged_output' as const, required: true }],
    riskLevel: 'low' as const
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
