/**
 * PatchIR validation and helpers for the architecture scaffold.
 */

import { randomUUID } from 'node:crypto';
import type {
  PatchIR,
  PatchIrOperation,
  PatchIrValidationResult,
  PatchRiskLevel,
  StructuredDiagnostic
} from '@soulforge/shared';
import {
  NATIVE_WRITER_REQUIRED_KINDS,
  SCAFFOLD_SUPPORTED_PATCH_KINDS,
  createDiagnostic
} from '@soulforge/shared';

const RISK_RANK: Record<PatchRiskLevel, number> = {
  safe: 0,
  low: 1,
  caution: 2,
  medium: 3,
  high: 4,
  blocked: 5
};

export function createPatchIr(input: {
  workspaceId: string;
  title: string;
  author: PatchIR['author'];
  operations: PatchIrOperation[];
  notes?: string;
}): PatchIR {
  const operations = input.operations.map((op) => ({
    ...op,
    id: op.id || randomUUID(),
    preconditions: op.preconditions ?? [],
    validatorRequirements: op.validatorRequirements ?? []
  }));
  const affectedResources = collectAffectedResources(operations);
  const riskLevel = estimatePatchRisk(operations);
  const patch: PatchIR = {
    patchId: randomUUID(),
    workspaceId: input.workspaceId,
    title: input.title,
    author: input.author,
    createdAt: new Date().toISOString(),
    operations,
    affectedResources,
    riskLevel
  };
  if (input.notes !== undefined) patch.notes = input.notes;
  return patch;
}

/**
 * Create a text_edit operation.
 * Production paths (saveTextResource) MUST pass expectedHash.
 * Low-level tests may omit expectedHash.
 */
export function createTextEditOperation(input: {
  targetUri: string;
  targetPath: string;
  newText: string;
  /** sha256 of original file; required for production saves. */
  expectedHash?: string;
  resourceKind?: PatchIrOperation['resourceKind'];
  allowEmpty?: boolean;
}): PatchIrOperation {
  const op: Extract<PatchIrOperation, { kind: 'text_edit' }> = {
    id: randomUUID(),
    kind: 'text_edit',
    targetUri: input.targetUri,
    targetPath: input.targetPath,
    newText: input.newText,
    preconditions: [
      {
        type: 'overlay_writable',
        description: 'Target must be on overlay / sandbox workspace',
        targetUri: input.targetUri
      }
    ],
    validatorRequirements: [
      { validatorId: 'text_file', scope: 'staged_output', required: true }
    ],
    riskLevel: 'safe'
  };
  if (input.expectedHash) {
    op.expectedHash = input.expectedHash;
    op.preconditions.push({
      type: 'content_hash',
      description: 'Expected content hash before edit',
      expectedHash: input.expectedHash,
      targetUri: input.targetUri
    });
  }
  if (input.resourceKind) op.resourceKind = input.resourceKind;
  if (input.allowEmpty !== undefined) op.allowEmpty = input.allowEmpty;
  return op;
}

export function createRawByteRangeOperation(input: {
  targetUri: string;
  targetPath: string;
  offset: number;
  length: number;
  replacement: Buffer | Uint8Array;
  expectedHash: string;
  resourceKind?: PatchIrOperation['resourceKind'];
}): PatchIrOperation {
  return {
    id: randomUUID(),
    kind: 'raw_byte_range_edit',
    targetUri: input.targetUri,
    targetPath: input.targetPath,
    offset: input.offset,
    length: input.length,
    replacementBase64: Buffer.from(input.replacement).toString('base64'),
    expectedHash: input.expectedHash,
    preconditions: [
      {
        type: 'content_hash',
        description: 'Raw edits require content hash precondition',
        expectedHash: input.expectedHash,
        targetUri: input.targetUri
      }
    ],
    validatorRequirements: [
      { validatorId: 'raw_file', scope: 'before_staging', required: true },
      { validatorId: 'raw_file', scope: 'staged_output', required: true }
    ],
    riskLevel: 'caution',
    ...(input.resourceKind ? { resourceKind: input.resourceKind } : {})
  };
}

