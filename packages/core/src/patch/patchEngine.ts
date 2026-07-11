/**
 * Legacy Patch Engine surface.
 *
 * Production commits no longer apply staging files independently.
 * They compile PatchProposal → PatchIR and execute WorkspaceTransaction
 * (see legacyPatchEngineAdapter.ts).
 *
 * createStagingArea remains for dry-run prep / graph attachment compatibility only.
 */

import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type {
  Diagnostic,
  OperationLogRecord,
  PatchChange,
  PatchMode,
  PatchProposal,
  ValidationResult
} from '@soulforge/shared';
import { attachGraphToProposal, buildGraphPatchFromProposal } from './graphPatch.js';
import type { OperationLogStore } from './operationLog.js';
import type { WorkspaceSession } from '../workspace/workspaceSession.js';
import {
  executePatchProposalThroughTransaction,
  stageAndValidateProposalThroughTransaction,
  toExecuteOptions
} from './legacyPatchEngineAdapter.js';

export interface CreatePatchProposalInput {
  workspaceId: string;
  title: string;
  author: 'user' | 'ai';
  mode: PatchMode;
  changes: PatchChange[];
  attachGraph?: boolean;
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
  proposal: PatchProposal;
}

export interface CommitPatchOptions {
  backupRoot?: string;
  operationLog?: OperationLogStore;
  session?: WorkspaceSession;
  /** Explicit sandbox / overlay root for WorkspaceTransaction. */
  workspaceRoot?: string;
  recoveryDir?: string;
}

export interface CommitPatchResult {
  opId: string;
  backupRoot: string;
  changedFiles: string[];
  diagnostics: Diagnostic[];
  operation?: OperationLogRecord;
}

interface TextContentEdit {
  newText: string;
}

export function createPatchProposal(input: CreatePatchProposalInput): PatchProposal {
  const proposal: PatchProposal = {
    opId: randomUUID(),
    workspaceId: input.workspaceId,
    title: input.title,
    author: input.author,
    mode: input.mode,
    changes: input.changes,
    createdAt: new Date().toISOString()
  };

  if (input.attachGraph === false) return proposal;
  return attachGraphToProposal(proposal);
}

/**
 * Compatibility staging helper.
 * Does NOT authorize production commit by itself — commitValidatedStagingArea
 * always re-executes through WorkspaceTransaction.
 */
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
      change: {
        ...change,
        beforeHash,
        afterHash,
        layer: change.layer ?? 'overlay'
      },
      stagingPath,
      beforeHash,
      afterHash
    });
  }

  const withHashes: PatchProposal = {
    ...proposal,
    changes: stagedFiles.map((file) => file.change),
    graph: buildGraphPatchFromProposal({
      ...proposal,
      changes: stagedFiles.map((file) => file.change)
    })
  };

  return { opId: proposal.opId, root, files: stagedFiles, proposal: withHashes };
}

/**
 * @deprecated Prefer stageAndValidateProposalThroughTransaction.
 * Kept for API compatibility; validates via WorkspaceTransaction when possible.
 */
export async function validateStagingArea(
  staging: StagingArea,
  session?: WorkspaceSession
): Promise<ValidationResult> {
  return stageAndValidateProposalThroughTransaction(staging.proposal, {
    ...(session ? { session } : {})
  });
}

export async function dryRunPatchProposal(
  proposal: PatchProposal,
  session?: WorkspaceSession
): Promise<ValidationResult> {
  try {
    return await stageAndValidateProposalThroughTransaction(proposal, {
      ...(session ? { session } : {})
    });
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

/**
 * Production commit entry for legacy StagingArea callers.
 *
 * Does NOT apply staging.files to the overlay directly.
 * Recompiles staging.proposal into PatchIR and commits via WorkspaceTransaction.
 */
export async function commitValidatedStagingArea(
  staging: StagingArea,
  options: CommitPatchOptions = {}
): Promise<CommitPatchResult> {
  return executePatchProposalThroughTransaction(
    staging.proposal,
    toExecuteOptions(options)
  );
}

/**
 * Preferred production entry when the caller already has a PatchProposal.
 */
export async function commitPatchProposal(
  proposal: PatchProposal,
  options: CommitPatchOptions = {}
): Promise<CommitPatchResult> {
  return executePatchProposalThroughTransaction(proposal, toExecuteOptions(options));
}

async function applyChangeToStagingFile(change: PatchChange, stagingPath: string): Promise<void> {
  if (change.kind === 'binary') {
    throw new Error('Binary patch application is not enabled yet. Use structured parsers and validators first.');
  }

  if (change.kind === 'text') {
    const edit = parseTextContentEdit(change.structuredEdit);
    if (!edit) {
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

function makeStagingPath(root: string, change: PatchChange): string {
  const safeTarget = change.targetUri.replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(root, safeTarget, basename(change.targetPath));
}

async function sha256File(path: string): Promise<string> {
  const content = await readFile(path);
  return createHash('sha256').update(content).digest('hex');
}
