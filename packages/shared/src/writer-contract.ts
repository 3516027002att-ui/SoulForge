/**
 * Writer contract surface for scaffold adapters (architecture fork #108).
 *
 * Operational contract used by the v0.5 architecture scaffold.
 * Distinct from the lighter WriterContract metadata in types.ts used by the desktop gate.
 * Native FromSoftware writers are NOT implemented here.
 */

import type { StructuredDiagnostic } from './diagnostics.js';
import type { PatchIrOperation, PatchIR, PatchPrecondition } from './patch-ir.js';
import type { ResourceKind } from './types.js';

export type WriterOperationKind =
  | 'text_edit'
  | 'file_replace'
  | 'raw_byte_range_edit'
  | 'synthetic_resource_edit'
  | 'resource_field_edit'
  | 'resource_node_add'
  | 'resource_node_delete'
  | 'resource_node_update'
  | 'resource_node_reorder'
  | 'resource_node_convert'
  | 'resource_edge_add'
  | 'resource_edge_delete'
  | 'resource_edge_update'
  | 'asset_import_replace'
  | 'structured_edit'
  | 'container_child_edit'
  | 'container_child_replace'
  | 'container_child_add'
  | 'container_child_delete'
  | 'container_child_rename'
  | 'container_child_move';

export interface WriterRollbackMetadata {
  writerId: string;
  strategy: 'restore_backup' | 'inverse_bytes' | 'reapply_text' | 'none';
  backupPaths: string[];
  notes?: string;
  details?: Record<string, unknown>;
}

export interface WriterWritePlan {
  writerId: string;
  operations: PatchIrOperation[];
  stagingRelativePaths: string[];
  preconditions: PatchPrecondition[];
  estimatedRisk: 'safe' | 'caution' | 'high' | 'blocked';
  notes?: string;
}

/**
 * Explicit op → staging path mapping.
 * WorkspaceTransaction must use this; never guess via string includes.
 */
export interface WriterWrittenTarget {
  opId: string;
  targetUri: string;
  targetPath?: string;
  stagingPath: string;
}

export interface WriterResourceEntryChange {
  id: string;
  resourceUri: string;
  entryUri: string;
  changeKind: string;
  beforeHash?: string;
  afterHash?: string;
  inverse: PatchIrOperation;
}

export interface WriterInverseCaptureResult {
  ok: boolean;
  resourceEntryChanges: WriterResourceEntryChange[];
  /** Forward operation ids for which a precise inverse was captured. */
  capturedOperationIds: string[];
  diagnostics: StructuredDiagnostic[];
}

export interface WriterApplyResult {
  ok: boolean;
  /**
   * Explicit mapping from operation id to staging path.
   * Required for multi-op commits with same basename / similar URIs.
   */
  writtenTargets: WriterWrittenTarget[];
  /** @deprecated Prefer writtenTargets. Kept for older callers. */
  writtenPaths: string[];
  diagnostics: StructuredDiagnostic[];
  rollback: WriterRollbackMetadata;
}

export interface WriterPostValidateResult {
  ok: boolean;
  writerId: string;
  /** Forward operation ids actually checked against staged output. */
  validatedOperationIds: string[];
  diagnostics: StructuredDiagnostic[];
}

/**
 * Operational writer adapter contract (scaffold).
 * Distinct from the metadata `WriterContract` in types.ts used by desktop gates.
 * All apply paths must write only to staging; commit is owned by WorkspaceTransaction.
 */
export interface WriterAdapterContract {
  readonly writerId: string;
  readonly supportedResourceKinds: readonly ResourceKind[];
  readonly supportedOperations: readonly WriterOperationKind[];
  readonly inputSchemaVersion: string;
  readonly preconditions: readonly string[];

  canHandle(operation: PatchIrOperation): boolean;
  writePlan(patch: PatchIR, operations: PatchIrOperation[]): WriterWritePlan;
  applyToStaging(input: {
    stagingRoot: string;
    operations: PatchIrOperation[];
    workspaceRoot?: string;
  }): Promise<WriterApplyResult>;
  /**
   * Capture precise semantic/container entry inverses after staging and before
   * any target replacement. Native structured operations are rejected when
   * this hook is missing or does not cover every forward operation.
   */
  captureInverse?(input: {
    operations: PatchIrOperation[];
    stagedTargets: WriterWrittenTarget[];
    workspaceRoot: string;
  }): Promise<WriterInverseCaptureResult> | WriterInverseCaptureResult;
  produceRollbackMetadata(input: {
    operations: PatchIrOperation[];
    backupPaths: string[];
  }): WriterRollbackMetadata;
  postValidate?(input: {
    stagingRoot: string;
    operations: PatchIrOperation[];
    writtenTargets: WriterWrittenTarget[];
  }): Promise<WriterPostValidateResult> | WriterPostValidateResult;
}

/** @deprecated Alias kept for docs that say WriterContract operational surface. */
export type ScaffoldWriterContract = WriterAdapterContract;

export interface WriterRegistryLookup {
  writerId: string;
  contract: WriterAdapterContract;
}
