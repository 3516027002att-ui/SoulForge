/**
 * Legacy patchEngine production path → PatchIR + WorkspaceTransaction.
 *
 * This is the single real commit authority bridge for old PatchProposal callers.
 * createStagingArea remains for dry-run / graph prep only; commit always
 * re-executes through WorkspaceTransaction.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type {
  Diagnostic,
  FileOperationRecord,
  OperationLogRecord,
  PatchProposal,
  ValidationResult
} from '@soulforge/shared';
import { toLegacyDiagnostic } from '@soulforge/shared';
import {
  createWorkspaceTransaction,
  type WorkspaceTransaction
} from '../transactions/workspaceTransaction.js';
import type { WorkspaceSession } from '../workspace/workspaceSession.js';
import { buildGraphPatchFromProposal } from './graphPatch.js';
import {
  createCommittedOperationRecord,
  getDefaultOperationLogStore,
  type OperationLogStore
} from './operationLog.js';
import { compilePatchProposalToPatchIr } from './patchProposalAdapter.js';

export interface ExecutePatchProposalOptions {
  workspaceRoot?: string;
  session?: WorkspaceSession;
  operationLog?: OperationLogStore;
  backupBaseDir?: string;
  actorId?: string;
}

/** Compat shape matching legacy CommitPatchResult. */
export interface TransactionCommitCompatResult {
  opId: string;
  backupRoot: string;
  changedFiles: string[];
  diagnostics: Diagnostic[];
  operation?: OperationLogRecord;
}
/**
 * Production write path for legacy proposals:
 * PatchProposal → PatchIR → WorkspaceTransaction → operation log.
 */
export async function executePatchProposalThroughTransaction(
  proposal: PatchProposal,
  options: ExecutePatchProposalOptions = {}
): Promise<TransactionCommitCompatResult> {
  const compiled = compilePatchProposalToPatchIr(proposal);
  if (!compiled.ok || !compiled.patch) {
    return {
      opId: proposal.opId,
      backupRoot: '',
      changedFiles: [],
      diagnostics: compiled.legacyDiagnostics
    };
  }

  const workspaceRoot = resolveWorkspaceRoot(proposal, options);
  if (!workspaceRoot) {
    return {
      opId: proposal.opId,
      backupRoot: '',
      changedFiles: [],
      diagnostics: [{
        severity: 'error',
        code: 'WORKSPACE_ROOT_REQUIRED',
        message: 'Cannot execute patch: workspaceRoot or session.overlayRoot is required.'
      }]
    };
  }

  // Session writable checks before staging.
  const preDiagnostics: Diagnostic[] = [];
  if (options.session) {
    for (const change of proposal.changes) {
      const writable = options.session.resolveWritablePath(
        change.targetPath,
        change.layer ?? 'overlay'
      );
      if (!writable.ok) preDiagnostics.push(...writable.diagnostics);
    }
  }
  if (preDiagnostics.some((item) => item.severity === 'error')) {
    return {
      opId: proposal.opId,
      backupRoot: '',
      changedFiles: [],
      diagnostics: preDiagnostics
    };
  }

  const tx = createWorkspaceTransaction({
    workspaceId: proposal.workspaceId,
    workspaceRoot,
    actor: {
      kind: proposal.author === 'ai' ? 'agent' : 'user',
      id: options.actorId ?? `legacy-patch:${proposal.author}`
    },
    ...(options.backupBaseDir !== undefined ? { backupBaseDir: options.backupBaseDir } : {})
  });

  // Align patch id with proposal opId for correlation when possible.
  const patch = {
    ...compiled.patch,
    patchId: proposal.opId
  };

  const added = tx.addPatch(patch);
  if (!added.ok) {
    return {
      opId: proposal.opId,
      backupRoot: '',
      changedFiles: [],
      diagnostics: [
        ...preDiagnostics,
        ...added.diagnostics.map(toLegacyDiagnostic)
      ]
    };
  }

  const staged = await tx.stage();
  if (!staged.ok) {
    return {
      opId: proposal.opId,
      backupRoot: '',
      changedFiles: [],
      diagnostics: [
        ...preDiagnostics,
        ...staged.diagnostics.map(toLegacyDiagnostic)
      ]
    };
  }

  const validated = await tx.validate();
  if (!validated.ok) {
    return {
      opId: proposal.opId,
      backupRoot: '',
      changedFiles: [],
      diagnostics: [
        ...preDiagnostics,
        ...validated.diagnostics.map(toLegacyDiagnostic)
      ]
    };
  }

  const committed = await tx.commit();
  const diagnostics: Diagnostic[] = [
    ...preDiagnostics,
    ...committed.diagnostics.map(toLegacyDiagnostic)
  ];

  if (!committed.ok || !committed.restorePoint) {
    return {
      opId: proposal.opId,
      backupRoot: committed.restorePoint?.root ?? '',
      changedFiles: [],
      diagnostics
    };
  }

  const graph = proposal.graph ?? buildGraphPatchFromProposal(proposal);
  const fileRecords = await buildFileOperationRecords(proposal, committed.restorePoint.files);
  const backupRoot = committed.restorePoint.root;

  const operation = createCommittedOperationRecord({
    proposal: {
      ...proposal,
      graph
    },
    backupRoot,
    files: fileRecords,
    diagnostics,
    graph
  });

  const store = options.operationLog ?? getDefaultOperationLogStore();
  try {
    store.record(operation);
  } catch (error) {
    const logDiagnostic: Diagnostic = {
      severity: 'error',
      code: 'OPERATION_LOG_RECORD_FAILED',
      message: error instanceof Error
        ? `Patch files were written but operation log record failed: ${error.message}`
        : 'Patch files were written but operation log record failed.',
      details: {
        opId: proposal.opId,
        backupRoot,
        transactionId: committed.transactionId,
        storeError: error instanceof Error ? error.message : String(error)
      }
    };
    diagnostics.push(logDiagnostic);
    operation.diagnostics = [...operation.diagnostics, logDiagnostic];
  }

  return {
    opId: proposal.opId,
    backupRoot,
    changedFiles: committed.committedPaths,
    diagnostics,
    operation
  };
}

