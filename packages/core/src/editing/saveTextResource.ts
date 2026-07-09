import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  ConfirmationReceipt,
  Diagnostic,
  IndexedFile,
  SaveTextResourceResult
} from '@soulforge/shared';
import { createPatchProposal, commitPatchProposal } from '../patch/patchEngine.js';
import { getDefaultOperationLogStore, type OperationLogStore } from '../patch/operationLog.js';
import { evaluateWriterGate } from '../patch/writerContract.js';
import { evaluateDiagnosticsGate, mergeValidationResults } from '../patch/diagnosticsGate.js';
import { compilePatchProposalToPatchIr } from '../patch/patchProposalAdapter.js';
import {
  resolveWorkspaceRootFromAbsoluteAndRelative
} from '../patch/legacyPatchEngineAdapter.js';
import type { WorkspaceSession } from '../workspace/workspaceSession.js';

export interface SaveTextResourceOptions {
  file: IndexedFile;
  newText: string;
  allowEmpty?: boolean;
  session?: WorkspaceSession;
  operationLog?: OperationLogStore;
  /** Required when writer contract / risk assessment demands confirmation. */
  confirmation?: ConfirmationReceipt;
  /** Preview-derived risk signals from desktop / tools. */
  truncated?: boolean;
  structuredEditable?: boolean;
  parseStatus?: string;
}

/**
 * Saves a directly editable text resource through PatchIR + WorkspaceTransaction.
 *
 * Production path:
 *   writer gate → PatchProposal → PatchIR → WorkspaceTransaction
 *     (addPatch → stage → validate → commit) → operation log
 *
 * Does not write the target file outside WorkspaceTransaction.commit.
 * Native packed formats remain blocked by the writer gate.
 */
export async function saveTextResource(options: SaveTextResourceOptions): Promise<SaveTextResourceResult> {
  const gate = evaluateWriterGate({
    file: options.file,
    changeKind: 'text',
    ...(options.confirmation ? { confirmation: options.confirmation } : {}),
    riskOptions: {
      ...(options.truncated !== undefined ? { truncated: options.truncated } : {}),
      ...(options.structuredEditable !== undefined ? { structuredEditable: options.structuredEditable } : {}),
      ...(options.parseStatus !== undefined ? { parseStatus: options.parseStatus } : {})
    }
  });

  const eligibility: Diagnostic[] = [...gate.diagnostics];

  if (options.newText.length === 0 && !options.allowEmpty) {
    eligibility.push({
      severity: 'error',
      code: 'TEXT_EDIT_EMPTY_OUTPUT_BLOCKED',
      message: 'Refusing to save an empty text resource unless allowEmpty is explicitly set.',
      sourceUri: options.file.sourceUri
    });
  }

  if (options.session) {
    eligibility.push(...options.session.resolveWritablePath(options.file.absolutePath).diagnostics);
  }

  const preGate = evaluateDiagnosticsGate(eligibility);
  if (!preGate.ok) {
    const needsConfirm = eligibility.some((item) => item.code === 'EDIT_CONFIRMATION_REQUIRED');
    return {
      ok: false,
      changedFiles: [],
      diagnostics: eligibility,
      risk: gate.risk,
      requiresConfirmation: needsConfirm || gate.risk.allowWithConfirmation
    };
  }

  try {
    // Capture content hash at proposal time so WorkspaceTransaction can reject
    // concurrent original changes (HASH_MISMATCH / ORIGINAL_CHANGED_DURING_STAGING).
    let beforeHash: string | undefined;
    try {
      const currentBytes = await readFile(options.file.absolutePath);
      beforeHash = createHash('sha256').update(currentBytes).digest('hex');
    } catch {
      // New file path: no hash precondition.
      beforeHash = undefined;
    }

    const proposal = createPatchProposal({
      workspaceId: options.file.workspaceId,
      title: `Edit ${options.file.relativePath}`,
      author: 'user',
      mode: 'normal',
      changes: [
        {
          targetUri: options.file.sourceUri,
          targetPath: options.file.absolutePath,
          kind: 'text',
          layer: 'overlay',
          resourceKind: options.file.resourceKind,
          ...(beforeHash ? { beforeHash } : {}),
          structuredEdit: {
            newText: options.newText,
            allowEmpty: options.allowEmpty === true
          }
        }
      ]
    });

    // Fail fast if the proposal cannot become PatchIR (binary/structured, etc.).
    const compiled = compilePatchProposalToPatchIr(proposal);
    if (!compiled.ok) {
      return {
        ok: false,
        changedFiles: [],
        diagnostics: compiled.legacyDiagnostics,
        risk: gate.risk,
        ...(proposal.graph ? { graph: proposal.graph } : {})
      };
    }

    const workspaceRoot = options.session?.layers.overlayRoot
      ?? resolveWorkspaceRootFromAbsoluteAndRelative(
        options.file.absolutePath,
        options.file.relativePath
      );

    const committed = await commitPatchProposal(proposal, {
      ...(options.session ? { session: options.session } : {}),
      operationLog: options.operationLog ?? getDefaultOperationLogStore(),
      workspaceRoot
    });

    const postGate = evaluateDiagnosticsGate(committed.diagnostics);
    const merged = mergeValidationResults(preGate, postGate);

    return {
      ok: merged.ok && committed.diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
      opId: committed.opId,
      backupRoot: committed.backupRoot,
      changedFiles: committed.changedFiles,
      diagnostics: committed.diagnostics,
      ...(proposal.graph
        ? { graph: proposal.graph }
        : committed.operation?.graph
          ? { graph: committed.operation.graph }
          : {}),
      risk: gate.risk
    };
  } catch (error) {
    return {
      ok: false,
      changedFiles: [],
      diagnostics: [
        {
          severity: 'error',
          code: 'TEXT_RESOURCE_SAVE_FAILED',
          message: error instanceof Error ? error.message : 'Failed to save text resource.',
          sourceUri: options.file.sourceUri,
          details: { targetPath: options.file.absolutePath }
        }
      ],
      risk: gate.risk
    };
  }
}
