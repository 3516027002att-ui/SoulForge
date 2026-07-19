/**
 * Asset import → PatchIR writeback.
 * Stages open-format bytes, then commits them into the Mod overlay only through
 * the existing durable PatchIR / WorkspaceTransaction path (file_replace).
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Diagnostic, PatchIR } from '@soulforge/shared';
import { stageAssetImport, type AssetImportRequest } from './assetImport.js';
import { createPatchIr } from '../patch-engine/patchIr.js';
import {
  executePatchIrThroughTransaction,
  type ExecutePatchIrOptions
} from '../patch/durablePatchCommit.js';

export interface AssetImportWritebackRequest extends AssetImportRequest {
  workspaceId: string;
  targetAbsolutePath: string;
  expectedTargetHash: string;
  confirmationReceiptId: string;
  title?: string;
}

export interface AssetImportWritebackResult {
  ok: boolean;
  importId: string;
  stagingPath: string;
  contentHash?: string;
  opId?: string;
  changedFiles: string[];
  diagnostics: Diagnostic[];
}

/**
 * Stage open-format source, then replace the target overlay file via PatchIR.
 * Does not invent native FLVER/MTD conversion — only file_replace of staged bytes.
 */
export async function commitAssetImportThroughPatchIr(
  request: AssetImportWritebackRequest,
  transactionOptions: ExecutePatchIrOptions
): Promise<AssetImportWritebackResult> {
  const staged = await stageAssetImport(request);
  if (!staged.ok) {
    return {
      ok: false,
      importId: staged.plan.importId,
      stagingPath: staged.stagingPath,
      changedFiles: [],
      diagnostics: staged.diagnostics.map((d) => ({
        severity: d.severity,
        code: String(d.code),
        message: d.message,
        ...(d.targetUri ? { sourceUri: d.targetUri } : {})
      }))
    };
  }

  const stagedBytes = await readFile(staged.stagingPath);
  const hash = (await import('node:crypto')).createHash('sha256').update(stagedBytes).digest('hex');
  if (hash !== staged.contentHash) {
    return {
      ok: false,
      importId: staged.plan.importId,
      stagingPath: staged.stagingPath,
      changedFiles: [],
      diagnostics: [{
        severity: 'error',
        code: 'ASSET_STAGING_HASH_MISMATCH',
        message: 'staged asset hash mismatch before PatchIR writeback'
      }]
    };
  }

  const opId = randomUUID();
  const patch: PatchIR = createPatchIr({
    workspaceId: request.workspaceId,
    title: request.title ?? `资产导入写回 ${staged.plan.format} → ${request.targetAssetUri}`,
    author: 'user',
    operations: [{
      id: opId,
      kind: 'file_replace',
      riskLevel: 'high',
      targetUri: request.targetAssetUri,
      targetPath: request.targetAbsolutePath,
      newContentBase64: stagedBytes.toString('base64'),
      expectedHash: request.expectedTargetHash,
      allowEmpty: stagedBytes.length === 0,
      preconditions: [{
        type: 'content_hash',
        description: 'Target hash must match before asset import writeback',
        expectedHash: request.expectedTargetHash,
        targetUri: request.targetAssetUri
      }, {
        type: 'overlay_writable',
        description: 'Target must be on overlay / sandbox workspace',
        targetUri: request.targetAssetUri
      }],
      validatorRequirements: [
        { validatorId: 'whole_file_replace', scope: 'before_staging', required: true },
        { validatorId: 'file_risk', scope: 'before_staging', required: true }
      ],
      requiresConfirmation: true,
      metadata: {
        requiresConfirmation: true,
        confirmationReceiptId: request.confirmationReceiptId,
        assetImportId: staged.plan.importId,
        assetImportFormat: staged.plan.format,
        conversionRuleId: request.conversionRuleId,
        nativeFormatAuthority: false
      }
    }]
  });

  const committed = await executePatchIrThroughTransaction(patch, transactionOptions);
  const ok = committed.changedFiles.length > 0
    && committed.diagnostics.every((d) => d.severity !== 'error');

  return {
    ok,
    importId: staged.plan.importId,
    stagingPath: staged.stagingPath,
    contentHash: staged.contentHash,
    opId: committed.opId,
    changedFiles: committed.changedFiles,
    diagnostics: [
      ...staged.diagnostics.map((d) => ({
        severity: d.severity,
        code: String(d.code),
        message: d.message,
        ...(d.targetUri ? { sourceUri: d.targetUri } : {})
      })),
      ...committed.diagnostics
    ]
  };
}
