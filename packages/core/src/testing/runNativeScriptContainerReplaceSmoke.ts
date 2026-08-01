/**
 * Native script-container whole-inner-file replacement smoke against a real
 * luabnd (DCX DFLT + BND4) container.
 *
 * Verifies the V0.5 SCOPE-BEHAVIOR-SCRIPT writer path end-to-end:
 *   snapshot real inner entry -> replace via Bridge native write-bnd4 staging
 *   -> PatchIR container_child_replace -> WorkspaceTransaction commit -> reread
 *   -> operation-level rollback restores original bytes byte-identically.
 *
 * The replacement bytes are treated as user-provided (SoulForge never
 * generates/compiles bytecode); we use a marker payload of the SAME length as
 * the original inner entry so the container layout stays valid. The container
 * is copied to a temp overlay; the original Mod file is never touched.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPatchIr } from '../patch-engine/patchIr.js';
import { executePatchIrThroughTransaction } from '../patch/durablePatchCommit.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { rollbackOperation } from '../patch/rollback.js';
import { createConfirmationReceipt } from '../patch/writerContract.js';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';

interface Envelope {
  sourceHash: string;
  nested?: {
    entryCount: number;
    entries: Array<{ id: number; name: string; contentHash: string; index: number }>;
  };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function main(): Promise<void> {
  const source = await resolveNativeFixture(
    process.argv[2],
    'luabnd-primary',
    '../../mods/script/aicommon.luabnd.dcx'
  );
  const root = await mkdtemp(join(tmpdir(), 'soulforge-native-script-replace-'));
  const overlay = join(root, 'mod');
  await mkdir(join(overlay, 'script'), { recursive: true });
  const target = join(overlay, 'script', 'aicommon.luabnd.dcx');
  await copyFile(source, target);
  const original = await readFile(target);
  const expectedHash = sha256(original);
  const session = await openWorkspaceSession({ overlayRoot: overlay, game: 'sekiro' });
  const store = new MemoryOperationLogStore();
  const targetUri = 'file://script/aicommon.luabnd.dcx';

  const baseline = await runBridge<Envelope>({
    command: 'read-dcx-document',
    filePath: target,
    allowedRoots: [overlay],
    timeoutMs: 60_000
  });
  const first = baseline.data?.nested?.entries[0];
  if (!first || !baseline.data?.nested) throw new Error('luabnd baseline entry missing.');
  if (!first.name.toLowerCase().endsWith('.lua') && !first.name.toLowerCase().endsWith('.hks')) {
    throw new Error(`Unexpected first inner entry (expected script): ${first.name}`);
  }

  // User-provided replacement: same-length marker payload (SoulForge does not
  // generate or compile bytecode; the bytes come from the user side).
  const originalInner = await runBridge<{ contentBase64?: string }>({
    command: 'snapshot-bnd4-child',
    filePath: target,
    allowedRoots: [overlay],
    timeoutMs: 60_000,
    commandOptions: { entryIndex: first.index }
  });
  if (!originalInner.data?.contentBase64) {
    throw new Error(`snapshot failed: ${JSON.stringify(originalInner.diagnostics)}`);
  }
  const originalBytes = Buffer.from(originalInner.data.contentBase64, 'base64');
  const marker = Buffer.from('SoulForge-user-replace-\x00\x00\x00\x00\x00\x00\x00\x00');
  const replacement = Buffer.alloc(originalBytes.length);
  marker.copy(replacement, 0, 0, Math.min(marker.length, replacement.length));

  const patch = createPatchIr({
    workspaceId: session.meta.workspaceId,
    title: '真实 luabnd 整内层文件替换（用户提供字节）',
    author: 'user',
    operations: [{
      id: 'native-script-inner-replace',
      kind: 'container_child_replace',
      targetUri,
      targetPath: target,
      resourceKind: 'other',
      containerUri: targetUri,
      childPath: first.name,
      childContentBase64: replacement.toString('base64'),
      expectedContainerHash: expectedHash,
      expectedHash,
      expectedChildHash: first.contentHash,
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
        nativeEntryIndex: first.index,
        nativeEntryId: first.id,
        requiresConfirmation: true,
        confirmationReceiptId: 'native-script-inner-replace-smoke'
      }
    }]
  });

  const committed = await executePatchIrThroughTransaction(patch, { session, operationLog: store });
  if (!committed.operation || committed.changedFiles.length !== 1) {
    throw new Error(`Script container replace failed: ${JSON.stringify(committed.diagnostics)}`);
  }

  const after = await runBridge<Envelope>({
    command: 'read-dcx-document',
    filePath: target,
    allowedRoots: [overlay],
    timeoutMs: 60_000
  });
  const replacedEntry = after.data?.nested?.entries[0];
  if (!replacedEntry || replacedEntry.contentHash === first.contentHash) {
    throw new Error('luabnd inner replace did not survive reread.');
  }
  if (after.data?.nested?.entryCount !== baseline.data.nested.entryCount) {
    throw new Error('luabnd inner replace changed entry count.');
  }

  const rolled = await rollbackOperation({
    opId: committed.opId,
    store,
    session,
    confirmation: createConfirmationReceipt({
      subjects: [`ROLLBACK_OPERATION:${committed.opId}`],
      riskLevel: 'high',
      note: 'native script container replace smoke'
    })
  });
  if (!rolled.ok || !(await readFile(target)).equals(original)) {
    throw new Error(`Script container rollback failed: ${JSON.stringify(rolled.diagnostics)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    message: '真实 luabnd 整内层文件替换 → Bridge 重读 → operation 回滚验证通过',
    containerEntries: baseline.data.nested.entryCount,
    innerEntry: first.name,
    originalChildHash: first.contentHash,
    rereadVerified: true,
    entryCountUnchanged: true,
    rollbackByteIdentical: true,
    replacementProvidedByUser: true,
    bytecodeNotGenerated: true
  }, null, 2));
  await disposeBridgeDaemonPool();
}

main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
