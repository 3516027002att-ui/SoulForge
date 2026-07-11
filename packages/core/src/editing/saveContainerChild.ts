/**
 * replaceContainerChild entry — PatchIR container_child_replace + WorkspaceTransaction.
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  ConfirmationReceipt,
  Diagnostic,
  IndexedFile,
  PatchIR,
  SaveTextResourceResult
} from '@soulforge/shared';
import { createDiagnostic, toLegacyDiagnostic } from '@soulforge/shared';
import {
  inspectContainerTree,
  readContainerChild,
  replaceContainerChildInMemory
} from '../containers/containerService.js';
import { createPatchIr } from '../patch-engine/patchIr.js';
import { executePatchIrThroughTransaction } from '../patch/durablePatchCommit.js';
import type { OperationLogStore } from '../patch/operationLog.js';
import { decodeStrictBase64, StrictBase64Error } from '../util/base64.js';
import type { WorkspaceSession } from '../workspace/workspaceSession.js';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export interface ReplaceContainerChildOptions {
  file: IndexedFile;
  childUri: string;
  expectedContainerHash: string;
  expectedChildHash: string;
  newContentBase64: string;
  confirmation?: ConfirmationReceipt;
  session?: WorkspaceSession;
  operationLog?: OperationLogStore;
  backupBaseDir?: string;
  recoveryDir?: string;
  title?: string;
}

export type ReplaceContainerChildResult = SaveTextResourceResult & {
  kind: 'container_child_replace';
  childUri?: string;
};

function childPathFromUri(childUri: string): string {
  const hash = childUri.indexOf('#');
  const fragment = hash >= 0 ? childUri.slice(hash + 1) : childUri;
  const parts = fragment.split('/').filter(Boolean);
  const idx = parts.lastIndexOf('child');
  return decodeURIComponent((idx >= 0 ? parts[idx + 1] : parts[parts.length - 1]) ?? '');
}

export async function replaceContainerChild(
  options: ReplaceContainerChildOptions
): Promise<ReplaceContainerChildResult> {
  if (!options.confirmation?.id || options.confirmation.subjects.length === 0) {
    return {
      ok: false,
      changedFiles: [],
      diagnostics: [toLegacyDiagnostic(createDiagnostic({
        severity: 'error',
        code: 'EDIT_CONFIRMATION_REQUIRED',
        message: 'container_child_replace requires an explicit confirmation receipt.',
        targetUri: options.file.sourceUri
      }))],
      kind: 'container_child_replace',
      childUri: options.childUri
    };
  }

  let newBytes: Buffer;
  try {
    newBytes = decodeStrictBase64(options.newContentBase64, { allowEmpty: false });
  } catch (error) {
    return {
      ok: false,
      changedFiles: [],
      diagnostics: [{
        severity: 'error',
        code: error instanceof StrictBase64Error ? error.code : 'BASE64_INVALID',
        message: error instanceof Error ? error.message : 'Invalid newContentBase64.',
        sourceUri: options.file.sourceUri
      }],
      kind: 'container_child_replace',
      childUri: options.childUri
    };
  }

  // Preflight: capability must allow child replace
  const tree = await inspectContainerTree(options.file.absolutePath, {
    relativePath: options.file.relativePath
  });
  if (!tree.ok || !tree.tree?.root.canReplaceChild) {
    return {
      ok: false,
      changedFiles: [],
      diagnostics: [{
        severity: 'error',
        code: 'CONTAINER_CHILD_REPLACE_BLOCKED',
        message: 'Container does not support authoritative child replace. Use raw replace or a supported synthetic/DCX DFLT nested binder.',
        sourceUri: options.file.sourceUri,
        details: {
          canReplaceChild: tree.tree?.root.canReplaceChild ?? false,
          format: tree.tree?.root.format
        }
      }],
      kind: 'container_child_replace',
      childUri: options.childUri
    };
  }

  // Early hash check
  let containerBytes: Buffer;
  try {
    containerBytes = await readFile(options.file.absolutePath);
  } catch (error) {
    return {
      ok: false,
      changedFiles: [],
      diagnostics: [{
        severity: 'error',
        code: 'CONTAINER_READ_FAILED',
        message: error instanceof Error ? error.message : 'Failed to read container.',
        sourceUri: options.file.sourceUri
      }],
      kind: 'container_child_replace',
      childUri: options.childUri
    };
  }
  if (sha256(containerBytes) !== options.expectedContainerHash) {
    return {
      ok: false,
      changedFiles: [],
      diagnostics: [{
        severity: 'error',
        code: 'HASH_MISMATCH',
        message: 'expectedContainerHash does not match current container.',
        sourceUri: options.file.sourceUri
      }],
      kind: 'container_child_replace',
      childUri: options.childUri
    };
  }

  // Preflight replace so we fail before transaction if format/child wrong
  const preflight = replaceContainerChildInMemory(
    containerBytes,
    childPathFromUri(options.childUri),
    newBytes,
    options.expectedContainerHash,
    options.expectedChildHash
  );
  if (!preflight.ok) {
    return {
      ok: false,
      changedFiles: [],
      diagnostics: preflight.diagnostics.map(toLegacyDiagnostic),
      kind: 'container_child_replace',
      childUri: options.childUri
    };
  }

  const childPath = childPathFromUri(options.childUri);
  const originalChild = await readContainerChild(options.file.absolutePath, options.childUri, {
    relativePath: options.file.relativePath
  });
  if (!originalChild.ok || !originalChild.bytes || sha256(originalChild.bytes) !== options.expectedChildHash) {
    return {
      ok: false,
      changedFiles: [],
      diagnostics: [{
        severity: 'error',
        code: 'CONTAINER_CHILD_INVERSE_CAPTURE_FAILED',
        message: '无法在提交前取得与 expectedChildHash 一致的条目原始字节，已阻止写入。',
        sourceUri: options.childUri
      }],
      kind: 'container_child_replace',
      childUri: options.childUri
    };
  }
  const opId = randomUUID();
  const patch: PatchIR = createPatchIr({
    workspaceId: options.file.workspaceId,
    title: options.title ?? `Replace child ${childPath} in ${options.file.relativePath}`,
    author: 'user',
    operations: [{
      id: opId,
      kind: 'container_child_replace',
      targetUri: options.file.sourceUri,
      targetPath: options.file.absolutePath,
      containerUri: options.file.sourceUri,
      childPath,
      childUri: options.childUri,
      childContentBase64: options.newContentBase64,
      expectedContainerHash: options.expectedContainerHash,
      expectedChildHash: options.expectedChildHash,
      expectedHash: options.expectedContainerHash,
      containerFormat: tree.tree.root.format,
      preconditions: [
        {
          type: 'content_hash',
          description: 'Expected container hash before child replace',
          expectedHash: options.expectedContainerHash,
          targetUri: options.file.sourceUri
        },
        {
          type: 'writer_capability',
          description: 'Container must support authoritative-repack child replace',
          targetUri: options.file.sourceUri
        }
      ],
      validatorRequirements: [
        { validatorId: 'container_roundtrip', scope: 'before_staging', required: true },
        { validatorId: 'container_roundtrip', scope: 'staged_output', required: true },
        { validatorId: 'container_roundtrip', scope: 'after_commit', required: true },
        { validatorId: 'file_risk', scope: 'before_staging', required: true }
      ],
      riskLevel: 'high',
      metadata: {
        requiresConfirmation: true,
        filesMode: true,
        containerChildReplace: true,
        nativeFormatAuthority: false,
        childUri: options.childUri
      }
    }]
  });

  const committed = await executePatchIrThroughTransaction(patch, {
    ...(options.session ? { session: options.session } : {}),
    ...(options.session?.layers.overlayRoot
      ? { workspaceRoot: options.session.layers.overlayRoot }
      : {}),
    ...(options.operationLog ? { operationLog: options.operationLog } : {}),
    ...(options.backupBaseDir ? { backupBaseDir: options.backupBaseDir } : {}),
    ...(options.recoveryDir ? { recoveryDir: options.recoveryDir } : {}),
    resourceEntryChanges: [{
      id: randomUUID(),
      resourceUri: options.file.sourceUri,
      entryUri: options.childUri,
      changeKind: 'replace',
      beforeHash: options.expectedChildHash,
      afterHash: sha256(newBytes),
      inverse: {
        id: randomUUID(),
        kind: 'container_child_replace',
        targetUri: options.file.sourceUri,
        targetPath: options.file.absolutePath,
        containerUri: options.file.sourceUri,
        childPath,
        childUri: options.childUri,
        childContentBase64: originalChild.bytes.toString('base64'),
        expectedContainerHash: options.expectedContainerHash,
        expectedChildHash: sha256(newBytes),
        expectedHash: options.expectedContainerHash,
        containerFormat: tree.tree.root.format,
        preconditions: [{
          type: 'content_hash',
          description: '回滚前容器必须仍等于原操作 afterHash',
          expectedHash: options.expectedContainerHash,
          targetUri: options.file.sourceUri
        }],
        validatorRequirements: [
          { validatorId: 'container_roundtrip', scope: 'before_staging', required: true },
          { validatorId: 'container_roundtrip', scope: 'staged_output', required: true },
          { validatorId: 'container_roundtrip', scope: 'after_commit', required: true }
        ],
        rollbackHint: { strategy: 'inverse_patch', notes: `资源条目 ${options.childUri} 的逆操作` },
        riskLevel: 'high',
        metadata: { inverseResourceEntry: true, entryUri: options.childUri }
      }
    }]
  });

  return {
    ok: committed.changedFiles.length > 0
      && committed.diagnostics.every((d: Diagnostic) => d.severity !== 'error'),
    opId: committed.opId,
    backupRoot: committed.backupRoot,
    changedFiles: committed.changedFiles,
    diagnostics: committed.diagnostics,
    kind: 'container_child_replace',
    childUri: options.childUri
  };
}

export async function inspectContainerForFile(file: IndexedFile) {
  return inspectContainerTree(file.absolutePath, { relativePath: file.relativePath });
}

export async function readContainerChildForFile(file: IndexedFile, childUri: string) {
  return readContainerChild(file.absolutePath, childUri, { relativePath: file.relativePath });
}
