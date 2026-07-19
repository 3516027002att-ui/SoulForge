/**
 * Real path: stage valid PNG → PatchIR file_replace into temp Mod overlay → reread hash.
 * Staging still preserves source open-format bytes; native conversion is covered by
 * open-format convert / dds-convert smokes.
 */
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitAssetImportThroughPatchIr } from '../assets/assetImportWriteback.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { createConfirmationReceipt } from '../patch/writerContract.js';

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function validPng1x1(): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.from([0x00, 0xff, 0x00, 0x80]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-asset-writeback-'));
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

  const png = validPng1x1();
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
    conversionRuleId: 'open-format.png.stage',
    stagingRoot: staging,
    workspaceId: session.meta.workspaceId,
    targetAbsolutePath: targetPath,
    expectedTargetHash: expectedHash,
    confirmationReceiptId: confirmation.id,
    title: 'asset import writeback smoke'
  }, {
    session,
    workspaceRoot: overlay,
    operationLog: store,
    actorId: 'asset-writeback-smoke'
  });

  if (!result.ok) {
    throw new Error(`writeback failed: ${JSON.stringify(result.diagnostics)}`);
  }
  const after = await readFile(targetPath);
  if (sha256(after) !== result.contentHash) {
    throw new Error('overlay hash mismatch after asset import writeback');
  }
  if (!Buffer.compare(after, png) === false && Buffer.compare(after, png) !== 0) {
    // explicit compare
  }
  if (Buffer.compare(after, png) !== 0) {
    throw new Error('overlay should contain staged open-format PNG bytes for stage-path writeback');
  }

  const stale = await commitAssetImportThroughPatchIr({
    sourcePath: pngPath,
    targetAssetUri: 'file://parts/tex/pixel.dds',
    conversionRuleId: 'open-format.png.stage',
    stagingRoot: staging,
    workspaceId: session.meta.workspaceId,
    targetAbsolutePath: targetPath,
    expectedTargetHash: expectedHash,
    confirmationReceiptId: confirmation.id
  }, {
    session,
    workspaceRoot: overlay,
    operationLog: store,
    actorId: 'asset-writeback-smoke-stale'
  });
  if (stale.ok) {
    throw new Error('stale hash writeback must fail');
  }

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

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
