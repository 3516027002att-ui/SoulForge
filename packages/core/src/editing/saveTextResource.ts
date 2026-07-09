import type {
  ConfirmationReceipt,
  Diagnostic,
  IndexedFile,
  SaveTextResourceResult
} from '@soulforge/shared';
import { commitValidatedStagingArea, createPatchProposal, createStagingArea } from '../patch/patchEngine.js';
import { getDefaultOperationLogStore, type OperationLogStore } from '../patch/operationLog.js';
import { evaluateWriterGate } from '../patch/writerContract.js';
import { evaluateDiagnosticsGate, mergeValidationResults } from '../patch/diagnosticsGate.js';
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
 * Saves a directly editable text resource through the Patch Engine.
 *
 * This intentionally refuses DCX/BND/TPF/GFX/native binary formats. Native writers must
 * be resource-specific so we do not corrupt packed mod files while the parser layer is
 * still maturing. Risky text paths require an explicit confirmation receipt.
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
          structuredEdit: {
            newText: options.newText,
            allowEmpty: options.allowEmpty === true
          }
        }
      ]
    });

    const staging = await createStagingArea(proposal);
    const committed = await commitValidatedStagingArea(staging, {
      ...(options.session ? { session: options.session } : {}),
      operationLog: options.operationLog ?? getDefaultOperationLogStore()
    });

    const postGate = evaluateDiagnosticsGate(committed.diagnostics);
    const merged = mergeValidationResults(preGate, postGate);

    return {
      ok: merged.ok && committed.diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
      opId: committed.opId,
      backupRoot: committed.backupRoot,
      changedFiles: committed.changedFiles,
      diagnostics: committed.diagnostics,
      ...(staging.proposal.graph ? { graph: staging.proposal.graph } : committed.operation?.graph ? { graph: committed.operation.graph } : {}),
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
