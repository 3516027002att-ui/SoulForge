/**
 * Files Mode write proposals and commits through PatchIR + WorkspaceTransaction only.
 */

import { createHash, randomUUID } from 'node:crypto';
import { access, constants, readFile } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import type {
  ConfirmationReceipt,
  Diagnostic,
  PatchIR,
  PatchIrOperation,
  StructuredDiagnostic
} from '@soulforge/shared';
import { createDiagnostic, toLegacyDiagnostic } from '@soulforge/shared';
import {
  createPatchIr,
  createRawByteRangeOperation,
  createTextEditOperation
} from '../patch-engine/patchIr.js';
import {
  executePatchIrThroughTransaction,
  type ExecutePatchIrOptions,
  type TransactionCommitCompatResult
} from '../patch/durablePatchCommit.js';
import type { WorkspaceSession } from '../workspace/workspaceSession.js';
import {
  getFileCapabilities,
  type FileCapabilityReport
} from './fileCapabilities.js';

export interface FileWriteProposal {
  proposalId: string;
  patch: PatchIR;
  capabilities: FileCapabilityReport;
  riskLevel: PatchIrOperation['riskLevel'];
  requiresConfirmation: boolean;
  diagnostics: StructuredDiagnostic[];
}

export interface ProposeTextFileEditInput {
  workspaceId: string;
  absolutePath: string;
  relativePath?: string;
  newText: string;
  allowEmpty?: boolean;
  session?: WorkspaceSession;
  title?: string;
}

export interface ProposeRawByteEditInput {
  workspaceId: string;
  absolutePath: string;
  relativePath?: string;
  offset: number;
  length: number;
  replacement: Buffer | Uint8Array;
  /**
   * Caller-owned content hash precondition. Must not be recomputed/overwritten
   * when provided (TOCTOU protection for raw write path).
   */
  expectedHash: string;
  session?: WorkspaceSession;
  title?: string;
}

export interface ProposeWholeFileReplaceInput {
  workspaceId: string;
  absolutePath: string;
  relativePath?: string;
  newText?: string;
  newContentBase64?: string;
  allowEmpty?: boolean;
  allowCreateNewFile?: boolean;
  /**
   * When set for an existing file, this hash is used as the PatchIR precondition
   * and must not be recomputed from disk at proposal time.
   */
  expectedHash?: string;
  session?: WorkspaceSession;
  title?: string;
  confirmation?: ConfirmationReceipt;
}

function toPosixRelative(workspaceRoot: string, absolutePath: string, relativePath?: string): string {
  if (relativePath) return relativePath.replaceAll('\\', '/');
  return relative(workspaceRoot, absolutePath).replaceAll('\\', '/');
}

function workspaceRootOf(session: WorkspaceSession | undefined, absolutePath: string): string {
  if (session) return resolve(session.layers.overlayRoot);
  return resolve(absolutePath, '..');
}

async function sha256Path(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

function targetUri(relativePath: string): string {
  return `file://${relativePath.replaceAll('\\', '/')}`;
}

function boundaryDiagnostics(
  session: WorkspaceSession | undefined,
  absolutePath: string
): StructuredDiagnostic[] {
  if (!session) return [];
  return session.resolveWritablePath(absolutePath).diagnostics.map((d) => {
    const item: StructuredDiagnostic = {
      severity: d.severity,
      code: d.code,
      message: d.message,
      recordedAt: new Date().toISOString()
    };
    if (d.sourceUri !== undefined) item.targetUri = d.sourceUri;
    if (d.details !== undefined) item.details = d.details;
    return item;
  });
}

function requireConfirmationForRisk(
  risk: PatchIrOperation['riskLevel'],
  confirmation?: ConfirmationReceipt
): StructuredDiagnostic[] {
  // Raw/caution/high Files Mode writes always need an explicit receipt.
  if (risk === 'safe') return [];
  if (confirmation?.id && confirmation.subjects.length > 0) return [];
  return [createDiagnostic({
    severity: 'error',
    code: 'EDIT_CONFIRMATION_REQUIRED',
    message: 'Files Mode raw/high-risk write requires an explicit confirmation receipt.',
    details: { riskLevel: risk }
  })];
}

export async function proposeTextFileEdit(
  input: ProposeTextFileEditInput
): Promise<FileWriteProposal> {
  const absolutePath = resolve(input.absolutePath);
  const workspaceRoot = workspaceRootOf(input.session, absolutePath);
  const relativePath = toPosixRelative(workspaceRoot, absolutePath, input.relativePath);
  const caps = getFileCapabilities({ absolutePath, relativePath });
  const diagnostics: StructuredDiagnostic[] = [
    ...boundaryDiagnostics(input.session, absolutePath)
  ];

  if (!caps.capabilities.includes('text_edit')) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'TEXT_EDIT_NOT_SUPPORTED',
      message: 'This file does not support text_edit in Files Mode.',
      details: { relativePath, formatKind: caps.formatKind }
    }));
  }
  if (input.newText.length === 0 && !input.allowEmpty) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'TEXT_EDIT_EMPTY_OUTPUT_BLOCKED',
      message: 'Empty text output blocked unless allowEmpty is set.'
    }));
  }

  let expectedHash: string | undefined;
  try {
    expectedHash = await sha256Path(absolutePath);
  } catch {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'FILE_NOT_FOUND',
      message: 'Text edit target does not exist.',
      details: { absolutePath }
    }));
  }

  const op = createTextEditOperation({
    targetUri: targetUri(relativePath),
    targetPath: absolutePath,
    newText: input.newText,
    ...(expectedHash ? { expectedHash } : {}),
    resourceKind: caps.resourceKind,
    ...(input.allowEmpty !== undefined ? { allowEmpty: input.allowEmpty } : {})
  });
  op.riskLevel = caps.writeRiskDefault === 'safe' ? 'safe' : caps.writeRiskDefault;

  const patch = createPatchIr({
    workspaceId: input.workspaceId,
    title: input.title ?? `Text edit ${relativePath}`,
    author: 'user',
    operations: [op]
  });

  return {
    proposalId: randomUUID(),
    patch,
    capabilities: caps,
    riskLevel: op.riskLevel,
    requiresConfirmation: op.riskLevel === 'high' || op.riskLevel === 'blocked',
    diagnostics
  };
}