export function validatePatchIr(patch: PatchIR): PatchIrValidationResult {
  const diagnostics: StructuredDiagnostic[] = [];

  if (!patch.patchId) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'PATCH_IR_MISSING_ID',
      message: 'PatchIR.patchId is required.'
    }));
  }
  if (!patch.workspaceId) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'PATCH_IR_MISSING_WORKSPACE',
      message: 'PatchIR.workspaceId is required.'
    }));
  }
  if (!Array.isArray(patch.operations) || patch.operations.length === 0) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'PATCH_IR_EMPTY',
      message: 'PatchIR must contain at least one operation.'
    }));
  }

  for (const op of patch.operations) {
    diagnostics.push(...validateOperation(op));
  }

  const affectedResources = collectAffectedResources(patch.operations);
  const estimatedRisk = maxRisk(estimatePatchRisk(patch.operations), patch.riskLevel);

  if (estimatedRisk === 'blocked') {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'PATCH_IR_BLOCKED',
      message: 'PatchIR is blocked due to unsupported or unsafe operations.',
      details: { affectedResources }
    }));
  }

  return {
    ok: diagnostics.every((item) => item.severity !== 'error'),
    diagnostics,
    affectedResources,
    estimatedRisk
  };
}

export function collectAffectedResources(operations: readonly PatchIrOperation[]): string[] {
  const uris = new Set<string>();
  for (const op of operations) {
    uris.add(op.targetUri);
    if ('fieldUri' in op && typeof op.fieldUri === 'string') uris.add(op.fieldUri);
    if ('containerUri' in op && typeof op.containerUri === 'string') uris.add(op.containerUri);
  }
  return [...uris];
}

export function collectPatchDiagnostics(patch: PatchIR): StructuredDiagnostic[] {
  return validatePatchIr(patch).diagnostics;
}

export function estimatePatchRisk(operations: readonly PatchIrOperation[]): PatchRiskLevel {
  if (operations.length === 0) return 'safe';
  let risk: PatchRiskLevel = 'safe';
  for (const op of operations) {
    if ((NATIVE_WRITER_REQUIRED_KINDS as readonly string[]).includes(op.kind)) {
      risk = maxRisk(risk, 'blocked');
      continue;
    }
    if (!(SCAFFOLD_SUPPORTED_PATCH_KINDS as readonly string[]).includes(op.kind)
      && op.kind !== 'resource_field_edit'
      && !op.kind.startsWith('resource_node')
      && !op.kind.startsWith('resource_edge')) {
      risk = maxRisk(risk, 'blocked');
      continue;
    }
    if (op.kind === 'raw_byte_range_edit') risk = maxRisk(risk, 'caution');
    if (op.kind === 'synthetic_resource_edit') risk = maxRisk(risk, 'low');
    if (op.kind === 'container_child_replace') risk = maxRisk(risk, 'high');
    if (op.riskLevel) risk = maxRisk(risk, op.riskLevel);
    // Unimplemented container mutations stay blocked.
    if (
      op.kind === 'container_child_add'
      || op.kind === 'container_child_delete'
      || op.kind === 'container_child_rename'
      || op.kind === 'container_child_move'
    ) {
      risk = maxRisk(risk, 'blocked');
    }
  }
  return risk;
}

