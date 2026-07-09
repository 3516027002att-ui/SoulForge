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

  if (change.kind === 'structured') {
    // Allow explicit raw schemas under structuredEdit.schemaId; otherwise block.
    const rawOp = tryCompileRawStructuredEdit(change);
    if (rawOp.operation || rawOp.diagnostics.length > 0) {
      return rawOp;
    }
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

  if (change.kind === 'binary') {
    const rawOp = tryCompileRawStructuredEdit(change);
    if (rawOp.operation || rawOp.diagnostics.some((d) => d.severity === 'error')) {
      return rawOp;
    }
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'BINARY_SCHEMA_REQUIRED',
      message: 'Binary PatchChange requires explicit structuredEdit schema (rawByteRangeEdit or rawFileReplaceBase64), expectedHash, and confirmation path.',
      targetUri: change.targetUri,
      details: { changeKind: change.kind, nativeFormatAuthority: false }
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

/**
 * Compile explicit raw schemas:
 * - rawByteRangeEdit
 * - rawFileReplaceBase64
 */
function tryCompileRawStructuredEdit(change: PatchChange): {
  operation?: PatchIrOperation;
  diagnostics: StructuredDiagnostic[];
} {
  const diagnostics: StructuredDiagnostic[] = [];
  if (!change.structuredEdit || typeof change.structuredEdit !== 'object') {
    return { diagnostics };
  }
  const body = change.structuredEdit as Record<string, unknown>;
  const schemaId = typeof body.schemaId === 'string' ? body.schemaId : '';
  const expectedHash = typeof body.expectedHash === 'string'
    ? body.expectedHash
    : change.beforeHash;

  if (schemaId === 'rawByteRangeEdit' || schemaId === 'soulforge.rawByteRangeEdit.v1') {
    if (!expectedHash) {
      diagnostics.push(createDiagnostic({
        severity: 'error',
        code: 'RAW_EDIT_HASH_REQUIRED',
        message: 'rawByteRangeEdit requires expectedHash.',
        targetUri: change.targetUri
      }));
      return { diagnostics };
    }
    const offset = Number(body.offset);
    const length = Number(body.length);
    const replacementBase64 = typeof body.replacementBase64 === 'string' ? body.replacementBase64 : '';
    if (!Number.isFinite(offset) || offset < 0 || !Number.isFinite(length) || length < 0 || !replacementBase64) {
      diagnostics.push(createDiagnostic({
        severity: 'error',
        code: 'RAW_EDIT_INVALID',
        message: 'rawByteRangeEdit requires offset, length, and replacementBase64.',
        targetUri: change.targetUri
      }));
      return { diagnostics };
    }
    const risk: PatchRiskLevel = body.nativePacked === true || body.highRisk === true ? 'high' : 'caution';
    const op: Extract<PatchIrOperation, { kind: 'raw_byte_range_edit' }> = {
      id: randomUUID(),
      kind: 'raw_byte_range_edit',
      targetUri: change.targetUri,
      targetPath: change.targetPath,
      offset,
      length,
      replacementBase64,
      expectedHash,
      preconditions: [{
        type: 'content_hash',
        description: 'Expected content hash before raw byte edit',
        expectedHash,
        targetUri: change.targetUri
      }],
      validatorRequirements: [
        { validatorId: 'raw_file', scope: 'before_staging', required: true },
        { validatorId: 'raw_file', scope: 'staged_output', required: true }
      ],
      riskLevel: risk,
      metadata: { requiresConfirmation: true, filesMode: true, schemaId },
      ...(change.resourceKind ? { resourceKind: change.resourceKind } : {})
    };
    return { operation: op, diagnostics };
  }

  if (schemaId === 'rawFileReplaceBase64' || schemaId === 'soulforge.rawFileReplaceBase64.v1') {
    if (!expectedHash && body.allowCreateNewFile !== true) {
      diagnostics.push(createDiagnostic({
        severity: 'error',
        code: 'RAW_REPLACE_HASH_REQUIRED',
        message: 'rawFileReplaceBase64 requires expectedHash for existing files.',
        targetUri: change.targetUri
      }));
      return { diagnostics };
    }
    const newContentBase64 = typeof body.newContentBase64 === 'string' ? body.newContentBase64 : '';
    if (!newContentBase64 && body.allowEmpty !== true) {
      diagnostics.push(createDiagnostic({
        severity: 'error',
        code: 'FILE_REPLACE_EMPTY',
        message: 'rawFileReplaceBase64 requires newContentBase64.',
        targetUri: change.targetUri
      }));
      return { diagnostics };
    }
    const risk: PatchRiskLevel = body.nativePacked === true || body.highRisk === true ? 'high' : 'caution';
    const op: Extract<PatchIrOperation, { kind: 'file_replace' }> = {
      id: randomUUID(),
      kind: 'file_replace',
      targetUri: change.targetUri,
      targetPath: change.targetPath,
      newContentBase64,
      preconditions: expectedHash
        ? [{
            type: 'content_hash',
            description: 'Expected content hash before raw replace',
            expectedHash,
            targetUri: change.targetUri
          }]
        : [],
      validatorRequirements: [
        { validatorId: 'whole_file_replace', scope: 'before_staging', required: true },
        { validatorId: 'file_risk', scope: 'before_staging', required: true }
      ],
      riskLevel: risk,
      requiresConfirmation: true,
      metadata: { requiresConfirmation: true, filesMode: true, schemaId },
      ...(expectedHash ? { expectedHash } : {}),
      ...(body.allowEmpty === true ? { allowEmpty: true } : {}),
      ...(body.allowCreateNewFile === true ? { allowCreateNewFile: true } : {}),
      ...(change.resourceKind ? { resourceKind: change.resourceKind } : {})
    };
    return { operation: op, diagnostics };
  }

  return { diagnostics };
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