export async function proposeRawByteEdit(
  input: ProposeRawByteEditInput
): Promise<FileWriteProposal> {
  const absolutePath = resolve(input.absolutePath);
  const workspaceRoot = workspaceRootOf(input.session, absolutePath);
  const relativePath = toPosixRelative(workspaceRoot, absolutePath, input.relativePath);
  const caps = getFileCapabilities({ absolutePath, relativePath, looksBinary: true });
  const diagnostics: StructuredDiagnostic[] = [
    ...boundaryDiagnostics(input.session, absolutePath)
  ];

  if (!caps.capabilities.includes('raw_edit')) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'RAW_EDIT_NOT_SUPPORTED',
      message: 'This file does not support raw_edit in Files Mode.'
    }));
  }

  // TOCTOU: never recompute/overwrite caller-provided expectedHash.
  if (!input.expectedHash || typeof input.expectedHash !== 'string') {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'RAW_EDIT_HASH_REQUIRED',
      message: 'proposeRawByteEdit requires caller expectedHash (must not be recomputed at proposal time).'
    }));
  }
  const expectedHash = input.expectedHash ?? '';

  try {
    await access(absolutePath, constants.F_OK);
  } catch {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'FILE_NOT_FOUND',
      message: 'Raw edit target does not exist.'
    }));
  }

  // All raw ops require confirmation; packed/native is high risk.
  const risk: PatchIrOperation['riskLevel'] = caps.isPackedOrNative ? 'high' : 'caution';
  const op = createRawByteRangeOperation({
    targetUri: targetUri(relativePath),
    targetPath: absolutePath,
    offset: input.offset,
    length: input.length,
    replacement: input.replacement,
    expectedHash,
    resourceKind: caps.resourceKind
  });
  op.riskLevel = risk;
  op.metadata = { requiresConfirmation: true, filesMode: true, nativePacked: caps.isPackedOrNative };

  const patch = createPatchIr({
    workspaceId: input.workspaceId,
    title: input.title ?? `Raw edit ${relativePath}`,
    author: 'user',
    operations: [op]
  });

  return {
    proposalId: randomUUID(),
    patch,
    capabilities: caps,
    riskLevel: risk,
    requiresConfirmation: true,
    diagnostics
  };
}

