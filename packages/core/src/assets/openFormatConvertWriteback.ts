/**
 * Open-format conversion → PatchIR writeback for texture intermediates.
 * Mesh structure probes are staged only and must not overwrite native FLVER via this path.
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Diagnostic, PatchIR } from '@soulforge/shared';
import { createPatchIr } from '../patch-engine/patchIr.js';
import {
  executePatchIrThroughTransaction,
  type ExecutePatchIrOptions
} from '../patch/durablePatchCommit.js';
import {
  convertOpenFormatAsset,
  type OpenFormatConvertRequest,
  type OpenFormatConvertResult
} from './openFormatConvert.js';

export interface OpenFormatConvertWritebackRequest extends OpenFormatConvertRequest {
  workspaceId: string;
  targetAbsolutePath: string;
  expectedTargetHash: string;
  confirmationReceiptId: string;
  title?: string;
}

export interface OpenFormatConvertWritebackResult {
  ok: boolean;
  conversionId: string;
  stagingPath?: string;
  contentHash?: string;
  opId?: string;
  changedFiles: string[];
  convert: OpenFormatConvertResult;
  diagnostics: Diagnostic[];
}

/**
 * Convert open-format source and, for texture intermediates only, commit via PatchIR.
 */
export async function convertOpenFormatAndWriteback(
  request: OpenFormatConvertWritebackRequest,
  transactionOptions: ExecutePatchIrOptions
): Promise<OpenFormatConvertWritebackResult> {
  const converted = await convertOpenFormatAsset(request);
  if (!converted.ok) {
    return {
      ok: false,
      conversionId: converted.plan.conversionId,
      convert: converted,
      changedFiles: [],
      diagnostics: toDiagnostics(converted.diagnostics)
    };
  }

  const textureWritebackAllowed =
    converted.plan.authority === 'candidate'
    && (
      converted.plan.conversionKind === 'texture-rgba-to-dds'
      || converted.plan.conversionKind === 'texture-dds-passthrough'
    );

  if (!textureWritebackAllowed) {
    return {
      ok: false,
      conversionId: converted.plan.conversionId,
      stagingPath: converted.stagingPath,
      convert: converted,
      changedFiles: [],
      diagnostics: [
        ...toDiagnostics(converted.diagnostics),
        {
          severity: 'error',
          code: 'OPEN_FORMAT_WRITEBACK_STRUCTURE_ONLY',
          message:
            'open-format mesh/structure probes stage only; FLVER/native mesh writeback is unsupported'
        }
      ]
    };
  }

  if (!converted.stagingPath || !converted.contentHash) {
    return {
      ok: false,
      conversionId: converted.plan.conversionId,
      convert: converted,
      changedFiles: [],
      diagnostics: [
        {
          severity: 'error',
          code: 'OPEN_FORMAT_WRITEBACK_NO_STAGING',
          message: 'texture conversion produced no staging artifact'
        }
      ]
    };
  }

  const stagedBytes = await readFile(converted.stagingPath);
  const stagedHash = createHash('sha256').update(stagedBytes).digest('hex');
  if (stagedHash !== converted.contentHash) {
    return {
      ok: false,
      conversionId: converted.plan.conversionId,
      stagingPath: converted.stagingPath,
      convert: converted,
      changedFiles: [],
      diagnostics: [
        {
          severity: 'error',
          code: 'OPEN_FORMAT_STAGING_HASH_MISMATCH',
          message: 'converted staging content hash mismatch before PatchIR'
        }
      ]
    };
  }

  const opId = randomUUID();
  const patch: PatchIR = createPatchIr({
    workspaceId: request.workspaceId,
    title: request.title ?? `Open-format convert writeback ${converted.plan.sourceKind} → ${request.targetAssetUri}`,
    author: 'user',
    operations: [
      {
        id: opId,
        kind: 'file_replace',
        riskLevel: 'high',
        targetUri: request.targetAssetUri,
        targetPath: request.targetAbsolutePath,
        newContentBase64: stagedBytes.toString('base64'),
        expectedHash: request.expectedTargetHash,
        preconditions: [
          {
            type: 'content_hash',
            description: 'Target hash must match before open-format convert writeback',
            expectedHash: request.expectedTargetHash,
            targetUri: request.targetAssetUri
          },
          {
            type: 'overlay_writable',
            description: 'Target must be on overlay / sandbox workspace',
            targetUri: request.targetAssetUri
          }
        ],
        validatorRequirements: [
          { validatorId: 'whole_file_replace', scope: 'before_staging', required: true },
          { validatorId: 'file_risk', scope: 'before_staging', required: true }
        ],
        requiresConfirmation: true,
        metadata: {
          requiresConfirmation: true,
          confirmationReceiptId: request.confirmationReceiptId,
          openFormatConversionId: converted.plan.conversionId,
          openFormatSourceKind: converted.plan.sourceKind,
          openFormatConversionKind: converted.plan.conversionKind,
          openFormatAuthority: converted.plan.authority,
          conversionRuleId: request.conversionRuleId,
          nativeFormatAuthority: false
        }
      }
    ]
  });

  const committed = await executePatchIrThroughTransaction(patch, transactionOptions);
  const ok =
    committed.changedFiles.length > 0 &&
    committed.diagnostics.every((d) => d.severity !== 'error');

  return {
    ok,
    conversionId: converted.plan.conversionId,
    stagingPath: converted.stagingPath,
    contentHash: converted.contentHash,
    ...(committed.opId ? { opId: committed.opId } : {}),
    changedFiles: committed.changedFiles,
    convert: converted,
    diagnostics: [...toDiagnostics(converted.diagnostics), ...committed.diagnostics]
  };
}

function toDiagnostics(
  items: Array<{ severity: Diagnostic['severity']; code: string | number; message: string; targetUri?: string }>
): Diagnostic[] {
  return items.map((d) => ({
    severity: d.severity,
    code: String(d.code),
    message: d.message,
    ...(d.targetUri ? { sourceUri: d.targetUri } : {})
  }));
}
