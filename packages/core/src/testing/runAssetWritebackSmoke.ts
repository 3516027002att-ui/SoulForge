/**
 * Real path: stage PNG → PatchIR file_replace into temp Mod overlay → reread hash.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';
import { commitAssetImportThroughPatchIr } from '../assets/assetImportWriteback.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { createConfirmationReceipt } from '../patch/writerContract.js';

function main(): Promise<void> {
  return withSmokeWorkspace('asset-writeback', (workspace) => mainInWorkspace(workspace.root));
}

async function mainInWorkspace(root: string): Promise<void> {
  const overlay = join(root, 'mod');
  const staging = join(root, 'staging');
  const sourceDir = join(root, 'source');
  await mkdir(join(overlay, 'parts', 'tex'), { recursive: true });
  await mkdir(staging, { recursive: true });
  await mkdir(sourceDir, { recursive: true });

  const targetPath = join(overlay, 'parts', 'tex', 'pixel.dds');
  const original = Buffer.from('FAKE-DDS-PLACEHOLDER-ORIGINAL-BYTES-0001');
  await writeFile(targetPath, original);
  const expectedHash = sha256(original);

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('SoulForge-import-png-payload')
  ]);
  const pngPath = join(sourceDir, 'pixel.png');
  await writeFile(pngPath, png);

  const session = await openWorkspaceSession({ overlayRoot: overlay, game: 'sekiro' });
  const store = new MemoryOperationLogStore();
  const confirmation = createConfirmationReceipt({
    subjects: [`ASSET_IMPORT:${targetPath}`],
    riskLevel: 'high',
    note: 'asset writeback smoke'
  });

  const result = await commitAssetImportThroughPatchIr({
    sourcePath: pngPath,
    targetAssetUri: 'file://parts/tex/pixel.dds',
    conversionRuleId: 'sekiro.dds.from-png',
    stagingRoot: staging,
    workspaceId: session.meta.workspaceId,
    targetAbsolutePath: targetPath,
    expectedTargetHash: expectedHash,
    confirmationReceiptId: confirmation.id,
    title: 'PNG 导入写回 smoke'
    // 提交会建还原点；不指定 backupBaseDir 时它落系统临时目录且有意保留，无人清理。
    // 实测：改用 harness 后静态门禁已判干净，运行期仍每次残留一个 soulforge-backup-*。
  }, { session, operationLog: store, backupBaseDir: join(root, 'backups') });

  if (!result.ok) {
    throw new Error(`writeback failed: ${JSON.stringify(result.diagnostics)}`);
  }
  const after = await readFile(targetPath);
  if (!after.equals(png)) {
    throw new Error('target file was not replaced with staged import bytes');
  }
  if (sha256(after) !== result.contentHash) {
    throw new Error('committed content hash mismatch');
  }

  // Hash gate: stale expected hash must fail
  const stale = await commitAssetImportThroughPatchIr({
    sourcePath: pngPath,
    targetAssetUri: 'file://parts/tex/pixel.dds',
    conversionRuleId: 'sekiro.dds.from-png',
    stagingRoot: staging,
    workspaceId: session.meta.workspaceId,
    targetAbsolutePath: targetPath,
    expectedTargetHash: expectedHash, // original hash, file already changed
    confirmationReceiptId: confirmation.id
    // 本段预期 hash 门拦下、不落还原点；仍显式指定，避免将来改成可通过时重新泄漏。
  }, { session, operationLog: store, backupBaseDir: join(root, 'backups') });
  if (stale.ok) throw new Error('stale hash writeback must fail');

  console.log(JSON.stringify({
    ok: true,
    message: '资产导入 → PatchIR 写回闭环验证通过',
    importId: result.importId,
    opId: result.opId,
    contentHash: result.contentHash,
    changedFiles: result.changedFiles.length,
    staleRejected: true
  }, null, 2));
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
