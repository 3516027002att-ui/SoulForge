/**
 * Raw-level write entry for any file via PatchIR + WorkspaceTransaction.
 * High-risk for native/packed; always requires confirmation for raw ops.
 * Not a native semantic writer.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  ConfirmationReceipt,
  Diagnostic,
  IndexedFile,
  SaveTextResourceResult
} from '@soulforge/shared';
import {
  resolveResourceCapabilities
} from '../capabilities/resourceCapabilities.js';
import {
  proposeRawByteEdit,
  proposeWholeFileReplace
} from '../files/writeFileResource.js';
import { commitProposedFileWrite } from '../files/fileWorkbench.js';
import type { OperationLogStore } from '../patch/operationLog.js';
import { evaluateRawWriterGate } from '../patch/writerContract.js';
import { decodeStrictBase64, StrictBase64Error } from '../util/base64.js';
import type { WorkspaceSession } from '../workspace/workspaceSession.js';

export type SaveRawResourceResult = SaveTextResourceResult & {
  kind?: 'raw_file_replace' | 'raw_byte_range';
};

export interface SaveRawReplaceOptions {
  file: IndexedFile;
  expectedHash: string;
  newContentBase64: string;
  allowEmpty?: boolean;
  confirmation?: ConfirmationReceipt;
  session?: WorkspaceSession;
  operationLog?: OperationLogStore;
  backupBaseDir?: string;
  recoveryDir?: string;
  title?: string;
}

export interface SaveRawByteRangeOptions {
  file: IndexedFile;
  expectedHash: string;
  offset: number;
  length: number;
  replacementBase64: string;
  confirmation?: ConfirmationReceipt;
  session?: WorkspaceSession;
  operationLog?: OperationLogStore;
  backupBaseDir?: string;
  recoveryDir?: string;
  title?: string;
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

export async function saveRawReplace(options: SaveRawReplaceOptions): Promise<SaveRawResourceResult> {
  const caps = resolveResourceCapabilities(options.file);
  const gate = evaluateRawWriterGate({
    file: options.file,
    capabilities: caps,
    operation: 'replace',
    ...(options.confirmation ? { confirmation: options.confirmation } : {})
  });
  if (!gate.ok) {
    return {
      ok: false,
      changedFiles: [],
      diagnostics: gate.diagnostics,
      risk: gate.risk,
      requiresConfirmation: gate.risk.allowWithConfirmation,
      kind: 'raw_file_replace'
    };
  }

  let actual: string;
  try {
    actual = await sha256File(options.file.absolutePath);
  } catch (error) {
    return {
      ok: false,
      changedFiles: [],
      diagnostics: [{
        severity: 'error',
        code: 'RAW_REPLACE_READ_FAILED',
        message: error instanceof Error ? error.message : 'Failed to read target for hash check.',
        sourceUri: options.file.sourceUri
      }],
      kind: 'raw_file_replace'
    };
  }
  if (actual !== options.expectedHash) {
    return {
      ok: false,
      changedFiles: [],
      diagnostics: [{
        severity: 'error',
        code: 'HASH_MISMATCH',
        message: 'expectedHash does not match current file content.',
        sourceUri: options.file.sourceUri,
        details: { expected: options.expectedHash, actual }
      }],
      kind: 'raw_file_replace'
    };
  }

  // Strict base64 before proposal so invalid payloads never reach staging.
  try {
    decodeStrictBase64(options.newContentBase64, { allowEmpty: options.allowEmpty === true });
  } catch (error) {
    const code = error instanceof StrictBase64Error ? error.code : 'RAW_REPLACE_PAYLOAD_INVALID';
    return {
      ok: false,
      changedFiles: [],
      diagnostics: [{
        severity: 'error',
        code,
        message: error instanceof Error ? error.message : 'newContentBase64 is not valid strict base64.',
        sourceUri: options.file.sourceUri
      }],
      kind: 'raw_file_replace'
    };
  }

  const proposal = await proposeWholeFileReplace({
    workspaceId: options.file.workspaceId,
    absolutePath: options.file.absolutePath,
    relativePath: options.file.relativePath,
    newContentBase64: options.newContentBase64,
    allowEmpty: options.allowEmpty === true,
    // Pass caller hash unchanged — proposal must not recompute/overwrite (TOCTOU).
    expectedHash: options.expectedHash,
    title: options.title ?? `Raw replace ${options.file.relativePath}`,
    ...(options.session ? { session: options.session } : {}),
    ...(options.confirmation ? { confirmation: options.confirmation } : {})
  });

  if (caps.isPackedOrNative) {
    proposal.diagnostics.push({
      severity: 'warning',
      code: 'RAW_REPLACE_NATIVE_PACKED',
      message: 'Raw whole-file replace of native/packed format. Not a semantic/native roundtrip writer.',
      targetUri: options.file.sourceUri,
      details: { nativeRoundTripSafe: false }
    });
  }

  const committed = await commitProposedFileWrite({
    proposal,
    ...(options.session ? { session: options.session } : {}),
    ...(options.session?.layers.overlayRoot
      ? { workspaceRoot: options.session.layers.overlayRoot }
      : {}),
    ...(options.operationLog ? { operationLog: options.operationLog } : {}),
    ...(options.confirmation ? { confirmation: options.confirmation } : {}),
    ...(options.backupBaseDir ? { backupBaseDir: options.backupBaseDir } : {}),
    ...(options.recoveryDir ? { recoveryDir: options.recoveryDir } : {})
  });

  return {
    ok: committed.changedFiles.length > 0
      && committed.diagnostics.every((d: Diagnostic) => d.severity !== 'error'),
    opId: committed.opId,
    backupRoot: committed.backupRoot,
    changedFiles: committed.changedFiles,
    diagnostics: committed.diagnostics,
    risk: gate.risk,
    kind: 'raw_file_replace'
  };
}

export async function saveRawByteRange(options: SaveRawByteRangeOptions): Promise<SaveRawResourceResult> {
  const caps = resolveResourceCapabilities(options.file);
  const gate = evaluateRawWriterGate({
    file: options.file,
    capabilities: caps,
    operation: 'byte_range',
    ...(options.confirmation ? { confirmation: options.confirmation } : {})
  });
  if (!gate.ok) {
    return {
      ok: false,
      changedFiles: [],
      diagnostics: gate.diagnostics,
      risk: gate.risk,
      requiresConfirmation: gate.risk.allowWithConfirmation,
      kind: 'raw_byte_range'
    };
  }

  let actual: string;
  try {
    actual = await sha256File(options.file.absolutePath);
  } catch (error) {
    return {
      ok: false,
      changedFiles: [],
      diagnostics: [{
        severity: 'error',
        code: 'RAW_PATCH_READ_FAILED',
        message: error instanceof Error ? error.message : 'Failed to read target for hash check.',
        sourceUri: options.file.sourceUri
      }],
      kind: 'raw_byte_range'
    };
  }
  if (actual !== options.expectedHash) {
    return {
      ok: false,
      changedFiles: [],
      diagnostics: [{
        severity: 'error',
        code: 'HASH_MISMATCH',
        message: 'expectedHash does not match current file content.',
        sourceUri: options.file.sourceUri,
        details: { expected: options.expectedHash, actual }
      }],
      kind: 'raw_byte_range'
    };
  }

  let replacement: Buffer;
  try {
    replacement = decodeStrictBase64(options.replacementBase64, { allowEmpty: false });
  } catch (error) {
    const code = error instanceof StrictBase64Error ? error.code : 'RAW_PATCH_PAYLOAD_INVALID';
    return {
      ok: false,
      changedFiles: [],
      diagnostics: [{
        severity: 'error',
        code,
        message: error instanceof Error ? error.message : 'replacementBase64 is not valid strict base64.',
        sourceUri: options.file.sourceUri
      }],
      kind: 'raw_byte_range'
    };
  }

  const proposal = await proposeRawByteEdit({
    workspaceId: options.file.workspaceId,
    absolutePath: options.file.absolutePath,
    relativePath: options.file.relativePath,
    offset: options.offset,
    length: options.length,
    replacement,
    // Pass caller hash unchanged — proposal must not recompute/overwrite (TOCTOU).
    expectedHash: options.expectedHash,
    title: options.title ?? `Raw byte patch ${options.file.relativePath}`,
    ...(options.session ? { session: options.session } : {})
  });

  if (caps.isPackedOrNative) {
    proposal.diagnostics.push({
      severity: 'warning',
      code: 'RAW_PATCH_NATIVE_PACKED',
      message: 'Raw byte-range patch of native/packed format. Not a semantic/native writer.',
      targetUri: options.file.sourceUri,
      details: { nativeRoundTripSafe: false }
    });
  }

  const committed = await commitProposedFileWrite({
    proposal,
    ...(options.session ? { session: options.session } : {}),
    ...(options.session?.layers.overlayRoot
      ? { workspaceRoot: options.session.layers.overlayRoot }
      : {}),
    ...(options.operationLog ? { operationLog: options.operationLog } : {}),
    ...(options.confirmation ? { confirmation: options.confirmation } : {}),
    ...(options.backupBaseDir ? { backupBaseDir: options.backupBaseDir } : {}),
    ...(options.recoveryDir ? { recoveryDir: options.recoveryDir } : {})
  });

  return {
    ok: committed.changedFiles.length > 0
      && committed.diagnostics.every((d: Diagnostic) => d.severity !== 'error'),
    opId: committed.opId,
    backupRoot: committed.backupRoot,
    changedFiles: committed.changedFiles,
    diagnostics: committed.diagnostics,
    risk: gate.risk,
    kind: 'raw_byte_range'
  };
}