/**
 * Stage + validate only (no commit). Used by dry-run compatibility.
 */
export async function stageAndValidateProposalThroughTransaction(
  proposal: PatchProposal,
  options: ExecutePatchProposalOptions = {}
): Promise<ValidationResult & { transaction?: WorkspaceTransaction }> {
  const compiled = compilePatchProposalToPatchIr(proposal);
  if (!compiled.ok || !compiled.patch) {
    return {
      ok: false,
      retryable: false,
      diagnostics: compiled.legacyDiagnostics
    };
  }

  const workspaceRoot = resolveWorkspaceRoot(proposal, options);
  if (!workspaceRoot) {
    return {
      ok: false,
      retryable: false,
      diagnostics: [{
        severity: 'error',
        code: 'WORKSPACE_ROOT_REQUIRED',
        message: 'Cannot dry-run patch: workspaceRoot or session.overlayRoot is required.'
      }]
    };
  }

  if (options.session) {
    const sessionDiagnostics: Diagnostic[] = [];
    for (const change of proposal.changes) {
      const writable = options.session.resolveWritablePath(
        change.targetPath,
        change.layer ?? 'overlay'
      );
      if (!writable.ok) sessionDiagnostics.push(...writable.diagnostics);
    }
    if (sessionDiagnostics.some((item) => item.severity === 'error')) {
      return { ok: false, retryable: false, diagnostics: sessionDiagnostics };
    }
  }

  const tx = createWorkspaceTransaction({
    workspaceId: proposal.workspaceId,
    workspaceRoot,
    actor: { kind: 'system', id: 'legacy-dry-run' }
  });

  const patch = { ...compiled.patch, patchId: proposal.opId };
  const added = tx.addPatch(patch);
  if (!added.ok) {
    return {
      ok: false,
      retryable: true,
      diagnostics: added.diagnostics.map(toLegacyDiagnostic)
    };
  }

  const staged = await tx.stage();
  if (!staged.ok) {
    return {
      ok: false,
      retryable: true,
      diagnostics: staged.diagnostics.map(toLegacyDiagnostic)
    };
  }

  const validated = await tx.validate();
  return {
    ok: validated.ok,
    retryable: !validated.ok,
    diagnostics: validated.diagnostics.map(toLegacyDiagnostic),
    transaction: tx
  };
}

