import { copyFile, mkdir, mkdtemp, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type { Diagnostic, PatchChange, PatchMode, PatchProposal, ValidationResult } from '@soulforge/shared';

export interface CreatePatchProposalInput {
  workspaceId: string;
  title: string;
  author: 'user' | 'ai';
  mode: PatchMode;
  changes: PatchChange[];
}

export interface StagedPatchFile {
  change: PatchChange;
  stagingPath: string;
  beforeHash: string;
  afterHash: string;
}

export interface StagingArea {
  opId: string;
  root: string;
  files: StagedPatchFile[];
}

export interface CommitPatchOptions {
  backupRoot?: string;
}

export interface CommitPatchResult {
  opId: string;
  backupRoot: string;
  changedFiles: string[];
  diagnostics: Diagnostic[];
}

interface TextContentEdit {
  newText: string;
}

export function createPatchProposal(input: CreatePatchProposalInput): PatchProposal {
  return {
    opId: randomUUID(),
    workspaceId: input.workspaceId,
    title: input.title,
    author: input.author,
    mode: input.mode,
    changes: input.changes,
    createdAt: new Date().toISOString()
  };
}

export async function createStagingArea(proposal: PatchProposal): Promise<StagingArea> {
  const root = await mkdtemp(join(tmpdir(), `soulforge-${proposal.opId}-`));
  const stagedFiles: StagedPatchFile[] = [];

  for (const change of proposal.changes) {
    const stagingPath = makeStagingPath(root, change);
    await mkdir(dirname(stagingPath), { recursive: true });
    await copyFile(change.targetPath, stagingPath);

    const beforeHash = await sha256File(change.targetPath);
    await applyChangeToStagingFile(change, stagingPath);
    const afterHash = await sha256File(stagingPath);

    stagedFiles.push({
      change,
      stagingPath,
      beforeHash,
      afterHash
    });
  }

  return { opId: proposal.opId, root, files: stagedFiles };
}

export async function validateStagingArea(staging: StagingArea): Promise<ValidationResult> {
  const diagnostics: Diagnostic[] = [];

  if (staging.files.length === 0) {
    diagnostics.push({
      severity: 'error',
      code: 'PATCH_HAS_NO_FILES',
      message: 'Patch proposal did not stage any files.'
    });
  }

  for (const file of staging.files) {
    const stagedStat = await safeStat(file.stagingPath);
    if (!stagedStat) {
      diagnostics.push({
        severity: 'error',
        code: 'STAGED_FILE_MISSING',
        message: 'A staged file is missing after patch application.',
        details: { targetPath: file.change.targetPath, stagingPath: file.stagingPath }
      });
      continue;
    }

    if (stagedStat.size === 0 && !allowsEmptyOutput(file.change)) {
      diagnostics.push({
        severity: 'error',
        code: 'STAGED_FILE_EMPTY',
        message: 'A staged output file is empty. Refusing to save unless explicitly allowed.',
        details: { targetPath: file.change.targetPath, stagingPath: file.stagingPath }
      });
    }

    const currentOriginalHash = await sha256File(file.change.targetPath);
    if (currentOriginalHash !== file.beforeHash) {
      diagnostics.push({
        severity: 'error',
        code: 'ORIGINAL_CHANGED_DURING_STAGING',
        message: 'Original file changed after staging started. Refusing to overwrite newer data.',
        details: { targetPath: file.change.targetPath }
      });
    }

    if (file.beforeHash === file.afterHash) {
      diagnostics.push({
        severity: 'warning',
        code: 'PATCH_NO_OP',
        message: 'Patch produced no file content change.',
        details: { targetPath: file.change.targetPath }
      });
    }
  }

  return {
    ok: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
    diagnostics,
    retryable: diagnostics.some((diagnostic) => diagnostic.code !== 'ORIGINAL_CHANGED_DURING_STAGING')
  };
}

export async function dryRunPatchProposal(proposal: PatchProposal): Promise<ValidationResult> {
  try {
    const staging = await createStagingArea(proposal);
    return await validateStagingArea(staging);
  } catch (error) {
    return {
      ok: false,
      retryable: false,
      diagnostics: [
        {
          severity: 'error',
          code: 'PATCH_DRY_RUN_FAILED',
          message: error instanceof Error ? error.message : 'Patch dry run failed.',
          details: { opId: proposal.opId }
        }
      ]
    };
  }
}

export async function commitValidatedStagingArea(staging: StagingArea, options: CommitPatchOptions = {}): Promise<CommitPatchResult> {
  const validation = await validateStagingArea(staging);
  if (!validation.ok) {
    return {
      opId: staging.opId,
      backupRoot: options.backupRoot ?? '',
      changedFiles: [],
      diagnostics: validation.diagnostics
    };
  }

  const backupRoot = options.backupRoot ?? join(tmpdir(), `soulforge-backup-${staging.opId}`);
  const changedFiles: string[] = [];
  const diagnostics: Diagnostic[] = [...validation.diagnostics];

  for (const file of staging.files) {
    const backupPath = makeBackupPath(backupRoot, file);
    await mkdir(dirname(backupPath), { recursive: true });
    await copyFile(file.change.targetPath, backupPath);

    // Keep the final replacement as close to atomic as possible: write a sibling temp file, then rename.
    const siblingTemp = join(dirname(file.change.targetPath), `.soulforge-${staging.opId}-${basename(file.change.targetPath)}.tmp`);
    await copyFile(file.stagingPath, siblingTemp);
    await rename(siblingTemp, file.change.targetPath);
    changedFiles.push(file.change.targetPath);
  }

  return {
    opId: staging.opId,
    backupRoot,
    changedFiles,
    diagnostics
  };
}

async function applyChangeToStagingFile(change: PatchChange, stagingPath: string): Promise<void> {
  if (change.kind === 'binary') {
    throw new Error('Binary patch application is not enabled yet. Use structured parsers and validators first.');
  }

  if (change.kind === 'text') {
    const edit = parseTextContentEdit(change.structuredEdit);
    if (!edit) {
      // No edit body means this is a dry staging/copy operation.
      return;
    }
    await writeFile(stagingPath, edit.newText, 'utf8');
    return;
  }

  if (change.kind === 'structured') {
    throw new Error('Structured patch application requires a resource-specific writer and is not enabled yet.');
  }
}

function parseTextContentEdit(value: unknown): TextContentEdit | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.newText !== 'string') return null;
  return { newText: candidate.newText };
}

function allowsEmptyOutput(change: PatchChange): boolean {
  if (!change.structuredEdit || typeof change.structuredEdit !== 'object') return false;
  const candidate = change.structuredEdit as Record<string, unknown>;
  return candidate.allowEmpty === true;
}

function makeStagingPath(root: string, change: PatchChange): string {
  const safeTarget = change.targetUri.replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(root, safeTarget, basename(change.targetPath));
}

function makeBackupPath(backupRoot: string, file: StagedPatchFile): string {
  const safeTarget = file.change.targetUri.replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(backupRoot, safeTarget, basename(file.change.targetPath));
}

async function safeStat(path: string): Promise<{ size: number } | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function sha256File(path: string): Promise<string> {
  const content = await readFile(path);
  return createHash('sha256').update(content).digest('hex');
}
