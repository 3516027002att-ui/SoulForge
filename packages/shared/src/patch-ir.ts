/**
 * Graph Patch IR (architecture forks #110–#111).
 * Unifies file replace, text, raw range, field, node/edge, and container child ops.
 *
 * Scaffold only — native structured writers are not implemented here.
 */

import type { ConfidenceLevel } from './confidence.js';
import type { StructuredDiagnostic } from './diagnostics.js';
import type { EditRiskLevel, ResourceKind } from './types.js';

export type PatchIrOpKind =
  | 'file_replace'
  | 'raw_byte_range_edit'
  | 'text_edit'
  | 'resource_field_edit'
  | 'resource_node_add'
  | 'resource_node_delete'
  | 'resource_node_update'
  | 'resource_edge_add'
  | 'resource_edge_delete'
  | 'resource_edge_update'
  | 'container_child_replace'
  | 'container_child_add'
  | 'container_child_delete'
  | 'container_child_rename'
  | 'container_child_move'
  | 'synthetic_resource_edit';

export type PatchRiskLevel = EditRiskLevel | 'low' | 'medium';

export interface PatchPrecondition {
  type: 'content_hash' | 'resource_exists' | 'overlay_writable' | 'writer_capability' | 'custom';
  description: string;
  expectedHash?: string;
  targetUri?: string;
  details?: Record<string, unknown>;
}

export interface PatchValidatorRequirement {
  validatorId: string;
  scope: 'before_staging' | 'staged_output' | 'after_commit' | 'any';
  required: boolean;
}

export interface PatchRollbackHint {
  strategy: 'restore_backup' | 'inverse_patch' | 'reapply_snapshot' | 'manual';
  backupRef?: string;
  notes?: string;
}

export interface PatchIrBase {
  id: string;
  kind: PatchIrOpKind;
  targetUri: string;
  /** Absolute or sandbox path when operating on real files. */
  targetPath?: string;
  resourceKind?: ResourceKind;
  preconditions: PatchPrecondition[];
  expectedHash?: string;
  validatorRequirements: PatchValidatorRequirement[];
  rollbackHint?: PatchRollbackHint;
  riskLevel: PatchRiskLevel;
  confidenceRequirement?: ConfidenceLevel;
  metadata?: Record<string, unknown>;
}

export interface FileReplaceOp extends PatchIrBase {
  kind: 'file_replace';
  newContentBase64?: string;
  newText?: string;
  allowCreateNewFile?: boolean;
  allowEmpty?: boolean;
  /** When true, policy/confirmation must cover high risk (packed/native/unsupported). */
  requiresConfirmation?: boolean;
}

export interface RawByteRangeEditOp extends PatchIrBase {
  kind: 'raw_byte_range_edit';
  offset: number;
  length: number;
  replacementBase64: string;
  expectedHash: string;
}

export interface TextEditOp extends PatchIrBase {
  kind: 'text_edit';
  newText: string;
  allowEmpty?: boolean;
}

export interface ResourceFieldEditOp extends PatchIrBase {
  kind: 'resource_field_edit';
  fieldUri: string;
  previousValue?: unknown;
  nextValue: unknown;
}

export interface ResourceNodeMutationOp extends PatchIrBase {
  kind: 'resource_node_add' | 'resource_node_delete' | 'resource_node_update';
  nodeId: string;
  nodePayload?: unknown;
}

export interface ResourceEdgeMutationOp extends PatchIrBase {
  kind: 'resource_edge_add' | 'resource_edge_delete' | 'resource_edge_update';
  edgeId: string;
  edgePayload?: unknown;
}

export interface ContainerChildOp extends PatchIrBase {
  kind:
    | 'container_child_replace'
    | 'container_child_add'
    | 'container_child_delete'
    | 'container_child_rename'
    | 'container_child_move';
  containerUri: string;
  childPath: string;
  newChildPath?: string;
  childContentBase64?: string;
}

export interface SyntheticResourceEditOp extends PatchIrBase {
  kind: 'synthetic_resource_edit';
  syntheticKind: 'event' | 'param' | 'map' | 'msg' | 'other';
  payload: unknown;
}

export type PatchIrOperation =
  | FileReplaceOp
  | RawByteRangeEditOp
  | TextEditOp
  | ResourceFieldEditOp
  | ResourceNodeMutationOp
  | ResourceEdgeMutationOp
  | ContainerChildOp
  | SyntheticResourceEditOp;

export interface PatchIR {
  patchId: string;
  workspaceId: string;
  title: string;
  author: 'user' | 'ai' | 'system';
  createdAt: string;
  operations: PatchIrOperation[];
  affectedResources: string[];
  riskLevel: PatchRiskLevel;
  confidenceRequirement?: ConfidenceLevel;
  notes?: string;
}

export interface PatchIrValidationResult {
  ok: boolean;
  diagnostics: StructuredDiagnostic[];
  affectedResources: string[];
  estimatedRisk: PatchRiskLevel;
}

/** Operations that scaffold adapters can apply to staging today. */
export const SCAFFOLD_SUPPORTED_PATCH_KINDS: readonly PatchIrOpKind[] = [
  'file_replace',
  'raw_byte_range_edit',
  'text_edit',
  'synthetic_resource_edit'
] as const;

/** Operations that require native writers — always rejected by scaffold validators. */
export const NATIVE_WRITER_REQUIRED_KINDS: readonly PatchIrOpKind[] = [
  'container_child_replace',
  'container_child_add',
  'container_child_delete',
  'container_child_rename',
  'container_child_move'
] as const;
