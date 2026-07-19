import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPatchIr } from '../patch-engine/patchIr.js';
import { executePatchIrThroughTransaction } from '../patch/durablePatchCommit.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { rollbackFile } from '../patch/rollback.js';
import { createConfirmationReceipt } from '../patch/writerContract.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-file-rollback-'));
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
    title: '文件级回滚验证',
    author: 'user',
    operations: [
      textEdit('file://first.txt', firstPath, 'first-before\n', 'first-after\n'),
      textEdit('file://second.txt', secondPath, 'second-before\n', 'second-after\n')
    ]
  });
  const committed = await executePatchIrThroughTransaction(patch, { session, operationLog: store });
  if (!committed.operation || committed.changedFiles.length !== 2) throw new Error('Two-file commit failed.');

  const rolled = await rollbackFile({
    opId: committed.opId,
    targetUri: 'file://first.txt',
    store,
    session,
    confirmation: createConfirmationReceipt({
      subjects: [`ROLLBACK_FILE:${committed.opId}:file://first.txt`],
      riskLevel: 'high',
      note: 'file rollback smoke'
    })
  });
  if (!rolled.ok || rolled.restoredFiles.length !== 1) {
    throw new Error(`File rollback failed: ${JSON.stringify(rolled.diagnostics)}`);
  }
  if (await readFile(firstPath, 'utf8') !== 'first-before\n') throw new Error('Selected file was not restored.');
  if (await readFile(secondPath, 'utf8') !== 'second-after\n') throw new Error('Unselected file was mutated.');
  if (rolled.record?.rollbackScope !== 'file' || rolled.record.files[0]?.targetUri !== 'file://first.txt') {
    throw new Error('File rollback inverse record lost its scope or target.');
  }
  console.log(JSON.stringify({
    ok: true,
    message: '文件级逆向 PatchIR 回滚验证通过',
    originalOpId: committed.opId,
    inverseOpId: rolled.inverseOpId,
    restoredFiles: rolled.restoredFiles.length
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
    validatorRequirements: [{ validatorId: 'text_file', scope: 'staged_output' as const, required: true }],
    riskLevel: 'low' as const
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
