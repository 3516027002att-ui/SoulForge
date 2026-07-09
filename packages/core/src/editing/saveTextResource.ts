import type { Diagnostic, IndexedFile, SaveTextResourceResult } from '@soulforge/shared';
import { commitValidatedStagingArea, createPatchProposal, createStagingArea } from '../patch/patchEngine.js';
import { getDefaultOperationLogStore, type OperationLogStore } from '../patch/operationLog.js';
import type { WorkspaceSession } from '../workspace/workspaceSession.js';

export interface SaveTextResourceOptions {
  file: IndexedFile;
  newText: string;
  allowEmpty?: boolean;
  session?: WorkspaceSession;
  operationLog?: OperationLogStore;
}

const EDITABLE_FORMATS = new Set(['text', 'hks']);
const EDITABLE_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.json',
  '.xml',
  '.yml',
  '.yaml',
  '.lua',
  '.hks',
  '.js',
  '.ts',
  '.csv',
  '.ini',
  '.cfg',
  '.toml',
  '.log'
]);

/**
 * Saves a directly editable text resource through the Patch Engine.
 *
 * This intentionally refuses DCX/BND/TPF/GFX/native binary formats. Native writers must
 * be resource-specific so we do not corrupt packed mod files while the parser layer is
 * still maturing.
 */
export async function saveTextResource(options: SaveTextResourceOptions): Promise<SaveTextResourceResult> {
  const eligibility = validateEditableTextResource(options.file, options.newText, options.allowEmpty ?? false);
  if (options.session) {
    eligibility.push(...options.session.resolveWritablePath(options.file.absolutePath).diagnostics);
  }
  if (eligibility.length > 0) {
    return {
      ok: false,
      changedFiles: [],
      diagnostics: eligibility
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

    return {
      ok: committed.diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
      opId: committed.opId,
      backupRoot: committed.backupRoot,
      changedFiles: committed.changedFiles,
      diagnostics: committed.diagnostics
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
      ]
    };
  }
}

function validateEditableTextResource(file: IndexedFile, newText: string, allowEmpty: boolean): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  if (!isEditableTextResource(file)) {
    diagnostics.push({
      severity: 'error',
      code: 'RESOURCE_NOT_TEXT_EDITABLE',
      message: 'This resource is not directly text-editable. Native packed formats require a resource-specific writer first.',
      sourceUri: file.sourceUri,
      details: {
        relativePath: file.relativePath,
        formatKind: file.formatKind,
        compoundExtension: file.compoundExtension
      }
    });
  }

  if (newText.length === 0 && !allowEmpty) {
    diagnostics.push({
      severity: 'error',
      code: 'TEXT_EDIT_EMPTY_OUTPUT_BLOCKED',
      message: 'Refusing to save an empty text resource unless allowEmpty is explicitly set.',
      sourceUri: file.sourceUri
    });
  }

  return diagnostics;
}

function isEditableTextResource(file: IndexedFile): boolean {
  if (EDITABLE_FORMATS.has(file.formatKind)) return true;
  return EDITABLE_EXTENSIONS.has(file.extension.toLowerCase()) || EDITABLE_EXTENSIONS.has(file.compoundExtension.toLowerCase());
}
