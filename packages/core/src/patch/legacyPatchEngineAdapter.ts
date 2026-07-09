/**
 * Legacy patchEngine production path → PatchIR + WorkspaceTransaction.
 *
 * This is the single real commit authority bridge for old PatchProposal callers.
 * createStagingArea remains for dry-run / graph prep only; commit always
 * re-executes through WorkspaceTransaction + durable operation log recovery.
 */

import { dirname, resolve, sep } from 'node:path';
import type {
  Diagnostic,
  PatchProposal,
  ValidationResult
} from '@soulforge/shared';
import { toLegacyDiagnostic } from '@soulforge/shared';
import {
  createWorkspaceTransaction,
  type WorkspaceTransaction
} from '../transactions/workspaceTransaction.js';
import type { WorkspaceSession } from '../workspace/workspaceSession.js';
import type { OperationLogStore } from './operationLog.js';
import { compilePatchProposalToPatchIr } from './patchProposalAdapter.js';
import {
  executePatchIrThroughTransaction,
  type TransactionCommitCompatResult
} from './durablePatchCommit.js';

export type { TransactionCommitCompatResult };

export interface ExecutePatchProposalOptions {
  workspaceRoot?: string;
  session?: WorkspaceSession;
  operationLog?: OperationLogStore;
  backupBaseDir?: string;
  actorId?: string;
  recoveryDir?: string;
}

/**
 * Production write path for legacy proposals:
 * PatchProposal → PatchIR → durable WorkspaceTransaction + operation log recovery.
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

  return executePatchIrThroughTransaction(
    { ...compiled.patch, patchId: proposal.opId },
    {
      workspaceRoot,
      ...(options.session ? { session: options.session } : {}),
      ...(options.operationLog ? { operationLog: options.operationLog } : {}),
      ...(options.backupBaseDir !== undefined ? { backupBaseDir: options.backupBaseDir } : {}),
      ...(options.actorId ? { actorId: options.actorId } : {}),
      ...(options.recoveryDir ? { recoveryDir: options.recoveryDir } : {}),
      author: proposal.author,
      mode: proposal.mode,
      ...(proposal.graph ? { graph: proposal.graph } : {})
    }
  );
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

function commonParentDirectory(paths: string[]): string | undefined {
  if (paths.length === 0) return undefined;
  const split = paths.map((pathValue) => resolve(pathValue).split(sep));
  const first = split[0];
  if (!first) return undefined;

  let end = first.length - 1;
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