export function resolveWorkspaceRoot(
  proposal: PatchProposal,
  options: ExecutePatchProposalOptions
): string | undefined {
  if (options.workspaceRoot) return resolve(options.workspaceRoot);
  if (options.session?.layers.overlayRoot) return resolve(options.session.layers.overlayRoot);

  // Derive from absolute target paths + optional relative path strip is not always available.
  // Use common parent of all absolute target paths when possible.
  const paths = proposal.changes.map((change) => resolve(change.targetPath));
  if (paths.length === 0) return undefined;
  return commonParentDirectory(paths);
}

export function resolveWorkspaceRootFromAbsoluteAndRelative(
  absolutePath: string,
  relativePath: string
): string {
  const abs = resolve(absolutePath);
  const rel = relativePath.replaceAll('\\', '/').replace(/^\/+/, '');
  const normalizedAbs = abs.replaceAll('\\', '/');
  const suffix = `/${rel}`;
  if (normalizedAbs.toLowerCase().endsWith(suffix.toLowerCase())) {
    return resolve(abs.slice(0, abs.length - rel.length).replace(/[/\\]+$/, '') || abs);
  }
  return dirname(abs);
}

async function buildFileOperationRecords(
  proposal: PatchProposal,
  backupFiles: Array<{ sourcePath: string; backupPath: string; beforeHash: string }>
): Promise<FileOperationRecord[]> {
  const byPath = new Map(proposal.changes.map((change) => [resolve(change.targetPath), change]));
  const records: FileOperationRecord[] = [];

  for (const file of backupFiles) {
    const change = byPath.get(resolve(file.sourcePath));
    let afterHash = file.beforeHash;
    try {
      afterHash = createHash('sha256').update(await readFile(file.sourcePath)).digest('hex');
    } catch {
      // keep beforeHash if unreadable (should not happen post-commit)
    }

    records.push({
      targetUri: change?.targetUri ?? `file://${file.sourcePath}`,
      targetPath: file.sourcePath,
      beforeHash: file.beforeHash,
      afterHash,
      backupPath: file.backupPath,
      kind: change?.kind ?? 'text',
      ...(change?.resourceKind ? { resourceKind: change.resourceKind } : {})
    });
  }

  return records;
}

function commonParentDirectory(paths: string[]): string | undefined {
  if (paths.length === 0) return undefined;
  const split = paths.map((pathValue) => resolve(pathValue).split(sep));
  const first = split[0];
  if (!first) return undefined;

  let end = first.length - 1; // exclude filename
  for (let i = 1; i < split.length; i += 1) {
    const parts = split[i];
    if (!parts) continue;
    let j = 0;
    while (j < end && j < parts.length - 1 && parts[j]?.toLowerCase() === first[j]?.toLowerCase()) {
      j += 1;
    }
    end = j;
  }
  if (end <= 0) return resolve(first[0] ?? paths[0]!);
  return first.slice(0, end).join(sep);
}

/** Map legacy commit options into ExecutePatchProposalOptions. */
export function toExecuteOptions(options: {
  workspaceRoot?: string;
  session?: WorkspaceSession;
  operationLog?: OperationLogStore;
  backupRoot?: string;
}): ExecutePatchProposalOptions {
  return {
    ...(options.workspaceRoot !== undefined ? { workspaceRoot: options.workspaceRoot } : {}),
    ...(options.session ? { session: options.session } : {}),
    ...(options.operationLog ? { operationLog: options.operationLog } : {}),
    ...(options.backupRoot !== undefined ? { backupBaseDir: options.backupRoot } : {})
  };
}
