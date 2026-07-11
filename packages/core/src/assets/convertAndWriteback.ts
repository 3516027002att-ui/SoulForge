/**
 * Open-format → native-ish DDS conversion then PatchIR writeback.
 * Current production conversion: raw RGBA / solid → uncompressed A8R8G8B8 DDS.
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Diagnostic } from '@soulforge/shared';
import { encodeRawRgba8ToDds, encodeSolidRgbaDds, type RawRgbaImage } from './pngToDds.js';
import { commitAssetImportThroughPatchIr } from './assetImportWriteback.js';
import type { ExecutePatchIrOptions } from '../patch/durablePatchCommit.js';

export interface ConvertRgbaToDdsWritebackRequest {
  workspaceId: string;
  stagingRoot: string;
  targetAssetUri: string;
  targetAbsolutePath: string;
  expectedTargetHash: string;
  confirmationReceiptId: string;
  conversionRuleId: string;
  image: RawRgbaImage | { solid: { width: number; height: number; r: number; g: number; b: number; a?: number } };
  title?: string;
}

export async function convertRgbaToDdsAndWriteback(
  request: ConvertRgbaToDdsWritebackRequest,
  transactionOptions: ExecutePatchIrOptions
): Promise<{
  ok: boolean;
  ddsHash?: string;
  opId?: string;
  changedFiles: string[];
  diagnostics: Diagnostic[];
}> {
  const encoded = 'solid' in request.image
    ? encodeSolidRgbaDds(request.image.solid)
    : encodeRawRgba8ToDds(request.image);

  if (encoded.dds.subarray(0, 4).toString('ascii') !== 'DDS ') {
    return {
      ok: false,
      changedFiles: [],
      diagnostics: [{ severity: 'error', code: 'DDS_ENCODE_FAILED', message: 'DDS 编码结果无魔数。' }]
    };
  }

  const sourceDir = join(request.stagingRoot, 'converted-source');
  await mkdir(sourceDir, { recursive: true });
  // Stage as .dds source so import format detection accepts DDS magic path.
  const sourcePath = join(sourceDir, `${createHash('sha256').update(encoded.dds).digest('hex').slice(0, 12)}.dds`);
  await writeFile(sourcePath, encoded.dds);

  const committed = await commitAssetImportThroughPatchIr({
    sourcePath,
    sourceBytes: encoded.dds,
    targetAssetUri: request.targetAssetUri,
    conversionRuleId: request.conversionRuleId,
    stagingRoot: request.stagingRoot,
    workspaceId: request.workspaceId,
    targetAbsolutePath: request.targetAbsolutePath,
    expectedTargetHash: request.expectedTargetHash,
    confirmationReceiptId: request.confirmationReceiptId,
    title: request.title ?? 'RGBA→DDS 转换写回'
  }, transactionOptions);

  return {
    ok: committed.ok,
    ddsHash: encoded.contentHash,
    ...(committed.opId ? { opId: committed.opId } : {}),
    changedFiles: committed.changedFiles,
    diagnostics: committed.diagnostics
  };
}
