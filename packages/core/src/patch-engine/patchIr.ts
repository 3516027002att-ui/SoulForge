/**
 * PatchIR validation and helpers for the architecture scaffold.
 */

import { createHash, randomUUID } from 'node:crypto';
import type {
  PatchTypedValue,
  PatchIR,
  PatchIrOperation,
  PatchIrValidationResult,
  PatchRiskLevel,
  ResourceEdgePayload,
  ResourceKind,
  ResourceNodePayload,
  StructuredDiagnostic
} from '@soulforge/shared';
import {
  NATIVE_WRITER_REQUIRED_KINDS,
  PATCH_IR_SCHEMA_VERSION,
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
const MAX_INLINE_TYPED_BYTES = 256 * 1024;
const RESOURCE_KINDS = new Set<ResourceKind>([
  'event', 'map', 'param', 'msg', 'menu', 'script', 'action', 'ai',
  'sfx', 'chr', 'obj', 'other', 'unknown'
]);
const PATCH_OPERATION_KINDS = new Set<string>([
  ...SCAFFOLD_SUPPORTED_PATCH_KINDS,
  ...NATIVE_WRITER_REQUIRED_KINDS
]);

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
    schemaVersion: PATCH_IR_SCHEMA_VERSION,
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

export function validatePatchIr(input: unknown): PatchIrValidationResult {
  const diagnostics: StructuredDiagnostic[] = [];
  if (!isRecord(input)) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'PATCH_IR_INVALID_ROOT',
      message: 'PatchIR must be an object.'
    }));
    return {
      ok: false,
      diagnostics,
      affectedResources: [],
      estimatedRisk: 'blocked'
    };
  }
  const patch = input;

  if (patch.schemaVersion !== PATCH_IR_SCHEMA_VERSION) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'PATCH_IR_SCHEMA_VERSION_UNSUPPORTED',
      message: `PatchIR.schemaVersion must be ${PATCH_IR_SCHEMA_VERSION}.`,
      details: { received: patch.schemaVersion ?? null }
    }));
  }

  if (!isNonEmptyString(patch.patchId)) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'PATCH_IR_MISSING_ID',
      message: 'PatchIR.patchId is required.'
    }));
  }
  if (!isNonEmptyString(patch.workspaceId)) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'PATCH_IR_MISSING_WORKSPACE',
      message: 'PatchIR.workspaceId is required.'
    }));
  }
  if (!isNonEmptyString(patch.title)
    || !['user', 'ai', 'system'].includes(String(patch.author))
    || !isNonEmptyString(patch.createdAt)
    || !Number.isFinite(Date.parse(String(patch.createdAt)))) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'PATCH_IR_HEADER_INVALID',
      message: 'PatchIR requires title, author, and an ISO-compatible createdAt timestamp.'
    }));
  }

  const operations: PatchIrOperation[] = [];
  if (!Array.isArray(patch.operations) || patch.operations.length === 0) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'PATCH_IR_EMPTY',
      message: 'PatchIR must contain at least one operation.'
    }));
  } else {
    for (const candidate of patch.operations) {
      if (!isPatchIrOperationBase(candidate)) {
        diagnostics.push(createDiagnostic({
          severity: 'error',
          code: 'PATCH_OP_INVALID_SHAPE',
          message: 'Patch operation requires a known kind, id, targetUri, risk, preconditions, and validators.'
        }));
        continue;
      }
      operations.push(candidate);
      diagnostics.push(...validateOperation(candidate));
    }
  }

  const affectedResources = collectAffectedResources(operations);
  if (!Array.isArray(patch.affectedResources)
    || !patch.affectedResources.every(isNonEmptyString)
    || !sameStringSet(patch.affectedResources, affectedResources)) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'PATCH_IR_AFFECTED_RESOURCES_MISMATCH',
      message: 'PatchIR.affectedResources must exactly match operation-derived resource URIs.',
      details: { expected: affectedResources }
    }));
  }

  const declaredRisk = isPatchRiskLevel(patch.riskLevel) ? patch.riskLevel : 'blocked';
  if (!isPatchRiskLevel(patch.riskLevel)) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'PATCH_IR_RISK_INVALID',
      message: 'PatchIR.riskLevel is invalid.'
    }));
  }
  const operationRisk = estimatePatchRisk(operations);
  const estimatedRisk = maxRisk(operationRisk, declaredRisk);
  if (RISK_RANK[declaredRisk] < RISK_RANK[operationRisk]) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'PATCH_IR_RISK_UNDERESTIMATED',
      message: 'PatchIR.riskLevel cannot be lower than operation-derived risk.',
      details: { declaredRisk, operationRisk }
    }));
  }

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
    if ((NATIVE_WRITER_REQUIRED_KINDS as readonly string[]).includes(op.kind) && !hasDeclaredWriterAuthority(op)) {
      risk = maxRisk(risk, 'blocked');
      continue;
    }
    if (!(SCAFFOLD_SUPPORTED_PATCH_KINDS as readonly string[]).includes(op.kind)
      && !hasDeclaredWriterAuthority(op)
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
    if (!hasNativeBnd4Authority(op) && (
      op.kind === 'container_child_add'
      || op.kind === 'container_child_delete'
      || op.kind === 'container_child_rename'
      || op.kind === 'container_child_move'
    )) {
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

  const validatorRequirementKeys = new Set<string>();
  for (const requirement of op.validatorRequirements) {
    if (!isRecord(requirement)
      || !isNonEmptyString(requirement.validatorId)
      || !['before_staging', 'staged_output', 'after_commit', 'any'].includes(String(requirement.scope))
      || typeof requirement.required !== 'boolean') {
      diagnostics.push(operationError(
        op,
        'PATCH_VALIDATOR_REQUIREMENT_INVALID',
        'validatorRequirements entries require validatorId, a known scope, and required boolean.'
      ));
      continue;
    }
    const key = `${requirement.validatorId}:${requirement.scope}`;
    if (validatorRequirementKeys.has(key)) {
      diagnostics.push(operationError(
        op,
        'PATCH_VALIDATOR_REQUIREMENT_DUPLICATE',
        `Duplicate validator requirement ${key}.`
      ));
    }
    validatorRequirementKeys.add(key);
    if (requirement.required && requirement.scope === 'any') {
      diagnostics.push(operationError(
        op,
        'PATCH_VALIDATOR_REQUIRED_SCOPE_AMBIGUOUS',
        'Required validators must bind to a concrete transaction phase instead of scope=any.'
      ));
    }
  }

  if ((NATIVE_WRITER_REQUIRED_KINDS as readonly string[]).includes(op.kind) && !hasDeclaredWriterAuthority(op)) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'NATIVE_WRITER_REQUIRED',
      message: `Operation ${op.kind} requires an explicitly declared authority writer.`,
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

  if (op.kind === 'resource_field_edit') {
    diagnostics.push(...validateDocumentBinding(op));
    if (!isPatchTypedValue(op.previousValue) || !isPatchTypedValue(op.nextValue)) {
      diagnostics.push(operationError(
        op,
        'PATCH_FIELD_TYPED_VALUE_INVALID',
        'resource_field_edit requires valid discriminated previousValue and nextValue.'
      ));
    }
    if (!op.inverse || op.inverse.kind !== 'resource_field_edit'
      || op.inverse.fieldUri !== op.fieldUri
      || !isPatchTypedValue(op.inverse.value)
      || !patchTypedValueEquals(op.inverse.value, op.previousValue)) {
      diagnostics.push(operationError(
        op,
        'PATCH_FIELD_INVERSE_INVALID',
        'resource_field_edit inverse must restore the exact previous typed value.'
      ));
    }
    for (const [field, value] of [
      ['schemaId', op.schemaId],
      ['schemaVersion', op.schemaVersion],
      ['layoutFingerprint', op.layoutFingerprint],
      ['fieldUri', op.fieldUri]
    ] as const) {
      if (!isNonEmptyString(value)) {
        diagnostics.push(operationError(
          op,
          'PATCH_FIELD_BINDING_INVALID',
          `resource_field_edit requires non-empty ${field}.`
        ));
      }
    }
  }

  if (op.kind.startsWith('resource_node_')) {
    diagnostics.push(...validateResourceNodeOperation(
      op as Extract<PatchIrOperation, { kind: `resource_node_${string}` }>
    ));
  }

  if (op.kind.startsWith('resource_edge_')) {
    diagnostics.push(...validateResourceEdgeOperation(
      op as Extract<PatchIrOperation, { kind: `resource_edge_${string}` }>
    ));
  }

  if (op.kind === 'asset_import_replace') {
    diagnostics.push(...validateAssetImportReplace(op));
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

function hasNativeBnd4Authority(op: PatchIrOperation): boolean {
  return op.kind.startsWith('container_child_')
    && 'containerFormat' in op
    && op.containerFormat === 'BND4_DFLT'
    && op.metadata?.nativeFormatAuthority === true;
}

function hasDeclaredWriterAuthority(op: PatchIrOperation): boolean {
  if (hasNativeBnd4Authority(op)) return true;
  return 'writerId' in op
    && typeof op.writerId === 'string'
    && op.writerId.trim().length > 0
    && op.metadata?.nativeFormatAuthority === true;
}

function validateDocumentBinding(
  op: Extract<PatchIrOperation, {
    kind:
      | 'resource_field_edit'
      | 'resource_node_add'
      | 'resource_node_delete'
      | 'resource_node_update'
      | 'resource_node_reorder'
      | 'resource_node_convert'
      | 'resource_edge_add'
      | 'resource_edge_delete'
      | 'resource_edge_update';
  }>
): StructuredDiagnostic[] {
  const diagnostics: StructuredDiagnostic[] = [];
  for (const [field, value] of [
    ['documentUri', op.documentUri],
    ['documentRevision', op.documentRevision],
    ['writerId', op.writerId],
    ['resourceKind', op.resourceKind]
  ] as const) {
    if (field === 'resourceKind' ? !isResourceKind(value) : !isNonEmptyString(value)) {
      diagnostics.push(operationError(
        op,
        'PATCH_SEMANTIC_BINDING_INVALID',
        `${op.kind} requires non-empty ${field}.`
      ));
    }
  }
  if (!isSha256(op.expectedDocumentHash)) {
    diagnostics.push(operationError(
      op,
      'PATCH_SEMANTIC_DOCUMENT_HASH_INVALID',
      `${op.kind} requires expectedDocumentHash as SHA-256 hex.`
    ));
  }
  return diagnostics;
}

function validateResourceNodeOperation(
  op: Extract<PatchIrOperation, {
    kind:
      | 'resource_node_add'
      | 'resource_node_delete'
      | 'resource_node_update'
      | 'resource_node_reorder'
      | 'resource_node_convert';
  }>
): StructuredDiagnostic[] {
  const diagnostics = validateDocumentBinding(op);
  if (!isNonEmptyString(op.nodeId)) {
    diagnostics.push(operationError(op, 'PATCH_NODE_ID_INVALID', `${op.kind} requires nodeId.`));
  }

  if (op.kind === 'resource_node_add') {
    if (!isResourceNodePayload(op.payload) || op.payload.resourceKind !== op.resourceKind) {
      diagnostics.push(operationError(
        op,
        'PATCH_NODE_PAYLOAD_INVALID',
        'resource_node_add requires a valid payload matching resourceKind.'
      ));
    }
    if (op.inverse?.kind !== 'resource_node_delete'
      || op.inverse.nodeId !== op.nodeId
      || !isSha256(op.inverse.expectedNodeHash)
      || (isResourceNodePayload(op.payload)
        && op.inverse.expectedNodeHash.toLowerCase() !== op.payload.snapshot.sha256.toLowerCase())) {
      diagnostics.push(operationError(
        op,
        'PATCH_NODE_INVERSE_INVALID',
        'resource_node_add inverse must delete the exact node with its staged hash.'
      ));
    }
  } else if (op.kind === 'resource_node_delete') {
    if (!isSha256(op.expectedNodeHash)) {
      diagnostics.push(operationError(
        op,
        'PATCH_NODE_HASH_INVALID',
        'resource_node_delete requires expectedNodeHash.'
      ));
    }
    if (op.inverse?.kind !== 'resource_node_add'
      || op.inverse.nodeId !== op.nodeId
      || !isResourceNodePayload(op.inverse.payload)
      || op.inverse.payload.resourceKind !== op.resourceKind
      || (isResourceNodePayload(op.inverse.payload)
        && isSha256(op.expectedNodeHash)
        && op.inverse.payload.snapshot.sha256.toLowerCase() !== op.expectedNodeHash.toLowerCase())) {
      diagnostics.push(operationError(
        op,
        'PATCH_NODE_INVERSE_INVALID',
        'resource_node_delete inverse must preserve a complete typed add payload.'
      ));
    }
  } else if (op.kind === 'resource_node_update') {
    if (!isSha256(op.expectedNodeHash)
      || !isResourceNodePayload(op.payload)
      || op.payload.resourceKind !== op.resourceKind) {
      diagnostics.push(operationError(
        op,
        'PATCH_NODE_UPDATE_INVALID',
        'resource_node_update requires expectedNodeHash and a matching typed payload.'
      ));
    }
    if (op.inverse?.kind !== 'resource_node_update'
      || op.inverse.nodeId !== op.nodeId
      || !isResourceNodePayload(op.inverse.payload)
      || op.inverse.payload.resourceKind !== op.resourceKind
      || (isResourceNodePayload(op.inverse.payload)
        && isSha256(op.expectedNodeHash)
        && op.inverse.payload.snapshot.sha256.toLowerCase() !== op.expectedNodeHash.toLowerCase())) {
      diagnostics.push(operationError(
        op,
        'PATCH_NODE_INVERSE_INVALID',
        'resource_node_update inverse must preserve the previous typed payload.'
      ));
    }
  } else if (op.kind === 'resource_node_reorder') {
    if (!isUniqueStringOrder(op.expectedOrder) || !op.expectedOrder.includes(op.nodeId)
      || (op.beforeNodeId !== undefined
        && (op.beforeNodeId === op.nodeId || !op.expectedOrder.includes(op.beforeNodeId)))) {
      diagnostics.push(operationError(
        op,
        'PATCH_NODE_REORDER_INVALID',
        'resource_node_reorder requires a unique expectedOrder containing node and anchor identities.'
      ));
    }
    if (op.inverse?.kind !== 'resource_node_reorder'
      || !isUniqueStringOrder(op.inverse.previousOrder)
      || !op.inverse.previousOrder.includes(op.nodeId)
      || op.inverse.parentNodeId !== op.parentNodeId
      || op.inverse.previousOrder.length !== op.expectedOrder.length
      || op.inverse.previousOrder.some((nodeId, index) => nodeId !== op.expectedOrder[index])) {
      diagnostics.push(operationError(
        op,
        'PATCH_NODE_INVERSE_INVALID',
        'resource_node_reorder inverse must preserve the complete previous sibling order.'
      ));
    }
  } else {
    if (!isSha256(op.expectedNodeHash)
      || !isNonEmptyString(op.fromType)
      || !isNonEmptyString(op.toType)
      || op.fromType === op.toType
      || !isResourceNodePayload(op.payload)
      || op.payload.resourceKind !== op.resourceKind) {
      diagnostics.push(operationError(
        op,
        'PATCH_NODE_CONVERT_INVALID',
        'resource_node_convert requires distinct types, expectedNodeHash, and a matching typed payload.'
      ));
    }
    if (op.inverse?.kind !== 'resource_node_convert'
      || op.inverse.nodeId !== op.nodeId
      || op.inverse.previousType !== op.fromType
      || !isResourceNodePayload(op.inverse.payload)
      || op.inverse.payload.resourceKind !== op.resourceKind
      || (isResourceNodePayload(op.inverse.payload)
        && isSha256(op.expectedNodeHash)
        && op.inverse.payload.snapshot.sha256.toLowerCase() !== op.expectedNodeHash.toLowerCase())) {
      diagnostics.push(operationError(
        op,
        'PATCH_NODE_INVERSE_INVALID',
        'resource_node_convert inverse must preserve the previous type and complete payload.'
      ));
    }
  }
  return diagnostics;
}

function validateResourceEdgeOperation(
  op: Extract<PatchIrOperation, {
    kind: 'resource_edge_add' | 'resource_edge_delete' | 'resource_edge_update';
  }>
): StructuredDiagnostic[] {
  const diagnostics = validateDocumentBinding(op);
  const expectedInverseKind = op.kind === 'resource_edge_add'
    ? 'resource_edge_delete'
    : op.kind === 'resource_edge_delete'
      ? 'resource_edge_add'
      : 'resource_edge_update';
  if (!isNonEmptyString(op.edgeId)
    || !isResourceEdgePayload(op.payload)
    || op.inverse?.kind !== expectedInverseKind
    || op.inverse?.edgeId !== op.edgeId
    || !isResourceEdgePayload(op.inverse?.payload)) {
    diagnostics.push(operationError(
      op,
      'PATCH_EDGE_PAYLOAD_INVALID',
      `${op.kind} requires typed current and inverse edge payloads bound to edgeId.`
    ));
  }
  return diagnostics;
}

function validateAssetImportReplace(
  op: Extract<PatchIrOperation, { kind: 'asset_import_replace' }>
): StructuredDiagnostic[] {
  const diagnostics: StructuredDiagnostic[] = [];
  const formats = new Set(['gltf', 'glb', 'png', 'tga', 'dds']);
  if (!isNonEmptyString(op.sourceImportObjectId)
    || !formats.has(op.importFormat)
    || !isNonEmptyString(op.targetAssetUri)
    || op.targetAssetUri !== op.targetUri
    || !isNonEmptyString(op.conversionRuleId)
    || !isNonEmptyString(op.writerId)
    || !isSha256(op.expectedTargetHash)
    || !Array.isArray(op.generatedStagingObjects)
    || op.generatedStagingObjects.length === 0
    || op.generatedStagingObjects.some((item) =>
      !isNonEmptyString(item?.objectId)
      || !isNonEmptyString(item?.mediaType)
      || !isSha256(item?.sha256)
      || !Number.isSafeInteger(item?.size)
      || item.size < 0)
    || new Set(op.generatedStagingObjects.map((item) => item.objectId)).size
      !== op.generatedStagingObjects.length) {
    diagnostics.push(operationError(
      op,
      'PATCH_ASSET_IMPORT_INVALID',
      'asset_import_replace requires bound import/target identities and unique verified staging objects.'
    ));
  }
  if (op.inverse?.kind !== 'asset_import_replace'
    || !isSha256(op.inverse.previousAssetObjectHash)
    || (isSha256(op.expectedTargetHash)
      && op.inverse.previousAssetObjectHash.toLowerCase() !== op.expectedTargetHash.toLowerCase())
    || !isNonEmptyString(op.inverse.backupRef)) {
    diagnostics.push(operationError(
      op,
      'PATCH_ASSET_INVERSE_INVALID',
      'asset_import_replace inverse must bind the previous object hash and backup reference.'
    ));
  }
  return diagnostics;
}

function isPatchTypedValue(value: unknown, depth = 0): value is PatchTypedValue {
  if (!isRecord(value) || depth > 32 || typeof value.valueType !== 'string') return false;
  switch (value.valueType) {
    case 'null': return value.value === null;
    case 'boolean': return typeof value.value === 'boolean';
    case 'integer': return Number.isSafeInteger(value.value);
    case 'float': return typeof value.value === 'number' && Number.isFinite(value.value);
    case 'string': return typeof value.value === 'string';
    case 'bytes': return isInlineBase64(value.base64);
    case 'enum':
      return isNonEmptyString(value.enumId)
        && (typeof value.value === 'string' || Number.isSafeInteger(value.value));
    case 'flags':
      return isNonEmptyString(value.enumId)
        && Array.isArray(value.values)
        && value.values.every((item) => typeof item === 'string' || Number.isSafeInteger(item));
    case 'array':
      return Array.isArray(value.items)
        && value.items.length <= 10_000
        && value.items.every((item) => isPatchTypedValue(item, depth + 1));
    case 'object': {
      if (!isRecord(value.fields)) return false;
      const entries = Object.entries(value.fields);
      return entries.length <= 10_000
        && entries.every(([key, item]) => isSafeObjectKey(key) && isPatchTypedValue(item, depth + 1));
    }
    default: return false;
  }
}

function patchTypedValueEquals(left: PatchTypedValue, right: PatchTypedValue): boolean {
  if (left.valueType !== right.valueType) return false;
  if (left.valueType === 'array' && right.valueType === 'array') {
    return left.items.length === right.items.length
      && left.items.every((item, index) => patchTypedValueEquals(item, right.items[index]!));
  }
  if (left.valueType === 'object' && right.valueType === 'object') {
    const leftKeys = Object.keys(left.fields).sort();
    const rightKeys = Object.keys(right.fields).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index]
        && patchTypedValueEquals(left.fields[key]!, right.fields[key]!));
  }
  if (left.valueType === 'flags' && right.valueType === 'flags') {
    return left.enumId === right.enumId
      && left.values.length === right.values.length
      && left.values.every((value, index) => value === right.values[index]);
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function isResourceNodePayload(value: unknown): value is ResourceNodePayload {
  if (!isRecord(value) || value.payloadVersion !== 1
    || !isResourceKind(value.resourceKind)
    || !isNonEmptyString(value.nodeType)
    || !isPreservedSnapshot(value.snapshot)) return false;
  switch (value.nodeType) {
    case 'emevd_event':
      return value.resourceKind === 'event'
        && Number.isSafeInteger(value.eventId)
        && Number.isSafeInteger(value.eventIndex) && Number(value.eventIndex) >= 0
        && Number.isSafeInteger(value.restartType)
        && isSha256(value.eventHash);
    case 'emevd_instruction':
      return value.resourceKind === 'event'
        && Number.isSafeInteger(value.eventId)
        && Number.isSafeInteger(value.eventIndex) && Number(value.eventIndex) >= 0
        && Number.isSafeInteger(value.instructionIndex) && Number(value.instructionIndex) >= 0
        && Number.isSafeInteger(value.bank)
        && Number.isSafeInteger(value.instructionId)
        && Number.isSafeInteger(value.layerOffset)
        && Number.isSafeInteger(value.parameterCount) && Number(value.parameterCount) >= 0
        && isSha256(value.instructionHash)
        && isBinaryContentRef(value.args)
        && isRecord(value.snapshot)
        && value.snapshot.sha256 === value.instructionHash;
    case 'param_row':
      return value.resourceKind === 'param'
        && isNonEmptyString(value.paramType)
        && Number.isSafeInteger(value.rowId)
        && (value.rowName === undefined || typeof value.rowName === 'string');
    case 'fmg_entry':
      return value.resourceKind === 'msg'
        && Number.isSafeInteger(value.entryId)
        && Number.isSafeInteger(value.stringIndex)
        && Number(value.stringIndex) >= 0
        && typeof value.text === 'string';
    case 'msb_entity':
      return value.resourceKind === 'map'
        && ['model', 'part', 'region', 'event'].includes(String(value.entityKind))
        && Number.isSafeInteger(value.entityIndex) && Number(value.entityIndex) >= 0
        && (value.entityId === undefined || Number.isSafeInteger(value.entityId))
        && typeof value.name === 'string';
    case 'opaque_resource':
      return !['event', 'param', 'msg', 'map'].includes(value.resourceKind)
        && isNonEmptyString(value.formatId);
    default: return false;
  }
}

function isResourceEdgePayload(value: unknown): value is ResourceEdgePayload {
  if (!isRecord(value) || value.payloadVersion !== 1
    || !isNonEmptyString(value.relationType)
    || !isNonEmptyString(value.sourceUri)
    || !isNonEmptyString(value.targetUri)) return false;
  if (value.attributes === undefined) return true;
  return isRecord(value.attributes)
    && Object.entries(value.attributes).every(([key, item]) =>
      isSafeObjectKey(key)
      && (item === null || ['string', 'number', 'boolean'].includes(typeof item))
      && (typeof item !== 'number' || Number.isFinite(item)));
}

function isPreservedSnapshot(value: unknown): boolean {
  if (!isRecord(value)
    || !isNonEmptyString(value.formatId)
    || !isNonEmptyString(value.schemaVersion)
    || !isBinaryContentRef(value)) return false;
  return true;
}

function isBinaryContentRef(value: unknown): boolean {
  if (!isRecord(value)
    || !isSha256(value.sha256)
    || !Number.isSafeInteger(value.size)
    || Number(value.size) < 0) return false;
  if (value.storage === 'staging_object') {
    return isNonEmptyString(value.objectId);
  }
  if (value.storage !== 'inline'
    || !isInlineBase64(value.dataBase64)) return false;
  const bytes = Buffer.from(value.dataBase64, 'base64');
  if (bytes.length !== value.size) return false;
  const actual = createHash('sha256').update(bytes).digest('hex');
  return actual.toLowerCase() === value.sha256.toLowerCase();
}

function isInlineBase64(value: unknown): value is string {
  return isCanonicalBase64(value)
    && Buffer.byteLength(value, 'base64') <= MAX_INLINE_TYPED_BYTES;
}

function isCanonicalBase64(value: unknown): value is string {
  if (typeof value !== 'string' || /\s/.test(value)) return false;
  try {
    return Buffer.from(value, 'base64').toString('base64') === value;
  } catch {
    return false;
  }
}

function isUniqueStringOrder(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every(isNonEmptyString)
    && new Set(value).size === value.length;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPatchIrOperationBase(value: unknown): value is PatchIrOperation {
  return isRecord(value)
    && typeof value.kind === 'string'
    && PATCH_OPERATION_KINDS.has(value.kind)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.targetUri)
    && isPatchRiskLevel(value.riskLevel)
    && Array.isArray(value.preconditions)
    && Array.isArray(value.validatorRequirements);
}

function isPatchRiskLevel(value: unknown): value is PatchRiskLevel {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(RISK_RANK, value);
}

function sameStringSet(left: unknown[], right: string[]): boolean {
  if (left.length !== new Set(left).size) return false;
  const leftSet = new Set(left);
  return leftSet.size === right.length && right.every((item) => leftSet.has(item));
}

function isSafeObjectKey(value: string): boolean {
  return value.trim().length > 0
    && value !== '__proto__' && value !== 'prototype' && value !== 'constructor';
}

function isResourceKind(value: unknown): value is ResourceKind {
  return typeof value === 'string' && RESOURCE_KINDS.has(value as ResourceKind);
}

function operationError(
  op: PatchIrOperation,
  code: string,
  message: string
): StructuredDiagnostic {
  return createDiagnostic({
    severity: 'error',
    code,
    message,
    targetUri: op.targetUri,
    details: { kind: op.kind, operationId: op.id }
  });
}

function maxRisk(a: PatchRiskLevel, b: PatchRiskLevel): PatchRiskLevel {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}
