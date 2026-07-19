/**
 * Shared PatchIR tool handlers used by both:
 * - production ToolRegistry (`packages/core/src/ai/toolRegistry.ts`)
 * - optional legacy scaffold registry (direct import only; not re-exported from ai-tools index)
 *
 * Keeps dual-registry call sites, but one implementation for propose/stage/validate/commit/rollback.
 * Writers still only stage via WorkspaceTransaction; no direct overlay writes.
 */

import type { AuditLogStore, PatchIR, ResourceKind, StructuredDiagnostic } from '@soulforge/shared';
import {
  createPatchIr,
  createTextEditOperation,
  validatePatchIr
} from '../patch-engine/patchIr.js';
import {
  createWorkspaceTransaction,
  type WorkspaceTransaction
} from '../transactions/workspaceTransaction.js';

export interface PatchToolCoreSuccess<T = unknown> {
  ok: true;
  data: T;
  summary?: string;
  diagnostics?: StructuredDiagnostic[];
}

export interface PatchToolCoreFailure {
  ok: false;
  code: string;
  message: string;
  details?: unknown;
  diagnostics?: StructuredDiagnostic[];
}

export type PatchToolCoreResult<T = unknown> = PatchToolCoreSuccess<T> | PatchToolCoreFailure;

/** Production ToolResult-compatible shape (optional adapter). */
export interface PatchToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface PatchToolEnv {
  workspaceId: string;
  /** Required for stage/commit path; overlay/sandbox root only. */
  workspaceRoot?: string;
  /** Shared mutable bag across chained tool calls (lastPatch / lastTransaction). */
  state: Record<string, unknown>;
  auditLog?: AuditLogStore;
  actorId?: string;
  defaultTitle?: string;
  /** Aligns with PatchIR / shared ResourceKind. */
  resourceKind?: ResourceKind;
}

/**
 * Resolve/create the shared mutable bag for chained patch.* calls.
 *
 * Accepts either:
 * - ToolContext / ScaffoldToolContext-like objects that may own a `.state` field
 * - a plain mutable bag already used as state
 */
export function ensurePatchToolState(
  contextOrState: { state?: object } | object | undefined
): Record<string, unknown> {
  if (!contextOrState || typeof contextOrState !== 'object') {
    return {};
  }

  // Prefer a nested `.state` bag when the object looks like a tool context.
  // Heuristic: ToolContext/ScaffoldToolContext always carry mode and either
  // workspaceIndex or workspaceId. Never treat those context objects as the bag.
  const maybeContext = contextOrState as {
    state?: Record<string, unknown>;
    mode?: unknown;
    workspaceIndex?: unknown;
    workspaceId?: unknown;
    workspaceRoot?: unknown;
  };
  const looksLikeToolContext = (
    'mode' in maybeContext
    || 'workspaceIndex' in maybeContext
    || ('workspaceId' in maybeContext && 'workspaceRoot' in maybeContext)
  );
  if (looksLikeToolContext || Object.prototype.hasOwnProperty.call(contextOrState, 'state')) {
    if (!maybeContext.state) maybeContext.state = {};
    return maybeContext.state;
  }

  return contextOrState as Record<string, unknown>;
}

export function toPatchToolResult<T>(result: PatchToolCoreResult<T>): PatchToolResult<T> {
  if (result.ok) {
    return { ok: true, data: result.data };
  }
  return {
    ok: false,
    error: {
      code: result.code,
      message: result.message,
      ...(result.details === undefined ? {} : { details: result.details })
    }
  };
}

export function runPatchProposeTextEdit(
  input: unknown,
  env: PatchToolEnv
): PatchToolCoreResult<{ patch: PatchIR; validation: ReturnType<typeof validatePatchIr> }> {
  const value = asRecord(input);
  const targetUri = asString(value.targetUri);
  const targetPath = asString(value.targetPath);
  const newText = typeof value.newText === 'string' ? value.newText : undefined;
  if (!targetUri || !targetPath || newText === undefined) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: 'patch.proposeTextEdit requires targetUri, targetPath, and newText.'
    };
  }

  const title = asOptionalString(value.title) ?? env.defaultTitle ?? 'AI text edit';
  const op = createTextEditOperation({
    targetUri,
    targetPath,
    newText,
    ...(env.resourceKind !== undefined ? { resourceKind: env.resourceKind } : { resourceKind: 'msg' as const })
  });
  const patch = createPatchIr({
    workspaceId: env.workspaceId,
    title,
    author: 'ai',
    operations: [op]
  });
  const validation = validatePatchIr(patch);
  if (!validation.ok) {
    return {
      ok: false,
      code: 'INVALID_PATCH',
      message: 'Proposed PatchIR failed schema validation.',
      details: { diagnostics: validation.diagnostics },
      diagnostics: validation.diagnostics
    };
  }

  env.state.lastPatch = patch;
  return {
    ok: true,
    data: { patch, validation },
    summary: 'Text edit PatchIR proposed',
    diagnostics: validation.diagnostics
  };
}

