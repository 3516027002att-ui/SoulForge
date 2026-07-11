import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPatchIr } from '../patch-engine/patchIr.js';
import { executePatchIrThroughTransaction } from '../patch/durablePatchCommit.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { rollbackOperation, rollbackResourceEntry } from '../patch/rollback.js';
import { createConfirmationReceipt } from '../patch/writerContract.js';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';

interface Envelope {
  sourceHash: string;
  nested?: {
    entryCount: number;
    entries: Array<{ id: number; name: string; contentHash: string; index?: number }>;
  };
}

async function main(): Promise<void> {
  const source = resolve(process.argv[2] ?? '../../mods/chr/c0000.anibnd.dcx');
  const root = await mkdtemp(join(tmpdir(), 'soulforge-native-bnd4-transaction-'));
  const overlay = join(root, 'mod');
  await mkdir(join(overlay, 'chr'), { recursive: true });
  const target = join(overlay, 'chr', 'c0000.anibnd.dcx');
  await copyFile(source, target);
  const original = await readFile(target);
  const expectedHash = sha256(original);
  const session = await openWorkspaceSession({ overlayRoot: overlay, game: 'sekiro' });
  const store = new MemoryOperationLogStore();
  const targetUri = 'file://chr/c0000.anibnd.dcx';

  // --- Operation-level: add + full operation rollback ---
  const patch = createPatchIr({
    workspaceId: session.meta.workspaceId,
    title: '真实 BND4 新增子项事务验证',
    author: 'user',
    operations: [{
      id: 'native-bnd4-add',
      kind: 'container_child_add',
      targetUri,
      targetPath: target,
      resourceKind: 'chr',
      containerUri: targetUri,
      childPath: 'N:\\SoulForge\\transaction\\added.bin',
      newChildPath: 'N:\\SoulForge\\transaction\\added.bin',
      childContentBase64: Buffer.from('SoulForge-transaction-native-BND4').toString('base64'),
      expectedContainerHash: expectedHash,
      expectedHash,
      containerFormat: 'BND4_DFLT',
      preconditions: [{
        type: 'content_hash',
        description: '容器哈希必须匹配',
        expectedHash,
        targetUri
      }],
      validatorRequirements: [
        { validatorId: 'container_roundtrip', scope: 'staged_output', required: true },
        { validatorId: 'file_risk', scope: 'before_staging', required: true }
      ],
      riskLevel: 'high',
      metadata: {
        nativeFormatAuthority: true,
        nativeEntryId: 2_000_000_001,
        requiresConfirmation: true,
        confirmationReceiptId: 'native-bnd4-transaction-smoke'
      }
    }]
  });
  const before = await runBridge<Envelope>({
    command: 'read-dcx-document',
    filePath: target,
    allowedRoots: [overlay],
    timeoutMs: 60_000
  });
  const committed = await executePatchIrThroughTransaction(patch, { session, operationLog: store });
  if (!committed.operation || committed.changedFiles.length !== 1) {
    throw new Error(`Native BND4 transaction failed: ${JSON.stringify(committed.diagnostics)}`);
  }
  const entryChanges = await store.listResourceEntryChanges(committed.opId);
  if (entryChanges.length !== 1 || entryChanges[0]?.changeKind !== 'add') {
    throw new Error(`Expected add resource-entry inverse, got: ${JSON.stringify(entryChanges)}`);
  }
  const after = await runBridge<Envelope>({
    command: 'read-dcx-document',
    filePath: target,
    allowedRoots: [overlay],
    timeoutMs: 60_000
  });
  if (after.data?.nested?.entryCount !== (before.data?.nested?.entryCount ?? 0) + 1) {
    throw new Error('Committed BND4 add did not survive reread.');
  }
  const rolled = await rollbackOperation({
    opId: committed.opId,
    store,
    session,
    confirmation: createConfirmationReceipt({
      subjects: [`ROLLBACK_OPERATION:${committed.opId}`],
      riskLevel: 'high',
      note: 'native BND4 transaction smoke'
    })
  });
  if (!rolled.ok || !(await readFile(target)).equals(original)) {
    throw new Error(`Native BND4 rollback failed: ${JSON.stringify(rolled.diagnostics)}`);
  }

  const mutationResults: string[] = ['add'];
  const entryRollbackResults: string[] = [];

  for (const mutation of ['replace', 'delete', 'rename', 'move', 'add'] as const) {
    // Fresh copy for each mutation so original bytes are the baseline.
    await copyFile(source, target);
    const baseline = await runBridge<Envelope>({
      command: 'read-dcx-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000
    });
    const first = baseline.data?.nested?.entries[0];
    if (!first || !baseline.data?.nested) throw new Error('BND4 baseline entry missing.');

    const addName = 'N:\\SoulForge\\transaction\\entry-inverse.bin';
    const operation = mutation === 'add'
      ? {
          id: `native-bnd4-entry-${mutation}`,
          kind: 'container_child_add' as const,
          targetUri,
          targetPath: target,
          resourceKind: 'chr' as const,
          containerUri: targetUri,
          childPath: addName,
          newChildPath: addName,
          childContentBase64: Buffer.from('SoulForge-entry-inverse-add').toString('base64'),
          expectedContainerHash: baseline.data.sourceHash,
          expectedHash: baseline.data.sourceHash,
          containerFormat: 'BND4_DFLT',
          preconditions: [{
            type: 'content_hash' as const,
            description: '容器哈希必须匹配',
            expectedHash: baseline.data.sourceHash
          }],
          validatorRequirements: [
            { validatorId: 'container_roundtrip', scope: 'staged_output' as const, required: true },
            { validatorId: 'file_risk', scope: 'before_staging' as const, required: true }
          ],
          riskLevel: 'high' as const,
          metadata: {
            nativeFormatAuthority: true,
            nativeEntryId: 2_000_000_099,
            requiresConfirmation: true,
            confirmationReceiptId: `native-bnd4-entry-${mutation}-smoke`
          }
        }
      : {
          id: `native-bnd4-entry-${mutation}`,
          kind: `container_child_${mutation}` as const,
          targetUri,
          targetPath: target,
          resourceKind: 'chr' as const,
          containerUri: targetUri,
          childPath: first.name,
          expectedContainerHash: baseline.data.sourceHash,
          expectedHash: baseline.data.sourceHash,
          expectedChildHash: first.contentHash,
          containerFormat: 'BND4_DFLT',
          ...(mutation === 'replace'
            ? { childContentBase64: Buffer.from('SoulForge-native-replace').toString('base64') }
            : {}),
          ...(mutation === 'rename' ? { newChildPath: `${first.name}.renamed` } : {}),
          preconditions: [{
            type: 'content_hash' as const,
            description: '容器哈希必须匹配',
            expectedHash: baseline.data.sourceHash
          }],
          validatorRequirements: [
            { validatorId: 'container_roundtrip', scope: 'staged_output' as const, required: true },
            { validatorId: 'file_risk', scope: 'before_staging' as const, required: true }
          ],
          riskLevel: 'high' as const,
          metadata: {
            nativeFormatAuthority: true,
            nativeEntryIndex: 0,
            nativeEntryId: first.id,
            ...(mutation === 'move' ? { toIndex: 1 } : {}),
            requiresConfirmation: true,
            confirmationReceiptId: `native-bnd4-entry-${mutation}-smoke`
          }
        };

    const mutationPatch = createPatchIr({
      workspaceId: session.meta.workspaceId,
      title: `真实 BND4 ${mutation} 条目级逆操作验证`,
      author: 'user',
      operations: [operation]
    });
    const mutationCommit = await executePatchIrThroughTransaction(mutationPatch, {
      session,
      operationLog: store
    });
    if (!mutationCommit.operation) {
      throw new Error(`${mutation} transaction failed: ${JSON.stringify(mutationCommit.diagnostics)}`);
    }

    const recorded = await store.listResourceEntryChanges(mutationCommit.opId);
    if (recorded.length !== 1 || recorded[0]?.changeKind !== mutation) {
      throw new Error(
        `${mutation} missing resource-entry inverse: ${JSON.stringify(recorded)}`
      );
    }
    const entryUri = recorded[0]!.entryUri;

    const mutationRead = await runBridge<Envelope>({
      command: 'read-dcx-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000
    });
    const next = mutationRead.data?.nested;
    const verified = mutation === 'replace'
      ? next?.entries[0]?.contentHash !== first.contentHash
      : mutation === 'delete'
        ? next?.entryCount === baseline.data.nested.entryCount - 1
        : mutation === 'rename'
          ? next?.entries[0]?.name === `${first.name}.renamed`
          : mutation === 'move'
            ? next?.entries[1]?.id === first.id
            : next?.entryCount === baseline.data.nested.entryCount + 1;
    if (!verified) throw new Error(`${mutation} did not survive reread.`);

    const entryRollback = await rollbackResourceEntry({
      opId: mutationCommit.opId,
      entryUri,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_RESOURCE_ENTRY:${mutationCommit.opId}:${entryUri}`],
        riskLevel: 'high',
        note: `native BND4 ${mutation} resource-entry smoke`
      })
    });
    if (!entryRollback.ok) {
      throw new Error(
        `${mutation} resource-entry rollback failed: ${JSON.stringify(entryRollback.diagnostics)}`
      );
    }

    const restored = await runBridge<Envelope>({
      command: 'read-dcx-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000
    });
    if (mutation === 'delete') {
      // Entry-level delete inverse re-appends the preserved payload; content/id/name must match.
      const restoredEntry = restored.data?.nested?.entries.find((e) => e.id === first.id && e.name === first.name);
      if (!restoredEntry || restoredEntry.contentHash !== first.contentHash) {
        throw new Error('delete entry rollback did not restore entry payload.');
      }
    } else if (mutation === 'add') {
      if (restored.data?.nested?.entryCount !== baseline.data.nested.entryCount) {
        throw new Error('add entry rollback did not remove added child.');
      }
      if (restored.data?.nested?.entries.some((e) => e.name === addName)) {
        throw new Error('add entry rollback left added child name present.');
      }
    } else if (!(await readFile(target)).equals(await readFile(source).then((b) => b))) {
      // replace/rename/move should restore full container bytes from a single entry inverse
      // when only that entry changed relative to ordering/content.
      // rename/move may alter only names/order — compare semantic state:
      if (mutation === 'replace') {
        if (restored.data?.nested?.entries[0]?.contentHash !== first.contentHash) {
          throw new Error('replace entry rollback content mismatch.');
        }
      } else if (mutation === 'rename') {
        if (restored.data?.nested?.entries[0]?.name !== first.name) {
          throw new Error('rename entry rollback name mismatch.');
        }
      } else if (mutation === 'move') {
        if (restored.data?.nested?.entries[0]?.id !== first.id) {
          throw new Error('move entry rollback order mismatch.');
        }
      }
    }

    mutationResults.push(mutation);
    entryRollbackResults.push(mutation);
  }

  // Final operation-level pass for replace/delete/rename/move (byte-identical restore).
  for (const mutation of ['replace', 'delete', 'rename', 'move'] as const) {
    await copyFile(source, target);
    const baselineBytes = await readFile(target);
    const baseline = await runBridge<Envelope>({
      command: 'read-dcx-document',
      filePath: target,
      allowedRoots: [overlay],
      timeoutMs: 60_000
    });
    const first = baseline.data?.nested?.entries[0];
    if (!first || !baseline.data?.nested) throw new Error('BND4 baseline entry missing.');
    const operation = {
      id: `native-bnd4-op-${mutation}`,
      kind: `container_child_${mutation}` as const,
      targetUri,
      targetPath: target,
      resourceKind: 'chr' as const,
      containerUri: targetUri,
      childPath: first.name,
      expectedContainerHash: baseline.data.sourceHash,
      expectedHash: baseline.data.sourceHash,
      expectedChildHash: first.contentHash,
      containerFormat: 'BND4_DFLT',
      ...(mutation === 'replace'
        ? { childContentBase64: Buffer.from('SoulForge-native-replace').toString('base64') }
        : {}),
      ...(mutation === 'rename' ? { newChildPath: `${first.name}.renamed` } : {}),
      preconditions: [{
        type: 'content_hash' as const,
        description: '容器哈希必须匹配',
        expectedHash: baseline.data.sourceHash
      }],
      validatorRequirements: [
        { validatorId: 'container_roundtrip', scope: 'staged_output' as const, required: true },
        { validatorId: 'file_risk', scope: 'before_staging' as const, required: true }
      ],
      riskLevel: 'high' as const,
      metadata: {
        nativeFormatAuthority: true,
        nativeEntryIndex: 0,
        nativeEntryId: first.id,
        ...(mutation === 'move' ? { toIndex: 1 } : {}),
        requiresConfirmation: true,
        confirmationReceiptId: `native-bnd4-op-${mutation}-smoke`
      }
    };
    const mutationPatch = createPatchIr({
      workspaceId: session.meta.workspaceId,
      title: `真实 BND4 ${mutation} 事务验证`,
      author: 'user',
      operations: [operation]
    });
    const mutationCommit = await executePatchIrThroughTransaction(mutationPatch, {
      session,
      operationLog: store
    });
    if (!mutationCommit.operation) {
      throw new Error(`${mutation} operation transaction failed: ${JSON.stringify(mutationCommit.diagnostics)}`);
    }
    const mutationRollback = await rollbackOperation({
      opId: mutationCommit.opId,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_OPERATION:${mutationCommit.opId}`],
        riskLevel: 'high',
        note: `native BND4 ${mutation} smoke`
      })
    });
    if (!mutationRollback.ok || !(await readFile(target)).equals(baselineBytes)) {
      throw new Error(`${mutation} operation rollback failed.`);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    message: '真实 BND4 PatchIR → Bridge staging → WorkspaceTransaction → 重读 → operation/resource-entry 回滚验证通过',
    beforeEntries: before.data?.nested?.entryCount,
    afterEntries: after.data?.nested?.entryCount,
    rollbackByteIdentical: true,
    mutations: mutationResults,
    resourceEntryRollbacks: entryRollbackResults
  }, null, 2));
  await disposeBridgeDaemonPool();
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
