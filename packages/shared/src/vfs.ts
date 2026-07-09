/**
 * Virtual filesystem scaffold (architecture fork areas for VFS / overlay).
 */

import type { ConfidenceAssessment } from './confidence.js';
import type { StructuredDiagnostic } from './diagnostics.js';
import type { ProvenanceChain } from './provenance.js';
import type { OverlayLayerId, ResourceURI } from './resource-uri.js';
import type { ResourceFormatKind, ResourceKind } from './types.js';

export type VfsNodeKind =
  | 'physical_file'
  | 'overlay'
  | 'container_child'
  | 'synthetic_resource'
  | 'generated_view'
  | 'unsupported'
  | 'directory';

export type VfsCapability =
  | 'read'
  | 'list'
  | 'text_edit'
  | 'raw_edit'
  | 'stage'
  | 'structured_edit'
  | 'container_edit'
  | 'none';

/**
 * Hash strategy for VFS open-time scan.
 * Large / packed files must not pretend full hash was computed at open.
 */
export type VfsHashStatus = 'full' | 'partial' | 'deferred' | 'unavailable';

export interface VfsNode {
  id: string;
  kind: VfsNodeKind;
  name: string;
  /** Workspace-relative POSIX path when applicable. */
  relativePath: string;
  absolutePath?: string;
  resourceUri: ResourceURI;
  resourceUriString: string;
  resourceKind: ResourceKind;
  formatKind: ResourceFormatKind;
  overlay: OverlayLayerId;
  capabilities: VfsCapability[];
  diagnostics: StructuredDiagnostic[];
  provenance?: ProvenanceChain;
  confidence?: ConfidenceAssessment;
  contentHash?: string;
  /** How contentHash was obtained at scan time. */
  hashStatus?: VfsHashStatus;
  size?: number;
  children?: VfsNode[];
  /** True when this is a synthetic fixture-backed resource. */
  synthetic?: boolean;
  /** Always false for synthetic fixtures. */
  nativeFormatAuthority: boolean;
  metadata?: Record<string, unknown>;
}

export interface VfsTree {
  workspaceId: string;
  root: VfsNode;
  nodesByUri: Record<string, VfsNode>;
  createdAt: string;
  diagnostics: StructuredDiagnostic[];
}

export interface BuildVfsOptions {
  workspaceId: string;
  workspaceRoot: string;
  game?: string;
  overlay?: OverlayLayerId;
}
