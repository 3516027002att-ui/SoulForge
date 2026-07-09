/**
 * Full File Workbench facade for Files Mode.
 */

import { access, constants } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import type { ConfirmationReceipt, Diagnostic } from '@soulforge/shared';
import { createResourceUri, formatResourceUri } from '@soulforge/shared';
import type { WorkspaceSession } from '../workspace/workspaceSession.js';
import { getFileCapabilities, type FileCapabilityReport } from './fileCapabilities.js';
import { previewFileResource, type FilePreviewResult } from './filePreview.js';
import { readFileResource, type ReadFileResourceResult } from './readFileResource.js';
import {
  commitFilePatch,
  proposeRawByteEdit,
  proposeStructuredEditBlocked,
  proposeTextFileEdit,
  proposeWholeFileReplace,
  type FileWriteProposal
} from './writeFileResource.js';
import { rollbackOperation } from '../patch/rollback.js';
import type { OperationLogStore } from '../patch/operationLog.js';
import type { TransactionCommitCompatResult } from '../patch/durablePatchCommit.js';

export interface OpenFileResourceResult {
  absolutePath: string;
  relativePath: string;
  resourceUri: string;
  exists: boolean;
  capabilities: FileCapabilityReport;
  preview: FilePreviewResult;
  diagnostics: Diagnostic[];
  nativeFormatAuthority: false;
}

function resolvePaths(input: {
  absolutePath?: string;
  relativePath?: string;
  session: WorkspaceSession;
}): { absolutePath: string; relativePath: string } {
  if (input.absolutePath) {
    const absolutePath = resolve(input.absolutePath);
    const relativePath = (input.relativePath
      ?? relative(input.session.layers.overlayRoot, absolutePath)
    ).replaceAll('\\', '/');
    return { absolutePath, relativePath };
  }
  if (!input.relativePath) {
    throw new Error('openFileResource requires absolutePath or relativePath');
  }
  const relativePath = input.relativePath.replaceAll('\\', '/');
  return {
    absolutePath: input.session.toOverlayPath(relativePath),
    relativePath
  };
}

export async function openFileResource(input: {
  session: WorkspaceSession;
  absolutePath?: string;
  relativePath?: string;
  game?: string;
}): Promise<OpenFileResourceResult> {
  const { absolutePath, relativePath } = resolvePaths({
    session: input.session,
    ...(input.absolutePath ? { absolutePath: input.absolutePath } : {}),
    ...(input.relativePath ? { relativePath: input.relativePath } : {})
  });

  let exists = true;
  try {
    await access(absolutePath, constants.F_OK);
  } catch {
    exists = false;
  }

  const capabilities = getFileCapabilities({ absolutePath, relativePath });
  const diagnostics: Diagnostic[] = [];

  if (!exists) {
    diagnostics.push({
      severity: 'error',
      code: 'FILE_NOT_FOUND',
      message: `File not found: ${relativePath}`,
      sourceUri: `file://${relativePath}`
    });
  }

  const preview = exists
    ? await previewFileResource({ absolutePath, relativePath })
    : {
        absolutePath,
        relativePath,
        size: 0,
        bytesRead: 0,
        truncated: false,
        previewKind: 'empty' as const,
        capabilities,
        diagnostics: [],
        nativeFormatAuthority: false as const
      };

  const resourceUri = formatResourceUri(createResourceUri({
    game: input.game ?? input.session.meta.game,
    overlay: input.session.isBasePath(absolutePath) ? 'base' : 'overlay',
    physicalPath: relativePath,
    resourceKind: capabilities.resourceKind
  }));

  return {
    absolutePath,
    relativePath,
    resourceUri,
    exists,
    capabilities,
    preview,
    diagnostics: [
      ...diagnostics,
      ...preview.diagnostics.map((d) => {
        const item: Diagnostic = {
          severity: d.severity,
          code: String(d.code),
          message: d.message,
          sourceUri: d.targetUri ?? resourceUri
        };
        if (d.details !== undefined) item.details = d.details;
        return item;
      })
    ],
    nativeFormatAuthority: false
  };
}

export async function getFileCapabilitiesForPath(input: {
  session: WorkspaceSession;
  absolutePath?: string;
  relativePath?: string;
}): Promise<FileCapabilityReport> {
  const paths = resolvePaths({
    session: input.session,
    ...(input.absolutePath ? { absolutePath: input.absolutePath } : {}),
    ...(input.relativePath ? { relativePath: input.relativePath } : {})
  });
  return getFileCapabilities(paths);
}

export {
  readFileResource,
  previewFileResource,
  proposeTextFileEdit,
  proposeRawByteEdit,
  proposeWholeFileReplace,
  proposeStructuredEditBlocked,
  commitFilePatch
};

export async function rollbackFileOperation(input: {
  opId: string;
  store: OperationLogStore;
  session?: WorkspaceSession;
}): Promise<{
  ok: boolean;
  opId: string;
  restoredFiles: string[];
  diagnostics: Diagnostic[];
}> {
  return rollbackOperation({
    opId: input.opId,
    store: input.store,
    ...(input.session ? { session: input.session } : {})
  });
}

export type {
  FileWriteProposal,
  FilePreviewResult,
  ReadFileResourceResult,
  TransactionCommitCompatResult
};

export async function commitProposedFileWrite(input: {
  proposal: FileWriteProposal;
  session?: WorkspaceSession;
  workspaceRoot?: string;
  operationLog?: OperationLogStore;
  confirmation?: ConfirmationReceipt;
  recoveryDir?: string;
}): Promise<TransactionCommitCompatResult> {
  if (input.proposal.diagnostics.some((d) => d.severity === 'error')) {
    return {
      opId: input.proposal.patch.patchId,
      backupRoot: '',
      changedFiles: [],
      diagnostics: input.proposal.diagnostics.map((d) => {
        const item: Diagnostic = {
          severity: d.severity,
          code: String(d.code),
          message: d.message
        };
        if (d.targetUri !== undefined) item.sourceUri = d.targetUri;
        if (d.details !== undefined) item.details = d.details;
        return item;
      })
    };
  }
  return commitFilePatch({
    patch: input.proposal.patch,
    ...(input.session ? { session: input.session } : {}),
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    ...(input.operationLog ? { operationLog: input.operationLog } : {}),
    ...(input.confirmation ? { confirmation: input.confirmation } : {}),
    ...(input.recoveryDir ? { recoveryDir: input.recoveryDir } : {})
  });
}
