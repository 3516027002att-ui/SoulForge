/**
 * Graph Patch IR (architecture forks #110–#111).
 * Unifies file replace, text, raw range, field, node/edge, and container child ops.
 *
 * Native semantic operations are versioned and typed, but remain blocked until
 * a registered authority writer accepts them.
 */

import type { ConfidenceLevel } from './confidence.js';
import type { StructuredDiagnostic } from './diagnostics.js';
import type { EditRiskLevel, ResourceKind } from './types.js';

export const PATCH_IR_SCHEMA_VERSION = '1.0.0' as const;

export type PatchIrOpKind =
  | 'file_replace'
  | 'raw_byte_range_edit'
  | 'text_edit'
  | 'resource_field_edit'
  | 'resource_node_add'
  | 'resource_node_delete'
  | 'resource_node_update'
  | 'resource_node_reorder'
  | 'resource_node_convert'
  | 'resource_edge_add'
  | 'resource_edge_delete'
  | 'resource_edge_update'
  | 'container_child_replace'
  | 'container_child_add'
  | 'container_child_delete'
  | 'container_child_rename'
  | 'container_child_move'
  | 'asset_import_replace'
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

export type PatchTypedValue =
  | { valueType: 'null'; value: null }
  | { valueType: 'boolean'; value: boolean }
  | { valueType: 'integer'; value: number }
  | { valueType: 'float'; value: number }
  | { valueType: 'string'; value: string }
  | { valueType: 'bytes'; base64: string }
  | { valueType: 'enum'; value: string | number; enumId: string }
  | { valueType: 'flags'; values: Array<string | number>; enumId: string }
  | { valueType: 'array'; items: PatchTypedValue[] }
  | { valueType: 'object'; fields: Record<string, PatchTypedValue> };

export type BinaryContentRef =
  | {
      storage: 'inline';
      dataBase64: string;
      sha256: string;
      size: number;
    }
  | {
      storage: 'staging_object';
      objectId: string;
      sha256: string;
      size: number;
    };

export type PreservedNodeSnapshot = BinaryContentRef & {
  formatId: string;
  schemaVersion: string;
};

export interface EmevdEventNodePayload {
  payloadVersion: 1;
  resourceKind: 'event';
  nodeType: 'emevd_event';
  eventId: number;
  eventIndex: number;
  restartType: number;
  /** Bridge semantic hash of the complete event snapshot. */
  eventHash: string;
  snapshot: PreservedNodeSnapshot;
}

export interface EmevdInstructionNodePayload {
  payloadVersion: 1;
  resourceKind: 'event';
  nodeType: 'emevd_instruction';
  eventId: number;
  eventIndex: number;
  instructionIndex: number;
  bank: number;
  instructionId: number;
  layerOffset: number;
  parameterCount: number;
  /** Bridge semantic hash of instruction args, layer and attached parameter substitutions. */
  instructionHash: string;
  args: BinaryContentRef;
  snapshot: PreservedNodeSnapshot;
}

export interface ParamRowNodePayload {
  payloadVersion: 1;
  resourceKind: 'param';
  nodeType: 'param_row';
  paramType: string;
  rowId: number;
  rowName?: string;
  snapshot: PreservedNodeSnapshot;
}

export interface FmgEntryNodePayload {
  payloadVersion: 1;
  resourceKind: 'msg';
  nodeType: 'fmg_entry';
  entryId: number;
  /** Occurrence index in the FMG string table; required for duplicate-ID isolation. */
  stringIndex: number;
  text: string;
  snapshot: PreservedNodeSnapshot;
}

export interface MsbEntityNodePayload {
  payloadVersion: 1;
  resourceKind: 'map';
  nodeType: 'msb_entity';
  entityKind: 'model' | 'part' | 'region' | 'event';
  entityIndex: number;
  entityId?: number;
  name: string;
  snapshot: PreservedNodeSnapshot;
}

export interface OpaqueResourceNodePayload {
  payloadVersion: 1;
  resourceKind: Exclude<ResourceKind, 'event' | 'param' | 'msg' | 'map'>;
  nodeType: 'opaque_resource';
  formatId: string;
  snapshot: PreservedNodeSnapshot;
}

export type ResourceNodePayload =
  | EmevdEventNodePayload
  | EmevdInstructionNodePayload
  | ParamRowNodePayload
  | FmgEntryNodePayload
  | MsbEntityNodePayload
  | OpaqueResourceNodePayload;

export interface ResourceNodeDeleteInverse {
  kind: 'resource_node_delete';
  nodeId: string;
  expectedNodeHash: string;
}

export interface ResourceNodeAddInverse {
  kind: 'resource_node_add';
  nodeId: string;
  payload: ResourceNodePayload;
}

export interface ResourceNodeUpdateInverse {
  kind: 'resource_node_update';
  nodeId: string;
  payload: ResourceNodePayload;
}

export interface ResourceNodeReorderInverse {
  kind: 'resource_node_reorder';
  parentNodeId?: string;
  previousOrder: string[];
}

export interface ResourceNodeConvertInverse {
  kind: 'resource_node_convert';
  nodeId: string;
  previousType: string;
  payload: ResourceNodePayload;
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
  resourceKind: ResourceKind;
  documentUri: string;
  documentRevision: string;
  schemaId: string;
  schemaVersion: string;
  layoutFingerprint: string;
  expectedDocumentHash: string;
  writerId: string;
  fieldUri: string;
  previousValue: PatchTypedValue;
  nextValue: PatchTypedValue;
  inverse: {
    kind: 'resource_field_edit';
    fieldUri: string;
    value: PatchTypedValue;
  };
}