function validateOperation(op: PatchIrOperation): StructuredDiagnostic[] {
  const diagnostics: StructuredDiagnostic[] = [];
  if (!op.id) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'PATCH_OP_MISSING_ID',
      message: 'Patch operation id is required.',
      targetUri: op.targetUri
    }));
  }
  if (!op.targetUri) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'PATCH_OP_MISSING_TARGET',
      message: 'Patch operation targetUri is required.'
    }));
  }

  if ((NATIVE_WRITER_REQUIRED_KINDS as readonly string[]).includes(op.kind)) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'NATIVE_WRITER_REQUIRED',
      message: `Operation ${op.kind} requires a native container writer, which is not implemented in the scaffold.`,
      targetUri: op.targetUri,
      details: { kind: op.kind }
    }));
  }

  if (op.kind === 'text_edit') {
    if (typeof op.newText !== 'string') {
      diagnostics.push(createDiagnostic({
        severity: 'error',
        code: 'TEXT_EDIT_INVALID',
        message: 'text_edit requires newText string.',
        targetUri: op.targetUri
      }));
    }
  }

  if (op.kind === 'raw_byte_range_edit') {
    if (!op.expectedHash) {
      diagnostics.push(createDiagnostic({
        severity: 'error',
        code: 'RAW_EDIT_HASH_REQUIRED',
        message: 'raw_byte_range_edit requires expectedHash precondition.',
        targetUri: op.targetUri
      }));
    }
    if (!Number.isFinite(op.offset) || op.offset < 0) {
      diagnostics.push(createDiagnostic({
        severity: 'error',
        code: 'RAW_EDIT_OFFSET_INVALID',
        message: 'raw_byte_range_edit offset must be a non-negative number.',
        targetUri: op.targetUri
      }));
    }
    if (!Number.isFinite(op.length) || op.length < 0) {
      diagnostics.push(createDiagnostic({
        severity: 'error',
        code: 'RAW_EDIT_LENGTH_INVALID',
        message: 'raw_byte_range_edit length must be a non-negative number.',
        targetUri: op.targetUri
      }));
    }
    if (!op.replacementBase64) {
      diagnostics.push(createDiagnostic({
        severity: 'error',
        code: 'RAW_EDIT_PAYLOAD_MISSING',
        message: 'raw_byte_range_edit requires replacementBase64.',
        targetUri: op.targetUri
      }));
    }
  }

  if (op.kind === 'file_replace') {
    if (op.newText === undefined && op.newContentBase64 === undefined) {
      diagnostics.push(createDiagnostic({
        severity: 'error',
        code: 'FILE_REPLACE_EMPTY',
        message: 'file_replace requires newText or newContentBase64.',
        targetUri: op.targetUri
      }));
    }
  }

  if (op.kind === 'container_child_replace') {
    if (!op.expectedContainerHash && !op.expectedHash) {
      diagnostics.push(createDiagnostic({
        severity: 'error',
        code: 'CONTAINER_HASH_REQUIRED',
        message: 'container_child_replace requires expectedContainerHash (or expectedHash).',
        targetUri: op.targetUri
      }));
    }
    if (!op.expectedChildHash) {
      diagnostics.push(createDiagnostic({
        severity: 'error',
        code: 'CONTAINER_CHILD_HASH_REQUIRED',
        message: 'container_child_replace requires expectedChildHash.',
        targetUri: op.targetUri
      }));
    }
    if (!op.childContentBase64) {
      diagnostics.push(createDiagnostic({
        severity: 'error',
        code: 'CONTAINER_CHILD_PAYLOAD_REQUIRED',
        message: 'container_child_replace requires childContentBase64.',
        targetUri: op.targetUri
      }));
    }
    if (!op.childPath && !op.childUri) {
      diagnostics.push(createDiagnostic({
        severity: 'error',
        code: 'CONTAINER_CHILD_PATH_REQUIRED',
        message: 'container_child_replace requires childPath or childUri.',
        targetUri: op.targetUri
      }));
    }
  }

  if (op.riskLevel === 'blocked') {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'PATCH_OP_BLOCKED',
      message: `Operation ${op.id} is marked blocked.`,
      targetUri: op.targetUri
    }));
  }

  return diagnostics;
}

function maxRisk(a: PatchRiskLevel, b: PatchRiskLevel): PatchRiskLevel {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}
