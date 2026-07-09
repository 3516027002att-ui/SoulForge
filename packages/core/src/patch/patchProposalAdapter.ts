/**
 * Compile legacy PatchProposal / PatchChange inputs into PatchIR.
 * Pure conversion — no filesystem I/O.
 *
 * text -> text_edit / file_replace
 * binary / structured -> blocked with NATIVE_WRITER_REQUIRED (or explicit block)
 */

import { randomUUID } from 'node:crypto';
import type {
  Diagnostic,
  PatchChange,
  PatchIR,
  PatchIrOperation,
  PatchProposal,
  PatchRiskLevel,
  StructuredDiagnostic
} from '@soulforge/shared';
import { createDiagnostic, toLegacyDiagnostic } from '@soulforge/shared';
import { collectAffectedResources, estimatePatchRisk, validatePatchIr } from '../patch-engine/patchIr.js';

export interface CompilePatchProposalResult {
  ok: boolean;
  patch?: PatchIR;
  operations: PatchIrOperation[];
  diagnostics: StructuredDiagnostic[];
  /** Legacy Diagnostic[] for callers still on the old shape. */
  legacyDiagnostics: Diagnostic[];
}

interface TextEditBody {
  newText: string;
  allowEmpty?: boolean;
}

/**
 * Convert a full legacy proposal into PatchIR.
 */
export function compilePatchProposalToPatchIr(proposal: PatchProposal): CompilePatchProposalResult {
  const operations: PatchIrOperation[] = [];
  const diagnostics: StructuredDiagnostic[] = [];

  if (!proposal.changes || proposal.changes.length === 0) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'PATCH_IR_EMPTY',
      message: 'Patch proposal has no changes to compile into PatchIR.'
    }));
    return fail(diagnostics);
  }

  for (const change of proposal.changes) {
    const compiled = compilePatchChangeToOperation(change);
    diagnostics.push(...compiled.diagnostics);
    if (compiled.operation) operations.push(compiled.operation);
  }

  if (operations.length === 0 || diagnostics.some((item) => item.severity === 'error')) {
    return fail(diagnostics, operations);
  }

  const author: PatchIR['author'] = proposal.author === 'ai' ? 'ai' : 'user';
  const riskLevel = maxRisk(
    estimatePatchRisk(operations),
    operations.reduce<PatchRiskLevel>((acc, op) => maxRisk(acc, op.riskLevel), 'safe')
  );

  const patch: PatchIR = {
    patchId: proposal.opId || randomUUID(),
    workspaceId: proposal.workspaceId,
    title: proposal.title,
    author,
    createdAt: proposal.createdAt,
    operations,
    affectedResources: collectAffectedResources(operations),
    riskLevel
  };

  const validation = validatePatchIr(patch);
  diagnostics.push(...validation.diagnostics);

  if (!validation.ok) {
    return fail(diagnostics, operations, patch);
  }

  return {
    ok: true,
    patch,
    operations,
    diagnostics,
    legacyDiagnostics: diagnostics.map(toLegacyDiagnostic)
  };
}

/**
 * Convert a single legacy PatchChange into a PatchIrOperation when supported.
 */
export function compilePatchChangeToOperation(change: PatchChange): {
  operation?: PatchIrOperation;
  diagnostics: StructuredDiagnostic[];
} {
  const diagnostics: StructuredDiagnostic[] = [];

  if (!change.targetUri || !change.targetPath) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'PATCH_OP_MISSING_TARGET',
      message: 'Patch change requires targetUri and targetPath.',
      targetUri: change.targetUri
    }));
    return { diagnostics };
  }

  if (change.kind === 'binary') {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'NATIVE_WRITER_REQUIRED',
      message: 'Binary PatchChange cannot be compiled to a scaffold writer. Native binary writers are not enabled.',
      targetUri: change.targetUri,
      details: { changeKind: change.kind, nativeFormatAuthority: false }
    }));
    return { diagnostics };
  }

  if (change.kind === 'structured') {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'NATIVE_WRITER_REQUIRED',
      message: 'Structured PatchChange requires a resource-specific writer (not implemented). Blocked by write-path consolidation.',
      targetUri: change.targetUri,
      details: {
        changeKind: change.kind,
        resourceKind: change.resourceKind,
        nativeFormatAuthority: false
      }
    }));
    return { diagnostics };
  }

  // kind === 'text'
  const body = parseTextEditBody(change.structuredEdit);
  if (!body) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'TEXT_EDIT_INVALID',
      message: 'Text PatchChange requires structuredEdit.newText string.',
      targetUri: change.targetUri
    }));
    return { diagnostics };
  }

  const op: Extract<PatchIrOperation, { kind: 'text_edit' }> = {
    id: randomUUID(),
    kind: 'text_edit',
    targetUri: change.targetUri,
    targetPath: change.targetPath,
    newText: body.newText,
    preconditions: [
      {
        type: 'overlay_writable',
        description: 'Target must be on overlay / sandbox workspace',
        targetUri: change.targetUri
      }
    ],
    validatorRequirements: [
      { validatorId: 'text_file', scope: 'before_staging', required: true },
      { validatorId: 'text_file', scope: 'staged_output', required: true }
    ],
    riskLevel: 'safe'
  };

  if (change.beforeHash) {
    op.expectedHash = change.beforeHash;
    op.preconditions.push({
      type: 'content_hash',
      description: 'Expected content hash before text edit',
      expectedHash: change.beforeHash,
      targetUri: change.targetUri
    });
  }
  if (change.resourceKind) op.resourceKind = change.resourceKind;
  if (body.allowEmpty !== undefined) op.allowEmpty = body.allowEmpty;

  return { operation: op, diagnostics };
}

function parseTextEditBody(value: unknown): TextEditBody | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.newText !== 'string') return null;
  const body: TextEditBody = { newText: candidate.newText };
  if (candidate.allowEmpty === true) body.allowEmpty = true;
  return body;
}

function fail(
  diagnostics: StructuredDiagnostic[],
  operations: PatchIrOperation[] = [],
  patch?: PatchIR
): CompilePatchProposalResult {
  return {
    ok: false,
    ...(patch ? { patch } : {}),
    operations,
    diagnostics,
    legacyDiagnostics: diagnostics.map(toLegacyDiagnostic)
  };
}

const RISK_RANK: Record<PatchRiskLevel, number> = {
  safe: 0,
  low: 1,
  caution: 2,
  medium: 3,
  high: 4,
  blocked: 5
};

function maxRisk(a: PatchRiskLevel, b: PatchRiskLevel): PatchRiskLevel {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}