export interface ResourceNodeBaseOp extends PatchIrBase {
  resourceKind: ResourceKind;
  documentUri: string;
  documentRevision: string;
  expectedDocumentHash: string;
  writerId: string;
  nodeId: string;
}

export interface ResourceNodeAddOp extends ResourceNodeBaseOp {
  kind: 'resource_node_add';
  payload: ResourceNodePayload;
  inverse: ResourceNodeDeleteInverse;
}

export interface ResourceNodeDeleteOp extends ResourceNodeBaseOp {
  kind: 'resource_node_delete';
  expectedNodeHash: string;
  inverse: ResourceNodeAddInverse;
}

export interface ResourceNodeUpdateOp extends ResourceNodeBaseOp {
  kind: 'resource_node_update';
  expectedNodeHash: string;
  payload: ResourceNodePayload;
  inverse: ResourceNodeUpdateInverse;
}

export interface ResourceNodeReorderOp extends ResourceNodeBaseOp {
  kind: 'resource_node_reorder';
  parentNodeId?: string;
  beforeNodeId?: string;
  expectedOrder: string[];
  inverse: ResourceNodeReorderInverse;
}

export interface ResourceNodeConvertOp extends ResourceNodeBaseOp {
  kind: 'resource_node_convert';
  expectedNodeHash: string;
  fromType: string;
  toType: string;
  payload: ResourceNodePayload;
  inverse: ResourceNodeConvertInverse;
}

export type ResourceNodeMutationOp =
  | ResourceNodeAddOp
  | ResourceNodeDeleteOp
  | ResourceNodeUpdateOp
  | ResourceNodeReorderOp
  | ResourceNodeConvertOp;

export interface ResourceEdgePayload {
  payloadVersion: 1;
  relationType: string;
  sourceUri: string;
  targetUri: string;
  attributes?: Record<string, string | number | boolean | null>;
}

export interface ResourceEdgeMutationOp extends PatchIrBase {
  kind: 'resource_edge_add' | 'resource_edge_delete' | 'resource_edge_update';
  resourceKind: ResourceKind;
  documentUri: string;
  documentRevision: string;
  expectedDocumentHash: string;
  writerId: string;
  edgeId: string;
  payload: ResourceEdgePayload;
  inverse: {
    kind: 'resource_edge_add' | 'resource_edge_delete' | 'resource_edge_update';
    edgeId: string;
    payload: ResourceEdgePayload;
  };
}

export interface ContainerChildOp extends PatchIrBase {
  kind:
    | 'container_child_replace'
    | 'container_child_add'
    | 'container_child_delete'
    | 'container_child_rename'
    | 'container_child_move';
  containerUri: string;
  /** Stable child path or fragment (name / id / nested path). */
  childPath: string;
  /** Stable child URI fragment, e.g. file://pack.bnd#bnd/child/item.fmg */
  childUri?: string;
  newChildPath?: string;
  childContentBase64?: string;
  /** sha256 of the outer container file before edit. */
  expectedContainerHash?: string;
  /** sha256 of the target child bytes before edit. */
  expectedChildHash?: string;
  /** Container format metadata for the writer (dcx/bnd3/bnd4/nested). */
  containerFormat?: string;
  /** Nested path segments from outer container to child. */
  nestedPath?: string[];
}

export interface SyntheticResourceEditOp extends PatchIrBase {
  kind: 'synthetic_resource_edit';
  syntheticKind: 'event' | 'param' | 'map' | 'msg' | 'other';
  payload: unknown;
}

export interface AssetImportReplaceOp extends PatchIrBase {
  kind: 'asset_import_replace';
  sourceImportObjectId: string;
  importFormat: 'gltf' | 'glb' | 'png' | 'tga' | 'dds';
  targetAssetUri: string;
  conversionRuleId: string;
  expectedTargetHash: string;
  writerId: string;
  generatedStagingObjects: Array<{
    objectId: string;
    mediaType: string;
    sha256: string;
    size: number;
  }>;
  inverse: {
    kind: 'asset_import_replace';
    previousAssetObjectHash: string;
    backupRef: string;
  };
}

export type PatchIrOperation =
  | FileReplaceOp
  | RawByteRangeEditOp
  | TextEditOp
  | ResourceFieldEditOp
  | ResourceNodeMutationOp
  | ResourceEdgeMutationOp
  | ContainerChildOp
  | AssetImportReplaceOp
  | SyntheticResourceEditOp;

export interface PatchIR {
  schemaVersion: typeof PATCH_IR_SCHEMA_VERSION;
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
  'synthetic_resource_edit',
  /** v0.6: synthetic SFBN BND + DCX DFLT nested child replace (authoritative for owned fixtures). */
  'container_child_replace'
] as const;

/**
 * Operations that require an explicitly declared authority writer.
 * Execution still resolves the registered writer; a writerId/metadata claim alone
 * never grants filesystem access. Native BND4 DFLT operations use their existing
 * corpus-bound authority path.
 */
export const NATIVE_WRITER_REQUIRED_KINDS: readonly PatchIrOpKind[] = [
  'resource_field_edit',
  'resource_node_add',
  'resource_node_delete',
  'resource_node_update',
  'resource_node_reorder',
  'resource_node_convert',
  'resource_edge_add',
  'resource_edge_delete',
  'resource_edge_update',
  'container_child_add',
  'container_child_delete',
  'container_child_rename',
  'container_child_move',
  'asset_import_replace'
] as const;