export async function proposeWholeFileReplace(
  input: ProposeWholeFileReplaceInput
): Promise<FileWriteProposal> {
  const absolutePath = resolve(input.absolutePath);
  const workspaceRoot = workspaceRootOf(input.session, absolutePath);
  const relativePath = toPosixRelative(workspaceRoot, absolutePath, input.relativePath);
  const caps = getFileCapabilities({ absolutePath, relativePath });
  const diagnostics: StructuredDiagnostic[] = [
    ...boundaryDiagnostics(input.session, absolutePath)
  ];

  if (!caps.capabilities.includes('whole_file_replace')) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'FILE_REPLACE_NOT_SUPPORTED',
      message: 'This file does not support whole-file replace in Files Mode.'
    }));
  }
  if (input.newText === undefined && input.newContentBase64 === undefined) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'FILE_REPLACE_EMPTY',
      message: 'file_replace requires newText or newContentBase64.'
    }));
  }

  let exists = true;
  try {
    await access(absolutePath, constants.F_OK);
  } catch {
    exists = false;
  }

  // TOCTOU: if caller provides expectedHash, use it as-is; never recompute over it.
  let expectedHash: string | undefined;
  if (exists) {
    if (input.expectedHash) {
      expectedHash = input.expectedHash;
    } else {
      expectedHash = await sha256Path(absolutePath);
    }
  } else if (!input.allowCreateNewFile) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'FILE_NOT_FOUND',
      message: 'Target does not exist and allowCreateNewFile is false.'
    }));
  }

  // Whole-file binary replace is never "safe"; text full replace can be safe only via text path.
  // This Files Mode replace API always requires confirmation for non-text payloads.
  const risk: PatchIrOperation['riskLevel'] = caps.isPackedOrNative
    ? 'high'
    : caps.isTextLike && input.newText !== undefined
      ? 'caution'
      : 'high';

  diagnostics.push(...requireConfirmationForRisk(risk, input.confirmation));

  const op: Extract<PatchIrOperation, { kind: 'file_replace' }> = {
    id: randomUUID(),
    kind: 'file_replace',
    targetUri: targetUri(relativePath),
    targetPath: absolutePath,
    resourceKind: caps.resourceKind,
    preconditions: [
      {
        type: 'overlay_writable',
        description: 'Target must be inside writable overlay',
        targetUri: targetUri(relativePath)
      }
    ],
    validatorRequirements: [
      { validatorId: 'whole_file_replace', scope: 'before_staging', required: true },
      { validatorId: 'file_risk', scope: 'before_staging', required: true }
    ],
    riskLevel: risk,
    ...(expectedHash ? { expectedHash } : {}),
    ...(input.newText !== undefined ? { newText: input.newText } : {}),
    ...(input.newContentBase64 !== undefined ? { newContentBase64: input.newContentBase64 } : {}),
    ...(input.allowCreateNewFile !== undefined ? { allowCreateNewFile: input.allowCreateNewFile } : {}),
    ...(input.allowEmpty !== undefined ? { allowEmpty: input.allowEmpty } : {}),
    requiresConfirmation: risk === 'high',
    metadata: {
      filesMode: true,
      packedOrNative: caps.isPackedOrNative,
      nativeFormatAuthority: false
    }
  };

  if (expectedHash) {
    op.preconditions.push({
      type: 'content_hash',
      description: 'Expected content hash before replace',
      expectedHash,
      targetUri: targetUri(relativePath)
    });
  }

  const patch = createPatchIr({
    workspaceId: input.workspaceId,
    title: input.title ?? `Replace ${basename(relativePath)}`,
    author: 'user',
    operations: [op]
  });

  return {
    proposalId: randomUUID(),
    patch,
    capabilities: caps,
    riskLevel: risk,
    requiresConfirmation: true,
    diagnostics
  };
}

export async function commitFilePatch(input: {
  patch: PatchIR;
  session?: WorkspaceSession;
  workspaceRoot?: string;
  operationLog?: ExecutePatchIrOptions['operationLog'];
  confirmation?: ConfirmationReceipt;
  backupBaseDir?: string;
  recoveryDir?: string;
}): Promise<TransactionCommitCompatResult & { diagnostics: Diagnostic[] }> {
  const needsConfirm = input.patch.operations.some(
    (op) =>
      op.riskLevel === 'high'
      || op.riskLevel === 'blocked'
      || op.riskLevel === 'caution'
      || op.metadata?.requiresConfirmation === true
      || (op.kind === 'file_replace' && op.requiresConfirmation === true)
      || op.kind === 'raw_byte_range_edit'
  );
  const confirmDiagnostics = needsConfirm
    ? requireConfirmationForRisk(
      input.patch.operations.some((op) => op.riskLevel === 'high' || op.riskLevel === 'blocked')
        ? 'high'
        : 'caution',
      input.confirmation
    )
    : [];
  if (confirmDiagnostics.some((d) => d.severity === 'error')) {
    return {
      opId: input.patch.patchId,
      backupRoot: '',
      changedFiles: [],
      diagnostics: confirmDiagnostics.map(toLegacyDiagnostic)
    };
  }

  return executePatchIrThroughTransaction(input.patch, {
    ...(input.session ? { session: input.session } : {}),
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    ...(input.operationLog ? { operationLog: input.operationLog } : {}),
    ...(input.backupBaseDir ? { backupBaseDir: input.backupBaseDir } : {}),
    ...(input.recoveryDir ? { recoveryDir: input.recoveryDir } : {})
  });
}

export function proposeStructuredEditBlocked(input: {
  absolutePath: string;
  relativePath: string;
}): FileWriteProposal {
  const caps = getFileCapabilities(input);
  const diagnostics = [createDiagnostic({
    severity: 'error',
    code: 'NATIVE_WRITER_REQUIRED',
    message: 'Structured edit is blocked. No native FromSoftware writer is implemented. Use Files Mode raw_edit or whole-file replace with high-risk confirmation instead.',
    details: {
      relativePath: input.relativePath,
      formatKind: caps.formatKind,
      nativeFormatAuthority: false
    }
  })];
  const patch = createPatchIr({
    workspaceId: 'blocked',
    title: 'structured blocked',
    author: 'system',
    operations: []
  });
  return {
    proposalId: randomUUID(),
    patch,
    capabilities: caps,
    riskLevel: 'blocked',
    requiresConfirmation: false,
    diagnostics
  };
}