export async function runPatchStage(
  input: unknown,
  env: PatchToolEnv
): Promise<PatchToolCoreResult<{
  transactionId: string;
  stagingRoot: string;
  status: ReturnType<WorkspaceTransaction['getStatus']>;
}>> {
  const value = asRecord(input);
  const patch = (value.patch as PatchIR | undefined) ?? (env.state.lastPatch as PatchIR | undefined);
  if (!patch) {
    return {
      ok: false,
      code: 'NO_PATCH',
      message: 'No PatchIR available to stage. Call patch.proposeTextEdit first.'
    };
  }

  const workspaceRoot = typeof env.workspaceRoot === 'string' ? env.workspaceRoot.trim() : '';
  if (!workspaceRoot) {
    return {
      ok: false,
      code: 'WORKSPACE_ROOT_REQUIRED',
      message: 'patch.stage requires workspaceRoot (active overlay root).'
    };
  }

  const tx = createWorkspaceTransaction({
    workspaceId: env.workspaceId,
    workspaceRoot,
    actor: { kind: 'agent', id: env.actorId ?? 'patch.stage' },
    ...(env.auditLog ? { auditLog: env.auditLog } : {})
  });
  tx.addPatch(patch);
  const staged = await tx.stage();
  if (!staged.ok) {
    return {
      ok: false,
      code: 'STAGE_FAILED',
      message: 'WorkspaceTransaction.stage failed.',
      details: { diagnostics: staged.diagnostics, status: tx.getStatus() },
      diagnostics: staged.diagnostics
    };
  }

  env.state.lastPatch = patch;
  env.state.lastTransaction = tx;
  return {
    ok: true,
    data: {
      transactionId: tx.transactionId,
      stagingRoot: staged.stagingRoot ?? '',
      status: tx.getStatus()
    },
    summary: 'Patch staged',
    diagnostics: staged.diagnostics
  };
}

export async function runPatchValidate(
  _input: unknown,
  env: PatchToolEnv
): Promise<PatchToolCoreResult<{
  transactionId: string;
  status: ReturnType<WorkspaceTransaction['getStatus']>;
}>> {
  const tx = env.state.lastTransaction as WorkspaceTransaction | undefined;
  if (!tx) {
    return {
      ok: false,
      code: 'NO_TRANSACTION',
      message: 'No staged transaction to validate. Call patch.stage first.'
    };
  }

  const result = await tx.validate();
  if (!result.ok) {
    return {
      ok: false,
      code: 'VALIDATE_FAILED',
      message: 'WorkspaceTransaction.validate failed.',
      details: { diagnostics: result.diagnostics, status: tx.getStatus() },
      diagnostics: result.diagnostics
    };
  }

  return {
    ok: true,
    data: {
      transactionId: tx.transactionId,
      status: tx.getStatus()
    },
    summary: 'Staged patch validated',
    diagnostics: result.diagnostics
  };
}

export async function runPatchCommit(
  _input: unknown,
  env: PatchToolEnv
): Promise<PatchToolCoreResult<{
  transactionId: string;
  committedPaths: string[];
  status: ReturnType<WorkspaceTransaction['getStatus']>;
}>> {
  const tx = env.state.lastTransaction as WorkspaceTransaction | undefined;
  if (!tx) {
    return {
      ok: false,
      code: 'NO_TRANSACTION',
      message: 'No validated transaction to commit. Call patch.validate first.'
    };
  }

  const result = await tx.commit();
  if (!result.ok) {
    return {
      ok: false,
      code: 'COMMIT_FAILED',
      message: 'WorkspaceTransaction.commit failed.',
      details: { diagnostics: result.diagnostics, status: tx.getStatus() },
      diagnostics: result.diagnostics
    };
  }

  return {
    ok: true,
    data: {
      transactionId: tx.transactionId,
      committedPaths: result.committedPaths,
      status: tx.getStatus()
    },
    summary: 'Patch committed',
    diagnostics: result.diagnostics
  };
}

export async function runPatchRollback(
  _input: unknown,
  env: PatchToolEnv
): Promise<PatchToolCoreResult<{
  transactionId: string;
  restoredPaths: string[];
  status: ReturnType<WorkspaceTransaction['getStatus']>;
}>> {
  const tx = env.state.lastTransaction as WorkspaceTransaction | undefined;
  if (!tx) {
    return {
      ok: false,
      code: 'NO_TRANSACTION',
      message: 'No transaction to rollback.'
    };
  }

  const result = await tx.rollback();
  if (!result.ok) {
    return {
      ok: false,
      code: 'ROLLBACK_FAILED',
      message: 'WorkspaceTransaction.rollback failed.',
      details: { diagnostics: result.diagnostics, status: tx.getStatus() },
      diagnostics: result.diagnostics
    };
  }

  return {
    ok: true,
    data: {
      transactionId: tx.transactionId,
      restoredPaths: result.restoredPaths,
      status: tx.getStatus()
    },
    summary: 'Patch rolled back',
    diagnostics: result.diagnostics
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
