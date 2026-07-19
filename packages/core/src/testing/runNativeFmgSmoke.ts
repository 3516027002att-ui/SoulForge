/**
 * Native FMG smoke: extract real msgbnd child → lossless read/roundtrip →
 * mutate via write-fmg staging → reread → restore via inverse mutation.
 * Also exercises BND4 child replace of rebuilt FMG bytes through PatchIR.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { createPatchIr } from '../patch-engine/patchIr.js';
import { executePatchIrThroughTransaction } from '../patch/durablePatchCommit.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { rollbackOperation } from '../patch/rollback.js';
import { createConfirmationReceipt } from '../patch/writerContract.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { resolveNativeFixturePath } from './nativeFixturePaths.js';

interface FmgEnvelope {
  sourceHash: string;
  entryCount: number;
  groupCount: number;
  entries: Array<{ id: number; text: string }>;
  roundTrip?: { semanticIdentical: boolean; byteIdentical: boolean };
}

interface Bnd4ChildSnapshot {
  contentBase64: string;
  contentHash: string;
  name: string;
  id: number;
  index: number;
}

async function main(): Promise<void> {
  const sourceMsgbnd = await resolveNativeFixturePath(
    'msg/zhocn/item.msgbnd.dcx',
    2,
    'SOULFORGE_NATIVE_FIXTURE_FMG'
  );
  const sourceRoot = dirname(sourceMsgbnd);
  const root = await mkdtemp(join(tmpdir(), 'soulforge-native-fmg-'));
  const overlay = join(root, 'mod');
  const staging = join(root, 'staging');
  await mkdir(join(overlay, 'msg', 'zhocn'), { recursive: true });
  await mkdir(staging, { recursive: true });
  const msgbndPath = join(overlay, 'msg', 'zhocn', 'item.msgbnd.dcx');
  await copyFile(sourceMsgbnd, msgbndPath);

  // 1) Snapshot first FMG child from real msgbnd
  const child = await runBridge<Bnd4ChildSnapshot>({
    command: 'snapshot-bnd4-child',
    filePath: msgbndPath,
    allowedRoots: [overlay],
    timeoutMs: 60_000,
    commandOptions: { entryIndex: 1 } // 武器名.fmg — has real Chinese strings
  });
  if (!child.data?.contentBase64) throw new Error(`snapshot failed: ${JSON.stringify(child.diagnostics)}`);
  const fmgPath = join(overlay, 'msg', 'zhocn', 'weapon_names.fmg');
  const originalFmg = Buffer.from(child.data.contentBase64, 'base64');
  await writeFile(fmgPath, originalFmg);

  // 2) Read + semantic roundtrip
  const read = await runBridge<FmgEnvelope>({
    command: 'read-fmg-document',
    filePath: fmgPath,
    allowedRoots: [overlay],
    timeoutMs: 60_000
  });
  if (read.parseStatus === 'failed' || !read.data) {
    throw new Error(`FMG read failed: ${JSON.stringify(read.diagnostics)}`);
  }
  if (!read.data.roundTrip?.semanticIdentical) {
    throw new Error(`FMG semantic roundtrip failed: ${JSON.stringify(read.data.roundTrip)}`);
  }
  const editable = read.data.entries.find((e) => e.text && e.text !== '<?null?>' && e.text.length > 0);
  if (!editable) throw new Error('No editable FMG entry found.');

  // 3) write-fmg staging mutation
  const stagedFmg = join(staging, 'weapon_names.fmg');
  const newText = `${editable.text}·SoulForge`;
  const written = await runBridge<{ outputHash: string; rereadVerified: boolean }>({
    command: 'write-fmg',
    filePath: fmgPath,
    allowedRoots: [overlay, staging],
    writableRoots: [staging],
    timeoutMs: 60_000,
    commandOptions: {
      outputPath: stagedFmg,
      expectedDocumentHash: read.data.sourceHash,
      mutation: 'upsert',
      id: editable.id,
      text: newText
    }
  });
  if (!written.diagnostics.some((d) => d.code === 'FMG_STAGING_WRITE_VERIFIED')) {
    throw new Error(`FMG write failed: ${JSON.stringify(written.diagnostics)}`);
  }
  const stagedBytes = await readFile(stagedFmg);
  const stagedRead = await runBridge<FmgEnvelope>({
    command: 'read-fmg-document',
    filePath: stagedFmg,
    allowedRoots: [staging],
    timeoutMs: 60_000
  });
  const stagedEntry = stagedRead.data?.entries.find((e) => e.id === editable.id);
  if (stagedEntry?.text !== newText) {
    throw new Error(`Staged FMG text mismatch: ${JSON.stringify(stagedEntry)}`);
  }

  // 4) Commit rebuilt FMG back into msgbnd via native BND4 replace + resource-entry inverse
  const session = await openWorkspaceSession({ overlayRoot: overlay, game: 'sekiro' });
  const store = new MemoryOperationLogStore();
  const containerHash = sha256(await readFile(msgbndPath));
  const targetUri = 'file://msg/zhocn/item.msgbnd.dcx';
  const patch = createPatchIr({
    workspaceId: session.meta.workspaceId,
    title: 'FMG 语义修改经 BND4 容器提交',
    author: 'user',
    operations: [{
      id: 'fmg-via-bnd4-replace',
      kind: 'container_child_replace',
      targetUri,
      targetPath: msgbndPath,
      resourceKind: 'msg',
      containerUri: targetUri,
      childPath: child.data.name,
      childContentBase64: stagedBytes.toString('base64'),
      expectedContainerHash: containerHash,
      expectedHash: containerHash,
      expectedChildHash: child.data.contentHash,
      containerFormat: 'BND4_DFLT',
      preconditions: [{
        type: 'content_hash',
        description: 'msgbnd hash',
        expectedHash: containerHash,
        targetUri
      }],
      validatorRequirements: [
        { validatorId: 'container_roundtrip', scope: 'staged_output', required: true },
        { validatorId: 'file_risk', scope: 'before_staging', required: true }
      ],
      riskLevel: 'high',
      metadata: {
        nativeFormatAuthority: true,
        nativeEntryIndex: child.data.index,
        nativeEntryId: child.data.id,
        requiresConfirmation: true,
        confirmationReceiptId: 'fmg-bnd4-smoke',
        fmgEntryId: editable.id
      }
    }]
  });
  const committed = await executePatchIrThroughTransaction(patch, { session, operationLog: store });
  if (!committed.operation) {
    throw new Error(`BND4 FMG commit failed: ${JSON.stringify(committed.diagnostics)}`);
  }

  // 5) Reread child FMG from committed msgbnd
  const afterChild = await runBridge<Bnd4ChildSnapshot>({
    command: 'snapshot-bnd4-child',
    filePath: msgbndPath,
    allowedRoots: [overlay],
    timeoutMs: 60_000,
    commandOptions: { entryIndex: child.data.index }
  });
  const afterFmgPath = join(staging, 'after.fmg');
  await writeFile(afterFmgPath, Buffer.from(afterChild.data!.contentBase64, 'base64'));
  const afterRead = await runBridge<FmgEnvelope>({
    command: 'read-fmg-document',
    filePath: afterFmgPath,
    allowedRoots: [staging],
    timeoutMs: 60_000
  });
  if (afterRead.data?.entries.find((e) => e.id === editable.id)?.text !== newText) {
    throw new Error('Committed msgbnd FMG child did not contain mutation.');
  }

  // 6) Operation rollback restores original msgbnd bytes
  const rolled = await rollbackOperation({
    opId: committed.opId,
    store,
    session,
    confirmation: createConfirmationReceipt({
      subjects: [`ROLLBACK_OPERATION:${committed.opId}`],
      riskLevel: 'high',
      note: 'fmg native smoke'
    })
  });
  if (!rolled.ok || !(await readFile(msgbndPath)).equals(await readFile(sourceMsgbnd))) {
    throw new Error(`FMG container rollback failed: ${JSON.stringify(rolled.diagnostics)}`);
  }

  // 7) Corpus: all FMG children in item.msgbnd semantic roundtrip
  const container = await runBridge<{ nested?: { entryCount: number } }>({
    command: 'read-dcx-document',
    filePath: sourceMsgbnd,
    allowedRoots: [sourceRoot],
    timeoutMs: 60_000
  });
  const count = container.data?.nested?.entryCount ?? 0;
  let fmgVerified = 0;
  for (let i = 0; i < count; i++) {
    const snap = await runBridge<Bnd4ChildSnapshot>({
      command: 'snapshot-bnd4-child',
      filePath: sourceMsgbnd,
      allowedRoots: [sourceRoot],
      timeoutMs: 60_000,
      commandOptions: { entryIndex: i }
    });
    const bytes = Buffer.from(snap.data!.contentBase64, 'base64');
    // FMG v2 marker
    if (bytes.length < 0x28 || bytes.readUInt32LE(0) !== 0x00020000) continue;
    const tmp = join(staging, `corpus-${i}.fmg`);
    await writeFile(tmp, bytes);
    const doc = await runBridge<FmgEnvelope>({
      command: 'read-fmg-document',
      filePath: tmp,
      allowedRoots: [staging],
      timeoutMs: 60_000
    });
    if (!doc.data?.roundTrip?.semanticIdentical) {
      throw new Error(`Corpus FMG ${i} semantic roundtrip failed: ${JSON.stringify(doc.diagnostics)}`);
    }
    fmgVerified += 1;
  }

  console.log(JSON.stringify({
    ok: true,
    message: '原生 FMG 读取/语义往返/写入/BND4 提交/回滚验证通过',
    entryCount: read.data.entryCount,
    groupCount: read.data.groupCount,
    mutatedId: editable.id,
    byteIdenticalNoop: read.data.roundTrip?.byteIdentical ?? false,
    semanticIdenticalNoop: true,
    corpusFmgVerified: fmgVerified,
    containerEntries: count
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
