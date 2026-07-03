import { cp, mkdir, mkdtemp } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Diagnostic, PatchChange, PatchMode, PatchProposal, ValidationResult } from '@soulforge/shared';

export interface CreatePatchProposalInput {
  workspaceId: string;
  title: string;
  author: 'user' | 'ai';
  mode: PatchMode;
  changes: PatchChange[];
}

export interface StagingArea {
  opId: string;
  root: string;
  copiedFiles: string[];
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
  const copiedFiles: string[] = [];

  for (const change of proposal.changes) {
    const targetFileName = basename(change.targetPath);
    const stagingPath = join(root, change.targetUri.replace(/[^a-zA-Z0-9._-]/g, '_'), targetFileName);
    await mkdir(dirname(stagingPath), { recursive: true });
    await cp(change.targetPath, stagingPath, { force: true });
    copiedFiles.push(stagingPath);
  }

  return { opId: proposal.opId, root, copiedFiles };
}

export async function validateStagingArea(staging: StagingArea): Promise<ValidationResult> {
  const diagnostics: Diagnostic[] = [];

  if (staging.copiedFiles.length === 0) {
    diagnostics.push({
      severity: 'error',
      code: 'PATCH_HAS_NO_FILES',
      message: 'Patch proposal did not stage any files.'
    });
  }

  return {
    ok: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
    diagnostics,
    retryable: true
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
