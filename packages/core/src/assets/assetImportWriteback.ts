/**
 * Asset import → PatchIR writeback.
 * Stages open-format bytes, then commits them into the Mod overlay only through
 * the existing durable PatchIR / WorkspaceTransaction path (file_replace).
 */

import { randomUUID } from 'node:crypto';
import type { Diagnostic, PatchIR } from '@soulforge/shared';
import { stageAssetImport, type AssetImportRequest } from './assetImport.js';
import { createPatchIr } from '../patch-engine/patchIr.js';
import { executePatchIrThroughTransaction, type ExecutePatchIrOptions } from '../patch/durablePatchCommit.js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export interface AssetImportWritebackRequest extends AssetImportRequest {
  workspaceId: string;
  /** Absolute path of the overlay file to replace (must already be resolved by session). */
  targetAbsolutePath: string;
  expectedTargetHash: string;
  confirmationReceiptId: string;
  title?: string;
}

export interface AssetImportWritebackResult {
  ok: boolean;
  importId?: string;
  stagingPath?: string;
  contentHash?: string;
  opId?: string;
  changedFiles: string[];
  diagnostics: Diagnostic[];
}

/**
 * Production entry: stage open-format asset, then PatchIR file_replace into overlay.
 * Does not bypass Patch Engine, hash checks, or confirmation metadata.
 */
export async function commitAssetImportThroughPatchIr(
  request: AssetImportWritebackRequest,
  transactionOptions: ExecutePatchIrOptions
): Promise<AssetImportWritebackResult> {
  const staged = await stageAssetImport(request);
  if (!staged.ok) {
    return {
      ok: false,
      changedFiles: [],
      diagnostics: staged.diagnostics.map((d) => ({
        severity: d.severity,
        code: d.code,
        message: d.message,
        ...(d.targetUri ? { sourceUri: d.targetUri } : {}),
        ...(d.details ? { details: d.details } : {})
      }))
    };
  }

  const stagedBytes = await readFile(staged.stagingPath);
  const stagedHash = createHash('sha256').update(stagedBytes).digest('hex');
  if (stagedHash !== staged.contentHash) {
    return {
      ok: false,
      importId: staged.plan.importId,
      stagingPath: staged.stagingPath,
      changedFiles: [],
      diagnostics: [{
        severity: 'error',
        code: 'ASSET_STAGING_HASH_MISMATCH',
        message: '暂存资产哈希与清单不一致，已阻止写回。'
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
      targetUri: request.targetAssetUri,
      targetPath: request.targetAbsolutePath,
      newContentBase64: stagedBytes.toString('base64'),
      expectedHash: request.expectedTargetHash,
      allowEmpty: stagedBytes.length === 0,
      requiresConfirmation: true,
      preconditions: [{
        type: 'content_hash',
        description: '写回前目标文件哈希必须匹配',
        expectedHash: request.expectedTargetHash,
        targetUri: request.targetAssetUri
      }],
      validatorRequirements: [
        { validatorId: 'whole_file_replace', scope: 'before_staging', required: true },
        { validatorId: 'whole_file_replace', scope: 'staged_output', required: true },
        { validatorId: 'file_risk', scope: 'before_staging', required: true }
      ],
      riskLevel: 'high',
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
        code: d.code,
        message: d.message,
        ...(d.targetUri ? { sourceUri: d.targetUri } : {})
      })),
      ...committed.diagnostics
    ]
  };
}
