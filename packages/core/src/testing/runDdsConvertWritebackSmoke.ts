/**
 * Real path: encode RGBA → DDS → stage → PatchIR writeback → reread DDS magic/hash.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';
import { convertRgbaToDdsAndWriteback } from '../assets/convertAndWriteback.js';
import { isDdsBuffer } from '../assets/pngToDds.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { createConfirmationReceipt } from '../patch/writerContract.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';

function main(): Promise<void> {
  return withSmokeWorkspace('dds-convert', (workspace) => mainInWorkspace(workspace.root));
}

async function mainInWorkspace(root: string): Promise<void> {
  const overlay = join(root, 'mod');
  const staging = join(root, 'staging');
  await mkdir(join(overlay, 'parts', 'tex'), { recursive: true });
  await mkdir(staging, { recursive: true });

  const targetPath = join(overlay, 'parts', 'tex', 'solid.dds');
  const original = Buffer.from('PLACEHOLDER-TARGET-NOT-DDS-YET');
  await writeFile(targetPath, original);
  const expectedHash = createHash('sha256').update(original).digest('hex');

  const session = await openWorkspaceSession({ overlayRoot: overlay, game: 'sekiro' });
  const store = new MemoryOperationLogStore();
  const confirmation = createConfirmationReceipt({
    subjects: [`ASSET_IMPORT:${targetPath}`],
    riskLevel: 'high',
    note: 'dds convert writeback smoke'
  });

  const result = await convertRgbaToDdsAndWriteback({
    workspaceId: session.meta.workspaceId,
    stagingRoot: staging,
    targetAssetUri: 'file://parts/tex/solid.dds',
    targetAbsolutePath: targetPath,
    expectedTargetHash: expectedHash,
    confirmationReceiptId: confirmation.id,
    conversionRuleId: 'sekiro.dds.from-rgba',
    image: { solid: { width: 4, height: 4, r: 32, g: 64, b: 128, a: 255 } },
    title: 'RGBA→DDS 写回 smoke'
    // 提交会建还原点；不指定 backupBaseDir 时它落系统临时目录且有意保留，无人清理。
    // 实测：改用 harness 后静态门禁已判干净，运行期仍每次残留一个 soulforge-backup-*。
  }, { session, operationLog: store, backupBaseDir: join(root, 'backups') });

  if (!result.ok) throw new Error(`convert writeback failed: ${JSON.stringify(result.diagnostics)}`);
  const after = await readFile(targetPath);
  if (!isDdsBuffer(after)) throw new Error('target is not DDS after writeback');
  if (createHash('sha256').update(after).digest('hex') !== result.ddsHash) {
    throw new Error('dds hash mismatch after commit');
  }
  // header width/height
  if (after.readUInt32LE(12) !== 4 || after.readUInt32LE(16) !== 4) {
    throw new Error('dds dimensions wrong');
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'RGBA→DDS 编码并经 PatchIR 写回验证通过',
    ddsHash: result.ddsHash,
    opId: result.opId,
    byteLength: after.length,
    magic: after.subarray(0, 4).toString('ascii')
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
